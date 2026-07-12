/* eslint-disable no-console */
/**
 * 01 — ROW-LEVEL policies injected into a non-RLS engine (MongoDB).
 *
 * MongoDB has no row-level security. The fabric resolves each policy's predicate,
 * compiles it to a source filter, and INJECTS it into the pushdown — so the
 * predicate runs inside Mongo (`$match`), and the tenant only ever receives the
 * rows they're entitled to. Three classic policies, stacked:
 *
 *   • tenant_isolation — tenant_code = SESSION.tenant_id   (multi-tenant scoping)
 *   • region_isolation — region      = SESSION.region      (data-residency)
 *   • hide_deleted     — deleted_at IS NULL                (soft-delete masking)
 *
 * SESSION.tenant_id comes from the auth token / x-tenant-id; SESSION.region from
 * the x-region header. Seed = 18 docs (2 tenants × 3 regions × 3, one deleted
 * per group). With all three policies + region=EU, only tenant_A + EU + live
 * rows survive (2).
 */
const { banner } = require('../_client');
const { login, seed, register, clearPolicies, addPolicy, queryAll } = require('./_lib');

async function run() {
  banner('01 — row-level policies (tenant / region / soft-delete) on MongoDB');
  const token = await login();
  console.log(`seeded ${await seed()} mongo docs; registered Policy_Lab`);
  await register();
  await clearPolicies(token);

  const base = await queryAll(token, 'EU');
  console.log(`\n[no policies] rows = ${base.rowCount} (expect 18 — nothing enforced yet)`);

  await addPolicy(token, { name: 'tenant_isolation', rowFilter: [{ column: 'tenant_code', operator: 'EQ', value: { session: 'tenant_id' } }] });
  await addPolicy(token, { name: 'region_isolation', rowFilter: [{ column: 'region', operator: 'EQ', value: { session: 'region' } }] });
  await addPolicy(token, { name: 'hide_deleted', rowFilter: [{ column: 'deleted_at', operator: 'IS_NULL' }] });

  const eu = await queryAll(token, 'EU');
  const violations = (eu.data || []).filter((r) => r.tenant_code !== 'tenant_A' || r.region !== 'EU' || r.deleted_at);
  console.log(`\n[3 policies, region=EU] rows = ${eu.rowCount} (expect 2)`);
  console.log('  policy violations in result:', violations.length, violations.length === 0 ? 'PASS' : 'FAIL');
  console.log('  injected pushdown:', (eu.plan?.pushed || []).filter((p) => p.includes('policy')));

  // Same query, region=NA → a DIFFERENT slice, proving the predicate is session-relative.
  const na = await queryAll(token, 'NA');
  console.log(`\n[same policies, region=NA] rows = ${na.rowCount} (expect 2 — NA slice)`);
  const naOk = (na.data || []).every((r) => r.region === 'NA' && r.tenant_code === 'tenant_A' && !r.deleted_at);
  console.log(`  region-relative isolation: ${naOk ? 'PASS' : 'FAIL'}`);

  if (eu.rowCount !== 2 || violations.length || na.rowCount !== 2 || !naOk) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
