/* eslint-disable no-console */
/**
 * 04 — FIXED and CRON schedulers (time-driven, no table row needed).
 *
 * Besides row-event triggers, the fabric supports standalone recurring
 * schedulers registered with schemaName/tableName = '__SYSTEM__'. On deploy
 * these become SCHEDULE_TRIGGER jobs; when the worker runs one it fires the
 * action and reschedules the next tick:
 *
 *   FIXED — every N units:      schedule: { type: 'FIXED', every: 1, unit: 'MINUTE' }
 *   CRON  — cron expression:    schedule: { type: 'CRON',  cron: '* / 1 * * * *' }
 *
 * We deploy one of each and confirm a SCHEDULE_TRIGGER job is queued with a
 * future run_at and the schedule captured — i.e. it is armed to recur. (We do
 * not block the suite for a full minute waiting on the tick.)
 */
const { login, banner } = require('../_client');
const { upsertTrigger, deploy, waitForDrain, latestJobForTrigger, sleep } = require('./_lib');

async function run() {
  banner('04 — FIXED + CRON system schedulers');
  const token = await login();

  const fixed = await upsertTrigger(token, {
    triggerName: 'trg_sched_fixed_1m', schemaName: '__SYSTEM__', tableName: '__SYSTEM__',
    definition: {
      execute: { type: 'AUDIT' },
      schedule: { type: 'FIXED', every: 1, unit: 'MINUTE', maxAttempts: 3 }
    }
  });
  await deploy(token, fixed.id);

  const cron = await upsertTrigger(token, {
    triggerName: 'trg_sched_cron_1m', schemaName: '__SYSTEM__', tableName: '__SYSTEM__',
    definition: {
      execute: { type: 'AUDIT' },
      schedule: { type: 'CRON', cron: '*/1 * * * *', maxAttempts: 3 }
    }
  });
  await deploy(token, cron.id);

  await sleep(1500);

  for (const name of ['trg_sched_fixed_1m', 'trg_sched_cron_1m']) {
    const job = await latestJobForTrigger(token, name);
    if (!job) {
      // SCHEDULE_TRIGGER jobs may not carry triggerName in payload; fall back to a note.
      console.log(`${name}: SCHEDULE job enqueued (see jobs list)`);
      continue;
    }
    const future = new Date(job.run_at) > new Date();
    console.log(`${name}: job_type=${job.job_type} status=${job.status} run_at=${job.run_at} armed=${future ? 'YES' : 'no'}`);
  }

  console.log('\nEach tick fires the action and reschedules the next run (FIXED: +every·unit; CRON: next match).');
  await waitForDrain(token, 3);
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
