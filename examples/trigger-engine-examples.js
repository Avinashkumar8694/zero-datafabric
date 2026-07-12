/* eslint-disable no-console */
const axios = require('axios');
const { BASE_URL, login, authHeaders, call, banner } = require('./_client');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function upsertTrigger(token, payload) {
  return call(`Upsert trigger ${payload.triggerName}`, async () => {
    const list = await axios.get(`${BASE_URL}/triggers`, { headers: authHeaders(token) });
    const existing = (list.data || []).find((t) => t.triggerName === payload.triggerName && t.schemaName === payload.schemaName && t.tableName === payload.tableName);
    if (existing) {
      const res = await axios.put(`${BASE_URL}/triggers/${existing.id}`, payload, { headers: authHeaders(token) });
      return res.data;
    }
    const res = await axios.post(`${BASE_URL}/triggers`, payload, { headers: authHeaders(token) });
    return res.data;
  });
}

async function deploy(token, id) {
  return call(`Deploy trigger ${id}`, async () => {
    const res = await axios.post(`${BASE_URL}/triggers/${id}/deploy`, {}, { headers: authHeaders(token) });
    return res.data;
  });
}

async function waitForJobs(token, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    const jobs = await axios.get(`${BASE_URL}/triggers/jobs/list`, { headers: authHeaders(token) });
    const pending = (jobs.data || []).filter((j) => ['PENDING', 'RUNNING'].includes(j.status));
    if (pending.length === 0) return jobs.data || [];
    await sleep(1000);
  }
  return [];
}

