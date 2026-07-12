/* eslint-disable no-console */
/**
 * 01 — Org hierarchy: descend the whole tree from the roots (over MongoDB).
 *
 * The recursive spec is engine-agnostic:
 *   connectBy { parent:'manager_id', child:'id' }  →  child.manager_id = parent.id
 *   anchor    manager_id IS NULL                    →  roots
 *   direction 'down' (default)                      →  walk to children
 *
 * The fabric fetches level 0 (roots), then each subsequent level with a single
 * `manager_id IN (…frontier ids…)` pushed to Mongo, tagging depth and building a
 * breadcrumb `path`. This is the `$graphLookup` / `WITH RECURSIVE` result, but
 * over an engine that has neither.
 */
const { banner } = require('../_client');
const { login, seed, register, recurse } = require('./_lib');

async function run() {
  banner('01 — descend the org tree from roots (MongoDB)');
  const token = await login();
  await seed(); await register();
  console.log('seeded org tree (8 nodes) + registered Org_Lab');

  const res = await recurse(token, {
    source: 'Org_Lab', resource: 'employees',
    connectBy: { parent: 'manager_id', child: 'id' },
    anchor: [{ column: 'manager_id', operator: 'IS_NULL' }],
    select: ['id', 'name', 'manager_id'],
    maxDepth: 10, pathColumn: 'name',
  });

  console.log(`\nstrategy: ${res.plan?.strategy} | nodes: ${res.rowCount} (expect 8)`);
  console.log('levels:', (res.plan?.traversal || []).map((t) => `d${t.depth}:+${t.added}`).join(' '));
  for (const n of (res.data || []).sort((a, b) => a.id - b.id)) {
    console.log(`  #${n.id} ${String(n.name).padEnd(7)} depth=${n.depth} path=${(n.path || []).join(' > ')}`);
  }
  const depthOf = (id) => (res.data || []).find((x) => x.id === id)?.depth;
  const ok = res.rowCount === 8 && depthOf(1) === 0 && depthOf(2) === 1 && depthOf(4) === 2 && depthOf(7) === 3;
  console.log(`\n  full closure + correct depths: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
