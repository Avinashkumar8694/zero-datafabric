import { queryWithContext } from '../../config/database';

export class TriggerService {
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
    await this.enqueueJob(tenantId, username, id, 'DELETE_TRIGGER', {
      schemaName: trg.schema_name,
      tableName: trg.table_name,
      triggerName: trg.trigger_name,
      event: trg.definition?.event
    });
    await this.writeLog(tenantId, id, trg.trigger_name, trg.schema_name, trg.table_name, trg.definition?.event, 'TRIGGER_DELETE_ENQUEUED', 'SUCCESS', { message: 'Delete job enqueued' }, username);
  }

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
