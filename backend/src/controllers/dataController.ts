import { Request, Response } from 'express';
import { QueryEngineService } from '../modules/query-engine/query-engine.service';

/**
 * Simple CRUD façade over the query engine. Each endpoint accepts an ergonomic
 * JSON body ({ source?, schema?, resource, where?, data?, columns?, ... }) and
 * returns the standard fabric envelope including the per-leg execution plan.
 */

const handle = (fn: (tenantId: string, body: any) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const result = await fn(user.tenant_id, req.body || {});
      res.json(result);
    } catch (err: any) {
      const msg = err.message || 'error';
      if (msg.toLowerCase().includes('suspended')) return res.status(403).json({ error: msg });
      // Client input errors → 400 (validation / safety), not 500.
      if (msg.startsWith('SAFETY') || /\brequire[sd]?\b|is required|invalid|not found|does not support/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      console.error('[DataController] error:', msg);
      res.status(500).json({ error: msg });
    }
  };

export const fetchData  = handle((t, b) => QueryEngineService.fetch(t, b));
export const createData = handle((t, b) => QueryEngineService.mutate(t, 'create', b));
export const updateData = handle((t, b) => QueryEngineService.mutate(t, 'update', b));
export const deleteData = handle((t, b) => QueryEngineService.mutate(t, 'delete', b));
