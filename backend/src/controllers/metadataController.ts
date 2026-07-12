/**
 * @module controllers/metadataController
 * @description Metadata / catalog control plane: browse the crawled catalog
 * (sources → schemas → tables/resources → columns/relationships), preview data,
 * crawl a tenant's connected sources, and manage the manifest-driven
 * provisioning lifecycle (diff/apply/history/rollback/migrate) via
 * `MetadataOrchestrator`. Catalog reads are cached in Redis (see (@link META_TTL))
 * because they only change on an explicit sync (crawl/apply/register/remove) —
 * every such path calls `invalidateTenant` to bust the cache, so correctness
 * comes from invalidation rather than a short TTL.
 */

import { Request, Response } from 'express';
import { MetadataService } from '../modules/metadata/metadata.service';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';
import { MetadataOrchestrator } from '../modules/metadata/orchestrator';
import { ManifestParser } from '../modules/metadata/manifest_parser';
import { pool, queryWithContext } from '../config/database';
import { cached, invalidateTenant } from '../config/cache';
import { ConnectorFactory } from '../modules/metadata/connectors/factory';
import { renderFabricDdl, renderFabricAst } from '../modules/metadata/ddl_render';

const orchestrator = new MetadataOrchestrator();
// Catalog reads change ONLY on sync (crawl/apply/register/remove), and every such
// path invalidates the cache — so serve from Redis for a long window between syncs.
/** Redis TTL (seconds) for cached catalog reads; correctness comes from `invalidateTenant`, not expiry. */
const META_TTL = 3600; // 1h; correctness comes from invalidation, not expiry

/**
 * Normalize a manifest `definition_ast` column entry into the shape the UI
 * expects, folding `length` into a SQL-style type string (e.g. `VARCHAR(255)`)
 * and deriving `nullable` from `nullable !== false && !primaryKey`.
 *
 * @param c - Raw AST column definition (`(name, type, length?, nullable?,
 *   default?, primaryKey?, strategy?)`).
 * @returns Normalized column `(name, type, nullable, default, primaryKey, strategy)`.
 */
function normalizeAstColumn(c: any) {
    return {
        name: c.name,
        type: c.length ? `${c.type}(${c.length})` : c.type,
        nullable: c.nullable !== false && !c.primaryKey,
        default: c.default ?? null,
        primaryKey: !!c.primaryKey,
        strategy: c.strategy || null,
    };
}

/**
 * Resolve the columns + constraints for a catalog resource, preferring the
 * manifest `definition_ast` (richest: PK/strategy/constraints) and falling back
 * to LIVE discovery from the real source (local hub `information_schema` or the
 * source connector's `discoverColumns`). Shared by (@link getColumns) and
 * (@link getResourceDetails) so both surface identical column metadata.
 *
 * @param tableId - the catalog table id.
 * @param tenantId - tenant for RLS/context.
 * @param username - username for query context.
 * @returns `(source, columns, constraints)` or null when the id is unknown.
 */
async function resolveColumns(tableId: string, tenantId: string, username: string):
    Promise<{ source: string; columns: any[]; constraints: any[] } | null> {
    const { rows } = await queryWithContext(`
        SELECT ct.physical_name AS t, cs.physical_name AS s, ct.definition_ast AS ast,
               ds.type AS engine, ds.config AS cfg, ds.name AS src
        FROM public.catalog_tables ct
        JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
        LEFT JOIN public.data_sources ds ON cs.source_id = ds.id
        WHERE ct.id = $1
    `, [tableId], { tenantId, username });
    if (rows.length === 0) return null;
    const row = rows[0];

    // 1. Manifest AST columns (richest).
    const ast = row.ast && typeof row.ast === 'object' ? row.ast : null;
    if (ast && Array.isArray(ast.columns) && ast.columns.length) {
        return { source: 'manifest', columns: ast.columns.map(normalizeAstColumn), constraints: ast.constraints || [] };
    }

    // 2. Live discovery from the source.
    const engine = String(row.engine || 'POSTGRES').toUpperCase();
    const cfg = row.cfg || {};
    const isLocalHub = cfg.local === true || row.src === 'Fabric_Hub_Postgres' || !row.engine;
    if (isLocalHub || (engine === 'POSTGRES' && !cfg.host && !cfg.connectionString)) {
        const cols = await queryWithContext(`
            SELECT column_name AS name, data_type AS type, (is_nullable = 'YES') AS nullable, column_default AS "default"
            FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position
        `, [row.s, row.t], { tenantId, username });
        return { source: 'live', columns: cols.rows, constraints: [] };
    }
    const connector = ConnectorFactory.getConnector(engine, cfg);
    try {
        const cols = connector.discoverColumns ? await connector.discoverColumns(row.s, row.t) : [];
        return { source: 'live', columns: cols, constraints: [] };
    } finally {
        await connector.close();
    }
}

