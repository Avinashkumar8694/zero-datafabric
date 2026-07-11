/* eslint-disable no-console */
/**
 * 01 — MANIFEST DB-procedure trigger (native Postgres CREATE TRIGGER).
 *
 * Creation path: METADATA MANIFEST.
 *
 * A TABLE resource may declare `triggers: [{ name, timing, events, procedure }]`.
 * The orchestrator transpiles each one natively (TriggerService.transpileTriggerSql)
 * into:
 *     CREATE TRIGGER "<name>" <timing> <events> ON <schema>.<table>
 *     FOR EACH ROW EXECUTE FUNCTION <procedure>();
 *
 * Here the procedure is the fabric primitive `public.audit_log_fn()`, which
 * writes an entry to fabric_admin.audit_logs on every change. We prove the
 * trigger really fires by inserting a row and watching the audit count rise.
 *
 * This is the "trigger created using manifest" path the platform must support.
 */
const { login } = require('../_client');
const { banner } = require('../_client');
const { applyManifest, insertRow, auditCountForTable, sleep } = require('./_lib');

const LOGICAL_SCHEMA = 'Trg_Manifest_Lab';
const PHYSICAL_SCHEMA = 'tenant_tenant_A_Trg_Manifest_Lab';
const TABLE = 'shipments';

async function run() {
  banner('01 — Manifest DB-procedure trigger (native CREATE TRIGGER)');
  const token = await login();

  await applyManifest(token, {
    version: `trg-manifest-lab-${Date.now()}`,
    schemas: [
      {
        name: LOGICAL_SCHEMA,
        resources: [
          {
            type: 'TABLE',
            name: TABLE,
            columns: [
              { name: 'id', type: 'TEXT', primaryKey: true },
              { name: 'status', type: 'TEXT' },
              { name: 'carrier', type: 'TEXT' },
              { name: 'updated_at', type: 'TIMESTAMP', default: 'NOW()' }
            ],
            // DB-procedure trigger: transpiled natively to EXECUTE FUNCTION audit_log_fn().
            triggers: [
              {
                name: 'trg_shipments_audit',
                timing: 'AFTER',
                events: ['INSERT', 'UPDATE'],
                execution: 'ROW',
                procedure: 'audit_log_fn' // bare name resolves to public.audit_log_fn
              }
            ]
          }
        ]
      }
    ]
  });

  const before = await auditCountForTable(token, TABLE);
  console.log(`audit_logs rows for '${TABLE}' before insert: ${before}`);

  await insertRow(token, LOGICAL_SCHEMA, TABLE, {
    id: `shp-${Date.now()}`,
    status: 'IN_TRANSIT',
    carrier: 'DHL'
  });

  // audit_log_fn writes synchronously inside the same transaction; a short beat
  // covers replication/visibility.
  await sleep(500);
  const after = await auditCountForTable(token, TABLE);
  console.log(`audit_logs rows for '${TABLE}' after insert:  ${after}`);

  if (after > before) {
    console.log(`PASS native manifest trigger fired (+${after - before} audit row)`);
  } else {
    console.log('FAIL manifest trigger did not fire — audit count unchanged');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err.response?.data || err.message);
    process.exit(1);
  });
}

module.exports = { run };
