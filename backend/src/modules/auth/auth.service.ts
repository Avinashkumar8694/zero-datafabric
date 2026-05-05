import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';

export class AuthService {
  static generateToken(tenantId: string, role: string = 'fabric_user') {
    const payload = {
      role,
      tenant_id: tenantId,
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
