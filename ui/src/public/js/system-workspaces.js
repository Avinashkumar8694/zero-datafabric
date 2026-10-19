/* /system: Workspaces tab. Searchable, filterable, paginated table with row actions and a detail drawer. */
(function () {
    const { esc, $ } = DF;
    const PAGE = 20;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const f = { search: '', status: '', plan: '', offset: 0 };
    let rows = [], total = 0, timer = null, drawerCtl = null, seq = 0;

    // ---- list -----------------------------------------------------------
    async function load() {
        const body = $('wsTblBody'), my = ++seq;
        body.innerHTML = `<tr><td colspan="6">${DF.loading('Loading workspaces…')}</td></tr>`;
        try {
            const r = await DF.api(`/system/workspaces${DF.qs({ search: f.search.trim(), status: f.status, plan: f.plan, limit: PAGE, offset: f.offset })}`);
            if (my !== seq) return;
            rows = r.workspaces || []; total = r.total || 0;
        } catch (e) { if (my === seq) body.innerHTML = `<tr><td colspan="6">${DF.errorBox(DF.errMsg(e))}</td></tr>`; return; }
        body.innerHTML = rows.length ? rows.map((w) => `<tr>
            <td><strong>${esc(w.name || w.id)}</strong><div class="ws-mono ws-muted">${esc(w.id)}</div></td>
            <td>${DF.badge(w.status || 'ACTIVE')}</td>
            <td>${esc(w.plan || 'default')}${w.planExpiresAt ? `<div class="ws-small ws-muted">until ${esc(DF.day(w.planExpiresAt))}</div>` : ''}</td>
            <td>${esc(w.ownerUsername || '—')}</td><td>${esc(DF.day(w.createdAt))}</td>
            <td><div class="ws-row-actions">
                <button class="btn-outline ws-btn-sm" data-open="${esc(w.id)}" title="Switch to this workspace and open its settings"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Open</button>
                <button class="btn-outline ws-btn-sm" data-detail="${esc(w.id)}"><i class="fas fa-circle-info" aria-hidden="true"></i> Details</button>
                <button class="btn-outline ws-btn-sm ${String(w.status).toUpperCase() === 'SUSPENDED' ? '' : 'ws-btn-danger'}" data-toggle="${esc(w.id)}">${String(w.status).toUpperCase() === 'SUSPENDED' ? 'Activate' : 'Suspend'}</button>
            </div></td></tr>`).join('')
            : `<tr><td colspan="6" class="ws-table-note">${f.search || f.status || f.plan ? 'No workspaces match these filters.' : 'No workspaces yet.'}</td></tr>`;
        const from = total ? f.offset + 1 : 0, to = Math.min(total, f.offset + rows.length);
        $('wsPagerInfo').textContent = `${from}–${to} of ${DF.num(total)}`;
        $('wsPrev').disabled = f.offset <= 0; $('wsNext').disabled = f.offset + PAGE >= total;
    }
    const find = (id) => rows.find((w) => w.id === id);

    // ---- actions --------------------------------------------------------
    function openWorkspace(id) {
        try { localStorage.setItem('active_tenant', id); } catch (e) { /* storage blocked */ }
        window.location.href = '/settings';
    }

    async function toggleStatus(id, name, current) {
        const suspend = String(current).toUpperCase() !== 'SUSPENDED';
        const ok = await DF.confirm({
            title: suspend ? `Suspend "${name}"?` : `Activate "${name}"?`, confirmText: suspend ? 'Suspend workspace' : 'Activate workspace', danger: suspend,
            message: suspend ? 'Everyone in this workspace loses access until it is activated again. Data is kept.' : 'Members regain access immediately.'
        });
        if (!ok) return false;
        try { await DF.api(`/system/workspaces/${encodeURIComponent(id)}`, { method: 'PUT', json: { status: suspend ? 'SUSPENDED' : 'ACTIVE' } }); DF.toast(suspend ? 'Workspace suspended' : 'Workspace activated', 'ok'); return true; }
        catch (e) { DF.toast(DF.errMsg(e), 'err'); return false; }
    }

    function renameModal(id, name, done) {
        DF.modal({
            title: 'Rename workspace', confirmText: 'Rename',
            body: `<div class="ws-form-grid">${DF.field({ id: 'rnName', label: 'Name', value: name, required: true, maxlength: 100, full: true, hint: 'The workspace ID stays the same.' })}</div>`,
            onSubmit: async () => {
                const v = $('rnName').value.trim();
                if (!v) throw new Error('Name is required');
                await DF.api(`/system/workspaces/${encodeURIComponent(id)}`, { method: 'PUT', json: { name: v } });
                DF.toast('Workspace renamed', 'ok'); done();
            }
        });
    }

    async function assignModal(id, detail, done) {
        let plans;
        try { plans = await SYS.plans(); } catch (e) { DF.toast(DF.errMsg(e), 'err'); return; }
        const w = detail.workspace;
        DF.modal({
            title: 'Assign plan', size: 'lg', confirmText: 'Assign plan',
            body: `<p class="ws-muted ws-small">Replaces the current plan (<strong>${esc(w.plan_name || 'default')}</strong>) and its overrides. Overrides apply only to this workspace and cannot exceed the licence ceiling.</p>
                <div class="ws-form-grid">
                    ${DF.field({ id: 'apPlan', label: 'Plan', type: 'select', options: plans.map((p) => ({ v: p.name, l: `${p.name}${(p.status || 'active') !== 'active' ? ` (${p.status})` : ''}` })), value: w.plan_name || (plans.find((p) => p.is_default) || {}).name, required: true })}
                    ${DF.field({ id: 'apEnds', label: 'Ends on (optional)', type: 'date', value: DF.toDateInput(w.plan_expires_at), hint: 'Must be a future date. Blank means no end date.' })}
                </div>
                <div class="ws-section-label">Limit overrides <span class="ws-muted" style="text-transform:none;letter-spacing:0">(blank = use the plan value)</span></div>
                <div id="apLimits">${SYS.limitsEditor('apL', w.plan_overrides || {}, { placeholder: 'Plan value' })}</div>`,
            onOpen: (c) => SYS.bindLimitsEditor(c.body),
            onSubmit: async () => {
                const body = { plan: $('apPlan').value, overrides: SYS.readLimits($('apLimits')) };
                const ends = $('apEnds').value;
                if (ends) body.expiresAt = new Date(`${ends}T23:59:59`).toISOString();
                await DF.api(`/system/workspaces/${encodeURIComponent(id)}/plan`, { method: 'PUT', json: body });
                DF.toast('Plan assigned', 'ok'); done();
            }
        });
    }

    function extendModal(id, detail, done) {
        const end = detail.effective?.trial?.endsAt;
        DF.modal({
            title: 'Extend trial or plan period', confirmText: 'Extend',
            body: `<p class="ws-muted ws-small">Currently ${end ? `${detail.effective.trial.expired ? 'ended' : 'ends'} <strong>${esc(DF.date(end))}</strong>` : 'no end date'}. Add days from the later of now and the current end, or set an exact date.</p>
                <div class="ws-form-grid">${DF.field({ id: 'exDays', label: 'Add days', type: 'number', min: 1, max: 3650, placeholder: '14' })}${DF.field({ id: 'exUntil', label: 'Or end on', type: 'date', value: '' })}</div>`,
            onSubmit: async () => {
                const days = $('exDays').value, until = $('exUntil').value;
                if (!days && !until) throw new Error('Enter a number of days or an end date.');
                const body = days ? { days: Number(days) } : { until: new Date(`${until}T23:59:59`).toISOString() };
                if (days && (!Number.isInteger(body.days) || body.days < 1 || body.days > 3650)) throw new Error('Days must be a whole number between 1 and 3650.');
                await DF.api(`/system/workspaces/${encodeURIComponent(id)}/plan/extend`, { method: 'POST', json: body });
                DF.toast('Period extended', 'ok'); done();
            }
        });
    }

    function ownerModal(id, detail, ownerName, done) {
        DF.modal({
            title: 'Change owner', confirmText: 'Change owner',
            body: `<p class="ws-muted ws-small">Current owner: <strong>${esc(ownerName || detail.workspace.user_id || 'none')}</strong>. The new owner gets full control of this workspace and the previous owner becomes a regular member.</p>
                <div class="ws-form-grid">${DF.field({ id: 'owUser', label: 'Username or user ID', required: true, full: true, placeholder: 'jane@example.com', hint: 'The user must already exist.' })}</div>`,
            onSubmit: async () => {
                const v = $('owUser').value.trim();
                if (!v) throw new Error('Enter a username or user ID.');
                await DF.api(`/system/workspaces/${encodeURIComponent(id)}/owner`, { method: 'POST', json: UUID.test(v) ? { userId: v } : { username: v } });
                DF.toast('Owner changed', 'ok'); done();
            }
        });
    }

    // ---- drawer ---------------------------------------------------------
    async function showDetail(id) {
        if (drawerCtl) drawerCtl.close();
        drawerCtl = DF.drawer({ title: 'Workspace', body: DF.loading('Loading workspace…'), onClose: () => { drawerCtl = null; } });
        const body = drawerCtl.body;
        let d;
        try { d = await DF.api(`/system/workspaces/${encodeURIComponent(id)}`); }
        catch (e) { body.innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        const row = find(id) || {};
        const w = d.workspace, eff = d.effective || {}, usage = d.usage || {}, ov = w.plan_overrides || {}, t = eff.trial || {};
        drawerCtl.root.querySelector('h3').textContent = w.name || w.id;
        const suspended = String(w.status).toUpperCase() === 'SUSPENDED';
        const refresh = async () => { await load(); showDetail(id); };
        const limitRows = DF.LIMITS.map(([k, label]) => {
            const uk = { max_api_tokens_per_user: 'active_api_tokens' }[k] || k;
            const used = usage[uk];
            return `<tr><td>${esc(label)}${k in ov ? ` ${DF.badge('override', 'info')}` : ''}</td><td>${esc(eff.limits && eff.limits[k] !== undefined ? DF.limit(eff.limits[k]) : '—')}</td><td>${esc(used === undefined ? '' : (used === null ? 'unknown' : DF.num(used)))}</td></tr>`;
        }).join('');
        const feats = Object.entries(eff.features || {}).filter(([, v]) => typeof v === 'boolean');
        body.innerHTML = `<div style="display:flex;gap:.4rem;flex-wrap:wrap">${DF.badge(w.status || 'ACTIVE')} ${DF.badge(`Plan: ${eff.plan?.name || w.plan_name || 'default'}`, 'info')}${t.expired ? ' ' + DF.badge('period ended', 'danger') : ''}</div>
            <div class="ws-drawer-actions">
                <button type="button" class="btn-primary ws-btn-sm" data-a="open"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> Open</button>
                <button type="button" class="btn-outline ws-btn-sm" data-a="rename">Rename</button>
                <button type="button" class="btn-outline ws-btn-sm ${suspended ? '' : 'ws-btn-danger'}" data-a="toggle">${suspended ? 'Activate' : 'Suspend'}</button>
                <button type="button" class="btn-outline ws-btn-sm" data-a="plan">Assign plan</button>
                <button type="button" class="btn-outline ws-btn-sm" data-a="extend">Extend trial</button>
                <button type="button" class="btn-outline ws-btn-sm" data-a="owner">Change owner</button>
            </div>
            <dl class="ws-kv">
                <dt>ID</dt><dd class="ws-mono">${esc(w.id)}</dd>
                <dt>Owner</dt><dd>${esc(row.ownerUsername || '—')} <span class="ws-mono ws-muted">${esc(w.user_id || '')}</span></dd>
                <dt>Created</dt><dd>${esc(DF.date(w.created_at))}</dd>
                <dt>Plan started</dt><dd>${esc(DF.date(w.plan_started_at || t.startedAt))}</dd>
                <dt>Plan ends</dt><dd>${esc(t.endsAt ? DF.date(t.endsAt) : 'No end date')}</dd>
                <dt>Licence</dt><dd>${DF.badge(eff.licence?.status || 'none')}</dd>
            </dl>
            <div class="ws-section-label">Effective limits and usage</div>
            <div class="table-wrapper"><table class="ws-table-limits"><thead><tr><th>Limit</th><th>Allowed</th><th>Used</th></tr></thead><tbody>${limitRows}</tbody></table></div>
            <div class="ws-section-label">Features</div>
            ${feats.length ? `<div class="ws-feat">${feats.map(([k, v]) => `<span class="${v ? 'on' : 'off'}"><i class="fas ${v ? 'fa-check' : 'fa-xmark'}" aria-hidden="true"></i>${esc((DF.FEATURES.find((x) => x[0] === k) || [k, k])[1])}</span>`).join('')}</div>` : '<span class="ws-muted ws-small">All features included.</span>'}`;
        body.onclick = async (e) => {
            const b = e.target.closest('[data-a]'); if (!b) return;
            const a = b.dataset.a;
            if (a === 'open') openWorkspace(id);
            else if (a === 'rename') renameModal(id, w.name, refresh);
            else if (a === 'toggle') { if (await toggleStatus(id, w.name || w.id, w.status)) refresh(); }
            else if (a === 'plan') assignModal(id, d, refresh);
            else if (a === 'extend') extendModal(id, d, refresh);
            else if (a === 'owner') ownerModal(id, d, row.ownerUsername, refresh);
        };
    }

    // ---- tab ------------------------------------------------------------
    async function render() {
        const root = $('tab-workspaces');
        root.innerHTML = `<div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-building" aria-hidden="true"></i> Workspaces</h3></div>
            <div class="ws-toolbar">
                <input id="wsSearch" class="grow" type="search" placeholder="Search by name or ID" aria-label="Search workspaces" autocomplete="off">
                <select id="wsFStatus" aria-label="Filter by status"><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select>
                <select id="wsFPlan" aria-label="Filter by plan"><option value="">All plans</option></select>
                <button type="button" class="btn-outline" id="wsReload" aria-label="Refresh"><i class="fas fa-arrows-rotate" aria-hidden="true"></i></button>
            </div>
            <div class="table-wrapper"><table><thead><tr><th>Workspace</th><th>Status</th><th>Plan</th><th>Owner</th><th>Created</th><th>Actions</th></tr></thead><tbody id="wsTblBody"></tbody></table></div>
            <div class="ws-pager"><span id="wsPagerInfo"></span><div><button type="button" class="btn-outline" id="wsPrev">Previous</button><button type="button" class="btn-outline" id="wsNext">Next</button></div></div></div>`;
        SYS.plans().then((plans) => { $('wsFPlan').insertAdjacentHTML('beforeend', plans.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')); }).catch(() => {});
        $('wsSearch').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { f.search = e.target.value; f.offset = 0; load(); }, 300); });
        $('wsFStatus').onchange = (e) => { f.status = e.target.value; f.offset = 0; load(); };
        $('wsFPlan').onchange = (e) => { f.plan = e.target.value; f.offset = 0; load(); };
        $('wsReload').onclick = load;
        $('wsPrev').onclick = () => { f.offset = Math.max(0, f.offset - PAGE); load(); };
        $('wsNext').onclick = () => { f.offset += PAGE; load(); };
        $('wsTblBody').addEventListener('click', async (e) => {
            const o = e.target.closest('[data-open]'), d = e.target.closest('[data-detail]'), t = e.target.closest('[data-toggle]');
            if (o) openWorkspace(o.dataset.open);
            else if (d) showDetail(d.dataset.detail);
            else if (t) { const w = find(t.dataset.toggle); if (w && await toggleStatus(w.id, w.name || w.id, w.status)) load(); }
        });
        await load();
    }

    SYS.register('workspaces', { render, refresh: load });
})();
