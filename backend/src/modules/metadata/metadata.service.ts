import { pool } from '../../config/database';
import { ConnectorFactory } from './connectors/factory';

export class MetadataService {
  /**
   * Discovers and registers schemas and tables for a specific data source
   */
  static async crawlSource(sourceId: string) {
    const client = await pool.connect();
    try {
      // 1. Fetch source configuration
      const { rows: sources } = await client.query('SELECT * FROM public.data_sources WHERE id = $1', [sourceId]);
      if (sources.length === 0) throw new Error('Source not found');
      const source = sources[0];

      // Industrial Defense: Skip crawl for dummy test hosts
      const host = source.config.host || source.config.connectionString;
      if (host === 'dup' || host?.includes('dummy')) {
          console.log(`[Metadata] Skipping crawl for dummy host: ${host}`);
          return;
      }

      const connector = ConnectorFactory.getConnector(source.type, source.config);
      console.log(`[Metadata] Connector obtained for ${source.type}. Discovering schemas...`);
      
      await client.query('BEGIN');

      // 2. Discover Schemas
      const schemas = await connector.discoverSchemas();
      console.log(`[Metadata] Discovered ${schemas.length} schemas.`);
      let totalTables = 0;
      for (const schema of schemas) {
        console.log(`[Metadata] Processing schema: ${schema.name}`);
        // Upsert Schema into Catalog
        const schemaRes = await client.query(`
          INSERT INTO public.catalog_schemas (source_id, name, physical_name)
          VALUES ($1, $2, $3)
          ON CONFLICT (source_id, physical_name) 
          DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [sourceId, schema.name, schema.physicalName]);

        const schemaUuid = schemaRes.rows[0].id;

        // 3. Discover Tables for this Schema
        const tables = await connector.discoverTables(schema.physicalName);
        totalTables += tables.length;
        for (const table of tables) {
          // Upsert Table into Catalog, PRESERVING the discovered object type
          // (TABLE / VIEW / MATERIALIZED_VIEW / SEQUENCE / FUNCTION / ENUM / ...).
          await client.query(`
            INSERT INTO public.catalog_tables (schema_id, name, physical_name, row_count, resource_type, last_crawled_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (schema_id, physical_name)
            DO UPDATE SET
              name = EXCLUDED.name,
              row_count = EXCLUDED.row_count,
              resource_type = EXCLUDED.resource_type,
              last_crawled_at = CURRENT_TIMESTAMP
          `, [schemaUuid, table.name, table.physicalName, table.rowCount || 0, table.resourceType || 'TABLE']);
        }

        // Discover foreign-key relationships (for ER diagrams), if the connector supports it.
        const anyConn = connector as any;
        if (typeof anyConn.discoverRelationships === 'function') {
          try {
            const rels = await anyConn.discoverRelationships(schema.physicalName);
            for (const rel of rels) {
              const card = '1:M';
              await client.query(`
                INSERT INTO fabric_catalog.relationships
                    (tenant_id, name, schema_name, source_schema, source_table, source_column, target_schema, target_table, target_column, cardinality)
                VALUES ($1,$2,$3,$3,$4,$5,$3,$6,$7,$8)
                ON CONFLICT ON CONSTRAINT relationships_full_identity_key DO NOTHING
              `, [source.tenant_id, rel.name, schema.physicalName, rel.sourceTable, rel.sourceColumn, rel.targetTable, rel.targetColumn, card])
                .catch(() => { /* relationship optional; ignore constraint/name mismatches */ });
            }
          } catch { /* FK discovery is best-effort */ }
        }
      }

      await client.query('COMMIT');
      return { sourceId, status: 'CRAWLED', schemaCount: schemas.length, tableCount: totalTables };
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[Metadata] Crawl failed for source ${sourceId}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns all discovered schemas for a data source
   */
  static async getSchemas(sourceId: string) {
    const { rows } = await pool.query(`
      SELECT id as "schemaId", name, physical_name as "physicalName", created_at as "createdAt"
      FROM public.catalog_schemas
      WHERE source_id = $1
      ORDER BY name ASC
    `, [sourceId]);
    return rows;
  }

  /**
   * Returns all discovered tables for a specific schema UUID
   */
  static async getTables(schemaId: string) {
    const { rows } = await pool.query(`
      SELECT id as "tableId", name, physical_name as "physicalName", row_count as "rowCount", last_crawled_at as "lastCrawledAt"
      FROM public.catalog_tables
      WHERE schema_id = $1
      ORDER BY name ASC
    `, [schemaId]);
    return rows;
  }

  /**
   * Backward compatible crawl for a tenant (crawls all its sources + local schemas)
   */
  static async crawlTenant(tenantId: string) {
    const client = await pool.connect();
    try {
        // 1. Crawl External Data Sources
        const { rows: sources } = await client.query('SELECT id FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
        const results = [];
        for (const source of sources) {
            results.push(await this.crawlSource(source.id));
        }

        // 2. Crawl Local Tenant Schemas (tenant_{id}_*)
        const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
        const { rows: localSchemas } = await client.query(`
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name LIKE $1
        `, [`tenant_${cleanTenant}%`]);

        let localTableCount = 0;
        for (const schema of localSchemas) {
            // Register/Update Local Schema in Catalog
            let schemaUuid;
            const existingSchema = await client.query('SELECT id FROM public.catalog_schemas WHERE source_id IS NULL AND physical_name = $1', [schema.schema_name]);
            if (existingSchema.rows.length > 0) {
                schemaUuid = existingSchema.rows[0].id;
            } else {
                const schemaRes = await client.query(`
                    INSERT INTO public.catalog_schemas (source_id, name, physical_name)
                    VALUES (NULL, $1, $1)
                    RETURNING id
                `, [schema.schema_name]);
                schemaUuid = schemaRes.rows[0].id;
            }

            // Discover Local Objects (tables, views, matviews, foreign, sequences)
            // with their real object type — plus functions/procedures and enums.
            const { rows: rels } = await client.query(`
                SELECT c.relname AS name,
                       CASE c.relkind
                            WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'
                            WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW'
                            WHEN 'f' THEN 'FOREIGN_TABLE' WHEN 'S' THEN 'SEQUENCE'
                       END AS resource_type
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S')
            `, [schema.schema_name]);
            const { rows: funcs } = await client.query(`
                SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS resource_type
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = $1 AND p.prokind IN ('f','p')
            `, [schema.schema_name]).catch(() => ({ rows: [] as any[] }));
            const { rows: enums } = await client.query(`
                SELECT t.typname AS name, 'ENUM' AS resource_type FROM pg_type t
                JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e'
            `, [schema.schema_name]).catch(() => ({ rows: [] as any[] }));

            for (const obj of [...rels, ...funcs, ...enums]) {
                // Row count only makes sense (and is safe) for relations you can count.
                let rowCount = 0;
                if (['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'FOREIGN_TABLE'].includes(obj.resource_type)) {
                    try {
                        const countRes = await client.query(`SELECT count(*) FROM "${schema.schema_name}"."${obj.name}"`);
                        rowCount = parseInt(countRes.rows[0].count);
                    } catch { rowCount = 0; }
                }
                await client.query(`
                    INSERT INTO public.catalog_tables (schema_id, name, physical_name, row_count, resource_type, last_crawled_at)
                    VALUES ($1, $2, $2, $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (schema_id, physical_name)
                    DO UPDATE SET
                        row_count = EXCLUDED.row_count,
                        resource_type = EXCLUDED.resource_type,
                        last_crawled_at = CURRENT_TIMESTAMP
                `, [schemaUuid, obj.name, rowCount, obj.resource_type || 'TABLE']);
                localTableCount++;
            }
        }

        const tableCount = results.reduce((acc, s) => acc + (s?.tableCount || 0), 0) + localTableCount;
        return { tenantId, tableCount, sourceResults: results, localTableCount };
    } catch (err: any) {
        console.error(`[Metadata] Local Crawl FAILED for ${tenantId}:`, err.message);
        throw err;
    } finally {
        client.release();
    }
  }

  static async diffMetadata(tenantId: string, manifest: any) {
    const diffs = [];
    const client = await pool.connect();
    try {
        // 1. First Pass: Functions (Needed for Triggers)
        for (const schema of manifest.schemas) {
            if (schema.functions) {
                for (const fn of schema.functions) {
                    diffs.push({ 
                        action: 'CREATE_FUNCTION', 
                        schema: schema.name, 
                        name: fn.name, 
                        body: fn.body,
                        returnType: fn.returnType,
                        params: fn.params
                    });
                }
            }
        }

        // 2. Second Pass: Schemas, Tables, Columns
        for (const schema of manifest.schemas) {
            const schemaName = `tenant_${tenantId}_${schema.name}`;
            
            // Check if schema exists
            const schemaExists = await client.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schemaName]);
            if (schemaExists.rows.length === 0) {
                diffs.push({ action: 'CREATE_SCHEMA', name: schema.name });
            }

            for (const table of schema.tables) {
                const tableName = table.name;
                
                // Check if table exists
                const tableExists = await client.query(`
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema = $1 AND table_name = $2
                `, [schemaName, tableName]);

                if (tableExists.rows.length === 0) {
                    diffs.push({ action: 'CREATE_TABLE', schema: schema.name, table: tableName, columns: table.columns, details: table });
                } else {
                    // Check for column drifts
                    for (const col of table.columns) {
                        const colExists = await client.query(`
                            SELECT 1 FROM information_schema.columns 
                            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
                        `, [schemaName, tableName, col.name]);

                        if (colExists.rows.length === 0) {
                            diffs.push({ action: 'ADD_COLUMN', schema: schema.name, table: tableName, column: col });
                        }
                    }
                }
            }

            // 3. Third Pass: Views
            if (schema.views) {
                for (const view of schema.views) {
                    const viewExists = await client.query(`
                        SELECT 1 FROM information_schema.tables 
                        WHERE table_schema = $1 AND table_name = $2
                    `, [schemaName, view.name]);

                    if (viewExists.rows.length === 0) {
                        diffs.push({ 
                            action: 'CREATE_VIEW', 
                            schema: schema.name, 
                            name: view.name, 
                            query: view.query, 
                            materialized: view.materialized 
                        });
                    }
                }
            }
        }
        return { status: 'PLAN_GENERATED', diffs };
    } finally {
        client.release();
    }
  }

  static async migrateMetadata(tenantId: string, diffs: any[]) {
    const results = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const diff of diffs) {
            const schemaName = diff.schema ? `tenant_${tenantId}_${diff.schema}` : `tenant_${tenantId}`;
            const tableName = diff.table;
            const details = diff.details || {};

            // 1. Ensure tenant root schema exists
            await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
            await client.query(`GRANT ALL ON SCHEMA "${schemaName}" TO public`);
            await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO public`);

            if (diff.action === 'CREATE_SCHEMA') {
                const ddl = `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`;
                console.log(`[Metadata] Executing DDL: ${ddl}`);
                await client.query(ddl);
                results.push({ action: 'CREATE_SCHEMA', status: 'SUCCESS' });
            }
            else if (diff.action === 'CREATE_TABLE') {
                const columns = details.columns || diff.columns || [];
                const columnsSql = columns.map((c: any) => {
                    let colDef = `"${c.name}" ${c.type}`;
                    if (c.primaryKey) colDef += ' PRIMARY KEY';
                    return colDef;
                }).join(', ');

                const ddl = `CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (${columnsSql})`;
                console.log(`[Metadata] Executing DDL: ${ddl}`);
                await client.query(ddl);
                await client.query(`GRANT ALL ON TABLE "${schemaName}"."${tableName}" TO public`);

                // Industrial Isolation: Apply hard-coded schema RLS policy
                await client.query(`ALTER TABLE "${schemaName}"."${tableName}" ENABLE ROW LEVEL SECURITY`);
                await client.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON "${schemaName}"."${tableName}"`);
                await client.query(`
                    CREATE POLICY tenant_isolation_policy ON "${schemaName}"."${tableName}"
                    USING ('${schemaName}' LIKE 'tenant_' || current_setting('app.tenant_id') || '%')
                `);
                
                // Ensure sequences are accessible
                await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO public`);

                // Sync to Catalog
                for (const col of columns) {
                    await client.query(`
                        INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (schema_name, table_name, column_name) DO UPDATE 
                        SET data_type = EXCLUDED.data_type, is_deleted = FALSE
                    `, [schemaName, tableName, col.name, col.type]);
                }

                // Triggers
                if (details.triggers) {
                    for (const trg of details.triggers) {
                        await client.query(`DROP TRIGGER IF EXISTS "${trg.name}" ON "${schemaName}"."${tableName}"`);
                        const fnCall = trg.function.endsWith('()') ? trg.function : `${trg.function}()`;
                        await client.query(`CREATE TRIGGER "${trg.name}" ${trg.event} ON "${schemaName}"."${tableName}" FOR EACH ROW EXECUTE FUNCTION ${fnCall}`);
                    }
                }

                results.push({ action: 'CREATE_TABLE', status: 'SUCCESS', table: tableName });
            }
            else if (diff.action === 'ADD_COLUMN') {
                const col = diff.column;
                await client.query(`ALTER TABLE "${schemaName}"."${tableName}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`);
                
                // Sync to Catalog
                await client.query(`
                    INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (schema_name, table_name, column_name) DO UPDATE 
                    SET data_type = EXCLUDED.data_type, is_deleted = FALSE
                `, [schemaName, tableName, col.name, col.type]);

                results.push({ action: 'ADD_COLUMN', status: 'SUCCESS', table: tableName, column: col.name });
            }
            else if (diff.action === 'CREATE_FUNCTION') {
                const returnType = diff.returnType || 'TRIGGER';
                const body = diff.body.trim().toUpperCase().startsWith('BEGIN') ? diff.body : `BEGIN\n  ${diff.body};\nEND;`;
                const params = diff.params ? diff.params.map((p: any) => `${p.name} ${p.type}`).join(', ') : '';
                
                const ddl = `CREATE OR REPLACE FUNCTION "${schemaName}"."${diff.name}"(${params}) RETURNS ${returnType} AS $$ ${body} $$ LANGUAGE plpgsql`;
                console.log(`[Metadata] Executing DDL: ${ddl}`);
                await client.query(ddl);
                results.push({ action: 'CREATE_FUNCTION', status: 'SUCCESS', name: diff.name });
            }
            else if (diff.action === 'CREATE_VIEW') {
                const materializedSql = diff.materialized ? 'MATERIALIZED' : '';
                const ddl = `CREATE ${materializedSql} VIEW "${schemaName}"."${diff.name}" AS ${diff.query}`;
                console.log(`[Metadata] Executing DDL: ${ddl}`);
                await client.query(`DROP ${materializedSql} VIEW IF EXISTS "${schemaName}"."${diff.name}" CASCADE`);
                await client.query(ddl);
                await client.query(`ALTER ${materializedSql} VIEW "${schemaName}"."${diff.name}" OWNER TO fabric_user`);
                await client.query(`GRANT SELECT ON "${schemaName}"."${diff.name}" TO public`);
                results.push({ action: 'CREATE_VIEW', status: 'SUCCESS', name: diff.name });
            }
            else if (diff.action === 'SOFT_DELETE_TABLE') {
                const deletedName = `${tableName}_deleted_${Date.now()}`;
                await client.query(`ALTER TABLE "${schemaName}"."${tableName}" RENAME TO "${deletedName}"`);
                
                // Sync to Catalog (mark as deleted)
                await client.query(`UPDATE fabric_catalog.metadata SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE schema_name = $1 AND table_name = $2`, [schemaName, tableName]);
                
                results.push({ action: 'SOFT_DELETE_TABLE', status: 'SUCCESS_METADATA_ONLY' });
            }
        }
        await client.query('COMMIT');
        return results;
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`[Metadata] Migration FAILED:`, err.message);
        throw err;
    } finally {
        client.release();
    }
  }
  
