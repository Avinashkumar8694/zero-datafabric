import request from 'supertest';
import { app } from '../../index';
import { getAdminToken } from './test_helper';

describe('Metadata: Industrial Template Validation', () => {
    it('Success: Return the Definitive Orchestration Specification', async () => {
        const token = await getAdminToken();
        const res = await request(app)
            .get('/api/metadata/template')
            .set('Authorization', `Bearer ${token}`);
        
        expect(res.status).toBe(200);
        expect(res.body.version).toBe("10.0");
        expect(res.body).toHaveProperty('description');
        
        // Check for essential structural blocks
        expect(res.body.schemas).toBeDefined();
        const coreSchema = res.body.schemas.find((s: any) => s.name === 'enterprise_core');
        expect(coreSchema).toBeDefined();
        
        // Verify sequences are included
        expect(coreSchema.sequences).toBeDefined();
        expect(coreSchema.sequences[0].name).toBe('global_tx_seq');

        // Verify tables and columns
        const usersTable = coreSchema.tables.find((t: any) => t.name === 'users');
        expect(usersTable).toBeDefined();
        expect(usersTable.columns.length).toBeGreaterThan(0);
        
        // Verify indexes
        expect(usersTable.indexes).toBeDefined();
    });
});
