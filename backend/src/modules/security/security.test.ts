import request from 'supertest';
import { app } from '../../index';
import { pool, queryWithContext } from '../../config/database';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

describe('Module 3: Security & Governance', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  
  const tokenA = jwt.sign({ tenant_id: 'tenant_A', username: 'user_A', internal_role: 'ADMIN' }, secret);
  const tokenB = jwt.sign({ tenant_id: 'tenant_B', username: 'user_B', internal_role: 'ADMIN' }, secret);

  beforeAll(async () => {
    // Rely on global migration setup for Industrial scale

    // 2. Setup tenants and data
    await pool.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'Tenant A'), ('tenant_B', 'Tenant B') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO public.data_sources (tenant_id, name, type, config) VALUES ('tenant_A', 'Source A', 'postgres', '{}') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO public.data_sources (tenant_id, name, type, config) VALUES ('tenant_B', 'Source B', 'postgres', '{}') ON CONFLICT DO NOTHING");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.data_sources WHERE tenant_id IN ('tenant_A', 'tenant_B')");
    await pool.query("DELETE FROM public.users WHERE tenant_id IN ('tenant_A', 'tenant_B')");
    await pool.query("DELETE FROM public.tenants WHERE id IN ('tenant_A', 'tenant_B')");
  });

  describe('3.1 Row-Level Security (RLS)', () => {
    it('should only return data belonging to the authenticated tenant', async () => {
      // Test with Tenant A
      const resA = await request(app)
        .get('/api/admin/connections') // Note: Using admin endpoint which should respect RLS
        .set('Authorization', `Bearer ${tokenA}`);

      expect(resA.status).toBe(200);
      const dataA = resA.body;
      expect(dataA.every((item: any) => item.tenant_id === 'tenant_A')).toBe(true);
      expect(dataA.some((item: any) => item.name === 'Source A')).toBe(true);
      expect(dataA.some((item: any) => item.name === 'Source B')).toBe(false);

      // Test with Tenant B
      const resB = await request(app)
        .get('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      const dataB = resB.body;
      expect(dataB.every((item: any) => item.tenant_id === 'tenant_B')).toBe(true);
      expect(dataB.some((item: any) => item.name === 'Source B')).toBe(true);
      expect(dataB.some((item: any) => item.name === 'Source A')).toBe(false);
    });

    it('should prevent cross-tenant insertion', async () => {
      const res = await request(app)
        .post('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          tenantId: 'tenant_B', // Attempting to insert for B while logged in as A
          name: 'Hacker Source',
          config: { host: 'localhost', port: 5432, dbName: 'db', user: 'u', pass: 'p' }
        });

      // The controller might just use the body's tenantId, but the DB should reject it if RLS is on
      // or the controller should enforce the JWT's tenantId.
      // If RLS works, the row won't be visible to A, or the INSERT will fail if the WITH CHECK is correct.
      
      // In this app, the Admin controller uses the tenantId from the body. 
      // We want to see if the security layer blocks it.
      expect(res.status).not.toBe(201); // Should fail or be corrected
    });
  });

  describe('3.2 Audit Logging', () => {
    it('should create an audit log entry on data modification', async () => {
      // Clear previous logs for cleanliness
      await pool.query("DELETE FROM fabric_admin.audit_logs WHERE tenant_id = 'tenant_A'");

      // Trigger an update
      await request(app)
        .post('/api/admin/connections')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          tenantId: 'tenant_A',
          name: 'Audit Test Source',
          config: { host: 'localhost' }
        });

      // Check audit logs (ordering by latest to avoid stale data issues)
      const { rows } = await pool.query("SELECT * FROM fabric_admin.audit_logs ORDER BY changed_at DESC LIMIT 1");
      console.log('--- LATEST AUDIT LOG ---', rows[0]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].action).toBe('INSERT');
      expect(rows[0].user_name).toBe('user_A');
      expect(rows[0].tenant_id).toBe('tenant_A');
    });
  });

  describe('3.3 Catalog Isolation', () => {
    it('should prevent Tenant B from seeing metadata of Tenant A', async () => {
      // 1. Admin ensures table exists and inserts metadata for Tenant A
      await pool.query(`
        CREATE SCHEMA IF NOT EXISTS fabric_catalog;
        CREATE TABLE IF NOT EXISTS fabric_catalog.metadata (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            source_id UUID,
            schema_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            data_type TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO fabric_catalog.metadata (schema_name, table_name, column_name, data_type) 
        VALUES ('tenant_tenant_A', 'orders', 'id', 'integer')
        ON CONFLICT DO NOTHING;
      `);

      // 2. Tenant B queries catalog (fully qualified)
      const userB = { tenantId: 'tenant_B', username: 'user_B' };
      const { rows } = await queryWithContext('SELECT * FROM "fabric_catalog"."metadata"', [], userB);

      // 3. Should not see Tenant A's metadata
      const hasTenantA = rows.some((r: any) => r.schema_name === 'tenant_tenant_A');
      expect(hasTenantA).toBe(false);
    });
  });
});
