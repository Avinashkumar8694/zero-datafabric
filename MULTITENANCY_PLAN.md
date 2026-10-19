# Multi-tenancy, system/workspace settings, licence key, isolation hardening

Model copied from zero-payment-ms (docs/plans.md): **system layer** (platform admin: deployment config, plans, workspaces, licence) and **workspace layer** (owner/members: workspace settings, limits, usage), with licence key as a hard ceiling. Status: [ ] todo, [x] done.

## 0. Actors (no membership table exists, so derived)
| Actor | How identified | Can |
| --- | --- | --- |
| Platform admin | JWT `internal_role=ADMIN` (never an API token) | everything; bypasses plan limits; every workspace via `x-tenant-id` (audited) |
| Workspace owner | `tenants.user_id = user.id` | schema/manifest apply, connections, governance, workspace settings, tokens |
| Member | any other token for the workspace | AST query, CRUD, saved analytics, own developer tokens |
| API token | `dft_` token | scoped query/data/metadata calls only, always member |

## 1. Defects found by the isolation audit (ranked) and owner of the fix
1. [ ] Cross-tenant destructive `CALL fabric_admin.*` (SECURITY DEFINER, no REVOKE) -> Agent A (+ `19-security-hardening.sql`)
2. [ ] Unauthenticated `/api/plans` CRUD; self-service `POST /api/subscriptions/me` plan/limit upgrade -> Me (system layer)
3. [ ] IDOR via foreign `tableId`/`schemaId`; `catalog_*` unscoped; async job status not tenant-checked -> Agent A
4. [ ] Trigger/manifest/DDL identifier injection executed as DB owner; triggers can target other tenants' schemas -> Agent B
5. [ ] Tenant id prefix + `LIKE` wildcard collisions (`t_ac` vs `t_ac_foo`, `_` wildcard) -> Agent A (+ tenant-id no-overlap rule at creation)
6. [ ] Hub self-registration as a source (auto-filled fabric_admin password); FDW server-name collision; blacklist IMPORT FOREIGN SCHEMA -> Agent B (+ `20-fdw-hardening.sql`)
7. [ ] `disconnectSource` unscoped; connection secrets returned to USER; connection mutation open to USER -> Agent A
8. [ ] SQL injection in `COUNT(*) FROM ${resource}` and legacy `generateSql` -> Agent A
9. [ ] `checkLimit(user.id)` mis-keyed (limits never applied per tenant); SSO tenants with NULL owner; licence payload mostly unenforced; seeded `identity-server` key makes every install self-host -> Me
10. [ ] Hard-coded defaults (JWT secret fallback, OIDC secrets, authenticator password, CORS `*`) -> flagged to user, only the JWT fallback is made fail-closed outside dev
Also: `cleanup.service.ts` deletes from non-existent tables and uses an unescaped `LIKE` schema drop (Agent A); `fabric_user` UPDATE on `public.users` (Agent A); `public.audit_logs` view not `security_invoker` (Agent A); USER-reachable apply/rollback/migrate/crawl/policies/grants/constraints/replication/triggers (Agent A, uses `requireWorkspaceAdmin`).

## 2. Feature tasks (mine)
### F6 System layer (`/api/system/*`, platform admin session only)
- [ ] `settings` table moved into `db/init/18` (key/value jsonb) with keys: `system`, `custom_login`, `license_key`, `license_validation`, `instance_id`
- [ ] System settings: default plan, `plan_limits_enabled`, `allow_self_signup`, `allow_workspace_creation`, `max_workspaces_per_user`, `default_region`, `maintenance_mode`, `max_token_days`
- [ ] Plans CRUD (admin only; public `GET /api/plans` lists active plans only; cannot delete default/in-use plan)
- [ ] Workspaces: list/filter, rename/suspend/activate, assign plan with per-workspace overrides + end date, extend trial, change owner, stats
- [ ] Licence: activate / replace / remove / validate / status (`/api/system/license`)
### F7 Workspace layer (`/api/workspace/*`)
- [ ] `tenants.settings` jsonb; sections `general`, `query`, `security`, `api`, `notifications`, strict validation, unknown keys rejected
- [ ] Effective limits = min(licence ceiling, plan merged with overrides); usage counters; `GET /api/workspace/limits`
- [ ] Plan select / "contact us" requests
- [ ] Enforce settings: `query.maxRows/timeoutMs`, `api.allowDeveloperTokens/maxTokenDays`, `security.allowedIps`
### F8 Licence key
- [ ] Payload v2 (see `LICENCE_KEY.md`), backwards compatible
- [ ] Licence ceiling enforced: max_connections/tables/triggers/replication/tenants (+ new `max_workers`, `max_api_tokens_per_user`, `max_users_per_workspace`, `max_saved_analytics`) and features (`distributed_execution_enabled`, `developer_tokens_enabled`, `elasticsearch_enabled`, `snowflake_enabled`, `cdc_kafka_enabled`, `manifest_import_export_enabled`)
- [ ] Invalid/expired licence status honoured; fail-closed to trial limits (not fail-open)
- [ ] `LICENCE_KEY.md`: exact object the portal must issue, field rules, enforcement map, activation, edge cases
### F9 UI
- [ ] System settings page (platform admin): General, Plans, Workspaces, Licence, Workers (existing)
- [ ] Workspace settings page: General, Query, Security, API, Plan & usage, Developer tokens
### F10 Consistent theme/layout on every console page (last)

