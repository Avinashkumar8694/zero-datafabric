/**
 * Shared building blocks for the two OpenAPI 3.0.3 documents (developer + system).
 *
 * Specs are assembled from plain TS objects (no swagger-jsdoc scanning) so that
 * audience filtering is explicit: each {@link OpDef} lists which spec(s) it belongs to
 * simply by being exported from `developer.ts` (both specs) or `system.ts` (system only).
 * `buildSpec` then expands every OpDef into a full OpenAPI operation (security, header
 * parameters, standard error responses, curl sample) and prunes unreferenced components.
 */
import { schemas } from './schemas';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * - `any`     : JWT session (`bearerAuth`) OR developer API token (`apiKeyAuth` / `Bearer dft_...`); scopes apply to tokens.
 * - `session` : JWT session ONLY. Developer API tokens are rejected (403).
 * - `public`  : no authentication (`security: []`).
 */
export type AuthMode = 'any' | 'session' | 'public';

export interface ParamDef {
  name: string;
  in: 'query' | 'path' | 'header';
  description: string;
  required?: boolean;
  schema?: Json;
  example?: Json;
}

export interface ExampleDef {
  summary: string;
  description?: string;
  value: Json;
}

export interface BodyDef {
  description?: string;
  required?: boolean;
  schema: Json;
  examples: Record<string, ExampleDef>;
  /** Use multipart/form-data instead of application/json (file upload). */
  multipart?: boolean;
  /** Additional alternative content (e.g. raw JSON manifest next to multipart upload). */
  alsoJson?: { schema: Json; examples: Record<string, ExampleDef> };
}

export interface RespDef {
  description: string;
  schema?: Json;
  example?: Json;
  contentType?: string;
  headers?: Json;
}

export interface OpDef {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description: string;
  auth?: AuthMode;
  /** Developer-token scopes that may call this operation (JWT sessions are not scope-limited). */
  scopes?: string[];
  /** Only a platform ADMIN may call (403 otherwise). */
  platformAdmin?: boolean;
  /** Include the `x-tenant-id` header parameter (default: true for authenticated ops). */
  tenantHeader?: boolean;
  /** Include `x-act-as-role` (ADMIN JWT only). */
  actAs?: boolean;
  /** Include `x-region`. */
  region?: boolean;
  /** Include `Accept: application/x-ndjson` (streaming). */
  ndjson?: boolean;
  /** Behind the licensing middleware: adds 402 (trial expired) and 429 (plan rate limit). */
  licensed?: boolean;
  /** Request bodies are AST-only; `sql`/`rawSql`/`nativeSql` keys are rejected with 400 SQL_NOT_SUPPORTED. */
  rejectsSql?: boolean;
  params?: ParamDef[];
  body?: BodyDef;
  responses: Record<string, RespDef>;
  /** Extra / overriding error responses: status -> description, optionally with a stable `code`. */
  errors?: Record<string, string | { description: string; code?: string; message?: string; codes?: string[] }>;
  /** Name of a reusable `components.responses` entry to use as the default 403 (e.g. `WorkspaceGuardForbidden`). */
  forbidden?: string;
  deprecated?: boolean;
}

export interface TagDef {
  name: string;
  description: string;
}

export interface TagGroup {
  name: string;
  tags: string[];
}

/* ------------------------------------------------------------------ */
/* Reusable components                                                 */
/* ------------------------------------------------------------------ */

export const DEVELOPER_SCOPES = ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] as const;

export const securitySchemes: Json = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Session JWT from `POST /api/auth/login` (1 hour lifetime). Send `Authorization: Bearer <jwt>`. A JWT session is required for token management, administration and tenant switching. ' +
      '**A developer API token (`dft_...`) may also be sent here** as `Authorization: Bearer dft_<prefix>_<secret>`; the server tells the two apart by the `dft_` prefix.',
  },
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description:
      'Developer API token minted with `POST /api/developer/tokens`, sent as `x-api-key: dft_<prefix>_<secret>`. ' +
      'Tokens are tenant-scoped, carry explicit scopes (`query:read data:read data:write metadata:read metadata:write triggers:read triggers:write`), expire (1-365 days) and can be revoked at any time. ' +
      'Tokens can only call `/api/queries`, `/api/analytics`, `/api/saved-analytics`, `/api/query-logs`, `/api/data`, `/api/metadata` and `/api/triggers`; never `/api/admin/*`, token management or tenant switching.',
  },
};

