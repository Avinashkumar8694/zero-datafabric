/* eslint-disable no-console */
/**
 * 05 — autoDrop (self-cleanup) and durable delivery.
 *
 * autoDrop: a trigger can carry `autoDrop: { when }`. When the condition holds
 * for a row, the trigger body enqueues a CLEANUP_TRIGGER job; the worker then
 * DROPs the native trigger and removes the registry entry. Useful for one-shot
 * or expiring triggers.
 *
 * Durability: every fired action becomes a row in public.trigger_jobs (a
 * Postgres-backed queue) BEFORE any delivery is attempted. Because the queue is
 * persisted, stopping the trigger-engine loses nothing — pending jobs simply
 * wait, and the worker drains them when it comes back (store-and-forward). This
 * script demonstrates the durable path: a job enqueued with a near-future
 * run_at stays PENDING, then transitions to COMPLETED once the worker picks it
 * up and writes its audit row.
 */
const { login, banner, authHeaders, BASE_URL } = require('../_client');
const axios = require('axios');
const {
  applyManifest, upsertTrigger, deploy, waitForDrain, insertRow, selectSql, sleep
} = require('./_lib');

const LOGICAL = 'Trg_AutoDrop_Lab';
const PHYSICAL = 'tenant_tenant_A_Trg_AutoDrop_Lab';
const TABLE = 'tickets';

async function triggerExists(token, name) {
  const rows = await selectSql(token,
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = '${name}' AND NOT tgisinternal`);
  return Number(rows[0]?.n || 0) > 0;
}

async function run() {
  banner('05 — autoDrop self-cleanup + durable delivery');
  const token = await login();

  await applyManifest(token, {
    version: `trg-autodrop-lab-${Date.now()}`,
    schemas: [{
      name: LOGICAL,
      resources: [{
        type: 'TABLE',
        name: TABLE,
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'status', type: 'TEXT' }
        ]
      }]
    }]
  });

  // ---- autoDrop ----
  const t = await upsertTrigger(token, {
    triggerName: 'trg_ticket_oneshot', schemaName: PHYSICAL, tableName: TABLE,
    definition: {
      event: 'AFTER_INSERT',
      execute: { type: 'AUDIT' },
      autoDrop: { when: "NEW.status = 'CLOSED'", message: 'drop once a ticket closes' }
    }
  });
  await deploy(token, t.id);
  await waitForDrain(token);

  console.log('trigger present after deploy:', await triggerExists(token, 'trg_ticket_oneshot'));

  // A CLOSED ticket satisfies autoDrop.when → enqueues CLEANUP_TRIGGER.
  await insertRow(token, LOGICAL, TABLE, { id: `tkt-${Date.now()}`, status: 'CLOSED' });
  await waitForDrain(token);
  await sleep(800);

  const gone = !(await triggerExists(token, 'trg_ticket_oneshot'));
  console.log(`${gone ? 'PASS' : 'FAIL'} autoDrop removed the trigger after the CLOSED row`);

  // ---- durability: enqueue with a near-future run_at, watch it drain ----
  const runAt = new Date(Date.now() + 3000).toISOString();
  const tag = `durable-${Date.now()}`;
  await axios.post(`${BASE_URL}/queries/exec`, {
    sql: `INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
          VALUES ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION',
            '{"triggerName":"${tag}","event":"AFTER_INSERT","actionType":"AUDIT","tableName":"${TABLE}","schemaName":"${PHYSICAL}","newRow":{"id":"${tag}"}}',
            'PENDING', '${runAt}', 3, 'examples')`
  }, { headers: authHeaders(token) });

  const pending = await selectSql(token,
    `SELECT status, run_at FROM public.trigger_jobs WHERE payload->>'triggerName' = '${tag}'`);
  console.log(`durable job persisted PENDING with future run_at:`, pending[0]);
  console.log('(If the trigger-engine were stopped now, this row would simply wait — nothing is lost.)');

  await waitForDrain(token, 12);
  await sleep(500);
  const done = await selectSql(token,
    `SELECT status FROM public.trigger_jobs WHERE payload->>'triggerName' = '${tag}'`);
  console.log(`durable job final status: ${done[0]?.status} (${done[0]?.status === 'COMPLETED' ? 'PASS' : 'check worker'})`);

  if (!gone) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
