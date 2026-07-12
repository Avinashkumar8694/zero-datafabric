/* eslint-disable no-console */
/**
 * 06 — Declarative authoring (no hand-written plpgsql) + control-plane
 *      visibility + delete cleanup.
 *
 * A manifest trigger can declare its behaviour three ways — none require you to
 * write a plpgsql function body:
 *
 *   • action  — a mini SQL/AST DSL:
 *       { type:'INSERT', into:'audit', values:{ order_id:'NEW.id', op:'TG_OP', at:'NOW()' } }
 *       { type:'RAISE',  when:{left:'NEW.amount',operator:'GT',right:'100000'}, message:'…' }
 *       { type:'UPDATE'|'DELETE'|'PERFORM' … }   or   { sql:'…single statement…' }
 *   • execute — the same declarative action model as API/UI triggers
 *       ({ type:'AUDIT'|'WEBHOOK'|'EMAIL'|'TELEGRAM'|'FUNCTION'|'EXCEPTION' })
 *   • procedure — EXECUTE an existing trigger function (advanced escape hatch)
 *
 * Value expressions are compiled through a safe whitelist (NEW./OLD. columns,
 * TG_OP / NOW() / literals) — nothing authored here can inject SQL.
 *
 * This script also proves:
 *   (a) EVERY manifest trigger shows up in the trigger control plane
 *       (trigger_registry, source=MANIFEST) alongside API/UI triggers;
 *   (b) deleting a trigger CANCELS its still-pending jobs (a future RELATIVE
 *       action here) so nothing fires after the trigger is gone.
 */
const { login, banner, authHeaders, BASE_URL } = require('../_client');
const axios = require('axios');
const {
  applyManifest, upsertTrigger, deploy, waitForDrain, insertRow, selectSql, sleep
} = require('./_lib');

const LOGICAL = 'Trg_Declarative_Lab';
const PHYSICAL = 'tenant_tenant_A_Trg_Declarative_Lab';

