import { Request, Response } from 'express';
import { MetadataService } from '../modules/metadata/metadata.service';
import { MetadataOrchestrator } from '../modules/metadata/orchestrator';
import { ManifestParser } from '../modules/metadata/manifest_parser';
import { pool, queryWithContext } from '../config/database';

const orchestrator = new MetadataOrchestrator();

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
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const getSources = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { rows } = await queryWithContext('SELECT id, name, type, status FROM public.data_sources', [], { tenantId: user.tenant_id, username: user.username });
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
        const { rows } = await queryWithContext('SELECT id as "schemaId", name, physical_name as "physicalName" FROM public.catalog_schemas WHERE source_id = $1', [sourceId], { tenantId: user.tenant_id, username: user.username });
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
        const { rows } = await queryWithContext('SELECT id as "tableId", name, physical_name as "physicalName", row_count as "rowCount", resource_type as "resourceType" FROM public.catalog_tables WHERE schema_id = $1', [schemaId], { tenantId: user.tenant_id, username: user.username });
        res.json(rows);
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
      'SELECT id, action, table_name as "tableName", created_at as "createdAt", new_data as "details" FROM public.audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10',
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
