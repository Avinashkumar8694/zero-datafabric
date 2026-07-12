/* eslint-disable no-console */
/** Runs the recursive-traversal example suite in order. */
const scenarios = [
  ['01 org hierarchy (descend)',        require('./01-org-hierarchy')],
  ['02 subtree + ancestors',            require('./02-subtree-and-ancestors')],
  ['03 depth cap + cycle guard',        require('./03-depth-cap-and-cycle')],
];

(async () => {
  let failed = 0;
  for (const [name, mod] of scenarios) {
    try { await mod.run(); } catch (e) { failed++; console.error(`\n[${name}] ERROR:`, e.response?.data || e.message); }
  }
  console.log(`\n=== recursive suite complete — ${scenarios.length - failed}/${scenarios.length} scenarios ok ===`);
  process.exit(failed ? 1 : 0);
})();
