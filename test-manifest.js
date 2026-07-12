/* eslint-disable no-console */
const { execSync } = require('node:child_process');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT = process.env.TENANT_ID || 'tenant_A';
const USERNAME = process.env.DF_USER || 'admin';
const PASSWORD = process.env.DF_PASS || 'admin';
const MANIFEST_FILE = process.env.MANIFEST_FILE || 'test_manifest.json';

function shEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function run(name, cmd, opts = {}) {
  const { allowFail = false } = opts;
  const started = Date.now();
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const ms = Date.now() - started;
    console.log(`PASS ${name} (${ms}ms)`);
    if (opts.printBody) console.log(out.trim());
    return { ok: true, out };
  } catch (err) {
    const ms = Date.now() - started;
    const stderr = err?.stderr?.toString() || '';
    const stdout = err?.stdout?.toString() || '';
    if (allowFail) {
      console.log(`WARN ${name} (${ms}ms)`);
      if (stderr.trim()) console.log(stderr.trim());
      if (stdout.trim()) console.log(stdout.trim());
      return { ok: false, out: stdout || stderr };
    }
    console.log(`FAIL ${name} (${ms}ms)`);
    if (stderr.trim()) console.log(stderr.trim());
    if (stdout.trim()) console.log(stdout.trim());
    throw err;
  }
}

function j(v) {
  return JSON.stringify(v);
}

function curlJson(method, path, token, body) {
  const url = `${BASE}${path}`;
  const headers = [
    `-H ${shEscape('Content-Type: application/json')}`,
    token ? `-H ${shEscape(`Authorization: Bearer ${token}`)}` : '',
    token ? `-H ${shEscape(`x-tenant-id: ${TENANT}`)}` : ''
  ].filter(Boolean).join(' ');
  const payload = body === undefined ? '' : `-d ${shEscape(j(body))}`;
  return `curl -s -X ${method} ${shEscape(url)} ${headers} ${payload}`;
}

function curlForm(path, token, filePath, force = false) {
  const q = force ? '?force=true' : '';
  return [
    `curl -s -X POST ${shEscape(`${BASE}${path}${q}`)}`,
    `-H ${shEscape(`Authorization: Bearer ${token}`)}`,
    `-H ${shEscape(`x-tenant-id: ${TENANT}`)}`,
    `-F ${shEscape(`file=@${filePath}`)}`
  ].join(' ');
}

function parseJson(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = raw.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return null;
}

