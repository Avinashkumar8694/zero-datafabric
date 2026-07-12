/* eslint-disable no-console */
/**
 * 03 — Policies declared in a METADATA MANIFEST (not the API).
 *
 * A table's `security.accessPolicies` block is engine-agnostic and synced into
 * the fabric policy catalog on apply, so the SAME manifest that provisions a
 * table also ships its row predicate + masking. (The legacy `security.masking`
 * field — previously a no-op — is now also enforced on non-RLS engines.)
 *
 * This applies a manifest for a fabric-managed Postgres table, then verifies the
 * policies landed in the control plane (GET /api/policies). Enforcement on the
 * data path is covered live for Mongo in 01/02; this shows the manifest AUTHORING
 * path and control-plane visibility.
 */
const axios = require('axios');
const { banner } = require('../_client');
const { BASE, login, headers } = require('./_lib');

async function run() {
  banner('03 — access policies via metadata manifest');
  const token = await login();

  const manifest = {
    version: `policy-manifest-lab-${Date.now()}`,
    schemas: [{
      name: 'Policy_Manifest_Lab',
      resources: [{
        type: 'TABLE',
        name: 'accounts',
        columns: [
          { name: 'id', type: 'TEXT', primaryKey: true },
          { name: 'tenant_code', type: 'TEXT' },
          { name: 'region', type: 'TEXT' },
          { name: 'email', type: 'TEXT' },
          { name: 'deleted_at', type: 'TIMESTAMP' },
        ],
        security: {
          // Engine-agnostic policies enforced by the fabric on non-RLS engines.
          accessPolicies: [
            {
              name: 'tenant_and_live',
              rowFilter: [
                { column: 'tenant_code', operator: 'EQ', value: { session: 'tenant_id' } },
                { column: 'deleted_at', operator: 'IS_NULL' },
              ],
              masking: [{ column: 'email', strategy: 'REDACT' }],
            },
          ],
          // Legacy masking field — now mapped to a fabric masking policy too.
          masking: [{ column: 'region', roles: ['ADMIN'], expression: 'REDACTED' }],
        },
      }],
    }],
  };

  await axios.post(`${BASE}/metadata/apply?force=true`, manifest, { headers: headers(token) });
  console.log('applied manifest with security.accessPolicies + legacy masking');

  const policies = (await axios.get(`${BASE}/policies`, { headers: headers(token) })).data || [];
  const mine = policies.filter((p) => p.table === 'accounts');
  console.log('\ncontrol-plane policies for accounts:');
  for (const p of mine) {
    console.log(`  ${p.name.padEnd(18)} source=${p.source} filters=${(p.rowFilter || []).length} masks=${(p.masking || []).length}`);
  }
  const hasRow = mine.some((p) => (p.rowFilter || []).length >= 2 && p.source === 'MANIFEST');
  const hasMask = mine.some((p) => (p.masking || []).length >= 1);
  console.log(`\n  structured accessPolicies synced: ${hasRow ? 'PASS' : 'FAIL'}`);
  console.log(`  legacy masking synced (no longer a no-op): ${hasMask ? 'PASS' : 'FAIL'}`);

  if (!hasRow || !hasMask) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
