import jwt from 'jsonwebtoken';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET must be set when NODE_ENV=production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';

export const generateToken = (payload: object) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
};

export const authenticateMockUser = (username: string, password: string) => {
  // Mock authentication logic for POC purposes
  if (username === 'admin' && password === 'admin') {
    return {
      role: 'web_anon',
      username: username,
      tenant_id: 'tenant_1',
    };
  }
  return null;
};