export const headerParameters: Json = {
  Authorization: {
    name: 'Authorization',
    in: 'header',
    required: false,
    description:
      '`Bearer <jwt>` (session from `/api/auth/login`) **or** `Bearer dft_<prefix>_<secret>` (developer API token). Supply either this header or `x-api-key`. ' +
      '(Swagger UI sends this through the Authorize dialog; the entry is listed so generated clients expose it.)',
    schema: { type: 'string', example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
  },
  XApiKey: {
    name: 'x-api-key',
    in: 'header',
    required: false,
    description: 'Developer API token (`dft_<prefix>_<secret>`). Alternative to `Authorization: Bearer dft_...`.',
    schema: { type: 'string', example: 'dft_a1b2c3d4_9f8e7d6c5b4a39281706f5e4d3c2b1a0' },
  },
  XTenantId: {
    name: 'x-tenant-id',
    in: 'header',
    required: false,
    description:
      'Override the tenant of the request. **Honoured only for platform ADMIN JWTs**; for every other caller (including all developer API tokens, which are bound to one tenant) the header is ignored.',
    schema: { type: 'string', example: 'tenant_A' },
  },
  XActAsRole: {
    name: 'x-act-as-role',
    in: 'header',
    required: false,
    description:
      '"View as" another role to test policies, masking and grants. **Platform ADMIN JWT only** - ignored for non-admin users and for developer API tokens.',
    schema: { type: 'string', example: 'ANALYST' },
  },
  XRegion: {
    name: 'x-region',
    in: 'header',
    required: false,
    description: 'Execution region used for region-aware policies and routing. Falls back to the server default (`DEFAULT_REGION`, then `AP`).',
    schema: { type: 'string', example: 'EU' },
  },
  AcceptNdjson: {
    name: 'Accept',
    in: 'header',
    required: false,
    description:
      'Send `application/x-ndjson` (together with `"stream": true` in the body or `?stream=true`) to receive newline-delimited JSON: one row per line followed by a `{"__meta__": {...}}` trailer with plan / rowCount / warnings.',
    schema: { type: 'string', enum: ['application/json', 'application/x-ndjson'], default: 'application/json' },
  },
};

const errorExample = (error: string, code?: string) => ({ error, ...(code ? { code } : {}) });

const errResp = (description: string, example: Json) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example } },
});

