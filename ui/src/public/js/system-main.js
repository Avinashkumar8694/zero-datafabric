/* /system: platform-admin gate, tab wiring, Overview and Settings tabs. */
(function () {
    const { esc, $ } = DF;

    function gate(message) {
        $('sysApp').hidden = true;
        $('sysGate').hidden = false;
        if (message) $('sysGateMsg').textContent = message;
    }

    // ---- Overview -------------------------------------------------------
    async function renderOverview() {
        const root = $('sysOverview');
        root.innerHTML = DF.loading('Loading platform stats…');
        let stats, reqs = null;
        try { stats = await DF.api('/system/stats'); }
        catch (e) { if (e.status === 403) { gate(); return; } root.innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        try { reqs = await DF.api('/system/plan-requests?status=open'); } catch (e) { reqs = null; }
        const byStatus = stats.workspacesByStatus || [], byPlan = stats.workspacesByPlan || [];
        const total = byStatus.reduce((a, r) => a + Number(r.n || 0), 0);
        const count = (s) => Number((byStatus.find((r) => String(r.status).toUpperCase() === s) || {}).n || 0);
        const maxPlan = Math.max(1, ...byPlan.map((r) => Number(r.n || 0)));
        const lic = stats.license || 'none';
        root.innerHTML = `<div class="ws-stats">
            <div class="ws-stat"><span class="ws-stat-label">Workspaces</span><span class="ws-stat-value">${esc(DF.num(total))}</span><span class="ws-stat-sub">${esc(count('ACTIVE'))} active · ${esc(count('SUSPENDED'))} suspended</span></div>
            <div class="ws-stat"><span class="ws-stat-label">Users</span><span class="ws-stat-value">${esc(DF.num(stats.users))}</span><span class="ws-stat-sub">Across all workspaces</span></div>
            <div class="ws-stat"><span class="ws-stat-label">Licence</span><span class="ws-stat-value">${DF.badge(lic)}</span><span class="ws-stat-sub"><a href="#licence">Manage licence</a></span></div>
            <div class="ws-stat"><span class="ws-stat-label">Open plan requests</span><span class="ws-stat-value">${reqs ? esc(reqs.length) : '—'}</span><span class="ws-stat-sub"><a href="#plans">Review requests</a></span></div>
        </div>
        ${['expired', 'invalid', 'wrong_instance', 'revoked'].includes(lic) ? `<div class="wk-banner err" role="alert"><i class="fas fa-key" aria-hidden="true"></i><div>The installed licence is <strong>${esc(lic.replace(/_/g, ' '))}</strong>. Workspaces fall back to trial limits. <a href="#licence">Fix it</a></div></div>` : ''}
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-chart-simple" aria-hidden="true"></i> Workspaces by plan</h3></div>
            ${byPlan.length ? `<div class="ws-usage">${byPlan.map((r) => `<div><div class="ws-meter-top"><b>${esc(r.plan)}</b><span class="ws-muted">${esc(r.n)} workspace${Number(r.n) === 1 ? '' : 's'}</span></div><div class="ws-bar"><i style="width:${Math.round((Number(r.n) / maxPlan) * 100)}%"></i></div></div>`).join('')}</div>` : DF.empty('No workspaces yet.')}
        </div>
        <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-chart-pie" aria-hidden="true"></i> Workspaces by status</h3></div>
            ${byStatus.length ? `<div class="ws-feat">${byStatus.map((r) => `<span>${DF.badge(r.status)} ${esc(r.n)}</span>`).join('')}</div>` : DF.empty('No workspaces yet.')}
        </div>`;
    }

    // ---- Settings -------------------------------------------------------
    const REGION = /^[A-Za-z]{2,8}$/;
    async function renderSettings() {
        const root = $('sysSettings');
        root.innerHTML = DF.loading('Loading settings…');
        let s, plans;
        try { [s, plans] = await Promise.all([DF.api('/system/settings'), SYS.plans(true)]); }
        catch (e) { root.innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        const planOpts = [{ v: '', l: 'Platform default (trial)' }].concat(plans.filter((p) => (p.status || 'active') === 'active' && !p.is_custom).map((p) => ({ v: p.name, l: p.name })));
        const f = (o) => DF.field(o);
        root.innerHTML = `<form class="ws-card" id="sysSetForm" novalidate>
            <div class="ws-card-head"><h3><i class="fas fa-gears" aria-hidden="true"></i> Platform settings</h3></div>
            <p class="ws-card-desc">Apply to every workspace on this deployment. Changes take effect within a few seconds.</p>
            <div class="ws-section-label">Plans and limits</div>
            <div class="ws-form-grid">
                ${f({ id: 'sysDefaultPlan', label: 'Default plan for new workspaces', type: 'select', options: planOpts, value: s.defaultPlan || '' })}
                ${f({ id: 'sysPlanLimits', label: 'Enforce plan limits', type: 'checkbox', value: s.planLimitsEnabled, hint: 'Off means every workspace is unlimited (the licence ceiling still applies).' })}
            </div>
            <div class="ws-section-label">Sign-up and workspaces</div>
            <div class="ws-form-grid">
                ${f({ id: 'sysSelfSignup', label: 'Allow self sign-up', type: 'checkbox', value: s.allowSelfSignup })}
                ${f({ id: 'sysWsCreate', label: 'Allow users to create workspaces', type: 'checkbox', value: s.allowWorkspaceCreation })}
                ${f({ id: 'sysMaxWs', label: 'Max workspaces per user', type: 'number', min: -1, max: 10000, value: s.maxWorkspacesPerUser, hint: '-1 means unlimited.' })}
                ${f({ id: 'sysRegion', label: 'Default region', maxlength: 8, value: s.defaultRegion, hint: '2 to 8 letters.' })}
                ${f({ id: 'sysTokenDays', label: 'Maximum developer token lifetime (days)', type: 'number', min: 1, max: 365, value: s.maxTokenDays, hint: '1 to 365. Workspaces can set a lower value.' })}
            </div>
            <div class="ws-section-label">Maintenance</div>
            <div class="ws-form-grid">
                ${f({ id: 'sysMaint', label: 'Maintenance mode', type: 'checkbox', value: s.maintenanceMode, hint: 'Blocks regular users while on.' })}
                ${f({ id: 'sysMaintMsg', label: 'Maintenance message', type: 'textarea', rows: 3, value: s.maintenanceMessage, full: true, hint: 'Up to 300 characters.' })}
            </div>
            <div class="ws-inline-err" id="sysSetErr" role="alert" hidden></div>
            <div class="ws-actions"><button type="button" class="btn-outline" id="sysSetReset">Reset</button><button type="submit" class="btn-primary">Save settings</button></div>
        </form>`;
        $('sysSetReset').onclick = renderSettings;
        $('sysSetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const err = $('sysSetErr'), btn = e.target.querySelector('[type="submit"]'); err.hidden = true;
            const next = {
                defaultPlan: $('sysDefaultPlan').value || null, planLimitsEnabled: $('sysPlanLimits').checked, allowSelfSignup: $('sysSelfSignup').checked,
                allowWorkspaceCreation: $('sysWsCreate').checked, maxWorkspacesPerUser: Number($('sysMaxWs').value), defaultRegion: $('sysRegion').value.trim(),
                maintenanceMode: $('sysMaint').checked, maintenanceMessage: $('sysMaintMsg').value.trim(), maxTokenDays: Number($('sysTokenDays').value)
            };
            const problem = !Number.isInteger(next.maxWorkspacesPerUser) || next.maxWorkspacesPerUser < -1 ? 'Max workspaces per user must be -1 or a whole number up to 10000.'
                : !REGION.test(next.defaultRegion) ? 'Default region must be 2 to 8 letters.'
                : !Number.isInteger(next.maxTokenDays) || next.maxTokenDays < 1 || next.maxTokenDays > 365 ? 'Maximum token lifetime must be between 1 and 365 days.'
                : next.maintenanceMessage.length > 300 ? 'The maintenance message can be at most 300 characters.' : '';
            if (problem) { err.textContent = problem; err.hidden = false; return; }
            const body = {};
            Object.keys(next).forEach((k) => { if (next[k] !== s[k] && !(k === 'defaultPlan' && !next[k] && !s[k])) body[k] = next[k]; });
            if (!Object.keys(body).length) { DF.toast('Nothing to save: no values changed.'); return; }
            const risky = [];
            if (body.maintenanceMode === true) risky.push('Maintenance mode blocks regular users until you switch it off again.');
            if (body.planLimitsEnabled === false) risky.push('Turning plan limits off makes every workspace unlimited.');
            if (risky.length && !(await DF.confirm({ title: 'Apply these changes?', message: risky, confirmText: 'Apply', danger: true }))) return;
            DF.busy(btn, true, 'Saving…');
            try { Object.assign(s, await DF.api('/system/settings', { method: 'PUT', json: body })); DF.toast('System settings saved', 'ok'); renderSettings(); }
            catch (er) { err.textContent = DF.errMsg(er); err.hidden = false; DF.toast(DF.errMsg(er), 'err'); }
            finally { DF.busy(btn, false); }
        });
    }

    SYS.register('overview', { render: renderOverview, refresh: renderOverview });
    SYS.register('settings', { render: renderSettings });
    // Worker nodes: the existing UI (settings-workers.js) now lives here, behaviour unchanged.
    SYS.register('workers', { render() { WorkersTab.init(); return WorkersTab.load(); } });

    SYS.start = function () {
        if (!DF.isPlatformAdmin()) { gate(); return; }
        const skip = {};
        const tabsApi = DF.tabs({
            def: 'overview',
            onFirst: (name) => {
                const m = SYS.mods[name]; skip[name] = true;
                if (m) Promise.resolve(m.render()).catch((e) => { const p = $(`tab-${name}`); if (p) p.insertAdjacentHTML('afterbegin', DF.errorBox(DF.errMsg(e))); });
            },
            // Re-showing a tab refreshes modules that opt in (the first show already rendered).
            onShow: (name) => { if (skip[name]) { skip[name] = false; return; } const m = SYS.mods[name]; if (m && m.refresh) m.refresh(); }
        });
        tabsApi.start();
    };
    SYS.gate = gate;
})();