/**
 * Export the current catalog (all sources, or one named source) as a
 * datafabric manifest — the reverse operation of (@link applyMetadata), useful
 * for round-tripping the live catalog back into a manifest file.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   Query param `source` (string, optional) restricts the export to one named source.
 * @param res - Express response. Sets `Content-Disposition: attachment` with a
 *   generated filename `fabric-manifest-<source|all>-<tenantId>.json` to hint a download.
 * @returns 200 with the manifest JSON from `MetadataService.exportManifest`.
 * @throws Responds 500 `(error)` on failure.
 */
export const exportMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const source = req.query.source as string | undefined;
        const manifest = await MetadataService.exportManifest(user.tenant_id, source);
        const fname = `fabric-manifest-${source || 'all'}-${user.tenant_id}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        res.json(manifest);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Live-introspect the real definition of a non-table Postgres object (view,
 * materialized view, function, procedure, sequence, enum, trigger) from the
 * source's system catalogs — the crawler stores only type+name, so the actual
 * body/query/values must be fetched on demand. Runs against the local hub
 * (queryWithContext) or a remote Postgres source (connector.rawQuery). Returns a
 * partial `(definitionSql?, definitionAst?)` to feed the fabric DDL/AST renderers;
 * returns `{}` for engines/types that have no such catalog concept.
 *
 * @param tableId - the catalog resource id.
 * @param tenantId - tenant for query context.
 * @param username - username for query context.
 * @returns `(definitionSql?, definitionAst?)` (possibly empty).
 */
async function resolveDefinition(tableId: string, tenantId: string, username: string):
    Promise<{ definitionSql?: string; definitionAst?: any }> {
    const { rows } = await queryWithContext(`
        SELECT ct.physical_name AS t, cs.physical_name AS s, ct.resource_type AS rtype,
               ds.type AS engine, ds.config AS cfg, ds.name AS src
        FROM public.catalog_tables ct
        JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
        LEFT JOIN public.data_sources ds ON cs.source_id = ds.id
        WHERE ct.id = $1
    `, [tableId], { tenantId, username });
    if (!rows.length) return {};
    const row = rows[0];
    const rtype = String(row.rtype || '').toUpperCase();
    const engine = String(row.engine || 'POSTGRES').toUpperCase();
    if (engine !== 'POSTGRES') return {}; // only Postgres has these catalog objects
    const cfg = row.cfg || {};
    const isLocalHub = cfg.local === true || row.src === 'Fabric_Hub_Postgres' || !row.engine
        || (engine === 'POSTGRES' && !cfg.host && !cfg.connectionString);

    // Run an introspection query either on the hub (with tenant context) or the remote source.
    let connector: any = null;
    const run = async (sql: string, params: any[]): Promise<any[]> => {
        if (isLocalHub) return (await queryWithContext(sql, params, { tenantId, username })).rows;
        connector = connector || ConnectorFactory.getConnector(engine, cfg);
        return connector.rawQuery ? connector.rawQuery(sql, params) : [];
    };

    try {
        if (rtype === 'VIEW' || rtype === 'MATERIALIZED_VIEW') {
            // Portable catalog lookup (avoids a ::regclass cast that can fail across search_paths).
            const cat = rtype.includes('MATERIALIZED')
                ? `SELECT definition AS def FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2`
                : `SELECT definition AS def FROM pg_views WHERE schemaname = $1 AND viewname = $2`;
            const r = await run(cat, [row.s, row.t]);
            const def = r[0]?.def?.trim();
            if (def) return { definitionAst: { query: def, materialized: rtype.includes('MATERIALIZED') } };
        } else if (rtype === 'FUNCTION' || rtype === 'PROCEDURE') {
            const r = await run(`
                SELECT pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS ret,
                       l.lanname AS lang, p.prosrc AS body,
                       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                JOIN pg_language l ON l.oid = p.prolang
                WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`, [row.s, row.t]);
            const f = r[0];
            if (f) return { definitionAst: { type: f.kind, argsText: f.args || '', returnType: f.ret, body: (f.body || '').trim(), language: f.lang } };
        } else if (rtype === 'SEQUENCE') {
            const r = await run(`SELECT start_value AS start, increment_by AS increment, min_value AS "minValue", max_value AS "maxValue", cache_size AS cache FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, [row.s, row.t]);
            if (r[0]) return { definitionAst: r[0] };
        } else if (rtype === 'ENUM') {
            const r = await run(`SELECT e.enumlabel AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder`, [row.s, row.t]);
            if (r.length) return { definitionAst: { values: r.map((x: any) => x.v) } };
        } else if (rtype === 'TRIGGER') {
            const r = await run(`SELECT pg_get_triggerdef(tr.oid, true) AS def, c.relname AS tbl FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND tr.tgname = $2 AND NOT tr.tgisinternal LIMIT 1`, [row.s, row.t]);
            const d = r[0];
            if (d?.def) return { definitionSql: d.def, definitionAst: { table: d.tbl, triggerDef: d.def } };
        }
    } catch { /* best-effort; renderer falls back to a labelled note */ }
    finally { if (connector) { try { await connector.close(); } catch { /* ignore */ } } }
    return {};
}

