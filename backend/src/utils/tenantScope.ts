/**
 * Tenant scoping helpers shared by controllers and services (Agent A, multi-tenancy hardening).
 *
 * - Typed HTTP-ish errors (`status` + `code`) so controllers can map a foreign id to 404
 *   (never 403: a 403 would confirm that the object exists in another workspace).
 * - SQL predicates that scope catalog rows (`catalog_schemas` / `catalog_tables`, which carry no
 *   tenant column) to a tenant through `data_sources.tenant_id` or, for hub-local schemas that have
 *   no source row, through the *exact* physical schema name (`tenant_<id>` / `tenant_<id>_<logical>`).
 * - The tenant-id creation rules: syntax (assertTenantId) + the no-prefix-overlap rule that keeps
 *   `tenant_<id>_<logical>` schema names unambiguous.
 */
import { assertTenantId, escapeLike } from './identifiers';

export class NotFoundError extends Error {
  status = 404;
  code = 'NOT_FOUND';
  constructor(message = 'Resource not found') { super(message); }
}

export class AccessDeniedError extends Error {
  status = 403;
  code = 'ACCESS_DENIED';
  constructor(message = 'ACCESS DENIED') { super(message.startsWith('ACCESS DENIED') ? message : `ACCESS DENIED: ${message}`); }
}

export class TenantIdOverlapError extends Error {
  status = 409;
  code = 'TENANT_ID_OVERLAP';
  constructor(public readonly conflictsWith: string) {
    super(`Tenant id overlaps with existing tenant "${conflictsWith}": one id may not equal another id followed by "_" and more characters`);
  }
}

/**
 * Runtime tenant-id check used when an id is turned into a schema name. Stricter than "strip whatever is odd" (which
 * let `a-b` and `ab` alias the same schema): anything outside [A-Za-z0-9_] (or longer than a schema name allows) is
 * rejected. Creation applies the tighter `assertTenantId` + overlap rule on top of this.
 */
export function assertTenantIdSafe(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_]{1,56}$/.test(id)) {
    const e: any = new Error('Invalid tenant id');
    e.status = 400; e.code = 'INVALID_IDENTIFIER';
    throw e;
  }
  return id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Maps a thrown error to an HTTP status if it carries one (NotFoundError, AccessDeniedError, IdentifierError, ...). */
export function httpStatusOf(err: any): number | null {
  const s = err && typeof err.status === 'number' ? err.status : null;
  return s && s >= 400 && s < 600 ? s : null;
}

/**
 * Maps a Postgres error raised while running a caller's query to a client-error status instead of a blanket 500:
 * undefined table/schema -> 404, undefined column / bad datatype / bad value -> 400, unique / foreign-key
 * violation -> 409, not-null / check -> 400, insufficient privilege -> 403, statement timeout -> 408.
 * Returns null for anything else (a genuine server fault stays a 500).
 */
export function pgClientError(err: any): { status: number; code: string } | null {
  const c = err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
  if (!c) return null;
  switch (c) {
    case '42P01': return { status: 404, code: 'UNDEFINED_TABLE' };
    case '3F000': return { status: 404, code: 'UNDEFINED_SCHEMA' };
    case '42703': return { status: 400, code: 'UNDEFINED_COLUMN' };
    case '42883': return { status: 400, code: 'UNDEFINED_FUNCTION' };
    case '42804': case '42846': return { status: 400, code: 'DATATYPE_MISMATCH' };
    case '42702': case '42725': return { status: 400, code: 'AMBIGUOUS_REFERENCE' };
    case '42601': return { status: 400, code: 'INVALID_QUERY' };
    case '42501': return { status: 403, code: 'ACCESS_DENIED' };
    case '23505': return { status: 409, code: 'UNIQUE_VIOLATION' };
    case '23503': return { status: 409, code: 'FOREIGN_KEY_VIOLATION' };
    case '23P01': return { status: 409, code: 'EXCLUSION_VIOLATION' };
    case '23502': return { status: 400, code: 'NOT_NULL_VIOLATION' };
    case '23514': return { status: 400, code: 'CHECK_VIOLATION' };
    case '57014': return { status: 408, code: 'QUERY_TIMEOUT' };
    case '42803': return { status: 400, code: 'GROUPING_ERROR' };
    default:
      if (c.startsWith('22')) return { status: 400, code: 'INVALID_VALUE' };
      if (c.startsWith('42')) return { status: 400, code: 'INVALID_QUERY' }; // syntax / access-rule class: a malformed request, not a server fault
      if (c.startsWith('23')) return { status: 400, code: 'CONSTRAINT_VIOLATION' };
      if (c.startsWith('0A') || c.startsWith('54')) return { status: 400, code: 'UNSUPPORTED_QUERY' }; // feature not supported / program limit exceeded by the request
      return null;
  }
}

