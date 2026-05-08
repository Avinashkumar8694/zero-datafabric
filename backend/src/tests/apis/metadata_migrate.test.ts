import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('POST /api/metadata/migrate (Industrial Scenarios)', () => {
    let adminToken: string;
    const testTenantId = 'ind_migrate_tenant';

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Industrial Migrate' });
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Orchestrate full V7.0 schema manifest (Functions, Triggers, Junctions)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const migrationPlan = [
            { action: 'CREATE_SCHEMA', details: {} },
            {
                action: 'CREATE_TABLE',
                table: 'audit_logs',
                details: {
                    columns: [
                        { name: 'id', type: 'SERIAL', primaryKey: true },
                        { name: 'event_type', type: 'VARCHAR(50)' },
                        { name: 'details', type: 'TEXT' }
                    ]
                }
            },
            {
                action: 'CREATE_FUNCTION',
                name: 'fn_log_test_audit',
                body: `BEGIN
                         INSERT INTO "tenant_${testTenantId}".audit_logs (event_type, details)
                         VALUES ('TEST_INSERT', 'Trigger fired');
                         RETURN NEW;
                       END;`
            },
            {
                action: 'CREATE_TABLE',
                table: 'trigger_test',
                details: {
                    columns: [
                        { name: 'id', type: 'SERIAL', primaryKey: true },
                        { name: 'data', type: 'TEXT' }
                    ],
                    triggers: [
                        { name: 'trg_test_audit', event: 'AFTER INSERT', function: `"tenant_${testTenantId}".fn_log_test_audit` }
                    ]
                }
            },
            {
                action: 'CREATE_TABLE',
                table: 'junction_table',
                details: {
                    columns: [
                        { name: 'id_a', type: 'INTEGER' },
                        { name: 'id_b', type: 'INTEGER' }
                    ],
                    compositePrimaryKey: ['id_a', 'id_b']
                }
            }
        ];

        const res = await request(app)
            .post('/api/metadata/migrate')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send({ migrationPlan });

        expect(res.status).toBe(200);
        expect(res.body.results.length).toBe(5);
        expect(res.body.results.every((r: any) => r.status === 'SUCCESS')).toBe(true);
    });

    it('Success: Apply SOFT_DELETE_TABLE action', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app)
            .post('/api/metadata/migrate')
            .set('Authorization', `Bearer ${scopedToken}`)
            .send({
                migrationPlan: [{ action: 'SOFT_DELETE_TABLE', table: 'junction_table' }]
            });

        expect(res.status).toBe(200);
        expect(res.body.results[0].status).toBe('SUCCESS_METADATA_ONLY');
    });
});
