/**
 * Tenancy, licensing and plan operations:
 *  - `/api/system/*`   platform settings, licence key, plan catalogue, workspaces, plan requests, stats, events
 *                      (platform ADMIN JWT session only)            -> system document only
 *  - `/api/workspace*` the caller's active workspace: settings, limits, plan
 *                      (JWT session only; reads for members, changes for the owner / a platform admin)
 *                      reads are in BOTH documents, changes in the system document.
 */
import { OpDef, TagDef, ex, jsonBody, pp, q, ref, refArray } from './shared';

export const TT = {
  settings: 'System settings',
  licence: 'Licence',
  plans: 'Plans',
  workspaces: 'Workspaces (system)',
  workspace: 'Workspace',
};

const adm = { auth: 'session' as const, platformAdmin: true, tenantHeader: false };
const ws = { auth: 'session' as const, forbidden: 'WorkspaceGuardForbidden' };

const adminForbidden = { description: 'Caller is not a platform admin (`FORBIDDEN`) or sent a developer API token (`TOKEN_NOT_ALLOWED`).', codes: ['FORBIDDEN', 'TOKEN_NOT_ALLOWED'] };
const ownerForbidden = { description: 'Only the workspace owner or a platform admin may change this (`WORKSPACE_ADMIN_REQUIRED`); developer API tokens get `TOKEN_NOT_ALLOWED`; the workspace guard may answer `TENANT_SUSPENDED` / `TENANT_NOT_AVAILABLE` / `IP_NOT_ALLOWED`.', codes: ['WORKSPACE_ADMIN_REQUIRED', 'TOKEN_NOT_ALLOWED', 'TENANT_SUSPENDED', 'TENANT_NOT_AVAILABLE', 'IP_NOT_ALLOWED'] };
const noWorkspace = { description: 'The session has no active workspace (`NO_WORKSPACE`): exchange it for a workspace token with `POST /api/auth/token` first.', code: 'NO_WORKSPACE', message: 'No active workspace: exchange your session for a workspace token first' };
const wsNotFound = { description: 'The workspace does not exist.', code: 'WORKSPACE_NOT_FOUND', message: 'workspace not found' };

const settingsEx = {
  defaultPlan: 'trial', planLimitsEnabled: true, allowSelfSignup: true, allowWorkspaceCreation: true, maxWorkspacesPerUser: -1,
  defaultRegion: 'AP', maintenanceMode: false, maintenanceMessage: '', maxTokenDays: 365,
};
const wsSettingsEx = {
  general: { timezone: 'UTC' }, query: { allowStreaming: true }, security: { allowedIps: [] },
  api: { allowDeveloperTokens: true, allowedScopes: ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] },
  notifications: { emailOnLimit: true, limitWarningPercent: 80 },
};
const effectiveEx = {
  tenantId: 't_acme',
  plan: { name: 'trial', source: 'default' },
  limits: { max_connections: 2, max_tables: 5, max_triggers: 3, max_query_rows: 10000, rate_limit_per_min: 10, max_users_per_workspace: 5 },
  features: { developer_tokens_enabled: true, workspace_settings_enabled: true, trial_period_days: 7 },
  trial: { startedAt: '2026-10-12T09:00:00.000Z', endsAt: '2026-10-19T09:00:00.000Z', expired: false, days: 7 },
  licence: { status: 'none', licensee: null, selfHosted: false, expiresAt: null },
  planLimitsEnabled: true,
};
const usageEx = { max_connections: 1, max_tables: 12, max_triggers: 0, max_saved_analytics: 3, max_users_per_workspace: 2, active_api_tokens: 1, max_replications: 0 };
const licenceEx = {
  status: 'valid', source: 'settings', error: null, licensee: 'Acme Corp', product: 'zero-datafabric', name: 'enterprise', schemaVersion: 1,
  issuedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2027-09-01T00:00:00.000Z', selfHosted: false, limits: { max_connections: 50 }, features: { enterprise_sso_enabled: true },
  maxInstallations: 1, boundInstanceId: null, validation: { status: 'valid', lastSuccessAt: '2026-10-19T06:00:00.000Z', errorMessage: null },
};
const planRow = {
  id: '5f0c1c8e-3a52-4b27-8f64-1a2b3c4d5e6f', name: 'pro', description: 'For growing teams', price_monthly: 49,
  limits: { max_connections: 20, max_users_per_workspace: 25, max_query_rows: 100000 }, features: { developer_tokens_enabled: true, trial_period_days: -1 },
  is_default: false, is_custom: false, status: 'active', contact_config: null, max_tenants: -1, created_at: '2026-09-01T10:00:00.000Z',
};
const wsSummary = { id: 't_acme', name: 'Acme Corp', status: 'ACTIVE', plan: 'pro', planExpiresAt: null, ownerUserId: 'b1c2d3e4-0000-4000-8000-000000000001', ownerUsername: 'alice', createdAt: '2026-09-01T10:00:00.000Z' };
const requestRow = { id: '7a1f6c3e-4d2b-4c8e-9b1a-0e5d6f7a8b9c', tenant_id: 't_acme', tenant_name: 'Acme Corp', requested_by: 'alice', plan_name: 'enterprise', message: 'We need 50 users and SSO.', status: 'open', created_at: '2026-10-18T08:30:00.000Z', resolved_by: null, resolved_at: null };
const wsIdParam = pp('id', 'Workspace (tenant) id, e.g. `t_acme`: a letter followed by letters, digits or `_` (2-41 chars).', 't_acme');

