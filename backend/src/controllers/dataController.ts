/**
 * @module controllers/dataController
 * @description Simple CRUD façade over the query engine. Each endpoint accepts an ergonomic
 * JSON body ({ source?, schema?, resource, where?, data?, columns?, ... }) and
 * returns the standard fabric envelope including the per-leg execution plan.
 * All endpoints share the {@link handle} wrapper, which builds the execution
 * session, captures the call to the query log, and normalizes error responses.
 */

import { Request, Response } from 'express';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';
import { FabricSequenceService } from '../modules/query-engine/sequence.service';
import { QueryLogService } from '../modules/query-engine/query-log.service';

/**
 * Build an Express handler for a fabric data operation: resolves the caller's
 * execution session (tenant, effective role, region), captures the call to the
 * query log under the given `mode`, invokes `fn` with `(tenantId, body, session)`,
 * and maps thrown errors to the appropriate HTTP status.
 *
 * @param mode - Query-log mode tag for this operation (e.g. `'FETCH'`, `'CRUD_CREATE'`,
 *   `'CRUD_UPDATE'`, `'CRUD_DELETE'`, `'CALL'`, `'SEQUENCE'`); recorded on the query log entry.
 * @param fn - The operation to run: `(tenantId, body, session) => Promise<result>`,
 *   where `body` is `req.body || {}` and `session` is `{ tenantId, role, region, username }`.
 * @returns An Express request handler that:
 *   - builds `session.role` from `(req as any).user.internal_role`/`role`, allowing an
 *     ADMIN caller to override it via the `x-act-as-role` header (for testing
 *     policy/grant/masking as another role);
 *   - builds `session.region` from the `x-region` header, falling back to the
 *     `DEFAULT_REGION` env var, then `'AP'`;
 *   - responds 200 with `fn`'s result on success;
 *   - responds 403 `{ error }` when the error message mentions "suspended" (tenant
 *     suspended) or is an access-control error (`err.accessDenied` or message starting
 *     with `ACCESS DENIED`);
 *   - responds 400 `{ error }` when the message starts with `SAFETY` or
 *     `CONSTRAINT VIOLATION`, or matches a "required"/"invalid"/"not found"/
 *     "does not support" pattern (client input errors);
 *   - responds 500 `{ error }` for anything else, logging the failure.
 */
const handle = (mode: string, fn: (tenantId: string, body: any, session: any) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      // ADMIN may "view as" another role for policy/grant/masking testing (x-act-as-role).
      const actAs = (user.internal_role === 'ADMIN') ? (req.headers['x-act-as-role'] as string) : undefined;
      const session = {
        tenantId: user.tenant_id,
        role: actAs || user.internal_role || user.role,
        region: (req.headers['x-region'] as string) || process.env.DEFAULT_REGION || 'AP',
        username: user.username,
      };
      const result = await QueryLogService.capture(
        { tenantId: user.tenant_id, username: user.username, role: session.role, mode, api: req.path, queryText: JSON.stringify(req.body || {}), source: (req.body || {}).source },
        () => fn(user.tenant_id, req.body || {}, session)
      );
      res.json(result);
    } catch (err: any) {
      const msg = err.message || 'error';
      if (msg.toLowerCase().includes('suspended')) return res.status(403).json({ error: msg });
      // Access control → 403.
      if (err.accessDenied || msg.startsWith('ACCESS DENIED')) return res.status(403).json({ error: msg });
      // Client input errors → 400 (validation / safety), not 500.
      if (msg.startsWith('SAFETY') || msg.startsWith('CONSTRAINT VIOLATION') || /\brequire[sd]?\b|is required|invalid|not found|does not support/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      console.error('[DataController] error:', msg);
      res.status(500).json({ error: msg });
    }
  };

/**
 * POST handler: fabric sequence allocation — Postgres-style `nextval()` for ANY
 * engine (e.g. to give MongoDB inserts consistent sequential IDs). Built via
 * {@link handle} under query-log mode `'SEQUENCE'`.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant, role, username)
 *   and honors `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ name: string (required), start?: number, increment?: number, count?: number }`.
 * @param res - Express response.
 * @returns 200 with the allocated value(s) from `FabricSequenceService.nextval`.
 * @throws Responds 400 `{ error: 'name is required' }` when `name` is missing;
 *   see {@link handle} for the full error-mapping contract (403/400/500).
 */
export const nextSequence = handle('SEQUENCE', async (t, b) => {
  if (!b.name) throw new Error('name is required');
  return FabricSequenceService.nextval(t, b.name, { start: b.start, increment: b.increment, count: b.count });
});

