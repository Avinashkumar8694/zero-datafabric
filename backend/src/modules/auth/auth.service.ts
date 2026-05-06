import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { pool } from '../../config/database';

const JWT_SECRET = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';

export class AuthService {
  static async login(username: string, password_raw: string) {
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

    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  }

  static verifyToken(token: string) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return null;
    }
  }
}
