/**
 * Component schemas for the tenancy / licensing surface: system settings, licence, plan catalogue,
 * workspaces, plan requests, system events and workspace settings (`/api/system/*`, `/api/workspace/*`).
 * Spread into the shared schema registry by schemas.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = (example?: any, description?: string, extra: any = {}) => ({ type: 'string', ...(example !== undefined ? { example } : {}), ...(description ? { description } : {}), ...extra });
const int = (example?: any, description?: string, extra: any = {}) => ({ type: 'integer', ...(example !== undefined ? { example } : {}), ...(description ? { description } : {}), ...extra });
const bool = (example?: any, description?: string) => ({ type: 'boolean', ...(example !== undefined ? { example } : {}), ...(description ? { description } : {}) });
const dt = (description?: string, extra: any = {}) => ({ type: 'string', format: 'date-time', ...(description ? { description } : {}), ...extra });

/** Numeric limit keys enforced per workspace (`-1` = unlimited, `0` = none allowed). Mirrors LIMIT_KEYS in limits.resolver.ts. */
export const LIMIT_KEY_NAMES = [
  'max_connections', 'max_records_per_table', 'max_tables', 'max_triggers', 'max_replication_tables', 'max_replication_rows',
  'max_replication_rows_per_table', 'max_replications', 'max_tenants', 'rate_limit_per_min', 'rate_limit_per_hour', 'rate_limit_per_day',
  'rate_limit_per_month', 'max_workers', 'max_api_tokens_per_user', 'max_users_per_workspace', 'max_saved_analytics', 'max_query_rows', 'max_manifest_size_mb',
] as const;

/** Boolean feature flags. Mirrors FEATURE_KEYS in limits.resolver.ts (`trial_period_days` is a number). */
export const FEATURE_KEY_NAMES = [
  'custom_branding', 'enterprise_sso_enabled', 'elasticsearch_enabled', 'snowflake_enabled', 'cdc_kafka_enabled', 'federated_query_enabled',
  'remove_branding', 'distributed_execution_enabled', 'developer_tokens_enabled', 'manifest_import_export_enabled', 'workspace_settings_enabled',
] as const;

const limitProps = Object.fromEntries(LIMIT_KEY_NAMES.map((k) => [k, int(undefined, undefined, { minimum: -1 })]));
const featureProps = {
  ...Object.fromEntries(FEATURE_KEY_NAMES.map((k) => [k, bool()])),
  trial_period_days: int(7, 'Trial length in days (-1 = no expiry, max 3650). Starts when the plan is assigned.', { minimum: -1, maximum: 3650 }),
};

const limitsObject = (description: string, example?: any) => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties: limitProps,
  ...(example ? { example } : {}),
});
const featuresObject = (description: string, example?: any) => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties: featureProps,
  ...(example ? { example } : {}),
});

const usageObject = {
  type: 'object',
  description: 'Current usage counters keyed like the limits they are compared with. A counter that could not be read is `null`.',
  properties: {
    max_connections: int(3, undefined, { nullable: true }),
    max_tables: int(41, undefined, { nullable: true }),
    max_triggers: int(2, undefined, { nullable: true }),
    max_saved_analytics: int(7, undefined, { nullable: true }),
    max_users_per_workspace: int(4, undefined, { nullable: true }),
    active_api_tokens: int(1, undefined, { nullable: true }),
    max_replications: int(0, undefined, { nullable: true }),
  },
};

