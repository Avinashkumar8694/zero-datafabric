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
 * Postgres-backed queue, visible via GET /api/triggers/jobs/list) BEFORE any
 * delivery is attempted. Because the queue is persisted, stopping the
 * trigger-engine loses nothing — pending jobs wait and the worker drains them
 * when it comes back (store-and-forward). See 03/06 for queued future jobs.
 */
const { login, banner } = require('../_client');
const {
  applyManifest, upsertTrigger, deploy, waitForDrain, insertRow, triggerRegistered, sleep
} = require('./_lib');

const LOGICAL = 'Trg_AutoDrop_Lab';
const PHYSICAL = 'tenant_tenant_A_Trg_AutoDrop_Lab';
const TABLE = 'tickets';

async function triggerExists(token, name) {
  // autoDrop drops the native trigger AND removes its registry row.
  return triggerRegistered(token, name);
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

  // Durable delivery: every action is a row in the trigger_jobs queue (see
  // GET /api/triggers/jobs/list); a stopped trigger-engine simply lets jobs wait.
  // 03-relative-schedule.js and 06-declarative-and-dsl.js show queued jobs with future run_at.

  if (!gone) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
