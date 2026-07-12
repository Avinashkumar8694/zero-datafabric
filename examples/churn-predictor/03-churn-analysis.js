/**
 * High-Value Churn Predictor — the multi-datasource "mega-query", realized on the
 * fabric. Mirrors the conceptual CTE SQL:
 *
 *   Target_Accounts   ← CRM (Postgres)          Enterprise, ARR>50k, renewal ≤ 90d
 *   Product_Engagement← Product_Logs (Mongo)    Core_Feature_Used: last-30d vs prev-30d
 *   Support_Friction  ← Support (Elasticsearch) open Urgent tickets + avg CSAT
 *   Negative_Sentiment← Support (Elasticsearch) full-text on ticket body
 *   Final stitch      ← threshold: engagement drop >40% AND ≥2 open urgent tickets
 *                       → revenue (ARR) at risk
 *
 * Each source does its own filtered/aggregated work (pushed down — see the trace);
 * the fabric drives the CRM account set as bind-join keys into Mongo + ES and the
 * script stitches the bounded partials. This is how a federated engine executes
 * such a query without moving whole tables.
 *
 * Run (backend up on :4000):  node 03-churn-analysis.js
 */
const http = require('http');
const BASE = 'http://localhost:4000/api';
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token, 'x-tenant-id': 'tenant_A' } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => {
      try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); }
    }); });
    r.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    if (data) r.write(data); r.end();
  });
}
let TOKEN;
async function q(label, query, limit = 5000) {
  const r = await req('POST', '/analytics/query', TOKEN, { queryConfig: { type: 'SELECT', schema: 'public', limit, query } });
  if (r.status !== 200) throw new Error(`${label}: ${r.json?.error}`);
  const leg = (r.json.plan?.legs || [])[0] || {};
  console.log(`  ${label}: ${r.json.rowCount} rows · ${leg.engine}/${leg.mode} ${leg.operation} · ${r.json.plan?.executionMs}ms`);
  console.log(`      ↳ ${String(leg.query).slice(0, 130)}`);
  return r.json.data || [];
}
const DAY = 86400000;

