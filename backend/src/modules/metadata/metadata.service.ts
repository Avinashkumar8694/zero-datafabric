import { pool } from '../../config/database';

export class MetadataService {
  /**
   * Advanced Discovery Crawler
   * Orchestrates the extraction of metadata from virtualized schemas
   */
  static async crawlTenant(tenantId: string) {
    const schemaName = `tenant_${tenantId}`;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Fetch raw metadata from Postgres Catalog (Native + Virtual FDW)
      const { rows: columns } = await client.query(`
        SELECT 
          table_name, column_name, data_type, is_nullable,
          column_default as default_value
        FROM information_schema.columns
        WHERE table_schema = $1
      `, [schemaName]);

      // 2. UPSERT into the Data Fabric Catalog
      for (const col of columns) {
        await client.query(`
          INSERT INTO fabric_catalog.metadata 
            (schema_name, table_name, column_name, data_type, is_nullable)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (schema_name, table_name, column_name) 
          DO UPDATE SET 
            data_type = EXCLUDED.data_type,
            last_crawled_at = CURRENT_TIMESTAMP
        `, [schemaName, col.table_name, col.column_name, col.data_type, col.is_nullable === 'YES']);
      }

      await client.query('COMMIT');
      return { tenantId, columnCount: columns.length };
    } catch (err: any) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generates a sample metadata template for industrial schema orchestration
   */
  static getTemplate(): any {
    return {
      version: "7.0",
      description: "Universal Data Fabric Orchestration Blueprint (The Definitive Spec)",
      schemas: [
        {
          name: "enterprise_core",
          description: "Global Transactional & Identity Core",
          sequences: [
            { name: "global_tx_seq", start: 1000000, increment: 1 }
          ],
          tables: [
            {
              name: "users",
              columns: [
                { name: "id", type: "UUID", primaryKey: true },
                { name: "email", type: "VARCHAR(255)", constraints: "UNIQUE NOT NULL", masking: "PARTIAL" },
                { name: "preferences", type: "JSONB", defaultValue: "'{}'" },
                { name: "status", type: "VARCHAR(20)", defaultValue: "'ACTIVE'" }
              ],
              indexes: [
                { name: "idx_user_pref_gin", type: "GIN", columns: ["preferences"] }
              ]
            },
            {
              name: "orders",
              partitioned: { type: "RANGE", column: "created_at" },
              columns: [
                { name: "id", type: "UUID", constraints: "NOT NULL" },
                { name: "user_id", type: "UUID", constraints: "NOT NULL" },
                { name: "amount", type: "NUMERIC(15,2)", constraints: "CHECK (amount > 0)" },
                { name: "created_at", type: "TIMESTAMP", constraints: "NOT NULL" }
              ],
              compositePrimaryKey: ["id", "created_at"],
              indexes: [
                { name: "idx_orders_user_date", type: "BTREE", columns: ["user_id", "created_at"] }
              ],
              triggers: [
                { name: "trg_order_audit", event: "AFTER INSERT", function: "fn_audit_log" }
              ],
              governance: { ttl: "7 years", quality: "amount > 0" }
            }
          ],
          views: [
            {
              name: "v_high_value_users",
              materialized: true,
              config: { // Directly mapped to QueryEngine AST
                type: "SELECT",
                table: "orders",
                select: ["user_id", "SUM(amount) as total_spend"],
                groupBy: ["user_id"],
                filter: { "amount": { "$gt": 1000 } }
              }
            }
          ]
        },
        {
          name: "external_virtual",
          description: "Heterogeneous Virtualized Layer",
          foreignTables: [
            {
              name: "snowflake_revenue",
              server: "snowflake_dw",
              columns: [
                { name: "period", type: "VARCHAR(10)" },
                { name: "revenue", type: "NUMERIC" }
              ],
              options: { "table": "monthly_revenue_report" }
            }
          ]
        }
      ],
      relationships: [
        {
          name: "rel_user_profile_1to1",
          type: "ONE_TO_ONE",
          source: { schema: "enterprise_core", table: "users", column: "id" },
          target: { schema: "enterprise_core", table: "profiles", column: "user_id" },
          cardinality: "1:1"
        },
        {
          name: "rel_user_orders_1toM",
          type: "ONE_TO_MANY",
          source: { schema: "enterprise_core", table: "users", column: "id" },
          target: { schema: "enterprise_core", table: "orders", column: "user_id" },
          cardinality: "1:M"
        },
        {
          name: "rel_user_groups_MM",
          type: "MANY_TO_MANY",
          junctionTable: "user_group_map",
          left: { table: "users", column: "id" },
          right: { table: "groups", column: "id" },
          cardinality: "M:M"
        }
      ],
      functions: [
        {
          name: "fn_audit_log",
          returnType: "TRIGGER",
          language: "plpgsql",
          body: "BEGIN INSERT INTO fabric_audit(tbl, op) VALUES (TG_TABLE_NAME, TG_OP); RETURN NEW; END;"
        }
      ]
    };
  }

