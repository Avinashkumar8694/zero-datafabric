/* eslint-disable no-console */
/**
 * 02 — COLUMN MASKING on a non-RLS engine (MongoDB).
 *
 * Mongo/ES can't mask columns per role. The fabric applies masking to the
 * returned rows post-fetch, driven by the same policy catalog. Four strategies:
 *
 *   • REDACT  → '***REDACTED***'
 *   • NULL    → null
 *   • HASH    → 'sha256:xxxxxxxx' (stable, non-reversible)
 *   • PARTIAL → keep the last 4 chars (e.g. '*****0007')
 *
 * A mask rule may target specific `roles` (omit = everyone). Here the masking
 * applies to the ADMIN role the demo logs in as. Row policies and masking
 * compose: rows are filtered at the source, then sensitive columns are masked.
 */
const { banner } = require('../_client');
const { login, seed, register, clearPolicies, addPolicy, queryAll } = require('./_lib');

async function run() {
  banner('02 — column masking (REDACT / PARTIAL / HASH / NULL) on MongoDB');
  const token = await login();
  console.log(`seeded ${await seed()} mongo docs; registered Policy_Lab`);
  await register();
  await clearPolicies(token);

  // A row policy (tenant isolation) + masking, to show they compose.
  await addPolicy(token, { name: 'tenant_isolation', rowFilter: [{ column: 'tenant_code', operator: 'EQ', value: { session: 'tenant_id' } }] });
  await addPolicy(token, {
    name: 'pii_masking',
    masking: [
      { column: 'email', strategy: 'REDACT' },
      { column: 'ssn', strategy: 'PARTIAL' },
      { column: 'amount', strategy: 'HASH' },
    ],
  });

  const res = await queryAll(token);
  const sample = (res.data || [])[0] || {};
  console.log(`\nrows = ${res.rowCount} (tenant_A only)`);
  console.log('  sample email :', sample.email, '(expect ***REDACTED***)');
  console.log('  sample ssn   :', sample.ssn, '(expect *****NNNN)');
  console.log('  sample amount:', sample.amount, '(expect sha256:xxxxxxxx)');
  console.log('  masking note :', (res.plan?.pushed || []).filter((p) => p.includes('masking')));

  const allMasked = (res.data || []).every((r) =>
    r.email === '***REDACTED***' && /^\*+\d{4}$/.test(String(r.ssn)) && /^sha256:[0-9a-f]{8}$/.test(String(r.amount)));
  console.log(`\n  every row masked correctly: ${allMasked ? 'PASS' : 'FAIL'}`);
  const tenantOk = (res.data || []).every((r) => r.tenant_code === 'tenant_A');
  console.log(`  row policy still applied alongside masking: ${tenantOk ? 'PASS' : 'FAIL'}`);

  if (!allMasked || !tenantOk) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
