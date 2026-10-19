/**
 * System (operator / whole-platform) OpenAPI document = every developer operation
 * PLUS administration, tenants, plans/subscriptions, settings, health, SSO,
 * replication writes and Citus worker management.
 */
import { AUTH_GUIDE, Json, OpDef, TagDef, TagGroup, buildSpec, ex, jsonBody, pp, q, ref, refArray } from './shared';
import { developerOps, developerTags, developerTagGroups } from './developer';
import { workerOps, workerTags } from './workers';
import { systemTenancyOps, tenancyTags } from './tenancy';

const T = {
  aTenants: 'Admin: Tenants',
  aConn: 'Admin: Connections',
  aUsers: 'Admin: Users',
  aInsights: 'Admin: Insights',
  aNotify: 'Admin: Notification Channels',
  tenants: 'Tenants',
  plans: 'Plans',
  subs: 'Subscriptions',
  settings: 'Settings',
  health: 'Health',
  sso: 'Auth: SSO & Session',
  docs: 'Developer Docs',
  replication: 'Replication',
};

const anyObj: Json = { type: 'object', additionalProperties: true };
const anyObjArray: Json = { type: 'array', items: anyObj };
const tenantEx = { id: 'tenant_A', name: 'Acme Corp', status: 'ACTIVE', created_at: '2026-09-01T10:00:00.000Z' };
const planEx = { id: 'plan_trial', name: 'trial', price_monthly: 0, limits: { max_tenants: 1, max_connections: 2, max_triggers: 3 }, features: { trial_period_days: 7 }, is_default: true, is_custom: false, status: 'active' };
const adm = { auth: 'session' as const, platformAdmin: true, tenantHeader: false };
const own = { auth: 'session' as const, tenantHeader: false };

