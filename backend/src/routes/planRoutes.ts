import { Router } from 'express';
import { pool } from '../config/database';
import { LicensingService } from '../services/licensing.service';

const router = Router();

const blockIfSelfHost = async (req: any, res: any, next: any) => {
    try {
        const user = req.user;
        if (user) {
            const isSelfHost = await LicensingService.isSelfHost(user.id);
            if (isSelfHost) {
                return res.status(403).json({ error: 'Plans related configuration is disabled in self-host mode.' });
            }
        }
        next();
    } catch (err: any) {
        next();
    }
};

/**
 * GET /api/plans
 * List all available plans
 */
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, price_monthly, limits, features, is_default, is_custom, status, created_at
             FROM public.plans
             WHERE status = 'active' OR status IS NULL
             ORDER BY price_monthly ASC, name ASC`
        );
        res.json(rows);
    } catch (err: any) {
        console.error('[Plans] Error listing plans:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/plans/:id
 * Get a single plan by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query(
            'SELECT * FROM public.plans WHERE id = $1',
            [id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        res.json(rows[0]);
    } catch (err: any) {
        console.error('[Plans] Error fetching plan:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/plans
 * Create a new plan (admin only)
 */
router.post('/', blockIfSelfHost, async (req, res) => {
    try {
        const { name, price_monthly, limits, features, is_default, is_custom, status } = req.body;
        if (!name) return res.status(400).json({ error: 'Plan name is required' });

        const { rows } = await pool.query(
            `INSERT INTO public.plans (name, price_monthly, limits, features, is_default, is_custom, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                name,
                price_monthly || 0,
                limits || {},
                features || {},
                is_default || false,
                is_custom || false,
                status || 'active'
            ]
        );
        res.status(201).json(rows[0]);
    } catch (err: any) {
        console.error('[Plans] Error creating plan:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/plans/:id
 * Update a plan (admin only)
 */
router.put('/:id', blockIfSelfHost, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price_monthly, limits, features, is_default, is_custom, status } = req.body;

        const { rows } = await pool.query(
            `UPDATE public.plans
             SET name = COALESCE($1, name),
                 price_monthly = COALESCE($2, price_monthly),
                 limits = COALESCE($3, limits),
                 features = COALESCE($4, features),
                 is_default = COALESCE($5, is_default),
                 is_custom = COALESCE($6, is_custom),
                 status = COALESCE($7, status)
             WHERE id = $8
             RETURNING *`,
            [name, price_monthly, limits, features, is_default, is_custom, status, id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        res.json(rows[0]);
    } catch (err: any) {
        console.error('[Plans] Error updating plan:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/plans/:id
 * Delete a plan (admin only)
 */
router.delete('/:id', blockIfSelfHost, async (req, res) => {
    try {
        const { id } = req.params;
        const { rows } = await pool.query(
            'DELETE FROM public.plans WHERE id = $1 RETURNING id',
            [id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        res.json({ success: true, message: 'Plan deleted' });
    } catch (err: any) {
        console.error('[Plans] Error deleting plan:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
