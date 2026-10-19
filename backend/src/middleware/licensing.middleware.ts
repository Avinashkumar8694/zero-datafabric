import { Request, Response, NextFunction } from 'express';
import { LicensingService } from '../services/licensing.service';

/**
 * Licensing Middleware (fails closed with 503 when limits cannot be evaluated):
 * - Excludes platform administrators (internal_role = 'ADMIN').
 * - Checks if the tenant's trial period has expired (7 days default).
 * - Enforces rate limiting per minute, hour, and day.
 */
export const licensingMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // System administrators and test environment bypass all licensing limits
  if ((user.internal_role === 'ADMIN' && user.auth_type !== 'api_token') || (process.env.NODE_ENV === 'test' && process.env.LICENSING_ENFORCE_IN_TEST !== 'true')) {
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
    // Fail closed: if limits cannot be evaluated the request is refused rather than served unmetered.
    console.error('[LicensingMiddleware] Error enforcing licensing:', err.message);
    return res.status(503).json({ error: 'Could not verify licence limits, try again shortly', code: 'LICENSE_CHECK_FAILED' });
  }
};
