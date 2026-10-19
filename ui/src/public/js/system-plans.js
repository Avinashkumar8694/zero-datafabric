/* /system: Plans tab. Plan cards, create/edit modal (limits + feature editor), delete with confirm, plan requests. */
(function () {
    const { esc, $ } = DF;
    const STATUSES = ['active', 'disabled', 'hidden', 'upcoming'];
    const NAME_RE = /^[A-Za-z0-9_-]{2,50}$/;
    let plans = [], reqStatus = 'open';

    const statusBadge = (s) => DF.badge(s || 'active', { active: 'ok', disabled: 'danger', hidden: 'muted', upcoming: 'warn' }[s || 'active']);

    function card(p) {
        const l = p.limits || {}, f = p.features || {}, price = Number(p.price_monthly) || 0;
        const on = DF.FEATURES.filter(([k]) => f[k] !== false).length;
        return `<article class="ws-plan">
            <div class="ws-plan-head"><span class="ws-plan-name">${esc(p.name)}</span><span>${statusBadge(p.status)}${p.is_default ? ' ' + DF.badge('default', 'info') : ''}${p.is_custom ? ' ' + DF.badge('custom', 'info') : ''}</span></div>
            <div class="ws-plan-price">${price === 0 ? 'Free' : `$${esc(price)}<small>/month</small>`}</div>
            ${p.description ? `<div class="ws-small ws-muted">${esc(p.description)}</div>` : ''}
            <ul>
                <li><i class="fas fa-check" aria-hidden="true"></i>${esc(DF.limit(l.max_connections))} connections</li>
                <li><i class="fas fa-check" aria-hidden="true"></i>${esc(DF.limit(l.max_tables))} tables</li>
                <li><i class="fas fa-check" aria-hidden="true"></i>${esc(DF.limit(l.max_users_per_workspace))} users per workspace</li>
                <li><i class="fas fa-check" aria-hidden="true"></i>${esc(on)} of ${esc(DF.FEATURES.length)} features</li>
                ${Number(f.trial_period_days) > 0 ? `<li><i class="fas fa-clock" aria-hidden="true"></i>${esc(f.trial_period_days)}-day trial</li>` : ''}
            </ul>
            <div class="ws-plan-actions"><button type="button" class="btn-outline" data-edit="${esc(p.id)}"><i class="fas fa-pen" aria-hidden="true"></i> Edit</button>
                <button type="button" class="btn-outline ws-btn-danger" data-del="${esc(p.id)}"><i class="fas fa-trash" aria-hidden="true"></i> Delete</button></div>
        </article>`;
    }

    function editor(p) {
        const isNew = !p;
        const cur = p || { status: 'active', limits: {}, features: { trial_period_days: 7 }, price_monthly: 0 };
        const cc = cur.contact_config || {};
        const f = cur.features || {};
        const body = `<div class="ws-form-grid">
                ${DF.field({ id: 'plName', label: 'Name', value: cur.name, required: true, maxlength: 50, pattern: '[A-Za-z0-9_\\-]{2,50}', hint: 'Letters, digits, _ and -, 2 to 50 characters.' })}
                ${DF.field({ id: 'plPrice', label: 'Price per month', type: 'number', min: 0, max: 1000000, step: '0.01', value: cur.price_monthly ?? 0 })}
                ${DF.field({ id: 'plStatus', label: 'Status', type: 'select', options: STATUSES.map((s) => ({ v: s, l: s })), value: cur.status || 'active', hint: 'Only active plans can be picked by workspaces.' })}
                ${DF.field({ id: 'plMaxTenants', label: 'Max workspaces on this plan', type: 'number', min: -1, value: cur.max_tenants ?? -1, hint: '-1 means unlimited.' })}
                ${DF.field({ id: 'plDesc', label: 'Description', value: cur.description || '', maxlength: 500, full: true })}
                ${DF.field({ id: 'plDefault', label: 'Default plan for new workspaces', type: 'checkbox', value: !!cur.is_default, hint: 'Must be active and not custom.' })}
                ${DF.field({ id: 'plCustom', label: 'Custom plan (by arrangement)', type: 'checkbox', value: !!cur.is_custom, hint: 'Workspaces send a request instead of selecting it.' })}
                ${DF.field({ id: 'plContactEmail', label: 'Contact email for custom plans', type: 'email', value: cc.email || '', maxlength: 200 })}
            </div>
            <div class="ws-section-label">Limits <span class="ws-muted" style="text-transform:none;letter-spacing:0">(blank = not set, trial default applies)</span></div>
            <div id="plLimits">${SYS.limitsEditor('plL', cur.limits)}</div>
            <div class="ws-section-label">Features</div>
            <div class="ws-feat-grid" id="plFeatures">${DF.FEATURES.map(([k, label]) => `<label class="ws-check"><input type="checkbox" data-feat="${esc(k)}" ${f[k] === false ? '' : 'checked'}><span>${esc(label)}</span></label>`).join('')}</div>
            <div class="ws-form-grid" style="margin-top:.75rem">${DF.field({ id: 'plTrial', label: 'Trial period (days)', type: 'number', min: -1, max: 3650, value: f.trial_period_days ?? '', hint: '-1 means no expiry. Blank leaves it unset.' })}</div>`;
        DF.modal({
            title: isNew ? 'New plan' : `Edit plan: ${cur.name}`, size: 'lg', confirmText: isNew ? 'Create plan' : 'Save plan', body,
            onOpen: (c) => SYS.bindLimitsEditor(c.body),
            onSubmit: async (form) => {
                const name = $('plName').value.trim();
                if (!NAME_RE.test(name)) throw new Error('Name must be 2 to 50 characters: letters, digits, _ and -.');
                const limits = SYS.readLimits($('plLimits'));
                const features = {};
                form.querySelectorAll('input[data-feat]').forEach((i) => { features[i.dataset.feat] = i.checked; });
                if ($('plTrial').value !== '') features.trial_period_days = Number($('plTrial').value);
                const body = {
                    name, description: $('plDesc').value.trim(), price_monthly: Number($('plPrice').value || 0), status: $('plStatus').value,
                    is_default: $('plDefault').checked, is_custom: $('plCustom').checked, max_tenants: Number($('plMaxTenants').value === '' ? -1 : $('plMaxTenants').value)
                };
                const email = $('plContactEmail').value.trim();
                if (email || cc.email !== undefined) body.contact_config = Object.assign({}, cc, { email });
                if (!Number.isInteger(body.max_tenants) || body.max_tenants < -1) throw new Error('Max workspaces must be -1 or more.');
                if (body.is_default && (body.is_custom || body.status !== 'active')) throw new Error('The default plan must be active and not custom.');
                if (isNew) { body.limits = limits; body.features = features; }
                else {
                    // Send limits/features only when edited, so unknown legacy keys on the plan are not rewritten.
                    const known = (o, keys) => JSON.stringify(Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)).sort()));
                    if (known(limits, DF.LIMITS.map((x) => x[0])) !== known(cur.limits, DF.LIMITS.map((x) => x[0]))) body.limits = limits;
                    const fkeys = DF.FEATURES.map((x) => x[0]).concat('trial_period_days');
                    const normCur = Object.fromEntries(DF.FEATURES.map(([k]) => [k, cur.features?.[k] !== false]).concat(cur.features?.trial_period_days !== undefined ? [['trial_period_days', cur.features.trial_period_days]] : []));
                    if (known(features, fkeys) !== known(normCur, fkeys)) body.features = features;
                    if (body.is_default === !!cur.is_default) delete body.is_default;
                }
                if (isNew) await DF.api('/system/plans', { method: 'POST', json: body });
                else await DF.api(`/system/plans/${encodeURIComponent(cur.id)}`, { method: 'PUT', json: body });
                DF.toast(isNew ? 'Plan created' : 'Plan saved', 'ok');
                await load();
            }
        });
    }

    async function remove(id) {
        const p = plans.find((x) => x.id === id); if (!p) return;
        const ok = await DF.confirm({ title: `Delete plan "${p.name}"?`, message: ['This cannot be undone.', 'A plan that is the default, built in, or used by any workspace cannot be deleted. Disable or hide it instead.'], confirmText: 'Delete plan', danger: true });
        if (!ok) return;
        try { await DF.api(`/system/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }); DF.toast('Plan deleted', 'ok'); await load(); }
        catch (e) { DF.toast(DF.errMsg(e), 'err'); }
    }

    async function load() {
        const grid = $('sysPlanGrid');
        grid.innerHTML = DF.loading('Loading plans…');
        try { plans = await SYS.plans(true); } catch (e) { grid.innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        grid.innerHTML = plans.length ? `<div class="ws-plans">${plans.map(card).join('')}</div>` : DF.empty('No plans yet. Create the first one.');
    }

    // ---- plan requests ---------------------------------------------------
    async function loadRequests() {
        const body = $('sysReqBody');
        body.innerHTML = `<tr><td colspan="6">${DF.loading()}</td></tr>`;
        try {
            const rows = await DF.api(`/system/plan-requests${DF.qs({ status: reqStatus })}`);
            body.innerHTML = rows.length ? rows.map((r) => `<tr><td>${esc(r.tenant_name || r.tenant_id)}<div class="ws-mono ws-muted">${esc(r.tenant_id)}</div></td><td>${esc(r.plan_name)}</td><td>${esc(r.requested_by)}</td>
                <td class="ws-cell-wrap">${esc(r.message || '')}</td><td>${esc(DF.date(r.created_at))}</td>
                <td>${r.status === 'open' ? `<div class="ws-row-actions"><button class="btn-outline ws-btn-sm" data-req="${esc(r.id)}" data-st="approved">Approve</button><button class="btn-outline ws-btn-sm" data-req="${esc(r.id)}" data-st="rejected">Reject</button><button class="btn-outline ws-btn-sm" data-req="${esc(r.id)}" data-st="closed">Close</button></div>` : DF.badge(r.status)}</td></tr>`).join('')
                : `<tr><td colspan="6" class="ws-table-note">No ${reqStatus === 'all' ? '' : esc(reqStatus) + ' '}requests.</td></tr>`;
        } catch (e) { body.innerHTML = `<tr><td colspan="6">${DF.errorBox(DF.errMsg(e))}</td></tr>`; }
    }

    async function resolve(id, status) {
        const ok = await DF.confirm({ title: `Mark request as ${status}?`, message: status === 'approved' ? 'This only records the decision. Assign the plan to the workspace from the Workspaces tab.' : 'The request is closed and removed from the open list.', confirmText: `Mark ${status}`, danger: status === 'rejected' });
        if (!ok) return;
        try { await DF.api(`/system/plan-requests/${encodeURIComponent(id)}`, { method: 'PUT', json: { status } }); DF.toast(`Request ${status}`, 'ok'); await loadRequests(); }
        catch (e) { DF.toast(DF.errMsg(e), 'err'); }
    }

    SYS.register('plans', {
        render() {
            $('tab-plans').innerHTML = `<div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-tags" aria-hidden="true"></i> Plan catalogue</h3>
                <button type="button" class="btn-primary" id="sysPlanNew"><i class="fas fa-plus" aria-hidden="true"></i> New plan</button></div>
                <p class="ws-card-desc">Plans define the limits and features of a workspace. Only active plans can be selected by workspaces.</p><div id="sysPlanGrid"></div></div>
                <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-inbox" aria-hidden="true"></i> Plan requests</h3>
                    <select id="sysReqStatus" class="ws-input" style="width:auto" aria-label="Request status"><option value="open">Open</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="closed">Closed</option><option value="all">All</option></select></div>
                    <div class="table-wrapper"><table><thead><tr><th>Workspace</th><th>Plan</th><th>Requested by</th><th>Message</th><th>Date</th><th>Action</th></tr></thead><tbody id="sysReqBody"></tbody></table></div></div>`;
            $('sysPlanNew').onclick = () => editor(null);
            $('sysPlanGrid').addEventListener('click', (e) => {
                const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
                if (ed) editor(plans.find((p) => p.id === ed.dataset.edit)); else if (del) remove(del.dataset.del);
            });
            $('sysReqStatus').onchange = (e) => { reqStatus = e.target.value; loadRequests(); };
            $('sysReqBody').addEventListener('click', (e) => { const b = e.target.closest('[data-req]'); if (b) resolve(b.dataset.req, b.dataset.st); });
            load(); loadRequests();
        },
        refresh() { load(); loadRequests(); }
    });
})();