export const componentResponses: Json = {
  BadRequest: errResp('Invalid request (validation error). AST endpoints return `SQL_NOT_SUPPORTED` when the body contains `sql`, `rawSql` or `nativeSql`.', errorExample('resource is required', 'VALIDATION_ERROR')),
  Unauthorized: errResp('Missing, malformed, expired or revoked credentials (JWT or developer token). Developer-token codes: `INVALID_TOKEN`, `TOKEN_REVOKED`, `TOKEN_EXPIRED`.', errorExample('Authentication required', 'UNAUTHENTICATED')),
  PaymentRequired: errResp('The tenant trial/subscription has expired.', errorExample('Trial period has expired. Please contact support or upgrade your subscription.', 'TRIAL_EXPIRED')),
  Forbidden: errResp(
    'Authenticated but not allowed: role lacks the privilege (grant / ADMIN), developer token lacks the required scope (`SCOPE_REQUIRED`), endpoint is JWT-session-only (`TOKEN_NOT_ALLOWED`), or the workspace guard refused it (`TENANT_SUSPENDED`, `TENANT_NOT_AVAILABLE`, `IP_NOT_ALLOWED`).',
    errorExample('API token is missing the required scope: data:write', 'SCOPE_REQUIRED'),
  ),
  WorkspaceGuardForbidden: {
    description:
      'Refused before the handler ran. Every authenticated `/api` request (sessions **and** developer tokens, except platform ADMINs) first passes the workspace guard, which answers `403` with one of: ' +
      '`TENANT_SUSPENDED` (the workspace was suspended by a platform admin), `TENANT_NOT_AVAILABLE` (the workspace no longer exists / was deleted) or `IP_NOT_ALLOWED` (the caller IP is outside the workspace `security.allowedIps` allow-list). ' +
      'Endpoints may add their own 403 codes, e.g. `TOKEN_NOT_ALLOWED` (developer tokens are rejected), `WORKSPACE_ADMIN_REQUIRED`, `FEATURE_DISABLED` (feature not in plan/licence), `PLAN_LIMIT_REACHED` / `LICENSE_LIMIT_REACHED` (a plan or licence limit was hit).',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        examples: {
          suspended: { summary: 'Workspace suspended', value: errorExample('Workspace is suspended', 'TENANT_SUSPENDED') },
          notAvailable: { summary: 'Workspace deleted / unknown', value: errorExample('Workspace is not available', 'TENANT_NOT_AVAILABLE') },
          ip: { summary: 'IP not on the allow-list', value: errorExample('Requests from this IP address are not allowed for this workspace', 'IP_NOT_ALLOWED') },
          token: { summary: 'API token on a session-only endpoint', value: errorExample('A user session is required', 'TOKEN_NOT_ALLOWED') },
        },
      },
    },
  },
  ServiceUnavailable: {
    description:
      'The workspace guard refused the request with `503`: `MAINTENANCE` (the platform is in maintenance mode; the body `error` carries the operator\'s message; platform ADMINs are exempt) or ' +
      '`GUARD_UNAVAILABLE` (the maintenance/suspension/IP checks could not run; the guard fails closed). Licensed data endpoints can also answer `LICENSE_CHECK_FAILED` when plan limits could not be evaluated. Retry later.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        examples: {
          maintenance: { summary: 'Maintenance mode', value: errorExample('The platform is in maintenance mode', 'MAINTENANCE') },
          guard: { summary: 'Guard could not verify access', value: errorExample('Could not verify workspace access', 'GUARD_UNAVAILABLE') },
          licence: { summary: 'Licence/limit check failed', value: errorExample('Could not verify licence limits, try again shortly', 'LICENSE_CHECK_FAILED') },
        },
      },
    },
  },
  NotFound: errResp('The addressed resource does not exist (or is not visible to the caller\'s tenant).', errorExample('Resource not found', 'NOT_FOUND')),
  Conflict: errResp('The request conflicts with current state.', errorExample('Resource already exists', 'CONFLICT')),
  TooManyRequests: errResp('Plan rate limit exceeded (per-minute / hour / day request quota).', errorExample('Rate limit exceeded. Your plan limit for minutely requests has been reached.', 'RATE_LIMITED')),
  InternalError: errResp('Unexpected server error.', errorExample('Internal Server Error')),
};

export const componentSchemas: Json = schemas;

/* ------------------------------------------------------------------ */
/* Operation expansion                                                 */
/* ------------------------------------------------------------------ */

const COMMON_REFS = {
  Authorization: { $ref: '#/components/parameters/Authorization' },
  XApiKey: { $ref: '#/components/parameters/XApiKey' },
  XTenantId: { $ref: '#/components/parameters/XTenantId' },
  XActAsRole: { $ref: '#/components/parameters/XActAsRole' },
  XRegion: { $ref: '#/components/parameters/XRegion' },
  AcceptNdjson: { $ref: '#/components/parameters/AcceptNdjson' },
};

function operationId(method: string, path: string): string {
  const words = path
    .replace(/[{}]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1)));
  return method + words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
}

function jsonContent(schema: Json, examples?: Record<string, ExampleDef>, example?: Json): Json {
  const c: Json = { schema };
  if (examples && Object.keys(examples).length) c.examples = examples;
  else if (example !== undefined) c.example = example;
  return c;
}

function curlFor(def: OpDef): string {
  const auth: AuthMode = def.auth ?? 'any';
  const lines = [`curl -X ${def.method.toUpperCase()} "$BASE_URL${def.path.replace(/\{([^}]+)\}/g, '<$1>')}"`];
  if (auth !== 'public') lines.push(`  -H "Authorization: Bearer $DFT_TOKEN"`);
  if (def.actAs) lines.push(`  -H "x-act-as-role: ANALYST"`);
  if (def.body) {
    if (def.body.multipart) {
      lines.push(`  -F "file=@manifest.json"`);
    } else {
      const first = Object.values(def.body.examples)[0];
      lines.push(`  -H "Content-Type: application/json"`);
      if (first) lines.push(`  -d '${JSON.stringify(first.value)}'`);
    }
  }
  return lines.join(' \\\n');
}

