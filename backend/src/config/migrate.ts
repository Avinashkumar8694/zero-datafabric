import fs from 'fs';
import path from 'path';
import { pool } from './database';
import dotenv from 'dotenv';

dotenv.config();

const migrate = async () => {
    const initDir = path.join(__dirname, '../../../db/init');
    const files = fs.readdirSync(initDir).filter(f => f.endsWith('.sql')).sort();

    console.log('--- Industrial Migration Started ---');
    
    // Industrial Hardening: Persistent Connection for Migration
    const client = await pool.connect();
    
    try {
        for (const file of files) {
            console.log(`[Migrating] ${file}...`);
            const sql = fs.readFileSync(path.join(initDir, file), 'utf8');
            
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
                console.log(`[Success] ${file}`);
            } catch (err: any) {
                await client.query('ROLLBACK');
                console.error(`[CRITICAL ERROR] ${file}: ${err.message}`);
                // In industrial environments, we halt on failure to prevent corrupted state
                process.exit(1);
            }
        }
        console.log('--- Industrial Migration Completed Successfully ---');
    } finally {
        client.release();
        process.exit(0);
    }
};

migrate();