export const tenancySchemas: Record<string, any> = {
  /* ---------------- system settings ---------------- */
  SystemSettings: {
    type: 'object',
    description: 'Platform-wide settings (stored under `settings.system`). Unset values fall back to the defaults shown.',
    properties: {
      defaultPlan: str('trial', 'Plan given to workspaces that have none. `null` = the plan flagged `is_default`, then the built-in trial.', { nullable: true }),
      planLimitsEnabled: bool(true, 'Master switch for plan limits. When false every plan limit is unlimited (a licence ceiling still applies). Default follows `PLAN_LIMITS_ENABLED`.'),
      allowSelfSignup: bool(true, 'Allow new users to register themselves.'),
      allowWorkspaceCreation: bool(true, 'Allow users to create additional workspaces.'),
      maxWorkspacesPerUser: int(-1, 'Workspaces one user may own (-1 = unlimited).', { minimum: -1, maximum: 10000 }),
      defaultRegion: str('AP', 'Default execution region (2-8 letters).', { pattern: '^[A-Za-z]{2,8}$' }),
      maintenanceMode: bool(false, 'When true every non-admin request is refused with 503 `MAINTENANCE`.'),
      maintenanceMessage: str('', 'Message returned while in maintenance mode (max 300 chars).', { maxLength: 300 }),
      maxTokenDays: int(365, 'Ceiling for developer-token lifetime and `api.maxTokenDays` of every workspace.', { minimum: 1, maximum: 365 }),
    },
  },
  SystemSettingsPatch: {
    type: 'object',
    description: 'Partial update: send only the settings to change. Unknown keys are rejected (`UNKNOWN_SETTINGS`); invalid values return `INVALID_SETTINGS`.',
    additionalProperties: false,
    properties: {
      defaultPlan: str('trial', 'Must name an active, non-custom plan, or `null`.', { nullable: true, pattern: '^[A-Za-z0-9_-]{1,100}$' }),
      planLimitsEnabled: bool(true),
      allowSelfSignup: bool(true),
      allowWorkspaceCreation: bool(true),
      maxWorkspacesPerUser: int(5, undefined, { minimum: -1, maximum: 10000 }),
      defaultRegion: str('EU', undefined, { pattern: '^[A-Za-z]{2,8}$' }),
      maintenanceMode: bool(false),
      maintenanceMessage: str('Back at 10:00 UTC', undefined, { maxLength: 300 }),
      maxTokenDays: int(90, undefined, { minimum: 1, maximum: 365 }),
    },
  },

  /* ---------------- workspace settings ---------------- */
  WorkspaceGeneralSettings: {
    type: 'object',
    description: 'Section `general`.',
    additionalProperties: false,
    properties: {
      displayName: str('Acme Analytics', 'Friendly name (max 100).', { maxLength: 100 }),
      timezone: str('UTC', 'IANA timezone, e.g. `Asia/Kolkata`, or `UTC`.'),
      defaultRegion: str('EU', 'Execution region (2-8 letters).', { pattern: '^[A-Za-z]{2,8}$' }),
      contactEmail: str('ops@acme.example', 'Contact address for notices.', { maxLength: 200 }),
    },
  },
  WorkspaceQuerySettings: {
    type: 'object',
    description: 'Section `query`. `maxRows` can never exceed the plan/licence `max_query_rows` (`EXCEEDS_LICENCE_LIMIT`).',
    additionalProperties: false,
    properties: {
      maxRows: int(10000, 'Row cap per query.', { minimum: 1, maximum: 1000000 }),
      timeoutMs: int(30000, 'Query timeout in ms.', { minimum: 100, maximum: 300000 }),
      allowStreaming: bool(true, 'Allow NDJSON streaming responses.'),
    },
  },
  WorkspaceSecuritySettings: {
    type: 'object',
    description: 'Section `security`.',
    additionalProperties: false,
    properties: {
      allowedIps: { type: 'array', maxItems: 50, items: str('203.0.113.0/24', 'IPv4/IPv6 address or CIDR (IPv4 CIDR matching; IPv6 exact match).'), description: 'IP allow-list for every request into the workspace (sessions and API tokens). Empty = any IP. Platform admins bypass it. Blocked callers get 403 `IP_NOT_ALLOWED`.', example: ['203.0.113.0/24'] },
    },
  },
  WorkspaceApiSettings: {
    type: 'object',
    description: 'Section `api`. `maxTokenDays` can never exceed the system maximum (`EXCEEDS_SYSTEM_LIMIT`).',
    additionalProperties: false,
    properties: {
      allowDeveloperTokens: bool(true, 'Whether developer API tokens may be created and used.'),
      maxTokenDays: int(90, 'Max lifetime of a developer token in this workspace.', { minimum: 1, maximum: 365 }),
      allowedScopes: { type: 'array', items: { type: 'string', enum: ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] }, description: 'Scopes a token in this workspace may carry.', example: ['query:read', 'data:read'] },
    },
  },
  WorkspaceNotificationSettings: {
    type: 'object',
    description: 'Section `notifications`.',
    additionalProperties: false,
    properties: {
      emailOnLimit: bool(true, 'E-mail the owner when a limit warning threshold is crossed.'),
      limitWarningPercent: int(80, 'Usage percentage that triggers the warning.', { minimum: 50, maximum: 100 }),
    },
  },
  WorkspaceSettings: {
    type: 'object',
    description: 'All five workspace settings sections with defaults filled in. Stored sparsely in `tenants.settings`.',
    properties: {
      general: ref('WorkspaceGeneralSettings'),
      query: ref('WorkspaceQuerySettings'),
      security: ref('WorkspaceSecuritySettings'),
      api: ref('WorkspaceApiSettings'),
      notifications: ref('WorkspaceNotificationSettings'),
    },
    example: {
      general: { timezone: 'UTC' },
      query: { allowStreaming: true },
      security: { allowedIps: [] },
      api: { allowDeveloperTokens: true, allowedScopes: ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] },
      notifications: { emailOnLimit: true, limitWarningPercent: 80 },
    },
  },
  WorkspaceSettingsSection: {
    description: 'One settings section, as returned by `PUT /api/workspace/settings/{section}` (shape depends on the section).',
    oneOf: [ref('WorkspaceGeneralSettings'), ref('WorkspaceQuerySettings'), ref('WorkspaceSecuritySettings'), ref('WorkspaceApiSettings'), ref('WorkspaceNotificationSettings')],
  },

  /* ---------------- effective limits ---------------- */
  EffectiveLimits: {
    type: 'object',
    description:
      'What a workspace may actually do right now: plan (or licence) limits + per-workspace overrides, capped by the licence ceiling. `-1` always means unlimited.',
    properties: {
      tenantId: str('t_acme'),
      plan: {
        type: 'object',
        properties: {
          name: str('trial'),
          source: { type: 'string', enum: ['workspace', 'subscription', 'default', 'licence', 'builtin'], example: 'default', description: 'Where the plan came from.' },
        },
      },
      limits: limitsObject('Effective numeric limits (-1 = unlimited).', { max_connections: 2, max_tables: 5, max_triggers: 3, max_query_rows: 10000, rate_limit_per_min: 10 }),
      features: featuresObject('Feature flags; a feature that is absent is enabled, `false` disables it.', { developer_tokens_enabled: true, trial_period_days: 7 }),
      trial: {
        type: 'object',
        properties: {
          startedAt: dt('When the plan/trial started.'),
          endsAt: dt('When it ends; `null` = never.', { nullable: true }),
          expired: bool(false, 'True after `endsAt`: licensed endpoints answer 402 `TRIAL_EXPIRED`.'),
          days: int(7, 'Configured trial length (-1 = unlimited).'),
        },
      },
      licence: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['none', 'valid', 'invalid', 'expired', 'wrong_instance', 'revoked'], example: 'none' },
          licensee: str('Acme Corp', undefined, { nullable: true }),
          selfHosted: bool(false, 'A usable self-hosted licence replaces plan limits with the licence limits.'),
          expiresAt: dt(undefined, { nullable: true }),
        },
      },
      planLimitsEnabled: bool(true, 'False when the system switched plan limits off.'),
      usage: usageObject,
    },
  },

  /* ---------------- licence ---------------- */
  LicenseView: {
    type: 'object',
    description: 'Non-secret view of the installed licence key (the key itself is never returned).',
    properties: {
      status: { type: 'string', enum: ['none', 'valid', 'invalid', 'expired', 'wrong_instance', 'revoked'], example: 'valid', description: 'Anything other than `valid` behaves as "no licence": plan limits apply, never unlimited.' },
      source: { type: 'string', enum: ['env', 'settings'], nullable: true, example: 'settings', description: '`env` = `LICENSE_KEY` environment variable (cannot be changed through the API).' },
      error: str(null, 'Why the key is not usable.', { nullable: true }),
      licensee: str('Acme Corp', undefined, { nullable: true }),
      product: str('zero-datafabric', undefined, { nullable: true }),
      name: str('enterprise', 'Licence/plan name.', { nullable: true }),
      schemaVersion: int(1, undefined, { nullable: true }),
      issuedAt: dt(undefined, { nullable: true }),
      expiresAt: dt(undefined, { nullable: true }),
      selfHosted: bool(false),
      limits: { type: 'object', nullable: true, additionalProperties: true, description: 'Licence ceilings per limit key (-1 = no cap).', example: { max_connections: 50, max_users_per_workspace: -1 } },
      features: { type: 'object', nullable: true, additionalProperties: true, description: 'Features the licence enables/disables.', example: { enterprise_sso_enabled: true } },
      maxInstallations: int(1, undefined, { nullable: true }),
      boundInstanceId: str(undefined, 'Installation the key is bound to.', { nullable: true }),
      validation: {
        type: 'object',
        nullable: true,
        description: 'Last result of the licensing-portal callback validation.',
        properties: { status: str('valid'), lastSuccessAt: dt(undefined, { nullable: true }), errorMessage: str(null, undefined, { nullable: true }) },
      },
      instanceId: str('0d6c9f7e-1c3a-4e6c-9a53-2f1b7f0e9a11', 'This installation\'s id (only on `GET /api/system/license`); quote it when requesting a bound key.', { nullable: true }),
    },
  },
  LicenseInstallRequest: { type: 'object', required: ['licenseKey'], properties: { licenseKey: str('eyJhbGciOiJSUzI1NiIs...', 'Signed licence key (JWT, up to 16000 chars).') } },

  /* ---------------- plans ---------------- */
  PlanDefinition: {
    type: 'object',
    description: 'Create (`POST`) or partially update (`PUT`) a plan. Unknown fields are rejected. `name` and `limits` + `features` are required on create only.',
    additionalProperties: false,
    properties: {
      name: str('pro', '2-50 chars: letters, digits, `_`, `-`. Unique.', { pattern: '^[A-Za-z0-9_-]{2,50}$' }),
      description: str('For growing teams', 'Up to 500 chars.', { maxLength: 500 }),
      price_monthly: { type: 'number', minimum: 0, maximum: 1000000, example: 49 },
      limits: limitsObject('Numeric limits; every value an integer >= -1 (-1 = unlimited). Unknown keys are rejected.', { max_connections: 20, max_users_per_workspace: 25, max_query_rows: 100000 }),
      features: featuresObject('Feature flags; boolean values (and `trial_period_days` -1..3650). Unknown keys are rejected.', { developer_tokens_enabled: true, workspace_settings_enabled: true, trial_period_days: -1 }),
      is_default: bool(false, 'Make this the default plan (must be active and not custom; unsets the previous default).'),
      is_custom: bool(false, '"By arrangement" plan: workspaces cannot select it, they send a plan request instead.'),
      status: { type: 'string', enum: ['active', 'disabled', 'hidden', 'upcoming'], example: 'active', description: '`active` selectable; `upcoming` listed but not selectable; `hidden`/`disabled` not offered to workspaces.' },
      contact_config: { type: 'object', nullable: true, additionalProperties: true, description: 'Contact-us details shown for custom plans (max 2 KB).', example: { email: 'sales@example.com' } },
      max_tenants: int(-1, 'Workspaces one owner may hold on this plan (-1 = unlimited).', { minimum: -1 }),
    },
  },

  /* ---------------- workspaces ---------------- */
  WorkspaceSummary: {
    type: 'object',
    properties: {
      id: str('t_acme'),
      name: str('Acme Corp'),
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'DELETED'], example: 'ACTIVE' },
      plan: str('trial', undefined, { nullable: true }),
      planExpiresAt: dt('End of the assigned plan / trial.', { nullable: true }),
      ownerUserId: str('b1c2d3e4-0000-4000-8000-000000000001', undefined, { nullable: true }),
      ownerUsername: str('alice', undefined, { nullable: true }),
      createdAt: dt(),
    },
  },
  WorkspaceList: {
    type: 'object',
    properties: { total: int(42, 'Rows matching the filters.'), limit: int(50), offset: int(0), workspaces: { type: 'array', items: ref('WorkspaceSummary') } },
  },
  WorkspaceDetail: {
    type: 'object',
    properties: {
      workspace: {
        type: 'object',
        additionalProperties: true,
        description: 'Raw workspace row.',
        properties: {
          id: str('t_acme'), name: str('Acme Corp'), status: str('ACTIVE'), plan_name: str('pro', undefined, { nullable: true }), plan_started_at: dt(undefined, { nullable: true }), plan_expires_at: dt(undefined, { nullable: true }),
          plan_overrides: { type: 'object', additionalProperties: { type: 'integer' }, example: { max_connections: 100 } }, user_id: str(undefined, 'Owner user id.', { nullable: true }), created_at: dt(), settings: ref('WorkspaceSettings'),
        },
      },
      effective: ref('EffectiveLimits'),
      usage: usageObject,
    },
  },
  WorkspaceUpdate: {
    type: 'object',
    additionalProperties: false,
    description: 'Send at least one of `name` / `status`.',
    properties: { name: str('Acme Corp (EU)', '1-100 characters.', { maxLength: 100 }), status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'], example: 'SUSPENDED', description: 'Case-insensitive. A suspended workspace answers 403 `TENANT_SUSPENDED` to all its sessions and tokens.' } },
  },
  WorkspaceRename: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: str('Acme Analytics', '1-100 characters.', { maxLength: 100 }) } },
  WorkspaceIdentity: { type: 'object', properties: { id: str('t_acme'), name: str('Acme Corp'), status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'], example: 'ACTIVE' } } },
  WorkspaceInfo: {
    type: 'object',
    properties: {
      workspace: { type: 'object', properties: { id: str('t_acme'), name: str('Acme Corp'), status: str('ACTIVE'), ownerUserId: str(undefined, undefined, { nullable: true }), createdAt: dt() } },
      role: { type: 'string', enum: ['platform_admin', 'owner', 'member'], example: 'owner', description: 'The caller\'s access level in this workspace.' },
      settings: ref('WorkspaceSettings'),
      plan: { $ref: '#/components/schemas/EffectiveLimits/properties/plan' },
      trial: { $ref: '#/components/schemas/EffectiveLimits/properties/trial' },
      licence: { $ref: '#/components/schemas/EffectiveLimits/properties/licence' },
      features: featuresObject('Effective feature flags.'),
    },
  },
  PlanAssignment: {
    type: 'object',
    required: ['plan'],
    additionalProperties: false,
    description: 'Assigning a plan restarts the plan clock and **replaces** any previous per-workspace overrides with the ones sent (none = cleared).',
    properties: {
      plan: str('pro', 'Plan name; any plan may be assigned by a platform admin, including custom/hidden ones.'),
      expiresAt: dt('Optional end date (not more than a day in the past). `null`/omitted = no fixed end (the plan trial length applies).', { nullable: true }),
      overrides: { ...limitsObject('Per-workspace limit overrides (integer >= -1), ignored while plan limits are switched off.'), example: { max_connections: 100 } },
    },
  },
  PlanExtension: {
    type: 'object',
    additionalProperties: true,
    description: 'Send either `days` (added to the later of now and the current end) or `until` (absolute date).',
    properties: { days: int(14, '1-3650.', { minimum: 1, maximum: 3650 }), until: dt('New end date; must be in the future.') },
  },
  OwnerChange: {
    type: 'object',
    description: 'Identify the new owner by `userId` (UUID) or `username`.',
    properties: { userId: str('b1c2d3e4-0000-4000-8000-000000000001', undefined, { format: 'uuid' }), username: str('alice') },
  },
  OwnerChanged: { type: 'object', properties: { id: str('t_acme'), ownerUserId: str('b1c2d3e4-0000-4000-8000-000000000001'), ownerUsername: str('alice') } },

  /* ---------------- plan requests ---------------- */
  PlanRequest: {
    type: 'object',
    description: '"Contact us" request for a custom plan raised by a workspace.',
    properties: {
      id: str('7a1f6c3e-4d2b-4c8e-9b1a-0e5d6f7a8b9c', undefined, { format: 'uuid' }),
      tenant_id: str('t_acme'),
      tenant_name: str('Acme Corp', 'Only in the system listing.'),
      requested_by: str('alice'),
      plan_name: str('enterprise'),
      message: str('We need 50 users', undefined, { nullable: true }),
      status: { type: 'string', enum: ['open', 'approved', 'rejected', 'closed'], example: 'open' },
      created_at: dt(),
      resolved_by: str(undefined, undefined, { nullable: true }),
      resolved_at: dt(undefined, { nullable: true }),
    },
  },
  PlanRequestInput: {
    type: 'object',
    required: ['plan'],
    additionalProperties: true,
    properties: { plan: str('enterprise', 'Requested plan name (2-50 chars).', { pattern: '^[A-Za-z0-9_-]{2,50}$' }), message: str('We need 50 users and SSO.', 'Up to 1000 chars.', { maxLength: 1000 }) },
  },
  PlanRequestResolution: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['approved', 'rejected', 'closed'], example: 'approved' } } },
  PlanSelection: { type: 'object', required: ['plan'], properties: { plan: str('pro', 'Name of an `active`, non-custom plan from `GET /api/workspace/plans`.') } },
  PlanDoesNotFitError: {
    type: 'object',
    required: ['error', 'code', 'problems'],
    properties: {
      error: str('The workspace uses more than this plan allows'),
      code: str('PLAN_DOES_NOT_FIT'),
      problems: { type: 'array', items: str('max_connections: using 5, plan allows 2'), description: 'One entry per limit the current usage exceeds.' },
    },
  },

  /* ---------------- stats / events ---------------- */
  SystemStats: {
    type: 'object',
    properties: {
      workspacesByStatus: { type: 'array', items: { type: 'object', properties: { status: str('ACTIVE'), n: int(12) } } },
      workspacesByPlan: { type: 'array', items: { type: 'object', properties: { plan: str('trial', '`(default)` for workspaces without an explicit plan.'), n: int(9) } } },
      users: int(31, 'Total platform users.'),
      license: { type: 'string', enum: ['none', 'valid', 'invalid', 'expired', 'wrong_instance', 'revoked'], example: 'none', description: 'Licence status.' },
    },
  },
  SystemEvent: {
    type: 'object',
    description: 'Audit-trail entry for a system or workspace change (settings, licence, plans, workspace status/plan/owner, plan requests).',
    properties: {
      id: { type: 'integer', example: 1042 },
      actor: str('root'),
      action: str('WORKSPACE_PLAN_ASSIGNED', 'e.g. SYSTEM_SETTINGS_UPDATED, LICENSE_INSTALLED, LICENSE_REMOVED, PLAN_CREATED, PLAN_UPDATED, PLAN_DELETED, WORKSPACE_UPDATED, WORKSPACE_PLAN_ASSIGNED, WORKSPACE_PLAN_EXTENDED, WORKSPACE_OWNER_CHANGED, WORKSPACE_RENAMED, WORKSPACE_PLAN_SELECTED, WORKSPACE_SETTINGS_UPDATED, PLAN_REQUEST_RESOLVED.'),
      tenantId: str('t_acme', undefined, { nullable: true }),
      detail: { type: 'object', additionalProperties: true, example: { plan: 'pro' } },
      createdAt: dt(),
    },
  },
};
