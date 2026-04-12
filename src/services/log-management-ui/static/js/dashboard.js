/**
 * Log Sistem Yönetim Paneli - Dashboard JavaScript
 * Professional unified management interface for Log Sistem
 */

// Global state
let currentFile = null;
let fileContent = {};
let originalConfigContent = {};
let services = {};
let autoRefreshInterval = null;
let platformInfo = { platform: 'unknown' };
let latestOpsSummary = null;
let latestOpsAction = null;
let storageCandidates = [];
/** @type {object|null} */
let lastRecommendedPlan = null;
/** @type {object|null} Son genişletme durumu özeti (bölüm yolu doğrulaması için). */
let lastDataDiskGrowSnapshot = null;
/** @type {object|null} Kök (/) FS genişletme özeti */
let lastOsDiskGrowSnapshot = null;
/** Konteyner adı → { dataBytes, bindPaths, composeService } */
let serviceStorageByContainer = {};
/** /api/services/storage sharedFilesystems — aygıt bazında tekilleştirilmiş df özeti */
let serviceStorageSharedFs = [];
let eligibleRawDisks = [];
let storageDiskHints = [];
/** Son /api/observability/metrics diskProfile (özet rozetler için) */
let lastDiskProfile = null;
/** Son mount-status yanıtı */
let lastStorageMountSnapshot = null;
let storageWorkflow = null;
let agentProfiles = [];
let agentEnrollmentTokens = [];
let agentNodes = [];
/** @type {string} */
let fleetHostSearchQuery = '';
let fleetHostsTableDelegated = false;
let agentOnboardingHistory = [];
let onboardingWizardStep = 1;
let onboardingSelfTestProbe = '';
const onboardingWizardState = { scenario: null, canInstall: null };
let guidedSettings = [];
let guidedSettingsDraftValues = {};
let activeSettingsGroup = 'all';
const collapsedSettingsGroups = new Set();
let pendingSettingChange = null;
let settingsWritable = true;
let settingsWriteMessage = '';
let settingsAutoApplyAvailable = false;
let latestHealth = null;
let latestConfigFiles = [];
let rawLogEvents = [];
let filteredLogEvents = [];
let logsPage = 1;
let logsPageSize = 50;
let monitoringHealthChart = null;
let latestAuditEvents = [];
let overviewActionStatus = {
    backup: null,
    validation: null,
    restartAll: null
};
let dataFreshness = {};
let lastOverviewIntelligenceFetch = 0;
let lastSettingsOverviewFetch = 0;
let servicesProblematicOnly = false;
let serviceActionStatus = {
    bulk: null,
    lastSingle: null,
    lastScale: null
};
let pipelineHealthState = null;
let pipelineTrendHistory = [];
let latestSettingsPostCheck = null;
let latestSettingsOpsSnapshot = null;
let csrfToken = null;
let overviewSloSnapshot = {
    epsText: '-',
    dropRateText: '-',
    latencyText: '-',
    bottleneckText: 'Bekleniyor',
    bottleneckClass: 'status-unknown',
    freshnessText: 'Henüz alınmadı'
};
const PIPELINE_TREND_WINDOW_MS = 60 * 1000;
let currentUserRole = 'viewer';
const roleWeights = {
    viewer: 1,
    operator: 2,
    admin: 3
};

const settingsGuides = {
    GRAYLOG_PASSWORD_SECRET: {
        placeholder: 'En az 32 karakter güçlü rastgele dize',
        hint: 'Giriş parolası değil. Sadece ilk kurulum veya güvenlik gerekiyorsa değiştirin.'
    },
    GRAYLOG_ROOT_PASSWORD: {
        placeholder: 'Graylog admin için yeni parola (düz metin)',
        hint: 'Kayıtta SHA2 .env’e yazılır; panel arka planda Mongo’daki admin kaydını sıfırlayıp graylog, bu panel ve watchdog’u yeniler (~1–2 dk). Sayfayı sonra yenileyin.'
    },
    TZ: {
        placeholder: 'Europe/Istanbul',
        hint: 'IANA timezone formatı kullanın. Ör: Europe/Istanbul'
    },
    ARCHIVE_DESTINATION: {
        placeholder: 'local | minio:bucket | s3:bucket | sftp:server/path',
        hint: 'Arşiv türünü seçin, hedefi ayrı girin. Hatalı format engellenir.'
    },
    SMTP_HOST: {
        placeholder: 'smtp.example.com',
        hint: 'Sadece host adı girin (http/https yazmayın).'
    },
    SESSION_TIMEOUT_MINUTES: {
        placeholder: '60',
        hint: 'Önerilen aralık: 5 - 1440 dakika'
    }
};

// Tehlikeli işlem onay modalı - yanlışlıkla sistemi bozmayı önler
let confirmDangerResolve = null;

function closeConfirmDangerModal() {
    const modal = document.getElementById('confirm-danger-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    if (confirmDangerResolve) {
        confirmDangerResolve(false);
        confirmDangerResolve = null;
    }
}

function confirmDangerSubmit() {
    const typetoEl = document.getElementById('confirm-danger-typeto');
    const inputEl = document.getElementById('confirm-danger-input');
    const requireType = typetoEl && typetoEl.style.display !== 'none';
    if (requireType && inputEl && inputEl.value.trim().toUpperCase() !== 'ONAYLA') return;

    const modal = document.getElementById('confirm-danger-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    if (confirmDangerResolve) {
        confirmDangerResolve(true);
        confirmDangerResolve = null;
    }
}

async function confirmDangerousAction(options) {
    return new Promise((resolve) => {
        confirmDangerResolve = resolve;
        const modal = document.getElementById('confirm-danger-modal');
        const msgEl = document.getElementById('confirm-danger-message');
        const detailEl = document.getElementById('confirm-danger-detail');
        const typetoEl = document.getElementById('confirm-danger-typeto');
        const inputEl = document.getElementById('confirm-danger-input');
        const submitBtn = document.getElementById('confirm-danger-submit');

        if (!modal || !msgEl) return resolve(false);

        msgEl.textContent = options.message || 'Bu işlem geri alınamaz. Devam etmek istediğinize emin misiniz?';
        if (detailEl) {
            detailEl.textContent = options.detail || '';
            detailEl.style.display = options.detail ? 'block' : 'none';
        }

        const requireType = options.requireType === true;
        if (typetoEl) typetoEl.style.display = requireType ? 'block' : 'none';
        if (inputEl) {
            inputEl.value = '';
            inputEl.onkeyup = () => {
                if (submitBtn) submitBtn.disabled = requireType ? inputEl.value.trim().toUpperCase() !== 'ONAYLA' : false;
            };
        }
        if (submitBtn) submitBtn.disabled = requireType;

        modal.style.display = 'flex';
        modal.classList.add('show');
        if (inputEl && requireType) setTimeout(() => inputEl.focus(), 100);
    });
}

function showSessionExpiredToast() {
    const existing = document.getElementById('session-expired-toast');
    if (existing) return;
    const toast = document.createElement('div');
    toast.id = 'session-expired-toast';
    toast.style.cssText = 'position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:10000;background:#1f2937;color:#fff;padding:0.85rem 1.25rem;border-radius:0.5rem;font-size:0.9rem;box-shadow:0 10px 25px rgba(0,0,0,0.2);display:flex;align-items:center;gap:0.5rem;';
    toast.innerHTML = '<i class="fas fa-exclamation-circle"></i> Oturumunuz sona erdi. Giriş sayfasına yönlendiriliyorsunuz...';
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.remove();
        window.location.href = '/login';
    }, 2000);
}

async function ensureCsrfToken() {
    if (csrfToken) return;
    try {
        const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!r.ok) return;
        const data = await r.json();
        if (data && data.csrfToken) {
            csrfToken = data.csrfToken;
        }
    } catch (e) {
        /* ignore */
    }
}

async function apiRequest(url, options = {}) {
    const requestOptions = { ...options };
    requestOptions.credentials = requestOptions.credentials || 'same-origin';
    const method = (requestOptions.method || 'GET').toUpperCase();
    const headers = new Headers(requestOptions.headers || {});

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutating) {
        await ensureCsrfToken();
    }
    if (mutating && csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    requestOptions.headers = headers;

    const response = await fetch(url, requestOptions);

    if (response.status === 401) {
        showSessionExpiredToast();
        throw new Error('Authentication required');
    }

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const payload = isJson ? await response.json() : { raw: await response.text() };

    if (payload && payload.csrfToken) {
        csrfToken = payload.csrfToken;
    }

    if (!response.ok) {
        const message = payload.error || payload.message || `HTTP ${response.status}`;
        const err = new Error(message);
        err.status = response.status;
        err.body = payload;
        throw err;
    }

    return payload;
}

/** Veri diski API’leri yeni panelde; eski imaj HTTP 404 döner. */
const STORAGE_PANEL_MIN_API_REVISION = 3;

function normalizeStorageMountPath(p) {
    return String(p || '').trim().replace(/\/+$/, '') || '';
}

function getStorageEffectiveEnv() {
    const hid = document.getElementById('storage-env-name');
    const v = hid && hid.value ? hid.value.trim() : '';
    return v || 'prod';
}

async function loadEffectiveStorageEnv() {
    const lab = document.getElementById('storage-env-effective-label');
    const hid = document.getElementById('storage-env-name');
    try {
        const r = await fetch('/api/health', { credentials: 'same-origin' });
        const j = await r.json();
        const env = j && j.panel && j.panel.storageEnv ? String(j.panel.storageEnv) : 'prod';
        if (hid) hid.value = env;
        if (lab) lab.textContent = `Ortam: ${env} (sunucu APP_ENV / LOG_SYSTEM_ENV)`;
    } catch (e) {
        if (lab) lab.textContent = 'Ortam: alınamadı — prod varsayılan';
        if (hid && !hid.value) hid.value = 'prod';
    }
}

function humanizeStoragePanelError(err) {
    const raw = err && err.message != null ? String(err.message) : String(err);
    const st = err && err.status;
    const looks404 = st === 404 || /\b404\b/.test(raw);
    if (!looks404) return raw;
    const hint =
        'Çalışan panel eski olabilir. Sunucuda: docker compose build log-management-ui && docker compose up -d log-management-ui';
    if (raw.includes('docker compose build')) return raw;
    const head =
        raw === 'HTTP 404' || /^not\s*found$/i.test(raw.trim()) ? 'Bu özellik bu panel sürümünde yok (HTTP 404)' : raw;
    return `${head}. ${hint}`;
}

async function updateStorageApiStaleBanner() {
    const el = document.getElementById('storage-api-stale-banner');
    if (!el) return;
    try {
        const h = await apiRequest('/api/health');
        const rev =
            h && h.panel && typeof h.panel.storageApiRevision === 'number'
                ? h.panel.storageApiRevision
                : null;
        if (rev == null || rev < STORAGE_PANEL_MIN_API_REVISION) {
            el.style.display = 'block';
            el.innerHTML =
                '<strong>Panel sürüm uyarısı.</strong> Plan / genişletme istekleri 404 dönüyorsa imajı güncelleyin. ' +
                '<code style="display:block;margin-top:0.4rem;font-size:0.78rem;word-break:break-all;">docker compose build log-management-ui && docker compose up -d log-management-ui</code>';
        } else {
            el.style.display = 'none';
            el.textContent = '';
        }
    } catch {
        el.style.display = 'none';
        el.textContent = '';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeTheme();
    initializeDashboard();
    setupEventListeners();
    renderSettingsRuntimeStatus();
    renderSettingsPostCheck();
    loadCurrentUser();
    loadAllData();
    startAutoRefresh();
    setTimeout(hideStartupSplash, 1500);
});

function initializeDashboard() {
    console.log('Dashboard initializing...');
    setupNavigationListeners();
}

function hasAtLeastRole(requiredRole) {
    const current = roleWeights[currentUserRole] || 0;
    const required = roleWeights[requiredRole] || 99;
    return current >= required;
}

function setButtonPermission(buttonId, enabled, deniedTitle) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.disabled = !enabled;
    if (!enabled && deniedTitle) {
        button.title = deniedTitle;
    }
}

