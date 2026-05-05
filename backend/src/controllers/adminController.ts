import { Request, Response } from 'express';
import * as adminService from '../services/adminService';

export const createTenant = async (req: Request, res: Response) => {
  const { tenantName } = req.body;
  if (!tenantName) return res.status(400).json({ error: 'tenantName is required' });

  try {
    const result = await adminService.createTenant(tenantName);
    res.json({ message: 'Tenant Provisioned Successfully', ...result });
  } catch (error) {
    console.error('Tenant provisioning failed:', error);
    res.status(500).json({ error: 'Provisioning failed' });
  }
};

export const createConnection = async (req: Request, res: Response) => {
  const { tenantId, serverName, host, port, dbname, remoteUser, remotePassword } = req.body;
  
  if (!tenantId || !serverName || !host || !port || !dbname || !remoteUser || !remotePassword) {
    return res.status(400).json({ error: 'Missing required connection parameters' });
  }

  try {
    const result = await adminService.createConnection(req.body);
    res.json(result);
  } catch (error) {
    console.error('FDW Connection failed:', error);
    res.status(500).json({ error: 'Connection failed' });
  }
};
