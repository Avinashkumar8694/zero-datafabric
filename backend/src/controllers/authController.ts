import { Request, Response } from 'express';
import { AuthService } from '../modules/auth/auth.service';

export const login = async (req: Request, res: Response) => {
  const { username, password } = req.body;
  try {
    const result = await AuthService.login(username, password);
    if (result) return res.json(result);
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

export const refreshToken = (req: Request, res: Response) => {
  const user = (req as any).user; 
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  
  const { tenantId } = req.body;
  if (!tenantId) {
    console.warn(`[Auth] Token exchange failed: missing tenantId for user ${user.username}`);
    return res.status(400).json({ error: 'tenantId is required' });
  }
  const token = AuthService.generateToken(tenantId, user.internal_role, user.username || 'unknown');
  console.log(`[Auth] Issued tenant-scoped token for ${user.username} -> ${tenantId}`);
  res.json({ token });
};
