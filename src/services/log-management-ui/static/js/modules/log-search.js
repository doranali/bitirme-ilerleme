/**
 * LogPanel.modules.logSearch — Log arama tab modulu (Faz 2).
 *
 * Sorumluluklar:
 *  - Tam metin sorgu + zaman araligi + filtre + limit
 *  - Sonuc tablosu, satira tiklayinca tam mesaj modal
 *  - Kaydedilmis aramalar (CRUD)
 *  - CSV export
 */
(function attachLogSearchModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.logSearch && NS.modules.logSearch.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    const state = {
        lastResults: [],
        lastQuery: null,
        searching: false
    };

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

    function readForm() {
        const filters = {};
        const src = ($('#lp-search-filter-source') || {}).value;
        if (src && src.trim()) filters.source = src.trim();
        const inp = ($('#lp-search-filter-input') || {}).value;
        if (inp && inp.trim()) filters.gl2_source_input = inp.trim();
        return {
            query: ($('#lp-search-query') || {}).value || '*',
            range: ($('#lp-search-range') || {}).value || '24h',
            limit: Number(($('#lp-search-limit') || {}).value) || 100,
            filters
        };
    }

    function fmtLevel(level) {
        const n = Number(level);
        if (!Number.isFinite(n)) return level || '-';
        const labels = ['Emerg', 'Alert', 'Crit', 'Err', 'Warn', 'Notice', 'Info', 'Debug'];
        const cls = n <= 3 ? 'badge-danger' : (n === 4 ? 'badge-warning' : (n === 5 ? 'badge-info' : 'badge-success'));
        return `<span class="badge ${cls}" title="syslog level ${n}">${labels[n] || n}</span>`;
    }

    function fmtTimestamp(ts) {
        if (!ts) return '-';
        try {
            const d = new Date(ts);
            if (Number.isNaN(d.getTime())) return ts;
            return d.toLocaleString('tr-TR', { hour12: false });
        } catch (_) { return ts; }
    }

    function renderResults(data) {
        const root = $('#lp-search-results');
        const countBadge = $('#lp-search-result-count');
        const exportBtn = $('#lp-search-export-btn');
        if (!root) return;

        const messages = Array.isArray(data.messages) ? data.messages : [];
        state.lastResults = messages;
        state.lastQuery = data.query || null;

        if (countBadge) countBadge.textContent = `${data.totalResults ?? messages.length} sonuç`;
        if (exportBtn) exportBtn.disabled = messages.length === 0;

        if (messages.length === 0) {
            ui.emptyState(root, {
                title: 'Sonuç yok',
                message: 'Sorgu hiç log eşleştirmedi. Sorguyu veya zaman aralığını genişletin.',
                icon: 'fa-magnifying-glass'
            });
            return;
        }

        const rows = messages.map((m, idx) => `
            <tr class="lp-search-row" data-idx="${idx}">
                <td class="lp-search-ts" style="white-space:nowrap;">${ui.escapeHtml(fmtTimestamp(m.timestamp))}</td>
                <td>${ui.escapeHtml(m.source || '-')}</td>
                <td>${m.level !== undefined && m.level !== null ? fmtLevel(m.level) : '-'}</td>
                <td class="lp-search-msg">${ui.escapeHtml(String(m.message || '').slice(0, 220))}${(m.message && m.message.length > 220) ? '…' : ''}</td>
            </tr>
        `).join('');

        root.innerHTML = `
            <div class="table-wrapper">
                <table class="table lp-search-table">
                    <thead>
                        <tr>
                            <th style="width:170px;">Zaman</th>
                            <th style="width:160px;">Kaynak</th>
                            <th style="width:90px;">Seviye</th>
                            <th>Mesaj</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="help-text" style="margin-top:0.5rem;">Sorgu süresi: ${data.time ?? '—'} ms · İndeksler: ${(data.usedIndices || []).slice(0, 4).map(i => i.index_name || i).join(', ') || '—'}</div>
        `;

        $$('.lp-search-row', root).forEach(tr => {
            tr.addEventListener('click', () => {
                const idx = Number(tr.getAttribute('data-idx'));
                showMessageDetail(messages[idx]);
            });
        });
    }

    function showMessageDetail(msg) {
        if (!msg) return;
        const detailJson = JSON.stringify(msg, null, 2);
        const overlay = document.createElement('div');
        overlay.className = 'lp-confirm-overlay';
        overlay.innerHTML = `
            <div class="lp-confirm-card" style="max-width:760px; max-height:80vh; overflow:auto;">
                <h4>Log mesajı detayı</h4>
                <div style="display:flex; gap:0.5rem; margin-bottom:0.5rem; flex-wrap:wrap;">
                    <span class="badge badge-info">${ui.escapeHtml(fmtTimestamp(msg.timestamp))}</span>
                    <span class="badge badge-secondary">${ui.escapeHtml(msg.source || '-')}</span>
                    ${(msg.level !== undefined) ? fmtLevel(msg.level) : ''}
                </div>
                <pre style="background:var(--bg-main); border:1px solid var(--color-border); border-radius:0.4rem; padding:0.75rem; max-height:50vh; overflow:auto; font-family:ui-monospace,monospace; font-size:0.82rem;"></pre>
                <div class="lp-confirm-actions" style="margin-top:0.85rem;">
                    <button class="btn btn-secondary lp-detail-copy"><i class="fas fa-copy"></i> JSON'u kopyala</button>
                    <button class="btn btn-primary lp-detail-close">Kapat</button>
                </div>
            </div>
        `;
        overlay.querySelector('pre').textContent = detailJson;
        const cleanup = () => { try { overlay.remove(); } catch (_) {} };
        overlay.querySelector('.lp-detail-copy').addEventListener('click', () => {
            ui.copyToClipboard(detailJson).then(() => ui.toast('JSON kopyalandı', 'success'));
        });
        overlay.querySelector('.lp-detail-close').addEventListener('click', cleanup);
        overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
        document.body.appendChild(overlay);
    }

    async function doSearch() {
        if (state.searching) return;
        const root = $('#lp-search-results');
        if (!root) return;
        state.searching = true;
        try {
            ui.loadingState(root, { message: 'Aranıyor...' });
            const form = readForm();
            const data = await api.post('/api/logs/search', form, { timeoutMs: 30000 });
            renderResults(data);
        } catch (e) {
            ui.errorState(root, e, { title: 'Arama yapılamadı', retry: doSearch });
            const cb = $('#lp-search-result-count');
            if (cb) cb.textContent = 'hata';
        } finally {
            state.searching = false;
        }
    }

    function exportCsv() {
        if (!state.lastResults.length) {
            ui.toast('Önce bir arama yapın', 'warning');
            return;
        }
        const cols = ['timestamp', 'source', 'level', 'facility', 'input', 'message'];
        const escape = (v) => {
            const s = (v === null || v === undefined) ? '' : String(v);
            if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        const header = cols.join(',');
        const rows = state.lastResults.map(m => cols.map(c => escape(m[c])).join(','));
        const csv = [header, ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url; a.download = `log-search-${stamp}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ui.toast('CSV indirildi', 'success');
    }

    async function loadSavedSearches() {
        const list = $('#lp-saved-list');
        if (!list) return;
        try {
            const data = await api.get('/api/logs/saved-searches');
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) {
                list.innerHTML = '<p class="help-text">Henüz kaydedilmiş arama yok. Bir arama yaptıktan sonra <strong>Bu aramayı kaydet</strong>\'e basın.</p>';
                return;
            }
            list.innerHTML = items.map(it => `
                <div class="lp-saved-item" data-id="${ui.escapeHtml(it.id)}">
                    <div class="lp-saved-meta">
                        <strong>${ui.escapeHtml(it.name)}</strong>
                        <span class="help-text">${ui.escapeHtml(it.range || '24h')} · ${ui.escapeHtml(it.query)}</span>
                    </div>
                    <div class="lp-saved-actions">
                        <button class="btn btn-sm btn-primary lp-saved-load" data-id="${ui.escapeHtml(it.id)}" title="Yükle"><i class="fas fa-arrow-up-from-bracket"></i></button>
                        <button class="btn btn-sm btn-danger lp-saved-del" data-id="${ui.escapeHtml(it.id)}" title="Sil"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `).join('');
            $$('.lp-saved-load', list).forEach(b => b.addEventListener('click', () => {
                const id = b.getAttribute('data-id');
                const it = items.find(x => x.id === id);
                if (!it) return;
                if ($('#lp-search-query')) $('#lp-search-query').value = it.query || '';
                if ($('#lp-search-range')) $('#lp-search-range').value = it.range || '24h';
                if (it.filters && it.filters.source && $('#lp-search-filter-source')) $('#lp-search-filter-source').value = it.filters.source;
                if (it.filters && it.filters.gl2_source_input && $('#lp-search-filter-input')) $('#lp-search-filter-input').value = it.filters.gl2_source_input;
                doSearch();
            }));
            $$('.lp-saved-del', list).forEach(b => b.addEventListener('click', async () => {
                const id = b.getAttribute('data-id');
                const ok = await ui.confirm({ title: 'Aramayı sil', message: 'Kaydedilmiş arama kalıcı olarak silinsin mi?', danger: true, okLabel: 'Sil' });
                if (!ok) return;
                try {
                    await api.del(`/api/logs/saved-searches/${encodeURIComponent(id)}`);
                    ui.toast('Silindi', 'success');
                    loadSavedSearches();
                } catch (e) {
                    ui.reportError(e, { title: 'Silme başarısız' });
                }
            }));
        } catch (e) {
            ui.errorState(list, e, { title: 'Kaydedilmiş aramalar alınamadı', retry: loadSavedSearches });
        }
    }

    async function saveCurrentSearch() {
        const form = readForm();
        if (!form.query || form.query === '*') {
            const ok = await ui.confirm({ title: 'Boş sorgu', message: 'Şu anda spesifik bir sorgu yok. Yine de kaydedilsin mi?' });
            if (!ok) return;
        }
        const name = global.prompt && global.prompt('Aramaya bir ad verin:');
        if (!name) return;
        try {
            await api.post('/api/logs/saved-searches', { name, query: form.query, range: form.range, filters: form.filters });
            ui.toast('Arama kaydedildi', 'success');
            loadSavedSearches();
        } catch (e) {
            ui.reportError(e, { title: 'Kaydetme başarısız' });
        }
    }

    function bindControls() {
        const btn = $('#lp-search-btn');
        if (btn && !btn.__bound) { btn.addEventListener('click', doSearch); btn.__bound = true; }

        const q = $('#lp-search-query');
        if (q && !q.__bound) {
            q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
            q.__bound = true;
        }

        const reset = $('#lp-search-reset-btn');
        if (reset && !reset.__bound) {
            reset.addEventListener('click', () => {
                ['lp-search-query', 'lp-search-filter-source', 'lp-search-filter-input'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                if ($('#lp-search-range')) $('#lp-search-range').value = '24h';
                if ($('#lp-search-limit')) $('#lp-search-limit').value = '100';
                ui.toast('Form temizlendi', { level: 'info', duration: 1500 });
            });
            reset.__bound = true;
        }

        const save = $('#lp-search-save-btn');
        if (save && !save.__bound) { save.addEventListener('click', saveCurrentSearch); save.__bound = true; }

        const exp = $('#lp-search-export-btn');
        if (exp && !exp.__bound) { exp.addEventListener('click', exportCsv); exp.__bound = true; }

        const refresh = $('#lp-saved-refresh-btn');
        if (refresh && !refresh.__bound) { refresh.addEventListener('click', loadSavedSearches); refresh.__bound = true; }
    }

    function init() {
        if (!api || !ui) return;
        bindControls();
    }

    NS.modules.logSearch = {
        __sealed: true,
        init,
        doSearch,
        loadSavedSearches
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            init();
            // tab acildiginda saved searches yukle
            const tab = document.getElementById('log-search');
            if (tab) {
                const observer = new MutationObserver(() => {
                    if (tab.classList.contains('active')) {
                        loadSavedSearches();
                        observer.disconnect();
                    }
                });
                observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
                if (tab.classList.contains('active')) loadSavedSearches();
            }
        }, 700);
    });
})(window);
