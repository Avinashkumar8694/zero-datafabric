import { Router } from 'express';
import { pool } from '../config/database';

const router = Router();

function getNextDataResetTime(frequency: string, hour: number, timezone: string): Date | null {
    if (!frequency || frequency === 'none') return null;
    
    try {
        const now = new Date();
        const tz = timezone || 'Asia/Kolkata';
        
        const localDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        const targetDate = new Date(localDate);
        targetDate.setHours(hour, 0, 0, 0);
        
        if (localDate.getTime() >= targetDate.getTime()) {
            if (frequency === 'daily') {
                targetDate.setDate(targetDate.getDate() + 1);
            } else if (frequency === 'weekly') {
                targetDate.setDate(targetDate.getDate() + 7);
            }
        } else if (frequency === 'weekly') {
            const dayOfWeek = localDate.getDay();
            if (dayOfWeek !== 0) {
                targetDate.setDate(targetDate.getDate() + (7 - dayOfWeek));
            }
        }
        
        const diff = targetDate.getTime() - localDate.getTime();
        return new Date(now.getTime() + diff);
    } catch (e) {
        console.error('[Cleanup] Error computing next reset time:', e);
        return null;
    }
}

/**
 * GET /api/subscriptions/me
 * Get the current user's active subscription
 */
router.get('/me', async (req, res) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });

        const { rows } = await pool.query(
            `SELECT s.*, p.name as plan_name, p.price_monthly, p.limits, p.features, u.timezone
             FROM public.subscriptions s
             JOIN public.plans p ON s.plan_id = p.id
             JOIN public.users u ON s.user_id = u.id
             WHERE s.user_id = $1 AND s.status = 'active'`,
            [user.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No active subscription found' });
        }
        
        const sub = rows[0];
        const trialDays = sub.features?.trial_period_days;
        let isTrialExpired = false;
        if (trialDays !== undefined && trialDays !== null && trialDays !== -1) {
            const start = new Date(sub.start_date).getTime();
            const now = Date.now();
            const diffDays = (now - start) / (1000 * 60 * 60 * 24);
            isTrialExpired = diffDays > trialDays;
        }

        const limits = sub.limits || {};
        const cleanupFrequency = limits.data_cleanup_frequency || 'none';
        const cleanupHour = limits.data_cleanup_hour !== undefined ? parseInt(limits.data_cleanup_hour) : 2;
        const nextReset = getNextDataResetTime(cleanupFrequency, cleanupHour, sub.timezone);

        res.json({
            ...sub,
            is_trial_expired: isTrialExpired,
            next_data_reset_at: nextReset ? nextReset.toISOString() : null
        });
    } catch (err: any) {
        console.error('[Subscriptions] Error fetching subscription:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/subscriptions/me
 * Create or update the current user's subscription
 */
router.post('/me', async (req, res) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });

        const { plan_id, status, end_date, snapshot } = req.body;

        if (!plan_id) return res.status(400).json({ error: 'plan_id is required' });

        // Check if subscription already exists
        const existing = await pool.query(
            'SELECT id FROM public.subscriptions WHERE user_id = $1',
            [user.id]
        );

        let result;
        if (existing.rows.length > 0) {
            // Update existing
            result = await pool.query(
                `UPDATE public.subscriptions
                 SET plan_id = $1, status = COALESCE($2, status), end_date = COALESCE($3, end_date), snapshot = COALESCE($4, snapshot)
                 WHERE user_id = $5
                 RETURNING *`,
                [plan_id, status, end_date, snapshot, user.id]
            );
        } else {
            // Create new
            result = await pool.query(
                `INSERT INTO public.subscriptions (user_id, plan_id, status, end_date, snapshot)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [user.id, plan_id, status || 'active', end_date, snapshot]
            );
        }
        res.json(result.rows[0]);
    } catch (err: any) {
        console.error('[Subscriptions] Error updating subscription:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/subscriptions/me/limits
 * Get current limits for the current user based on their subscription
 */
router.get('/me/limits', async (req, res) => {
    try {
        const user = (req as any).user;
        if (!user) return res.status(401).json({ error: 'Authentication required' });

        const { rows } = await pool.query(
            `SELECT p.limits, p.features
             FROM public.subscriptions s
             JOIN public.plans p ON s.plan_id = p.id
             WHERE s.user_id = $1 AND s.status = 'active'`,
            [user.id]
        );
        if (rows.length === 0) {
            // Return trial limits as default
            const trialPlan = await pool.query("SELECT limits, features FROM public.plans WHERE name = 'trial'");
            if (trialPlan.rows.length > 0) {
                return res.json(trialPlan.rows[0]);
            }
            return res.status(404).json({ error: 'No plan found' });
        }
        res.json({ limits: rows[0].limits, features: rows[0].features });
    } catch (err: any) {
        console.error('[Subscriptions] Error fetching limits:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
