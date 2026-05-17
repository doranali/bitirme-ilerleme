/**
 * LogPanel.modules.users — Kullanici, Rol Matrisi, Audit log (Faz 7).
 */
(function attachUsersModule(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.users && NS.modules.users.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;
    const state = { users: [], history: {}, audit: [], modalMode: 'create', modalUser: null };

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

    function formatDate(value) {
        if (!value) return '-';
        try {
            const d = (value instanceof Date) ? value : new Date(value);
            if (Number.isNaN(d.getTime())) return '-';
            return d.toLocaleString('tr-TR', { hour12: false });
        } catch (_) { return '-'; }
    }

    function bindSubtabs() {
        const root = document.getElementById('users-security');
        if (!root) return;
        const buttons = $$('.lp-subtab-btn[data-subtab]', root);
        const panes = $$('.lp-subtab-pane[data-subtab-pane]', root);
        buttons.forEach(b => {
            if (b.__bound) return;
            b.__bound = true;
            b.addEventListener('click', () => {
                const target = b.getAttribute('data-subtab');
                buttons.forEach(x => {
                    const a = x === b;
                    x.classList.toggle('lp-subtab-active', a);
                    x.setAttribute('aria-selected', a ? 'true' : 'false');
                });
                panes.forEach(p => {
                    const a = p.getAttribute('data-subtab-pane') === target;
                    p.classList.toggle('lp-subtab-pane-active', a);
                    if (a) p.removeAttribute('hidden'); else p.setAttribute('hidden', '');
                });
                if (target === 'users-roles') loadRoles();
                if (target === 'users-audit') loadAudit();
            });
        });
    }

    function renderUsersTable() {
        const wrap = $('#lp-users-table-wrapper');
        if (!wrap) return;

        if (!state.users.length) {
            ui.emptyState(wrap, { title: 'Kullanıcı yok', message: 'Sistem yeni kuruldu.', icon: 'fa-users' });
            return;
        }

        const rows = state.users.map(u => {
            const h = state.history[u.username] || {};
            const last = formatDate(h.lastLogin);
            const failed = h.failedLogins || 0;
            const failBadge = failed > 0 ? `<span class="badge badge-warning" title="Toplam başarısız giriş">${failed} fail</span>` : '';
            const roleBadge = `<span class="badge ${u.role === 'admin' ? 'badge-danger' : (u.role === 'operator' ? 'badge-warning' : 'badge-info')}">${ui.escapeHtml(u.role)}</span>`;
            const statusBadge = u.enabled ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-secondary">Devre dışı</span>';
            return `
                <tr data-username="${ui.escapeHtml(u.username)}">
                    <td><strong>${ui.escapeHtml(u.username)}</strong></td>
                    <td>${roleBadge}</td>
                    <td>${statusBadge}</td>
                    <td class="help-text">${last}</td>
                    <td>${failBadge}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn btn-sm btn-secondary lp-users-edit" data-username="${ui.escapeHtml(u.username)}" title="Düzenle"><i class="fas fa-pen"></i></button>
                        <button class="btn btn-sm btn-warning lp-users-pwd" data-username="${ui.escapeHtml(u.username)}" title="Parola sıfırla"><i class="fas fa-key"></i></button>
                        <button class="btn btn-sm btn-danger lp-users-del" data-username="${ui.escapeHtml(u.username)}" title="Sil"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>
            `;
        }).join('');

        wrap.innerHTML = `
            <div class="table-wrapper">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Kullanıcı</th><th>Rol</th><th>Durum</th><th>Son giriş</th><th>Hata</th><th>Eylem</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;

        $$('.lp-users-edit', wrap).forEach(b => b.addEventListener('click', () => openModal('edit', b.getAttribute('data-username'))));
        $$('.lp-users-pwd', wrap).forEach(b => b.addEventListener('click', () => openModal('password', b.getAttribute('data-username'))));
        $$('.lp-users-del', wrap).forEach(b => b.addEventListener('click', () => deleteUser(b.getAttribute('data-username'))));
    }

    async function loadUsers() {
        const wrap = $('#lp-users-table-wrapper');
        if (!wrap) return;
        ui.loadingState(wrap, { message: 'Kullanıcılar yükleniyor...' });
        try {
            const [u, h] = await Promise.all([
                api.get('/api/users'),
                api.get('/api/users/login-history').catch(() => ({ history: {} }))
            ]);
            state.users = (u && Array.isArray(u.users)) ? u.users : [];
            state.history = (h && h.history) ? h.history : {};
            renderUsersTable();
        } catch (e) {
            ui.errorState(wrap, e, { title: 'Kullanıcılar alınamadı', retry: loadUsers });
        }
    }

    function openModal(mode, username) {
        const m = $('#lp-user-modal');
        if (!m) return;
        state.modalMode = mode || 'create';
        state.modalUser = (state.users || []).find(u => u.username === username) || null;

        const titleEl = $('#lp-user-modal-title');
        const usernameEl = $('#lp-user-modal-username');
        const passwordEl = $('#lp-user-modal-password');
        const roleEl = $('#lp-user-modal-role');
        const enabledEl = $('#lp-user-modal-enabled');
        const helpEl = $('#lp-user-modal-help');

        if (state.modalMode === 'create') {
            titleEl.innerHTML = '<i class="fas fa-user-plus"></i> Yeni Kullanıcı';
            usernameEl.value = ''; usernameEl.disabled = false;
            passwordEl.value = ''; passwordEl.placeholder = 'En az 8 karakter';
            roleEl.value = 'viewer';
            enabledEl.checked = true;
            helpEl.textContent = 'Yeni bir panel kullanıcısı oluşturuluyor.';
        } else if (state.modalMode === 'edit') {
            titleEl.innerHTML = '<i class="fas fa-user-pen"></i> Kullanıcı Düzenle';
            usernameEl.value = (state.modalUser || {}).username || '';
            usernameEl.disabled = true;
            passwordEl.value = ''; passwordEl.placeholder = 'Boş bırakılırsa değişmez';
            roleEl.value = (state.modalUser || {}).role || 'viewer';
            enabledEl.checked = (state.modalUser || {}).enabled !== false;
            helpEl.textContent = 'Rol/durum güncellemesi. Parolayı değiştirmek için doldurun.';
        } else if (state.modalMode === 'password') {
            titleEl.innerHTML = '<i class="fas fa-key"></i> Parola Sıfırla';
            usernameEl.value = (state.modalUser || {}).username || '';
            usernameEl.disabled = true;
            passwordEl.value = ''; passwordEl.placeholder = 'Yeni parola';
            roleEl.value = (state.modalUser || {}).role || 'viewer';
            roleEl.disabled = true;
            enabledEl.checked = (state.modalUser || {}).enabled !== false;
            enabledEl.disabled = true;
            helpEl.textContent = 'Sadece parola güncellenecek.';
        }
        m.classList.add('show');
        m.style.display = 'flex';
        setTimeout(() => { (passwordEl || usernameEl).focus(); }, 50);
    }

    function closeModal() {
        const m = $('#lp-user-modal');
        if (m) { m.classList.remove('show'); m.style.display = 'none'; }
        const roleEl = $('#lp-user-modal-role');
        const enabledEl = $('#lp-user-modal-enabled');
        if (roleEl) roleEl.disabled = false;
        if (enabledEl) enabledEl.disabled = false;
        state.modalUser = null;
    }

    async function saveModal() {
        const username = ($('#lp-user-modal-username') || {}).value || '';
        const password = ($('#lp-user-modal-password') || {}).value || '';
        const role = ($('#lp-user-modal-role') || {}).value || 'viewer';
        const enabled = !!($('#lp-user-modal-enabled') || {}).checked;
        const isCreate = state.modalMode === 'create';
        if (!username.trim()) { ui.toast('Kullanıcı adı gerekli', 'warning'); return; }
        if (isCreate && password.length < 8) { ui.toast('Parola en az 8 karakter olmalı', 'warning'); return; }
        if (state.modalMode === 'password' && password.length < 8) { ui.toast('Yeni parola en az 8 karakter', 'warning'); return; }

        const body = { username: username.trim(), role, enabled };
        if (password) body.password = password;
        try {
            await api.post('/api/users', body);
            ui.toast(isCreate ? 'Kullanıcı oluşturuldu' : 'Kullanıcı güncellendi', 'success');
            closeModal();
            loadUsers();
        } catch (e) {
            ui.reportError(e, { title: 'Kayıt başarısız' });
        }
    }

    async function deleteUser(username) {
        if (!username) return;
        const ok = await ui.confirm({
            title: 'Kullanıcıyı sil',
            message: `${username} kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`,
            danger: true,
            okLabel: 'Sil'
        });
        if (!ok) return;
        try {
            await api.del(`/api/users/${encodeURIComponent(username)}`);
            ui.toast('Silindi', 'success');
            loadUsers();
        } catch (e) {
            ui.reportError(e, { title: 'Silinemedi' });
        }
    }

    async function loadRoles() {
        const root = $('#lp-roles-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Rol matrisi yükleniyor...' });
        try {
            const r = await api.get('/api/users/roles');
            const roles = Array.isArray(r.roles) ? r.roles : [];
            const perms = Array.isArray(r.permissions) ? r.permissions : [];
            root.innerHTML = `
                <div class="grid-2">
                    <div>
                        <h5 style="margin-bottom:0.5rem;">Roller</h5>
                        <div style="display:flex; flex-direction:column; gap:0.5rem;">
                            ${roles.map(r => `
                                <div class="lp-saved-item" style="flex-direction:column; align-items:flex-start;">
                                    <div style="display:flex; gap:0.5rem; align-items:center;">
                                        <span class="badge ${r.role === 'admin' ? 'badge-danger' : (r.role === 'operator' ? 'badge-warning' : 'badge-info')}">${ui.escapeHtml(r.role)}</span>
                                        <span class="help-text">Düzey ${r.level}</span>
                                    </div>
                                    <div class="help-text" style="margin-top:0.4rem;">${ui.escapeHtml(r.description || '')}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    <div>
                        <h5 style="margin-bottom:0.5rem;">Endpoint Yetkileri</h5>
                        <div class="table-wrapper">
                            <table class="table">
                                <thead>
                                    <tr><th>Endpoint</th><th style="width:120px;">Min. Rol</th></tr>
                                </thead>
                                <tbody>
                                    ${perms.map(p => `
                                        <tr>
                                            <td><code>${ui.escapeHtml(p.endpoint)}</code></td>
                                            <td><span class="badge ${p.minRole === 'admin' ? 'badge-danger' : (p.minRole === 'operator' ? 'badge-warning' : 'badge-info')}">${ui.escapeHtml(p.minRole)}</span></td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                        <p class="help-text" style="margin-top:0.5rem;">Operatör admin yetkilerini de kapsar mantığı yoktur — her endpoint kendi minimum rolünü ister, üst rol otomatik geçer (operator → admin).</p>
                    </div>
                </div>
            `;
        } catch (e) {
            ui.errorState(root, e, { title: 'Rol matrisi alınamadı', retry: loadRoles });
        }
    }

    function renderAudit() {
        const root = $('#lp-audit-content');
        if (!root) return;
        const filter = (($('#lp-audit-filter') || {}).value || '').trim().toLowerCase();
        const events = state.audit.filter(ev => {
            if (!filter) return true;
            const blob = `${ev.user} ${ev.action} ${ev.status} ${JSON.stringify(ev.details || {})}`.toLowerCase();
            return blob.includes(filter);
        });
        if (!events.length) {
            ui.emptyState(root, { title: 'Sonuç yok', message: filter ? 'Filtreye uyan olay yok.' : 'Henüz audit olayı yok.', icon: 'fa-clock-rotate-left' });
            return;
        }
        const rows = events.slice(0, 500).map(ev => {
            const status = ev.status || '-';
            const cls = status === 'success' ? 'badge-success' : (status === 'failed' ? 'badge-danger' : 'badge-warning');
            const detailJson = JSON.stringify(ev.details || {}, null, 2);
            return `
                <tr>
                    <td class="lp-search-ts">${ui.escapeHtml(formatDate(ev.timestamp))}</td>
                    <td>${ui.escapeHtml(ev.user || '-')}</td>
                    <td><code>${ui.escapeHtml(ev.action || '-')}</code></td>
                    <td><span class="badge ${cls}">${ui.escapeHtml(status)}</span></td>
                    <td>${ui.escapeHtml(ev.ip || '-')}</td>
                    <td><details><summary class="help-text">Ayrıntı</summary><pre style="font-size:0.78rem; background:var(--bg-main); padding:0.4rem; margin-top:0.3rem; border-radius:0.3rem; white-space:pre-wrap; word-break:break-word;">${ui.escapeHtml(detailJson)}</pre></details></td>
                </tr>
            `;
        }).join('');
        root.innerHTML = `
            <div class="table-wrapper">
                <table class="table lp-search-table">
                    <thead>
                        <tr>
                            <th>Zaman</th><th>Kullanıcı</th><th>İşlem</th><th>Sonuç</th><th>IP</th><th>Detay</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="help-text" style="margin-top:0.5rem;">Görüntülenen: ${Math.min(events.length, 500)} / Toplam: ${state.audit.length} olay</div>
        `;
    }

    async function loadAudit() {
        const root = $('#lp-audit-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Audit log yükleniyor...' });
        try {
            const r = await api.get('/api/audit/events?limit=500');
            state.audit = Array.isArray(r.events) ? r.events : [];
            renderAudit();
        } catch (e) {
            ui.errorState(root, e, { title: 'Audit log alınamadı', retry: loadAudit });
        }
    }

    function exportAuditCsv() {
        if (!state.audit.length) { ui.toast('Önce yenileyin', 'warning'); return; }
        const cols = ['timestamp', 'user', 'action', 'status', 'ip'];
        const escape = v => {
            const s = (v === null || v === undefined) ? '' : String(v);
            if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        const rows = state.audit.map(ev => cols.map(c => escape(ev[c])).join(','));
        const csv = [cols.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `audit-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ui.toast('CSV indirildi', 'success');
    }

    function bindControls() {
        const refresh = $('#lp-users-refresh-btn');
        if (refresh && !refresh.__bound) { refresh.addEventListener('click', loadUsers); refresh.__bound = true; }

        const add = $('#lp-users-add-btn');
        if (add && !add.__bound) { add.addEventListener('click', () => openModal('create')); add.__bound = true; }

        const close = $('#lp-user-modal-close');
        const cancel = $('#lp-user-modal-cancel');
        const save = $('#lp-user-modal-save');
        if (close && !close.__bound) { close.addEventListener('click', closeModal); close.__bound = true; }
        if (cancel && !cancel.__bound) { cancel.addEventListener('click', closeModal); cancel.__bound = true; }
        if (save && !save.__bound) { save.addEventListener('click', saveModal); save.__bound = true; }

        const audRefresh = $('#lp-audit-refresh-btn');
        if (audRefresh && !audRefresh.__bound) { audRefresh.addEventListener('click', loadAudit); audRefresh.__bound = true; }
        const audFilter = $('#lp-audit-filter');
        if (audFilter && !audFilter.__bound) { audFilter.addEventListener('input', () => renderAudit()); audFilter.__bound = true; }
        const audExport = $('#lp-audit-export-btn');
        if (audExport && !audExport.__bound) { audExport.addEventListener('click', exportAuditCsv); audExport.__bound = true; }
    }

    function init() {
        if (!api || !ui) return;
        bindSubtabs();
        bindControls();

        const tab = document.getElementById('users-security');
        if (tab) {
            const observer = new MutationObserver(() => {
                if (tab.classList.contains('active') && !state.users.length) {
                    loadUsers();
                }
            });
            observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
        }
    }

    NS.modules.users = {
        __sealed: true,
        init,
        loadUsers,
        loadAudit,
        loadRoles
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 700);
    });
})(window);
