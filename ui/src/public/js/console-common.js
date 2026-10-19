/* Shared helpers for the workspace settings (/settings) and System (/system) pages.
   Needs the globals from partials/header.ejs: API_BASE, getAuthHeaders, escapeHtml, getDecodedToken. Exposes window.DF. */
(function () {
    const esc = (v) => escapeHtml(v);
    const $ = (id) => document.getElementById(id);

    // ---- API -------------------------------------------------------------
    class ApiError extends Error {
        constructor(message, status, code, body) { super(message); this.status = status; this.code = code; this.body = body || {}; }
    }
    async function api(path, opts) {
        const o = Object.assign({}, opts || {});
        o.headers = Object.assign(getAuthHeaders(), o.headers || {});
        if (o.json !== undefined) { o.body = JSON.stringify(o.json); delete o.json; }
        let res;
        try { res = await fetch(`${API_BASE}${path}`, o); }
        catch (e) { throw new ApiError('Could not reach the server', 0, 'NETWORK'); }
        if (res.status === 204) return null;
        const text = await res.text();
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch (e) { body = {}; }
        if (!res.ok) throw new ApiError(body.error || `Request failed (${res.status})`, res.status, body.code, body);
        return body;
    }
    function qs(params) {
        const p = new URLSearchParams();
        Object.keys(params).forEach((k) => { const v = params[k]; if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); });
        const s = p.toString();
        return s ? `?${s}` : '';
    }

    // ---- formatting ------------------------------------------------------
    const date = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleString(); };
    const day = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleDateString(); };
    const num = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString());
    const limit = (n) => (n === -1 ? 'Unlimited' : num(n));
    function daysLeft(d) { if (!d) return null; const ms = new Date(d).getTime() - Date.now(); return isNaN(ms) ? null : Math.ceil(ms / 86400000); }
    function toDateInput(d) { if (!d) return ''; const x = new Date(d); return isNaN(x) ? '' : x.toISOString().slice(0, 10); }

    const BADGE = {
        ACTIVE: 'ok', valid: 'ok', active: 'ok', approved: 'ok', owner: 'info', platform_admin: 'info', member: 'muted',
        SUSPENDED: 'danger', expired: 'danger', revoked: 'danger', invalid: 'danger', wrong_instance: 'danger', rejected: 'danger', disabled: 'danger',
        upcoming: 'warn', trial: 'warn', open: 'warn', hidden: 'muted', none: 'muted', closed: 'muted'
    };
    function badge(text, kind) {
        const k = kind || BADGE[text] || 'muted';
        return `<span class="badge ws-badge-${esc(k)}">${esc(String(text).replace(/_/g, ' '))}</span>`;
    }

    // ---- limit / feature catalogue ---------------------------------------
    const LIMITS = [
        ['max_connections', 'Data source connections'], ['max_tables', 'Tables'], ['max_records_per_table', 'Records per table'],
        ['max_triggers', 'Triggers'], ['max_replications', 'Replications'], ['max_replication_tables', 'Replication tables'],
        ['max_replication_rows', 'Replication rows'], ['max_replication_rows_per_table', 'Replication rows per table'],
        ['max_saved_analytics', 'Saved analytics'], ['max_users_per_workspace', 'Users per workspace'], ['max_api_tokens_per_user', 'API tokens per user'],
        ['max_query_rows', 'Rows per query'], ['max_manifest_size_mb', 'Manifest size (MB)'], ['max_workers', 'Worker nodes'], ['max_tenants', 'Workspaces'],
        ['rate_limit_per_min', 'Requests per minute'], ['rate_limit_per_hour', 'Requests per hour'], ['rate_limit_per_day', 'Requests per day'], ['rate_limit_per_month', 'Requests per month']
    ];
    const FEATURES = [
        ['custom_branding', 'Custom branding'], ['remove_branding', 'Remove branding'], ['enterprise_sso_enabled', 'Enterprise SSO'],
        ['elasticsearch_enabled', 'Elasticsearch'], ['snowflake_enabled', 'Snowflake'], ['cdc_kafka_enabled', 'CDC via Kafka'],
        ['federated_query_enabled', 'Federated queries'], ['distributed_execution_enabled', 'Distributed execution'],
        ['developer_tokens_enabled', 'Developer tokens'], ['manifest_import_export_enabled', 'Manifest import / export'], ['workspace_settings_enabled', 'Workspace settings']
    ];
    const limitLabel = (k) => { const f = LIMITS.find((x) => x[0] === k); return f ? f[1] : k; };

    // ---- DOM helpers -----------------------------------------------------
    const loading = (text) => `<div class="ws-loading" role="status"><span class="ws-spin" aria-hidden="true"></span><span>${esc(text || 'Loading…')}</span></div>`;
    const errorBox = (msg) => `<div class="wk-banner err" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><div>${esc(msg)}</div></div>`;
    const empty = (msg) => `<div class="ws-empty">${esc(msg)}</div>`;
    function busy(btn, on, label) {
        if (!btn) return;
        if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (label) btn.textContent = label; }
        else { btn.disabled = false; btn.removeAttribute('aria-busy'); if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; } }
    }

    // Form field markup. Every interpolated value is escaped here.
    function field(o) {
        const id = esc(o.id);
        const dis = o.disabled ? ' disabled' : '';
        const common = `id="${id}"${dis}${o.required ? ' required' : ''}`;
        const hint = o.hint ? `<span class="ws-hint">${esc(o.hint)}</span>` : '';
        const cls = `ws-field${o.full ? ' full' : ''}`;
        if (o.type === 'checkbox') {
            return `<div class="${cls}"><label class="ws-check"><input type="checkbox" ${common}${o.value ? ' checked' : ''}><span>${esc(o.label)}</span></label>${hint}</div>`;
        }
        let control;
        if (o.type === 'select') {
            control = `<select ${common}>${(o.options || []).map((op) => `<option value="${esc(op.v)}"${String(op.v) === String(o.value ?? '') ? ' selected' : ''}>${esc(op.l)}</option>`).join('')}</select>`;
        } else if (o.type === 'textarea') {
            control = `<textarea ${common} rows="${esc(o.rows || 4)}" placeholder="${esc(o.placeholder || '')}" spellcheck="false">${esc(o.value ?? '')}</textarea>`;
        } else {
            const t = o.type || 'text';
            control = `<input type="${esc(t)}" ${common} value="${esc(o.value ?? '')}" placeholder="${esc(o.placeholder || '')}"` +
                `${o.min !== undefined ? ` min="${esc(o.min)}"` : ''}${o.max !== undefined ? ` max="${esc(o.max)}"` : ''}${o.step !== undefined ? ` step="${esc(o.step)}"` : ''}` +
                `${o.maxlength ? ` maxlength="${esc(o.maxlength)}"` : ''}${o.list ? ` list="${esc(o.list)}"` : ''}${o.pattern ? ` pattern="${esc(o.pattern)}"` : ''} autocomplete="off">`;
        }
        return `<div class="${cls}"><label for="${id}">${esc(o.label)}</label>${control}${hint}</div>`;
    }

    // ---- toasts ----------------------------------------------------------
    function toast(msg, kind) {
        let box = $('wsToasts');
        if (!box) { box = document.createElement('div'); box.id = 'wsToasts'; box.className = 'ws-toasts'; document.body.appendChild(box); }
        const t = document.createElement('div');
        t.className = `ws-toast ${kind || ''}`; t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        t.textContent = msg; box.appendChild(t);
        setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
    }
    const errMsg = (e) => (e && e.message) || 'Something went wrong';

    // ---- modal / drawer / confirm ----------------------------------------
    let seq = 0;
    const layers = [];
    function openLayer(o, isDrawer) {
        const prev = document.activeElement;
        const id = `wsDlg${++seq}`;
        const overlay = document.createElement('div');
        overlay.className = `ws-overlay${isDrawer ? ' drawer' : ''}`;
        overlay.innerHTML = `<form class="${isDrawer ? 'ws-drawer' : `ws-dialog${o.size === 'lg' ? ' lg' : ''}`}" role="dialog" aria-modal="true" aria-labelledby="${id}t" novalidate>
            <div class="ws-dialog-head"><h3 id="${id}t"></h3><button type="button" class="ws-x" data-close aria-label="Close">&times;</button></div>
            <div class="ws-dialog-body"></div>
            <div class="ws-dialog-err" role="alert" hidden></div>
            ${o.hideFooter ? '' : `<div class="ws-dialog-foot"><button type="button" class="btn-outline" data-close></button><button type="submit" class="btn-primary"></button></div>`}
        </form>`;
        const form = overlay.firstElementChild;
        overlay.querySelector('h3').textContent = o.title || '';
        const body = overlay.querySelector('.ws-dialog-body');
        if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
        const errEl = overlay.querySelector('.ws-dialog-err');
        const submit = overlay.querySelector('[type="submit"]');
        if (!o.hideFooter) {
            overlay.querySelector('.ws-dialog-foot .btn-outline').textContent = o.cancelText || 'Cancel';
            submit.textContent = o.confirmText || 'Save';
            if (o.danger) { submit.style.background = 'var(--danger)'; }
        }
        function close() { document.removeEventListener('keydown', onKey, true); const i = layers.indexOf(overlay); if (i >= 0) layers.splice(i, 1); overlay.remove(); if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } } }
        function setError(msg) { errEl.hidden = !msg; errEl.textContent = msg || ''; }
        function onKey(e) { if (e.key === 'Escape' && layers[layers.length - 1] === overlay) { e.stopPropagation(); close(); if (o.onClose) o.onClose(); } }
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { close(); if (o.onClose) o.onClose(); } });
        form.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { close(); if (o.onClose) o.onClose(); } });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!o.onSubmit) { close(); return; }
            setError('');
            if (typeof form.reportValidity === 'function' && !form.checkValidity()) { form.reportValidity(); return; }
            busy(submit, true);
            try { const r = await o.onSubmit(form, ctrl); if (r !== false) close(); }
            catch (err) { setError(errMsg(err)); }
            finally { if (submit.isConnected) busy(submit, false); }
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay); layers.push(overlay);
        const ctrl = { root: overlay, form, body, close, setError };
        if (o.onOpen) o.onOpen(ctrl);
        const first = body.querySelector('input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])') || submit || overlay.querySelector('[data-close]');
        if (first) setTimeout(() => { try { first.focus(); } catch (e) { /* ignore */ } }, 30);
        return ctrl;
    }
    const modal = (o) => openLayer(o, false);
    const drawer = (o) => openLayer(Object.assign({ hideFooter: true }, o), true);

    /** Promise<boolean>. `message` is plain text. */
    function confirmDialog(o) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            const ctrl = modal({
                title: o.title || 'Are you sure?', confirmText: o.confirmText || 'Confirm', danger: !!o.danger,
                body: '<div data-msg></div>',
                onOpen: (c) => {
                    const host = c.body.querySelector('[data-msg]');
                    (Array.isArray(o.message) ? o.message : [o.message]).filter(Boolean).forEach((t) => { const p = document.createElement('p'); p.textContent = t; host.appendChild(p); });
                    if (o.list && o.list.length) { const ul = document.createElement('ul'); ul.style.margin = '.6rem 0 0 1.1rem'; o.list.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); host.appendChild(ul); }
                },
                onSubmit: () => { finish(true); },
                onClose: () => finish(false)
            });
            // Cancel button path (data-close) already calls onClose; make sure unmounts without submit resolve false.
            ctrl.root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) finish(false); });
        });
    }

    // ---- hash-routed tabs ------------------------------------------------
    /** Markup: .st-tabs > button.st-tab[data-tab]; panels `#tab-<name>.st-panel`. */
    function tabs(o) {
        const root = document.querySelector(o.root || '.st-tabs');
        const seen = {};
        const visible = () => [...root.querySelectorAll('.st-tab')].filter((t) => t.style.display !== 'none').map((t) => t.dataset.tab);
        function show(name, replace) {
            if (!visible().includes(name)) name = o.def;
            root.querySelectorAll('.st-tab').forEach((t) => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
            document.querySelectorAll('.st-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
            if (!seen[name]) { seen[name] = true; if (o.onFirst) o.onFirst(name); }
            if (o.onShow) o.onShow(name);
            if (replace !== false) { try { history.replaceState(null, '', `#${name}`); } catch (e) { /* ignore */ } }
        }
        root.addEventListener('click', (e) => { const b = e.target.closest('.st-tab'); if (b) show(b.dataset.tab); });
        root.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const names = visible(); const cur = names.indexOf(root.querySelector('.st-tab[aria-selected="true"]')?.dataset.tab);
            const next = names[(cur + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
            show(next); root.querySelector(`.st-tab[data-tab="${next}"]`).focus();
        });
        window.addEventListener('hashchange', () => show(location.hash.slice(1), false));
        return { show, start: () => show(location.hash.slice(1) || o.def) };
    }

    // Role of the signed-in user from the JWT (the server stays authoritative).
    const isPlatformAdmin = () => { try { return (getDecodedToken() || {}).internal_role === 'ADMIN'; } catch (e) { return false; } };

    window.DF = { esc, $, api, ApiError, qs, date, day, num, limit, daysLeft, toDateInput, badge, LIMITS, FEATURES, limitLabel, loading, errorBox, empty, busy, field, toast, errMsg, modal, drawer, confirm: confirmDialog, tabs, isPlatformAdmin };
})();
