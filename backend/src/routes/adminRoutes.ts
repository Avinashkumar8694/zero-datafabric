import { Router } from 'express';
import * as adminController from '../controllers/adminController';

const router = Router();

// Tenant Management
router.get('/tenants', adminController.getTenants);
router.post('/tenants', adminController.createTenant);
router.put('/tenants/:id', adminController.updateTenant);
router.patch('/tenants/:id', adminController.updateTenant);
router.delete('/tenants/:id', adminController.deleteTenant);

// Connection Management
router.get('/connections', adminController.getConnections);
router.post('/connections', adminController.createConnection);
router.patch('/connections', adminController.updateConnectionStatus);
router.delete('/connections/:id', adminController.removeConnection);

// User Management
router.get('/users', adminController.getUsers);
router.post('/users', adminController.createUser);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);

// Platform Insights
router.get('/stats', adminController.getDashboardStats);
router.get('/audit-logs', adminController.getAuditLogs);
router.get('/catalog', adminController.getCatalogSummary);
router.get('/notification-channels', adminController.listNotificationChannels);
router.post('/notification-channels', adminController.upsertNotificationChannel);
router.delete('/notification-channels/:id', adminController.deleteNotificationChannel);
router.post('/notification-channels/test', adminController.testNotificationChannel);

export default router;