/**
 * Column-level metadata for a catalog resource (table/collection/index).
 * Prefers the manifest's `definition_ast` (rich: PK/strategy/constraints);
 * falls back to LIVE discovery from the real source (works for crawled tables
 * that have no manifest AST — either the local hub's `information_schema`, or
 * the source connector's `discoverColumns`). Results are cached per tenant+tableId.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Query params: `tableId` (string) — the catalog table id directly, OR
 *   `source` + `resource` (strings) as a convenience pair that gets resolved to
 *   a `tableId` via a join across `data_sources`/`catalog_schemas`/`catalog_tables`.
 * @param res - Express response.
 * @returns 200 with `(source: 'manifest' | 'live', columns: [...], constraints: [...])`.
 * @throws Responds 400 `(error: 'tableId (or source+resource) is required')` when
 *   neither is resolvable; 404 `(error: 'Resource not found')` when the table id
 *   doesn't exist; 500 `(error)` on failure (e.g. connector discovery error).
 */
export const getColumns = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let tableId = req.query.tableId as string;
        // Convenience: resolve tableId from a (source, resource) pair when not given directly.
        if (!tableId) {
            const source = req.query.source as string | undefined;
            const resource = req.query.resource as string | undefined;
            if (source && resource) {
                const { rows } = await queryWithContext(`
                    SELECT ct.id FROM public.catalog_tables ct
                    JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
                    JOIN public.data_sources ds ON cs.source_id = ds.id
                    WHERE ds.tenant_id = $1 AND ds.name = $2 AND ct.name = $3 LIMIT 1
                `, [user.tenant_id, source, resource], { tenantId: user.tenant_id, username: user.username });
                if (rows.length) tableId = rows[0].id;
            }
        }
        if (!tableId) return res.status(400).json({ error: 'tableId (or source+resource) is required' });
        const key = `meta:${user.tenant_id}:columns:${tableId}`;
        const payload = await cached(key, META_TTL, async () => resolveColumns(tableId, user.tenant_id, user.username));
        if (payload === null) return res.status(404).json({ error: 'Resource not found' });
        res.json(payload);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Relationships (FKs / manifest-declared relationships) for the tenant, for
 * rendering ER diagrams. Cached per tenant+schema.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Query param `schema` (string, optional) filters to relationships whose
 *   source or target schema matches; omitted returns all relationships for the tenant.
 * @param res - Express response.
 * @returns 200 with rows `(name, sourceSchema, sourceTable, sourceColumn,
 *   targetSchema, targetTable, targetColumn, cardinality)` from `fabric_catalog.relationships`.
 * @throws Responds 500 `(error)` on failure.
 */