function applyRoleBasedUiAccess() {
    const canOperate = hasAtLeastRole('operator');
    const canAdmin = hasAtLeastRole('admin');

    setButtonPermission('restart-all-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('backup-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('validate-config-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('ops-sanity-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('ops-flow-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('ops-stream-repair-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-refresh-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-rescan-bus-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('storage-candidate-select', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-apply-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('storage-raw-disk-select', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-prepare-disk-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('storage-recommended-plan-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-complete-recommended-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('storage-grow-refresh-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-grow-exec-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('storage-os-grow-refresh-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('storage-os-grow-exec-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    const storageRecConfirm = document.getElementById('storage-recommended-confirm');
    if (storageRecConfirm) {
        storageRecConfirm.disabled = !canAdmin;
        if (!canAdmin) storageRecConfirm.title = 'Bu işlem için admin rolü gerekli';
    }
    ['storage-recommended-wipe', 'storage-recommended-relocate', 'storage-recommended-rescan-first'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.disabled = !canAdmin;
            if (!canAdmin) el.title = 'Tam kurulum için admin rolü gerekli';
        }
    });
    const storageConfirmDev = document.getElementById('storage-confirm-device');
    if (storageConfirmDev) {
        storageConfirmDev.disabled = !canAdmin;
        if (!canAdmin) storageConfirmDev.title = 'Bu işlem için admin rolü gerekli';
    }
    const growConfirmIn = document.getElementById('storage-grow-confirm-part');
    if (growConfirmIn) {
        growConfirmIn.disabled = !canAdmin;
        if (!canAdmin) growConfirmIn.title = 'Bu işlem için admin rolü gerekli';
    }
    const osGrowConfirmIn = document.getElementById('storage-os-grow-confirm-part');
    if (osGrowConfirmIn) {
        osGrowConfirmIn.disabled = !canAdmin;
        if (!canAdmin) osGrowConfirmIn.title = 'Bu işlem için admin rolü gerekli';
    }
    const applyPathConfirm = document.getElementById('storage-apply-confirm-path');
    if (applyPathConfirm) {
        applyPathConfirm.disabled = !canAdmin;
        if (!canAdmin) applyPathConfirm.title = 'Bu işlem için admin rolü gerekli';
    }
    const storageWipeCb = document.getElementById('storage-wipe-disk');
    if (storageWipeCb) {
        storageWipeCb.disabled = !canAdmin;
        if (!canAdmin) storageWipeCb.title = 'Bu işlem için admin rolü gerekli';
    }
    setButtonPermission('agent-refresh-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('agent-profile-select', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('agent-create-token-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('onboarding-wizard-token-btn', canAdmin, 'Token için admin rolü gerekli');
    setButtonPermission('agent-token-revoke-select', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('agent-revoke-token-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    setButtonPermission('agent-copy-install-btn', canAdmin, 'Bu işlem için admin rolü gerekli');
    const navFleet = document.getElementById('nav-agent-fleet');
    if (navFleet) {
        navFleet.style.display = canOperate ? '' : 'none';
    }
    const fleetSearch = document.getElementById('fleet-host-search');
    if (fleetSearch) {
        fleetSearch.disabled = !canOperate;
        if (!canOperate) fleetSearch.title = 'Operator rolü gerekli';
        else fleetSearch.removeAttribute('title');
    }
    setButtonPermission('validate-btn', canOperate, 'Bu işlem için operator rolü gerekli');
    setButtonPermission('save-config-btn', canAdmin, 'Bu işlem için admin rolü gerekli');

    const restartProblematicBtn = document.getElementById('services-restart-problematic-btn');
    if (restartProblematicBtn) {
        restartProblematicBtn.disabled = !canOperate;
        if (!canOperate) restartProblematicBtn.title = 'Bu işlem için operator rolü gerekli';
    }

    const logsControls = [
        'logs-refresh-btn', 'logs-export-btn', 'logs-search-input', 'log-service-filter',
        'log-level-filter', 'logs-page-size', 'logs-prev-page', 'logs-next-page'
    ];
    logsControls.forEach(controlId => {
        const element = document.getElementById(controlId);
        if (!element) return;
        element.disabled = !canOperate;
        if (!canOperate) {
            element.title = 'Audit/log görünümü için operator rolü gerekli';
        }
    });

    const settingsPostCheckBtn = document.getElementById('settings-post-check-run-btn');
    if (settingsPostCheckBtn) {
        settingsPostCheckBtn.disabled = !canOperate;
        if (!canOperate) {
            settingsPostCheckBtn.title = 'Post-check için operator rolü gerekli';
        }
    }

    applyStoragePreparePolicyLocks();
}

function applyPlatformSpecificVisibility() {
    const isK8s = platformInfo.platform === 'k8s';
    const k8sGrid = document.getElementById('settings-k8s-ops-grid');
    if (k8sGrid) k8sGrid.style.display = isK8s ? '' : 'none';
    const perfWrap = document.getElementById('settings-compose-perf-wrap');
    if (perfWrap) perfWrap.style.display = isK8s ? 'none' : '';
    document.querySelectorAll('.settings-subnav-link-k8s').forEach((el) => {
        el.style.display = isK8s ? '' : 'none';
    });
    document.querySelectorAll('.settings-subnav-link-compose').forEach((el) => {
        el.style.display = isK8s ? 'none' : '';
    });
}

function renderLogsPermissionDenied() {
    const message = 'Audit log görüntülemek için operator rolü gerekli.';
    const auditContainer = document.getElementById('audit-events-list');
    const logsViewer = document.getElementById('logs-viewer');
    const logsSummary = document.getElementById('logs-summary');
    if (auditContainer) auditContainer.innerHTML = `<p class="loading">${message}</p>`;
    if (logsViewer) logsViewer.innerHTML = `<p class="loading">${message}</p>`;
    if (logsSummary) logsSummary.textContent = message;
}

function setupNavigationListeners() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabName = item.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // Show selected tab
    const tabElement = document.getElementById(tabName);
    if (tabElement) {
        tabElement.classList.add('active');
    }

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('data-tab') === tabName) {
            item.classList.add('active');
        }
    });

    // Update header
    const titles = {
        overview: { title: 'Genel Bakış', subtitle: 'Sistem durumu ve yapılandırma yönetimi' },
        services: { title: 'Servisler', subtitle: 'Tüm hizmetleri yönetin ve kontrolü' },
        config: { title: 'Yapılandırma', subtitle: 'Sistem ayarlarını düzenleyin' },
        'agent-fleet': { title: 'Uç nokta envanteri', subtitle: 'Kayıtlı hostlar, log hacmi ve kurulum' },
        settings: { title: 'Ayarlar', subtitle: '.env kataloğu, depolama ve doğrulama' },
        monitoring: { title: 'İzleme', subtitle: 'Gerçek zamanlı sistem metrikleri' },
        logs: { title: 'Loglar', subtitle: 'Sistem loglarını görüntüleyin' },
        archive: { title: 'Arşiv / WORM', subtitle: '5651 uyumlu arşiv durumu ve retention' }
    };

    if (titles[tabName]) {
        document.getElementById('page-title').textContent = titles[tabName].title;
        document.getElementById('page-subtitle').textContent = titles[tabName].subtitle;
    }

    // Load tab-specific data
    if (tabName === 'services') {
        loadServices();
    } else if (tabName === 'config') {
        loadConfigFiles();
    } else if (tabName === 'agent-fleet') {
        applyPlatformSpecificVisibility();
        void loadAgentFleetData();
        void initOnboardingWizard();
    } else if (tabName === 'settings') {
        applyPlatformSpecificVisibility();
        loadGuidedSettings();
        loadStorageCandidates();
        loadNormalizationData();
        loadReleaseStatus();
        loadHpaPolicies();
        populateRolloutDeployments();
    } else if (tabName === 'monitoring') {
        loadMonitoringData();
    } else if (tabName === 'logs') {
        if (hasAtLeastRole('operator')) {
            loadLogs();
            loadAuditEvents();
            loadContainerList();
        } else {
            renderLogsPermissionDenied();
        }
    } else if (tabName === 'archive') {
        loadArchiveStatus();
        loadArchiveRetention();
    }
}

async function loadCurrentUser() {
    try {
        const data = await apiRequest('/api/auth/me');
        if (data && !data.error) {
            currentUserRole = data.role || 'viewer';
            if (data.csrfToken) {
                csrfToken = data.csrfToken;
            }
            const pill = document.getElementById('current-user-pill');
            if (pill) {
                pill.textContent = `Kullanıcı: ${data.username || '-'} (${data.role || '-'})`;
            }
            applyRoleBasedUiAccess();
        }
    } catch (error) {
        console.error('Error loading current user:', error);
    }
}

async function logout() {
    try {
        await fetch('/logout', { method: 'POST' });
    } finally {
        window.location.href = '/login';
    }
}

function setupEventListeners() {
    // Header buttons
    document.getElementById('refresh-btn').addEventListener('click', loadAllData);
    document.getElementById('help-btn').addEventListener('click', showHelp);
    document.getElementById('logout-btn').addEventListener('click', logout);
    const themeToggle = document.getElementById('theme-toggle-btn');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    // Quick action buttons
    document.getElementById('restart-all-btn').addEventListener('click', restartAllServices);
    document.getElementById('backup-btn').addEventListener('click', backupConfig);
    document.getElementById('validate-config-btn').addEventListener('click', validateAllConfig);
    const opsSanityBtn = document.getElementById('ops-sanity-btn');
    if (opsSanityBtn) opsSanityBtn.addEventListener('click', runOpsSanityCheck);
    const opsFlowBtn = document.getElementById('ops-flow-btn');
    if (opsFlowBtn) opsFlowBtn.addEventListener('click', runOpsFlowTest);
    const opsStreamRepairBtn = document.getElementById('ops-stream-repair-btn');
    if (opsStreamRepairBtn) opsStreamRepairBtn.addEventListener('click', runOpsStreamRepair);

    // Config editor buttons
    document.getElementById('save-config-btn').addEventListener('click', saveConfig);
    document.getElementById('cancel-config-btn').addEventListener('click', cancelConfigEdit);
    document.getElementById('validate-btn').addEventListener('click', validateCurrentConfig);

    // Service filter
    document.getElementById('service-filter').addEventListener('input', filterServices);
    const problematicToggle = document.getElementById('services-problematic-toggle');
    if (problematicToggle) {
        problematicToggle.addEventListener('click', toggleServicesProblematicOnly);
    }

    const restartProblematicBtn = document.getElementById('services-restart-problematic-btn');
    if (restartProblematicBtn) {
        restartProblematicBtn.addEventListener('click', restartProblematicServices);
    }

    const clearServicesFilter = document.getElementById('services-clear-filter-btn');
    if (clearServicesFilter) {
        clearServicesFilter.addEventListener('click', resetServicesFilters);
    }

    const settingsSearch = document.getElementById('settings-search');
    if (settingsSearch) {
        settingsSearch.addEventListener('input', applyGuidedSettingsFilters);
    }

    const settingsCategoryFilters = document.getElementById('settings-category-filters');
    if (settingsCategoryFilters) {
        settingsCategoryFilters.addEventListener('click', (event) => {
            const button = event.target.closest('[data-group]');
            if (!button) return;
            activeSettingsGroup = button.getAttribute('data-group') || 'all';
            applyGuidedSettingsFilters();
            updateSettingsCategorySelection();
        });
    }

    const settingsCollapseAll = document.getElementById('settings-collapse-all-btn');
    if (settingsCollapseAll) {
        settingsCollapseAll.addEventListener('click', collapseAllSettingGroups);
    }

    const settingsExpandAll = document.getElementById('settings-expand-all-btn');
    if (settingsExpandAll) {
        settingsExpandAll.addEventListener('click', expandAllSettingGroups);
    }

    const settingsPostCheckBtn = document.getElementById('settings-post-check-run-btn');
    if (settingsPostCheckBtn) {
        settingsPostCheckBtn.addEventListener('click', () => runSettingsPostCheck('manual'));
    }

    const storageRefreshBtn = document.getElementById('storage-refresh-btn');
    if (storageRefreshBtn) {
        storageRefreshBtn.addEventListener('click', loadStorageCandidates);
    }

    const diskGuidanceGoto = document.getElementById('disk-guidance-goto-storage');
    if (diskGuidanceGoto) {
        diskGuidanceGoto.addEventListener('click', () => {
            switchTab('settings');
            document.getElementById('settings-storage-data-disk')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    const diskGuidanceDismiss = document.getElementById('disk-guidance-dismiss');
    if (diskGuidanceDismiss) {
        diskGuidanceDismiss.addEventListener('click', () => {
            try {
                sessionStorage.setItem('diskGuidanceDismissed', '1');
            } catch (e) { /* ignore */ }
            document.getElementById('disk-guidance-banner')?.classList.add('disk-guidance-hidden');
        });
    }

    const storageRescanBusBtn = document.getElementById('storage-rescan-bus-btn');
    if (storageRescanBusBtn) {
        storageRescanBusBtn.addEventListener('click', rescanStorageHostBuses);
    }

    const storageApplyBtn = document.getElementById('storage-apply-btn');
    if (storageApplyBtn) {
        storageApplyBtn.addEventListener('click', applySelectedStorageProfile);
    }

    const storagePrepareDiskBtn = document.getElementById('storage-prepare-disk-btn');
    if (storagePrepareDiskBtn) {
        storagePrepareDiskBtn.addEventListener('click', prepareRawDiskAndApply);
    }

    const storageRecommendedPlanBtn = document.getElementById('storage-recommended-plan-btn');
    if (storageRecommendedPlanBtn) {
        storageRecommendedPlanBtn.addEventListener('click', () => {
            const rcb = document.getElementById('storage-recommended-rescan-cb');
            loadRecommendedSetupPlan(!!(rcb && rcb.checked));
        });
    }
    const storageCompleteRecommendedBtn = document.getElementById('storage-complete-recommended-btn');
    if (storageCompleteRecommendedBtn) {
        storageCompleteRecommendedBtn.addEventListener('click', completeRecommendedStorageSetup);
    }

    const storageGrowRefreshBtn = document.getElementById('storage-grow-refresh-btn');
    if (storageGrowRefreshBtn) {
        storageGrowRefreshBtn.addEventListener('click', () => loadDataDiskGrowStatus());
    }
    const storageGrowExecBtn = document.getElementById('storage-grow-exec-btn');
    if (storageGrowExecBtn) {
        storageGrowExecBtn.addEventListener('click', executeDataDiskGrow);
    }

    const storageOsGrowRefreshBtn = document.getElementById('storage-os-grow-refresh-btn');
    if (storageOsGrowRefreshBtn) {
        storageOsGrowRefreshBtn.addEventListener('click', () => loadOsDiskGrowStatus());
    }
    const storageOsGrowExecBtn = document.getElementById('storage-os-grow-exec-btn');
    if (storageOsGrowExecBtn) {
        storageOsGrowExecBtn.addEventListener('click', executeOsDiskGrow);
    }

    const agentRefreshBtn = document.getElementById('agent-refresh-btn');
    if (agentRefreshBtn) {
        agentRefreshBtn.addEventListener('click', loadAgentFleetData);
    }
    const fleetHostSearch = document.getElementById('fleet-host-search');
    if (fleetHostSearch) {
        fleetHostSearch.addEventListener('input', () => {
            fleetHostSearchQuery = (fleetHostSearch.value || '').trim().toLowerCase();
            renderFleetHostsTable();
        });
    }

    const agentCreateTokenBtn = document.getElementById('agent-create-token-btn');
    if (agentCreateTokenBtn) {
        agentCreateTokenBtn.addEventListener('click', createAgentEnrollmentToken);
    }

    const agentRevokeTokenBtn = document.getElementById('agent-revoke-token-btn');
    if (agentRevokeTokenBtn) {
        agentRevokeTokenBtn.addEventListener('click', revokeSelectedAgentToken);
    }

    const agentCopyInstallBtn = document.getElementById('agent-copy-install-btn');
    if (agentCopyInstallBtn) {
        agentCopyInstallBtn.addEventListener('click', copyAgentInstallCommand);
    }
    const agentCopyInstallWinBtn = document.getElementById('agent-copy-install-win-btn');
    if (agentCopyInstallWinBtn) {
        agentCopyInstallWinBtn.addEventListener('click', copyAgentInstallCommandWin);
    }
    const agentCopyUninstallWinBtn = document.getElementById('agent-copy-uninstall-win-btn');
    if (agentCopyUninstallWinBtn) {
        agentCopyUninstallWinBtn.addEventListener('click', copyAgentUninstallCommandWin);
    }

    const obNext = document.getElementById('onboarding-wizard-next');
    if (obNext) obNext.addEventListener('click', onboardingWizardNext);
    const obBack = document.getElementById('onboarding-wizard-back');
    if (obBack) obBack.addEventListener('click', onboardingWizardBack);
    const obTok = document.getElementById('onboarding-wizard-token-btn');
    if (obTok) obTok.addEventListener('click', onboardingWizardCreateToken);
    const obChk = document.getElementById('onboarding-wizard-check-graylog');
    if (obChk) obChk.addEventListener('click', checkOnboardingGraylog);
    const obNewP = document.getElementById('onboarding-wizard-new-probe');
    if (obNewP) obNewP.addEventListener('click', () => loadOnboardingSelfTestInstructions(true));
    const obCpL = document.getElementById('onboarding-wizard-copy-linux');
    if (obCpL) obCpL.addEventListener('click', () => {
        const t = document.getElementById('onboarding-wizard-linux-cmd');
        if (t && t.value) copyTextToClipboard(t.value).then(ok => showAlert(ok ? 'Kopyalandı' : 'Kopyalanamadı', ok ? 'success' : 'danger'));
    });
    const obCpP = document.getElementById('onboarding-wizard-copy-ps');
    if (obCpP) obCpP.addEventListener('click', () => {
        const t = document.getElementById('onboarding-wizard-ps-cmd');
        if (t && t.value) copyTextToClipboard(t.value).then(ok => showAlert(ok ? 'Kopyalandı' : 'Kopyalanamadı', ok ? 'success' : 'danger'));
    });

    document.getElementById('onboarding-step-1')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.onboarding-scenario-btn[data-scenario]');
        if (!btn) return;
        document.querySelectorAll('#onboarding-step-1 .onboarding-scenario-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        onboardingWizardState.scenario = btn.getAttribute('data-scenario');
    });
    document.getElementById('onboarding-step-2')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.onboarding-scenario-btn[data-can-install]');
        if (!btn) return;
        document.querySelectorAll('#onboarding-step-2 .onboarding-scenario-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        onboardingWizardState.canInstall = btn.getAttribute('data-can-install');
    });

    setupAgentFleetModeSwitch();

    const agentProfileSelect = document.getElementById('agent-profile-select');
    if (agentProfileSelect) {
        agentProfileSelect.addEventListener('change', onAgentProfileChanged);
    }

    const qcSamplesRefreshBtn = document.getElementById('qc-samples-refresh-btn');
    if (qcSamplesRefreshBtn) {
        qcSamplesRefreshBtn.addEventListener('click', loadNormalizationData);
    }

    const normAddMappingBtn = document.getElementById('norm-add-mapping-btn');
    if (normAddMappingBtn) {
        normAddMappingBtn.addEventListener('click', addNormalizationMapping);
    }
    const normDryRunBtn = document.getElementById('norm-dry-run-btn');
    if (normDryRunBtn) {
        normDryRunBtn.addEventListener('click', normDryRunPreview);
    }

    const perfDetectBtn = document.getElementById('perf-detect-ram-btn');
    if (perfDetectBtn) perfDetectBtn.addEventListener('click', perfDetectRam);
    const perfGetRecsBtn = document.getElementById('perf-get-recs-btn');
    if (perfGetRecsBtn) perfGetRecsBtn.addEventListener('click', perfGetRecommendations);
    const perfApplyBtn = document.getElementById('perf-apply-btn');
    if (perfApplyBtn) perfApplyBtn.addEventListener('click', perfApplyAutoTune);

    const showConfigDiffBtn = document.getElementById('show-config-diff-btn');
    if (showConfigDiffBtn) showConfigDiffBtn.addEventListener('click', showConfigDiff);

    const logServiceFilter = document.getElementById('log-service-filter');
    if (logServiceFilter) {
        logServiceFilter.addEventListener('change', () => {
            logsPage = 1;
            if (!rawLogEvents.length) loadLogs();
            else applyLogsFiltersAndRender();
        });
    }

    const logLevelFilter = document.getElementById('log-level-filter');
    if (logLevelFilter) {
        logLevelFilter.addEventListener('change', () => {
            logsPage = 1;
            if (!rawLogEvents.length) loadLogs();
            else applyLogsFiltersAndRender();
        });
    }

    const logsSearchInput = document.getElementById('logs-search-input');
    if (logsSearchInput) {
        logsSearchInput.addEventListener('input', () => {
            logsPage = 1;
            applyLogsFiltersAndRender();
        });
    }

    const logsPageSizeSelect = document.getElementById('logs-page-size');
    if (logsPageSizeSelect) {
        logsPageSize = parseInt(logsPageSizeSelect.value || '50', 10);
        logsPageSizeSelect.addEventListener('change', () => {
            logsPageSize = parseInt(logsPageSizeSelect.value || '50', 10);
            logsPage = 1;
            applyLogsFiltersAndRender();
        });
    }

    const logsPrevBtn = document.getElementById('logs-prev-page');
    if (logsPrevBtn) {
        logsPrevBtn.addEventListener('click', () => {
            if (logsPage > 1) {
                logsPage -= 1;
                renderLogsTable();
            }
        });
    }

    const logsNextBtn = document.getElementById('logs-next-page');
    if (logsNextBtn) {
        logsNextBtn.addEventListener('click', () => {
            const totalPages = Math.max(1, Math.ceil(filteredLogEvents.length / logsPageSize));
            if (logsPage < totalPages) {
                logsPage += 1;
                renderLogsTable();
            }
        });
    }

    const logsRefreshBtn = document.getElementById('logs-refresh-btn');
    if (logsRefreshBtn) {
        logsRefreshBtn.addEventListener('click', loadLogs);
    }

    const logsExportBtn = document.getElementById('logs-export-btn');
    if (logsExportBtn) {
        logsExportBtn.addEventListener('click', exportFilteredLogs);
    }

    const containerLogsSelect = document.getElementById('container-logs-select');
    const containerLogsLoadBtn = document.getElementById('container-logs-load-btn');
    const containerLogsRefreshBtn = document.getElementById('container-logs-refresh-btn');
    if (containerLogsLoadBtn) {
        containerLogsLoadBtn.addEventListener('click', loadContainerLogs);
    }
    if (containerLogsRefreshBtn) {
        containerLogsRefreshBtn.addEventListener('click', () => {
            loadContainerList().then(() => {
                const sel = document.getElementById('container-logs-select');
                if (sel && sel.value) loadContainerLogs();
            });
        });
    }

    applyRoleBasedUiAccess();

    // Help modal close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal('help-modal');
            closeSettingDetail();
            closeChangeSummaryModal();
            closeConfigDiffModal();
        }
    });
}

function initializeTheme() {
    const stored = localStorage.getItem('dashboard-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = stored || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
}

function applyTheme(theme) {
    const root = document.body;
    const isDark = theme === 'dark';
    root.classList.toggle('dark-mode', isDark);
    root.setAttribute('data-theme', theme);
    localStorage.setItem('dashboard-theme', theme);

    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.innerHTML = isDark
            ? '<i class="fas fa-sun"></i>'
            : '<i class="fas fa-moon"></i>';
        btn.title = isDark ? 'Aydınlık Moda Geç' : 'Koyu Moda Geç';
    }
}

function toggleTheme() {
    const current = document.body.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Core functions
async function loadAllData() {
    showAlert('Veriler yenileniyor...', 'info');
    const results = await Promise.allSettled([
        loadPlatformInfo(),
        loadSystemHealth(),
        loadServices(),
        loadStats(),
        loadConfigFiles(),
        loadOpsSummary(),
        loadOverviewIntelligence(true)
    ]);

    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
        showAlert(`Veriler kısmi güncellendi (${failed} hata)`, 'warning');
    } else {
        showAlert('Veriler güncellendi', 'success');
    }

    hideStartupSplash();
}

function renderOpsSummary() {
    const summaryEl = document.getElementById('ops-summary');
    if (!summaryEl) return;

    if (!latestOpsSummary) {
        summaryEl.textContent = 'Ortam bilgisi alınamadı.';
        return;
    }

    const env = latestOpsSummary.environment || '-';
    const platform = latestOpsSummary.platform || '-';
    const running = Number(latestOpsSummary.runningServices || 0);
    const total = Number(latestOpsSummary.totalServices || 0);
    const problematic = Number(latestOpsSummary.problematicServices || 0);
    summaryEl.textContent = `Ortam: ${env} • Platform: ${platform} • Servis: ${running}/${total} • Sorunlu: ${problematic}`;
}

function renderOpsActionResult() {
    const el = document.getElementById('ops-action-result');
    if (!el) return;
    if (!latestOpsAction) {
        el.textContent = 'Henüz operasyon tetiklenmedi.';
        return;
    }

    const prefix = latestOpsAction.status === 'success' ? '✓' : (latestOpsAction.status === 'warning' ? '⚠' : '✗');
    const ts = latestOpsAction.timestamp ? formatRelativeTime(latestOpsAction.timestamp) : '-';
    el.textContent = `${prefix} ${latestOpsAction.message || '-'} • ${ts}`;
}

async function loadOpsSummary() {
    try {
        latestOpsSummary = await apiRequest('/api/ops/summary');
        renderOpsSummary();
    } catch (error) {
        const summaryEl = document.getElementById('ops-summary');
        if (summaryEl) {
            summaryEl.textContent = `Ortam özeti hatası: ${error.message}`;
        }
    }
}

function buildOpsDetailMessage(data) {
    const checks = Array.isArray(data?.checks) ? data.checks : [];
    const statusSummary = checks.length
        ? checks.map(item => `${item.name}: ${item.status}`).join(' | ')
        : '';
    const base = statusSummary
        ? `${data?.summary || 'Operasyon tamamlandı'} (${statusSummary})`
        : (data?.summary || 'Operasyon tamamlandı');
    const notes = Array.isArray(data?.context?.notes) ? data.context.notes.filter(Boolean) : [];
    if (!notes.length) return base;
    return `${base} — ${notes.join(' ')}`;
}

async function runOpsAction(path, actionLabel) {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    try {
        showAlert(`${actionLabel} çalıştırılıyor...`, 'info');
        const data = await apiRequest(path, { method: 'POST' });
        const status = data?.status || 'success';
        const message = buildOpsDetailMessage(data);
        latestOpsAction = {
            status,
            message,
            timestamp: new Date().toISOString()
        };
        renderOpsActionResult();
        showAlert(message, status === 'failed' ? 'danger' : (status === 'warning' ? 'warning' : 'success'));
        await loadOpsSummary();
        setTimeout(loadServices, 1000);
    } catch (error) {
        latestOpsAction = {
            status: 'failed',
            message: `${actionLabel} hatası: ${error.message}`,
            timestamp: new Date().toISOString()
        };
        renderOpsActionResult();
        showAlert(`${actionLabel} hatası: ${error.message}`, 'danger');
    }
}

async function runOpsSanityCheck() {
    await runOpsAction('/api/ops/sanity', 'Sanity check');
}

async function runOpsFlowTest() {
    await runOpsAction('/api/ops/flow-test', 'Flow test');
}

async function runOpsStreamRepair() {
    const ok = await confirmDangerousAction({
        message: 'Stream arama onarımı çalıştırılacak.',
        detail: 'Bu işlem deflector cycle ve range rebuild tetikler. Graylog geçici olarak yeni indekslere yönlendirilebilir.'
    });
    if (!ok) return;
    await runOpsAction('/api/ops/stream-repair', 'Stream onarımı');
}

function renderStorageWorkflow(wf) {
    const el = document.getElementById('storage-vcenter-workflow');
    if (!el) return;
    if (!wf || !Array.isArray(wf.steps) || !wf.steps.length) {
        el.innerHTML = '';
        return;
    }
    const esc = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const title = wf.title
        ? `<div class="help-text" style="margin-bottom:0.25rem;"><strong>${esc(wf.title)}</strong></div>`
        : '';
    const items = wf.steps.map((s) => `<li>${esc(s)}</li>`).join('');
    el.innerHTML = `${title}<ol class="help-text" style="margin:0.2rem 0 0 1.1rem;line-height:1.45;">${items}</ol>`;
}

function renderEligibleRawDisks() {
    const select = document.getElementById('storage-raw-disk-select');
    const hint = document.getElementById('storage-raw-disk-hint');
    if (!select) return;
    select.innerHTML = '<option value="">Ham disk seçin (yeni VMDK)...</option>';
    eligibleRawDisks.forEach(d => {
        const option = document.createElement('option');
        option.value = d.path;
        const wipeNote = d.canPrepareWithoutWipe ? '' : ' — bölüm var, Wipe gerekir';
        const star = d.suggestedForDataDisk ? '★ önerilen • ' : '';
        option.textContent = `${star}${d.path} • ${d.sizeGB} GB • ${d.model || '—'}${wipeNote}`;
        option.dataset.needsWipe = d.canPrepareWithoutWipe ? '' : '1';
        select.appendChild(option);
    });
    const suggested = eligibleRawDisks.find(d => d.suggestedForDataDisk);
    if (suggested) {
        select.value = suggested.path;
    }
    if (hint) {
        const base = eligibleRawDisks.length
            ? `Kök/OS diski hariç uygun disk: ${eligibleRawDisks.length}. Yanlış seçim veri kaybına yol açar.`
            : 'Liste boş: önce «Disk veriyollarını tara», sonra «Diskleri Yenile». Gerekirse VM’yi yeniden başlatın veya konukta lsblk ile aygıtı doğrulayın.';
        const extra = (storageDiskHints && storageDiskHints.length)
            ? ` ${storageDiskHints.join(' ')}`
            : '';
        hint.textContent = base + extra;
    }
}

/** Tek veri VMDK: kökten ayrı FS sonrası ham disk hazırlığı kilitli; rol + data-prepare-locked birleşir. */
function applyStoragePreparePolicyLocks() {
    const card = document.getElementById('settings-storage-data-disk');
    const locked = card && card.getAttribute('data-prepare-locked') === '1';
    const canOperate = hasAtLeastRole('operator');
    const canAdmin = hasAtLeastRole('admin');

    const planBtn = document.getElementById('storage-recommended-plan-btn');
    if (planBtn) {
        planBtn.disabled = !canOperate || locked;
        if (locked) planBtn.title = 'Veri diski zaten kökten ayrı; yeni ham disk hazırlığı kapalı.';
        else if (!canOperate) planBtn.title = 'Bu işlem için operator rolü gerekli';
        else planBtn.removeAttribute('title');
    }
    const prepBtn = document.getElementById('storage-prepare-disk-btn');
    if (prepBtn) {
        prepBtn.disabled = !canAdmin || locked;
        if (locked) prepBtn.title = 'Veri diski tanımlı; yalnızca aynı VMDK genişletilir.';
        else if (!canAdmin) prepBtn.title = 'Bu işlem için admin rolü gerekli';
        else prepBtn.removeAttribute('title');
    }
    const compBtn = document.getElementById('storage-complete-recommended-btn');
    if (compBtn) {
        compBtn.disabled = !canAdmin || locked;
        if (locked) compBtn.title = 'Veri diski tanımlı; tam kur kapalı.';
        else if (!canAdmin) compBtn.title = 'Bu işlem için admin rolü gerekli';
        else compBtn.removeAttribute('title');
    }
    const rawSel = document.getElementById('storage-raw-disk-select');
    if (rawSel) {
        rawSel.disabled = !canOperate || locked;
        if (locked) rawSel.title = 'Bu aşamada ham disk seçimi kullanılmaz.';
        else if (!canOperate) rawSel.title = 'Bu işlem için operator rolü gerekli';
        else rawSel.removeAttribute('title');
    }
    const recScanCb = document.getElementById('storage-recommended-rescan-cb');
    if (recScanCb) {
        recScanCb.disabled = !canOperate || locked;
        if (locked) recScanCb.title = 'Kilitli.';
        else if (!canOperate) recScanCb.title = 'Bu işlem için operator rolü gerekli';
        else recScanCb.removeAttribute('title');
    }
    ['storage-recommended-wipe', 'storage-recommended-relocate', 'storage-recommended-rescan-first', 'storage-wipe-disk', 'storage-relocate-mount-dir'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const dis = !canAdmin || locked;
        el.disabled = dis;
        if (locked) el.title = 'Bu aşamada kapalı.';
        else if (!canAdmin) el.title = (id.includes('recommended') ? 'Tam kurulum için admin rolü gerekli' : 'Bu işlem için admin rolü gerekli');
        else el.removeAttribute('title');
    });
    const storageRecConfirm = document.getElementById('storage-recommended-confirm');
    if (storageRecConfirm) {
        storageRecConfirm.disabled = !canAdmin || locked;
        if (locked) storageRecConfirm.title = 'Kilitli.';
        else if (!canAdmin) storageRecConfirm.title = 'Bu işlem için admin rolü gerekli';
        else storageRecConfirm.removeAttribute('title');
    }
    const storageConfirmDev = document.getElementById('storage-confirm-device');
    if (storageConfirmDev) {
        storageConfirmDev.disabled = !canAdmin || locked;
        if (locked) storageConfirmDev.title = 'Kilitli.';
        else if (!canAdmin) storageConfirmDev.title = 'Bu işlem için admin rolü gerekli';
        else storageConfirmDev.removeAttribute('title');
    }
}

function applyStorageDiskPolicyUI(m) {
    const card = document.getElementById('settings-storage-data-disk');
    const bundle = document.getElementById('storage-first-setup-bundle');
    const badge = document.getElementById('storage-phase-badge');
    if (!card) return;
    if (!m || m.error) {
        card.setAttribute('data-prepare-locked', '0');
        if (bundle) bundle.style.display = '';
        if (badge) badge.textContent = 'İlk kurulum veya genişletme';
        applyStoragePreparePolicyLocks();
        return;
    }
    const locked = m.prepareNewRawDiskAllowed === false;
    card.setAttribute('data-prepare-locked', locked ? '1' : '0');
    if (bundle) bundle.style.display = locked ? 'none' : '';
    if (badge) badge.textContent = locked ? 'Ayrı disk hazır — sadece büyütme' : 'Yeni disk kurulumu mümkün';
    applyStoragePreparePolicyLocks();
}

function renderSigningOnboardingBanner(mountSnap) {
    const el = document.getElementById('signing-onboarding-banner');
    if (!el) return;
    if (!mountSnap || mountSnap.error) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = 'block';
    el.style.paddingLeft = '0.6rem';
    const separate = !mountSnap.sameFilesystemAsRoot;
    if (!separate) {
        el.style.borderLeft = '3px solid var(--color-warning, #d97706)';
        el.className = 'settings-summary';
        el.innerHTML = `<strong>Kurulum sırası — 1. Veri diski</strong>
            <div class="help-text" style="margin-top:0.35rem;">5651 ve log arşivi için veri dizini OS diskinden ayrı olmalı. Bu adımı tamamladıktan sonra imzalama ayarlarına geçin. <a href="#" id="signing-cta-storage">Veri diski bölümüne git →</a></div>`;
    } else {
        el.style.borderLeft = '3px solid var(--color-info, #0284c7)';
        el.className = 'settings-summary';
        el.innerHTML = `<strong>Kurulum sırası — 2. İmzalama (5651)</strong>
            <div class="help-text" style="margin-top:0.35rem;">Gerçek kaynaklardan log toplamaya geçmeden önce <strong>5651 Uyum</strong> grubunda imza tipini (TÜBİTAK veya OpenSSL), gerekirse TSA URL ve arşiv hedefini tanımlayın. <a href="#" id="signing-cta-5651">5651 ayarlarına git →</a></div>`;
    }
    const aStorage = document.getElementById('signing-cta-storage');
    const a5651 = document.getElementById('signing-cta-5651');
    if (aStorage) {
        aStorage.addEventListener('click', (e) => {
            e.preventDefault();
            switchTab('settings');
            setTimeout(() => document.getElementById('settings-storage-data-disk')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
        });
    }
    if (a5651) {
        a5651.addEventListener('click', (e) => {
            e.preventDefault();
            switchTab('settings');
            setTimeout(() => document.querySelector('.settings-group-block.group-5651-uyum')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
        });
    }
}

function renderStorageMountBanner(m) {
    const el = document.getElementById('storage-mount-status-banner');
    const ackRow = document.getElementById('storage-ack-root-row');
    const esc = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    if (!el) return;
    if (!m || m.error) {
        el.style.display = 'block';
        el.className = 'settings-summary';
        el.style.borderLeft = '3px solid var(--color-border, #ccc)';
        el.style.paddingLeft = '0.6rem';
        el.textContent = m && m.error ? `Durum alınamadı: ${m.error}` : 'Yükleniyor…';
        if (ackRow) ackRow.style.display = 'none';
        lastStorageMountSnapshot = m || null;
        applyStorageDiskPolicyUI(m);
        renderSigningOnboardingBanner(m);
        updateStorageHubPills(lastDiskProfile, lastStorageMountSnapshot);
        return;
    }
    lastStorageMountSnapshot = m;
    const same = !!m.sameFilesystemAsRoot;
    el.style.display = 'block';
    el.style.borderLeft = same ? '3px solid var(--color-warning, #d97706)' : '3px solid var(--color-success, #16a34a)';
    el.style.paddingLeft = '0.6rem';
    el.className = 'settings-summary';
    const title = same ? 'Log verisi sistem diskiyle aynı bölümde' : 'Log verisi ayrı disk üzerinde';
    const lead = same
        ? 'Canlı ortamda ayrı disk önerilir. Aşağıdan «Kayıtlı konumu güncelle» veya gelişmiş adımları kullanın.'
        : 'Önerilen ayrım sağlandı. Alan yetmezse «Mevcut diski büyüt» bölümüne bakın.';
    const src = `Kök <code>${m.rootSource || '—'}</code> • Veri <code>${m.dataPath || '/opt/log-system/data'}</code> → <code>${m.dataSource || '—'}</code>`;
    const detail =
        Array.isArray(m.summaryLines) && m.summaryLines.length
            ? `<details class="storage-details" style="margin-top:0.45rem;border:0;padding:0;"><summary style="cursor:pointer;">Teknik ayrıntı</summary><div class="inner" style="margin-top:0.35rem;">${src}<br>${m.summaryLines.map((x) => esc(x)).join('<br>')}</div></details>`
            : `<details class="storage-details" style="margin-top:0.45rem;border:0;padding:0;"><summary style="cursor:pointer;">Teknik ayrıntı</summary><div class="inner" style="margin-top:0.35rem;">${src}</div></details>`;
    el.innerHTML = `<strong>${title}</strong><div class="help-text" style="margin:0.35rem 0 0;font-size:0.9rem;">${lead}</div>${detail}`;
    if (ackRow) ackRow.style.display = same ? 'block' : 'none';
    applyStorageDiskPolicyUI(m);
    renderSigningOnboardingBanner(m);
    updateStorageHubPills(lastDiskProfile, lastStorageMountSnapshot);
}

async function loadStorageMountStatus() {
    const el = document.getElementById('storage-mount-status-banner');
    if (!el) return;
    try {
        const m = await apiRequest('/api/storage/mount-status');
        renderStorageMountBanner(m);
    } catch (e) {
        renderStorageMountBanner({ error: e.message || String(e) });
    }
}

function renderDataDiskGrowUI(g) {
    const sum = document.getElementById('storage-grow-summary');
    const btn = document.getElementById('storage-grow-exec-btn');
    const growRow = document.getElementById('storage-grow-confirm-row');
    const growHint = document.getElementById('storage-grow-expected-hint');
    const growInput = document.getElementById('storage-grow-confirm-part');
    if (!sum) return;
    if (g && g.error) {
        lastDataDiskGrowSnapshot = null;
        if (growRow) growRow.style.display = 'none';
        if (growInput) growInput.value = '';
        sum.textContent = `Durum alınamadı: ${g.error}`;
        if (btn) btn.style.display = 'none';
        return;
    }
    lastDataDiskGrowSnapshot = g && g.eligible !== false ? g : null;
    const fmtGiB = (b) => (typeof b === 'number' ? (b / 1024 ** 3).toFixed(1) : '—');
    const diskG = fmtGiB(g.diskBytes);
    const partG = fmtGiB(g.partitionBytes);
    const sameSize = g.diskPartitionSizesMatchApprox === true;
    const sizeLine = sameSize
        ? `<div class="help-text" style="margin-top:0.25rem;">Disk ve bölüm kapasitesi (yaklaşık): ~${diskG} GiB</div>`
        : `<div class="help-text" style="margin-top:0.25rem;">Disk ~${diskG} GiB • Bölüm ~${partG} GiB</div>`;
    const tgt = g.targetFilesystemBytesAfterGrowApprox;
    const afterLine =
        g.canGrow && typeof tgt === 'number'
            ? `<div class="help-text" style="margin-top:0.25rem;">Genişletme sonrası ext4 toplam boyut (yaklaşık): ~${fmtGiB(tgt)} GiB</div>`
            : '';
    const rescanNote =
        g.hostBusRescanBeforeProbe === true
            ? '<div class="help-text" style="margin-top:0.25rem;">Ölçümden önce konukta veriyolu + disk <code>rescan</code> çalıştırıldı.</div>'
            : '';
    const meta = [
        g.message ? `<div>${g.message}</div>` : '',
        g.partitionPath ? `<div class="help-text" style="margin-top:0.25rem;">Bölüm: <code>${g.partitionPath}</code> • ext4: ${g.supportedFilesystem ? 'evet' : 'hayır'}</div>` : '',
        sizeLine,
        rescanNote,
        afterLine
    ].join('');
    sum.innerHTML = g.eligible === false
        ? `<span class="badge badge-secondary">Uygun değil</span> ${g.message || g.reason || ''}`
        : `${g.canGrow ? '<span class="badge badge-warning">Genişletme mümkün</span>' : '<span class="badge badge-success">Güncel</span>'} ${meta}`;
    if (btn) btn.style.display = g.canGrow ? 'inline-flex' : 'none';
    if (growRow) growRow.style.display = g.canGrow ? 'block' : 'none';
    if (growHint) growHint.textContent = g.partitionPath || '—';
    if (growInput && !g.canGrow) growInput.value = '';
}

async function loadDataDiskGrowStatus() {
    if (!document.getElementById('storage-grow-summary')) return;
    try {
        const g = await apiRequest('/api/storage/data-disk-grow-status?rescan=1');
        renderDataDiskGrowUI(g);
    } catch (e) {
        renderDataDiskGrowUI({ error: humanizeStoragePanelError(e) });
    }
}

async function executeDataDiskGrow() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const expected = lastDataDiskGrowSnapshot && lastDataDiskGrowSnapshot.partitionPath;
    const typed = (document.getElementById('storage-grow-confirm-part') && document.getElementById('storage-grow-confirm-part').value.trim()) || '';
    if (!expected) {
        showAlert('Önce «Durumu yenile» ile bölüm yolunu yükleyin.', 'warning');
        return;
    }
    if (typed !== expected) {
        showAlert(`Genişletme için «${expected}» yolunu onay alanına aynen yazın.`, 'warning');
        return;
    }
    const resultBox = document.getElementById('storage-grow-result');
    const tgt = lastDataDiskGrowSnapshot && lastDataDiskGrowSnapshot.targetFilesystemBytesAfterGrowApprox;
    const tgtHint =
        typeof tgt === 'number' ? ` Tahmini yeni ext4 toplamı: ~${(tgt / 1024 ** 3).toFixed(1)} GiB.` : '';
    const ok = await confirmDangerousAction({
        message: `Genişletme: ${expected}`,
        detail:
            'vCenter’da aynı veri VMDK’sı büyütüldü mü kontrol edin. Panel bölümü (gerekirse) uzatır ve ext4’ü otomatik büyütür; terminale gerek yok. LVM veri yolu desteklenmez.' +
            tgtHint,
        requireType: true
    });
    if (!ok) return;
    if (resultBox) resultBox.textContent = 'Genişletme çalışıyor…';
    const growAbort = new AbortController();
    const growTmr = setTimeout(() => growAbort.abort(), 12 * 60 * 1000);
    try {
        const data = await apiRequest('/api/storage/data-disk-grow', {
            method: 'POST',
            signal: growAbort.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rescanFirst: true })
        });
        const r = data.result || {};
        if (resultBox) {
            resultBox.textContent = `✓ ${data.message || 'Tamam'} • log: ${(r.log || '').slice(0, 500)}`;
        }
        showAlert(data.message || 'Genişletme tamam', 'success');
        const after = (data.result && data.result.after) || {};
        if (resultBox && after.partitionPath) {
            resultBox.textContent += ` • Doğrulama: bölüm ${after.partitionPath} — ${after.canGrow ? 'hâlâ genişletilebilir görünüyor' : 'güncel'}`;
        }
        await loadDataDiskGrowStatus();
        await loadStorageMountStatus().catch(() => {});
    } catch (e) {
        const msg = humanizeStoragePanelError(e);
        if (resultBox) resultBox.textContent = `✗ ${msg}`;
        showAlert(`Genişletme: ${msg}`, 'danger');
    } finally {
        clearTimeout(growTmr);
    }
}

function renderOsDiskGrowUI(g) {
    const sum = document.getElementById('storage-os-grow-summary');
    const btn = document.getElementById('storage-os-grow-exec-btn');
    const growRow = document.getElementById('storage-os-grow-confirm-row');
    const growHint = document.getElementById('storage-os-grow-expected-hint');
    const growInput = document.getElementById('storage-os-grow-confirm-part');
    if (!sum) return;
    if (g && g.error) {
        lastOsDiskGrowSnapshot = null;
        if (growRow) growRow.style.display = 'none';
        if (growInput) growInput.value = '';
        sum.textContent = `Durum alınamadı: ${g.error}`;
        if (btn) btn.style.display = 'none';
        return;
    }
    lastOsDiskGrowSnapshot = g && g.eligible !== false ? g : null;
    const fmtGiB = (b) => (typeof b === 'number' ? (b / 1024 ** 3).toFixed(1) : '—');
    const diskG = fmtGiB(g.diskBytes);
    const partG = fmtGiB(g.partitionBytes);
    const sameSize = g.diskPartitionSizesMatchApprox === true;
    const sizeLine = sameSize
        ? `<div class="help-text" style="margin-top:0.25rem;">Disk ve kök bölüm (yaklaşık): ~${diskG} GiB</div>`
        : `<div class="help-text" style="margin-top:0.25rem;">Disk ~${diskG} GiB • Bölüm ~${partG} GiB</div>`;
    const tgt = g.targetFilesystemBytesAfterGrowApprox;
    const afterLine =
        g.canGrow && typeof tgt === 'number'
            ? `<div class="help-text" style="margin-top:0.25rem;">Genişletme sonrası ext4 (yaklaşık): ~${fmtGiB(tgt)} GiB</div>`
            : '';
    const risk = g.riskWarning
        ? `<div class="help-text" style="margin-top:0.35rem;color:var(--color-warning-text,#92400e);">${g.riskWarning}</div>`
        : '';
    const devLine =
        g.scope === 'lvm_root' && (g.physicalVolume || g.volumeGroup)
            ? `<div class="help-text" style="margin-top:0.25rem;">LVM: LV <code>${g.partitionPath || '—'}</code> • PV <code>${g.physicalVolume || '—'}</code> • VG <code>${g.volumeGroup || '—'}</code> • ext4: ${g.supportedFilesystem ? 'evet' : 'hayır'}</div>`
            : g.partitionPath
              ? `<div class="help-text" style="margin-top:0.25rem;">Bölüm: <code>${g.partitionPath}</code> • ext4: ${g.supportedFilesystem ? 'evet' : 'hayır'}</div>`
              : '';
    const rescanNote =
        g.hostBusRescanBeforeProbe === true
            ? '<div class="help-text" style="margin-top:0.25rem;">Ölçümden önce konukta veriyolu + disk <code>rescan</code> çalıştırıldı (hypervisor’da büyütme sonrası ~3 sn sürebilir).</div>'
            : '';
    const meta = [
        g.message ? `<div>${g.message}</div>` : '',
        devLine,
        sizeLine,
        rescanNote,
        afterLine,
        risk
    ].join('');
    sum.innerHTML = g.eligible === false
        ? `<span class="badge badge-secondary">Uygun değil</span> ${g.message || g.reason || ''}`
        : `${g.canGrow ? '<span class="badge badge-warning">Genişletme mümkün</span>' : '<span class="badge badge-success">Güncel</span>'} ${meta}`;
    if (btn) btn.style.display = g.canGrow ? 'inline-flex' : 'none';
    if (growRow) growRow.style.display = g.canGrow ? 'block' : 'none';
    if (growHint) growHint.textContent = g.partitionPath || '—';
    if (growInput && !g.canGrow) growInput.value = '';
}

async function loadOsDiskGrowStatus() {
    if (!document.getElementById('storage-os-grow-summary')) return;
    try {
        const g = await apiRequest('/api/storage/os-disk-grow-status?rescan=1');
        renderOsDiskGrowUI(g);
    } catch (e) {
        renderOsDiskGrowUI({ error: humanizeStoragePanelError(e) });
    }
}

async function executeOsDiskGrow() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const expected = lastOsDiskGrowSnapshot && lastOsDiskGrowSnapshot.partitionPath;
    const typed = (document.getElementById('storage-os-grow-confirm-part') && document.getElementById('storage-os-grow-confirm-part').value.trim()) || '';
    if (!expected) {
        showAlert('Önce «OS durumu yenile» ile bölüm yolunu yükleyin.', 'warning');
        return;
    }
    if (typed !== expected) {
        showAlert(`Onay için «${expected}» yolunu aynen yazın.`, 'warning');
        return;
    }
    const resultBox = document.getElementById('storage-os-grow-result');
    const tgt = lastOsDiskGrowSnapshot && lastOsDiskGrowSnapshot.targetFilesystemBytesAfterGrowApprox;
    const tgtHint =
        typeof tgt === 'number' ? ` Tahmini yeni ext4: ~${(tgt / 1024 ** 3).toFixed(1)} GiB.` : '';
    const isLvm = lastOsDiskGrowSnapshot && lastOsDiskGrowSnapshot.scope === 'lvm_root';
    const ok = await confirmDangerousAction({
        message: `Kök (/) dosya sistemi genişletme: ${expected}`,
        detail: isLvm
            ? 'Hypervisor’da OS diski büyütüldü mü kontrol edin. LVM kök: panel GPT, pvresize, lvextend ve ext4 büyütmesini otomatik yapar (tek PV, ext4). Yedek önerilir; terminale gerek yok.' +
              tgtHint
            : 'Hypervisor’da OS diski büyütüldü mü kontrol edin. Panel kök bölümü ve ext4’ü otomatik uzatır; yedek önerilir; terminale gerek yok.' +
              tgtHint,
        requireType: true
    });
    if (!ok) return;
    if (resultBox) resultBox.textContent = 'Kök FS genişletme çalışıyor…';
    const growAbort = new AbortController();
    const growTmr = setTimeout(() => growAbort.abort(), 12 * 60 * 1000);
    try {
        const data = await apiRequest('/api/storage/os-disk-grow', {
            method: 'POST',
            signal: growAbort.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rescanFirst: true })
        });
        const r = data.result || {};
        if (resultBox) {
            resultBox.textContent = `✓ ${data.message || 'Tamam'} • log: ${(r.log || '').slice(0, 500)}`;
        }
        showAlert(data.message || 'Kök FS genişletildi', 'success');
        const after = (data.result && data.result.after) || {};
        if (resultBox && after.partitionPath) {
            resultBox.textContent += ` • Doğrulama: ${after.canGrow ? 'hâlâ genişletilebilir görünüyor' : 'güncel'}`;
        }
        await loadOsDiskGrowStatus();
        await loadStorageMountStatus().catch(() => {});
        loadServiceStorage().catch(() => {});
    } catch (e) {
        const msg = humanizeStoragePanelError(e);
        if (resultBox) resultBox.textContent = `✗ ${msg}`;
        showAlert(`Kök FS: ${msg}`, 'danger');
    } finally {
        clearTimeout(growTmr);
    }
}

function renderRecommendedPlanUI(plan) {
    const sumEl = document.getElementById('storage-recommended-plan-summary');
    const actEl = document.getElementById('storage-recommended-actions');
    const resEl = document.getElementById('storage-recommended-result');
    if (!sumEl) return;
    lastRecommendedPlan = plan && typeof plan === 'object' ? plan : null;
    if (resEl) resEl.textContent = '';
    if (!plan || plan.error) {
        sumEl.textContent = plan && plan.error ? `Plan hatası: ${plan.error}` : 'Plan alınamadı.';
        if (actEl) actEl.style.display = 'none';
        return;
    }
    if (!plan.ok) {
        const hints = Array.isArray(plan.hints) ? plan.hints.map((h) => `• ${h}`).join(' ') : '';
        sumEl.innerHTML = `<span class="badge badge-warning">Hazır değil</span> ${plan.message || ''} ${hints}`;
        if (actEl) actEl.style.display = 'none';
        return;
    }
    const lines = Array.isArray(plan.summaryLines)
        ? plan.summaryLines.map((x) => `<div style="margin-top:0.25rem;">${x}</div>`).join('')
        : '';
    sumEl.innerHTML = `<span class="badge badge-info">Önerilen</span> <code>${plan.suggestedDevice || ''}</code> (${plan.suggestedSizeGB != null ? plan.suggestedSizeGB : '—'} GB)${lines}`;
    const wipeCb = document.getElementById('storage-recommended-wipe');
    const relocCb = document.getElementById('storage-recommended-relocate');
    if (plan.sameFilesystemAsRoot) {
        if (actEl) actEl.style.display = 'block';
        if (wipeCb) wipeCb.checked = !!plan.needsWipe;
        if (relocCb) relocCb.checked = !!plan.relocateRecommended;
    } else {
        if (actEl) actEl.style.display = 'none';
    }
}

