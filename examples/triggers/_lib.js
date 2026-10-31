/* eslint-disable no-console */
/**
 * Shared helpers for the trigger example suite.
 *
 * The Data Fabric exposes THREE ways to create a trigger; every script in this
 * folder exercises one or more of them end-to-end:
 *
 *   1. MANIFEST  — a DB-procedure trigger declared on a TABLE resource
 *                  ({ name, timing, events, procedure }). The orchestrator
 *                  transpiles it natively to `CREATE TRIGGER … EXECUTE FUNCTION
 *                  proc()` (runs with owner privileges). See 01-manifest-db-trigger.js.
 *   2. API/UI    — a fabric ACTION trigger ({ event, execute:{type} }) written
 *                  to the trigger_registry, then deployed. The separate
 *                  trigger-engine microservice compiles it to a native trigger
 *                  whose body enqueues a durable job on each row change, and a
 *                  worker drains trigger_jobs. See 02-action-triggers.js.
 *   (Raw SQL — `CREATE TRIGGER` or otherwise — is not supported; use the
 *   manifest or the API. See README.md.)
 *
 * These helpers wrap the registry API + a few read-only AST/REST lookups
 * (/analytics/query, /triggers/jobs/list, /admin/audit-logs) used only to
 * *verify* what the engine did.
 */
const axios = require('axios');
const { BASE_URL, authHeaders, call } = require('../_client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apply a metadata manifest (idempotent; force=true replays cleanly). */
async function applyManifest(token, manifest) {
  return call(`Apply manifest ${manifest.version}`, async () => {
    const res = await axios.post(`${BASE_URL}/metadata/apply?force=true`, manifest, { headers: authHeaders(token) });
    return res.data;
  });
}

/** Create-or-update a registry (API/UI) trigger, keyed by name+schema+table. */
async function upsertTrigger(token, payload) {
  return call(`Upsert trigger ${payload.triggerName}`, async () => {
    const list = await axios.get(`${BASE_URL}/triggers`, { headers: authHeaders(token) });
    const existing = (list.data || []).find(
      (t) => t.triggerName === payload.triggerName && t.schemaName === payload.schemaName && t.tableName === payload.tableName
    );
    if (existing) {
      const res = await axios.put(`${BASE_URL}/triggers/${existing.id}`, payload, { headers: authHeaders(token) });
      return res.data;
    }
    const res = await axios.post(`${BASE_URL}/triggers`, payload, { headers: authHeaders(token) });
    return res.data;
  });
}

/** Enqueue a DEPLOY/SCHEDULE job for a registry trigger (picked up by the MS). */
async function deploy(token, id) {
  return call(`Deploy trigger ${id}`, async () => {
    const res = await axios.post(`${BASE_URL}/triggers/${id}/deploy`, {}, { headers: authHeaders(token) });
    return res.data;
  });
}

/** Wait until no trigger_jobs are PENDING/RUNNING (the MS has drained the queue). */
async function waitForDrain(token, tries = 15) {
  for (let i = 0; i < tries; i += 1) {
    const jobs = await axios.get(`${BASE_URL}/triggers/jobs/list`, { headers: authHeaders(token) });
    const busy = (jobs.data || []).filter((j) => ['PENDING', 'RUNNING'].includes(j.status) && new Date(j.runAt) <= new Date());
    if (busy.length === 0) return jobs.data || [];
    await sleep(1000);
  }
  const jobs = await axios.get(`${BASE_URL}/triggers/jobs/list`, { headers: authHeaders(token) });
  return jobs.data || [];
}

/** INSERT a row through the structured query engine (runs with owner context, so triggers fire). */
async function insertRow(token, schema, table, data, opts = {}) {
  return call(`Insert into ${schema}.${table}`, async () => {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: { type: 'INSERT', schema, table, data }
    }, { headers: authHeaders(token) });
    return res.data;
  }, opts);
}

/** Count rows of a logical-schema resource via the AST engine (optional AST `where` predicates). */
async function countRows(token, schema, resource, where) {
  const res = await axios.post(`${BASE_URL}/analytics/query`, {
    queryConfig: {
      type: 'SELECT', schema, limit: 1,
      query: {
        from: { resource },
        select: [{ aggregate: 'COUNT', column: '*', alias: 'n' }],
        ...(where ? { where } : {})
      }
    }
  }, { headers: authHeaders(token) });
  const d = res.data || {};
  const row = (d.data || d.results || [])[0] || {};
  return Number(row.n || 0);
}

/** Does a registry trigger with this name exist? (autoDrop removes the registry row when it cleans up.) */
async function triggerRegistered(token, triggerName) {
  const list = await axios.get(`${BASE_URL}/triggers`, { headers: authHeaders(token) });
  return (list.data || []).some((t) => t.triggerName === triggerName);
}

/** Resolve a registry trigger's id by name (null when absent). */
async function triggerIdByName(token, triggerName) {
  const list = await axios.get(`${BASE_URL}/triggers`, { headers: authHeaders(token) });
  const t = (list.data || []).find((x) => x.triggerName === triggerName);
  return t ? t.id : null;
}

/** Latest queue job (GET /triggers/jobs/list, newest first) for a trigger id, optionally of one job type. */
async function latestJobForTriggerId(token, triggerId, jobType) {
  if (!triggerId) return null;
  const jobs = await axios.get(`${BASE_URL}/triggers/jobs/list`, { headers: authHeaders(token) });
  const j = (jobs.data || []).find((x) => x.triggerId === triggerId && (!jobType || x.jobType === jobType));
  return j ? { id: j.id, job_type: j.jobType, status: j.status, run_at: j.runAt, created_at: j.createdAt } : null;
}

/** Latest trigger_jobs row for a given trigger name (resolved via the registry). */
async function latestJobForTrigger(token, triggerName) {
  return latestJobForTriggerId(token, await triggerIdByName(token, triggerName));
}

/**
 * Minutes between the latest job's run_at and an anchor. `anchor` is a Date, or
 * the string 'created_at' to anchor on the job's own created_at. Both run_at and
 * created_at come back through the same serializer, so the created_at delta is
 * timezone-safe; for a fixed Date anchor, run the example on a host whose
 * timezone matches the API server's.
 */
async function jobRunAtDeltaMinutes(token, triggerName, anchor) {
  const job = await latestJobForTrigger(token, triggerName);
  if (!job) return null;
  const base = anchor === 'created_at' ? new Date(job.created_at) : anchor;
  return { ...job, delta: Math.round((new Date(job.run_at) - base) / 60000) };
}

/**
 * Count recent audit_logs rows for a table (proves a DB trigger -> audit_log_fn
 * fired). Reads GET /admin/audit-logs (latest 50 platform-wide rows).
 */
async function auditCountForTable(token, tableName) {
  const res = await axios.get(`${BASE_URL}/admin/audit-logs`, { headers: authHeaders(token) });
  return (res.data || []).filter((r) => r.table_name === tableName).length;
}

module.exports = {
  sleep,
  applyManifest,
  upsertTrigger,
  deploy,
  waitForDrain,
  insertRow,
  countRows,
  triggerRegistered,
  triggerIdByName,
  latestJobForTriggerId,
  latestJobForTrigger,
  jobRunAtDeltaMinutes,
  auditCountForTable
};