function main() {
  console.log('=== Data Fabric Capability Runner (curl-backed) ===');
  console.log(`BASE=${BASE} TENANT=${TENANT} MANIFEST=${MANIFEST_FILE}`);

  const loginOut = run(
    'Login',
    curlJson('POST', '/auth/login', null, { username: USERNAME, password: PASSWORD })
  ).out;
  const loginJson = parseJson(loginOut);
  if (!loginJson?.token) {
    console.log('Login raw response:', loginOut);
    throw new Error('Unable to login or parse token');
  }
  const token = loginJson.token;

  // 1) Register 3 datasources first (Postgres + MongoDB + Elasticsearch)
  const sourcePayloads = [
    {
      name: 'Fabric_Hub_Postgres',
      config: { type: 'postgres', host: 'localhost', port: 5432, dbName: 'datafabric', user: 'fabric_admin', pass: 'super_secret_password', syncType: 'VIRTUAL' }
    },
    {
      name: 'Activity_Mongo',
      config: { type: 'mongodb', host: 'localhost', port: 27017, dbName: 'admin', user: 'admin', pass: 'mongo_password', syncType: 'VIRTUAL' }
    },
    {
      name: 'Elastic_Search',
      config: { type: 'elasticsearch', host: 'localhost', port: 9200, connectionString: 'http://localhost:9200', syncType: 'VIRTUAL' }
    }
  ];

  sourcePayloads.forEach((p) => {
    run(
      `Register Source: ${p.name}`,
      curlJson('POST', '/admin/connections', token, p),
      { allowFail: true }
    );
  });

  run('List Connections', curlJson('GET', '/admin/connections', token), { allowFail: true });

  // 2) Diff + apply from manifest
  run('Metadata Diff', curlForm('/metadata/diff', token, MANIFEST_FILE), { allowFail: true });
  run('Metadata Apply (guardrail expected maybe)', curlForm('/metadata/apply', token, MANIFEST_FILE), { allowFail: true });
  run('Metadata Apply Force', curlForm('/metadata/apply', token, MANIFEST_FILE, true), { allowFail: true });
  run('Downstream Status', curlJson('GET', '/metadata/downstream', token), { allowFail: true, printBody: true });

  // 3) Query capability matrix
  const queries = [
    {
      name: 'SQL Native Basic',
      mode: 'sql',
      body: { sql: 'SELECT 1 AS ok LIMIT 1' }
    },
    {
      name: 'SQL Native Async',
      mode: 'sql',
      body: { sql: 'SELECT NOW() AS now_ts', async: true }
    },
    {
      name: 'AST Basic Table Select (manifest style)',
      mode: 'ast',
      body: {
        queryConfig: {
          type: 'SELECT',
          schema: 'Global_Supply_Chain',
          limit: 10,
          query: { select: ['id', 'region', 'status'], from: { resource: 'shipments', source: 'Fabric_Hub_Postgres' } }
        }
      }
    },
    {
      name: 'AST Filter + Order',
      mode: 'ast',
      body: {
        queryConfig: {
          type: 'SELECT',
          schema: 'Global_Supply_Chain',
          limit: 10,
          query: {
            select: ['id', 'status', 'created_at'],
            from: { resource: 'shipments' },
            where: [{ column: 'status', operator: 'EQ', value: 'PENDING' }],
            orderBy: [{ column: 'created_at', direction: 'DESC' }]
          }
        }
      }
    },
    {
      name: 'AST Join',
      mode: 'ast',
      body: {
        queryConfig: {
          type: 'SELECT',
          schema: 'Global_Supply_Chain',
          limit: 10,
          query: {
            select: ['shipments.id', 'shipment_details.notes'],
            from: { resource: 'shipments' },
            joins: [{ type: 'INNER', resource: 'shipment_details', on: { left: 'shipments.id', operator: 'EQ', right: 'shipment_details.shipment_id' } }]
          }
        }
      }
    },
    {
      name: 'AST Set Operation UNION',
      mode: 'ast',
      body: {
        queryConfig: {
          type: 'SELECT',
          schema: 'Global_Supply_Chain',
          limit: 20,
          query: {
            union: [
              { select: ['sku', 'stock'], from: { resource: 'local_inventory' } },
              { select: ['item_id', 'qty'], from: { resource: 'remote_depot_mongo' } }
            ]
          }
        }
      }
    },
    {
      name: 'AST Aggregate Count',
      mode: 'ast',
      body: { queryConfig: { type: 'SELECT', schema: 'Global_Supply_Chain', table: 'shipments', select: ['count(*)'] } }
    },
    {
      name: 'AST Async',
      mode: 'ast_async',
      body: {
        queryConfig: {
          type: 'SELECT',
          schema: 'Global_Supply_Chain',
          limit: 10,
          query: { select: ['*'], from: { resource: 'employees' } }
        }
      }
    }
  ];

  queries.forEach((q) => {
    let cmd = '';
    if (q.mode === 'sql') cmd = curlJson('POST', '/queries/exec', token, q.body);
    else if (q.mode === 'ast') cmd = curlJson('POST', '/analytics/query', token, q.body);
    else cmd = curlJson('POST', '/analytics/query-async', token, q.body);
    run(`Query: ${q.name}`, cmd, { allowFail: true, printBody: true });
  });

  // 4) Optional ES checks
  run('ES Health', `curl -s ${shEscape('http://127.0.0.1:9200/_cluster/health')}`, { allowFail: true, printBody: true });
  run('ES Indices', `curl -s ${shEscape('http://127.0.0.1:9200/_cat/indices?v')}`, { allowFail: true, printBody: true });

  console.log('=== Completed: review PASS/WARN/FAIL above ===');
  console.log('Note: WARN may be expected for guardrails, missing seed data, or unavailable external engines.');
}

main();
