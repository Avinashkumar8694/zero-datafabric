import { Request, Response } from 'express';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';
import { queryWithContext } from '../config/database';

export const executeEngineQuery = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const queryConfig = req.body.config || req.body;
        const result = await QueryEngineService.executeQuery(user.tenant_id, queryConfig);
        res.json(result);
    } catch (err: any) {
        console.error(`[QueryController:executeEngineQuery] Error:`, err.message);
        if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
};

export const executeNativeSql = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { sql } = req.body;
        const result = await queryWithContext(sql, [], { tenantId: user.tenant_id, username: user.username });
        res.json({ results: result.rows, rowCount: result.rowCount });
    } catch (err: any) {
        console.error(`[QueryController:executeNativeSql] Error:`, err.message);
        if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
};

export const executeRawSql = async (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    try {
        const { sql, params = [], async: isAsync } = req.body;
        if (isAsync) {
            const jobId = QueryEngineService.executeAsyncRawSql(user.tenant_id, user.username || 'unknown', sql, params);
            return res.status(202).json({ queryId: jobId, status: 'ACCEPTED' });
        } else {
            const results = await QueryEngineService.executeRawSql(user.tenant_id, user.username || 'unknown', sql, params);
            return res.json({ results });
        }
    } catch (err: any) {
        console.error(`[QueryController:executeRawSql] Error:`, err.message);
        if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
};

export const getJobStatus = async (req: Request, res: Response) => {
    try {
        const job = QueryEngineService.getJobStatus(req.params.id as string);
        if (job.status === 'NOT_FOUND') return res.status(404).json(job);
        res.json(job);
    } catch (err: any) {
        console.error(`[QueryController:getJobStatus] Error:`, err.message);
        if (err.message.includes('SUSPENDED')) return res.status(403).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
};
