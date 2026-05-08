import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { pool } from '../../config/database';

const getJwtSecret = () => process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';

export class AuthService {
  static async login(username: string, password_raw: string) {
    if (!username) {
        console.log('[Auth] Login attempt with missing username');
        return null;
    }
    console.log(`[Auth] Attempting login for: [${username}] (length: ${username.length})`);
    // Add a 5-second timeout to prevent indefinite hanging
    const queryPromise = pool.query('SELECT * FROM public.users WHERE username = $1', [username]);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Database Query Timeout')), 5000));
    
    const result = await Promise.race([queryPromise, timeoutPromise]) as any;
    const { rows } = result;
    if (rows.length === 0) {
      console.log(`[Auth] User not found in DB: [${username}]`);
      return null;
    }

    const user = rows[0];
    const match = await bcrypt.compare(password_raw, user.password_hash);
    if (!match) {
      console.log(`[Auth] Password mismatch for user: ${username}`);
      return null;
    }

    const token = this.generateToken(user.tenant_id, user.role, user.username);
    console.log(`[Auth] Login successful for: ${username}, Tenant: ${user.tenant_id}, Role: ${user.role}`);
    return { token, user: { id: user.id, username: user.username, tenant_id: user.tenant_id } };
  }

  static generateToken(tenantId: string, internalRole: string = 'USER', username: string = 'unknown') {
    // Map internal roles to DB roles for PostgREST
    const dbRole = 'fabric_user'; 
    
    const payload = {
      role: dbRole, // This is the role PostgREST will switch to
      internal_role: internalRole, // Store actual role for app logic
      tenant_id: tenantId,
      username: username,
      iat: Math.floor(Date.now() / 1000),
      iss: 'zero-data-fabric'
    };

    return jwt.sign(payload, getJwtSecret(), { expiresIn: '1h' });
  }

  static verifyToken(token: string) {
    try {
      return jwt.verify(token, getJwtSecret());
    } catch (err) {
      return null;
    }
  }

  static async createUser(username: string, password_raw: string, tenantId: string, role: string) {
    const hash = await bcrypt.hash(password_raw, 10);
    const { rows } = await pool.query(
      'INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id, username, tenant_id, role, status',
      [username, hash, tenantId, role]
    );
    return rows[0];
  }

  static async updateUser(id: string, username: string, password_raw: string | null, tenantId: string, role: string) {
    if (password_raw) {
      const hash = await bcrypt.hash(password_raw, 10);
      const { rows } = await pool.query(
        'UPDATE public.users SET username = $1, password_hash = $2, tenant_id = $3, role = $4 WHERE id = $5 RETURNING id, username, tenant_id, role, status',
        [username, hash, tenantId, role, id]
      );
      return rows[0];
    } else {
      const { rows } = await pool.query(
        'UPDATE public.users SET username = $1, tenant_id = $2, role = $3 WHERE id = $4 RETURNING id, username, tenant_id, role, status',
        [username, tenantId, role, id]
      );
      return rows[0];
    }
  }

  static async deleteUser(id: string) {
    await pool.query('DELETE FROM public.users WHERE id = $1', [id]);
    return { id, status: 'DELETED' };
  }
}