/**
 * POST handler: invoke a provisioned function/procedure (fabric
 * function-as-a-service). Works alongside the AST `{ type: 'CALL' }` form and
 * SQL `CALL`/`SELECT fn(...)` passthrough. Built via {@link handle} under
 * query-log mode `'CALL'`.
 *
 * @param req - Express request. Requires `(req as any).user` and honors
 *   `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ schema?: string, function?: string, procedure?: string, args?: any[] }`.
 * @param res - Express response.
 * @returns 200 with the function/procedure result from `QueryEngineService.executeQuery`,
 *   including the fabric's execution plan.
 * @throws See {@link handle} for the error-mapping contract (403 access denied/suspended,
 *   400 invalid name or SAFETY/CONSTRAINT VIOLATION, 500 otherwise).
 */
export const callFunction = handle('CALL', (t, b, s) =>
  QueryEngineService.executeQuery(t, { type: 'CALL', schema: b.schema, function: b.function, procedure: b.procedure, args: b.args } as any, s));

/**
 * POST handler: fetch rows from a resource (table/collection/index) across any
 * connected engine. Built via {@link handle} under query-log mode `'FETCH'`.
 *
 * @param req - Express request. Requires `(req as any).user` and honors
 *   `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ source?: string, schema?: string, resource: string (required),
 *   columns?: string[], where?: Record<string, any | { $op: any }>,
 *   orderBy?: any[], limit?: number, offset?: number }`. `where` values may be a
 *   literal or a `{ $eq|$in|$match|... : value }` operator map.
 * @param res - Express response.
 * @returns 200 with the fetched rows and the fabric's execution plan
 *   (`QueryEngineService.fetch` → `executeQuery`).
 * @throws Responds 400 when `resource` is missing or a `where`/`columns` key
 *   fails the safe-identifier check (`SAFETY: invalid ... field name`); see
 *   {@link handle} for the full error-mapping contract.
 */
export const fetchData  = handle('FETCH', (t, b, s) => QueryEngineService.fetch(t, b, s));

/**
 * POST handler: insert row(s) into a resource across any connected engine,
 * enforcing registered constraints/grants/policies. Built via {@link handle}
 * under query-log mode `'CRUD_CREATE'`.
 *
 * @param req - Express request. Requires `(req as any).user` and honors
 *   `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ source?: string, schema?: string, resource: string (required),
 *   data: object | object[], generate?: object }` — `generate` declares
 *   write-time value generators (e.g. UUID_V7, sequence) for engines without
 *   native column defaults.
 * @param res - Express response.
 * @returns 200 with the created row(s)/result and the fabric's execution plan
 *   (`QueryEngineService.mutate(..., 'create', ...)`).
 * @throws Responds 400 when `resource` is missing, a constraint is violated
 *   (`CONSTRAINT VIOLATION: ...`), or a field name fails the safety check;
 *   403 when the role lacks INSERT grant (`ACCESS DENIED: ...`) or the tenant
 *   is suspended; see {@link handle} for the full contract.
 */
export const createData = handle('CRUD_CREATE', (t, b, s) => QueryEngineService.mutate(t, 'create', b, s));

/**
 * POST handler: update row(s) matching a filter in a resource across any
 * connected engine, enforcing registered constraints/grants/policies. Built
 * via {@link handle} under query-log mode `'CRUD_UPDATE'`.
 *
 * @param req - Express request. Requires `(req as any).user` and honors
 *   `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ source?: string, schema?: string, resource: string (required),
 *   where: Record<string, any | { $op: any }> (required — unrestricted updates
 *   are blocked), data: object, generate?: object }`.
 * @param res - Express response.
 * @returns 200 with the update result and the fabric's execution plan
 *   (`QueryEngineService.mutate(..., 'update', ...)`).
 * @throws Responds 400 when `resource`/`where` is missing (`SAFETY: update/delete
 *   require a "where" filter ...`), a constraint is violated, or a field name
 *   fails the safety check; 403 when the role lacks UPDATE grant or the tenant
 *   is suspended; see {@link handle} for the full contract.
 */
export const updateData = handle('CRUD_UPDATE', (t, b, s) => QueryEngineService.mutate(t, 'update', b, s));

/**
 * POST handler: delete row(s) matching a filter from a resource across any
 * connected engine, enforcing registered constraints/grants/policies. Built
 * via {@link handle} under query-log mode `'CRUD_DELETE'`.
 *
 * @param req - Express request. Requires `(req as any).user` and honors
 *   `x-act-as-role`/`x-region` headers (see {@link handle}).
 *   Body: `{ source?: string, schema?: string, resource: string (required),
 *   where: Record<string, any | { $op: any }> (required — unrestricted deletes
 *   are blocked) }`.
 * @param res - Express response.
 * @returns 200 with the delete result and the fabric's execution plan
 *   (`QueryEngineService.mutate(..., 'delete', ...)`).
 * @throws Responds 400 when `resource`/`where` is missing (`SAFETY: update/delete
 *   require a "where" filter ...`) or a field name fails the safety check;
 *   403 when the role lacks DELETE grant or the tenant is suspended; see
 *   {@link handle} for the full contract.
 */
export const deleteData = handle('CRUD_DELETE', (t, b, s) => QueryEngineService.mutate(t, 'delete', b, s));
