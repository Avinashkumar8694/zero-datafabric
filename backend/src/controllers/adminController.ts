import { Request, Response } from 'express';
import * as adminService from '../services/adminService';
import { IntegrationService } from '../modules/integration/integration.service';
import { TenantService } from '../modules/tenant/tenant.service';
import { AuthService } from '../modules/auth/auth.service';
import { pool, queryWithContext } from '../config/database';

// --- Tenant Management ---
export const getTenants = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
    res.json(rows);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const createTenant = async (req: Request, res: Response) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });
  try {
    const result = await TenantService.createTenant(id, name);
    res.status(201).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const updateTenant = async (req: Request, res: Response) => {
  try {
    const { name, status } = req.body;
    const result = await TenantService.updateTenant(req.params.id as string, name, status);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const deleteTenant = async (req: Request, res: Response) => {
  try {
    const result = await TenantService.deleteTenant(req.params.id as string);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

// --- Connection Management ---
export const getConnections = async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const result = await queryWithContext('SELECT * FROM public.data_sources', [], { tenantId: user.tenant_id, username: user.username });
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
          } as any));
          live_status = 'LIVE';
        } catch {
          live_status = 'UNREACHABLE';
        }
      }
      return { ...row, live_status };
    }));
    res.json(enriched);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const createConnection = async (req: Request, res: Response) => {
  const { name, config } = req.body;
  const user = (req as any).user;
  if (!name || !config) return res.status(400).json({ error: 'name and config are required' });
  try {
    const result = await IntegrationService.registerRemoteSource(user.tenant_id, name, config, { username: user.username });
    const statusCode = result.status === 'RE-INTEGRATED' ? 200 : 201;
    res.status(statusCode).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const updateConnectionStatus = async (req: Request, res: Response) => {
  const { sourceId, status } = req.body;
  if (!sourceId || !status) return res.status(400).json({ error: 'sourceId and status are required' });
  try {
    const result = await adminService.disconnectSource(sourceId, status);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const removeConnection = async (req: Request, res: Response) => {
  const sourceId = req.params.id;
  const user = (req as any).user;
  if (!sourceId) return res.status(400).json({ error: 'sourceId is required' });
  try {
    const result = await IntegrationService.removeSource(sourceId as string, user.tenant_id);
    res.json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

// --- User Management ---
export const getUsers = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT id, username, tenant_id, role, status FROM public.users');
    res.json(rows);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { username, password, tenantId, role } = req.body;
  try {
    const result = await AuthService.createUser(username, password, tenantId, role);
    res.status(201).json(result);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

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
export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const [tenants, connections, audits] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM public.tenants'),
      pool.query('SELECT COUNT(*) FROM public.data_sources'),
      pool.query("SELECT COUNT(*) FROM public.audit_logs WHERE changed_at > NOW() - INTERVAL '24 hours'")
    ]);
    
    res.json({
      tenants: parseInt(tenants.rows[0].count),
      connections: parseInt(connections.rows[0].count),
      audits: parseInt(audits.rows[0].count)
    });
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM public.audit_logs ORDER BY changed_at DESC LIMIT 50');
    res.json(rows);
  } catch (err: any) { 
    console.error(`[Admin] Error in ${req.url}:`, err.message);
    res.status(500).json({ error: err.message }); 
  }
};

export const getCatalogSummary = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await queryWithContext(`
      SELECT 
        s.physical_name as schema_name, 
        t.physical_name as table_name, 
        t.row_count, 
        t.last_crawled_at 
      FROM public.catalog_tables t
      JOIN public.catalog_schemas s ON t.schema_id = s.id
      WHERE ($1::text IS NULL OR (
          s.source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)
          OR s.physical_name LIKE 'tenant_' || $1 || '%'
      ))
      ORDER BY s.physical_name, t.physical_name ASC`, [user.tenant_id], {
      tenantId: user.tenant_id,
      username: user.username || 'unknown'
    });
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
};

export const listNotificationChannels = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await queryWithContext(
      `SELECT id, channel_type as "channelType", name, config, is_default as "isDefault", status, updated_at as "updatedAt"
       FROM public.notification_channels
       ORDER BY channel_type, name`,
      [],
      { tenantId: user.tenant_id, username: user.username }
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const upsertNotificationChannel = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { channelType, name, config, isDefault = false, status = 'ACTIVE' } = req.body || {};
    if (!channelType || !name || !config) return res.status(400).json({ error: 'channelType, name, config required' });

    if (isDefault) {
      await queryWithContext(
        `UPDATE public.notification_channels SET is_default = false, updated_at = NOW() WHERE channel_type = $1`,
        [channelType],
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

export const deleteNotificationChannel = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    await queryWithContext(`DELETE FROM public.notification_channels WHERE id = $1`, [req.params.id], {
      tenantId: user.tenant_id,
      username: user.username
    });
    res.json({ status: 'SUCCESS' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

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
