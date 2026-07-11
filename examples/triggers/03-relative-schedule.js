/* eslint-disable no-console */
/**
 * 03 — RELATIVE schedule: anchor the delay off a ROW COLUMN or off NOW().
 *
 * A RELATIVE schedule defers a fired action by `after`/`unit`. The anchor —
 * the instant the delay is measured from — is now configurable:
 *
 *   • schedule.column set  → anchor = that column's value on the affected row
 *                            (NEW on insert/update, OLD on delete). run_at =
 *                            row.column + after·unit. Falls back to NOW() if the
 *                            column is null/absent so a bad column never drops the job.
 *   • schedule.column unset → anchor = trigger firing time. run_at = NOW() + after·unit.
 *
 * This is implemented in the native trigger body the engine generates:
 *   run_at = COALESCE((row_to_json(NEW)->>'col')::timestamptz,
 *                     (row_to_json(OLD)->>'col')::timestamptz, NOW()) + INTERVAL '…'
 *
 * We deploy one trigger of each flavour, insert a row carrying a known
 * event_time, then read the enqueued trigger_jobs.run_at and assert it matches
 * the expected anchor. This proves the column-relative scheduling end-to-end.
 */
const { login, banner } = require('../_client');
const {
  applyManifest, upsertTrigger, deploy, waitForDrain, insertRow, jobRunAtDeltaMinutes, sleep
} = require('./_lib');

const LOGICAL = 'Trg_Relative_Lab';
const PHYSICAL = 'tenant_tenant_A_Trg_Relative_Lab';
const TABLE = 'sla_events';

// A fixed, unambiguous anchor timestamp carried by the inserted row.
const EVENT_TIME = '2030-01-01 00:00:00';
const AFTER_MIN = 30; // delay 30 minutes past the anchor

async function run() {
  banner('03 — RELATIVE schedule (column-anchored vs now-anchored)');
  const token = await login();

  await applyManifest(token, {
    version: `trg-relative-lab-${Date.now()}`,
    schemas: [{
      name: LOGICAL,
      resources: [{
        type: 'TABLE',
        name: TABLE,
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'severity', type: 'TEXT' },
          { name: 'event_time', type: 'TIMESTAMP' } // the RELATIVE anchor column
        ]
      }]
    }]
  });

  // (A) Column-anchored: run_at = event_time + 30 min.
  const relCol = await upsertTrigger(token, {
    triggerName: 'trg_sla_escalate_from_event', schemaName: PHYSICAL, tableName: TABLE,
    definition: {
      event: 'AFTER_INSERT',
      execute: { type: 'AUDIT' },
      schedule: { type: 'RELATIVE', after: AFTER_MIN, unit: 'MINUTE', column: 'event_time', maxAttempts: 3 }
    }
  });
  await deploy(token, relCol.id);

  // (B) Now-anchored: run_at = NOW() + 30 min (no column).
  const relNow = await upsertTrigger(token, {
    triggerName: 'trg_sla_escalate_from_now', schemaName: PHYSICAL, tableName: TABLE,
    definition: {
      event: 'AFTER_INSERT',
      execute: { type: 'AUDIT' },
      schedule: { type: 'RELATIVE', after: AFTER_MIN, unit: 'MINUTE', maxAttempts: 3 }
    }
  });
  await deploy(token, relNow.id);

  await waitForDrain(token); // MS deploys both native triggers

  await insertRow(token, LOGICAL, TABLE, { id: `sla-${Date.now()}`, severity: 'P1', event_time: EVENT_TIME });
  await sleep(1200); // both triggers enqueue their action jobs

  // ---- (A) column-anchored assertion (delta computed in-DB, UTC frame) ----
  const jobA = await jobRunAtDeltaMinutes(token, 'trg_sla_escalate_from_event', `TIMESTAMP '${EVENT_TIME}'`);
  console.log('\n[A] column-anchored (event_time + 30m)');
  console.log('    row.event_time :', EVENT_TIME);
  console.log('    job.run_at     :', jobA && jobA.run_at);
  console.log(`    run_at - event_time = ${jobA && jobA.delta} min (expected ${AFTER_MIN})`);
  const passA = jobA && Number(jobA.delta) === AFTER_MIN;
  console.log(`    ${passA ? 'PASS' : 'FAIL'} run_at anchored to the row column`);

  // ---- (B) now-anchored assertion (delta vs the job's own created_at) ----
  const jobB = await jobRunAtDeltaMinutes(token, 'trg_sla_escalate_from_now', 'created_at');
  console.log('\n[B] now-anchored (NOW() + 30m)');
  console.log('    job.created_at :', jobB && jobB.created_at);
  console.log('    job.run_at     :', jobB && jobB.run_at);
  console.log(`    run_at - created_at = ${jobB && jobB.delta} min (expected ${AFTER_MIN})`);
  const passB = jobB && Number(jobB.delta) === AFTER_MIN;
  console.log(`    ${passB ? 'PASS' : 'FAIL'} run_at anchored to firing time`);

  console.log('\nNote: both jobs sit PENDING with a future run_at — the worker only');
  console.log('picks them up once run_at <= NOW(), so a 30-min SLA escalation fires on time.');

  if (!passA || !passB) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
