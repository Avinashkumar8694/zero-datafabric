/* eslint-disable no-console */
/**
 * 02 — API/UI ACTION triggers (every execute.type).
 *
 * Creation path: TRIGGER REGISTRY API (also how the Triggers UI page creates them).
 *
 * A registry trigger has `definition: { event, execute: { type, ... } }`. On
 * deploy, the trigger-engine microservice compiles a native trigger whose body
 * enqueues a durable EXECUTE_TRIGGER_ACTION job (or PERFORMs a function / RAISEs
 * an exception inline). The worker then dispatches the action. This script
 * exercises ALL action types:
 *
 *   AUDIT     — writes fabric_admin.audit_logs (fully verified here)
 *   WEBHOOK   — HTTP POST with header/body templating + OIDC/BEARER/BASIC auth
 *   EMAIL     — SMTP send with conditional {{?a|b|c}} templates
 *   TELEGRAM  — bot sendMessage
 *   FUNCTION  — PERFORM a plpgsql function inline (no job)
 *   EXCEPTION — RAISE to block the write when a WHEN condition holds
 *
 * WEBHOOK/EMAIL/TELEGRAM attempt real delivery; without a configured channel
 * they land in the logs as errors — that is expected and still demonstrates the
 * dispatch path. AUDIT / FUNCTION / EXCEPTION are verified deterministically.
 */
const { login, banner, authHeaders, BASE_URL } = require('../_client');
const axios = require('axios');
const {
  applyManifest, upsertTrigger, deploy, waitForDrain, insertRow, auditCountForTable, selectSql, sleep
} = require('./_lib');

const LOGICAL = 'Trg_Action_Lab';
const PHYSICAL = 'tenant_tenant_A_Trg_Action_Lab';
const TABLE = 'orders';

