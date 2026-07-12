/**
 * High-Value Churn Predictor — external data seeder.
 *
 * Seeds four genuinely-separate external stores the fabric federates over
 * (nothing in the fabric's own control-plane DB):
 *
 *   CRM_Salesforce  Postgres :5436 / crm        accounts (tier, ARR, renewal_date)
 *   Prod_Postgres   Postgres :5436 / prod_ops   orders (purchase history)
 *   Product_Logs    MongoDB  :27017 / product   user_events (clickstream)
 *   Support_ES      Elasticsearch :9200         support_tickets (status/priority/csat + full text)
 *
 * Keyed on account_id across all stores. A cohort of accounts is deliberately
 * engineered to be "at risk" (Enterprise, ARR>50k, renewal<90d, engagement drop
 * >40%, >=2 open urgent tickets, negative-sentiment ticket text) so the churn
 * query returns real results.
 *
 * Run:  NODE_PATH=../../backend/node_modules node 01-seed-sources.js
 */
const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const axios = require('axios');

const PG = { host: 'localhost', port: 5436, user: 'remote_admin', password: 'remote_password' };
const MONGO_URI = 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';
const ES = 'http://localhost:9200';

const N_ACCOUNTS = 2000;
const N_ORDERS = 12000;
const N_EVENTS = 40000;
const N_TICKETS = 8000;
const AT_RISK = 12; // first 12 accounts are engineered to be at risk

const TIERS = ['Enterprise', 'SMB'];
const REGIONS = ['NA', 'EU', 'APAC', 'LATAM'];
const EVENTS = ['Core_Feature_Used', 'Login', 'Report_Exported', 'Settings_Changed'];
const NEG_PHRASES = ['considering a competitor', 'unacceptable delay', 'canceling our contract', 'repeated outage', 'extremely frustrated'];
const POS_PHRASES = ['great support', 'works perfectly', 'thanks for the quick fix', 'very happy with the product'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const money = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
const iso = (dt) => dt.toISOString();
const day = (dt) => dt.toISOString().slice(0, 10);

async function bulkInsert(c, table, cols, rows, chunk = 1000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const tuples = slice.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
    await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}
const isAtRisk = (id) => id <= AT_RISK;

async function seedCrm() {
  const c = new Client({ ...PG, database: 'crm' });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS accounts CASCADE`);
  await c.query(`CREATE TABLE accounts (
    account_id INTEGER PRIMARY KEY, company_name TEXT NOT NULL, account_tier TEXT NOT NULL,
    arr NUMERIC(12,2) NOT NULL, renewal_date DATE NOT NULL, region TEXT NOT NULL)`);
  const rows = [];
  for (let id = 1; id <= N_ACCOUNTS; id++) {
    const risk = isAtRisk(id);
    // At-risk cohort: Enterprise, high ARR, renewal within 90 days.
    const tier = risk ? 'Enterprise' : pick(TIERS);
    const arr = risk ? money(60000, 400000) : (tier === 'Enterprise' ? money(50000, 500000) : money(2000, 49000));
    const renewal = risk ? daysFromNow(5 + rnd(80)) : daysFromNow(rnd(500) - 30);
    rows.push([id, `Company_${id}`, tier, arr, day(renewal), pick(REGIONS)]);
  }
  await bulkInsert(c, 'accounts', ['account_id', 'company_name', 'account_tier', 'arr', 'renewal_date', 'region'], rows);
  await c.query(`CREATE INDEX ix_acc_tier ON accounts(account_tier)`);
  await c.query(`CREATE INDEX ix_acc_renewal ON accounts(renewal_date)`);
  console.log(`[CRM_Salesforce] accounts = ${N_ACCOUNTS} (first ${AT_RISK} engineered at-risk)`);
  await c.end();
}

async function seedProd() {
  const c = new Client({ ...PG, database: 'prod_ops' });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS orders CASCADE`);
  await c.query(`CREATE TABLE orders (
    order_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, order_date TIMESTAMP NOT NULL, amount NUMERIC(12,2) NOT NULL)`);
  const rows = [];
  for (let id = 1; id <= N_ORDERS; id++) {
    rows.push([id, 1 + rnd(N_ACCOUNTS), iso(daysFromNow(-rnd(365))), money(500, 25000)]);
  }
  await bulkInsert(c, 'orders', ['order_id', 'account_id', 'order_date', 'amount'], rows);
  await c.query(`CREATE INDEX ix_ord_account ON orders(account_id)`);
  console.log(`[Prod_Postgres] orders = ${N_ORDERS}`);
  await c.end();
}

