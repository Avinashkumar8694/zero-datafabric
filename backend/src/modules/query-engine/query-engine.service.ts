import { pool } from '../../config/database';
import { EventService } from '../events/event.service';
const { randomUUID } = require('crypto');

export interface QueryConfig {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 
        'CREATE_SCHEMA' | 'CREATE_TABLE' | 'CREATE_FOREIGN_TABLE' | 
        'ALTER_TABLE' | 'DROP_TABLE' | 'CREATE_INDEX' | 
        'CREATE_VIEW' | 'CREATE_SEQUENCE';
  table?: string;
  withRecursive?: {
    name: string;
    baseQuery: string; 
    recursiveQuery: string; 
  };
  select?: string[];
  filter?: Record<string, any>;
  joins?: {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
    table: string;
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
  // In-memory job store for async queries (Would be Redis in Prod)
  private static jobs = new Map<string, { status: string; result?: any; error?: any; createdAt: Date }>();

  /**
   * Distributes a table across the Citus cluster using a partition key
   */
  static async distributeTable(tableName: string, distributionColumn: string) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT * FROM pg_dist_partition WHERE logicalrelid = $1::regclass", 
        [tableName]
      );
      if (rows.length > 0) return { status: 'ALREADY_DISTRIBUTED' };
      await client.query(`SELECT create_distributed_table($1, $2)`, [tableName, distributionColumn]);
      return { status: 'DISTRIBUTED', table: tableName, key: distributionColumn };
    } catch (err: any) {
      console.error(`[QueryEngine] Distribution failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Refreshes a materialized view. Supports concurrent refresh so read queries aren't blocked.
   */
  static async refreshMaterializedView(tenantId: string, viewName: string, concurrent: boolean = true): Promise<void> {
    const safeViewName = viewName.replace(/[^a-zA-Z0-9_]/g, '');
    const schemaName = `tenant_${tenantId.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const fullPath = `"${schemaName}"."${safeViewName}"`; 
    const client = await pool.connect();
    try {
      const refreshCmd = concurrent 
          ? `REFRESH MATERIALIZED VIEW CONCURRENTLY ${fullPath}` 
          : `REFRESH MATERIALIZED VIEW ${fullPath}`;
      console.log(`[QueryEngine] Starting refresh for ${fullPath}...`);
      await client.query(refreshCmd);
      console.log(`[QueryEngine] Refresh complete for ${fullPath}.`);
      // EventService.publish('ANALYTICS', { type: 'VIEW_REFRESHED', tenantId, viewName: safeViewName, timestamp: new Date() });
    } catch (err: any) {
      console.error(`[QueryEngine] Failed to refresh ${fullPath}:`, err.message);
      if (concurrent) {
        console.log(`[QueryEngine] Retrying standard refresh for ${fullPath}...`);
        await client.query(`REFRESH MATERIALIZED VIEW ${fullPath}`);
      } else {
         throw err;
      }
    } finally {
      client.release();
    }
  }

  /**
   * Generates a SQL string and parameters from a QueryConfig without executing it.
   * Useful for CREATE VIEW or complex migration planning.
   */
  static async generateSql(tenantId: string, queryConfig: QueryConfig): Promise<{ sql: string, params: any[] }> {
    const { type, table, select, filter, joins, groupBy, orderBy, limit, offset, withRecursive, data, schemaDef, indexDef, alterDef, foreignDef, viewDef, sequenceDef } = queryConfig;
    const schemaName = `tenant_${tenantId.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const safeTable = table ? `"${schemaName}"."${table.replace(/[^a-zA-Z0-9_]/g, '')}"` : '';
    
    let queryStr = '';
    const params: any[] = [];
    let paramIndex = 1;

    if (type === 'SELECT') {
      const selectFields = select && select.length > 0 
        ? select.map(f => f.replace(/[^a-zA-Z0-9_.*(), ]/g, '')).join(', ') 
        : '*';
      
      if (withRecursive) {
         const cteName = withRecursive.name.replace(/[^a-zA-Z0-9_]/g, '');
         queryStr += `WITH RECURSIVE ${cteName} AS (
            ${withRecursive.baseQuery}
            UNION ALL
            ${withRecursive.recursiveQuery}
         ) `;
      }
      const targetTableStr = table || 'UNKNOWN_TABLE';
      const actualFromTable = (withRecursive && targetTableStr === withRecursive.name) ? targetTableStr.replace(/[^a-zA-Z0-9_]/g, '') : safeTable;
      queryStr += `SELECT ${selectFields} FROM ${actualFromTable}`;
      
      if (joins && joins.length > 0) {
        joins.forEach(join => {
           const isJoinCte = withRecursive && join.table === withRecursive.name;
           const safeJoinTable = isJoinCte ? join.table.replace(/[^a-zA-Z0-9_]/g, '') : `"${schemaName}"."${join.table.replace(/[^a-zA-Z0-9_]/g, '')}"`;
           queryStr += ` ${join.type} JOIN ${safeJoinTable} ON ${join.on}`;
        });
      }

      const whereClauses: string[] = [];
      if (filter) {
        for (const [key, value] of Object.entries(filter)) {
          whereClauses.push(`${key.replace(/[^a-zA-Z0-9_.]/g, '')} = $${paramIndex}`);
          params.push(value);
          paramIndex++;
        }
      }
      if (whereClauses.length > 0) queryStr += ` WHERE ${whereClauses.join(' AND ')}`;

      if (groupBy && groupBy.length > 0) {
        queryStr += ` GROUP BY ${groupBy.map(f => f.replace(/[^a-zA-Z0-9_.]/g, '')).join(', ')}`;
      }

      if (orderBy && orderBy.length > 0) {
        queryStr += ` ORDER BY ${orderBy.map(ob => `${ob.field.replace(/[^a-zA-Z0-9_]/g, '')} ${ob.dir === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`;
      }

      if (limit) {
         queryStr += ` LIMIT $${paramIndex}`;
         params.push(limit);
         paramIndex++;
      }
      
      if (offset) {
         queryStr += ` OFFSET $${paramIndex}`;
         params.push(offset);
         paramIndex++;
      }
    } else {
        throw new Error('generateSql currently only supports SELECT types');
    }

    return { sql: queryStr, params };
  }

  /**
   * Executes a configured dynamic query.
   * Handles SELECT, INSERT, UPDATE, DELETE, and full runtime DDL (Schema, Table, Column, Index, FDW).
   */
  static async executeQuery(tenantId: string, queryConfig: QueryConfig) {
    const client = await pool.connect();
    try {
      const { type, table, select, filter, joins, groupBy, orderBy, limit, offset, withRecursive, data, schemaDef, indexDef, alterDef, foreignDef, viewDef, sequenceDef } = queryConfig;
      const schemaName = `tenant_${tenantId.replace(/[^a-zA-Z0-9_]/g, '')}`;
      
      // Some operations (like CREATE_SCHEMA) don't require a table
      const safeTable = table ? `"${schemaName}"."${table.replace(/[^a-zA-Z0-9_]/g, '')}"` : '';
      
      let queryStr = '';
      const params: any[] = [];
      let paramIndex = 1;

      if (type === 'SELECT') {
        // Fetch masking rules from catalog for this tenant
        const { rows: maskingRules } = await pool.query(`
          SELECT column_name, description FROM fabric_catalog.metadata 
          WHERE schema_name = $1 AND table_name = $2 AND description LIKE '%MASK:%'
        `, [schemaName, table]);

        const selectFields = select && select.length > 0 
          ? select.map(f => {
              const rule = maskingRules.find(r => r.column_name === f);
              if (rule && rule.description.includes('MASK:PARTIAL')) {
                 return `LEFT(${f}, 3) || '****' as ${f}`;
              }
              return f.replace(/[^a-zA-Z0-9_.*(), ]/g, '');
            }).join(', ') 
          : '*';
        
        if (withRecursive) {
           const cteName = withRecursive.name.replace(/[^a-zA-Z0-9_]/g, '');
           queryStr += `WITH RECURSIVE ${cteName} AS (
              ${withRecursive.baseQuery}
              UNION ALL
              ${withRecursive.recursiveQuery}
           ) `;
        }
        // Safely fallback if table is undefined (though validation should prevent this)
        const targetTableStr = table || 'UNKNOWN_TABLE';
        const actualFromTable = (withRecursive && targetTableStr === withRecursive.name) ? targetTableStr.replace(/[^a-zA-Z0-9_]/g, '') : safeTable;
        queryStr += `SELECT ${selectFields} FROM ${actualFromTable}`;
        
        if (joins && joins.length > 0) {
          joins.forEach(join => {
             const isJoinCte = withRecursive && join.table === withRecursive.name;
             const safeJoinTable = isJoinCte ? join.table.replace(/[^a-zA-Z0-9_]/g, '') : `"${schemaName}"."${join.table.replace(/[^a-zA-Z0-9_]/g, '')}"`;
             queryStr += ` ${join.type} JOIN ${safeJoinTable} ON ${join.on}`;
          });
        }

        const whereClauses: string[] = [];
        if (filter) {
          for (const [key, value] of Object.entries(filter)) {
            // Allow dots for table aliases in filters (e.g. customers.id)
            whereClauses.push(`${key.replace(/[^a-zA-Z0-9_.]/g, '')} = $${paramIndex}`);
            params.push(value);
            paramIndex++;
          }
        }
        if (whereClauses.length > 0) queryStr += ` WHERE ${whereClauses.join(' AND ')}`;

        if (groupBy && groupBy.length > 0) {
          queryStr += ` GROUP BY ${groupBy.map(f => f.replace(/[^a-zA-Z0-9_.]/g, '')).join(', ')}`;
        }

        if (orderBy && orderBy.length > 0) {
          queryStr += ` ORDER BY ${orderBy.map(ob => `${ob.field.replace(/[^a-zA-Z0-9_]/g, '')} ${ob.dir === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`;
        }

        if (limit) {
           queryStr += ` LIMIT $${paramIndex}`;
           params.push(limit);
           paramIndex++;
        }
        
        if (offset) {
           queryStr += ` OFFSET $${paramIndex}`;
           params.push(offset);
           paramIndex++;
        }

      } else if (type === 'INSERT') {
        if (!safeTable) throw new Error('INSERT requires a table');
        if (!data || Array.isArray(data)) throw new Error('INSERT currently only supports single object payloads in this example');
        const keys = Object.keys(data).map(k => `"${k.replace(/[^a-zA-Z0-9_]/g, '')}"`);
        const placeholders = keys.map(() => `$${paramIndex++}`);
        Object.values(data).forEach(v => params.push(v));
        queryStr = `INSERT INTO ${safeTable} (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
        
      } else if (type === 'UPDATE') {
        if (!safeTable) throw new Error('UPDATE requires a table');
        if (!data || Array.isArray(data)) throw new Error('UPDATE requires a data object');
        const setClauses = Object.keys(data).map(k => `"${k.replace(/[^a-zA-Z0-9_]/g, '')}" = $${paramIndex++}`);
        Object.values(data).forEach(v => params.push(v));
        
        queryStr = `UPDATE ${safeTable} SET ${setClauses.join(', ')}`;
        
        const whereClauses: string[] = [];
        if (filter) {
          for (const [key, value] of Object.entries(filter)) {
            whereClauses.push(`"${key.replace(/[^a-zA-Z0-9_]/g, '')}" = $${paramIndex++}`);
            params.push(value);
          }
          if (whereClauses.length > 0) queryStr += ` WHERE ${whereClauses.join(' AND ')}`;
        }
        queryStr += ` RETURNING *`;

      } else if (type === 'DELETE') {
        if (!safeTable) throw new Error('DELETE requires a table');
        queryStr = `DELETE FROM ${safeTable}`;
        const whereClauses: string[] = [];
        if (filter) {
          for (const [key, value] of Object.entries(filter)) {
            whereClauses.push(`"${key.replace(/[^a-zA-Z0-9_]/g, '')}" = $${paramIndex++}`);
            params.push(value);
          }
          if (whereClauses.length > 0) queryStr += ` WHERE ${whereClauses.join(' AND ')}`;
        }
        queryStr += ` RETURNING *`;

      // ---------- DDL OPERATIONS ----------
      } else if (type === 'CREATE_SCHEMA') {
        queryStr = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;
        await client.query(queryStr);
        await client.query(`ALTER SCHEMA "${schemaName}" OWNER TO fabric_user`);
        await client.query(`GRANT ALL ON SCHEMA "${schemaName}" TO fabric_user`);
        await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO fabric_user`);
        await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO fabric_user`);

      } else if (type === 'CREATE_TABLE') {
        if (!safeTable) throw new Error('CREATE_TABLE requires a table');
        if (!schemaDef || !schemaDef.columns || schemaDef.columns.length === 0) throw new Error('CREATE_TABLE requires schemaDef.columns');
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`); // Auto-ensure schema
        const colDefs = schemaDef.columns.map(c => `"${c.name.replace(/[^a-zA-Z0-9_]/g, '')}" ${c.type} ${c.constraints || ''}`);
        queryStr = `CREATE TABLE IF NOT EXISTS ${safeTable} (${colDefs.join(', ')})`;
        await client.query(queryStr);
        await client.query(`ALTER TABLE ${safeTable} OWNER TO fabric_user`);
        await client.query(`GRANT ALL ON TABLE ${safeTable} TO fabric_user`);

      } else if (type === 'CREATE_FOREIGN_TABLE') {
        if (!safeTable) throw new Error('CREATE_FOREIGN_TABLE requires a table');
        if (!schemaDef || !schemaDef.columns || schemaDef.columns.length === 0) throw new Error('CREATE_FOREIGN_TABLE requires schemaDef.columns');
        if (!foreignDef || !foreignDef.serverName) throw new Error('CREATE_FOREIGN_TABLE requires foreignDef.serverName');
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`); // Auto-ensure schema
        
        const colDefs = schemaDef.columns.map(c => `"${c.name.replace(/[^a-zA-Z0-9_]/g, '')}" ${c.type} ${c.constraints || ''}`);
        
        let optionsStr = '';
        if (foreignDef.options) {
           const opts = Object.entries(foreignDef.options).map(([k, v]) => `${k} '${v.replace(/'/g, "''")}'`);
           if (opts.length > 0) optionsStr = `OPTIONS (${opts.join(', ')})`;
        }
        
        const safeServerName = `"${foreignDef.serverName.replace(/[^a-zA-Z0-9_]/g, '')}"`;
        queryStr = `CREATE FOREIGN TABLE IF NOT EXISTS ${safeTable} (${colDefs.join(', ')}) SERVER ${safeServerName} ${optionsStr}`;
        await client.query(queryStr);
        await client.query(`ALTER TABLE ${safeTable} OWNER TO fabric_user`);
        await client.query(`GRANT ALL ON TABLE ${safeTable} TO fabric_user`);

      } else if (type === 'ALTER_TABLE') {
        if (!safeTable) throw new Error('ALTER_TABLE requires a table');
        if (!alterDef || !alterDef.action || !alterDef.columnName) throw new Error('ALTER_TABLE requires alterDef');
        const safeColName = `"${alterDef.columnName.replace(/[^a-zA-Z0-9_]/g, '')}"`;
        if (alterDef.action === 'ADD_COLUMN') {
          if (!alterDef.columnType) throw new Error('ADD_COLUMN requires a columnType');
          queryStr = `ALTER TABLE ${safeTable} ADD COLUMN IF NOT EXISTS ${safeColName} ${alterDef.columnType}`;
        } else if (alterDef.action === 'DROP_COLUMN') {
          queryStr = `ALTER TABLE ${safeTable} DROP COLUMN IF EXISTS ${safeColName}`;
        }

      } else if (type === 'DROP_TABLE') {
        if (!safeTable) throw new Error('DROP_TABLE requires a table');
        queryStr = `DROP TABLE IF EXISTS ${safeTable} CASCADE`;

      } else if (type === 'CREATE_INDEX') {
        if (!safeTable) throw new Error('CREATE_INDEX requires a table');
        if (!indexDef || !indexDef.name || !indexDef.columns || indexDef.columns.length === 0) throw new Error('CREATE_INDEX requires indexDef');
        const safeIdxName = `"${indexDef.name.replace(/[^a-zA-Z0-9_]/g, '')}"`;
        const idxCols = indexDef.columns.map(c => `"${c.replace(/[^a-zA-Z0-9_]/g, '')}"`).join(', ');
        queryStr = `CREATE ${indexDef.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${safeIdxName} ON ${safeTable} (${idxCols})`;

      } else if (type === 'CREATE_VIEW') {
        if (!viewDef || !viewDef.name || !viewDef.query) throw new Error('CREATE_VIEW requires viewDef');
        const safeViewName = `"${schemaName}"."${viewDef.name.replace(/[^a-zA-Z0-9_]/g, '')}"`;
        queryStr = `CREATE ${viewDef.materialized ? 'MATERIALIZED ' : ''}VIEW ${safeViewName} AS ${viewDef.query}`;
        await client.query(queryStr);
        await client.query(`ALTER ${viewDef.materialized ? 'MATERIALIZED ' : ''}VIEW ${safeViewName} OWNER TO fabric_user`);
        await client.query(`GRANT ALL ON ${viewDef.materialized ? 'MATERIALIZED ' : ''}VIEW ${safeViewName} TO fabric_user`);

      } else if (type === 'CREATE_SEQUENCE') {
        if (!sequenceDef || !sequenceDef.name) throw new Error('CREATE_SEQUENCE requires sequenceDef');
        const safeSeqName = `"${schemaName}"."${sequenceDef.name.replace(/[^a-zA-Z0-9_]/g, '')}"`;
        queryStr = `CREATE SEQUENCE IF NOT EXISTS ${safeSeqName} START WITH ${sequenceDef.start || 1} INCREMENT BY ${sequenceDef.increment || 1}`;
        await client.query(queryStr);
        await client.query(`ALTER SEQUENCE ${safeSeqName} OWNER TO fabric_user`);
        await client.query(`GRANT ALL ON SEQUENCE ${safeSeqName} TO fabric_user`);

      } else {
        throw new Error(`Unsupported query type: ${type}`);
      }
      
      const { rows, command, rowCount } = await client.query(queryStr, params);
      
      // For DDL, return a summary rather than rows
      const ddlTypes = ['CREATE_SCHEMA', 'CREATE_TABLE', 'CREATE_FOREIGN_TABLE', 'ALTER_TABLE', 'DROP_TABLE', 'CREATE_INDEX', 'CREATE_VIEW', 'CREATE_SEQUENCE'];
      if (ddlTypes.includes(type)) {
         return { command, target: type === 'CREATE_SCHEMA' ? schemaName : (type === 'CREATE_VIEW' ? viewDef?.name : (type === 'CREATE_SEQUENCE' ? sequenceDef?.name : safeTable)), status: 'SUCCESS' };
      }
      // For DML, return rows or affected count
      return type === 'SELECT' ? rows : { command, rowCount, returning: rows };
    } catch (err: any) {
      console.error(`[QueryEngine] Execution failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Asynchronous Execution Model for Long-Running Analytics
   * Generates a jobId, runs the query in the background, and returns the jobId immediately.
   */
  static executeAsyncQuery(tenantId: string, queryConfig: QueryConfig): string {
    const jobId = randomUUID();
    
    // Initialize job in the store
    QueryEngineService.jobs.set(jobId, { status: 'PENDING', createdAt: new Date() });

    // Execute in background
    QueryEngineService.executeQuery(tenantId, queryConfig)
      .then(result => {
        QueryEngineService.jobs.set(jobId, { status: 'COMPLETED', result, createdAt: new Date() });
      })
      .catch(error => {
        QueryEngineService.jobs.set(jobId, { status: 'FAILED', error: error.message, createdAt: new Date() });
      });

    return jobId;
  }

  /**
   * Performance & Cost Governance Safety Shield
   * Prevents runaway queries and accidental data wipes
   */
  static applySafetyShield(sql: string): { sanitizedSql: string, safetyApplied: boolean } {
    let sanitizedSql = sql.trim();
    let safetyApplied = false;

    // 1. Enforce LIMIT on SELECTs if missing
    if (sanitizedSql.toUpperCase().startsWith('SELECT') && !sanitizedSql.toUpperCase().includes('LIMIT')) {
      sanitizedSql = `${sanitizedSql.replace(/;$/, '')} LIMIT 1000`;
      safetyApplied = true;
    }

    // 2. Block Dangerous Mutations without WHERE
    const upperSql = sanitizedSql.toUpperCase();
    if ((upperSql.startsWith('DELETE') || upperSql.startsWith('UPDATE')) && !upperSql.includes('WHERE')) {
      throw new Error('INDUSTRIAL GOVERNANCE BLOCK: Destructive operations without a WHERE clause are prohibited.');
    }

    return { sanitizedSql, safetyApplied };
  }

  /**
   * Execute Synchronous SQL with RLS Injection and Parameters
   */
  static async executeRawSql(tenantId: string, username: string, sql: string, params: any[] = []) {
    const { queryWithContext } = require('../../config/database');
    const { sanitizedSql, safetyApplied } = this.applySafetyShield(sql);
    
    const result = await queryWithContext(sanitizedSql, params, { 
      tenantId, 
      username 
    });

    return {
      results: result.rows,
      safetyApplied
    };
  }

  /**
   * Asynchronous Raw SQL Execution with Parameters
   */
  static executeAsyncRawSql(tenantId: string, username: string, sql: string, params: any[] = []): string {
    const jobId = randomUUID();
    
    QueryEngineService.jobs.set(jobId, { status: 'PENDING', createdAt: new Date() });
    
    QueryEngineService.executeRawSql(tenantId, username, sql, params)
      .then(result => {
        QueryEngineService.jobs.set(jobId, { status: 'COMPLETED', result, createdAt: new Date() });
      })
      .catch(error => {
        QueryEngineService.jobs.set(jobId, { status: 'FAILED', error: error.message, createdAt: new Date() });
      });

    return jobId;
  }

  /**
   * Fetch the status of an asynchronous query job.
   */
  static getJobStatus(jobId: string) {
    const job = QueryEngineService.jobs.get(jobId);
    if (!job) {
      return { status: 'NOT_FOUND', message: 'Job ID does not exist or has expired.' };
    }
    return job;
  }
}

