import { AuthService } from './modules/auth/auth.service';
import { pool } from './config/database';

async function verify() {
    console.log('--- Identity Verification Diagnostic ---');
    try {
        const username = 'admin';
        const password = 'admin';
        
        console.log(`Attempting login for: ${username}`);
        const result = await AuthService.login(username, password);
        
        if (result) {
            console.log('SUCCESS: Credentials verified.');
            console.log('Token:', result.token.substring(0, 20) + '...');
        } else {
            console.error('FAILED: Invalid credentials.');
            
            // Deep Inspection
            const { rows } = await pool.query('SELECT username, password_hash FROM public.users WHERE username = $1', [username]);
            if (rows.length === 0) {
                console.error(`ERROR: User "${username}" NOT FOUND in database.`);
            } else {
                console.log('User found in DB. Inspecting hash...');
                console.log('Hash in DB:', rows[0].password_hash);
            }
        }
        process.exit(0);
    } catch (e) {
        console.error('CRITICAL ERROR:', e);
        process.exit(1);
    }
}

verify();
