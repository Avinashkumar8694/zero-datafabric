import axios from 'axios';

const BASE_URL = 'http://127.0.0.1:4000/api';

async function diagnose() {
    console.log('--- Industrial Data Fabric API Diagnostic (TS) ---');
    
    try {
        // 1. Auth Check
        console.log('[1/5] Testing Authentication...');
        const authRes = await axios.post(`${BASE_URL}/auth/login`, {
            username: 'admin',
            password: 'admin'
        });
        const token = authRes.data.token;
        console.log('✅ Auth Successful (Token received)');

        const headers = { Authorization: `Bearer ${token}` };

        // 2. Tenant Registry Check
        console.log('[2/5] Testing Tenant Registry...');
        const tenantRes = await axios.get(`${BASE_URL}/admin/tenants`, { headers });
        console.log(`✅ Tenants Found: ${tenantRes.data.length}`);

        // 3. IAM Check
        console.log('[3/5] Testing Identity Directory...');
        const userRes = await axios.get(`${BASE_URL}/admin/users`, { headers });
        console.log(`✅ Users Registered: ${userRes.data.length}`);

        // 4. Query Engine Check
        console.log('[4/5] Testing Query Engine (AST -> SQL preview)...');
        const queryRes = await axios.post(`${BASE_URL}/queries/transpile`, {
            type: 'SELECT', table: 'tenants', select: ['id'], limit: 1
        }, { headers });
        console.log(`✅ Query Engine Operational`);
        console.log(`   - Transpiled SQL: ${queryRes.data.sql}`);

        // 5. Metadata Catalog Check
        console.log('[5/5] Testing Metadata Catalog...');
        const catalogRes = await axios.get(`${BASE_URL}/admin/catalog`, { headers });
        console.log(`✅ Catalog Online (Records: ${catalogRes.data.length})`);

        console.log('\n--- ALL SYSTEMS OPERATIONAL ---');
    } catch (err: any) {
        console.error('\n❌ DIAGNOSTIC FAILED');
        if (err.response) {
            console.error(`Status: ${err.response.status}`);
            console.error(`Error: ${JSON.stringify(err.response.data)}`);
        } else {
            console.error(`Error: ${err.message}`);
        }
        process.exit(1);
    }
}

diagnose();
