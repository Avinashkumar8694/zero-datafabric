import { Request, Response, NextFunction } from 'express';
import { LicensingService } from '../services/licensing.service';

/**
 * Licensing Middleware:
 * - Excludes system administrators (internal_role = 'ADMIN').
 * - Checks if the tenant's trial period has expired (7 days default).
 * - Enforces rate limiting per minute, hour, and day.
 */
export const licensingMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // System administrators bypass all licensing limits
  if (user.internal_role === 'ADMIN') {
    return next();
  }

  const tenantId = user.tenant_id;

  try {
    // 1. Check if the trial has expired
    const isExpired = await LicensingService.isTrialExpired(tenantId);
    if (isExpired) {
      return res.status(402).json({
        error: 'Trial period has expired. Please contact support or upgrade your subscription.'
      });
    }

    // 2. Check query rate limits
    const rateCheck = await LicensingService.checkRateLimit(tenantId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded. Your plan limit for ${rateCheck.limitType}ly requests has been reached.`
      });
    }

    next();
  } catch (err: any) {
    console.error('[LicensingMiddleware] Error enforcing licensing:', err.message);
    // Graceful degradation: in case of database or cache error, allow request to proceed
    next();
  }
};
