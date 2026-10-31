/* /settings: General (name, general, notifications) and Query tabs. Generic section forms over PUT /workspace/settings/:section. */
(function () {
    const { esc, $ } = DF;

    const SECTIONS = {
        general: {
            title: 'General', icon: 'fa-sliders', desc: 'How this workspace presents itself. Leave a field blank to keep its current value.',
            fields: [
                { key: 'displayName', label: 'Display name', type: 'text', maxlength: 100, blankOk: true },
                { key: 'timezone', label: 'Timezone', type: 'text', list: 'wsTzList', placeholder: 'UTC', hint: 'IANA name, for example Asia/Kolkata.' },
                { key: 'defaultRegion', label: 'Default region', type: 'text', maxlength: 8, placeholder: 'AP', hint: '2 to 8 letters.' },
                { key: 'contactEmail', label: 'Contact email', type: 'email', maxlength: 200, hint: 'Used for limit and plan notices.' }
            ]
        },
        notifications: {
            title: 'Notifications', icon: 'fa-bell', desc: 'Warn the workspace before a plan limit is reached.',
            fields: [
                { key: 'emailOnLimit', label: 'Email me when a limit is close', type: 'checkbox' },
                { key: 'limitWarningPercent', label: 'Warning threshold (%)', type: 'number', min: 50, max: 100, hint: 'Between 50 and 100.' }
            ]
        },
        query: {
            title: 'Query', icon: 'fa-database', desc: 'Defaults and ceilings for queries run in this workspace. Your plan may enforce lower values.',
            fields: [
                { key: 'maxRows', label: 'Max rows per query', type: 'number', min: 1, max: 1000000, placeholder: 'Plan default', hint: '1 to 1,000,000. Your plan limit still applies.' },
                { key: 'timeoutMs', label: 'Query timeout (ms)', type: 'number', min: 100, max: 300000, placeholder: 'Server default', hint: '100 to 300,000.' },
                { key: 'allowStreaming', label: 'Allow streaming responses', type: 'checkbox' }
            ]
        }
    };

    function timezones() {
        try { if (Intl.supportedValuesOf) return Intl.supportedValuesOf('timeZone').concat(['UTC']); } catch (e) { /* older browser */ }
        return ['UTC'];
    }

    function sectionCard(key, ws) {
        const s = SECTIONS[key], vals = (ws.data.settings || {})[key] || {};
        const dis = !ws.canEditSettings;
        const fields = s.fields.map((f) => DF.field({ id: `wsf-${key}-${f.key}`, label: f.label, type: f.type, value: f.type === 'checkbox' ? !!vals[f.key] : vals[f.key], min: f.min, max: f.max, maxlength: f.maxlength, list: f.list, placeholder: f.placeholder, hint: f.hint, disabled: dis })).join('');
        return `<form class="ws-card" id="wsf-${key}" novalidate>
            <div class="ws-card-head"><h3><i class="fas ${esc(s.icon)}" aria-hidden="true"></i> ${esc(s.title)}</h3></div>
            <p class="ws-card-desc">${esc(s.desc)}</p>
            <div class="ws-form-grid">${fields}</div>
            <div class="ws-inline-err" id="wsf-${key}-err" role="alert" hidden></div>
            ${dis ? '' : `<div class="ws-actions"><button type="button" class="btn-outline" data-reset="${esc(key)}">Reset</button><button type="submit" class="btn-primary">Save ${esc(s.title.toLowerCase())}</button></div>`}
        </form>`;
    }

    function collect(key, current) {
        const out = {};
        SECTIONS[key].fields.forEach((f) => {
            const el = $(`wsf-${key}-${f.key}`); if (!el) return;
            let v;
            if (f.type === 'checkbox') v = el.checked;
            else if (f.type === 'number') { if (el.value === '') return; v = Number(el.value); }
            else { v = el.value.trim(); if (v === '' && !f.blankOk) return; }
            if (current[f.key] !== v && !(current[f.key] === undefined && v === '')) out[f.key] = v;
        });
        return out;
    }

    function fill(key, ws) {
        const vals = (ws.data.settings || {})[key] || {};
        SECTIONS[key].fields.forEach((f) => {
            const el = $(`wsf-${key}-${f.key}`); if (!el) return;
            if (f.type === 'checkbox') el.checked = !!vals[f.key]; else el.value = vals[f.key] ?? '';
        });
    }

    function bind(root, ws) {
        root.addEventListener('submit', async (e) => {
            const form = e.target.closest('form[id^="wsf-"]'); if (!form) return;
            e.preventDefault();
            const key = form.id.slice(4);
            const errEl = $(`wsf-${key}-err`), btn = form.querySelector('[type="submit"]');
            errEl.hidden = true;
            if (!form.checkValidity()) { form.reportValidity(); return; }
            const current = (ws.data.settings || {})[key] || {};
            const body = collect(key, current);
            if (!Object.keys(body).length) { DF.toast('Nothing to save: no values changed.'); return; }
            DF.busy(btn, true, 'Saving…');
            try {
                await DF.api(`/workspace/settings/${encodeURIComponent(key)}`, { method: 'PUT', json: body });
                ws.data.settings = await DF.api('/workspace/settings');
                fill(key, ws);
                DF.toast(`${SECTIONS[key].title} settings saved`, 'ok');
            } catch (er) { errEl.textContent = DF.errMsg(er); errEl.hidden = false; DF.toast(DF.errMsg(er), 'err'); }
            finally { DF.busy(btn, false); }
        });
        root.addEventListener('click', (e) => { const b = e.target.closest('[data-reset]'); if (b) { fill(b.dataset.reset, ws); $(`wsf-${b.dataset.reset}-err`).hidden = true; } });
    }

    function nameCard(ws) {
        const dis = !ws.canEdit;
        return `<form class="ws-card" id="wsNameForm" novalidate>
            <div class="ws-card-head"><h3><i class="fas fa-signature" aria-hidden="true"></i> Workspace name</h3></div>
            <p class="ws-card-desc">The name shown in the workspace switcher. The workspace ID (<span class="ws-mono">${esc(ws.data.workspace.id)}</span>) never changes.</p>
            <div class="ws-form-grid">${DF.field({ id: 'wsName', label: 'Name', value: ws.data.workspace.name, maxlength: 100, required: true, disabled: dis, hint: '1 to 100 characters.' })}</div>
            <div class="ws-inline-err" id="wsNameErr" role="alert" hidden></div>
            ${dis ? '' : '<div class="ws-actions"><button type="submit" class="btn-primary">Rename workspace</button></div>'}
        </form>`;
    }

    function bindName(ws) {
        $('wsNameForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = $('wsName').value.trim(), errEl = $('wsNameErr'), btn = e.target.querySelector('[type="submit"]');
            errEl.hidden = true;
            if (!name) { errEl.textContent = 'Name is required'; errEl.hidden = false; return; }
            if (name === ws.data.workspace.name) { DF.toast('Nothing to save: the name is unchanged.'); return; }
            DF.busy(btn, true, 'Saving…');
            try { await DF.api('/workspace', { method: 'PUT', json: { name } }); await ws.reload(); DF.toast('Workspace renamed', 'ok'); }
            catch (er) { errEl.textContent = DF.errMsg(er); errEl.hidden = false; }
            finally { DF.busy(btn, false); }
        });
    }

    function ensureTzList() {
        if ($('wsTzList')) return;
        const dl = document.createElement('datalist'); dl.id = 'wsTzList';
        timezones().forEach((z) => { const o = document.createElement('option'); o.value = z; dl.appendChild(o); });
        document.body.appendChild(dl);
    }

    WS.register('general', {
        render(ws) {
            ensureTzList();
            const root = $('tab-general');
            root.innerHTML = ws.readonlyNote() + nameCard(ws) + sectionCard('general', ws) + sectionCard('notifications', ws);
            bindName(ws); bind(root, ws);
        }
    });
    WS.register('query', {
        render(ws) {
            const root = $('tab-query');
            root.innerHTML = ws.readonlyNote() + sectionCard('query', ws);
            bind(root, ws);
        }
    });
})();