const adminOps: OpDef[] = [
  /* ---- tenants ---- */
  { ...adm, method: 'get', path: '/api/admin/tenants', tag: T.aTenants, summary: 'List all tenants', description: 'Every tenant on the platform.', responses: { '200': { description: 'Tenants.', schema: refArray('Tenant'), example: [tenantEx] } } },
  {
    ...adm,
    method: 'post',
    path: '/api/admin/tenants',
    tag: T.aTenants,
    summary: 'Provision a tenant',
    description: 'Creates the tenant record and its isolated schemas.',
    body: jsonBody(ref('CreateTenantRequest'), { basic: ex('New tenant', { id: 'tenant_B', name: 'New Tenant' }) }),
    responses: { '201': { description: 'Created.', schema: ref('Tenant'), example: { id: 'tenant_B', name: 'New Tenant', status: 'ACTIVE' } } },
    errors: { '409': { description: 'Tenant id already exists.', code: 'CONFLICT', message: 'Tenant tenant_B already exists' } },
  },
  { ...adm, method: 'put', path: '/api/admin/tenants/{id}', tag: T.aTenants, summary: 'Update a tenant', description: 'Rename a tenant or change its lifecycle status (a SUSPENDED tenant gets 403 on data/query calls).', params: [pp('id', 'Tenant id.', 'tenant_A')], body: jsonBody(ref('UpdateTenantRequest'), { suspend: ex('Suspend', { status: 'SUSPENDED' }), rename: ex('Rename', { name: 'Acme Corp (renamed)' }) }), responses: { '200': { description: 'Updated tenant.', schema: ref('Tenant'), example: { ...tenantEx, status: 'SUSPENDED' } } } },
  { ...adm, method: 'patch', path: '/api/admin/tenants/{id}', tag: T.aTenants, summary: 'Partially update a tenant', description: 'Same semantics as PUT.', params: [pp('id', 'Tenant id.', 'tenant_A')], body: jsonBody(ref('UpdateTenantRequest'), { suspend: ex('Suspend', { status: 'SUSPENDED' }) }), responses: { '200': { description: 'Updated tenant.', schema: ref('Tenant'), example: { ...tenantEx, status: 'SUSPENDED' } } } },
  { ...adm, method: 'delete', path: '/api/admin/tenants/{id}', tag: T.aTenants, summary: 'De-provision a tenant', description: 'Drops the tenant and its schemas. **Irreversible.**', params: [pp('id', 'Tenant id.', 'tenant_A')], responses: { '200': { description: 'Deleted.', schema: ref('TenantDeleted'), example: { status: 'DELETED', id: 'tenant_A' } } } },

  /* ---- connections ---- */
  { ...own, method: 'get', path: '/api/admin/connections', tag: T.aConn, summary: 'List data source connections', description: 'Tenant-scoped data sources with a live reachability probe (`live_status`: LIVE / OFFLINE / UNREACHABLE).', responses: { '200': { description: 'Connections.', schema: refArray('Connection'), example: [{ id: 'src_1', name: 'Retail_Core', type: 'postgres', status: 'CONNECTED', live_status: 'LIVE' }] } } },
  {
    ...own,
    method: 'post',
    path: '/api/admin/connections',
    tag: T.aConn,
    summary: 'Register a data source',
    description: 'Registers (or re-integrates when the name exists) a remote source. Plan connection limits apply (403).',
    body: jsonBody(ref('CreateConnectionRequest'), { pg: ex('Postgres source', { name: 'Retail_Core', config: { type: 'postgres', host: 'db.internal', port: 5432, dbName: 'retail', user: 'fabric_reader', pass: 'REPLACE_ME', syncType: 'VIRTUAL' } }) }),
    responses: { '200': { description: 'Existing source re-integrated.', schema: ref('Connection'), example: { id: 'src_1', name: 'Retail_Core', status: 'CONNECTED' } }, '201': { description: 'New source registered.', schema: ref('Connection'), example: { id: 'src_2', name: 'Retail_Core', status: 'CONNECTED' } } },
  },
  { ...own, method: 'patch', path: '/api/admin/connections', tag: T.aConn, summary: 'Change a connection status', description: 'Marks a source CONNECTED or DISCONNECTED.', body: jsonBody(ref('ConnectionStatusRequest'), { off: ex('Disconnect', { sourceId: 'src_1', status: 'DISCONNECTED' }) }), responses: { '200': { description: 'Status changed.', schema: anyObj, example: { id: 'src_1', status: 'DISCONNECTED' } } } },
  { ...own, method: 'delete', path: '/api/admin/connections/{id}', tag: T.aConn, summary: 'Remove a data source', description: 'Unregisters the source and its catalog entries.', params: [pp('id', 'Source id.', 'src_1')], responses: { '200': { description: 'Removed.', schema: anyObj, example: { status: 'DELETED', id: 'src_1' } } } },

  /* ---- users ---- */
  { ...adm, method: 'get', path: '/api/admin/users', tag: T.aUsers, summary: 'List users', description: 'All platform identities.', responses: { '200': { description: 'Users.', schema: refArray('PlatformUser'), example: [{ id: 'b1c2d3e4', username: 'alice', tenant_id: 'tenant_A', role: 'ANALYST' }] } } },
  { ...adm, method: 'post', path: '/api/admin/users', tag: T.aUsers, summary: 'Create a user', description: 'Creates an identity bound to a tenant with an application role.', body: jsonBody(ref('CreateUserRequest'), { analyst: ex('Analyst', { username: 'alice', password: 'REPLACE_ME', tenantId: 'tenant_A', role: 'ANALYST' }) }), responses: { '201': { description: 'Created.', schema: ref('PlatformUser'), example: { id: 'b1c2d3e4', username: 'alice', tenant_id: 'tenant_A', role: 'ANALYST' } } }, errors: { '409': { description: 'Duplicate username.', code: 'CONFLICT', message: 'duplicate key value violates unique constraint' } } },
  { ...adm, method: 'put', path: '/api/admin/users/{id}', tag: T.aUsers, summary: 'Update a user', description: 'Change username, password, tenant or role.', params: [pp('id', 'User id.', 'b1c2d3e4')], body: jsonBody(ref('UpdateUserRequest'), { role: ex('Promote', { role: 'ADMIN' }) }), responses: { '200': { description: 'Updated.', schema: ref('PlatformUser'), example: { id: 'b1c2d3e4', username: 'alice', role: 'ADMIN' } } } },
  { ...adm, method: 'delete', path: '/api/admin/users/{id}', tag: T.aUsers, summary: 'Delete a user', description: 'Removes the identity.', params: [pp('id', 'User id.', 'b1c2d3e4')], responses: { '200': { description: 'Deleted.', schema: anyObj, example: { status: 'DELETED' } } } },

  /* ---- insights ---- */
  { ...own, method: 'get', path: '/api/admin/stats', tag: T.aInsights, summary: 'Dashboard counters', description: 'Tenants / connections / 24h audit events. Global for ADMIN, tenant-scoped for others.', responses: { '200': { description: 'Counters.', schema: ref('DashboardStats'), example: { tenants: 3, connections: 5, audits: 128 } } } },
  { ...adm, method: 'get', path: '/api/admin/audit-logs', tag: T.aInsights, summary: 'Recent audit logs', description: 'The 50 most recent platform-wide audit entries.', responses: { '200': { description: 'Audit entries.', schema: refArray('AuditLog'), example: [{ id: '1024', tenant_id: 'tenant_A', user_name: 'alice', action: 'UPDATE', table_name: 'orders', changed_at: '2026-10-19T09:00:00.000Z' }] } } },
  { ...own, method: 'get', path: '/api/admin/catalog', tag: T.aInsights, summary: 'Catalog summary', description: 'Schemas/tables with row counts and last-crawl time for the caller\'s tenant (all tenants for ADMIN).', responses: { '200': { description: 'Catalog rows.', schema: refArray('CatalogSummaryRow'), example: [{ schema_name: 'tenant_A_public', table_name: 'orders', row_count: 1200, last_crawled_at: '2026-10-19T08:00:00.000Z' }] } } },

  /* ---- notification channels ---- */
  { ...own, method: 'get', path: '/api/admin/notification-channels', tag: T.aNotify, summary: 'List notification channels', description: 'Channels used by triggers and platform alerts.', responses: { '200': { description: 'Channels.', schema: refArray('NotificationChannel'), example: [{ id: 'ch_1', channelType: 'SLACK', name: 'ops-alerts', config: { url: 'https://hooks.example.com/notify' }, isDefault: true, status: 'ACTIVE' }] } } },
  { ...own, method: 'post', path: '/api/admin/notification-channels', tag: T.aNotify, summary: 'Create or update a channel', description: 'Upserts by channel type + name.', body: jsonBody(ref('UpsertNotificationChannelRequest'), { webhook: ex('Webhook channel', { channelType: 'WEBHOOK', name: 'ops-alerts', config: { url: 'https://hooks.example.com/notify' }, isDefault: true }) }), responses: { '200': { description: 'Saved channel.', schema: ref('NotificationChannel'), example: { id: 'ch_1', channelType: 'WEBHOOK', name: 'ops-alerts', status: 'ACTIVE' } } } },
  { ...own, method: 'delete', path: '/api/admin/notification-channels/{id}', tag: T.aNotify, summary: 'Delete a channel', description: 'Removes the channel.', params: [pp('id', 'Channel id.', 'ch_1')], responses: { '200': { description: 'Deleted.', schema: anyObj, example: { status: 'DELETED' } } } },
  { ...own, method: 'post', path: '/api/admin/notification-channels/test', tag: T.aNotify, summary: 'Send a test notification', description: 'Enqueues a synthetic event through a channel type.', body: jsonBody(ref('TestNotificationRequest'), { webhook: ex('Test webhook', { channelType: 'WEBHOOK', name: 'ops-alerts' }) }), responses: { '200': { description: 'Enqueued.', schema: ref('TestNotificationResponse'), example: { status: 'ENQUEUED', jobId: 'job_42' } } } },
];