export const getRelationships = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const schema = req.query.schema as string | undefined;
        const key = `meta:${user.tenant_id}:relationships:${schema || 'all'}`;
        const rows = await cached(key, META_TTL, async () => {
            const params: any[] = [user.tenant_id];
            let sql = `SELECT name, source_schema AS "sourceSchema", source_table AS "sourceTable", source_column AS "sourceColumn",
                              target_schema AS "targetSchema", target_table AS "targetTable", target_column AS "targetColumn", cardinality
                       FROM fabric_catalog.relationships WHERE tenant_id = $1`;
            if (schema) { params.push(schema); sql += ` AND (source_schema = $2 OR target_schema = $2)`; }
            return (await queryWithContext(sql, params, { tenantId: user.tenant_id, username: user.username })).rows;
        });
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Legacy-style lookup of column metadata/descriptions for a table by name,
 * scanning the `fabric_catalog.metadata` table for any schema matching the
 * caller's tenant naming convention (`tenant_<id>%`).
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   `req.params.name` is the table name to look up.
 * @param res - Express response.
 * @returns 200 `(table, columns)` where `columns` is the array of matching
 *   `(schema_name, column_name, data_type, description)` rows (may be empty
 *   if no match; this endpoint does not 404).
 * @throws Responds 500 `(error)` on a database failure.
 */
export const getTableDetails = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const tableName = req.params.name;
        const { rows } = await pool.query(`
            SELECT schema_name, column_name, data_type, description 
            FROM fabric_catalog.metadata 
            WHERE schema_name LIKE $1 AND table_name = $2
        `, [`tenant_${user.tenant_id}%`, tableName]);
        res.json({ table: tableName, columns: rows });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Trigger a catalog crawl (discover schemas/tables/columns) for a tenant's
 * connected sources, then invalidate that tenant's cache so the refreshed
 * catalog is served on the next read.
 *
 * @param req - Express request. Requires `(req as any).user`. For an ADMIN
 *   caller, the target tenant comes from `req.body.tenantId` (cross-tenant
 *   crawl); for any other caller, it's forced to their own `tenant_id`.
 * @param res - Express response.
 * @returns 200 with the crawl result summary from `MetadataService.crawlTenant`.
 * @throws Responds 400 `(error: 'tenantId is required')` when an ADMIN caller
 *   omits `tenantId`; 500 `(error)` on a crawl failure.
 */
export const crawlTenant = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const tenantId = user?.internal_role === 'ADMIN' ? req.body.tenantId : user?.tenant_id;
        if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
        const result = await MetadataService.crawlTenant(tenantId);
        await invalidateTenant(tenantId); // fresh catalog → bust cached reads
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * List the caller's tenant's registered data sources (id/name/type/status).
 * Cached per tenant.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 * @param res - Express response.
 * @returns 200 with rows from `public.data_sources`.
 * @throws Responds 500 `(error)` on failure.
 */
export const getSources = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const rows = await cached(`meta:${user.tenant_id}:sources`, META_TTL, async () =>
            (await queryWithContext('SELECT id, name, type, status FROM public.data_sources', [], { tenantId: user.tenant_id, username: user.username })).rows);
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * List the catalog schemas discovered under a given data source. Cached per
 * tenant+sourceId.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Query param `sourceId` (string, required) is the owning source's id.
 * @param res - Express response.
 * @returns 200 with rows `(schemaId, name, physicalName)` from `public.catalog_schemas`.
 * @throws Responds 400 `(error: 'sourceId is required')` when missing;
 *   500 `(error)` on failure.
 */
