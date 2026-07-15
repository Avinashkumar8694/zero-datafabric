import axios from 'axios';
import { pool } from './config/database';

const API_BASE = 'http://localhost:4000/api';

async function verifySelfHostFlow() {
    console.log('=== Programmatic Self-Host & Custom Settings Verification ===');

    try {
        // 1. Log in as admin
        console.log('1. Attempting login as admin...');
        const loginRes = await axios.post(`${API_BASE}/auth/login`, {
            username: 'admin',
            password: 'admin'
        });
        const token = loginRes.data.token;
        const headers = { Authorization: `Bearer ${token}` };
        console.log('   Login successful!');

        // Get plan IDs
        const plansRes = await axios.get(`${API_BASE}/plans`, { headers });
        const trialPlan = plansRes.data.find((p: any) => p.name === 'trial');
        const selfhostPlan = plansRes.data.find((p: any) => p.name === 'selfhost');

        if (!trialPlan || !selfhostPlan) {
            throw new Error('Could not find trial or selfhost plans in DB');
        }

        // 2. Ensure default state is Trial
        console.log('2. Resetting active subscription to Trial Plan...');
        await axios.post(`${API_BASE}/subscriptions/me`, { plan_id: trialPlan.id }, { headers });
        
        // 3. Verify public settings return selfhost: false
        console.log('3. Fetching public login settings (Trial mode)...');
        const publicSettingsTrial = await axios.get(`${API_BASE}/settings/login`);
        console.log('   selfhost status:', publicSettingsTrial.data.selfhost);
        if (publicSettingsTrial.data.selfhost !== false) {
            throw new Error('Public settings should return selfhost = false when subscribed to Trial plan');
        }

        // 4. Try updating login settings while on Trial plan (should be forbidden)
        console.log('4. Attempting to update custom login settings under Trial subscription...');
        try {
            await axios.post(`${API_BASE}/settings/login`, {
                title: "Acme trial",
                bg_color: "#123456",
                allow_password_login: true,
                sso_enabled: true
            }, { headers });
            throw new Error('Updating settings should have failed under Trial plan but it did not!');
        } catch (err: any) {
            if (err.response && err.response.status === 403) {
                console.log('   ✔ Correctly blocked with 403 Forbidden!');
            } else {
                throw new Error('Expected 403 Forbidden, got: ' + (err.response?.status || err.message));
            }
        }

        // 5. Activate Self-Host Plan
        console.log('5. Activating Self-Host Plan...');
        await axios.post(`${API_BASE}/subscriptions/me`, { plan_id: selfhostPlan.id }, { headers });

        // 6. Verify plans related configuration is now blocked
        console.log('6. Attempting to customize a plan under active Self-Host plan (should be forbidden)...');
        try {
            await axios.put(`${API_BASE}/plans/${trialPlan.id}`, {
                name: 'trial',
                price_monthly: 10,
                limits: trialPlan.limits,
                features: trialPlan.features
            }, { headers });
            throw new Error('Modifying plans should have failed under Self-Host plan but it did not!');
        } catch (err: any) {
            if (err.response && err.response.status === 403) {
                console.log('   ✔ Correctly blocked with 403 Forbidden!');
            } else {
                throw new Error('Expected 403 Forbidden, got: ' + (err.response?.status || err.message));
            }
        }

        // 7. Verify public settings return selfhost: true
        console.log('7. Fetching public login settings (Self-Host mode)...');
        const publicSettingsSelf = await axios.get(`${API_BASE}/settings/login`);
        console.log('   selfhost status:', publicSettingsSelf.data.selfhost);
        if (publicSettingsSelf.data.selfhost !== true) {
            throw new Error('Public settings should return selfhost = true when subscribed to Self-Host plan');
        }

        // 8. Update login settings under Self-Host plan
        console.log('8. Updating custom login configurations...');
        const newSettings = {
            title: "Acme Corporate Data Fabric",
            bg_color: "#080c18",
            logo_url: "https://acme.org/logo.png",
            allow_password_login: true,
            sso_enabled: false, // disable SSO for testing
            oidc_issuer: "https://acme.oidc.com",
            oidc_client_id: "acme-client",
            oidc_client_secret: "acme-secret"
        };
        const updateRes = await axios.post(`${API_BASE}/settings/login`, newSettings, { headers });
        console.log('   Settings updated successfully:', updateRes.data);

        // 9. Verify public settings reflect the custom configuration without returning the client secret
        console.log('9. Verifying public login settings contain custom values and hide secrets...');
        const finalPublic = await axios.get(`${API_BASE}/settings/login`);
        console.log('   Public values:', finalPublic.data);
        if (finalPublic.data.title !== newSettings.title || finalPublic.data.bg_color !== newSettings.bg_color) {
            throw new Error('Custom branding changes not reflected in public settings');
        }
        if (finalPublic.data.sso_enabled !== false || finalPublic.data.oidc_client_id !== 'acme-client') {
            throw new Error('SSO flags or client ID not updated correctly');
        }
        if (finalPublic.data.oidc_client_secret) {
            throw new Error('SECURITY VIOLATION: OIDC Client secret leaked in public settings response!');
        }
        console.log('   ✔ Public values look secure and correct!');

        // 10. Clean up / Restore state to Trial
        console.log('10. Restoring system back to Trial Plan...');
        // Directly bypass the self-host block by updating database subscription
        await pool.query(
            "UPDATE public.subscriptions SET plan_id = $1 WHERE user_id = '2214bdaa-c0fe-41a8-89fc-706996ba8e0f'",
            [trialPlan.id]
        );
        // Reset settings
        const defaultSettings = {
            title: "Data Fabric",
            bg_color: "#04060f",
            logo_url: "",
            allow_password_login: true,
            sso_enabled: true,
            oidc_issuer: "https://ids.fabrixly.com",
            oidc_client_id: "zero-datafabric",
            oidc_client_secret: "super-secret-key-fabric"
        };
        await pool.query("UPDATE public.settings SET value = $1 WHERE key = 'custom_login'", [JSON.stringify(defaultSettings)]);
        console.log('   ✔ System restored.');

        console.log('\n=== All Self-Host & Custom Settings Tests Passed Successfully! ===');
        process.exit(0);

    } catch (err: any) {
        console.error('\n*** Verification Failed ***');
        console.error(err.response ? err.response.data : err.message);
        process.exit(1);
    }
}

verifySelfHostFlow();
