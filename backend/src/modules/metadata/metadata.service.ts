/**
 * Metadata catalog crawling, legacy diff/migrate, and manifest export.
 * ------------------------------------------------------------------
 * Discovery-side counterpart to `MetadataOrchestrator`: instead of applying a
 * declared manifest, this service introspects EXISTING physical stores
 * (registered heterogeneous data sources via `ConnectorFactory`, or the local
 * tenant Postgres schemas) and registers what it finds into the fabric
 * catalog (`public.catalog_schemas` / `public.catalog_tables`) so the UI
 * Explorer and query engine can see them. It also provides `exportManifest`,
 * the reverse operation — reconstructing a portable `MetadataManifest` from
 * the current catalog — and a static onboarding `getTemplate`. The
 * `diffMetadata`/`migrateMetadata` pair is an earlier, simpler manifest
 * apply path retained for backward compatibility; `MetadataOrchestrator`
 * (plan/apply) is the current, richer implementation.
 */
import { pool } from '../../config/database';
import { ConnectorFactory } from './connectors/factory';

/**
 * Catalog crawling, legacy manifest diff/migrate, and manifest export
 * service for the metadata module.
 * @class
 * @hideconstructor
 */
export class MetadataService {
  /**
   * Discovers and registers a data source's schemas and tables into the
   * fabric catalog. Skips known dummy/test hosts. Also opportunistically
   * discovers foreign-key relationships (best-effort; failures are
   * swallowed) when the connector supports `discoverRelationships`. Runs
   * inside a transaction so a partial crawl doesn't leave the catalog
   * half-updated.
   * @param sourceId `public.data_sources` row id to crawl.
   * @returns `(sourceId, status: 'CRAWLED', schemaCount, tableCount)`.
   * @throws {Error} If the source doesn't exist, or if schema/table discovery or catalog upserts fail (transaction is rolled back first).
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
   * Returns all discovered schemas for a data source.
   * @param sourceId `public.data_sources` row id.
   * @returns Rows of `(schemaId, name, physicalName, createdAt)`, ordered by name.
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
   * Returns all discovered tables for a specific schema UUID.
   * @param schemaId `public.catalog_schemas` row id.
   * @returns Rows of `(tableId, name, physicalName, rowCount, lastCrawledAt)`, ordered by name.
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
   * Backward-compatible crawl for a tenant: crawls every registered external
   * data source (`crawlSource`, resiliently — a failed source is recorded and
   * skipped rather than aborting the rest) plus the tenant's local Postgres
   * schemas (`tenant_{id}_*`), registering all discovered tables/views/
   * materialized views/foreign tables/sequences/functions/procedures/enums
   * into the catalog with best-effort row counts.
   * @param tenantId Tenant scope; local schemas are matched by the `tenant_{tenantId}%` name pattern.
   * @returns `(tenantId, tableCount, sourceResults, localTableCount)` where `tableCount` is the combined total across sources and local schemas.
   * @throws Rethrows any error from the local-schema crawl phase (per-source crawl failures are caught individually and do not throw).
   */
  static async crawlTenant(tenantId: string) {
    const client = await pool.connect();
    try {
        // 1. Crawl External Data Sources
        const { rows: sources } = await client.query('SELECT id, name FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
        const results = [];
        // Resilient per-source crawl: an unreachable / misconfigured source (e.g. a
        // missing password) is recorded as FAILED and skipped — it must not abort the
        // crawl of every other source.
        for (const source of sources) {
            try {
                results.push(await this.crawlSource(source.id));
            } catch (e: any) {
                console.warn(`[Crawl] source ${source.name} (${source.id}) failed: ${e.message}`);
                results.push({ sourceId: source.id, source: source.name, status: 'FAILED', error: e.message });
            }
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

        const tableCount = results.reduce((acc, s: any) => acc + (s?.tableCount || 0), 0) + localTableCount;
        return { tenantId, tableCount, sourceResults: results, localTableCount };
    } catch (err: any) {
        console.error(`[Metadata] Local Crawl FAILED for ${tenantId}:`, err.message);
        throw err;
    } finally {
        client.release();
    }
  }

  /**
   * Legacy manifest diff routine (superseded by `DiffEngine.compare` for the
   * v4.0 manifest spec, but retained for the older `(schema.tables/views/functions)`
   * shape). Checks schema existence, per-table existence and per-column drift,
   * and view existence, emitting `CREATE_SCHEMA`/`CREATE_TABLE`/`ADD_COLUMN`/
   * `CREATE_VIEW`/`CREATE_FUNCTION` diffs. Functions are diffed first since
   * tables may reference them (e.g. via triggers).
   * @param tenantId Tenant scope; physical schema names are derived as `tenant_{tenantId}_(schema.name)`.
   * @param manifest Legacy-shaped manifest (`(schemas: [( name, tables, views?, functions? )])`).
   * @returns `(status: 'PLAN_GENERATED', diffs)`.
   */
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

  /**
   * Legacy manifest apply routine that executes the diffs produced by
   * `diffMetadata` (superseded by `MetadataOrchestrator.apply` for the v4.0
   * spec). Ensures the tenant root schema exists, then for each diff runs the
   * corresponding DDL (`CREATE_SCHEMA`/`CREATE_TABLE`/`ADD_COLUMN`/
   * `CREATE_FUNCTION`/`CREATE_VIEW`/`SOFT_DELETE_TABLE`), applying a
   * hard-coded tenant-isolation RLS policy to every created table and mirroring
   * column metadata into `fabric_catalog.metadata`. Runs inside a single
   * transaction; any failure rolls back all diffs together.
   * @param tenantId Tenant scope; physical schema names are derived as `tenant_{tenantId}[_{diff.schema}]`.
   * @param diffs Diff entries as produced by `diffMetadata`.
   * @returns One result entry per diff (`(action, status, ...)`).
   * @throws Rethrows any DDL/query error after rolling back the transaction.
   */
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
  
  /**
   * Export the current catalog as a datafabric manifest (the reverse of apply).
   * Prefers each resource's stored definition_ast (perfect round-trip for
   * manifest-applied objects); for crawled objects it reconstructs columns via
   * live introspection. Pass sourceName to export a single, self-contained source.
   * System schemas (`pg_catalog`, `information_schema`, `pg_toast`, temp schemas)
   * are always omitted. Relationships are included only when both endpoints are
   * present in the export (self-contained when `sourceName` scopes to one source);
   * a single-source export additionally flags resources that reference other
   * data sources via `warnings`, since re-applying it alone wouldn't be sufficient.
   * @param tenantId Tenant scope.
   * @param sourceName When supplied, scopes the export to a single named data source instead of every source registered for the tenant.
   * @returns A `MetadataManifest`-shaped object (`version: '1.0-export'`) plus `exportedAt`, and optionally `warnings` when `sourceName` resources depend on other sources.
   */
  static async exportManifest(tenantId: string, sourceName?: string): Promise<any> {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '');
    const srcParams: any[] = [tenantId];
    let srcSql = `SELECT id, name, type, config FROM public.data_sources WHERE tenant_id = $1`;
    if (sourceName) { srcParams.push(sourceName); srcSql += ` AND name = $2`; }
    const { rows: sources } = await pool.query(srcSql, srcParams);

    const schemas: any[] = [];
    const exportedTables = new Set<string>(); // schemaName.tableName present in this export

    const SYSTEM_SCHEMAS = new Set(['pg_toast', 'pg_catalog', 'information_schema']);
    const isSystemSchema = (n: string) => SYSTEM_SCHEMAS.has(n) || /^pg_(toast_)?temp/.test(n) || n.startsWith('pg_');
    for (const source of sources) {
      const { rows: cats } = await pool.query(
        `SELECT id, name, physical_name FROM public.catalog_schemas WHERE source_id = $1`, [source.id]);
      for (const cat of cats) {
        if (isSystemSchema(cat.name)) continue; // omit Postgres system schemas from a portable manifest
        const { rows: objs } = await pool.query(
          `SELECT name, physical_name, resource_type, definition_ast, definition_sql
           FROM public.catalog_tables WHERE schema_id = $1`, [cat.id]);
        const resources: any[] = [];
        for (const o of objs) {
          // Child metadata rows (a table's policies/triggers) are folded into their table's AST.
          if (o.resource_type === 'POLICY' || o.resource_type === 'TRIGGER' || String(o.name).includes('.')) continue;

          if (o.definition_ast && typeof o.definition_ast === 'object') {
            resources.push(o.definition_ast); // round-trip manifest-applied resource verbatim
          } else if (['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'FOREIGN_TABLE'].includes(o.resource_type)) {
            const columns = await this.introspectColumns(source, cat.physical_name, o.physical_name);
            const type = o.resource_type === 'FOREIGN_TABLE' ? 'TABLE' : o.resource_type;
            const res: any = { type, name: o.name };
            if (columns.length) res.columns = columns;
            if (o.definition_sql && type !== 'TABLE') res.definitionSql = o.definition_sql;
            resources.push(res);
          } else {
            // SEQUENCE / FUNCTION / PROCEDURE / ENUM without an AST — name-level export.
            resources.push({ type: o.resource_type, name: o.name });
          }
          exportedTables.add(`${cat.name}.${o.name}`);
        }
        schemas.push({ name: cat.name, targetSource: source.name, resources });
      }
    }

    // Relationships. For a single-source export keep only those whose BOTH endpoints
    // are present in this export (self-contained); cross-source relationships are dropped.
    const { rows: rels } = await pool.query(
      `SELECT name, cardinality, source_schema, source_table, source_column, target_schema, target_table, target_column
       FROM fabric_catalog.relationships WHERE tenant_id = $1`, [tenantId]);
    const contained = (schema: string, table: string) => !sourceName || exportedTables.has(`${schema}.${table}`);
    const relationships = rels
      .filter((r) => contained(r.source_schema, r.source_table) && contained(r.target_schema, r.target_table))
      .map((r) => ({
        name: r.name,
        cardinality: r.cardinality === 'M:M' ? 'M:N' : r.cardinality,
        ...(r.cardinality === 'M:M' ? { bridge: `${r.source_table}_${r.target_table}_link` } : {}),
        from: { resource: r.source_table, field: r.source_column },
        to: { resource: r.target_table, field: r.target_column },
      }));

    // For a single-source export, flag any resource whose definition references another
    // datasource (e.g. a federated view) — such a source is not self-contained.
    const warnings: string[] = [];
    if (sourceName) {
      const ownSources = new Set(sources.map((s) => s.name));
      for (const sch of schemas) {
        for (const r of sch.resources) {
          const ext = this.collectExternalSources(r, ownSources);
          if (ext.length) warnings.push(
            `Resource "${sch.name}.${r.name}" depends on other datasource(s): ${ext.join(', ')}. ` +
            `Re-applying this single-source manifest requires those sources.`);
        }
      }
    }

    return {
      version: '1.0-export',
      namespace: sourceName ? (schemas[0]?.name || sourceName) : 'Exported_Fabric',
      targetSource: sourceName || 'Fabric_Hub_Postgres',
      exportedAt: new Date().toISOString(),
      schemas,
      ...(relationships.length ? { relationships } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * Walk a resource definition and collect any `source` values that aren't in ownSources.
   * @param obj Resource definition (or nested fragment) to scan recursively.
   * @param ownSources Data source names considered "local" to the current export; any other `source` value found is reported.
   * @param acc Accumulator set used across the recursion; callers normally omit this.
   * @returns The distinct external source names referenced anywhere within `obj`.
   */
  private static collectExternalSources(obj: any, ownSources: Set<string>, acc = new Set<string>()): string[] {
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj)) { obj.forEach((x) => this.collectExternalSources(x, ownSources, acc)); }
      else {
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'source' && typeof v === 'string' && !ownSources.has(v)) acc.add(v);
          else this.collectExternalSources(v, ownSources, acc);
        }
      }
    }
    return [...acc];
  }

