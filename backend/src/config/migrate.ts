import fs from 'fs';
import path from 'path';
import { pool } from './database';
import dotenv from 'dotenv';

/**
 * Standalone migration runner script — applies every `.sql` file in
 * `db/init` (sorted lexically, so files are conventionally numbered) against
 * the configured database, in order, each inside its own transaction.
 * Intended to be run directly (e.g. `node migrate.js`), not imported: it
 * calls (@link migrate) and exits the process on completion or failure.
 */

dotenv.config();

/**
 * Run every `.sql` migration file found in `db/init`, in filename-sorted
 * order, each wrapped in its own `BEGIN`/`COMMIT` transaction on a single
 * persistent connection. On any file's failure, that file's transaction is
 * rolled back and the process halts immediately (`process.exit(1)`) to avoid
 * continuing on top of a partially-migrated, potentially inconsistent schema.
 * On full success, exits with code 0.
 * @returns Never resolves normally in practice — the process exits (0 on
 *   success, 1 on the first migration failure) rather than returning control to a caller.
 */
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