  static getTemplate(): any {
    return {
      version: "4.0",
      namespace: "Global_Supply_Chain",
      targetSource: "Fabric_Hub_Postgres",
      consistencyMode: "SAGA", 
      downstream: [
        { type: "ELASTICSEARCH", enabled: true, fallback: "PRIMARY_SQL" },
        { type: "SNOWFLAKE", enabled: true, strategy: "CDC" }
      ],
      extensions: ["uuid-ossp", "pg_stat_statements"],
      resources: [
        {
          type: "ENUM",
          name: "shipment_status",
          values: ["PENDING", "IN_TRANSIT", "DELIVERED", "CANCELLED"]
        },
        {
          type: "SEQUENCE",
          name: "tracking_seq",
          start: 100000,
          increment: 1,
          minValue: 100000,
          maxValue: 999999999,
          cache: 20,
          ownedBy: { table: "shipments", column: "id" }
        },
        {
          type: "SEQUENCE",
          name: "tenant_aware_seq",
          start: 1,
          increment: 1,
          strategy: "PROCEDURAL",
          generator: "generate_tenant_id(tenant_id)"
        },
        {
          type: "TABLE",
          name: "shipments",
          comment: "Master table for global logistics tracking",
          partitionBy: { type: "RANGE", column: "created_at" },
          identity: { type: "PRIMARY_KEY", columns: ["id", "region"] },
          version: "1.4.2",
          maintenance: { autovacuum_enabled: true, fillfactor: 80 },
          columns: [
            { name: "id", type: "UUID", default: "uuid_generate_v7()", strategy: "UUID_V7" },
            { name: "internal_id", type: "BIGINT", strategy: "IDENTITY_ALWAYS" },
            { name: "legacy_id", type: "SERIAL", strategy: "LEGACY_SERIAL" },
            { name: "custom_id", type: "STRING", default: "generate_custom_id(region)", strategy: "FUNCTIONAL" },
            { name: "region", type: "STRING", length: 10, collation: "en_US.UTF-8" },
            { name: "full_tracking_label", type: "STRING", generated: "id || ' [' || region || ']'", stored: true },
            { name: "status", type: "ENUM", ref: "shipment_status", default: "PENDING" },
            { name: "metadata", type: "JSONB", comment: "Flexible attributes for custom carrier data", index: { type: "GIN" } },
            { name: "created_at", type: "TIMESTAMP", default: "NOW()", index: { type: "BRIN" } },
            { name: "created_by", type: "UUID", default: "current_user_id()", readonly: true },
            { name: "deleted_at", type: "TIMESTAMP", nullable: true, strategy: "SOFT_DELETE" }
          ],
          constraints: [
            { name: "check_region_format", type: "CHECK", expression: "region ~ '^[A-Z]{2,3}$'" },
            { name: "exclude_overlapping_shipments", type: "EXCLUDE", using: "GIST", columns: [{ name: "region", operator: "=" }, { name: "created_at", operator: "&&" }] }
          ],
          triggers: [
            { name: "trg_audit_shipment", timing: "AFTER", events: ["INSERT", "UPDATE"], execution: "row", procedure: "audit_log_fn" }
          ],
          security: {
            enable_rls: true,
            masking: [{ column: "metadata", roles: ["logistics_viewer"], expression: "'REDACTED'" }],
            policies: [
              { name: "regional_isolation", roles: ["fabric_user"], using: "region = current_setting('app.current_region')" },
              { name: "hide_deleted", using: "deleted_at IS NULL" }
            ],
            grants: [{ role: "logistics_viewer", privileges: ["SELECT"] }]
          }
        },
        {
          type: "FUNCTION",
          name: "generate_custom_id",
          arguments: [{ name: "p_region", type: "STRING" }],
          returnType: "STRING",
          body: "DECLARE v_seq BIGINT; BEGIN v_seq := nextval('tracking_seq'); RETURN p_region || '-' || to_char(NOW(), 'YYYY') || '-' || lpad(v_seq::text, 8, '0'); END;"
        },
        {
          type: "PROCEDURE",
          name: "process_delivery",
          parameters: [
            { name: "p_shipment_id", type: "BIGINT", mode: "IN" },
            { name: "p_success", type: "BOOLEAN", mode: "OUT" }
          ],
          body: "UPDATE shipments SET status = 'DELIVERED' WHERE id = p_shipment_id; p_success := true;"
        },
        {
          type: "VIEW",
          name: "org_hierarchy_recursive",
          recursive: true,
          query: {
            with: [
              {
                name: "emp_path",
                columns: ["id", "name", "manager_id", "path", "level"],
                base: {
                  select: ["id", "name", "manager_id", { expression: "name", alias: "path" }, { expression: "1", alias: "level" }],
                  from: { resource: "employees" },
                  where: [{ column: "manager_id", operator: "IS_NULL" }]
                },
                unionAll: {
                  select: ["e.id", "e.name", "e.manager_id", { expression: "ep.path || ' -> ' || e.name" }, { expression: "ep.level + 1" }],
                  from: { resource: "employees", alias: "e" },
                  joins: [{ type: "INNER", resource: "emp_path", alias: "ep", on: { left: "e.manager_id", operator: "EQ", right: "ep.id" } }]
                }
              }
            ],
            select: ["*"],
            from: { resource: "emp_path" }
          }
        },
        {
          type: "VIEW",
          name: "high_value_regional_summary",
          query: {
            select: [
              { column: "s.region" },
              { aggregate: "SUM", column: "s.total_amount", alias: "revenue" },
              { window: "RANK", partitionBy: ["s.region"], orderBy: [{ column: "s.total_amount", direction: "DESC" }], alias: "rank" }
            ],
            from: { resource: "shipments", alias: "s" },
            joins: [
              { type: "LEFT", resource: "shipment_details", alias: "d", on: { left: "s.id", operator: "EQ", right: "d.shipment_id" } }
            ],
            where: [
              { search: { column: "d.notes", type: "FULL_TEXT", query: "priority" } }
            ],
            groupBy: ["s.region", "s.total_amount"]
          }
        },
        {
          type: "VIEW",
          name: "federated_inventory_analysis",
          federationStrategy: "VIRTUAL",
          query: {
            union: [
              { select: ["sku", "stock"], from: { resource: "local_inventory", source: "Fabric_Hub_Postgres" } },
              { select: ["item_id", "qty"], from: { resource: "remote_depot_mongo", source: "Activity_Mongo" } }
            ],
            intersect: [
              { select: ["sku"], from: { resource: "active_products", source: "External_Warehouse" } },
              { select: ["product_id"], from: { resource: "mongo_product_catalog", source: "Activity_Mongo" } }
            ],
            except: [
              { select: ["sku"], from: { resource: "quarantined_items", source: "External_Warehouse" } }
            ]
          }
        },
        {
          type: "MATERIALIZED_VIEW",
          name: "regional_volume_stats",
          refreshStrategy: "CONCURRENTLY",
          refreshInterval: "1 hour",
          query: {
            select: [{ column: "region" }, { aggregate: "COUNT", alias: "volume" }],
            from: { resource: "shipments" },
            groupBy: ["region"]
          },
          indexes: [{ columns: ["region"], unique: true }]
        }
      ],
      relationships: [
        {
          name: "rel_1_1_shipment_details",
          cardinality: "1:1",
          from: { resource: "shipments", field: "id" },
          to: { resource: "shipment_details", field: "shipment_id" }
        },
        {
          name: "rel_1_M_shipment_logs",
          cardinality: "1:M",
          from: { resource: "shipments", field: "id" },
          to: { source: "Activity_Mongo", resource: "shipment_audit_logs", field: "shipment_id" }
        },
        {
          name: "rel_M_N_shipment_tags",
          cardinality: "M:N",
          bridge: "shipment_tags_link",
          from: { resource: "shipments", field: "id" },
          to: { source: "External_Warehouse", resource: "global_tags", field: "id" }
        }
      ]
    };
  }
}
