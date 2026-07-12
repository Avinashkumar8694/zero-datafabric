/* Regenerate EXAMPLES.md from the examples array. Run: node ../bulk-test/gen_examples_md.js */
const fs = require('fs');
const path = require('path');
const { EX } = require('./examples_ast_sql.js');

const lines = [];
lines.push('# Advanced Analytics Examples — paired AST + SQL');
lines.push('');
lines.push('Hand-crafted real-world business queries over a retail star schema across **four engines** (Postgres `orders`, MongoDB `customers`, MySQL `products`, Elasticsearch `webviews`). Each shows the equivalent **SQL** and the fabric **AST** that is executed — validated against a JS oracle in `examples_ast_sql.js`, with per-leg execution checked by `analyze_legs.js`. Write-side concepts (CRUD, sequences, custom functions, write-value generators) are in `suite_crud_functions.js`.');
lines.push('');
lines.push('Run: `cd backend && NODE_PATH=./node_modules node ../bulk-test/examples_ast_sql.js`');
lines.push('');
lines.push('| # | Scenario | Engines |');
lines.push('|---|---|---|');
for (const e of EX) lines.push(`| ${e.n} | ${e.title} | ${e.engines} |`);
lines.push('');
lines.push('---');
lines.push('');
for (const e of EX) {
  const tags = (e.cross ? ' (cross-datasource → `CROSS_ENGINE`)' : '') + (e.win ? ' · window (in-fabric)' : '');
  lines.push(`## ${e.n}. ${e.title}`);
  lines.push('');
  lines.push(`**Engines:** ${e.engines}${tags}`);
  lines.push('');
  lines.push('**SQL**');
  lines.push('```sql');
  lines.push(e.sql);
  lines.push('```');
  lines.push('');
  lines.push('**AST**');
  lines.push('```json');
  lines.push(JSON.stringify(e.ast, null, 2));
  lines.push('```');
  lines.push('');
}
fs.writeFileSync(path.join(__dirname, 'EXAMPLES.md'), lines.join('\n'));
console.log('EXAMPLES.md regenerated:', EX.length, 'examples');