async function loadRecommendedSetupPlan(withRescan) {
    const sumEl = document.getElementById('storage-recommended-plan-summary');
    if (sumEl) sumEl.textContent = 'Plan yükleniyor…';
    try {
        const q = withRescan ? '?rescan=1' : '';
        const plan = await apiRequest(`/api/storage/recommended-setup-plan${q}`);
        renderRecommendedPlanUI(plan);
    } catch (e) {
        renderRecommendedPlanUI({ error: humanizeStoragePanelError(e) });
    }
}

async function completeRecommendedStorageSetup() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const envName = getStorageEffectiveEnv();
    const confirmInput = document.getElementById('storage-recommended-confirm');
    const wipeCb = document.getElementById('storage-recommended-wipe');
    const relocCb = document.getElementById('storage-recommended-relocate');
    const rescanFirstCb = document.getElementById('storage-recommended-rescan-first');
    const resultBox = document.getElementById('storage-recommended-result');
    const confirmDevice = (confirmInput && confirmInput.value) ? confirmInput.value.trim() : '';

    if (!lastRecommendedPlan || !lastRecommendedPlan.ok) {
        showAlert('Önce «Planı yükle» ile önerilen diski doğrulayın', 'warning');
        return;
    }
    if (!lastRecommendedPlan.sameFilesystemAsRoot) {
        showAlert('Veri yolu zaten kökten ayrı; bu akış devre dışı. Gerekirse «Storage profile» kullanın.', 'warning');
        return;
    }
    const dev = lastRecommendedPlan.suggestedDevice;
    if (!dev) {
        showAlert('Önerilen aygıt yok', 'warning');
        return;
    }
    if (confirmDevice !== dev) {
        showAlert(`Onay alanına tam olarak şunu yazın: ${dev}`, 'warning');
        return;
    }
    if (lastRecommendedPlan.needsWipe && !(wipeCb && wipeCb.checked)) {
        showAlert('Bu diskte bölüm var; «wipe» kutusunu işaretleyin veya elle hazırlayın.', 'warning');
        return;
    }

    const ok = await confirmDangerousAction({
        message: `Önerilen veri diski tam kurulum: ${dev}`,
        detail:
            '/opt/log-system/data altına ext4, fstab ve .env (ortam: ' +
            envName +
            '). Yanlış aygıt veri kaybına yol açar. Son adım: ONAYLA yazın.',
        requireType: true
    });
    if (!ok) return;

    if (resultBox) resultBox.textContent = 'Kurulum çalışıyor… (uzun sürebilir)';

    const abortCtl = new AbortController();
    const tmr = setTimeout(() => abortCtl.abort(), 20 * 60 * 1000);
    try {
        const data = await apiRequest('/api/storage/complete-recommended-setup', {
            method: 'POST',
            signal: abortCtl.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                confirmDevice,
                envName,
                wipeExisting: !!(wipeCb && wipeCb.checked),
                relocateMountDirContents: !!(relocCb && relocCb.checked),
                rescanFirst: rescanFirstCb ? !!rescanFirstCb.checked : true
            })
        });
        const r = data.result || {};
        const ms = r.mountStatus || {};
        const verified = ms.sameFilesystemAsRoot === false;
        if (resultBox) {
            resultBox.textContent = `✓ ${data.message || 'Tamam'} • bağlantı: ${verified ? 'kökten ayrı' : 'kontrol edin'} • veri=${ms.dataSource || '—'} • aygıt=${(r.profile && r.profile.device) || '—'}`;
        }
        showAlert(data.message || 'Önerilen disk kurulumu tamam', 'success');
        if (confirmInput) confirmInput.value = '';
        await loadStorageMountStatus().catch(() => {});
        await loadRecommendedSetupPlan(false).catch(() => {});
        await loadStorageCandidates();
        loadGuidedSettings();
    } catch (error) {
        const msg = humanizeStoragePanelError(error);
        if (resultBox) resultBox.textContent = `✗ ${msg}`;
        showAlert(`Önerilen kurulum: ${msg}`, 'danger');
    } finally {
        clearTimeout(tmr);
    }
}

function renderStorageCandidates() {
    const select = document.getElementById('storage-candidate-select');
    const summary = document.getElementById('storage-scan-summary');
    if (!select || !summary) return;

    select.innerHTML = '<option value="">Disk adayı seçin...</option>';
    if (!storageCandidates.length) {
        summary.textContent = 'Aday disk bulunamadı. Hostta ayrı disk mount edildiğinden emin olun.';
        return;
    }

    storageCandidates.forEach(item => {
        const option = document.createElement('option');
        option.value = item.path;
        const badge = item.recommended ? 'ÖNERİLEN' : 'dikkat';
        option.textContent = `${item.path} • ${item.availableGB}GB boş / ${item.totalGB}GB • ${item.device} • ${badge}`;
        select.appendChild(option);
    });

    const recommended = storageCandidates.filter(item => item.recommended).length;
    summary.textContent = `Toplam aday: ${storageCandidates.length} • Önerilen: ${recommended}`;
}

async function loadStorageCandidates() {
    const summary = document.getElementById('storage-scan-summary');
    if (summary) summary.textContent = 'Disk adayları taranıyor...';

    await loadEffectiveStorageEnv().catch(() => {});
    await updateStorageApiStaleBanner().catch(() => {});

    try {
        const [cData, rawData] = await Promise.all([
            apiRequest('/api/storage/candidates'),
            apiRequest('/api/storage/eligible-disks').catch(() => ({ disks: [] }))
        ]);
        await loadStorageMountStatus().catch(() => {});
        storageCandidates = Array.isArray(cData.items) ? cData.items : [];
        eligibleRawDisks = Array.isArray(rawData.disks) ? rawData.disks : [];
        storageDiskHints = Array.isArray(rawData.hints) ? rawData.hints : [];
        storageWorkflow = rawData.workflow && rawData.workflow.steps ? rawData.workflow : null;
        renderStorageWorkflow(storageWorkflow);
        renderStorageCandidates();
        renderEligibleRawDisks();
        await loadDataDiskGrowStatus().catch(() => {});
        await loadOsDiskGrowStatus().catch(() => {});
        await loadRecommendedSetupPlan(false).catch(() => {});
    } catch (error) {
        eligibleRawDisks = [];
        storageDiskHints = [];
        storageWorkflow = null;
        renderStorageWorkflow(null);
        renderEligibleRawDisks();
        const em = humanizeStoragePanelError(error);
        renderDataDiskGrowUI({ error: em });
        renderOsDiskGrowUI({ error: em });
        renderRecommendedPlanUI({ error: em });
        if (summary) summary.textContent = `Disk tarama hatası: ${em}`;
    }
}

async function rescanStorageHostBuses() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Veriyolu taraması için admin rolü gerekli', 'warning');
        return;
    }
    const hint = document.getElementById('storage-raw-disk-hint');
    if (hint) hint.textContent = 'Konukta SCSI/NVMe taraması çalışıyor…';
    try {
        const data = await apiRequest('/api/storage/rescan-host-buses', { method: 'POST' });
        showAlert(data.message || 'Tarama tamam', 'success');
        await loadStorageCandidates();
    } catch (error) {
        if (hint) hint.textContent = `Tarama hatası: ${error.message}`;
        showAlert(`Veriyolu taraması: ${error.message}`, 'danger');
    }
}

async function prepareRawDiskAndApply() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }

    const select = document.getElementById('storage-raw-disk-select');
    const confirmInput = document.getElementById('storage-confirm-device');
    const wipeCb = document.getElementById('storage-wipe-disk');
    const relocateCb = document.getElementById('storage-relocate-mount-dir');
    const resultBox = document.getElementById('storage-prepare-result');

    const device = (select && select.value) ? select.value.trim() : '';
    const confirmDevice = (confirmInput && confirmInput.value) ? confirmInput.value.trim() : '';
    const envName = getStorageEffectiveEnv();

    if (!device) {
        showAlert('Önce listeden ham disk seçin', 'warning');
        return;
    }

    const opt = select.selectedOptions[0];
    const needsWipe = opt && opt.dataset && opt.dataset.needsWipe === '1';
    if (needsWipe && !(wipeCb && wipeCb.checked)) {
        showAlert('Bu diskte mevcut bölüm var; Wipe kutusunu işaretleyin.', 'warning');
        return;
    }

    if (confirmDevice !== device) {
        showAlert(`Önce «Onay» alanına aygıt yolunu aynen yazın: ${device}`, 'warning');
        return;
    }

    const relocate = !!(relocateCb && relocateCb.checked);
    const ok = await confirmDangerousAction({
        message: `Veri diski hazırlama: ${device}`,
        detail:
            'GPT + tek ext4, fstab ve /opt/log-system/data mount. Yanlış disk veri kaybına yol açar. İkinci adım: aşağıda ONAYLA yazın.' +
            (relocate
                ? ' Mevcut data içeriği data.panel-relocate-… altına taşınır.'
                : ''),
        requireType: true
    });
    if (!ok) return;

    if (resultBox) {
        resultBox.textContent =
            'Disk hazırlanıyor… (büyük disklerde veya yavaş ortamda birkaç dakika sürebilir; sayfayı kapatmayın.)';
    }

    const prepareAbort = new AbortController();
    const prepareAbortTimer = setTimeout(() => prepareAbort.abort(), 20 * 60 * 1000);
    try {
        const data = await apiRequest('/api/storage/prepare-disk', {
            method: 'POST',
            signal: prepareAbort.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device,
                confirmDevice,
                mountPoint: '/opt/log-system/data',
                envName,
                wipeExisting: !!(wipeCb && wipeCb.checked),
                relocateMountDirContents: relocate
            })
        });
        const prof = (data.result && data.result.profile) || {};
        const mv = (data.result && data.result.mountVerification) || {};
        const okSep = mv.separateFromRoot === true;
        if (resultBox) {
            resultBox.textContent =
                `✓ ${data.message || 'Tamam'} • hot=${prof.hotRoot || '-'} • device=${prof.device || '-'} • doğrulama: ${okSep ? 'kökten ayrı FS' : 'kontrol'} (${mv.dataSource || '—'})`;
        }
        showAlert(data.message || 'Disk hazırlandı', 'success');
        if (confirmInput) confirmInput.value = '';
        if (wipeCb) wipeCb.checked = false;
        await loadStorageMountStatus().catch(() => {});
        loadStorageCandidates();
        loadGuidedSettings();
    } catch (error) {
        const msg = humanizeStoragePanelError(error);
        if (resultBox) resultBox.textContent = `✗ ${msg}`;
        showAlert(`Disk hazırlama: ${msg}`, 'danger');
    } finally {
        clearTimeout(prepareAbortTimer);
    }
}

/** apply-profile bu uçta yalnızca kök-FS onayı için 409 döner; gövde parse edilemese bile ikinci adımı aç. */
function storageProfileErrorNeedsAck(error) {
    return !!(error && error.status === 409);
}

async function applySelectedStorageProfile() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }

    const select = document.getElementById('storage-candidate-select');
    const customInput = document.getElementById('storage-custom-path');
    const pathConfirmIn = document.getElementById('storage-apply-confirm-path');
    const resultBox = document.getElementById('storage-apply-result');
    const ackSameRootCb = document.getElementById('storage-ack-same-as-root-cb');
    const customPath = (customInput && customInput.value) ? customInput.value.trim() : '';
    const selectedPath = customPath || ((select && select.value) ? select.value : '');
    const envName = getStorageEffectiveEnv();
    const typedPath = (pathConfirmIn && pathConfirmIn.value) ? pathConfirmIn.value.trim() : '';

    if (!selectedPath) {
        showAlert('Bir disk adayı seçin veya özel mount yolunu yazın', 'warning');
        return;
    }
    if (normalizeStorageMountPath(typedPath) !== normalizeStorageMountPath(selectedPath)) {
        showAlert(`Onay alanına uygulanacak yolu aynen yazın: ${selectedPath}`, 'warning');
        return;
    }

    const preAckRoot = !!(ackSameRootCb && ackSameRootCb.checked);
    const ok = await confirmDangerousAction({
        message: `Storage profile: ${selectedPath} (ortam: ${envName})`,
        detail:
            (preAckRoot
                ? 'Kök disk onayı işaretli: .env yolları bu dizine yazılır. '
                : '') +
            '.env veri yolları güncellenir; mevcut veri otomatik taşınmaz. Son adım: ONAYLA yazın.',
        requireType: true
    });
    if (!ok) return;

    const buildApplyBody = (forceAck) => {
        const fromCb = !!(ackSameRootCb && ackSameRootCb.checked);
        const acknowledgeRootFilesystem = fromCb || forceAck === true;
        return {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: selectedPath,
                envName,
                ...(acknowledgeRootFilesystem ? { acknowledgeRootFilesystem: true } : {})
            })
        };
    };

    const onApplySuccess = (data) => {
        const result = data.result || {};
        if (resultBox) {
            resultBox.textContent = `✓ Uygulandı • hot=${result.hotRoot || '-'} • archive=${result.archiveRoot || '-'} • data=${result.dataRoot || '-'}`;
        }
        showAlert(data.message || 'Storage profile uygulandı', 'success');
        if (pathConfirmIn) pathConfirmIn.value = '';
        loadGuidedSettings();
        loadStorageMountStatus().catch(() => {});
    };

    try {
        const data = await apiRequest('/api/storage/apply-profile', buildApplyBody(false));
        onApplySuccess(data);
    } catch (error) {
        if (storageProfileErrorNeedsAck(error)) {
            const detail = (error.body && error.body.detail) || error.message;
            const ok2 = await confirmDangerousAction({
                message: 'Veri yolu hâlâ OS kökü ile aynı dosya sisteminde',
                detail:
                    `${detail} Önerilen: önce «Hazırla + .env» ile ikinci VMDK’yı /opt/log-system/data altına bağlayın. ` +
                    'Tek disk: «Kök ile aynı diskte kalsın» işaretleyip Uygula veya burada devam edin. Son adım: ONAYLA yazın.',
                requireType: true
            });
            if (!ok2) {
                if (resultBox) resultBox.textContent = 'İptal (onay verilmedi). Yukarıdaki onay kutusunu işaretleyip Uygula da kullanılabilir.';
                return;
            }
            try {
                const data = await apiRequest('/api/storage/apply-profile', buildApplyBody(true));
                onApplySuccess(data);
            } catch (e2) {
                if (resultBox) resultBox.textContent = `✗ Hata: ${e2.message}`;
                showAlert(`Storage profile hatası: ${e2.message}`, 'danger');
            }
            return;
        }
        if (resultBox) {
            resultBox.textContent = `✗ Hata: ${error.message}`;
        }
        showAlert(`Storage profile hatası: ${error.message}`, 'danger');
    }
}

function renderAgentProfiles() {
    const select = document.getElementById('agent-profile-select');
    const summary = document.getElementById('agent-profile-summary');
    if (!select || !summary) return;

    select.innerHTML = '';
    if (!agentProfiles.length) {
        select.innerHTML = '<option value="">Profil bulunamadı</option>';
        summary.textContent = 'Profil kataloğu yüklenemedi.';
        return;
    }

    agentProfiles.forEach(profile => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = `${profile.name} (${profile.type})`;
        select.appendChild(option);
    });

    onAgentProfileChanged();
}

function onAgentProfileChanged() {
    const select = document.getElementById('agent-profile-select');
    const relayFields = document.getElementById('agent-relay-fields');
    const summary = document.getElementById('agent-profile-summary');
    if (!select || !summary) return;

    const selectedId = select.value;
    const profile = agentProfiles.find(item => item.id === selectedId);
    if (!profile) {
        summary.textContent = 'Profil seçimi bekleniyor.';
        if (relayFields) relayFields.style.display = 'none';
        return;
    }

    const defaults = profile.defaults || {};
    const ingestPortInput = document.getElementById('agent-ingest-port');
    const logTypeInput = document.getElementById('agent-log-type');
    if (ingestPortInput && defaults.ingestPort) ingestPortInput.value = defaults.ingestPort;
    if (logTypeInput && defaults.logType) logTypeInput.value = defaults.logType;

    const isRelay = profile.type === 'relay';
    if (relayFields) {
        relayFields.style.display = isRelay ? 'flex' : 'none';
    }

    const relayUdpInput = document.getElementById('agent-relay-udp-port');
    const relayTcpInput = document.getElementById('agent-relay-tcp-port');
    if (isRelay) {
        if (relayUdpInput && defaults.relayUdpPort) relayUdpInput.value = defaults.relayUdpPort;
        if (relayTcpInput && defaults.relayTcpPort) relayTcpInput.value = defaults.relayTcpPort;
    }

    summary.textContent = `${profile.name} • ${profile.description || '-'} • Transport: ${profile.transport || '-'}`;
}

function renderAgentTokenSummary() {
    const summary = document.getElementById('agent-token-summary');
    const revokeSelect = document.getElementById('agent-token-revoke-select');
    if (!summary || !revokeSelect) return;

    revokeSelect.innerHTML = '<option value="">İptal edilecek token seçin...</option>';
    if (!agentEnrollmentTokens.length) {
        summary.textContent = hasAtLeastRole('admin')
            ? 'Aktif/pending token bulunmuyor.'
            : 'Token listesi yalnızca admin rolünde görüntülenir.';
        return;
    }

    const revokable = agentEnrollmentTokens.filter((item) => {
        const st = String(item.effectiveStatus || item.status || '').toLowerCase();
        return st === 'pending' || st === 'active';
    });
    revokable.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        const st = item.effectiveStatus || item.status;
        const stTr = formatEnrollmentStatusTr(st);
        option.textContent = `${item.profileId} • ${stTr} • ${item.expiresAt || '-'}`;
        revokeSelect.appendChild(option);
    });

    summary.textContent = `Toplam token: ${agentEnrollmentTokens.length} • İptal edilebilir (bekliyor/aktif): ${revokable.length}`;
}

function renderAgentNodeSummary() {
    const summary = document.getElementById('agent-node-summary');
    if (!summary) return;

    if (!agentNodes.length) {
        summary.textContent = 'Henüz enroll edilmiş node yok.';
        return;
    }

    const top = agentNodes.slice(0, 5).map(node => {
        const host = node.hostname || 'unknown-host';
        const profile = node.profileId || '-';
        const seen = node.lastSeenAt ? formatRelativeTime(node.lastSeenAt) : '-';
        return `${host} (${profile}, son temas: ${seen})`;
    });
    summary.textContent = `Toplam ${agentNodes.length} uç · ${top.join(' · ')}`;
}

function getHeartbeatLevel(lastSeenAt) {
    const date = parseIsoDate(lastSeenAt);
    if (!date) return 'unknown';
    const ageSec = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (ageSec <= 180) return 'success';
    if (ageSec <= 900) return 'warning';
    return 'danger';
}

function renderAgentHeartbeatSummary() {
    const summary = document.getElementById('agent-heartbeat-summary');
    if (!summary) return;

    if (!agentNodes.length) {
        summary.innerHTML = '<span class="help-text">Kayıtlı uç yok.</span> <span class="status-badge status-unknown">—</span>';
        return;
    }

    let ok = 0;
    let warn = 0;
    let down = 0;
    agentNodes.forEach(node => {
        const level = getHeartbeatLevel(node.lastSeenAt);
        if (level === 'success') ok += 1;
        else if (level === 'warning') warn += 1;
        else down += 1;
    });

    const globalLevel = down > 0 ? 'danger' : (warn > 0 ? 'warning' : 'success');
    const globalLabel = globalLevel === 'danger'
        ? 'Kopuk bildirim'
        : (globalLevel === 'warning' ? 'Gecikmiş' : 'Güncel');
    summary.innerHTML = `
        <span class="help-text">Panel bildirimi (heartbeat): güncel ${ok} · gecikmiş ${warn} · kopuk ${down}</span>
        <span class="status-badge status-${globalLevel}">${globalLabel}</span>
    `;
}

function formatFleetLogCount(n) {
    if (n === null || n === undefined) return '—';
    const x = Number(n);
    if (Number.isNaN(x)) return '—';
    return x.toLocaleString('tr-TR');
}

function ensureFleetHostsTableDelegation() {
    const container = document.getElementById('fleet-hosts-table');
    if (!container || fleetHostsTableDelegated) return;
    fleetHostsTableDelegated = true;
    container.addEventListener('click', (e) => {
        const tr = e.target.closest('tr.fleet-host-row');
        if (!tr) return;
        const hid = tr.getAttribute('data-host');
        if (!hid) return;
        try {
            const hostname = decodeURIComponent(hid);
            void openFleetHostModal(hostname);
        } catch (_) { /* ignore */ }
    });
}

