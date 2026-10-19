/* /system: Events tab. Audit trail of platform changes (GET /system/events). */
(function () {
    const { esc, $ } = DF;

    async function load() {
        const body = $('evBody');
        body.innerHTML = `<tr><td colspan="5">${DF.loading()}</td></tr>`;
        try {
            const rows = await DF.api(`/system/events${DF.qs({ limit: $('evLimit').value, tenantId: $('evTenant').value.trim() })}`);
            body.innerHTML = rows.length ? rows.map((e) => `<tr><td>${esc(DF.date(e.createdAt))}</td><td>${esc(e.actor)}</td><td><span class="badge ws-badge-info">${esc(e.action)}</span></td>
                <td class="ws-mono">${esc(e.tenantId || '—')}</td><td class="ws-cell-wrap">${esc(e.detail === null || e.detail === undefined ? '' : JSON.stringify(e.detail))}</td></tr>`).join('')
                : `<tr><td colspan="5" class="ws-table-note">No events recorded${$('evTenant').value.trim() ? ' for this workspace' : ''}.</td></tr>`;
        } catch (e) { body.innerHTML = `<tr><td colspan="5">${DF.errorBox(DF.errMsg(e))}</td></tr>`; }
    }

    SYS.register('events', {
        render() {
            $('tab-events').innerHTML = `<div class="ws-card"><div class="ws-card-head"><h3><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> System events</h3></div>
                <p class="ws-card-desc">Every platform-level change (plans, workspaces, licence, settings) with who did it.</p>
                <div class="ws-toolbar"><input id="evTenant" class="grow" type="search" placeholder="Filter by workspace ID" aria-label="Filter by workspace ID" autocomplete="off">
                    <select id="evLimit" aria-label="Rows"><option value="50">Last 50</option><option value="100">Last 100</option><option value="200">Last 200</option></select>
                    <button type="button" class="btn-outline" id="evReload"><i class="fas fa-arrows-rotate" aria-hidden="true"></i> Refresh</button></div>
                <div class="table-wrapper"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Workspace</th><th>Detail</th></tr></thead><tbody id="evBody"></tbody></table></div></div>`;
            let t = null;
            $('evTenant').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 350); });
            $('evLimit').onchange = load; $('evReload').onclick = load;
            return load();
        },
        refresh: load
    });
})();
