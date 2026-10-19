# Tenancy access matrix

Actors (see `MULTITENANCY_PLAN.md` section 0): **Admin** = platform admin (JWT `internal_role=ADMIN`, never an API token);
**Owner** = `tenants.user_id` of the active workspace; **Member** = any other token for the workspace (API tokens are always members).
Gate = `requireWorkspaceAdmin` (`backend/src/middleware/tenantAccess.middleware.ts`): Admin or Owner. Every row below is always
scoped to the caller's own workspace; foreign ids answer **404** (never 403), `x-tenant-id` / body `tenantId` are honoured for Admins only.

| Area | Endpoint(s) | Member | Owner | Admin |
| --- | --- | --- | --- | --- |
| Connections | `GET /api/admin/connections` | read (secrets redacted, `hasPassword`) | read (redacted) | read (redacted) |
| Connections | `POST /api/admin/connections`, `PATCH /api/admin/connections`, `DELETE /api/admin/connections/:id` | 403 | yes | yes |
| Notification channels | `GET /api/admin/notification-channels` | read (config redacted) | read (full config) | read (full) |
| Notification channels | `POST /api/admin/notification-channels`, `DELETE .../:id`, `POST .../test` | 403 | yes | yes |
| Catalog / metadata reads | `GET /api/metadata/{sources,schemas,tables,columns,resource/:id,preview,relationships,history,downstream,export,template,tables/:name}`, `GET /api/admin/{catalog,stats}`, `GET /api/events` | yes | yes | yes |
| Manifest / schema | `POST /api/metadata/diff` (plan only) | yes | yes | yes |
| Manifest / schema | `POST /api/metadata/{apply,rollback/:id,migrate,crawl,sync,downstream/toggle}` | 403 | yes | yes |
| Governance | `GET /api/{policies,grants,constraints}` | yes | yes | yes |
| Governance | `POST /api/{policies,grants,constraints}`, `DELETE /api/policies/:id` | 403 | yes | yes |
| Replication | `GET /api/replication[/analytics,/tracking,/runs,/runs/:id]` | yes | yes | yes |
| Replication | `POST /api/replication`, `/:id/run`, `/:id/restore`, `/runs/:id/{pause,resume}`, `DELETE /:id` | 403 | yes | yes |
| Triggers | `GET /api/triggers[/logs/list,/jobs/list]` | yes | yes | yes |
| Triggers | `POST /api/triggers`, `PUT/DELETE /:id`, `POST /:id/deploy`, `POST /jobs/:id/retry` | 403 | yes | yes |
| Data (CRUD) | `/api/data/{fetch,create,update,delete,call,sequence}` | yes (own tenant schemas only) | yes | yes |
| AST query | `/api/queries/*`, `/api/analytics/*` (incl. DDL config types) | yes (own tenant schemas only; async jobs visible to the starting user only) | yes | yes |
| Saved analytics / query logs | `/api/saved-analytics`, `/api/query-logs` | own tenant | own tenant | active tenant |
| Tenants / users / audit logs | `/api/admin/{tenants,users,audit-logs}` | 403 | 403 | yes |
| Token exchange | `POST /api/auth/token` | 403 unless owner of target tenant | own tenants | any |

Notes
- API tokens (`dft_...`) are members: they can no longer apply manifests or write triggers even with the `metadata:write` / `triggers:write` scopes (the gate rejects them).
- DDL config types (`CREATE_TABLE`, `ALTER_TABLE`, `DROP_TABLE`, `CREATE_VIEW`, ...) sent to `/api/analytics/query` are still member-accessible (existing behaviour, relied on by `query-engine.test.ts`); they only reach the caller's own `tenant_<id>[_x]` schemas and every identifier / fragment is validated.
- Database layer (`db/init/19-security-hardening.sql`): `fabric_user` has no EXECUTE on `fabric_admin.*` SECURITY DEFINER functions, no access to `public.users`, read-only access to the catalog tables, none to `fabric_system`; `public.audit_logs` is `security_invoker`.
- Tenant ids: `^[A-Za-z][A-Za-z0-9_]{1,40}$` and no overlap (`X` may not start with `E_` for an existing `E`, nor vice versa; case-insensitive) -> 400 `INVALID_IDENTIFIER` / 409 `TENANT_ID_OVERLAP`.