const tenantOps: OpDef[] = [
  { ...own, method: 'get', path: '/api/tenants', tag: T.tenants, summary: 'List my tenants', description: 'ADMIN sees all tenants; other users see only tenants they own.', responses: { '200': { description: 'Tenants.', schema: refArray('Tenant'), example: [tenantEx] } } },
  { ...own, method: 'post', path: '/api/tenants', tag: T.tenants, summary: 'Create a tenant', description: 'Creates a STANDARD tenant for the caller. The `id` is sanitised and prefixed `t_`; generated when omitted. Plan tenant limits apply.', body: jsonBody({ type: 'object', required: ['name'], properties: { id: { type: 'string', example: 'acme' }, name: { type: 'string', example: 'Acme Corp' } } }, { basic: ex('Create', { name: 'Acme Corp' }) }), responses: { '201': { description: 'Created.', schema: ref('Tenant'), example: { id: 't_acme', name: 'Acme Corp', status: 'ACTIVE' } } }, errors: { '403': 'Plan tenant limit reached.' } },
  { ...own, method: 'get', path: '/api/tenants/{id}', tag: T.tenants, summary: 'Get a tenant', description: 'Owner or ADMIN only.', params: [pp('id', 'Tenant id.', 't_acme')], responses: { '200': { description: 'Tenant.', schema: ref('Tenant'), example: tenantEx } } },
  { ...own, method: 'put', path: '/api/tenants/{id}', tag: T.tenants, summary: 'Update my tenant', description: 'Owner or ADMIN: rename or change status.', params: [pp('id', 'Tenant id.', 't_acme')], body: jsonBody(ref('UpdateTenantRequest'), { rename: ex('Rename', { name: 'Acme Inc' }) }), responses: { '200': { description: 'Updated.', schema: ref('Tenant'), example: tenantEx } } },
];

