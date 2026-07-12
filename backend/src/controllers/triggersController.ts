/**
 * @module controllers/triggersController
 * @description Trigger control plane: define row-based (event + schema/table) or
 * scheduled triggers with a compiled action (see `action_compiler`), deploy them so
 * mutation paths fire them, and inspect their execution logs and the async job queue
 * (`trigger_jobs`) that actually runs the compiled actions.
 */

import { Request, Response } from 'express';
import { TriggerService } from '../modules/triggers/trigger.service';

/**
 * List all triggers defined for the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of trigger records from `TriggerService.listTriggers`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const listTriggers = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const rows = await TriggerService.listTriggers(user.tenant_id);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create a new trigger definition (event + schema/table match, plus a compiled
 * action) for the caller's tenant. The trigger is created but not necessarily
 * active until deployed — see (@link deployTrigger).
 *
 * @param req - Express request. Reads tenant/username from `(req as any).user`.
 *   Body is the trigger definition, e.g. `(triggerName, event, schemaName,
 *   tableName, execute: ( type, ... ))` — validated by `TriggerService.createTrigger`
 *   (requires `triggerName`+`definition`, `definition.execute.type`, and for
 *   row-based triggers `definition.event` plus `schemaName`/`tableName`).
 * @param res - Express response.
 * @returns 201 with the created trigger record from `TriggerService.createTrigger`.
 * @throws Responds 400 `(error)` for any validation/service error (e.g. missing
 *   required fields).
 */
export const createTrigger = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const created = await TriggerService.createTrigger(user.tenant_id, user.username, req.body);
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Update an existing trigger's definition.
 *
 * @param req - Express request. Reads tenant/username from `(req as any).user`.
 *   `req.params.id` is the trigger id to update (required). Body is the partial/full
 *   trigger definition to apply — see (@link createTrigger) for shape.
 * @param res - Express response.
 * @returns 200 with the updated trigger record from `TriggerService.updateTrigger`.
 * @throws Responds 400 `(error: 'id is required')` when `req.params.id` is missing;
 *   400 `(error)` for validation errors or when the trigger id does not exist
 *   (service throws `'Trigger not found'`).
 */
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

/**
 * Delete a trigger by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Reads tenant/username from `(req as any).user`.
 *   `req.params.id` is the trigger id to delete (required).
 * @param res - Express response.
 * @returns 200 `(status: 'SUCCESS')` when the trigger was deleted.
 * @throws Responds 400 `(error: 'id is required')` when `req.params.id` is missing;
 *   400 `(error)` when the trigger id does not exist (service throws `'Trigger not found'`).
 */
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

/**
 * Deploy (activate) a trigger so subsequent matching mutations fire its compiled action.
 *
 * @param req - Express request. Reads tenant/username from `(req as any).user`.
 *   `req.params.id` is the trigger id to deploy (required).
 * @param res - Express response.
 * @returns 200 with the deployment result from `TriggerService.deployTrigger`.
 * @throws Responds 400 `(error: 'id is required')` when `req.params.id` is missing;
 *   400 `(error)` when the trigger id does not exist or fails to deploy/compile.
 */
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

/**
 * List trigger execution log entries (fired triggers and their outcome),
 * paginated and optionally filtered to a single trigger.
 *
 * @param req - Express request. Reads tenant from `(req as any).user.tenant_id`.
 *   Query params: `triggerId` (string, optional filter), `limit` (number, defaults
 *   to 50), `offset` (number, defaults to 0).
 * @param res - Express response.
 * @returns 200 with the array of log entries from `TriggerService.listLogs`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
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

/**
 * List the async `trigger_jobs` queue entries (compiled trigger actions
 * enqueued for out-of-band execution, e.g. notifications) for the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of job records from `TriggerService.listJobs`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const listTriggerJobs = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const rows = await TriggerService.listJobs(user.tenant_id);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Re-enqueue a failed (or otherwise retryable) trigger job for execution.
 *
 * @param req - Express request. Reads tenant/username from `(req as any).user`.
 *   `req.params.id` is the job id to retry (required).
 * @param res - Express response.
 * @returns 200 with the retry result from `TriggerService.retryJob`.
 * @throws Responds 400 `(error: 'id is required')` when `req.params.id` is missing;
 *   400 `(error)` when the job id does not exist or is not retryable.
 */
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
