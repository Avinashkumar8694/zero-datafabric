import { Router } from 'express';
import { pool } from '../config/database';
import { LicensingService } from '../services/licensing.service';

const router = Router();

const requireAdmin = (req: any, res: any, next: any) => {
    if (!req.user || req.user.internal_role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin privileges required' });
    }
    next();
};

async function isSystemSelfHost(): Promise<boolean> {
    try {
        const { rows } = await pool.query(
            `SELECT p.name
             FROM public.subscriptions s
             JOIN public.plans p ON s.plan_id = p.id
             JOIN public.users u ON s.user_id = u.id
             WHERE (u.username = 'admin' OR u.username = 'arjunkumargupta108@gmail.com') AND s.status = 'active'`
        );
        return rows.some(r => r.name === 'selfhost');
    } catch {
        return false;
    }
}

/**
 * GET /api/settings/login
 * Retrieve customized login configurations (public endpoint)
 */
router.get('/login', async (req, res) => {
    try {
        const selfhost = await isSystemSelfHost();
        const { rows } = await pool.query("SELECT value FROM public.settings WHERE key = 'custom_login'");
        if (rows.length === 0) {
            return res.json({
                selfhost,
                title: "Data Fabric",
                logo_url: "",
                bg_color: "#04060f",
                allow_password_login: true,
                sso_enabled: true
            });
        }
        
        // Hide OIDC secret from public consumption
        const val = rows[0].value || {};
        const safeVal = {
            selfhost,
            title: val.title || "Data Fabric",
            logo_url: val.logo_url || "",
            bg_color: val.bg_color || "#04060f",
            allow_password_login: val.allow_password_login !== undefined ? val.allow_password_login : true,
            sso_enabled: val.sso_enabled !== undefined ? val.sso_enabled : true,
            oidc_issuer: val.oidc_issuer || "https://ids.fabrixly.com",
            oidc_client_id: val.oidc_client_id || "zero-datafabric"
        };
        res.json(safeVal);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/settings/login/raw
 * Retrieve full configs including secrets (admin only)
 */
router.get('/login/raw', requireAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT value FROM public.settings WHERE key = 'custom_login'");
        if (rows.length === 0) {
            return res.json({});
        }
        res.json(rows[0].value);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/settings/login
 * Update customized login configurations (admin only, self-host plan required)
 */
router.post('/login', requireAdmin, async (req: any, res: any) => {
    try {
        const user = req.user;
        const isSelfHost = await LicensingService.isSelfHost(user.id);
        if (!isSelfHost) {
            return res.status(403).json({ error: 'Custom login configuration is a premium Self-Host feature. Please upgrade your plan to unlock.' });
        }

        const { title, logo_url, bg_color, allow_password_login, sso_enabled, oidc_issuer, oidc_client_id, oidc_client_secret } = req.body;

        const val = {
            title,
            logo_url,
            bg_color,
            allow_password_login: !!allow_password_login,
            sso_enabled: !!sso_enabled,
            oidc_issuer,
            oidc_client_id,
            oidc_client_secret
        };

        const { rows } = await pool.query(
            `INSERT INTO public.settings (key, value)
             VALUES ('custom_login', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
             RETURNING *`,
            [JSON.stringify(val)]
        );

        res.json(rows[0].value);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
