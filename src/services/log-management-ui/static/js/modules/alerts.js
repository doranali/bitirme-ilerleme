/**
 * LogPanel.modules.alerts — Faz 6: Alarm & Bildirim yonetimi.
 *
 * Sorumluluk: Telegram kanal CRUD, Grafana kural listesi (read-only),
 * eskalasyon merdiveni (JSON), alarm gecmisi + susturma listesi.
 */
(function attachAlerts(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.alerts && NS.modules.alerts.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

    // -------- Subtab navigation --------
    function showSubtab(id) {
        $$('#alerts .lp-subtab-btn').forEach(b => {
            const a = b.getAttribute('data-subtab') === id;
            b.classList.toggle('active', a);
            b.setAttribute('aria-selected', a ? 'true' : 'false');
        });
        $$('#alerts .lp-subtab-pane').forEach(p => {
            p.classList.toggle('active', p.id === id);
        });
        if (id === 'alerts-channels') loadChannels();
        if (id === 'alerts-rules') loadRules();
        if (id === 'alerts-escalation') loadEscalation();
        if (id === 'alerts-history') { loadHistory(); loadSilences(); }
    }

    // -------- Channels (Telegram) --------
    let _channelsCache = [];

    async function loadChannels() {
        const root = $('#lp-alert-channels-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Kanallar yükleniyor...' });
        try {
            const data = await api.get('/api/alerts/channels');
            _channelsCache = Array.isArray(data.items) ? data.items : [];
            if (!_channelsCache.length) {
                ui.emptyState(root, {
                    title: 'Henüz Telegram kanalı yok',
                    message: data.telegramConfigured ? 'Sağ üstten "Kanal ekle" ile başlayın.' : 'Önce TELEGRAM_BOT_TOKEN tanımlayın (Ayarlar → Bildirim).',
                    icon: 'fa-telegram'
                });
                return;
            }
            const rows = _channelsCache.map(c => `
                <tr>
                    <td><strong>${ui.escapeHtml(c.name)}</strong></td>
                    <td><code>${ui.escapeHtml(c.chatId)}</code></td>
                    <td>${(c.tags || []).map(t => `<span class="badge badge-secondary">${ui.escapeHtml(t)}</span>`).join(' ')}</td>
                    <td class="help-text">${ui.escapeHtml(c.createdAt || '-')}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary lp-alert-channel-test" data-id="${ui.escapeHtml(c.id)}" title="Test mesajı"><i class="fas fa-paper-plane"></i></button>
                        <button class="btn btn-sm btn-danger lp-alert-channel-delete admin-only" data-id="${ui.escapeHtml(c.id)}" title="Sil"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `).join('');
            root.innerHTML = `
                ${data.telegramConfigured ? '' : '<div class="alert alert-warning" style="margin-bottom:0.5rem;">TELEGRAM_BOT_TOKEN tanımsız — test ve canlı yayın çalışmaz.</div>'}
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Etiket</th><th>chat_id</th><th>Filtre</th><th>Eklenme</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
            $$('.lp-alert-channel-test', root).forEach(b => b.addEventListener('click', () => testChannel(b.getAttribute('data-id'))));
            $$('.lp-alert-channel-delete', root).forEach(b => b.addEventListener('click', () => deleteChannel(b.getAttribute('data-id'))));
        } catch (e) {
            ui.errorState(root, e, { title: 'Kanallar alınamadı', retry: loadChannels });
        }
    }

    function openChannelModal() {
        const m = $('#lp-alert-channel-modal');
        if (!m) return;
        $('#lp-alert-channel-name').value = '';
        $('#lp-alert-channel-chat').value = '';
        $('#lp-alert-channel-tags').value = '';
        $('#lp-alert-channel-error').textContent = '';
        m.style.display = 'flex';
    }

    function closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.style.display = 'none';
    }

    async function saveChannel() {
        const name = ($('#lp-alert-channel-name').value || '').trim();
        const chatId = ($('#lp-alert-channel-chat').value || '').trim();
        const tagsStr = ($('#lp-alert-channel-tags').value || '').trim();
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
        if (!name || !chatId) {
            $('#lp-alert-channel-error').textContent = 'Kanal etiketi ve chat_id gerekli';
            return;
        }
        try {
            await api.post('/api/alerts/channels', { name, chatId, tags });
            ui.toast('Kanal eklendi', 'success');
            closeModal('lp-alert-channel-modal');
            loadChannels();
        } catch (e) {
            const msg = (e && e.body && e.body.error) ? e.body.error : (e && e.message) || 'Kayıt başarısız';
            $('#lp-alert-channel-error').textContent = msg;
        }
    }

    async function testChannel(id) {
        try {
            const r = await api.post(`/api/alerts/channels/${encodeURIComponent(id)}/test`);
            if (r.sent) ui.toast('Test mesajı Telegram\'a gönderildi', 'success');
            else ui.toast('Test başarısız: ' + (r.error || ''), 'danger');
        } catch (e) {
            ui.reportError(e, { title: 'Test başarısız' });
        }
    }

    async function deleteChannel(id) {
        const ok = await ui.confirm({
            title: 'Kanalı sil',
            message: 'Bu Telegram kanalı kayıtlardan kaldırılsın mı? Yapılandırılmış alarmlar artık buraya gönderilmez.',
            danger: true,
            okLabel: 'Sil'
        });
        if (!ok) return;
        try {
            await api.del(`/api/alerts/channels/${encodeURIComponent(id)}`);
            ui.toast('Silindi', 'success');
            loadChannels();
        } catch (e) {
            ui.reportError(e, { title: 'Silme başarısız' });
        }
    }

    // -------- Rules (read-only) --------
    async function loadRules() {
        const root = $('#lp-alert-rules-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Kurallar yükleniyor...' });
        try {
            const data = await api.get('/api/alerts/rules');
            const link = $('#lp-alert-grafana-link');
            if (link) {
                link.href = (data.grafanaUrl || '/grafana').replace(/\/+$/, '') + '/alerting/list';
            }
            const items = Array.isArray(data.items) ? data.items : [];
            if (!items.length) {
                ui.emptyState(root, {
                    title: 'Tanımlı kural yok',
                    message: data.note || 'Grafana provisioning kuralları okunamadı.',
                    icon: 'fa-bell-slash'
                });
                return;
            }
            const rows = items.map(r => `
                <tr>
                    <td><strong>${ui.escapeHtml(r.title || r.uid)}</strong></td>
                    <td><span class="badge badge-${(r.severity === 'critical') ? 'danger' : (r.severity === 'warning' ? 'warning' : 'info')}">${ui.escapeHtml(r.severity || '-')}</span></td>
                    <td>${ui.escapeHtml(r.stream || '-')}</td>
                    <td>${ui.escapeHtml(r.for || '-')}</td>
                    <td class="help-text">${ui.escapeHtml(r.summary || '-')}</td>
                    <td><code>${ui.escapeHtml(r.uid || '')}</code></td>
                </tr>
            `).join('');
            root.innerHTML = `
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Kural</th><th>Severity</th><th>Stream</th><th>For</th><th>Özet</th><th>UID</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        } catch (e) {
            ui.errorState(root, e, { title: 'Kurallar alınamadı', retry: loadRules });
        }
    }

    // -------- Escalation --------
    let _escalationLevels = [];

    function renderEscalationRows() {
        const root = $('#lp-alert-escalation-rows');
        if (!root) return;
        if (!_escalationLevels.length) {
            root.innerHTML = '<p class="help-text">Henüz kademe yok. "Kademe ekle" ile başlayın.</p>';
            return;
        }
        root.innerHTML = _escalationLevels.map((lvl, idx) => `
            <div class="lp-escalation-row" data-idx="${idx}" style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; padding:0.4rem; border:1px solid var(--border-color, rgba(255,255,255,0.08)); border-radius:6px;">
                <strong style="min-width:30px;">#${idx + 1}</strong>
                <label class="help-text">Sonra (dk):
                    <input type="number" min="0" max="1440" class="input-search lp-esc-min" value="${ui.escapeHtml(String(lvl.afterMinutes || 0))}" style="max-width:90px; margin-left:0.25rem;">
                </label>
                <label class="help-text">Kanal etiketi:
                    <input type="text" class="input-search lp-esc-tag" value="${ui.escapeHtml(lvl.channelTag || '')}" placeholder="boş=varsayılan" style="max-width:160px; margin-left:0.25rem;">
                </label>
                <label class="help-text" style="flex:1; min-width:200px;">Not:
                    <input type="text" class="input-search lp-esc-note" value="${ui.escapeHtml(lvl.note || '')}" placeholder="açıklama" style="margin-left:0.25rem;">
                </label>
                <button class="btn btn-sm btn-danger lp-esc-remove admin-only" type="button" title="Sil"><i class="fas fa-trash"></i></button>
            </div>
        `).join('');
        $$('.lp-esc-remove', root).forEach(b => b.addEventListener('click', () => {
            const idx = parseInt(b.closest('.lp-escalation-row').getAttribute('data-idx'), 10);
            _escalationLevels.splice(idx, 1);
            renderEscalationRows();
        }));
    }

    function readEscalationFromDom() {
        return $$('#lp-alert-escalation-rows .lp-escalation-row').map(row => ({
            afterMinutes: parseInt($('.lp-esc-min', row).value || '0', 10) || 0,
            channelTag: ($('.lp-esc-tag', row).value || '').trim(),
            note: ($('.lp-esc-note', row).value || '').trim().slice(0, 200),
        }));
    }

    async function loadEscalation() {
        const status = $('#lp-alert-escalation-status');
        try {
            const data = await api.get('/api/alerts/escalation');
            _escalationLevels = Array.isArray(data.levels) ? data.levels : [];
            renderEscalationRows();
            if (status) status.textContent = data.updatedAt ? `Son güncelleme: ${data.updatedAt} (${data.updatedBy || '-'})` : 'Henüz kaydedilmedi.';
        } catch (e) {
            ui.reportError(e, { title: 'Eskalasyon alınamadı' });
        }
    }

    async function saveEscalation() {
        _escalationLevels = readEscalationFromDom();
        try {
            const r = await api.put('/api/alerts/escalation', { levels: _escalationLevels });
            ui.toast(`${r.levels} kademe kaydedildi`, 'success');
            loadEscalation();
        } catch (e) {
            ui.reportError(e, { title: 'Kayıt başarısız' });
        }
    }

    // -------- History + silences --------
    async function loadHistory() {
        const root = $('#lp-alert-history-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Alarm geçmişi yükleniyor...' });
        try {
            const data = await api.get('/api/alerts/history?limit=100');
            const items = Array.isArray(data.items) ? data.items : [];
            if (!items.length) {
                ui.emptyState(root, {
                    title: 'Henüz alarm yok',
                    message: data.error ? `alert-webhook log\'u okunamadı: ${data.error}` : 'Konteyner log\'unda eşleşen kayıt yok.',
                    icon: 'fa-bell-slash'
                });
                return;
            }
            const rows = items.map(it => {
                const lvl = it.level || 'info';
                const cls = lvl === 'critical' ? 'badge-danger' : (lvl === 'warning' ? 'badge-warning' : 'badge-info');
                return `<tr>
                    <td class="help-text" style="white-space:nowrap;">${ui.escapeHtml(it.timestamp || '-')}</td>
                    <td><span class="badge ${cls}">${ui.escapeHtml(lvl)}</span></td>
                    <td><code>${ui.escapeHtml(it.message || '-')}</code></td>
                </tr>`;
            }).join('');
            root.innerHTML = `
                <div class="help-text" style="margin-bottom:0.4rem;">${items.length} kayıt — kaynak: <code>${ui.escapeHtml(data.container || 'alert-webhook')}</code></div>
                <div class="table-wrapper" style="max-height:340px; overflow:auto;">
                    <table class="table">
                        <thead><tr><th>Zaman</th><th>Severity</th><th>Mesaj</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
        } catch (e) {
            ui.errorState(root, e, { title: 'Geçmiş alınamadı', retry: loadHistory });
        }
    }

    async function loadSilences() {
        const root = $('#lp-alert-silences-content');
        if (!root) return;
        try {
            const data = await api.get('/api/alerts/silences');
            const active = Array.isArray(data.active) ? data.active : [];
            if (!active.length) {
                root.innerHTML = '<p class="help-text">Aktif susturma yok.</p>';
                return;
            }
            const rows = active.map(s => `
                <tr>
                    <td><code>${ui.escapeHtml(s.pattern)}</code></td>
                    <td class="help-text">${ui.escapeHtml(s.reason || '-')}</td>
                    <td class="help-text">${ui.escapeHtml(s.until || '-')} (${s.remainingMinutes || 0}dk)</td>
                    <td class="help-text">${ui.escapeHtml(s.createdBy || '-')}</td>
                    <td><button class="btn btn-sm btn-secondary lp-alert-silence-delete" data-id="${ui.escapeHtml(s.id)}" title="Susturmayı kaldır"><i class="fas fa-volume-high"></i></button></td>
                </tr>
            `).join('');
            root.innerHTML = `
                <div class="table-wrapper">
                    <table class="table">
                        <thead><tr><th>Pattern</th><th>Sebep</th><th>Bitiş</th><th>Kim</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;
            $$('.lp-alert-silence-delete', root).forEach(b => b.addEventListener('click', () => deleteSilence(b.getAttribute('data-id'))));
        } catch (e) {
            root.innerHTML = `<p class="help-text" style="color:var(--danger,#ef4444);">Susturmalar alınamadı: ${ui.escapeHtml((e && e.message) || '?')}</p>`;
        }
    }

    async function addSilence() {
        const pattern = global.prompt && global.prompt('Susturulacak alarm başlığı veya etiketi (regex değil, içeren):', '');
        if (!pattern) return;
        const minutes = global.prompt && global.prompt('Kaç dakika susturulsun?', '60');
        if (!minutes) return;
        const reason = global.prompt && global.prompt('Sebep / not (opsiyonel):', '');
        try {
            await api.post('/api/alerts/silences', {
                pattern: pattern.trim(),
                minutes: parseInt(minutes, 10) || 60,
                reason: (reason || '').trim()
            });
            ui.toast('Susturma eklendi', 'success');
            loadSilences();
        } catch (e) {
            ui.reportError(e, { title: 'Susturma eklenemedi' });
        }
    }

    async function deleteSilence(id) {
        try {
            await api.del(`/api/alerts/silences/${encodeURIComponent(id)}`);
            ui.toast('Susturma kaldırıldı', 'success');
            loadSilences();
        } catch (e) {
            ui.reportError(e, { title: 'Silme başarısız' });
        }
    }

    // -------- Wiring --------
    function bind() {
        $$('#alerts .lp-subtab-btn').forEach(b => {
            if (b.__bound) return;
            b.addEventListener('click', () => showSubtab(b.getAttribute('data-subtab')));
            b.__bound = true;
        });

        const add = $('#lp-alert-channel-add');
        if (add && !add.__bound) { add.addEventListener('click', openChannelModal); add.__bound = true; }
        const save = $('#lp-alert-channel-save');
        if (save && !save.__bound) { save.addEventListener('click', saveChannel); save.__bound = true; }
        $$('#lp-alert-channel-modal [data-close-modal]').forEach(b => {
            if (b.__bound) return;
            b.addEventListener('click', () => closeModal(b.getAttribute('data-close-modal')));
            b.__bound = true;
        });

        const rr = $('#lp-alert-rules-refresh');
        if (rr && !rr.__bound) { rr.addEventListener('click', loadRules); rr.__bound = true; }

        const ea = $('#lp-alert-escalation-add');
        if (ea && !ea.__bound) {
            ea.addEventListener('click', () => {
                _escalationLevels.push({ afterMinutes: 5, channelTag: '', note: '' });
                renderEscalationRows();
            });
            ea.__bound = true;
        }
        const es = $('#lp-alert-escalation-save');
        if (es && !es.__bound) { es.addEventListener('click', saveEscalation); es.__bound = true; }

        const hr = $('#lp-alert-history-refresh');
        if (hr && !hr.__bound) { hr.addEventListener('click', () => { loadHistory(); loadSilences(); }); hr.__bound = true; }
        const sa = $('#lp-alert-silence-add');
        if (sa && !sa.__bound) { sa.addEventListener('click', addSilence); sa.__bound = true; }

        const tab = document.getElementById('alerts');
        if (tab) {
            const obs = new MutationObserver(() => {
                if (tab.classList.contains('active')) {
                    const active = $('#alerts .lp-subtab-btn.active');
                    showSubtab(active ? active.getAttribute('data-subtab') : 'alerts-channels');
                }
            });
            obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
        }
    }

    function init() {
        if (!api || !ui) return;
        bind();
    }

    NS.modules.alerts = { __sealed: true, init, loadChannels, loadRules, loadEscalation, loadHistory, loadSilences };

    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
})(window);