  /**
   * Reconstruct column metadata for a crawled resource (no manifest AST), by
   * introspecting either the local Hub's `information_schema.columns` or, for
   * a remote source, a fresh connector obtained from `ConnectorFactory` (which
   * is always closed afterward). Any introspection failure is swallowed and
   * reported as no columns, so a single unreachable/misconfigured source
   * doesn't block the rest of the export.
   * @param source The `public.data_sources` row (`(type, config, name)`) the table belongs to.
   * @param physicalSchema Physical schema name containing the table.
   * @param physicalTable Physical table name to introspect.
   * @returns Manifest-shaped column definitions (`(name, type, nullable?, primaryKey?)`); empty if introspection fails.
   */
  private static async introspectColumns(source: any, physicalSchema: string, physicalTable: string): Promise<any[]> {
    const engine = String(source.type || 'POSTGRES').toUpperCase();
    const cfg = source.config || {};
    const isLocalHub = cfg.local === true || source.name === 'Fabric_Hub_Postgres' || (engine === 'POSTGRES' && !cfg.host && !cfg.connectionString);
    const toManifestCol = (c: any) => ({
      name: c.name, type: c.type, ...(c.nullable === false ? { nullable: false } : {}), ...(c.primaryKey ? { primaryKey: true } : {}),
    });
    try {
      if (isLocalHub) {
        const { rows } = await pool.query(`
          SELECT column_name AS name, data_type AS type, (is_nullable='YES') AS nullable, false AS "primaryKey"
          FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position
        `, [physicalSchema, physicalTable]);
        return rows.map(toManifestCol);
      }
      const connector = ConnectorFactory.getConnector(engine, cfg);
      try {
        const cols = connector.discoverColumns ? await connector.discoverColumns(physicalSchema, physicalTable) : [];
        return cols.map(toManifestCol);
      } finally { await connector.close(); }
    } catch { return []; }
  }

  /**
   * Returns a static, richly-annotated example v4.0 manifest demonstrating
   * every supported resource kind and feature (enums, native/procedural
   * sequences, partitioned tables with identity strategies/generated columns/
   * constraints/triggers/RLS/masking/grants, functions/procedures, recursive
   * and windowed/aggregate views, a federated view spanning sources,
   * a materialized view, and 1:1/1:M/M:N relationships including
   * cross-source ones). Used to seed the manifest editor UI/onboarding flow.
   * @returns The example manifest object (not validated/parsed — for display/editing only).
   */
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
