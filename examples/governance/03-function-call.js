/* eslint-disable no-console */
/**
 * 03 — FUNCTION / PROCEDURE call (fabric function-as-a-service).
 *
 * Functions/procedures are provisioned on the hub Postgres via a manifest. The
 * fabric exposes them as a service callable from:
 *   • POST /api/data/call { schema, function, args }
 *   • POST /api/analytics/query with queryConfig { type: 'CALL', ... }
 *
 * We apply a tiny manifest with a scalar function, then call it both ways and
 * confirm the same result. (For a non-SQL engine, this is how the fabric supplies
 * function values that Mongo/ES can't compute themselves.)
 */
const axios = require('axios');
const { banner } = require('../_client');
const { BASE, login, H } = require('./_lib');

async function run() {
  banner('03 — function-as-a-service (data/call + CALL query)');
  const token = await login();

  // Provision a scalar function on the hub via a manifest.
  await axios.post(`${BASE}/metadata/apply?force=true`, {
    version: `gov-fn-lab-${Date.now()}`,
    schemas: [{
      name: 'Gov_Fn_Lab',
      resources: [{
        type: 'FUNCTION', name: 'label_for_region',
        arguments: [{ name: 'p_region', type: 'STRING' }],
        returnType: 'STRING',
        body: "BEGIN RETURN p_region || '-' || to_char(NOW(), 'YYYY'); END;",
      }],
    }],
  }, { headers: H(token) });
  console.log('provisioned function Gov_Fn_Lab.label_for_region(p_region)\n');

  // (a) POST /api/data/call.
  const ast = await axios.post(`${BASE}/data/call`, { schema: 'Gov_Fn_Lab', function: 'label_for_region', args: ['EU'] }, { headers: H(token) });
  const astVal = ast.data.data?.[0]?.label_for_region;
  console.log(`  [data/call]   label_for_region('EU') = ${astVal}  (strategy=${ast.data.plan?.strategy})`);

  // (b) the same call as an AST query of type CALL.
  const q = await axios.post(`${BASE}/analytics/query`, {
    queryConfig: { type: 'CALL', schema: 'Gov_Fn_Lab', function: 'label_for_region', args: ['EU'] }
  }, { headers: H(token) });
  const qVal = q.data.data?.[0]?.label_for_region;
  console.log(`  [CALL query]  label_for_region('EU') = ${qVal}`);

  const ok = !!astVal && astVal === qVal;
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'} same result from both call paths`);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