function renderFleetHostsTable() {
    const container = document.getElementById('fleet-hosts-table');
    if (!container) return;
    ensureFleetHostsTableDelegation();

    if (!hasAtLeastRole('operator')) {
        container.textContent = 'Operator rolü gerekli.';
        return;
    }

    if (!agentNodes.length) {
        container.innerHTML = '<p class="help-text">Kayıtlı uç nokta yok.</p>';
        return;
    }

    const q = fleetHostSearchQuery;
    const filtered = q
        ? agentNodes.filter((n) => (n.hostname || '').toLowerCase().includes(q))
        : agentNodes;

    if (!filtered.length) {
        container.innerHTML = '<p class="help-text">Arama ile eşleşen host yok.</p>';
        return;
    }

    const rows = filtered.map((node) => {
        const host = node.hostname || 'unknown-host';
        const enc = encodeURIComponent(host);
        const profile = escapeHtml(node.profileId || '—');
        const ip = escapeHtml(node.lastSeenIp || '—');
        const seen = node.lastSeenAt ? formatRelativeTime(node.lastSeenAt) : '—';
        const uninstalled = String(node.agentLifecycle || '') === 'uninstalled';
        const level = uninstalled ? 'info' : getHeartbeatLevel(node.lastSeenAt);
        const badge = uninstalled
            ? 'Kaldırıldı'
            : (level === 'success' ? 'Güncel' : (level === 'warning' ? 'Gecikmiş' : (level === 'danger' ? 'Kopuk' : '—')));
        const c24 = formatFleetLogCount(node.logCount24h);
        const c7 = formatFleetLogCount(node.logCount7d);
        const gHint = (node.graylogError24h || node.graylogError7d)
            ? '<span class="help-text" title="Graylog sorgusu tamamlanamadı">*</span>'
            : '';
        return `
            <tr class="fleet-host-row" tabindex="0" data-host="${enc}" title="Ayrıntı">
                <td><strong>${escapeHtml(host)}</strong></td>
                <td>${profile}</td>
                <td>${ip}</td>
                <td>${escapeHtml(seen)}</td>
                <td><span class="status-badge status-${level}">${badge}</span></td>
                <td class="fleet-num">${c24}</td>
                <td class="fleet-num">${c7}${gHint}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <p class="help-text" style="margin:0 0 0.5rem 0;">Satıra tıklayın: özet ve son mesajlar. «Panel bildirimi» ile Graylog sayıları farklı olabilir.</p>
        <div class="fleet-hosts-table-wrap">
        <table class="fleet-data-table">
            <thead><tr>
                <th>Host</th>
                <th>Profil</th>
                <th>IP</th>
                <th>Son bildirim</th>
                <th>Panel</th>
                <th class="fleet-num">24 saat</th>
                <th class="fleet-num">7 gün</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>
    `;
}

async function openFleetHostModal(hostname) {
    const modal = document.getElementById('fleet-host-modal');
    const body = document.getElementById('fleet-host-modal-body');
    const title = document.getElementById('fleet-host-modal-title');
    if (!modal || !body) return;
    if (title) title.textContent = hostname;
    body.innerHTML = '<p class="loading">Yükleniyor…</p>';
    modal.style.display = 'flex';
    try {
        const d = await apiRequest(`/api/agent/fleet-host-detail?hostname=${encodeURIComponent(hostname)}`);
        const node = d.node || {};
        const g = d.graylog || {};
        const samples = Array.isArray(g.samples) ? g.samples : [];
        const life = String(node.agentLifecycle || '');
        const unLine = life === 'uninstalled'
            ? `<dt class="help-text">Kaldırma</dt><dd>${escapeHtml(node.uninstalledAt || '—')} — ${escapeHtml(node.uninstallReason || 'user_uninstall')}</dd>`
            : '';
        const meta = `
            <dl style="margin:0 0 0.75rem 0; display:grid; gap:0.35rem 1rem; grid-template-columns:auto 1fr; font-size:0.88rem;">
                <dt class="help-text">Profil</dt><dd>${escapeHtml(node.profileId || '—')}</dd>
                <dt class="help-text">IP</dt><dd>${escapeHtml(node.lastSeenIp || '—')}</dd>
                <dt class="help-text">Son panel bildirimi</dt><dd>${node.lastSeenAt ? escapeHtml(formatRelativeTime(node.lastSeenAt)) : '—'}</dd>
                ${unLine}
                <dt class="help-text">Graylog (7 gün)</dt><dd>${formatFleetLogCount(g.total7d)}${g.error ? ` <span class="help-text">(${escapeHtml(g.error)})</span>` : ''}</dd>
            </dl>`;
        const logRows = samples.length
            ? samples.map((s) => {
                const ts = escapeHtml(String(s.timestamp || '—'));
                const src = escapeHtml(String(s.source || ''));
                const msg = escapeHtml(String(s.message || '').slice(0, 400));
                return `<tr><td style="white-space:nowrap; font-size:0.8rem;" class="help-text">${ts}</td><td style="font-size:0.82rem;"><span class="help-text">${src}</span><br>${msg}</td></tr>`;
            }).join('')
            : '<tr><td colspan="2" class="help-text">Örnek yok veya Graylog yanıt vermedi.</td></tr>';
        body.innerHTML = `${meta}
            <div style="font-weight:600; margin-bottom:0.35rem; font-size:0.9rem;">Son kayıtlar (en fazla 10)</div>
            <div style="overflow-x:auto; max-height:280px; overflow-y:auto; border:1px solid var(--color-border); border-radius:0.35rem;">
            <table class="fleet-data-table" style="font-size:0.82rem;"><tbody>${logRows}</tbody></table>
            </div>`;
    } catch (err) {
        body.innerHTML = `<p class="loading">Hata: ${escapeHtml(err.message)}</p>`;
    }
}

function closeFleetHostModal() {
    const modal = document.getElementById('fleet-host-modal');
    if (modal) modal.style.display = 'none';
}

function formatEnrollmentStatusTr(code) {
    const c = String(code || 'unknown').toLowerCase();
    const map = {
        pending: 'Bekliyor',
        active: 'Aktif',
        expired: 'Süresi doldu',
        revoked: 'İptal edildi',
        unknown: 'Bilinmiyor'
    };
    return map[c] || escapeHtml(c);
}

function enrollmentStatusBadgeClass(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'active') return 'success';
    if (c === 'revoked') return 'danger';
    if (c === 'expired') return 'warning';
    if (c === 'pending') return 'info';
    return 'unknown';
}

function formatShortDateTimeTr(value) {
    const date = parseIsoDate(value);
    if (!date) return '-';
    // Europe/Istanbul: panel «yerel» ile tarayıcı TZ karışmasın; TR operasyon saati sabit
    return date.toLocaleString('tr-TR', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderAgentHistoryTable() {
    const container = document.getElementById('agent-history-table');
    if (!container) return;

    if (!hasAtLeastRole('operator')) {
        container.textContent = 'Onboarding geçmişi için operator rolü gerekli.';
        return;
    }

    if (!agentOnboardingHistory.length) {
        container.textContent = 'Onboarding geçmişi bulunamadı.';
        return;
    }

    const rows = agentOnboardingHistory.slice(0, 20).map((item) => {
        const disp = String(item.effectiveStatus || item.status || 'unknown');
        const level = enrollmentStatusBadgeClass(disp);
        const label = formatEnrollmentStatusTr(disp);
        const host = escapeHtml(item.nodeHost || '—');
        const createdAbs = item.createdAt ? formatShortDateTimeTr(item.createdAt) : '—';
        const createdRel = item.createdAt ? formatRelativeTime(item.createdAt) : '';
        const created = item.createdAt ? `${createdAbs} <span class="help-text" style="font-size:0.78rem;">(${createdRel})</span>` : '—';
        const expires = formatShortDateTimeTr(item.expiresAt);
        const lastEvt = item.lastSeenAt ? formatRelativeTime(item.lastSeenAt) : '—';
        const actN = item.activationCount || 0;
        const actWhen = actN > 0 && item.activatedAt ? formatShortDateTimeTr(item.activatedAt) : '—';
        const dl = item.scriptDownloads || 0;
        const by = escapeHtml(item.createdBy || '—');
        return `
            <tr>
                <td>${escapeHtml(item.profileId || '—')}</td>
                <td>${by}</td>
                <td><span class="status-badge status-${level}">${label}</span></td>
                <td>${host}</td>
                <td>${dl}</td>
                <td>${actN}</td>
                <td>${actWhen}</td>
                <td>${created}</td>
                <td>${expires}</td>
                <td>${lastEvt}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div style="font-weight:600; margin-bottom:0.35rem;">Kayıt geçmişi (son 20)</div>
        <p class="help-text" style="margin:0 0 0.45rem 0; font-size:0.78rem;">Son olay: indirme veya aktivasyon (heartbeat değil). Saat: Europe/Istanbul.</p>
        <div style="overflow-x:auto;">
        <table class="logs-table">
            <thead><tr>
                <th>Profil</th>
                <th>Oluşturan</th>
                <th>Durum</th>
                <th>Node</th>
                <th>İndirme</th>
                <th>Akt. #</th>
                <th>Aktivasyon (TR)</th>
                <th>Oluşturma (TR)</th>
                <th>Bitiş (TR)</th>
                <th>Son olay</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>
    `;
}

function setupAgentFleetModeSwitch() {
    const w = document.getElementById('agent-fleet-mode-wizard');
    const a = document.getElementById('agent-fleet-mode-advanced');
    const pw = document.getElementById('agent-fleet-panel-wizard');
    const pa = document.getElementById('agent-fleet-panel-advanced');
    if (!w || !a || !pw || !pa) return;

    const setMode = (mode) => {
        const advanced = mode === 'advanced';
        pw.style.display = advanced ? 'none' : 'block';
        pa.style.display = advanced ? 'block' : 'none';
        w.classList.toggle('btn-primary', !advanced);
        w.classList.toggle('btn-secondary', advanced);
        a.classList.toggle('btn-primary', advanced);
        a.classList.toggle('btn-secondary', !advanced);
        w.classList.toggle('active', !advanced);
        a.classList.toggle('active', advanced);
        w.setAttribute('aria-selected', String(!advanced));
        a.setAttribute('aria-selected', String(advanced));
        try {
            sessionStorage.setItem('agentFleetUiMode', mode);
        } catch (e) { /* ignore */ }
    };

    w.addEventListener('click', () => setMode('wizard'));
    a.addEventListener('click', () => setMode('advanced'));

    try {
        const saved = sessionStorage.getItem('agentFleetUiMode');
        if (saved === 'advanced') setMode('advanced');
        else setMode('wizard');
    } catch (e) {
        setMode('wizard');
    }
}

async function initOnboardingWizard() {
    onboardingWizardStep = 1;
    onboardingWizardState.scenario = null;
    onboardingWizardState.canInstall = null;
    onboardingSelfTestProbe = '';
    document.querySelectorAll('#onboarding-step-1 .onboarding-scenario-btn, #onboarding-step-2 .onboarding-scenario-btn').forEach(b => b.classList.remove('selected'));
    showOnboardingWizardStep(1);
    const res = document.getElementById('onboarding-wizard-check-result');
    if (res) res.textContent = 'Henüz kontrol edilmedi.';
    try {
        const d = await apiRequest('/api/agent/default-ingest');
        const h = document.getElementById('onboarding-wizard-ingest-host');
        const p = document.getElementById('onboarding-wizard-ingest-port');
        if (h && !h.value.trim()) h.value = d.ingestHost || '';
        if (p && d.ingestPort) p.value = String(d.ingestPort);
    } catch (_) { /* ignore */ }
}

function showOnboardingWizardStep(n) {
    onboardingWizardStep = Math.max(1, Math.min(5, n));
    const ind = document.getElementById('onboarding-wizard-indicator');
    if (ind) ind.textContent = `Adım ${onboardingWizardStep} / 5`;
    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`onboarding-step-${i}`);
        if (el) el.classList.toggle('active', i === onboardingWizardStep);
    }
    if (onboardingWizardStep === 5) {
        void loadOnboardingSelfTestInstructions(false);
    }
}

function syncWizardToAgentForm() {
    let profileId = 'linux-agent-v1';
    let logType = 'system';
    if (onboardingWizardState.scenario === 'windows_server') {
        profileId = onboardingWizardState.canInstall === 'no' ? 'syslog-relay-v1' : 'windows-agent-v1';
    } else if (onboardingWizardState.canInstall === 'no') {
        profileId = 'syslog-relay-v1';
    } else if (onboardingWizardState.scenario === 'network_device') {
        profileId = 'syslog-relay-v1';
    }
    if (onboardingWizardState.scenario === 'web_server') {
        logType = 'web_access';
    }
    const sel = document.getElementById('agent-profile-select');
    if (sel) {
        sel.value = profileId;
    }
    onAgentProfileChanged();
    const wh = document.getElementById('onboarding-wizard-ingest-host')?.value?.trim() || '';
    const wp = document.getElementById('onboarding-wizard-ingest-port')?.value || '5151';
    const ah = document.getElementById('agent-ingest-host');
    const ap = document.getElementById('agent-ingest-port');
    const lt = document.getElementById('agent-log-type');
    if (ah) ah.value = wh;
    if (ap) ap.value = wp;
    if (lt) lt.value = logType;
    const hint = document.getElementById('onboarding-wizard-profile-hint');
    if (hint) {
        const p = agentProfiles.find(x => x.id === profileId);
        hint.textContent = `Seçilen profil: ${profileId} — ${p ? (p.description || p.name) : ''}`;
    }
}

function onboardingWizardNext() {
    if (onboardingWizardStep === 1) {
        if (!onboardingWizardState.scenario) {
            showAlert('Lütfen bir senaryo seçin', 'warning');
            return;
        }
    }
    if (onboardingWizardStep === 2) {
        if (!onboardingWizardState.canInstall) {
            showAlert('Lütfen kurulum seçeneğini işaretleyin', 'warning');
            return;
        }
    }
    if (onboardingWizardStep === 3) {
        const wh = document.getElementById('onboarding-wizard-ingest-host')?.value?.trim() || '';
        if (!wh) {
            showAlert('Merkez adresi (IP veya hostname) gerekli', 'warning');
            return;
        }
    }
    if (onboardingWizardStep === 4) {
        showOnboardingWizardStep(5);
        return;
    }
    if (onboardingWizardStep < 5) {
        const next = onboardingWizardStep + 1;
        if (next === 4) {
            syncWizardToAgentForm();
        }
        showOnboardingWizardStep(next);
    }
}

function onboardingWizardBack() {
    if (onboardingWizardStep <= 1) return;
    showOnboardingWizardStep(onboardingWizardStep - 1);
}

async function onboardingWizardCreateToken() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Token üretmek için admin rolü gerekli', 'warning');
        return;
    }
    syncWizardToAgentForm();
    await createAgentEnrollmentToken();
}

async function loadOnboardingSelfTestInstructions(forceNewProbe) {
    if (!hasAtLeastRole('operator')) {
        const le = document.getElementById('onboarding-wizard-linux-cmd');
        const pe = document.getElementById('onboarding-wizard-ps-cmd');
        if (le) le.value = 'Self-test için operator veya admin rolü gerekli.';
        if (pe) pe.value = '';
        return;
    }
    const host = (document.getElementById('onboarding-wizard-ingest-host')?.value || '').trim();
    const port = parseInt(document.getElementById('onboarding-wizard-ingest-port')?.value || '5151', 10);
    let q = `ingestHost=${encodeURIComponent(host)}&ingestPort=${port}`;
    if (!forceNewProbe && onboardingSelfTestProbe) {
        q += `&probe=${encodeURIComponent(onboardingSelfTestProbe)}`;
    }
    try {
        const data = await apiRequest(`/api/agent/self-test/instructions?${q}`);
        onboardingSelfTestProbe = data.probe || '';
        const le = document.getElementById('onboarding-wizard-linux-cmd');
        const pe = document.getElementById('onboarding-wizard-ps-cmd');
        const pl = document.getElementById('onboarding-wizard-probe-label');
        if (le) le.value = data.linuxCommand || '';
        if (pe) pe.value = data.powershellScript || '';
        if (pl) pl.textContent = `Test kodu (mesajda geçer): ${onboardingSelfTestProbe}`;
    } catch (error) {
        showAlert(`Self-test talimatı alınamadı: ${error.message}`, 'danger');
    }
}

async function checkOnboardingGraylog() {
    const resultEl = document.getElementById('onboarding-wizard-check-result');
    if (!hasAtLeastRole('operator')) {
        if (resultEl) resultEl.textContent = 'Bu kontrol için operator veya admin rolü gerekli.';
        return;
    }
    if (!onboardingSelfTestProbe) {
        showAlert('Önce test komutlarını yükleyin (Adım 5)', 'warning');
        return;
    }
    if (resultEl) resultEl.textContent = 'Graylog taranıyor…';
    try {
        const d = await apiRequest(`/api/agent/self-test/status?probe=${encodeURIComponent(onboardingSelfTestProbe)}`);
        if (d.found) {
            if (resultEl) {
                resultEl.innerHTML = '<span class="status-badge status-success">Merkeze ulaştı ✓</span> Son 15 dakikada bu test kodu Graylog aramasında bulundu.';
            }
            showAlert('Bağlantı doğrulandı', 'success');
            return;
        }
        const checklist = (d.checklist || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
        if (resultEl) {
            resultEl.innerHTML = d.graylogSearched === false
                ? `<span class="status-badge status-warning">Graylog araması yapılamadı</span> ${escapeHtml(d.error || '')}<ul style="margin:0.35rem 0 0 1rem;">${checklist}</ul>`
                : '<span class="status-badge status-danger">Henüz görünmüyor</span> Komutu gönderen makineden birkaç saniye sonra tekrar deneyin. Firewall ve IP’yi kontrol edin.';
        }
    } catch (error) {
        if (resultEl) resultEl.textContent = `Hata: ${error.message}`;
    }
}

async function loadAgentProfiles() {
    const summary = document.getElementById('agent-profile-summary');
    if (summary) summary.textContent = 'Profil kataloğu yükleniyor...';
    try {
        const data = await apiRequest('/api/agent/profiles');
        agentProfiles = Array.isArray(data.profiles) ? data.profiles : [];
        renderAgentProfiles();
    } catch (error) {
        agentProfiles = [];
        if (summary) summary.textContent = `Profil kataloğu hatası: ${error.message}`;
    }
}

async function loadAgentEnrollmentTokens() {
    const summary = document.getElementById('agent-token-summary');
    if (summary) summary.textContent = 'Token listesi yükleniyor...';

    if (!hasAtLeastRole('admin')) {
        agentEnrollmentTokens = [];
        renderAgentTokenSummary();
        return;
    }

    try {
        const data = await apiRequest('/api/agent/enrollment-tokens');
        agentEnrollmentTokens = Array.isArray(data.tokens) ? data.tokens : [];
        renderAgentTokenSummary();
    } catch (error) {
        agentEnrollmentTokens = [];
        if (summary) summary.textContent = `Token yükleme hatası: ${error.message}`;
    }
}

async function loadAgentNodes() {
    const summary = document.getElementById('agent-node-summary');
    if (summary) summary.textContent = 'Yükleniyor…';

    if (!hasAtLeastRole('operator')) {
        agentNodes = [];
        return;
    }

    try {
        const data = await apiRequest('/api/agent/nodes');
        agentNodes = Array.isArray(data.nodes) ? data.nodes : [];
    } catch (error) {
        agentNodes = [];
        if (summary) summary.textContent = `Liste hatası: ${error.message}`;
    }
}

async function loadAgentOnboardingHistory() {
    const container = document.getElementById('agent-history-table');
    if (container) container.textContent = 'Onboarding geçmişi yükleniyor...';

    if (!hasAtLeastRole('operator')) {
        agentOnboardingHistory = [];
        renderAgentHistoryTable();
        return;
    }

    try {
        const data = await apiRequest('/api/agent/onboarding-history');
        agentOnboardingHistory = Array.isArray(data.items) ? data.items : [];
        renderAgentHistoryTable();
    } catch (error) {
        agentOnboardingHistory = [];
        if (container) container.textContent = `Onboarding geçmişi hatası: ${error.message}`;
    }
}

function buildAgentInstallCommandBash(installUrlSh) {
    const safeUrl = String(installUrlSh || '').trim();
    if (!safeUrl) return '';
    return `curl -fsSL "${safeUrl}" | sudo bash`;
}

function buildAgentInstallCommand(installUrl) {
    return buildAgentInstallCommandBash(installUrl);
}

function buildAgentInstallCommandWindows(installUrlPs1) {
    const u = String(installUrlPs1 || '').trim();
    if (!u) return '';
    const esc = u.replace(/'/g, "''");
    return `$url = '${esc}'
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\\LogPlatformAgentInstall.ps1" -UseBasicParsing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\LogPlatformAgentInstall.ps1"`;
}

function buildAgentUninstallCommandWindows(uninstallUrlPs1) {
    const u = String(uninstallUrlPs1 || '').trim();
    if (!u) return '';
    const esc = u.replace(/'/g, "''");
    return `$url = '${esc}'
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\\LogPlatformAgentUninstall.ps1" -UseBasicParsing
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\LogPlatformAgentUninstall.ps1"`;
}

function applyAgentInstallCommandsFromResponse(data) {
    const kind = data.installKind || 'bash';
    const urlEl = document.getElementById('agent-install-url');
    const bashEl = document.getElementById('agent-install-command');
    const winTa = document.getElementById('agent-install-command-win');
    const rowBash = document.getElementById('agent-install-row-bash');
    const rowWin = document.getElementById('agent-install-row-win');
    const rowUn = document.getElementById('agent-uninstall-row-win');
    const urlUnEl = document.getElementById('agent-uninstall-url');
    const winUnTa = document.getElementById('agent-uninstall-command-win');
    const hint = document.getElementById('agent-install-kind-hint');

    const primary = String(data.installUrl || '').trim();
    const urlSh = String(data.installUrlSh || data.installUrl || '').trim();
    const urlPs = String(data.installUrlPs1 || data.installUrl || '').trim();
    const urlUn = String(data.uninstallUrlPs1 || '').trim();

    if (urlEl) urlEl.value = primary;

    if (kind === 'powershell') {
        if (rowBash) rowBash.style.display = 'none';
        if (rowWin) rowWin.style.display = 'flex';
        if (bashEl) bashEl.value = '';
        if (winTa) winTa.value = buildAgentInstallCommandWindows(urlPs || primary);
        if (rowUn) rowUn.style.display = urlUn ? 'flex' : 'none';
        if (urlUnEl) urlUnEl.value = urlUn;
        if (winUnTa) winUnTa.value = urlUn ? buildAgentUninstallCommandWindows(urlUn) : '';
        if (hint) {
            hint.textContent = 'Bu token yalnızca Windows içindir. Üstteki adres .ps1 biter; Linux’ta çalışmaz. Komutu hedef Windows’ta Yönetici PowerShell ile çalıştırın (Fluent Bit indirilir, servis kurulur). Kaldırma: aynı token ile alttaki «Kaldırma» bağlantısı — çalışınca panele audit kaydı düşer. Linux için panelde «Linux Agent» veya «Syslog Relay» ile yeni token alın.';
        }
    } else {
        if (rowBash) rowBash.style.display = 'flex';
        if (rowWin) rowWin.style.display = 'none';
        if (rowUn) rowUn.style.display = 'none';
        if (urlUnEl) urlUnEl.value = '';
        if (winUnTa) winUnTa.value = '';
        if (winTa) winTa.value = '';
        const shUrl = String(data.installUrlSh || '').trim() || primary;
        if (bashEl) bashEl.value = buildAgentInstallCommandBash(shUrl);
        if (hint) {
            hint.textContent = 'Bu token Linux veya syslog relay içindir. Üstteki adres .sh biter; Windows’ta çalışmaz. Komutu hedef Linux’ta root veya sudo ile çalıştırın. Windows kurulumu için panelde «Windows Agent» profiliyle ayrı token üretin.';
        }
    }
}

async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        const tempInput = document.createElement('textarea');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(tempInput);
        return ok;
    }
}

async function copyAgentInstallCommand() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const input = document.getElementById('agent-install-command');
    const command = input ? String(input.value || '').trim() : '';
    if (!command) {
        showAlert('Önce token üretin', 'warning');
        return;
    }
    const copied = await copyTextToClipboard(command);
    showAlert(copied ? 'Kurulum komutu kopyalandı' : 'Komut kopyalanamadı', copied ? 'success' : 'danger');
}

async function copyAgentInstallCommandWin() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const ta = document.getElementById('agent-install-command-win');
    const command = ta ? String(ta.value || '').trim() : '';
    if (!command) {
        showAlert('Önce Windows için token üretin', 'warning');
        return;
    }
    const copied = await copyTextToClipboard(command);
    showAlert(copied ? 'PowerShell komutları kopyalandı' : 'Kopyalanamadı', copied ? 'success' : 'danger');
}

async function copyAgentUninstallCommandWin() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const ta = document.getElementById('agent-uninstall-command-win');
    const command = ta ? String(ta.value || '').trim() : '';
    if (!command) {
        showAlert('Önce Windows token üretin (kaldırma bağlantısı üretilir)', 'warning');
        return;
    }
    const copied = await copyTextToClipboard(command);
    showAlert(copied ? 'Kaldırma komutu kopyalandı' : 'Kopyalanamadı', copied ? 'success' : 'danger');
}

async function createAgentEnrollmentToken() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }

    const profileSelect = document.getElementById('agent-profile-select');
    const selectedProfile = profileSelect ? profileSelect.value : '';
    if (!selectedProfile) {
        showAlert('Önce bir profil seçin', 'warning');
        return;
    }

    const payload = {
        profileId: selectedProfile,
        ingestHost: (document.getElementById('agent-ingest-host')?.value || '').trim(),
        ingestPort: parseInt(document.getElementById('agent-ingest-port')?.value || '5151', 10),
        companyId: (document.getElementById('agent-company-id')?.value || 'default').trim(),
        siteId: (document.getElementById('agent-site-id')?.value || 'default-site').trim(),
        logType: (document.getElementById('agent-log-type')?.value || 'system').trim(),
        ttlMinutes: parseInt(document.getElementById('agent-ttl-minutes')?.value || '120', 10)
    };

    const profile = agentProfiles.find(item => item.id === selectedProfile);
    if (profile && profile.type === 'relay') {
        payload.relayUdpPort = parseInt(document.getElementById('agent-relay-udp-port')?.value || '1514', 10);
        payload.relayTcpPort = parseInt(document.getElementById('agent-relay-tcp-port')?.value || '1514', 10);
    }

    try {
        const data = await apiRequest('/api/agent/enrollment-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resultEl = document.getElementById('agent-install-result');

        if (resultEl) {
            const expiresAt = data?.record?.expiresAt || '-';
            resultEl.textContent = `✓ Token üretildi • profil=${selectedProfile} • expires=${expiresAt}`;
        }
        applyAgentInstallCommandsFromResponse(data);

        await loadAgentEnrollmentTokens();
        showAlert(data.message || 'Enrollment token oluşturuldu', 'success');
    } catch (error) {
        const resultEl = document.getElementById('agent-install-result');
        if (resultEl) resultEl.textContent = `✗ Token üretme hatası: ${error.message}`;
        showAlert(`Token üretme hatası: ${error.message}`, 'danger');
    }
}

async function revokeSelectedAgentToken() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }

    const select = document.getElementById('agent-token-revoke-select');
    const tokenId = (select && select.value) ? select.value : '';
    if (!tokenId) {
        showAlert('Önce iptal edilecek tokenı seçin', 'warning');
        return;
    }

    const ok = await confirmDangerousAction({
        message: 'Seçili enrollment token iptal edilecek.',
        detail: 'İptal edilen token ile yeni agent kaydı yapılamaz. Mevcut agent\'lar etkilenmez.'
    });
    if (!ok) return;

    try {
        const data = await apiRequest('/api/agent/enrollment-token/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenId })
        });
        showAlert(data.message || 'Token iptal edildi', 'success');
        await loadAgentEnrollmentTokens();
    } catch (error) {
        showAlert(`Token iptal hatası: ${error.message}`, 'danger');
    }
}

async function mergeFleetGraylogOverview() {
    if (!hasAtLeastRole('operator') || !agentNodes.length) return;
    try {
        const data = await apiRequest('/api/agent/fleet-overview');
        const enriched = Array.isArray(data.nodes) ? data.nodes : [];
        const byKey = new Map();
        enriched.forEach((row) => {
            const k = (row.hostname || '').toLowerCase();
            if (k) byKey.set(k, row);
        });
        agentNodes = agentNodes.map((n) => {
            const k = (n.hostname || '').toLowerCase();
            const g = k ? byKey.get(k) : null;
            if (!g) return { ...n };
            return {
                ...n,
                logCount24h: g.logCount24h,
                logCount7d: g.logCount7d,
                graylogError24h: g.graylogError24h,
                graylogError7d: g.graylogError7d
            };
        });
    } catch (e) {
        console.warn('fleet-overview', e);
    }
}

async function loadAgentFleetData() {
    await loadAgentProfiles();
    await Promise.all([
        loadAgentEnrollmentTokens(),
        loadAgentNodes(),
        loadAgentOnboardingHistory()
    ]);
    await mergeFleetGraylogOverview();
    renderAgentNodeSummary();
    renderAgentHeartbeatSummary();
    renderFleetHostsTable();
    // Varsayılan ingest host'u otomatik doldur (boşsa)
    try {
        const def = await apiRequest('/api/agent/default-ingest');
        const ingestHostEl = document.getElementById('agent-ingest-host');
        if (ingestHostEl && !ingestHostEl.value.trim()) {
            ingestHostEl.value = def.ingestHost || '';
            ingestHostEl.placeholder = def.ingestHost ? `Otomatik: ${def.ingestHost}` : 'Merkez sunucu IP/host';
        }
        const ingestPortEl = document.getElementById('agent-ingest-port');
        if (ingestPortEl && def.ingestPort) ingestPortEl.value = def.ingestPort;
    } catch (_) { /* ignore */ }
}

async function loadReleaseStatus() {
    const container = document.getElementById('release-status-info');
    if (!container) return;
    try {
        const data = await apiRequest('/api/release/status');
        container.innerHTML = `
            <div class="health-item"><span>Ortam</span><span>${escapeHtml(data.environment || '-')}</span></div>
            <div class="health-item"><span>Release Tag</span><span><strong>${escapeHtml(data.currentTag || 'dev')}</strong></span></div>
        `;
    } catch (error) {
        container.innerHTML = `<p class="loading">Yükleme hatası: ${escapeHtml(error.message)}</p>`;
    }
}

async function loadNormalizationData() {
    const samplesContainer = document.getElementById('qc-samples-list');
    const rowsContainer = document.getElementById('normalization-lookup-rows');
    const addForm = document.getElementById('normalization-add-form');
    if (!samplesContainer || !rowsContainer) return;

    try {
        const [samplesData, rowsData] = await Promise.all([
            apiRequest('/api/normalization/qc-samples'),
            apiRequest('/api/normalization/lookup-rows')
        ]);

        const samples = samplesData.samples || [];
        if (samples.length) {
            samplesContainer.innerHTML = samples.map(s => {
                const v = escapeHtml(s.vendor);
                const p = escapeHtml(s.product);
                const o = escapeHtml(s.os_major);
                const vq = JSON.stringify(s.vendor);
                const pq = JSON.stringify(s.product);
                const oq = JSON.stringify(s.os_major);
                return `<div class="service-item" style="cursor:pointer;" onclick="fillNormForm(${vq},${pq},${oq})" title="Formu doldurmak için tıklayın">
                    <span>${v} | ${p} | ${o}</span>
                    <code style="font-size:0.8rem">${escapeHtml(s.lookupKey)}</code>
                </div>`;
            }).join('');
            if (addForm) addForm.style.display = '';
        } else {
            samplesContainer.innerHTML = `<p class="loading">${samplesData.message || 'QC stream\'de örnek yok.'}</p>`;
            if (addForm) addForm.style.display = '';
        }

        const rows = rowsData.rows || [];
        rowsContainer.innerHTML = rows.length
            ? rows.map(r => `<div class="service-item"><code>${escapeHtml(r.key)}</code> → <strong>${escapeHtml(r.profile)}</strong></div>`).join('')
            : '<p class="loading">Lookup satırı yok.</p>';
    } catch (error) {
        samplesContainer.innerHTML = `<p class="loading">Yükleme hatası: ${error.message}</p>`;
        if (rowsContainer) rowsContainer.innerHTML = `<p class="loading">Yükleme hatası.</p>`;
    }
}

function fillNormForm(vendor, product, osMajor) {
    const v = document.getElementById('norm-vendor');
    const p = document.getElementById('norm-product');
    const o = document.getElementById('norm-os-major');
    if (v) v.value = vendor || '';
    if (p) p.value = product || '';
    if (o) o.value = osMajor || 'unknown';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function addNormalizationMapping() {
    const vendor = document.getElementById('norm-vendor')?.value?.trim();
    const product = document.getElementById('norm-product')?.value?.trim();
    const osMajor = document.getElementById('norm-os-major')?.value?.trim() || 'unknown';
    const profile = document.getElementById('norm-profile')?.value?.trim();
    const srcField = document.getElementById('norm-src-field')?.value?.trim() || 'src';
    const dstField = document.getElementById('norm-dst-field')?.value?.trim() || 'dst';
    const resultEl = document.getElementById('norm-add-result');
    if (!resultEl) return;

    if (!vendor || !product) {
        resultEl.textContent = 'vendor ve product zorunludur.';
        resultEl.style.color = 'var(--color-danger)';
        return;
    }

    try {
        const data = await apiRequest('/api/normalization/add-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vendor,
                product,
                os_major: osMajor,
                profile: profile || undefined,
                srcField,
                dstField
            })
        });
        if (data.written) {
            resultEl.textContent = data.message || 'Mapping eklendi.';
            resultEl.style.color = 'var(--color-success)';
            await loadNormalizationData();
        } else if (data.manualStepRequired) {
            resultEl.innerHTML = `Manuel adım: <code>${escapeHtml(data.lineToAdd)}</code> satırını ${escapeHtml(data.file)} dosyasına ekleyin.`;
            resultEl.style.color = 'var(--color-warning)';
        } else {
            resultEl.textContent = data.message || 'Tamamlandı.';
            resultEl.style.color = '';
        }
    } catch (error) {
        resultEl.textContent = `Hata: ${error.message}`;
        resultEl.style.color = 'var(--color-danger)';
    }
}

async function normDryRunPreview() {
    const vendor = document.getElementById('norm-vendor')?.value?.trim();
    const product = document.getElementById('norm-product')?.value?.trim();
    const osMajor = document.getElementById('norm-os-major')?.value?.trim() || 'unknown';
    const profile = document.getElementById('norm-profile')?.value?.trim();
    const srcField = document.getElementById('norm-src-field')?.value?.trim() || 'src';
    const dstField = document.getElementById('norm-dst-field')?.value?.trim() || 'dst';
    const previewEl = document.getElementById('norm-dry-run-preview');
    if (!previewEl) return;
    if (!vendor || !product) {
        previewEl.textContent = 'vendor ve product girin.';
        previewEl.style.display = 'block';
        previewEl.style.color = 'var(--color-danger)';
        return;
    }
    try {
        const sample = { vendor, product, os_major: osMajor, message: 'örnek mesaj', src: '192.168.1.1', dst: '10.0.0.1' };
        const data = await apiRequest('/api/normalization/dry-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vendor, product, os_major: osMajor, profile: profile || undefined, srcField, dstField, sampleMessage: sample })
        });
        previewEl.textContent = 'Önizleme: ' + JSON.stringify(data.preview || {}, null, 2);
        previewEl.style.display = 'block';
        previewEl.style.color = '';
    } catch (error) {
        previewEl.textContent = 'Hata: ' + error.message;
        previewEl.style.display = 'block';
        previewEl.style.color = 'var(--color-danger)';
    }
}

async function perfDetectRam() {
    const input = document.getElementById('perf-ram-input');
    const recsEl = document.getElementById('perf-recommendations');
    if (!input || !recsEl) return;
    try {
        const data = await apiRequest('/api/performance/detect-ram');
        if (data.ramMb) {
            input.value = data.ramMb;
            recsEl.textContent = `Tespit edilen RAM: ${data.ramMb} MB`;
        } else {
            recsEl.textContent = data.error || 'RAM tespit edilemedi.';
        }
    } catch (e) {
        recsEl.textContent = 'Hata: ' + e.message;
    }
}

async function perfGetRecommendations() {
    const input = document.getElementById('perf-ram-input');
    const recsEl = document.getElementById('perf-recommendations');
    if (!input || !recsEl) return;
    const ram = parseInt(input.value, 10);
    if (!ram || ram < 512) {
        recsEl.textContent = 'Geçerli RAM (MB) girin (min 512).';
        return;
    }
    try {
        const data = await apiRequest(`/api/performance/recommendations?ram_mb=${ram}`);
        const r = data.recommended || {};
        const res = data.reservedRamMb != null ? `Rezerv %20: ${data.reservedRamMb} MB • Kullanılabilir: ${data.availableRamMb} MB` : '';
        recsEl.innerHTML = `
            <div><strong>Önerilen Java heap</strong> (docker-compose single-node ile aynı formül)</div>
            <div style="margin-top:0.35rem;">Graylog: <code>${r.GRAYLOG_JAVA_HEAP_MB ?? '-'} MB</code> → <code>-Xms${r.GRAYLOG_HEAP || '-'}</code></div>
            <div>OpenSearch: <code>${r.OPENSEARCH_JAVA_HEAP_MB ?? '-'} MB</code> → <code>-Xms${r.OPENSEARCH_HEAP || '-'}</code></div>
            <div style="margin-top:0.35rem; font-size:0.88rem; color:var(--text-muted);">${res}</div>
            <div style="margin-top:0.35rem; font-size:0.88rem; color:var(--text-muted);">${data.formula || ''}</div>`;
    } catch (e) {
        recsEl.textContent = 'Hata: ' + e.message;
    }
}

async function perfApplyAutoTune() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const resultEl = document.getElementById('perf-apply-result');
    const input = document.getElementById('perf-ram-input');
    if (!resultEl) return;
    const ramRaw = input && input.value ? parseInt(input.value, 10) : NaN;
    const body = Number.isFinite(ramRaw) && ramRaw >= 512 ? { ramMb: ramRaw } : {};
    try {
        const data = await apiRequest('/api/performance/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let detail = data.message || 'Uygulandı.';
        const cr = data.composeRecreate;
        if (cr && !cr.skipped && cr.ok && cr.output) {
            const tail = String(cr.output).trim().split('\n').slice(-6).join('\n');
            if (tail) detail += '\n\n— compose —\n' + tail;
        } else if (cr && !cr.skipped && !cr.ok && cr.error) {
            detail += '\n\n— compose hata —\n' + String(cr.error).slice(0, 1200);
        }
        const ss = data.serviceStatus;
        if (ss && typeof ss === 'object' && Object.keys(ss).length) {
            const lines = Object.entries(ss).map(([k, v]) => {
                if (!v || typeof v !== 'object') return `${k}: ?`;
                if (v.error) return `${k}: ${v.error}`;
                const h = v.health ? ` health:${v.health}` : '';
                return `${k}: ${v.status || '-'}${h}`;
            });
            detail += '\n\n— durum —\n' + lines.join('\n');
        }
        resultEl.textContent = detail;
        resultEl.style.color = cr && !cr.skipped && !cr.ok ? 'var(--color-warning)' : 'var(--color-success)';
        showAlert(data.message || 'Heap ayarları uygulandı', cr && !cr.skipped && !cr.ok ? 'warning' : 'success');
    } catch (e) {
        resultEl.textContent = 'Hata: ' + (e.message || e.error || 'Bilinmeyen');
        resultEl.style.color = 'var(--color-danger)';
    }
}

function updateDiskGuidanceBanner(diskProfile) {
    const wrap = document.getElementById('disk-guidance-banner');
    const titleEl = document.getElementById('disk-guidance-title');
    const metricsEl = document.getElementById('disk-guidance-metrics');
    const bodyEl = document.getElementById('disk-guidance-body');
    if (!wrap || !titleEl || !metricsEl || !bodyEl) return;
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('diskGuidanceDismissed') === '1') {
        wrap.classList.add('disk-guidance-hidden');
        return;
    }
    if (!diskProfile) {
        wrap.classList.add('disk-guidance-hidden');
        return;
    }
    if (diskProfile.ok === false && (diskProfile.error || (diskProfile.messages && diskProfile.messages.length))) {
        wrap.classList.remove('disk-guidance-hidden', 'severity-danger', 'severity-warning', 'severity-info');
        wrap.classList.add('severity-danger');
        titleEl.textContent = 'Depolama bilgisi alınamadı';
        metricsEl.textContent = '';
        bodyEl.replaceChildren();
        (diskProfile.messages || []).forEach((m) => {
            const p = document.createElement('p');
            p.className = 'disk-guidance-line';
            p.textContent = m;
            bodyEl.appendChild(p);
        });
        return;
    }
    const isolation = diskProfile.dataIsolation;
    const isolationBad = isolation && isolation.ok === false;
    const showReq = diskProfile.showDiskRequirementBanner === true;
    const showSep = diskProfile.showSeparateDiskBanner === true;
    const note = diskProfile.pathNote;
    const hasMsgs = Array.isArray(diskProfile.messages) && diskProfile.messages.length > 0;
    if (!showReq && !showSep && !note && !isolationBad && !hasMsgs) {
        wrap.classList.add('disk-guidance-hidden');
        return;
    }
    wrap.classList.remove('disk-guidance-hidden', 'severity-danger', 'severity-warning', 'severity-info');
    let sev = 'info';
    if (isolationBad || showReq) sev = 'danger';
    else if (showSep) sev = 'warning';
    wrap.classList.add('severity-' + sev);
    if (isolationBad) {
        titleEl.textContent = 'Dikkat: ortam klasörü ile sunucu etiketi uyuşmuyor';
    } else if (showReq) {
        titleEl.textContent = 'Disk boyutu veya boş alan yetersiz';
    } else if (showSep) {
        titleEl.textContent = 'Öneri: logları sistem diskinden ayırın';
    } else if (hasMsgs) {
        titleEl.textContent = 'Depolama bilgisi';
    } else {
        titleEl.textContent = 'Depolama';
    }
    const lines = [];
    if (isolationBad && isolation.issues && isolation.issues.length) {
        lines.push(...isolation.issues);
    }
    if (note) lines.push(note);
    if (Array.isArray(diskProfile.messages)) lines.push(...diskProfile.messages);
    bodyEl.replaceChildren();
    lines.slice(0, 4).forEach((m) => {
        const p = document.createElement('p');
        p.className = 'disk-guidance-line';
        p.textContent = m;
        bodyEl.appendChild(p);
    });
    if (lines.length > 4) {
        const more = document.createElement('p');
        more.className = 'disk-guidance-line disk-guidance-muted';
        more.textContent = `+${lines.length - 4} ek not — ayrıntı için Ayarlar → Depolama.`;
        bodyEl.appendChild(more);
    }
    if (diskProfile.ok && diskProfile.totalMib != null) {
        const gbTot = Math.max(0, Math.round(diskProfile.totalMib / 1024));
        const gbFree = Math.max(0, Math.round(diskProfile.freeMib / 1024));
        const pct = diskProfile.usagePercent != null ? ` • yaklaşık %${diskProfile.usagePercent} kullanımda` : '';
        metricsEl.textContent = `Tahmini: ~${gbTot} GB toplam, ~${gbFree} GB boş${pct}`;
    } else {
        metricsEl.textContent = '';
    }
}

