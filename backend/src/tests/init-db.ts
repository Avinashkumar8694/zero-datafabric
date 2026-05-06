import { pool } from '../config/database';
import fs from 'fs';
import path from 'path';

async function initDb() {
  const initDir = path.join(__dirname, '../../../db/init');
  const files = fs.readdirSync(initDir).sort();

  console.log('--- INITIALIZING DATABASE ---');
  
  for (const file of files) {
    if (file.endsWith('.sql') && file !== '05-ai-setup.sql') {
      console.log(`Executing ${file}...`);
      const sql = fs.readFileSync(path.join(initDir, file), 'utf8');
      try {
        await pool.query(sql);
        console.log(`SUCCESS: ${file}`);
      } catch (err: any) {
        console.error(`FAILED: ${file}`);
        console.error(err.message);
      }
    }
  }
  
  console.log('--- DATABASE INITIALIZATION COMPLETED ---');
  process.exit(0);
}

initDb();
