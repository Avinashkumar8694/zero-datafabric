import { Request, Response } from 'express';
import { MetadataService } from '../modules/metadata/metadata.service';
import { pool, queryWithContext } from '../config/database';

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
        const { rows } = await queryWithContext('SELECT id as "tableId", name, physical_name as "physicalName", row_count as "rowCount" FROM public.catalog_tables WHERE schema_id = $1', [schemaId], { tenantId: user.tenant_id, username: user.username });
        res.json(rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const getTemplate = (req: Request, res: Response) => {
    res.json(MetadataService.getTemplate());
};

export const diffMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let manifest = req.body;
        if (req.file) {
            manifest = JSON.parse(req.file.buffer.toString());
        }
        const plan = await MetadataService.diffMetadata(user.tenant_id, manifest);
        res.json(plan);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const applyMetadata = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        let manifest = req.body;
        if (req.file) {
            manifest = JSON.parse(req.file.buffer.toString());
        }
        const planObj = await MetadataService.diffMetadata(user.tenant_id, manifest);
        const migrationResponse = await MetadataService.migrateMetadata(user.tenant_id, planObj.diffs);
        res.json({ success: true, plan: planObj.diffs, results: migrationResponse });
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
