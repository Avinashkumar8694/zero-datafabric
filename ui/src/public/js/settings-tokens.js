/* Developer tokens tab: mint, list and revoke scoped API tokens. */
(function () {
    const $ = (id) => document.getElementById(id);
    const esc = (v) => escapeHtml(v);
    const fmt = (d) => d ? new Date(d).toLocaleString() : '—';
    async function api(path, opts) {
        const res = await fetch(`${API_BASE}/developer/tokens${path}`, Object.assign({ headers: getAuthHeaders() }, opts || {}));
        if (res.status === 204) return null;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        return body;
    }
    function state(t) { return t.revokedAt ? 'Revoked' : (t.expiresAt && new Date(t.expiresAt) <= new Date()) ? 'Expired' : 'Active'; }
    async function load() {
        const rows = await api('');
        $('tkRows').innerHTML = rows.length ? rows.map(t => {
            const s = state(t);
            return `<tr><td>${esc(t.name)}</td><td><code>dft_${esc(t.prefix)}_…</code></td><td style="font-size:.78rem">${esc((t.scopes || []).join(', '))}</td><td>${esc(fmt(t.expiresAt))}</td><td>${esc(fmt(t.lastUsedAt))}</td>
                <td><span class="badge wk-st-${s === 'Active' ? 'ACTIVE' : 'DOWN'}">${s}</span></td>
                <td>${s === 'Active' ? `<button class="btn-outline" data-revoke="${esc(t.id)}">Revoke</button>` : ''}</td></tr>`;
        }).join('') : `<tr><td colspan="7" style="color:var(--text-muted)">No tokens yet.</td></tr>`;
    }
    async function init() {
        const origin = API_BASE.replace(/\/api$/, '');
        $('tkDocsDev').href = `${origin}/api-docs/developer`;
        try {
            const { scopes } = await api('/scopes');
            $('tkScopes').innerHTML = scopes.map(s => `<label><input type="checkbox" value="${esc(s)}" ${s.endsWith(':read') ? 'checked' : ''}/> ${esc(s)}</label>`).join('');
        } catch (e) { $('tkScopes').textContent = e.message; }
        $('tkForm').onsubmit = async (ev) => {
            ev.preventDefault();
            const scopes = [...$('tkScopes').querySelectorAll('input:checked')].map(i => i.value);
            try {
                const r = await api('', { method: 'POST', body: JSON.stringify({ name: $('tkName').value.trim(), scopes, expiresInDays: Number($('tkDays').value) }) });
                $('tkSecret').textContent = r.token; $('tkReveal').hidden = false; $('tkForm').reset(); await load();
            } catch (e) { alert(e.message); }
        };
        $('tkCopy').onclick = async () => { try { await navigator.clipboard.writeText($('tkSecret').textContent); $('tkCopy').textContent = 'Copied'; setTimeout(() => $('tkCopy').textContent = 'Copy', 1500); } catch { /* clipboard unavailable */ } };
        $('tkRows').addEventListener('click', async (e) => {
            const b = e.target.closest('button[data-revoke]'); if (!b) return;
            if (confirm('Revoke this token? Applications using it will stop working immediately.')) { try { await api(`/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE' }); await load(); } catch (er) { alert(er.message); } }
        });
        load().catch(e => { $('tkRows').innerHTML = `<tr><td colspan="7">${esc(e.message)}</td></tr>`; });
    }
    window.TokensTab = { init };
})();
