/**
 * @module routes/adminRoutes
 * @description Platform administration router, mounted at `/api/admin` behind
 * `requireAdmin` (see `index.ts`) — every route here requires a platform-admin
 * bearer token. Covers tenant lifecycle, data-source connection management,
 * platform user management, and cross-tenant insights/notification-channel config.
 */

import { Router } from 'express';
import * as adminController from '../controllers/adminController';

const router = Router();

// Middleware to enforce system admin privileges
const requireAdmin = (req: any, res: any, next: any) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (user.internal_role !== 'ADMIN') return res.status(403).json({ error: 'Admin privileges required' });
    next();
};

// Tenant Management
router.get('/tenants', requireAdmin, adminController.getTenants); // GET /api/admin/tenants — list all tenants
router.post('/tenants', requireAdmin, adminController.createTenant); // POST /api/admin/tenants — provision a new tenant
router.put('/tenants/:id', requireAdmin, adminController.updateTenant); // PUT /api/admin/tenants/:id — update tenant name/status
router.patch('/tenants/:id', requireAdmin, adminController.updateTenant); // PATCH /api/admin/tenants/:id — same as PUT, partial update
router.delete('/tenants/:id', requireAdmin, adminController.deleteTenant); // DELETE /api/admin/tenants/:id — permanently remove a tenant

// Connection Management (Tenant-scoped, open to trial/users)
router.get('/connections', adminController.getConnections); // GET /api/admin/connections — list data sources with live status probe
router.post('/connections', adminController.createConnection); // POST /api/admin/connections — register/re-integrate a remote source
router.patch('/connections', adminController.updateConnectionStatus); // PATCH /api/admin/connections — update a source's connection status
router.delete('/connections/:id', adminController.removeConnection); // DELETE /api/admin/connections/:id — remove a data source

// User Management (Admin-only)
router.get('/users', requireAdmin, adminController.getUsers); // GET /api/admin/users — list all platform users
router.post('/users', requireAdmin, adminController.createUser); // POST /api/admin/users — create a platform user
router.put('/users/:id', requireAdmin, adminController.updateUser); // PUT /api/admin/users/:id — update a platform user
router.delete('/users/:id', requireAdmin, adminController.deleteUser); // DELETE /api/admin/users/:id — delete a platform user

// Platform Insights (Open to users, scoped inside adminController)
router.get('/stats', adminController.getDashboardStats); // GET /api/admin/stats — global / tenant dashboard counters
router.get('/audit-logs', requireAdmin, adminController.getAuditLogs); // GET /api/admin/audit-logs — recent platform-wide audit log entries
router.get('/catalog', adminController.getCatalogSummary); // GET /api/admin/catalog — catalog summary for the caller's tenant
router.get('/notification-channels', adminController.listNotificationChannels); // GET /api/admin/notification-channels — list configured notification channels
router.post('/notification-channels', adminController.upsertNotificationChannel); // POST /api/admin/notification-channels — create/update a notification channel
router.delete('/notification-channels/:id', adminController.deleteNotificationChannel); // DELETE /api/admin/notification-channels/:id — delete a notification channel
router.post('/notification-channels/test', adminController.testNotificationChannel); // POST /api/admin/notification-channels/test — send a synthetic test event through a channel

export default router;
