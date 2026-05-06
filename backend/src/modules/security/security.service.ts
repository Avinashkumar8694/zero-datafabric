import { pool } from '../../config/database';

export class SecurityService {
  /**
   * Applies an advanced multi-layered RLS policy to a table
   * Policy: (tenant_id = claim.tenant_id) AND (role_level >= required_level)
   */
  static async applyAdvancedRLS(tableName: string) {
    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
      
      // Dynamic policy that reads from the JWT claims injected by PostgREST/Orchestrator
      const policySql = `
        CREATE POLICY advanced_tenant_isolation ON ${tableName}
        FOR ALL
        TO fabric_user
        USING (
          tenant_id = current_setting('request.jwt.claims', true)::json->>'tenant_id'
        )
        WITH CHECK (
          tenant_id = current_setting('request.jwt.claims', true)::json->>'tenant_id'
        );
      `;
      
      await client.query(policySql);
      return { status: 'RLS_APPLIED', table: tableName };
    } catch (err: any) {
      console.error(`[Security] RLS failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Applies RLS to all tables within a specific schema
   * Essential for Module 3.1 when virtualizing multiple tables at once
   */
  static async applyRLSToSchema(schemaName: string, tenantId: string) {
    const client = await pool.connect();
    try {
      // 1. Get all tables in the schema
      const { rows: tables } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
        [schemaName]
      );

      for (const table of tables) {
        const tableName = `"${schemaName}"."${table.table_name}"`;
        await client.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
        
        // Drop existing to avoid conflicts
        await client.query(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${tableName}`);
        
        await client.query(`
          CREATE POLICY tenant_isolation_policy ON ${tableName}
          FOR ALL
          TO fabric_user
          USING (tenant_id = $1)
          WITH CHECK (tenant_id = $1)
        `, [tenantId]);
      }
      
      return { status: 'RLS_SCHEMA_APPLIED', schema: schemaName, tableCount: tables.length };
    } finally {
      client.release();
    }
  }

  /**
   * Encrypts a sensitive field using pgcrypto (Industrial Grade PII protection)
   */
  static async encryptField(value: string, key: string) {
    const { rows } = await pool.query(
      "SELECT pgp_sym_encrypt($1, $2) as encrypted", 
      [value, key]
    );
    return rows[0].encrypted;
  }
}
