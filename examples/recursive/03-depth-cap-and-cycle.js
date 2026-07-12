/* eslint-disable no-console */
/**
 * 03 — Bounded traversal: maxDepth cap + cycle guard.
 *
 * In-fabric recursion is bounded so a deep or cyclic graph can't run away:
 *   • maxDepth   — stop after N levels; the result flags `truncatedByDepth`.
 *   • cycle guard — a `seen` set on the node key means a cyclic graph
 *                   (A → B → C → … → A) terminates and each node appears once.
 *
 * We run the org tree with maxDepth=1 (roots + one level only), then walk the
 * deliberately-cyclic `graph` collection and confirm it terminates with each
 * node visited exactly once.
 */
const { banner } = require('../_client');
const { login, seed, register, recurse } = require('./_lib');

async function run() {
  banner('03 — maxDepth cap + cycle guard');
  const token = await login();
  await seed(); await register();

  // (a) Depth cap: roots (d0) + one level (d1) only.
  const capped = await recurse(token, {
    source: 'Org_Lab', resource: 'employees',
    connectBy: { parent: 'manager_id', child: 'id' },
    anchor: [{ column: 'manager_id', operator: 'IS_NULL' }],
    select: ['id', 'name', 'manager_id'], maxDepth: 1,
  });
  const maxDepthSeen = Math.max(...(capped.data || []).map((r) => r.depth));
  console.log(`\n[maxDepth=1] nodes = ${capped.rowCount} (expect 3: CEO + 2 VPs), max depth = ${maxDepthSeen}`);
  console.log('  warnings:', capped.warnings);
  const capOk = capped.rowCount === 3 && maxDepthSeen === 1 && (capped.warnings || []).some((w) => /maxDepth/i.test(w));
  console.log(`  depth cap enforced + flagged: ${capOk ? 'PASS' : 'FAIL'}`);

  // (b) Cycle guard: the `graph` collection contains a ring; traversal must halt.
  const cyc = await recurse(token, {
    source: 'Org_Lab', resource: 'graph',
    connectBy: { parent: 'parent_id', child: 'id' },
    anchor: [{ column: 'parent_id', operator: 'IS_NULL' }],
    select: ['id', 'name', 'parent_id'], maxDepth: 50,
  });
  const ids = (cyc.data || []).map((r) => r.id);
  const unique = new Set(ids).size === ids.length;
  console.log(`\n[cyclic graph] visited ${cyc.rowCount} node(s): [${ids.join(', ')}]`);
  console.log(`  terminated + each node once (no infinite loop): ${unique && cyc.rowCount > 0 ? 'PASS' : 'FAIL'}`);

  if (!capOk || !unique) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
