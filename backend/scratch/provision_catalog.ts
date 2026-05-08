import { pool } from '../src/config/database';

async function provisionCatalog() {
    console.log('--- Industrial Catalog Provisioning ---');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Ensure schemas table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.catalog_schemas (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                source_id UUID REFERENCES public.data_sources(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                physical_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source_id, physical_name)
            );
        `);

        // 2. Ensure tables table exists (replacing old catalog structure)
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.catalog_tables (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                schema_id UUID REFERENCES public.catalog_schemas(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                physical_name TEXT NOT NULL,
                row_count BIGINT DEFAULT 0,
                last_crawled_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(schema_id, physical_name)
            );
        `);

        // 3. Update data_sources to include a robust type system if missing
        // (Assuming data_sources already exists from previous modules)
        
        await client.query('COMMIT');
        console.log('Catalog Registry Provisioned Successfully.');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error('Provisioning Failed:', err.message);
    } finally {
        client.release();
        process.exit();
    }
}

provisionCatalog();