export function buildOperation(def: OpDef): Json {
  const auth: AuthMode = def.auth ?? 'any';
  const secured = auth !== 'public';
  const tenantHeader = def.tenantHeader ?? secured;

  /* ---- description (auto-appended access note) ---- */
  const access: string[] = [];
  if (auth === 'public') access.push('**Access:** public, no credentials required.');
  else if (auth === 'session') {
    access.push(
      def.platformAdmin
        ? '**Access:** platform ADMIN JWT session only. Developer API tokens are rejected (403).'
        : '**Access:** JWT session only. Developer API tokens are rejected (403).',
    );
  } else {
    const who = def.platformAdmin ? 'platform ADMIN' : 'any authenticated caller';
    access.push(
      `**Access:** ${who} - JWT session or developer API token.` +
        (def.scopes?.length ? ` **Required token scope:** ${def.scopes.map((s) => '`' + s + '`').join(' or ')} (JWT sessions are not scope-limited).` : ''),
    );
  }
  if (def.rejectsSql) access.push('**AST only:** bodies containing `sql`, `rawSql` or `nativeSql` are rejected with `400 SQL_NOT_SUPPORTED`.');

  /* ---- parameters ---- */
  const parameters: Json[] = [];
  if (secured) {
    parameters.push(COMMON_REFS.Authorization);
    if (auth === 'any') parameters.push(COMMON_REFS.XApiKey);
  }
  if (tenantHeader) parameters.push(COMMON_REFS.XTenantId);
  if (def.actAs) parameters.push(COMMON_REFS.XActAsRole);
  if (def.region) parameters.push(COMMON_REFS.XRegion);
  if (def.ndjson) parameters.push(COMMON_REFS.AcceptNdjson);

  const declared = new Map((def.params ?? []).map((p) => [`${p.in}:${p.name}`, p]));
  for (const m of def.path.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1]!;
    const p = declared.get(`path:${name}`);
    declared.delete(`path:${name}`);
    parameters.push({
      name,
      in: 'path',
      required: true,
      description: p?.description ?? `${name} of the addressed resource.`,
      schema: p?.schema ?? { type: 'string' },
      ...(p?.example !== undefined ? { example: p.example } : {}),
    });
  }
  for (const p of declared.values()) {
    parameters.push({
      name: p.name,
      in: p.in,
      required: p.required ?? false,
      description: p.description,
      schema: p.schema ?? { type: 'string' },
      ...(p.example !== undefined ? { example: p.example } : {}),
    });
  }

  /* ---- request body ---- */
  let requestBody: Json | undefined;
  if (def.body) {
    const b = def.body;
    const content: Json = {};
    if (b.multipart) {
      content['multipart/form-data'] = { schema: b.schema };
      if (b.alsoJson) content['application/json'] = jsonContent(b.alsoJson.schema, b.alsoJson.examples);
    } else {
      content['application/json'] = jsonContent(b.schema, b.examples);
    }
    requestBody = { required: b.required ?? true, ...(b.description ? { description: b.description } : {}), content };
  }

  /* ---- responses ---- */
  const responses: Json = {};
  for (const [status, r] of Object.entries(def.responses)) {
    const resp: Json = { description: r.description };
    if (r.headers) resp.headers = r.headers;
    if (r.schema || r.example !== undefined) {
      const ct = r.contentType ?? 'application/json';
      resp.content = { [ct]: jsonContent(r.schema ?? { type: 'object' }, undefined, r.example) };
    }
    responses[status] = resp;
  }
  const hasInput = !!def.body || (def.params ?? []).some((p) => p.in === 'query' && p.required) || (def.params ?? []).some((p) => p.in === 'path');
  if (!responses['400'] && hasInput) {
    responses['400'] = def.rejectsSql
      ? {
          description: 'Invalid AST / validation error, or the body contained a raw-SQL key (`SQL_NOT_SUPPORTED`).',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              examples: {
                sqlNotSupported: { summary: 'Raw SQL rejected', value: { error: 'Raw SQL is not supported. Send an AST queryConfig.', code: 'SQL_NOT_SUPPORTED' } },
                validation: { summary: 'Invalid request', value: { error: 'resource is required', code: 'VALIDATION_ERROR' } },
              },
            },
          },
        }
      : { $ref: '#/components/responses/BadRequest' };
  }
  if (secured) {
    responses['401'] ??= { $ref: '#/components/responses/Unauthorized' };
    responses['403'] ??= { $ref: `#/components/responses/${def.forbidden ?? 'Forbidden'}` };
    // Platform ADMINs bypass the workspace guard, so only non-admin operations can see its 503s.
    if (!def.platformAdmin) responses['503'] ??= { $ref: '#/components/responses/ServiceUnavailable' };
  }
  if (def.licensed) {
    responses['402'] ??= { $ref: '#/components/responses/PaymentRequired' };
    responses['429'] ??= { $ref: '#/components/responses/TooManyRequests' };
  }
  if ((def.path.includes('{') || def.errors?.['404']) && !responses['404']) responses['404'] = { $ref: '#/components/responses/NotFound' };
  for (const [status, e] of Object.entries(def.errors ?? {})) {
    const description = typeof e === 'string' ? e : e.description;
    const code = typeof e === 'string' ? undefined : e.code;
    const message = typeof e === 'string' ? e : e.message ?? e.description;
    const codes = typeof e === 'string' ? undefined : e.codes;
    const full = codes?.length ? `${description} Possible codes: ${codes.map((c) => '`' + c + '`').join(', ')}.` : description;
    responses[status] = errResp(full, errorExample(message, code ?? codes?.[0]));
  }
  responses['500'] ??= { $ref: '#/components/responses/InternalError' };

  const ordered: Json = {};
  for (const k of Object.keys(responses).sort()) ordered[k] = responses[k];

  const op: Json = {
    operationId: operationId(def.method, def.path),
    summary: def.summary,
    description: [def.description.trim(), ...access].join('\n\n'),
    tags: [def.tag],
    security: auth === 'public' ? [] : auth === 'session' ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses: ordered,
    'x-codeSamples': [{ lang: 'Shell', label: 'curl', source: curlFor(def) }],
  };
  if (def.scopes?.length) op['x-required-scopes'] = def.scopes;
  if (def.platformAdmin) op['x-platform-admin-only'] = true;
  if (def.deprecated) op.deprecated = true;
  if (!parameters.length) delete op.parameters;
  return op;
}

