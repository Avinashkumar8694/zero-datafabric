/**
 * @module controllers/queryController
 * @description Query execution endpoints: run an AST/`QueryConfig` through the
 * full fabric engine (AST only; SQL execution is not supported), preview the SQL an AST would compile to, and poll async job status.
 * Endpoints that honor "view as" build an execution session from
 * `(req as any).user` plus the `x-act-as-role`/`x-region` headers (ADMIN only
 * for `x-act-as-role`), mirroring `dataController`'s session logic.
 */

import { Request, Response } from 'express';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';
import { QueryLogService } from '../modules/query-engine/query-log.service';
import { wantsStream, streamNdjson, pipeRowStream } from '../modules/query-engine/stream';
import { tryStream } from '../modules/query-engine/stream_source';
import { queryWithContext } from '../config/database';
import { callerKey, httpStatusOf, pgClientError } from '../utils/tenantScope';

/**
 * Execute a fabric `QueryConfig` (AST-based query: SELECT/CALL/etc.) against
 * the query engine, resolving the engine/connector automatically per the
 * config's `source`/`schema`.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, internal_role,
 *   role, username). Body: `(config)` or the `QueryConfig` directly as the body.
 *   Headers: `x-act-as-role` (ADMIN-only role override for policy/grant/masking
 *   testing), `x-region` (execution region, falls back to `DEFAULT_REGION` env
 *   var then `'AP'`).
 * @param res - Express response.
 * @returns 200 with the result envelope (rows/data + execution plan) from
 *   `QueryEngineService.executeQuery`.
 * @throws Responds 403 `(error)` when the tenant account is suspended;
 *   500 `(error)` on any other failure (validation errors from the engine
 *   also surface as 500 here — this endpoint does not classify errors into
 *   400 the way `dataController` does).
 */
export const executeEngineQuery = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const queryConfig = req.body.config || req.body;
        const actAs = (user.internal_role === 'ADMIN') ? (req.headers['x-act-as-role'] as string) : undefined;
        const session = {
            tenantId: user.tenant_id,
            role: actAs || user.internal_role || user.role,
            region: (req.headers['x-region'] as string) || process.env.DEFAULT_REGION || 'AP',
            username: user.username,
        };
        const result = await QueryEngineService.executeQuery(user.tenant_id, queryConfig, session);
        res.json(result);
    } catch (err: any) {
        console.error(`[QueryController:executeEngineQuery] Error:`, err.message);
        if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
        const st = httpStatusOf(err);
        if (st) return res.status(st).json({ error: err.message, code: err.code });
        const pg = pgClientError(err);
        if (pg) return res.status(pg.status).json({ error: err.message, code: pg.code });
        res.status(500).json({ error: err.message });
    }
};

;

;

/**
 * Transpile an AST query config into the SQL the fabric would generate — powers
 * the "see SQL mode" preview in the AST builder. Accepts ( config ) (a queryConfig
 * with a `.query` AST) or a bare AST `(query)`; returns ( sql ).
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, used to
 *   qualify the schema as `tenant_<tenantId>_<schema>`). Body: `(config)` or a
 *   bare `(query, schema?, limit?)`/`(type: 'CALL', ...)` AST.
 *   - `CALL`/procedure configs produce a `CALL ...` or `SELECT * FROM fn(...)` string directly.
 *   - Recursive queries (`ast.recursive`) have no single SQL form (they run
 *     level-by-level in-fabric), so a note is returned instead.
 *   - Otherwise the AST is passed to `QueryTranspiler.toSql`, with `limit`
 *     appended if the generated SQL doesn't already have one.
 * @param res - Express response.
 * @returns 200 `(sql)` with the generated SQL (or a descriptive placeholder for
 *   recursive queries, `(sql, note: 'RECURSIVE_IN_FABRIC')`).
 * @throws Never propagates an error status — on transpilation failure it still
 *   responds 200 with `(sql: '-- could not transpile to SQL: <message>', error: <message>)`
 *   so the UI preview can render the failure inline.
 */
export const transpileQuery = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const body = req.body || {};
        const cfg = body.config || body;
        if (cfg?.type === 'CALL') {
            const ref = cfg.schema ? `"${cfg.schema}"."${cfg.function || cfg.procedure}"` : `${cfg.function || cfg.procedure}`;
            const args = Array.isArray(cfg.args) ? cfg.args.map((a: any) => JSON.stringify(a)).join(', ') : '';
            return res.json({ sql: cfg.procedure ? `CALL ${ref}(${args});` : `SELECT * FROM ${ref}(${args});` });
        }
        const ast = cfg?.query || cfg;
        if (ast?.recursive) return res.json({ sql: '-- recursive traversal runs in-fabric (level-by-level IN(...) fetches); no single SQL statement.', note: 'RECURSIVE_IN_FABRIC' });
        const { QueryTranspiler } = await import('../modules/metadata/query_transpiler');
        const schema = cfg?.schema ? `tenant_${user.tenant_id}_${cfg.schema}` : undefined;
        let sql = QueryTranspiler.toSql(ast, schema);
        if (typeof cfg?.limit === 'number' && !/\blimit\b/i.test(sql)) sql += ` LIMIT ${cfg.limit}`;
        res.json({ sql: sql.trim() + ';' });
    } catch (err: any) {
        res.status(200).json({ sql: `-- could not transpile to SQL: ${err.message}`, error: err.message });
    }
};

/**
 * Poll the status of an asynchronous query job (enqueued via
 * (@link QueryEngineService.executeAsyncQuery), or another async job producer).
 *
 * @param req - Express request. `req.params.id` is the job id.
 * @param res - Express response.
 * @returns 200 with the job status record from `QueryEngineService.getJobStatus`
 *   (e.g. `(status: 'PENDING' | 'RUNNING' | 'DONE' | ..., result?, error?)`).
 * @throws Responds 404 with the job record when its `status` is `'NOT_FOUND'`;
 *   403 `(error)` when the job/tenant is suspended; 500 `(error)` otherwise.
 */
export const getJobStatus = async (req: Request, res: Response) => {
    try {
        const u = (req as any).user || {};
        const job = QueryEngineService.getJobStatus(req.params.id as string, u.tenant_id, callerKey(u));
        if (job.status === 'NOT_FOUND') return res.status(404).json(job);
        res.json(job);
    } catch (err: any) {
        console.error(`[QueryController:getJobStatus] Error:`, err.message);
        if (err.message.includes('SUSPENDED')) return res.status(403).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
};
