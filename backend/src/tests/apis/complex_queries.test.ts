import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';

describe('Data Fabric: Industrial Complex Queries', () => {
    let token: string;
    let tenantId = 'tenant_complex';

    beforeAll(async () => {
        // Setup Tenant
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
        await pool.query('INSERT INTO public.tenants (id, name, status) VALUES ($1, $2, $3)', [tenantId, 'Complex Test Tenant', 'ACTIVE']);
        
        token = AuthService.generateToken(tenantId, 'ADMIN', 'admin');

        // Create logical tables for testing
        const schemaName = `tenant_${tenantId}`;
        await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
        await pool.query(`GRANT ALL ON SCHEMA "${schemaName}" TO fabric_user`);
        
        await pool.query(`DROP TABLE IF EXISTS "${schemaName}"."orders" CASCADE`);
        await pool.query(`DROP TABLE IF EXISTS "${schemaName}"."users" CASCADE`);
        
        await pool.query(`CREATE TABLE "${schemaName}"."users" (id UUID PRIMARY KEY, name TEXT, email TEXT)`);
        await pool.query(`CREATE TABLE "${schemaName}"."orders" (id UUID PRIMARY KEY, user_id UUID REFERENCES "${schemaName}"."users"(id), amount DECIMAL, status TEXT)`);
        
        await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO fabric_user`);

        // Seed data
        const uid1 = '11111111-1111-1111-1111-111111111111';
        const uid2 = '22222222-2222-2222-2222-222222222222';
        await pool.query(`INSERT INTO "${schemaName}"."users" (id, name, email) VALUES ($1, $2, $3), ($4, $5, $6)`, 
            [uid1, 'Alice', 'alice@example.com', uid2, 'Bob', 'bob@example.com']);
        
        await pool.query(`INSERT INTO "${schemaName}"."orders" (id, user_id, amount, status) VALUES 
            (gen_random_uuid(), $1, 100.50, 'COMPLETED'),
            (gen_random_uuid(), $1, 50.00, 'PENDING'),
            (gen_random_uuid(), $2, 200.00, 'COMPLETED')`, [uid1, uid2]);
    });

    it('Success: Execute Join Query with Aliases and Filters', async () => {
        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({
                type: 'SELECT',
                table: 'users',
                select: ['users.name', 'orders.amount', 'orders.status'],
                joins: [
                    {
                        type: 'INNER',
                        table: 'orders',
                        on: 'users.id = orders.user_id'
                    }
                ],
                filter: {
                    'orders.status': 'COMPLETED',
                    'users.name': { '$ne': 'Eve' }
                },
                orderBy: [{ field: 'orders.amount', dir: 'DESC' }]
            });

        if (res.status !== 200) console.error('Complex Join Error:', res.body.error);
        expect(res.status).toBe(200);
        expect(res.body.length).toBe(2);
    });

    it('Success: Advanced Filter with $in Operator', async () => {
        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({
                type: 'SELECT',
                table: 'users',
                filter: {
                    'name': { '$in': ['Alice', 'Charlie'] }
                }
            });

        if (res.status !== 200) console.error('Filter $in Error:', res.body.error);
        expect(res.status).toBe(200);
        expect(res.body.length).toBe(1);
    });
});
