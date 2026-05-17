/**
 * LogPanel.modules.setupWizard — Ilk kurulum sihirbazi (9 adimli, form tabanli).
 *
 * Davranis:
 *  - Login sonrasi otomatik /api/setup/status cagirir
 *  - completed=false ve oturum admin ise overlay acilir; "Sonra" yalnizca zorunlu
 *    adimlardan eksik kalmamissa kullanilabilir.
 *  - Adimlar 3 bolum: required (atlanamaz), recommended, optional.
 *  - kind=form adimlari icin form render edilir, /api/setup/save/<id> ile kaydedilir.
 *  - kind=navigate adimlari icin "Aç" butonu sadece ilgili tab'a gecer, overlay kapanmaz.
 *  - Header "Hızlı Kurulum" butonu ile her zaman yeniden acilabilir.
 *
 * Bagimliliklar:
 *  - LogPanel.api (api.get / api.post)
 *  - LogPanel.ui  (ui.toast / ui.escapeHtml / ui.reportError)
 *  - LogPanel.state (admin rol kontrolu)
 *  - global switchTab (mevcut dashboard.js fonksiyonu)
 */
(function attachSetupWizard(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.setupWizard && NS.modules.setupWizard.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    const SESSION_FLAG = 'lp_setup_dismissed';
    const SECTION_LABELS = {
        required: { label: 'Zorunlu', tone: 'critical', desc: '' },
        recommended: { label: 'Önemli', tone: 'warn', desc: '' },
        optional: { label: 'Opsiyonel', tone: 'info', desc: '' },
    };

    function setupStepHelpBtn(helpKey) {
        return `<div class="lp-setup-help-row" style="margin:0 0 0.65rem 0;">
            <button type="button" class="btn btn-sm btn-secondary lp-inline-info-btn" data-help-key="${helpKey}" aria-expanded="false">
                <i class="fas fa-circle-info"></i> Bilgi al
            </button>
        </div>`;
    }

    function rebindSetupHelpButtons() {
        const h = NS.modules.help;
        if (h && typeof h.bindInlineHelpButtons === 'function') h.bindInlineHelpButtons();
    }

    // Adim form sablonlari — her adim icin (sistem bilgisinden gelen mevcut degerleri kullanir)
    const FORM_BUILDERS = {
        admin_password: function (info) {
            const inUse = info && info.admin_password && info.admin_password.defaultInUse;
            const banner = inUse
                ? '<div class="lp-setup-warn"><i class="fas fa-triangle-exclamation"></i> Default <code>admin</code> parolası hala aktif!</div>'
                : '<div class="lp-setup-ok"><i class="fas fa-check-circle"></i> Admin parolası özel olarak ayarlanmış.</div>';
            return `
                ${banner}
                ${setupStepHelpBtn('setup-wizard-admin-password')}
                <div class="lp-setup-actions">
                    <button class="btn btn-primary lp-setup-goto-tab" data-tab="users-security"><i class="fas fa-user-shield"></i> Kullanıcılar sekmesine git</button>
                </div>
            `;
        },

        company_info: function (info) {
            const c = (info && info.company_info) || {};
            const cid = ui.escapeHtml(c.company_id || 'default');
            const sid = ui.escapeHtml(c.site_id || '');
            const pt = ui.escapeHtml(c.panel_title || 'Log Sistem');
            const tz = c.timezone || 'Europe/Istanbul';
            return `
                ${setupStepHelpBtn('setup-wizard-company')}
                <div class="lp-setup-formgrid">
                    <label>
                        <span>Şirket / kurum kimliği <small>(company_id)</small></span>
                        <input type="text" name="company_id" value="${cid}" maxlength="64" placeholder="firma-adi" required title="Küçük harf, tire veya alt çizgi">
                    </label>
                    <label>
                        <span>Lokasyon / şube <small>(site_id, opsiyonel)</small></span>
                        <input type="text" name="site_id" value="${sid}" maxlength="64" placeholder="merkez veya ankara-dc1">
                    </label>
                    <label>
                        <span>Panel başlığı</span>
                        <input type="text" name="panel_title" value="${pt}" maxlength="80" placeholder="Log Sistem">
                    </label>
                    <label>
                        <span>Saat dilimi</span>
                        <select name="timezone">
                            ${['Europe/Istanbul','Europe/London','UTC','Europe/Berlin','Asia/Riyadh','Asia/Dubai','Europe/Moscow']
                                .map(t => `<option value="${t}" ${t===tz?'selected':''}>${t}</option>`).join('')}
                        </select>
                    </label>
                </div>
            `;
        },

        public_url: function (info) {
            const p = (info && info.public_url) || {};
            const cur = ui.escapeHtml(p.base_url || '');
            const hint = ui.escapeHtml(p.auto_detected_host || '');
            const suggested = hint ? `https://${hint}` : '';
            return `
                ${setupStepHelpBtn('setup-wizard-public-url')}
                <div class="lp-setup-formgrid">
                    <label>
                        <span>Public taban URL</span>
                        <input type="url" name="base_url" value="${cur || ui.escapeHtml(suggested)}" placeholder="https://logs.firma.com" required title="Panel ve agent için dış adres (https)">
                    </label>
                </div>
            `;
        },

        signer: function (info) {
            const s = (info && info.signer) || {};
            const t = (s.type || 'OPEN_SOURCE').toUpperCase();
            const tubi = ui.escapeHtml(s.tubitak_url || '');
            const rfc = ui.escapeHtml(s.rfc3161_url || 'https://freetsa.org/tsr');
            return `
                ${setupStepHelpBtn('setup-wizard-signer')}
                <div class="lp-setup-radio-group">
                    <label class="lp-setup-radio">
                        <input type="radio" name="type" value="TUBITAK" ${t==='TUBITAK'?'checked':''}>
                        <div>
                            <strong>TÜBİTAK Kamu SM TSA</strong>
                        </div>
                    </label>
                    <label class="lp-setup-radio">
                        <input type="radio" name="type" value="OPEN_SOURCE_RFC3161" ${t==='OPEN_SOURCE_RFC3161' || t==='OPEN_SOURCE'?'checked':''}>
                        <div>
                            <strong>Açık kaynak RFC3161</strong>
                        </div>
                    </label>
                    <label class="lp-setup-radio">
                        <input type="radio" name="type" value="OPEN_SOURCE_LOCAL" ${t==='OPEN_SOURCE_LOCAL'?'checked':''}>
                        <div>
                            <strong>Yerel offline</strong>
                        </div>
                    </label>
                </div>
                <div class="lp-setup-formgrid lp-setup-signer-urls">
                    <label data-show-when="type=TUBITAK">
                        <span>TÜBİTAK TSA URL</span>
                        <input type="url" name="tubitak_url" value="${tubi}">
                    </label>
                    <label data-show-when="type=OPEN_SOURCE_RFC3161">
                        <span>RFC3161 TSA URL</span>
                        <input type="url" name="rfc3161_url" value="${rfc}">
                    </label>
                </div>
                <div class="lp-setup-actions">
                    <button type="button" class="btn btn-secondary lp-setup-test-btn" data-test="signer"><i class="fas fa-plug"></i> Bağlantıyı test et</button>
                    <span class="lp-setup-test-result" data-result="signer"></span>
                </div>
            `;
        },

        tls: function (info) {
            const t = (info && info.tls) || {};
            const cp = ui.escapeHtml(t.cert_path || '');
            return `
                ${setupStepHelpBtn('setup-wizard-tls')}
                ${cp ? `<div class="lp-setup-ok"><i class="fas fa-check-circle"></i> Mevcut sertifika: <code>${cp}</code></div>` : ''}
                <div class="lp-setup-actions">
                    <button class="btn btn-primary lp-setup-goto-tab" data-tab="settings"><i class="fas fa-lock"></i> Ayarlar sekmesine git</button>
                </div>
            `;
        },

        retention: function (info) {
            const r = (info && info.retention) || {};
            const hot = parseInt(r.hot_days || '7', 10) || 7;
            const total = parseInt(r.total_days || '730', 10) || 730;
            const dp = ui.escapeHtml(r.data_path || '/opt/log-system/data');
            const disks = Array.isArray(r.disks) ? r.disks : [];
            const diskRows = disks.map(d => {
                const tone = d.usedPct > 85 ? 'critical' : (d.usedPct > 70 ? 'warn' : '');
                return `<tr class="${tone}"><td><code>${ui.escapeHtml(d.mountpoint)}</code></td><td>${ui.escapeHtml(d.fstype)}</td><td>${d.totalGb} GB</td><td>${d.freeGb} GB</td><td>${d.usedPct}%</td></tr>`;
            }).join('');
            return `
                ${setupStepHelpBtn('setup-wizard-retention')}
                <div class="lp-setup-formgrid">
                    <label>
                        <span>Hot retention (gün)</span>
                        <input type="number" name="hot_days" value="${hot}" min="1" max="365" title="Öneri 7–14">
                    </label>
                    <label>
                        <span>Toplam saklama (gün)</span>
                        <input type="number" name="total_days" value="${total}" min="730" max="3650" title="5651 min 730">
                    </label>
                    <label>
                        <span>Veri saklama yolu</span>
                        <input type="text" name="data_path" value="${dp}" placeholder="/opt/log-system/data">
                    </label>
                </div>
                ${disks.length ? `
                    <details class="lp-setup-details">
                        <summary>Mevcut diskler (${disks.length})</summary>
                        <table class="lp-setup-disktable">
                            <thead><tr><th>Mountpoint</th><th>FS</th><th>Toplam</th><th>Boş</th><th>Kullanım</th></tr></thead>
                            <tbody>${diskRows}</tbody>
                        </table>
                    </details>
                ` : ''}
            `;
        },

        backup_destination: function (info) {
            const b = (info && info.backup_destination) || {};
            const t = (b.type || 'local').toLowerCase();
            const ep = ui.escapeHtml(b.endpoint || '');
            const bk = ui.escapeHtml(b.bucket || '');
            return `
                ${setupStepHelpBtn('setup-wizard-backup')}
                <div class="lp-setup-radio-group">
                    <label class="lp-setup-radio"><input type="radio" name="type" value="local" ${t==='local'?'checked':''}><div><strong>Yerel disk</strong></div></label>
                    <label class="lp-setup-radio"><input type="radio" name="type" value="minio" ${t==='minio'?'checked':''}><div><strong>MinIO (S3 uyumlu)</strong></div></label>
                    <label class="lp-setup-radio"><input type="radio" name="type" value="s3" ${t==='s3'?'checked':''}><div><strong>AWS S3</strong></div></label>
                    <label class="lp-setup-radio"><input type="radio" name="type" value="sftp" ${t==='sftp'?'checked':''}><div><strong>SFTP</strong></div></label>
                </div>
                <div class="lp-setup-formgrid lp-setup-backup-fields" data-hide-when="type=local">
                    <label>
                        <span>Endpoint / host</span>
                        <input type="text" name="endpoint" value="${ep}" placeholder="minio.firma.com:9000 veya s3.eu-central-1.amazonaws.com">
                    </label>
                    <label data-show-when="type=minio,s3">
                        <span>Bucket</span>
                        <input type="text" name="bucket" value="${bk}" placeholder="log-archive">
                    </label>
                    <label>
                        <span>Access key / kullanıcı</span>
                        <input type="text" name="access_key" autocomplete="off">
                    </label>
                    <label>
                        <span>Secret key / parola</span>
                        <input type="password" name="secret_key" autocomplete="new-password">
                    </label>
                </div>
                <div class="lp-setup-actions">
                    <button type="button" class="btn btn-secondary lp-setup-test-btn" data-test="backup"><i class="fas fa-plug"></i> Bağlantıyı test et</button>
                    <span class="lp-setup-test-result" data-result="backup"></span>
                </div>
            `;
        },

        telegram: function (info) {
            const t = (info && info.telegram) || {};
            return `
                ${setupStepHelpBtn('setup-wizard-telegram')}
                <div class="lp-setup-formgrid">
                    <label>
                        <span>Bot token</span>
                        <input type="text" name="bot_token" placeholder="${t.has_token ? '****** (mevcut)' : '123456:ABC-...'}" autocomplete="off">
                    </label>
                    <label>
                        <span>Chat ID</span>
                        <input type="text" name="chat_id" placeholder="${t.has_chat ? '****** (mevcut)' : '123456789 veya -100123...'}" autocomplete="off">
                    </label>
                </div>
                <div class="lp-setup-actions">
                    <button type="button" class="btn btn-secondary lp-setup-test-btn" data-test="telegram"><i class="fas fa-paper-plane"></i> Test mesajı gönder</button>
                    <span class="lp-setup-test-result" data-result="telegram"></span>
                </div>
            `;
        },

        first_agent: function () {
            return `
                ${setupStepHelpBtn('setup-wizard-first-agent')}
                <div class="lp-setup-cards-3">
                    <div class="lp-setup-card-item">
                        <i class="fab fa-linux"></i>
                        <strong>Linux ajanı</strong>
                    </div>
                    <div class="lp-setup-card-item">
                        <i class="fab fa-windows"></i>
                        <strong>Windows ajanı</strong>
                    </div>
                    <div class="lp-setup-card-item">
                        <i class="fas fa-network-wired"></i>
                        <strong>Syslog cihazı</strong>
                    </div>
                </div>
                <div class="lp-setup-actions">
                    <button class="btn btn-primary lp-setup-goto-tab" data-tab="agent-fleet"><i class="fas fa-arrow-right"></i> Uç Envanteri'ne git</button>
                </div>
            `;
        },
    };

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }
    function _looksLikeOpenWizardCta(el) {
        if (!el) return false;
        const txt = String(el.textContent || '').trim().toLowerCase();
        return txt.includes('sihirbaz') || txt.includes('hızlı kurulum') || txt.includes('hizli kurulum');
    }

    function normalizeBannerBindings() {
        const banner = $('#lp-setup-banner') || $('.lp-setup-banner');
        if (!banner) return;
        if (!banner.id) banner.id = 'lp-setup-banner';

        let openBtn = $('#lp-setup-banner-open', banner);
        if (!openBtn) {
            openBtn = $('[data-setup-action="open"]', banner)
                || $('.lp-setup-banner-open', banner)
                || $$('button, a', banner).find((el) => _looksLikeOpenWizardCta(el));
            if (openBtn && !openBtn.id) openBtn.id = 'lp-setup-banner-open';
        }
    }

    function isAdmin() {
        return !!(NS.state && NS.state.isAdmin && NS.state.isAdmin());
    }

    let _state = {
        status: null,         // /api/setup/status response
        info: null,           // /api/setup/system-info response
        currentStepId: null,  // selected step id
        loading: false,
    };

    async function fetchStatus() {
        try { return await api.get('/api/setup/status'); } catch (_) { return null; }
    }

    async function fetchInfo() {
        try { return await api.get('/api/setup/system-info'); } catch (_) { return null; }
    }

    function open() {
        const m = $('#lp-setup-wizard');
        if (m) m.style.display = 'flex';
        try { sessionStorage.removeItem(SESSION_FLAG); } catch (_) {}
        refresh();
    }

    function close(opts) {
        const m = $('#lp-setup-wizard');
        if (m) m.style.display = 'none';
        if (!opts || opts.remember !== false) {
            try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch (_) {}
        }
    }

    function pickFirstPendingStep(steps) {
        const order = ['required', 'recommended', 'optional'];
        for (const sec of order) {
            const cand = steps.find(s => s.section === sec && !s.completed);
            if (cand) return cand.id;
        }
        return steps[0] ? steps[0].id : null;
    }

    function renderStepList(steps, currentId) {
        const sections = ['required', 'recommended', 'optional'];
        return sections.map(sec => {
            const items = steps.filter(s => s.section === sec);
            if (!items.length) return '';
            const meta = SECTION_LABELS[sec];
            return `
                <div class="lp-setup-section">
                    <div class="lp-setup-section-head">
                        <strong>${meta.label}</strong>
                        <span class="lp-setup-section-count">${items.filter(i => i.completed).length}/${items.length}</span>
                    </div>
                    ${meta.desc ? `<div class="lp-setup-section-desc help-text">${meta.desc}</div>` : ''}
                    <ul class="lp-setup-steplist">
                        ${items.map(i => `
                            <li class="${i.completed ? 'done' : ''} ${i.id===currentId?'active':''} ${i.severity==='critical'?'critical':''}" data-step-id="${ui.escapeHtml(i.id)}">
                                <i class="fas ${ui.escapeHtml(i.icon || 'fa-circle')}"></i>
                                <span class="lp-setup-step-title">${ui.escapeHtml(i.title)}</span>
                                ${i.completed ? '<i class="fas fa-check lp-setup-step-check" title="Tamamlandı"></i>' : ''}
                                ${i.severity==='critical' ? '<i class="fas fa-triangle-exclamation lp-setup-step-warn" title="Kritik"></i>' : ''}
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        }).join('');
    }

    function renderStepDetail(step, info) {
        if (!step) return '<p class="help-text">Sol panelden bir adım seçin.</p>';
        const builder = FORM_BUILDERS[step.id];
        const body = typeof builder === 'function' ? builder(info) : '<p class="help-text">Bu adım için form bulunmuyor.</p>';
        const isForm = step.kind === 'form';
        const isCompleted = step.completed;
        const note = step.note ? `<div class="lp-setup-note">${ui.escapeHtml(step.note)}</div>` : '';
        const descBlock = step.description
            ? `<details class="lp-setup-step-desc" style="margin:0.15rem 0 0.5rem;"><summary style="cursor:pointer;font-size:0.85rem;">API açıklaması</summary><p class="help-text" style="margin:0.35rem 0 0;">${ui.escapeHtml(step.description)}</p></details>`
            : '';
        return `
            <div class="lp-setup-detail-head">
                <div>
                    <div class="lp-setup-detail-section ${SECTION_LABELS[step.section]?.tone || ''}">${SECTION_LABELS[step.section]?.label || ''}</div>
                    <h3><i class="fas ${ui.escapeHtml(step.icon || 'fa-circle')}"></i> ${ui.escapeHtml(step.title)}</h3>
                    ${descBlock}
                </div>
                <div>
                    ${isCompleted ? '<span class="badge badge-success"><i class="fas fa-check"></i> Tamamlandı</span>' : ''}
                </div>
            </div>
            ${note}
            <form class="lp-setup-form" data-step-id="${ui.escapeHtml(step.id)}" data-kind="${ui.escapeHtml(step.kind || 'form')}">
                ${body}
                ${isForm ? `
                    <div class="lp-setup-form-actions">
                        <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> ${isCompleted ? 'Güncelle' : 'Kaydet ve devam et'}</button>
                        ${step.section !== 'required' ? `<button type="button" class="btn btn-secondary lp-setup-skip" data-step-id="${ui.escapeHtml(step.id)}"><i class="fas fa-forward"></i> Atla</button>` : ''}
                    </div>
                ` : ''}
            </form>
        `;
    }

    async function render() {
        const data = _state.status;
        const info = _state.info;
        if (!data) return;
        const root = $('#lp-setup-steps');
        const bar = $('#lp-setup-progress-bar');
        const label = $('#lp-setup-progress-label');
        const finalBtn = $('#lp-setup-finalize-btn');
        const dismissBtn = $('#lp-setup-close');
        if (!root) return;

        const percent = data.percent || 0;
        if (bar) bar.style.width = percent + '%';
        if (label) label.textContent = `${data.completedCount}/${data.totalSteps} adım tamamlandı (%${percent}) — ${data.requiredPending || 0} zorunlu eksik`;

        const reqMissing = (data.requiredPending || 0) > 0;
        if (finalBtn) finalBtn.style.display = reqMissing ? 'none' : '';
        if (dismissBtn) {
            dismissBtn.disabled = reqMissing;
            dismissBtn.title = reqMissing ? 'Zorunlu adımları tamamlamadan kapatamazsınız' : 'Sihirbazı sonra göster';
        }

        if (!_state.currentStepId) {
            _state.currentStepId = pickFirstPendingStep(data.steps);
        }
        const current = data.steps.find(s => s.id === _state.currentStepId);

        root.innerHTML = `
            <div class="lp-setup-layout">
                <aside class="lp-setup-sidebar">${renderStepList(data.steps, _state.currentStepId)}</aside>
                <section class="lp-setup-detail">${renderStepDetail(current, info)}</section>
            </div>
        `;

        bindStepInteractions(root);
        rebindSetupHelpButtons();
    }

    function bindStepInteractions(root) {
        // Sol panelden adim secimi
        $$('.lp-setup-steplist li[data-step-id]', root).forEach(li => {
            li.addEventListener('click', () => {
                _state.currentStepId = li.getAttribute('data-step-id');
                render();
            });
        });

        // "Aç" — sadece tab gec, OVERLAY'i kapatma
        $$('.lp-setup-goto-tab', root).forEach(b => {
            b.addEventListener('click', (e) => {
                e.preventDefault();
                const t = b.getAttribute('data-tab');
                if (typeof global.switchTab === 'function' && t) global.switchTab(t);
                // Overlay'i ucur ki kullanici hedef tab'i gorebilsin; pencereyi belirgin sekilde kapatmiyoruz
                const m = $('#lp-setup-wizard');
                if (m) m.style.display = 'none';
                // Sayfa degisiminin uzerinden gelecek API/UI guncellemesi sonrasi tekrar acmak icin hatirlat
                ui.toast('Sihirbaz gizlendi — sağ üstteki "Hızlı Kurulum" ikonuyla geri açabilirsiniz', 'info', 4000);
            });
        });

        // Atla — section==='required' olmayan adimlar icin
        $$('.lp-setup-skip', root).forEach(b => {
            b.addEventListener('click', async () => {
                const sid = b.getAttribute('data-step-id');
                try {
                    await api.post('/api/setup/complete-step', { step: sid, note: 'manuel atlandi' });
                    ui.toast('Adım atlandı', 'info');
                    _state.currentStepId = null;
                    refresh();
                } catch (e) { ui.reportError(e, { title: 'Atlama başarısız' }); }
            });
        });

        // Form submit — kaydet ve sonraki adima gec
        $$('form.lp-setup-form', root).forEach(f => {
            f.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (f.getAttribute('data-kind') !== 'form') return;
                const sid = f.getAttribute('data-step-id');
                const fd = new FormData(f);
                const obj = {};
                fd.forEach((v, k) => { obj[k] = v; });
                try {
                    await api.post('/api/setup/save/' + encodeURIComponent(sid), obj);
                    ui.toast('Adım kaydedildi', 'success');
                    _state.currentStepId = null;
                    refresh();
                } catch (err) { ui.reportError(err, { title: 'Kayıt başarısız' }); }
            });
        });

        // Test butonlari (signer / backup / telegram)
        $$('.lp-setup-test-btn', root).forEach(b => {
            b.addEventListener('click', async () => {
                const kind = b.getAttribute('data-test');
                const form = b.closest('form');
                const fd = new FormData(form);
                const obj = {};
                fd.forEach((v, k) => { obj[k] = v; });
                const result = root.querySelector(`.lp-setup-test-result[data-result="${kind}"]`);
                if (result) result.textContent = 'Test ediliyor…';
                try {
                    let endpoint, body;
                    if (kind === 'signer') {
                        endpoint = '/api/setup/test/signer';
                        const t = obj.type;
                        const url = t === 'TUBITAK' ? obj.tubitak_url : (t === 'OPEN_SOURCE_RFC3161' ? obj.rfc3161_url : '');
                        body = { type: t, url: url };
                    } else if (kind === 'backup') {
                        endpoint = '/api/setup/test/backup';
                        body = { type: obj.type, endpoint: obj.endpoint, bucket: obj.bucket, access_key: obj.access_key, secret_key: obj.secret_key };
                    } else if (kind === 'telegram') {
                        endpoint = '/api/setup/test/telegram';
                        body = { bot_token: obj.bot_token, chat_id: obj.chat_id };
                    } else { return; }
                    const r = await api.post(endpoint, body);
                    if (result) result.innerHTML = `<span class="lp-setup-ok"><i class="fas fa-check-circle"></i> ${ui.escapeHtml(r.note || 'Başarılı')}</span>`;
                } catch (err) {
                    if (result) result.innerHTML = `<span class="lp-setup-warn"><i class="fas fa-circle-xmark"></i> ${ui.escapeHtml((err && (err.message || err.error)) || 'Hata')}</span>`;
                }
            });
        });

        // data-show-when / data-hide-when conditional fields (signer urls, backup fields)
        $$('form.lp-setup-form input[type="radio"]', root).forEach(r => {
            r.addEventListener('change', () => updateConditionalVisibility(r.closest('form')));
        });
        $$('form.lp-setup-form', root).forEach(f => updateConditionalVisibility(f));
    }

    function updateConditionalVisibility(form) {
        if (!form) return;
        const radios = form.querySelectorAll('input[type="radio"]:checked');
        const radioVals = {};
        radios.forEach(r => { radioVals[r.name] = r.value; });
        $$('[data-show-when]', form).forEach(el => {
            const cond = el.getAttribute('data-show-when');
            const [name, vals] = cond.split('=');
            const allowed = (vals || '').split(',').map(s => s.trim());
            el.style.display = allowed.includes(radioVals[name]) ? '' : 'none';
        });
        $$('[data-hide-when]', form).forEach(el => {
            const cond = el.getAttribute('data-hide-when');
            const [name, vals] = cond.split('=');
            const blocked = (vals || '').split(',').map(s => s.trim());
            el.style.display = blocked.includes(radioVals[name]) ? 'none' : '';
        });
    }

    async function refresh() {
        if (_state.loading) return;
        _state.loading = true;
        try {
            const [status, info] = await Promise.all([fetchStatus(), fetchInfo()]);
            _state.status = status;
            _state.info = info;
            // Eger secili adim artik mevcut degilse sifirla
            if (_state.currentStepId && status && !status.steps.find(s => s.id === _state.currentStepId)) {
                _state.currentStepId = null;
            }
            await render();
        } finally {
            _state.loading = false;
        }
    }

    async function bootIfNeeded() {
        if (!api || !ui) return;
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (_) {}
        if (dismissed) return;

        const data = await fetchStatus();
        if (!data) return;
        // Yeni kural: zorunlu eksik VE finalize edilmemisse zorla ac
        const hasRequiredPending = (data.requiredPending || 0) > 0;
        const finalized = !!data.finalized;
        if (!hasRequiredPending && finalized) return;

        // Sadece admin'lere goster
        let role = NS.state && NS.state.data && NS.state.data.currentRole;
        if (!role) {
            try {
                const me = await api.get('/api/auth/me');
                role = me && me.role;
                if (NS.state && NS.state.setUser && me) NS.state.setUser({ username: me.username }, role);
            } catch (_) {}
        }
        if (String(role || '').toLowerCase() !== 'admin') return;

        _state.status = data;
        _state.info = await fetchInfo();
        const m = $('#lp-setup-wizard');
        if (m) m.style.display = 'flex';
        await render();
    }

    function bindGlobals() {
        normalizeBannerBindings();
        const closeBtn = $('#lp-setup-close');
        if (closeBtn && !closeBtn.__bound) {
            closeBtn.addEventListener('click', () => {
                if (closeBtn.disabled) return;
                close({ remember: true });
            });
            closeBtn.__bound = true;
        }
        const finalBtn = $('#lp-setup-finalize-btn');
        if (finalBtn && !finalBtn.__bound) {
            finalBtn.addEventListener('click', async () => {
                try {
                    await api.post('/api/setup/finalize', {});
                    ui.toast('Kurulum tamamlandı', 'success');
                    close({ remember: true });
                } catch (e) { ui.reportError(e, { title: 'İşlem başarısız' }); }
            });
            finalBtn.__bound = true;
        }
        // Header'daki "Hızlı Kurulum" butonu
        const reopenBtn = $('#lp-setup-reopen');
        if (reopenBtn && !reopenBtn.__bound) {
            reopenBtn.addEventListener('click', () => open());
            reopenBtn.__bound = true;
        }
        // Genel Bakış banneri "Sihirbazı aç" linki
        const bannerBtn = $('#lp-setup-banner-open');
        if (bannerBtn && !bannerBtn.__bound) {
            bannerBtn.addEventListener('click', () => open());
            bannerBtn.__bound = true;
        }
        if (!document.__lpSetupWizardDelegatedOpenBound) {
            document.addEventListener('click', (ev) => {
                const target = ev.target && ev.target.closest
                    ? ev.target.closest('#lp-setup-reopen, #lp-setup-banner-open, [data-setup-action="open"], .lp-setup-banner-open, .lp-setup-banner button, .lp-setup-banner a')
                    : null;
                if (!target) return;
                if (!_looksLikeOpenWizardCta(target) && !target.matches('#lp-setup-reopen, #lp-setup-banner-open, [data-setup-action="open"], .lp-setup-banner-open')) return;
                ev.preventDefault();
                open();
            }, true);
            document.__lpSetupWizardDelegatedOpenBound = true;
        }
    }

    function init() {
        if (!api || !ui) return;
        bindGlobals();
        setTimeout(bootIfNeeded, 1500);
        // Banner durumunu zamanla guncelle
        setTimeout(updateBanner, 2200);
    }

    async function updateBanner() {
        const banner = $('#lp-setup-banner');
        if (!banner) return;
        const data = await fetchStatus();
        if (!data) return;
        const reqMissing = (data.requiredPending || 0) > 0;
        const total = data.totalSteps || 9;
        const done = data.completedCount || 0;
        if (reqMissing || done < total) {
            banner.style.display = '';
            const text = reqMissing
                ? `${data.requiredPending} zorunlu kurulum adımı tamamlanmadı`
                : `${total - done} kurulum adımı tamamlanmayı bekliyor`;
            const t = banner.querySelector('#lp-setup-banner-text');
            if (t) t.textContent = text;
            banner.classList.toggle('lp-setup-banner-critical', reqMissing);
        } else {
            banner.style.display = 'none';
        }
    }

    NS.modules.setupWizard = {
        __sealed: true,
        init,
        open,
        close,
        refresh,
        updateBanner,
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 800);
    });
})(window);