export const getSchemas = async (req: Request, res: Response) => {
    try {
        const sourceId = req.query.sourceId as string;
        if (!sourceId) return res.status(400).json({ error: 'sourceId is required' });
        const user = (req as any).user;
        const rows = await cached(`meta:${user.tenant_id}:schemas:${sourceId}`, META_TTL, async () =>
            (await queryWithContext('SELECT id as "schemaId", name, physical_name as "physicalName" FROM public.catalog_schemas WHERE source_id = $1', [sourceId], { tenantId: user.tenant_id, username: user.username })).rows);
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * List the catalog tables/resources discovered under a given schema. Cached
 * per tenant+schemaId.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Query param `schemaId` (string, required) is the owning schema's id.
 * @param res - Express response.
 * @returns 200 with rows `(tableId, name, physicalName, rowCount, resourceType)`
 *   from `public.catalog_tables`.
 * @throws Responds 400 `(error: 'schemaId is required')` when missing;
 *   500 `(error)` on failure.
 */
export const getTables = async (req: Request, res: Response) => {
    try {
        const schemaId = req.query.schemaId as string;
        if (!schemaId) return res.status(400).json({ error: 'schemaId is required' });
        const user = (req as any).user;
        const rows = await cached(`meta:${user.tenant_id}:tables:${schemaId}`, META_TTL, async () =>
            (await queryWithContext('SELECT id as "tableId", name, physical_name as "physicalName", row_count as "rowCount", resource_type as "resourceType" FROM public.catalog_tables WHERE schema_id = $1', [schemaId], { tenantId: user.tenant_id, username: user.username })).rows);
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Preview a small sample of rows from a catalog resource by table id, used by
 * the UI's data-preview panel. Not cached (always hits the live source).
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   Query params: `tableId` (string, required), `limit` (number, defaults to 50).
 * @param res - Express response.
 * @returns 200 with a plain array of preview rows, normalized regardless of
 *   whether the underlying connector returns a bare array, `(data: [...])`,
 *   or `(results: [...])`.
 * @throws Responds 400 `(error: 'tableId is required')` when missing;
 *   500 `(error)` on failure (e.g. unknown tableId or source error).
 */
export const getPreviewData = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { tableId, limit = 50 } = req.query;
        if (!tableId) return res.status(400).json({ error: 'tableId is required' });

        const result = await QueryEngineService.executeQuery(user.tenant_id, {
            type: 'SELECT',
            tableId: tableId as string,
            limit: parseInt(limit as string),
            select: ['*']
        });

        // Normalize payload for UI consumers across physical + virtual connectors.
        if (Array.isArray(result)) return res.json(result);
        if (Array.isArray((result as any)?.data)) return res.json((result as any).data);
        if (Array.isArray((result as any)?.results)) return res.json((result as any).results);
        res.json(result || []);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Return a blank/example datafabric manifest template to seed the manifest
 * editor UI. Synchronous — no async work or tenant scoping.
 *
 * @param req - Express request (unused).
 * @param res - Express response.
 * @returns 200 with the template object from `MetadataService.getTemplate`.
 */
export const getTemplate = (req: Request, res: Response) => {
    res.json(MetadataService.getTemplate());
};

/**
 * @openapi
 * /api/metadata/diff:
 *   post:
 *     summary: Analyze Drift (Diff)
 *     description: Performs a deep structural analysis between the provided Industrial Blueprint (JSON) and the live database state. Detects new schemas, resources, and root-level orchestration requirements.
 *     tags: [Metadata]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MetadataManifest'
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Drift analysis complete (Plan Ready)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "PLAN_READY" }
 *                 changes: { type: array, items: { type: object } }
 *       500:
 *         description: Analysis failed
 */
/**
 * Analyze drift between a submitted datafabric manifest and the tenant's live
 * database/catalog state, producing a change plan (new/changed schemas,
 * resources, orchestration steps) without applying anything.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   Accepts the manifest either as an uploaded `file` (`req.file`, via multer
 *   memory storage — see `metadataRoutes.ts`) or as the raw JSON request body
 *   (string or object, stringified before parsing).
 * @param res - Express response.
 * @returns 200 with the drift plan from `MetadataOrchestrator.plan` (e.g.
 *   `(status: 'PLAN_READY', changes: [...])`).
 * @throws Responds 500 `(error)` when the manifest fails to parse or the
 *   diff computation fails.
 */
export const diffMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let content = '';
        if (req.file) {
            content = req.file.buffer.toString();
        } else {
            content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        const manifest = ManifestParser.parse(content);
        const plan = await orchestrator.plan(user.tenant_id, manifest);
        res.json(plan);
    } catch (err: any) {
        console.error(`[MetadataController] Diff Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Apply a datafabric manifest: orchestrates the actual schema/resource
 * provisioning (create/alter tables, register sources, wire downstream
 * targets, etc.) implied by the manifest, then invalidates the tenant's cache.
 *
 * @param req - Express request. Requires an authenticated `(req as any).user`.
 *   Accepts the manifest either as an uploaded `file` (`req.file`) or as the
 *   raw JSON request body (string or object, stringified before parsing).
 *   Query param `force` (`'true'`/other, optional) bypasses guardrail checks
 *   that would otherwise block a risky apply.
 * @param res - Express response.
 * @returns 200 with the orchestration result from `MetadataOrchestrator.apply`.
 * @throws Responds 401 `(error: 'Authentication required')` when there is no
 *   authenticated user; 400 `(error: 'Industrial Guardrail Violation', message)`
 *   when the orchestrator rejects the manifest for safety reasons (message
 *   contains `CRITICAL`/`Validation`/`High-Risk`/`Integrity`); 500
 *   `(error: 'Orchestration Failed', message)` for any other failure.
 */
export const applyMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        
        let content = '';
        if (req.file) {
            content = req.file.buffer.toString();
        } else {
            content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        
        const manifest = ManifestParser.parse(content);
        const force = req.query.force === 'true';
        
        const result = await orchestrator.apply(user.tenant_id, manifest, { force });
        await invalidateTenant(user.tenant_id);
        res.json(result);
    } catch (err: any) {
        console.error(`[MetadataController] Apply Error: ${err.message}`);
        
        // Industrial Guardrail Violation (Section 3.2)
        if (err.message.includes('CRITICAL') || err.message.includes('Validation') || err.message.includes('High-Risk') || err.message.includes('Integrity')) {
            return res.status(400).json({ 
                error: 'Industrial Guardrail Violation', 
                message: err.message 
            });
        }
        
        res.status(500).json({ error: 'Orchestration Failed', message: err.message });
    }
};

/**
 * List the manifest apply history (versions) for the caller's tenant, most
 * recent first, for the rollback/version-diff UI.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 * @param res - Express response.
 * @returns 200 with the history array from `MetadataOrchestrator.getHistory`.
 * @throws Responds 500 `(error)` on failure.
 */
export const getMetadataHistory = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const history = await orchestrator.getHistory(user.tenant_id);
        res.json(history);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Roll back the tenant's catalog/schema state to a previously applied
 * manifest version.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   `req.params.id` is the manifest history/version id to roll back to.
 * @param res - Express response.
 * @returns 200 with the rollback result from `MetadataOrchestrator.rollback`.
 * @throws Responds 500 `(error)` on failure (e.g. unknown version id).
 */
export const rollbackMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const versionId = req.params.id as string;
        const result = await orchestrator.rollback(user.tenant_id, versionId);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Apply a set of ad-hoc metadata migration steps (schema evolution diffs) not
 * tied to a full manifest apply.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   Body: `(migrationPlan)` — the list/spec of migration steps to run,
 *   passed through to `MetadataService.migrateMetadata`.
 * @param res - Express response.
 * @returns 200 `(results)` with the per-step migration results.
 * @throws Responds 500 `(error)` on failure.
 */
export const migrateMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { migrationPlan } = req.body;
        const results = await MetadataService.migrateMetadata(user.tenant_id, migrationPlan);
        res.json({ results });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Fetch the 10 most recent audit-log events for the caller's tenant, shaped
 * for a compact "recent activity" feed.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 * @param res - Express response.
 * @returns 200 with rows `(id, action, tableName, createdAt, details)` from `public.audit_logs`.
 * @throws Responds 500 `(error)` on failure.
 */
export const getEvents = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await pool.query(
      'SELECT id, action, table_name as "tableName", changed_at as "createdAt", new_data as "details" FROM public.audit_logs WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT 10',
      [user.tenant_id]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// The search/analytics targets the fabric can drive. Always shown in the control
// centre so an operator can enable/disable them, whether or not a manifest set them.
/** Canonical downstream analytics/search targets always surfaced in the control centre, regardless of manifest or registry state. */
const CANONICAL_DOWNSTREAMS = ['ELASTICSEARCH', 'SNOWFLAKE'];

/**
 * Report the status of downstream mutation-sync targets (Elasticsearch,
 * Snowflake, plus any other registry entries) for the caller's tenant,
 * merging live registry rows with whether a matching connection actually exists.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 * @param res - Express response.
 * @returns 200 with an array covering every (@link CANONICAL_DOWNSTREAMS) target
 *   plus any extra registry entries: `(target_type, status, config, connected,
 *   updated_at)`, where `status` is the registry status if present, else
 *   `'AVAILABLE'` (connection exists but not registered) or `'NOT_CONFIGURED'`.
 * @throws Responds 500 `(error)` on failure.
 */
export const getDownstreamStatus = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { rows } = await pool.query('SELECT target_type, config, status, updated_at FROM fabric_system.downstream_registry WHERE tenant_id = $1', [user.tenant_id]);
        const byType: Record<string, any> = {};
        for (const r of rows) byType[String(r.target_type).toUpperCase()] = r;
        // Which of these engines actually have a registered connection?
        const conn = await pool.query(
            `SELECT DISTINCT upper(type) AS type FROM public.data_sources WHERE tenant_id = $1 AND upper(type) = ANY($2)`,
            [user.tenant_id, CANONICAL_DOWNSTREAMS]
        );
        const connected = new Set(conn.rows.map((r) => r.type));
        // Always surface the canonical targets; merge live registry state + connection presence.
        const out = CANONICAL_DOWNSTREAMS.map((t) => {
            const r = byType[t];
            return {
                target_type: t,
                status: r ? r.status : (connected.has(t) ? 'AVAILABLE' : 'NOT_CONFIGURED'),
                config: r?.config || {},
                connected: connected.has(t),
                updated_at: r?.updated_at || null,
            };
        });
        // Append any other registry targets not in the canonical set.
        for (const r of rows) if (!CANONICAL_DOWNSTREAMS.includes(String(r.target_type).toUpperCase())) out.push({ ...r, connected: false });
        res.json(out);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Enable or disable a downstream mutation-sync target (e.g. Elasticsearch,
 * Snowflake) for the caller's tenant. Directly upserts the downstream
 * registry so the toggle works even without a manifest, and best-effort
 * mirrors the change into the tenant's latest applied manifest (re-applying
 * it with `force: true`) when one exists.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   Body: `(targetType: string (required), enabled: boolean)`.
 * @param res - Express response.
 * @returns 200 `(status: 'SUCCESS', targetType, enabled)`.
 * @throws Responds 400 `(error: 'targetType is required')` when missing;
 *   500 `(error)` on a registry-update failure. Failures while re-applying
 *   the manifest mirror are caught and logged, not surfaced to the caller.
 */
export const toggleDownstream = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { targetType, enabled } = req.body;
        if (!targetType) return res.status(400).json({ error: 'targetType is required' });
        const status = enabled ? 'ACTIVE' : 'DISABLED';
        // Directly upsert the registry so enabling/disabling works even with no manifest.
        await pool.query(
            `INSERT INTO fabric_system.downstream_registry (tenant_id, target_type, config, status, updated_at)
             VALUES ($1, $2, '{}'::jsonb, $3, NOW())
             ON CONFLICT (tenant_id, target_type)
             DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
            [user.tenant_id, String(targetType).toUpperCase(), status]
        );
        // If a manifest exists, also reflect the toggle in it + re-orchestrate (best-effort).
        try {
            const { rows } = await pool.query(`SELECT ast_content FROM fabric_system.metadata_history WHERE tenant_id = $1 ORDER BY applied_at DESC LIMIT 1`, [user.tenant_id]);
            if (rows.length) {
                const manifest = rows[0].ast_content; manifest.downstream = manifest.downstream || [];
                const t = manifest.downstream.find((d: any) => String(d.type).toUpperCase() === String(targetType).toUpperCase());
                if (t) t.enabled = enabled; else manifest.downstream.push({ type: String(targetType).toUpperCase(), enabled });
                await orchestrator.apply(user.tenant_id, manifest, { force: true });
            }
        } catch (e: any) { console.warn(`[Downstream] manifest re-apply skipped: ${e.message}`); }
        res.json({ status: 'SUCCESS', targetType: String(targetType).toUpperCase(), enabled });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * Fetch full details for a single catalog resource (table/collection/index),
 * including its definition (SQL and/or AST) and owning source info.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   `req.params.id` is the catalog table id.
 * @param res - Express response.
 * @returns 200 with `(tableId, name, physicalName, resourceType, definitionSql,
 *   definitionAst, rowCount, sourceType, sourceName)`.
 * @throws Responds 404 `(error: 'Resource not found')` when the id doesn't
 *   match any catalog table; 500 `(error)` on failure.
 */
export const getResourceDetails = async (req: Request, res: Response) => {
    try {
        const resourceId = req.params.id;
        const user = (req as any).user;
        
        const { rows } = await queryWithContext(`
            SELECT
                ct.id as "tableId",
                ct.name,
                ct.physical_name as "physicalName",
                ct.resource_type as "resourceType",
                ct.definition_sql as "definitionSql",
                ct.definition_ast as "definitionAst",
                ct.row_count as "rowCount",
                cs.name as "schemaName",
                ds.type as "sourceType",
                ds.name as "sourceName"
            FROM public.catalog_tables ct
            JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
            LEFT JOIN public.data_sources ds ON cs.source_id = ds.id
            WHERE ct.id = $1
        `, [resourceId], { tenantId: user.tenant_id, username: user.username });

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Resource not found' });
        }

        const row = rows[0];
        const rtype = String(row.resourceType || '').toUpperCase();

        // Resolve columns (manifest AST or live discovery) so the fabric DDL/AST
        // can be reconstructed for crawled resources that carry no manifest.
        let columns: any[] = [];
        try {
            const colTypes = ['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'FOREIGN_TABLE'];
            if (colTypes.includes(rtype)) {
                const resolved = await resolveColumns(String(resourceId), user.tenant_id, user.username);
                columns = resolved?.columns || [];
            } else if (row.definitionAst && Array.isArray(row.definitionAst.columns)) {
                columns = row.definitionAst.columns.map(normalizeAstColumn);
            }
        } catch { /* column discovery is best-effort; DDL/AST still render */ }

        // For non-table objects (view/function/procedure/sequence/enum/trigger)
        // with no stored definition, live-introspect the real DDL from the source
        // catalog so the fabric shows the true definition, not a placeholder.
        let effectiveSql = row.definitionSql;
        let effectiveAst = row.definitionAst;
        const introspectable = ['VIEW', 'MATERIALIZED_VIEW', 'FUNCTION', 'PROCEDURE', 'SEQUENCE', 'ENUM', 'TRIGGER'];
        if (introspectable.includes(rtype) && !effectiveAst && !effectiveSql) {
            try {
                const def = await resolveDefinition(String(resourceId), user.tenant_id, user.username);
                if (def.definitionSql) effectiveSql = def.definitionSql;
                if (def.definitionAst) effectiveAst = def.definitionAst;
            } catch { /* best-effort */ }
        }

        // Always return datafabric-format SQL DDL + Fabric AST — never a
        // `SELECT * FROM x` placeholder or a raw dump. Both are reconstructed in a
        // consistent fabric shape from the (stored or live-introspected) definition.
        // Raw `definitionAst` is kept untouched for the Properties cards; the
        // rendered canonical descriptor is exposed as `fabricAst`.
        const input = { ...row, columns, definitionSql: effectiveSql, definitionAst: effectiveAst };
        const definitionSql = renderFabricDdl(input);
        const fabricAst = renderFabricAst(input);

        res.json({ ...row, columns, definitionSql, fabricAst });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};
