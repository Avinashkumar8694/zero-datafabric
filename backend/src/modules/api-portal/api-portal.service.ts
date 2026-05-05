import { pool } from '../../config/database';

export class ApiPortalService {
  /**
   * Generates the OpenAPI spec for a specific tenant
   * Leverages PostgREST's native metadata extraction
   */
  static async getTenantOpenApiSpec(tenantId: string) {
    // This logic usually involves a fetch against the PostgREST port (3000)
    // but we can provide the orchestration URL here.
    return {
      specUrl: `http://localhost:3000/`,
      tenantContext: tenantId,
      docsUrl: `https://docs.zero-data-fabric.com/${tenantId}`
    };
  }

  /**
   * Dynamically grants API access to a new table
   * Orchestrates the internal Postgres GRANTs that PostgREST follows
   */
  static async exposeTableToApi(tableName: string, schemaName: string) {
    const client = await pool.connect();
    try {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schemaName}.${tableName} TO fabric_user`);
      return { status: 'EXPOSED', table: tableName };
    } finally {
      client.release();
    }
  }
}