function updateStorageHubPills(diskProfile, mountSnap) {
    const pillDisk = document.getElementById('storage-hub-pill-disk');
    const pillSpace = document.getElementById('storage-hub-pill-space');
    const pillEnv = document.getElementById('storage-hub-pill-env');
    if (!pillDisk || !pillSpace || !pillEnv) return;

    const setPill = (el, title, text, mood) => {
        el.className = 'storage-hub-pill' + (mood ? ` ${mood}` : '');
        el.innerHTML = `<strong>${title}</strong><span>${text}</span>`;
    };

    if (mountSnap && !mountSnap.error) {
        const same = !!mountSnap.sameFilesystemAsRoot;
        setPill(
            pillDisk,
            'Veri diski',
            same ? 'Loglar sistem diskiyle aynı bölümde' : 'Loglar ayrı diskte',
            same ? 'warn' : 'ok'
        );
    } else if (mountSnap && mountSnap.error) {
        setPill(pillDisk, 'Veri diski', 'Durum okunamadı', 'warn');
    } else {
        setPill(pillDisk, 'Veri diski', 'Yükleniyor…', '');
    }

    if (diskProfile && diskProfile.ok && diskProfile.totalMib != null) {
        const gbTot = Math.max(0, Math.round(diskProfile.totalMib / 1024));
        const gbFree = Math.max(0, Math.round(diskProfile.freeMib / 1024));
        const meets = diskProfile.meetsMinimum !== false;
        setPill(
            pillSpace,
            'Alan',
            `~${gbTot} GB toplam, ~${gbFree} GB boş`,
            meets ? 'ok' : 'bad'
        );
    } else {
        setPill(pillSpace, 'Alan', '—', '');
    }

    const iso = diskProfile && diskProfile.dataIsolation;
    if (iso && iso.ok === false) {
        setPill(pillEnv, 'Ortam klasörleri', 'Uyuşmazlık var — .env yollarını düzeltin', 'bad');
    } else if (iso && iso.warnings && iso.warnings.length) {
        setPill(pillEnv, 'Ortam klasörleri', 'Kontrol önerilir', 'warn');
    } else if (iso && iso.environment) {
        setPill(pillEnv, 'Ortam', `Bu sunucu: ${iso.environment}`, 'ok');
    } else {
        setPill(pillEnv, 'Ortam', '—', '');
    }
}

async function loadObservabilityMetrics() {
    try {
        const data = await apiRequest('/api/observability/metrics');
        const set = (id, val, badge) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val != null ? String(val) : '-';
            const b = document.getElementById(id.replace('-value', '-badge'));
            if (b) b.textContent = badge != null ? String(badge) : '-';
        };
        set('obs-ingest-value', data.ingestRecords, data.ingestRecords);
        set('obs-disk-value', data.diskUsagePercent != null ? data.diskUsagePercent + '%' : '-', data.diskUsagePercent != null ? data.diskUsagePercent + '%' : '-');
        set('obs-qc-value', data.qcStreamCount1h, data.qcStreamCount1h);
        set('obs-errors-value', data.outputErrors, data.outputErrors);
        lastDiskProfile = data.diskProfile || null;
        updateDiskGuidanceBanner(data.diskProfile);
        updateStorageHubPills(lastDiskProfile, lastStorageMountSnapshot);
    } catch (e) {
        console.error('Observability load error:', e);
    }
}

async function showConfigDiff() {
    if (!currentFile) return;
    const editor = document.getElementById('config-editor');
    if (!editor) return;
    const oldContent = originalConfigContent[currentFile] || '';
    const newContent = editor.value || '';
    try {
        const data = await apiRequest('/api/config/diff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old: oldContent, new: newContent })
        });
        const modal = document.getElementById('config-diff-modal');
        const content = document.getElementById('config-diff-content');
        if (modal && content) {
            content.textContent = data.diff || (data.hasChanges ? 'Değişiklik var ama diff üretilemedi.' : 'Değişiklik yok.');
            modal.classList.add('show');
            modal.style.display = 'flex';
        }
    } catch (e) {
        showAlert('Diff alınamadı: ' + e.message, 'danger');
    }
}

function closeConfigDiffModal() {
    const modal = document.getElementById('config-diff-modal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
}

function markDataFreshness(source) {
    dataFreshness[source] = new Date().toISOString();
    renderOverviewFreshness();
}

const dashboardUtils = window.DashboardUtils || {};

function parseIsoDate(value) {
    if (typeof dashboardUtils.parseIsoDate === 'function') {
        return dashboardUtils.parseIsoDate(value);
    }
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeTime(value) {
    if (typeof dashboardUtils.formatRelativeTime === 'function') {
        return dashboardUtils.formatRelativeTime(value);
    }
    const date = parseIsoDate(value);
    if (!date) return '-';
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.max(0, Math.floor(diffMs / 1000));
    if (diffSec < 60) return `${diffSec} sn önce`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} dk önce`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} sa önce`;
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay} gün önce`;
}

function getFreshnessStatus(value) {
    if (typeof dashboardUtils.getFreshnessStatus === 'function') {
        return dashboardUtils.getFreshnessStatus(value);
    }
    const date = parseIsoDate(value);
    if (!date) {
        return { level: 'unknown', label: 'Henüz alınmadı', relative: '-' };
    }

    const ageSeconds = (Date.now() - date.getTime()) / 1000;
    if (ageSeconds <= 60) {
        return { level: 'success', label: 'Taze', relative: formatRelativeTime(value) };
    }
    if (ageSeconds <= 180) {
        return { level: 'warning', label: 'Gecikmeli', relative: formatRelativeTime(value) };
    }
    return { level: 'danger', label: 'Eski', relative: formatRelativeTime(value) };
}

function formatActionSnapshot(snapshot) {
    if (typeof dashboardUtils.formatActionSnapshot === 'function') {
        return dashboardUtils.formatActionSnapshot(snapshot);
    }
    if (!snapshot) return '-';
    const prefix = snapshot.status === 'success' ? '✓' : snapshot.status === 'warning' ? '⚠' : '✗';
    return `${prefix} ${snapshot.message} • ${formatRelativeTime(snapshot.timestamp)}`;
}

function canPersistSettings() {
    return settingsWritable || settingsAutoApplyAvailable;
}

function getSettingCatalogValue(key, fallback = '') {
    if (!key) return fallback;
    const setting = (guidedSettings || []).find(item => item.key === key);
    if (!setting) return fallback;
    if (Object.prototype.hasOwnProperty.call(guidedSettingsDraftValues, key)) {
        return guidedSettingsDraftValues[key];
    }
    return setting.value ?? fallback;
}

function hasSettingValue(key) {
    return String(getSettingCatalogValue(key, '') || '').trim().length > 0;
}

function computeSettingsOpsSnapshot() {
    const signerType = String(getSettingCatalogValue('SIGNER_TYPE', 'OPEN_SOURCE') || 'OPEN_SOURCE').toUpperCase();
    const archiveDestination = String(getSettingCatalogValue('ARCHIVE_DESTINATION', 'local') || 'local');
    const telegramConfigured = hasSettingValue('TELEGRAM_BOT_TOKEN') && hasSettingValue('TELEGRAM_CHAT_ID');
    const webhookRunning = String(services?.['alert-webhook']?.status || '').toLowerCase() === 'running';
    const watchdogRunning = String(services?.watchdog?.status || '').toLowerCase() === 'running';
    const postCheckStatus = latestSettingsPostCheck?.status || 'unknown';

    const issues = [];
    if (!telegramConfigured) issues.push('Telegram kimlik bilgileri eksik');
    if (!webhookRunning) issues.push('alert-webhook servisi çalışmıyor');
    if (!watchdogRunning) issues.push('watchdog servisi çalışmıyor');
    if (postCheckStatus === 'failed') issues.push('son post-check başarısız');

    let level = 'success';
    let badgeText = 'Hazır';
    if (issues.length > 0 || postCheckStatus === 'warning') {
        level = postCheckStatus === 'failed' || issues.length >= 2 ? 'danger' : 'warning';
        badgeText = level === 'danger' ? 'Aksiyon Gerekli' : 'Kısmi Hazır';
    }

    return {
        level,
        badgeText,
        signerType,
        archiveDestination,
        telegramConfigured,
        webhookRunning,
        watchdogRunning,
        postCheckStatus,
        issues
    };
}

function renderSettingsOpsSnapshot() {
    const container = document.getElementById('settings-ops-snapshot');
    if (!container) return;

    const snapshot = computeSettingsOpsSnapshot();
    latestSettingsOpsSnapshot = snapshot;

    const statusClass = snapshot.level === 'success' ? 'status-success' : snapshot.level === 'danger' ? 'status-danger' : 'status-warning';
    const postCheckLabel = snapshot.postCheckStatus === 'success'
        ? 'Başarılı'
        : snapshot.postCheckStatus === 'failed'
            ? 'Başarısız'
            : snapshot.postCheckStatus === 'warning'
                ? 'Uyarı'
                : 'Bekleniyor';

    const details = [
        `Signer: ${snapshot.signerType}`,
        `Arşiv: ${snapshot.archiveDestination}`,
        `Telegram: ${snapshot.telegramConfigured ? 'hazır' : 'eksik'}`,
        `Webhook/Watchdog: ${snapshot.webhookRunning ? 'up' : 'down'} / ${snapshot.watchdogRunning ? 'up' : 'down'}`,
        `Post-check: ${postCheckLabel}`
    ];

    const issueText = snapshot.issues.length
        ? ` • Sorunlar: ${snapshot.issues.slice(0, 2).join(', ')}${snapshot.issues.length > 2 ? ` (+${snapshot.issues.length - 2})` : ''}`
        : '';

    container.innerHTML = `
        <span>${details.join(' • ')}${issueText}</span>
        <span class="status-badge ${statusClass}">${snapshot.badgeText}</span>
    `;
}

function renderSettingsRuntimeStatus() {
    const container = document.getElementById('settings-runtime-status');
    if (!container) return;

    if (settingsWritable && !settingsAutoApplyAvailable) {
        container.style.display = 'none';
        return;
    }

    container.style.display = '';

    let message = 'Sistem ayarları panel üzerinden doğrudan kaydediliyor.';
    let badgeClass = 'status-success';
    let badgeText = 'Doğrudan';

    if (!settingsWritable && settingsAutoApplyAvailable) {
        message = settingsWriteMessage || 'Ayar dosyası salt-okunur; değişiklikler otomatik uygulanır.';
        badgeClass = 'status-info';
        badgeText = 'Auto-Apply';
    } else if (!settingsWritable && !settingsAutoApplyAvailable) {
        message = settingsWriteMessage || 'Ayarlar şu anda panelden uygulanamıyor.';
        badgeClass = 'status-danger';
        badgeText = 'Müdahale Gerekli';
    }

    container.innerHTML = `
        <div class="settings-runtime-main">
            <div class="settings-runtime-title">Ayar Uygulama Modu</div>
            <div class="settings-runtime-text">${message}</div>
        </div>
        <span class="status-badge ${badgeClass}">${badgeText}</span>
    `;
}

function renderSettingsPostCheck() {
    const summaryEl = document.getElementById('settings-post-check-summary');
    const badgeEl = document.getElementById('settings-post-check-badge');
    const listEl = document.getElementById('settings-post-check-list');
    if (!summaryEl || !badgeEl || !listEl) return;

    if (!latestSettingsPostCheck) {
        summaryEl.textContent = 'Henüz çalıştırılmadı.';
        badgeEl.className = 'status-badge status-unknown';
        badgeEl.textContent = 'Bekleniyor';
        listEl.innerHTML = '<li>Health, ingest ve query smoke kontrolleri burada gösterilir.</li>';
        return;
    }

    const status = latestSettingsPostCheck.status || 'warning';
    const badgeClass = status === 'success' ? 'status-success' : status === 'failed' ? 'status-danger' : 'status-warning';
    const badgeLabel = status === 'success' ? 'Başarılı' : status === 'failed' ? 'Başarısız' : 'Uyarı';
    badgeEl.className = `status-badge ${badgeClass}`;
    badgeEl.textContent = badgeLabel;

    summaryEl.textContent = `${latestSettingsPostCheck.summary || 'Post-check tamamlandı'} • ${formatRelativeTime(latestSettingsPostCheck.timestamp)}`;

    const checks = latestSettingsPostCheck.checks || [];
    const suggestions = latestSettingsPostCheck.suggestions || [];
    const checkItems = checks.map(item => {
        const icon = item.status === 'success' ? '✓' : item.status === 'failed' ? '✗' : '⚠';
        return `<li>${icon} ${item.name}: ${item.message}</li>`;
    });
    const suggestionItems = suggestions.slice(0, 2).map(item => `<li>→ ${item}</li>`);
    listEl.innerHTML = [...checkItems, ...suggestionItems].join('') || '<li>Detay bulunamadı.</li>';
    renderSettingsOpsSnapshot();
}

async function runSettingsPostCheck(changedKey = '') {
    if (!hasAtLeastRole('operator')) {
        showAlert('Post-check için operator rolü gerekli', 'warning');
        return;
    }

    try {
        const data = await apiRequest('/api/settings/post-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: changedKey || null
            })
        });
        latestSettingsPostCheck = data;
        renderSettingsPostCheck();
        if (data.status === 'failed') {
            showAlert(data.summary || 'Post-check başarısız', 'danger');
        } else if (data.status === 'warning') {
            showAlert(data.summary || 'Post-check uyarılı tamamlandı', 'warning');
        } else {
            showAlert(data.summary || 'Post-check başarılı', 'success');
        }
    } catch (error) {
        latestSettingsPostCheck = {
            status: 'failed',
            summary: `Post-check hatası: ${error.message}`,
            timestamp: new Date().toISOString(),
            checks: [],
            suggestions: []
        };
        renderSettingsPostCheck();
        showAlert(`Post-check hatası: ${error.message}`, 'danger');
    }
}

function toFiniteNumber(value) {
    if (typeof dashboardUtils.toFiniteNumber === 'function') {
        return dashboardUtils.toFiniteNumber(value);
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function updatePipelineTrendHistory(state) {
    const now = Date.now();
    pipelineTrendHistory.push({
        ts: now,
        inputRecords: toFiniteNumber(state?.metrics?.inputRecords),
        outputProcessed: toFiniteNumber(state?.metrics?.outputProcessed),
        outputErrors: toFiniteNumber(state?.metrics?.outputErrors)
    });

    const minTs = now - PIPELINE_TREND_WINDOW_MS;
    pipelineTrendHistory = pipelineTrendHistory.filter(sample => sample.ts >= minTs);
}

function calculatePipelineKpis() {
    const thresholds = pipelineHealthState?.thresholds || {};
    const dropRateWarningPct = toFiniteNumber(thresholds.dropRateWarningPct) ?? 0.5;
    const dropRateDangerPct = toFiniteNumber(thresholds.dropRateDangerPct) ?? 1.0;
    const errorWarningDelta = toFiniteNumber(thresholds.errorWarningDelta) ?? 1;
    const measuredLatency = toFiniteNumber(pipelineHealthState?.metrics?.e2eLatencySec);
    const measuredLatencyStatus = pipelineHealthState?.metrics?.e2eLatencyStatus || 'unknown';

    const inputSeries = pipelineTrendHistory.filter(sample => sample.inputRecords !== null);
    const outputSeries = pipelineTrendHistory.filter(sample => sample.outputProcessed !== null);
    const errorSeries = pipelineTrendHistory.filter(sample => sample.outputErrors !== null);

    if (inputSeries.length < 2) {
        return {
            epsText: '-',
            dropRateText: '-',
            latencyText: '-',
            trendText: 'Yeterli veri yok',
            alertClass: 'info',
            alertText: 'Trend için en az iki örnek gerekir; henüz log akışı yoksa bu normaldir — darboğaz sinyali değildir.'
        };
    }

    const firstIn = inputSeries[0];
    const lastIn = inputSeries[inputSeries.length - 1];
    const seconds = Math.max(1, (lastIn.ts - firstIn.ts) / 1000);
    const deltaInput = Math.max(0, (lastIn.inputRecords || 0) - (firstIn.inputRecords || 0));
    const eps = deltaInput / seconds;

    const firstOut = outputSeries.length ? outputSeries[0] : null;
    const lastOut = outputSeries.length ? outputSeries[outputSeries.length - 1] : null;
    const deltaOutput = firstOut && lastOut
        ? Math.max(0, (lastOut.outputProcessed || 0) - (firstOut.outputProcessed || 0))
        : null;

    const firstErr = errorSeries.length ? errorSeries[0] : null;
    const lastErr = errorSeries.length ? errorSeries[errorSeries.length - 1] : null;
    const deltaErrors = firstErr && lastErr
        ? Math.max(0, (lastErr.outputErrors || 0) - (firstErr.outputErrors || 0))
        : 0;

    let dropRate = null;
    if (deltaOutput !== null && deltaInput > 0) {
        dropRate = Math.max(0, ((deltaInput - deltaOutput) / deltaInput) * 100);
    }

    const backlog = deltaOutput !== null ? Math.max(0, deltaInput - deltaOutput) : 0;
    const latencyEstimate = eps > 0 ? backlog / eps : null;

    let alertClass = 'success';
    let alertText = 'Bottleneck sinyali yok.';
    if (dropRate !== null && dropRate > dropRateDangerPct) {
        alertClass = 'danger';
        alertText = `Kritik drop-rate: %${dropRate.toFixed(2)} • pipeline tıkanması olabilir.`;
    } else if (deltaErrors >= errorWarningDelta || (dropRate !== null && dropRate > dropRateWarningPct)) {
        alertClass = 'warning';
        alertText = `Uyarı: hata artışı (${deltaErrors}) veya drop-rate yükseliyor.`;
    }

    const latencyText = measuredLatency !== null
        ? `${measuredLatency.toFixed(3)} sn${measuredLatencyStatus === 'success' ? ' (ölçüm)' : ' (probe timeout)'}`
        : (latencyEstimate === null ? '-' : `${latencyEstimate.toFixed(1)} sn (tahmini)`);

    return {
        epsText: `${eps.toFixed(1)} eps`,
        dropRateText: dropRate === null ? '-' : `%${dropRate.toFixed(2)}`,
        latencyText,
        trendText: `In:+${deltaInput} Out:+${deltaOutput ?? '-'} Err:+${deltaErrors}`,
        alertClass,
        alertText
    };
}

async function loadOverviewAuditSummary() {
    if (!hasAtLeastRole('operator')) {
        return;
    }
    try {
        const data = await apiRequest('/api/audit/events?limit=250');
        latestAuditEvents = data.events || [];
        markDataFreshness('audit');
    } catch (error) {
        if (!/role required/i.test(error.message || '')) {
            console.error('Overview audit summary error:', error);
        }
    }
}

async function loadSettingsSnapshotForOverview(force = false) {
    const now = Date.now();
    if (!force && guidedSettings.length > 0 && now - lastSettingsOverviewFetch < 120000) {
        return;
    }

    try {
        const data = await apiRequest('/api/settings/catalog');
        settingsWritable = data.settingsWritable !== false;
        settingsAutoApplyAvailable = data.settingsAutoApplyAvailable === true;
        settingsWriteMessage = data.settingsWriteMessage || '';
        if (Array.isArray(data.settings)) {
            guidedSettings = data.settings;
        }
        renderSettingsRuntimeStatus();
        renderSettingsOpsSnapshot();
        lastSettingsOverviewFetch = now;
        markDataFreshness('settings');
    } catch (error) {
        if (!/role required/i.test(error.message || '')) {
            console.error('Overview settings snapshot error:', error);
        }
    }
}

function renderOverviewPipelineKpis() {
    const epsEl = document.getElementById('overview-slo-eps');
    const dropEl = document.getElementById('overview-slo-drop-rate');
    const latencyEl = document.getElementById('overview-slo-latency');
    const bottleneckEl = document.getElementById('overview-slo-bottleneck');
    const freshnessEl = document.getElementById('overview-slo-freshness');
    if (!epsEl || !dropEl || !latencyEl || !bottleneckEl || !freshnessEl) return;

    epsEl.textContent = overviewSloSnapshot.epsText || '-';
    dropEl.textContent = overviewSloSnapshot.dropRateText || '-';
    latencyEl.textContent = overviewSloSnapshot.latencyText || '-';
    bottleneckEl.textContent = overviewSloSnapshot.bottleneckText || '-';
    bottleneckEl.className = `value ${overviewSloSnapshot.bottleneckClass || ''}`;
    freshnessEl.textContent = overviewSloSnapshot.freshnessText || '-';
}

async function loadOverviewPipelineKpis() {
    if (!hasAtLeastRole('operator')) {
        overviewSloSnapshot = {
            epsText: '-',
            dropRateText: '-',
            latencyText: '-',
            bottleneckText: '—',
            bottleneckClass: 'status-unknown',
            freshnessText: 'Pipeline özeti için operator girişi gerekir (yetki eksikliği darboğaz değildir).'
        };
        renderOverviewPipelineKpis();
        return;
    }

    try {
        const data = await apiRequest('/api/pipeline/status');
        pipelineHealthState = data;
        updatePipelineTrendHistory(data);
        const kpi = calculatePipelineKpis();

        let bottleneckText;
        let bottleneckClass;
        if (kpi.alertClass === 'danger') {
            bottleneckText = 'Kritik';
            bottleneckClass = 'status-danger';
        } else if (kpi.alertClass === 'warning') {
            bottleneckText = 'Uyarı';
            bottleneckClass = 'status-warning';
        } else if (kpi.alertClass === 'info') {
            bottleneckText = 'Henüz ölçülemedi';
            bottleneckClass = 'status-unknown';
        } else {
            bottleneckText = 'Yok';
            bottleneckClass = 'status-success';
        }

        overviewSloSnapshot = {
            epsText: kpi.epsText,
            dropRateText: kpi.dropRateText,
            latencyText: kpi.latencyText,
            bottleneckText,
            bottleneckClass,
            freshnessText: `${formatRelativeTime(new Date().toISOString())} • ${kpi.trendText}`
        };
        markDataFreshness('pipeline');
    } catch (error) {
        overviewSloSnapshot = {
            epsText: '-',
            dropRateText: '-',
            latencyText: '-',
            bottleneckText: 'Veri Yok',
            bottleneckClass: 'status-warning',
            freshnessText: `alınamadı: ${error.message}`
        };
    }

    renderOverviewPipelineKpis();
}

function renderOverviewOperationalIntelligence() {
    const totalEl = document.getElementById('overview-audit-total');
    const failedEl = document.getElementById('overview-audit-failed');
    const failureEl = document.getElementById('overview-last-failure');
    const backupEl = document.getElementById('overview-last-backup');
    const validationEl = document.getElementById('overview-last-validation');
    const restartEl = document.getElementById('overview-last-restart');
    if (!totalEl || !failedEl || !failureEl || !backupEl || !validationEl || !restartEl) return;

    const audit = latestAuditEvents || [];
    const failed = audit.filter(event => event.status === 'failed');
    const lastFailed = failed[0];
    const lastBackupEvent = audit.find(event => event.action === 'backup.create');

    totalEl.textContent = String(audit.length);
    failedEl.textContent = String(failed.length);
    failureEl.textContent = lastFailed
        ? `${lastFailed.action || 'bilinmeyen'} • ${formatRelativeTime(lastFailed.timestamp)}`
        : 'Yok';

    backupEl.textContent = overviewActionStatus.backup
        ? formatActionSnapshot(overviewActionStatus.backup)
        : (lastBackupEvent ? `${lastBackupEvent.status} • ${formatRelativeTime(lastBackupEvent.timestamp)}` : '-');

    validationEl.textContent = formatActionSnapshot(overviewActionStatus.validation);
    restartEl.textContent = formatActionSnapshot(overviewActionStatus.restartAll);
}

function renderOverviewCriticalEvents() {
    const container = document.getElementById('overview-critical-events');
    if (!container) return;

    const criticalActions = new Set([
        'service.control',
        'service.scale',
        'backup.create',
        'config.update',
        'settings.update',
        'hpa.update',
        'rollout.restart',
        'rollout.rollback'
    ]);

    const items = (latestAuditEvents || [])
        .filter(event => event.status === 'failed' || criticalActions.has(event.action))
        .slice(0, 8);

    if (!items.length) {
        container.innerHTML = '<p class="loading">Kritik operasyon olayı bulunamadı.</p>';
        return;
    }

    container.innerHTML = items.map(item => {
        const badgeClass = item.status === 'success' ? 'status-success' : 'status-danger';
        const actor = `${item.user || 'anonymous'} (${item.role || '-'})`;
        return `
            <div class="overview-event-item">
                <div class="overview-event-main">
                    <div class="overview-event-title">${item.action || 'event'}</div>
                    <div class="overview-event-meta">${formatRelativeTime(item.timestamp)} • ${actor}</div>
                </div>
                <span class="status-badge ${badgeClass}">${(item.status || 'unknown').toUpperCase()}</span>
            </div>
        `;
    }).join('');
}

function renderOverviewFreshness() {
    const container = document.getElementById('overview-freshness-list');
    if (!container) return;

    const rows = [
        { label: 'Platform bilgisi', key: 'platform' },
        { label: 'Sistem sağlığı', key: 'health' },
        { label: 'Servis durumu', key: 'services' },
        { label: 'Yapılandırma listesi', key: 'config' },
        { label: 'Ayar kataloğu', key: 'settings' },
        { label: 'Pipeline / Fluent Bit', key: 'pipeline' },
        { label: 'Audit özeti', key: 'audit' },
        { label: 'İzleme metrikleri', key: 'monitoring' },
        { label: 'Log görünümü', key: 'logs' }
    ];

    const freshnessRows = rows.map(row => {
        const freshness = getFreshnessStatus(dataFreshness[row.key]);
        return `
            <div class="overview-freshness-item">
                <div>
                    <div class="overview-freshness-label">${row.label}</div>
                    <div class="overview-freshness-value">${freshness.relative}</div>
                </div>
                <span class="status-badge status-${freshness.level === 'unknown' ? 'unknown' : freshness.level}">${freshness.label}</span>
            </div>
        `;
    });

    freshnessRows.push(`
        <div class="overview-freshness-item">
            <div>
                <div class="overview-freshness-label">Platform modu</div>
                <div class="overview-freshness-value">${platformInfo.platform || 'unknown'} • namespace: ${platformInfo.namespace || '-'}</div>
            </div>
            <span class="status-badge status-info">Kapsam</span>
        </div>
    `);

    freshnessRows.push(`
        <div class="overview-freshness-item">
            <div>
                <div class="overview-freshness-label">Ayar yazılabilirliği</div>
                <div class="overview-freshness-value">${settingsWritable ? 'Ayar kayıtları aktif' : (settingsWriteMessage || 'Salt-okunur ortam')}</div>
            </div>
            <span class="status-badge ${canPersistSettings() ? 'status-success' : 'status-danger'}">${settingsWritable ? 'Yazılabilir' : (settingsAutoApplyAvailable ? 'Auto-Apply' : 'Salt-okunur')}</span>
        </div>
    `);

    container.innerHTML = freshnessRows.join('');
}

async function loadOverviewIntelligence(force = false) {
    const now = Date.now();
    if (!force && now - lastOverviewIntelligenceFetch < 25000) {
        renderOverviewOperationalIntelligence();
        renderOverviewCriticalEvents();
        renderOverviewPipelineKpis();
        renderOverviewFreshness();
        return;
    }

    lastOverviewIntelligenceFetch = now;
    await Promise.allSettled([
        loadOverviewAuditSummary(),
        loadSettingsSnapshotForOverview(force),
        loadOverviewPipelineKpis()
    ]);

    renderOverviewOperationalIntelligence();
    renderOverviewCriticalEvents();
    renderOverviewPipelineKpis();
    renderOverviewFreshness();
    updateCriticalOverview();
}

function hideStartupSplash() {
    const splash = document.getElementById('startup-splash');
    if (!splash || splash.classList.contains('hidden')) return;

    splash.classList.add('hidden');
    setTimeout(() => {
        if (splash.parentNode) {
            splash.parentNode.removeChild(splash);
        }
    }, 550);
}

async function loadPlatformInfo() {
    try {
        const data = await apiRequest('/api/platform');
        if (data && !data.error) {
            platformInfo = data;
            const badge = document.getElementById('platform-badge');
            if (badge) {
                badge.textContent = `Platform: ${data.platform || 'unknown'} (${data.namespace || '-'})`;
            }
            applyPlatformSpecificVisibility();
            markDataFreshness('platform');
            if (services && Object.keys(services).length) {
                updateServicesTable();
            }
        }
    } catch (error) {
        console.error('Error loading platform info:', error);
    }
}

async function loadSystemHealth() {
    try {
        const data = await apiRequest('/api/health');
        latestHealth = data;
        const detectedServices = Object.keys(services || {}).length;
        const runningCount = Number.isFinite(data.services_running)
            ? data.services_running
            : (data.services_count || 0);
        const totalServices = Number.isFinite(data.services_total)
            ? data.services_total
            : (detectedServices > 0 ? detectedServices : Math.max(data.services_count || 0, 1));
        const problemCount = Number.isFinite(data.services_problematic)
            ? data.services_problematic
            : Math.max(0, totalServices - runningCount);

        // Update docker status
        const dockerStatus = document.getElementById('docker-status');
        const dockerHealthy = typeof data.docker === 'string' && data.docker.startsWith('healthy');
        if (dockerHealthy) {
            dockerStatus.textContent = 'Sağlıklı';
            dockerStatus.className = 'status-badge status-success';
        } else {
            dockerStatus.textContent = 'Sorunlu';
            dockerStatus.className = 'status-badge status-danger';
        }

        // Update services count
        document.getElementById('services-count').textContent = `${runningCount}/${totalServices || '-'}`;

        // Zorunlu: docker-compose + .env (API config_healthy). Eski panel: tüm config_paths.
        const configPaths = data.config_paths || {};
        const configOk = typeof data.config_healthy === 'boolean'
            ? data.config_healthy
            : (Object.keys(configPaths).length > 0 && Object.values(configPaths).every(s => s === 'exists'));
        const configStatus = document.getElementById('config-status');
        const optionalMissing = typeof data.config_healthy === 'boolean' && data.config_healthy === true
            && Object.values(configPaths).some(s => s !== 'exists');
        configStatus.textContent = configOk ? 'Tamam' : 'Eksik';
        configStatus.className = configOk ? 'status-badge status-success' : 'status-badge status-danger';
        if (optionalMissing) {
            configStatus.title = 'Zorunlu dosyalar tamam; bazi istege bagli klasorler (fluent-bit, grafana_config, certs) eksik olabilir.';
        } else {
            configStatus.title = '';
        }

        const ingest = data.ingest_pipeline || {};
        const ingestOverall = typeof ingest.overall === 'string' ? ingest.overall : '';
        const ingestOk = ingestOverall === 'ok';

        const healthPanel = document.getElementById('system-health');
        if (healthPanel) {
            let level = dockerHealthy && configOk && problemCount === 0 ? 'İyi' : (problemCount <= 2 ? 'Uyarı' : 'Kritik');
            if (ingestOverall === 'down') {
                level = 'Kritik';
            } else if (ingestOverall === 'degraded' && level === 'İyi') {
                level = 'Uyarı';
            }
            const levelClass = level === 'İyi' ? 'status-success' : (level === 'Uyarı' ? 'status-warning' : 'status-danger');
            const ingestLine = ingestOverall
                ? ` • Log hattı: <strong>${ingestOverall === 'ok' ? 'Tamam' : ingestOverall === 'degraded' ? 'Kısmi sorun' : 'Kritik'}</strong>`
                : '';
            healthPanel.innerHTML = `
                <div class="status-badge ${levelClass}" style="font-size:0.95rem; padding:0.42rem 0.9rem;">Sistem Seviyesi: ${level}</div>
                <div style="margin-top:0.75rem; font-size:0.85rem; color:var(--muted-text, #6b7280);">
                    Çalışan: <strong>${runningCount}</strong> • Sorunlu/Duran: <strong>${problemCount}</strong>${ingestLine}
                </div>
            `;
        }

        // Kenar çubuğu: yalnizca Docker + zorunlu config + gercek sorun yoksa «Calisiyor»
        const statusIndicator = document.getElementById('system-status');
        if (configOk && runningCount > 0 && dockerHealthy && problemCount === 0 && ingestOk) {
            statusIndicator.innerHTML = '<span class="pulse"></span><span>Çalışıyor</span>';
            statusIndicator.style.color = '#10b981';
        } else {
            statusIndicator.innerHTML = '<span class="pulse"></span><span>Dikkat Gerekli</span>';
            statusIndicator.style.color = '#f59e0b';
        }

        console.log('System health:', data);
        markDataFreshness('health');
        updateCriticalOverview();
    } catch (error) {
        console.error('Error loading system health:', error);
    }
}

async function loadServices() {
    try {
        services = await apiRequest('/api/services');

        if (services.error) {
            showAlert('Servisler yüklenemedi: ' + services.error, 'danger');
            return;
        }

        updateServicesList();
        updateServicesTable();
        updateStats();
        markDataFreshness('services');
        renderServicesCommandCenter();
        renderSettingsOpsSnapshot();
        updateCriticalOverview();
        loadServiceStorage().catch(() => {});
    } catch (error) {
        console.error('Error loading services:', error);
    }
}

function formatStorageBytes(n) {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i += 1;
    }
    if (i === 0) return `${Math.round(v)} ${u[i]}`;
    const dec = v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(dec)} ${u[i]}`;
}

