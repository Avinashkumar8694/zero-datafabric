import { QueryEngineService } from './query-engine.service';

// Mock the database pool
jest.mock('../../config/database', () => ({
  pool: {
    connect: jest.fn(),
    query: jest.fn()
  },
  queryWithContext: jest.fn()
}));

import { queryWithContext } from '../../config/database';

describe('QueryEngineService (Industrial Safety Shield)', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Safety Shield (SELECT)', () => {
    it('should block unrestricted SELECT (no filter, no limit)', async () => {
      const config: any = { type: 'SELECT', table: 'users', select: ['*'] };
      await expect(QueryEngineService.executeQuery('demo', config))
        .rejects.toThrow('INDUSTRIAL SAFETY: Unrestricted operations (No LIMIT or WHERE) are blocked to prevent resource exhaustion.');
    });

    it('should allow aggregate SELECT without filter or limit', async () => {
      (queryWithContext as jest.Mock).mockResolvedValue({ rows: [] });
      const config: any = { type: 'SELECT', table: 'users', select: ['count(*)'] };
      await QueryEngineService.executeQuery('demo', config);
      expect(queryWithContext).toHaveBeenCalled();
    });

    it('should allow SELECT with limit', async () => {
      (queryWithContext as jest.Mock).mockResolvedValue({ rows: [] });
      const config: any = { type: 'SELECT', table: 'users', select: ['*'], limit: 10 };
      await QueryEngineService.executeQuery('demo', config);
      expect(queryWithContext).toHaveBeenCalled();
    });
  });

  describe('Safety Shield (DML)', () => {
    it('should block DELETE without filter', async () => {
      const config: any = { type: 'DELETE', table: 'users' };
      await expect(QueryEngineService.executeQuery('demo', config))
        .rejects.toThrow('INDUSTRIAL SAFETY: Unrestricted operations (No LIMIT or WHERE) are blocked to prevent resource exhaustion.');
    });

    it('should allow DELETE with filter', async () => {
      (queryWithContext as jest.Mock).mockResolvedValue({ rows: [] });
      const config: any = { type: 'DELETE', table: 'users', filter: { id: 1 } };
      await QueryEngineService.executeQuery('demo', config);
      expect(queryWithContext).toHaveBeenCalled();
    });
  });

  describe('Filter Operators', () => {
     it('should correctly parse $gt and $like operators', async () => {
       let capturedSql = '';
       let capturedParams: any[] = [];

       (queryWithContext as jest.Mock).mockImplementation((sql, params) => {
            capturedSql = sql;
            capturedParams = params;
            return { rows: [] };
       });

      const config: any = { 
        type: 'SELECT', 
        table: 'users', 
        select: ['*'], 
        filter: { 
            age: { '$gt': 18 },
            email: { '$like': '%@zero.io' }
        } 
      };

      await QueryEngineService.executeQuery('demo', config);

      expect(capturedSql).toContain('"age" > $1');
      expect(capturedSql).toContain('"email" ILIKE $2');
      expect(capturedParams).toEqual([18, '%@zero.io']);
     });
  });
});
