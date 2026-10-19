/* /system: Login & SSO tab. Moved from the old settings page; same endpoints and behaviour (self-host plan unlocks editing). */
(function () {
    const $ = (id) => document.getElementById(id);
    let isSelfHost = false;

    async function loadSettings() {
        try {
            // 1. Verify self-host subscription plan status
            const subRes = await fetch(`${API_BASE}/subscriptions/me`, { headers: getAuthHeaders() });
            const sub = await subRes.json();
            const badge = $('planBadge');

            if (sub && sub.plan_name === 'selfhost') {
                isSelfHost = true;
                badge.innerText = 'Self-Host Plan';
                badge.className = 'badge ws-badge-ok';
                $('selfhostAlertBanner').style.display = 'none';
            } else {
                isSelfHost = false;
                badge.innerText = 'Trial Plan';
                badge.className = 'badge ws-badge-danger';
                $('selfhostAlertBanner').style.display = 'flex';

                // Disable inputs if not self-host
                document.querySelectorAll('#settingsForm input, #settingsForm button[type="submit"]').forEach((input) => {
                    input.disabled = true;
                    input.style.opacity = '0.5';
                    input.style.cursor = 'not-allowed';
                });
            }

            // 2. Fetch custom settings values
            const endpoint = isSelfHost ? `${API_BASE}/settings/login/raw` : `${API_BASE}/settings/login`;
            const settingsRes = await fetch(endpoint, { headers: getAuthHeaders() });
            const data = await settingsRes.json();

            if (data) {
                $('loginTitle').value = data.title || '';
                $('loginBgColor').value = data.bg_color || '#04060f';
                $('loginLogoUrl').value = data.logo_url || '';
                $('allowPasswordLogin').checked = data.allow_password_login !== false;
                $('ssoEnabled').checked = data.sso_enabled !== false;
                $('oidcIssuer').value = data.oidc_issuer || '';
                $('oidcClientId').value = data.oidc_client_id || '';
                if (data.oidc_client_secret) $('oidcClientSecret').value = data.oidc_client_secret;
            }
        } catch (err) {
            console.error('[Settings] Load failed:', err);
            alert('Could not load portal settings configuration.');
        }
    }

    function init() {
        $('loginReset').onclick = () => { loadSettings(); };
        $('settingsForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!isSelfHost) return;

            const payload = {
                title: $('loginTitle').value,
                bg_color: $('loginBgColor').value,
                logo_url: $('loginLogoUrl').value,
                allow_password_login: $('allowPasswordLogin').checked,
                sso_enabled: $('ssoEnabled').checked,
                oidc_issuer: $('oidcIssuer').value,
                oidc_client_id: $('oidcClientId').value,
                oidc_client_secret: $('oidcClientSecret').value
            };

            const saveBtn = $('saveBtn');
            try {
                saveBtn.disabled = true;
                saveBtn.innerText = 'Saving...';
                const res = await fetch(`${API_BASE}/settings/login`, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(payload) });
                if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed to save settings'); }
                alert('System settings updated successfully!');
            } catch (err) {
                alert('Error updating settings: ' + err.message);
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerText = 'Save Configuration';
            }
        });
        return loadSettings();
    }

    SYS.register('login', { render: init });
})();
