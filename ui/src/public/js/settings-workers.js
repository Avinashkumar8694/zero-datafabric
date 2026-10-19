/* Worker nodes tab: manage Citus workers for distributed execution. Admin only. */
(function () {
    const $ = (id) => document.getElementById(id);
    const esc = (v) => escapeHtml(v);
    let timer = null;

    function toast(msg, bad) {
        const t = document.createElement('div');
        t.className = 'wk-toast'; t.setAttribute('role', 'status');
        if (bad) t.style.borderColor = 'var(--danger, #f87171)';
        t.textContent = msg; document.body.appendChild(t);
        setTimeout(() => t.remove(), 4500);
    }
    async function api(path, opts) {
        const res = await fetch(`${API_BASE}/admin/workers${path}`, Object.assign({ headers: getAuthHeaders() }, opts || {}));
        if (res.status === 204) return null;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.code = body.code; throw e; }
        return body;
    }
    async function act(btn, fn, okMsg) {
        if (btn) btn.disabled = true;
        try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
        finally { if (btn) btn.disabled = false; await load(); }
    }
    const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
    const fmtDate = (d) => d ? new Date(d).toLocaleString() : '—';

    function renderStatus(data) {
        const c = data.citus; let html = '';
        if (!c.available) html = `<div class="wk-banner err"><i class="fas fa-triangle-exclamation"></i><div><strong>Citus is not installed on the hub database.</strong><br>Run the hub on a <code>citusdata/citus</code> image to enable distributed execution. Workers cannot be added until then.</div></div>`;
        else if (!c.isCoordinator) html = `<div class="wk-banner err"><i class="fas fa-triangle-exclamation"></i><div>The configured database is a Citus worker, not the coordinator.</div></div>`;
        else html = `<div class="wk-banner ok"><i class="fas fa-circle-check"></i><div>Citus ${esc(c.version)} coordinator is ready. Queries fan out to the active workers below.</div></div>`;
        (data.warnings || []).forEach(w => { html += `<div class="wk-banner warn"><i class="fas fa-circle-info"></i><div>${esc(w)}</div></div>`; });
        $('wkStatus').innerHTML = html;
        const s = data.summary;
        $('wkTiles').innerHTML = [['Workers', s.total], ['Active', s.active], ['Draining', s.draining], ['Down / drift', s.down], ['Shard placements', s.shards]]
            .map(([l, v]) => `<div class="wk-tile"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
        const dis = !c.available || !c.isCoordinator;
        ['wkAddToggle', 'wkRebalance', 'wkHealth', 'wkSync'].forEach(id => { $(id).disabled = dis; });
    }

    function renderWorkers(workers) {
        if (!workers.length) { $('wkGrid').innerHTML = `<div class="wk-empty" style="grid-column:1/-1">No worker nodes yet. Add a Citus worker to start running queries in parallel.</div>`; return; }
        $('wkGrid').innerHTML = workers.map(w => {
            const labels = Object.entries(w.labels || {}).map(([k, v]) => `<span class="wk-chip">${esc(k)}=${esc(v)}</span>`).join('');
            const h = w.lastHealth ? `<span class="badge wk-st-${esc(w.lastHealth.status)}">${esc(w.lastHealth.status)}</span> <span>${esc(fmtDate(w.lastHealth.checkedAt))}</span>` : '<span>not checked</span>';
            const toggle = w.shouldHaveShards
                ? `<button class="btn-outline" data-act="drain" data-id="${esc(w.id)}" title="Stop placing shards here and move existing shards away">Drain</button>`
                : `<button class="btn-outline" data-act="activate" data-id="${esc(w.id)}">Activate</button>`;
            return `<article class="wk-card">
                <h4><span>${esc(w.name)}</span><span class="badge wk-st-${esc(w.status)}">${esc(w.status)}</span></h4>
                <div class="mono">${esc(w.host)}:${esc(w.port)}${w.citusNodeId != null ? ` · node ${esc(w.citusNodeId)}` : ''}</div>
                <div class="wk-meta"><span class="wk-chip">${esc(w.shardCount)} shards</span>${labels}</div>
                <div class="wk-meta">${h}</div>
                ${w.lastError ? `<div class="wk-meta" style="color:var(--danger,#f87171)">${esc(w.lastError)}</div>` : ''}
                <div class="wk-actions">${toggle}
                    <button class="btn-outline" data-act="health" data-id="${esc(w.id)}">Check</button>
                    <button class="btn-outline" data-act="remove" data-id="${esc(w.id)}" data-name="${esc(w.name)}" style="color:var(--danger,#f87171)">Remove</button></div>
            </article>`;
        }).join('');
    }

    function renderTables(rows) {
        $('wkTables').innerHTML = rows.length ? rows.map(t => `<tr><td>${esc(t.schema)}.${esc(t.table)}</td><td>${esc(t.type)}</td><td>${esc(t.distributionColumn || '—')}</td><td>${esc(t.shardCount)}</td><td>${esc(fmtBytes(t.sizeBytes))}</td></tr>`).join('')
            : `<tr><td colspan="5" style="color:var(--text-muted)">No distributed tables yet.</td></tr>`;
    }
    function renderJobs(rows) {
        $('wkJobs').innerHTML = rows.length ? rows.map(j => `<tr><td>#${esc(j.jobId)} ${esc(j.description || j.type)}</td><td><span class="badge wk-st-${j.state === 'running' || j.state === 'scheduled' ? 'DRAINING' : j.state === 'finished' ? 'ACTIVE' : 'DOWN'}">${esc(j.state)}</span></td><td>${esc(fmtDate(j.startedAt))}</td><td>${esc(fmtDate(j.finishedAt))}</td></tr>`).join('')
            : `<tr><td colspan="4" style="color:var(--text-muted)">No rebalance jobs.</td></tr>`;
        clearTimeout(timer);
        if (rows.some(j => j.state === 'running' || j.state === 'scheduled')) timer = setTimeout(load, 5000);
    }
    function renderEvents(rows) {
        $('wkEvents').innerHTML = rows.length ? rows.map(e => `<tr><td>${esc(fmtDate(e.createdAt))}</td><td>${esc(e.action)}</td><td>${esc(e.actor)}</td><td style="max-width:360px;overflow-wrap:anywhere;font-size:.78rem;color:var(--text-muted)">${esc(JSON.stringify(e.detail))}</td></tr>`).join('')
            : `<tr><td colspan="4" style="color:var(--text-muted)">No changes recorded.</td></tr>`;
    }

    async function load() {
        try {
            const [data, tables, jobs, events] = await Promise.all([api(''), api('/tables'), api('/rebalance/status'), api('/events?limit=15')]);
            renderStatus(data); renderWorkers(data.workers); renderTables(tables); renderJobs(jobs); renderEvents(events);
        } catch (e) {
            $('wkStatus').innerHTML = `<div class="wk-banner err"><i class="fas fa-triangle-exclamation"></i><div>${esc(e.message)}</div></div>`;
        }
    }

    function parseLabels(s) {
        const out = {};
        s.split(',').map(x => x.trim()).filter(Boolean).forEach(p => { const i = p.indexOf('='); if (i < 1) throw new Error(`Label "${p}" must be key=value`); out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
        return out;
    }

    function init() {
        $('wkAddToggle').onclick = () => { $('wkAddForm').hidden = !$('wkAddForm').hidden; if (!$('wkAddForm').hidden) $('wkName').focus(); };
        $('wkCancel').onclick = () => { $('wkAddForm').hidden = true; };
        $('wkRefresh').onclick = load;
        $('wkHealth').onclick = (e) => act(e.currentTarget, () => api('/health', { method: 'POST', body: '{}' }), 'Health check complete');
        $('wkSync').onclick = (e) => act(e.currentTarget, async () => { const r = await api('/sync', { method: 'POST', body: '{}' }); toast(`Synced: ${r.imported} imported, ${r.drift} drifted`); });
        $('wkRebalance').onclick = (e) => { if (confirm('Rebalance shards across all active workers now? Writes to a shard may pause briefly while it moves.')) act(e.currentTarget, () => api('/rebalance', { method: 'POST', body: '{}' }), 'Rebalance started'); };
        $('wkAddForm').onsubmit = (ev) => {
            ev.preventDefault();
            act($('wkSubmit'), async () => {
                await api('', { method: 'POST', body: JSON.stringify({ name: $('wkName').value.trim(), host: $('wkHost').value.trim(), port: Number($('wkPort').value), labels: parseLabels($('wkLabels').value), shouldHaveShards: $('wkShards').checked }) });
                $('wkAddForm').reset(); $('wkAddForm').hidden = true;
            }, 'Worker registered');
        };
        $('wkDistForm').onsubmit = (ev) => {
            ev.preventDefault();
            act(ev.submitter, async () => { await api('/tables/distribute', { method: 'POST', body: JSON.stringify({ schema: $('dSchema').value.trim(), table: $('dTable').value.trim(), column: $('dColumn').value.trim() }) }); $('wkDistForm').reset(); }, 'Table distributed');
        };
        $('wkGrid').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]'); if (!b) return;
            const id = encodeURIComponent(b.dataset.id);
            if (b.dataset.act === 'remove') { if (confirm(`Remove worker "${b.dataset.name}"? It must hold no shards.`)) act(b, () => api(`/${id}`, { method: 'DELETE' }), 'Worker removed'); }
            else if (b.dataset.act === 'drain') { if (confirm('Drain this worker? New shards stop landing here and existing shards move to other workers.')) act(b, () => api(`/${id}/drain`, { method: 'POST', body: '{}' }), 'Drain started'); }
            else act(b, () => api(`/${id}/${b.dataset.act}`, { method: 'POST', body: '{}' }), 'Done');
        });
    }
    window.WorkersTab = { init, load };
})();