(async () => {
  const login = await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' });
  TOKEN = login.json?.token;
  if (!TOKEN) { console.log('LOGIN FAILED'); process.exit(1); }

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const plus90 = new Date(now + 90 * DAY).toISOString().slice(0, 10);
  const cur_lo = now - 30 * DAY;
  const prev_lo = now - 60 * DAY, prev_hi = now - 30 * DAY;

  console.log('HIGH-VALUE CHURN PREDICTOR — federated across CRM(PG) + Product_Logs(Mongo) + Support(ES)\n');

  // 1) Target accounts from CRM (Postgres) — filter pushed down.
  console.log('[1] Target_Accounts  (CRM / PostgreSQL)');
  const targets = await q('Enterprise, ARR>50k, renewal≤90d', {
    from: { resource: 'accounts', source: 'CRM_Salesforce' },
    select: ['account_id', 'company_name', 'arr', 'renewal_date'],
    where: [
      { column: 'account_tier', operator: 'EQ', value: 'Enterprise' },
      { column: 'arr', operator: 'GT', value: 50000 },
      { column: 'renewal_date', operator: 'GTE', value: today },
      { column: 'renewal_date', operator: 'LTE', value: plus90 },
    ],
  });
  const ids = targets.map((t) => t.account_id).slice(0, 1000);
  const acct = Object.fromEntries(targets.map((t) => [t.account_id, t]));
  console.log(`      → ${targets.length} candidate accounts (driving keys for the other sources)\n`);
  if (!ids.length) { console.log('No candidate accounts.'); process.exit(0); }

  // 2) Product engagement (Mongo) — two windowed COUNT aggregates, pushed as $group.
  console.log('[2] Product_Engagement  (Product_Logs / MongoDB, $group pushdown)');
  const curAgg = await q('Core_Feature_Used clicks — last 30d', {
    from: { resource: 'user_events', source: 'Product_Logs' }, groupBy: ['account_id'],
    select: ['account_id', { aggregate: 'COUNT', column: '*', alias: 'clicks' }],
    where: [ { column: 'event_name', operator: 'EQ', value: 'Core_Feature_Used' },
             { column: 'account_id', operator: 'IN', value: ids },
             { column: 'event_time', operator: 'GTE', value: cur_lo } ],
  });
  const prevAgg = await q('Core_Feature_Used clicks — prev 30d', {
    from: { resource: 'user_events', source: 'Product_Logs' }, groupBy: ['account_id'],
    select: ['account_id', { aggregate: 'COUNT', column: '*', alias: 'clicks' }],
    where: [ { column: 'event_name', operator: 'EQ', value: 'Core_Feature_Used' },
             { column: 'account_id', operator: 'IN', value: ids },
             { column: 'event_time', operator: 'GTE', value: prev_lo },
             { column: 'event_time', operator: 'LT', value: prev_hi } ],
  });
  const cur = Object.fromEntries(curAgg.map((r) => [r.account_id, Number(r.clicks)]));
  const prev = Object.fromEntries(prevAgg.map((r) => [r.account_id, Number(r.clicks)]));
  console.log('');

  // 3) Support friction (Elasticsearch) — terms agg on account_id, pushed down.
  console.log('[3] Support_Friction  (Support / Elasticsearch, terms+metric aggs)');
  const friction = await q('open Urgent tickets + avg CSAT by account', {
    from: { resource: 'support_tickets', source: 'Support_ES' }, groupBy: ['account_id'],
    select: ['account_id', { aggregate: 'COUNT', column: '*', alias: 'open_urgent' }, { aggregate: 'AVG', column: 'csat', alias: 'avg_csat' }],
    where: [ { column: 'priority', operator: 'EQ', value: 'Urgent' },
             { column: 'status', operator: 'IN', value: ['Open', 'Pending'] },
             { column: 'account_id', operator: 'IN', value: ids } ],
  });
  const fr = Object.fromEntries(friction.map((r) => [r.account_id, r]));
  console.log('');

  // 4) Negative sentiment (Elasticsearch) — full-text MATCH on ticket body.
  console.log('[4] Negative_Sentiment  (Support / Elasticsearch, full-text $match)');
  const sentiment = await q('tickets mentioning churn/competitor/outage language', {
    from: { resource: 'support_tickets', source: 'Support_ES' }, select: ['account_id', 'body'],
    where: [ { column: 'account_id', operator: 'IN', value: ids },
             { column: 'body', operator: 'MATCH', value: 'canceling competitor outage unacceptable frustrated' } ],
  });
  const negative = new Set(sentiment.map((r) => r.account_id));
  console.log('');

  // 5) Stitch + threshold: engagement drop >40% AND >=2 open urgent tickets.
  const atRisk = [];
  for (const id of ids) {
    const c = cur[id] || 0, p = prev[id] || 0;
    const ou = Number(fr[id]?.open_urgent || 0);
    const dropped = p > 0 && c < p * 0.6;      // >40% drop
    if (dropped && ou >= 2) {
      atRisk.push({
        company: acct[id].company_name, account_id: id, arr: Number(acct[id].arr),
        renewal: String(acct[id].renewal_date).slice(0, 10),
        prev_clicks: p, current_clicks: c,
        drop_pct: Math.round((1 - c / p) * 100),
        open_urgent: ou, avg_csat: fr[id]?.avg_csat ? Number(fr[id].avg_csat).toFixed(2) : '-',
        negative_sentiment: negative.has(id) ? 'YES' : 'no',
      });
    }
  }
  atRisk.sort((a, b) => b.arr - a.arr);
  const revenueAtRisk = atRisk.reduce((s, a) => s + a.arr, 0);

  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`AT-RISK ENTERPRISE ACCOUNTS: ${atRisk.length}   |   REVENUE AT RISK (ARR): $${revenueAtRisk.toLocaleString()}`);
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('company        acct   ARR        renewal      clicks(prev→cur)  drop  urgent  csat  negSentiment');
  for (const a of atRisk.slice(0, 20)) {
    console.log(
      `${a.company.padEnd(14)} ${String(a.account_id).padStart(4)}  $${String(a.arr).padStart(9)}  ${a.renewal}  ` +
      `${String(a.prev_clicks).padStart(4)}→${String(a.current_clicks).padStart(3)}         ${String(a.drop_pct).padStart(3)}%   ${String(a.open_urgent).padStart(3)}   ${String(a.avg_csat).padStart(4)}   ${a.negative_sentiment}`);
  }
  console.log('\nActionable insight: dispatch CS to these accounts before renewal — highest ARR first.');
})().catch((e) => { console.error('CHURN ANALYSIS FAILED:', e.message || e); process.exit(1); });
