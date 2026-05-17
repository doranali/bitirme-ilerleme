/**
 * LogPanel.modules.servicesExtra — Faz 4: Servis kategorileri + Kafka + ISM + Graylog hizli erisim.
 *
 * Mevcut services tab'inin ALTINA cikan ek kartlar; mevcut services
 * tablosuna dokunmaz (regression yok).
 */
(function attachServicesExtraModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.servicesExtra && NS.modules.servicesExtra.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    const CATEGORY_DEF = [
        { id: 'ingestion', title: 'Ingestion', icon: 'fa-arrow-down-to-bracket',
          services: ['fluent-bit', 'kafka1', 'kafka2', 'kafka3'] },
        { id: 'processing', title: 'Processing', icon: 'fa-microchip',
          services: ['graylog', 'graylog2', 'normalization', 'log-router'] },
        { id: 'storage', title: 'Storage', icon: 'fa-database',
          services: ['opensearch1', 'opensearch2', 'mongodb', 'mongodb1', 'mongodb2', 'minio'] },
        { id: 'compliance', title: 'Compliance', icon: 'fa-shield-halved',
          services: ['signing-engine', 'archive', 'log-archiver'] },
        { id: 'observability', title: 'Observability', icon: 'fa-chart-line',
          services: ['grafana', 'alert-webhook', 'prometheus', 'watchdog'] },
        { id: 'panel', title: 'Panel & Network', icon: 'fa-shield',
          services: ['log-management-ui', 'nginx-proxy-manager', 'post-init', 'log-system-setup'] },
    ];

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

    function getServicesSnapshot() {
        // dashboard.js global `services` objesini kullan; obje key=container_name
        if (global.services && typeof global.services === 'object') return global.services;
        return {};
    }

    function classify(serviceName, info) {
        const status = String((info && info.status) || '').toLowerCase();
        const health = String((info && info.health) || '').toLowerCase();
        if (health === 'unhealthy' || status === 'exited' || status === 'stopped' || status === 'created') return 'fail';
        if (status === 'running' && (health === 'healthy' || health === 'n/a' || !health)) return 'ok';
        if (status === 'running') return 'warn';
        return 'unknown';
    }

    function renderCategories() {
        const root = $('#lp-services-categories');
        if (!root) return;
        const snap = getServicesSnapshot();
        const presentNames = Object.keys(snap || {});
        if (presentNames.length === 0) {
            root.innerHTML = '<p class="loading">—</p>';
            return;
        }

        root.innerHTML = CATEGORY_DEF.map(cat => {
            const matched = cat.services.filter(name => presentNames.some(p => p.toLowerCase() === name.toLowerCase() || p.toLowerCase().includes(name.toLowerCase())));
            const tracked = matched.map(name => {
                const k = presentNames.find(p => p.toLowerCase() === name.toLowerCase()) || presentNames.find(p => p.toLowerCase().includes(name.toLowerCase()));
                return { name: k || name, info: snap[k] || {} };
            });
            const okCount = tracked.filter(t => classify(t.name, t.info) === 'ok').length;
            const failCount = tracked.filter(t => classify(t.name, t.info) === 'fail').length;
            const warnCount = tracked.filter(t => classify(t.name, t.info) === 'warn').length;
            const totalCount = tracked.length;

            const headerCls = failCount > 0 ? 'lp-cat-fail' : (warnCount > 0 ? 'lp-cat-warn' : 'lp-cat-ok');

            return `
                <div class="lp-cat-card ${headerCls}">
                    <div class="lp-cat-head">
                        <div class="lp-cat-icon"><i class="fas ${cat.icon}"></i></div>
                        <div>
                            <div class="lp-cat-title">${ui.escapeHtml(cat.title)}</div>
                            <div class="lp-cat-summary">${okCount}/${totalCount} sağlıklı</div>
                        </div>
                    </div>
                    <div class="lp-cat-services">
                        ${tracked.map(t => {
                            const c = classify(t.name, t.info);
                            const dot = c === 'ok' ? 'lp-dot-ok' : (c === 'warn' ? 'lp-dot-warn' : (c === 'fail' ? 'lp-dot-fail' : 'lp-dot-unknown'));
                            return `<div class="lp-cat-service" title="${ui.escapeHtml(t.info.health || t.info.status || '-')}">
                                <span class="lp-status-dot ${dot}"></span>
                                <span>${ui.escapeHtml(t.name)}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }

    async function loadLiveSummary() {
        const root = $('#lp-live-summary-content');
        if (!root) return;
        if (!api) return;
        root.textContent = 'Yükleniyor...';
        try {
            const data = await api.get('/api/services/live-summary', { timeoutMs: 25000 });
            root.textContent = JSON.stringify(data, null, 2);
        } catch (e) {
            root.textContent = 'Özet alınamadı: ' + (e && e.message ? e.message : String(e));
        }
    }

    async function loadKafka() {
        const root = $('#lp-kafka-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Kafka durumu yükleniyor...' });
        try {
            const data = await api.get('/api/services/kafka', { timeoutMs: 30000 });
            const topics = Array.isArray(data.topics) ? data.topics : [];
            if (topics.length === 0) {
                ui.emptyState(root, { title: 'Topic yok', message: 'Kafka cluster\'ında topic bulunamadı.' });
                return;
            }
            const rows = topics.map(t => `
                <tr>
                    <td><strong>${ui.escapeHtml(t.name)}</strong></td>
                    <td>${t.partitions ?? '-'}</td>
                    <td>${t.replicationFactor ?? '-'}</td>
                    <td>${t.lag > 0 ? `<span class="badge badge-warning">${t.lag}</span>` : '<span class="badge badge-success">0</span>'}</td>
                </tr>
            `).join('');
            root.innerHTML = `
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Topic</th><th>Partition</th><th>Replication</th><th>Toplam Lag</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        } catch (e) {
            ui.errorState(root, e, { title: 'Kafka durumu alınamadı', retry: loadKafka });
        }
    }

    async function loadIsm() {
        const root = $('#lp-ism-content');
        if (!root) return;
        ui.loadingState(root, { message: 'ISM politikası yükleniyor...' });
        try {
            const data = await api.get('/api/services/opensearch-ism', { timeoutMs: 15000 });
            const days = data.transitionDays || {};
            const states = data.states || [];
            const stateBadges = states.map(s => `<span class="badge badge-info" style="margin-right:0.3rem;">${ui.escapeHtml(s)}${days[s] ? ` (${days[s]}d)` : ''}</span>`).join('');
            root.innerHTML = `
                <div class="help-text">Aktif policy: <code>${ui.escapeHtml(data.policyId || '-')}</code></div>
                <div style="margin-top:0.4rem;">${stateBadges || '<span class="help-text">Durum bulunamadı.</span>'}</div>
                <details style="margin-top:0.6rem;"><summary class="help-text">Ham JSON</summary><pre style="background:var(--bg-main); padding:0.6rem; border-radius:0.4rem; max-height:240px; overflow:auto; font-size:0.78rem;"></pre></details>
            `;
            const pre = root.querySelector('pre');
            if (pre) pre.textContent = JSON.stringify(data.raw || {}, null, 2);
        } catch (e) {
            ui.errorState(root, e, { title: 'ISM politikası alınamadı', retry: loadIsm });
        }
    }

    function bindGraylogLinks() {
        const root = $('#lp-graylog-quick-links');
        if (!root) return;
        const host = (global.location && global.location.hostname) || 'localhost';
        const baseGuess = `http://${host}:9000`;
        $$('a[data-graylog-path]', root).forEach(a => {
            const path = a.getAttribute('data-graylog-path') || '';
            a.href = baseGuess + path;
        });
    }

    function bindRefresh() {
        const cat = $('#lp-services-cat-refresh');
        if (cat && !cat.__bound) {
            cat.addEventListener('click', () => {
                if (typeof global.loadServices === 'function') global.loadServices();
                setTimeout(renderCategories, 600);
            });
            cat.__bound = true;
        }
        const kf = $('#lp-kafka-refresh');
        if (kf && !kf.__bound) { kf.addEventListener('click', loadKafka); kf.__bound = true; }
        const live = $('#lp-live-summary-refresh');
        if (live && !live.__bound) {
            live.addEventListener('click', loadLiveSummary);
            live.__bound = true;
        }
    }

    function init() {
        if (!api || !ui) return;
        bindRefresh();
        bindGraylogLinks();
        // services tab acildiginda kategori render et (50 sn de bir auto-render)
        const tab = document.getElementById('services');
        if (tab) {
            const observer = new MutationObserver(() => {
                if (tab.classList.contains('active')) {
                    renderCategories();
                    loadLiveSummary();
                    loadKafka();
                    loadIsm();
                }
            });
            observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
            if (tab.classList.contains('active')) {
                renderCategories();
                loadKafka();
                loadIsm();
            }
        }
        // periyodik kategori yenilemesi
        setInterval(() => {
            const t = document.getElementById('services');
            if (t && t.classList.contains('active')) renderCategories();
        }, 30000);
    }

    NS.modules.servicesExtra = {
        __sealed: true,
        init,
        loadKafka,
        loadIsm,
        loadLiveSummary,
        renderCategories
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 800);
    });
})(window);
