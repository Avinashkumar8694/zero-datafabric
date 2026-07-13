import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';

export const getAdminToken = async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    return res.body.token;
};

export const cleanupTenant = async (tenantId: string) => {
    try {
        await pool.query('DELETE FROM fabric_catalog.metadata WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]);
        await pool.query('DELETE FROM public.catalog_schemas WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]);
        await pool.query('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM public.users WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
        
        // Drop any schemas dynamically created for the tenant
        const { rows } = await pool.query(`
            SELECT schema_name FROM information_schema.schemata 
            WHERE schema_name LIKE $1
        `, [`tenant_${tenantId}%`]);
        for (const r of rows) {
            await pool.query(`DROP SCHEMA IF EXISTS "${r.schema_name}" CASCADE`);
        }
    } catch (err: any) {
        console.error(`[Test Helper] Error during cleanupTenant for ${tenantId}:`, err.message);
    }
};
