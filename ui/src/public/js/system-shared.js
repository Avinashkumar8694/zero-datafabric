/* /system: shared pieces (tab registry, plan list cache, limits editor). Loaded before the system-*.js tab files. */
(function () {
    const { esc } = DF;
    const mods = {};
    let planCache = null;

    const SYS = {
        register(name, mod) { mods[name] = mod; },
        mods,
        /** Full plan catalogue (cached; call with true to refetch). */
        async plans(force) {
            if (!planCache || force) { const r = await DF.api('/system/plans'); planCache = Array.isArray(r) ? r : (r.plans || []); }
            return planCache;
        },

        /** Limits editor: one number input per limit key; blank = not set; "Unlimited" box = -1.
            `values` is an object of current values. */
        limitsEditor(prefix, values, opts) {
            const o = opts || {};
            const v = values || {};
            return `<div class="ws-limits-grid">${DF.LIMITS.map(([k, label]) => {
                const cur = v[k];
                const unl = cur === -1;
                return `<div class="ws-field"><label for="${esc(prefix)}-${esc(k)}">${esc(label)}</label>
                    <input type="number" id="${esc(prefix)}-${esc(k)}" data-limit="${esc(k)}" min="0" step="1" value="${unl || cur === undefined || cur === null ? '' : esc(cur)}" placeholder="${esc(o.placeholder || 'Not set')}" ${unl ? 'disabled' : ''}>
                    <label class="ws-check" style="min-height:32px"><input type="checkbox" data-unl="${esc(k)}" ${unl ? 'checked' : ''}><span class="ws-small">Unlimited</span></label></div>`;
            }).join('')}</div>`;
        },
        bindLimitsEditor(root) {
            root.addEventListener('change', (e) => {
                const c = e.target.closest('input[data-unl]'); if (!c) return;
                const inp = root.querySelector(`input[data-limit="${c.dataset.unl}"]`);
                inp.disabled = c.checked; if (c.checked) inp.value = '';
            });
        },
        /** Read the editor back into {key: int}; throws on invalid numbers. */
        readLimits(root) {
            const out = {};
            root.querySelectorAll('input[data-limit]').forEach((inp) => {
                const k = inp.dataset.limit, unl = root.querySelector(`input[data-unl="${k}"]`).checked;
                if (unl) { out[k] = -1; return; }
                if (inp.value.trim() === '') return;
                const n = Number(inp.value);
                if (!Number.isInteger(n) || n < 0) throw new Error(`${DF.limitLabel(k)} must be a whole number of 0 or more`);
                out[k] = n;
            });
            return out;
        }
    };
    window.SYS = SYS;
})();
