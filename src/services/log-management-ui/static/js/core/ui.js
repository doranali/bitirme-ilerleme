/**
 * LogPanel.ui — standart kullanici arayuzu yardimcilari.
 *
 * Mevcut showAlert()/closeModal() fonksiyonlariyla geri uyumlu.
 * Yeni modullerin (Faz 1+) tek capisi: LogPanel.ui.toast / .confirm /
 * .loading / .errorState / .emptyState / .copyToClipboard.
 */
(function attachLogPanelUi(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    if (NS.ui && NS.ui.__sealed) return;

    const TOAST_CONTAINER_ID = 'lp-toast-container';
    const DEFAULT_TOAST_MS = 4500;

    function ensureToastContainer() {
        let c = document.getElementById(TOAST_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = TOAST_CONTAINER_ID;
        c.className = 'lp-toast-container';
        c.setAttribute('aria-live', 'polite');
        c.setAttribute('aria-atomic', 'true');
        document.body.appendChild(c);
        return c;
    }

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function iconFor(level) {
        switch (level) {
            case 'success': return 'fa-circle-check';
            case 'warning': return 'fa-triangle-exclamation';
            case 'danger':
            case 'error': return 'fa-circle-exclamation';
            default: return 'fa-circle-info';
        }
    }

    function normLevel(level) {
        if (!level) return 'info';
        const l = String(level).toLowerCase();
        if (l === 'error') return 'danger';
        return l;
    }

    /**
     * Profesyonel toast.
     * @param {string} message
     * @param {object|string} [opts]   string verilirse level olarak yorumlanir.
     * @param {string} [opts.level='info']
     * @param {number} [opts.duration]
     * @param {string} [opts.title]
     * @param {string} [opts.detail]   teknik detay (kopyalanabilir).
     * @param {Array<{label,onClick,style?}>} [opts.actions]
     * @returns {{close:Function, el:HTMLElement}}
     */
    function toast(message, opts) {
        if (typeof opts === 'string') opts = { level: opts };
        opts = opts || {};
        const level = normLevel(opts.level);
        const duration = Number.isFinite(opts.duration) ? opts.duration : DEFAULT_TOAST_MS;

        const c = ensureToastContainer();
        const el = document.createElement('div');
        el.className = `lp-toast lp-toast-${level}`;
        el.setAttribute('role', level === 'danger' ? 'alert' : 'status');

        const titleHtml = opts.title ? `<div class="lp-toast-title">${escapeHtml(opts.title)}</div>` : '';
        const detailHtml = opts.detail
            ? `<details class="lp-toast-detail"><summary>Teknik detay</summary><pre>${escapeHtml(opts.detail)}</pre></details>`
            : '';

        el.innerHTML = `
            <div class="lp-toast-icon"><i class="fas ${iconFor(level)}"></i></div>
            <div class="lp-toast-body">
                ${titleHtml}
                <div class="lp-toast-message">${escapeHtml(message)}</div>
                ${detailHtml}
                <div class="lp-toast-actions"></div>
            </div>
            <button type="button" class="lp-toast-close" aria-label="Kapat">&times;</button>
        `;

        const actionsEl = el.querySelector('.lp-toast-actions');
        const actions = Array.isArray(opts.actions) ? opts.actions.slice() : [];
        if (opts.detail) {
            actions.unshift({
                label: 'Detayi kopyala',
                onClick: () => copyToClipboard(opts.detail).then(() => toast('Kopyalandi', 'success'))
            });
        }
        actions.forEach(a => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `lp-toast-action ${a.style || ''}`.trim();
            btn.textContent = a.label || 'Eylem';
            btn.addEventListener('click', () => {
                try { a.onClick && a.onClick(); } catch (_) {}
                if (a.dismiss !== false) close();
            });
            actionsEl.appendChild(btn);
        });

        let closed = false;
        let timer = null;
        function close() {
            if (closed) return;
            closed = true;
            if (timer) clearTimeout(timer);
            el.classList.add('lp-toast-leaving');
            setTimeout(() => { try { el.remove(); } catch (_) {} }, 200);
        }
        el.querySelector('.lp-toast-close').addEventListener('click', close);
        if (duration > 0) timer = setTimeout(close, duration);

        c.appendChild(el);
        return { close, el };
    }

    function copyToClipboard(text) {
        const value = String(text ?? '');
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
            return global.navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
        }
        return Promise.resolve(fallbackCopy(value));
    }

    function fallbackCopy(value) {
        try {
            const ta = document.createElement('textarea');
            ta.value = value;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Standart hata UX'i. Bir hata objesi alir, kullaniciya net mesaj +
     * kopyalanabilir teknik detay + (opsiyonel) tekrar dene gosterir.
     */
    function reportError(err, opts = {}) {
        const status = err && err.status;
        let title = opts.title || 'Bir hata olustu';
        let message = (err && err.message) || 'Bilinmeyen hata';
        let detail = '';

        if (status === 0 || (err && err.code === 'TIMEOUT')) {
            title = 'Baglanti zaman asimi';
            message = opts.contextLabel
                ? `${opts.contextLabel} icin sunucudan yanit alinamadi`
                : 'Sunucudan yanit alinamadi';
        } else if (status === 401) {
            title = 'Oturum suresi doldu';
            message = 'Yeniden giris yapmaniz gerekiyor';
        } else if (status === 403) {
            title = 'Yetki yetersiz';
            message = 'Bu islem icin gerekli role sahip degilsiniz';
        } else if (status === 404) {
            title = 'Bulunamadi';
            message = (err && err.message) || 'Istenen kaynak bulunamadi';
        } else if (status >= 500) {
            title = 'Sunucu hatasi';
            message = (err && err.message) || `HTTP ${status}`;
        }

        try {
            const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
            detail = JSON.stringify({
                code: err && err.code,
                status: err && err.status,
                message: err && err.message,
                body: err && err.body,
                stack: stack || undefined
            }, null, 2);
        } catch (_) {
            detail = String((err && err.message) || err || '');
        }

        const actions = [];
        if (typeof opts.retry === 'function') {
            actions.push({ label: 'Tekrar dene', onClick: opts.retry, style: 'lp-toast-action-primary' });
        }
        return toast(message, { level: 'danger', title, detail, duration: 8000, actions });
    }

    function emptyState(targetEl, opts = {}) {
        if (!targetEl) return;
        const icon = opts.icon || 'fa-inbox';
        const title = opts.title || 'Veri yok';
        const message = opts.message || 'Goruntulecek kayit bulunamadi';
        const actionHtml = opts.actionLabel
            ? `<button type="button" class="btn btn-sm btn-secondary lp-empty-action"><i class="fas fa-rotate"></i> ${escapeHtml(opts.actionLabel)}</button>`
            : '';
        targetEl.innerHTML = `
            <div class="lp-empty-state">
                <div class="lp-empty-icon"><i class="fas ${icon}"></i></div>
                <h4 class="lp-empty-title">${escapeHtml(title)}</h4>
                <p class="lp-empty-message">${escapeHtml(message)}</p>
                ${actionHtml}
            </div>
        `;
        if (opts.onAction && typeof opts.onAction === 'function') {
            const btn = targetEl.querySelector('.lp-empty-action');
            if (btn) btn.addEventListener('click', opts.onAction);
        }
    }

    function loadingState(targetEl, opts = {}) {
        if (!targetEl) return;
        const message = opts.message || 'Yukleniyor';
        targetEl.innerHTML = `
            <div class="lp-loading-state">
                <div class="lp-spinner-ring" aria-hidden="true"></div>
                <p class="lp-loading-text">${escapeHtml(message)}</p>
            </div>
        `;
    }

    function errorState(targetEl, err, opts = {}) {
        if (!targetEl) return;
        let detail = '';
        try {
            detail = JSON.stringify({
                code: err && err.code,
                status: err && err.status,
                message: err && err.message,
                body: err && err.body
            }, null, 2);
        } catch (_) {
            detail = String((err && err.message) || err || '');
        }
        const message = (err && err.message) || 'Veri yuklenemedi';
        targetEl.innerHTML = `
            <div class="lp-error-state">
                <div class="lp-error-icon"><i class="fas fa-circle-exclamation"></i></div>
                <h4 class="lp-error-title">${escapeHtml(opts.title || 'Yukleme basarisiz')}</h4>
                <p class="lp-error-message">${escapeHtml(message)}</p>
                <details class="lp-error-detail"><summary>Teknik detay</summary><pre></pre></details>
                <div class="lp-error-actions">
                    <button type="button" class="btn btn-sm btn-secondary lp-error-copy"><i class="fas fa-copy"></i> Kopyala</button>
                    <button type="button" class="btn btn-sm btn-primary lp-error-retry" style="display:none;"><i class="fas fa-rotate"></i> Tekrar dene</button>
                </div>
            </div>
        `;
        targetEl.querySelector('.lp-error-detail pre').textContent = detail;
        targetEl.querySelector('.lp-error-copy').addEventListener('click', () => {
            copyToClipboard(detail).then(() => toast('Detay panoya kopyalandi', 'success'));
        });
        if (typeof opts.retry === 'function') {
            const btn = targetEl.querySelector('.lp-error-retry');
            btn.style.display = '';
            btn.addEventListener('click', opts.retry);
        }
    }

    /** Confirm dialog (modal yerine basit varyant). */
    function confirm(opts = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'lp-confirm-overlay';
            const danger = !!opts.danger;
            overlay.innerHTML = `
                <div class="lp-confirm-card ${danger ? 'lp-confirm-danger' : ''}">
                    <h4>${escapeHtml(opts.title || 'Onay')}</h4>
                    <p>${escapeHtml(opts.message || 'Devam etmek istediginize emin misiniz?')}</p>
                    <div class="lp-confirm-actions">
                        <button type="button" class="btn btn-secondary lp-confirm-cancel">${escapeHtml(opts.cancelLabel || 'Iptal')}</button>
                        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} lp-confirm-ok">${escapeHtml(opts.okLabel || 'Onayla')}</button>
                    </div>
                </div>
            `;
            const cleanup = (val) => { try { overlay.remove(); } catch (_) {} resolve(val); };
            overlay.querySelector('.lp-confirm-cancel').addEventListener('click', () => cleanup(false));
            overlay.querySelector('.lp-confirm-ok').addEventListener('click', () => cleanup(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
            document.body.appendChild(overlay);
            setTimeout(() => overlay.querySelector('.lp-confirm-ok').focus(), 30);
        });
    }

    function formatBytes(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
        return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
    }

    function formatDate(value, opts = {}) {
        if (!value) return '-';
        try {
            const d = (value instanceof Date) ? value : new Date(value);
            if (Number.isNaN(d.getTime())) return '-';
            if (opts.relative && global.DashboardUtils && typeof global.DashboardUtils.formatRelativeTime === 'function') {
                return global.DashboardUtils.formatRelativeTime(value);
            }
            return d.toLocaleString('tr-TR');
        } catch (_) {
            return '-';
        }
    }

    NS.ui = {
        __sealed: true,
        toast,
        reportError,
        emptyState,
        loadingState,
        errorState,
        confirm,
        copyToClipboard,
        escapeHtml,
        formatBytes,
        formatDate
    };

    NS.toast = NS.toast || toast;
})(window);
