import { pool } from '../../config/database';

/** Current usage counters of a workspace, keyed like the limit keys they are compared with. A counter that cannot be read is null. */
export async function workspaceUsage(tenantId: string): Promise<Record<string, number | null>> {
  const q = async (sql: string): Promise<number | null> => {
    try { return parseInt((await pool.query(sql, [tenantId])).rows[0]?.n ?? '0', 10); } catch { return null; }
  };
  const [connections, tables, triggers, savedAnalytics, users, tokens, replications] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM public.data_sources WHERE tenant_id = $1'),
    q(`SELECT COUNT(*) AS n FROM public.catalog_tables t JOIN public.catalog_schemas s ON s.id = t.schema_id JOIN public.data_sources d ON d.id = s.source_id WHERE d.tenant_id = $1`),
    q('SELECT COUNT(*) AS n FROM public.trigger_registry WHERE tenant_id = $1'),
    q('SELECT COUNT(*) AS n FROM fabric_system.saved_analytics WHERE tenant_id = $1'),
    q('SELECT COUNT(*) AS n FROM public.users WHERE tenant_id = $1'),
    q('SELECT COUNT(*) AS n FROM public.api_tokens WHERE tenant_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())'),
    q('SELECT COUNT(*) AS n FROM fabric_system.replication_jobs WHERE tenant_id = $1'),
  ]);
  return { max_connections: connections, max_tables: tables, max_triggers: triggers, max_saved_analytics: savedAnalytics, max_users_per_workspace: users, active_api_tokens: tokens, max_replications: replications };
}
