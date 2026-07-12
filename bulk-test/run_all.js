/**
 * Runs BOTH bulk suites (2000+ generated queries) against the live fabric on
 * :4000 and prints a combined report with strategy (leg) distribution.
 *
 *   cd backend && NODE_PATH=./node_modules node ../bulk-test/run_all.js
 *
 * Requires: backend running on :4000, and the datasets registered in
 * tenant_advanced_test (see README.md → "Data setup").
 */
const O = require('./oracle');
const foundational = require('./suite_same_and_cross');
const crossAnalytics = require('./suite_cross_analytics');

(async () => {
  const suites = [['SAME-SOURCE + CROSS-SOURCE (foundational)', foundational], ['CROSS-DATASOURCE ANALYTICS', crossAnalytics]];
  let totP = 0, totF = 0, tot = 0;
  const combinedStrat = {};
  for (const [title, cases] of suites) {
    const { results, strat } = await O.runCases(cases);
    const { pass, fail } = O.report(title, cases, results, strat);
    totP += pass; totF += fail; tot += cases.length;
    for (const k of Object.keys(strat)) combinedStrat[k] = (combinedStrat[k] || 0) + strat[k];
  }
  console.log('\n========================================');
  console.log(`GRAND TOTAL: ${tot} queries   PASS ${totP}   FAIL ${totF}`);
  console.log('COMBINED STRATEGY (legs):', JSON.stringify(combinedStrat));
  console.log('========================================');
  process.exit(totF === 0 ? 0 : 1);
})();
