/**
 * Run the whole Elasticsearch example suite.
 *   node run-all.js            # run all scenarios (assumes index seeded + registered)
 *   node run-all.js --seed     # (re)seed the ES index + register the source first
 *
 * Prereqs: docker stack up (Elasticsearch :9200), backend on :4000.
 */
const { execSync } = require('child_process');
const run = (cmd, env) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ...env } }); };
(async () => {
  if (process.argv.includes('--seed')) {
    run('node 01-seed.js', { NODE_PATH: '../../backend/node_modules' });
    run('node 02-register.js', { NODE_PATH: '../../backend/node_modules' });
  }
  run('node 03-search-and-fulltext.js');
  run('node 04-aggregations.js');
  run('node 05-sql-mode.js');
  run('node 06-crud-and-federation.js');
  console.log('\n=== elasticsearch example suite complete ===');
})();
