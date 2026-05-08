import request from 'supertest';
import { app } from '../../index';

describe('POST /api/auth/login', () => {
    it('Success: Valid credentials should return JWT', async () => {
        const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
    });

    it('Failure: Invalid password should return 401', async () => {
        await request(app).post('/api/auth/login').send({ username: 'admin', password: 'wrong' }).expect(401);
    });

    it('Failure: Non-existent user should return 401', async () => {
        await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'password' }).expect(401);
    });

    it('Failure: Empty payload should return 401', async () => {
        await request(app).post('/api/auth/login').send({}).expect(401);
    });
});
