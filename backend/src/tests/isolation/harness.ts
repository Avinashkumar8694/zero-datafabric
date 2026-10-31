/**
 * Shared harness for the DB-backed isolation suites (run ONLY against the throwaway DB, see MULTITENANCY_PLAN.md).
 * Tenants are created through TenantService (real namespace provisioning); users and their tokens are USER-role:
 * the owner is `tenants.user_id`, members are plain users of the same tenant. Nothing here uses an ADMIN token
 * except `adminToken()` which is only used to exercise platform-admin-only behaviour.
 */
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';
import { TenantService } from '../../modules/tenant/tenant.service';
import { CleanupService } from '../../services/cleanup.service';

export { app, pool, request };

// supertest spins up an ephemeral server per request; an occasional socket-level hiccup ("Parse Error") is transport noise, not a result.
jest.retryTimes(1);

if (!/(:|%3A)55450\b/.test(process.env.DATABASE_URL || '') && process.env.ISOLATION_ALLOW_ANY_DB !== 'true') {
  throw new Error('Isolation suites only run against the throwaway DB on :55450 (set DATABASE_URL accordingly).');
}

export const suffix = () => `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

export interface TestTenant {
  id: string;
  owner: { id: string; username: string; token: string };
  member: { id: string; username: string; token: string };
  schema: string;
}

const created: { tenants: string[]; users: string[] } = { tenants: [], users: [] };

async function mkUser(username: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, 'x', NULL, 'USER') RETURNING id`, [username]);
  created.users.push(rows[0].id);
  return rows[0].id;
}

/** Creates tenant `id` with an owner and a member (both role USER) and returns their tokens. */
export async function mkTenant(id: string): Promise<TestTenant> {
  const ownerName = `own_${id}`.slice(0, 60);
  const memberName = `mem_${id}`.slice(0, 60);
  const ownerId = await mkUser(ownerName);
  const memberId = await mkUser(memberName);
  await TenantService.createTenant(id, `Isolation ${id}`, 'STANDARD', ownerId);
  created.tenants.push(id);
  await pool.query('UPDATE public.users SET tenant_id = $1 WHERE id = ANY($2::uuid[])', [id, [ownerId, memberId]]);
  return {
    id,
    schema: `tenant_${id}`,
    owner: { id: ownerId, username: ownerName, token: AuthService.generateToken(id, 'USER', ownerName, ownerId) },
    member: { id: memberId, username: memberName, token: AuthService.generateToken(id, 'USER', memberName, memberId) },
  };
}

/** A platform-admin session (used only for platform-admin behaviour such as creating tenants over HTTP). */
export const adminToken = () => AuthService.generateToken('tenant_A', 'ADMIN', 'iso_admin', '00000000-0000-0000-0000-0000000000aa');

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Removes everything the suite created (best effort, never throws). */
export async function cleanupAll(extraTenantIds: string[] = []) {
  const ids = [...new Set([...created.tenants, ...extraTenantIds])];
  for (const t of ids) {
    try { await CleanupService.purgeTenant(t); } catch { /* ignore */ }
    for (const sql of [
      'DELETE FROM public.notification_channels WHERE tenant_id = $1',
      'DELETE FROM public.trigger_registry WHERE tenant_id = $1',
      'DELETE FROM public.api_tokens WHERE tenant_id = $1',
      'DELETE FROM fabric_system.access_policies WHERE tenant_id = $1',
      'DELETE FROM fabric_system.access_grants WHERE tenant_id = $1',
      'DELETE FROM fabric_system.fabric_constraints WHERE tenant_id = $1',
      'DELETE FROM fabric_system.metadata_history WHERE tenant_id = $1',
      'DELETE FROM fabric_system.downstream_registry WHERE tenant_id = $1',
      'DELETE FROM fabric_catalog.metadata WHERE schema_name = $2 OR schema_name LIKE $3',
      'DELETE FROM public.catalog_schemas WHERE source_id IS NULL AND (physical_name = $2 OR physical_name LIKE $3)',
    ]) {
      try {
        if (sql.includes('$2')) await pool.query(sql, [t, `tenant_${t}`, `tenant_${t}\\_%`]);
        else await pool.query(sql, [t]);
      } catch { /* table may not exist on this DB */ }
    }
    try { await pool.query('DROP SCHEMA IF EXISTS "tenant_' + t.replace(/"/g, '') + '" CASCADE'); } catch { /* ignore */ }
    try { await pool.query('DELETE FROM public.users WHERE tenant_id = $1', [t]); } catch { /* ignore */ }
    try { await pool.query('DELETE FROM public.tenants WHERE id = $1', [t]); } catch { /* ignore */ }
  }
  if (created.users.length) { try { await pool.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [created.users]); } catch { /* ignore */ } }
  created.tenants.length = 0; created.users.length = 0;
}

/** Creates a table with rows in the tenant's primary schema (as the owner pool) and returns its name. */
export async function mkTable(t: TestTenant, table: string, rows: Record<string, any>[]) {
  await pool.query(`CREATE TABLE "${t.schema}"."${table}" (id serial primary key, v text)`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t.schema}"."${table}" TO fabric_user`);
  await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${t.schema}" TO fabric_user`);
  for (const r of rows) await pool.query(`INSERT INTO "${t.schema}"."${table}" (v) VALUES ($1)`, [r.v]);
}

/** Registers a hub-local catalog entry for `schema.table` (source-less schema, as MetadataService.crawlTenant does). */
export async function mkCatalogTable(schemaPhysical: string, table: string): Promise<{ schemaId: string; tableId: string }> {
  const s = await pool.query(`INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES (NULL, $1, $1) RETURNING id`, [schemaPhysical]);
  const t = await pool.query(`INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type) VALUES ($1, $2, $2, 'TABLE') RETURNING id`, [s.rows[0].id, table]);
  return { schemaId: s.rows[0].id, tableId: t.rows[0].id };
}

/** Inserts a data source (with secrets in its config) plus a catalog schema/table for it. */
export async function mkSource(t: TestTenant, name: string, config: any, syncType = 'VIRTUAL') {
  const { rows } = await pool.query(
    `INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1, $2, 'postgres', $3::jsonb, $4, 'CONNECTED') RETURNING id`,
    [t.id, name, JSON.stringify(config), syncType]);
  const sourceId = rows[0].id as string;
  const s = await pool.query(`INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1, 'remote', 'remote') RETURNING id`, [sourceId]);
  const tb = await pool.query(`INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type) VALUES ($1, 'things', 'things', 'TABLE') RETURNING id`, [s.rows[0].id]);
  return { sourceId, schemaId: s.rows[0].id as string, tableId: tb.rows[0].id as string };
}
