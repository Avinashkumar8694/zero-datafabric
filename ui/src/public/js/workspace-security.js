/* /settings: Security tab. IP allow-list editor with add/remove chips and a lock-out warning. */
(function () {
    const { esc, $ } = DF;
    const MAX = 50;
    let saved = [], list = [], ws = null;

    function validIp(v) {
        const [ip, bits, extra] = v.split('/');
        if (extra !== undefined || !ip) return false;
        let max;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { if (ip.split('.').some((o) => Number(o) > 255)) return false; max = 32; }
        else if (ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip) && ip.split(':').length >= 3 && ip.split(':').length <= 9) max = 128;
        else return false;
        if (bits === undefined) return true;
        return /^\d{1,3}$/.test(bits) && Number(bits) <= max;
    }
    const dirty = () => JSON.stringify(list) !== JSON.stringify(saved);

    function renderChips() {
        const dis = !ws.canEditSettings;
        $('ipChips').innerHTML = list.length
            ? list.map((ip, i) => `<span class="ws-chip">${esc(ip)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(ip)}" ${dis ? 'disabled' : ''}>&times;</button></span>`).join('')
            : '<span class="ws-muted ws-small">No restriction: every address can reach this workspace.</span>';
        const warn = $('ipLockWarn');
        warn.hidden = !list.length;
        if ($('ipSave')) { $('ipSave').disabled = !dirty(); $('ipReset').disabled = !dirty(); }
        $('ipCount').textContent = `${list.length} of ${MAX} entries`;
    }

    function addFromInput() {
        const inp = $('ipInput'), err = $('ipErr');
        err.hidden = true;
        const parts = inp.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        if (!parts.length) return;
        const bad = parts.filter((p) => !validIp(p));
        if (bad.length) { err.textContent = `Not a valid IP address or CIDR range: ${bad.join(', ')}`; err.hidden = false; return; }
        const next = [...new Set([...list, ...parts])];
        if (next.length > MAX) { err.textContent = `At most ${MAX} entries are allowed.`; err.hidden = false; return; }
        list = next; inp.value = ''; renderChips(); inp.focus();
    }

    async function save() {
        const btn = $('ipSave'), err = $('ipErr');
        err.hidden = true;
        const ok = await DF.confirm(list.length ? {
            title: 'Restrict access by IP?', confirmText: 'Save allow-list', danger: true,
            message: ['Only the addresses below will be able to reach this workspace. Every other address is rejected, including yours if it is not listed.', 'If you lock yourself out, a platform admin must clear the list.'],
            list
        } : {
            title: 'Remove the IP restriction?', confirmText: 'Remove restriction',
            message: 'With an empty list every address can reach this workspace.'
        });
        if (!ok) return;
        DF.busy(btn, true, 'Saving…');
        try {
            await DF.api('/workspace/settings/security', { method: 'PUT', json: { allowedIps: list } });
            ws.data.settings = await DF.api('/workspace/settings');
            saved = [...((ws.data.settings.security || {}).allowedIps || [])]; list = [...saved];
            DF.toast('Allow-list saved', 'ok');
        } catch (e) { err.textContent = DF.errMsg(e); err.hidden = false; DF.toast(DF.errMsg(e), 'err'); }
        finally { DF.busy(btn, false); renderChips(); }
    }

    WS.register('security', {
        render(w) {
            ws = w;
            saved = [...(((w.data.settings || {}).security || {}).allowedIps || [])]; list = [...saved];
            const dis = !w.canEditSettings;
            $('tab-security').innerHTML = `${w.readonlyNote()}
            <div class="ws-card">
                <div class="ws-card-head"><h3><i class="fas fa-shield-halved" aria-hidden="true"></i> IP allow-list</h3><span class="ws-muted ws-small" id="ipCount"></span></div>
                <p class="ws-card-desc">Restrict this workspace to specific IP addresses or CIDR ranges (for example <span class="ws-mono">203.0.113.7</span> or <span class="ws-mono">10.0.0.0/16</span>). An empty list allows every address.</p>
                <div class="wk-banner warn" id="ipLockWarn" role="note" hidden><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><div><strong>Lock-out risk.</strong> Once saved, requests from any address not listed here are rejected, including yours. Add the address you are connecting from before saving.</div></div>
                <div class="ws-chips" id="ipChips" aria-live="polite"></div>
                ${dis ? '' : `<div class="ws-add-row"><input id="ipInput" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="203.0.113.7 or 10.0.0.0/16" aria-label="IP address or CIDR range"><button type="button" class="btn-outline" id="ipAdd"><i class="fas fa-plus" aria-hidden="true"></i> Add</button></div>
                <span class="ws-hint">Add several at once separated by commas or spaces. IPv4 ranges are matched by CIDR; IPv6 entries match exactly.</span>`}
                <div class="ws-inline-err" id="ipErr" role="alert" hidden></div>
                ${dis ? '' : '<div class="ws-actions"><button type="button" class="btn-outline" id="ipReset" disabled>Reset</button><button type="button" class="btn-primary" id="ipSave" disabled>Save allow-list</button></div>'}
            </div>`;
            renderChips();
            if (dis) return;
            $('ipAdd').onclick = addFromInput;
            $('ipInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } });
            $('ipChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-rm]'); if (b) { list.splice(Number(b.dataset.rm), 1); renderChips(); } });
            $('ipReset').onclick = () => { list = [...saved]; $('ipErr').hidden = true; renderChips(); };
            $('ipSave').onclick = save;
        }
    });
})();