/**
 * SQL predicate that restricts a `public.catalog_schemas` alias to the given tenant. Appends the three
 * bound parameters it needs to `params` and returns the predicate text:
 *   - schemas of a source owned by the tenant (`data_sources.tenant_id`), or
 *   - source-less hub schemas whose physical name is exactly `tenant_<id>` or `tenant_<id>_...`
 *     (LIKE wildcards in the id are escaped, so `_` / `%` never match anything else).
 */
export function catalogSchemaScope(alias: string, params: any[], tenantId: string): string {
  params.push(tenantId); const t = params.length;
  params.push(`tenant_${tenantId}`); const base = params.length;
  params.push(`${escapeLike(`tenant_${tenantId}_`)}%`); const like = params.length;
  return `(${alias}.source_id IN (SELECT ds_scope.id FROM public.data_sources ds_scope WHERE ds_scope.tenant_id = $${t}) `
    + `OR (${alias}.source_id IS NULL AND (${alias}.physical_name = $${base} OR ${alias}.physical_name LIKE $${like} ESCAPE '\\')))`;
}

/** Minimal shape shared by pg.Pool and pg.PoolClient. */
export interface Queryable { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>; }

/**
 * Returns an existing tenant id that overlaps with `id` (case-insensitive): an id E such that
 * `id` starts with `E_` or `E` starts with `id_`. Exact duplicates are not "overlaps" (the primary key handles them).
 */
export async function findTenantIdOverlap(db: Queryable, id: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id FROM public.tenants
      WHERE lower(id) <> lower($1::text)
        AND ( left(lower($1::text), length(id) + 1) = lower(id) || '_'
           OR left(lower(id), length($1::text) + 1) = lower($1::text) || '_' )
      LIMIT 1`,
    [id]
  );
  return rows.length ? String(rows[0].id) : null;
}

/**
 * Validates a tenant id for creation: syntax (assertTenantId) and the no-overlap rule. Must run on the same
 * connection/transaction that inserts the tenant; takes a transaction-level advisory lock so two concurrent
 * creations of overlapping ids cannot both pass (the lock is released at COMMIT/ROLLBACK).
 * @throws IdentifierError (400) for bad syntax, TenantIdOverlapError (409, code TENANT_ID_OVERLAP) on overlap.
 */
export async function assertCreatableTenantId(db: Queryable, id: unknown): Promise<string> {
  const tid = assertTenantId(id);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('fabric:tenant-id-overlap'))`);
  const clash = await findTenantIdOverlap(db, tid);
  if (clash) throw new TenantIdOverlapError(clash);
  return tid;
}

/** Stable per-caller key (same convention as api_tokens.user_id): user id, else username. */
export function callerKey(user: any): string {
  return String(user?.id ?? user?.username ?? '');
}

/**
 * The tenant a request acts on. Always the authenticated user's tenant; a request-supplied `tenantId` (body) is
 * honoured ONLY for platform administrators (JWT internal_role=ADMIN, never an API token).
 */
export function requestTenant(req: { user?: any; body?: any }): string | null {
  const user = req.user;
  if (!user) return null;
  const platformAdmin = user.internal_role === 'ADMIN' && user.auth_type !== 'api_token';
  const requested = req.body?.tenantId;
  if (platformAdmin && typeof requested === 'string' && requested) return requested;
  return user.tenant_id ?? null;
}
