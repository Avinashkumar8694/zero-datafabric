import { pool } from '../src/config/database';

async function secureCatalog() {
    console.log('--- Securing Catalog with RLS ---');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Enable RLS
        await client.query('ALTER TABLE public.catalog_schemas ENABLE ROW LEVEL SECURITY');
        await client.query('ALTER TABLE public.catalog_tables ENABLE ROW LEVEL SECURITY');

        // 2. Create Policies for catalog_schemas
        // A user can see schemas if they belong to a data source owned by their tenant
        await client.query(`
            DROP POLICY IF EXISTS tenant_schema_isolation ON public.catalog_schemas;
            CREATE POLICY tenant_schema_isolation ON public.catalog_schemas
            USING (source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = current_setting('app.tenant_id', true)));
        `);

        // 3. Create Policies for catalog_tables
        // A user can see tables if they belong to a schema they can see
        await client.query(`
            DROP POLICY IF EXISTS tenant_table_isolation ON public.catalog_tables;
            CREATE POLICY tenant_table_isolation ON public.catalog_tables
            USING (schema_id IN (SELECT id FROM public.catalog_schemas));
        `);

        await client.query('COMMIT');
        console.log('Catalog Security Policy Applied.');
    } catch (err: any) {
        await client.query('ROLLBACK');
        console.error('Security Application Failed:', err.message);
    } finally {
        client.release();
        process.exit();
    }
}

secureCatalog();
