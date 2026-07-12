import { pool } from '../../config/database';

/**
 * ApiPortalService — helpers backing the tenant-facing API/developer portal:
 * surfacing a tenant's auto-generated OpenAPI spec (derived from PostgREST's
 * native schema introspection) and dynamically exposing tables through
 * PostgREST via Postgres GRANTs.
 */
export class ApiPortalService {
  /**
   * Resolve the pointers a tenant's developer portal needs to reach its
   * auto-generated OpenAPI spec and docs. Does not fetch the spec itself —
   * PostgREST serves it live from its own schema introspection; this just
   * returns the URLs, scoped to the tenant.
   * @param tenantId - The tenant to build portal URLs for.
   * @returns `(specUrl, tenantContext, docsUrl)`.
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
   * Grant `fabric_user` full CRUD (SELECT/INSERT/UPDATE/DELETE) on a table so
   * PostgREST — which follows the underlying Postgres GRANTs — starts serving
   * it through the REST API.
   * @param tableName - Table to expose.
   * @param schemaName - Schema containing the table.
   * @returns `(status: 'EXPOSED', table)`.
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