  /**
   * Exports the current tenant schema and relational state as a JSON manifest
   */
  static async exportTenantMetadata(tenantId: string) {
    const schemaName = `tenant_${tenantId}`;
    
    // 1. Fetch Columns
    const { rows: columns } = await pool.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
    `, [schemaName]);

    // 2. Fetch Relationships
    const { rows: relations } = await pool.query(`
      SELECT source_table, source_column, target_table, target_column, cardinality
      FROM fabric_catalog.relationships
      WHERE schema_name = $1
    `, [schemaName]);

    return {
      tenantId,
      timestamp: new Date().toISOString(),
      schema: {
        name: schemaName,
        tables: Array.from(new Set(columns.map(c => c.table_name))).map(t => ({
          name: t,
          columns: columns.filter(c => c.table_name === t).map(c => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === 'YES'
          })),
          relationships: relations.filter(r => r.source_table === t).map(r => ({
            column: r.source_column,
            targetTable: r.target_table,
            targetColumn: r.target_column,
            cardinality: r.cardinality
          }))
        }))
      }
    };
  }

  /**
   * Compares a proposed metadata manifest against the live schema to generate a migration diff
   */
  static async diffMetadata(tenantId: string, proposed: any) {
    const live = await this.exportTenantMetadata(tenantId);
    const diffs: any[] = [];

    const proposedTables = proposed.schema.tables;
    const liveTables = live.schema.tables;

    // 1. Check for Added or Modified Tables
    for (const pTable of proposedTables) {
      const lTable = liveTables.find((t: any) => t.name === pTable.name);
      
      if (!lTable) {
        diffs.push({ action: 'CREATE_TABLE', table: pTable.name, details: pTable });
      } else {
        // Compare columns
        for (const pCol of pTable.columns) {
          const lCol = lTable.columns.find((c: any) => c.name === pCol.name);
          if (!lCol) {
            diffs.push({ action: 'ADD_COLUMN', table: pTable.name, column: pCol.name, type: pCol.type });
          } else if (lCol.type !== pCol.type) {
            diffs.push({ action: 'ALTER_COLUMN_TYPE', table: pTable.name, column: pCol.name, oldType: lCol.type, newType: pCol.type });
          }
        }
      }
    }

    // 2. Check for Soft Deletes (Tables/Columns in Live but not in Proposed)
    for (const lTable of liveTables) {
      const pTable = proposedTables.find((t: any) => t.name === lTable.name);
      if (!pTable) {
        diffs.push({ action: 'SOFT_DELETE_TABLE', table: lTable.name });
      }
    }

    // 3. Check for Sequences
    if (proposed.schema.sequences) {
      for (const pSeq of proposed.schema.sequences) {
        diffs.push({ action: 'CREATE_SEQUENCE', ...pSeq });
      }
    }

    // 4. Check for Views
    if (proposed.schema.views) {
      for (const pView of proposed.schema.views) {
        diffs.push({ action: 'CREATE_VIEW', ...pView });
      }
    }

    // 5. Check for Table-specific Indexes
    for (const pTable of proposedTables) {
      if (pTable.indexes) {
        for (const pIdx of pTable.indexes) {
          diffs.push({ action: 'CREATE_INDEX', table: pTable.name, ...pIdx });
        }
      }
    }

    // 6. Check for Relationships
    if (proposed.schema.relationships) {
      for (const pRel of proposed.schema.relationships) {
        diffs.push({ action: 'ESTABLISH_RELATIONSHIP', ...pRel });
      }
    }

    return { tenantId, diffs };
  }

  /**
   * Orchestrates the execution of a migration plan (diff) against the live system
   */
  static async migrateMetadata(tenantId: string, migrationPlan: any[]) {
    const { QueryEngineService } = require('../query-engine/query-engine.service');
    const results: any[] = [];

    for (const step of migrationPlan) {
      try {
        let query;
        switch (step.action) {
          case 'CREATE_SCHEMA':
            query = { type: 'CREATE_SCHEMA' };
            break;

          case 'CREATE_FOREIGN_TABLE':
            query = { 
              type: 'CREATE_FOREIGN_TABLE', 
              table: step.table,
              schemaDef: { columns: step.details.columns },
              foreignDef: { serverName: step.details.server, options: step.details.options }
            };
            break;

          case 'CREATE_FUNCTION':
            await pool.query(`
              CREATE OR REPLACE FUNCTION "tenant_${tenantId}"."${step.name}"()
              RETURNS TRIGGER AS $$
              ${step.body}
              $$ LANGUAGE plpgsql;
            `);
            await pool.query(`ALTER FUNCTION "tenant_${tenantId}"."${step.name}"() OWNER TO fabric_user`);
            results.push({ action: step.action, status: 'SUCCESS' });
            continue;

          case 'CREATE_TABLE':
            const colDefs = step.details.columns.map((c: any) => {
              let def = `"${c.name}" ${c.type}`;
              if (c.primaryKey) def += ' PRIMARY KEY';
              if (c.constraints) def += ` ${c.constraints}`;
              if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`;
              return def;
            });
            
            // Handle Composite Primary Key
            if (step.details.compositePrimaryKey) {
               colDefs.push(`PRIMARY KEY (${step.details.compositePrimaryKey.map((k: any) => `"${k}"`).join(', ')})`);
            }

            let createTableSql = `CREATE TABLE IF NOT EXISTS "tenant_${tenantId}"."${step.table}" (${colDefs.join(', ')})`;
            
            // Handle Partitioning
            if (step.details.partitioned) {
               createTableSql += ` PARTITION BY ${step.details.partitioned.type} ("${step.details.partitioned.column}")`;
            }
            
            await pool.query(createTableSql);
            await pool.query(`ALTER TABLE "tenant_${tenantId}"."${step.table}" OWNER TO fabric_user`);
            await pool.query(`GRANT ALL ON TABLE "tenant_${tenantId}"."${step.table}" TO fabric_user`);
            
            // Populate Catalog for Governance (Masking, etc.)
            for (const col of step.details.columns) {
              await pool.query(`
                INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type, description)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (schema_name, table_name, column_name) DO UPDATE SET description = EXCLUDED.description
              `, [`tenant_${tenantId}`, step.table, col.name, col.type, col.description || '']);
            }
            results.push({ action: step.action, table: step.table, status: 'SUCCESS' });
            
            // Handle Triggers
            if (step.details.triggers) {
               for (const trg of step.details.triggers) {
                  const trgSql = `CREATE TRIGGER "${trg.name}" ${trg.event} ON "tenant_${tenantId}"."${step.table}" FOR EACH ROW EXECUTE FUNCTION ${trg.function}()`;
                  await pool.query(trgSql);
               }
            }

            // Handle Policies (RLS)
            if (step.details.policies) {
               await pool.query(`ALTER TABLE "tenant_${tenantId}"."${step.table}" ENABLE ROW LEVEL SECURITY`);
               for (const pol of step.details.policies) {
                  const polSql = `CREATE POLICY "${pol.name}" ON "tenant_${tenantId}"."${step.table}" FOR ${pol.action} USING (${pol.check})`;
                  await pool.query(polSql);
               }
            }
            continue;

          case 'CREATE_VIEW':
            // Structured View: Use AST to generate query
            const viewConfig = step.details?.config || step.config;
            const { sql: viewSql } = await QueryEngineService.generateSql(tenantId, viewConfig);
            query = { 
              type: 'CREATE_VIEW', 
              viewDef: { name: step.table || step.name, query: viewSql, materialized: step.details?.materialized } 
            };
            break;

          case 'ESTABLISH_RELATIONSHIP':
            // 1. Insert into Catalog for Dynamic Join resolution
            await pool.query(`
              INSERT INTO fabric_catalog.relationships 
                (schema_name, source_table, source_column, target_table, target_column, cardinality, description)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (schema_name, source_table, source_column, target_table, target_column)
              DO UPDATE SET cardinality = EXCLUDED.cardinality
            `, [`tenant_${tenantId}`, step.sourceTable, step.sourceColumn, step.targetTable, step.targetColumn, step.cardinality, step.name || 'Link']);

            // 2. Optional: Add physical FK if enforced
            if (step.enforceForeignKey) {
               const fkSql = `ALTER TABLE "tenant_${tenantId}"."${step.sourceTable}" 
                              ADD CONSTRAINT "fk_${step.sourceTable}_${step.targetTable}" 
                              FOREIGN KEY ("${step.sourceColumn}") 
                              REFERENCES "tenant_${tenantId}"."${step.targetTable}" ("${step.targetColumn}")`;
               await pool.query(fkSql);
            }
            results.push({ action: step.action, status: 'SUCCESS_RELATIONAL_LINK' });
            continue;

          case 'CREATE_SEQUENCE':
            query = { 
              type: 'CREATE_SEQUENCE', 
              sequenceDef: { name: step.name, start: step.start, increment: step.increment } 
            };
            break;

          case 'CREATE_INDEX':
            query = { 
              type: 'CREATE_INDEX', 
              table: step.table, 
              indexDef: { name: step.name, columns: step.columns, unique: step.unique } 
            };
            break;
            
          case 'SOFT_DELETE_TABLE':
            await pool.query(`
              UPDATE fabric_catalog.metadata 
              SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP 
              WHERE schema_name = $1 AND table_name = $2
            `, [`tenant_${tenantId}`, step.table]);
            results.push({ action: step.action, status: 'SUCCESS_METADATA_ONLY' });
            continue;
        }

        if (query) {
          const res = await QueryEngineService.executeQuery(tenantId, query);
          results.push({ action: step.action, status: 'SUCCESS', response: res });
        }
      } catch (err: any) {
        results.push({ action: step.action, status: 'FAILED', error: err.message });
      }
    }

    return { tenantId, results };
  }

  /**
   * Full-Text Search across the Fabric Catalog
   */
  static async searchCatalog(tenantId: string, query: string) {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type, description
      FROM fabric_catalog.metadata
      WHERE schema_name = $1
      AND (
        table_name ILIKE $2 OR 
        column_name ILIKE $2 OR 
        description ILIKE $2
      )
    `, [`tenant_${tenantId}`, `%${query}%`]);
    
    return rows;
  }
}