/* ------------------------------------------------------------------ */
/* Spec assembly                                                       */
/* ------------------------------------------------------------------ */

export interface SpecOptions {
  title: string;
  version: string;
  description: string;
  ops: OpDef[];
  tags: TagDef[];
  tagGroups: TagGroup[];
}

export const servers: Json[] = [
  {
    url: '{scheme}://{host}:{port}',
    description: 'Self-hosted / local Data Fabric API',
    variables: {
      scheme: { default: 'http', enum: ['http', 'https'] },
      host: { default: 'localhost', description: 'API host name' },
      port: { default: '4000', description: 'API port' },
    },
  },
  {
    url: '{baseUrl}',
    description: 'Custom base URL (reverse proxy / managed deployment)',
    variables: { baseUrl: { default: 'http://localhost:4000', description: 'Full base URL without a trailing slash' } },
  },
];

function collectRefs(node: Json, into: Set<string>): void {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, into));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') into.add(v);
      else collectRefs(v, into);
    }
  }
}

/** Keep only components reachable from `paths` so each spec ships exactly what it uses. */
function pruneComponents(spec: Json, all: Json): void {
  const seen = new Set<string>();
  const queue: string[] = [];
  const found = new Set<string>();
  collectRefs(spec.paths, found);
  found.forEach((r) => queue.push(r));
  while (queue.length) {
    const ref = queue.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const [, , section, name] = ref.split('/');
    const target = section && name ? all[section]?.[name] : undefined;
    if (!target) continue;
    const inner = new Set<string>();
    collectRefs(target, inner);
    inner.forEach((r) => queue.push(r));
  }
  const components: Json = { securitySchemes: all.securitySchemes };
  for (const section of ['schemas', 'parameters', 'responses']) {
    components[section] = {};
    for (const ref of seen) {
      const [, , sec, name] = ref.split('/');
      if (sec === section && name && all[section][name]) components[section][name] = all[section][name];
    }
  }
  spec.components = components;
}

