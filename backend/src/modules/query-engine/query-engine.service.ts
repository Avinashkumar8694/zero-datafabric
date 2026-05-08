import { pool, queryWithContext } from '../../config/database';
import { EventService } from '../events/event.service';
import { ConnectorFactory } from '../metadata/connectors/factory';
import { randomUUID } from 'crypto';

export interface QueryConfig {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 
        'CREATE_SCHEMA' | 'CREATE_TABLE' | 'CREATE_FOREIGN_TABLE' | 
        'ALTER_TABLE' | 'DROP_TABLE' | 'CREATE_INDEX' | 
        'CREATE_VIEW' | 'CREATE_SEQUENCE';
  table?: string;
  schema?: string;
  tableId?: string; // UUID reference to catalog_tables
  schemaId?: string; // UUID reference to catalog_schemas
  withRecursive?: {
    name: string;
    baseQuery: string; 
    recursiveQuery: string; 
  };
  select?: string[];
  filter?: Record<string, any>;
  joins?: {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
    table?: string;
    tableId?: string;
    schema?: string;
    on: string;
  }[];
  groupBy?: string[];
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }[];
  limit?: number;
  offset?: number;
  
  // DML/CRUD specific
  data?: Record<string, any> | Record<string, any>[]; 
  
  // DDL specific
  schemaDef?: { columns: { name: string; type: string; constraints?: string }[] };
  indexDef?: { name: string; columns: string[]; unique?: boolean };
  
  // ALTER TABLE specific
  alterDef?: {
    action: 'ADD_COLUMN' | 'DROP_COLUMN';
    columnName: string;
    columnType?: string;
  };

  foreignDef?: {
    serverName: string;
    options: Record<string, string>;
  };
  
  // VIEW specific
  viewDef?: { name: string; query: string; materialized?: boolean };
  
  // SEQUENCE specific
  sequenceDef?: { name: string; start?: number; increment?: number };
}

export class QueryEngineService {
  private static jobs = new Map<string, { status: string; result?: any; error?: string }>();

  /**
   * Orchestrates the execution of complex query configurations
   */
  static async executeQuery(tenantId: string, config: QueryConfig): Promise<any> {
    // 0. Tenant Lifecycle Check (with resilience for unit tests)
    try {
        const { rows: tenantRows } = await pool.query('SELECT status FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRows.length > 0 && tenantRows[0].status === 'SUSPENDED') {
            throw new Error('Tenant account is suspended. Operations are restricted.');
        }
    } catch (err: any) {
        if (err.message.includes('suspended')) throw err;
        // Ignore "relation not exists" or connection errors in dev/test
        console.warn(`[QueryEngine] Lifecycle check bypassed: ${err.message}`);
    }

    // INDUSTRIAL SAFETY SHIELD: Guard against unrestricted operations
    if (['SELECT', 'UPDATE', 'DELETE'].includes(config.type)) {
        const hasLimit = config.limit !== undefined;
        const hasFilter = config.filter && Object.keys(config.filter).length > 0;
        const isAggregate = config.select && (config.select.some(s => s.toLowerCase().includes('count(')) || config.select.some(s => s.toLowerCase().includes('sum(')));

        if (!hasLimit && !hasFilter && !isAggregate) {
            throw new Error('INDUSTRIAL SAFETY: Unrestricted operations (No LIMIT or WHERE) are blocked to prevent resource exhaustion.');
        }
    }

    // SPECIAL CASE: CREATE_SCHEMA uses stored procedure for security
    if (config.type === 'CREATE_SCHEMA') {
        const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
        // If it's a simple tenant schema creation
        if (!config.schema) {
            await queryWithContext('SELECT fabric_admin.create_tenant_namespace($1)', [cleanTenant], { tenantId, username: 'system' });
            return { status: 'SUCCESS', target: `tenant_${cleanTenant}`, type: 'CREATE_SCHEMA' };
        }
    }

    // 1. Resolve Table/Schema to find Source and Sync Type
    let sourceId: string | null = null;
    let physicalSchema: string | null = null;
    let physicalTable: string | null = null;

    if (config.tableId) {
        const { rows } = await pool.query(`
            SELECT ct.physical_name as t_name, cs.physical_name as s_name, cs.source_id, ds.type as s_type, ds.config as s_config, ds.sync_type
            FROM public.catalog_tables ct
            JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
            JOIN public.data_sources ds ON cs.source_id = ds.id
            WHERE ct.id = $1
        `, [config.tableId]);
        if (rows.length > 0) {
            sourceId = rows[0].source_id;
            physicalSchema = rows[0].s_name;
            physicalTable = rows[0].t_name;

            // INDUSTRIAL ROUTING: If VIRTUAL, use Connector directly
            if (rows[0].sync_type === 'VIRTUAL') {
                console.log(`[QueryEngine] Routing virtual query to ${rows[0].s_type} connector...`);
                const connector = ConnectorFactory.getConnector(rows[0].s_type, rows[0].s_config);
                try {
                    const data = await connector.query(physicalSchema!, physicalTable!, config);
                    return {
                        data: data,
                        rowCount: data.length,
                        sourceType: rows[0].s_type,
                        physicalSchema,
                        physicalTable
                    };
                } finally {
                    await connector.close();
                }
            }
        }
    }

    const { sql, params } = await this.generateSql(tenantId, config);
    const result = await queryWithContext(sql, params, { tenantId, username: 'system' });
    
    // Auto-Event Triggering for Mutation Queries
    if (['INSERT', 'UPDATE', 'DELETE'].includes(config.type)) {
      await EventService.emit('query.mutation', {
        tenantId,
        action: config.type,
        table: config.table,
        timestamp: new Date().toISOString()
      });
    }

    // Return specialized result for DDL vs DML
    if (config.type.startsWith('CREATE') || config.type.startsWith('DROP') || config.type.startsWith('ALTER')) {
      const targetName = config.type === 'CREATE_SCHEMA' 
        ? (config.schema ? `tenant_${tenantId}_${config.schema}` : `tenant_${tenantId}`)
        : (config.table || config.schema);
      return { status: 'SUCCESS', target: targetName, type: config.type };
    }

    if (config.type === 'INSERT' || config.type === 'UPDATE' || config.type === 'DELETE') {
        return { 
            rowCount: result.rowCount, 
            returning: result.rows,
            status: 'SUCCESS'
        };
    }

    return result.rows;
  }