/* ------------------------------------------------------------------ */
/* /api/system/*  (system document only)                                */
/* ------------------------------------------------------------------ */
export const systemTenancyOps: OpDef[] = [
  /* ---- settings ---- */
  {
    ...adm, method: 'get', path: '/api/system/settings', tag: TT.settings, summary: 'Get system settings',
    description: 'Platform-wide settings with defaults filled in: default plan, plan-limits master switch, sign-up / workspace-creation policy, default region, maintenance mode and the token-lifetime ceiling. Cached for a few seconds server-side.',
    responses: { '200': { description: 'Current settings.', schema: ref('SystemSettings'), example: settingsEx } },
    errors: { '403': adminForbidden },
  },
  {
    ...adm, method: 'put', path: '/api/system/settings', tag: TT.settings, summary: 'Update system settings',
    description: 'Partial update with strict validation: send only the keys to change. Unknown keys are rejected with `UNKNOWN_SETTINGS`; wrong types/ranges (or a `defaultPlan` that is not an active, non-custom plan) with `INVALID_SETTINGS`. While `maintenanceMode` is true every non-admin request gets 503 `MAINTENANCE`. Recorded as `SYSTEM_SETTINGS_UPDATED` in the system event log.',
    body: jsonBody(ref('SystemSettingsPatch'), {
      maintenance: ex('Enter maintenance mode', { maintenanceMode: true, maintenanceMessage: 'Back at 10:00 UTC' }),
      policy: ex('Cap workspaces and token lifetime', { maxWorkspacesPerUser: 5, maxTokenDays: 90, defaultPlan: 'trial' }),
    }),
    responses: { '200': { description: 'The full settings after the update.', schema: ref('SystemSettings'), example: { ...settingsEx, maintenanceMode: true, maintenanceMessage: 'Back at 10:00 UTC' } } },
    errors: {
      '400': { description: 'Unknown key or invalid value.', codes: ['INVALID_SETTINGS', 'UNKNOWN_SETTINGS'], message: 'system.maxTokenDays: must be an integer between 1 and 365' },
      '403': adminForbidden,
    },
  },

  /* ---- licence ---- */
  {
    ...adm, method: 'get', path: '/api/system/license', tag: TT.licence, summary: 'Licence status',
    description: 'Status, ceilings and features of the installed licence key, plus this installation\'s `instanceId`. The key itself is never returned. Only a `valid` licence has any effect; every other status (`none`, `invalid`, `expired`, `wrong_instance`, `revoked`) behaves like "no licence" - plan limits apply, never unlimited.',
    responses: { '200': { description: 'Licence view.', schema: ref('LicenseView'), example: { ...licenceEx, instanceId: '0d6c9f7e-1c3a-4e6c-9a53-2f1b7f0e9a11' } } },
    errors: { '403': adminForbidden },
  },
  {
    ...adm, method: 'post', path: '/api/system/license', tag: TT.licence, summary: 'Install a licence key',
    description: 'Verifies the signed key (signature, expiry, instance binding) and stores it, replacing any previous key. Rejected with 409 `LICENSE_FROM_ENV` when the key is supplied through the `LICENSE_KEY` environment variable (that one wins and must be changed there). Limits are re-evaluated immediately. Recorded as `LICENSE_INSTALLED`.',
    body: jsonBody(ref('LicenseInstallRequest'), { key: ex('Install', { licenseKey: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...' }) }),
    responses: { '201': { description: 'Installed; the resulting licence view.', schema: ref('LicenseView'), example: licenceEx } },
    errors: {
      '400': { description: 'Key missing, expired, malformed/badly signed, or bound to another installation.', codes: ['INVALID_LICENSE', 'LICENSE_EXPIRED', 'WRONG_INSTANCE'], message: 'This licence key is not valid (bad signature or malformed)' },
      '403': adminForbidden,
      '409': { description: 'The key is managed through the `LICENSE_KEY` environment variable.', code: 'LICENSE_FROM_ENV', message: 'The licence key is set through the LICENSE_KEY environment variable; change it there' },
    },
  },
  {
    ...adm, method: 'delete', path: '/api/system/license', tag: TT.licence, summary: 'Remove the licence key',
    description: 'Deletes the stored key and its validation state; plan limits apply again. Not possible when the key comes from the `LICENSE_KEY` environment variable. Recorded as `LICENSE_REMOVED`.',
    responses: { '200': { description: 'Licence view after removal (status `none`).', schema: ref('LicenseView'), example: { ...licenceEx, status: 'none', source: null, licensee: null, product: null, name: null, schemaVersion: null, issuedAt: null, expiresAt: null, limits: null, features: null, maxInstallations: null, validation: null } } },
    errors: { '403': adminForbidden, '409': { description: 'The key is managed through the `LICENSE_KEY` environment variable.', code: 'LICENSE_FROM_ENV', message: 'The licence key is set through the LICENSE_KEY environment variable; remove it there' } },
  },
  {
    ...adm, method: 'post', path: '/api/system/license/validate', tag: TT.licence, summary: 'Re-evaluate the licence now',
    description: 'Clears the licence and limits caches (normally refreshed every 15 s) and re-evaluates the key immediately. Use after the licensing portal changed the key.',
    responses: { '200': { description: 'Freshly evaluated licence view.', schema: ref('LicenseView'), example: licenceEx } },
    errors: { '403': adminForbidden },
  },

  /* ---- plans ---- */
  {
    ...adm, method: 'get', path: '/api/system/plans', tag: TT.plans, summary: 'Plan catalogue (all plans)',
    description: 'Every plan including `disabled`, `hidden`, `upcoming` and custom plans, ordered by price then name. Workspaces see the selectable subset through `GET /api/workspace/plans`.',
    responses: { '200': { description: 'All plans.', schema: refArray('Plan'), example: [planRow] } },
    errors: { '403': adminForbidden },
  },
  {
    ...adm, method: 'post', path: '/api/system/plans', tag: TT.plans, summary: 'Create a plan',
    description: '`name`, `limits` and `features` are required. Limit/feature keys are validated (unknown keys rejected). The default plan must be `active` and not custom; flagging a plan default unsets the previous default. Recorded as `PLAN_CREATED`.',
    body: jsonBody(ref('PlanDefinition'), {
      pro: ex('Pro plan', { name: 'pro', description: 'For growing teams', price_monthly: 49, limits: { max_connections: 20, max_users_per_workspace: 25, max_query_rows: 100000 }, features: { developer_tokens_enabled: true, workspace_settings_enabled: true, trial_period_days: -1 }, status: 'active' }),
      custom: ex('By-arrangement plan', { name: 'enterprise', price_monthly: 0, is_custom: true, limits: { max_connections: -1 }, features: {}, contact_config: { email: 'sales@example.com' } }),
    }),
    responses: { '201': { description: 'Created plan.', schema: ref('Plan'), example: planRow } },
    errors: {
      '400': { description: 'Invalid plan definition.', code: 'INVALID_PLAN', message: 'unknown limit "max_foo"' },
      '403': adminForbidden,
      '409': { description: 'A plan with this name exists.', code: 'PLAN_EXISTS', message: 'a plan with this name already exists' },
    },
  },
  {
    ...adm, method: 'put', path: '/api/system/plans/{id}', tag: TT.plans, summary: 'Edit a plan',
    description: 'Partial update: send only the fields to change (`nothing to update` is a 400). The current default cannot be unset - make another plan the default instead. Changes apply to workspaces on the plan within seconds. Recorded as `PLAN_UPDATED`.',
    params: [pp('id', 'Plan id (UUID).', '5f0c1c8e-3a52-4b27-8f64-1a2b3c4d5e6f')],
    body: jsonBody(ref('PlanDefinition'), { price: ex('Change price and a limit', { price_monthly: 59, limits: { max_connections: 30 } }), hide: ex('Retire a plan', { status: 'hidden' }) }),
    responses: { '200': { description: 'Updated plan.', schema: ref('Plan'), example: { ...planRow, price_monthly: 59 } } },
    errors: {
      '400': { description: 'Invalid plan definition or nothing to update.', code: 'INVALID_PLAN', message: 'the default plan must be active and not custom' },
      '403': adminForbidden,
      '404': { description: 'No plan with this id.', code: 'PLAN_NOT_FOUND', message: 'plan not found' },
      '409': { description: 'Renaming to a name that exists.', code: 'PLAN_EXISTS', message: 'a plan with this name already exists' },
    },
  },
  {
    ...adm, method: 'delete', path: '/api/system/plans/{id}', tag: TT.plans, summary: 'Delete a plan',
    description: 'Only an unused, non-default, non-built-in plan can be deleted (the built-in `trial` and `selfhost` plans can only be disabled or hidden). Recorded as `PLAN_DELETED`.',
    params: [pp('id', 'Plan id (UUID).', '5f0c1c8e-3a52-4b27-8f64-1a2b3c4d5e6f')],
    responses: { '204': { description: 'Deleted (no body).' } },
    errors: {
      '403': adminForbidden,
      '404': { description: 'No plan with this id.', code: 'PLAN_NOT_FOUND', message: 'plan not found' },
      '409': { description: 'The plan is the default, built-in, or still used by workspaces/subscriptions.', code: 'PLAN_IN_USE', message: '2 workspace(s)/subscription(s) use this plan; move them first' },
    },
  },

  /* ---- workspaces ---- */
  {
    ...adm, method: 'get', path: '/api/system/workspaces', tag: TT.workspaces, summary: 'List workspaces',
    description: 'Paginated list of all workspaces, newest first, with plan and owner. Filter by status, plan or a free-text search over id and name.',
    params: [
      q('limit', '1-200 (default 50).', { type: 'integer', minimum: 1, maximum: 200, default: 50 }, 50),
      q('offset', 'Rows to skip (default 0).', { type: 'integer', minimum: 0, default: 0 }, 0),
      q('status', 'Exact status, case-insensitive: `ACTIVE`, `SUSPENDED`, `DELETED`.', undefined, 'ACTIVE'),
      q('plan', 'Exact plan name.', undefined, 'trial'),
      q('search', 'Substring of the workspace id or name.', undefined, 'acme'),
    ],
    responses: { '200': { description: 'A page of workspaces.', schema: ref('WorkspaceList'), example: { total: 1, limit: 50, offset: 0, workspaces: [wsSummary] } } },
    errors: { '403': adminForbidden },
  },
  {
    ...adm, method: 'get', path: '/api/system/workspaces/{id}', tag: TT.workspaces, summary: 'Workspace detail',
    description: 'The workspace row (plan, overrides, settings), its effective limits (plan + overrides + licence ceiling) and current usage.',
    params: [wsIdParam],
    responses: { '200': { description: 'Workspace, effective limits and usage.', schema: ref('WorkspaceDetail'), example: { workspace: { id: 't_acme', name: 'Acme Corp', status: 'ACTIVE', plan_name: 'pro', plan_started_at: '2026-10-01T09:00:00.000Z', plan_expires_at: null, plan_overrides: {}, user_id: 'b1c2d3e4-0000-4000-8000-000000000001', created_at: '2026-09-01T10:00:00.000Z', settings: wsSettingsEx }, effective: effectiveEx, usage: usageEx } } },
    errors: { '403': adminForbidden, '404': wsNotFound },
  },
  {
    ...adm, method: 'put', path: '/api/system/workspaces/{id}', tag: TT.workspaces, summary: 'Rename, suspend or activate a workspace',
    description: 'Send `name` and/or `status` (`ACTIVE` | `SUSPENDED`). Suspending takes effect within seconds: every session and API token of that workspace then gets 403 `TENANT_SUSPENDED` (platform admins are unaffected). Recorded as `WORKSPACE_UPDATED`.',
    params: [wsIdParam],
    body: jsonBody(ref('WorkspaceUpdate'), { suspend: ex('Suspend', { status: 'SUSPENDED' }), rename: ex('Rename', { name: 'Acme Corp (EU)' }) }),
    responses: { '200': { description: 'Updated workspace.', schema: ref('WorkspaceIdentity'), example: { id: 't_acme', name: 'Acme Corp', status: 'SUSPENDED' } } },
    errors: { '400': { description: 'Unknown field, invalid name/status, or nothing to update.', code: 'INVALID_WORKSPACE', message: 'status must be ACTIVE or SUSPENDED' }, '403': adminForbidden, '404': wsNotFound },
  },
  {
    ...adm, method: 'put', path: '/api/system/workspaces/{id}/plan', tag: TT.workspaces, summary: 'Assign a plan to a workspace',
    description: 'Assigns any plan (including custom/hidden ones) and restarts the plan clock. `expiresAt` sets a fixed end date; `overrides` raises or lowers individual limits for this workspace only. **Previous overrides are replaced** by the ones sent (omit to clear). Recorded as `WORKSPACE_PLAN_ASSIGNED`.',
    params: [wsIdParam],
    body: jsonBody(ref('PlanAssignment'), { simple: ex('Move to pro', { plan: 'pro' }), custom: ex('Pro with a raised limit and an end date', { plan: 'pro', expiresAt: '2027-01-01T00:00:00.000Z', overrides: { max_connections: 100 } }) }),
    responses: { '200': { description: 'The workspace\'s new effective limits.', schema: ref('EffectiveLimits'), example: { ...effectiveEx, plan: { name: 'pro', source: 'workspace' } } } },
    errors: { '400': { description: 'Unknown field, missing plan, past `expiresAt`, or an invalid override.', code: 'INVALID_PLAN_ASSIGNMENT', message: 'plan (name) is required' }, '403': adminForbidden, '404': { description: 'Unknown plan or workspace.', codes: ['PLAN_NOT_FOUND', 'WORKSPACE_NOT_FOUND'] } },
  },
  {
    ...adm, method: 'post', path: '/api/system/workspaces/{id}/plan/extend', tag: TT.workspaces, summary: 'Extend the trial / plan end',
    description: 'Send `days` (1-3650; added to the later of now and the current end date) or `until` (an absolute future date). Recorded as `WORKSPACE_PLAN_EXTENDED`.',
    params: [wsIdParam],
    body: jsonBody(ref('PlanExtension'), { days: ex('Add 14 days', { days: 14 }), until: ex('Until a date', { until: '2026-12-31T00:00:00.000Z' }) }),
    responses: { '200': { description: 'The workspace\'s new effective limits (see `trial.endsAt`).', schema: ref('EffectiveLimits'), example: effectiveEx } },
    errors: { '400': { description: 'Neither `days` nor `until`, an invalid date, or an end date in the past.', code: 'INVALID_EXTENSION', message: 'send days (1-3650) or until (date)' }, '403': adminForbidden, '404': wsNotFound },
  },
  {
    ...adm, method: 'post', path: '/api/system/workspaces/{id}/owner', tag: TT.workspaces, summary: 'Change the workspace owner',
    description: 'Makes another existing user the owner (who can then change workspace settings, rename it and pick a plan). Identify the user by `userId` (UUID) or `username`. Recorded as `WORKSPACE_OWNER_CHANGED`.',
    params: [wsIdParam],
    body: jsonBody(ref('OwnerChange'), { byUsername: ex('By username', { username: 'alice' }), byId: ex('By id', { userId: 'b1c2d3e4-0000-4000-8000-000000000001' }) }),
    responses: { '200': { description: 'New owner.', schema: ref('OwnerChanged'), example: { id: 't_acme', ownerUserId: 'b1c2d3e4-0000-4000-8000-000000000001', ownerUsername: 'alice' } } },
    errors: { '403': adminForbidden, '404': { description: 'Unknown user or workspace.', codes: ['USER_NOT_FOUND', 'WORKSPACE_NOT_FOUND'] } },
  },

  /* ---- plan requests ---- */
  {
    ...adm, method: 'get', path: '/api/system/plan-requests', tag: TT.plans, summary: 'List plan requests',
    description: '"Contact us" requests raised by workspace owners for custom plans, newest first (max 200). Defaults to `open` requests.',
    params: [q('status', 'Filter: `open` (default), `approved`, `rejected`, `closed` or `all`.', { type: 'string', enum: ['open', 'approved', 'rejected', 'closed', 'all'], default: 'open' }, 'open')],
    responses: { '200': { description: 'Plan requests.', schema: refArray('PlanRequest'), example: [requestRow] } },
    errors: { '400': { description: 'Invalid `status` filter.', code: 'INVALID_QUERY', message: 'invalid status' }, '403': adminForbidden },
  },
  {
    ...adm, method: 'put', path: '/api/system/plan-requests/{id}', tag: TT.plans, summary: 'Resolve a plan request',
    description: 'Marks an **open** request `approved`, `rejected` or `closed`. Approving does not assign anything: follow up with `PUT /api/system/workspaces/{id}/plan`. Recorded as `PLAN_REQUEST_RESOLVED`.',
    params: [pp('id', 'Plan request id (UUID).', '7a1f6c3e-4d2b-4c8e-9b1a-0e5d6f7a8b9c')],
    body: jsonBody(ref('PlanRequestResolution'), { approve: ex('Approve', { status: 'approved' }), reject: ex('Reject', { status: 'rejected' }) }),
    responses: { '200': { description: 'The resolved request.', schema: ref('PlanRequest'), example: { ...requestRow, status: 'approved', resolved_by: 'root', resolved_at: '2026-10-19T09:00:00.000Z' } } },
    errors: { '400': { description: '`status` is not approved/rejected/closed.', code: 'INVALID_REQUEST', message: 'status must be approved, rejected or closed' }, '403': adminForbidden, '404': { description: 'No open request with this id (unknown or already resolved).', code: 'REQUEST_NOT_FOUND', message: 'open request not found' } },
  },

  /* ---- stats & events ---- */
  {
    ...adm, method: 'get', path: '/api/system/stats', tag: TT.workspaces, summary: 'Platform counters',
    description: 'Workspaces by status and by plan, total users and the licence status.',
    responses: { '200': { description: 'Counters.', schema: ref('SystemStats'), example: { workspacesByStatus: [{ status: 'ACTIVE', n: 11 }, { status: 'SUSPENDED', n: 1 }], workspacesByPlan: [{ plan: 'trial', n: 9 }, { plan: 'pro', n: 3 }], users: 31, license: 'none' } } },
    errors: { '403': adminForbidden },
  },
  {
    ...adm, method: 'get', path: '/api/system/events', tag: TT.workspaces, summary: 'System event log',
    description: 'Audit trail of platform and workspace changes (settings, licence, plans, workspace status/plan/owner, plan requests), newest first.',
    params: [q('limit', '1-200 (default 50).', { type: 'integer', minimum: 1, maximum: 200, default: 50 }, 50), q('tenantId', 'Only events of this workspace.', undefined, 't_acme')],
    responses: { '200': { description: 'Events.', schema: refArray('SystemEvent'), example: [{ id: 1042, actor: 'root', action: 'WORKSPACE_PLAN_ASSIGNED', tenantId: 't_acme', detail: { plan: 'pro', expiresAt: null, overrides: {} }, createdAt: '2026-10-19T09:00:00.000Z' }] } },
    errors: { '403': adminForbidden },
  },

  /* ---- workspace: changes (system document only) ---- */
  {
    ...ws, method: 'put', path: '/api/workspace', tag: TT.workspace, summary: 'Rename the workspace',
    description: 'Renames the caller\'s active workspace. Needs the workspace owner or a platform admin (platform admins pick the workspace with `x-tenant-id`). Recorded as `WORKSPACE_RENAMED`.',
    body: jsonBody(ref('WorkspaceRename'), { rename: ex('Rename', { name: 'Acme Analytics' }) }),
    responses: { '200': { description: 'Updated workspace.', schema: { type: 'object', properties: { id: { type: 'string', example: 't_acme' }, name: { type: 'string', example: 'Acme Analytics' } } }, example: { id: 't_acme', name: 'Acme Analytics' } } },
    errors: { '400': { description: 'Unknown field / invalid name, or no active workspace.', codes: ['INVALID_WORKSPACE', 'NO_WORKSPACE'], message: 'name must be 1-100 characters' }, '403': ownerForbidden },
  },
  {
    ...ws, method: 'put', path: '/api/workspace/settings/{section}', tag: TT.workspace, summary: 'Update a settings section',
    description:
      'Partial update of one section (`general`, `query`, `security`, `api` or `notifications`); send only the keys to change. Needs the owner or a platform admin and the `workspace_settings_enabled` feature (403 `FEATURE_DISABLED` when the plan/licence turns it off). ' +
      '`api.maxTokenDays` cannot exceed the system `maxTokenDays` (400 `EXCEEDS_SYSTEM_LIMIT`) and `query.maxRows` cannot exceed the licensed `max_query_rows` (400 `EXCEEDS_LICENCE_LIMIT`). Unknown keys: `UNKNOWN_SETTINGS`; bad values: `INVALID_SETTINGS`. ' +
      '`security.allowedIps` locks the workspace to those IPs/CIDRs - mind your own address. Recorded as `WORKSPACE_SETTINGS_UPDATED`.',
    params: [{ name: 'section', in: 'path', description: 'Settings section.', required: true, schema: { type: 'string', enum: ['general', 'query', 'security', 'api', 'notifications'] }, example: 'query' }],
    body: jsonBody(ref('WorkspaceSettingsSection'), {
      query: ex('query section', { maxRows: 5000, timeoutMs: 30000 }),
      security: ex('security section: IP allow-list', { allowedIps: ['203.0.113.0/24', '198.51.100.7'] }),
      api: ex('api section', { allowDeveloperTokens: true, maxTokenDays: 90, allowedScopes: ['query:read', 'data:read'] }),
      general: ex('general section', { displayName: 'Acme Analytics', timezone: 'Asia/Kolkata', contactEmail: 'ops@acme.example' }),
      notifications: ex('notifications section', { emailOnLimit: true, limitWarningPercent: 90 }),
    }),
    responses: { '200': { description: 'The whole section after the update (defaults filled in).', schema: ref('WorkspaceSettingsSection'), example: { maxRows: 5000, timeoutMs: 30000, allowStreaming: true } } },
    errors: {
      '400': { description: 'Invalid or unknown setting, a value above a system/licence ceiling, or no active workspace.', codes: ['INVALID_SETTINGS', 'UNKNOWN_SETTINGS', 'EXCEEDS_SYSTEM_LIMIT', 'EXCEEDS_LICENCE_LIMIT', 'NO_WORKSPACE'], message: 'api.maxTokenDays cannot exceed the system maximum of 90' },
      '403': { description: ownerForbidden.description + ' `FEATURE_DISABLED` when the plan/licence does not include workspace settings.', codes: ['WORKSPACE_ADMIN_REQUIRED', 'FEATURE_DISABLED', 'TOKEN_NOT_ALLOWED', 'TENANT_SUSPENDED', 'IP_NOT_ALLOWED'] },
      '404': { description: 'Unknown section or workspace.', codes: ['UNKNOWN_SECTION', 'WORKSPACE_NOT_FOUND'], message: 'Unknown settings section "foo"' },
    },
  },
  {
    ...ws, method: 'get', path: '/api/workspace/plans', tag: TT.workspace, summary: 'Plans this workspace may pick',
    description: 'The `active` and `upcoming` plans (never the internal `selfhost` plan), cheapest first. Only `active`, non-custom plans can be selected with `PUT /api/workspace/plan`; custom ones go through a plan request.',
    responses: { '200': { description: 'Selectable plans.', schema: refArray('Plan'), example: [{ name: 'trial', description: null, price_monthly: 0, limits: { max_connections: 2 }, features: { trial_period_days: 7 }, is_default: true, is_custom: false, status: 'active', contact_config: null }] } },
    errors: { '400': noWorkspace },
  },
  {
    ...ws, method: 'put', path: '/api/workspace/plan', tag: TT.workspace, summary: 'Switch the workspace plan',
    description:
      'Self-service plan change by the owner (or a platform admin, who may pick any plan and skips the checks). The plan must be `active` and not custom (403 `PLAN_NOT_SELECTABLE`), the current usage must fit its limits (409 `PLAN_DOES_NOT_FIT`, with a `problems` list) and a trial plan can only be taken once per workspace (409 `TRIAL_ALREADY_USED`). Clears per-workspace overrides and the end date. Recorded as `WORKSPACE_PLAN_SELECTED`.',
    body: jsonBody(ref('PlanSelection'), { pro: ex('Switch to pro', { plan: 'pro' }) }),
    responses: {
      '200': { description: 'The workspace\'s new effective limits.', schema: ref('EffectiveLimits'), example: { ...effectiveEx, plan: { name: 'pro', source: 'workspace' } } },
      '409': { description: 'Usage exceeds the target plan (`PLAN_DOES_NOT_FIT`, with `problems`) or the workspace already used its trial (`TRIAL_ALREADY_USED`).', schema: ref('PlanDoesNotFitError'), example: { error: 'The workspace uses more than this plan allows', code: 'PLAN_DOES_NOT_FIT', problems: ['max_connections: using 5, plan allows 2'] } },
    },
    errors: {
      '400': { description: '`plan` missing, or no active workspace.', codes: ['INVALID_PLAN_SELECTION', 'NO_WORKSPACE'], message: 'plan (name) is required' },
      '403': { description: 'The plan cannot be self-selected (`PLAN_NOT_SELECTABLE`: not active, custom or internal) or the caller is not the owner / a platform admin (`WORKSPACE_ADMIN_REQUIRED`).', codes: ['PLAN_NOT_SELECTABLE', 'WORKSPACE_ADMIN_REQUIRED', 'TOKEN_NOT_ALLOWED', 'TENANT_SUSPENDED', 'IP_NOT_ALLOWED'] },
      '404': { description: 'No plan with this name.', code: 'PLAN_NOT_FOUND', message: 'plan not found' },
    },
  },
  {
    ...ws, method: 'post', path: '/api/workspace/plan/requests', tag: TT.workspace, summary: 'Send a plan request ("contact us")',
    description: 'Asks the platform operator for a custom plan. Needs the owner or a platform admin. At most 3 requests can be open per workspace (429 `TOO_MANY_REQUESTS`). Operators see them under `GET /api/system/plan-requests`.',
    body: jsonBody(ref('PlanRequestInput'), { enterprise: ex('Ask for enterprise', { plan: 'enterprise', message: 'We need 50 users and SSO.' }) }),
    responses: { '201': { description: 'Request recorded.', schema: ref('PlanRequest'), example: { id: '7a1f6c3e-4d2b-4c8e-9b1a-0e5d6f7a8b9c', plan_name: 'enterprise', status: 'open', created_at: '2026-10-18T08:30:00.000Z' } } },
    errors: {
      '400': { description: 'Invalid `plan`/`message`, or no active workspace.', codes: ['INVALID_REQUEST', 'NO_WORKSPACE'], message: 'plan (name) is required' },
      '403': ownerForbidden,
      '429': { description: 'Three requests are already open for this workspace.', code: 'TOO_MANY_REQUESTS', message: 'At most 3 open plan requests per workspace' },
    },
  },
];

/* ------------------------------------------------------------------ */
/* /api/workspace reads (developer + system documents)                  */
/* ------------------------------------------------------------------ */
const sessionNote = ' **Session only**: a developer API token is rejected with 403 `TOKEN_NOT_ALLOWED`.';
export const workspaceReadOps: OpDef[] = [
  {
    ...ws, method: 'get', path: '/api/workspace', tag: TT.workspace, summary: 'Active workspace overview',
    description: 'The caller\'s active workspace (the one in the JWT; platform admins can pick another with `x-tenant-id`): identity, the caller\'s role (`platform_admin`, `owner` or `member`), all settings sections, the plan, trial window, licence summary and feature flags. Readable by every member.' + sessionNote,
    responses: { '200': { description: 'Workspace overview.', schema: ref('WorkspaceInfo'), example: { workspace: { id: 't_acme', name: 'Acme Corp', status: 'ACTIVE', ownerUserId: 'b1c2d3e4-0000-4000-8000-000000000001', createdAt: '2026-09-01T10:00:00.000Z' }, role: 'owner', settings: wsSettingsEx, plan: effectiveEx.plan, trial: effectiveEx.trial, licence: effectiveEx.licence, features: effectiveEx.features } } },
    errors: { '400': noWorkspace, '404': wsNotFound },
  },
  {
    ...ws, method: 'get', path: '/api/workspace/settings', tag: TT.workspace, summary: 'Workspace settings',
    description: 'All five settings sections (`general`, `query`, `security`, `api`, `notifications`) with defaults filled in. Readable by every member; change them with `PUT /api/workspace/settings/{section}` (system API, owner only).' + sessionNote,
    responses: { '200': { description: 'Settings.', schema: ref('WorkspaceSettings'), example: wsSettingsEx } },
    errors: { '400': noWorkspace },
  },
  {
    ...ws, method: 'get', path: '/api/workspace/limits', tag: TT.workspace, summary: 'Effective limits and usage',
    description: 'What the workspace may do now (plan or licence limits + overrides, capped by the licence ceiling; `-1` = unlimited), its feature flags, trial window, licence summary and current usage counters. When a limit is hit, calls fail with 403 `PLAN_LIMIT_REACHED` / `LICENSE_LIMIT_REACHED`; a disabled feature gives 403 `FEATURE_DISABLED`.' + sessionNote,
    responses: { '200': { description: 'Effective limits with usage.', schema: ref('EffectiveLimits'), example: { ...effectiveEx, usage: usageEx } } },
    errors: { '400': noWorkspace },
  },
];

export const tenancyTags: TagDef[] = [
  { name: TT.settings, description: 'Platform-wide settings: default plan, plan-limits master switch, sign-up and workspace-creation policy, maintenance mode, token-lifetime ceiling. Platform ADMIN JWT session only.' },
  { name: TT.licence, description: 'Licence key lifecycle: status, install, remove, re-validate. A usable key caps plan limits (or, self-hosted, replaces them). Platform ADMIN JWT session only.' },
  { name: TT.workspaces, description: 'Platform ADMIN: list and inspect workspaces, suspend/rename, assign plans with per-workspace overrides, extend trials, change owners; platform counters and the system event log.' },
  { name: TT.workspace, description: 'The caller\'s active workspace: overview, settings, effective limits/usage and plan selection. **JWT session only** (API tokens get 403 `TOKEN_NOT_ALLOWED`); reads for every member, changes for the workspace owner or a platform admin.' },
];

export const workspaceTagsForDeveloper: TagDef[] = [tenancyTags[3]!];
