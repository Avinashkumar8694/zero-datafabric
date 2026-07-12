/* eslint-disable no-console */
/**
 * 01 — CONSTRAINT enforcement on a non-SQL engine (MongoDB).
 *
 * Mongo has no NOT NULL / CHECK / ENUM / FK. The fabric's Constraint engine
 * validates the write payload IN-FABRIC before it reaches Mongo and rejects
 * violations with a clear 400 — the same guarantee Postgres gives natively.
 *
 * We register an engine-agnostic constraint spec on `gov_lab.inventory`:
 *   sku           NOT NULL, UNIQUE
 *   status        ENUM(ACTIVE, DISCONTINUED)
 *   warehouse_id  FK → warehouses.id
 *   qty           CHECK >= 0
 * then exercise a valid write plus one write per violation type.
 */
const axios = require('axios');
const { banner } = require('../_client');
const { BASE, login, H, seed, register, create } = require('./_lib');

async function run() {
  banner('01 — constraint enforcement on MongoDB writes');
  const token = await login();
  await seed(); await register();

  await axios.post(`${BASE}/constraints`, {
    schema: 'gov_lab', table: 'inventory',
    columns: [
      { name: 'sku', notNull: true, unique: true },
      { name: 'status', enum: ['ACTIVE', 'DISCONTINUED'] },
      { name: 'warehouse_id', fk: { source: 'Gov_Lab', schema: 'gov_lab', table: 'warehouses', column: 'id' } },
    ],
    checks: [{ name: 'qty_non_negative', column: 'qty', op: 'GTE', value: 0 }],
  }, { headers: H(token) });
  console.log('registered constraints on gov_lab.inventory\n');

  const cases = [
    ['valid row',           { sku: 'SKU-2', qty: 10, status: 'ACTIVE', warehouse_id: 'WH2' }, true],
    ['NOT NULL (sku null)', { sku: null, qty: 1, status: 'ACTIVE', warehouse_id: 'WH1' }, false],
    ['UNIQUE (sku dup)',    { sku: 'SKU-1', qty: 1, status: 'ACTIVE', warehouse_id: 'WH1' }, false],
    ['ENUM (bad status)',   { sku: 'SKU-3', qty: 1, status: 'FROZEN', warehouse_id: 'WH1' }, false],
    ['CHECK (qty < 0)',     { sku: 'SKU-4', qty: -5, status: 'ACTIVE', warehouse_id: 'WH1' }, false],
    ['FK (missing wh)',     { sku: 'SKU-5', qty: 1, status: 'ACTIVE', warehouse_id: 'WH9' }, false],
  ];
  let pass = 0;
  for (const [label, data, shouldSucceed] of cases) {
    const res = await create(token, data);
    const good = res.ok === shouldSucceed;
    if (good) pass++;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} → ${res.ok ? 'accepted' : `rejected(${res.status}): ${res.error}`}`);
  }
  console.log(`\n${pass}/${cases.length} constraint cases behaved correctly`);
  if (pass !== cases.length) process.exitCode = 1;
}

if (require.main === module) run().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
module.exports = { run };