async function seedProductLogs() {
  const mc = new MongoClient(MONGO_URI);
  await mc.connect();
  const db = mc.db('product');
  await db.collection('user_events').drop().catch(() => {});
  const events = [];
  for (let i = 1; i <= N_EVENTS; i++) {
    const acct = 1 + rnd(N_ACCOUNTS);
    const risk = isAtRisk(acct);
    // At-risk accounts: core-feature events concentrated in the PREVIOUS window
    // (31-60d ago) and sparse in the last 30d → a sharp engagement drop.
    let ageDays;
    if (risk) ageDays = Math.random() < 0.85 ? 31 + rnd(30) : rnd(30);
    else ageDays = rnd(60);
    const when = daysFromNow(-ageDays);
    events.push({
      event_id: i, account_id: acct,
      event_name: Math.random() < 0.6 ? 'Core_Feature_Used' : pick(EVENTS),
      // epoch-ms (number) so cross-engine range filters compare cleanly in Mongo
      // (Mongo won't match a Date field against an ISO string — strict BSON types).
      event_time: when.getTime(),
      event_date: iso(when),
      user_email: `user${rnd(9000)}@company-${acct}.io`,
    });
  }
  for (let i = 0; i < events.length; i += 5000) await db.collection('user_events').insertMany(events.slice(i, i + 5000));
  await db.collection('user_events').createIndex({ account_id: 1 });
  await db.collection('user_events').createIndex({ event_name: 1, event_time: 1 });
  console.log(`[Product_Logs] user_events = ${N_EVENTS}`);
  await mc.close();
}

async function seedSupportES() {
  // (re)create index with an explicit mapping: keyword facets + analyzed text body.
  await axios.delete(`${ES}/support_tickets`).catch(() => {});
  await axios.put(`${ES}/support_tickets`, {
    mappings: { properties: {
      ticket_id: { type: 'integer' }, account_id: { type: 'integer' },
      status: { type: 'keyword' }, priority: { type: 'keyword' },
      csat: { type: 'float' }, subject: { type: 'text' }, body: { type: 'text' },
      created_at: { type: 'date' },
    } },
  }, { headers: { 'Content-Type': 'application/json' } });

  const STATUS = ['Open', 'Pending', 'Solved'];
  const PRIORITY = ['Urgent', 'High', 'Normal'];
  let bulk = '';
  for (let id = 1; id <= N_TICKETS; id++) {
    const acct = 1 + rnd(N_ACCOUNTS);
    const risk = isAtRisk(acct);
    const status = risk ? pick(['Open', 'Pending']) : pick(STATUS);
    const priority = risk ? 'Urgent' : pick(PRIORITY);
    const negative = risk && Math.random() < 0.6;
    const body = negative ? `We are ${pick(NEG_PHRASES)} and ${pick(NEG_PHRASES)}.` : `${pick(POS_PHRASES)}.`;
    const doc = {
      ticket_id: id, account_id: acct, status, priority,
      csat: risk ? money(1, 3) : money(3, 5),
      subject: negative ? 'Escalation' : 'General inquiry',
      body, created_at: iso(daysFromNow(-rnd(30))),
    };
    bulk += JSON.stringify({ index: { _index: 'support_tickets', _id: String(id) } }) + '\n' + JSON.stringify(doc) + '\n';
    if (id % 2000 === 0) { await axios.post(`${ES}/_bulk`, bulk, { headers: { 'Content-Type': 'application/x-ndjson' } }); bulk = ''; }
  }
  if (bulk) await axios.post(`${ES}/_bulk`, bulk, { headers: { 'Content-Type': 'application/x-ndjson' } });
  await axios.post(`${ES}/support_tickets/_refresh`);
  const count = (await axios.get(`${ES}/support_tickets/_count`)).data.count;
  console.log(`[Support_ES] support_tickets = ${count}`);
}

(async () => {
  const t = Date.now();
  await seedCrm();
  await seedProd();
  await seedProductLogs();
  await seedSupportES();
  console.log(`\nAll churn sources seeded in ${((Date.now() - t) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error('SEED FAILED:', e.message || e); process.exit(1); });