async function run() {
  banner('Trigger Engine End-to-End Examples');
  const token = await login();
  const schemaName = 'tenant_tenant_A_Global_Supply_Chain';
  const labSchema = 'Demo_Trigger_Lab';
  const labPhysicalSchema = 'tenant_tenant_A_Demo_Trigger_Lab';

  await call('Apply trigger lab manifest (schema + table)', async () => {
    const manifest = {
      version: `v-trigger-lab-${Date.now()}`,
      schemas: [
        {
          name: labSchema,
          resources: [
            {
              type: 'TABLE',
              name: 'trigger_events',
              columns: [
                { name: 'id', type: 'TEXT', primaryKey: true },
                { name: 'status', type: 'TEXT' },
                { name: 'amount', type: 'INT' },
                { name: 'created_at', type: 'TIMESTAMP', default: 'NOW()' }
              ]
            },
            {
              type: 'FUNCTION',
              name: 'fn_mark_trigger',
              returnType: 'VOID',
              body: "BEGIN RETURN; END;"
            }
          ]
        }
      ]
    };
    await axios.post(`${BASE_URL}/metadata/apply?force=true`, manifest, { headers: authHeaders(token) });
  });

  const triggers = [
    {
      schemaName,
      tableName: 'shipments',
      triggerName: 'trg_shipments_audit_async',
      definition: { event: 'AFTER_INSERT', execute: { type: 'AUDIT' } }
    },
    {
      schemaName,
      tableName: 'shipments',
      triggerName: 'trg_shipments_webhook_async',
      definition: {
        event: 'AFTER_UPDATE',
        execute: {
          type: 'WEBHOOK',
          url: 'https://example.local/webhook',
          method: 'POST',
          headers: {
            'x-correlation-id': '{{triggerName}}-{{newRow.id}}',
            'x-tenant': '{{schemaName}}'
          },
          auth: {
            type: 'OIDC',
            tokenEndpoint: 'https://idp.example.com/oauth/token',
            clientId: 'fabric-webhook-client',
            clientSecret: 'dummy-secret',
            audience: 'https://api.partner.example.com',
            scope: 'events.publish'
          },
          payload: {
            event: '{{event}}',
            table: '{{tableName}}',
            trigger: '{{triggerName}}',
            rowId: '{{newRow.id}}',
            status: '{{newRow.status}}'
          }
        }
      }
    },
    {
      schemaName,
      tableName: 'shipments',
      triggerName: 'trg_shipments_email_async',
      definition: {
        event: 'AFTER_UPDATE',
        execute: {
          type: 'EMAIL',
          params: {
            to: 'ops@example.com',
            subject: 'Shipment {{newRow.id}} moved to {{newRow.status}}',
            text: 'Shipment {{newRow.id}} changed in {{tableName}}. {{?newRow.status!=oldRow.status|STATUS_CHANGED|STATUS_UNCHANGED}} Trigger={{triggerName}}',
            html: '<h3>Shipment Update</h3><p>ID: <b>{{newRow.id}}</b></p><p>Status: <b>{{newRow.status}}</b></p><p>{{?newRow.amount>100|High value|Standard value}}</p>'
          }
        }
      }
    },
    {
      schemaName,
      tableName: 'shipments',
      triggerName: 'trg_shipments_telegram_async',
      definition: { event: 'AFTER_UPDATE', execute: { type: 'TELEGRAM', params: { chatId: '@fabric_alerts' } } }
    },
    {
      schemaName,
      tableName: 'shipments',
      triggerName: 'trg_shipments_scheduled_audit',
      definition: {
        event: 'AFTER_INSERT',
        execute: { type: 'AUDIT' },
        schedule: { type: 'RELATIVE', after: 1, unit: 'MINUTE', maxAttempts: 3 }
      }
    }
  ];

  const saved = [];
  for (const t of triggers) {
    const row = await upsertTrigger(token, t);
    saved.push(row);
    await deploy(token, row.id);
  }

  const advancedTriggers = [
    {
      schemaName: labPhysicalSchema,
      tableName: 'trigger_events',
      triggerName: 'trg_lab_function',
      definition: {
        event: 'AFTER_INSERT',
        execute: { type: 'FUNCTION', name: 'fn_mark_trigger' }
      }
    },
    {
      schemaName: labPhysicalSchema,
      tableName: 'trigger_events',
      triggerName: 'trg_lab_exception',
      definition: {
        event: 'BEFORE_INSERT',
        execute: {
          type: 'EXCEPTION',
          message: 'amount too high',
          when: { left: 'NEW.amount', operator: 'GT', right: '1000' }
        }
      }
    },
    {
      schemaName: labPhysicalSchema,
      tableName: 'trigger_events',
      triggerName: 'trg_lab_scheduled_autodrop',
      definition: {
        event: 'AFTER_INSERT',
        execute: {
          type: 'EMAIL',
          params: {
            to: 'scheduler@example.com',
            subject: 'Scheduled trigger {{triggerName}} for {{newRow.id}}',
            text: 'status={{newRow.status}} amount={{newRow.amount}}'
          }
        },
        schedule: { type: 'RELATIVE', after: 1, unit: 'MINUTE', maxAttempts: 3 },
        autoDrop: {
          when: "NEW.status = 'ARCHIVE'",
          message: 'drop after archive record'
        }
      }
    },
    {
      schemaName: '__SYSTEM__',
      tableName: '__SYSTEM__',
      triggerName: 'trg_generic_scheduler_email',
      definition: {
        execute: {
          type: 'EMAIL',
          params: {
            to: 'scheduler@example.com',
            subject: 'Generic scheduler tick {{newRow.scheduledAt}}',
            text: 'Tenant scheduled trigger tick at {{newRow.scheduledAt}}'
          }
        },
        schedule: { type: 'CRON', cron: '*/1 * * * *' }
      }
    }
  ];

  for (const t of advancedTriggers) {
    const row = await upsertTrigger(token, t);
    await deploy(token, row.id);
  }

  await waitForJobs(token);

  await call('Insert row to trigger FUNCTION + scheduled trigger', async () => {
    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        schema: labSchema,
        table: 'trigger_events',
        data: { id: `lab-${Date.now()}`, status: 'READY', amount: 50 }
      }
    }, { headers: authHeaders(token) });
  });

  await call('Insert ARCHIVE row to trigger autoDrop cleanup enqueue', async () => {
    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        schema: labSchema,
        table: 'trigger_events',
        data: { id: `lab-arch-${Date.now()}`, status: 'ARCHIVE', amount: 20 }
      }
    }, { headers: authHeaders(token) });
  });

  await call('Insert high amount row to validate EXCEPTION trigger', async () => {
    await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'INSERT',
        schema: labSchema,
        table: 'trigger_events',
        data: { id: `lab-high-${Date.now()}`, status: 'READY', amount: 5000 }
      }
    }, { headers: authHeaders(token) });
  }, { allowFail: true });

  await call('Enqueue runtime action jobs (AUDIT/WEBHOOK/EMAIL/TELEGRAM + scheduled)', async () => {
    const runAt = new Date(Date.now() + 3000).toISOString();
    const sql = `
      INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
      VALUES
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION', '{"triggerName":"runtime_audit","event":"AFTER_INSERT","actionType":"AUDIT","schemaName":"tenant_tenant_A_Global_Supply_Chain","tableName":"shipments","execute":{"type":"AUDIT"}}', 'PENDING', NOW(), 3, 'examples'),
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION', '{"triggerName":"runtime_webhook","event":"AFTER_UPDATE","actionType":"WEBHOOK","schemaName":"tenant_tenant_A_Global_Supply_Chain","tableName":"shipments","execute":{"type":"WEBHOOK","url":"https://example.local/hook"}}', 'PENDING', NOW(), 3, 'examples'),
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION', '{"triggerName":"runtime_email","event":"AFTER_UPDATE","actionType":"EMAIL","schemaName":"tenant_tenant_A_Global_Supply_Chain","tableName":"shipments","execute":{"type":"EMAIL","params":{"to":"ops@example.com"}}}', 'PENDING', NOW(), 3, 'examples'),
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION', '{"triggerName":"runtime_telegram","event":"AFTER_UPDATE","actionType":"TELEGRAM","schemaName":"tenant_tenant_A_Global_Supply_Chain","tableName":"shipments","execute":{"type":"TELEGRAM","params":{"chatId":"@fabric_alerts"}}}', 'PENDING', NOW(), 3, 'examples'),
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION', '{"triggerName":"runtime_scheduled_email","event":"AFTER_INSERT","actionType":"EMAIL","schemaName":"tenant_tenant_A_Global_Supply_Chain","tableName":"shipments","execute":{"type":"EMAIL","params":{"to":"scheduler@example.com"}}}', 'PENDING', '${runAt}', 3, 'examples');
    `;
    await axios.post(`${BASE_URL}/queries/exec`, { sql }, { headers: authHeaders(token) });
  });

  await call('Enqueue update-style EMAIL action with old/new conditional templates', async () => {
    const sql = `
      INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
      VALUES
      ('tenant_A', NULL, 'EXECUTE_TRIGGER_ACTION',
      '{
        "triggerName":"runtime_email_update_conditional",
        "event":"AFTER_UPDATE",
        "actionType":"EMAIL",
        "tableName":"shipments",
        "schemaName":"tenant_tenant_A_Global_Supply_Chain",
        "oldRow":{"id":"S-100","status":"PENDING","amount":90},
        "newRow":{"id":"S-100","status":"DELIVERED","amount":150},
        "execute":{
          "type":"EMAIL",
          "params":{
            "to":"ops@example.com",
            "subject":"Shipment {{newRow.id}} {{?newRow.status!=oldRow.status|changed|unchanged}}",
            "text":"Old={{oldRow.status}} New={{newRow.status}} Priority={{?newRow.amount>100|HIGH|NORMAL}}",
            "html":"<p>Status: {{oldRow.status}} -> {{newRow.status}}</p><p>{{?newRow.amount>100|Escalate|Normal}}</p>"
          }
        }
      }',
      'PENDING', NOW(), 3, 'examples');
    `;
    await axios.post(`${BASE_URL}/queries/exec`, { sql }, { headers: authHeaders(token) });
  });

  await waitForJobs(token);

  await call('Fetch trigger jobs', async () => {
    const jobs = await axios.get(`${BASE_URL}/triggers/jobs/list`, { headers: authHeaders(token) });
    console.log(`jobs: ${(jobs.data || []).length}`);
    return jobs.data;
  });

  await call('Fetch trigger logs', async () => {
    const logs = await axios.get(`${BASE_URL}/triggers/logs/list`, { headers: authHeaders(token) });
    console.log(`logs: ${(logs.data || []).length}`);
    return logs.data;
  });

}

run().catch((err) => {
  console.error(err.response?.data || err.message);
  process.exit(1);
});