## 3. Test matrix (throwaway DB on :55450; never the dev hub)
Isolation (USER tokens, not ADMIN): T1 tenant B cannot read/write/count A via CRUD, AST, saved analytics, query logs, triggers, replication, catalog/metadata GETs; T2 foreign `tableId`/`schemaId`/`sourceId`/job id -> 404; T3 `x-tenant-id` ignored for USER; T4 token exchange only for owned tenants; T5 tenant-id prefix collision rejected at creation; T6 `LIKE` wildcard ids; T7 `CALL fabric_admin.*` refused; T8 hub self-registration refused; T9 FDW name collision; T10 USER cannot mutate connections/manifests/governance; T11 connection secrets redacted for members; T12 USER cannot self-promote (`public.users`) or read `public.audit_logs` of others.
AST execution: every AST type (SELECT, joins, groupBy/aggregates, filters `$gt/$in/$like...`, orderBy, limit/offset, CTE/withRecursive, window, CALL, INSERT/UPDATE/DELETE via data API, MERGE/UPSERT if supported) x hub and remote source; limit clamping; identifier injection attempts in every AST field; type coercion; empty/huge payloads; unicode.
CRUD: create/read/update/delete single and bulk, filter-required update/delete, constraint violations, concurrent updates, pagination, masking/RLS per role.
Manifests: export -> diff (no change) -> apply (create/alter/drop/rename, soft-delete), rollback, history, import via upload (size limit, malformed JSON/YAML, wrong version, unknown keys, identifier injection, cross-tenant references), idempotent re-apply, partial failure atomicity, download format round-trip.
Connections: create/list/update/delete isolation, duplicate names across tenants, secret redaction, test-connection SSRF (metadata/link-local), hub self-registration, remove with dependent schemas, limits (`max_connections`).
Settings/licence: system vs workspace authz matrix, validation (unknown keys, ranges), plan assign/extend/override merge, licence ceiling min(), expired/invalid/forged/other-product licence, licence replace/remove at runtime, `PLAN_LIMITS_ENABLED=false`, trial expiry, suspended workspace blocks API tokens and sessions.

## 4. Verification log
(filled as work lands; failures are reported as failures)

## Verification log (final)
- Full `npx jest src` on a fresh Citus database (all db/init SQL): 1654 tests; after fixing the last items every suite passes except those that need external services (7 skipped: Mongo, Elasticsearch) and 8 `todo` for AST features the engine does not support (BETWEEN, nested $and/$or/$not, NOT_LIKE, MATCH/CONTAINS, MERGE/UPSERT).
- One flaky pattern: `tests/ast/injection-corpus` can report "socket hang up" when the whole repo runs in one process; it passes alone and in the directory run.
- NOT covered: manifest lifecycle suite (diff/apply/rollback/import matrix), connection isolation/SSRF suite with a remote Postgres, CRUD token scopes/RLS/masking. Existing coverage for those comes from tests/hardening, tests/isolation and the legacy src/tests/apis suites.
- Known gaps: policy masking / row filters are not enforced on hub tables (only on federated legs); `tryStream` on remote sources probably bypasses the row ceiling; `queryWithContext` uses SET LOCAL ROLE from a superuser session (needs a non-superuser app role); trigger-engine `/jobs/run-once` and `/transpile` are unauthenticated; `create_tenant_namespace` still drops schemas without validation.