export function buildSpec(opts: SpecOptions): Json {
  const paths: Json = {};
  const seenIds = new Set<string>();
  for (const def of opts.ops) {
    const op = buildOperation(def);
    if (seenIds.has(op.operationId)) throw new Error(`Duplicate operationId ${op.operationId} (${def.method} ${def.path})`);
    seenIds.add(op.operationId);
    paths[def.path] ??= {};
    if (paths[def.path][def.method]) throw new Error(`Duplicate operation ${def.method.toUpperCase()} ${def.path}`);
    paths[def.path][def.method] = op;
  }

  const usedTags = new Set(opts.ops.map((o) => o.tag));
  for (const t of usedTags) if (!opts.tags.some((x) => x.name === t)) throw new Error(`Tag "${t}" has no description entry`);

  const spec: Json = {
    openapi: '3.0.3',
    info: {
      title: opts.title,
      version: opts.version,
      description: opts.description,
      contact: { name: 'Zero Data Fabric Engineering', email: 'engineering@fabric.internal' },
      license: { name: 'Proprietary' },
    },
    servers,
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    tags: opts.tags.filter((t) => usedTags.has(t.name)),
    'x-tagGroups': opts.tagGroups
      .map((g) => ({ name: g.name, tags: g.tags.filter((t) => usedTags.has(t)) }))
      .filter((g) => g.tags.length),
    paths,
  };
  pruneComponents(spec, {
    securitySchemes,
    parameters: headerParameters,
    responses: componentResponses,
    schemas: componentSchemas,
  });
  return spec;
}

/* ------------------------------------------------------------------ */
/* Info.description: shared authentication guide                       */
/* ------------------------------------------------------------------ */

