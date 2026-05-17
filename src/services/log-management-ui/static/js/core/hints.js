/**
 * Inline «?» help popovers (first-run + dashboard).
 */
(function attachHints(global) {
    'use strict';

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function hintInnerHtml(plain) {
        if (!plain) return '';
        return escapeHtml(plain).replace(/\n/g, '<br>');
    }

    let seq = 0;

    function hintMarkup(plain) {
        const inner = hintInnerHtml(plain);
        if (!inner) return '';
        const uid = 'lp-h-' + (++seq);
        return '<span class="lp-hint" data-lp-plain-hint>'
            + '<button type="button" class="lp-hint-btn" data-lp-plain-hint-btn aria-expanded="false"'
            + ' aria-controls="' + uid + '-p" id="' + uid + '-b" aria-label="Açıklama" title="Yardım">?</button>'
            + '<span class="lp-hint-popover" id="' + uid + '-p" role="tooltip" hidden>'
            + '<span class="lp-hint-popover-inner">' + inner + '</span></span></span>';
    }

    function mountHint(elId, text) {
        const el = document.getElementById(elId);
        if (el) el.innerHTML = hintMarkup(text);
    }

    function initHintDelegation() {
        if (global.__lpHintsInit) return;
        global.__lpHintsInit = true;
        document.addEventListener('click', function (e) {
            const btn = e.target.closest('[data-lp-plain-hint-btn]');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                const wrap = btn.closest('[data-lp-plain-hint]');
                const pop = wrap && wrap.querySelector('.lp-hint-popover');
                const was = wrap && wrap.classList.contains('is-open');
                document.querySelectorAll('[data-lp-plain-hint].is-open').forEach((w) => {
                    w.classList.remove('is-open');
                    const b = w.querySelector('[data-lp-plain-hint-btn]');
                    const p = w.querySelector('.lp-hint-popover');
                    if (b) b.setAttribute('aria-expanded', 'false');
                    if (p) p.hidden = true;
                });
                if (!was && wrap && pop) {
                    wrap.classList.add('is-open');
                    btn.setAttribute('aria-expanded', 'true');
                    pop.hidden = false;
                }
                return;
            }
            if (!e.target.closest('[data-lp-plain-hint]')) {
                document.querySelectorAll('[data-lp-plain-hint].is-open').forEach((w) => {
                    w.classList.remove('is-open');
                    const b = w.querySelector('[data-lp-plain-hint-btn]');
                    const p = w.querySelector('.lp-hint-popover');
                    if (b) b.setAttribute('aria-expanded', 'false');
                    if (p) p.hidden = true;
                });
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('[data-lp-plain-hint].is-open').forEach((w) => {
                w.classList.remove('is-open');
                const b = w.querySelector('[data-lp-plain-hint-btn]');
                const p = w.querySelector('.lp-hint-popover');
                if (b) b.setAttribute('aria-expanded', 'false');
                if (p) p.hidden = true;
            });
        });
    }

    global.LpHints = {
        escapeHtml,
        hintMarkup,
        mountHint,
        initHintDelegation,
    };
}(typeof window !== 'undefined' ? window : globalThis));
