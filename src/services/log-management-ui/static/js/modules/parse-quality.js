/**
 * Parse Kalitesi — quality_control stream özeti + keşif (vendor|product|os_major).
 */
(function attachParseQualityModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.parseQuality && NS.modules.parseQuality.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    function $(s, r) { return (r || document).querySelector(s); }

    async function loadDiscoveries(range) {
        const data = await api.get(`/api/parse/discoveries?range=${encodeURIComponent(range || '24h')}`, { timeoutMs: 35000 });
        return data;
    }

    async function refresh() {
        const root = $('#lp-parse-quality-body');
        if (!root || !api) return;
        ui.loadingState(root, { message: 'QC + keşif yükleniyor...' });
        const range = '24h';
        try {
            const [qc, disc] = await Promise.all([
                api.get(`/api/parse/qc-summary?range=${range}`, { timeoutMs: 30000 }),
                loadDiscoveries(range),
            ]);

            const srcRows = (qc.topSources || []).map(
                row => `<tr><td><code>${ui.escapeHtml(String(row.key))}</code></td><td>${row.count}</td></tr>`
            ).join('');
            const samp = (qc.samples || []).map((s) => {
                const txt = ui.escapeHtml((s.message || '').slice(0, 400));
                return `<tr><td style="white-space:nowrap;font-size:0.82rem;">${ui.escapeHtml(s.timestamp || '—')}</td>`
                    + `<td>${ui.escapeHtml(s.source || '—')}</td>`
                    + `<td><code style="font-size:0.78rem;">${ui.escapeHtml(s.normalization_profile || '—')}</code></td>`
                    + `<td style="max-width:420px;overflow:hidden;text-overflow:ellipsis;" title="${txt}">${txt}</td>`
                    + `<td><button type="button" class="btn btn-sm btn-secondary lp-copy-sample" data-sample="${encodeURIComponent(s.message || '')}">Kopyala</button></td></tr>`;
            }).join('');

            const discRows = (disc.discoveries || []).map((d) => {
                const lk = ui.escapeHtml(d.lookupKey || '');
                const snip = (d.samples && d.samples[0] && (d.samples[0].message || d.samples[0].full_message)) || '';
                const msg = ui.escapeHtml(String(snip).slice(0, 200));
                return `<tr data-lk="${ui.escapeHtml(d.lookupKey || '')}" data-v="${ui.escapeHtml(d.vendor || '')}" data-p="${ui.escapeHtml(d.product || '')}" data-o="${ui.escapeHtml(d.os_major || '')}">
                    <td><code style="font-size:0.78rem;">${lk}</code></td>
                    <td>${d.count ?? '—'}</td>
                    <td style="max-width:240px;" class="help-text" title="${msg}">${msg || '—'}</td>
                    <td style="white-space:nowrap;">
                        <button type="button" class="btn btn-sm btn-secondary lp-parse-suppress">3g sustur</button>
                        <button type="button" class="btn btn-sm btn-primary lp-parse-profile">Profil</button>
                    </td>
                </tr>`;
            }).join('');

            root.innerHTML = `
                <p class="help-text">Yaklaşık toplam (24s): <strong>${qc.totalApprox != null ? qc.totalApprox : '—'}</strong>
                · Stream: <code>${ui.escapeHtml(qc.qualityControlStreamId || '')}</code></p>
                ${qc.note ? `<p class="help-text" style="color:var(--warning);">${ui.escapeHtml(qc.note)}</p>` : ''}
                ${disc.note ? `<p class="help-text" style="color:var(--warning);">${ui.escapeHtml(disc.note)}</p>` : ''}
                ${qc.vendorPackHint ? `<p class="help-text" style="font-size:0.82rem;">${ui.escapeHtml(qc.vendorPackHint)}</p>` : ''}
                <p class="help-text">Susturma: <strong>${disc.suppressionsActive ?? 0}</strong> · Keşif: <strong>${(disc.discoveries || []).length}</strong></p>

                <div class="grid-2" style="gap:1rem;">
                    <div>
                        <h5 style="margin:0 0 0.5rem;">Kaynak kırılımı</h5>
                        <div class="table-wrapper">
                            <table class="table"><thead><tr><th>Kaynak</th><th>Adet</th></tr></thead>
                            <tbody>${srcRows || '<tr><td colspan="2" class="help-text">Kayıt yok veya agregasyon yok</td></tr>'}</tbody></table>
                        </div>
                    </div>
                    <div>
                        <h5 style="margin:0 0 0.5rem;">Örnek mesajlar</h5>
                        <div class="table-wrapper">
                            <table class="table"><thead><tr><th>Zaman</th><th>Src</th><th>Profil</th><th>Mesaj</th><th></th></tr></thead>
                            <tbody>${samp || '<tr><td colspan="5" class="help-text">Örnek yok</td></tr>'}</tbody></table>
                        </div>
                    </div>
                </div>

                <div style="margin-top:1.25rem;">
                    <h5 style="margin:0 0 0.5rem;">Yeni format keşfi (QC üçlüleri)</h5>
                    <div class="table-wrapper">
                        <table class="table">
                            <thead><tr><th>lookupKey</th><th>Adet</th><th>Örnek</th><th></th></tr></thead>
                            <tbody>${discRows || '<tr><td colspan="4" class="help-text">Keşif yok veya OpenSearch multi_terms desteklenmiyor.</td></tr>'}</tbody>
                        </table>
                    </div>
                </div>
            `;
            root.querySelectorAll('.lp-copy-sample').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const raw = decodeURIComponent(btn.getAttribute('data-sample') || '');
                    navigator.clipboard.writeText(raw).then(() => {
                        btn.textContent = 'OK';
                        setTimeout(() => { btn.textContent = 'Kopyala'; }, 1200);
                    }).catch(() => {});
                });
            });
            root.querySelectorAll('.lp-parse-suppress').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const tr = btn.closest('tr');
                    if (!tr || !api) return;
                    const lk = tr.getAttribute('data-lk') || '';
                    btn.disabled = true;
                    try {
                        await api.post('/api/parse/suppress', { lookupKey: lk, days: 3 });
                        btn.textContent = 'OK';
                        await refresh();
                    } catch (e) {
                        btn.disabled = false;
                        ui.toast((e && e.message) ? e.message : String(e), { level: 'danger', title: 'İstek başarısız' });
                    }
                });
            });
            root.querySelectorAll('.lp-parse-profile').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const tr = btn.closest('tr');
                    if (!tr || !api) return;
                    const body = {
                        vendor: tr.getAttribute('data-v') || '',
                        product: tr.getAttribute('data-p') || '',
                        os_major: tr.getAttribute('data-o') || 'unknown',
                        srcField: 'src',
                        dstField: 'dst',
                    };
                    btn.disabled = true;
                    try {
                        await api.post('/api/parse/profile', body);
                        btn.textContent = 'OK';
                        await refresh();
                    } catch (e) {
                        btn.disabled = false;
                        ui.toast((e && e.message) ? e.message : String(e), { level: 'danger', title: 'İstek başarısız' });
                    }
                });
            });
        } catch (e) {
            ui.errorState(root, e, { title: 'Parse kalitesi / keşif alınamadı', retry: refresh });
        }
    }

    function initBind() {
        const b = $('#lp-parse-quality-refresh');
        if (b && !b.__bound) {
            b.addEventListener('click', refresh);
            b.__bound = true;
        }
    }

    NS.modules.parseQuality = {
        __sealed: true,
        refresh,
        initBind,
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initBind, 400);
    });
})(window);
