import { Request, Response } from 'express';
import * as authService from '../services/authService';

export const login = async (req: Request, res: Response) => {
  const { username, password } = req.body;

  const user = authService.authenticateMockUser(username, password);

  if (user) {
    const token = authService.generateToken({
      ...user,
      exp: Math.floor(Date.now() / 1000) + (60 * 60),
    });
    return res.json({ token });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
};
