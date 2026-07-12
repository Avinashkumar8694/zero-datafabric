/* eslint-disable no-console */
/** Runs the governance example suite: constraints, grants, function-as-a-service. */
const scenarios = [
  ['01 constraints',   require('./01-constraints')],
  ['02 grants',        require('./02-grants')],
  ['03 function call', require('./03-function-call')],
];

(async () => {
  let failed = 0;
  for (const [name, mod] of scenarios) {
    try { await mod.run(); } catch (e) { failed++; console.error(`\n[${name}] ERROR:`, e.response?.data || e.message); }
  }
  console.log(`\n=== governance suite complete — ${scenarios.length - failed}/${scenarios.length} scenarios ok ===`);
  process.exit(failed ? 1 : 0);
})();
