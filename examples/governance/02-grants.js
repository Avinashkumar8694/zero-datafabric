/* eslint-disable no-console */
/**
 * 02 — GRANT enforcement on a non-SQL engine (MongoDB).
 *
 * Mongo/ES have no table privileges. When a table has declared grants, the
 * fabric's Grant engine gates reads/writes by the session role — the same
 * allow/deny Postgres would make. ADMIN bypasses; un-governed tables are
 * default-allow. An ADMIN may `x-act-as-role: <role>` to test as another role.
 *
 * Grant: ANALYST may SELECT (not INSERT) on gov_lab.inventory.
 */
const axios = require('axios');
const { banner } = require('../_client');
const { BASE, login, H, seed, register, create, fetch } = require('./_lib');

async function run() {
  banner('02 — grant enforcement on MongoDB (role/privilege gate)');
  const token = await login();
  await seed(); await register();

  await axios.post(`${BASE}/grants`, {
    schema: 'gov_lab', table: 'inventory',
    grants: [{ role: 'ANALYST', privileges: ['SELECT'] }],
  }, { headers: H(token) });
  console.log('granted ANALYST=SELECT on gov_lab.inventory\n');

  const asAnalyst = { 'x-act-as-role': 'ANALYST' };
  const asGuest = { 'x-act-as-role': 'GUEST' };

  const readAnalyst = await fetch(token, asAnalyst);
  const readGuest = await fetch(token, asGuest);
  const writeAnalyst = await create(token, { sku: `G-${Date.now()}`, qty: 1, status: 'ACTIVE', warehouse_id: 'WH1' }, asAnalyst);
  const writeAdmin = await create(token, { sku: `A-${Date.now()}`, qty: 1, status: 'ACTIVE', warehouse_id: 'WH1' });

  const rows = [
    ['READ  as ANALYST (has SELECT)', readAnalyst.ok, true],
    ['READ  as GUEST   (no grant)  ', readGuest.ok, false],
    ['WRITE as ANALYST (no INSERT) ', writeAnalyst.ok, false],
    ['WRITE as ADMIN   (bypass)    ', writeAdmin.ok, true],
  ];
  let pass = 0;
  for (const [label, ok, expected] of rows) {
    const good = ok === expected;
    if (good) pass++;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label} → ${ok ? 'allowed' : 'denied (403)'}`);
  }
  console.log(`\n${pass}/${rows.length} grant decisions correct`);
  if (pass !== rows.length) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
