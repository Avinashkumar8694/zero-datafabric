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
        expect(res.body.version).toBe('4.0');

        // The template is the flat v4.0 shape: a root-level `resources` list (the parser lifts it into `schemas`).
        const resources: any[] = res.body.resources;
        expect(Array.isArray(resources)).toBe(true);
        const byName = (n: string) => resources.find((r: any) => r.name === n);

        expect(byName('shipment_status').type).toBe('ENUM');
        expect(byName('tracking_seq').type).toBe('SEQUENCE');
        expect(byName('generate_custom_id').type).toBe('FUNCTION');

        const shipments = byName('shipments');
        expect(shipments.type).toBe('TABLE');
        expect(shipments.columns.length).toBeGreaterThan(0);
        expect(shipments.constraints).toBeDefined();
        expect(shipments.triggers).toBeDefined();
        expect(resources.some((r: any) => r.type === 'MATERIALIZED_VIEW')).toBe(true);
        expect(Array.isArray(res.body.relationships)).toBe(true);
    });
});
