import axios from 'axios';
import { pool } from '../../config/database';

type MutationJob = {
  id: string;
  tenant_id: string;
  schema_name: string;
  table_name: string;
  action: string;
  payload: any;
  attempts: number;
  max_attempts: number;
};

export class ElasticsearchMutationWorker {
  private static started = false;

  static start(intervalMs = Number(process.env.ES_MUTATION_POLL_MS || 1500)) {
    if (this.started) return;
    this.started = true;
    setInterval(() => {
      this.tick().catch((err) => console.error('[ES-MutationWorker] tick failed:', err.message));
    }, intervalMs);
    console.log(`[ES-MutationWorker] started (${intervalMs}ms)`);
  }

  static async enqueueMutation(params: {
    tenantId: string;
    schemaName: string;
    tableName: string;
    action: 'INSERT' | 'UPDATE' | 'DELETE';
    rows: any[];
    filter?: Record<string, any>;
  }) {
    if (!params.rows?.length && params.action !== 'DELETE') return;
    await pool.query(
      `INSERT INTO public.es_mutation_jobs (tenant_id, schema_name, table_name, action, payload, status, run_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', NOW())`,
      [params.tenantId, params.schemaName, params.tableName, params.action, JSON.stringify({ rows: params.rows || [], filter: params.filter || null })]
    );
  }

  private static async tick() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<MutationJob>(
        `SELECT id, tenant_id, schema_name, table_name, action, payload, attempts, max_attempts
         FROM public.es_mutation_jobs
         WHERE status = 'PENDING' AND run_at <= NOW()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 20`
      );
      await client.query('COMMIT');
      client.release();
      for (const job of rows) await this.process(job);
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
  }

  private static async process(job: MutationJob) {
    const client = await pool.connect();
    try {
      await client.query(`UPDATE public.es_mutation_jobs SET status='RUNNING', updated_at=NOW() WHERE id=$1`, [job.id]);
      const connector = await this.getElasticConnector(job.tenant_id);
      if (!connector) {
        await this.defer(client, job, 'ELASTICSEARCH connector not configured');
        return;
      }
      const endpoint = (connector.config?.connectionString || `http://${connector.config?.host || 'localhost'}:${connector.config?.port || 9200}`).replace(/\/$/, '');
      const axiosConfig: any = { timeout: Number(connector.config?.timeoutMs || 8000) };
      if (connector.config?.user && connector.config?.pass) {
        axiosConfig.auth = { username: connector.config.user, password: connector.config.pass };
      }

      const index = `${job.tenant_id}_${job.schema_name.replace(/^tenant_[^_]+_/, '')}_${job.table_name}`.toLowerCase();
      const payloadRows = Array.isArray(job.payload?.rows) ? job.payload.rows : [];
      if (job.action === 'DELETE') {
        for (const row of payloadRows) {
          const id = row?.id || row?.item_id || null;
          if (!id) continue;
          await axios.delete(`${endpoint}/${index}/_doc/${encodeURIComponent(String(id))}?refresh=true`, axiosConfig).catch(() => null);
        }
      } else {
        const lines: string[] = [];
        for (const row of payloadRows) {
          const id = row?.id || row?.item_id || undefined;
          const action: any = { index: { _index: index } };
          if (id) action.index._id = String(id);
          lines.push(JSON.stringify(action));
          lines.push(JSON.stringify(row));
        }
        if (lines.length) {
          await axios.post(`${endpoint}/_bulk?refresh=true`, `${lines.join('\n')}\n`, {
            ...axiosConfig,
            headers: { ...(axiosConfig.headers || {}), 'Content-Type': 'application/x-ndjson' }
          });
        }
      }

      await client.query(`UPDATE public.es_mutation_jobs SET status='COMPLETED', updated_at=NOW() WHERE id=$1`, [job.id]);
    } catch (err: any) {
      await this.defer(client, job, err.message || 'mutation sync failed');
    } finally {
      client.release();
    }
  }

  private static async defer(client: any, job: MutationJob, error: string) {
    const attempts = job.attempts + 1;
    const terminal = attempts >= job.max_attempts;
    await client.query(
      `UPDATE public.es_mutation_jobs
       SET status = $2,
           attempts = $3,
           last_error = $4,
           run_at = CASE WHEN $2='PENDING' THEN NOW() + INTERVAL '20 seconds' ELSE run_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, terminal ? 'FAILED' : 'PENDING', attempts, error]
    );
  }

  private static async getElasticConnector(tenantId: string) {
    const { rows } = await pool.query(
      `SELECT config FROM public.data_sources
       WHERE tenant_id = $1 AND UPPER(type)='ELASTICSEARCH' AND status IN ('ACTIVE','CONNECTED')
       LIMIT 1`,
      [tenantId]
    );
    return rows[0] || null;
  }
}
