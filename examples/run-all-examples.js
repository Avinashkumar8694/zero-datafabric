/* eslint-disable no-console */
const { execSync } = require('node:child_process');
const path = require('node:path');

const root = __dirname;
const scripts = [
  'prepare-demo-env.js',
  'register-3-datasources.js',
  'inserts-all-datasources.js',
  'all-query-types.js',
  'multi-datasource-queries.js',
  'views-mviews-sequences-procs-triggers.js',
  'update-delete-advanced.js',
  'aggregation-and-complex.js'
];

for (const s of scripts) {
  const full = path.join(root, s);
  console.log(`\n>>> Running ${s}`);
  try {
    execSync(`node ${JSON.stringify(full)}`, { stdio: 'inherit' });
  } catch (err) {
    console.log(`Script ended with non-zero status: ${s}`);
  }
}

console.log('\nAll example scripts executed.');
