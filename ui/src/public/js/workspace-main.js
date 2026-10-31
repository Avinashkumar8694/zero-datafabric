/* /settings: loads the active workspace, wires the tabs and renders the Overview tab.
   Other tabs register themselves with WS.register(name, { render(ctx) }) from workspace-*.js. */
(function () {
    const { esc, $ } = DF;
    const PLAN_SOURCES = { workspace: 'Assigned to this workspace', default: 'Default plan', subscription: 'From your subscription', licence: 'Set by the installed licence', builtin: 'Built-in trial limits' };
    const ROLES = {
        platform_admin: ['Platform admin', 'You can view and change every workspace.'],
        owner: ['Owner', 'You can change settings, plan and tokens for this workspace.'],
        member: ['Member', 'You can use the workspace and manage your own developer tokens. Settings are read-only.']
    };

    const WS = {
        data: null, role: 'member', canEdit: false, canEditSettings: false,
        mods: {}, rendered: {},
        register(name, mod) { WS.mods[name] = mod; },
        async load() {
            WS.data = await DF.api('/workspace');
            WS.role = WS.data.role || 'member';
            WS.canEdit = WS.role === 'owner' || WS.role === 'platform_admin';
            const f = WS.data.features || {};
            WS.canEditSettings = WS.canEdit && f.workspace_settings_enabled !== false;
        },
        /** Refetch the workspace and refresh header + overview (modules keep their own state). */
        async reload() { await WS.load(); renderHeader(); renderOverview(); },
        readonlyNote() {
            if (WS.canEditSettings) return '';
            const why = !WS.canEdit ? 'Only the workspace owner or a platform admin can change these settings.' : 'Workspace settings are not included in your current plan or licence.';
            return `<div class="ws-readonly" role="note"><i class="fas fa-lock" aria-hidden="true"></i><span>${esc(why)} You can view the current values.</span></div>`;
        },
        async start() {
            const tabsApi = DF.tabs({
                def: 'overview',
                onFirst: (name) => {
                    if (!WS.data) return;
                    const m = WS.mods[name];
                    if (m && !WS.rendered[name]) { WS.rendered[name] = true; Promise.resolve(m.render(WS)).catch((e) => { const p = $(`tab-${name}`); if (p) p.innerHTML = DF.errorBox(DF.errMsg(e)); }); }
                }
            });
            $('wsOverview').innerHTML = DF.loading('Loading workspace…');
            try { await WS.load(); }
            catch (e) {
                document.querySelector('.st-tabs').hidden = true;
                document.querySelectorAll('.st-panel').forEach((p) => { p.hidden = true; });
                $('wsNotice').innerHTML = DF.errorBox(e.code === 'NO_WORKSPACE' ? 'No active workspace. Pick one in the top bar, then reload.' : DF.errMsg(e));
                return;
            }
            renderHeader();
            tabsApi.start();
            renderOverview();
        }
    };
    window.WS = WS;

    function renderHeader() {
        const d = WS.data;
        const [roleLabel] = ROLES[WS.role] || [WS.role];
        $('wsHeadBadges').innerHTML = `${DF.badge(roleLabel, WS.role === 'member' ? 'muted' : 'info')} ${DF.badge(`Plan: ${d.plan?.name || 'unknown'}`, 'info')}`;
        $('wsSubtitle').textContent = `${d.workspace.name || d.workspace.id}${d.workspace.name ? ` (${d.workspace.id})` : ''}`;
    }

    function renderOverview() {
        const d = WS.data, w = d.workspace, t = d.trial || {}, lic = d.licence || {};
        const [roleLabel, roleText] = ROLES[WS.role] || [WS.role, ''];
        const left = DF.daysLeft(t.endsAt);
        let trialValue, trialSub;
        if (t.endsAt) {
            trialValue = t.expired ? 'Expired' : (left !== null ? `${left} day${left === 1 ? '' : 's'} left` : DF.day(t.endsAt));
            trialSub = `${t.expired ? 'Ended' : 'Ends'} ${DF.date(t.endsAt)}`;
        } else { trialValue = 'No end date'; trialSub = 'This plan does not expire'; }
        const features = Object.entries(d.features || {}).filter(([, v]) => typeof v === 'boolean');
        const banners = [];
        if (w.status && String(w.status).toUpperCase() === 'SUSPENDED') banners.push(`<div class="wk-banner err" role="alert"><i class="fas fa-ban" aria-hidden="true"></i><div><strong>This workspace is suspended.</strong> Contact your platform administrator.</div></div>`);
        if (t.expired) banners.push(`<div class="wk-banner err" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><div><strong>The plan period has ended.</strong> Pick a plan in <a href="#plan">Plan &amp; usage</a> or contact us to continue.</div></div>`);
        if (lic.status && !['valid', 'none'].includes(lic.status)) banners.push(`<div class="wk-banner warn" role="status"><i class="fas fa-key" aria-hidden="true"></i><div>The installed licence is <strong>${esc(String(lic.status).replace(/_/g, ' '))}</strong>, so trial limits apply until a platform admin fixes it.</div></div>`);
        $('wsOverview').innerHTML = `${banners.join('')}
            <div class="ws-stats">
                <div class="ws-stat"><span class="ws-stat-label">Workspace</span><span class="ws-stat-value">${esc(w.name || w.id)}</span>
                    <span class="ws-stat-sub">${DF.badge(w.status || 'ACTIVE')} <span class="ws-mono">${esc(w.id)}</span></span></div>
                <div class="ws-stat"><span class="ws-stat-label">Your role</span><span class="ws-stat-value">${esc(roleLabel)}</span><span class="ws-stat-sub">${esc(roleText)}</span></div>
                <div class="ws-stat"><span class="ws-stat-label">Plan</span><span class="ws-stat-value">${esc(d.plan?.name || '—')}</span><span class="ws-stat-sub">${esc(PLAN_SOURCES[d.plan?.source] || d.plan?.source || '')}</span></div>
                <div class="ws-stat"><span class="ws-stat-label">Plan period</span><span class="ws-stat-value">${esc(trialValue)}</span><span class="ws-stat-sub">${esc(trialSub)}</span></div>
                <div class="ws-stat"><span class="ws-stat-label">Licence</span><span class="ws-stat-value">${DF.badge(lic.status || 'none')}</span>
                    <span class="ws-stat-sub">${lic.licensee ? esc(lic.licensee) : 'No licensee'}${lic.selfHosted ? ' · self-hosted' : ''}${lic.expiresAt ? ` · expires ${esc(DF.day(lic.expiresAt))}` : ''}</span></div>
            </div>
            <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-circle-info" aria-hidden="true"></i> Details</h3></div>
                <dl class="ws-kv">
                    <dt>Workspace ID</dt><dd class="ws-mono">${esc(w.id)}</dd>
                    <dt>Owner user ID</dt><dd class="ws-mono">${esc(w.ownerUserId || '—')}</dd>
                    <dt>Created</dt><dd>${esc(DF.date(w.createdAt))}</dd>
                    <dt>Plan period start</dt><dd>${esc(DF.date(t.startedAt))}</dd>
                </dl></div>
            <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-toggle-on" aria-hidden="true"></i> Included features</h3></div>
                ${features.length ? `<div class="ws-feat">${features.map(([k, v]) => `<span class="${v ? 'on' : 'off'}"><i class="fas ${v ? 'fa-check' : 'fa-xmark'}" aria-hidden="true"></i>${esc((DF.FEATURES.find((f) => f[0] === k) || [k, k.replace(/_/g, ' ')])[1])}</span>`).join('')}</div>`
                    : DF.empty('Every feature is included.')}
            </div>`;
    }
})();
