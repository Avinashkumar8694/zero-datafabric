import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { pool } from '../../config/database';

/**
 * AuthService — username/password authentication and JWT issuance/verification.
 *
 * Users are stored in `public.users` with a bcrypt password hash. On
 * successful login, a JWT is minted whose `role` claim is always the fixed
 * Postgres role `fabric_user` (the role PostgREST authenticates the DB
 * connection as), while the caller's real application role travels
 * separately as `internal_role` for app-level authorization decisions (e.g.
 * (@link GrantService), (@link PolicyService)) and `x-act-as-role`
 * impersonation. `tenant_id` and `username` are embedded so downstream
 * requests can be scoped without an extra lookup.
 */

/** Resolve the HMAC secret used to sign/verify JWTs, falling back to a dev default if unset. */
const getJwtSecret = () => process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';

export class AuthService {
  /**
   * Authenticate a username/password pair against `public.users`.
   * Runs the user lookup with a 5-second timeout to avoid hanging requests
   * if the database is unresponsive, then verifies the password with bcrypt
   * and, on success, mints a JWT via (@link AuthService.generateToken).
   * @param username - The username to authenticate.
   * @param password_raw - The plaintext password to verify against the stored bcrypt hash.
   * @returns `(token, user: ( id, username, tenant_id ))` on success, or
   *   `null` if the username is missing/unknown or the password does not match.
   * @throws {Error} 'Database Query Timeout' if the user lookup takes longer than 5 seconds.
   */
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

  /**
   * Mint a signed JWT (1h expiry) for an authenticated session.
   * The DB-facing `role` claim is always `fabric_user` — the single Postgres
   * role PostgREST switches to — while `internal_role` carries the real
   * application role for the fabric's own authorization checks.
   * @param tenantId - Tenant the session is scoped to.
   * @param internalRole - The user's application role (e.g. ADMIN/USER); defaults to `'USER'`.
   * @param username - The authenticated username; defaults to `'unknown'`.
   * @returns A signed JWT string.
   */
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

  /**
   * Verify and decode a JWT issued by (@link AuthService.generateToken).
   * @param token - The JWT to verify.
   * @returns The decoded payload if the token is valid and unexpired, or `null` if verification fails.
   */
  static verifyToken(token: string) {
    try {
      return jwt.verify(token, getJwtSecret());
    } catch (err) {
      return null;
    }
  }

  /**
   * Create a new user record with a bcrypt-hashed password.
   * @param username - The new user's username (must be unique).
   * @param password_raw - The plaintext password to hash (bcrypt, cost 10) and store.
   * @param tenantId - Tenant the user belongs to.
   * @param role - The user's application role.
   * @returns The created user row (id, username, tenant_id, role, status).
   * @throws Propagates any database error, e.g. a unique-constraint violation on username.
   */
  static async createUser(username: string, password_raw: string, tenantId: string, role: string) {
    const hash = await bcrypt.hash(password_raw, 10);
    const { rows } = await pool.query(
      'INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ($1, $2, $3, $4) RETURNING id, username, tenant_id, role, status',
      [username, hash, tenantId, role]
    );
    return rows[0];
  }

  /**
   * Update a user's profile, optionally rotating their password.
   * When `password_raw` is provided it is re-hashed and replaces the stored
   * hash; when omitted, only username/tenant/role are updated.
   * @param id - The user's id.
   * @param username - New username.
   * @param password_raw - New plaintext password to hash, or `null`/falsy to leave the password unchanged.
   * @param tenantId - New tenant assignment.
   * @param role - New application role.
   * @returns The updated user row (id, username, tenant_id, role, status).
   */
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

  /**
   * Permanently delete a user record.
   * @param id - The user's id.
   * @returns `(id, status: 'DELETED')` regardless of whether a matching row existed.
   */
  static async deleteUser(id: string) {
    await pool.query('DELETE FROM public.users WHERE id = $1', [id]);
    return { id, status: 'DELETED' };
  }
}
