/**
 * LogPanel.modules.agentsBulk — Faz 5: Toplu agent eylemleri.
 */
(function attachAgentsBulk(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.agentsBulk && NS.modules.agentsBulk.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

    function readNodeIds() {
        const raw = (($('#lp-bulk-nodes') || {}).value || '').trim();
        if (!raw) return [];
        return raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    }

    function renderBulkResult(message, level) {
        const out = $('#lp-bulk-result');
        if (!out) return;
        out.innerHTML = `<div class="alert alert-${level === 'success' ? 'success' : (level === 'danger' ? 'danger' : 'info')}">${ui.escapeHtml(message)}</div>`;
    }

    async function bulkCertRenew() {
        const nodes = readNodeIds();
        if (!nodes.length) { ui.toast('Hedef agent listesi boş', 'warning'); return; }
        const ok = await ui.confirm({
            title: 'Sertifika yenileme',
            message: `${nodes.length} agent için sertifika yenileme talebi gönderilsin mi? Eylemler agent'ların bir sonraki heartbeat'inde alınır.`,
            okLabel: 'Yenile'
        });
        if (!ok) return;
        try {
            const r = await api.post('/api/agent/cert-renew', { nodeIds: nodes });
            renderBulkResult(`${r.message || ''} ${r.note || ''}`, 'success');
            loadPending();
        } catch (e) {
            ui.reportError(e, { title: 'Sertifika yenileme başarısız' });
        }
    }

    async function bulkConfigPush() {
        const nodes = readNodeIds();
        if (!nodes.length) { ui.toast('Hedef agent listesi boş', 'warning'); return; }
        const profile = global.prompt && global.prompt('Push edilecek profil adı:', 'default');
        if (!profile) return;
        try {
            const r = await api.post('/api/agent/config-push', { nodeIds: nodes, profile });
            renderBulkResult(`${r.message || ''} (profil: ${r.profile})`, 'success');
            loadPending();
        } catch (e) {
            ui.reportError(e, { title: 'Yapılandırma push başarısız' });
        }
    }

    async function bulkRestart() {
        const nodes = readNodeIds();
        if (!nodes.length) { ui.toast('Hedef agent listesi boş', 'warning'); return; }
        const ok = await ui.confirm({
            title: 'Toplu yeniden başlatma',
            message: `${nodes.length} agent yeniden başlatılsın mı? Eylem agent'ların bir sonraki heartbeat'inde uygulanır.`,
            danger: true,
            okLabel: 'Yeniden başlat'
        });
        if (!ok) return;
        try {
            const r = await api.post('/api/agent/restart', { nodeIds: nodes });
            renderBulkResult(`${r.message || ''} ${r.note || ''}`, 'success');
            loadPending();
        } catch (e) {
            ui.reportError(e, { title: 'Yeniden başlatma başarısız' });
        }
    }

    async function loadPending() {
        const root = $('#lp-pending-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Bekleyen eylemler yükleniyor...' });
        try {
            const data = await api.get('/api/agent/pending-actions');
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) {
                ui.emptyState(root, { title: 'Bekleyen eylem yok', message: 'Tüm agent\'lar güncel.', icon: 'fa-circle-check' });
                return;
            }
            const rows = items.slice(0, 100).map(a => `
                <tr>
                    <td><code>${ui.escapeHtml(a.nodeId)}</code></td>
                    <td><span class="badge badge-info">${ui.escapeHtml(a.type)}</span></td>
                    <td class="help-text">${ui.escapeHtml(JSON.stringify(a.params || {}))}</td>
                    <td class="help-text">${ui.escapeHtml(a.issuedAt || '-')}</td>
                    <td>${ui.escapeHtml(a.issuedBy || '-')}</td>
                    <td><button class="btn btn-sm btn-secondary lp-pending-cancel admin-only" data-node="${ui.escapeHtml(a.nodeId)}" data-aid="${ui.escapeHtml(a.id)}" title="Vazgec"><i class="fas fa-xmark"></i></button></td>
                </tr>
            `).join('');
            root.innerHTML = `
                <div class="help-text" style="margin-bottom:0.4rem;">${items.length} bekleyen eylem · ${data.totalNodes} farklı agent</div>
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Agent</th><th>Eylem</th><th>Parametre</th><th>Zaman</th><th>Veren</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
            $$('.lp-pending-cancel', root).forEach(b => b.addEventListener('click', async () => {
                const node = b.getAttribute('data-node');
                const aid = b.getAttribute('data-aid');
                try {
                    await api.del(`/api/agent/pending-actions/${encodeURIComponent(node)}/${encodeURIComponent(aid)}`);
                    ui.toast('İptal edildi', 'success');
                    loadPending();
                } catch (e) {
                    ui.reportError(e, { title: 'İptal başarısız' });
                }
            }));
        } catch (e) {
            ui.errorState(root, e, { title: 'Bekleyen eylemler alınamadı', retry: loadPending });
        }
    }

    function statusBadge(status) {
        if (status === 'ok') return '<span class="badge badge-success"><i class="fas fa-check"></i> Tamam</span>';
        if (status === 'warn') return '<span class="badge badge-warning"><i class="fas fa-triangle-exclamation"></i> Uyarı</span>';
        if (status === 'fail') return '<span class="badge badge-danger"><i class="fas fa-xmark"></i> Hata</span>';
        return '<span class="badge badge-secondary">' + ui.escapeHtml(status || '?') + '</span>';
    }

    async function runSelfTest() {
        const root = $('#lp-selftest-content');
        const overallBadge = $('#lp-selftest-overall');
        if (!root) return;
        if (overallBadge) {
            overallBadge.className = 'badge badge-info';
            overallBadge.textContent = 'Çalışıyor…';
        }
        ui.loadingState(root, { message: 'Tanılama yürütülüyor (5–10 sn)…' });
        try {
            const data = await api.get('/api/agent/self-test', { timeoutMs: 15000 });
            const checks = Array.isArray(data.checks) ? data.checks : [];
            const rows = checks.map(c => `
                <tr>
                    <td>${ui.escapeHtml(c.name || c.id)}</td>
                    <td>${statusBadge(c.status)}</td>
                    <td class="help-text"><code>${ui.escapeHtml(c.detail || '-')}</code></td>
                </tr>
            `).join('');
            root.innerHTML = `
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Kontrol</th><th>Durum</th><th>Detay</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <p class="help-text" style="margin-top:0.6rem;">Genel: ${statusBadge(data.overall)} · ${ui.escapeHtml(data.generatedAt || '')}</p>
            `;
            if (overallBadge) {
                const map = { ok: 'badge-success', warn: 'badge-warning', fail: 'badge-danger' };
                overallBadge.className = 'badge ' + (map[data.overall] || 'badge-secondary');
                overallBadge.textContent = data.overall === 'ok' ? 'Tüm kontroller başarılı'
                    : data.overall === 'warn' ? 'Uyarılarla geçti'
                    : data.overall === 'fail' ? 'Hatalar bulundu' : 'Bilinmiyor';
            }
        } catch (e) {
            ui.errorState(root, e, { title: 'Self-test başarısız', retry: runSelfTest });
            if (overallBadge) {
                overallBadge.className = 'badge badge-danger';
                overallBadge.textContent = 'Hata';
            }
        }
    }

    function bind() {
        const cr = $('#lp-bulk-cert-renew');
        if (cr && !cr.__bound) { cr.addEventListener('click', bulkCertRenew); cr.__bound = true; }
        const cp = $('#lp-bulk-config-push');
        if (cp && !cp.__bound) { cp.addEventListener('click', bulkConfigPush); cp.__bound = true; }
        const rb = $('#lp-bulk-restart');
        if (rb && !rb.__bound) { rb.addEventListener('click', bulkRestart); rb.__bound = true; }
        const pr = $('#lp-pending-refresh');
        if (pr && !pr.__bound) { pr.addEventListener('click', loadPending); pr.__bound = true; }
        const st = $('#lp-selftest-run');
        if (st && !st.__bound) { st.addEventListener('click', runSelfTest); st.__bound = true; }

        const tab = document.getElementById('agent-fleet');
        if (tab) {
            const obs = new MutationObserver(() => {
                if (tab.classList.contains('active')) loadPending();
            });
            obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
            if (tab.classList.contains('active')) loadPending();
        }
    }

    function init() {
        if (!api || !ui) return;
        bind();
    }

    NS.modules.agentsBulk = { __sealed: true, init, loadPending, runSelfTest };

    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
})(window);
