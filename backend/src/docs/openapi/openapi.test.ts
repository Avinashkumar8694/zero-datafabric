import fs from 'fs';
import path from 'path';
import { developerSpec } from './developer';
import { systemSpec } from './system';

/* eslint-disable @typescript-eslint/no-explicit-any */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const specs: Array<[string, any]> = [
  ['developer', developerSpec],
  ['system', systemSpec],
];

/** Routes that exist in route files / index.ts but are intentionally NOT documented. */
const IGNORED_ROUTES = new Set<string>([
  // Being removed (AST-only platform). They must never appear in a spec.
  'POST /api/queries/exec',
  'POST /api/queries/native',
]);

const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}').replace(/\/+$/, '') || '/';

function operations(spec: any): Array<{ method: string; path: string; op: any }> {
  const out: Array<{ method: string; path: string; op: any }> = [];
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const m of METHODS) if (item[m]) out.push({ method: m, path: p, op: item[m] });
  }
  return out;
}

function collectRefs(node: any, acc: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, acc));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

function resolvePointer(root: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce((cur: any, key) => (cur == null ? undefined : cur[key.replace(/~1/g, '/').replace(/~0/g, '~')]), root);
}

describe.each(specs)('%s OpenAPI spec', (name, spec) => {
  it('is a structurally valid OpenAPI 3.0.3 document (swagger-parser)', async () => {
    expect(spec.openapi).toBe('3.0.3');
    let parser: any;
    try {
      // swagger-parser ships as a transitive dependency of swagger-jsdoc.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      parser = require('swagger-parser');
    } catch {
      parser = null;
    }
    if (parser) {
      const api = await parser.validate(JSON.parse(JSON.stringify(spec)));
      expect(api.info.title).toBeTruthy();
    } else {
      expect(spec.info?.title).toBeTruthy();
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    }
  });

  it('declares servers with variables defaulting to http://localhost:4000', () => {
    const s = spec.servers[0];
    const url = s.url.replace(/\{(\w+)\}/g, (_: string, v: string) => s.variables[v].default);
    expect(url).toBe('http://localhost:4000');
  });

  it('documents authentication & token generation in info.description', () => {
    expect(spec.info.description).toContain('Authentication & token generation');
    for (const scope of ['query:read', 'data:read', 'data:write', 'metadata:write', 'triggers:write']) expect(spec.info.description).toContain(scope);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(spec.components.securitySchemes.apiKeyAuth).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-api-key' });
  });

  it('every operation has summary, description, tags, unique operationId and security', () => {
    const ids = new Set<string>();
    for (const { method, path: p, op } of operations(spec)) {
      const label = `${method.toUpperCase()} ${p}`;
      expect(`${label} summary:${!!op.summary}`).toBe(`${label} summary:true`);
      expect(`${label} description:${!!op.description}`).toBe(`${label} description:true`);
      expect(`${label} tags:${Array.isArray(op.tags) && op.tags.length > 0}`).toBe(`${label} tags:true`);
      expect(Array.isArray(op.security)).toBe(true);
      expect(ids.has(op.operationId)).toBe(false);
      ids.add(op.operationId);
    }
  });

  it('every non-public operation documents 401 (and 403); public operations use `security: []`', () => {
    for (const { method, path: p, op } of operations(spec)) {
      const label = `${method.toUpperCase()} ${p}`;
      if (op.security.length === 0) continue; // public
      expect(`${label} 401:${!!op.responses['401']}`).toBe(`${label} 401:true`);
      expect(`${label} 403:${!!op.responses['403']}`).toBe(`${label} 403:true`);
      expect(`${label} 500:${!!op.responses['500']}`).toBe(`${label} 500:true`);
    }
  });

  it('every operation with a request body carries at least one example', () => {
    for (const { method, path: p, op } of operations(spec)) {
      if (!op.requestBody) continue;
      const label = `${method.toUpperCase()} ${p}`;
      const hasExample = Object.values<any>(op.requestBody.content).some((c) => (c.examples && Object.keys(c.examples).length) || c.example !== undefined);
      expect(`${label} example:${hasExample}`).toBe(`${label} example:true`);
    }
  });

  it('every $ref resolves', () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(20);
    const missing = refs.filter((r) => resolvePointer(spec, r) === undefined);
    expect(missing).toEqual([]);
  });

  it('exposes the reusable header parameters', () => {
    const params = Object.values<any>(spec.components.parameters).map((p) => p.name);
    for (const h of ['Authorization', 'x-api-key', 'x-tenant-id', 'x-act-as-role', 'x-region', 'Accept']) expect(params).toContain(h);
  });

  it('contains no SQL execution endpoints or raw-SQL request fields', () => {
    for (const p of Object.keys(spec.paths)) expect(p).not.toMatch(/^\/api\/queries\/(exec|native)/);
    for (const { method, path: p, op } of operations(spec)) {
      if (!op.requestBody) continue;
      const bodyText = JSON.stringify(op.requestBody);
      // property definitions named sql / rawSql / nativeSql would advertise raw-SQL input
      expect(`${method} ${p} ${/"(sql|rawSql|nativeSql)":\{/.test(bodyText)}`).toBe(`${method} ${p} false`);
    }
  });

  it('references only declared tags and lists them with descriptions', () => {
    const declared = new Map<string, string>(spec.tags.map((t: any) => [t.name, t.description]));
    for (const { op } of operations(spec)) for (const t of op.tags) expect(declared.get(t)).toBeTruthy();
    expect(Array.isArray(spec['x-tagGroups'])).toBe(true);
  });

  it(`${name}: public/JWT-only/api-token auth modes are consistent`, () => {
    for (const { method, path: p, op } of operations(spec)) {
      const schemes = op.security.flatMap((s: any) => Object.keys(s));
      if (schemes.includes('apiKeyAuth')) {
        expect(`${method} ${p} ${op['x-required-scopes']?.length > 0}`).toBe(`${method} ${p} true`);
      }
    }
  });
});

