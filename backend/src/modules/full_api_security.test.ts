import request from 'supertest';
import { app } from '../index';
import jwt from 'jsonwebtoken';

describe('Module 6: Full API Security & Authorization Validation', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  const adminToken = jwt.sign({ tenant_id: 'tenant_A', username: 'admin', internal_role: 'ADMIN', role: 'fabric_user' }, secret);
  const userToken = jwt.sign({ tenant_id: 'tenant_A', username: 'user', internal_role: 'USER', role: 'fabric_user' }, secret);
  const dummyId = '00000000-0000-0000-0000-000000000000';

  const testRoute = async (method: string, path: string, token?: string, body?: any) => {
    const req = (request(app) as any)[method.toLowerCase()](path);
    if (token) req.set('Authorization', `Bearer ${token}`);
    if (body) req.send(body);
    return req;
  };

  describe('6.1 Public Access Control', () => {
    it('POST /api/auth/login should be accessible without token (returns 401 for wrong creds, not missing token)', async () => {
      const res = await testRoute('POST', '/api/auth/login', undefined, { username: 'admin', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });
  });

  describe('6.2 Authentication Enforcement (401)', () => {
    const protectedRoutes = [
      ['GET', '/api/admin/tenants'],
      ['POST', '/api/admin/tenants'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['GET', '/api/admin/connections'],
      ['POST', '/api/admin/connections'],
      ['GET', '/api/admin/audit-logs'],
      ['GET', '/api/admin/catalog'],
      ['POST', '/api/queries/exec'],
      ['POST', '/api/auth/token'],
    ];

    protectedRoutes.forEach(([method, path]) => {
      it(`${method} ${path} should return 401 without token`, async () => {
        const res = await testRoute(method, path);
        expect(res.status).toBe(401);
      });
    });
  });

  describe('6.3 Role-Based Authorization Enforcement (403)', () => {
    const adminOnlyRoutes = [
      ['GET', '/api/admin/tenants'],
      ['POST', '/api/admin/tenants'],
      ['PUT', `/api/admin/tenants/${dummyId}`],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['PUT', `/api/admin/users/${dummyId}`],
      ['DELETE', `/api/admin/users/${dummyId}`],
      ['GET', '/api/admin/audit-logs'],
    ];

    adminOnlyRoutes.forEach(([method, path]) => {
      it(`${method} ${path} should return 403 for non-admin user`, async () => {
        const res = await testRoute(method, path, userToken);
        expect(res.status).toBe(403);
      });
    });
  });

  describe('6.4 Tenant User Access to Connections and Catalog (200/404/500)', () => {
    it('GET /api/admin/connections should be accessible for non-admin user', async () => {
      const res = await testRoute('GET', '/api/admin/connections', userToken);
      expect(res.status).toBe(200);
    });

    it('GET /api/admin/catalog should be accessible for non-admin user', async () => {
      const res = await testRoute('GET', '/api/admin/catalog', userToken);
      expect(res.status).toBe(200);
    });
  });

  describe('6.5 Full Admin Access (200/201/202/404)', () => {
    it('GET /api/admin/tenants should be accessible for admin', async () => {
      const res = await testRoute('GET', '/api/admin/tenants', adminToken);
      expect(res.status).toBe(200);
    });

    it('POST /api/queries/exec should be accessible for user', async () => {
        const res = await testRoute('POST', '/api/queries/exec', userToken, { sql: 'SELECT 1' });
        expect(res.status).toBe(200);
    });
  });
});
