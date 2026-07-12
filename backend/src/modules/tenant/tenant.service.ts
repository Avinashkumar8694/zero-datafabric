import { pool } from '../../config/database';

/**
 * TenantService — tenant lifecycle management: registry CRUD plus the
 * physical provisioning/deprovisioning of each tenant's dedicated Postgres
 * schema namespace (`tenant_<id>`).
 */
export class TenantService {
  /**
   * Provision a new tenant end-to-end: registers it in `public.tenants`,
   * then creates its physical schema namespace via the
   * `fabric_admin.create_tenant_namespace` DB function and grants `fabric_user`
   * CREATE on that schema. Runs in a single transaction — the registry row and
   * the physical schema are created atomically, or neither is.
   * @param id - The tenant id (also used to derive the `tenant_<id>` schema name).
   * @param name - Human-readable tenant name.
   * @param tier - Service tier; defaults to `'STANDARD'`.
   * @returns The created `public.tenants` row.
   * @throws Re-throws any error after rolling back the transaction and logging it.
   */
  static async createTenant(id: string, name: string, tier: string = 'STANDARD') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Register in the master registry
      const result = await client.query(
        'INSERT INTO public.tenants (id, name, tier) VALUES ($1, $2, $3) RETURNING *',
        [id, name, tier]
      );

      // 2. Call the DB orchestrator to create the physical schema
      await client.query('SELECT fabric_admin.create_tenant_namespace($1)', [id]);
      
      // 3. Grant CREATE permission (missing in the DB function)
      await client.query(`GRANT CREATE ON SCHEMA "tenant_${id}" TO fabric_user`);

      await client.query('COMMIT');
      return result.rows[0];
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`[Tenant] Provisioning failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update a tenant's registry metadata (name and lifecycle status). Does not
   * touch the physical schema — e.g. `SUSPENDED` is a registry-level flag
   * that callers are expected to enforce elsewhere.
   * @param id - The tenant id.
   * @param name - New display name.
   * @param status - New lifecycle status.
   * @returns The updated `public.tenants` row.
   */
  static async updateTenant(id: string, name: string, status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
    const { rows } = await pool.query(
      'UPDATE public.tenants SET name = $1, status = $2 WHERE id = $3 RETURNING *',
      [name, status, id]
    );
    return rows[0];
  }

  /**
   * List every registered tenant, newest first.
   * @returns All rows from `public.tenants`.
   */
  static async listAll() {
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    return rows;
  }

  /**
   * Fully decommission a tenant: drops its physical schema (`tenant_<id>`,
   * `CASCADE` — all tenant data is destroyed) and removes its registry row.
   * Runs in a single transaction so the schema and registry entry are removed
   * atomically.
   * @param id - The tenant id to delete.
   * @returns `(id, status: 'DELETED')`.
   * @throws Re-throws any error after rolling back the transaction.
   */
  static async deleteTenant(id: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 1. Drop the tenant schema (virtualized data)
      await client.query(`DROP SCHEMA IF EXISTS tenant_${id} CASCADE`);
      // 2. Remove from registry
      await client.query('DELETE FROM public.tenants WHERE id = $1', [id]);
      await client.query('COMMIT');
      return { id, status: 'DELETED' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
