import request from 'supertest';
import { app } from '../../index';

describe('GET /health', () => {
    it('Success: Return basic heartbeat status', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('UP');
    });
});
