# Licence key: the object the portal must issue (payload schema v2)

Zero Data Fabric accepts an **RS256-signed JWT** (the Zero Licensing Portal key pair; public key embedded in `backend/src/utils/licensing.ts`). The claims below are the JWT payload. v1 keys (no `schema_version`) keep working: every field added in v2 is optional.

## 1. Payload

```jsonc
{
  "schema_version": 2,                      // 1 or absent = original object
  "licensee": "Acme Corp",                  // required
  "product": "data-fabric",                 // other Zero products are accepted with a warning (shared key pair)
  "name": "Enterprise Self-Host",           // plan/tier label shown in the console
  "issuedAt": "2026-10-19T00:00:00Z",       // ISO-8601
  "expiresAt": "2027-10-19T00:00:00Z",      // ISO-8601, required; expired key = treated as no licence
  "selfHosted": true,                       // true: the licence limits REPLACE the plan limits; no trial; plan UI hidden
  "bound_instance_id": "<instance id>",     // v2, optional: key only activates on that installation (Settings > System > Licence shows the id)
  "max_installations": 1,                   // enforced by the portal when callback validation is on
  "validation_url": "https://licensing.example.com/api/licenses/validate",
  "limits": { /* section 2; -1 unlimited, 0 none, >0 hard cap; an absent key = no ceiling from the licence */ },
  "features": { /* section 3; absent = enabled (true) */ "callback_validation_enabled": false }
}
```

## 2. `limits` (all optional integers)

| Key | Meaning | Enforced at |
| --- | --- | --- |
| `max_connections` | data sources per workspace | create connection |
| `max_tables` | catalogued tables per workspace | manifest apply / migrate |
| `max_records_per_table` | rows per virtual table | query engine write path |
| `max_triggers` | triggers per workspace | create trigger |
| `max_replications`, `max_replication_tables`, `max_replication_rows`, `max_replication_rows_per_table` | replication jobs and volume | replication create/run |
| `max_tenants` | workspaces on the whole installation | workspace creation |
| `rate_limit_per_min/hour/day/month` | API requests per workspace | licensing middleware (429) |
| `max_workers` (v2) | registered Citus worker nodes | add worker |
| `max_api_tokens_per_user` (v2) | active developer tokens per user | mint token |
| `max_users_per_workspace` (v2) | users homed in one workspace | create user |
| `max_saved_analytics` (v2) | saved analytics per workspace | create saved analytic |
| `max_query_rows` (v2) | hard ceiling on rows of one AST query (applied as `limit`) | query engine |
| `max_manifest_size_mb` (v2) | uploaded manifest size | manifest upload (413) |

## 3. `features` (booleans; `false` disables, absent enables)

| Key | Effect when `false` |
| --- | --- |
| `trial_period_days` | number; trial length for non-self-hosted use (-1 = never expires) |
| `custom_branding` | login branding cannot be saved |
| `enterprise_sso_enabled` | OIDC settings cannot be saved |
| `remove_branding` | (true) public login config returns `removeBranding: true` |
| `elasticsearch_enabled`, `snowflake_enabled` | those connector types cannot be registered |
| `cdc_kafka_enabled` | replication strategy `CDC` refused |
| `federated_query_enabled` | cross-engine (multi-source) AST queries refused |
| `distributed_execution_enabled` (v2) | worker nodes / distributed tables / rebalance refused |
| `developer_tokens_enabled` (v2) | developer tokens cannot be minted; existing ones stop working |
| `manifest_import_export_enabled` (v2) | manifest export and file import/diff/apply refused |
| `workspace_settings_enabled` (v2) | workspace owners cannot edit workspace settings |
| `callback_validation_enabled` | `false` = purely offline verification (air-gapped); otherwise the daily encrypted callback to `validation_url` runs (60-day grace on network failure; a portal "invalid" answer makes the key `revoked`) |

Platform admins are never limited by plans, but the licence ceiling and feature switches that are platform-level (workers, branding, SSO) apply to them too.

## 4. How the limits combine

`effective = min( plan limits + per-workspace overrides , licence limit )`, with `-1` = infinity. With a usable `selfHosted` licence the base is the licence limits instead of the plan. System setting `planLimitsEnabled=false` lifts plan limits and overrides but never the licence ceiling. Features: a licence `false` always wins; a plan may also switch a feature off.

## 5. Activation and states

- Install: Console > System > Licence, or `POST /api/system/license {"licenseKey": "..."}`, or env `LICENSE_KEY` (env wins and cannot be changed from the UI).
- States: `none`, `valid`, `invalid` (bad signature/malformed), `expired`, `wrong_instance` (bound to another install or instance id unknown), `revoked` (portal rejected it). Anything but `valid` behaves as **no licence**: plan limits apply, never unlimited.
- The raw key is never returned by the API.

## 6. Portal checklist

1. Sign with the portal RS256 private key; never put secrets in the payload.
2. Always set `expiresAt`; set `selfHosted:true` only for installs that should ignore plans.
3. Prefer explicit numbers for every limit you sell; omit a limit only if it should not be capped.
4. For per-install keys, issue after the customer reads the instance id from the Licence screen and set `bound_instance_id`.
5. Test keys: tests sign with their own key pair via `LICENSE_PUBLIC_KEY_PEM` (honoured only when `NODE_ENV=test`).

## 7. Known gaps
`max_records_per_table` is fail-open and exempts the default tenant; `max_installations` is only meaningful with portal callbacks. The key seeded by `index.ts` at startup does not verify against the embedded public key (see the console's licence banner).
