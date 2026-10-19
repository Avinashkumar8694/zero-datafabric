import { Router } from 'express';
import { pool } from '../config/database';
import { LicensingService } from '../services/licensing.service';
import { TenantService } from '../modules/tenant/tenant.service';

const router = Router();

/**
 * GET /api/tenants
 * List tenants accessible to the current user.
 * - Admin: sees all tenants
 * - Regular user: sees only their own tenants
 */
router.get('/', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    let rows;
    if (user.internal_role === 'ADMIN') {
      const result = await pool.query('SELECT * FROM public.tenants ORDER BY created_at DESC');
      rows = result.rows;
    } else {
      const result = await pool.query(
        'SELECT * FROM public.tenants WHERE user_id = $1 ORDER BY created_at DESC',
        [user.id]
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (err: any) {
    console.error(`[Tenants] Error listing tenants:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/tenants
 * Create a new tenant for the current user.
 * Checks plan limits before creating.
 */
router.post('/', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { id, name } = req.body;
    if (!name) return res.status(400).json({ error: 'Tenant name is required' });

    // Check plan limits
    const limitCheck = await LicensingService.canCreateTenant(user.id);
    if (!limitCheck.allowed) {
      return res.status(403).json({ error: limitCheck.reason });
    }

    // Generate or sanitize tenant ID
    let tenantId = id;
    if (!tenantId) {
      tenantId = `t_${user.username.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${Date.now().toString(36)}`;
    } else {
      tenantId = tenantId.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
      if (!tenantId.startsWith('t_')) {
        tenantId = `t_${tenantId}`;
      }
    }

    const result = await TenantService.createTenant(tenantId, name, 'STANDARD', user.id);
    res.status(201).json(result);
  } catch (err: any) {
    console.error(`[Tenants] Error creating tenant:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/tenants/:id
 * Update tenant name or status (active/suspended/archived).
 * Allowed for:
 * - Admin
 * - Tenant Owner (user_id = user.id)
 */
router.put('/:id', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    const { name, status } = req.body;

    const { rows } = await pool.query('SELECT * FROM public.tenants WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenant = rows[0];
    if (user.internal_role !== 'ADMIN' && tenant.user_id !== user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await TenantService.updateTenant(id, name || tenant.name, status || tenant.status);
    res.json(result);
  } catch (err: any) {
    console.error(`[Tenants] Error updating tenant:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tenants/:id
 * Get a specific tenant (user can only access their own, admin can access any)
 */
router.get('/:id', async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM public.tenants WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenant = rows[0];
    // Check access: admin or owner
    if (user.internal_role !== 'ADMIN' && tenant.user_id !== user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(tenant);
  } catch (err: any) {
    console.error(`[Tenants] Error fetching tenant:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
