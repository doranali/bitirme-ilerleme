/**
 * LogPanel.modules.compliance — 5651 Compliance Merkezi (Faz 3).
 *
 * Sorumluluklar:
 *  - Alt sekme yonlendirme (archive-status / archive-signing / archive-verify)
 *  - Imza gecmisi (timeline) — /api/compliance/history
 *  - Hash dogrulama formu — /api/compliance/verify-manifest
 *  - Hukuki rapor uretici — /api/compliance/legal-report (JSON indirir)
 */
(function attachComplianceModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.compliance && NS.modules.compliance.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    const state = { historyLoaded: false, lastHistory: null };

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

    function bindSubtabs() {
        const archive = document.getElementById('archive');
        if (!archive) return;
        const buttons = $$('.lp-subtab-btn[data-subtab]', archive);
        const panes = $$('.lp-subtab-pane[data-subtab-pane]', archive);
        if (buttons.length === 0) return;

        buttons.forEach(btn => {
            if (btn.__bound) return;
            btn.__bound = true;
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-subtab');
                buttons.forEach(b => {
                    const active = b === btn;
                    b.classList.toggle('lp-subtab-active', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                panes.forEach(p => {
                    const active = p.getAttribute('data-subtab-pane') === target;
                    p.classList.toggle('lp-subtab-pane-active', active);
                    if (active) p.removeAttribute('hidden');
                    else p.setAttribute('hidden', '');
                });
                if (target === 'archive-signing' && !state.historyLoaded) {
                    loadHistory();
                }
            });
        });
    }

    function fmtBytes(n) { return ui.formatBytes(n); }

    function shortHash(h) {
        if (!h) return '—';
        const s = String(h);
        return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
    }

    function badgeFor(entry) {
        if (entry.signed && entry.worm) return '<span class="badge badge-success">İmzalı + WORM</span>';
        if (entry.signed) return '<span class="badge badge-info">İmzalı</span>';
        if (entry.worm) return '<span class="badge badge-warning">WORM (imza yok)</span>';
        return '<span class="badge badge-danger">İmzasız</span>';
    }

    function renderSummary(data) {
        const el = $('#lp-compliance-summary');
        if (!el) return;
        const s = data.summary || {};
        const warnings = (data.warnings && data.warnings.length) ? `<div class="help-text" style="color:var(--color-warning); margin-top:0.4rem;">Uyarı: ${data.warnings.length} okuma sorunu (detay timeline'da).</div>` : '';
        const missing = (s.missingCount || 0) > 0 ? `<span class="badge badge-warning">Eksik gün: ${s.missingCount}</span>` : '<span class="badge badge-success">Eksik gün yok</span>';

        el.innerHTML = `
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
                <span class="badge badge-info">Toplam gün: ${s.total ?? 0}</span>
                <span class="badge badge-success">İmzalı: ${s.signed ?? 0}</span>
                <span class="badge badge-info">WORM: ${s.worm ?? 0}</span>
                ${missing}
                <span class="help-text">Pencere: son ${data.limitDays ?? '—'} gün</span>
            </div>
            ${warnings}
        `;
    }

    function renderTimeline(data) {
        const el = $('#lp-compliance-timeline');
        if (!el) return;
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (entries.length === 0) {
            ui.emptyState(el, { title: 'Henüz arşiv kaydı yok', message: 'Sistem yeni kuruldu veya log akışı başlamadı.', icon: 'fa-folder-open' });
            return;
        }

        el.innerHTML = entries.map(e => {
            const prevStatus = e.previousHash
                ? `<div class="lp-tl-chain" title="Bir önceki günün hash'i: ${ui.escapeHtml(e.previousHash)}">↗ Zincir: ${shortHash(e.previousHash)}</div>`
                : '<div class="lp-tl-chain" style="color:var(--text-muted);">— ilk gün</div>';
            const sig = e.signature ? `<div class="lp-tl-sig"><i class="fas fa-stamp"></i> ${ui.escapeHtml(e.signature)}</div>` : '';
            return `
                <div class="lp-tl-row" data-date="${ui.escapeHtml(e.date)}">
                    <div class="lp-tl-marker ${e.signed ? 'lp-tl-marker-ok' : 'lp-tl-marker-fail'}"></div>
                    <div class="lp-tl-card">
                        <div class="lp-tl-head">
                            <strong>${ui.escapeHtml(e.date)}</strong>
                            ${badgeFor(e)}
                            <span class="help-text">${fmtBytes(e.rawSize || 0)}</span>
                            ${e.signer ? `<span class="badge badge-info">${ui.escapeHtml(e.signer)}</span>` : ''}
                        </div>
                        <div class="lp-tl-body">
                            <div class="lp-tl-hash" title="${ui.escapeHtml(e.hash || '')}">
                                <i class="fas fa-fingerprint"></i>
                                <code>${e.hash ? shortHash(e.hash) : '— hash yok'}</code>
                                ${e.hash ? `<button class="lp-tl-copy" data-hash="${ui.escapeHtml(e.hash)}" title="Hash'i kopyala"><i class="fas fa-copy"></i></button>` : ''}
                            </div>
                            ${prevStatus}
                            ${sig}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        $$('.lp-tl-copy', el).forEach(btn => {
            btn.addEventListener('click', () => {
                const h = btn.getAttribute('data-hash') || '';
                ui.copyToClipboard(h).then(() => ui.toast('Hash kopyalandı', 'success'));
            });
        });
    }

    async function loadHistory() {
        const summary = $('#lp-compliance-summary');
        const timeline = $('#lp-compliance-timeline');
        if (!summary || !timeline) return;
        const sel = $('#lp-compliance-history-days');
        const days = sel ? Number(sel.value) || 90 : 90;

        ui.loadingState(timeline, { message: 'İmza geçmişi yükleniyor...' });
        summary.innerHTML = '<p class="loading">Hesaplanıyor...</p>';

        try {
            const data = await api.get('/api/compliance/history', { query: { days } });
            state.lastHistory = data;
            state.historyLoaded = true;
            renderSummary(data);
            renderTimeline(data);
        } catch (e) {
            summary.innerHTML = '';
            ui.errorState(timeline, e, { title: 'Tarihçe alınamadı', retry: loadHistory });
        }
    }

    function bindHistoryControls() {
        const refresh = $('#lp-compliance-history-refresh');
        if (refresh && !refresh.__bound) {
            refresh.addEventListener('click', () => { state.historyLoaded = false; loadHistory(); });
            refresh.__bound = true;
        }
        const sel = $('#lp-compliance-history-days');
        if (sel && !sel.__bound) {
            sel.addEventListener('change', () => { state.historyLoaded = false; loadHistory(); });
            sel.__bound = true;
        }
    }

    function bindVerify() {
        const btn = $('#lp-verify-submit');
        if (!btn || btn.__bound) return;
        btn.__bound = true;
        btn.addEventListener('click', async () => {
            const date = ($('#lp-verify-date') || {}).value || '';
            const hash = (($('#lp-verify-hash') || {}).value || '').trim().toLowerCase();
            const out = $('#lp-verify-result');
            if (!date) { ui.toast('Tarih seçin', 'warning'); return; }
            if (!hash || hash.length < 32) { ui.toast('Geçerli bir hash girin', 'warning'); return; }
            if (!out) return;

            ui.loadingState(out, { message: 'Karşılaştırılıyor...' });
            try {
                const r = await api.post('/api/compliance/verify-manifest', { date, hash });
                if (r.match) {
                    out.innerHTML = `
                        <div class="alert alert-success">
                            <i class="fas fa-circle-check"></i>
                            <strong>Eşleşti</strong> — ${ui.escapeHtml(date)} tarihindeki kayıt verdiğiniz hash ile <strong>aynı</strong>.
                            <div class="help-text" style="margin-top:0.35rem;">Kaynak: ${ui.escapeHtml(r.source || 'manifest.json')}</div>
                        </div>
                    `;
                } else {
                    out.innerHTML = `
                        <div class="alert alert-danger">
                            <i class="fas fa-circle-xmark"></i>
                            <strong>Eşleşmedi</strong> — ${ui.escapeHtml(date)} tarihindeki sistem kaydı farklı bir hash içeriyor.
                            <div class="help-text" style="margin-top:0.35rem; font-family:ui-monospace,monospace; word-break:break-all;">
                                Sistem: ${ui.escapeHtml(r.expectedHash || '')}<br>
                                Sizin: ${ui.escapeHtml(r.providedHash || '')}
                            </div>
                        </div>
                    `;
                }
            } catch (e) {
                ui.errorState(out, e, { title: 'Doğrulama yapılamadı' });
            }
        });
    }

    function bindLegalReport() {
        const btn = $('#lp-report-submit');
        if (!btn || btn.__bound) return;
        btn.__bound = true;

        const today = new Date();
        const monthAgo = new Date(today.getTime() - 30 * 86400000);
        const ymd = (d) => d.toISOString().slice(0, 10);
        const startEl = $('#lp-report-start');
        const endEl = $('#lp-report-end');
        if (startEl && !startEl.value) startEl.value = ymd(monthAgo);
        if (endEl && !endEl.value) endEl.value = ymd(today);

        btn.addEventListener('click', async () => {
            const start = (startEl || {}).value || '';
            const end = (endEl || {}).value || '';
            const out = $('#lp-report-result');
            if (!start || !end) { ui.toast('Başlangıç ve bitiş seçin', 'warning'); return; }
            if (!out) return;

            ui.loadingState(out, { message: 'Rapor üretiliyor...' });
            try {
                const r = await api.post('/api/compliance/legal-report', { start_date: start, end_date: end });
                const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `5651-compliance-report-${start}-${end}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                const s = r.summary || {};
                out.innerHTML = `
                    <div class="alert alert-success">
                        <i class="fas fa-circle-check"></i> Rapor üretildi (id: <code>${ui.escapeHtml(r.reportId || '-')}</code>) ve indirildi.
                    </div>
                    <div class="help-text" style="margin-top:0.5rem;">
                        Toplam gün: ${s.totalDays ?? 0} • İmzalı: ${s.signedDays ?? 0} • WORM: ${s.wormDays ?? 0} • Eksik: ${s.missingDays ?? 0}
                    </div>
                `;
            } catch (e) {
                ui.errorState(out, e, { title: 'Rapor üretilemedi' });
            }
        });
    }

    function init() {
        if (!api || !ui) return;
        bindSubtabs();
        bindHistoryControls();
        bindVerify();
        bindLegalReport();
    }

    NS.modules.compliance = {
        __sealed: true,
        init,
        loadHistory
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 700);
    });
})(window);