const planOps: OpDef[] = [
  { method: 'get', path: '/api/plans', tag: T.plans, auth: 'public', summary: 'List plans', description: 'Active subscription plans ordered by price.', responses: { '200': { description: 'Plans.', schema: refArray('Plan'), example: [planEx] } } },
  { method: 'get', path: '/api/plans/{id}', tag: T.plans, auth: 'public', summary: 'Get a plan', description: 'One plan including limits and features.', params: [pp('id', 'Plan id.', 'plan_trial')], responses: { '200': { description: 'Plan.', schema: ref('Plan'), example: planEx } } },
  { ...adm, method: 'post', path: '/api/plans', tag: T.plans, summary: 'Create a plan', description: 'Intended for platform ADMIN. Disabled in self-host mode (403).', body: jsonBody(ref('PlanInput'), { pro: ex('Pro plan', { name: 'pro', price_monthly: 49, limits: { max_tenants: 5, max_connections: 20 }, features: {} }) }), responses: { '201': { description: 'Created.', schema: ref('Plan'), example: { ...planEx, name: 'pro', price_monthly: 49 } } } },
  { ...adm, method: 'put', path: '/api/plans/{id}', tag: T.plans, summary: 'Update a plan', description: 'Intended for platform ADMIN. Omitted fields keep their value.', params: [pp('id', 'Plan id.', 'plan_trial')], body: jsonBody(ref('PlanInput'), { price: ex('Change price', { name: 'pro', price_monthly: 59 }) }), responses: { '200': { description: 'Updated.', schema: ref('Plan'), example: planEx } } },
  { ...adm, method: 'delete', path: '/api/plans/{id}', tag: T.plans, summary: 'Delete a plan', description: 'Intended for platform ADMIN.', params: [pp('id', 'Plan id.', 'plan_trial')], responses: { '200': { description: 'Deleted.', schema: ref('PlanDeleted'), example: { success: true, message: 'Plan deleted' } } } },
];

