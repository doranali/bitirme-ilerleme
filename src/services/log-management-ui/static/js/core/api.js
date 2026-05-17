/**
 * LogPanel.api — standart API katmani.
 *
 * Mevcut dashboard.js'in apiRequest()/csrfToken global'leri ile UYUMLUDUR;
 * bu modul onlari koruyarak ek timeout/retry/abort/yapilandirilmis hata UX'i
 * saglar. Yeni gelistirilen modullerin (Faz 1+) tek capisi olarak kullanilir.
 *
 * Yukleme sirasi: dashboard.html'de dashboard-utils.js'ten ONCE; dashboard.js
 * GLOBAL csrfToken'i hala canli, bu modul onu opsiyonel olarak okur.
 */
(function attachLogPanelApi(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    if (NS.api && NS.api.__sealed) return;

    const DEFAULT_TIMEOUT_MS = 20000;
    const DEFAULT_RETRY_COUNT = 0;
    const DEFAULT_RETRY_DELAY_MS = 600;

    function getCsrfTokenSync() {
        if (typeof global.csrfToken === 'string' && global.csrfToken) return global.csrfToken;
        try {
            const meta = document.querySelector('meta[name="csrf-token"]');
            if (meta && meta.content) return meta.content;
        } catch (_) { /* ignore */ }
        return '';
    }

    async function refreshCsrfTokenIfNeeded() {
        if (getCsrfTokenSync()) return;
        try {
            const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
            if (!r.ok) return;
            const data = await r.json();
            if (data && data.csrfToken) {
                global.csrfToken = data.csrfToken;
            }
        } catch (_) { /* ignore */ }
    }

    function timeoutSignal(ms, externalSignal) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
        if (externalSignal) {
            if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
            else externalSignal.addEventListener('abort', () => ctrl.abort(externalSignal.reason), { once: true });
        }
        return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
    }

    function isRetriable(status, method) {
        if (method !== 'GET' && method !== 'HEAD') return false;
        if (status === 0) return true;
        return status >= 500 && status !== 501;
    }

    /**
     * @param {string} url
     * @param {object} [options]
     * @param {string} [options.method='GET']
     * @param {object|FormData|string|null} [options.body]
     * @param {object} [options.headers]
     * @param {object} [options.query]   URL'ye eklenecek query params.
     * @param {number} [options.timeoutMs]
     * @param {number} [options.retry]   Sadece GET/HEAD; varsayilan 0.
     * @param {AbortSignal} [options.signal]
     * @param {boolean} [options.raw=false]  true ise Response donulur (JSON parse edilmez).
     * @returns {Promise<any>}
     */
    async function request(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
        const retry = Math.max(0, Number.isFinite(options.retry) ? options.retry : DEFAULT_RETRY_COUNT);

        let finalUrl = url;
        if (options.query && typeof options.query === 'object') {
            const usp = new URLSearchParams();
            Object.entries(options.query).forEach(([k, v]) => {
                if (v === undefined || v === null) return;
                usp.append(k, String(v));
            });
            const qs = usp.toString();
            if (qs) finalUrl += (finalUrl.includes('?') ? '&' : '?') + qs;
        }

        const headers = new Headers(options.headers || {});
        let body = options.body;

        const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        const isFormData = (typeof FormData !== 'undefined') && (body instanceof FormData);

        if (body && typeof body === 'object' && !isFormData && typeof body !== 'string') {
            if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
            body = JSON.stringify(body);
        }

        if (isMutating) {
            await refreshCsrfTokenIfNeeded();
            const tok = getCsrfTokenSync();
            if (tok) headers.set('X-CSRF-Token', tok);
        }

        let lastErr = null;
        let attempts = 0;

        while (attempts <= retry) {
            attempts += 1;
            const t = timeoutSignal(timeoutMs, options.signal);
            try {
                const response = await fetch(finalUrl, {
                    method,
                    headers,
                    body: isMutating ? body : undefined,
                    credentials: 'same-origin',
                    signal: t.signal
                });
                t.cancel();

                if (response.status === 401) {
                    if (typeof global.showSessionExpiredToast === 'function') {
                        try { global.showSessionExpiredToast(); } catch (_) { /* ignore */ }
                    }
                    const err = new Error('Authentication required');
                    err.status = 401;
                    err.code = 'AUTH_REQUIRED';
                    throw err;
                }

                if (options.raw) return response;

                const ct = response.headers.get('content-type') || '';
                const isJson = ct.includes('application/json');
                let payload;
                try {
                    payload = isJson ? await response.json() : { raw: await response.text() };
                } catch (parseErr) {
                    payload = { raw: '', parseError: String(parseErr) };
                }

                if (payload && typeof payload === 'object' && payload.csrfToken) {
                    global.csrfToken = payload.csrfToken;
                }

                if (!response.ok) {
                    if (isRetriable(response.status, method) && attempts <= retry) {
                        await new Promise(r => setTimeout(r, DEFAULT_RETRY_DELAY_MS * attempts));
                        continue;
                    }
                    const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`;
                    const err = new Error(String(message));
                    err.status = response.status;
                    err.body = payload;
                    err.code = `HTTP_${response.status}`;
                    throw err;
                }

                return payload;
            } catch (e) {
                t.cancel();
                lastErr = e;
                if (e && e.name === 'AbortError') {
                    if (e.message === 'timeout' || (e.cause && e.cause.name === 'TimeoutError')) {
                        e.code = 'TIMEOUT';
                        e.status = 0;
                    } else {
                        e.code = 'ABORTED';
                        throw e;
                    }
                }
                if ((e.code === 'TIMEOUT' || e.status === 0) && method === 'GET' && attempts <= retry) {
                    await new Promise(r => setTimeout(r, DEFAULT_RETRY_DELAY_MS * attempts));
                    continue;
                }
                throw e;
            }
        }
        throw lastErr || new Error('request_failed');
    }

    const api = {
        __sealed: true,
        request,
        get: (url, opt = {}) => request(url, { ...opt, method: 'GET' }),
        post: (url, body, opt = {}) => request(url, { ...opt, method: 'POST', body }),
        put: (url, body, opt = {}) => request(url, { ...opt, method: 'PUT', body }),
        del: (url, opt = {}) => request(url, { ...opt, method: 'DELETE' }),
        patch: (url, body, opt = {}) => request(url, { ...opt, method: 'PATCH', body }),
        getCsrfToken: getCsrfTokenSync,
        refreshCsrfToken: refreshCsrfTokenIfNeeded
    };

    NS.api = api;
})(window);
