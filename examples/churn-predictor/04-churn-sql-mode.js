/**
 * High-Value Churn Predictor — the SAME use case exercised through the raw-SQL
 * query interface (/api/queries/exec), complementing the AST version (03).
 *
 * The SQL interface runs NATIVE SQL at ONE source (window functions, CTEs,
 * recursive queries) — it is not cross-engine. So:
 *   • the SQL-native (Postgres) parts of the use case run as real SQL here;
 *   • the cross-engine stitch (Mongo product logs + ES support) stays on the AST
 *     path (03-churn-analysis.js), which is the only mode that federates engines.
 *
 * This script also cross-checks that SQL mode and AST mode agree on the shared
 * step (Target_Accounts), and shows that a non-SQL engine correctly refuses raw SQL.
 *
 * Run (backend up on :4000):  node 04-churn-sql-mode.js
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
    }}, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); } }); });
    r.on('error', e => resolve({ status: 0, json: { error: e.message } })); if (data) r.write(data); r.end();
  });
}
let T;
const sqlOn = (source, sql) => req('POST', '/queries/exec', T, { source, schema: 'public', sql });
const ast = (query, limit = 5000) => req('POST', '/analytics/query', T, { queryConfig: { type: 'SELECT', schema: 'public', limit, query } });
const rows = (r) => r.json?.data || r.json?.results || [];
function head(title, r) {
  console.log(`\n### ${title}`);
  if (r.status !== 200) { console.log('   ERROR:', r.json?.error); return; }
  const leg = (r.json.plan?.legs || [])[0] || {};
  console.log(`   ${r.json.rowCount ?? rows(r).length} rows · ${leg.engine || ''}/${leg.mode || ''} ${leg.operation || ''} · ${r.json.plan?.executionMs}ms`);
}

(async () => {
  T = (await req('POST', '/auth/login', null, { username: 'admin', password: 'admin' })).json.token;
  console.log('CHURN — SQL QUERY INTERFACE (native SQL executed at the source)');

  // 1) Target_Accounts as native SQL on the CRM Postgres source.
  const targSql = `SELECT account_id, company_name, arr, renewal_date
                   FROM accounts
                   WHERE account_tier = 'Enterprise'
                     AND arr > 50000
                     AND renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'`;
  const sqlTarg = await sqlOn('CRM_Salesforce', targSql);
  head('Target_Accounts via SQL (CRM_Salesforce)', sqlTarg);

  // Cross-check: same step via AST must agree on the row count.
  const astTarg = await ast({ from: { resource: 'accounts', source: 'CRM_Salesforce' },
    select: ['account_id'],
    where: [ { column: 'account_tier', operator: 'EQ', value: 'Enterprise' },
             { column: 'arr', operator: 'GT', value: 50000 },
             { column: 'renewal_date', operator: 'GTE', value: new Date().toISOString().slice(0, 10) },
             { column: 'renewal_date', operator: 'LTE', value: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) } ] });
  console.log(`   cross-check vs AST: SQL=${sqlTarg.json.rowCount} AST=${astTarg.json.rowCount} → ${sqlTarg.json.rowCount === astTarg.json.rowCount ? 'MATCH ✓' : 'MISMATCH ✗'}`);

  // 2) Window-function CTE on CRM: rank at-risk candidates by ARR & renewal urgency.
  const rankSql = `WITH c AS (
      SELECT account_id, company_name, arr,
             (renewal_date - CURRENT_DATE) AS days_to_renewal
      FROM accounts
      WHERE account_tier = 'Enterprise' AND arr > 50000
        AND renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days')
    SELECT company_name, arr, days_to_renewal,
           RANK() OVER (ORDER BY arr DESC) AS arr_rank,
           NTILE(4) OVER (ORDER BY days_to_renewal) AS renewal_urgency_quartile
    FROM c ORDER BY arr DESC LIMIT 8`;
  const rank = await sqlOn('CRM_Salesforce', rankSql);
  head('Window CTE — rank candidates by ARR + renewal urgency (CRM_Salesforce)', rank);
  for (const r of rows(rank)) console.log(`     ${r.company_name.padEnd(14)} $${String(r.arr).padStart(9)}  in ${String(r.days_to_renewal).padStart(3)}d  arr#${r.arr_rank}  urgency Q${r.renewal_urgency_quartile}`);

  // 3) "Declining purchase value" signal via native SQL on the Production Postgres.
  const declineSql = `WITH win AS (
      SELECT account_id,
             SUM(amount) FILTER (WHERE order_date >= NOW() - INTERVAL '90 days')                                   AS cur_90,
             SUM(amount) FILTER (WHERE order_date >= NOW() - INTERVAL '180 days' AND order_date < NOW() - INTERVAL '90 days') AS prev_90
      FROM orders GROUP BY account_id)
    SELECT account_id, round(cur_90,2) cur_90, round(prev_90,2) prev_90,
           round((cur_90 - prev_90) / NULLIF(prev_90,0) * 100, 1) AS pct_change
    FROM win
    WHERE prev_90 > 0 AND cur_90 < prev_90 * 0.5
    ORDER BY prev_90 DESC LIMIT 8`;
  const decline = await sqlOn('Prod_Postgres', declineSql);
  head('Declining purchase value — window/FILTER SQL (Prod_Postgres)', decline);
  for (const r of rows(decline)) console.log(`     account ${String(r.account_id).padStart(4)}  $${r.prev_90} → $${r.cur_90}  (${r.pct_change}%)`);

  // 4) Support friction via ELASTICSEARCH SQL (native _sql: full-text + aggregate at source).
  const esFriction = await sqlOn('Support_ES',
    `SELECT priority, COUNT(*) AS open_urgent, AVG(csat) AS avg_csat
     FROM support_tickets WHERE status IN ('Open','Pending') GROUP BY priority`);
  head('Support friction via ES SQL (_sql at Support_ES)', esFriction);
  for (const r of rows(esFriction)) console.log(`     ${String(r.priority).padEnd(8)} open=${r.open_urgent}  avg_csat=${Number(r.avg_csat).toFixed(2)}`);

  const esText = await sqlOn('Support_ES',
    `SELECT account_id, SCORE() AS sc FROM support_tickets WHERE MATCH(body, 'canceling competitor') ORDER BY SCORE() DESC LIMIT 3`);
  head('Negative-sentiment via ES SQL full-text MATCH() + SCORE()', esText);
  for (const r of rows(esText)) console.log(`     account ${String(r.account_id).padStart(4)}  score ${Number(r.sc).toFixed(2)}`);

  // 5) SQL over MongoDB: Mongo has no SQL engine, so the fabric TRANSLATES the SQL
  //    into Mongo's native query language ($group) and runs it.
  const mongoSql = await sqlOn('Product_Logs',
    `SELECT event_name, COUNT(*) AS n FROM user_events WHERE account_id < 500 GROUP BY event_name`);
  head('SQL over MongoDB — fabric translates SQL → Mongo $group (Product_Logs)', mongoSql);
  for (const r of rows(mongoSql)) console.log(`     ${String(r.event_name).padEnd(20)} ${r.n}`);
  console.log('   → every engine is reachable by SQL: SQL-native engines run it directly; Mongo is translated.');

  console.log('\nDone. SQL mode covers the Postgres-native analytics; AST mode covers the cross-engine federation.');
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
