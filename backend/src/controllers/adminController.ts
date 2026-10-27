/**
 * @module controllers/adminController
 * @description Platform administration control plane, mounted under `requireAdmin`
 * (see `index.ts`) so every handler here assumes a platform-admin caller.
 * Covers tenant lifecycle, data-source connection management, platform user
 * management, and cross-tenant/global insights (dashboard stats, audit logs,
 * catalog summary, notification channels). Handlers that touch the catalog or
 * connection state invalidate the relevant tenant's Redis cache via `invalidateTenant`.
 */

import { Request, Response } from 'express';
import * as adminService from '../services/adminService';
import { IntegrationService } from '../modules/integration/integration.service';
import { TenantService } from '../modules/tenant/tenant.service';
import { AuthService } from '../modules/auth/auth.service';
import { pool, queryWithContext } from '../config/database';
import { invalidateTenant } from '../config/cache';
import { LimitsResolver, LimitError } from '../modules/tenancy/limits.resolver';
import { LicensingService } from '../services/licensing.service';
import { catalogSchemaScope, httpStatusOf, isUuid, NotFoundError } from '../utils/tenantScope';
import { redactConfig } from '../utils/redact';
import { isWorkspaceOwner, isPlatformAdmin } from '../middleware/tenantAccess.middleware';

/** Typed errors (TENANT_ID_OVERLAP 409, INVALID_IDENTIFIER 400, NOT_FOUND 404, ...) keep their status; the rest is a 500. */
const fail = (res: Response, err: any) => {
  const st = httpStatusOf(err) || 500;
  return res.status(st).json({ error: err.message, ...(err.code && httpStatusOf(err) ? { code: err.code } : {}) });
};

// --- Tenant Management ---

/**
 * List tenants. Admins see all tenants; non-admins see only their own tenant.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 with tenant rows.
 */
