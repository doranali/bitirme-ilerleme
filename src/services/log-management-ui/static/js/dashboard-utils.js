(function attachDashboardUtils(global) {
    const DashboardUtils = {
        parseIsoDate(value) {
            if (!value) return null;
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        },

        formatRelativeTime(value) {
            const date = DashboardUtils.parseIsoDate(value);
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
        },

        getFreshnessStatus(value) {
            const date = DashboardUtils.parseIsoDate(value);
            if (!date) {
                return { level: 'unknown', label: 'Henüz alınmadı', relative: '-' };
            }

            const ageSeconds = (Date.now() - date.getTime()) / 1000;
            if (ageSeconds <= 60) {
                return { level: 'success', label: 'Taze', relative: DashboardUtils.formatRelativeTime(value) };
            }
            if (ageSeconds <= 180) {
                return { level: 'warning', label: 'Gecikmeli', relative: DashboardUtils.formatRelativeTime(value) };
            }
            return { level: 'danger', label: 'Eski', relative: DashboardUtils.formatRelativeTime(value) };
        },

        formatActionSnapshot(snapshot) {
            if (!snapshot) return '-';
            const prefix = snapshot.status === 'success' ? '✓' : snapshot.status === 'warning' ? '⚠' : '✗';
            return `${prefix} ${snapshot.message} • ${DashboardUtils.formatRelativeTime(snapshot.timestamp)}`;
        },

        toFiniteNumber(value) {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        },

        parsePublishedTcpPorts(ports) {
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
        },

        isHealthIgnoredService(name = '', info = {}) {
            const labels = info.labels || {};
            const v = String(labels['com.log-system.health.ignore'] || labels['log_system.health.ignore'] || '').trim().toLowerCase();
            if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
            return false;
        },

        isServiceProblematic(name = '', info = {}) {
            if (DashboardUtils.isHealthIgnoredService(name, info)) return false;
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
        },

        getServiceIssueReason(info = {}) {
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
        },

        formatHostForHttpUrl(host) {
            const h = String(host || '').trim();
            if (!h) return '127.0.0.1';
            if (h.includes(':') && !h.startsWith('[')) {
                return `[${h}]`;
            }
            return h;
        },

        getServiceInterfaceLinks(serviceName, info = {}, baseHost) {
            const name = (serviceName || '').toLowerCase();
            const publishedTcp = DashboardUtils.parsePublishedTcpPorts(info.ports);
            if (!publishedTcp.length) return [];

            const rawHost = (baseHost && String(baseHost).trim())
                || (typeof window !== 'undefined' && window.location && window.location.hostname)
                || '127.0.0.1';
            const hostPart = DashboardUtils.formatHostForHttpUrl(rawHost);

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
        },

        settingGroupKey(group) {
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
        },

        validateSettingValue(setting, rawValue) {
            const value = String(rawValue ?? '').trim();

            if (!setting) {
                return { valid: false, message: 'Ayar tanımı bulunamadı' };
            }

            if (setting.type === 'number') {
                if (!/^\d+$/.test(value)) {
                    return { valid: false, message: 'Sayısal bir değer girin' };
                }
                const numeric = Number(value);
                if (numeric < 0) {
                    return { valid: false, message: 'Değer 0 veya daha büyük olmalı' };
                }
                if (setting.key === 'SESSION_TIMEOUT_MINUTES' && (numeric < 5 || numeric > 1440)) {
                    return { valid: false, message: 'Oturum süresi 5 ile 1440 arasında olmalı' };
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
        },

        calculateLogSummary(rawLogEvents = [], filteredLogEvents = []) {
            const total = rawLogEvents.length;
            const visible = filteredLogEvents.length;
            const failed = filteredLogEvents.filter(event => event.status === 'failed').length;
            const success = filteredLogEvents.filter(event => event.status === 'success').length;
            return { total, visible, failed, success };
        },

        paginate(items = [], page = 1, pageSize = 50) {
            const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
            const safePage = Math.min(Math.max(1, page), totalPages);
            const start = (safePage - 1) * pageSize;
            const pageItems = items.slice(start, start + pageSize);
            return {
                page: safePage,
                totalPages,
                start,
                pageItems
            };
        }
    };

    global.DashboardUtils = DashboardUtils;
})(window);