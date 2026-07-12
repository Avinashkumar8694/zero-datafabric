/* eslint-disable no-console */
/**
 * 02 — Subtree (descend from a mid node) and ancestors (ascend to the root).
 *
 * Same hierarchy, two directions:
 *   • startWith { id = 2 } + direction 'down'  → the VP-A subtree (2,4,5,7,8).
 *   • startWith { id = 7 } + direction 'up'     → Eng-1's chain of command
 *                                                 (7 → 4 → 2 → 1).
 *
 * `startWith` overrides the default root anchor, so recursion can begin anywhere.
 * 'up' flips the bind direction (match on the child key, follow the parent key).
 */
const { banner } = require('../_client');
const { login, seed, register, recurse } = require('./_lib');

async function run() {
  banner('02 — subtree (down from a node) + ancestors (up to the root)');
  const token = await login();
  await seed(); await register();

  // Subtree under VP-A (id 2).
  const sub = await recurse(token, {
    source: 'Org_Lab', resource: 'employees',
    connectBy: { parent: 'manager_id', child: 'id' },
    startWith: [{ column: 'id', operator: 'EQ', value: 2 }],
    direction: 'down', select: ['id', 'name', 'manager_id'], maxDepth: 10, pathColumn: 'name',
  });
  const subIds = (sub.data || []).map((r) => r.id).sort((a, b) => a - b);
  console.log(`\n[subtree from VP-A(2), down] nodes = ${sub.rowCount}: [${subIds.join(', ')}] (expect 2,4,5,7,8)`);
  const subOk = JSON.stringify(subIds) === JSON.stringify([2, 4, 5, 7, 8]);
  console.log(`  subtree correct: ${subOk ? 'PASS' : 'FAIL'}`);

  // Ancestors of Eng-1 (id 7), walking up.
  const anc = await recurse(token, {
    source: 'Org_Lab', resource: 'employees',
    connectBy: { parent: 'manager_id', child: 'id' },
    startWith: [{ column: 'id', operator: 'EQ', value: 7 }],
    direction: 'up', select: ['id', 'name', 'manager_id'], maxDepth: 10, pathColumn: 'name',
  });
  const ancIds = (anc.data || []).map((r) => r.id);
  console.log(`\n[ancestors of Eng-1(7), up] chain = [${ancIds.join(' → ')}] (expect 7,4,2,1)`);
  const ancOk = JSON.stringify(ancIds.slice().sort((a, b) => a - b)) === JSON.stringify([1, 2, 4, 7]);
  console.log(`  ancestor chain correct: ${ancOk ? 'PASS' : 'FAIL'}`);

  if (!subOk || !ancOk) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
