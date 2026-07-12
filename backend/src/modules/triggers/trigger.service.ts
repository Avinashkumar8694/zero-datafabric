import { queryWithContext } from '../../config/database';
import { TriggerActionCompiler } from './action_compiler';

/**
 * Trigger control-plane service: native manifest-trigger transpile + registry
 * lifecycle (create/deploy/delete, durable job enqueue, control-plane visibility).
 * @class
 * @hideconstructor
 */
export class TriggerService {
  /**
   * Native, in-fabric transpile of a manifest trigger definition into Postgres
   * DDL — no external trigger engine required at apply time. Supports all three
   * declarative forms (procedure / execute / action) via TriggerActionCompiler,
   * and — when a tenantId is supplied — also registers the trigger in
   * public.trigger_registry (source=MANIFEST) so it appears in the control plane
   * alongside API/UI triggers.
   */
  static transpileTriggerSql(trigger: any, schemaName: string, tableName: string, tenantId?: string): string[] {
    const name = TriggerActionCompiler.ident(trigger?.name);
    if (!name) return ['-- trigger skipped: no name'];

    const compiled = TriggerActionCompiler.toSql(trigger, { schemaName, tableName, triggerName: name });
    const statements = [...compiled.statements];
    if (tenantId) statements.push(this.registryUpsertSql(trigger, schemaName, tableName, tenantId));
    return statements;
  }

