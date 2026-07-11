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
 *   3. SQL       — raw `CREATE TRIGGER` via /queries/exec is intentionally
 *                  denied for tenant users (sandboxed, cannot DDL managed
 *                  schemas). Use the manifest or the API instead — documented
 *                  in README.md.
 *
 * These helpers wrap the registry API + a few direct SQL reads (via
 * /queries/exec) used only to *verify* what the engine did.
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

/** Run a read-only SQL statement and return rows (used only for verification).
 *  /queries/exec wraps rows as { results: { results: [...] } }. */
async function selectSql(token, sql) {
  const res = await axios.post(`${BASE_URL}/queries/exec`, { sql }, { headers: authHeaders(token) });
  const d = res.data || {};
  return d.results?.results || d.results?.rows || d.rows || d.data || (Array.isArray(d) ? d : []);
}

/** Latest trigger_jobs row for a given trigger name (via payload->>'triggerName'). */
async function latestJobForTrigger(token, triggerName) {
  const rows = await selectSql(token,
    `SELECT id, job_type, status, run_at, created_at, payload->>'triggerName' AS trigger_name
     FROM public.trigger_jobs
     WHERE payload->>'triggerName' = '${triggerName}'
     ORDER BY created_at DESC LIMIT 1`);
  return rows[0] || null;
}

/**
 * Minutes between the latest job's run_at and an anchor SQL expression, computed
 * ENTIRELY in Postgres. run_at is a `timestamp without time zone` in the DB's
 * UTC session, so comparing it in JS would misparse it under the client's local
 * timezone; doing the arithmetic in SQL keeps everything in one UTC frame — the
 * same frame the worker uses for `run_at <= NOW()`.
 */
async function jobRunAtDeltaMinutes(token, triggerName, anchorSqlExpr) {
  const rows = await selectSql(token,
    `SELECT ROUND(EXTRACT(EPOCH FROM (run_at - (${anchorSqlExpr}))) / 60)::int AS delta,
            run_at, created_at
     FROM public.trigger_jobs
     WHERE payload->>'triggerName' = '${triggerName}'
     ORDER BY created_at DESC LIMIT 1`);
  return rows[0] || null;
}

/** Count audit_logs rows for a table (proves a DB trigger → audit_log_fn fired). */
async function auditCountForTable(token, tableName) {
  const rows = await selectSql(token,
    `SELECT count(*)::int AS n FROM fabric_admin.audit_logs WHERE table_name = '${tableName}'`);
  return Number(rows[0]?.n || 0);
}

module.exports = {
  sleep,
  applyManifest,
  upsertTrigger,
  deploy,
  waitForDrain,
  insertRow,
  selectSql,
  latestJobForTrigger,
  jobRunAtDeltaMinutes,
  auditCountForTable
};
