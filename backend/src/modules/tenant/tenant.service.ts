import { pool } from '../../config/database';

export class TenantService {
  /**
   * Industrial Grade Tenant Provisioning
   * Automates the creation of Postgres namespaces and application roles
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

  static async updateTenant(id: string, name: string, status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
    const { rows } = await pool.query(
      'UPDATE public.tenants SET name = $1, status = $2 WHERE id = $3 RETURNING *',
      [name, status, id]
    );
    return rows[0];
  }

  static async listAll() {
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    return rows;
  }

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
