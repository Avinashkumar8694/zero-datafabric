import { Request, Response } from 'express';
import { MetadataService } from '../modules/metadata/metadata.service';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';
import { MetadataOrchestrator } from '../modules/metadata/orchestrator';
import { ManifestParser } from '../modules/metadata/manifest_parser';
import { pool, queryWithContext } from '../config/database';
import { cached, invalidateTenant } from '../config/cache';
import { ConnectorFactory } from '../modules/metadata/connectors/factory';

const orchestrator = new MetadataOrchestrator();
// Catalog reads change ONLY on sync (crawl/apply/register/remove), and every such
// path invalidates the cache — so serve from Redis for a long window between syncs.
const META_TTL = 3600; // 1h; correctness comes from invalidation, not expiry

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
 * Column-level metadata for a catalog resource. Prefers the manifest's
 * definition_ast (rich: PK/strategy/constraints); falls back to LIVE discovery
 * from the real source (works for crawled tables that have no manifest AST).
 */
export const getColumns = async (req: Request, res: Response) => {
    try {
        const tableId = req.query.tableId as string;
        if (!tableId) return res.status(400).json({ error: 'tableId is required' });
        const user = (req as any).user;
        const key = `meta:${user.tenant_id}:columns:${tableId}`;
        const payload = await cached(key, META_TTL, async () => {
            const { rows } = await queryWithContext(`
                SELECT ct.physical_name AS t, cs.physical_name AS s, ct.definition_ast AS ast,
                       ds.type AS engine, ds.config AS cfg, ds.name AS src
                FROM public.catalog_tables ct
                JOIN public.catalog_schemas cs ON ct.schema_id = cs.id
                LEFT JOIN public.data_sources ds ON cs.source_id = ds.id
                WHERE ct.id = $1
            `, [tableId], { tenantId: user.tenant_id, username: user.username });
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
                `, [row.s, row.t], { tenantId: user.tenant_id, username: user.username });
                return { source: 'live', columns: cols.rows, constraints: [] };
            }
            const connector = ConnectorFactory.getConnector(engine, cfg);
            try {
                const cols = connector.discoverColumns ? await connector.discoverColumns(row.s, row.t) : [];
                return { source: 'live', columns: cols, constraints: [] };
            } finally {
                await connector.close();
            }
        });
        if (payload === null) return res.status(404).json({ error: 'Resource not found' });
        res.json(payload);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

/** Relationships (FKs / manifest relationships) for the tenant, for ER diagrams. */
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

export const getMetadataHistory = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const history = await orchestrator.getHistory(user.tenant_id);
        res.json(history);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

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

export const getDownstreamStatus = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { rows } = await pool.query('SELECT target_type, config, status, updated_at FROM fabric_system.downstream_registry WHERE tenant_id = $1', [user.tenant_id]);
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const toggleDownstream = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { targetType, enabled } = req.body;
        
        // 1. Fetch Latest Manifest
        const { rows } = await pool.query(`SELECT ast_content FROM fabric_system.metadata_history WHERE tenant_id = $1 ORDER BY applied_at DESC LIMIT 1`, [user.tenant_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'No active manifest found for tenant' });
        
        const manifest = rows[0].ast_content;
        if (!manifest.downstream) manifest.downstream = [];
        
        // 2. Update Target State
        const target = manifest.downstream.find((d: any) => d.type === targetType);
        if (target) {
            target.enabled = enabled;
        } else {
            manifest.downstream.push({ type: targetType, enabled });
        }
        
        // 3. Re-Apply Manifest (Force to bypass risk checks for simple toggles)
        const result = await orchestrator.apply(user.tenant_id, manifest, { force: true });
        res.json({ status: 'SUCCESS', result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

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

        res.json(rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};
