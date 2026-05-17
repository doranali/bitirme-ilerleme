/**
 * LogPanel.modules.overview — Komuta Merkezi (Faz 1).
 *
 * Sorumluluklar:
 *  - 4 KPI karti: bugunku log hacmi, 24sa hata, agent fleet, son imza
 *  - "Bugun yapilmasi gerekenler" listesi (kosullu uyarilar)
 *  - Hizli eylemler bar (sign, backup, validate, refresh)
 *
 * Mevcut dashboard.js fonksiyonlarini yedekleme/dogrulama icin yeniden
 * kullanir (backupNow, validateAllConfigs vb. globalde mevcut).
 */
(function attachOverviewModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.overview && NS.modules.overview.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;
    const utils = global.DashboardUtils || {};

    const state = {
        lastRefresh: 0,
        refreshing: false,
        timer: null
    };

    function $(id) { return document.getElementById(id); }
    function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

    function fmtBytes(n) { return ui && ui.formatBytes ? ui.formatBytes(n) : `${n}`; }

    function fmtRelative(ts) {
        if (!ts) return '—';
        try {
            if (utils.formatRelativeTime) return utils.formatRelativeTime(ts);
            const d = new Date(ts);
            if (Number.isNaN(d.getTime())) return '—';
            return d.toLocaleString('tr-TR');
        } catch (_) { return '—'; }
    }

    async function safeGet(url, opt) {
        try {
            return { ok: true, data: await api.get(url, { timeoutMs: 10000, ...opt }) };
        } catch (e) {
            return { ok: false, error: e };
        }
    }

    function computeLogVolume(metrics) {
        if (!metrics || typeof metrics !== 'object') return null;
        const eps1 = Number(metrics.eps_1m || (metrics.eps && metrics.eps['1m']) || 0);
        const bytes24h = Number(metrics.bytes_24h || metrics.bytesLast24h || 0);
        if (bytes24h > 0) return { value: fmtBytes(bytes24h), sub: `EPS (1dk): ${eps1.toFixed(1)}` };
        if (eps1 > 0) return { value: `${(eps1 * 86400).toFixed(0)} olay/gün (tahmin)`, sub: `EPS (1dk): ${eps1.toFixed(1)}` };
        return { value: '—', sub: 'Henüz log akışı yok' };
    }

    function computeErrors(audit) {
        if (!audit || !Array.isArray(audit.events)) return null;
        const cutoff = Date.now() - 24 * 3600 * 1000;
        let total = 0;
        let failed = 0;
        let lastFailureTs = null;
        audit.events.forEach(ev => {
            const t = Date.parse(ev.timestamp || ev.time || '') || 0;
            if (t < cutoff) return;
            total += 1;
            const status = String(ev.status || ev.result || '').toLowerCase();
            if (status === 'failed' || status === 'error' || status === 'denied') {
                failed += 1;
                if (!lastFailureTs || t > lastFailureTs) lastFailureTs = t;
            }
        });
        return { total, failed, lastFailureTs };
    }

    function computeFleet(fleetOverview) {
        if (!fleetOverview || typeof fleetOverview !== 'object') return null;
        const total = Number(fleetOverview.total || (fleetOverview.summary && fleetOverview.summary.total) || (Array.isArray(fleetOverview.nodes) ? fleetOverview.nodes.length : 0));
        const online = Number(fleetOverview.online || (fleetOverview.summary && fleetOverview.summary.online) || 0);
        const offline = Number(fleetOverview.offline || (fleetOverview.summary && fleetOverview.summary.offline) || Math.max(0, total - online));
        return { total, online, offline };
    }

    function computeSigning(signing) {
        if (!signing || typeof signing !== 'object') return null;
        const lastIso = signing.last_signed_at || signing.lastSignedAt || (signing.last && signing.last.timestamp) || null;
        const lastStatus = String(signing.last_status || signing.lastStatus || '').toLowerCase();
        const reachable = signing.reachable !== false;
        const provider = signing.signer || signing.provider || signing.type || '—';
        return { lastIso, lastStatus, reachable, provider };
    }

    function renderKpis(snapshot) {
        const v = snapshot.logVolume;
        if (v) {
            setText('lp-kpi-logvolume', v.value);
            setText('lp-kpi-logvolume-sub', v.sub);
        } else {
            setText('lp-kpi-logvolume', '—');
            setText('lp-kpi-logvolume-sub', 'Veri yok');
        }

        const e = snapshot.errors;
        if (e) {
            setText('lp-kpi-errors', `${e.failed}`);
            setText('lp-kpi-errors-sub', e.lastFailureTs ? `Son: ${fmtRelative(e.lastFailureTs)}` : `Toplam olay: ${e.total}`);
            const card = document.querySelector('.lp-cc-kpi[data-kpi="errors"] .lp-cc-kpi-icon');
            if (card) card.classList.toggle('lp-cc-kpi-icon-danger', e.failed > 0);
        } else {
            setText('lp-kpi-errors', '—');
            setText('lp-kpi-errors-sub', 'Audit verisi alınamadı');
        }

        const f = snapshot.fleet;
        if (f) {
            setText('lp-kpi-fleet', `${f.online} / ${f.total}`);
            setText('lp-kpi-fleet-sub', f.offline > 0 ? `${f.offline} agent çevrimdışı` : 'Tüm agent online');
            const card = document.querySelector('.lp-cc-kpi[data-kpi="fleet"] .lp-cc-kpi-icon');
            if (card) {
                card.classList.toggle('lp-cc-kpi-icon-warn', f.offline > 0 && f.offline <= 5);
                card.classList.toggle('lp-cc-kpi-icon-danger', f.offline > 5);
            }
        } else {
            setText('lp-kpi-fleet', '—');
            setText('lp-kpi-fleet-sub', 'Fleet verisi alınamadı');
        }

        const s = snapshot.signing;
        const card = document.querySelector('.lp-cc-kpi[data-kpi="signing"] .lp-cc-kpi-icon');
        if (s && s.reachable) {
            const isFail = s.lastStatus && s.lastStatus !== 'success' && s.lastStatus !== 'ok';
            setText('lp-kpi-signing', s.lastIso ? fmtRelative(s.lastIso) : 'Henüz imza yok');
            setText('lp-kpi-signing-sub', `Sağlayıcı: ${s.provider}${isFail ? ' • başarısız' : ''}`);
            if (card) {
                card.classList.toggle('lp-cc-kpi-icon-danger', !!isFail);
                card.classList.toggle('lp-cc-kpi-icon-success', !isFail);
            }
        } else {
            setText('lp-kpi-signing', 'Erişilemiyor');
            setText('lp-kpi-signing-sub', 'Signing-engine yanıt vermiyor');
            if (card) {
                card.classList.add('lp-cc-kpi-icon-danger');
                card.classList.remove('lp-cc-kpi-icon-success');
            }
        }
    }

    function pushTodo(list, item) {
        list.push(item);
    }

    function buildTodos(snapshot) {
        const todos = [];

        if (snapshot.signing && snapshot.signing.reachable === false) {
            pushTodo(todos, {
                level: 'danger',
                icon: 'fa-signature',
                title: '5651 imzalama servisi yanıt vermiyor',
                detail: 'signing-engine yanıt vermediği için günlük imzalar üretilemez.',
                action: { label: 'Servisleri kontrol et', tab: 'services' }
            });
        } else if (snapshot.signing && snapshot.signing.lastStatus && !['success','ok',''].includes(snapshot.signing.lastStatus)) {
            pushTodo(todos, {
                level: 'danger',
                icon: 'fa-signature',
                title: 'Son 5651 imzalama başarısız',
                detail: `Son imza durumu: ${snapshot.signing.lastStatus}`,
                action: { label: 'Arşiv & İmzaya git', tab: 'archive' }
            });
        }

        if (snapshot.fleet) {
            if (snapshot.fleet.total === 0) {
                pushTodo(todos, {
                    level: 'warning',
                    icon: 'fa-network-wired',
                    title: 'Henüz hiç agent kaydı yok',
                    detail: 'Uç envanteri sayfasından ilk agent için kayıt token üretebilirsiniz.',
                    action: { label: 'Uç envanterine git', tab: 'agent-fleet' }
                });
            } else if (snapshot.fleet.offline >= 5) {
                pushTodo(todos, {
                    level: 'danger',
                    icon: 'fa-network-wired',
                    title: `${snapshot.fleet.offline} agent çevrimdışı`,
                    detail: 'Beş veya daha fazla agent heartbeat göndermiyor.',
                    action: { label: 'Uç envanterine git', tab: 'agent-fleet' }
                });
            } else if (snapshot.fleet.offline > 0) {
                pushTodo(todos, {
                    level: 'warning',
                    icon: 'fa-network-wired',
                    title: `${snapshot.fleet.offline} agent çevrimdışı`,
                    detail: 'Bazı agent\'lar son heartbeat\'i geç gönderdi.',
                    action: { label: 'Uç envanterine git', tab: 'agent-fleet' }
                });
            }
        }

        if (snapshot.disk && snapshot.disk.percentUsed >= 85) {
            const lvl = snapshot.disk.percentUsed >= 95 ? 'danger' : 'warning';
            pushTodo(todos, {
                level: lvl,
                icon: 'fa-hard-drive',
                title: `Disk kullanımı %${snapshot.disk.percentUsed.toFixed(0)}`,
                detail: 'Retention politikasını gözden geçirin veya disk genişletin.',
                action: { label: 'Yapılandırmaya git', tab: 'config' }
            });
        }

        if (snapshot.errors && snapshot.errors.failed >= 5) {
            pushTodo(todos, {
                level: 'warning',
                icon: 'fa-triangle-exclamation',
                title: `Son 24 saatte ${snapshot.errors.failed} başarısız audit olayı`,
                detail: 'Yetkilendirme veya yapılandırma hataları olabilir.',
                action: { label: 'Logları aç', tab: 'logs' }
            });
        }

        if (snapshot.servicesUnhealthy && snapshot.servicesUnhealthy.length > 0) {
            pushTodo(todos, {
                level: 'danger',
                icon: 'fa-cube',
                title: `${snapshot.servicesUnhealthy.length} servis sorunlu`,
                detail: 'Sağlıksız servisler: ' + snapshot.servicesUnhealthy.slice(0, 5).join(', '),
                action: { label: 'Servislere git', tab: 'services' }
            });
        }

        if (snapshot.healthDegraded) {
            pushTodo(todos, {
                level: 'warning',
                icon: 'fa-triangle-exclamation',
                title: 'Panel sağlık kontrolünde uyarı var',
                detail: snapshot.healthDegraded,
                action: { label: 'Yapılandırmaya git', tab: 'config' }
            });
        }

        return todos;
    }

    function renderTodos(todos) {
        const list = $('lp-todo-list');
        const count = $('lp-todo-count');
        if (!list) return;

        if (count) count.textContent = todos.length === 0 ? 'Hepsi sağlıklı' : `${todos.length} öğe`;
        if (count) {
            count.classList.remove('badge-success', 'badge-warning', 'badge-danger', 'badge-info');
            if (todos.length === 0) count.classList.add('badge-success');
            else if (todos.some(t => t.level === 'danger')) count.classList.add('badge-danger');
            else count.classList.add('badge-warning');
        }

        if (todos.length === 0) {
            list.innerHTML = `
                <div class="lp-todo-empty">
                    <i class="fas fa-circle-check"></i>
                    <div><strong>Tüm sistemler sağlıklı.</strong><br>
                    <span class="help-text">5651 imza servisi, agent fleet, disk ve audit olayları normal sınırlarda.</span></div>
                </div>
            `;
            return;
        }

        list.innerHTML = todos.map((t, idx) => `
            <div class="lp-todo-item lp-todo-${ui.escapeHtml(t.level)}" data-idx="${idx}">
                <div class="lp-todo-icon"><i class="fas ${ui.escapeHtml(t.icon || 'fa-circle-info')}"></i></div>
                <div class="lp-todo-body">
                    <div class="lp-todo-title">${ui.escapeHtml(t.title)}</div>
                    <div class="lp-todo-detail">${ui.escapeHtml(t.detail || '')}</div>
                </div>
                <div class="lp-todo-action">
                    ${t.action ? `<button class="btn btn-sm btn-secondary" data-tab-target="${ui.escapeHtml(t.action.tab)}">${ui.escapeHtml(t.action.label)} <i class="fas fa-arrow-right"></i></button>` : ''}
                </div>
            </div>
        `).join('');

        list.querySelectorAll('[data-tab-target]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab-target');
                if (tab && typeof global.switchTab === 'function') global.switchTab(tab);
            });
        });
    }

    async function refresh(force) {
        if (state.refreshing) return;
        if (!force && Date.now() - state.lastRefresh < 5000) return;
        state.refreshing = true;
        try {
            const [metricsR, auditR, fleetR, signingR, healthR, mountR] = await Promise.all([
                safeGet('/api/observability/metrics'),
                safeGet('/api/audit/events?limit=200'),
                safeGet('/api/agent/fleet-overview'),
                safeGet('/api/signing/health'),
                safeGet('/api/health'),
                safeGet('/api/storage/mount-status')
            ]);

            const snapshot = {
                logVolume: metricsR.ok ? computeLogVolume(metricsR.data) : null,
                errors: auditR.ok ? computeErrors(auditR.data) : null,
                fleet: fleetR.ok ? computeFleet(fleetR.data) : null,
                signing: signingR.ok ? computeSigning(signingR.data) : { reachable: false }
            };

            if (healthR.ok && healthR.data) {
                const h = healthR.data;
                if (Array.isArray(h.services)) {
                    snapshot.servicesUnhealthy = h.services
                        .filter(s => s && (s.status === 'unhealthy' || s.status === 'exited' || s.status === 'stopped'))
                        .map(s => s.name).slice(0, 10);
                }
                if (h.warnings && h.warnings.length) {
                    snapshot.healthDegraded = (h.warnings.slice(0, 2) || []).join(' | ');
                }
            }

            if (mountR.ok && mountR.data) {
                const ms = mountR.data;
                const usedPct = Number(ms.percentUsed || ms.used_percent || (ms.summary && ms.summary.percentUsed) || 0);
                if (Number.isFinite(usedPct) && usedPct > 0) {
                    snapshot.disk = { percentUsed: usedPct };
                }
            }

            renderKpis(snapshot);
            renderTodos(buildTodos(snapshot));
            state.lastRefresh = Date.now();
        } catch (e) {
            console.error('overview.refresh failed:', e);
        } finally {
            state.refreshing = false;
        }
    }

    function bindActions() {
        const sign = $('lp-cc-action-sign');
        if (sign && !sign.__bound) {
            sign.addEventListener('click', async () => {
                const ok = await ui.confirm({ title: 'Şimdi imzala', message: 'Dünün arşivini hemen imzalamak istiyor musunuz?', okLabel: 'İmzala' });
                if (!ok) return;
                try {
                    sign.disabled = true;
                    const r = await api.post('/api/signing/sign-now', {});
                    ui.toast('İmzalama tetiklendi', { level: 'success', detail: JSON.stringify(r) });
                    setTimeout(() => refresh(true), 800);
                } catch (e) {
                    ui.reportError(e, { title: 'İmzalama başarısız', retry: () => sign.click() });
                } finally {
                    sign.disabled = false;
                }
            });
            sign.__bound = true;
        }
        const backup = $('lp-cc-action-backup');
        if (backup && !backup.__bound) {
            backup.addEventListener('click', () => {
                if (typeof global.createBackup === 'function') global.createBackup();
                else if (typeof global.backupNow === 'function') global.backupNow();
                else if (document.getElementById('backup-btn')) document.getElementById('backup-btn').click();
                else ui.toast('Yedekleme fonksiyonu bulunamadı', 'warning');
            });
            backup.__bound = true;
        }
        const validate = $('lp-cc-action-validate');
        if (validate && !validate.__bound) {
            validate.addEventListener('click', () => {
                if (typeof global.validateAllConfigs === 'function') global.validateAllConfigs();
                else if (typeof global.validateConfig === 'function') global.validateConfig();
                else if (document.getElementById('validate-config-btn')) document.getElementById('validate-config-btn').click();
                else ui.toast('Doğrulama fonksiyonu bulunamadı', 'warning');
            });
            validate.__bound = true;
        }
        const refreshBtn = $('lp-cc-action-refresh');
        if (refreshBtn && !refreshBtn.__bound) {
            refreshBtn.addEventListener('click', () => {
                refresh(true);
                if (typeof global.loadOpsSummary === 'function') global.loadOpsSummary();
                if (typeof global.loadOverviewIntelligence === 'function') global.loadOverviewIntelligence(true);
                if (typeof global.loadServices === 'function') global.loadServices();
                if (typeof global.loadSystemHealth === 'function') global.loadSystemHealth();
                ui.toast('Veriler yenileniyor', { level: 'info', duration: 2000 });
            });
            refreshBtn.__bound = true;
        }
    }

    function init() {
        if (!api || !ui) {
            console.warn('overview module: LogPanel.api/ui not ready');
            return;
        }
        bindActions();
        refresh(true);
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => {
            const overviewTab = document.getElementById('overview');
            if (overviewTab && overviewTab.classList.contains('active')) {
                refresh(false);
            }
        }, 30000);
    }

    NS.modules.overview = {
        __sealed: true,
        refresh,
        init
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 600);
    });
})(window);
