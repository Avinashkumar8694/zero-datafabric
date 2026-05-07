import { Request, Response } from 'express';
import { QueryEngineService, QueryConfig } from './query-engine.service';
const { randomUUID } = require('crypto');

export class QueryEngineController {
  
  static async refreshView(req: Request, res: Response) {
    try {
      const { viewName, concurrent = true } = req.body;
      const tenantId = (req as any).user?.tenant_id || req.body.tenantId;

      if (!tenantId || !viewName) {
        return res.status(400).json({ error: 'tenantId and viewName are required' });
      }

      QueryEngineService.refreshMaterializedView(tenantId, viewName, concurrent).catch(err => {
        console.error(`Background refresh failed for ${viewName}:`, err);
      });

      const jobId = randomUUID();

      return res.status(202).json({
        status: "accepted",
        message: "View refresh initiated in background",
        jobId: jobId
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  static async executeQuery(req: Request, res: Response) {
    try {
      const { queryConfig } = req.body;
      // Industrial Hardening: Prioritize identity from session context (Identity Proxy)
      const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
      
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const data = await QueryEngineService.executeQuery(tenantId, queryConfig as QueryConfig);
      
      return res.status(200).json({ data });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  static async executeAsyncQuery(req: Request, res: Response) {
    try {
      const { queryConfig } = req.body;
      const tenantId = (req as any).user?.tenant_id || req.body.tenantId;
      
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const jobId = QueryEngineService.executeAsyncQuery(tenantId, queryConfig as QueryConfig);
      
      return res.status(202).json({ jobId, status: 'PENDING' });
    } catch (err: any) {
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
      return res.status(500).json({ error: err.message });
    }
  }
}
