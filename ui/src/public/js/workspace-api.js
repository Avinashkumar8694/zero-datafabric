/* /settings: API tab. Token policy (allowDeveloperTokens, maxTokenDays, allowedScopes) plus the existing developer tokens table. */
(function () {
    const { esc, $ } = DF;
    let ws = null, allScopes = [];

    const policy = () => ((ws.data.settings || {}).api) || {};

    /** Make the token form follow the workspace policy (never offer what the server would refuse). */
    function applyTokenPolicy() {
        const p = policy();
        const form = $('tkForm'); if (!form) return;
        const off = p.allowDeveloperTokens === false;
        $('tkPolicyOff').hidden = !off;
        form.querySelectorAll('input, button').forEach((el) => { el.disabled = off; });
        const days = $('tkDays');
        if (p.maxTokenDays) { days.max = String(p.maxTokenDays); if (Number(days.value) > p.maxTokenDays) days.value = String(p.maxTokenDays); }
        const allowed = Array.isArray(p.allowedScopes) ? p.allowedScopes : null;
        $('tkScopes').querySelectorAll('label').forEach((lab) => {
            const input = lab.querySelector('input'); if (!input) return;
            const ok = !allowed || allowed.includes(input.value);
            lab.style.display = ok ? '' : 'none';
            if (!ok) { input.checked = false; input.disabled = true; } else if (!off) input.disabled = false;
        });
    }

    function collect() {
        const body = {};
        const cur = policy();
        const allow = $('apiAllowTokens').checked;
        if (allow !== (cur.allowDeveloperTokens !== false)) body.allowDeveloperTokens = allow;
        const days = $('apiMaxDays').value;
        if (days !== '' && Number(days) !== cur.maxTokenDays) body.maxTokenDays = Number(days);
        const scopes = [...$('apiScopes').querySelectorAll('input:checked')].map((i) => i.value);
        const prev = Array.isArray(cur.allowedScopes) ? cur.allowedScopes : allScopes;
        if (JSON.stringify([...scopes].sort()) !== JSON.stringify([...prev].sort())) body.allowedScopes = scopes;
        return body;
    }

    function renderPolicy() {
        const p = policy(), dis = !ws.canEditSettings;
        const checked = Array.isArray(p.allowedScopes) ? p.allowedScopes : allScopes;
        $('apiPolicy').innerHTML = `<form class="ws-card" id="apiForm" novalidate>
            <div class="ws-card-head"><h3><i class="fas fa-sliders" aria-hidden="true"></i> Token policy</h3></div>
            <p class="ws-card-desc">Controls which developer tokens can be created for this workspace.</p>
            <div class="ws-form-grid">
                ${DF.field({ id: 'apiAllowTokens', label: 'Allow developer tokens', type: 'checkbox', value: p.allowDeveloperTokens !== false, disabled: dis, hint: 'When off, nobody can create new tokens here.' })}
                ${DF.field({ id: 'apiMaxDays', label: 'Maximum token lifetime (days)', type: 'number', min: 1, max: 365, value: p.maxTokenDays, placeholder: 'System default', disabled: dis, hint: '1 to 365. The platform maximum still applies.' })}
            </div>
            <div class="ws-section-label">Allowed scopes</div>
            <div class="ws-checks" id="apiScopes">${allScopes.length ? allScopes.map((s) => `<label class="ws-check"><input type="checkbox" value="${esc(s)}" ${checked.includes(s) ? 'checked' : ''} ${dis ? 'disabled' : ''}><span>${esc(s)}</span></label>`).join('') : '<span class="ws-muted ws-small">Scopes could not be loaded.</span>'}</div>
            <span class="ws-hint">Tokens in this workspace can only carry the selected scopes.</span>
            <div class="ws-inline-err" id="apiErr" role="alert" hidden></div>
            ${dis ? '' : '<div class="ws-actions"><button type="button" class="btn-outline" id="apiReset">Reset</button><button type="submit" class="btn-primary">Save token policy</button></div>'}
        </form>`;
        if (dis) return;
        $('apiReset').onclick = renderPolicy;
        $('apiForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const err = $('apiErr'), btn = e.target.querySelector('[type="submit"]'); err.hidden = true;
            if (!e.target.checkValidity()) { e.target.reportValidity(); return; }
            const body = collect();
            if (!Object.keys(body).length) { DF.toast('Nothing to save: no values changed.'); return; }
            DF.busy(btn, true, 'Saving…');
            try {
                await DF.api('/workspace/settings/api', { method: 'PUT', json: body });
                ws.data.settings = await DF.api('/workspace/settings');
                DF.toast('Token policy saved', 'ok'); renderPolicy(); applyTokenPolicy();
            } catch (er) { err.textContent = DF.errMsg(er); err.hidden = false; DF.toast(DF.errMsg(er), 'err'); }
            finally { DF.busy(btn, false); }
        });
    }

    WS.register('api', {
        async render(w) {
            ws = w;
            $('apiPolicy').innerHTML = DF.loading('Loading token policy…');
            try { allScopes = (await DF.api('/developer/tokens/scopes')).scopes || []; } catch (e) { allScopes = []; }
            $('apiPolicyNote').innerHTML = w.readonlyNote();
            renderPolicy();
            await TokensTab.init();
            applyTokenPolicy();
        }
    });
})();
