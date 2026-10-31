/* /settings: Plan & usage tab. Usage-vs-limit bars, selectable plans (with confirm), plan request form, contact-us for custom plans. */
(function () {
    const { esc, $ } = DF;
    let ws = null, lim = null, plans = [];

    // usage counter -> [limit key, label]
    const USAGE = [
        ['max_connections', 'max_connections', 'Data source connections'], ['max_tables', 'max_tables', 'Tables'], ['max_triggers', 'max_triggers', 'Triggers'],
        ['max_saved_analytics', 'max_saved_analytics', 'Saved analytics'], ['max_users_per_workspace', 'max_users_per_workspace', 'Users'],
        ['max_replications', 'max_replications', 'Replications'], ['active_api_tokens', 'max_api_tokens_per_user', 'Active API tokens (limit applies per user)']
    ];

    function meter(label, used, limit, warnAt) {
        const unl = limit === -1 || limit === undefined || limit === null;
        let cls = '', pct = 0, text;
        if (used === null || used === undefined) { text = `usage unknown / ${unl ? 'unlimited' : DF.num(limit)}`; }
        else if (unl) { cls = 'unl'; text = `${DF.num(used)} used · unlimited`; }
        else {
            pct = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
            cls = used >= limit ? 'full' : (pct >= warnAt ? 'warn' : '');
            text = `${DF.num(used)} of ${DF.num(limit)}${used >= limit ? ' · limit reached' : ''}`;
        }
        return `<div><div class="ws-meter-top"><b>${esc(label)}</b><span class="ws-muted">${esc(text)}</span></div>
            <div class="ws-bar ${cls}" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div></div>`;
    }

    function summary() {
        const t = lim.trial || {}, l = lim.licence || {}, left = DF.daysLeft(t.endsAt);
        const period = t.endsAt ? (t.expired ? `Ended ${DF.date(t.endsAt)}` : `Ends ${DF.date(t.endsAt)}${left !== null ? ` (${left} day${left === 1 ? '' : 's'} left)` : ''}`) : 'No end date';
        return `<div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-layer-group" aria-hidden="true"></i> Current plan</h3>${DF.badge(lim.plan?.name || 'unknown', 'info')}</div>
            <dl class="ws-kv"><dt>Plan period</dt><dd>${esc(period)} ${t.expired ? DF.badge('expired', 'danger') : ''}</dd>
            <dt>Licence</dt><dd>${DF.badge(l.status || 'none')} ${l.licensee ? esc(l.licensee) : ''}${l.selfHosted ? ' · self-hosted' : ''}</dd>
            ${lim.planLimitsEnabled === false ? '<dt>Limits</dt><dd>Plan limits are switched off on this platform.</dd>' : ''}</dl></div>`;
    }

    function usageCard() {
        const warnAt = Number(((ws.data.settings || {}).notifications || {}).limitWarningPercent) || 80;
        const usage = lim.usage || {}, limits = lim.limits || {};
        const rows = USAGE.filter(([u, k]) => u in usage || k in limits);
        const table = DF.LIMITS.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="ws-mono">${esc(k)}</td><td>${esc(limits[k] === undefined ? '—' : DF.limit(limits[k]))}</td></tr>`).join('');
        return `<div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-gauge-high" aria-hidden="true"></i> Usage</h3></div>
            <p class="ws-card-desc">Current usage against the limits of your plan and licence. Bars turn amber at ${esc(warnAt)}%.</p>
            <div class="ws-usage">${rows.map(([u, k, label]) => meter(label, usage[u], limits[k], warnAt)).join('') || DF.empty('No usage data available.')}</div>
            <details class="ws-details" style="margin-top:1rem"><summary>All effective limits</summary>
                <div class="table-wrapper"><table class="ws-table-limits"><thead><tr><th>Limit</th><th>Key</th><th>Value</th></tr></thead><tbody>${table}</tbody></table></div></details></div>`;
    }

    function planCard(p) {
        const cur = lim.plan?.name === p.name;
        const l = p.limits || {}, f = p.features || {};
        const price = Number(p.price_monthly) || 0;
        const trial = Number(f.trial_period_days);
        const feats = DF.FEATURES.filter(([k]) => k in f);
        const status = p.status === 'upcoming' ? DF.badge('coming soon', 'warn') : (p.is_custom ? DF.badge('custom', 'info') : '');
        let action;
        if (cur) action = '<button type="button" class="btn-outline" disabled>Current plan</button>';
        else if (p.status === 'upcoming') action = '<button type="button" class="btn-outline" disabled>Coming soon</button>';
        else if (p.is_custom) action = `<button type="button" class="btn-outline" data-contact="${esc(p.name)}" ${ws.canEdit ? '' : 'disabled'}><i class="fas fa-envelope" aria-hidden="true"></i> Contact us</button>`;
        else action = `<button type="button" class="btn-primary" data-select="${esc(p.name)}" ${ws.canEdit ? '' : 'disabled'}>Select plan</button>`;
        const li = (ok, text) => `<li class="${ok ? '' : 'off'}"><i class="fas ${ok ? 'fa-check' : 'fa-xmark'}" aria-hidden="true"></i>${esc(text)}</li>`;
        const contact = p.is_custom && p.contact_config && typeof p.contact_config.email === 'string' ? `<span class="ws-hint">${esc(p.contact_config.email)}</span>` : '';
        return `<article class="ws-plan ${cur ? 'current' : ''} ${p.status === 'upcoming' ? 'dim' : ''}">
            <div class="ws-plan-head"><span class="ws-plan-name">${esc(p.name)}</span>${cur ? DF.badge('current', 'ok') : status}</div>
            <div class="ws-plan-price">${p.is_custom ? 'Custom' : (price === 0 ? 'Free' : `$${esc(price)}<small>/month</small>`)}</div>
            ${p.description ? `<div class="ws-small ws-muted">${esc(p.description)}</div>` : ''}
            <ul>
                ${li(true, `${DF.limit(l.max_connections)} connections`)}${li(true, `${DF.limit(l.max_tables)} tables`)}${li(true, `${DF.limit(l.max_users_per_workspace)} users`)}${li(true, `${DF.limit(l.max_query_rows)} rows per query`)}
                ${trial > 0 ? li(true, `${trial}-day trial period`) : ''}
                ${feats.slice(0, 6).map(([k, label]) => li(f[k] !== false, label)).join('')}
            </ul>${contact}
            <div class="ws-plan-actions">${action}</div></article>`;
    }

    function selectPlan(name) {
        const p = plans.find((x) => x.name === name); if (!p) return;
        const trial = Number((p.features || {}).trial_period_days);
        DF.modal({
            title: `Switch to ${p.name}?`, confirmText: 'Switch plan',
            body: `<p>Your workspace will move to the <strong>${esc(p.name)}</strong> plan. Your current plan ends immediately and its per-workspace overrides are cleared.</p>${trial > 0 ? `<p>This plan includes a ${esc(trial)}-day trial. A workspace can only use a trial once.</p>` : ''}
                <p class="ws-muted ws-small">If your usage is above this plan's limits the switch is refused and nothing changes.</p>`,
            onSubmit: async () => {
                try { await DF.api('/workspace/plan', { method: 'PUT', json: { plan: name } }); }
                catch (e) {
                    if (e.code === 'PLAN_DOES_NOT_FIT' && Array.isArray(e.body.problems)) throw new Error(`${e.message}:\n- ${e.body.problems.join('\n- ')}`);
                    throw e;
                }
                DF.toast(`Now on the ${name} plan`, 'ok');
                await ws.reload(); await render(ws);
            }
        });
    }

    function requestModal(planName) {
        const opts = plans.map((p) => ({ v: p.name, l: p.name + (p.is_custom ? ' (custom)' : '') }));
        DF.modal({
            title: 'Contact us about a plan', confirmText: 'Send request',
            body: `<p class="ws-muted ws-small">We will get back to you about pricing and limits. You can have up to 3 open requests.</p><div class="ws-form-grid">
                ${DF.field({ id: 'prqPlan', label: 'Plan', type: 'select', options: opts, value: planName, full: true, required: true })}
                ${DF.field({ id: 'prqMsg', label: 'What do you need?', type: 'textarea', rows: 5, full: true, hint: 'Up to 1000 characters.', placeholder: 'For example: 20 connections and SSO for 50 users.' })}</div>`,
            onSubmit: async () => {
                const msg = $('prqMsg').value.trim();
                if (msg.length > 1000) throw new Error('The message can be at most 1000 characters.');
                await DF.api('/workspace/plan/requests', { method: 'POST', json: { plan: $('prqPlan').value, message: msg || undefined } });
                DF.toast('Request sent. We will be in touch.', 'ok');
            }
        });
    }

    async function render(w) {
        ws = w;
        const root = $('tab-plan');
        if (!lim) root.innerHTML = DF.loading('Loading plan and usage…');
        try {
            const [l, p] = await Promise.all([DF.api('/workspace/limits'), DF.api('/workspace/plans')]);
            lim = l; plans = Array.isArray(p) ? p : (p.plans || []);
        } catch (e) { root.innerHTML = DF.errorBox(DF.errMsg(e)); return; }
        const note = ws.canEdit ? '' : '<div class="ws-readonly" role="note"><i class="fas fa-lock" aria-hidden="true"></i><span>Only the workspace owner or a platform admin can change the plan. You can view usage and plans.</span></div>';
        root.innerHTML = `${note}${summary()}${usageCard()}
            <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-tags" aria-hidden="true"></i> Available plans</h3></div>
                ${plans.length ? `<div class="ws-plans">${plans.map(planCard).join('')}</div>` : DF.empty('No plans are available to select right now.')}</div>
            <div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-handshake-angle" aria-hidden="true"></i> Need something else?</h3></div>
                <p class="ws-card-desc">Custom limits, self-hosting or enterprise features are arranged with us directly.</p>
                <button type="button" class="btn-outline" id="planContact" ${ws.canEdit ? '' : 'disabled'}><i class="fas fa-envelope" aria-hidden="true"></i> Send a plan request</button></div>`;
        root.onclick = (e) => {
            const s = e.target.closest('[data-select]'), c = e.target.closest('[data-contact]');
            if (s) selectPlan(s.dataset.select); else if (c) requestModal(c.dataset.contact); else if (e.target.closest('#planContact')) requestModal((plans.find((p) => p.is_custom) || plans[0] || {}).name);
        };
    }

    WS.register('plan', { render });
})();