async function run() {
  banner('06 — declarative authoring + control plane + delete cleanup');
  const token = await login();

  // One manifest, three trigger authoring styles — ZERO plpgsql bodies.
  await applyManifest(token, {
    version: `trg-declarative-lab-${Date.now()}`,
    schemas: [{
      name: LOGICAL,
      resources: [
        {
          type: 'TABLE', name: 'orders',
          columns: [
            { name: 'id', type: 'TEXT', primaryKey: true },
            { name: 'amount', type: 'INT' },
            { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()' }
          ],
          triggers: [
            {
              // (1) mini-DSL INSERT — write an audit trail row, no function body.
              name: 'trg_orders_audit_trail',
              timing: 'AFTER', events: ['INSERT', 'UPDATE'],
              action: {
                type: 'INSERT', into: 'order_events',
                values: { order_id: 'NEW.id', op: 'TG_OP', amount: 'NEW.amount', at: 'NOW()' }
              }
            },
            {
              // (2) mini-DSL RAISE — a business-rule guard.
              name: 'trg_orders_guard',
              timing: 'BEFORE', events: ['INSERT'],
              action: { type: 'RAISE', when: { left: 'NEW.amount', operator: 'GT', right: '100000' }, message: 'order amount exceeds limit' }
            },
            {
              // (3) declarative execute — the built-in AUDIT action.
              name: 'trg_orders_builtin_audit',
              timing: 'AFTER', events: ['INSERT'],
              execute: { type: 'AUDIT' }
            }
          ]
        },
        {
          type: 'TABLE', name: 'order_events',
          columns: [
            { name: 'id', type: 'SERIAL', primaryKey: true },
            { name: 'order_id', type: 'TEXT' },
            { name: 'op', type: 'TEXT' },
            { name: 'amount', type: 'INT' },
            { name: 'at', type: 'TIMESTAMP' }
          ]
        }
      ]
    }]
  });

  // (a) Control-plane visibility — every manifest trigger is registered.
  const registry = (await axios.get(`${BASE_URL}/triggers`, { headers: authHeaders(token) })).data || [];
  const mine = registry.filter((t) => (t.schemaName || '').includes('Trg_Declarative_Lab'));
  console.log('\ncontrol plane (source=MANIFEST):');
  for (const t of mine) {
    const d = t.definition || {};
    console.log(`  ${(t.triggerName || '').padEnd(28)} status=${t.status} source=${d.source} kind=${d.kind}`);
  }
  const visible = ['trg_orders_audit_trail', 'trg_orders_guard', 'trg_orders_builtin_audit'].every(
    (n) => mine.some((t) => t.triggerName === n && (t.definition || {}).source === 'MANIFEST')
  );
  console.log(`  ${visible ? 'PASS' : 'FAIL'} all manifest triggers appear in the control plane`);

  // Fire the DSL: a normal order writes an audit row; an over-limit order is blocked.
  await insertRow(token, LOGICAL, 'orders', { id: `ord-${Date.now()}`, amount: 500 });
  await insertRow(token, LOGICAL, 'orders', { id: `ord-big-${Date.now()}`, amount: 999999 }, { allowFail: true });
  await sleep(400);

  const events = await selectSql(token, `SELECT count(*)::int AS n FROM "${PHYSICAL}".order_events`);
  const blocked = await selectSql(token, `SELECT count(*)::int AS n FROM "${PHYSICAL}".orders WHERE amount > 100000`);
  const eventsN = Number(events[0] && events[0].n || 0);
  const blockedN = Number(blocked[0] && blocked[0].n || 0);
  console.log(`\nmini-DSL INSERT wrote order_events = ${eventsN} (${eventsN > 0 ? 'PASS' : 'FAIL'})`);
  console.log(`mini-DSL RAISE blocked over-limit order, present = ${blockedN} (${blockedN === 0 ? 'PASS' : 'FAIL'})`);

  // (b) Delete cleanup — a RELATIVE trigger with a future action job, then delete.
  const rel = await upsertTrigger(token, {
    triggerName: 'trg_orders_delayed', schemaName: PHYSICAL, tableName: 'orders',
    definition: { event: 'AFTER_INSERT', execute: { type: 'AUDIT' }, schedule: { type: 'RELATIVE', after: 60, unit: 'MINUTE' } }
  });
  await deploy(token, rel.id);
  await waitForDrain(token);
  await insertRow(token, LOGICAL, 'orders', { id: `ord-delay-${Date.now()}`, amount: 5 });
  await sleep(1000);

  const before = await selectSql(token,
    `SELECT status FROM public.trigger_jobs WHERE payload->>'triggerName'='trg_orders_delayed' AND job_type='EXECUTE_TRIGGER_ACTION' ORDER BY created_at DESC LIMIT 1`);
  console.log(`\nfuture RELATIVE action job before delete: ${before[0] && before[0].status}`);

  await axios.delete(`${BASE_URL}/triggers/${rel.id}`, { headers: authHeaders(token) });
  await waitForDrain(token, 8);
  await sleep(800);

  const after = await selectSql(token,
    `SELECT status FROM public.trigger_jobs WHERE payload->>'triggerName'='trg_orders_delayed' AND job_type='EXECUTE_TRIGGER_ACTION' ORDER BY created_at DESC LIMIT 1`);
  const cancelled = after[0] && after[0].status === 'CANCELLED';
  console.log(`future RELATIVE action job after delete:  ${after[0] && after[0].status} (${cancelled ? 'PASS — cancelled, will not fire' : 'FAIL'})`);

  if (!visible || eventsN === 0 || blockedN !== 0 || !cancelled) process.exitCode = 1;
}

if (require.main === module) {
  run().catch((err) => { console.error(err.response?.data || err.message); process.exit(1); });
}

module.exports = { run };
