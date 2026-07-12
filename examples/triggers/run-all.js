/* eslint-disable no-console */
/**
 * Runs the full trigger example suite in order. Each step is self-contained and
 * idempotent (manifests use force=true, triggers upsert by name).
 */
const scenarios = [
  ['01 manifest DB-procedure trigger', require('./01-manifest-db-trigger')],
  ['02 API/UI action triggers',        require('./02-action-triggers')],
  ['03 RELATIVE schedule (column/now)', require('./03-relative-schedule')],
  ['04 FIXED + CRON schedulers',       require('./04-fixed-cron-schedules')],
  ['05 autoDrop + durability',         require('./05-autodrop-and-durability')],
  ['06 declarative + mini-DSL',        require('./06-declarative-and-dsl')]
];

(async () => {
  let failed = 0;
  for (const [name, mod] of scenarios) {
    try {
      await mod.run();
    } catch (err) {
      failed += 1;
      console.error(`\n[${name}] ERROR:`, err.response?.data || err.message);
    }
  }
  console.log(`\n=== trigger suite complete — ${scenarios.length - failed}/${scenarios.length} scenarios ok ===`);
  process.exit(failed ? 1 : 0);
})();
