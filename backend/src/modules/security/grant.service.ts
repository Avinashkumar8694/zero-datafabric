import { pool } from '../../config/database';

/**
 * GrantService — engine-agnostic table privilege enforcement.
 *
 * Postgres enforces GRANT/REVOKE natively. Non-SQL engines (Mongo/ES) have no
 * table-level privilege model, so the fabric compensates: when a table has
 * declared grants, a session role must hold the required privilege or the
 * request is denied — the same allow/deny decision Postgres would make, applied
 * uniformly across engines.
 *
 * Policy: enforce ONLY when grants are declared for a table (default-allow for
 * un-governed tables, so existing queries are unaffected). ADMIN always passes.
 * Grants are stored engine-agnostically in fabric_system.access_grants and
 * synced from a manifest's `security.grants`.
 */

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface GrantRule { role: string; privileges: Privilege[] }

export class GrantService {
  private static ready = false;

  /**
   * Create the engine-agnostic grant catalog table if it does not already
   * exist, memoizing success so later calls are a cheap no-op.
   * @returns Resolves once the table is confirmed to exist.
   */
  static async ensureTable(): Promise<void> {
    if (this.ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.access_grants (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   text NOT NULL,
        schema_name text NOT NULL,
        table_name  text NOT NULL,
        grants      jsonb NOT NULL DEFAULT '[]'::jsonb,
        source      text NOT NULL DEFAULT 'API',
        updated_at  timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, schema_name, table_name)
      )`);
    this.ready = true;
  }

  /**
   * Create or replace the grant set declared for a (schema, table).
   * Upserts on the (tenant, schema, table) unique key, so re-applying a
   * manifest's `security.grants` for the same table simply overwrites the
   * previous rule set rather than accumulating duplicates.
   * @param tenantId - Owning tenant.
   * @param schema - Physical (or connector-native) schema name.
   * @param table - Table name within the schema.
   * @param grants - The full replacement set of role/privilege rules.
   * @param source - Origin of the write, e.g. 'API' or 'MANIFEST'.
   * @returns The persisted grant row (id, schema, table, grants, source).
   */
  static async upsert(tenantId: string, schema: string, table: string, grants: GrantRule[], source = 'API'): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.access_grants (tenant_id, schema_name, table_name, grants, source, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,NOW())
       ON CONFLICT (tenant_id, schema_name, table_name)
       DO UPDATE SET grants = EXCLUDED.grants, source = EXCLUDED.source, updated_at = NOW()
       RETURNING id, schema_name AS schema, table_name AS "table", grants, source`,
      [tenantId, schema, table, JSON.stringify(grants || []), source]
    );
    return rows[0];
  }

  /**
   * List every declared grant rule set for a tenant, newest first.
   * @param tenantId - Tenant whose grants are being listed.
   * @returns All grant rows for the tenant (may be empty).
   */
  static async list(tenantId: string): Promise<any[]> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, schema_name AS schema, table_name AS "table", grants, source, updated_at AS "updatedAt"
       FROM fabric_system.access_grants WHERE tenant_id=$1 ORDER BY updated_at DESC`, [tenantId]);
    return rows;
  }

  /**
   * Pure allow/deny decision (no I/O) — governed only when grants are declared;
   * ADMIN/SYSTEM bypass; otherwise the role must hold the privilege.
   * @param grants - The grant rules declared for the table (empty/undefined = ungoverned).
   * @param role - The session role requesting access (case-insensitive; may be undefined).
   * @param privilege - The privilege being requested.
   * @returns `{ allowed, governed }` — `governed=false` means no grants are
   *   declared for the table (default-allow); `allowed` reflects whether the
   *   role holds the requested privilege when governed.
   */
  static decide(grants: GrantRule[], role: string | undefined, privilege: Privilege): { allowed: boolean; governed: boolean } {
    if (!grants || !grants.length) return { allowed: true, governed: false };
    const r = String(role || '').toUpperCase();
    if (r === 'ADMIN' || r === 'SYSTEM') return { allowed: true, governed: true };
    const allowed = grants.some((g) =>
      String(g.role || '').toUpperCase() === r &&
      (g.privileges || []).map((p) => String(p).toUpperCase()).includes(privilege));
    return { allowed, governed: true };
  }

  /**
   * Look up the declared grants for a physical (schema, table) and resolve
   * the allow/deny decision for `role` via {@link GrantService.decide}.
   * @param tenantId - Owning tenant.
   * @param physicalSchema - Physical (or connector-native) schema name.
   * @param table - Table name within the schema.
   * @param role - The session role requesting access.
   * @param privilege - The privilege being requested.
   * @returns `{ allowed, governed }` for this table/role/privilege.
   */
  static async check(tenantId: string, physicalSchema: string, table: string, role: string | undefined, privilege: Privilege): Promise<{ allowed: boolean; governed: boolean }> {
    await this.ensureTable();
    const result = await pool.query(
      `SELECT grants FROM fabric_system.access_grants WHERE tenant_id=$1 AND schema_name=$2 AND table_name=$3`,
      [tenantId, physicalSchema, table]);
    const grants: GrantRule[] = result?.rows?.[0]?.grants || [];
    return this.decide(grants, role, privilege);
  }

  /**
   * Throw a consistent access error if the role lacks the privilege.
   * @param tenantId - Owning tenant.
   * @param physicalSchema - Physical (or connector-native) schema name.
   * @param table - Table name within the schema.
   * @param role - The session role requesting access.
   * @param privilege - The privilege being requested.
   * @returns Resolves silently when access is allowed or the table is ungoverned.
   * @throws {Error} with `err.accessDenied = true` when the table is governed
   *   and the role lacks the requested privilege.
   */
  static async enforce(tenantId: string, physicalSchema: string, table: string, role: string | undefined, privilege: Privilege): Promise<void> {
    const { allowed, governed } = await this.check(tenantId, physicalSchema, table, role, privilege);
    if (governed && !allowed) {
      const err: any = new Error(`ACCESS DENIED: role "${role || '(none)'}" lacks ${privilege} on ${physicalSchema}.${table}`);
      err.accessDenied = true;
      throw err;
    }
  }
}
