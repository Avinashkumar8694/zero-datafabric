import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';

export const getAdminToken = async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    return res.body.token;
};

export const cleanupTenant = async (tenantId: string) => {
    await pool.query('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM public.users WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
    await pool.query(`DROP SCHEMA IF EXISTS tenant_${tenantId} CASCADE`);
};