const subOps: OpDef[] = [
  { ...own, method: 'get', path: '/api/subscriptions/me', tag: T.subs, summary: 'My active subscription', description: 'Active plan, limits, trial status and next data-reset time.', responses: { '200': { description: 'Subscription.', schema: ref('Subscription'), example: { id: 'sub_01', plan_name: 'trial', status: 'active', is_trial_expired: false, next_data_reset_at: null } } } },
  { ...own, method: 'post', path: '/api/subscriptions/me', tag: T.subs, summary: 'Create or change my subscription', description: 'Switches the caller to `plan_id`.', body: jsonBody(ref('SubscriptionInput'), { upgrade: ex('Upgrade', { plan_id: 'plan_pro' }) }), responses: { '200': { description: 'Subscription row.', schema: ref('Subscription'), example: { id: 'sub_01', plan_id: 'plan_pro', status: 'active' } } } },
  { ...own, method: 'get', path: '/api/subscriptions/me/limits', tag: T.subs, summary: 'My plan limits', description: 'Limits and features of the active plan (trial limits when none).', responses: { '200': { description: 'Limits.', schema: ref('PlanLimits'), example: { limits: { max_tenants: 1 }, features: { trial_period_days: 7 } } } } },
];

const settingsOps: OpDef[] = [
  { method: 'get', path: '/api/settings/login', tag: T.settings, auth: 'public', summary: 'Login page configuration', description: 'Branding and SSO flags for the login screen. The OIDC secret is never included.', responses: { '200': { description: 'Public login settings.', schema: ref('LoginSettingsPublic'), example: { selfhost: false, title: 'Data Fabric', allow_password_login: true, sso_enabled: true, oidc_client_id: 'zero-datafabric' } } } },
  { ...adm, method: 'get', path: '/api/settings/login/raw', tag: T.settings, summary: 'Full login configuration', description: 'Includes the OIDC client secret.', responses: { '200': { description: 'Raw configuration.', schema: ref('LoginSettingsRaw'), example: { title: 'Data Fabric', oidc_client_id: 'zero-datafabric' } } } },
  { ...adm, method: 'post', path: '/api/settings/login', tag: T.settings, summary: 'Update login configuration', description: 'Self-host plan only (403 otherwise).', body: jsonBody(ref('LoginSettingsInput'), { brand: ex('Rebrand', { title: 'Acme Data', bg_color: '#04060f', allow_password_login: true, sso_enabled: true, oidc_issuer: 'https://ids.example.com', oidc_client_id: 'zero-datafabric' }) }), responses: { '200': { description: 'Saved configuration.', schema: ref('LoginSettingsRaw'), example: { title: 'Acme Data' } } } },
];

const healthOps: OpDef[] = [
  { method: 'get', path: '/api/health', tag: T.health, auth: 'public', summary: 'Service health with database probe', description: 'Uptime and database pool statistics. Returns 503 when the database is unreachable.', responses: { '200': { description: 'Healthy.', schema: ref('HealthResponse'), example: { status: 'HEALTHY', uptime: '12h 30m', database: { latency: '5ms', pool: { total: 10, idle: 8, waiting: 0 } } } }, '503': { description: 'Database unreachable.', schema: ref('HealthResponse'), example: { status: 'UNHEALTHY', error: 'Database Unreachable' } } } },
  { method: 'get', path: '/health', tag: T.health, auth: 'public', summary: 'Liveness probe', description: 'Static liveness answer for load balancers.', responses: { '200': { description: 'Up.', schema: ref('UpStatus'), example: { status: 'UP' } } } },
];

