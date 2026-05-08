import { pool } from '../src/config/database';

async function inspect() {
    console.log('--- Catalog Inspection ---');
    const schemas = await pool.query('SELECT * FROM public.catalog_schemas');
    console.log('Schemas:', JSON.stringify(schemas.rows, null, 2));
    
    const tables = await pool.query('SELECT * FROM public.catalog_tables');
    console.log('Tables:', JSON.stringify(tables.rows, null, 2));
    
    process.exit();
}

inspect();