export const AUTH_GUIDE = `
## Authentication & token generation

Every endpoint except the ones marked *public* (\`security: []\`) needs credentials. There are two kinds:

| Credential | How you get it | Header | Lifetime |
|---|---|---|---|
| **Session JWT** | \`POST /api/auth/login\` | \`Authorization: Bearer <jwt>\` | 1 hour |
| **Developer API token** | \`POST /api/developer/tokens\` (needs a JWT) | \`x-api-key: dft_<prefix>_<secret>\` **or** \`Authorization: Bearer dft_<prefix>_<secret>\` | 1-365 days, revocable |

### 1. Log in and get a JWT
\`\`\`bash
curl -s -X POST "$BASE_URL/api/auth/login" -H "Content-Type: application/json" \\
  -d '{"username":"alice","password":"s3cret!"}'
# -> {"token":"eyJhbGciOi...","user":{"id":"...","username":"alice","tenant_id":"tenant_A"}}
\`\`\`
The JWT is bound to the user's home tenant. To work in another tenant you own, exchange it with \`POST /api/auth/token {"tenantId": "..."}\` (platform ADMINs may also send the \`x-tenant-id\` header on any call).

### 2. Mint a developer token (for servers, CI, notebooks)
\`\`\`bash
curl -s -X POST "$BASE_URL/api/developer/tokens" \\
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \\
  -d '{"name":"etl-pipeline","scopes":["query:read","data:read","data:write"],"expiresInDays":90}'
# -> 201 {"id":"...","prefix":"a1b2c3d4","scopes":[...],"expiresAt":"...","token":"dft_a1b2c3d4_<secret>"}
\`\`\`
* The full \`token\` is returned **exactly once**. Only a SHA-256 hash is stored; \`GET /api/developer/tokens\` lists metadata (id, name, prefix, scopes, expiry, last use) but never the secret.
* Minting, listing and revoking require a **JWT session** - a developer token cannot create or manage tokens.

### 3. Call the API with the token
\`\`\`bash
curl -s -X POST "$BASE_URL/api/data/fetch" -H "x-api-key: $DFT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"source":"An_Lab","schema":"an_lab","resource":"employees","limit":5}'
\`\`\`
\`Authorization: Bearer $DFT_TOKEN\` works identically to \`x-api-key\`.

### Scopes
Each token carries one or more scopes; an operation lists the scopes it accepts in \`x-required-scopes\`. A missing scope returns \`403 SCOPE_REQUIRED\`. JWT sessions are not scope-limited (their access is governed by the user's role).

| Scope | Grants |
|---|---|
| \`query:read\` | AST queries (\`/api/queries/*\`, \`/api/analytics/*\`), job polling, saved analytics (\`/api/saved-analytics/*\`), query logs (\`/api/query-logs/*\`) |
| \`data:read\` | \`POST /api/data/fetch\` and any GET under \`/api/data\` |
| \`data:write\` | \`POST\` under \`/api/data\` except \`fetch\`: \`create\`, \`update\`, \`delete\`, \`call\`, \`sequence\`; also any non-SELECT AST (CALL, DML) sent to \`/api/queries\` or \`/api/analytics\` |
| \`metadata:read\` | \`GET /api/metadata/*\` (catalog browse, manifests, history, downstream status) |
| \`metadata:write\` | \`POST /api/metadata/*\` (crawl, sync, apply, migrate, rollback, downstream toggle) |
| \`triggers:read\` | \`GET /api/triggers/*\` (list, logs, jobs) |
| \`triggers:write\` | Create, update, delete, deploy triggers and retry trigger jobs |

**A developer token can only reach \`/api/queries\`, \`/api/analytics\`, \`/api/saved-analytics\`, \`/api/query-logs\`, \`/api/data\`, \`/api/metadata\` and \`/api/triggers\`.** Everything else (policies, constraints, grants, replication, events, \`/api/admin/*\`, tenants, plans, settings, worker management, token management) requires a **JWT session** and answers \`403 TOKEN_NOT_ALLOWED\` to a token. \`admin:*\` scopes are never grantable.

### Expiry, revocation and errors
* An expired (\`TOKEN_EXPIRED\`), revoked (\`TOKEN_REVOKED\`) or unknown (\`INVALID_TOKEN\`) token returns \`401\`. Revoke with \`DELETE /api/developer/tokens/{id}\` - effective immediately; \`revokedAt\` is then set on the listing.
* Rotate by minting a new token, deploying it, then revoking the old one.
* Never put tokens in URLs or client-side code.

### Common headers
| Header | Purpose |
|---|---|
| \`Authorization\` | \`Bearer <jwt>\` or \`Bearer dft_...\` |
| \`x-api-key\` | Developer token alternative |
| \`x-tenant-id\` | Tenant override - **platform ADMIN JWT only** |
| \`x-act-as-role\` | Run a query/data call "as" another role to test policies - **ADMIN JWT only, ignored for API tokens** |
| \`x-region\` | Execution region (default \`AP\`) |
| \`Accept: application/x-ndjson\` | Stream rows as NDJSON (with \`"stream": true\`) |

### Error model
Every non-2xx response is JSON \`{ "error": "<message>", "code": "<STABLE_CODE>" }\`. Common codes: \`SQL_NOT_SUPPORTED\`, \`VALIDATION_ERROR\` (400); \`UNAUTHENTICATED\`, \`INVALID_TOKEN\`, \`TOKEN_REVOKED\`, \`TOKEN_EXPIRED\` (401); \`SCOPE_REQUIRED\`, \`TOKEN_NOT_ALLOWED\`, \`TOKEN_FROM_TOKEN\`, \`TENANT_SUSPENDED\`, \`TENANT_NOT_AVAILABLE\`, \`IP_NOT_ALLOWED\` (403); \`MAINTENANCE\`, \`GUARD_UNAVAILABLE\` (503, workspace guard); \`NOT_FOUND\` (404); \`CONFLICT\` (409); \`RATE_LIMITED\` (429). Legacy endpoints may omit \`code\`; always branch on the HTTP status first.

### AST only - no raw SQL
The platform executes **structured AST queries** only. The former \`/api/queries/exec\` and \`/api/queries/native\` endpoints were removed, and any \`sql\` / \`rawSql\` / \`nativeSql\` field in a body returns \`400 SQL_NOT_SUPPORTED\`. \`POST /api/queries/transpile\` still previews the SQL an AST would compile to, but never executes it.

### Rate limits & plans
Tenants on a plan are subject to per-minute/hour/day request quotas (\`429\`) and to trial expiry (\`402\`). Platform ADMINs bypass licensing.
`;

/* ------------------------------------------------------------------ */
/* Tiny authoring helpers used by the operation modules                */
/* ------------------------------------------------------------------ */

/** `$ref` to a component schema. */
export const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
/** Array of `$ref`. */
export const refArray = (name: string): Json => ({ type: 'array', items: ref(name) });
/** One named request/response example. */
export const ex = (summary: string, value: Json, description?: string): ExampleDef => ({ summary, value, ...(description ? { description } : {}) });
/** `{ example: ... }` shorthand for a JSON request body with named examples. */
export const jsonBody = (schema: Json, examples: Record<string, ExampleDef>, description?: string, required = true): BodyDef => ({ schema, examples, required, ...(description ? { description } : {}) });
/** Query-string parameter. */
export const q = (name: string, description: string, schema: Json = { type: 'string' }, example?: Json, required = false): ParamDef => ({ name, in: 'query', description, schema, required, ...(example !== undefined ? { example } : {}) });
/** Path parameter with description. */
export const pp = (name: string, description: string, example?: Json): ParamDef => ({ name, in: 'path', description, required: true, ...(example !== undefined ? { example } : {}) });
