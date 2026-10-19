/**
 * Shared helpers for the DB-backed hardening suites. These run ONLY against the throwaway database:
 *   DATABASE_URL=postgresql://fabric_admin:fabric_password@127.0.0.1:55450/datafabric DB_HOST=127.0.0.1 DB_PORT=55450 NODE_ENV=test npx jest src/tests/hardening --runInBand
 * Refuses to run against anything else (the default env points at the developer's live hub).
 */
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';
import { assertTenantId, belongsToTenant } from '../../utils/identifiers';

export function assertThrowawayDb() {
  const url = process.env.DATABASE_URL || '';
  if (!/:(55450)\//.test(url) || process.env.DB_PORT !== '55450') {
    throw new Error(`Refusing to run hardening tests against ${url.replace(/:[^:@/]*@/, ':***@') || '(default env)'}: use the throwaway DB on :55450`);
  }
}

export interface Workspace { tenantId: string; userId: string; username: string; ownerToken: string; memberToken: string; memberId: string }

let counter = 0;
export const uniq = (tag: string) => `hd_${tag}_${Date.now().toString(36)}${(counter++).toString(36)}`.slice(0, 40);

/** Owner (tenants.user_id = user) + a plain member, created with direct inserts. */
export async function createWorkspace(tag: string): Promise<Workspace> {
  assertThrowawayDb();
  const tenantId = assertTenantId(uniq(tag));
  const username = `${tenantId}_owner`;
  const memberName = `${tenantId}_member`;
  await pool.query(`INSERT INTO public.tenants (id, name) VALUES ($1, $2)`, [tenantId, `Hardening ${tag}`]);
  await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [tenantId]);
  const owner = await pool.query(`INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, 'x', $2, 'USER') RETURNING id`, [username, tenantId]);
  const member = await pool.query(`INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, 'x', $2, 'USER') RETURNING id`, [memberName, tenantId]);
  await pool.query(`UPDATE public.tenants SET user_id = $1 WHERE id = $2`, [owner.rows[0].id, tenantId]);
  return {
    tenantId, username, userId: owner.rows[0].id, memberId: member.rows[0].id,
    ownerToken: AuthService.generateToken(tenantId, 'USER', username, owner.rows[0].id),
    memberToken: AuthService.generateToken(tenantId, 'USER', memberName, member.rows[0].id),
  };
}

const safe = async (sql: string, params: any[] = []) => { try { await pool.query(sql, params); } catch { /* best-effort cleanup */ } };

export async function cleanupWorkspace(tenantId: string) {
  await safe('DELETE FROM public.trigger_jobs WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM public.trigger_execution_logs WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM public.trigger_registry WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM fabric_system.metadata_history WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM fabric_system.fabric_enums WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM fabric_system.virtual_views WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM fabric_catalog.relationships WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM fabric_system.downstream_registry WHERE tenant_id = $1', [tenantId]);
  await safe('SELECT fabric_admin.remove_remote_source($1, name) FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM public.catalog_schemas WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]);
  await safe('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM public.users WHERE tenant_id = $1', [tenantId]);
  await safe('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
  const { rows } = await pool.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'`);
  for (const r of rows) if (belongsToTenant(r.nspname, tenantId)) await safe(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`);
}

export async function relationExists(schema: string, table: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS r`, [`"${schema}"."${table}"`]);
  return !!rows[0].r;
}

export async function schemaExists(schema: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  return rows.length > 0;
}

export async function listTenantSchemas(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%' ORDER BY 1`);
  return rows.map((r) => r.nspname).filter((n: string) => belongsToTenant(n, tenantId));
}