function titleEscapePaths(paths) {
    if (!paths || !paths.length) return '';
    return paths
        .join(' | ')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function renderServicesStorageSharedSummary() {
    const el = document.getElementById('services-storage-shared-summary');
    if (!el) return;
    if (platformInfo.platform === 'k8s') {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    const list = Array.isArray(serviceStorageSharedFs) ? serviceStorageSharedFs : [];
    if (!list.length) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = 'block';
    const lines = list.map((fs) => {
        const pct = fs.totalBytes > 0 ? Math.round((100 * fs.usedBytes) / fs.totalBytes) : 0;
        const mp = escapeHtml(fs.mountPoint || '—');
        const dev = escapeHtml(fs.device || '—');
        return `${dev} <span class="help-text">@ ${mp}</span> — ${formatStorageBytes(fs.totalBytes)} toplam, boş ${formatStorageBytes(fs.availBytes)}, ~%${pct} dolu <span class="help-text">(tüm FS)</span>`;
    });
    el.innerHTML = `<div style="line-height:1.5;font-size:0.88rem;"><strong>Paylaşılan bölümler</strong> <span class="help-text">(her aygıt bir kez; servisler ortak havuz kullanır)</span>:<br>${lines.join('<br>')}</div>`;
}

async function loadServiceStorage() {
    const hint = document.getElementById('services-storage-hint');
    if (platformInfo.platform === 'k8s') {
        serviceStorageByContainer = {};
        serviceStorageSharedFs = [];
        if (hint) hint.style.display = 'none';
        renderServicesStorageSharedSummary();
        updateServicesTable();
        return;
    }
    if (hint) hint.style.display = '';
    try {
        const data = await apiRequest('/api/services/storage');
        if (data && data.ok && data.byContainer) {
            serviceStorageByContainer = data.byContainer;
            serviceStorageSharedFs = Array.isArray(data.sharedFilesystems) ? data.sharedFilesystems : [];
        } else {
            serviceStorageByContainer = {};
            serviceStorageSharedFs = [];
        }
        renderServicesStorageSharedSummary();
        updateServicesTable();
    } catch (e) {
        serviceStorageByContainer = {};
        serviceStorageSharedFs = [];
        renderServicesStorageSharedSummary();
        updateServicesTable();
    }
}

/** Kasitli durdurulan / sorun sayilmayacak servis (compose: com.log-system.health.ignore: "true"). */
function isHealthIgnoredService(name, info = {}) {
    if (CONTAINERS_IGNORE_FOR_HEALTH.has(name)) return true;
    if (name && name.includes('log-system-setup') && name !== 'log-system-setup') return true;
    if (looksLikeDockerAdhocRandomName(name)) return true;
    const labels = info.labels || {};
    const v = String(labels['com.log-system.health.ignore'] || labels['log_system.health.ignore'] || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isServiceProblematic(name, info) {
    if (info === undefined) {
        info = name;
        name = '';
    }
    if (typeof dashboardUtils.isServiceProblematic === 'function') {
        return dashboardUtils.isServiceProblematic(name, info);
    }
    if (isHealthIgnoredService(name, info)) return false;
    const status = (info?.status || '').toLowerCase();
    const health = (info?.health || '').toLowerCase();
    return (
        status === 'exited'
        || status === 'stopped'
        || status === 'degraded'
        || status === 'created'
        || status === 'paused'
        || health === 'unhealthy'
    );
}

function getFilteredServiceEntries() {
    const query = (document.getElementById('service-filter')?.value || '').toLowerCase().trim();
    return Object.entries(services || {}).filter(([name, info]) => {
        if (servicesProblematicOnly && !isServiceProblematic(name, info)) {
            return false;
        }
        if (!query) {
            return true;
        }

        const haystack = [
            name,
            info?.status || '',
            info?.health || '',
            info?.image || '',
            info?.kind || ''
        ].join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function getServiceIssueReason(info = {}) {
    if (typeof dashboardUtils.getServiceIssueReason === 'function') {
        return dashboardUtils.getServiceIssueReason(info);
    }
    if (info.composeReplaceNameMismatch) {
        return 'Compose replace sonrası geçici konteyner adı; DNS için düzeltin: bash src/scripts/ops/reconcile-compose-canonical-names.sh';
    }
    const status = (info.status || '').toLowerCase();
    const health = (info.health || '').toLowerCase();

    if (health === 'unhealthy') {
        return 'Healthcheck başarısız (unhealthy)';
    }
    if (status === 'created') {
        return 'Konteyner oluşturuldu, başlatılmadı (created) — Başlat veya compose ile düzeltin';
    }
    if (status === 'paused') {
        return 'Konteyner duraklatılmış (paused)';
    }
    if (status === 'exited' || status === 'stopped') {
        return 'Servis durmuş durumda';
    }
    if (status === 'degraded') {
        return `Kısmi hazır (${info.health || 'degraded'})`;
    }
    if (health && health !== 'healthy' && health !== 'n/a' && health !== 'none') {
        return `Health: ${info.health}`;
    }
    return 'Sorun tespit edilmedi';
}

/** Hostname for service UI links (Graylog, NPM, …). Not 127.0.0.1 when panel is opened via LAN/DNS. */
function getServiceInterfaceBaseHost() {
    const fromApi = platformInfo && typeof platformInfo.serviceLinkHost === 'string' && platformInfo.serviceLinkHost.trim();
    if (fromApi) return fromApi.trim();
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
        return window.location.hostname;
    }
    return '127.0.0.1';
}

function formatHostForHttpUrl(host) {
    if (typeof dashboardUtils.formatHostForHttpUrl === 'function') {
        return dashboardUtils.formatHostForHttpUrl(host);
    }
    const h = String(host || '').trim();
    if (!h) return '127.0.0.1';
    if (h.includes(':') && !h.startsWith('[')) {
        return `[${h}]`;
    }
    return h;
}

function parsePublishedTcpPorts(ports) {
    if (typeof dashboardUtils.parsePublishedTcpPorts === 'function') {
        return dashboardUtils.parsePublishedTcpPorts(ports);
    }
    if (!ports || typeof ports !== 'object' || Array.isArray(ports)) return [];

    const published = [];
    Object.entries(ports).forEach(([containerPortProto, bindings]) => {
        if (!containerPortProto || !String(containerPortProto).endsWith('/tcp')) return;
        const containerPort = parseInt(String(containerPortProto).split('/')[0], 10);
        if (!Array.isArray(bindings)) return;

        bindings.forEach(binding => {
            const hostPortRaw = binding?.HostPort;
            const hostPort = parseInt(hostPortRaw, 10);
            if (!Number.isInteger(hostPort) || hostPort <= 0) return;
            published.push({ containerPort, hostPort });
        });
    });

    return published;
}

function getServiceInterfaceLinks(serviceName, info = {}) {
    const baseHost = getServiceInterfaceBaseHost();
    if (typeof dashboardUtils.getServiceInterfaceLinks === 'function') {
        return dashboardUtils.getServiceInterfaceLinks(serviceName, info, baseHost);
    }
    const name = (serviceName || '').toLowerCase();
    const publishedTcp = parsePublishedTcpPorts(info.ports);
    if (!publishedTcp.length) return [];

    const hostPart = formatHostForHttpUrl(baseHost);

    const labelFor = (containerPort) => {
        if (name.includes('graylog')) return 'Graylog UI';
        if (name.includes('log-management-ui')) return 'Dashboard';
        if (name.includes('nginx-proxy-manager')) {
            if (containerPort === 81) return 'NPM Admin';
            return 'NPM';
        }
        if (name.includes('minio')) {
            if (containerPort === 9001) return 'MinIO Console';
            if (containerPort === 9000) return 'MinIO API';
        }
        if (name.includes('fluent-bit') && containerPort === 2020) return 'Fluent Metrics';
        if (name.includes('signing-engine')) return 'Signing API';
        return 'Arayüz';
    };

    const links = publishedTcp.map(item => ({
        url: `http://${hostPart}:${item.hostPort}`,
        label: labelFor(item.containerPort),
        hostPort: item.hostPort,
        containerPort: item.containerPort
    }));

    const deduped = [];
    const seen = new Set();
    links.forEach(link => {
        if (seen.has(link.url)) return;
        seen.add(link.url);
        deduped.push(link);
    });

    return deduped;
}

function openServiceInterface(url) {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
}

function renderServicesCommandCenter() {
    const totalEl = document.getElementById('services-kpi-total');
    const runningEl = document.getElementById('services-kpi-running');
    const problematicEl = document.getElementById('services-kpi-problematic');
    const platformEl = document.getElementById('services-kpi-platform');
    const summaryEl = document.getElementById('services-bulk-summary');
    const toggleBtn = document.getElementById('services-problematic-toggle');
    if (!totalEl || !runningEl || !problematicEl || !platformEl || !summaryEl) return;

    const entries = Object.entries(services || {});
    const coreEntries = entries.filter(([n]) => isCoreService(n));
    const runningCount = coreEntries.filter(([_, info]) => (info.status || '').toLowerCase() === 'running').length;
    const problematicEntries = coreEntries.filter(([n, info]) => isServiceProblematic(n, info));

    totalEl.textContent = String(coreEntries.length);
    runningEl.textContent = String(runningCount);
    problematicEl.textContent = `${problematicEntries.length}${servicesProblematicOnly ? ' (filtre aktif)' : ''}`;
    platformEl.textContent = `${platformInfo.platform || 'unknown'} / ${platformInfo.namespace || '-'}`;

    if (toggleBtn) {
        toggleBtn.className = servicesProblematicOnly ? 'btn btn-sm btn-warning' : 'btn btn-sm btn-secondary';
        toggleBtn.innerHTML = servicesProblematicOnly
            ? '<i class="fas fa-filter"></i> Sorunlu Filtre Aktif'
            : '<i class="fas fa-triangle-exclamation"></i> Sadece Sorunlular';
    }

    const filteredCount = getFilteredServiceEntries().length;
    const freshness = getFreshnessStatus(dataFreshness.services);
    const summarySource = serviceActionStatus.bulk || serviceActionStatus.lastSingle || serviceActionStatus.lastScale;
    const scaleNote = platformInfo.platform === 'k8s'
        ? 'K8s modunda ölçekleme (HPA/replica) aktif.'
        : 'Compose modunda otomatik yatay ölçekleme yok; servisler kendi kendine scale etmez.';
    const summaryText = summarySource
        ? `${summarySource.message} • ${formatRelativeTime(summarySource.timestamp)}`
        : `Filtrelenen servis: ${filteredCount} / ${coreEntries.length} • ${scaleNote}`;
    const summaryLevel = summarySource
        ? (summarySource.status === 'success' ? 'success' : summarySource.status === 'warning' ? 'warning' : 'danger')
        : (problematicEntries.length > 0 ? 'warning' : 'info');

    summaryEl.innerHTML = `
        <span>${summaryText}</span>
        <span class="status-badge status-${summaryLevel}">${freshness.label} • ${freshness.relative}</span>
    `;
}

function toggleServicesProblematicOnly() {
    servicesProblematicOnly = !servicesProblematicOnly;
    updateServicesTable();
    renderServicesCommandCenter();
}

function resetServicesFilters() {
    const input = document.getElementById('service-filter');
    if (input) {
        input.value = '';
    }
    servicesProblematicOnly = false;
    updateServicesTable();
    renderServicesCommandCenter();
}

function updateServicesList() {
    const list = document.getElementById('active-services-list');
    const running = Object.entries(services).filter(([_, info]) => info.status === 'running');

    if (running.length === 0) {
        list.innerHTML = '<p class="loading">Çalışan servis yok</p>';
        return;
    }

    let html = running.slice(0, 5).map(([name, info]) => `
        <div class="service-item">
            <span class="service-item-name"><i class="fas fa-circle" style="color: #10b981; margin-right: 0.5rem;"></i>${name}</span>
            <span class="status-badge status-success">${info.status}</span>
        </div>
    `).join('');

    if (running.length > 5) {
        html += `<p style="text-align: center; color: #6b7280; font-size: 0.9rem; margin-top: 0.5rem;">+${running.length - 5} daha</p>`;
    }

    list.innerHTML = html;
}

function updateServicesTable() {
    const table = document.getElementById('services-table');
    const filteredEntries = getFilteredServiceEntries();
    const canOperate = hasAtLeastRole('operator');
    const isK8s = platformInfo.platform === 'k8s';
    const showDiskCol = !isK8s;

    if (!filteredEntries.length) {
        const query = (document.getElementById('service-filter')?.value || '').trim();
        const reason = servicesProblematicOnly || query
            ? 'Filtreye uygun servis bulunamadı.'
            : 'Servis bulunamadı.';
        table.innerHTML = `<p class="loading">${reason}</p>`;
        return;
    }
    
    let html = `
        <table class="services-grid-table">
            <thead>
                <tr>
                    <th class="col-service">Adı</th>
                    <th class="col-status">Durum</th>
                    <th class="col-health">Sağlık</th>
                    ${showDiskCol ? '<th class="col-disk">Veri (bind)</th>' : ''}
                    <th class="col-issue">Son Sorun Notu</th>
                    ${isK8s ? '<th class="col-scale">Ölçek</th>' : ''}
                    <th class="col-actions">İşlemler</th>
                </tr>
            </thead>
            <tbody>
    `;

    filteredEntries.forEach(([name, info]) => {
        const statusColor = info.status === 'running'
            ? 'status-success'
            : (info.status === 'exited' ? 'status-danger' : (info.status === 'created' || info.status === 'paused' ? 'status-danger' : 'status-warning'));
        
        const healthColor = info.health === 'healthy' ? 'status-success' : 
                           info.health === 'unhealthy' ? 'status-danger' : 'status-unknown';
        const canScale = isK8s && canOperate;
        const replicas = Number.isInteger(info.replicas) ? info.replicas : 1;
        const issueReason = getServiceIssueReason(info);
        const interfaceLinks = getServiceInterfaceLinks(name, info);
        const displayLabel = info.displayName || info.composeService || name;
        const serviceNameCell = displayLabel !== name
            ? `<strong>${escapeHtml(displayLabel)}</strong><div class="help-text" style="font-size:0.78rem;">Docker adı: <code>${escapeHtml(name)}</code></div>`
            : `<strong>${escapeHtml(name)}</strong>`;

        const actionButtons = [
            `<button class="btn btn-sm btn-info" onclick="controlService('${name}', 'restart')" ${canOperate ? '' : 'disabled'} title="Yeniden başlat"><i class="fas fa-sync"></i></button>`
        ];

        interfaceLinks.slice(0, 2).forEach(link => {
            actionButtons.push(`<button class="btn btn-sm btn-secondary" onclick="openServiceInterface('${link.url}')" title="${link.label} (${link.hostPort})"><i class="fas fa-arrow-up-right-from-square"></i></button>`);
        });

        if (!interfaceLinks.length) {
            actionButtons.push('<button class="btn btn-sm btn-secondary" disabled title="Bu servis için yayınlanmış arayüz portu yok"><i class="fas fa-link-slash"></i></button>');
        }

        const st = serviceStorageByContainer[name] || {};
        const bindPaths = st.bindPaths || [];
        const diskBytes = typeof st.dataBytes === 'number' ? st.dataBytes : null;
        const diskTitle = titleEscapePaths(bindPaths);
        let diskInner = '—';
        if (bindPaths.length === 0 && diskBytes === null) {
            diskInner = '—';
        } else if (bindPaths.length === 0) {
            diskInner = '<span class="help-text">Bind yok</span>';
        } else if (diskBytes !== null) {
            diskInner = formatStorageBytes(diskBytes);
        }
        const diskCell = showDiskCol
            ? `<td class="col-disk" title="${diskTitle}">${diskInner}</td>`
            : '';

        html += `
            <tr>
                <td class="col-service">${serviceNameCell}</td>
                <td class="col-status"><span class="status-badge ${statusColor}">${info.status}</span></td>
                <td class="col-health"><span class="status-badge ${healthColor}">${info.health || 'N/A'}</span></td>
                ${diskCell}
                <td class="col-issue">${issueReason}</td>
                ${isK8s ? `
                <td class="col-scale">
                    <div class="services-scale-box">
                        <input id="scale-${name}" type="number" min="0" value="${replicas}" class="services-scale-input" ${canScale ? '' : 'disabled'}>
                        <button class="btn btn-sm btn-secondary" onclick="scaleService('${name}')" ${canScale ? '' : 'disabled'} title="Replica güncelle">
                            <i class="fas fa-up-right-and-down-left-from-center"></i>
                        </button>
                    </div>
                </td>
                ` : ''}
                <td class="col-actions">
                    <div class="services-action-buttons">
                        ${actionButtons.join('')}
                    </div>
                    ${interfaceLinks.length ? `<div class="services-link-note">${interfaceLinks.slice(0, 2).map(link => `${link.label}: ${link.hostPort}`).join(' • ')}</div>` : '<div class="services-link-note">Arayüz portu yayınlanmamış</div>'}
                </td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    table.innerHTML = html;
}

function updateStats() {
    const coreEntries = Object.entries(services || {}).filter(([n]) => isCoreService(n));
    const running = coreEntries.filter(([, s]) => s.status === 'running').length;
    const stopped = coreEntries.filter(([n, s]) => !isHealthIgnoredService(n, s) && (s.status === 'exited' || s.status === 'stopped' || s.status === 'created' || s.status === 'paused')).length;
    const unhealthy = coreEntries.filter(([n, s]) => !isHealthIgnoredService(n, s) && s.health === 'unhealthy').length;
    const total = coreEntries.length;

    document.getElementById('running-count').textContent = running;
    document.getElementById('stopped-count').textContent = stopped;
    document.getElementById('unhealthy-count').textContent = unhealthy;
    document.getElementById('total-count').textContent = total;
}

function updateCriticalOverview() {
    const list = document.getElementById('critical-overview-list');
    if (!list) return;

    const entries = [];

    const dockerHealthy = typeof latestHealth?.docker === 'string' && latestHealth.docker.startsWith('healthy');
    const coreEntriesOv = Object.entries(services || {}).filter(([n]) => isCoreService(n));
    const running = coreEntriesOv.filter(([, item]) => item.status === 'running').length;
    const total = coreEntriesOv.length;
    const unhealthyServices = Object.entries(services || {})
        .filter(([name, info]) => isCoreService(name) && !isHealthIgnoredService(name, info)
            && (info.health === 'unhealthy' || info.status === 'exited' || info.status === 'stopped' || info.status === 'degraded' || info.status === 'created' || info.status === 'paused'))
        .map(([name]) => name);

    entries.push({
        title: 'Platform',
        value: `${platformInfo.platform || 'unknown'} • Namespace: ${platformInfo.namespace || '-'}`,
        level: 'info',
        action: 'Ayarlar sekmesi',
        tab: 'settings'
    });

    entries.push({
        title: 'Sistem Sağlığı',
        value: `${dockerHealthy ? 'Docker sağlıklı' : 'Docker sorunu var'} • Çalışan servis: ${running}/${total || 0}`,
        level: dockerHealthy && unhealthyServices.length === 0 ? 'success' : 'warning',
        action: 'Servisler sekmesi',
        tab: 'services'
    });

    entries.push({
        title: 'Servis Uyarıları',
        value: unhealthyServices.length
            ? `Sorunlu/duran: ${unhealthyServices.slice(0, 3).join(', ')}${unhealthyServices.length > 3 ? ` (+${unhealthyServices.length - 3})` : ''}`
            : 'Tüm servisler sağlıklı durumda',
        level: unhealthyServices.length ? 'danger' : 'success',
        action: 'Servisleri aç',
        tab: 'services'
    });

    const ip = latestHealth?.ingest_pipeline;
    if (ip && typeof ip === 'object') {
        const ov = typeof ip.overall === 'string' ? ip.overall : 'unknown';
        const fb = ip.fluentBit || {};
        const gl = ip.graylog || {};
        let value = '';
        if (ov === 'ok') {
            value = 'Fluent Bit konteyneri çalışıyor, HTTP 2020 yanıtlı, Graylog API erişilebilir (ajan UDP 5151 → merkez).';
        } else if (ov === 'degraded') {
            const parts = [
                `FB: ${fb.containerRunning ? 'çalışıyor' : 'çalışmıyor'}`,
                fb.httpOk ? 'HTTP ok' : 'HTTP sorun',
                gl.apiOk ? 'Graylog API ok' : 'Graylog API sorun',
            ];
            value = `${parts.join(' • ')}${fb.detail ? ` — ${fb.detail}` : ''}${gl.detail ? ` — ${gl.detail}` : ''}`;
        } else {
            value = ip.error
                ? String(ip.error)
                : `Durum: ${ov}. fluent-bit ve graylog servislerini kontrol edin.${fb.detail ? ` (${fb.detail})` : ''}`;
        }
        entries.push({
            title: 'Log toplama hattı (UDP → Fluent Bit → Graylog)',
            value,
            level: ov === 'ok' ? 'success' : (ov === 'degraded' ? 'warning' : 'danger'),
            action: 'Servisler sekmesi',
            tab: 'services'
        });
    }

    const highRiskSettings = (guidedSettings || []).filter(item => item.riskLevel === 'high').length;
    entries.push({
        title: 'Ayarlar',
        value: canPersistSettings()
            ? `${highRiskSettings} yüksek riskli ayar tanımı var${!settingsWritable ? ' • Otomatik uygulama aktif' : ''}`
            : (settingsWriteMessage || 'Ayar kayıtları geçici olarak salt-okunur durumda'),
        level: canPersistSettings() ? (highRiskSettings > 0 ? 'warning' : 'info') : 'danger',
        action: 'Ayarları yönet',
        tab: 'settings'
    });

    const opsSnapshot = latestSettingsOpsSnapshot || computeSettingsOpsSnapshot();
    entries.push({
        title: 'Alerting Zinciri',
        value: `Telegram ${opsSnapshot.telegramConfigured ? 'hazır' : 'eksik'} • alert-webhook ${opsSnapshot.webhookRunning ? 'up' : 'down'} • watchdog ${opsSnapshot.watchdogRunning ? 'up' : 'down'} • post-check ${opsSnapshot.postCheckStatus || 'bekleniyor'}`,
        level: opsSnapshot.level === 'success' ? 'success' : (opsSnapshot.level === 'danger' ? 'danger' : 'warning'),
        action: 'Ayarlar sekmesi',
        tab: 'settings'
    });

    entries.push({
        title: 'Yapılandırma Dosyaları',
        value: `${latestConfigFiles.length || 0} dosya algılandı. Kritik dosyalar: ${(latestConfigFiles || []).slice(0, 2).join(', ') || '-'}`,
        level: latestConfigFiles.length ? 'info' : 'warning',
        action: 'Yapılandırmayı aç',
        tab: 'config'
    });

    const failedAuditCount = (latestAuditEvents || []).filter(event => event.status === 'failed').length;
    const latestAudit = (latestAuditEvents || [])[0];
    entries.push({
        title: 'Audit Riski',
        value: latestAudit
            ? `Başarısız olay: ${failedAuditCount} • Son olay: ${latestAudit.action || '-'} (${formatRelativeTime(latestAudit.timestamp)})`
            : 'Audit özeti henüz alınmadı veya yetki bulunmuyor',
        level: failedAuditCount > 0 ? 'warning' : 'info',
        action: 'Logları aç',
        tab: 'logs'
    });

    const healthFreshness = getFreshnessStatus(dataFreshness.health);
    entries.push({
        title: 'Veri Tazeliği',
        value: `Sağlık: ${healthFreshness.label} (${healthFreshness.relative}) • Son servis güncellemesi: ${formatRelativeTime(dataFreshness.services)}`,
        level: healthFreshness.level === 'danger' ? 'danger' : (healthFreshness.level === 'warning' ? 'warning' : 'success'),
        action: 'İzleme sekmesi',
        tab: 'monitoring'
    });

    list.innerHTML = entries.map(item => `
        <div class="critical-item">
            <div>
                <div class="critical-title">${item.title}</div>
                <div class="critical-value">${item.value}</div>
            </div>
            <div style="display:flex; gap:0.5rem; align-items:center;">
                <span class="status-badge status-${item.level === 'success' ? 'success' : item.level === 'danger' ? 'danger' : item.level === 'warning' ? 'warning' : 'info'}">${item.level.toUpperCase()}</span>
                <button class="btn btn-sm btn-secondary" onclick="switchTab('${item.tab}')">${item.action}</button>
            </div>
        </div>
    `).join('');
}

async function loadStats() {
    // This would load stats from API
    // For now, we update from services data
    updateStats();
}

async function loadConfigFiles() {
    try {
        const data = await apiRequest('/api/config/config-files-list');
        latestConfigFiles = data.files || [];

        if (!data.files) {
            document.getElementById('config-file-list').innerHTML = '<p class="loading">Dosyalar yuklenemedi</p>';
            return;
        }

        let html = '';
        data.files.forEach(file => {
            html += `
                <div class="file-item" onclick="loadConfigFile('${file}')">
                    <i class="fas fa-file"></i> ${file}
                </div>
            `;
        });

        document.getElementById('config-file-list').innerHTML = html;

        const overview = document.getElementById('config-files-overview');
        if (overview) {
            const previewFiles = (data.files || []).slice(0, 8);
            overview.innerHTML = previewFiles.map(file => `
                <div class="overview-file-item" onclick="openConfigFromSettings('${file}')" style="cursor:pointer;">
                    <i class="fas fa-file-lines"></i>
                    <span>${file}</span>
                </div>
            `).join('') + (data.files.length > 8
                ? `<p style="grid-column:1/-1; text-align:center; color:var(--text-muted); margin-top:0.2rem;">+${data.files.length - 8} dosya daha</p>`
                : '');
        }
            markDataFreshness('config');
            renderSettingsOpsSnapshot();
        updateCriticalOverview();
    } catch (error) {
        console.error('Error loading config files:', error);
        showAlert('Dosyalar yuklenirken hata: ' + error.message, 'danger');
    }
}

async function loadConfigFile(file) {
    try {
        currentFile = file;
        const data = await apiRequest(`/api/config/${encodeURIComponent(file)}`);

        if (data.error) {
            showAlert('Dosya yuklenemedi: ' + data.error, 'danger');
            return;
        }

        if (data.content) {
            const editor = document.getElementById('config-editor');
            const placeholder = document.getElementById('editor-placeholder');
            const buttons = document.getElementById('editor-buttons');
            const help = document.getElementById('editor-help');

            editor.value = data.content;
            originalConfigContent[file] = data.content;
            editor.style.display = 'block';
            placeholder.style.display = 'none';
            buttons.style.display = 'flex';

            // Show help text based on file type
            let helpText = '';
            if (file.includes('.env')) {
                helpText = '💡 <strong>.env Dosyası:</strong> Sistem ortam değişkenlerini burada tanımlayın. <code>KEY=VALUE</code> formatında yazın.';
            } else if (file.includes('docker-compose')) {
                helpText = '💡 <strong>Docker Compose:</strong> Tüm servislerin tanımlandığı YAML dosyasıdır. Dikkatli düzenleyin!';
            } else if (file.includes('fluent-bit')) {
                helpText = '💡 <strong>Fluent Bit:</strong> Log toplama ve yönlendirme konfigürasyonu. Y-Model yapısını burada ayarlayabilirsiniz.';
            } else if (file.includes('grafana')) {
                helpText = '💡 <strong>Grafana:</strong> Veri kaynakları ve dashboard konfigürasyonu.';
            } else if (file.includes('graylog')) {
                helpText = '💡 <strong>Graylog:</strong> Log işleme hatları ve girişleri.';
            }

            if (helpText) {
                help.innerHTML = helpText;
                help.style.display = 'block';
            }

            showAlert(`Dosya açıldı: ${file}`, 'success');

            // Mark file as active
            document.querySelectorAll('.file-item').forEach(item => item.classList.remove('active'));
            const activeItem = document.querySelector(`.file-item[onclick="loadConfigFile('${file}')"]`);
            if (activeItem) {
                activeItem.classList.add('active');
            }
        }
    } catch (error) {
        console.error('Error loading config file:', error);
        showAlert('Dosya yüklenirken hata: ' + error.message, 'danger');
    }
}

async function saveConfig() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    if (!currentFile) return;

    const content = document.getElementById('config-editor').value;

    try {
        const data = await apiRequest(`/api/config/${encodeURIComponent(currentFile)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });

        if (data.error) {
            showAlert('Hata: ' + data.error, 'danger');
        } else {
            showAlert(data.message || 'Yapılandırma kaydedildi', 'success');
            fileContent[currentFile] = content;
            setTimeout(loadServices, 2000);
        }
    } catch (error) {
        showAlert('Kayıt hatası: ' + error.message, 'danger');
    }
}

async function validateCurrentConfig() {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    if (!currentFile) return;

    const content = document.getElementById('config-editor').value;

    try {
        const data = await apiRequest('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: currentFile, content })
        });

        if (data.valid) {
            showAlert('✓ ' + data.message, 'success');
        } else {
            showAlert('✗ ' + data.message, 'danger');
        }
    } catch (error) {
        showAlert('Doğrulama hatası: ' + error.message, 'danger');
    }
}

function cancelConfigEdit() {
    currentFile = null;
    document.getElementById('config-editor').style.display = 'none';
    document.getElementById('editor-placeholder').style.display = 'block';
    document.getElementById('editor-buttons').style.display = 'none';
    document.getElementById('editor-help').style.display = 'none';
}

function openConfigFromSettings(configType) {
    if (!configType) return;
    switchTab('config');
    setTimeout(() => {
        loadConfigFile(configType);
    }, 120);
}

async function controlService(serviceName, action) {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    const actionLabel = action === 'restart' ? 'yeniden başlatılacak' : action === 'stop' ? 'durdurulacak' : 'başlatılacak';
    const ok = await confirmDangerousAction({
        message: `"${serviceName}" servisi ${actionLabel}. Bu işlem onaylanmalıdır.`,
        detail: action === 'stop' ? 'Durdurulan servis log toplamayı keser. Sadece bakım veya sorun giderme için durdurun.' : 'Bu işlem geçici kesintiye neden olabilir.'
    });
    if (!ok) return;

    try {
        const data = await apiRequest(`/api/service/${serviceName}/${action}`, {
            method: 'POST'
        });

        if (data.error) {
            showAlert('Hata: ' + data.error, 'danger');
            serviceActionStatus.lastSingle = {
                status: 'danger',
                message: `${serviceName} ${action} hatalı: ${data.error}`,
                timestamp: new Date().toISOString()
            };
            renderServicesCommandCenter();
        } else {
            showAlert(data.message || `Servis ${action}`, 'success');
            serviceActionStatus.lastSingle = {
                status: 'success',
                message: `${serviceName} ${action} başarılı`,
                timestamp: new Date().toISOString()
            };
            renderServicesCommandCenter();
            setTimeout(loadServices, 2000);
        }
    } catch (error) {
        showAlert('Hata: ' + error.message, 'danger');
        serviceActionStatus.lastSingle = {
            status: 'danger',
            message: `${serviceName} ${action} hatalı: ${error.message}`,
            timestamp: new Date().toISOString()
        };
        renderServicesCommandCenter();
    }
}

async function scaleService(serviceName) {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    if (platformInfo.platform !== 'k8s') {
        showAlert('Ölçekleme yalnızca Kubernetes modunda aktif. Compose modunda servisler otomatik scale etmez.', 'info');
        return;
    }
    const input = document.getElementById(`scale-${serviceName}`);
    if (!input) return;

    const replicas = parseInt(input.value, 10);
    if (Number.isNaN(replicas) || replicas < 0) {
        showAlert('Replica değeri 0 veya daha büyük olmalı', 'warning');
        return;
    }

    try {
        const data = await apiRequest(`/api/scale/${serviceName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replicas })
        });

        if (data.error) {
            showAlert('Ölçekleme hatası: ' + data.error, 'danger');
            serviceActionStatus.lastScale = {
                status: 'danger',
                message: `${serviceName} ölçekleme hatalı: ${data.error}`,
                timestamp: new Date().toISOString()
            };
            renderServicesCommandCenter();
            return;
        }

        showAlert(data.message || 'Ölçekleme güncellendi', 'success');
        serviceActionStatus.lastScale = {
            status: 'success',
            message: `${serviceName} replicas=${replicas}`,
            timestamp: new Date().toISOString()
        };
        renderServicesCommandCenter();
        setTimeout(loadServices, 1000);
    } catch (error) {
        showAlert('Ölçekleme hatası: ' + error.message, 'danger');
        serviceActionStatus.lastScale = {
            status: 'danger',
            message: `${serviceName} ölçekleme hatalı: ${error.message}`,
            timestamp: new Date().toISOString()
        };
        renderServicesCommandCenter();
    }
}

async function loadGuidedSettings() {
    try {
        const data = await apiRequest('/api/settings/catalog');
        if (data.error) {
            showAlert('Ayarlar yüklenemedi: ' + data.error, 'danger');
            return;
        }
        settingsWritable = data.settingsWritable !== false;
        settingsAutoApplyAvailable = data.settingsAutoApplyAvailable === true;
        settingsWriteMessage = data.settingsWriteMessage || '';
        guidedSettings = data.settings || [];
        guidedSettingsDraftValues = {};
        guidedSettings.forEach(item => {
            guidedSettingsDraftValues[item.key] = item.value ?? '';
        });
        renderSettingsCategoryFilters(getVisibleGuidedSettings(guidedSettings));
        applyGuidedSettingsFilters();
        renderSettingsRuntimeStatus();
        renderSettingsOpsSnapshot();
        markDataFreshness('settings');
        if (!settingsWritable && settingsWriteMessage) {
            showAlert(settingsWriteMessage, settingsAutoApplyAvailable ? 'info' : 'warning');
        }
        updateCriticalOverview();
    } catch (error) {
        showAlert('Ayarlar yüklenemedi: ' + error.message, 'danger');
    }
}

function filterGuidedSettings() {
    applyGuidedSettingsFilters();
}

function renderSettingsCategoryFilters(settings) {
    const container = document.getElementById('settings-category-filters');
    if (!container) return;

    const groups = Array.from(new Set((settings || []).map(item => item.group || 'Diğer'))).sort((a, b) => a.localeCompare(b, 'tr'));
    const counts = groups.reduce((acc, group) => {
        acc[group] = settings.filter(item => (item.group || 'Diğer') === group).length;
        return acc;
    }, {});

    container.innerHTML = `
        <button class="category-chip" data-group="all">Tümü <span>${settings.length}</span></button>
        ${groups.map(group => `<button class="category-chip" data-group="${group}">${group} <span>${counts[group]}</span></button>`).join('')}
    `;

    if (activeSettingsGroup !== 'all' && !groups.includes(activeSettingsGroup)) {
        activeSettingsGroup = 'all';
    }
    updateSettingsCategorySelection();
    updateSettingsSummaryStats(settings, settings);
}

function updateSettingsCategorySelection() {
    document.querySelectorAll('#settings-category-filters .category-chip').forEach(chip => {
        const isActive = chip.getAttribute('data-group') === activeSettingsGroup;
        chip.classList.toggle('active', isActive);
    });
}

function applyGuidedSettingsFilters() {
    const query = (document.getElementById('settings-search')?.value || '').toLowerCase().trim();
    const visibleSettings = getVisibleGuidedSettings(guidedSettings);
    let filtered = visibleSettings.filter(item => {
        const group = item.group || 'Diğer';
        const groupMatch = activeSettingsGroup === 'all' || group === activeSettingsGroup;
        const queryMatch =
            !query ||
            (item.label || '').toLowerCase().includes(query) ||
            (item.key || '').toLowerCase().includes(query) ||
            (item.group || '').toLowerCase().includes(query) ||
            (item.description || '').toLowerCase().includes(query);
        return groupMatch && queryMatch;
    });

    renderGuidedSettings(filtered);

    const summary = document.getElementById('settings-summary');
    if (summary) {
        const groupLabel = activeSettingsGroup === 'all' ? 'Tüm kategoriler' : activeSettingsGroup;
        summary.textContent = `${groupLabel} • ${filtered.length} ayar gösteriliyor`;
    }

    updateSettingsSummaryStats(visibleSettings, filtered);
}

function rememberDraftSettingValue(key, value) {
    if (!key) return;
    guidedSettingsDraftValues[key] = value;
}

function getSettingSnapshotValues() {
    const snapshot = {};
    (guidedSettings || []).forEach(item => {
        snapshot[item.key] = Object.prototype.hasOwnProperty.call(guidedSettingsDraftValues, item.key)
            ? guidedSettingsDraftValues[item.key]
            : (item.value ?? '');
    });

    document.querySelectorAll('[data-setting-input="1"]').forEach(input => {
        const key = input.getAttribute('data-setting-key');
        if (!key) return;
        snapshot[key] = getResolvedSettingValue(key, input.id);
    });

    return snapshot;
}

function evaluateVisibilityRule(rule, valueMap) {
    if (!rule) return true;
    if (Array.isArray(rule.allOf)) {
        return rule.allOf.every(item => evaluateVisibilityRule(item, valueMap));
    }
    if (Array.isArray(rule.anyOf)) {
        return rule.anyOf.some(item => evaluateVisibilityRule(item, valueMap));
    }

    const key = rule.key;
    const current = String(valueMap[key] ?? '').trim();
    if (Object.prototype.hasOwnProperty.call(rule, 'equals')) {
        return current === String(rule.equals);
    }
    if (Object.prototype.hasOwnProperty.call(rule, 'notEquals')) {
        return current !== String(rule.notEquals);
    }
    if (Object.prototype.hasOwnProperty.call(rule, 'startsWith')) {
        return current.toLowerCase().startsWith(String(rule.startsWith).toLowerCase());
    }
    if (Object.prototype.hasOwnProperty.call(rule, 'truthy')) {
        const val = current.toLowerCase();
        const truthy = ['1', 'true', 'yes', 'on'].includes(val);
        return Boolean(rule.truthy) ? truthy : !truthy;
    }
    if (Object.prototype.hasOwnProperty.call(rule, 'hasValue')) {
        return Boolean(rule.hasValue) ? current.length > 0 : current.length === 0;
    }
    return true;
}

function getVisibleGuidedSettings(settings) {
    const valueMap = getSettingSnapshotValues();
    return (settings || []).filter(item => evaluateVisibilityRule(item.visibleWhen, valueMap));
}

function updateSettingsSummaryStats(allSettings, visibleSettings) {
    const totalEl = document.getElementById('settings-total-count');
    const visibleEl = document.getElementById('settings-visible-count');
    const criticalEl = document.getElementById('settings-critical-count');
    if (!totalEl || !visibleEl || !criticalEl) return;

    const total = (allSettings || []).length;
    const visible = (visibleSettings || []).length;
    const critical = (visibleSettings || []).filter(s => s.riskLevel === 'high').length;

    totalEl.textContent = String(total);
    visibleEl.textContent = String(visible);
    criticalEl.textContent = String(critical);
}

function settingGroupKey(group) {
    if (typeof dashboardUtils.settingGroupKey === 'function') {
        return dashboardUtils.settingGroupKey(group);
    }
    const raw = (group || 'Diğer').toLowerCase();
    const normalized = raw
        .replace(/ı/g, 'i')
        .replace(/İ/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c');
    return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getSettingByKey(key) {
    return guidedSettings.find(item => item.key === key);
}

function getDraftOrSettingValue(setting) {
    if (!setting || !setting.key) return '';
    if (Object.prototype.hasOwnProperty.call(guidedSettingsDraftValues, setting.key)) {
        return guidedSettingsDraftValues[setting.key];
    }
    return setting.value ?? '';
}

function validateSettingValue(setting, rawValue) {
    if (typeof dashboardUtils.validateSettingValue === 'function') {
        return dashboardUtils.validateSettingValue(setting, rawValue);
    }
    const value = String(rawValue ?? '').trim();

    if (!setting) {
        return { valid: false, message: 'Ayar tanımı bulunamadı' };
    }

    if (setting.type === 'number') {
        if (!/^\d+$/.test(value)) {
            return { valid: false, message: 'Sayısal bir değer girin' };
        }
        const numeric = Number(value);
        const min = Number.isFinite(Number(setting.min)) ? Number(setting.min) : 0;
        const max = Number.isFinite(Number(setting.max)) ? Number(setting.max) : null;
        if (numeric < min) {
            return { valid: false, message: `Değer en az ${min} olmalı` };
        }
        if (max !== null && numeric > max) {
            return { valid: false, message: `Değer en fazla ${max} olmalı` };
        }
    }

    if (setting.type === 'select') {
        const options = setting.options || [];
        if (!options.includes(value)) {
            return { valid: false, message: `Geçerli seçenek: ${options.join(', ')}` };
        }
    }

    if (setting.type === 'password' && value !== '********' && value.length > 0 && value.length < 8) {
        return { valid: false, message: 'Parola en az 8 karakter olmalı' };
    }

    if (setting.minLength && value && value.length < Number(setting.minLength)) {
        return { valid: false, message: `En az ${setting.minLength} karakter gerekli` };
    }

    if (setting.pattern && value) {
        try {
            const pattern = new RegExp(setting.pattern);
            if (!pattern.test(value)) {
                return { valid: false, message: `${setting.key} formatı geçersiz` };
            }
        } catch (error) {
            console.warn('Pattern parse error:', setting.key, error);
        }
    }

    const forbiddenPatterns = Array.isArray(setting.forbiddenPatterns) ? setting.forbiddenPatterns : [];
    for (const token of forbiddenPatterns) {
        try {
            const pattern = new RegExp(token, 'i');
            if (value && pattern.test(value)) {
                return { valid: false, message: `${setting.key} alanında izin verilmeyen format var` };
            }
        } catch (error) {
            console.warn('Forbidden pattern parse error:', setting.key, error);
        }
    }

    if (setting.key === 'TZ' && value && (!value.includes('/') || /\s/.test(value))) {
        return { valid: false, message: 'Timezone formatı geçersiz. Ör: Europe/Istanbul' };
    }

    if (setting.key === 'SMTP_HOST' && value && /https?:\/\//i.test(value)) {
        return { valid: false, message: 'SMTP host alanına protokol eklemeyin' };
    }

    if (setting.key === 'ARCHIVE_DESTINATION' && value) {
        const pattern = /^(local|minio:[\w./-]+|s3:[\w./-]+|sftp:[^\s:]+\/[^\s]+)$/;
        if (!pattern.test(value)) {
            return {
                valid: false,
                message: 'Format: local | minio:bucket | s3:bucket | sftp:server/path'
            };
        }
    }

    return { valid: true, message: '' };
}

function parseArchiveDestinationValue(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value || value === 'local') {
        return { kind: 'local', target: '' };
    }
    const colonIndex = value.indexOf(':');
    if (colonIndex === -1) {
        return { kind: 'local', target: '' };
    }

    const kind = value.slice(0, colonIndex).toLowerCase();
    const target = value.slice(colonIndex + 1);
    if (!['minio', 's3', 'sftp'].includes(kind)) {
        return { kind: 'local', target: '' };
    }
    return { kind, target };
}

function composeArchiveDestinationValue(kind, target) {
    const safeKind = ['local', 'minio', 's3', 'sftp'].includes(kind) ? kind : 'local';
    const trimmedTarget = String(target || '').trim();
    if (safeKind === 'local') {
        return 'local';
    }
    return `${safeKind}:${trimmedTarget}`;
}

function getResolvedSettingValue(key, inputId) {
    if (key !== 'ARCHIVE_DESTINATION') {
        const input = document.getElementById(inputId);
        return input ? input.value : '';
    }

    const hiddenInput = document.getElementById(inputId);
    const typeSelect = document.getElementById(`${inputId}-archive-type`);
    const targetInput = document.getElementById(`${inputId}-archive-target`);
    const kind = typeSelect ? typeSelect.value : 'local';
    const target = targetInput ? targetInput.value : '';
    const resolved = composeArchiveDestinationValue(kind, target);

    if (hiddenInput) {
        hiddenInput.value = resolved;
    }
    return resolved;
}

function onArchiveDestinationPartChange(inputId, errorId, saveBtnId) {
    const typeSelect = document.getElementById(`${inputId}-archive-type`);
    const targetInput = document.getElementById(`${inputId}-archive-target`);
    if (typeSelect && targetInput) {
        const isLocal = typeSelect.value === 'local';
        targetInput.disabled = isLocal;
        targetInput.placeholder = isLocal
            ? 'local hedefi otomatik: ARCHIVE_DATA_ROOT'
            : (typeSelect.value === 'sftp' ? 'server/path' : 'bucket veya path');
        if (isLocal) {
            targetInput.value = '';
        }
    }
    const previousValue = String(guidedSettingsDraftValues.ARCHIVE_DESTINATION || 'local');
    const previousKind = parseArchiveDestinationValue(previousValue).kind;
    validateSettingInput('ARCHIVE_DESTINATION', inputId, errorId, saveBtnId);
    const currentValue = String(guidedSettingsDraftValues.ARCHIVE_DESTINATION || 'local');
    const currentKind = parseArchiveDestinationValue(currentValue).kind;
    if (previousKind !== currentKind) {
        renderSettingsCategoryFilters(getVisibleGuidedSettings(guidedSettings));
        applyGuidedSettingsFilters();
    }
}

function validateSettingInput(key, inputId, errorId, saveBtnId, options = {}) {
    const input = document.getElementById(inputId);
    const errorEl = document.getElementById(errorId);
    const saveBtn = document.getElementById(saveBtnId);
    const setting = getSettingByKey(key);
    if (!input || !errorEl || !saveBtn || !setting) return true;

    const resolvedValue = getResolvedSettingValue(key, inputId);
    rememberDraftSettingValue(key, resolvedValue);
    const result = validateSettingValue(setting, resolvedValue);
    errorEl.textContent = result.valid ? '' : result.message;
    errorEl.style.display = result.valid ? 'none' : 'block';
    input.classList.toggle('input-invalid', !result.valid);
    saveBtn.disabled = !result.valid;

    if (!options.suppressRefresh && ['SIGNER_TYPE', 'SMTP_ENABLED', 'SMTP_USE_AUTH', 'TELEGRAM_BOT_TOKEN'].includes(key)) {
        renderSettingsCategoryFilters(getVisibleGuidedSettings(guidedSettings));
        applyGuidedSettingsFilters();
    }

    return result.valid;
}

function initializeRenderedSettingValidation() {
    document.querySelectorAll('[data-setting-input="1"]').forEach(input => {
        const key = input.getAttribute('data-setting-key');
        const inputId = input.id;
        const errorId = input.getAttribute('data-error-id');
        const saveBtnId = input.getAttribute('data-save-id');
        if (key === 'ARCHIVE_DESTINATION') {
            onArchiveDestinationPartChange(inputId, errorId, saveBtnId);
            return;
        }
        validateSettingInput(key, inputId, errorId, saveBtnId, { suppressRefresh: true });
    });
}

function toggleSettingsGroup(groupKey) {
    if (!groupKey) return;
    if (collapsedSettingsGroups.has(groupKey)) {
        collapsedSettingsGroups.delete(groupKey);
    } else {
        collapsedSettingsGroups.add(groupKey);
    }
    applyGuidedSettingsFilters();
}

function collapseAllSettingGroups() {
    const groups = Array.from(new Set((guidedSettings || []).map(item => settingGroupKey(item.group || 'Diğer'))));
    groups.forEach(group => collapsedSettingsGroups.add(group));
    applyGuidedSettingsFilters();
}

function expandAllSettingGroups() {
    collapsedSettingsGroups.clear();
    applyGuidedSettingsFilters();
}

function renderGuidedSettings(settings) {
    const container = document.getElementById('guided-settings-list');
    if (!container) return;
    const canEditSettings = canPersistSettings();

    if (!settings.length) {
        container.innerHTML = '<p class="loading">Ayar bulunamadı.</p>';
        return;
    }

    const grouped = settings.reduce((acc, item) => {
        const group = item.group || 'Diğer';
        if (!acc[group]) acc[group] = [];
        acc[group].push(item);
        return acc;
    }, {});

    const groups = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'tr'));

    container.innerHTML = groups.map(group => {
        const items = grouped[group];
        const groupKey = settingGroupKey(group);
        const isCollapsed = collapsedSettingsGroups.has(groupKey);
        const cards = items.map((s, idx) => {
        const inputId = `setting-${group.replace(/\s+/g, '-').toLowerCase()}-${idx}`;
        const saveBtnId = `${inputId}-save`;
        const errorId = `${inputId}-error`;
        const fallbackGuide = { placeholder: s.placeholder || '', hint: s.hint || '' };
        const guide = settingsGuides[s.key] || fallbackGuide;
        const currentValue = getDraftOrSettingValue(s);
        let inputMarkup = '';

        if (s.key === 'ARCHIVE_DESTINATION') {
            const parsedArchive = parseArchiveDestinationValue(currentValue || 'local');
            const localSelected = parsedArchive.kind === 'local';
            inputMarkup = `
                <div class="archive-destination-control">
                    <div class="archive-control-row">
                        <select id="${inputId}-archive-type" class="select-input" onchange="onArchiveDestinationPartChange('${inputId}', '${errorId}', '${saveBtnId}')" ${canEditSettings ? '' : 'disabled'}>
                            <option value="local" ${parsedArchive.kind === 'local' ? 'selected' : ''}>local (sunucu içi)</option>
                            <option value="minio" ${parsedArchive.kind === 'minio' ? 'selected' : ''}>minio</option>
                            <option value="s3" ${parsedArchive.kind === 's3' ? 'selected' : ''}>s3</option>
                            <option value="sftp" ${parsedArchive.kind === 'sftp' ? 'selected' : ''}>sftp</option>
                        </select>
                        <input id="${inputId}-archive-target" class="input-search" type="text" value="${parsedArchive.target || ''}" placeholder="${localSelected ? 'local hedefi otomatik: ARCHIVE_DATA_ROOT' : (parsedArchive.kind === 'sftp' ? 'server/path' : 'bucket veya path')}" oninput="onArchiveDestinationPartChange('${inputId}', '${errorId}', '${saveBtnId}')" spellcheck="false" ${localSelected ? 'disabled' : ''} ${canEditSettings ? '' : 'disabled'}>
                    </div>
                    <div class="archive-control-hint">Örnekler: <strong>local</strong>, <strong>minio:logs-backup</strong>, <strong>s3:bucket/path</strong>, <strong>sftp:server/path</strong></div>
                    <input id="${inputId}" type="hidden" value="${currentValue || 'local'}" data-setting-input="1" data-setting-key="${s.key}" data-error-id="${errorId}" data-save-id="${saveBtnId}">
                </div>
            `;
        } else if (s.type === 'select') {
            const options = (s.options || []).map(opt => `<option value="${opt}" ${String(opt) === String(currentValue) ? 'selected' : ''}>${opt}</option>`).join('');
            inputMarkup = `<select id="${inputId}" class="select-input" data-setting-input="1" data-setting-key="${s.key}" data-error-id="${errorId}" data-save-id="${saveBtnId}" onchange="validateSettingInput('${s.key}', '${inputId}', '${errorId}', '${saveBtnId}')" ${canEditSettings ? '' : 'disabled'}>${options}</select>`;
        } else {
            const inputType = s.type === 'password' ? 'password' : (s.type === 'number' ? 'number' : 'text');
            const minAttr = s.type === 'number' && Number.isFinite(Number(s.min)) ? `min="${s.min}"` : '';
            const maxAttr = s.type === 'number' && Number.isFinite(Number(s.max)) ? `max="${s.max}"` : '';
            inputMarkup = `<input id="${inputId}" class="input-search" type="${inputType}" value="${currentValue || ''}" ${minAttr} ${maxAttr} ${guide.placeholder ? `placeholder="${guide.placeholder}"` : ''} spellcheck="false" data-setting-input="1" data-setting-key="${s.key}" data-error-id="${errorId}" data-save-id="${saveBtnId}" oninput="validateSettingInput('${s.key}', '${inputId}', '${errorId}', '${saveBtnId}')" ${canEditSettings ? '' : 'disabled'}>`;
        }

        const riskClass = s.riskLevel === 'high' ? 'badge-danger' : (s.riskLevel === 'medium' ? 'badge-warning' : 'badge-success');
        const affected = (s.affectedServices || []).join(', ');
        const restartText = s.restartRequired ? 'Evet' : 'Hayır';

        return `
            <div class="card setting-card">
                <div class="card-header">
                    <h4>${s.label}</h4>
                    <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
                        <span class="badge badge-warning">${s.requiredRole || 'viewer'}</span>
                        <span class="badge ${riskClass}">risk: ${s.riskLevel || 'medium'}</span>
                    </div>
                </div>
                <div class="card-body">
                    <p class="help-text">${s.description}</p>
                    ${s.deprecatedCoercion ? `<p class="help-text" style="border-left:3px solid var(--color-warning);padding-left:0.5rem;margin-top:0.5rem;">${String(s.deprecatedCoercion).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : ''}
                    <div class="setting-meta-grid">
                        <div class="setting-meta-item"><span>Alan</span><strong>${s.key}</strong></div>
                        <div class="setting-meta-item"><span>Restart</span><strong>${restartText}</strong></div>
                        <div class="setting-meta-item setting-meta-item-full"><span>Etkilenen Servisler</span><strong>${affected || '-'}</strong></div>
                    </div>
                    ${guide.hint ? `<div class="setting-input-hint"><i class="fas fa-lightbulb"></i> ${guide.hint}</div>` : ''}
                    ${inputMarkup}
                    <div id="${errorId}" class="setting-input-error" style="display:none;"></div>
                    <div style="display:flex; justify-content:flex-end; margin-top:0.75rem;">
                        <button class="btn btn-secondary btn-sm" style="margin-right:0.5rem;" onclick="openSettingDetail('${s.key}')">
                            <i class="fas fa-circle-info"></i> Detay
                        </button>
                        <button id="${saveBtnId}" class="btn btn-success btn-sm" onclick="previewSettingChange('${s.key}', '${inputId}')" ${canEditSettings ? '' : 'disabled'}>
                            <i class="fas fa-save"></i> Kaydet
                        </button>
                    </div>
                </div>
            </div>
        `;
        }).join('');

        return `
            <section class="settings-group-block group-${groupKey}">
                <div class="settings-group-title-row">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                        <button class="group-toggle-btn" onclick="toggleSettingsGroup('${groupKey}')" title="Grubu aç/kapat">
                            <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                        </button>
                        <h4>${group}</h4>
                    </div>
                    <span class="badge badge-info">${items.length} ayar</span>
                </div>
                <div class="settings-grid grouped-settings-grid" style="display:${isCollapsed ? 'none' : 'grid'};">
                    ${cards}
                </div>
            </section>
        `;
    }).join('');

    initializeRenderedSettingValidation();
}

async function openSettingDetail(key) {
    const drawer = document.getElementById('setting-detail-drawer');
    const titleEl = document.getElementById('setting-detail-title');
    const metaEl = document.getElementById('setting-detail-meta');
    const impactEl = document.getElementById('setting-detail-impact');
    const auditEl = document.getElementById('setting-detail-audit');
    if (!drawer || !titleEl || !metaEl || !impactEl || !auditEl) return;

    const setting = guidedSettings.find(item => item.key === key);
    titleEl.textContent = setting?.label || key;
    metaEl.textContent = `Anahtar: ${key}`;
    impactEl.innerHTML = '<p class="loading">Etki bilgisi yükleniyor...</p>';
    auditEl.innerHTML = '<p class="loading">Audit geçmişi yükleniyor...</p>';
    drawer.classList.add('show');

    const [impactResult, auditResult] = await Promise.allSettled([
        apiRequest(`/api/settings/impact/${encodeURIComponent(key)}`),
        apiRequest('/api/audit/events?limit=250')
    ]);

    if (impactResult.status === 'fulfilled') {
        const impact = impactResult.value || {};
        const affected = (impact.affectedServices || []).join(', ') || '-';
        const restart = impact.restartRequired ? 'Evet' : 'Hayır';
        const risk = impact.riskLevel || setting?.riskLevel || 'medium';

        impactEl.innerHTML = `
            <div class="detail-grid">
                <div class="detail-item"><span>Risk</span><strong>${risk}</strong></div>
                <div class="detail-item"><span>Restart Gerekir</span><strong>${restart}</strong></div>
                <div class="detail-item detail-item-full"><span>Etkilenen Servisler</span><strong>${affected}</strong></div>
                <div class="detail-item detail-item-full"><span>Açıklama</span><strong>${impact.description || setting?.description || '-'}</strong></div>
            </div>
        `;
    } else {
        impactEl.innerHTML = `<p class="loading">Etki bilgisi alınamadı: ${impactResult.reason?.message || 'Bilinmeyen hata'}</p>`;
    }

    if (auditResult.status === 'fulfilled') {
        const statusMeta = {
            success: { label: 'Başarılı', icon: '✓' },
            failed: { label: 'Başarısız', icon: '✗' },
            warning: { label: 'Uyarı', icon: '⚠' }
        };

        const formatLocalDateTime = (isoValue) => {
            const parsed = parseIsoDate(isoValue);
            if (!parsed) return '-';
            return parsed.toLocaleString('tr-TR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        };

        const summarizeAuditDetails = (event) => {
            const details = event?.details || {};
            if (details.no_change) return 'Maskelenmiş değer değişmedi, kayıt atlandı.';
            if (details.auto_applied) {
                const via = details.writer_container ? ` (${details.writer_container})` : '';
                return `Salt-okunur ortamda otomatik uygulandı${via}.`;
            }
            if (details.side_note) return String(details.side_note);
            return 'Ayar güncellemesi başarıyla işlendi.';
        };

        const formatAuditValue = (value) => {
            if (value === undefined || value === null || value === '') return '(boş)';
            return String(value);
        };

        const renderValueDelta = (event) => {
            const details = event?.details || {};
            if (!Object.prototype.hasOwnProperty.call(details, 'old_value') && !Object.prototype.hasOwnProperty.call(details, 'new_value')) {
                return '';
            }

            const oldValue = formatAuditValue(details.old_value);
            const newValue = formatAuditValue(details.new_value);
            return `<div class="timeline-time">Değer: <strong>${oldValue}</strong> → <strong>${newValue}</strong></div>`;
        };

        const events = (auditResult.value?.events || [])
            .filter(event => event?.action === 'settings.update' && event?.details?.key === key)
            .slice(0, 12);

        if (!events.length) {
            auditEl.innerHTML = '<p class="loading">Bu ayar için kayıtlı değişiklik bulunamadı.</p>';
        } else {
            auditEl.innerHTML = events.map(event => `
                <div class="timeline-item">
                    <div class="timeline-dot"></div>
                    <div class="timeline-content">
                        <div class="timeline-text"><strong>${(statusMeta[event.status]?.icon || '•')} ${statusMeta[event.status]?.label || event.status || 'Bilinmiyor'}</strong> • ${event.user || 'anonymous'} (${event.role || '-'})</div>
                        <div class="timeline-time">${formatLocalDateTime(event.timestamp)} • ${formatRelativeTime(event.timestamp)}</div>
                        ${renderValueDelta(event)}
                        <div class="timeline-time">${summarizeAuditDetails(event)}</div>
                    </div>
                </div>
            `).join('');
        }
    } else {
        auditEl.innerHTML = `<p class="loading">Audit geçmişi alınamadı: ${auditResult.reason?.message || 'Bilinmeyen hata'}</p>`;
    }
}

function closeSettingDetail() {
    const drawer = document.getElementById('setting-detail-drawer');
    if (drawer) {
        drawer.classList.remove('show');
    }
}

async function saveGuidedSetting(key, inputId) {
    if (!canPersistSettings()) {
        showAlert(settingsWriteMessage || 'Bu ortamda ayar kaydetme işlemi devre dışı', 'warning');
        return;
    }

    const input = document.getElementById(inputId);
    if (!input) return;

    const setting = guidedSettings.find(s => s.key === key);
    if (!setting) return;

    const resolvedValue = getResolvedSettingValue(key, inputId);
    const validation = validateSettingValue(setting, resolvedValue);
    if (!validation.valid) {
        showAlert(`Ayar kaydedilemedi: ${validation.message}`, 'warning');
        return;
    }

    try {
        const data = await apiRequest('/api/settings/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value: resolvedValue })
        });

        if (data.error) {
            showAlert('Ayar kaydedilemedi: ' + data.error, 'danger');
            return;
        }

        showAlert(data.message || 'Ayar kaydedildi', 'success');
        if (hasAtLeastRole('operator')) {
            runSettingsPostCheck(key);
        }
        setTimeout(loadGuidedSettings, 500);
    } catch (error) {
        showAlert('Ayar kaydetme hatası: ' + error.message, 'danger');
    }
}

function previewSettingChange(key, inputId) {
    if (!canPersistSettings()) {
        showAlert(settingsWriteMessage || 'Bu ortamda ayar kaydetme işlemi devre dışı', 'warning');
        return;
    }

    const input = document.getElementById(inputId);
    const setting = getSettingByKey(key);
    if (!input || !setting) return;

    const resolvedValue = getResolvedSettingValue(key, inputId);
    const validation = validateSettingValue(setting, resolvedValue);
    if (!validation.valid) {
        showAlert(`Ayar kaydedilemedi: ${validation.message}`, 'warning');
        return;
    }

    const oldValueRaw = setting.value ?? '';
    const oldValue = oldValueRaw === '********' ? 'Gizli Değer' : String(oldValueRaw);
    const newValue = setting.type === 'password' && resolvedValue !== '********' ? 'Yeni Gizli Değer' : String(resolvedValue);
    const affected = (setting.affectedServices || []).join(', ') || '-';
    const restart = setting.restartRequired ? 'Evet' : 'Hayır';
    const risk = setting.riskLevel || 'medium';

    pendingSettingChange = { key, inputId };

    const title = document.getElementById('change-summary-title');
    const body = document.getElementById('change-summary-body');
    if (!title || !body) return;

    title.textContent = `${setting.label} değişiklik özeti`;
    body.innerHTML = `
        <div class="detail-grid">
            <div class="detail-item detail-item-full"><span>Alan</span><strong>${setting.key}</strong></div>
            <div class="detail-item"><span>Risk</span><strong>${risk}</strong></div>
            <div class="detail-item"><span>Restart Gerekir</span><strong>${restart}</strong></div>
            <div class="detail-item detail-item-full"><span>Etkilenen Servisler</span><strong>${affected}</strong></div>
            <div class="detail-item detail-item-full"><span>Mevcut Değer</span><strong>${oldValue || '-'}</strong></div>
            <div class="detail-item detail-item-full"><span>Yeni Değer</span><strong>${newValue || '-'}</strong></div>
        </div>
    `;

    const modal = document.getElementById('change-summary-modal');
    if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
    }
}

function closeChangeSummaryModal() {
    const modal = document.getElementById('change-summary-modal');
    if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
    }
    pendingSettingChange = null;
}

async function confirmSettingChangeSave() {
    if (!pendingSettingChange) return;
    const { key, inputId } = pendingSettingChange;
    closeChangeSummaryModal();
    await saveGuidedSetting(key, inputId);
}

async function loadAuditEvents() {
    if (!hasAtLeastRole('operator')) {
        renderLogsPermissionDenied();
        return;
    }
    const container = document.getElementById('audit-events-list');
    if (!container) return;

    try {
        const data = await apiRequest('/api/audit/events?limit=100');

        if (data.error) {
            container.innerHTML = `<p class="loading">${data.error}</p>`;
            return;
        }

        const events = data.events || [];
        if (!events.length) {
            container.innerHTML = '<p class="loading">Henüz audit kaydı yok.</p>';
            return;
        }

        container.innerHTML = events.map((item) => {
            const det = item.details && typeof item.details === 'object' ? item.details : null;
            let extra = '';
            if (item.action === 'agent.windows_uninstall' && det) {
                const h = escapeHtml(det.hostname || '');
                const inv = det.inventoryUpdated ? 'envanter güncellendi' : 'envanter eşleşmesi yok';
                extra = `<div class="help-text" style="font-size:0.82rem; margin-top:0.25rem;">Host: <strong>${h}</strong> • ${escapeHtml(inv)}${det.reason ? ` • ${escapeHtml(det.reason)}` : ''}</div>`;
            }
            return `
            <div class="timeline-item">
                <div class="timeline-dot" style="background:${item.status === 'success' ? '#10b981' : '#ef4444'}"></div>
                <div class="timeline-content">
                    <div class="timeline-text"><strong>${escapeHtml(item.action || '')}</strong> • ${escapeHtml(item.status || '')}</div>
                    <div class="timeline-time">${escapeHtml(item.timestamp || '')} • ${escapeHtml(item.user || 'anonymous')} (${escapeHtml(item.role || '-')})</div>
                    ${extra}
                </div>
            </div>`;
        }).join('');

        latestAuditEvents = events;
        markDataFreshness('audit');
        renderOverviewOperationalIntelligence();
        renderOverviewCriticalEvents();
        updateCriticalOverview();
    } catch (error) {
        container.innerHTML = `<p class="loading">Audit yükleme hatası: ${error.message}</p>`;
    }
}

async function loadArchiveStatus() {
    const container = document.getElementById('archive-entries-list');
    const retryBadge = document.getElementById('archive-retry-badge');
    if (!container) return;

    try {
        const data = await apiRequest('/api/archive/status');
        if (data.error) {
            container.innerHTML = `<p class="loading">${data.error}</p>`;
            return;
        }

        const entries = data.entries || [];
        if (data.retryQueueCount > 0 && retryBadge) {
            retryBadge.style.display = 'inline-block';
            retryBadge.textContent = `Retry kuyruğu: ${data.retryQueueCount}`;
            retryBadge.className = 'status-badge status-warning';
        } else if (retryBadge) {
            retryBadge.style.display = 'none';
        }

        if (!entries.length) {
            container.innerHTML = '<p class="loading">Henüz arşiv dosyası yok.</p>';
            return;
        }

        container.innerHTML = entries.map(e => {
            const signedIcon = e.signed ? '<span class="status-success">✓</span>' : '<span class="status-danger">✗</span>';
            const wormIcon = e.worm ? '<span class="status-success">✓</span>' : '<span class="status-danger">✗</span>';
            const size = e.rawSize ? (e.rawSize / 1024).toFixed(1) + ' KB' : '-';
            const hash = e.hash ? `<code>${String(e.hash).slice(0, 16)}...</code>` : '-';
            return `
                <div class="service-item" style="flex-direction:column; align-items:flex-start; gap:0.35rem;">
                    <div style="display:flex; justify-content:space-between; width:100%;">
                        <strong>${e.date}</strong>
                        <span>${size}</span>
                    </div>
                    <div style="font-size:0.85rem; color:var(--text-muted);">
                        İmzalı: ${signedIcon} | WORM: ${wormIcon}
                        ${e.hash ? ` | Hash: ${hash}` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        container.innerHTML = `<p class="loading">Arşiv durumu yüklenemedi: ${error.message}</p>`;
    }
}

async function applyOpenSearchIsm() {
    if (!hasAtLeastRole('admin')) {
        showAlert('Bu işlem için admin rolü gerekli', 'warning');
        return;
    }
    const resultEl = document.getElementById('opensearch-ism-apply-result');
    const confirmed = await confirmDangerousAction({
        message: 'OpenSearch ISM (90 gün) ve best_compression şablonu uygulanacak',
        detail: 'Küme ayarları güncellenir; mevcut indekslerde yaşam döngüsü politikanıza göre etki olabilir. Yeni graylog_* indeksleri şablonu kullanır.'
    });
    if (!confirmed) return;
    if (resultEl) resultEl.textContent = 'Uygulanıyor…';
    try {
        const resp = await apiRequest('/api/ops/apply-opensearch-ism', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (resultEl) resultEl.textContent = resp.message || 'Tamamlandı';
        showAlert(resp.message || 'OpenSearch ISM uygulandı', 'success');
        loadArchiveRetention();
    } catch (error) {
        if (resultEl) resultEl.textContent = error.message || String(error);
        showAlert(`ISM uygulama: ${error.message}`, 'danger');
    }
}

async function loadArchiveRetention() {
    const container = document.getElementById('archive-retention-info');
    if (!container) return;

    try {
        const data = await apiRequest('/api/archive/retention');
        if (data.error) {
            container.innerHTML = `<p class="loading">${data.error}</p>`;
            return;
        }

        const oi = data.opensearchIsm || {};
        const fully = oi.fullyApplied === true;
        const reach = oi.reachable === true;
        const pol = oi.policyPresent === true;
        const tpl = oi.templatePresent === true;
        let ismStatusLine = 'Denetlenemedi';
        if (oi.error && !reach) {
            ismStatusLine = `Erişim yok: ${oi.error}`;
        } else if (fully) {
            ismStatusLine = 'Evet — policy + şablon kümede';
        } else if (reach) {
            ismStatusLine = `Policy: ${pol ? 'var' : 'yok'} • Şablon: ${tpl ? 'var' : 'yok'}`;
        }

        let ismHint = '';
        if (oi.error && !reach) {
            ismHint = `<div class="settings-summary" style="margin-top:0.5rem;">${escapeHtml(oi.error)}</div>`;
        } else if (reach && !fully) {
            ismHint = '<div class="settings-summary" style="margin-top:0.5rem;">Kurulum betiği OpenSearch gecikirse ISM atlanabilir; arka planda otomatik yeniden deneme çalışır (<code>logs/ism-auto-retry.log</code>). Buradan da tek tıkla uygulayabilirsiniz.</div>';
        }

        const applyRow = hasAtLeastRole('admin')
            ? `<div style="margin-top:0.6rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
                <button type="button" class="btn btn-sm btn-warning" id="opensearch-apply-ism-btn"><i class="fas fa-database"></i> OpenSearch ISM + şablonu uygula</button>
                <span id="opensearch-ism-apply-result" class="help-text"></span>
               </div>`
            : '';

        const stages = (data.ismStages || []).map(s =>
            `<div><strong>${s.name}</strong>: ${s.minAge} – ${s.desc}</div>`
        ).join('');
        container.innerHTML = `
            <div class="health-details">
                <div class="health-item"><span>Arşiv hedefi</span><span>${data.archiveDestination || 'local'}</span></div>
                <div class="health-item"><span>OpenSearch (arama)</span><span>${data.rawRetentionDays || 90} gün</span></div>
                <div class="health-item"><span>WORM (5651 arşiv)</span><span>${data.totalRetentionDays || 730} gün</span></div>
                <div class="health-item"><span>ISM policy (tasarım)</span><span>${data.ismPolicy || '-'}</span></div>
                <div class="health-item"><span>ISM kümede</span><span>${escapeHtml(ismStatusLine)}</span></div>
            </div>
            ${ismHint}
            ${applyRow}
            <div style="margin-top:0.75rem;">
                <strong>ISM aşamaları:</strong>
                <div style="margin-top:0.35rem; font-size:0.9rem;">${stages || '-'}</div>
            </div>
        `;
        const applyBtn = document.getElementById('opensearch-apply-ism-btn');
        if (applyBtn) applyBtn.addEventListener('click', applyOpenSearchIsm);
    } catch (error) {
        container.innerHTML = `<p class="loading">Retention bilgisi yüklenemedi: ${error.message}</p>`;
    }
}

async function loadHpaPolicies() {
    const container = document.getElementById('hpa-policies-list');
    if (!container) return;

    if (platformInfo.platform !== 'k8s') {
        container.innerHTML = '<p class="loading">HPA yönetimi yalnızca Kubernetes modunda kullanılabilir.</p>';
        return;
    }

    try {
        const data = await apiRequest('/api/k8s/hpa');
        if (data.error) {
            container.innerHTML = `<p class="loading">${data.error}</p>`;
            return;
        }

        const items = data.items || [];
        if (!items.length) {
            container.innerHTML = '<p class="loading">HPA bulunamadı.</p>';
            return;
        }

        container.innerHTML = items.map((h, idx) => {
            const minId = `hpa-min-${idx}`;
            const maxId = `hpa-max-${idx}`;
            const cpuId = `hpa-cpu-${idx}`;
            const memId = `hpa-mem-${idx}`;
            return `
                <div class="file-item" style="cursor:default;">
                    <div style="font-weight:600; margin-bottom:0.5rem;">${h.name} → ${h.target_kind}/${h.target_name}</div>
                    <div style="display:grid; grid-template-columns:repeat(4,minmax(70px,1fr)); gap:0.5rem; margin-bottom:0.5rem;">
                        <input id="${minId}" type="number" min="0" class="input-search" value="${h.min_replicas ?? 1}" title="Min Replica">
                        <input id="${maxId}" type="number" min="1" class="input-search" value="${h.max_replicas ?? 1}" title="Max Replica">
                        <input id="${cpuId}" type="number" min="1" class="input-search" value="${h.cpu_target ?? ''}" title="CPU %">
                        <input id="${memId}" type="number" min="1" class="input-search" value="${h.memory_target ?? ''}" title="Memory %">
                    </div>
                    <div style="display:flex; justify-content:flex-end;">
                        <button class="btn btn-success btn-sm" onclick="saveHpaPolicy('${h.name}', '${minId}', '${maxId}', '${cpuId}', '${memId}')">
                            <i class="fas fa-save"></i> HPA Kaydet
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        container.innerHTML = `<p class="loading">HPA yükleme hatası: ${error.message}</p>`;
    }
}

async function saveHpaPolicy(name, minId, maxId, cpuId, memId) {
    const payload = {
        min_replicas: parseInt(document.getElementById(minId).value || '0', 10),
        max_replicas: parseInt(document.getElementById(maxId).value || '1', 10)
    };

    const cpu = document.getElementById(cpuId).value;
    const mem = document.getElementById(memId).value;
    if (cpu !== '') payload.cpu_target = parseInt(cpu, 10);
    if (mem !== '') payload.memory_target = parseInt(mem, 10);

    try {
        const data = await apiRequest(`/api/k8s/hpa/${name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (data.error) {
            showAlert('HPA güncelleme hatası: ' + data.error, 'danger');
            return;
        }
        showAlert(data.message || 'HPA politikası güncellendi', 'success');
        setTimeout(loadHpaPolicies, 800);
    } catch (error) {
        showAlert('HPA güncelleme hatası: ' + error.message, 'danger');
    }
}

function populateRolloutDeployments() {
    const select = document.getElementById('rollout-deployment-select');
    if (!select) return;

    if (platformInfo.platform !== 'k8s') {
        select.innerHTML = '<option value="">Kubernetes modu gerekli</option>';
        return;
    }

    const deploymentNames = Object.entries(services)
        .filter(([_, info]) => (info.kind || '').toLowerCase() === 'deployment')
        .map(([name]) => name)
        .sort();

    if (!deploymentNames.length) {
        select.innerHTML = '<option value="">Deployment yok</option>';
        return;
    }

    select.innerHTML = deploymentNames.map(name => `<option value="${name}">${name}</option>`).join('');
}

async function loadRolloutHistory() {
    const select = document.getElementById('rollout-deployment-select');
    const container = document.getElementById('rollout-history-list');
    if (!select || !container) return;

    const deployment = select.value;
    if (!deployment) {
        container.innerHTML = '<p class="loading">Deployment seçin.</p>';
        return;
    }

    try {
        const data = await apiRequest(`/api/k8s/rollout/${deployment}/history`);
        if (data.error) {
            container.innerHTML = `<p class="loading">${data.error}</p>`;
            return;
        }
        const items = data.items || [];
        if (!items.length) {
            container.innerHTML = '<p class="loading">Revision geçmişi bulunamadı.</p>';
            return;
        }

        container.innerHTML = items.map(item => `
            <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-content">
                    <div class="timeline-text"><strong>Revizyon:</strong> ${item.revision} • <strong>Image:</strong> ${item.image}</div>
                    <div class="timeline-time">${item.created || ''}</div>
                    <div style="margin-top:0.5rem;">
                        <button class="btn btn-secondary btn-sm" onclick="rollbackDeployment('${deployment}', '${item.revision}')">
                            <i class="fas fa-rotate-left"></i> Bu revizyona dön
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = `<p class="loading">Rollout geçmişi hatası: ${error.message}</p>`;
    }
}

async function restartSelectedDeployment() {
    const select = document.getElementById('rollout-deployment-select');
    if (!select || !select.value) {
        showAlert('Önce deployment seçin', 'warning');
        return;
    }

    try {
        const data = await apiRequest(`/api/k8s/rollout/${select.value}/restart`, { method: 'POST' });
        if (data.error) {
            showAlert('Restart hatası: ' + data.error, 'danger');
            return;
        }
        showAlert(data.message || 'Deployment restart tetiklendi', 'success');
    } catch (error) {
        showAlert('Restart hatası: ' + error.message, 'danger');
    }
}

async function rollbackDeployment(deployment, revision) {
    const ok = await confirmDangerousAction({
        message: `${deployment} deployment'u revision ${revision} sürümüne döndürülecek.`,
        detail: 'Bu işlem önceki sürüme geri dönüş sağlar. Geçici kesinti oluşabilir.'
    });
    if (!ok) return;

    try {
        const data = await apiRequest(`/api/k8s/rollout/${deployment}/rollback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision })
        });
        if (data.error) {
            showAlert('Rollback hatası: ' + data.error, 'danger');
            return;
        }
        showAlert(data.message || 'Rollback tamamlandı', 'success');
        setTimeout(loadRolloutHistory, 1200);
    } catch (error) {
        showAlert('Rollback hatası: ' + error.message, 'danger');
    }
}

async function restartAllServices() {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    const serviceNames = Object.keys(services || {}).filter(name => name !== 'log-management-ui');
    const ok = await confirmDangerousAction({
        message: 'Tüm servisler yeniden başlatılacak. Bu işlem sistemde geçici kesintiye neden olur.',
        detail: `${serviceNames.length} servis etkilenecek. Log toplama birkaç dakika kesintiye uğrayabilir. Devam etmek için ONAYLA yazın.`,
        requireType: true
    });
    if (!ok) return;
    if (!serviceNames.length) {
        showAlert('Yeniden başlatılacak servis bulunamadı', 'warning');
        return;
    }

    showAlert(`${serviceNames.length} servis için restart başlatıldı`, 'info');
    let successCount = 0;
    let fail = 0;

    for (const serviceName of serviceNames) {
        try {
            await apiRequest(`/api/service/${serviceName}/restart`, { method: 'POST' });
            successCount += 1;
        } catch (_) {
            fail += 1;
        }
    }

    showAlert(`Restart tamamlandı. Başarılı: ${successCount}, Hatalı: ${fail}`, fail ? 'warning' : 'success');
    overviewActionStatus.restartAll = {
        status: fail > 0 ? 'warning' : 'success',
        message: `Başarılı: ${successCount}, Hatalı: ${fail}`,
        timestamp: new Date().toISOString()
    };
    serviceActionStatus.bulk = {
        status: fail > 0 ? 'warning' : 'success',
        message: `Toplu restart • Başarılı: ${successCount}, Hatalı: ${fail}`,
        timestamp: new Date().toISOString()
    };
    renderOverviewOperationalIntelligence();
    renderServicesCommandCenter();
    setTimeout(loadServices, 1500);
}

async function restartProblematicServices() {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    const problematicServices = Object.entries(services || {})
        .filter(([name, info]) => name !== 'log-management-ui' && isCoreService(name) && isServiceProblematic(name, info))
        .map(([name]) => name);

    if (!problematicServices.length) {
        showAlert('Yeniden başlatılacak sorunlu servis bulunamadı', 'info');
        return;
    }

    const ok = await confirmDangerousAction({
        message: `${problematicServices.length} sorunlu servis yeniden başlatılacak.`,
        detail: `Servisler: ${problematicServices.join(', ')}. Bu işlem geçici kesintiye neden olabilir.`
    });
    if (!ok) return;

    showAlert(`${problematicServices.length} sorunlu servis için restart başlatıldı`, 'info');
    let successCount = 0;
    let fail = 0;

    for (const serviceName of problematicServices) {
        try {
            await apiRequest(`/api/service/${serviceName}/restart`, { method: 'POST' });
            successCount += 1;
        } catch (_) {
            fail += 1;
        }
    }

    const level = fail ? 'warning' : 'success';
    showAlert(`Sorunlu restart tamamlandı. Başarılı: ${successCount}, Hatalı: ${fail}`, level);

    serviceActionStatus.bulk = {
        status: fail ? 'warning' : 'success',
        message: `Sorunlu restart • Başarılı: ${successCount}, Hatalı: ${fail}`,
        timestamp: new Date().toISOString()
    };
    renderServicesCommandCenter();
    setTimeout(loadServices, 1200);
}

async function backupConfig() {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    try {
        showAlert('Yapılandırmaların yedeklemesi yapılıyor...', 'info');
        const data = await apiRequest('/api/backup', { method: 'POST' });
        showAlert(data.message || 'Yedekleme başarıyla tamamlandı', 'success');
        overviewActionStatus.backup = {
            status: 'success',
            message: data.message || 'Yedekleme tamamlandı',
            timestamp: new Date().toISOString()
        };
        renderOverviewOperationalIntelligence();
    } catch (error) {
        showAlert('Yedekleme hatası: ' + error.message, 'danger');
        overviewActionStatus.backup = {
            status: 'danger',
            message: error.message,
            timestamp: new Date().toISOString()
        };
        renderOverviewOperationalIntelligence();
    }
}

async function validateAllConfig() {
    if (!hasAtLeastRole('operator')) {
        showAlert('Bu işlem için operator rolü gerekli', 'warning');
        return;
    }
    try {
        showAlert('Yapılandırmalar doğrulanıyor...', 'info');
        const data = await apiRequest('/api/config/config-files-list');
        const files = (data.files || []).slice(0, 30);

        let valid = 0;
        let invalid = 0;
        let skipped = 0;

        for (const file of files) {
            try {
                const fileData = await apiRequest(`/api/config/${encodeURIComponent(file)}`);
                if (!fileData.content) {
                    skipped += 1;
                    continue;
                }

                const result = await apiRequest('/api/validate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: file, content: fileData.content })
                });

                if (result.valid) valid += 1;
                else invalid += 1;
            } catch (_) {
                skipped += 1;
            }
        }

        const level = invalid > 0 ? 'warning' : 'success';
        showAlert(`Doğrulama tamamlandı • Geçerli: ${valid}, Hatalı: ${invalid}, Atlanan: ${skipped}`, level);
        overviewActionStatus.validation = {
            status: invalid > 0 ? 'warning' : 'success',
            message: `Geçerli: ${valid}, Hatalı: ${invalid}, Atlanan: ${skipped}`,
            timestamp: new Date().toISOString()
        };
        renderOverviewOperationalIntelligence();
    } catch (error) {
        showAlert('Toplu doğrulama hatası: ' + error.message, 'danger');
        overviewActionStatus.validation = {
            status: 'danger',
            message: error.message,
            timestamp: new Date().toISOString()
        };
        renderOverviewOperationalIntelligence();
    }
}

function filterServices() {
    updateServicesTable();
    renderServicesCommandCenter();
}

const CONTAINERS_IGNORE_FOR_HEALTH = new Set([
    'log-system-setup', 'graylog-post-init', 'tests-log-generator', 'log-gen'
]);

/** Docker'ın --namesiz `docker run` adları (ör. ecstatic_ramanujan); panelde servis sayılmamalı. */
function looksLikeDockerAdhocRandomName(name) {
    return /^[a-z]+_[a-z]+$/.test(name || '');
}

function isCoreService(name) {
    if (CONTAINERS_IGNORE_FOR_HEALTH.has(name)) return false;
    if (name.includes('log-system-setup') && name !== 'log-system-setup') return false;
    if (looksLikeDockerAdhocRandomName(name)) return false;
    return true;
}

async function loadMonitoringData() {
    try {
        const [obsData, health, allServices] = await Promise.all([
            apiRequest('/api/observability/metrics').catch(() => ({})),
            apiRequest('/api/health'),
            (services && Object.keys(services).length) ? Promise.resolve(services) : apiRequest('/api/services')
        ]);

        const coreEntries = Object.entries(allServices || {}).filter(([name]) => isCoreService(name));
        const total = coreEntries.length || 1;
        const running = coreEntries.filter(([, item]) => item.status === 'running').length;
        const stopped = coreEntries.filter(([name, item]) => !isHealthIgnoredService(name, item) && (item.status === 'exited' || item.status === 'stopped' || item.status === 'created' || item.status === 'paused')).length;
        const unhealthy = coreEntries.filter(([name, item]) => !isHealthIgnoredService(name, item) && item.health === 'unhealthy').length;
        const degraded = coreEntries.filter(([name, item]) => !isHealthIgnoredService(name, item) && item.status === 'degraded').length;

        // Gerçek CPU/RAM değil: çekirdek servislerin çalışma oranı ve unhealthy/durmuş cezası (eski UI yanlışlıkla ~70/60 gösteriyordu).
        const runningSharePct = Math.min(100, Math.round((running / total) * 100));
        const problemCount = unhealthy + stopped + degraded;
        const healthStressPct = Math.min(100, Math.round(problemCount * 12 + unhealthy * 15));

        const diskReal = obsData.diskUsagePercent != null ? obsData.diskUsagePercent : null;
        const diskApprox = diskReal != null ? diskReal : Math.min(100, Math.round((running / 14) * 50));

        const cpuBar = document.getElementById('cpu-usage');
        const memBar = document.getElementById('mem-usage');
        const diskBar = document.getElementById('disk-usage');
        const cpuVal = document.getElementById('cpu-value');
        const memVal = document.getElementById('mem-value');
        const diskVal = document.getElementById('disk-value');

        cpuBar.style.width = `${runningSharePct}%`;
        memBar.style.width = `${healthStressPct}%`;
        diskBar.style.width = `${diskApprox}%`;
        cpuVal.textContent = `${running} / ${total} servis ayakta (${runningSharePct}%)`;
        memVal.textContent = problemCount > 0
            ? `Unhealthy: ${unhealthy} • Durmuş: ${stopped} • risk çubuğu ≈${healthStressPct}%`
            : 'Sorun yok (unhealthy/durmuş yok)';
        diskVal.textContent = diskReal != null ? `${diskReal}%` : `${diskApprox}% (tahmini)`;

        renderMonitoringHealthChart({ running, stopped, unhealthy, degraded });
        loadObservabilityMetrics();
        markDataFreshness('monitoring');
    } catch (error) {
        console.error('Monitoring load error:', error);
    }
}

function renderMonitoringHealthChart(metrics) {
    const canvas = document.getElementById('healthChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const dataset = [
        Number(metrics.running || 0),
        Number(metrics.degraded || 0),
        Number(metrics.stopped || 0),
        Number(metrics.unhealthy || 0)
    ];

    const config = {
        type: 'doughnut',
        data: {
            labels: ['Running', 'Degraded', 'Stopped', 'Unhealthy'],
            datasets: [{
                data: dataset,
                backgroundColor: ['#10b981', '#f59e0b', '#6b7280', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            },
            cutout: '62%'
        }
    };

    if (monitoringHealthChart) {
        monitoringHealthChart.data.datasets[0].data = dataset;
        monitoringHealthChart.update();
        return;
    }

    monitoringHealthChart = new Chart(canvas, config);
}

async function loadContainerList() {
    const select = document.getElementById('container-logs-select');
    if (!select) return;
    try {
        const data = await apiRequest('/api/container-logs');
        if (data.containers && data.containers.length) {
            const current = select.value;
            select.innerHTML = '<option value="">Container seçin...</option>' +
                data.containers.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.status})</option>`).join('');
            if (data.containers.some(c => c.name === current)) select.value = current;
        } else {
            select.innerHTML = '<option value="">Container bulunamadı</option>';
        }
    } catch (e) {
        select.innerHTML = '<option value="">Yükleme hatası</option>';
    }
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function loadContainerLogs() {
    const select = document.getElementById('container-logs-select');
    const viewer = document.getElementById('container-logs-viewer');
    const tailSelect = document.getElementById('container-logs-tail');
    if (!select || !viewer || !select.value) {
        if (viewer) viewer.innerHTML = '<p class="loading">Önce bir container seçin.</p>';
        return;
    }
    viewer.innerHTML = '<p class="loading">Loglar yükleniyor...</p>';
    try {
        const tail = tailSelect ? parseInt(tailSelect.value || '200', 10) : 200;
        const data = await apiRequest(`/api/container-logs?container=${encodeURIComponent(select.value)}&tail=${tail}`);
        if (data.logs && data.logs.length) {
            viewer.innerHTML = data.logs.map(line =>
                `<div class="log-line">${escapeHtml(line)}</div>`
            ).join('');
        } else {
            viewer.innerHTML = '<p class="loading">Bu container için log kaydı yok.</p>';
        }
    } catch (e) {
        viewer.innerHTML = `<p class="loading">Hata: ${escapeHtml(e.message)}</p>`;
    }
}

async function loadLogs() {
    if (!hasAtLeastRole('operator')) {
        renderLogsPermissionDenied();
        return;
    }
    const viewer = document.getElementById('logs-viewer');
    if (!viewer) return;

    try {
        const data = await apiRequest('/api/audit/events?limit=1000');
        rawLogEvents = data.events || [];
        const actionSelect = document.getElementById('log-service-filter');
        const selectedAction = actionSelect?.value || '';
        const actions = Array.from(new Set(rawLogEvents.map(e => e.action).filter(Boolean))).sort();
        if (actionSelect) {
            const current = selectedAction;
            actionSelect.innerHTML = '<option value="">Tüm Olaylar</option>' +
                actions.map(action => `<option value="${action}">${action}</option>`).join('');
            if (actions.includes(current)) {
                actionSelect.value = current;
            }
        }
        logsPage = 1;
        applyLogsFiltersAndRender();
        markDataFreshness('logs');
    } catch (error) {
        viewer.innerHTML = `<p class="loading">Log yükleme hatası: ${error.message}</p>`;
    }
}

function applyLogsFiltersAndRender() {
    const selectedAction = document.getElementById('log-service-filter')?.value || '';
    const levelFilter = (document.getElementById('log-level-filter')?.value || '').toUpperCase();
    const searchQuery = (document.getElementById('logs-search-input')?.value || '').trim().toLowerCase();

    filteredLogEvents = (rawLogEvents || []).filter(event => {
        if (selectedAction && event.action !== selectedAction) return false;

        if (levelFilter) {
            if (levelFilter === 'ERROR' && event.status !== 'failed') return false;
            if (levelFilter === 'WARN' && event.status === 'success') return false;
            if (levelFilter === 'INFO' && event.status !== 'success') return false;
        }

        if (!searchQuery) return true;
        const details = event.details ? JSON.stringify(event.details) : '{}';
        const haystack = [
            event.timestamp || '',
            event.action || '',
            event.user || '',
            event.role || '',
            event.status || '',
            details
        ].join(' ').toLowerCase();

        return haystack.includes(searchQuery);
    });

    renderLogsSummary();
    renderLogsTable();
}

function renderLogsSummary() {
    const summary = document.getElementById('logs-summary');
    if (!summary) return;

    const stats = typeof dashboardUtils.calculateLogSummary === 'function'
        ? dashboardUtils.calculateLogSummary(rawLogEvents, filteredLogEvents)
        : {
            total: rawLogEvents.length,
            visible: filteredLogEvents.length,
            failed: filteredLogEvents.filter(event => event.status === 'failed').length,
            success: filteredLogEvents.filter(event => event.status === 'success').length
        };
    summary.textContent = `Toplam: ${stats.total} • Filtrelenen: ${stats.visible} • Başarılı: ${stats.success} • Hatalı: ${stats.failed}`;
}

function renderLogsTable() {
    const viewer = document.getElementById('logs-viewer');
    const pageIndicator = document.getElementById('logs-page-indicator');
    const prevBtn = document.getElementById('logs-prev-page');
    const nextBtn = document.getElementById('logs-next-page');
    if (!viewer) return;

    if (!filteredLogEvents.length) {
        viewer.innerHTML = '<p class="loading">Filtreye uygun log kaydı bulunamadı.</p>';
        if (pageIndicator) pageIndicator.textContent = 'Sayfa 1 / 1';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        return;
    }

    const pagination = typeof dashboardUtils.paginate === 'function'
        ? dashboardUtils.paginate(filteredLogEvents, logsPage, logsPageSize)
        : (() => {
            const totalPages = Math.max(1, Math.ceil(filteredLogEvents.length / logsPageSize));
            const page = Math.min(Math.max(1, logsPage), totalPages);
            const start = (page - 1) * logsPageSize;
            return {
                page,
                totalPages,
                start,
                pageItems: filteredLogEvents.slice(start, start + logsPageSize)
            };
        })();
    logsPage = pagination.page;
    const totalPages = pagination.totalPages;
    const pageItems = pagination.pageItems;

    const actionLabels = {
        'auth.login': 'Giriş',
        'auth.logout': 'Çıkış',
        'service.restart': 'Servis yeniden başlatma',
        'service.start': 'Servis başlatma',
        'service.stop': 'Servis durdurma',
        'config.save': 'Yapılandırma kaydetme',
        'backup.create': 'Yedek oluşturma',
        'users.upsert': 'Kullanıcı güncelleme',
        'ops.sanity': 'Sanity check',
        'ops.flow-test': 'Flow test',
        'ops.stream-repair': 'Stream onarımı',
        'settings.update': 'Ayar güncelleme',
        'archive.apply': 'Arşiv uygulama',
        'agent.token.create': 'Token oluşturma',
        'agent.token.revoke': 'Token iptali'
    };

    const formatDetailsPreview = (details) => {
        if (!details || typeof details !== 'object') return '-';
        const keys = Object.keys(details).filter(k => !['password', 'token', 'secret'].some(s => k.toLowerCase().includes(s)));
        if (keys.length === 0) return '-';
        const parts = keys.slice(0, 3).map(k => {
            const v = String(details[k]);
            return `${k}: ${v.length > 30 ? v.slice(0, 30) + '...' : v}`;
        });
        return parts.join(' • ');
    };

    const formatDetailsFull = (event) => {
        const parts = [];
        if (event.ip) parts.push(`IP: ${event.ip}`);
        const details = event.details;
        if (details && typeof details === 'object' && Object.keys(details).length > 0) {
            Object.keys(details).forEach(k => {
                parts.push(`${k}: ${typeof details[k] === 'object' ? JSON.stringify(details[k]) : details[k]}`);
            });
        }
        return parts.length ? parts.join('\n') : '-';
    };

    viewer.innerHTML = `
        <table class="logs-table">
            <thead>
                <tr>
                    <th style="width:1.8rem;"></th>
                    <th>Zaman</th>
                    <th>Seviye</th>
                    <th>Aksiyon</th>
                    <th>Kullanıcı</th>
                    <th>Rol</th>
                    <th>Detay</th>
                </tr>
            </thead>
            <tbody>
                ${pageItems.map((event, idx) => {
                    const isSuccess = event.status === 'success';
                    const level = isSuccess ? 'INFO' : 'ERROR';
                    const levelClass = isSuccess ? 'status-success' : 'status-danger';
                    const hasDetails = (event.ip) || (event.details && typeof event.details === 'object' && Object.keys(event.details).length > 0);
                    const preview = formatDetailsPreview(event.details);
                    const fullDetails = formatDetailsFull(event);
                    const rowId = `audit-row-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`;

                    return `
                        <tr data-row-id="${rowId}">
                            <td>${hasDetails ? `<span class="log-row-expand" data-expand="${rowId}" title="Detayı aç/kapat"><i class="fas fa-chevron-down"></i></span>` : ''}</td>
                            <td>${escapeHtml((event.timestamp || '-').replace('T', ' ').replace('Z', ''))}</td>
                            <td><span class="status-badge ${levelClass}">${level}</span></td>
                            <td><strong>${escapeHtml(actionLabels[event.action] || event.action || '-')}</strong></td>
                            <td>${escapeHtml(event.user || 'anonymous')}</td>
                            <td>${escapeHtml(event.role || '-')}</td>
                            <td><div class="log-details">${escapeHtml(preview)}</div></td>
                        </tr>
                        ${hasDetails ? `
                        <tr id="${rowId}" class="log-detail-row" style="display:none;">
                            <td></td>
                            <td colspan="6"><div class="log-detail-expanded">${escapeHtml(fullDetails)}</div></td>
                        </tr>
                        ` : ''}
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    viewer.querySelectorAll('.log-row-expand').forEach(el => {
        el.addEventListener('click', () => {
            const rowId = el.getAttribute('data-expand');
            const detailRow = document.getElementById(rowId);
            if (detailRow) {
                const isHidden = detailRow.style.display === 'none';
                detailRow.style.display = isHidden ? 'table-row' : 'none';
                el.querySelector('i').className = isHidden ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
            }
        });
    });

    if (pageIndicator) {
        pageIndicator.textContent = `Sayfa ${logsPage} / ${totalPages}`;
    }
    if (prevBtn) {
        prevBtn.disabled = logsPage <= 1;
    }
    if (nextBtn) {
        nextBtn.disabled = logsPage >= totalPages;
    }
}

function exportFilteredLogs() {
    if (!filteredLogEvents.length) {
        showAlert('Dışa aktarılacak log kaydı yok', 'warning');
        return;
    }

    const blob = new Blob([JSON.stringify(filteredLogEvents, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `audit-logs-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    showAlert('Filtrelenen loglar dışa aktarıldı', 'success');
}

// Utility functions
function showAlert(message, type = 'info') {
    const container = document.getElementById('alert-container');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
        ${String(message).replace(/</g, '&lt;')}
    `;
    if (container) {
        container.appendChild(alert);
        setTimeout(() => alert.remove(), 4500);
    } else {
        alert.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:10000;max-width:360px;';
        document.body.appendChild(alert);
        setTimeout(() => alert.remove(), 4500);
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
    }
}

function showHelp() {
    const modal = document.getElementById('help-modal');
    modal.classList.add('show');
    modal.style.display = 'flex';
}

function startAutoRefresh() {
    // Oturum canlı tutma - her 2 dakikada bir ping (session timeout önleme)
    setInterval(() => {
        if (document.visibilityState === 'visible') {
            apiRequest('/api/auth/me').then(d => { if (d && d.csrfToken) csrfToken = d.csrfToken; }).catch(() => {});
        }
    }, 120000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            apiRequest('/api/auth/me').then(d => { if (d && d.csrfToken) csrfToken = d.csrfToken; }).catch(() => {});
        }
    });

    autoRefreshInterval = setInterval(() => {
        loadSystemHealth();
        loadServices();
        const overviewTab = document.getElementById('overview');
        if (overviewTab && overviewTab.classList.contains('active')) {
            loadOpsSummary();
            loadOverviewIntelligence(false);
        }
        const monitoringTab = document.getElementById('monitoring');
        if (monitoringTab && monitoringTab.classList.contains('active')) {
            loadMonitoringData();
        }
    }, 30000); // Refresh every 30 seconds
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 's') {
            e.preventDefault();
            if (currentFile) saveConfig();
        }
    }
});

console.log('Dashboard JavaScript loaded successfully');
