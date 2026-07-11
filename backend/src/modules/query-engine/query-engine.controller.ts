import { Request, Response } from 'express';
import { QueryEngineService, QueryConfig } from './query-engine.service';
const { randomUUID } = require('crypto');

export class QueryEngineController {
  
  static async refreshView(req: Request, res: Response) {
    try {
      const { viewName, schema = 'default', concurrent = true } = req.body;
      const tenantId = (req as any).user?.tenant_id || req.body.tenantId;

      if (!tenantId || !viewName) {
        return res.status(400).json({ error: 'tenantId and viewName are required' });
      }

      QueryEngineService.refreshMaterializedView(tenantId, viewName, concurrent, schema).catch(err => {
        console.error(`Background refresh failed for ${viewName} in ${schema}:`, err);
      });

      const jobId = randomUUID();

      return res.status(202).json({
        status: "accepted",
        message: "View refresh initiated in background",
        jobId: jobId
      });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  static async executeQuery(req: Request, res: Response) {
    const { queryConfig } = req.body;
    const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
    try {
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const result = await QueryEngineService.executeQuery(tenantId, queryConfig as QueryConfig);
      // The service returns an enveloped object ({ data, rowCount, plan?, warnings? }) for
      // SELECT-family queries; pass it through so plan/warnings reach the client. Wrap only
      // bare arrays (defensive — legacy callers) to preserve the { data } contract.
      const payload = Array.isArray(result) ? { data: result } : result;
      return res.status(200).json(payload);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed for tenant ${tenantId}: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  static async executeAsyncQuery(req: Request, res: Response) {
    const { queryConfig } = req.body;
    const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
    try {
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const jobId = QueryEngineService.executeAsyncQuery(tenantId, queryConfig as QueryConfig);
      return res.status(202).json({ jobId, status: 'PENDING' });
    } catch (err: any) {
      console.error(`[Query-Async] Execution failed for tenant ${tenantId}: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  static async getJobStatus(req: Request, res: Response) {
    try {
      const jobId = req.params.jobId as string;
      const job = QueryEngineService.getJobStatus(jobId);
      
      if (job.status === 'NOT_FOUND') {
        return res.status(404).json(job);
      }
      
      return res.status(200).json(job);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('suspended')) return res.status(403).json({ error: err.message });
      console.error(`[Query] Execution failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}
