/**
 * İlk kurulum — 3 adımlı sihirbaz (/first-run)
 */
(function firstRunPage() {
    'use strict';

    const cfg = window.__FIRST_RUN__ || {};
    const CSRF = cfg.csrfToken || '';
    const H = window.LpHints;

    const K1_KEYS = [
        'LOG_SYSTEM_COMPANY_ID',
        'LOG_PLATFORM_PUBLIC_BASE_URL',
        'LOG_PLATFORM_PUBLIC_HOST',
        'LOG_PLATFORM_PUBLIC_SCHEME',
        'DEV_DEFAULT_CREDENTIALS',
    ];

    const K1_FIELD_IDS = ['LOG_SYSTEM_COMPANY_ID', 'LOG_PLATFORM_PUBLIC', 'DEV_DEFAULT_CREDENTIALS'];

    const K2_SETTING_KEYS = [
        'SIGNER_TYPE',
        'ARCHIVE_DESTINATION',
        'TUBITAK_TSA_URL',
        'TUBITAK_TLS_INSECURE',
        'TUBITAK_TSA_CUSTOMER_NO',
        'TUBITAK_TSA_PASSWORD',
    ];

    const TUBITAK_EXTRA_KEYS = [
        'TUBITAK_TSA_URL',
        'TUBITAK_TLS_INSECURE',
        'TUBITAK_TSA_CUSTOMER_NO',
        'TUBITAK_TSA_PASSWORD',
    ];

    const SIGNER_TYPE_LABELS = {
        OPEN_SOURCE: 'OpenSSL (açık kaynak)',
        TUBITAK: 'TÜBİTAK KamuSM',
    };

    const TASK_LABELS = {
        PIPELINE_HEALTH: 'Log hattı sağlığı',
        STORAGE_ACK: 'Depolama konumu',
        SYSLOG_ACK: 'Syslog kaynakları',
        SIGNER_TYPE: 'İmzalama motoru',
        ARCHIVE_DESTINATION: 'Arşiv hedefi',
        TUBITAK_TSA_URL: 'TÜBİTAK TSA adresi',
        TUBITAK_TLS_INSECURE: 'TSA TLS doğrulaması',
        TUBITAK_TSA_CUSTOMER_NO: 'Kamu SM müşteri no',
        TUBITAK_TSA_PASSWORD: 'Kamu SM müşteri parolası',
        LOG_SYSTEM_COMPANY_ID: 'Kurum kodu',
        LOG_PLATFORM_PUBLIC: 'Kamuya açık adres',
        DEV_DEFAULT_CREDENTIALS: 'Geliştirme kimlik bilgileri',
        PANEL_ADMIN_PASSWORD: 'Yönetici parolası',
    };

    const TASK_ICONS = {
        PIPELINE_HEALTH: 'fa-heart-pulse',
        STORAGE_ACK: 'fa-hard-drive',
        SYSLOG_ACK: 'fa-network-wired',
        SIGNER_TYPE: 'fa-signature',
        ARCHIVE_DESTINATION: 'fa-box-archive',
    };

    let gateState = null;
    let currentStep = 1;
    let maxUnlockedStep = 1;
    let catalogWritable = true;
    let catalogSettings = {};

    async function api(method, url, body) {
        const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF };
        const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch (_) { /* ignore */ }
        if (!r.ok) throw new Error((j && j.error) || t || String(r.status));
        return j;
    }

    function taskTitle(item) {
        return TASK_LABELS[item.id] || item.id || 'Kontrol';
    }

    function simplifyMessage(item) {
        const raw = item.message || '';
        if (item.id === 'STORAGE_ACK') {
            return 'Veri dizini kök disk üzerinde. Üretim için ayrı disk önerilir; bilinçliyseniz onaylayın.';
        }
        if (item.id === 'SYSLOG_ACK') {
            return 'Henüz güvenilir syslog trafiği yok. Bilinçli olarak boş bırakıyorsanız onaylayın.';
        }
        if (item.id === 'PIPELINE_HEALTH') {
            return raw.replace(/^Fluent Bit \/ Graylog sağlığı[^.]*\.\s*/i, '')
                || 'Log toplama hattı henüz sağlıklı değil.';
        }
        if (item.id === 'SIGNER_TYPE') {
            return 'İmzalama motoru OPEN_SOURCE veya TUBITAK olarak seçilmelidir.';
        }
        if (item.id === 'TUBITAK_TSA_URL') {
            return 'TÜBİTAK için Kamu SM TSA tam URL gerekli (test: tzd.kamusm.gov.tr yolu).';
        }
        return raw.replace(/^[A-Z0-9_]+\s+/i, '').trim() || raw;
    }

    function k1FieldsMissing(g) {
        return (g.k1Missing || []).some((m) => K1_FIELD_IDS.includes(m.id));
    }

    function inferStep(g) {
        if (!g || g.gateSatisfied) return 'done';
        if (k1FieldsMissing(g)) return 1;
        if (!g.k2Complete) return 2;
        if ((g.k1Missing || []).some((m) => m.id === 'PANEL_ADMIN_PASSWORD')) return 3;
        return 'done';
    }

    function showStep(step) {
        currentStep = step === 'done' ? 'done' : Math.max(1, Math.min(3, Number(step) || 1));

        document.querySelectorAll('.lp-fr-step-panel').forEach((panel) => {
            const active = panel.getAttribute('data-step') === String(currentStep);
            panel.classList.toggle('is-active', active);
            panel.hidden = !active;
        });

        document.querySelectorAll('.lp-fr-step-item').forEach((btn) => {
            const n = Number(btn.getAttribute('data-goto-step'));
            const done = gateState && (
                (n === 1 && !k1FieldsMissing(gateState)) ||
                (n === 2 && gateState.k2Complete) ||
                (n === 3 && gateState.gateSatisfied)
            );
            const active = currentStep === n;
            btn.classList.toggle('is-active', active);
            btn.classList.toggle('is-done', done && !active);
            btn.disabled = n > maxUnlockedStep && !done;
            btn.setAttribute('aria-current', active ? 'step' : 'false');
        });

        const back = document.getElementById('btn-back');
        if (back) back.hidden = currentStep === 1 || currentStep === 'done';

        updatePrimaryButton();
    }

    function updateSummary(g) {
        const el = document.getElementById('fr-summary');
        if (!el || !g) return;
        if (g.gateSatisfied || currentStep === 'done') {
            el.textContent = 'Kurulum tamamlandı.';
            return;
        }
        const k2n = (g.k2Missing || []).length;
        const k1n = (g.k1Missing || []).filter((m) => K1_FIELD_IDS.includes(m.id)).length;
        if (currentStep === 1 && k1n > 0) {
            el.textContent = k1n + ' kimlik alanı eksik.';
        } else if (currentStep === 2 && k2n > 0) {
            el.textContent = k2n + ' operasyon maddesi kaldı.';
        } else if (currentStep === 3) {
            el.textContent = 'Güçlü bir yönetici parolası belirleyin.';
        } else {
            const pwd = (g.k1Missing || []).some((m) => m.id === 'PANEL_ADMIN_PASSWORD') ? 1 : 0;
            const total = k1n + k2n + pwd;
            el.textContent = total > 0 ? total + ' eksik madde kaldı.' : 'Devam edebilirsiniz.';
        }
    }

    function updatePrimaryButton() {
        const btn = document.getElementById('btn-primary');
        const cont = document.getElementById('btn-continue');
        if (!btn) return;

        if (currentStep === 'done' || (gateState && gateState.gateSatisfied)) {
            btn.classList.add('d-none');
            if (cont) {
                cont.classList.remove('d-none');
                cont.href = '/';
            }
            return;
        }

        btn.classList.remove('d-none');
        if (cont) cont.classList.add('d-none');

        if (currentStep === 1) {
            btn.textContent = 'Kaydet ve devam et';
            btn.disabled = !catalogWritable;
        } else if (currentStep === 2) {
            btn.textContent = 'Devam et';
            btn.disabled = !(gateState && gateState.k2Complete);
        } else if (currentStep === 3) {
            btn.textContent = 'Parolayı kaydet';
            btn.disabled = false;
        }
    }

    function settingFieldValue(key) {
        const s = catalogSettings[key];
        if (!s) return '';
        return s.masked ? '' : (s.value ?? '');
    }

    function renderTubitakExtraFields(show) {
        const url = catalogSettings.TUBITAK_TSA_URL || {};
        const tls = catalogSettings.TUBITAK_TLS_INSECURE || {};
        const tlsVal = String(settingFieldValue('TUBITAK_TLS_INSECURE') || '0');
        const tlsOpts = (tls.options || ['0', '1']).map((o) => {
            const sel = String(o) === tlsVal ? ' selected' : '';
            return '<option value="' + H.escapeHtml(o) + '"' + sel + '>' + (o === '1' ? 'Evet (yalnızca test)' : 'Hayır') + '</option>';
        }).join('');
        return '<div class="lp-fr-tubitak-extra"' + (show ? '' : ' hidden') + '>'
            + '<div class="lp-fr-tubitak-field"><label>TSA tam URL</label>'
            + '<input type="text" class="lp-fr-task-input" data-setting-input="TUBITAK_TSA_URL" value="'
            + H.escapeHtml(settingFieldValue('TUBITAK_TSA_URL')) + '" placeholder="'
            + H.escapeHtml(url.placeholder || 'http://tzd.kamusm.gov.tr/...') + '"></div>'
            + '<div class="lp-fr-tubitak-field"><label>Müşteri no</label>'
            + '<input type="text" class="lp-fr-task-input" data-setting-input="TUBITAK_TSA_CUSTOMER_NO" value="'
            + H.escapeHtml(settingFieldValue('TUBITAK_TSA_CUSTOMER_NO')) + '"></div>'
            + '<div class="lp-fr-tubitak-field"><label>Müşteri parola</label>'
            + '<input type="password" class="lp-fr-task-input" data-setting-input="TUBITAK_TSA_PASSWORD" value="'
            + H.escapeHtml(settingFieldValue('TUBITAK_TSA_PASSWORD')) + '" autocomplete="new-password"></div>'
            + '<div class="lp-fr-tubitak-field"><label>TLS doğrulamasını atla</label>'
            + '<select class="lp-fr-task-select" data-setting-input="TUBITAK_TLS_INSECURE">' + tlsOpts + '</select></div>'
            + '</div>';
    }

    async function saveSettingKeys(keys, row) {
        for (const key of keys) {
            const input = row.querySelector('[data-setting-input="' + key + '"]');
            if (!input) continue;
            const val = input.value;
            if ((key === 'TUBITAK_TSA_PASSWORD' || key === 'TUBITAK_TSA_CUSTOMER_NO') && !val) continue;
            if (key === 'TUBITAK_TSA_URL' && !val) throw new Error('TÜBİTAK için TSA URL zorunludur.');
            if (!val && key !== 'TUBITAK_TLS_INSECURE') continue;
            await api('POST', '/api/settings/update', { key, value: val });
        }
    }

    function renderTaskSettingControl(item) {
        if (!K2_SETTING_KEYS.includes(item.id)) return '';
        const s = catalogSettings[item.id];
        if (!s && item.id !== 'SIGNER_TYPE') return '';
        if (!catalogWritable) {
            return '<p class="lp-fr-task-card-desc">Ayar dosyası salt okunur; değişiklik için sunucu yöneticisine başvurun.</p>';
        }
        if (item.id === 'SIGNER_TYPE') {
            const current = String(s.value || '').toUpperCase();
            const valid = ['OPEN_SOURCE', 'TUBITAK'].includes(current);
            const options = (s.options || ['OPEN_SOURCE', 'TUBITAK']).map((o) => {
                const val = String(o).toUpperCase();
                const selected = current === val ? ' selected' : '';
                const label = SIGNER_TYPE_LABELS[val] || val;
                return '<option value="' + H.escapeHtml(val) + '"' + selected + '>' + H.escapeHtml(label) + '</option>';
            }).join('');
            const placeholder = !valid ? '<option value="" disabled selected>Seçin…</option>' : '';
            return '<div class="lp-fr-task-card-actions lp-fr-task-setting lp-fr-task-setting-signer">'
                + '<select class="lp-fr-task-select" data-setting-input="SIGNER_TYPE" aria-label="İmzalama motoru">'
                + placeholder + options + '</select>'
                + renderTubitakExtraFields(current === 'TUBITAK')
                + '<button type="button" class="lp-fr-btn-save-setting" data-save-bundle="signer">Kaydet</button></div>';
        }
        if (item.id === 'TUBITAK_TSA_URL') {
            const ph = H.escapeHtml((s && s.placeholder) || 'http://tzd.kamusm.gov.tr/...');
            return '<div class="lp-fr-task-card-actions lp-fr-task-setting">'
                + '<input type="text" class="lp-fr-task-input" data-setting-input="TUBITAK_TSA_URL"'
                + ' value="' + H.escapeHtml(settingFieldValue('TUBITAK_TSA_URL')) + '" placeholder="' + ph + '">'
                + '<button type="button" class="lp-fr-btn-save-setting" data-setting-key="TUBITAK_TSA_URL">Kaydet</button></div>';
        }
        if (item.id === 'ARCHIVE_DESTINATION') {
            const val = H.escapeHtml(s.masked ? '' : (s.value ?? 'local'));
            const ph = H.escapeHtml(s.placeholder || 'local');
            return '<div class="lp-fr-task-card-actions lp-fr-task-setting">'
                + '<input type="text" class="lp-fr-task-input" data-setting-input="ARCHIVE_DESTINATION"'
                + ' value="' + val + '" placeholder="' + ph + '" aria-label="Arşiv hedefi">'
                + '<button type="button" class="lp-fr-btn-save-setting" data-setting-key="ARCHIVE_DESTINATION">Kaydet</button></div>';
        }
        return '';
    }

    function bindTaskCardActions(root) {
        root.querySelectorAll('[data-ack]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await api('POST', '/api/setup/ack', { ack: btn.getAttribute('data-ack') });
                    await refreshGate({ autoStep: false });
                } catch (e) {
                    btn.disabled = false;
                    showAlert(String(e.message || e));
                }
            });
        });
        root.querySelectorAll('[data-setting-input="SIGNER_TYPE"]').forEach((sel) => {
            sel.addEventListener('change', () => {
                const row = sel.closest('.lp-fr-task-setting-signer') || sel.closest('.lp-fr-task-setting');
                const extra = row && row.querySelector('.lp-fr-tubitak-extra');
                if (extra) extra.hidden = sel.value !== 'TUBITAK';
            });
        });
        root.querySelectorAll('.lp-fr-btn-save-setting').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const row = btn.closest('.lp-fr-task-setting');
                const msg = row && row.parentElement.querySelector('.lp-fr-task-save-msg');
                btn.disabled = true;
                try {
                    if (btn.getAttribute('data-save-bundle') === 'signer') {
                        const stSel = row.querySelector('[data-setting-input="SIGNER_TYPE"]');
                        if (!stSel || !stSel.value) throw new Error('İmzalama motoru seçin.');
                        await api('POST', '/api/settings/update', { key: 'SIGNER_TYPE', value: stSel.value });
                        if (stSel.value === 'TUBITAK') {
                            await saveSettingKeys(['TUBITAK_TSA_URL', 'TUBITAK_TLS_INSECURE', 'TUBITAK_TSA_CUSTOMER_NO', 'TUBITAK_TSA_PASSWORD'], row);
                        }
                    } else {
                        const key = btn.getAttribute('data-setting-key');
                        const input = row && row.querySelector('[data-setting-input="' + key + '"]');
                        if (!input || !input.value) throw new Error('Lütfen bir değer seçin veya girin.');
                        await api('POST', '/api/settings/update', { key, value: input.value });
                    }
                    if (msg) { msg.textContent = 'Kaydedildi'; msg.classList.add('is-ok'); }
                    await refreshGate({ autoStep: false });
                    updatePrimaryButton();
                } catch (e) {
                    if (msg) { msg.textContent = String(e.message || e); msg.classList.remove('is-ok'); }
                    else showAlert(String(e.message || e));
                } finally {
                    btn.disabled = false;
                }
            });
        });
    }

    function renderTaskCards(g) {
        const root = document.getElementById('k2-tasks');
        if (!root) return;

        const items = g.k2Missing || [];
        if (!items.length) {
            root.innerHTML = ''
                + '<div class="lp-fr-task-card is-ok">'
                + '<span class="lp-fr-task-card-icon"><i class="fas fa-check-circle"></i></span>'
                + '<div class="lp-fr-task-card-body">'
                + '<p class="lp-fr-task-card-title">Operasyon hazır</p>'
                + '<p class="lp-fr-task-card-desc">Tüm ön koşullar karşılandı.</p>'
                + '</div></div>';
            return;
        }

        root.innerHTML = items.map((item) => {
            const icon = TASK_ICONS[item.id] || 'fa-circle-exclamation';
            const title = H.escapeHtml(taskTitle(item));
            const desc = H.escapeHtml(simplifyMessage(item));
            let actions = renderTaskSettingControl(item);
            if (item.id === 'STORAGE_ACK') {
                actions = '<div class="lp-fr-task-card-actions">'
                    + '<button type="button" class="lp-fr-btn-ack" data-ack="data_on_root_ok">Riski kabul ediyorum</button>'
                    + '</div>';
            } else if (item.id === 'SYSLOG_ACK') {
                actions = '<div class="lp-fr-task-card-actions">'
                    + '<button type="button" class="lp-fr-btn-ack" data-ack="syslog_empty_ok">Boş bırakmayı onaylıyorum</button>'
                    + '</div>';
            }
            return '<article class="lp-fr-task-card" data-task-id="' + H.escapeHtml(item.id) + '">'
                + '<span class="lp-fr-task-card-icon"><i class="fas ' + icon + '"></i></span>'
                + '<div class="lp-fr-task-card-body">'
                + '<p class="lp-fr-task-card-title">' + title + '</p>'
                + '<p class="lp-fr-task-card-desc">' + desc + '</p>'
                + actions
                + (K2_SETTING_KEYS.includes(item.id) ? '<p class="lp-fr-task-save-msg lp-fr-field-msg"></p>' : '')
                + '</div></article>';
        }).join('');

        bindTaskCardActions(root);
    }

    function showAlert(msg) {
        const alert = document.getElementById('gate-alert');
        if (!alert) return;
        if (!msg) {
            alert.classList.add('d-none');
            alert.textContent = '';
            return;
        }
        alert.classList.remove('d-none');
        alert.textContent = msg;
    }

    async function refreshGate(opts) {
        const autoStep = !opts || opts.autoStep !== false;
        const g = await api('GET', '/api/setup/gate');
        gateState = g;

        if (!g.enabled) {
            showAlert('Kurulum kilidi bu ortamda kapalı; yönlendiriliyorsunuz.');
            window.location.href = '/';
            return g;
        }

        showAlert('');
        renderTaskCards(g);
        updateSummary(g);

        const inferred = inferStep(g);
        maxUnlockedStep = inferred === 'done' ? 3 : Math.max(inferred, typeof currentStep === 'number' ? currentStep : 1);

        if (autoStep) {
            showStep(inferred);
        } else {
            showStep(currentStep);
            updateSummary(g);
        }

        return g;
    }

    function getK1Inputs() {
        const inputs = {};
        for (const key of K1_KEYS) {
            const el = document.getElementById('fld-' + key);
            if (el) inputs[key] = el.value;
        }
        return inputs;
    }

    async function saveAllK1() {
        const inputs = getK1Inputs();
        for (const key of K1_KEYS) {
            if (!(key in inputs)) continue;
            await api('POST', '/api/settings/update', { key, value: inputs[key] });
        }
    }

    async function loadCatalogAndForms() {
        const data = await api('GET', '/api/settings/catalog');
        const box = document.getElementById('k1-forms');
        if (!box) return;

        catalogWritable = !!data.settingsWritable;
        catalogSettings = {};
        (data.settings || []).forEach((s) => { catalogSettings[s.key] = s; });
        const settings = (data.settings || []).filter((s) => K1_KEYS.includes(s.key));

        if (!catalogWritable) {
            box.innerHTML = '<p class="lp-fr-alert">' + H.escapeHtml(data.settingsWriteMessage || 'Ayar dosyası salt okunur.') + '</p>';
            updatePrimaryButton();
            return;
        }

        box.innerHTML = '';
        for (const s of settings) {
            const id = 'fld-' + s.key;
            const wrap = document.createElement('div');
            wrap.className = 'lp-fr-field';
            if (s.key === 'LOG_PLATFORM_PUBLIC_BASE_URL' || s.key === 'DEV_DEFAULT_CREDENTIALS') {
                wrap.classList.add('lp-fr-field-full');
            }

            const label = document.createElement('label');
            label.setAttribute('for', id);
            label.textContent = s.label || s.key;
            const hintParts = [(s.description || '').trim()];
            if (s.placeholder) hintParts.push('Örnek: ' + s.placeholder);
            label.insertAdjacentHTML('beforeend', H.hintMarkup(hintParts.filter(Boolean).join('\n\n')));

            let input;
            if (s.type === 'select') {
                input = document.createElement('select');
                (s.options || []).forEach((o) => {
                    const opt = document.createElement('option');
                    opt.value = o;
                    opt.textContent = o;
                    if (String(s.value) === String(o)) opt.selected = true;
                    input.appendChild(opt);
                });
            } else {
                input = document.createElement('input');
                input.type = s.type === 'password' ? 'password' : 'text';
                input.value = s.masked ? '' : (s.value ?? '');
                input.placeholder = s.placeholder || '';
            }
            input.id = id;

            wrap.appendChild(label);
            wrap.appendChild(input);
            box.appendChild(wrap);
        }

    }

    function passwordStrength(pw) {
        if (!pw) return { level: '', label: '' };
        if (pw.length < 8) return { level: 'weak', label: 'Zayıf — en az 8 karakter' };
        let score = 0;
        if (pw.length >= 12) score++;
        if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
        if (/\d/.test(pw)) score++;
        if (/[^A-Za-z0-9]/.test(pw)) score++;
        if (score <= 1) return { level: 'medium', label: 'Orta — daha uzun veya karmaşık yapın' };
        return { level: 'strong', label: 'Güçlü' };
    }

    function updatePasswordMeter() {
        const input = document.getElementById('adm-pass');
        const meter = document.querySelector('.lp-fr-password-meter');
        const hint = document.getElementById('adm-strength');
        if (!input || !meter) return;
        const s = passwordStrength(input.value);
        meter.classList.remove('is-weak', 'is-medium', 'is-strong');
        if (s.level) meter.classList.add('is-' + s.level);
        if (hint) hint.textContent = s.label;
    }

    async function saveAdminPassword() {
        const p = document.getElementById('adm-pass').value;
        const msg = document.getElementById('adm-msg');
        if (!p || p.length < 8) {
            if (msg) {
                msg.textContent = 'En az 8 karakter girin.';
                msg.classList.remove('is-ok');
            }
            return false;
        }
        try {
            await api('POST', '/api/users', { username: 'admin', password: p, role: 'admin', enabled: true });
            if (msg) {
                msg.textContent = 'Parola güncellendi. Oturumu kapatıp yeniden giriş yapmanız önerilir.';
                msg.classList.add('is-ok');
            }
            await refreshGate({ autoStep: true });
            return true;
        } catch (e) {
            if (msg) {
                msg.textContent = String(e.message || e);
                msg.classList.remove('is-ok');
            }
            return false;
        }
    }

    async function onPrimaryClick() {
        const btn = document.getElementById('btn-primary');
        if (btn) btn.disabled = true;
        try {
            if (currentStep === 1) {
                await saveAllK1();
                const g = await refreshGate({ autoStep: false });
                if (!k1FieldsMissing(g)) {
                    showStep(2);
                    maxUnlockedStep = Math.max(maxUnlockedStep, 2);
                    updateSummary(g);
                }
            } else if (currentStep === 2) {
                if (gateState && gateState.k2Complete) {
                    showStep(3);
                    maxUnlockedStep = 3;
                    updateSummary(gateState);
                }
            } else if (currentStep === 3) {
                await saveAdminPassword();
            }
        } catch (e) {
            showAlert(String(e.message || e));
        } finally {
            updatePrimaryButton();
        }
    }

    function bindNavigation() {
        document.querySelectorAll('[data-goto-step]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const n = Number(btn.getAttribute('data-goto-step'));
                if (btn.disabled || n > maxUnlockedStep) return;
                showStep(n);
                updateSummary(gateState);
            });
        });

        const back = document.getElementById('btn-back');
        if (back) {
            back.addEventListener('click', () => {
                if (currentStep === 2) showStep(1);
                else if (currentStep === 3) showStep(gateState && gateState.k2Complete ? 2 : 1);
                updateSummary(gateState);
            });
        }

        const primary = document.getElementById('btn-primary');
        if (primary) primary.addEventListener('click', onPrimaryClick);

        const admPass = document.getElementById('adm-pass');
        if (admPass) admPass.addEventListener('input', updatePasswordMeter);
    }

    function init() {
        if (!H) return;
        H.initHintDelegation();
        H.mountHint('hint-mount-gate', 'Yalnızca acil müdahale: LOG_SYSTEM_SETUP_GATE=0 ile kilidi geçici kapatabilirsiniz.');
        bindNavigation();
        loadCatalogAndForms()
            .then(() => refreshGate({ autoStep: true }))
            .catch((e) => showAlert(String(e)));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}());
