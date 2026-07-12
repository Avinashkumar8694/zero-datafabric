/* eslint-disable no-console */
/** Runs the Policy Engine example suite in order. */
const scenarios = [
  ['01 row isolation (tenant/region/soft-delete)', require('./01-row-isolation')],
  ['02 column masking',                            require('./02-column-masking')],
  ['03 policies via manifest',                     require('./03-manifest-policies')],
];

(async () => {
  let failed = 0;
  for (const [name, mod] of scenarios) {
    try { await mod.run(); } catch (e) { failed++; console.error(`\n[${name}] ERROR:`, e.response?.data || e.message); }
  }
  console.log(`\n=== policy suite complete — ${scenarios.length - failed}/${scenarios.length} scenarios ok ===`);
  process.exit(failed ? 1 : 0);
})();