const ssoOps: OpDef[] = [
  { ...own, method: 'post', path: '/api/auth/timezone', tag: T.sso, summary: 'Save my timezone', description: 'Stores the user\'s IANA timezone (used for scheduled data resets).', body: jsonBody(ref('TimezoneRequest'), { ist: ex('Kolkata', { timezone: 'Asia/Kolkata' }) }), responses: { '200': { description: 'Saved.', schema: ref('MessageResponse'), example: { message: 'Timezone updated successfully' } } } },
  { method: 'get', path: '/api/auth/sso', tag: T.sso, auth: 'public', summary: 'Start OIDC single sign-on', description: 'Redirects the browser to the identity provider\'s authorization endpoint.', responses: { '302': { description: 'Redirect to the identity provider.' } } },
  { method: 'get', path: '/api/auth/sso/callback', tag: T.sso, auth: 'public', summary: 'OIDC callback', description: 'Exchanges the authorization `code`, auto-provisions the user/tenant on first login, issues a fabric JWT and redirects to the UI as `/login?token=...`.', params: [q('code', 'Authorization code from the identity provider.', undefined, 'abc123', true), q('state', 'Opaque state echoed by the provider.')], responses: { '302': { description: 'Redirect to the UI with the JWT.' } }, errors: { '400': { description: 'Authorization code is missing.', code: 'VALIDATION_ERROR', message: 'Authorization code is missing' } } },
  { method: 'get', path: '/api/auth/sso/logout', tag: T.sso, auth: 'public', summary: 'SSO logout', description: 'Redirects to the identity provider\'s end-session endpoint, then back to `redirect_uri`.', params: [q('redirect_uri', 'Where to return after logout.')], responses: { '302': { description: 'Redirect to the identity provider.' } } },
  { method: 'get', path: '/api/auth/logout', tag: T.sso, auth: 'public', summary: 'Logout (alias)', description: 'Alias of `/api/auth/sso/logout`.', params: [q('redirect_uri', 'Where to return after logout.')], responses: { '302': { description: 'Redirect to the identity provider.' } } },
];

const docOps: OpDef[] = [
  { method: 'get', path: '/api/developer-docs', tag: T.docs, auth: 'public', summary: 'List developer guides', description: 'Grouped index of the Markdown developer guides.', responses: { '200': { description: 'Doc groups.', schema: ref('DeveloperDocsList') } } },
  { method: 'get', path: '/api/developer-docs/{id}', tag: T.docs, auth: 'public', summary: 'Get a developer guide', description: 'Rendered guide by file id (e.g. `README.md`).', params: [pp('id', 'Guide file id.', 'README.md')], responses: { '200': { description: 'Guide.', schema: ref('DeveloperDoc') } } },
];