async function run() {
  banner('02 — API/UI action triggers (AUDIT/WEBHOOK/EMAIL/TELEGRAM/FUNCTION/EXCEPTION)');
  const token = await login();

  // Lab table + a trigger function target for the FUNCTION action.
  await applyManifest(token, {
    version: `trg-action-lab-${Date.now()}`,
    schemas: [{
      name: LOGICAL,
      resources: [
        {
          type: 'TABLE',
          name: TABLE,
          columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'status', type: 'TEXT' },
            { name: 'amount', type: 'INT' },
            { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()' }
          ]
        },
        {
          // Side-effect function invoked by the FUNCTION action. The engine emits
          // `PERFORM fn()` (no args, no NEW), so this is a parameterless VOID
          // function — it records that the trigger ran by inserting a marker row.
          type: 'FUNCTION',
          name: 'fn_order_touch',
          returnType: 'VOID',
          body: "BEGIN INSERT INTO \"" + PHYSICAL + "\".marker(note) VALUES ('order-trigger-fired'); END;"
        },
        {
          type: 'TABLE',
          name: 'marker',
          columns: [
            { name: 'id', type: 'SERIAL', primaryKey: true },
            { name: 'note', type: 'TEXT' }
          ]
        }
      ]
    }]
  });

  const defs = [
    {
      triggerName: 'trg_order_audit', schemaName: PHYSICAL, tableName: TABLE,
      definition: { event: 'AFTER_INSERT', execute: { type: 'AUDIT' } }
    },
    {
      triggerName: 'trg_order_webhook', schemaName: PHYSICAL, tableName: TABLE,
      definition: {
        event: 'AFTER_INSERT',
        execute: {
          type: 'WEBHOOK', url: 'https://example.local/orders', method: 'POST',
          headers: { 'x-correlation-id': '{{triggerName}}-{{newRow.id}}' },
          auth: {
            type: 'OIDC', tokenEndpoint: 'https://idp.example.com/oauth/token',
            clientId: 'fabric-webhook', clientSecret: 'dummy', audience: 'https://api.partner.example.com', scope: 'events.publish'
          },
          payload: { event: '{{event}}', order: '{{newRow.id}}', amount: '{{newRow.amount}}' }
        }
      }
    },
    {
      triggerName: 'trg_order_email', schemaName: PHYSICAL, tableName: TABLE,
      definition: {
        event: 'AFTER_INSERT',
        execute: {
          type: 'EMAIL',
          params: {
            to: 'ops@example.com',
            subject: 'Order {{newRow.id}} placed',
            text: 'Order {{newRow.id}} amount={{newRow.amount}} priority={{?newRow.amount>100|HIGH|NORMAL}}',
            html: '<p>Order <b>{{newRow.id}}</b> — {{?newRow.amount>100|High value|Standard}}</p>'
          }
        }
      }
    },
    {
      triggerName: 'trg_order_telegram', schemaName: PHYSICAL, tableName: TABLE,
      definition: { event: 'AFTER_INSERT', execute: { type: 'TELEGRAM', params: { chatId: '@fabric_alerts', text: 'New order {{newRow.id}}' } } }
    },
    {
      triggerName: 'trg_order_function', schemaName: PHYSICAL, tableName: TABLE,
      definition: { event: 'AFTER_INSERT', execute: { type: 'FUNCTION', name: 'fn_order_touch' } }
    },
    {
      triggerName: 'trg_order_guard', schemaName: PHYSICAL, tableName: TABLE,
      definition: {
        event: 'BEFORE_INSERT',
        execute: { type: 'EXCEPTION', message: 'order amount exceeds limit', when: { left: 'NEW.amount', operator: 'GT', right: '100000' } }
      }
    }
  ];

  for (const d of defs) {
    const row = await upsertTrigger(token, d);
    await deploy(token, row.id);
  }
  await waitForDrain(token); // let the MS deploy all native triggers

  const auditBefore = await auditCountForTable(token, TABLE);

  // A normal order — fires AUDIT/WEBHOOK/EMAIL/TELEGRAM/FUNCTION.
  await insertRow(token, LOGICAL, TABLE, { id: `ord-${Date.now()}`, status: 'NEW', amount: 250 });

  // An over-limit order — the EXCEPTION guard must block it (insert fails on purpose).
  await insertRow(token, LOGICAL, TABLE, { id: `ord-huge-${Date.now()}`, status: 'NEW', amount: 999999 }, { allowFail: true });

  await waitForDrain(token);
  await sleep(500);

  const auditAfter = await auditCountForTable(token, TABLE);
  console.log(`AUDIT: audit_logs for '${TABLE}' ${auditBefore} -> ${auditAfter} (${auditAfter > auditBefore ? 'PASS' : 'FAIL'})`);

  // FUNCTION: fn_order_touch inserted a marker row synchronously (PERFORM in the trigger).
  const marker = await selectSql(token, `SELECT count(*)::int AS n FROM "${PHYSICAL}".marker`);
  const markerN = Number(marker[0] && marker[0].n || 0);
  console.log(`FUNCTION: marker rows = ${markerN} (${markerN > 0 ? 'PASS' : 'FAIL'})`);

  // EXCEPTION: the over-limit order must NOT exist (the guard blocked it).
  const huge = await selectSql(token, `SELECT count(*)::int AS n FROM "${PHYSICAL}"."${TABLE}" WHERE amount > 100000`);
  const hugeN = Number(huge[0] && huge[0].n || 0);
  console.log(`EXCEPTION: over-limit orders present = ${hugeN} (${hugeN === 0 ? 'PASS (blocked)' : 'FAIL'})`);

  const logs = (await axios.get(`${BASE_URL}/triggers/logs/list?limit=25`, { headers: authHeaders(token) })).data || [];
  const byAction = {};
  for (const l of logs) byAction[l.action] = (byAction[l.action] || 0) + 1;
  console.log('recent trigger_execution_logs by action:', byAction);
  console.log('(WEBHOOK/EMAIL/TELEGRAM may show errors without a live channel — that is the dispatch path working.)');

  if (auditAfter <= auditBefore || markerN === 0 || hugeN !== 0) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
