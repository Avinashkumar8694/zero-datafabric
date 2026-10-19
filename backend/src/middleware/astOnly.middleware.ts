import { Request, Response, NextFunction } from 'express';

/**
 * The fabric executes structured AST queries only. Reject any request that tries
 * to smuggle SQL text in: `sql` / `rawSql` / `nativeSql` / `rawQuery` keys at the
 * top level, inside `config`, or inside a `query` object, and a `query` that is a
 * string instead of an AST object. Data payload values (rows being inserted) are
 * not scanned, so a column that happens to be named `sql` is unaffected.
 */
const FORBIDDEN = new Set(['sql', 'rawsql', 'nativesql', 'rawquery', 'native']);

const hasForbiddenKey = (o: any): boolean =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).some(k => FORBIDDEN.has(k.toLowerCase()));

export const astOnly = (req: Request, res: Response, next: NextFunction) => {
  const body = req.body;
  if (body && typeof body === 'object') {
    const cfg = body.config && typeof body.config === 'object' ? body.config : undefined;
    const qc = body.queryConfig && typeof body.queryConfig === 'object' ? body.queryConfig : undefined;
    const candidates = [body, cfg, body.query, cfg?.query, qc, qc?.query];
    const stringQuery = typeof body.query === 'string' || typeof cfg?.query === 'string' || typeof qc?.query === 'string';
    if (stringQuery || candidates.some(hasForbiddenKey)) {
      return res.status(400).json({
        error: 'SQL execution is not supported. Send a structured AST query instead (see /api-docs/developer).',
        code: 'SQL_NOT_SUPPORTED',
      });
    }
  }
  next();
};