const replicationWriteOps: OpDef[] = ([
  { method: 'post', path: '/api/replication', summary: 'Create a replication job', description: 'Defines a source-to-source replication (ONE_WAY / TWO_WAY; FULL / INCREMENTAL / CDC). Plan `max_replications` applies (403).', body: jsonBody(ref('CreateReplicationJobRequest'), { cdc: ex('CDC to DR', { name: 'retail-to-dr', sourceName: 'Retail_Core', destName: 'DR_Postgres', strategy: 'CDC', mode: 'ONE_WAY' }), incr: ex('Hourly incremental', { name: 'orders-incr', sourceName: 'Retail_Core', destName: 'DR_Postgres', strategy: 'INCREMENTAL', cdcColumn: 'updated_at', scheduleMs: 3600000 }) }), responses: { '201': { description: 'Created.', schema: ref('ReplicationJob'), example: { id: 'rep_01', name: 'retail-to-dr', sourceName: 'Retail_Core', destName: 'DR_Postgres', strategy: 'CDC' } } } },
  { method: 'post', path: '/api/replication/{id}/run', summary: 'Run a replication job now', description: 'Enqueues a REPLICATE copy job and returns immediately.', params: [pp('id', 'Job id.', 'rep_01')], body: jsonBody(ref('ReplicationRunRequest'), { full: ex('Force full snapshot', { full: true }) }, undefined, false), responses: { '202': { description: 'Run queued.', schema: ref('QueuedRun'), example: { status: 'QUEUED', runId: 'run_8f2a', run: { id: 'run_8f2a' } } } } },
  { method: 'post', path: '/api/replication/{id}/restore', summary: 'Disaster-recovery restore', description: 'Enqueues a RESTORE job copying the replica back into `targetSource`.', params: [pp('id', 'Job id.', 'rep_01')], body: jsonBody(ref('ReplicationRestoreRequest'), { dr: ex('Restore to primary', { targetSource: 'Retail_Core' }) }), responses: { '202': { description: 'Restore queued.', schema: ref('QueuedRun'), example: { status: 'QUEUED', runId: 'run_9b3c', run: { id: 'run_9b3c' } } } } },
  { method: 'delete', path: '/api/replication/{id}', summary: 'Delete a replication job', description: 'Removes the job definition (data already replicated is kept).', params: [pp('id', 'Job id.', 'rep_01')], responses: { '200': { description: 'Deleted.', schema: ref('Deleted'), example: { status: 'DELETED' } } } },
  { method: 'post', path: '/api/replication/runs/{runId}/pause', summary: 'Pause a run', description: 'Pauses a RUNNING / QUEUED run.', params: [pp('runId', 'Run id.', 'run_8f2a')], responses: { '200': { description: 'Pausing.', schema: ref('RunControlResponse'), example: { status: 'PAUSING', run: { id: 'run_8f2a', status: 'RUNNING' } } } }, errors: { '409': { description: 'Run is not pausable.', code: 'CONFLICT', message: 'run not pausable (not RUNNING/QUEUED)' } } },
  { method: 'post', path: '/api/replication/runs/{runId}/resume', summary: 'Resume a run', description: 'Resumes a PAUSED or FAILED run from its checkpoint.', params: [pp('runId', 'Run id.', 'run_8f2a')], responses: { '200': { description: 'Re-queued.', schema: ref('RunControlResponse'), example: { status: 'QUEUED', run: { id: 'run_8f2a', status: 'QUEUED' } } } }, errors: { '409': { description: 'Run is not resumable.', code: 'CONFLICT', message: 'run not resumable (not PAUSED/FAILED)' } } },
] as Omit<OpDef, 'tag'>[]).map((o) => ({ ...o, tag: T.replication, ...own, licensed: true }) as OpDef);

const systemOnlyOps: OpDef[] = [...adminOps, ...workerOps, ...tenantOps, ...planOps, ...subOps, ...settingsOps, ...healthOps, ...ssoOps, ...docOps, ...replicationWriteOps, ...systemTenancyOps];

export const systemOps: OpDef[] = [...developerOps, ...systemOnlyOps];

export const systemTags: TagDef[] = [
  ...developerTags.filter((t) => t.name !== T.replication),
  { name: T.replication, description: 'Source-to-source replication: job lifecycle, runs, pause/resume and disaster-recovery restore. Reads are in the developer document; mutations are JWT-session only.' },
  { name: T.aTenants, description: 'Platform ADMIN: tenant lifecycle (provision, rename, suspend, de-provision).' },
  { name: T.aConn, description: 'Data-source connection management (tenant-scoped, available to trial users).' },
  { name: T.aUsers, description: 'Platform ADMIN: user identities and roles.' },
  { name: T.aInsights, description: 'Dashboard counters, forensic audit logs and catalog summary.' },
  { name: T.aNotify, description: 'Notification channels used by triggers and alerts.' },
  ...workerTags,
  { name: T.tenants, description: 'Self-service tenant listing and creation for the signed-in user.' },
  { name: T.plans, description: 'Plans (limits and feature flags): the legacy `/api/plans` catalogue plus the platform-admin plan catalogue under `/api/system/plans` (all statuses, custom plans) and plan requests (`/api/system/plan-requests`).' },
  { name: T.subs, description: 'The signed-in user\'s subscription and plan limits.' },
  { name: T.settings, description: 'Login-page branding and OIDC configuration.' },
  { name: T.health, description: 'Health and liveness probes (public).' },
  { name: T.sso, description: 'Browser SSO flow and session helpers.' },
  { name: T.docs, description: 'Markdown developer guides served to the portal (public).' },
  ...tenancyTags.filter((t) => t.name !== 'Workspace'),
];

