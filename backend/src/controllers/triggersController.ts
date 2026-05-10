import { Request, Response } from 'express';
import { TriggerService } from '../modules/triggers/trigger.service';

export const listTriggers = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const rows = await TriggerService.listTriggers(user.tenant_id);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const createTrigger = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const created = await TriggerService.createTrigger(user.tenant_id, user.username, req.body);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const updateTrigger = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const updated = await TriggerService.updateTrigger(user.tenant_id, user.username, id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const deleteTrigger = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    await TriggerService.deleteTrigger(user.tenant_id, user.username, id);
    res.json({ status: 'SUCCESS' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const deployTrigger = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const result = await TriggerService.deployTrigger(user.tenant_id, user.username, id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const listTriggerLogs = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const rows = await TriggerService.listLogs(user.tenant_id, req.query.triggerId as string | undefined, limit, offset);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const listTriggerJobs = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const rows = await TriggerService.listJobs(user.tenant_id);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const retryTriggerJob = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const result = await TriggerService.retryJob(user.tenant_id, user.username, id);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
