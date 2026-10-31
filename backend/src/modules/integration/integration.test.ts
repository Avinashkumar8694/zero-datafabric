import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import jwt from 'jsonwebtoken';

jest.setTimeout(30000);

describe('Module 1/3: Data Integration & Virtualization', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  const token = jwt.sign({ tenant_id: 'tenant_C', username: 'admin_user', internal_role: 'ADMIN' }, secret);

  beforeAll(async () => {
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_C', 'Integration Test Tenant') ON CONFLICT DO NOTHING");
    await pool.query("SELECT fabric_admin.create_tenant_namespace('tenant_C')");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.data_sources WHERE tenant_id = 'tenant_C'");
    await pool.query("DELETE FROM public.users WHERE tenant_id = 'tenant_C'");
    await pool.query("DELETE FROM public.tenants WHERE id = 'tenant_C'");
  });

  it('refuses to register the platform hub itself as a source (no server-side credentials are ever injected)', async () => {
    const res = await request(app)
      .post('/api/admin/connections')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Remote_Store',
        config: {
          host: '127.0.0.1',
          port: Number(process.env.DB_PORT || 5434), // the hub's own mapped port
          dbName: 'datafabric',
          user: 'fabric_admin',
          type: 'postgres',
          syncType: 'VIRTUAL'
        }
      });

    expect(res.status).toBe(403);
    const { rows } = await pool.query("SELECT 1 FROM public.data_sources WHERE name = 'Remote_Store' AND tenant_id = 'tenant_C'");
    expect(rows.length).toBe(0);
  });

  it('registers a source and is idempotent on re-registration', async () => {
    const body = { name: 'Remote_Store', config: { host: 'dummy', port: 5432, dbName: 'datafabric', user: 'u', pass: 'p', type: 'postgres', syncType: 'VIRTUAL' } };
    const first = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${token}`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('INTEGRATED');
    const { rows } = await pool.query("SELECT * FROM public.data_sources WHERE name = 'Remote_Store' AND tenant_id = 'tenant_C'");
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('CONNECTED');

    const again = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${token}`).send(body);
    expect(again.status).toBe(200); // Should return 200 for existing
    expect(again.body.status).toBe('RE-INTEGRATED');
  });

  it('rejects unsafe source names and metadata-service targets', async () => {
    const bad = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${token}`).send({ name: 'x"; DROP SERVER y;--', config: { host: 'dummy', type: 'postgres', syncType: 'VIRTUAL' } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ssrf = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${token}`).send({ name: 'Meta', config: { host: '169.254.169.254', port: 5432, dbName: 'x', type: 'postgres', syncType: 'VIRTUAL' } });
    expect(ssrf.status).toBeGreaterThanOrEqual(400);
  });

  it('should return 500 when registering with an invalid configuration', async () => {
    const res = await request(app)
      .post('/api/admin/connections')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Invalid_Store',
        config: {
          host: 'non-existent-host',
          port: 5432,
          dbName: 'nothing',
          user: 'invalid',
          pass: 'invalid',
          syncType: 'VIRTUAL'
        }
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it('should successfully remove a registered source and cleanup FDW servers', async () => {
    // First get the ID
    const { rows } = await pool.query("SELECT id FROM public.data_sources WHERE name = 'Remote_Store'");
    const sourceId = rows[0].id;

    const res = await request(app)
      .delete(`/api/admin/connections/${sourceId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DECOMMISSIONED');

    // Verify FDW cleanup
    const { rows: servers } = await pool.query("SELECT srvname FROM pg_foreign_server");
    console.log('--- SERVERS REMAINING ---', servers);
    const hasStore = servers.some((s: any) => s.srvname.includes('tenant_C') && s.srvname.includes('Remote_Store'));
    expect(hasStore).toBe(false);
  });

  it('should prevent registration without a valid authorization token', async () => {
    const res = await request(app)
      .post('/api/admin/connections')
      .send({
        name: 'Hacker_Source',
        config: { host: 'evil.com', port: 5432 }
      });

    expect(res.status).toBe(401);
  });
});