describe('developer vs system relationship', () => {
  const key = (o: { method: string; path: string }) => `${o.method.toUpperCase()} ${o.path}`;

  it('system contains every developer operation', () => {
    const sys = new Set(operations(systemSpec).map(key));
    const missing = operations(developerSpec).map(key).filter((k) => !sys.has(k));
    expect(missing).toEqual([]);
  });

  it('developer excludes administration, workers, plans and settings', () => {
    for (const p of Object.keys(developerSpec.paths)) {
      expect(p).not.toMatch(/^\/api\/(admin|plans|subscriptions|settings|tenants)/);
    }
    for (const p of ['/api/admin/tenants', '/api/admin/workers', '/api/plans', '/api/settings/login', '/api/health']) {
      expect(systemSpec.paths[p]).toBeDefined();
    }
  });

  it('documents the workers and developer-token contracts', () => {
    const w = '/api/admin/workers';
    const sysOps = new Set(operations(systemSpec).map(key));
    for (const k of [
      `GET ${w}`, `POST ${w}`, `GET ${w}/{id}`, `PATCH ${w}/{id}`, `DELETE ${w}/{id}`,
      `POST ${w}/{id}/activate`, `POST ${w}/{id}/drain`, `POST ${w}/{id}/health`, `POST ${w}/health`,
      `POST ${w}/rebalance`, `GET ${w}/rebalance/status`, `GET ${w}/tables`, `POST ${w}/tables/distribute`, `POST ${w}/sync`, `GET ${w}/events`,
    ]) expect(sysOps.has(k)).toBe(true);
    const dev = new Set(operations(developerSpec).map(key));
    for (const k of ['POST /api/developer/tokens', 'GET /api/developer/tokens', 'GET /api/developer/tokens/scopes', 'DELETE /api/developer/tokens/{id}', 'POST /api/auth/login', 'POST /api/auth/token', 'POST /api/queries/engine', 'POST /api/queries/transpile', 'POST /api/analytics/query'])
      expect(dev.has(k)).toBe(true);
    // workers are platform-ADMIN, JWT session only
    for (const { path: p, op } of operations(systemSpec)) {
      if (p.startsWith(w)) expect(op.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Route coverage: every router.<verb>() in src/routes must be in the   */
/* system spec.                                                         */
/* ------------------------------------------------------------------ */
describe('route coverage', () => {
  const srcDir = path.resolve(__dirname, '..', '..');
  const routesDir = path.join(srcDir, 'routes');
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** import identifier -> absolute route file (resolved from relative imports of `file`) */
  function routeImports(file: string, text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/import\s+(\w+)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const abs = path.resolve(path.dirname(file), m[2]!) + '.ts';
      if (fs.existsSync(abs) && abs.startsWith(routesDir)) out[m[1]!] = abs;
    }
    return out;
  }

  const join = (prefix: string, sub: string) => norm(`${prefix}/${sub}`.replace(/\/+/g, '/'));

  function routesOf(file: string, prefix: string, seen: Set<string>): string[] {
    if (seen.has(file)) return [];
    seen.add(file);
    const text = stripComments(read(file));
    const found: string[] = [];
    for (const m of text.matchAll(/\b\w+\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g)) {
      const sub = m[3]!;
      if (sub !== '' && !sub.startsWith('/')) continue;
      found.push(`${m[1]!.toUpperCase()} ${join(prefix, sub)}`);
    }
    const imports = routeImports(file, text);
    for (const m of text.matchAll(/\b\w+\.use\(\s*(['"`])([^'"`]*)\1\s*,([^)]*)\)/g)) {
      const ident = m[3]!.split(',').map((s) => s.trim()).filter(Boolean).pop()!;
      const target = imports[ident];
      if (target) found.push(...routesOf(target, join(prefix, m[2]!), seen));
    }
    return found;
  }

  const indexText = stripComments(read(path.join(srcDir, 'index.ts')));
  const indexImports = routeImports(path.join(srcDir, 'index.ts'), indexText);

  function allRoutes(): { routes: string[]; unmounted: string[] } {
    const routes: string[] = [];
    const seen = new Set<string>();
    for (const m of indexText.matchAll(/\bapp\.use\(\s*(['"`])([^'"`]*)\1\s*,([^;]*?)\)\s*;/g)) {
      const ident = m[3]!.split(',').map((s) => s.trim()).filter(Boolean).pop()!;
      const target = indexImports[ident];
      if (target) routes.push(...routesOf(target, m[2]!, seen));
    }
    for (const m of indexText.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]*)\2/g)) {
      if (m[3]!.startsWith('/api-docs')) continue;
      routes.push(`${m[1]!.toUpperCase()} ${norm(m[3]!)}`);
    }
    const unmounted = fs
      .readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(routesDir, f))
      .filter((f) => !seen.has(f));
    return { routes, unmounted };
  }

  it('parses a realistic number of routes from src/routes + index.ts', () => {
    const { routes } = allRoutes();
    expect(routes.length).toBeGreaterThan(80);
    expect(routes).toContain('POST /api/auth/login');
    expect(routes).toContain('GET /api/health');
  });

  it('every mounted route is documented in the system spec', () => {
    const documented = new Set(operations(systemSpec).map((o) => `${o.method.toUpperCase()} ${norm(o.path)}`));
    const { routes, unmounted } = allRoutes();
    if (unmounted.length) console.warn('[openapi.test] route files not mounted from index.ts (skipped):', unmounted.map((f) => path.basename(f)).join(', '));
    const missing = [...new Set(routes)].filter((r) => !IGNORED_ROUTES.has(r) && !documented.has(r));
    expect(missing).toEqual([]);
  });

  it('documented operations without a matching route are reported (soft check)', () => {
    const implemented = new Set(allRoutes().routes);
    const orphans = operations(systemSpec)
      .map((o) => `${o.method.toUpperCase()} ${norm(o.path)}`)
      .filter((k) => !implemented.has(k));
    if (orphans.length) console.warn('[openapi.test] documented but not (yet) registered in routes/index.ts:', orphans.join(' | '));
    expect(Array.isArray(orphans)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* HTTP mounting                                                        */
/* ------------------------------------------------------------------ */
describe('mountApiDocs', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const request = require('supertest');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mountApiDocs } = require('../mountDocs');
  const app = express();
  mountApiDocs(app);

  it('serves the landing page and redirects /api-docs.json', async () => {
    const landing = await request(app).get('/api-docs');
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('/api-docs/developer');
    expect(landing.text).toContain('/api-docs/system');
    const legacy = await request(app).get('/api-docs.json');
    expect(legacy.status).toBe(302);
    expect(legacy.headers.location).toBe('/api-docs/developer.json');
  });

  it('serves both JSON specs', async () => {
    const dev = await request(app).get('/api-docs/developer.json');
    const sys = await request(app).get('/api-docs/system.json');
    expect(dev.status).toBe(200);
    expect(sys.status).toBe(200);
    expect(dev.body.info.title).toMatch(/Developer/);
    expect(sys.body.info.title).toMatch(/System/);
    expect(Object.keys(sys.body.paths).length).toBeGreaterThan(Object.keys(dev.body.paths).length);
  });

  it('serves the Swagger UI for both documents', async () => {
    for (const p of ['/api-docs/developer/', '/api-docs/system/']) {
      const r = await request(app).get(p);
      expect(r.status).toBe(200);
      expect(r.text).toContain('swagger-ui');
    }
  });
});