export const systemTagGroups: TagGroup[] = [
  ...developerTagGroups,
  { name: 'Platform administration', tags: [T.aTenants, T.aConn, T.aUsers, T.aInsights, T.aNotify, 'Admin: Workers (Citus)'] },
  { name: 'Accounts & licensing', tags: [T.tenants, T.plans, T.subs, T.settings, T.sso] },
  { name: 'Platform settings & licensing', tags: ['System settings', 'Licence', 'Workspaces (system)'] },
  { name: 'Operations', tags: [T.health, T.docs] },
];

const ACCESS_MATRIX = `
## Access levels (tenancy access matrix)

Access derives from existing data (there is no membership table): a **platform admin** is a user with the ADMIN role, a **workspace owner** is the user referenced by the workspace (\`tenants.user_id\`), and a **member** is anyone else holding a token for the workspace. A **developer API token** is always a member and can never be an owner or admin.

| Area | Platform admin (JWT) | Workspace owner (JWT) | Member (JWT) | Developer API token |
|---|---|---|---|---|
| \`/api/system/*\` (settings, licence, plans, workspaces, requests, stats, events) | yes | 403 \`FORBIDDEN\` | 403 \`FORBIDDEN\` | 403 \`TOKEN_NOT_ALLOWED\` |
| \`GET /api/workspace\`, \`/settings\`, \`/limits\`, \`/plans\` | any workspace (\`x-tenant-id\`) | yes | yes | 403 \`TOKEN_NOT_ALLOWED\` |
| Change workspace name, settings, plan; send plan request | any workspace; may assign any plan | yes (own plan choice must fit usage) | 403 \`WORKSPACE_ADMIN_REQUIRED\` | 403 \`TOKEN_NOT_ALLOWED\` |
| Schema, connection, governance changes | yes | yes | 403 \`WORKSPACE_ADMIN_REQUIRED\` | 403 |
| Queries, CRUD, analytics, metadata reads, triggers | yes (never limited by plans) | yes | yes | yes, within token scopes |
| Plan limits, trial expiry, rate limits | bypassed | apply | apply | apply |

### Workspace guard (every authenticated \`/api\` call except auth, health and docs)
Platform admins bypass the guard; everyone else (sessions **and** API tokens) is checked in this order:
1. Maintenance mode on -> **503 \`MAINTENANCE\`** (message set by the operator).
2. Workspace suspended -> **403 \`TENANT_SUSPENDED\`**; workspace deleted/unknown -> **403 \`TENANT_NOT_AVAILABLE\`**.
3. Caller IP outside the workspace \`security.allowedIps\` -> **403 \`IP_NOT_ALLOWED\`**.
4. If these checks cannot run the guard fails closed -> **503 \`GUARD_UNAVAILABLE\`**.

Limit errors: **403 \`PLAN_LIMIT_REACHED\`** / **403 \`LICENSE_LIMIT_REACHED\`** (a plan or licence limit is hit), **403 \`FEATURE_DISABLED\`**, **402 \`TRIAL_EXPIRED\`**, **429** (rate limit), **503 \`LICENSE_CHECK_FAILED\`** (limits could not be evaluated). Effective limits = plan (or self-hosted licence) limits + per-workspace overrides, capped by the licence ceiling; \`-1\` is unlimited.
`;

export const systemSpec: Json = buildSpec({
  title: 'Zero Data Fabric - System API',
  version: '2.0.0',
  description:
    'Whole-platform operator reference for the Zero Data Fabric: **everything in the Developer API** plus administration (tenants, connections, users, audit, notification channels), Citus **worker node management**, plans and subscriptions, settings, replication control, SSO and health.\n\n' +
    'Operations tagged under *Platform administration* require a **platform ADMIN JWT session**; developer API tokens never reach them. Integrators who only need queries/CRUD should use the Developer API at `/api-docs/developer`.\n' +
    ACCESS_MATRIX +
    AUTH_GUIDE,
  ops: systemOps,
  tags: systemTags,
  tagGroups: systemTagGroups,
});
