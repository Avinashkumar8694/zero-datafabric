/**
 * Run the churn-predictor example end to end.
 *   node run-all.js            # run the analysis (assumes seeded + registered)
 *   node run-all.js --seed     # (re)seed external sources + register + run
 *
 * Prereqs: docker stack up (remote PG :5436, Mongo :27017, ES :9200), backend :4000.
 */
const { execSync } = require('child_process');
const run = (cmd, env) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ...env } }); };
(async () => {
  if (process.argv.includes('--seed')) {
    run('node 01-seed-sources.js', { NODE_PATH: '../../backend/node_modules' });
    run('node 02-register-sources.js', { NODE_PATH: '../../backend/node_modules' });
  }
  run('node 03-churn-analysis.js');   // AST mode — cross-engine federation
  run('node 04-churn-sql-mode.js');   // SQL mode — native SQL at the Postgres sources
  console.log('\n=== churn-predictor complete ===');
})();
