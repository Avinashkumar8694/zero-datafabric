/**
 * Run the whole distributed-retail example suite end to end.
 *   node run-all.js            # assumes external DBs already seeded + sources registered
 *   node run-all.js --seed     # (re)seed + (re)register first
 *
 * Prereqs: docker stack up, backend on :4000.
 */
const { execSync } = require('child_process');
const run = (cmd, env) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ...env } }); };

(async () => {
  if (process.argv.includes('--seed')) {
    run('node 01-seed-external-sources.js', { NODE_PATH: '../../backend/node_modules' });
    run('node 02-register-sources.js', { NODE_PATH: '../../backend/node_modules' });
  }
  run('node 03-analytics-suite.js');
  run('node 04-tat-audit.js');
  run('node 05-real-world-scenarios.js');
  run('node 06-ast-cookbook.js');
  run('node 07-crud-api-examples.js');
  console.log('\n=== distributed-retail example suite complete ===');
})();
