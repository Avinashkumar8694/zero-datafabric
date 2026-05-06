import { pool } from './config/database';

async function check() {
    try {
        const { rows } = await pool.query('SELECT username FROM public.users');
        if (rows.length > 0) {
            const uname = rows[0].username;
            console.log(`Username: [${uname}]`);
            console.log(`Length: ${uname.length}`);
            console.log(`Starts with quote? ${uname.startsWith("'")}`);
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
