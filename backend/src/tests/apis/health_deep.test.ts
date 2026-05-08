import request from 'supertest';
import { app } from '../../index';

describe('GET /api/health', () => {
    it('Success: Return deep system health and DB latency', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('database');
        expect(res.body.database).toHaveProperty('latency');
    });
});
