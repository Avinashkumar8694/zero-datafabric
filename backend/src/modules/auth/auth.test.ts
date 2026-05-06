import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import bcrypt from 'bcrypt';

describe('Module 1.1: Industrial IAM & Auth', () => {
  const adminCredentials = { username: 'admin', password: 'admin' };
  let adminToken: string;

  beforeAll(async () => {
      // Ensure admin exists with correct hash (Migration should have done this, but we verify)
      const hash = await bcrypt.hash('admin', 10);
      await pool.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'Admin Tenant') ON CONFLICT DO NOTHING");
      await pool.query(
          "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
          ['admin', hash, 'tenant_A', 'ADMIN']
      );
  });

  describe('Authentication Flow', () => {
    it('should login successfully with valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send(adminCredentials);

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('admin');
      adminToken = res.body.token;
    });

    it('should reject login with invalid password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should reject login with non-existent user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'ghost', password: 'password' });

      expect(res.status).toBe(401);
    });
  });

  describe('User Management (IAM)', () => {
    const newUser = {
        username: 'test_user_' + Date.now(),
        password: 'test_password',
        tenantId: 'tenant_A',
        role: 'USER'
    };

    it('should allow an admin to create a new user', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(newUser);

      expect(res.status).toBe(201);
      expect(res.body.username).toBe(newUser.username);
    });

    it('should allow the new user to login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: newUser.username, password: newUser.password });

      expect(res.status).toBe(200);
      expect(res.body.user.tenant_id).toBe(newUser.tenantId);
    });

    it('should list all users for the admin', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((u: any) => u.username === newUser.username)).toBe(true);
    });
  });

  afterAll(async () => {
    // Cleanup test users but keep the seed admin for other tests
    await pool.query("DELETE FROM public.users WHERE username LIKE 'test_user_%'");
  });
});
