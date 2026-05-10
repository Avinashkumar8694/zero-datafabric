import { pool } from '../../db';
import { TriggerTranspiler } from './trigger.transpiler';
import { CronExpressionParser } from 'cron-parser';
import axios from 'axios';
import nodemailer from 'nodemailer';

type JobRow = {
  id: string;
  tenant_id: string;
  trigger_id: string | null;
  job_type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
};

export class TriggerWorker {
  private static running = false;

  static start(intervalMs = 1500) {
    if (this.running) return;
    this.running = true;
    setInterval(() => {
      this.tick().catch((err) => {
        console.error('[TriggerWorker] tick failed', err.message);
      });
    }, intervalMs);
    console.log(`[TriggerWorker] started (${intervalMs}ms polling)`);
  }

  static async runOnce() {
    await this.tick();
  }

  private static async tick() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<JobRow>(
        `SELECT id, tenant_id, trigger_id, job_type, payload, attempts, max_attempts
         FROM public.trigger_jobs
         WHERE status = 'PENDING' AND run_at <= NOW()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 5`
      );
      await client.query('COMMIT');
      client.release();

      for (const job of rows) {
        await this.processJob(job);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
  }

  private static async processJob(job: JobRow) {
    const client = await pool.connect();
    try {
      await client.query(`UPDATE public.trigger_jobs SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [job.id]);
      const payload = job.payload || {};

      if (job.job_type === 'DEPLOY_TRIGGER') {
        const { rows } = await client.query(
          `SELECT schema_name, table_name, trigger_name, definition
           FROM public.trigger_registry
           WHERE id = $1`,
          [job.trigger_id]
        );
        if (!rows.length) throw new Error('Trigger registry entry not found');
        const trg = rows[0];
        const sqlStatements = TriggerTranspiler.toSql(
          { name: trg.trigger_name, ...trg.definition },
          trg.schema_name,
          trg.table_name
        );
        for (const stmt of sqlStatements) {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [job.tenant_id]);
          await client.query(`SELECT set_config('app.user_name', $1, true)`, ['trigger-engine']);
          await client.query(stmt);
          await client.query('COMMIT');
        }
        await client.query(
          `UPDATE public.trigger_registry SET status = 'ACTIVE', last_deployed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [job.trigger_id]
        );
        await this.log(client, job, 'TRIGGER_DEPLOY', 'SUCCESS', { statements: sqlStatements.length });
      } else if (job.job_type === 'DELETE_TRIGGER' || job.job_type === 'CLEANUP_TRIGGER') {
        const schemaName = payload.schemaName;
        const tableName = payload.tableName;
        const triggerName = payload.triggerName;
        await client.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${schemaName}"."${tableName}"`);
        if (job.trigger_id) {
          await client.query(`DELETE FROM public.trigger_registry WHERE id = $1`, [job.trigger_id]);
        }
        await this.log(client, job, 'TRIGGER_DELETE', 'SUCCESS', { schemaName, tableName, triggerName });
      } else if (job.job_type === 'EXECUTE_TRIGGER_ACTION') {
        const actionType = payload.actionType || payload?.execute?.type;
        let detail: any = { actionType, mode: 'live' };
        const channelConfig = await this.loadChannelConfig(client, job.tenant_id, actionType);
        if (channelConfig) {
          detail.channelName = channelConfig.name;
          detail.channelStatus = channelConfig.status;
        }
        if (actionType === 'WEBHOOK') {
          detail.target = payload?.execute?.url || channelConfig?.config?.url || null;
          const mergedHeaders = {
            ...(channelConfig?.config?.headers || {}),
            ...(payload?.execute?.headers || {})
          };
          const authResolved = await this.resolveAuth(payload?.execute?.auth || channelConfig?.config?.auth || { type: 'NONE' });
          if (authResolved.authorization) mergedHeaders.Authorization = authResolved.authorization;
          detail.method = payload?.execute?.method || channelConfig?.config?.method || 'POST';
          detail.headers = mergedHeaders;
          detail.auth = authResolved.meta;
          detail.body = this.renderObject(payload?.execute?.payload || payload?.newRow || {}, payload);
          const response = await axios.request({
            method: String(detail.method || 'POST'),
            url: String(detail.target),
            headers: detail.headers,
            data: detail.body,
            timeout: Number(channelConfig?.config?.timeoutMs || 10000)
          });
          detail.httpStatus = response.status;
        } else if (actionType === 'AUDIT') {
          detail.note = 'Audit action accepted';
          await client.query(
            `INSERT INTO fabric_admin.audit_logs (tenant_id, user_name, action, table_name, row_id, new_data)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              job.tenant_id,
              'trigger-engine',
              `TRIGGER_${payload?.event || 'EVENT'}`,
              payload?.tableName || 'N/A',
              String(payload?.newRow?.id || payload?.oldRow?.id || ''),
              JSON.stringify({
                triggerName: payload?.triggerName,
                event: payload?.event,
                newRow: payload?.newRow || null,
                oldRow: payload?.oldRow || null
              })
            ]
          );
        } else if (actionType === 'EMAIL') {
          detail.to = payload?.execute?.params?.to || channelConfig?.config?.defaultTo || null;
          detail.from = channelConfig?.config?.fromEmail || null;
          detail.subject = this.renderTemplate(
            payload?.execute?.params?.subject || channelConfig?.config?.subjectTemplate || 'Data Fabric Trigger: {{triggerName}}',
            payload
          );
          detail.text = this.renderTemplate(
            payload?.execute?.params?.text || channelConfig?.config?.textTemplate || 'Trigger {{triggerName}} fired for {{tableName}}',
            payload
          );
          detail.html = this.renderTemplate(
            payload?.execute?.params?.html || channelConfig?.config?.htmlTemplate || '<p>Trigger <b>{{triggerName}}</b> fired for <b>{{tableName}}</b></p>',
            payload
          );
          if (!channelConfig) throw new Error('No tenant EMAIL channel configured');
          const smtpHost = channelConfig.config?.smtpHost;
          const smtpPort = Number(channelConfig.config?.smtpPort || 587);
          const smtpSecure = Boolean(channelConfig.config?.smtpSecure || smtpPort === 465);
          const smtpUser = channelConfig.config?.smtpUser;
          const smtpPass = channelConfig.config?.smtpPass;
          if (!smtpHost || !smtpUser || !smtpPass) throw new Error('EMAIL channel missing smtpHost/smtpUser/smtpPass');
          const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            auth: { user: smtpUser, pass: smtpPass }
          });
          const info = await transporter.sendMail({
            from: detail.from || smtpUser,
            to: detail.to,
            subject: detail.subject,
            text: detail.text,
            html: detail.html
          });
          detail.messageId = info.messageId;
        } else if (actionType === 'TELEGRAM') {
          detail.chatId = payload?.execute?.params?.chatId || channelConfig?.config?.chatId || null;
          detail.text = this.renderTemplate(
            payload?.execute?.params?.text || channelConfig?.config?.textTemplate || 'Trigger {{triggerName}} fired for {{tableName}}',
            payload
          );
          if (!channelConfig) throw new Error('No tenant TELEGRAM channel configured');
          if (String(channelConfig.config?.deliveryMode || '').toUpperCase() === 'WEBHOOK') {
            const target = channelConfig.config?.url || payload?.execute?.url;
            if (!target) throw new Error('TELEGRAM webhook mode missing url');
            const mergedHeaders = {
              ...(channelConfig?.config?.headers || {}),
              ...(payload?.execute?.headers || {})
            };
            const authResolved = await this.resolveAuth(payload?.execute?.auth || channelConfig?.config?.auth || { type: 'NONE' });
            if (authResolved.authorization) mergedHeaders.Authorization = authResolved.authorization;
            const body = this.renderObject(
              payload?.execute?.payload || {
                chatId: detail.chatId,
                text: detail.text,
                triggerName: payload?.triggerName,
                event: payload?.event
              },
              payload
            );
            const whRes = await axios.request({
              method: String(payload?.execute?.method || channelConfig?.config?.method || 'POST'),
              url: String(target),
              headers: mergedHeaders,
              data: body,
              timeout: Number(channelConfig?.config?.timeoutMs || 10000)
            });
            detail.mode = 'telegram-webhook';
            detail.httpStatus = whRes.status;
            detail.target = target;
          } else {
          const botToken = channelConfig.config?.botToken;
          if (!botToken || !detail.chatId) throw new Error('TELEGRAM channel missing botToken/chatId');
          const endpoint = channelConfig.config?.apiBase || `https://api.telegram.org/bot${botToken}/sendMessage`;
          const tgRes = await axios.post(endpoint, {
            chat_id: detail.chatId,
            text: detail.text,
            parse_mode: channelConfig.config?.parseMode || 'HTML'
          }, { timeout: Number(channelConfig.config?.timeoutMs || 10000) });
          detail.telegramOk = tgRes.data?.ok === true;
          detail.telegramMessageId = tgRes.data?.result?.message_id || null;
          }
        }
        await this.log(client, job, 'TRIGGER_ACTION', 'SUCCESS', detail);
      } else if (job.job_type === 'SCHEDULE_TRIGGER') {
        const actionPayload = {
          triggerName: payload?.triggerName,
          event: payload?.event || 'SCHEDULED',
          actionType: payload?.execute?.type,
          tableName: payload?.tableName || '__SYSTEM__',
          schemaName: payload?.schemaName || '__SYSTEM__',
          execute: payload?.execute || {},
          newRow: {
            scheduledAt: new Date().toISOString()
          }
        };
        await this.processScheduledAction(client, job, actionPayload);
      } else {
        await this.log(client, job, 'TRIGGER_JOB', 'FAILED', { message: `Unsupported job type ${job.job_type}` });
        throw new Error(`Unsupported job type ${job.job_type}`);
      }

      if (job.job_type !== 'SCHEDULE_TRIGGER') {
        await client.query(`UPDATE public.trigger_jobs SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`, [job.id]);
      }
    } catch (err: any) {
      const attempts = job.attempts + 1;
      const terminal = attempts >= job.max_attempts;
      await client.query(
        `UPDATE public.trigger_jobs
         SET status = $2, attempts = $3, last_error = $4, run_at = CASE WHEN $2 = 'PENDING' THEN NOW() + INTERVAL '30 seconds' ELSE run_at END, updated_at = NOW()
         WHERE id = $1`,
        [job.id, terminal ? 'FAILED' : 'PENDING', attempts, err.message]
      );
      await this.log(client, job, 'TRIGGER_JOB', 'FAILED', { message: err.message, attempts });
    } finally {
      client.release();
    }
  }

  private static async processScheduledAction(client: any, job: JobRow, actionPayload: any) {
    const subJob: JobRow = {
      ...job,
      payload: actionPayload
    };
    await this.log(client, subJob, 'TRIGGER_SCHEDULE_TICK', 'SUCCESS', { schedule: job.payload?.schedule || null });
    // Reuse execution path for action rendering/logging
    const fake = {
      id: job.id,
      tenant_id: job.tenant_id,
      trigger_id: job.trigger_id,
      job_type: 'EXECUTE_TRIGGER_ACTION',
      payload: actionPayload,
      attempts: job.attempts,
      max_attempts: job.max_attempts
    } as JobRow;
    // Inline minimal execution for scheduled action
    const actionType = actionPayload.actionType || actionPayload?.execute?.type;
    let detail: any = { actionType, mode: 'simulated', schedule: job.payload?.schedule || null };
    const channelConfig = await this.loadChannelConfig(client, job.tenant_id, actionType);
    if (channelConfig) {
      detail.channelName = channelConfig.name;
      detail.channelStatus = channelConfig.status;
    }
    if (actionType === 'EMAIL') {
      detail.to = actionPayload?.execute?.params?.to || channelConfig?.config?.defaultTo || null;
      detail.from = channelConfig?.config?.fromEmail || null;
      detail.subject = this.renderTemplate(
        actionPayload?.execute?.params?.subject || channelConfig?.config?.subjectTemplate || 'Scheduled Trigger: {{triggerName}}',
        actionPayload
      );
      detail.text = this.renderTemplate(
        actionPayload?.execute?.params?.text || channelConfig?.config?.textTemplate || 'Tick at {{newRow.scheduledAt}}',
        actionPayload
      );
    } else if (actionType === 'TELEGRAM') {
      detail.chatId = actionPayload?.execute?.params?.chatId || channelConfig?.config?.chatId || null;
      detail.text = this.renderTemplate(
        actionPayload?.execute?.params?.text || channelConfig?.config?.textTemplate || 'Tick at {{newRow.scheduledAt}}',
        actionPayload
      );
    }
    await this.log(client, fake, 'TRIGGER_ACTION', 'SUCCESS', detail);

    const schedule = job.payload?.schedule || {};
    let nextRun = new Date(Date.now() + 60_000);
    if (String(schedule.type || '').toUpperCase() === 'CRON' && schedule.cron) {
      try {
        const it = CronExpressionParser.parse(String(schedule.cron), { currentDate: new Date() });
        nextRun = it.next().toDate();
      } catch {
        nextRun = new Date(Date.now() + 60_000);
      }
    } else {
      const every = Math.max(1, Number(schedule.every || 1));
      const unit = String(schedule.unit || 'MINUTE').toUpperCase();
      const factor: Record<string, number> = { SECOND: 1000, MINUTE: 60000, HOUR: 3600000, DAY: 86400000 };
      nextRun = new Date(Date.now() + every * (factor[unit] || factor.MINUTE));
    }
    await client.query(
      `UPDATE public.trigger_jobs
       SET status = 'PENDING',
           run_at = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, nextRun.toISOString()]
    );
  }

  private static async log(client: any, job: JobRow, action: string, status: string, detail: any) {
    await client.query(
      `INSERT INTO public.trigger_execution_logs
      (tenant_id, trigger_id, trigger_name, schema_name, table_name, event_type, action, status, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        job.tenant_id,
        job.trigger_id,
        job.payload?.triggerName || 'N/A',
        job.payload?.schemaName || null,
        job.payload?.tableName || null,
        job.payload?.event || null,
        action,
        status,
        JSON.stringify(detail || {})
      ]
    );
  }

  private static async loadChannelConfig(client: any, tenantId: string, actionType: string) {
    if (!['EMAIL', 'TELEGRAM', 'WEBHOOK'].includes(String(actionType || '').toUpperCase())) return null;
    const { rows } = await client.query(
      `SELECT name, config, status
       FROM public.notification_channels
       WHERE tenant_id = $1 AND channel_type = $2 AND status = 'ACTIVE'
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`,
      [tenantId, String(actionType).toUpperCase()]
    );
    return rows[0] || null;
  }

  private static renderTemplate(template: string, ctx: any) {
    const safe = String(template || '');
    // Conditional inline syntax:
    // {{?newRow.amount>100|HIGH|LOW}}
    // {{?newRow.status!=oldRow.status|STATUS_CHANGED|UNCHANGED}}
    const withConditionals = safe.replace(/\{\{\s*\?([^|]+)\|([^|]*)\|([^}]*)\}\}/g, (_m, expr, whenTrue, whenFalse) => {
      const ok = this.evaluateCondition(String(expr || '').trim(), ctx);
      return ok ? String(whenTrue || '') : String(whenFalse || '');
    });
    return withConditionals.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path) => {
      const value = this.getPath(ctx, String(path));
      return value === undefined || value === null ? '' : String(value);
    });
  }

  private static renderObject(obj: any, ctx: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.renderTemplate(obj, ctx);
    if (Array.isArray(obj)) return obj.map((x) => this.renderObject(x, ctx));
    if (typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) out[k] = this.renderObject(v, ctx);
      return out;
    }
    return obj;
  }

  private static getPath(obj: any, path: string) {
    return path.split('.').reduce((acc: any, part: string) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
  }

  private static async resolveAuth(auth: any) {
    const kind = String(auth?.type || 'NONE').toUpperCase();
    if (kind === 'BASIC' && auth?.username && auth?.password) {
      const token = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { authorization: `Basic ${token}`, meta: { type: 'BASIC' } };
    }
    if (kind === 'BEARER' && auth?.token) {
      return { authorization: `Bearer ${auth.token}`, meta: { type: 'BEARER' } };
    }
    if (kind === 'OIDC') {
      if (!auth?.tokenEndpoint || !auth?.clientId || !auth?.clientSecret) {
        throw new Error('OIDC auth requires tokenEndpoint/clientId/clientSecret');
      }
      const body = new URLSearchParams();
      body.set('grant_type', 'client_credentials');
      body.set('client_id', auth.clientId);
      body.set('client_secret', auth.clientSecret);
      if (auth.scope) body.set('scope', auth.scope);
      if (auth.audience) body.set('audience', auth.audience);
      const tokenRes = await axios.post(String(auth.tokenEndpoint), body.toString(), {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: Number(auth.timeoutMs || 10000)
      });
      const token = tokenRes.data?.access_token;
      if (!token) throw new Error('OIDC token response missing access_token');
      return {
        authorization: `Bearer ${token}`,
        meta: {
          type: 'OIDC',
          tokenEndpoint: auth?.tokenEndpoint || null,
          audience: auth?.audience || null,
          scope: auth?.scope || null,
          resolved: 'live'
        }
      };
    }
    return { authorization: null, meta: { type: 'NONE' } };
  }

  private static evaluateCondition(expr: string, ctx: any) {
    const m = expr.match(/^([a-zA-Z0-9_.]+)\s*(==|!=|>=|<=|>|<)\s*([a-zA-Z0-9_.\"'-]+)$/);
    if (!m) return false;
    const leftPath = m[1];
    const op = m[2];
    const rawRight = m[3];
    const leftVal = this.getPath(ctx, leftPath);
    const rightVal = this.resolveLiteralOrPath(rawRight, ctx);

    const lNum = Number(leftVal);
    const rNum = Number(rightVal);
    const useNumeric = !Number.isNaN(lNum) && !Number.isNaN(rNum);
    const l = useNumeric ? lNum : String(leftVal ?? '');
    const r = useNumeric ? rNum : String(rightVal ?? '');

    switch (op) {
      case '==': return l === r;
      case '!=': return l !== r;
      case '>': return (l as any) > (r as any);
      case '<': return (l as any) < (r as any);
      case '>=': return (l as any) >= (r as any);
      case '<=': return (l as any) <= (r as any);
      default: return false;
    }
  }

  private static resolveLiteralOrPath(raw: string, ctx: any) {
    const v = String(raw || '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    const pathVal = this.getPath(ctx, v);
    return pathVal === undefined ? v : pathVal;
  }
}
