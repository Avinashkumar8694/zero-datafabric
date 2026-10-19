/* /system: Licence tab. Status, limits/features, install / remove / re-validate. The key itself is never shown. */
(function () {
    const { esc, $ } = DF;

    const EXPLAIN = {
        none: ['No licence is installed', 'Workspaces run on their plan limits (trial limits by default). Paste a licence key below to activate a licence.', 'muted'],
        valid: ['The licence is valid', 'Its limits are a hard ceiling for every workspace and its features apply platform-wide.', 'ok'],
        invalid: ['The licence key is not valid', 'The signature check failed or the key is malformed. Workspaces fall back to trial limits until a valid key is installed.', 'err'],
        expired: ['The licence has expired', 'Workspaces fall back to trial limits. Install a renewed key to restore the licensed limits.', 'err'],
        wrong_instance: ['The licence belongs to a different installation', 'This key is bound to another instance ID. Ask the portal to re-issue it for the instance ID shown below.', 'err'],
        revoked: ['The licence was revoked', 'The licensing portal rejected this key. Workspaces fall back to trial limits.', 'err']
    };
    let st = null;

    function limitsTable(l) {
        const rows = DF.LIMITS.filter(([k]) => l && k in l).map(([k, label]) => `<tr><td>${esc(label)}</td><td class="ws-mono">${esc(k)}</td><td>${esc(DF.limit(l[k]))}</td></tr>`).join('');
        return rows ? `<div class="table-wrapper"><table class="ws-table-limits"><thead><tr><th>Limit</th><th>Key</th><th>Ceiling</th></tr></thead><tbody>${rows}</tbody></table></div>` : DF.empty('The licence sets no limits (everything is unlimited at licence level).');
    }

    function view() {
        const s = st, ex = EXPLAIN[s.status] || [String(s.status), s.error || '', 'muted'];
        const left = DF.daysLeft(s.expiresAt);
        const feats = s.features ? Object.entries(s.features).filter(([, v]) => typeof v === 'boolean') : [];
        const v = s.validation;
        $('sysLicence').innerHTML = `
        <div class="wk-banner ${ex[2] === 'ok' ? 'ok' : ex[2] === 'err' ? 'err' : ''}" role="status"><i class="fas ${ex[2] === 'ok' ? 'fa-circle-check' : ex[2] === 'err' ? 'fa-triangle-exclamation' : 'fa-circle-info'}" aria-hidden="true"></i>
            <div><strong>${esc(ex[0])}.</strong> ${esc(ex[1])}${s.error ? `<br><span class="ws-small">${esc(s.error)}</span>` : ''}</div></div>
        <div class="ws-stats">
            <div class="ws-stat"><span class="ws-stat-label">Status</span><span class="ws-stat-value">${DF.badge(s.status)}</span><span class="ws-stat-sub">${s.source ? `Source: ${esc(s.source)}` : 'No key installed'}</span></div>
            <div class="ws-stat"><span class="ws-stat-label">Licensee</span><span class="ws-stat-value">${esc(s.licensee || '—')}</span><span class="ws-stat-sub">${esc([s.product, s.name].filter(Boolean).join(' · ') || 'No product')}</span></div>
            <div class="ws-stat"><span class="ws-stat-label">Expires</span><span class="ws-stat-value">${esc(s.expiresAt ? DF.day(s.expiresAt) : '—')}</span><span class="ws-stat-sub">${left === null ? 'No expiry date' : (left < 0 ? `${-left} days ago` : `${left} day${left === 1 ? '' : 's'} left`)}</span></div>
            <div class="ws-stat"><span class="ws-stat-label">Mode</span><span class="ws-stat-value">${s.selfHosted ? 'Self-hosted' : 'Hosted'}</span><span class="ws-stat-sub">${s.maxInstallations ? `Up to ${esc(s.maxInstallations)} installations` : 'No installation cap'}</span></div>
        </div>
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-fingerprint" aria-hidden="true"></i> This installation</h3></div>
            <dl class="ws-kv">
                <dt>Instance ID</dt><dd><span class="ws-mono" id="licInstance">${esc(s.instanceId || 'unknown')}</span> <button type="button" class="btn-outline ws-btn-sm" id="licCopy">Copy</button></dd>
                <dt>Bound instance</dt><dd class="ws-mono">${esc(s.boundInstanceId || 'not bound')}</dd>
                <dt>Issued</dt><dd>${esc(DF.date(s.issuedAt))}</dd>
                <dt>Schema version</dt><dd>${esc(s.schemaVersion ?? '—')}</dd>
                <dt>Portal validation</dt><dd>${v ? `${DF.badge(v.status || 'unknown')} <span class="ws-small ws-muted">last success ${esc(DF.date(v.lastSuccessAt))}${v.errorMessage ? ` · ${esc(v.errorMessage)}` : ''}</span>` : '<span class="ws-muted">Not used</span>'}</dd>
            </dl></div>
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-key" aria-hidden="true"></i> Licence key</h3></div>
            <form id="licForm" novalidate>
                <div class="ws-form-grid">${DF.field({ id: 'licKey', label: s.status === 'none' ? 'Paste licence key' : 'Replace licence key', type: 'textarea', rows: 5, full: true, placeholder: 'Paste the key issued by the licensing portal', hint: 'The key is verified on install and is never displayed again.' })}</div>
                <div class="ws-inline-err" id="licErr" role="alert" hidden></div>
                <div class="ws-actions">
                    <button type="button" class="btn-outline ws-btn-danger" id="licRemove" ${s.status === 'none' ? 'disabled' : ''}><i class="fas fa-trash" aria-hidden="true"></i> Remove</button>
                    <button type="button" class="btn-outline" id="licValidate" ${s.status === 'none' ? 'disabled' : ''}><i class="fas fa-rotate" aria-hidden="true"></i> Re-validate</button>
                    <button type="submit" class="btn-primary"><i class="fas fa-circle-check" aria-hidden="true"></i> ${s.status === 'none' ? 'Install' : 'Replace'} key</button>
                </div></form></div>
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-ruler-combined" aria-hidden="true"></i> Limits set by the licence</h3></div>
            ${s.status === 'valid' ? limitsTable(s.limits) : `<p class="ws-muted ws-small">${s.status === 'none' ? 'No licence, so there is no licence ceiling.' : 'Limits are not applied because the licence is not valid.'}</p>`}</div>
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-toggle-on" aria-hidden="true"></i> Features set by the licence</h3></div>
            ${s.status === 'valid' && feats.length ? `<div class="ws-feat">${feats.map(([k, on]) => `<span class="${on ? 'on' : 'off'}"><i class="fas ${on ? 'fa-check' : 'fa-xmark'}" aria-hidden="true"></i>${esc((DF.FEATURES.find((x) => x[0] === k) || [k, k.replace(/_/g, ' ')])[1])}</span>`).join('')}</div>`
                : `<p class="ws-muted ws-small">${s.status === 'valid' ? 'The licence does not restrict any feature.' : 'No licence features apply.'}</p>`}</div>`;

        $('licCopy').onclick = async () => { try { await navigator.clipboard.writeText(s.instanceId || ''); DF.toast('Instance ID copied', 'ok'); } catch (e) { DF.toast('Copy failed. Select the ID and copy it manually.', 'err'); } };
        $('licForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const key = $('licKey').value.trim(), err = $('licErr'), btn = e.target.querySelector('[type="submit"]'); err.hidden = true;
            if (!key) { err.textContent = 'Paste a licence key first.'; err.hidden = false; return; }
            if (s.status !== 'none' && !(await DF.confirm({ title: 'Replace the installed licence?', message: 'The current key is replaced immediately. Workspaces are re-evaluated against the new limits.', confirmText: 'Replace key' }))) return;
            DF.busy(btn, true, 'Verifying…');
            try { await DF.api('/system/license', { method: 'POST', json: { licenseKey: key } }); DF.toast('Licence installed', 'ok'); await load(); }
            catch (er) { err.textContent = DF.errMsg(er); err.hidden = false; DF.busy(btn, false); }
        });
        $('licRemove').onclick = async (e) => {
            if (!(await DF.confirm({ title: 'Remove the licence?', message: ['Licensed limits and features stop applying and workspaces fall back to their plan limits.', 'You can install the key again later.'], confirmText: 'Remove licence', danger: true }))) return;
            DF.busy(e.currentTarget, true);
            try { await DF.api('/system/license', { method: 'DELETE' }); DF.toast('Licence removed', 'ok'); await load(); }
            catch (er) { DF.toast(DF.errMsg(er), 'err'); DF.busy(e.currentTarget, false); }
        };
        $('licValidate').onclick = async (e) => {
            DF.busy(e.currentTarget, true, 'Validating…');
            try { await DF.api('/system/license/validate', { method: 'POST', json: {} }); DF.toast('Licence re-validated', 'ok'); await load(); }
            catch (er) { DF.toast(DF.errMsg(er), 'err'); DF.busy(e.currentTarget, false); }
        };
    }

    async function load() {
        if (!st) $('sysLicence').innerHTML = DF.loading('Loading licence…');
        try { st = await DF.api('/system/license'); } catch (e) { $('sysLicence').innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        view();
    }

    SYS.register('licence', { render: load, refresh: load });
})();
