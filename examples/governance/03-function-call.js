/* eslint-disable no-console */
/**
 * 03 — FUNCTION / PROCEDURE call (fabric function-as-a-service), both modes.
 *
 * Functions/procedures are provisioned on the hub Postgres. The fabric exposes
 * them as a service callable from:
 *   • AST mode  — POST /api/data/call { function, args }  (or query {type:'CALL'})
 *   • SQL mode  — a `SELECT fn(...)` / `CALL proc(...)` string (hub passthrough)
 *
 * We apply a tiny manifest with a scalar function, then call it both ways and
 * confirm the same result. (For a non-SQL engine, this is how the fabric supplies
 * function values that Mongo/ES can't compute themselves.)
 */
const axios = require('axios');
const { banner } = require('../_client');
const { BASE, login, H } = require('./_lib');

async function run() {
  banner('03 — function-as-a-service (AST CALL + SQL passthrough)');
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

  // (a) AST mode — POST /api/data/call.
  const ast = await axios.post(`${BASE}/data/call`, { schema: 'Gov_Fn_Lab', function: 'label_for_region', args: ['EU'] }, { headers: H(token) });
  const astVal = ast.data.data?.[0]?.label_for_region;
  console.log(`  [AST CALL]   label_for_region('EU') = ${astVal}  (strategy=${ast.data.plan?.strategy})`);

  // (b) SQL mode — passthrough on the hub.
  const sqlRes = await axios.post(`${BASE}/queries/exec`, { sql: `SELECT "tenant_${'tenant_A'}_Gov_Fn_Lab".label_for_region('EU') AS label` }, { headers: H(token) });
  const sqlVal = (sqlRes.data.results?.results || sqlRes.data.results || [])[0]?.label;
  console.log(`  [SQL exec]   label_for_region('EU') = ${sqlVal}`);

  const ok = !!astVal && astVal === sqlVal;
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'} same result from AST CALL and SQL — function callable in both modes`);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