  /**
   * Upsert a manifest-created trigger into trigger_registry so the control plane
   * shows every trigger. Runs inside the manifest apply transaction, so
   * registration is atomic with the CREATE TRIGGER. Marked source=MANIFEST.
   */
  private static registryUpsertSql(trigger: any, schemaName: string, tableName: string, tenantId: string): string {
    const esc = (s: any) => String(s ?? '').replace(/'/g, "''");
    const name = TriggerActionCompiler.ident(trigger?.name);
    const timing = String(trigger?.timing || (trigger?.event ? String(trigger.event).split('_')[0] : 'AFTER')).toUpperCase();
    const events = Array.isArray(trigger?.events)
      ? trigger.events
      : [trigger?.event ? String(trigger.event).toUpperCase().split('_').slice(1).join('_') : 'INSERT'];
    const firstEvent = String(events[0] || 'INSERT').toUpperCase();
    // A normalized event label ('AFTER_INSERT') so the UI, which reads
    // definition.event, renders manifest triggers consistently.
    const definition = {
      source: 'MANIFEST',
      kind: trigger?.action ? 'ACTION' : (trigger?.execute?.type ? 'EXECUTE' : 'PROCEDURE'),
      event: `${timing}_${firstEvent}`,
      timing,
      events,
      procedure: trigger?.procedure || undefined,
      execute: trigger?.execute || undefined,
      action: trigger?.action || undefined,
      schedule: trigger?.schedule || undefined,
    };
    const defJson = esc(JSON.stringify(definition));
    return `INSERT INTO public.trigger_registry
        (tenant_id, schema_name, table_name, trigger_name, definition, status, created_by, last_deployed_at, updated_at)
      VALUES ('${esc(tenantId)}', '${esc(schemaName)}', '${esc(tableName)}', '${esc(name)}', '${defJson}'::jsonb, 'ACTIVE', 'manifest', NOW(), NOW())
      ON CONFLICT (tenant_id, schema_name, table_name, trigger_name)
      DO UPDATE SET definition = EXCLUDED.definition, status = 'ACTIVE', last_deployed_at = NOW(), updated_at = NOW()`;
  }

  /**
   * List every registered trigger for a tenant (both manifest- and
   * API/UI-created), most recently updated first.
   * @param tenantId - Tenant whose trigger registry is being read.
   * @returns Rows from `public.trigger_registry` with camelCased columns.
   */
  static async listTriggers(tenantId: string) {
    const { rows } = await queryWithContext(
      `SELECT id, schema_name as "schemaName", table_name as "tableName", trigger_name as "triggerName", definition, status, last_deployed_at as "lastDeployedAt", updated_at as "updatedAt"
       FROM public.trigger_registry
       ORDER BY updated_at DESC`,
      [],
      { tenantId, username: 'system' }
    );
    return rows;
  }

  /**
   * Register (or re-register) a control-plane trigger definition. Validates
   * the payload, upserts the registry row (keyed on tenant/schema/table/name)
   * with status forced back to ACTIVE, and writes an audit log entry. Does
   * NOT deploy the trigger to Postgres — call {@link TriggerService.deployTrigger}
   * to enqueue that.
   * @param tenantId - Owning tenant.
   * @param username - Actor performing the change (for audit logging).
   * @param payload - `{ triggerName, definition, schemaName?, tableName? }`; `schemaName`/`tableName` default to `'__SYSTEM__'` for generic (schedule-only) triggers.
   * @returns The persisted trigger_registry row.
   * @throws {Error} If the payload fails {@link TriggerService.validate}.
   */
  static async createTrigger(tenantId: string, username: string, payload: any) {
    this.validate(payload);
    const { triggerName, definition } = payload;
    const schemaName = payload.schemaName || '__SYSTEM__';
    const tableName = payload.tableName || '__SYSTEM__';
    const { rows } = await queryWithContext(
      `INSERT INTO public.trigger_registry (tenant_id, schema_name, table_name, trigger_name, definition, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (tenant_id, schema_name, table_name, trigger_name)
       DO UPDATE SET definition = EXCLUDED.definition, status = 'ACTIVE', updated_at = NOW()
       RETURNING id, schema_name as "schemaName", table_name as "tableName", trigger_name as "triggerName", definition, status`,
      [tenantId, schemaName, tableName, triggerName, JSON.stringify(definition), username],
      { tenantId, username }
    );
    await this.writeLog(tenantId, rows[0].id, triggerName, schemaName, tableName, definition?.event, 'TRIGGER_UPSERT', 'SUCCESS', { message: 'Trigger registry updated' }, username);
    return rows[0];
  }

  /**
   * Update an existing trigger registry row in place by id. Like
   * {@link TriggerService.createTrigger}, this only updates the registry
   * record and audit log — it does not redeploy the DDL; call
   * {@link TriggerService.deployTrigger} afterward to push the change live.
   * @param tenantId - Owning tenant (also used for the audit log context).
   * @param username - Actor performing the change (for audit logging).
   * @param id - The trigger_registry row id to update.
   * @param payload - `{ triggerName, definition, schemaName?, tableName? }`.
   * @returns The updated trigger_registry row.
   * @throws {Error} If the payload fails validation, or if `id` does not exist ('Trigger not found').
   */
  static async updateTrigger(tenantId: string, username: string, id: string, payload: any) {
    this.validate(payload);
    const { definition, triggerName } = payload;
    const schemaName = payload.schemaName || '__SYSTEM__';
    const tableName = payload.tableName || '__SYSTEM__';
    const { rows } = await queryWithContext(
      `UPDATE public.trigger_registry
       SET schema_name = $2, table_name = $3, trigger_name = $4, definition = $5::jsonb, updated_at = NOW()
       WHERE id = $1
       RETURNING id, schema_name as "schemaName", table_name as "tableName", trigger_name as "triggerName", definition, status`,
      [id, schemaName, tableName, triggerName, JSON.stringify(definition)],
      { tenantId, username }
    );
    if (!rows.length) throw new Error('Trigger not found');
    await this.writeLog(tenantId, id, triggerName, schemaName, tableName, definition?.event, 'TRIGGER_UPDATE', 'SUCCESS', { message: 'Trigger updated' }, username);
    return rows[0];
  }

  /**
   * Mark a trigger for deletion and enqueue the durable job that drops it.
   * Sets the registry row to `PENDING_DELETE`, cancels any outstanding
   * PENDING jobs owned by this trigger (recurring schedule/deploy jobs
   * matched by `trigger_id`, plus fired `EXECUTE_TRIGGER_ACTION` jobs matched
   * by `payload->>'triggerName'`, since those are enqueued with
   * `trigger_id = NULL`) so nothing fires after the trigger is gone, then
   * enqueues a `DELETE_TRIGGER` job (deliberately never cancelled by the step
   * above, since it is what performs the actual drop).
   * @param tenantId - Owning tenant.
   * @param username - Actor performing the change (for audit logging).
   * @param id - The trigger_registry row id to delete.
   * @returns Resolves once the delete job has been enqueued and logged.
   * @throws {Error} 'Trigger not found' if `id` does not exist.
   */
  static async deleteTrigger(tenantId: string, username: string, id: string) {
    const { rows } = await queryWithContext(
      `SELECT id, schema_name, table_name, trigger_name, definition FROM public.trigger_registry WHERE id = $1`,
      [id],
      { tenantId, username }
    );
    if (!rows.length) throw new Error('Trigger not found');
    const trg = rows[0];

    await queryWithContext(
      `UPDATE public.trigger_registry SET status = 'PENDING_DELETE', updated_at = NOW() WHERE id = $1`,
      [id],
      { tenantId, username }
    );

    // Cancel the trigger's outstanding work so nothing fires after it is gone:
    //  - recurring SCHEDULE_TRIGGER / DEPLOY jobs are linked by trigger_id;
    //  - fired action jobs (EXECUTE_TRIGGER_ACTION), including future RELATIVE
    //    ones, are enqueued by the DB trigger with trigger_id = NULL and are
    //    keyed by payload->>'triggerName'.
    // We never cancel a DELETE_TRIGGER job (that is what performs the drop).
    const cancelled = await queryWithContext(
      `UPDATE public.trigger_jobs
         SET status = 'CANCELLED', last_error = 'trigger deleted', updated_at = NOW()
       WHERE status = 'PENDING'
         AND job_type <> 'DELETE_TRIGGER'
         AND (trigger_id = $1 OR payload->>'triggerName' = $2)
       RETURNING id`,
      [id, trg.trigger_name],
      { tenantId, username }
    );

    await this.enqueueJob(tenantId, username, id, 'DELETE_TRIGGER', {
      schemaName: trg.schema_name,
      tableName: trg.table_name,
      triggerName: trg.trigger_name,
      event: trg.definition?.event
    });
    await this.writeLog(tenantId, id, trg.trigger_name, trg.schema_name, trg.table_name, trg.definition?.event, 'TRIGGER_JOBS_CANCELLED', 'SUCCESS', { cancelled: cancelled.rows.length }, username);
    await this.writeLog(tenantId, id, trg.trigger_name, trg.schema_name, trg.table_name, trg.definition?.event, 'TRIGGER_DELETE_ENQUEUED', 'SUCCESS', { message: 'Delete job enqueued' }, username);
  }

  /**
   * Enqueue the durable job that deploys (creates/replaces) a trigger's DDL
   * in Postgres. Marks the registry row `PENDING_DEPLOY`, then picks the job
   * type: a schedule-only definition with no bound schema/table becomes a
   * recurring `SCHEDULE_TRIGGER` job; anything bound to a table becomes a
   * one-shot `DEPLOY_TRIGGER` job that runs {@link TriggerActionCompiler} DDL.
   * @param tenantId - Owning tenant.
   * @param username - Actor performing the change (for audit logging).
   * @param id - The trigger_registry row id to deploy.
   * @returns `{ status: 'ENQUEUED', jobId }`.
   * @throws {Error} 'Trigger not found' if `id` does not exist.
   */
  static async deployTrigger(tenantId: string, username: string, id: string) {
    const { rows } = await queryWithContext(
      `SELECT id, schema_name, table_name, trigger_name, definition FROM public.trigger_registry WHERE id = $1`,
      [id],
      { tenantId, username }
    );
    if (!rows.length) throw new Error('Trigger not found');
    const trg = rows[0];

    await queryWithContext(
      `UPDATE public.trigger_registry SET status = 'PENDING_DEPLOY', updated_at = NOW() WHERE id = $1`,
      [id],
      { tenantId, username }
    );
    const isGenericScheduler = !!trg.definition?.schedule?.type && (!trg.schema_name || !trg.table_name || trg.schema_name === '__SYSTEM__' || trg.table_name === '__SYSTEM__');
    const jobType = isGenericScheduler ? 'SCHEDULE_TRIGGER' : 'DEPLOY_TRIGGER';
    const jobId = await this.enqueueJob(tenantId, username, id, jobType, {
      schemaName: trg.schema_name,
      tableName: trg.table_name,
      triggerName: trg.trigger_name,
      event: trg.definition?.event,
      schedule: trg.definition?.schedule || null,
      execute: trg.definition?.execute || null
    });
    await this.writeLog(tenantId, id, trg.trigger_name, trg.schema_name, trg.table_name, trg.definition?.event, 'TRIGGER_DEPLOY_ENQUEUED', 'SUCCESS', { jobId, jobType }, username);
    return { status: 'ENQUEUED', jobId };
  }

  /**
   * List the 200 most recent durable trigger jobs for a tenant (the queue the
   * worker drains), regardless of status.
   * @param tenantId - Tenant whose jobs are being listed.
   * @returns Up to 200 rows from `public.trigger_jobs`, newest first.
   */
  static async listJobs(tenantId: string) {
    const { rows } = await queryWithContext(
      `SELECT id, trigger_id as "triggerId", job_type as "jobType", status, attempts, max_attempts as "maxAttempts", run_at as "runAt", last_error as "lastError", created_at as "createdAt"
       FROM public.trigger_jobs
       ORDER BY created_at DESC
       LIMIT 200`,
      [],
      { tenantId, username: 'system' }
    );
    return rows;
  }

  /**
   * Requeue a failed/cancelled job for immediate re-attempt: resets it to
   * `PENDING`, clears `last_error`, and sets `run_at` to now.
   * @param tenantId - Owning tenant (audit log context).
   * @param username - Actor performing the retry (for audit logging).
   * @param jobId - The trigger_jobs row id to retry.
   * @returns `{ status: 'ENQUEUED', jobId }`.
   */
  static async retryJob(tenantId: string, username: string, jobId: string) {
    await queryWithContext(
      `UPDATE public.trigger_jobs
       SET status = 'PENDING', run_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [jobId],
      { tenantId, username }
    );
    return { status: 'ENQUEUED', jobId };
  }

  /**
   * Page through trigger execution audit logs, optionally scoped to one
   * trigger, newest first.
   * @param tenantId - Tenant whose logs are being read.
   * @param triggerId - When given, restricts to logs for this trigger id only.
   * @param limit - Max rows to return (default 50).
   * @param offset - Row offset for pagination (default 0).
   * @returns Rows from `public.trigger_execution_logs`.
   */
  static async listLogs(tenantId: string, triggerId?: string, limit = 50, offset = 0) {
    const params: any[] = [];
    let where = '';
    if (triggerId) {
      where = 'WHERE trigger_id = $1';
      params.push(triggerId);
    }
    params.push(limit);
    params.push(offset);
    const { rows } = await queryWithContext(
      `SELECT id, trigger_id as "triggerId", trigger_name as "triggerName", schema_name as "schemaName", table_name as "tableName", event_type as "eventType", action, status, detail, created_at as "createdAt"
       FROM public.trigger_execution_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
      { tenantId, username: 'system' }
    );
    return rows;
  }

  /**
   * Validate a create/update trigger payload before it is persisted.
   * @param payload - The candidate trigger payload (`triggerName`, `definition`, `schemaName`, `tableName`).
   * @returns Nothing on success.
   * @throws {Error} If `triggerName`/`definition` are missing, `definition.execute.type`
   *   is absent, or (for non-scheduler triggers) `definition.event`/`schemaName`/`tableName` are missing.
   */
  private static validate(payload: any) {
    if (!payload?.triggerName || !payload?.definition) {
      throw new Error('triggerName and definition are required');
    }
    if (!payload.definition?.execute?.type) {
      throw new Error('definition.execute.type is required');
    }
    const hasScheduler = !!payload.definition?.schedule?.type;
    if (!hasScheduler && !payload.definition?.event) {
      throw new Error('definition.event is required for row-based triggers');
    }
    if (!hasScheduler && (!payload?.schemaName || !payload?.tableName)) {
      throw new Error('schemaName and tableName are required for row-based triggers');
    }
  }

  /**
   * Append a row to `public.trigger_execution_logs` recording an action taken
   * against a trigger (upsert, update, deploy-enqueued, delete-enqueued, etc.).
   * @param tenantId - Owning tenant.
   * @param triggerId - The trigger_registry row id the log entry is about.
   * @param triggerName - The trigger's name (denormalized for easy reading).
   * @param schemaName - The trigger's schema (denormalized).
   * @param tableName - The trigger's table (denormalized).
   * @param eventType - The definition's event label (e.g. `AFTER_INSERT`), if any.
   * @param action - The action being logged (e.g. `TRIGGER_UPSERT`, `TRIGGER_DEPLOY_ENQUEUED`).
   * @param status - `SUCCESS` or a failure status.
   * @param detail - Arbitrary JSON detail payload for the log entry.
   * @param username - Actor that performed the action.
   * @returns Resolves once the log row is written.
   */
  private static async writeLog(
    tenantId: string,
    triggerId: string,
    triggerName: string,
    schemaName: string,
    tableName: string,
    eventType: string,
    action: string,
    status: string,
    detail: any,
    username: string
  ) {
    await queryWithContext(
      `INSERT INTO public.trigger_execution_logs
      (tenant_id, trigger_id, trigger_name, schema_name, table_name, event_type, action, status, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [tenantId, triggerId, triggerName, schemaName, tableName, eventType || null, action, status, JSON.stringify(detail || {})],
      { tenantId, username }
    );
  }

  /**
   * Insert a durable `public.trigger_jobs` row for the worker to pick up.
   * Computes `run_at`: immediate (`NOW()`) for all job types except a
   * `FIXED`-schedule payload, which is delayed by `schedule.every`/`schedule.unit`.
   * @param tenantId - Owning tenant.
   * @param username - Actor that triggered the enqueue (`created_by`).
   * @param triggerId - The owning trigger_registry row id.
   * @param jobType - One of `DEPLOY_TRIGGER` / `SCHEDULE_TRIGGER` / `DELETE_TRIGGER` / `EXECUTE_TRIGGER_ACTION`.
   * @param payload - Job-type-specific JSON payload stored on the row.
   * @returns The new job's id.
   */
  private static async enqueueJob(
    tenantId: string,
    username: string,
    triggerId: string,
    jobType: string,
    payload: any
  ) {
    const runAtExpr = payload?.schedule?.type === 'FIXED'
      ? `NOW() + INTERVAL '${Math.max(1, Number(payload.schedule.every || 1))} ${String(payload.schedule.unit || 'MINUTE').toLowerCase()}'`
      : 'NOW()';
    const { rows } = await queryWithContext(
      `INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING', ${runAtExpr}, 5, $5)
       RETURNING id`,
      [tenantId, triggerId, jobType, JSON.stringify(payload || {}), username],
      { tenantId, username }
    );
    return rows[0].id;
  }
}