export const getTenants = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (user && user.internal_role !== 'ADMIN') {
      const { rows } = await pool.query('SELECT * FROM public.tenants WHERE id = $1', [user.tenant_id]);
      return res.json(rows);
    }
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    res.json(rows);
  } catch (err: any) {
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Provision a new tenant.
 *
 * @param req - Express request. Body: `(id: string (required), name: string (required))`.
 * @param res - Express response.
 * @returns 201 with the created tenant record from `TenantService.createTenant`.
 * @throws Responds 400 `(error: 'id and name are required')` when either field is
 *   missing; 500 `(error)` on failure (e.g. duplicate id).
 */
export const createTenant = async (req: Request, res: Response) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });
  try {
    const user = (req as any).user;
    
    // Check plan limits for non-admin users
    if (user && user.internal_role !== 'ADMIN') {
      const limitCheck = await LicensingService.canCreateTenant(user.id);
      if (!limitCheck.allowed) {
        return res.status(403).json({ error: limitCheck.reason });
      }
    }
    
    const result = await TenantService.createTenant(id, name, 'STANDARD', user?.id);
    res.status(201).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

/**
 * Update a tenant's name and/or lifecycle status (e.g. suspend/archive).
 *
 * @param req - Express request. `req.params.id` is the tenant id. Body:
 *   `(name?: string, status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED')`.
 * @param res - Express response.
 * @returns 200 with the updated tenant record from `TenantService.updateTenant`.
 * @throws Responds 500 `(error)` on failure (e.g. unknown tenant id).
 */
export const updateTenant = async (req: Request, res: Response) => {
  try {
    const { name, status } = req.body;
    if (status !== undefined && !['ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(status)) return res.status(400).json({ error: 'status must be ACTIVE, SUSPENDED or ARCHIVED' });
    const result = await TenantService.updateTenant(req.params.id as string, name, status);
    if (!result) return res.status(404).json({ error: 'Tenant not found' });
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

/**
 * Permanently remove a tenant and (per `TenantService.deleteTenant`) its
 * associated platform records.
 *
 * @param req - Express request. `req.params.id` is the tenant id to delete.
 * @param res - Express response.
 * @returns 200 with the result of `TenantService.deleteTenant`.
 * @throws Responds 500 `(error)` on failure (e.g. unknown tenant id).
 */
export const deleteTenant = async (req: Request, res: Response) => {
  try {
    const result = await TenantService.deleteTenant(req.params.id as string);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

// --- Connection Management ---

/**
 * List the caller's tenant's registered data-source connections, enriched
 * with a best-effort live status probe for each (bounded by a 1.5s timeout
 * per source so one unreachable source doesn't stall the whole list).
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 * @param res - Express response.
 * @returns 200 with each `data_sources` row plus a computed `live_status`:
 *   `'OFFLINE'` when the source is marked `DISCONNECTED`, `'LIVE'` when the
 *   connectivity probe (`IntegrationService.testConnection`) succeeds within
 *   1.5s, otherwise `'UNREACHABLE'`.
 * @throws Responds 500 `(error)` on failure to read `data_sources`.
 */
export const getConnections = async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    // Explicit tenant filter (not RLS alone: the ADMIN claim bypasses RLS) - a platform admin sees the active workspace
    // (x-tenant-id), never every workspace at once.
    const result = await queryWithContext('SELECT * FROM public.data_sources WHERE tenant_id = $1 ORDER BY created_at', [user.tenant_id], { tenantId: user.tenant_id, username: user.username });
    const probeWithTimeout = async (probe: Promise<any>, ms = 1500) => {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('probe-timeout')), ms));
      return Promise.race([probe, timeout]);
    };

    const enriched = await Promise.all(result.rows.map(async (row: any) => {
      let live_status = 'UNKNOWN';
      if (row.status === 'DISCONNECTED') {
        live_status = 'OFFLINE';
      } else {
        try {
          await probeWithTimeout(IntegrationService.testConnection({
            ...(row.config || {}),
            type: String(row.type || '').toLowerCase()
          } as any, { isPlatformAdmin: isPlatformAdmin(user) }));
          live_status = 'LIVE';
        } catch {
          live_status = 'UNREACHABLE';
        }
      }
      // Secrets never leave the server in a list response: passwords/keys/tokens are removed (hasPassword: true) and
      // credentials inside URIs / connection strings are masked, for owners and members alike.
      const { config, hasPassword } = redactConfig(row.config);
      return { ...row, config, hasPassword, live_status };
    }));
    res.json(enriched);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

/**
 * Register (or re-integrate a previously removed) remote data-source
 * connection for the caller's tenant, then bust that tenant's cache.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Body: `(name: string (required), config: object (required))` — `config`
 *   holds the engine type and connection details consumed by
 *   `IntegrationService.registerRemoteSource`.
 * @param res - Express response.
 * @returns 201 with the new source record, or 200 when the service reports
 *   `status: 'RE-INTEGRATED'` (an existing/soft-deleted source was revived).
 * @throws Responds 400 `(error: 'name and config are required')` when either
 *   field is missing; 500 `(error)` on connection/registration failure.
 */
export const createConnection = async (req: Request, res: Response) => {
  const { name, config } = req.body;
  const user = (req as any).user;
  if (!name || !config) return res.status(400).json({ error: 'name and config are required' });
  try {
    // Connector types that the licence/plan can switch off.
    {
      const t = String((config && (config.type || config.engine)) || req.body.type || '').toUpperCase();
      const gate = /ELASTIC|^ES$/.test(t) ? 'elasticsearch_enabled' : /SNOWFLAKE/.test(t) ? 'snowflake_enabled' : null;
      if (gate && user.internal_role !== 'ADMIN') {
        try { await LimitsResolver.assertFeature(user.tenant_id, gate as any); }
        catch (e: any) { if (e instanceof LimitError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
      }
    }
    // Enforce connections limit for non-admin users
    if (user.internal_role !== 'ADMIN') {
      const context = { tenantId: user.tenant_id, username: user.username };
      const existing = await queryWithContext('SELECT COUNT(*) FROM public.data_sources WHERE tenant_id = $1', [user.tenant_id], context);
      const currentCount = parseInt(existing.rows[0].count);
      
      const existsCheck = await queryWithContext('SELECT id FROM public.data_sources WHERE tenant_id = $1 AND name = $2', [user.tenant_id, name], context);
      const isNew = existsCheck.rows.length === 0;

      if (isNew) {
        // Limits are per workspace: keyed by the TENANT id (they used to be keyed by the user id and never applied).
        const allowed = await LicensingService.checkLimit(user.tenant_id, 'max_connections', currentCount);
        if (!allowed) {
          return res.status(400).json({ error: 'Connection limit exceeded. Your current plan restricts you to a maximum of 2 connections.' });
        }
      }
    }

    const result = await IntegrationService.registerRemoteSource(user.tenant_id, name, config, { username: user.username, isPlatformAdmin: isPlatformAdmin(user) });
    await invalidateTenant(user.tenant_id);
    const statusCode = result.status === 'RE-INTEGRATED' ? 200 : 201;
    res.status(statusCode).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

/**
 * Update a data source's connection status (e.g. disconnect/reconnect a source
 * without removing its catalog entries), then bust that tenant's cache.
 *
 * @param req - Express request. Requires `(req as any).user`. Body:
 *   `(sourceId: string (required), status: string (required))`.
 * @param res - Express response.
 * @returns 200 with the result of `adminService.disconnectSource`.
 * @throws Responds 400 `(error: 'sourceId and status are required')` when
 *   either field is missing; 500 `(error)` on failure.
 */
export const updateConnectionStatus = async (req: Request, res: Response) => {
  const { sourceId, status } = req.body;
  const user = (req as any).user;
  if (!sourceId || !status) return res.status(400).json({ error: 'sourceId and status are required' });
  if (!['CONNECTED', 'DISCONNECTED'].includes(String(status))) return res.status(400).json({ error: 'status must be CONNECTED or DISCONNECTED' });
  try {
    // Scoped to the caller's workspace: a foreign source id is a 404, never an update.
    const result = await adminService.disconnectSource(String(sourceId), String(status), user.tenant_id);
    if (user?.tenant_id) await invalidateTenant(user.tenant_id);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    fail(res, err);
  }
};

/**
 * Remove a data-source connection from the caller's tenant, then bust that
 * tenant's cache.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id).
 *   `req.params.id` is the source id to remove (required).
 * @param res - Express response.
 * @returns 200 with the result of `IntegrationService.removeSource`.
 * @throws Responds 400 `(error: 'sourceId is required')` when `req.params.id`
 *   is missing; 500 `(error)` on failure.
 */
export const removeConnection = async (req: Request, res: Response) => {
  const sourceId = req.params.id;
  const user = (req as any).user;
  if (!sourceId) return res.status(400).json({ error: 'sourceId is required' });
  try {
    if (!isUuid(sourceId)) return res.status(404).json({ error: 'Source not found', code: 'NOT_FOUND' });
    const result = await IntegrationService.removeSource(sourceId as string, user.tenant_id);
    await invalidateTenant(user.tenant_id);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    // removeSource reports a foreign/unknown id as "not found or unauthorized": always a 404, never a 500/403.
    if (/not found or unauthorized/i.test(err.message)) return res.status(404).json({ error: 'Source not found', code: 'NOT_FOUND' });
    fail(res, err);
  }
};

// --- User Management ---

/**
 * List every platform user across all tenants (id, username, tenant, role, status).
 *
 * @param req - Express request (admin-only; global list, not tenant-scoped).
 * @param res - Express response.
 * @returns 200 with the rows from `public.users`.
 * @throws Responds 500 `(error)` on a database failure.
 */
export const getUsers = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT id, username, tenant_id, role, status FROM public.users');
    res.json(rows);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

/**
 * Create a new platform user assigned to a tenant with a given role.
 *
 * @param req - Express request. Body: `(username: string, password: string,
 *   tenantId: string, role: string)`.
 * @param res - Express response.
 * @returns 201 with the created user record from `AuthService.createUser`.
 * @throws Responds 500 `(error)` on failure (e.g. duplicate username, unknown tenant).
 */
export const createUser = async (req: Request, res: Response) => {
  const { username, password, tenantId, role } = req.body;
  try {
    const result = await AuthService.createUser(username, password, tenantId, role);
    res.status(201).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    if (err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message }); 
  }
};

/**
 * Update a platform user's username, password, tenant assignment, and/or role.
 *
 * @param req - Express request. `req.params.id` is the user id. Body:
 *   `(username?: string, password?: string, tenantId?: string, role?: string)`.
 * @param res - Express response.
 * @returns 200 with the updated user record from `AuthService.updateUser`.
 * @throws Responds 500 `(error)` on failure (e.g. unknown user id).
 */
export const updateUser = async (req: Request, res: Response) => {
  const { username, password, tenantId, role } = req.body;
  try {
    const result = await AuthService.updateUser(req.params.id as string, username, password, tenantId, role);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

/**
 * Delete a platform user by id.
 *
 * @param req - Express request. `req.params.id` is the user id to delete.
 * @param res - Express response.
 * @returns 200 with the result of `AuthService.deleteUser`.
 * @throws Responds 500 `(error)` on failure (e.g. unknown user id).
 */
export const deleteUser = async (req: Request, res: Response) => {
  try {
    const result = await AuthService.deleteUser(req.params.id as string);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

// --- Insights ---

/**
 * Platform-wide dashboard headline counters: total tenants, total connections,
 * and audit-log activity in the last 24 hours.
 *
 * @param req - Express request (admin-only; global counts across all tenants).
 * @param res - Express response.
 * @returns 200 `(tenants: number, connections: number, audits: number)`.
 * @throws Responds 500 `(error)` on a database failure.
 */
export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const requestedTenant = (req.headers['x-tenant-id'] as string) || (req.query.tenantId as string);

    // If an admin or user has switched to a specific tenant, scope metrics to that workspace!
    if (requestedTenant && requestedTenant !== 'all') {
      const [tenants, connections, audits, users] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM public.tenants WHERE id = $1', [requestedTenant]),
        pool.query('SELECT COUNT(*) FROM public.data_sources WHERE tenant_id = $1', [requestedTenant]),
        pool.query("SELECT COUNT(*) FROM public.audit_logs WHERE (tenant_id = $1 OR tenant_id IS NULL) AND changed_at > NOW() - INTERVAL '24 hours'", [requestedTenant]),
        pool.query('SELECT COUNT(*) FROM public.users WHERE tenant_id = $1', [requestedTenant]),
      ]);

      const tenantInfo = (await pool.query('SELECT id, name, plan_name FROM public.tenants WHERE id = $1', [requestedTenant])).rows[0];

      return res.json({
        tenants: parseInt(tenants.rows[0]?.count || '1'),
        connections: parseInt(connections.rows[0]?.count || '0'),
        audits: parseInt(audits.rows[0]?.count || '0'),
        users: parseInt(users.rows[0]?.count || '0'),
        activeTenant: tenantInfo ? { id: tenantInfo.id, name: tenantInfo.name, plan: tenantInfo.plan_name } : null,
      });
    }

    if (user.internal_role === 'ADMIN') {
      const [tenants, connections, audits, users] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM public.tenants'),
        pool.query('SELECT COUNT(*) FROM public.data_sources'),
        pool.query("SELECT COUNT(*) FROM public.audit_logs WHERE changed_at > NOW() - INTERVAL '24 hours'"),
        pool.query('SELECT COUNT(*) FROM public.users'),
      ]);
      
      res.json({
        tenants: parseInt(tenants.rows[0].count),
        connections: parseInt(connections.rows[0].count),
        audits: parseInt(audits.rows[0].count),
        users: parseInt(users.rows[0]?.count || '0'),
      });
    } else {
      const context = { tenantId: user.tenant_id, username: user.username };
      const [tenants, connections, audits] = await Promise.all([
        queryWithContext('SELECT COUNT(*) FROM public.tenants', [], context),
        queryWithContext('SELECT COUNT(*) FROM public.data_sources', [], context),
        queryWithContext("SELECT COUNT(*) FROM public.audit_logs WHERE changed_at > NOW() - INTERVAL '24 hours'", [], context)
      ]);
      
      res.json({
        tenants: parseInt(tenants.rows[0].count),
        connections: parseInt(connections.rows[0].count),
        audits: parseInt(audits.rows[0].count)
      });
    }
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

/**
 * Fetch the most recent platform-wide audit-log entries.
 *
 * @param req - Express request (admin-only; global, not tenant-scoped).
 * @param res - Express response.
 * @returns 200 with up to 50 most recent rows from `public.audit_logs`.
 * @throws Responds 500 `(error)` on a database failure.
 */
export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.audit_logs ORDER BY changed_at DESC LIMIT 50');
    res.json(rows);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

/**
 * Summarize the catalog (schemas/tables, row counts, last crawl time) visible
 * to the caller's tenant, matched either by owning data-source or by the
 * conventional `tenant_<id>...` physical schema naming.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 * @param res - Express response.
 * @returns 200 with an array of `(schema_name, table_name, row_count, last_crawled_at)`.
 * @throws Responds 500 `(error)` on a database failure.
 */
export const getCatalogSummary = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const params: any[] = [];
    const scope = catalogSchemaScope('s', params, user.tenant_id);
    const { rows } = await queryWithContext(`
      SELECT 
        s.physical_name as schema_name, 
        t.physical_name as table_name, 
        t.row_count, 
        t.last_crawled_at 
      FROM public.catalog_tables t
      JOIN public.catalog_schemas s ON t.schema_id = s.id
      WHERE ${scope}
      ORDER BY s.physical_name, t.physical_name ASC`, params, {
      tenantId: user.tenant_id,
      username: user.username || 'unknown'
    });
    res.json(rows);
  } catch (err: any) { fail(res, err); }
};

/**
 * List notification channels (e.g. email/webhook/Slack targets) configured for
 * trigger actions, ordered by type then name.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 * @param res - Express response.
 * @returns 200 with rows `(id, channelType, name, config, isDefault, status, updatedAt)`
 *   from `public.notification_channels`.
 * @throws Responds 500 `(error)` on a database failure.
 */
export const listNotificationChannels = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await queryWithContext(
      `SELECT id, channel_type as "channelType", name, config, is_default as "isDefault", status, updated_at as "updatedAt"
       FROM public.notification_channels
       WHERE tenant_id = $1
       ORDER BY channel_type, name`,
      [user.tenant_id],
      { tenantId: user.tenant_id, username: user.username }
    );
    // Webhook URLs / tokens in a channel config are secrets: only the workspace owner / a platform admin sees them.
    const privileged = isPlatformAdmin(user) || await isWorkspaceOwner(user, user.tenant_id);
    res.json(privileged ? rows : rows.map((r: any) => { const { config, hasPassword } = redactConfig(r.config); return { ...r, config, hasPassword }; }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create or update a notification channel. When marked as the default for its
 * `channelType`, clears the default flag on any other channel of that type
 * first, so at most one default exists per type.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Body: `(channelType: string (required), name: string (required),
 *   config: object (required), isDefault?: boolean (default false),
 *   status?: string (default 'ACTIVE'))`.
 * @param res - Express response.
 * @returns 200 with the upserted channel row `(id, channelType, name, config,
 *   isDefault, status)` (upsert keyed on tenant + channelType + name).
 * @throws Responds 400 `(error: 'channelType, name, config required')` when any
 *   are missing; 500 `(error)` on a database failure.
 */
export const upsertNotificationChannel = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { channelType, name, config, isDefault = false, status = 'ACTIVE' } = req.body || {};
    if (!channelType || !name || !config) return res.status(400).json({ error: 'channelType, name, config required' });

    if (isDefault) {
      await queryWithContext(
        `UPDATE public.notification_channels SET is_default = false, updated_at = NOW() WHERE channel_type = $1 AND tenant_id = $2`,
        [channelType, user.tenant_id],
        { tenantId: user.tenant_id, username: user.username }
      );
    }

    const { rows } = await queryWithContext(
      `INSERT INTO public.notification_channels (tenant_id, channel_type, name, config, is_default, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (tenant_id, channel_type, name)
       DO UPDATE SET config = EXCLUDED.config, is_default = EXCLUDED.is_default, status = EXCLUDED.status, updated_at = NOW()
       RETURNING id, channel_type as "channelType", name, config, is_default as "isDefault", status`,
      [user.tenant_id, channelType, name, JSON.stringify(config), !!isDefault, status],
      { tenantId: user.tenant_id, username: user.username }
    );
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Delete a notification channel by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   `req.params.id` is the channel id to delete.
 * @param res - Express response.
 * @returns 200 `(status: 'SUCCESS')` (idempotent — succeeds even if the id
 *   didn't match any row).
 * @throws Responds 500 `(error)` on a database failure.
 */
export const deleteNotificationChannel = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
    const del = await queryWithContext(`DELETE FROM public.notification_channels WHERE id = $1 AND tenant_id = $2`, [req.params.id, user.tenant_id], {
      tenantId: user.tenant_id,
      username: user.username
    });
    if (!del.rowCount) return res.status(404).json({ error: 'Channel not found', code: 'NOT_FOUND' });
    res.json({ status: 'SUCCESS' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Send a synthetic test event through a notification channel, by enqueuing a
 * one-off `EXECUTE_TRIGGER_ACTION` job with a fabricated payload — exercises
 * the same job pipeline (`trigger_jobs`) real trigger actions use, without
 * requiring an actual trigger or row mutation.
 *
 * @param req - Express request. Requires `(req as any).user` (tenant_id, username).
 *   Body: `(channelType: string (required), name?: string, sample?: object)` —
 *   `sample` is merged into the synthetic action's `execute` config (e.g.
 *   channel-specific overrides).
 * @param res - Express response.
 * @returns 200 `(status: 'ENQUEUED', jobId)` once the test job is queued
 *   (delivery itself happens asynchronously via the trigger job worker).
 * @throws Responds 400 `(error: 'channelType required')` when missing;
 *   500 `(error)` on a database failure while enqueuing.
 */
export const testNotificationChannel = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { channelType, name, sample } = req.body || {};
    if (!channelType) return res.status(400).json({ error: 'channelType required' });
    const payload = {
      triggerName: `settings_test_${name || channelType}`,
      event: 'SETTINGS_TEST',
      actionType: channelType,
      schemaName: '__SYSTEM__',
      tableName: '__SYSTEM__',
      newRow: {
        id: `test-${Date.now()}`,
        status: 'TEST',
        amount: 1
      },
      execute: {
        type: channelType,
        ...(sample || {})
      }
    };
    const { rows } = await queryWithContext(
      `INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
       VALUES ($1, NULL, 'EXECUTE_TRIGGER_ACTION', $2::jsonb, 'PENDING', NOW(), 3, $3)
       RETURNING id`,
      [user.tenant_id, JSON.stringify(payload), user.username],
      { tenantId: user.tenant_id, username: user.username }
    );
    res.json({ status: 'ENQUEUED', jobId: rows[0].id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