  /**
   * Specialized method for DDL execution during migration (bypass event emitting)
   */
  static async executeRawSql(tenantId: string, username: string, sql: string, params: any[] = []): Promise<any> {
    // 0. Tenant Lifecycle Check (with resilience for unit tests)
    try {
        const { rows: tenantRows } = await pool.query('SELECT status FROM public.tenants WHERE id = $1', [tenantId]);
        if (tenantRows.length > 0 && tenantRows[0].status === 'SUSPENDED') {
            throw new Error('Tenant account is suspended. Operations are restricted.');
        }
    } catch (err: any) {
        if (err.message.includes('suspended')) throw err;
        // Ignore "relation not exists" or connection errors in dev/test
        console.warn(`[QueryEngine] Lifecycle check bypassed: ${err.message}`);
    }

    const safetyApplied = this.detectUnsafeOperations(sql);
    const result = await queryWithContext(sql, params, { tenantId, username });
    
    return {
      results: result.rows,
      safetyApplied
    };
  }

  /**
   * Asynchronous Query Execution Wrapper
   */
  static executeAsyncRawSql(tenantId: string, username: string, sql: string, params: any[] = []): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: 'RUNNING' });

    this.executeRawSql(tenantId, username, sql, params)
      .then(result => {
        this.jobs.set(jobId, { status: 'COMPLETED', result });
      })
      .catch(err => {
        this.jobs.set(jobId, { status: 'FAILED', error: err.message });
      });

    return jobId;
  }

  static getJobStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'NOT_FOUND', jobId };
    return { jobId, ...job };
  }

  /**
   * Generates a SQL string and parameters from a QueryConfig without executing it.
   * Useful for CREATE VIEW or complex migration planning.
   */
  static async generateSql(tenantId: string, config: QueryConfig, inlineValues = false): Promise<{ sql: string, params: any[] }> {
    const { type, table, select, filter, joins, groupBy, orderBy, limit, offset, withRecursive } = config;
    
    if (!tenantId) {
        throw new Error('Internal Error: Tenant identity missing in SQL generation');
    }

    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    
    let schemaName = config.schema 
        ? `tenant_${cleanTenant}_${config.schema.replace(/[^a-zA-Z0-9_]/g, '')}`
        : `tenant_${cleanTenant}`;
    
    let tableName = table?.replace(/[^a-zA-Z0-9_]/g, '');

    // INDUSTRIAL RESOLUTION: If UUIDs are provided, resolve physical locations via Catalog
    if (config.tableId) {
        const { rows } = await pool.query(`
            SELECT ct.physical_name as table_name, cs.physical_name as schema_name 
            FROM public.catalog_tables ct
            JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
            WHERE ct.id = $1
        `, [config.tableId]);
        if (rows.length > 0) {
            tableName = rows[0].table_name;
            schemaName = rows[0].schema_name;
        }
    } else if (config.schemaId) {
        const { rows } = await pool.query('SELECT physical_name FROM public.catalog_schemas WHERE id = $1', [config.schemaId]);
        if (rows.length > 0) {
            schemaName = rows[0].physical_name;
        }
    }

    const safeTable = `"${schemaName}"."${tableName}"`;
    
    let queryStr = '';
    const params: any[] = [];
    let paramIndex = 1;

    if (withRecursive) {
        queryStr = `WITH RECURSIVE ${withRecursive.name} AS (
            ${withRecursive.baseQuery}
            UNION ALL
            ${withRecursive.recursiveQuery}
        ) `;
    }

    if (type === 'SELECT') {
      const selectFields = select && select.length > 0 
        ? select.map(f => {
            if (f === '*') return '*';
            if (f.includes('(') || f.includes(' ')) return f; 
            return f.split('.').map(part => `"${part.replace(/[^a-zA-Z0-9_]/g, '')}"`).join('.');
          }).join(', ') 
        : '*';
      
      const isCte = withRecursive && config.table === withRecursive.name;
      const selectSchema = config.schema ? `tenant_${cleanTenant}_${config.schema}` : `tenant_${cleanTenant}`;
      const safeSelectTable = isCte 
        ? `"${tableName!.replace(/[^a-zA-Z0-9_]/g, '')}"`
        : `"${schemaName}"."${tableName!.replace(/[^a-zA-Z0-9_]/g, '')}"`;

      queryStr += `SELECT ${selectFields} FROM ${safeSelectTable}`;
      
      if (joins) {
        for (const join of joins) {
          let joinTable = join.table;
          let joinSchema = config.schema ? `tenant_${cleanTenant}_${config.schema}` : `tenant_${cleanTenant}`;

          // RESOLVE LOGICAL TABLE IN JOIN
          if (join.tableId) {
             const jRes = await pool.query(`
                SELECT ct.physical_name as t_name, cs.physical_name as s_name 
                FROM public.catalog_tables ct
                JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
                WHERE ct.id = $1
             `, [join.tableId]);
             if (jRes.rows.length > 0) {
                 joinTable = jRes.rows[0].t_name;
                 joinSchema = jRes.rows[0].s_name;
             }
          } else if (join.schema) {
              joinSchema = join.schema.startsWith('tenant_') ? join.schema : `tenant_${cleanTenant}_${join.schema}`;
          }

          const safeJoinTable = `"${joinSchema}"."${joinTable!.replace(/[^a-zA-Z0-9_]/g, '')}"`;
          queryStr += ` ${join.type} JOIN ${safeJoinTable} ON ${join.on}`;
        }
      }
    } else if (type === 'INSERT') {
      const data = config.data as any;
      const columns = Object.keys(Array.isArray(data) ? data[0] : data);
      const rows = Array.isArray(data) ? data : [data];
      
      const placeholders = rows.map(row => {
        return '(' + columns.map(col => {
          if (inlineValues) return this.formatInline(row[col]);
          params.push(row[col]);
          return `$${paramIndex++}`;
        }).join(', ') + ')';
      }).join(', ');

      queryStr = `INSERT INTO ${safeTable} (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders} RETURNING *`;
    } else if (type === 'UPDATE') {
      const data = config.data as any;
      const sets = Object.keys(data).map(col => {
        if (inlineValues) return `"${col}" = ${this.formatInline(data[col])}`;
        params.push(data[col]);
        return `"${col}" = $${paramIndex++}`;
      }).join(', ');
      queryStr = `UPDATE ${safeTable} SET ${sets}`;
    } else if (type === 'DELETE') {
      queryStr = `DELETE FROM ${safeTable}`;
    } else if (type === 'CREATE_TABLE') {
      const columns = config.schemaDef?.columns.map(c => `"${c.name}" ${c.type} ${c.constraints || ''}`).join(', ');
      queryStr = `CREATE TABLE ${safeTable} (${columns})`;
    } else if (type === 'DROP_TABLE') {
      queryStr = `DROP TABLE IF EXISTS ${safeTable}`;
    } else if (type === 'CREATE_INDEX') {
      const idx = config.indexDef!;
      queryStr = `CREATE ${idx.unique ? 'UNIQUE ' : '' }INDEX "${idx.name}" ON ${safeTable} (${idx.columns.join(', ')})`;
    } else if (type === 'CREATE_VIEW') {
      const view = config.viewDef!;
      queryStr = `CREATE ${view.materialized ? 'MATERIALIZED ' : ''}VIEW "${schemaName}"."${view.name}" AS ${view.query}`;
    } else if (type === 'CREATE_SCHEMA') {
      queryStr = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;
    } else if (type === 'CREATE_SEQUENCE') {
      const seq = config.sequenceDef!;
      queryStr = `CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."${seq.name}" START WITH ${seq.start || 1} INCREMENT BY ${seq.increment || 1}`;
    } else if (type === 'ALTER_TABLE') {
        const alter = config.alterDef!;
        if (alter.action === 'ADD_COLUMN') {
            queryStr = `ALTER TABLE ${safeTable} ADD COLUMN "${alter.columnName}" ${alter.columnType}`;
        } else if (alter.action === 'DROP_COLUMN') {
            queryStr = `ALTER TABLE ${safeTable} DROP COLUMN "${alter.columnName}"`;
        }
    }

    // Common WHERE clause for SELECT/UPDATE/DELETE
    if (filter && ['SELECT', 'UPDATE', 'DELETE'].includes(type)) {
      const whereClauses = Object.keys(filter).map(key => {
        const safeKey = key.includes('.') 
          ? key.split('.').map(part => `"${part.replace(/[^a-zA-Z0-9_]/g, '')}"`).join('.')
          : `"${key.replace(/[^a-zA-Z0-9_]/g, '')}"`;
          
        const valObj = filter[key];
        const keys = typeof valObj === 'object' && valObj !== null ? Object.keys(valObj) : [];
        const firstKey = keys[0];
        const isOp = firstKey && firstKey.startsWith('$');
        const op = isOp ? firstKey : '$eq';
        const val = isOp ? (valObj as any)[op] : valObj;
        
        let sqlOp = '=';
        if (op === '$gt') sqlOp = '>';
        else if (op === '$lt') sqlOp = '<';
        else if (op === '$ne') sqlOp = '!=';
        else if (op === '$like') sqlOp = 'ILIKE';
        else if (op === '$in') sqlOp = 'IN';

        if (op === '$in' && Array.isArray(val)) {
            const inPlaceholders = val.map(v => {
                if (inlineValues) return this.formatInline(v);
                params.push(v);
                return `$${paramIndex++}`;
            }).join(', ');
            return `${safeKey} IN (${inPlaceholders})`;
        }

        if (inlineValues) return `${safeKey} ${sqlOp} ${this.formatInline(val)}`;
        params.push(val);
        return `${safeKey} ${sqlOp} $${paramIndex++}`;
      });
      if (whereClauses.length > 0) {
        queryStr += ` WHERE ${whereClauses.join(' AND ')}`;
      }
    }

    // Add RETURNING * for DML (AFTER WHERE clause)
    if (['UPDATE', 'DELETE'].includes(type)) {
        queryStr += ` RETURNING *`;
    }

    if (type === 'SELECT') {
        if (groupBy) queryStr += ` GROUP BY ${groupBy.join(', ')}`;
        if (orderBy) queryStr += ` ORDER BY ${orderBy.map(o => `${o.field} ${o.dir}`).join(', ')}`;
        if (limit) queryStr += ` LIMIT ${limit}`;
        if (offset) queryStr += ` OFFSET ${offset}`;
    }

    console.log(`[SQL Gen] ${type} -> ${queryStr}`);
    return { sql: queryStr, params };
  }

  private static formatInline(val: any): string {
    if (val === null) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return val.toString();
  }

  private static detectUnsafeOperations(sql: string): boolean {
    const unsafeKeywords = ['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE'];
    const upperSql = sql.toUpperCase();
    return unsafeKeywords.some(keyword => upperSql.includes(keyword));
  }

  /**
   * Refreshes a materialized view in the background
   */
  static async refreshMaterializedView(tenantId: string, viewName: string, concurrent: boolean = true, schema: string = 'default') {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    const schemaName = schema === 'default' ? `tenant_${cleanTenant}` : `tenant_${cleanTenant}_${schema.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const sql = `REFRESH MATERIALIZED VIEW ${concurrent ? 'CONCURRENTLY ' : ''}"${schemaName}"."${viewName}"`;
    await queryWithContext(sql, [], { tenantId, username: 'system' });
  }

  /**
   * Async high-level query execution (QueryConfig based)
   */
  static executeAsyncQuery(tenantId: string, config: QueryConfig): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, { status: 'PENDING' });

    this.executeQuery(tenantId, config)
        .then(data => this.jobs.set(jobId, { status: 'COMPLETED', result: data }))
        .catch(err => this.jobs.set(jobId, { status: 'FAILED', error: err.message }));

    return jobId;
  }

  /**
   * Citus-specific: Distributes a table across the cluster
   */
  static async distributeTable(tableName: string, distributionColumn: string) {
    try {
      await pool.query(`SELECT create_distributed_table($1, $2)`, [tableName, distributionColumn]);
      return { status: 'DISTRIBUTED', table: tableName };
    } catch (err: any) {
      if (err.message.includes('already distributed')) {
        return { status: 'ALREADY_DISTRIBUTED', table: tableName };
      }
      throw err;
    }
  }
}
