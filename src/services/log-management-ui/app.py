#!/usr/bin/env python3
"""
Log Management System - Unified Dashboard
Tek dashboard üzerinden tüm sistem yönetimi
"""

import os
import errno
import json
import yaml
import difflib
import docker
import shlex
import subprocess
import shutil
import socket
import random
import re
import uuid
import time
import secrets
import hashlib
import ipaddress
from urllib.parse import urlparse, urlunparse
from docker import errors as docker_errors
from functools import wraps
from pathlib import Path
from datetime import datetime, timedelta
from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    redirect,
    url_for,
    flash,
    session,
    make_response,
)
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
import requests
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

from security_utils import (
    configure_flask_security,
    csrf_protect,
    get_or_create_csrf_token,
    is_safe_config_path,
    validate_csrf_token,
)

try:
    from kubernetes import client as k8s_client, config as k8s_config
    from kubernetes.client.rest import ApiException
    k8s_lib_available = True
except Exception:
    k8s_client = None
    k8s_config = None
    ApiException = Exception
    k8s_lib_available = False

app = Flask(__name__)
app.secret_key = os.environ.get('MANAGEMENT_UI_SECRET_KEY') or os.environ.get('SECRET_KEY') or os.urandom(48).hex()
CORS(app)
configure_flask_security(app)

# Config paths - Use absolute paths from the host mounted volume
BASE_DIR = Path('/app/config')
CONFIG_PATHS = {
    'docker-compose': BASE_DIR / 'docker-compose.yml',
    'fluent-bit': BASE_DIR / 'fluent-bit',
    'grafana_config': BASE_DIR / 'grafana_config',
    'scripts': BASE_DIR / 'scripts',
    'certs': BASE_DIR / 'certs',
    'env': BASE_DIR / '.env'
}
# Panel genel sağlığı (kenar çubuğu «Çalışıyor»): yalnızca bunlar zorunlu. Diğerleri isteğe bağlı dizinler.
CONFIG_PATHS_HEALTH_REQUIRED = frozenset({'docker-compose', 'env'})
ENV_PATH = CONFIG_PATHS['env']
DATA_DIR = BASE_DIR / 'data'
AUDIT_LOG_PATH = BASE_DIR / 'audit' / 'events.jsonl'
AGENT_FLEET_PATH = BASE_DIR / 'agent-fleet'
AGENT_PROFILES_PATH = AGENT_FLEET_PATH / 'profiles.json'
AGENT_TOKENS_PATH = AGENT_FLEET_PATH / 'enrollment_tokens.json'
AGENT_NODES_PATH = AGENT_FLEET_PATH / 'nodes.json'

USERS_PATH = BASE_DIR / 'users.yaml'
SESSION_TIMEOUT_MINUTES = int(os.environ.get('SESSION_TIMEOUT_MINUTES', '60'))
ROLE_WEIGHTS = {
    'viewer': 1,
    'operator': 2,
    'admin': 3
}
PLATFORM_MODE = os.environ.get('PLATFORM_MODE', 'auto').lower()
K8S_NAMESPACE = os.environ.get('K8S_NAMESPACE', 'default')

PIPELINE_LATENCY_PROBE_CACHE = {
    'timestamp': None,
    'seconds': None,
    'status': 'unknown',
    'note': 'Henüz ölçülmedi'
}

# Panel «Sanity check» — docker-compose.yml ile uyum:
# - opensearch2/3 yalnızca «opensearch-cluster» profiliyle başlar; log yoğunluğu bunu OTOMATİK açmaz (operatör seçimi).
# - Varsayılan: opensearch1 + OPENSEARCH_DISCOVERY_TYPE=single-node (Kafka’daki 3 broker’dan farklı model).
SANITY_REQUIRED_SERVICES_BASE = frozenset({
    'mongodb', 'kafka1', 'kafka2', 'kafka3', 'opensearch1', 'graylog', 'fluent-bit', 'log-management-ui',
})
SANITY_OPENSEARCH_CLUSTER_NODES = frozenset({'opensearch2', 'opensearch3'})
# Bu servislerin konteyneri varsa çalışır olmalı; hiç oluşturulmadıysa (minimal kurulum) kontrol dışı.
SANITY_AUXILIARY_IF_PRESENT = frozenset({
    'grafana', 'alert-webhook', 'watchdog', 'signing-engine',
})

# docker-compose.yml container_name değerleri (+ dinamik simülasyon). Host'taki `docker run` çöpleri (ecstatic_ramanujan vb.) listede yok.
COMPOSE_STACK_CONTAINER_NAMES = frozenset({
    'log-system-setup', 'mongodb', 'kafka1', 'kafka2', 'kafka3',
    'opensearch1', 'opensearch2', 'opensearch3', 'graylog', 'fluent-bit',
    'log-gen', 'log-signer-cron', 'graylog-post-init', 'watchdog',
    'alert-webhook', 'signing-engine', 'nginx-proxy-manager', 'minio',
    'grafana', 'log-management-ui', 'simulated-log-producer',
})

# dashboard.js CONTAINERS_IGNORE_FOR_HEALTH ile aynı mantık
CONTAINER_NAMES_IGNORED_FOR_HEALTH = frozenset({
    'log-system-setup', 'graylog-post-init', 'tests-log-generator', 'log-gen',
})


def _looks_like_docker_adhoc_random_name(name: str) -> bool:
    return bool(re.fullmatch(r'[a-z]+_[a-z]+', (name or '').strip()))


def panel_counts_service_for_health_summary(name: str, _labels: dict | None) -> bool:
    """dashboard.js isCoreService ile uyumlu: özet sayımlara hangi konteynerler dahil."""
    if not name:
        return False
    if name in CONTAINER_NAMES_IGNORED_FOR_HEALTH:
        return False
    if 'log-system-setup' in name and name != 'log-system-setup':
        return False
    if _looks_like_docker_adhoc_random_name(name):
        return False
    return True


def health_ignore_intentional_stop(_name: str, labels: dict | None) -> bool:
    """docker-compose labels: com.log-system.health.ignore=true — kasıtlı durdurulan servis sorun sayılmaz."""
    labels = labels or {}
    v = labels.get('com.log-system.health.ignore') or labels.get('log_system.health.ignore')
    return str(v or '').strip().lower() in ('1', 'true', 'yes', 'on')


def stack_health_metrics_from_services(services_status: dict) -> dict:
    """Çalışan / toplam / gerçekten sorunlu (kasıtlı durdurulanlar hariç)."""
    running = total = problematic = 0
    if not isinstance(services_status, dict) or services_status.get('error'):
        return {'running': running, 'total': total, 'problematic': problematic}
    for name, item in services_status.items():
        if not isinstance(item, dict):
            continue
        labels = item.get('labels') or {}
        if not panel_counts_service_for_health_summary(name, labels):
            continue
        total += 1
        st = str(item.get('status', '')).lower()
        hc = str(item.get('health', '')).lower()
        if st == 'running':
            running += 1
        is_bad = st in ('exited', 'stopped', 'dead', 'degraded', 'created', 'paused') or hc == 'unhealthy'
        if is_bad and not health_ignore_intentional_stop(name, labels):
            problematic += 1
    return {'running': running, 'total': total, 'problematic': problematic}

# Servis bind mount du özetleri (panel /api/services/storage); grow sonrası sıfırlanır
_SERVICE_STORAGE_USAGE_CACHE = {'ts': 0.0, 'payload': None}


def _invalidate_service_storage_usage_cache():
    _SERVICE_STORAGE_USAGE_CACHE['ts'] = 0.0
    _SERVICE_STORAGE_USAGE_CACHE['payload'] = None


def _include_container_in_service_dashboard(container) -> bool:
    """Yalnızca bu stack'e ait konteynerler; rastgele adlı docker run ve compose run (oneoff) kayıtlarını ele."""
    try:
        name = (container.name or '').strip()
        labels = container.labels or {}
        if labels.get('com.docker.compose.oneoff') == 'True':
            return False
        if labels.get('com.docker.compose.service'):
            return True
        return name in COMPOSE_STACK_CONTAINER_NAMES
    except Exception:
        return False


def _docker_client_error_is_missing_container(err: Exception) -> bool:
    """list() sonrası recreate ile silinen konteyner: NotFound / 404 / daemon mesajı."""
    if isinstance(err, docker_errors.NotFound):
        return True
    if isinstance(err, docker_errors.APIError):
        if getattr(err, 'status_code', None) == 404:
            return True
        resp = getattr(err, 'response', None)
        if resp is not None and getattr(resp, 'status_code', None) == 404:
            return True
    msg = str(err).lower()
    if 'no such container' in msg:
        return True
    if '404' in msg and ('not found' in msg or 'client error' in msg):
        return True
    try:
        import requests
        if isinstance(err, requests.exceptions.HTTPError):
            r = getattr(err, 'response', None)
            if r is not None and getattr(r, 'status_code', None) == 404:
                return True
    except Exception:
        pass
    return False


def _docker_reload_container_or_skip(container) -> bool:
    """True if container still exists. False if removed between list() and inspect (compose replace race)."""
    try:
        container.reload()
        return True
    except docker_errors.NotFound:
        return False
    except docker_errors.APIError as e:
        if _docker_client_error_is_missing_container(e):
            return False
        raise
    except Exception as e:
        if _docker_client_error_is_missing_container(e):
            return False
        raise


STREAM_DEFLECTOR_INDEX_SET_IDS = [
    '69a1927a9aa34144cc9f2524',
    '69a1927a9aa34144cc9f2520',
    '6996b23a2c49be26e49251a9',
    '6996b2362c49be26e492512e',
    '6996b23a2c49be26e49251ab'
]


def _utc_now_iso():
    return datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def _safe_read_json(path: Path, default_value):
    try:
        if not path.exists():
            return default_value
        with open(path, 'r') as f:
            data = json.load(f)
        return data
    except Exception:
        return default_value


def _safe_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + '.tmp')
    with open(tmp_path, 'w') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def _token_digest(raw_token: str):
    return hashlib.sha256(raw_token.encode('utf-8')).hexdigest()


def _agent_profile_catalog():
    builtins = [
        {
            'id': 'linux-agent-v1',
            'name': 'Linux Agent (One-Click)',
            'type': 'agent',
            'platform': 'linux',
            'transport': 'udp-json',
            'description': 'Linux host üzerine Fluent Bit kurar, logları otomatik toplayıp merkeze yollar.',
            'defaults': {
                'ingestPort': 5151,
                'companyId': 'default',
                'siteId': 'default-site',
                'logType': 'system'
            }
        },
        {
            'id': 'syslog-relay-v1',
            'name': 'Syslog Relay Gateway',
            'type': 'relay',
            'platform': 'linux',
            'transport': 'syslog-to-udp-json',
            'description': 'Ajan kurulamayan firewall/switch loglarını syslog ile alır ve merkeze dönüştürerek iletir. (Linux üzerinde çalışır.)',
            'defaults': {
                'relayUdpPort': 1514,
                'relayTcpPort': 1514,
                'ingestPort': 5151,
                'companyId': 'default',
                'siteId': 'default-site',
                'logType': 'network'
            }
        },
        {
            'id': 'windows-agent-v1',
            'name': 'Windows Agent (PowerShell)',
            'type': 'agent',
            'platform': 'windows',
            'transport': 'udp-json',
            'description': 'Windows sunucu veya iş istasyonunda Fluent Bit kurar; Olay Günlüğü (Application/System/Security) merkeze JSON/UDP ile gider.',
            'defaults': {
                'ingestPort': 5151,
                'companyId': 'default',
                'siteId': 'default-site',
                'logType': 'system'
            }
        }
    ]
    custom = _safe_read_json(AGENT_PROFILES_PATH, [])
    if not isinstance(custom, list):
        custom = []
    return builtins + custom


def _find_agent_profile(profile_id: str):
    for profile in _agent_profile_catalog():
        if profile.get('id') == profile_id:
            return profile
    return None


def _normalize_host(raw_host: str):
    value = str(raw_host or '').strip()
    if not value:
        return ''
    value = value.split(':')[0]
    if value in ('localhost', '127.0.0.1'):
        return ''
    if len(value) > 255:
        return ''
    if not re.match(r'^[a-zA-Z0-9._:-]+$', value):
        return ''
    return value


def _resolve_service_link_host():
    """Browser-facing hostname for Docker-published UI ports (Graylog, NPM, …).

    Prefer LOG_PLATFORM_PUBLIC_HOST when set (reverse proxy / split DNS).
    Otherwise use the Host header from the panel request (works for LAN IP / DNS).
    """
    env_host = _normalize_host(os.environ.get('LOG_PLATFORM_PUBLIC_HOST', ''))
    if env_host:
        return env_host
    host_header = request.host.split(':')[0] if request.host else ''
    normalized = _normalize_host(host_header)
    if normalized:
        return normalized
    return '127.0.0.1'


def _public_app_base_url() -> str:
    """Tam panel tabanı URL (kurulum linkleri, Linux MANAGEMENT_API, Windows $LpApi).

    Öncelik: LOG_PLATFORM_PUBLIC_BASE_URL → LOG_PLATFORM_PUBLIC_HOST + LOG_PLATFORM_PUBLIC_SCHEME
    → istek (url_root + X-Forwarded-Proto). Ters vekil arkasında BASE_URL veya HOST+SCHEME önerilir.
    """
    bu = (os.environ.get('LOG_PLATFORM_PUBLIC_BASE_URL') or '').strip().rstrip('/')
    if bu:
        return bu
    ph = _normalize_host(os.environ.get('LOG_PLATFORM_PUBLIC_HOST', ''))
    if ph:
        sch = (os.environ.get('LOG_PLATFORM_PUBLIC_SCHEME') or 'https').strip().lower()
        if sch not in ('http', 'https'):
            sch = 'https'
        return f'{sch}://{ph}'
    raw = (request.url_root or '').rstrip('/')
    if not raw:
        return 'http://127.0.0.1:8080'
    xf = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    if xf in ('http', 'https'):
        parsed = urlparse(raw + '/')
        if parsed.scheme and parsed.netloc:
            raw = urlunparse((xf, parsed.netloc, '', '', '', '')).rstrip('/')
    return raw


def _resolve_ingest_host(payload):
    explicit = _normalize_host(payload.get('ingestHost')) if isinstance(payload, dict) else ''
    if explicit:
        return explicit

    host_header = request.host.split(':')[0] if request.host else ''
    normalized = _normalize_host(host_header)
    if normalized:
        return normalized

    env_host = _normalize_host(os.environ.get('LOG_PLATFORM_PUBLIC_HOST', ''))
    if env_host:
        return env_host

    return '127.0.0.1'


def _new_enrollment_token(profile_id, payload):
    profile = _find_agent_profile(profile_id)
    if not profile:
        raise RuntimeError('unknown profile')

    defaults = profile.get('defaults', {})
    ingest_host = _resolve_ingest_host(payload)
    ingest_port = int(payload.get('ingestPort') or defaults.get('ingestPort') or 5151)
    ttl_minutes = int(payload.get('ttlMinutes') or 60)
    ttl_minutes = max(5, min(ttl_minutes, 24 * 60))

    company_id = str(payload.get('companyId') or defaults.get('companyId') or 'default').strip() or 'default'
    site_id = str(payload.get('siteId') or defaults.get('siteId') or 'default-site').strip() or 'default-site'
    log_type = str(payload.get('logType') or defaults.get('logType') or 'generic').strip() or 'generic'

    metadata = {
        'ingestHost': ingest_host,
        'ingestPort': ingest_port,
        'companyId': company_id,
        'siteId': site_id,
        'logType': log_type,
        'relayUdpPort': int(payload.get('relayUdpPort') or defaults.get('relayUdpPort') or 1514),
        'relayTcpPort': int(payload.get('relayTcpPort') or defaults.get('relayTcpPort') or 1514)
    }

    raw_token = secrets.token_urlsafe(36)
    now = datetime.utcnow()
    token_record = {
        'id': str(uuid.uuid4()),
        'profileId': profile_id,
        'tokenHash': _token_digest(raw_token),
        'status': 'pending',
        'createdAt': now.isoformat() + 'Z',
        'expiresAt': (now + timedelta(minutes=ttl_minutes)).isoformat() + 'Z',
        'ttlMinutes': ttl_minutes,
        'createdBy': session.get('username', 'unknown'),
        'maxActivations': 1,
        'activationCount': 0,
        'scriptDownloads': 0,
        'metadata': metadata,
        'lastSeenAt': None,
        'lastSeenIp': None,
        'activatedNode': None
    }
    return raw_token, token_record


def _load_tokens():
    payload = _safe_read_json(AGENT_TOKENS_PATH, {'tokens': []})
    tokens = payload.get('tokens', []) if isinstance(payload, dict) else []
    return tokens if isinstance(tokens, list) else []


def _save_tokens(tokens):
    _safe_write_json(AGENT_TOKENS_PATH, {'tokens': tokens})


def _find_token_record(raw_token):
    token_hash = _token_digest(raw_token)
    tokens = _load_tokens()
    for idx, item in enumerate(tokens):
        if item.get('tokenHash') == token_hash:
            return tokens, idx, item
    return tokens, -1, None


def _is_token_expired(record):
    try:
        expires_at = datetime.fromisoformat(str(record.get('expiresAt', '')).replace('Z', ''))
        return datetime.utcnow() > expires_at
    except Exception:
        return True


def _effective_enrollment_status(record):
    """Panel listeleri için: DB'de pending kalsa bile süresi dolmuşsa expired göster."""
    st = str(record.get('status') or 'unknown').strip().lower()
    if st in ('revoked', 'active', 'expired'):
        return st
    if _is_token_expired(record):
        return 'expired'
    return st if st else 'unknown'


def _render_linux_agent_script(record, raw_token):
    m = record.get('metadata', {})
    ingest_host = m.get('ingestHost', '127.0.0.1')
    ingest_port = int(m.get('ingestPort', 5151))
    company_id = m.get('companyId', 'default')
    site_id = m.get('siteId', 'default-site')
    log_type = m.get('logType', 'system')

    return f'''#!/usr/bin/env bash
# Log Platform - Fluent Bit Agent (Zero-Config Kurulum)
# Tüm Linux dağıtımlarında otomatik çalışır: Ubuntu, Debian, RHEL, CentOS, Rocky, Alma, Alpine
set -euo pipefail

PROFILE_ID="{record.get('profileId')}"
ENROLL_TOKEN="{raw_token}"
INGEST_HOST="{ingest_host}"
INGEST_PORT="{ingest_port}"
COMPANY_ID="{company_id}"
SITE_ID="{site_id}"
LOG_TYPE="{log_type}"
MANAGEMENT_API="{_public_app_base_url()}"

if [[ $EUID -ne 0 ]]; then
  echo "[ERROR] Bu kurulum root yetkisi gerektirir. sudo ile çalıştırın."
  exit 1
fi

install_fluent_bit() {{
  if command -v fluent-bit >/dev/null 2>&1; then
    echo "[OK] Fluent Bit zaten kurulu"
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "[INFO] Ubuntu/Debian tespit edildi..."
    apt-get update -qq
    apt-get install -y curl gpg ca-certificates
    curl -fsSL https://packages.fluentbit.io/fluentbit.key | gpg --dearmor -o /usr/share/keyrings/fluentbit-keyring.gpg
    codename=$(grep -oP '(?<=VERSION_CODENAME=).*' /etc/os-release 2>/dev/null || lsb_release -cs 2>/dev/null || echo "bookworm")
    echo "deb [signed-by=/usr/share/keyrings/fluentbit-keyring.gpg] https://packages.fluentbit.io/ubuntu/$codename $codename main" > /etc/apt/sources.list.d/fluent-bit.list
    apt-get update -qq && apt-get install -y fluent-bit
    return 0
  fi

  if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    echo "[INFO] RHEL/CentOS/Rocky/Alma tespit edildi..."
    cat > /etc/yum.repos.d/fluent-bit.repo <<'REPO'
[fluent-bit]
name=Fluent Bit
baseurl=https://packages.fluentbit.io/centos/$releasever/$basearch/
gpgcheck=1
gpgkey=https://packages.fluentbit.io/fluentbit.key
repo_gpgcheck=1
enabled=1
REPO
    (command -v dnf >/dev/null 2>&1 && dnf install -y fluent-bit) || yum install -y fluent-bit
    return 0
  fi

  if command -v apk >/dev/null 2>&1; then
    echo "[INFO] Alpine tespit edildi..."
    apk add --no-cache fluent-bit
    return 0
  fi

  echo "[ERROR] Desteklenmeyen sistem. Ubuntu, Debian, RHEL, CentOS, Rocky, Alma veya Alpine kullanın."
  exit 2
}}

install_fluent_bit

mkdir -p /etc/fluent-bit /var/lib/fluent-bit/storage /var/log/fluent-bit
if [[ -f /etc/fluent-bit/fluent-bit.conf ]]; then
  cp /etc/fluent-bit/fluent-bit.conf /etc/fluent-bit/fluent-bit.conf.bak.$(date +%s)
fi

# Tüm yaygın log yolları (Ubuntu/Debian/RHEL/CentOS/Alpine - mevcut olanlar otomatik)
cat > /etc/fluent-bit/fluent-bit.conf <<CONF
[SERVICE]
    Flush                   1
    Daemon                  Off
    Log_Level               info
    HTTP_Server             On
    HTTP_Listen             0.0.0.0
    HTTP_Port               2021
    storage.path            /var/lib/fluent-bit/storage
    storage.sync            normal
    storage.checksum        Off
    storage.backlog.mem_limit 64M

[INPUT]
    Name                    tail
    Path                    /var/log/syslog
    Path                    /var/log/messages
    Path                    /var/log/auth.log
    Path                    /var/log/secure
    Path                    /var/log/*.log
    Tag                     edge.tail
    Refresh_Interval        5
    Rotate_Wait             30
    DB                      /var/lib/fluent-bit/tail.db
    Mem_Buf_Limit           32MB
    Skip_Long_Lines         On
    storage.type            filesystem

[FILTER]
    Name                    record_modifier
    Match                   *
    Record                  company_id $COMPANY_ID
    Record                  site_id $SITE_ID
    Record                  log_type $LOG_TYPE
    Record                  profile_id $PROFILE_ID

[OUTPUT]
    Name                    udp
    Match                   *
    Host                    $INGEST_HOST
    Port                    $INGEST_PORT
    Format                  json
    Retry_Limit             False
CONF

# Sistemctl (Alpine'de systemd yok)
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now fluent-bit 2>/dev/null || true
  echo "[OK] Fluent Bit servisi başlatıldı (systemd)"
else
  # Alpine: rc-service veya manuel
  if command -v rc-service >/dev/null 2>&1; then
    rc-service fluent-bit start 2>/dev/null || true
    rc-update add fluent-bit default 2>/dev/null || true
    echo "[OK] Fluent Bit servisi başlatıldı (OpenRC)"
  else
    fluent-bit -c /etc/fluent-bit/fluent-bit.conf &
    echo "[OK] Fluent Bit arka planda başlatıldı"
  fi
fi

HOSTNAME_VALUE=$(hostname -f 2>/dev/null || hostname)
curl -fsS -m 5 -X POST "$MANAGEMENT_API/api/agent/activate" \
  -H "Content-Type: application/json" \
  -d "{{\"token\":\"$ENROLL_TOKEN\",\"hostname\":\"$HOSTNAME_VALUE\",\"profile\":\"$PROFILE_ID\"}}" >/dev/null 2>&1 || true

echo "[OK] Fluent Bit agent kuruldu. Loglar: $INGEST_HOST:$INGEST_PORT"
echo "[INFO] Panel: $MANAGEMENT_API | Health: http://127.0.0.1:2021/api/v1/health"
'''


def _render_syslog_relay_script(record, raw_token):
    m = record.get('metadata', {})
    ingest_host = m.get('ingestHost', '127.0.0.1')
    ingest_port = int(m.get('ingestPort', 5151))
    company_id = m.get('companyId', 'default')
    site_id = m.get('siteId', 'default-site')
    log_type = m.get('logType', 'network')
    relay_udp_port = int(m.get('relayUdpPort', 1514))
    relay_tcp_port = int(m.get('relayTcpPort', 1514))

    return f'''#!/usr/bin/env bash
set -euo pipefail

PROFILE_ID="{record.get('profileId')}"
ENROLL_TOKEN="{raw_token}"
INGEST_HOST="{ingest_host}"
INGEST_PORT="{ingest_port}"
COMPANY_ID="{company_id}"
SITE_ID="{site_id}"
LOG_TYPE="{log_type}"
RELAY_UDP_PORT="{relay_udp_port}"
RELAY_TCP_PORT="{relay_tcp_port}"
MANAGEMENT_API="{_public_app_base_url()}"

if [[ $EUID -ne 0 ]]; then
  echo "[ERROR] Bu kurulum root yetkisi gerektirir"
  exit 1
fi

if ! command -v fluent-bit >/dev/null 2>&1; then
  echo "[INFO] fluent-bit kurulu değil, linux-agent profiliyle aynı paket reposu kullanılacak"
fi

curl -fsSL "$MANAGEMENT_API/api/agent/install/$ENROLL_TOKEN.sh?bootstrap=1" -o /tmp/fluent-bit-bootstrap.sh
bash /tmp/fluent-bit-bootstrap.sh --relay-only

mkdir -p /etc/fluent-bit /var/lib/fluent-bit/storage
cat > /etc/fluent-bit/fluent-bit.conf <<CONF
[SERVICE]
    Flush                   1
    Daemon                  Off
    Log_Level               info
    HTTP_Server             On
    HTTP_Listen             0.0.0.0
    HTTP_Port               2021
    storage.path            /var/lib/fluent-bit/storage
    storage.sync            normal
    storage.backlog.mem_limit 64M

[INPUT]
    Name                    syslog
    Mode                    udp
    Listen                  0.0.0.0
    Port                    $RELAY_UDP_PORT
    Parser                  syslog-rfc3164
    Tag                     relay.syslog

[INPUT]
    Name                    syslog
    Mode                    tcp
    Listen                  0.0.0.0
    Port                    $RELAY_TCP_PORT
    Parser                  syslog-rfc3164
    Tag                     relay.syslog

[FILTER]
    Name                    record_modifier
    Match                   relay.syslog
    Record                  company_id $COMPANY_ID
    Record                  site_id $SITE_ID
    Record                  log_type $LOG_TYPE
    Record                  profile_id $PROFILE_ID

[OUTPUT]
    Name                    udp
    Match                   relay.syslog
    Host                    $INGEST_HOST
    Port                    $INGEST_PORT
    Format                  json
    Retry_Limit             False
CONF

systemctl daemon-reload || true
systemctl enable --now fluent-bit

HOSTNAME_VALUE=$(hostname -f 2>/dev/null || hostname)
curl -fsS -X POST "$MANAGEMENT_API/api/agent/activate" \
  -H "Content-Type: application/json" \
  -d "{{\"token\":\"$ENROLL_TOKEN\",\"hostname\":\"$HOSTNAME_VALUE\",\"profile\":\"$PROFILE_ID\"}}" >/dev/null || true

echo "[OK] Syslog relay kuruldu. Firewall/Switch cihazlarını bu hostun UDP/TCP $RELAY_UDP_PORT portuna yönlendirin."
'''


def _render_windows_agent_ps1(record, raw_token):
    """PowerShell: Fluent Bit Windows zip, winlog input, UDP/JSON output, Windows service."""
    m = record.get('metadata', {})
    ingest_host = m.get('ingestHost', '127.0.0.1')
    ingest_port = int(m.get('ingestPort', 5151))
    company_id = m.get('companyId', 'default')
    site_id = m.get('siteId', 'default-site')
    log_type = m.get('logType', 'system')
    profile_id = record.get('profileId') or 'windows-agent-v1'
    management_api = _public_app_base_url()

    version = (os.environ.get('FLUENT_BIT_WINDOWS_VERSION') or '5.0.2').strip()
    zip_override = (os.environ.get('FLUENT_BIT_WINDOWS_ZIP_URL') or '').strip()
    zip_url = zip_override or f'https://packages.fluentbit.io/windows/fluent-bit-{version}-win64.zip'
    service_name = (os.environ.get('FLUENT_BIT_WINDOWS_SERVICE_NAME') or 'LogPlatformFluentBit').strip()
    # Gecikmeli otostart bazı ortamlarda SCM’nin servisi başlatmasını bozabiliyor; güvenilir kurulum için varsayılan kapalı.
    win_delayed = os.environ.get('FLUENT_BIT_WINDOWS_DELAYED_START', '0').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    # depend= Tcpip nadiren «Cannot start service» üretebiliyor; istenirse .env ile açılır.
    win_depend_tcp = os.environ.get('FLUENT_BIT_WINDOWS_SERVICE_DEPEND_TCP', '0').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    # Security kanalı bazı sunucularda ek izin / gürültü; CSV: Application,System veya Application,System,Security
    win_channels = (os.environ.get('FLUENT_BIT_WINDOWS_EVENT_CHANNELS') or 'Application,System').strip()

    def _ps_sq(value):
        return str(value).replace("'", "''")

    # token_urlsafe: no single quotes; still escape for safety
    t_lit = _ps_sq(raw_token)
    return (
        "# Log Platform - Fluent Bit Windows agent (enrollment)\n"
        "#Requires -Version 5.1\n"
        "$ErrorActionPreference = 'Stop'\n"
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\n"
        f"$LpToken = '{t_lit}'\n"
        f"$LpIngestHost = '{_ps_sq(ingest_host)}'\n"
        f"$LpIngestPort = {ingest_port}\n"
        f"$LpCompany = '{_ps_sq(company_id)}'\n"
        f"$LpSite = '{_ps_sq(site_id)}'\n"
        f"$LpLogType = '{_ps_sq(log_type)}'\n"
        f"$LpProfile = '{_ps_sq(profile_id)}'\n"
        f"$LpApi = '{_ps_sq(management_api)}'\n"
        f"$LpZipUrl = '{_ps_sq(zip_url)}'\n"
        f"$LpServiceName = '{_ps_sq(service_name)}'\n"
        f"$LpWinChannels = '{_ps_sq(win_channels)}'\n"
        "\n"
        "$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()\n"
        "if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {\n"
        "  Write-Error 'Yonetici PowerShell gerekli (Run as administrator).'\n"
        "  exit 1\n"
        "}\n"
        "\n"
        "$Data = Join-Path $env:ProgramData 'LogPlatformFluentBit'\n"
        "$Cache = Join-Path $env:TEMP ('LogPlatformFbZip_' + [Guid]::NewGuid().ToString('n'))\n"
        "# Program Files icinde bosluk Windows servis binPath kayitlarini bozabiliyor; surucu kokune kur.\n"
        "$InstallRoot = Join-Path $env:SystemDrive 'LogPlatformFluentBit'\n"
        "New-Item -ItemType Directory -Path $Data -Force | Out-Null\n"
        "New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null\n"
        "New-Item -ItemType Directory -Path $Cache -Force | Out-Null\n"
        "New-Item -ItemType Directory -Path (Join-Path $Data 'storage') -Force | Out-Null\n"
        "\n"
        "$zipPath = Join-Path $Cache 'fluent-bit.zip'\n"
        "Write-Host ('[INFO] Fluent Bit indiriliyor: ' + $LpZipUrl)\n"
        "Invoke-WebRequest -Uri $LpZipUrl -OutFile $zipPath -UseBasicParsing\n"
        "Expand-Archive -Path $zipPath -DestinationPath $Cache -Force\n"
        "\n"
        "$fbExe = Get-ChildItem -Path $Cache -Recurse -Filter 'fluent-bit.exe' | Select-Object -First 1\n"
        "if (-not $fbExe) { Write-Error 'Zip icinde fluent-bit.exe bulunamadi.'; exit 2 }\n"
        "$bundleRoot = $fbExe.Directory.Parent.FullName\n"
        "$srcConf = Join-Path $bundleRoot 'conf'\n"
        "$destConf = Join-Path $InstallRoot 'conf'\n"
        "if (-not (Test-Path $srcConf)) {\n"
        "  Write-Error 'Fluent Bit zip icinde conf klasoru bulunamadi; paket veya surum hatali olabilir.'\n"
        "  exit 2\n"
        "}\n"
        "Copy-Item -LiteralPath $srcConf -Destination $InstallRoot -Recurse -Force\n"
        "\n"
        "$dataUnix = ($Data -replace '\\\\', '/')\n"
        "$installUnix = ($InstallRoot -replace '\\\\', '/')\n"
        "$confPath = Join-Path $Data 'fluent-bit.conf'\n"
        "$LpMachine = $env:COMPUTERNAME\n"
        "$conf = @\"\n"
        "[SERVICE]\n"
        "    Flush                   5\n"
        "    Daemon                  Off\n"
        "    Log_Level               info\n"
        "    parsers_file            $installUnix/conf/parsers.conf\n"
        "    plugins_file            $installUnix/conf/plugins.conf\n"
        "    http_server             On\n"
        "    http_listen             0.0.0.0\n"
        "    http_port               2021\n"
        "    storage.path            $dataUnix/storage\n"
        "    storage.sync            normal\n"
        "    storage.backlog.mem_limit 64M\n"
        "\n"
        "[INPUT]\n"
        "    Name                    winlog\n"
        "    Channels                $LpWinChannels\n"
        "    Interval_Sec            1\n"
        "    DB                      $dataUnix/winlog.db\n"
        "\n"
        "[FILTER]\n"
        "    Name                    record_modifier\n"
        "    Match                   *\n"
        "    Record                  host $LpMachine\n"
        "    Record                  source $LpMachine\n"
        "    Record                  company_id $LpCompany\n"
        "    Record                  site_id $LpSite\n"
        "    Record                  log_type $LpLogType\n"
        "    Record                  profile_id $LpProfile\n"
        "\n"
        "[OUTPUT]\n"
        "    Name                    udp\n"
        "    Match                   *\n"
        "    Host                    $LpIngestHost\n"
        "    Port                    $LpIngestPort\n"
        "    Format                  json\n"
        "    Retry_Limit             False\n"
        "\"@\n"
        "$utf8NoBom = New-Object System.Text.UTF8Encoding $false\n"
        "[System.IO.File]::WriteAllText($confPath, $conf, $utf8NoBom)\n"
        "$pluginsCheck = Join-Path $destConf 'plugins.conf'\n"
        "if (-not (Test-Path $pluginsCheck)) {\n"
        "  Write-Error 'conf/plugins.conf kurulumda yok; Fluent Bit zip paketini veya FLUENT_BIT_WINDOWS_ZIP_URL degerini kontrol edin.'\n"
        "  exit 3\n"
        "}\n"
        "\n"
        "$targetBin = Join-Path $InstallRoot 'bin'\n"
        "New-Item -ItemType Directory -Path $targetBin -Force | Out-Null\n"
        "Copy-Item $fbExe.FullName (Join-Path $targetBin 'fluent-bit.exe') -Force\n"
        "Get-ChildItem -Path $fbExe.Directory.FullName -Filter '*.dll' -ErrorAction SilentlyContinue "
        "| ForEach-Object { Copy-Item $_.FullName (Join-Path $targetBin $_.Name) -Force }\n"
        "\n"
        "$exePath = Join-Path $targetBin 'fluent-bit.exe'\n"
        "# sc.exe: PowerShell & sc.exe a b c ile birlestirme argv'yi bozup USAGE basmasina yol acabiliyor; @args splat kullan.\n"
        "# Gorunen ad bosluksuz (Services listesinde); aciklama asagida sc description ile.\n"
        "$scCreateArgs = @(\n"
        "  'create',\n"
        "  $LpServiceName,\n"
        "  ('binPath= \"{0}\" -c \"{1}\"' -f $exePath, $confPath),\n"
        "  'DisplayName= LogPlatformFluentBit',\n"
        "  'start= auto'\n"
        ")\n"
        "$svc = Get-Service -Name $LpServiceName -ErrorAction SilentlyContinue\n"
        "if ($svc) {\n"
        "  Stop-Service -Name $LpServiceName -Force -ErrorAction SilentlyContinue\n"
        "  Start-Sleep -Seconds 2\n"
        "  sc.exe delete $LpServiceName | Out-Null\n"
        "  $t0 = Get-Date\n"
        "  while (((Get-Date) - $t0).TotalSeconds -lt 45) {\n"
        "    $qr = sc.exe query $LpServiceName 2>&1 | Out-String\n"
        "    if ($qr -match '1060' -or $qr -match 'DOES NOT EXIST' -or $qr -match 'specified service does not exist') { break }\n"
        "    Start-Sleep -Milliseconds 400\n"
        "  }\n"
        "  Start-Sleep -Seconds 2\n"
        "}\n"
        "$scOut = & sc.exe @scCreateArgs 2>&1\n"
        "if ($LASTEXITCODE -ne 0) {\n"
        "  $so = \"$scOut\"\n"
        "  if ($so -match '1073' -or $so -match 'already exists' -or $so -match 'zaten' -or $so -match 'already been run') {\n"
        "    Write-Warning '[INFO] Servis kaydi mevcut; silinip tekrar deneniyor...'\n"
        "    sc.exe delete $LpServiceName | Out-Null\n"
        "    Start-Sleep -Seconds 4\n"
        "    $scOut = & sc.exe @scCreateArgs 2>&1\n"
        "  }\n"
        "}\n"
        "if ($LASTEXITCODE -ne 0) {\n"
        "  Write-Host $scOut\n"
        "  Write-Error 'sc.exe create basarisiz (servis adi veya onceki kalinti). Gerekirse sunucuyu yeniden baslatin.'\n"
        "  exit 4\n"
        "}\n"
        'sc.exe description $LpServiceName "Log Platform Fluent Bit agent" | Out-Null\n'
        "sc.exe failure $LpServiceName reset= 86400 "
        "actions= restart/60000/restart/120000/restart/300000 | Out-Null\n"
        "sc.exe failureflag $LpServiceName 1 | Out-Null\n"
        + (
            "& sc.exe config $LpServiceName 'depend= Tcpip' | Out-Null\n"
            if win_depend_tcp
            else ''
        )
        + (
            "& sc.exe config $LpServiceName start= delayed-auto | Out-Null\n"
            if win_delayed
            else ''
        )
        + "Start-Sleep -Seconds 2\n"
        "$started = $false\n"
        "for ($i = 0; $i -lt 4; $i++) {\n"
        "  try {\n"
        "    Start-Service -Name $LpServiceName -ErrorAction Stop\n"
        "    $started = $true\n"
        "    break\n"
        "  } catch {\n"
        "    Start-Sleep -Seconds 2\n"
        "  }\n"
        "}\n"
        "if (-not $started) {\n"
        "  sc.exe start $LpServiceName | Out-Null\n"
        "  Start-Sleep -Seconds 2\n"
        "  $svcChk = Get-Service -Name $LpServiceName -ErrorAction SilentlyContinue\n"
        "  if ($svcChk -and $svcChk.Status -eq 'Running') { $started = $true }\n"
        "}\n"
        "if ($started) {\n"
        "  Write-Host ('[OK] Servis baslatildi: ' + $LpServiceName)\n"
        "} else {\n"
        "  Write-Warning ('Servis baslatilamadi; olay gunlugune bakin: Get-WinEvent -LogName System -MaxEvents 20 | Where-Object { $_.Message -like \"*LogPlatformFluentBit*\" -or $_.Message -like \"*fluent-bit*\" }')\n"
        "  Write-Host '[INFO] Tanilama: Fluent Bit birkac saniye calistiriliyor (stderr)...'\n"
        "  $errF = Join-Path $env:TEMP 'LogPlatformFluentBit-stderr.txt'\n"
        "  $outF = Join-Path $env:TEMP 'LogPlatformFluentBit-stdout.txt'\n"
        "  Remove-Item $errF, $outF -ErrorAction SilentlyContinue\n"
        "  $pr = Start-Process -FilePath $exePath -ArgumentList @('-c', $confPath) -WorkingDirectory $targetBin "
        "-PassThru -WindowStyle Hidden -RedirectStandardError $errF -RedirectStandardOutput $outF\n"
        "  Start-Sleep -Seconds 5\n"
        "  if ($pr -and -not $pr.HasExited) { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue }\n"
        "  if (Test-Path $errF) { $t = Get-Content $errF -Raw -ErrorAction SilentlyContinue; if ($t) { Write-Host $t } }\n"
        "  Write-Host '[IPUCU] Visual C++ Redistributable x64 yuklu olmali. Guvenlik gunlugu gerekirse panel ortaminda "
        "FLUENT_BIT_WINDOWS_EVENT_CHANNELS=Application,System,Security kullanin (varsayilan: Application,System).'\n"
        "  Write-Host '[IPUCU] sc delete sonrasi bazen yeniden baslatma gerekir. Panel .env: FLUENT_BIT_WINDOWS_SERVICE_DEPEND_TCP=0 (varsayilan), DELAYED_START=0.'\n"
        "  Write-Error 'Fluent Bit Windows servisi baslatilamadi.'\n"
        "}\n"
        "\n"
        "try {\n"
        "  $body = @{ token = $LpToken; hostname = $env:COMPUTERNAME; profile = $LpProfile } | ConvertTo-Json\n"
        "  Invoke-RestMethod -Uri ($LpApi.TrimEnd('/') + '/api/agent/activate') -Method Post "
        "-ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 15 | Out-Null\n"
        "  Write-Host '[OK] Merkeze aktivasyon gonderildi.'\n"
        "} catch {\n"
        "  Write-Warning ('Aktivasyon istegi basarisiz (ag/firewall): ' + $_.Exception.Message)\n"
        "}\n"
        "\n"
        "$LpHbScript = Join-Path $Data 'LogPlatformHeartbeat.ps1'\n"
        "Set-Content -LiteralPath $LpHbScript -Encoding UTF8 -Value @'\n"
        "$ErrorActionPreference = 'SilentlyContinue'\n"
        "try {\n"
        f"  $body = @{{ token = '{t_lit}'; hostname = $env:COMPUTERNAME; status = 'ok' }} | ConvertTo-Json\n"
        f"  $api = '{_ps_sq(management_api)}'\n"
        "  Invoke-RestMethod -Uri ($api.TrimEnd('/') + '/api/agent/heartbeat') -Method Post "
        "-Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 25 | Out-Null\n"
        "} catch {}\n"
        "'@\n"
        "Unregister-ScheduledTask -TaskName 'LogPlatformAgentHeartbeat' -Confirm:$false "
        "-ErrorAction SilentlyContinue | Out-Null\n"
        "$argHb = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $LpHbScript + '\"'\n"
        "$actionHb = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argHb\n"
        "$triggerHb = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval "
        "(New-TimeSpan -Minutes 3) -RepetitionDuration ([TimeSpan]::MaxValue)\n"
        "$principalHb = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' "
        "-LogonType ServiceAccount -RunLevel Highest\n"
        "try {\n"
        "  Register-ScheduledTask -TaskName 'LogPlatformAgentHeartbeat' -Action $actionHb "
        "-Trigger $triggerHb -Principal $principalHb -Force | Out-Null\n"
        "  Write-Host '[OK] Heartbeat gorevi: her 3 dk (LogPlatformAgentHeartbeat).'\n"
        "} catch {\n"
        "  Write-Warning ('Heartbeat gorevi eklenemedi: ' + $_.Exception.Message)\n"
        "}\n"
        "try { & $LpHbScript } catch {}\n"
        "\n"
        "Write-Host ('[OK] Kurulum tamam. Hedef UDP: ' + $LpIngestHost + ':' + $LpIngestPort)\n"
        "Remove-Item -Path $Cache -Recurse -Force -ErrorAction SilentlyContinue\n"
    )


def _render_installer_ps1(record, raw_token):
    profile_id = record.get('profileId')
    if profile_id != 'windows-agent-v1':
        return None
    return _render_windows_agent_ps1(record, raw_token)


def _render_windows_uninstall_ps1(raw_token: str) -> str:
    """PowerShell: Windows Fluent Bit servisi, heartbeat görevi ve kurulum dizinlerini kaldırır; panele bildirir."""
    service_name = (os.environ.get('FLUENT_BIT_WINDOWS_SERVICE_NAME') or 'LogPlatformFluentBit').strip()
    management_api = _public_app_base_url()

    def _ps_sq(value):
        return str(value).replace("'", "''")

    t_lit = _ps_sq(raw_token)
    return (
        "# Log Platform - Windows agent kaldirma (kurulumda kullandiginiz enrollment token ile)\n"
        "#Requires -Version 5.1\n"
        "$ErrorActionPreference = 'Stop'\n"
        f"$LpToken = '{t_lit}'\n"
        f"$LpApi = '{_ps_sq(management_api)}'\n"
        f"$LpServiceName = '{_ps_sq(service_name)}'\n"
        "\n"
        "$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()\n"
        "if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {\n"
        "  Write-Error 'Yonetici PowerShell gerekli (Run as administrator).'\n"
        "  exit 1\n"
        "}\n"
        "\n"
        "Write-Host ('[INFO] Servis durduruluyor: ' + $LpServiceName)\n"
        "Stop-Service -Name $LpServiceName -Force -ErrorAction SilentlyContinue\n"
        "Start-Sleep -Seconds 2\n"
        "sc.exe delete $LpServiceName | Out-Null\n"
        "Unregister-ScheduledTask -TaskName 'LogPlatformAgentHeartbeat' -Confirm:$false "
        "-ErrorAction SilentlyContinue | Out-Null\n"
        "$dataDir = Join-Path $env:ProgramData 'LogPlatformFluentBit'\n"
        "$installDir = Join-Path $env:SystemDrive 'LogPlatformFluentBit'\n"
        "if (Test-Path -LiteralPath $dataDir) {\n"
        "  Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue\n"
        "}\n"
        "if (Test-Path -LiteralPath $installDir) {\n"
        "  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue\n"
        "}\n"
        "Remove-Item (Join-Path $env:TEMP 'LogPlatformAgentInstall.ps1') -Force -ErrorAction SilentlyContinue\n"
        "Remove-Item (Join-Path $env:TEMP 'LogPlatformAgentUninstall.ps1') -Force -ErrorAction SilentlyContinue\n"
        "\n"
        "try {\n"
        "  $body = @{ token = $LpToken; hostname = $env:COMPUTERNAME; reason = 'user_uninstall' } | ConvertTo-Json\n"
        "  Invoke-RestMethod -Uri ($LpApi.TrimEnd('/') + '/api/agent/uninstall-notify') -Method Post "
        "-ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 25 | Out-Null\n"
        "  Write-Host '[OK] Merkez panele kaldirma bildirimi gonderildi (Loglar > Audit).'\n"
        "} catch {\n"
        "  Write-Warning ('Bildirim gonderilemedi (ag/firewall): ' + $_.Exception.Message)\n"
        "}\n"
        "Write-Host '[OK] Log Platform Windows ajan bu makineden kaldirildi.'\n"
    )


def _render_installer_script(record, raw_token):
    profile_id = record.get('profileId')
    bootstrap_only = str(request.args.get('bootstrap') or '').strip() == '1'
    if bootstrap_only:
        bootstrap = {
            **record,
            'profileId': 'linux-agent-v1'
        }
        return _render_linux_agent_script(bootstrap, raw_token)
    if profile_id == 'syslog-relay-v1':
        return _render_syslog_relay_script(record, raw_token)
    return _render_linux_agent_script(record, raw_token)


def _is_dev_mode():
    """Dev ortamında mı (varsayılan admin/admin123! kullanılacak)."""
    return (
        os.environ.get('FLASK_ENV', '').lower() == 'development'
        or os.environ.get('PLATFORM_MODE', '').lower() == 'dev'
        or os.environ.get('DEV_DEFAULT_CREDENTIALS', '').lower() in ('1', 'true', 'yes')
        or os.environ.get('LOG_SYSTEM_RELEASE_TAG', '').lower() == 'dev'
        or os.environ.get('APP_ENV', '').lower() == 'dev'
        or os.environ.get('LOG_SYSTEM_ENV', '').lower() == 'dev'
    )


def ensure_dev_admin():
    """Dev ortamında admin/admin123! ile girişi garanti et."""
    if not _is_dev_mode():
        return
    try:
        users = load_users()
        admin_user = next((u for u in users if u.get('username') == 'admin'), None)
        default_pass = os.environ.get('DEFAULT_ADMIN_PASSWORD', 'admin123!')
        if admin_user and not check_password_hash(admin_user.get('password_hash', ''), default_pass):
            admin_user['password_hash'] = generate_password_hash(default_pass)
            save_users(users)
            print(f"[DEV] admin parolası '{default_pass}' ile sıfırlandı.")
        elif not admin_user:
            users.append({
                'username': 'admin',
                'password_hash': generate_password_hash(default_pass),
                'role': 'admin',
                'enabled': True
            })
            save_users(users)
            print(f"[DEV] admin kullanıcısı oluşturuldu (parola: {default_pass}).")
    except Exception as e:
        print(f"[DEV] ensure_dev_admin uyarısı: {e}")


def load_users():
    if not USERS_PATH.exists():
        USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
        default_payload = {
            'users': [
                {
                    'username': os.environ.get('DEFAULT_ADMIN_USER', 'admin'),
                    'password_hash': generate_password_hash(
                        os.environ.get('DEFAULT_ADMIN_PASSWORD', 'admin123!')
                    ),
                    'role': 'admin',
                    'enabled': True
                }
            ]
        }
        with open(USERS_PATH, 'w') as f:
            yaml.safe_dump(default_payload, f, sort_keys=False)

    with open(USERS_PATH, 'r') as f:
        payload = yaml.safe_load(f) or {}

    return payload.get('users', [])


def save_users(users):
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(USERS_PATH, 'w') as f:
        yaml.safe_dump({'users': users}, f, sort_keys=False)


def audit_event(action, status='success', details=None):
    try:
        AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'user': session.get('username', 'anonymous'),
            'role': session.get('role', 'viewer'),
            'action': action,
            'status': status,
            'details': details or {},
            'ip': request.headers.get('X-Forwarded-For', request.remote_addr)
        }
        with open(AUDIT_LOG_PATH, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception as e:
        print(f"Warning: audit log write failed: {e}")


def read_audit_events(limit=200):
    if not AUDIT_LOG_PATH.exists():
        return []
    events = []
    with open(AUDIT_LOG_PATH, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                continue
    events.reverse()
    return events[:limit]


def get_user(username):
    users = load_users()
    for user in users:
        if user.get('username') == username and user.get('enabled', True):
            return user
    return None


def current_user_role():
    return session.get('role', 'viewer')


def has_role(required_role):
    current = ROLE_WEIGHTS.get(current_user_role(), 0)
    required = ROLE_WEIGHTS.get(required_role, 99)
    return current >= required


def login_required(view_func):
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        user = session.get('username')
        expires_at = session.get('expires_at')
        if not user or not expires_at:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Authentication required'}), 401
            return redirect(url_for('login'))

        if datetime.utcnow().timestamp() > expires_at:
            session.clear()
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Session expired'}), 401
            return redirect(url_for('login'))

        session['expires_at'] = (datetime.utcnow() + timedelta(minutes=SESSION_TIMEOUT_MINUTES)).timestamp()
        get_or_create_csrf_token()
        return view_func(*args, **kwargs)

    return wrapper


def require_role(role):
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(*args, **kwargs):
            if not has_role(role):
                return jsonify({'error': f'{role} role required'}), 403
            return view_func(*args, **kwargs)

        return wrapper

    return decorator

# Ensure all paths exist
for key, path in CONFIG_PATHS.items():
    if not path.exists():
        print(f"Warning: Config path {key} does not exist: {path}")

# Docker client - handle initialization errors
try:
    docker_client = docker.from_env()
    docker_client.ping()  # Test connection
    docker_available = True
except Exception as e:
    print(f"Warning: Docker client initialization failed: {e}")
    docker_client = None
    docker_available = False

k8s_available = False
k8s_apps = None
k8s_core = None
k8s_autoscaling = None

if k8s_lib_available:
    try:
        try:
            k8s_config.load_incluster_config()
        except Exception:
            k8s_config.load_kube_config()
        k8s_apps = k8s_client.AppsV1Api()
        k8s_core = k8s_client.CoreV1Api()
        k8s_autoscaling = k8s_client.AutoscalingV2Api()
        k8s_available = True
    except Exception as e:
        print(f"Warning: Kubernetes client initialization failed: {e}")


def runtime_platform():
    if PLATFORM_MODE in ('k8s', 'kubernetes') and k8s_available:
        return 'k8s'
    if PLATFORM_MODE in ('compose', 'docker') and docker_available:
        return 'compose'
    if PLATFORM_MODE == 'auto':
        if k8s_available:
            return 'k8s'
        if docker_available:
            return 'compose'
    return 'unknown'


def k8s_workload_status():
    services = {}
    try:
        deployments = k8s_apps.list_namespaced_deployment(K8S_NAMESPACE).items
        for dep in deployments:
            ready = dep.status.ready_replicas or 0
            replicas = dep.spec.replicas or 0
            status = 'running' if replicas > 0 and ready > 0 else 'degraded'
            if replicas == 0:
                status = 'stopped'
            services[dep.metadata.name] = {
                'status': status,
                'health': f"{ready}/{replicas}",
                'image': dep.spec.template.spec.containers[0].image if dep.spec.template.spec.containers else 'unknown',
                'ports': '',
                'labels': dep.metadata.labels or {},
                'created': dep.metadata.creation_timestamp.isoformat() if dep.metadata.creation_timestamp else 'Unknown',
                'kind': 'Deployment',
                'replicas': replicas,
                'ready_replicas': ready
            }

        statefulsets = k8s_apps.list_namespaced_stateful_set(K8S_NAMESPACE).items
        for st in statefulsets:
            ready = st.status.ready_replicas or 0
            replicas = st.spec.replicas or 0
            status = 'running' if replicas > 0 and ready > 0 else 'degraded'
            if replicas == 0:
                status = 'stopped'
            services[st.metadata.name] = {
                'status': status,
                'health': f"{ready}/{replicas}",
                'image': st.spec.template.spec.containers[0].image if st.spec.template.spec.containers else 'unknown',
                'ports': '',
                'labels': st.metadata.labels or {},
                'created': st.metadata.creation_timestamp.isoformat() if st.metadata.creation_timestamp else 'Unknown',
                'kind': 'StatefulSet',
                'replicas': replicas,
                'ready_replicas': ready
            }
        return services
    except Exception as e:
        return {'error': f'Kubernetes API error: {str(e)}'}


def resolve_k8s_resource(service_name):
    try:
        dep = k8s_apps.read_namespaced_deployment(service_name, K8S_NAMESPACE)
        return 'deployment', dep
    except ApiException:
        pass

    try:
        st = k8s_apps.read_namespaced_stateful_set(service_name, K8S_NAMESPACE)
        return 'statefulset', st
    except ApiException:
        return None, None


def k8s_control_service(service_name, action):
    kind, obj = resolve_k8s_resource(service_name)
    if not kind:
        raise RuntimeError(f"Service not found in namespace {K8S_NAMESPACE}: {service_name}")

    current_replicas = obj.spec.replicas or 0
    if action == 'restart':
        patch_body = {
            'spec': {
                'template': {
                    'metadata': {
                        'annotations': {
                            'kubectl.kubernetes.io/restartedAt': datetime.utcnow().isoformat() + 'Z'
                        }
                    }
                }
            }
        }
        if kind == 'deployment':
            k8s_apps.patch_namespaced_deployment(service_name, K8S_NAMESPACE, patch_body)
        else:
            k8s_apps.patch_namespaced_stateful_set(service_name, K8S_NAMESPACE, patch_body)
        return f"{service_name} restarted"

    target_replicas = 0 if action == 'stop' else (1 if current_replicas == 0 else current_replicas)
    scale_body = {'spec': {'replicas': target_replicas}}
    if kind == 'deployment':
        k8s_apps.patch_namespaced_deployment_scale(service_name, K8S_NAMESPACE, scale_body)
    else:
        k8s_apps.patch_namespaced_stateful_set_scale(service_name, K8S_NAMESPACE, scale_body)
    return f"{service_name} scaled to {target_replicas}"


def list_hpa_policies():
    hpas = k8s_autoscaling.list_namespaced_horizontal_pod_autoscaler(K8S_NAMESPACE).items
    result = []
    for hpa in hpas:
        cpu_target = None
        mem_target = None
        metrics = hpa.spec.metrics or []
        for metric in metrics:
            if metric.type == 'Resource' and metric.resource and metric.resource.target:
                if metric.resource.name == 'cpu':
                    cpu_target = metric.resource.target.average_utilization
                elif metric.resource.name == 'memory':
                    mem_target = metric.resource.target.average_utilization

        result.append({
            'name': hpa.metadata.name,
            'target_kind': hpa.spec.scale_target_ref.kind,
            'target_name': hpa.spec.scale_target_ref.name,
            'min_replicas': hpa.spec.min_replicas,
            'max_replicas': hpa.spec.max_replicas,
            'cpu_target': cpu_target,
            'memory_target': mem_target
        })
    return result


def patch_hpa_policy(name, min_replicas=None, max_replicas=None, cpu_target=None, memory_target=None):
    hpa = k8s_autoscaling.read_namespaced_horizontal_pod_autoscaler(name, K8S_NAMESPACE)
    metrics = hpa.spec.metrics or []

    def upsert_resource_metric(metric_name, target_value):
        if target_value is None:
            return
        for metric in metrics:
            if metric.type == 'Resource' and metric.resource and metric.resource.name == metric_name:
                metric.resource.target.average_utilization = int(target_value)
                metric.resource.target.type = 'Utilization'
                return
        metrics.append(
            k8s_client.V2MetricSpec(
                type='Resource',
                resource=k8s_client.V2ResourceMetricSource(
                    name=metric_name,
                    target=k8s_client.V2MetricTarget(type='Utilization', average_utilization=int(target_value))
                )
            )
        )

    upsert_resource_metric('cpu', cpu_target)
    upsert_resource_metric('memory', memory_target)

    patch_body = {
        'spec': {
            'minReplicas': int(min_replicas) if min_replicas is not None else hpa.spec.min_replicas,
            'maxReplicas': int(max_replicas) if max_replicas is not None else hpa.spec.max_replicas,
            'metrics': [m.to_dict() if hasattr(m, 'to_dict') else m for m in metrics]
        }
    }

    k8s_autoscaling.patch_namespaced_horizontal_pod_autoscaler(name, K8S_NAMESPACE, patch_body)


def deployment_rollout_history(deployment_name):
    replica_sets = k8s_apps.list_namespaced_replica_set(K8S_NAMESPACE).items
    history = []
    for rs in replica_sets:
        owner_refs = rs.metadata.owner_references or []
        owned = any(ref.kind == 'Deployment' and ref.name == deployment_name for ref in owner_refs)
        if not owned:
            continue
        rev = (rs.metadata.annotations or {}).get('deployment.kubernetes.io/revision', '0')
        history.append({
            'replicaset': rs.metadata.name,
            'revision': int(rev) if str(rev).isdigit() else rev,
            'image': rs.spec.template.spec.containers[0].image if rs.spec.template.spec.containers else 'unknown',
            'created': rs.metadata.creation_timestamp.isoformat() if rs.metadata.creation_timestamp else None
        })
    history.sort(key=lambda x: x['revision'] if isinstance(x['revision'], int) else 0, reverse=True)
    return history


def restart_deployment(deployment_name):
    patch_body = {
        'spec': {
            'template': {
                'metadata': {
                    'annotations': {
                        'kubectl.kubernetes.io/restartedAt': datetime.utcnow().isoformat() + 'Z'
                    }
                }
            }
        }
    }
    k8s_apps.patch_namespaced_deployment(deployment_name, K8S_NAMESPACE, patch_body)


def rollback_deployment_to_revision(deployment_name, revision):
    replica_sets = k8s_apps.list_namespaced_replica_set(K8S_NAMESPACE).items
    selected_rs = None
    revision = str(revision)
    for rs in replica_sets:
        owner_refs = rs.metadata.owner_references or []
        owned = any(ref.kind == 'Deployment' and ref.name == deployment_name for ref in owner_refs)
        if not owned:
            continue
        rs_revision = (rs.metadata.annotations or {}).get('deployment.kubernetes.io/revision')
        if rs_revision == revision:
            selected_rs = rs
            break

    if selected_rs is None:
        raise RuntimeError(f'Revision not found for deployment {deployment_name}: {revision}')

    containers = []
    for c in selected_rs.spec.template.spec.containers:
        containers.append({'name': c.name, 'image': c.image})

    patch_body = {
        'spec': {
            'template': {
                'metadata': {
                    'annotations': {
                        'log-system.io/rolled-back-from-revision': str(revision),
                        'log-system.io/rolled-back-at': datetime.utcnow().isoformat() + 'Z'
                    }
                },
                'spec': {
                    'containers': containers
                }
            }
        }
    }
    k8s_apps.patch_namespaced_deployment(deployment_name, K8S_NAMESPACE, patch_body)

def get_service_status():
    """Get status of all services"""
    if runtime_platform() == 'k8s':
        return k8s_workload_status()

    if not docker_available or docker_client is None:
        return {'error': 'Docker is not available. Make sure Docker daemon is running.'}
    
    try:
        containers = docker_client.containers.list(all=True, ignore_removed=True)
        
        services = {}
        for container in containers:
            try:
                if not _docker_reload_container_or_skip(container):
                    continue
                if not _include_container_in_service_dashboard(container):
                    continue
                # image/ports lazy inspect: recreate yarışında 404 — tüm istisnaları tek yerde yakala
                health = "N/A"
                try:
                    if container.attrs.get('State', {}).get('Health'):
                        health = container.attrs['State']['Health']['Status']
                except Exception:
                    pass
                if container.status == 'running' and health == 'N/A':
                    health = 'healthy'

                lbl = container.labels or {}
                compose_svc = (lbl.get('com.docker.compose.service') or '').strip() or None
                compose_proj = (lbl.get('com.docker.compose.project') or '').strip() or None
                display_name = compose_svc if compose_svc else container.name
                replace_stuck = bool(
                    lbl.get('com.docker.compose.replace')
                    and compose_svc
                    and container.name != compose_svc
                )
                try:
                    img_tags = container.image.tags if container.image else []
                except Exception:
                    img_tags = []
                try:
                    ports = container.ports
                except Exception:
                    ports = {}
                services[container.name] = {
                    'status': container.status,
                    'health': health,
                    'image': img_tags[0] if img_tags else 'No tag',
                    'ports': ports,
                    'labels': container.labels,
                    'created': container.attrs['Created'][:19] if 'Created' in container.attrs else 'Unknown',
                    'composeService': compose_svc,
                    'composeProject': compose_proj,
                    'displayName': display_name,
                    'composeReplaceNameMismatch': replace_stuck,
                }
            except Exception as e:
                if _docker_client_error_is_missing_container(e):
                    continue
                cid = getattr(container, 'short_id', None) or (getattr(container, 'id', '') or '')[:12] or '?'
                print(f"get_service_status: konteyner atlandı ({cid}): {e}", flush=True)
                continue
        return services
    except Exception as e:
        print(f"Error getting service status: {e}")
        # Try to get services via docker compose if Docker API fails
        try:
            import subprocess
            result = subprocess.run(['docker', 'compose', 'ps', '--format', 'json'], 
                                  capture_output=True, text=True, cwd='/app/config')
            if result.returncode == 0:
                import json
                containers = json.loads(result.stdout)
                services = {}
                for container in containers:
                    health = container.get('Health', 'N/A')
                    state = (container.get('State') or '').lower()
                    if state == 'running' and (not health or health == 'N/A'):
                        health = 'healthy'
                    services[container['Name']] = {
                        'status': container['State'],
                        'health': health,
                        'image': container['Service'],
                        'ports': '',
                        'labels': {},
                        'created': 'Unknown'
                    }
                return services
        except Exception as e2:
            print(f"Fallback also failed: {e2}")
        
        return {'error': f'Docker API error: {str(e)}. Make sure Docker daemon is running and socket is accessible.'}

def validate_config_change(config_type, content):
    """Validate configuration changes before applying"""
    if config_type == 'docker-compose':
        try:
            yaml.safe_load(content)
            return True, "YAML syntax is valid"
        except yaml.YAMLError as e:
            return False, f"YAML syntax error: {str(e)}"
    
    elif config_type == 'env':
        # Basic .env validation
        lines = content.split('\n')
        for line in lines:
            line = line.strip()
            if line and not line.startswith('#') and '=' not in line:
                return False, f"Invalid line: {line}"
        return True, ".env format is valid"
    
    elif config_type.endswith('.json'):
        try:
            json.loads(content)
            return True, "JSON syntax is valid"
        except json.JSONDecodeError as e:
            return False, f"JSON syntax error: {str(e)}"
    
    elif config_type.endswith('.yaml') or config_type.endswith('.yml'):
        try:
            yaml.safe_load(content)
            return True, "YAML syntax is valid"
        except yaml.YAMLError as e:
            return False, f"YAML syntax error: {str(e)}"
    
    return True, "No validation available for this file type"


def parse_env_file(path: Path):
    env_map = {}
    if not path.exists():
        return env_map

    with open(path, 'r') as f:
        for raw in f.readlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            env_map[key.strip()] = value.strip()
    return env_map


def _graylog_root_password_sha256_hex(plain: str) -> str:
    """Graylog GRAYLOG_ROOT_PASSWORD_SHA2: SHA256(utf-8 password) as lowercase hex."""
    return hashlib.sha256(str(plain).encode('utf-8')).hexdigest()


def _settings_env_write_pairs(primary_key: str, primary_value: str) -> list:
    """Tek kullanıcı girişiyle birden fazla .env anahtarı yazılacaksa (ör. Graylog admin)."""
    pairs = [(primary_key, primary_value)]
    if primary_key == 'GRAYLOG_ROOT_PASSWORD':
        pairs.append(('GRAYLOG_ROOT_PASSWORD_SHA2', _graylog_root_password_sha256_hex(primary_value)))
    return pairs


def update_env_key(path: Path, key: str, value: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with open(path, 'w') as f:
            f.write(f"{key}={value}\n")
        return

    with open(path, 'r') as f:
        lines = f.readlines()

    updated = False
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(f"{key}="):
            new_lines.append(f"{key}={value}\n")
            updated = True
        else:
            new_lines.append(line)

    if not updated:
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines[-1] += '\n'
        new_lines.append(f"{key}={value}\n")

    with open(path, 'w') as f:
        f.writelines(new_lines)


def settings_storage_status():
    target = ENV_PATH if ENV_PATH.exists() else ENV_PATH.parent
    writable = os.access(target, os.W_OK)
    auto_apply_available = False
    message = None

    if writable:
        message = 'Ayarlar doğrudan uygulanabilir.'
        return writable, auto_apply_available, message

    if runtime_platform() == 'compose' and docker_available and docker_client is not None:
        try:
            for container in docker_client.containers.list(all=True, ignore_removed=True):
                mounts = container.attrs.get('Mounts', [])
                has_rw_config_mount = any(
                    (m.get('Destination') or '').rstrip('/') == '/app/config' and bool(m.get('RW'))
                    for m in mounts
                )
                if has_rw_config_mount:
                    auto_apply_available = True
                    break
            if not auto_apply_available and (discover_env_file_sources() or discover_compose_config_sources()):
                auto_apply_available = True
        except Exception:
            auto_apply_available = False

    if auto_apply_available:
        message = 'Ayar dosyası panelde salt-okunur ancak değişiklikler arka planda otomatik uygulanacak.'
    else:
        message = 'Ayar dosya sistemi salt-okunur bağlı ve otomatik uygulama kanalı bulunamadı. Yönetici desteği gerekiyor.'

    return writable, auto_apply_available, message


def discover_compose_config_sources():
    if not docker_available or docker_client is None:
        return []

    sources = []
    seen = set()
    for container in docker_client.containers.list(all=True, ignore_removed=True):
        for mount in container.attrs.get('Mounts', []):
            destination = (mount.get('Destination') or '').rstrip('/')
            source = mount.get('Source')
            if destination == '/app/config' and source and source not in seen:
                seen.add(source)
                sources.append(source)
    return sources


def discover_env_file_sources():
    if not docker_available or docker_client is None:
        return []

    sources = []
    seen = set()
    for container in docker_client.containers.list(all=True, ignore_removed=True):
        for mount in container.attrs.get('Mounts', []):
            destination = (mount.get('Destination') or '').rstrip('/')
            source = mount.get('Source')
            if destination.endswith('/.env') and source and source not in seen:
                seen.add(source)
                sources.append(source)
    return sources


def _compose_heap_recreate_host_project_dir():
    """Host'ta docker-compose.yml ve .env'in bulunduğu kök (panel konteyner mount kaynağı)."""
    if not docker_available or docker_client is None:
        return None
    try:
        ui = docker_client.containers.get('log-management-ui')
        for mount in ui.attrs.get('Mounts', []):
            destination = (mount.get('Destination') or '').rstrip('/')
            source = mount.get('Source')
            if destination.endswith('/.env') and source:
                return str(Path(source).parent)
        for mount in ui.attrs.get('Mounts', []):
            destination = (mount.get('Destination') or '').rstrip('/')
            source = mount.get('Source')
            if destination == '/app/config' and source:
                return source
    except docker_errors.NotFound:
        pass
    except Exception:
        pass
    for p in discover_env_file_sources():
        if p:
            return str(Path(p).parent)
    roots = discover_compose_config_sources()
    return roots[0] if roots else None


def _wait_container_health_status(name, want='healthy', timeout_sec=240, interval=3):
    """Docker API ile konteyner sağlık durumunu bekle (reload ile)."""
    if not docker_available or docker_client is None:
        return False
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            c = docker_client.containers.get(name)
            c.reload()
            st = c.attrs.get('State') or {}
            health = st.get('Health') or {}
            status = health.get('Status')
            if status == want:
                return True
            if not health and st.get('Status') == 'running':
                return True
        except docker_errors.NotFound:
            pass
        except Exception:
            pass
        time.sleep(interval)
    return False


def _compose_cli_exec(host_root, cli_image, script):
    """docker:cli imajında tek bir sh -lc komutu çalıştırır.

    Proje dizinini host ile aynı mutlak yola bağlarız (/workspace değil). Aksi halde
    compose dosyasındaki ./config/... bind mountları daemon tarafında /workspace/...
    olarak çözülür; yol yoksa Docker boş dizin yaratır (ör. ca.crt «is a directory»).
    """
    root = str(Path(host_root).resolve())
    volumes = {
        root: {'bind': root, 'mode': 'rw'},
        '/var/run/docker.sock': {'bind': '/var/run/docker.sock', 'mode': 'rw'},
    }
    wd = root

    def _run():
        return docker_client.containers.run(
            cli_image,
            ['sh', '-lc', script],
            volumes=volumes,
            working_dir=wd,
            remove=True,
            user='root',
            stdout=True,
            stderr=True,
        )

    try:
        return None, _run()
    except docker_errors.ImageNotFound:
        try:
            docker_client.images.pull(cli_image)
        except Exception as pull_err:
            return f'CLI imajı çekilemedi ({cli_image}): {pull_err}', None
        try:
            return None, _run()
        except docker_errors.ContainerError as e2:
            return (e2.stderr or b'').decode('utf-8', errors='replace')[-6000:] or str(e2), None
        except Exception as e2:
            return str(e2), None
    except docker_errors.ContainerError as e:
        return (e.stderr or b'').decode('utf-8', errors='replace')[-6000:] or str(e), None
    except Exception as e:
        return str(e), None


def _compose_cli_run_detached(host_root, cli_image, script):
    """docker:cli ile tek seferlik rollout: detach=True — panel konteyneri yenilense bile işlem sürer."""
    root = str(Path(host_root).resolve())
    volumes = {
        root: {'bind': root, 'mode': 'rw'},
        '/var/run/docker.sock': {'bind': '/var/run/docker.sock', 'mode': 'rw'},
    }

    def _run():
        return docker_client.containers.run(
            cli_image,
            ['sh', '-lc', script],
            volumes=volumes,
            working_dir=root,
            detach=True,
            remove=True,
            user='root',
        )

    try:
        c = _run()
        cid = (c.id or '')[:12] if c is not None else ''
        return None, cid
    except docker_errors.ImageNotFound:
        try:
            docker_client.images.pull(cli_image)
        except Exception as pull_err:
            return f'CLI imajı çekilemedi ({cli_image}): {pull_err}', None
        try:
            c = _run()
            cid = (c.id or '')[:12] if c is not None else ''
            return None, cid
        except Exception as e2:
            return str(e2), None
    except Exception as e:
        return str(e), None


def _start_graylog_password_rollout_detached():
    """
    .env güncellendikten sonra Graylog'un yeni GRAYLOG_ROOT_PASSWORD_SHA2 alması için konteyner yenilenmeli.
    Kök kullanıcı (admin) MongoDB'de değil; Shiro + root_password_sha2 ortam değişkeni ile doğrulanır.

    Kritik: Rollout'u panel sürecinde veya paneli durduran bir thread'de çalıştırmayın — işlem yarıda kesilir.
    Bunun yerine ayrı bir docker:cli konteynerinde detach çalıştırılır. Sıra: graylog → (bekle) → post-init →
    watchdog → en son log-management-ui (panel yenilenir).
    """
    flag = os.environ.get('LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT', '1').strip().lower()
    if flag in ('0', 'false', 'no', 'off'):
        return {'ok': True, 'skipped': True, 'reason': 'LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT kapalı'}

    if not docker_available or docker_client is None:
        return {'ok': False, 'skipped': False, 'error': 'Docker API yok; otomatik yenileme başlatılamadı'}

    host_root = _compose_heap_recreate_host_project_dir()
    if not host_root:
        return {'ok': False, 'skipped': False, 'error': 'Compose proje kökü bulunamadı (panel .env mount)'}

    cli_image = (os.environ.get('LOG_SYSTEM_DOCKER_CLI_IMAGE') or 'docker:26-cli').strip()
    compose_file = (os.environ.get('LOG_SYSTEM_HEAP_COMPOSE_FILE') or 'docker-compose.yml').strip() or 'docker-compose.yml'
    root_q = shlex.quote(str(Path(host_root).resolve()))
    cf_q = shlex.quote(compose_file)

    script = (
        f'cd {root_q}\n'
        f'echo "[graylog-pw-rollout] basladi"\n'
        f'docker compose -f {cf_q} up -d --force-recreate --no-deps graylog\n'
        'i=1\n'
        'while [ "$i" -le 72 ]; do\n'
        f'  if docker compose -f {cf_q} exec -T graylog curl -sf --max-time 12 http://127.0.0.1:9000/api >/dev/null 2>&1; then\n'
        '    echo "[graylog-pw-rollout] graylog_api_hazir"\n'
        '    break\n'
        '  fi\n'
        '  i=$((i+1))\n'
        '  sleep 5\n'
        'done\n'
        f'docker compose -f {cf_q} run --rm --no-deps graylog-post-init || true\n'
        f'docker compose -f {cf_q} up -d --force-recreate --no-deps watchdog\n'
        f'docker compose -f {cf_q} up -d --force-recreate --no-deps log-management-ui\n'
        'echo "[graylog-pw-rollout] bitti"\n'
    )

    err, cid = _compose_cli_run_detached(host_root, cli_image, script)
    if err:
        try:
            audit_event('graylog.password_rollout', 'start_failed', {'error': err, 'rolloutContainerId': cid})
        except Exception:
            pass
        return {'ok': False, 'skipped': False, 'error': err, 'rolloutContainerId': cid or None}
    audit_event('graylog.password_rollout', 'started', {'rolloutContainerId': cid, 'mode': 'detached_cli'})
    return {'ok': True, 'skipped': False, 'rolloutContainerId': cid, 'mode': 'detached_cli'}


def _run_compose_recreate_graylog_opensearch():
    """
    .env heap güncellemesinden sonra host üzerinde docker compose ile servisleri yeniden oluşturur.
    Panel imajında docker CLI yok; resmi docker CLI imajı + socket kullanılır.
    Önce yalnızca opensearch1; sağlık gelene kadar beklenir, sonra graylog (--no-deps).
    """
    flag = os.environ.get('LOG_SYSTEM_HEAP_COMPOSE_RECREATE', '1').strip().lower()
    if flag in ('0', 'false', 'no', 'off'):
        return {'ok': True, 'skipped': True, 'reason': 'LOG_SYSTEM_HEAP_COMPOSE_RECREATE kapalı'}

    host_root = _compose_heap_recreate_host_project_dir()
    if not host_root:
        return {
            'ok': True,
            'skipped': True,
            'reason': 'Host proje kökü bulunamadı (log-management-ui /.env veya /app/config mount)',
        }

    cli_image = (os.environ.get('LOG_SYSTEM_DOCKER_CLI_IMAGE') or 'docker:26-cli').strip()
    wait_sec = int(os.environ.get('LOG_SYSTEM_HEAP_OPENSEARCH_WAIT_SEC', '240'))
    compose_file = (os.environ.get('LOG_SYSTEM_HEAP_COMPOSE_FILE') or 'docker-compose.yml').strip() or 'docker-compose.yml'
    cf_q = shlex.quote(compose_file)

    out_chunks = []
    root_q = shlex.quote(str(Path(host_root).resolve()))

    def _heap_recreate_shell(service: str) -> str:
        # stop + rm: compose/daemon bazen eski container ID ile takılıyor («No such container»)
        return (
            f'set -e; cd {root_q} && '
            f'docker compose -f {cf_q} stop {service} 2>/dev/null || true && '
            f'docker compose -f {cf_q} rm -f {service} 2>/dev/null || true && '
            f'docker compose -f {cf_q} up -d --no-deps {service}'
        )

    err, raw = _compose_cli_exec(
        host_root,
        cli_image,
        _heap_recreate_shell('opensearch1'),
    )
    if err:
        return {'ok': False, 'skipped': False, 'error': err}
    if raw is not None:
        out_chunks.append(
            raw.decode('utf-8', errors='replace').strip()
            if isinstance(raw, (bytes, bytearray))
            else str(raw).strip()
        )

    if not _wait_container_health_status('opensearch1', want='healthy', timeout_sec=wait_sec):
        return {
            'ok': False,
            'skipped': False,
            'error': (
                f'opensearch1 {wait_sec}s içinde healthy olmadı. '
                'Kaynak yetersizliği veya healthcheck gecikmesi olabilir.'
            ),
            'output': '\n'.join(out_chunks)[-8000:],
        }

    err2, raw2 = _compose_cli_exec(
        host_root,
        cli_image,
        _heap_recreate_shell('graylog'),
    )
    if err2:
        return {
            'ok': False,
            'skipped': False,
            'error': err2,
            'output': '\n'.join(out_chunks)[-8000:],
        }
    if raw2 is not None:
        out_chunks.append(
            raw2.decode('utf-8', errors='replace').strip()
            if isinstance(raw2, (bytes, bytearray))
            else str(raw2).strip()
        )

    text = '\n'.join(out_chunks).strip()
    return {'ok': True, 'skipped': False, 'output': text[-8000:]}


def _heap_stack_service_status():
    """graylog / opensearch1 kısa durum (recreate sonrası kontrol)."""
    if not docker_available or docker_client is None:
        return {}
    out = {}
    for name in ('graylog', 'opensearch1'):
        try:
            c = docker_client.containers.get(name)
            st = c.attrs.get('State') or {}
            health = (st.get('Health') or {}).get('Status')
            out[name] = {'status': c.status, 'health': health}
        except docker_errors.NotFound:
            out[name] = {'status': 'not_found'}
        except Exception as e:
            out[name] = {'error': str(e)}
    return out


def _helper_env_path(path: Path):
    try:
        relative = path.relative_to(BASE_DIR)
    except Exception:
        relative = Path(path.name)
    return Path('/mnt-config') / relative


def update_env_key_via_helper_container(path: Path, key: str, value: str):
    env_file_sources = discover_env_file_sources()
    config_sources = discover_compose_config_sources()
    if not env_file_sources and not config_sources:
        raise RuntimeError('Compose config kaynağı bulunamadı')

    helper_path = _helper_env_path(path)
    key_q = shlex.quote(str(key))
    value_q = shlex.quote(str(value))
    file_q = shlex.quote(str(helper_path))
    script = (
        "set -e; "
        f"ENV_FILE={file_q}; "
        f"KEY={key_q}; "
        f"VALUE={value_q}; "
        "mkdir -p \"$(dirname \"$ENV_FILE\")\"; "
        "touch \"$ENV_FILE\"; "
        "awk -v key=\"$KEY\" -v value=\"$VALUE\" '"
        "BEGIN { updated=0 } "
        "index($0, key\"=\")==1 { print key\"=\"value; updated=1; next } "
        "{ print } "
        "END { if (!updated) print key\"=\"value }"
        "' \"$ENV_FILE\" > \"$ENV_FILE.tmp\"; "
        "mv \"$ENV_FILE.tmp\" \"$ENV_FILE\""
    )

    errors = []
    image = 'alpine:3.20'
    for source_file in env_file_sources:
        file_script = (
            "set -e; "
            "ENV_FILE=/mnt-env-file; "
            f"KEY={key_q}; "
            f"VALUE={value_q}; "
            "touch \"$ENV_FILE\"; "
            "TMP_FILE=$(mktemp); "
            "awk -v key=\"$KEY\" -v value=\"$VALUE\" '"
            "BEGIN { updated=0 } "
            "index($0, key\"=\")==1 { print key\"=\"value; updated=1; next } "
            "{ print } "
            "END { if (!updated) print key\"=\"value }"
            "' \"$ENV_FILE\" > \"$TMP_FILE\"; "
            "cat \"$TMP_FILE\" > \"$ENV_FILE\"; "
            "rm -f \"$TMP_FILE\""
        )
        try:
            docker_client.containers.run(
                image=image,
                command=['sh', '-lc', file_script],
                volumes={source_file: {'bind': '/mnt-env-file', 'mode': 'rw'}},
                remove=True,
                user='0'
            )
            return f'helper-file:{source_file}'
        except docker_errors.ImageNotFound:
            try:
                docker_client.images.pull(image)
                docker_client.containers.run(
                    image=image,
                    command=['sh', '-lc', file_script],
                    volumes={source_file: {'bind': '/mnt-env-file', 'mode': 'rw'}},
                    remove=True,
                    user='0'
                )
                return f'helper-file:{source_file}'
            except Exception as pull_err:
                errors.append(f'{source_file}: {str(pull_err)}')
        except Exception as e:
            errors.append(f'{source_file}: {str(e)}')

    for source in config_sources:
        try:
            docker_client.containers.run(
                image=image,
                command=['sh', '-lc', script],
                volumes={source: {'bind': '/mnt-config', 'mode': 'rw'}},
                remove=True,
                user='0'
            )
            return f'helper:{source}'
        except docker_errors.ImageNotFound:
            try:
                docker_client.images.pull(image)
                docker_client.containers.run(
                    image=image,
                    command=['sh', '-lc', script],
                    volumes={source: {'bind': '/mnt-config', 'mode': 'rw'}},
                    remove=True,
                    user='0'
                )
                return f'helper:{source}'
            except Exception as pull_err:
                errors.append(f'{source}: {str(pull_err)}')
        except Exception as e:
            errors.append(f'{source}: {str(e)}')

    raise RuntimeError('Helper container ile yazma başarısız: ' + '; '.join(errors[:3]))


def update_env_key_via_runtime(path: Path, key: str, value: str):
    if runtime_platform() != 'compose':
        raise RuntimeError('Otomatik uygulama yalnızca compose modunda desteklenir')
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')

    target_path = str(path)
    candidates = []
    for container in docker_client.containers.list(all=True, ignore_removed=True):
        mounts = container.attrs.get('Mounts', [])
        for mount in mounts:
            destination = (mount.get('Destination') or '').rstrip('/')
            if destination == '/app/config' and bool(mount.get('RW')):
                name = (container.name or '').lower()
                score = 0
                if 'setup' in name:
                    score += 20
                if 'log-management-ui' in name:
                    score -= 10
                if container.status == 'running':
                    score += 5
                candidates.append((score, container))
                break

    if not candidates:
        return update_env_key_via_helper_container(path, key, value)

    candidates.sort(key=lambda item: item[0], reverse=True)
    key_q = shlex.quote(str(key))
    value_q = shlex.quote(str(value))
    target_q = shlex.quote(target_path)
    script = (
        "set -e; "
        f"ENV_FILE={target_q}; "
        f"KEY={key_q}; "
        f"VALUE={value_q}; "
        "mkdir -p \"$(dirname \"$ENV_FILE\")\"; "
        "touch \"$ENV_FILE\"; "
        "awk -v key=\"$KEY\" -v value=\"$VALUE\" '"
        "BEGIN { updated=0 } "
        "index($0, key\"=\")==1 { print key\"=\"value; updated=1; next } "
        "{ print } "
        "END { if (!updated) print key\"=\"value }"
        "' \"$ENV_FILE\" > \"$ENV_FILE.tmp\"; "
        "mv \"$ENV_FILE.tmp\" \"$ENV_FILE\""
    )

    errors = []
    for _, container in candidates:
        try:
            result = container.exec_run(['sh', '-lc', script], user='0')
            if result.exit_code == 0:
                return container.name
            output = result.output.decode('utf-8', errors='ignore') if isinstance(result.output, (bytes, bytearray)) else str(result.output)
            errors.append(f"{container.name}: {output.strip()}")
        except Exception as e:
            errors.append(f"{container.name}: {str(e)}")

    try:
        return update_env_key_via_helper_container(path, key, value)
    except Exception as helper_error:
        errors.append(str(helper_error))

    raise RuntimeError('Otomatik uygulama başarısız: ' + '; '.join(errors[:3]))


def compose_control_service(service_name: str, action: str):
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')

    targets = []
    try:
        targets = [docker_client.containers.get(service_name)]
    except Exception:
        targets = []

    if not targets:
        try:
            targets = docker_client.containers.list(
                all=True,
                ignore_removed=True,
                filters={'label': f'com.docker.compose.service={service_name}'}
            )
        except Exception:
            targets = []

    if len(targets) > 1:
        exact = [c for c in targets if c.name == service_name]
        if exact:
            targets = exact
        else:
            running = [c for c in targets if getattr(c, 'status', None) == 'running']
            if running:
                targets = running

    if not targets:
        try:
            all_containers = docker_client.containers.list(all=True, ignore_removed=True)
            targets = [c for c in all_containers if c.name.endswith(service_name)]
        except Exception:
            targets = []

    if not targets:
        raise RuntimeError(f'Servis bulunamadı: {service_name}')

    controlled = []
    for container in targets:
        if action == 'restart':
            container.restart(timeout=20)
        elif action == 'stop':
            container.stop(timeout=20)
        elif action == 'start':
            container.start()
        container.reload()
        controlled.append(container.name)

    return f"Service {service_name} {action}ed successfully ({', '.join(controlled)})"


def safe_container_status(name: str):
    if not docker_available or docker_client is None:
        return {'exists': False, 'status': 'docker-unavailable'}
    try:
        container = docker_client.containers.get(name)
        return {'exists': True, 'status': container.status}
    except Exception:
        return {'exists': False, 'status': 'not-found'}


def get_metrics_probe_profile(env_map=None):
    """SIMULATION_TEST_MODE: Fluent Bit UDP latency probe yönlendirmesi (METRICS_ONLY | ISOLATED_E2E)."""
    if env_map is None:
        env_map = parse_env_file(ENV_PATH)
    mode = (env_map.get('SIMULATION_TEST_MODE', 'METRICS_ONLY') or 'METRICS_ONLY').strip().upper()
    if mode not in ('METRICS_ONLY', 'ISOLATED_E2E'):
        return 'METRICS_ONLY'
    return mode


def ensure_simulated_log_producer(enabled: bool):
    if runtime_platform() != 'compose':
        return {'enabled': False, 'note': 'Simülasyon üretici yalnızca compose modunda desteklenir'}
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')

    producer_name = 'simulated-log-producer'
    network_name = 'log_net'
    env_map = parse_env_file(ENV_PATH)
    probe_profile = get_metrics_probe_profile(env_map)
    simulation_route = 'isolated' if probe_profile == 'METRICS_ONLY' else 'e2e'
    simulation_target_port = '5152' if probe_profile == 'METRICS_ONLY' else '5153'
    simulation_run_id = f"sim-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"

    container = None
    try:
        container = docker_client.containers.get(producer_name)
    except Exception:
        container = None

    if not enabled:
        if container:
            try:
                if container.status == 'running':
                    container.stop(timeout=10)
            except Exception:
                pass
            try:
                container.remove(force=True)
            except Exception:
                pass
        return {'enabled': False, 'container': producer_name, 'note': 'Simülasyon üretici durduruldu'}

    loop_script = (
        "import json, os, random, socket, time\n"
        "host = os.getenv('SIM_TARGET_HOST', 'fluent-bit')\n"
        "port = int(os.getenv('SIM_TARGET_PORT', '5151'))\n"
        "interval = float(os.getenv('SIM_INTERVAL', '0.20'))\n"
        "devices = int(os.getenv('SIM_DEVICE_COUNT', '32'))\n"
        "sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n"
        "counter = 0\n"
        "while True:\n"
        "  counter += 1\n"
        "  device = random.randint(1, devices)\n"
        "  payload = {\n"
        "    'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),\n"
        "    'message': f'simulated remote device event {counter}',\n"
        "    'level': random.choice(['INFO','INFO','INFO','WARN','ERROR']),\n"
        "    'source': f'remote-device-{device:03d}',\n"
        "    'device_ip': f'10.42.{device % 16}.{(counter % 250) + 1}',\n"
        "    'pipeline_test': 'simulated-5651',\n"
        "    'simulation': 'true',\n"
        "    'simulation_route': os.getenv('SIMULATION_ROUTE', 'isolated'),\n"
        "    'simulation_mode': os.getenv('SIMULATION_TEST_MODE', 'METRICS_ONLY'),\n"
        "    'simulation_run_id': os.getenv('SIMULATION_RUN_ID', 'sim-unknown')\n"
        "  }\n"
        "  try:\n"
        "    sock.sendto(json.dumps(payload).encode('utf-8'), (host, port))\n"
        "  except Exception:\n"
        "    time.sleep(max(interval, 0.5))\n"
        "  time.sleep(interval)\n"
    )

    if container:
        current_env = container.attrs.get('Config', {}).get('Env', []) or []
        env_map = {}
        for item in current_env:
            if '=' in item:
                key, val = item.split('=', 1)
                env_map[key] = val

        current_mode = env_map.get('SIMULATION_TEST_MODE', '').strip().upper()
        current_route = env_map.get('SIMULATION_ROUTE', '').strip().lower()

        mode_changed = current_mode != probe_profile
        route_changed = current_route != simulation_route

        if mode_changed or route_changed:
            try:
                if container.status == 'running':
                    container.stop(timeout=10)
            except Exception:
                pass
            try:
                container.remove(force=True)
            except Exception:
                pass
            container = None
        else:
            if container.status != 'running':
                container.start()
            return {
                'enabled': True,
                'container': producer_name,
                'mode': probe_profile,
                'route': simulation_route,
                'note': f'Simülasyon üretici aktif ({probe_profile})'
            }

    docker_client.containers.run(
        image='python:3.12-alpine',
        name=producer_name,
        command=['python', '-u', '-c', loop_script],
        network=network_name,
        detach=True,
        restart_policy={'Name': 'unless-stopped'},
        environment={
            'SIM_TARGET_HOST': 'fluent-bit',
            'SIM_TARGET_PORT': simulation_target_port,
            'SIM_INTERVAL': '0.20',
            'SIM_DEVICE_COUNT': '32',
            'SIMULATION_ROUTE': simulation_route,
            'SIMULATION_TEST_MODE': probe_profile,
            'SIMULATION_RUN_ID': simulation_run_id
        },
        labels={
            'log-system.simulation': 'true',
            'log-system.managed-by': 'log-management-ui'
        }
    )
    return {
        'enabled': True,
        'container': producer_name,
        'mode': probe_profile,
        'route': simulation_route,
        'runId': simulation_run_id,
        'note': f'Simülasyon üretici başlatıldı ({probe_profile})'
    }


def ensure_log_gen(enabled: bool):
    """log-gen (flog → Fluent Bit UDP 5151). Yalnızca docker-compose.synthetic-traffic.yml ile; üretimde kapalı."""
    if runtime_platform() != 'compose':
        return {'ok': True, 'skipped': True, 'note': 'Compose dışı ortam'}
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    host_root = _compose_heap_recreate_host_project_dir()
    if not host_root:
        raise RuntimeError('Compose proje kökü bulunamadı')
    env_map = parse_env_file(ENV_PATH)
    if enabled and _is_prod_log_system_env(env_map):
        return {
            'ok': False,
            'error': 'LOG_SYSTEM_ENV=prod iken sentetik log-gen başlatılamaz (üretim güvenliği).',
            'enabled': False,
        }
    syn_path = Path(host_root) / DOCKER_COMPOSE_SYNTHETIC_FILE
    if enabled and not syn_path.is_file():
        return {
            'ok': False,
            'error': (
                f'{DOCKER_COMPOSE_SYNTHETIC_FILE} bulunamadı — bu dağıtımda sentetik üretici yok (prod paketi).'
            ),
            'enabled': False,
        }
    cli_image = (os.environ.get('LOG_SYSTEM_DOCKER_CLI_IMAGE') or 'docker:26-cli').strip()
    cf_primary = (os.environ.get('LOG_SYSTEM_HEAP_COMPOSE_FILE') or 'docker-compose.yml').strip() or 'docker-compose.yml'
    cf_chain = (env_map.get('COMPOSE_FILE') or '').strip()
    parts = [p.strip() for p in cf_chain.split(':') if p.strip()] if cf_chain else [cf_primary]
    if syn_path.is_file() and DOCKER_COMPOSE_SYNTHETIC_FILE not in parts:
        parts = list(parts) + [DOCKER_COMPOSE_SYNTHETIC_FILE]
    compose_f = ' '.join(f'-f {shlex.quote(p)}' for p in parts)
    root_q = shlex.quote(str(Path(host_root).resolve()))
    profile = 'synthetic-traffic'
    if enabled:
        script = f'set -e\ncd {root_q}\ndocker compose {compose_f} --profile {profile} up -d --no-deps log-gen\n'
    else:
        script = (
            f'set -e\ncd {root_q}\n'
            f'docker compose {compose_f} stop log-gen 2>/dev/null || true\n'
            f'docker compose {compose_f} rm -f log-gen 2>/dev/null || true\n'
        )
    err, raw = _compose_cli_exec(host_root, cli_image, script)
    tail = ''
    if raw is not None:
        tail = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
        tail = tail[-4000:]
    if err:
        return {'ok': False, 'error': err, 'log_tail': tail, 'enabled': enabled}
    return {'ok': True, 'enabled': enabled, 'log_tail': tail}


def send_simulation_burst(count=300):
    count = max(10, min(int(count), 5000))
    env_map = parse_env_file(ENV_PATH)
    probe_profile = get_metrics_probe_profile(env_map)
    simulation_route = 'isolated' if probe_profile == 'METRICS_ONLY' else 'e2e'
    simulation_target_port = 5152 if probe_profile == 'METRICS_ONLY' else 5153
    simulation_run_id = f"burst-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"
    sent = 0
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for idx in range(count):
            device = random.randint(1, 64)
            payload = {
                'time': datetime.utcnow().isoformat() + 'Z',
                'message': f'simulation burst event {idx + 1}',
                'level': random.choice(['INFO', 'INFO', 'WARN', 'ERROR']),
                'source': f'remote-device-{device:03d}',
                'device_ip': f'10.52.{device % 32}.{(idx % 250) + 1}',
                'pipeline_test': 'burst-5651',
                'simulation': 'true',
                'simulation_route': simulation_route,
                'simulation_mode': probe_profile,
                'simulation_run_id': simulation_run_id
            }
            sock.sendto(json.dumps(payload).encode('utf-8'), ('fluent-bit', simulation_target_port))
            sent += 1
    finally:
        sock.close()
    return sent


def pipeline_bottleneck_thresholds_from_env():
    def parse_float(name, default):
        raw = os.environ.get(name, str(default))
        try:
            value = float(raw)
            return value if value >= 0 else default
        except Exception:
            return default

    def parse_int(name, default):
        raw = os.environ.get(name, str(default))
        try:
            value = int(raw)
            return value if value >= 0 else default
        except Exception:
            return default

    return {
        'dropRateWarningPct': parse_float('SIM_BOTTLENECK_DROP_RATE_WARN_PCT', 0.5),
        'dropRateDangerPct': parse_float('SIM_BOTTLENECK_DROP_RATE_DANGER_PCT', 1.0),
        'errorWarningDelta': parse_int('SIM_BOTTLENECK_ERROR_WARN_DELTA', 1)
    }


def measure_pipeline_probe_latency(probe_profile='METRICS_ONLY', timeout_sec=2.5, poll_interval=0.20):
    baseline = collect_fluent_bit_metrics()
    baseline_output = baseline.get('outputProcessed')
    if baseline_output is None:
        return None, 'Fluent Bit output metriği alınamadı'

    target_port = 5152 if probe_profile == 'METRICS_ONLY' else 5153
    probe_payload = {
        'time': datetime.utcnow().isoformat() + 'Z',
        'message': 'pipeline latency probe',
        'level': 'INFO',
        'source': 'dashboard-latency-probe',
        'pipeline_test': 'latency-probe',
        'simulation': 'true',
        'simulation_mode': probe_profile,
        'simulation_probe_id': f"probe-{uuid.uuid4().hex[:10]}"
    }

    started_at = datetime.utcnow()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(json.dumps(probe_payload).encode('utf-8'), ('fluent-bit', target_port))
    finally:
        sock.close()

    loops = max(1, int(timeout_sec / poll_interval))
    for _ in range(loops):
        current = collect_fluent_bit_metrics()
        current_output = current.get('outputProcessed')
        if isinstance(current_output, int) and current_output > baseline_output:
            elapsed = (datetime.utcnow() - started_at).total_seconds()
            return round(max(elapsed, 0.001), 3), None
        time.sleep(poll_interval)

    return None, 'Probe timeout: output metriğinde artış gözlenmedi'


def get_cached_pipeline_probe_latency(probe_profile='METRICS_ONLY', ttl_seconds=90):
    now = datetime.utcnow()
    cached_ts = PIPELINE_LATENCY_PROBE_CACHE.get('timestamp')
    if cached_ts:
        age = (now - cached_ts).total_seconds()
        if age < ttl_seconds:
            return {
                'seconds': PIPELINE_LATENCY_PROBE_CACHE.get('seconds'),
                'status': PIPELINE_LATENCY_PROBE_CACHE.get('status', 'unknown'),
                'note': PIPELINE_LATENCY_PROBE_CACHE.get('note', ''),
                'measuredAt': cached_ts.isoformat() + 'Z'
            }

    latency_seconds, note = measure_pipeline_probe_latency(probe_profile=probe_profile)
    PIPELINE_LATENCY_PROBE_CACHE['timestamp'] = now
    PIPELINE_LATENCY_PROBE_CACHE['seconds'] = latency_seconds
    PIPELINE_LATENCY_PROBE_CACHE['status'] = 'success' if latency_seconds is not None else 'warning'
    PIPELINE_LATENCY_PROBE_CACHE['note'] = note or 'E2E latency ölçümü güncellendi'
    return {
        'seconds': latency_seconds,
        'status': PIPELINE_LATENCY_PROBE_CACHE['status'],
        'note': PIPELINE_LATENCY_PROBE_CACHE['note'],
        'measuredAt': now.isoformat() + 'Z'
    }


def _get_disk_usage():
    """Return disk usage percent for data dir."""
    for path in [DATA_DIR, BASE_DIR, Path('/')]:
        try:
            if path.exists():
                stat = os.statvfs(str(path))
                total = stat.f_blocks * stat.f_frsize
                free = stat.f_bavail * stat.f_frsize
                used = total - free
                return round(100.0 * used / total, 1) if total > 0 else 0
        except Exception:
            continue
    return None


def _env_file_get(key: str):
    """Son tanımlı KEY= satırı (.env); yorum satırları yok sayılır."""
    if not ENV_PATH.exists():
        return None
    try:
        text = ENV_PATH.read_text(errors='replace')
    except OSError:
        return None
    prefix = f'{key}='
    val = None
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith(prefix):
            val = s[len(prefix):].strip().strip('"').strip("'")
    return val


def _collect_data_path_isolation():
    """
    LOG_SYSTEM_ENV ile .env içindeki /log-hot/{ortam}/ yollarının uyumu.
    Yanlış ortam klasörü (ör. prod sunucuda staging yolu) log verisinin karışmasına yol açar.
    """
    env = (_env_file_get('LOG_SYSTEM_ENV') or 'dev').strip().lower()
    allowed_envs = {'prod', 'staging', 'dev', 'test'}
    if env not in allowed_envs:
        env = 'dev'

    check_keys = (
        'MONGODB_DATA_PATH',
        'OPENSEARCH_DATA1_PATH',
        'OPENSEARCH_DATA2_PATH',
        'OPENSEARCH_DATA3_PATH',
        'HOT_DATA_ROOT',
    )
    pattern = re.compile(r'/log-hot/(prod|staging|dev|test)(?:/|$)')
    seen = set()
    issues = []
    warnings = []

    for key in check_keys:
        v = (_env_file_get(key) or '').strip()
        if not v.startswith('/'):
            continue
        p = v.replace('\\', '/')
        for m in pattern.finditer(p):
            found = m.group(1)
            if found != env:
                t = (found, env, key)
                if t not in seen:
                    seen.add(t)
                    issues.append(
                        f'Bu sunucu «{env}» ortamı olarak işaretli; «{key}» yolunda «{found}» klasörü var. '
                        f'Farklı ortamların verisi aynı makinede karışmasın diye yolları düzeltin (Ayarlar → Depolama).'
                    )
            break

    mongo = (_env_file_get('MONGODB_DATA_PATH') or '').strip()
    if mongo.startswith('/') and '/log-hot/' in mongo.replace('\\', '/'):
        if f'/log-hot/{env}/' not in mongo.replace('\\', '/'):
            warnings.append(
                f'Kayıt klasörü «{env}» ortam klasörünü içermiyor; logların doğru yerde toplandığını doğrulayın.'
            )

    ok = len(issues) == 0
    return {
        'ok': ok,
        'environment': env,
        'issues': issues,
        'warnings': warnings,
        'label': 'Uyumlu' if ok and not warnings else ('Düzeltin' if not ok else 'İnceleyin'),
    }


def _collect_disk_storage_profile():
    """Panel uyarıları; eşikler preflight-env.sh / disk-plan-for-env.sh ile uyumlu tutulmalı."""
    min_prod_total_mib = 40960
    min_prod_free_mib = 1536
    rec_total_mib = 81920
    rec_free_mib = 10240
    min_dev_total_mib = 8192
    min_dev_free_mib = 512

    mongodb_raw = _env_file_get('MONGODB_DATA_PATH')
    log_env = (_env_file_get('LOG_SYSTEM_ENV') or os.environ.get('LOG_SYSTEM_ENV') or '').strip().lower()
    is_prod = log_env == 'prod'

    probe = DATA_DIR
    path_note = None
    # Mutlak host yolu (ör. /opt/log-system/data/mongodb_data) panel imajında yoksa bile Docker host üzerinden df ile ölç.
    host_disk_from_mongo_path = None
    if mongodb_raw:
        raw = mongodb_raw.strip()
        if raw.startswith('/'):
            candidate = Path(raw)
            if candidate.exists():
                probe = candidate
            else:
                hpi = _probe_path_info(raw) if docker_available and docker_client else None
                if hpi is not None:
                    tk = int(hpi.get('totalKBlocks') or 0)
                    ak = int(hpi.get('availKBlocks') or 0)
                    host_disk_from_mongo_path = {
                        'total_mib': max(0, tk // 1024),
                        'free_mib': max(0, ak // 1024),
                        'used_pct': round(100.0 * (tk - ak) / tk, 1) if tk > 0 else 0.0,
                        'same_as_root': _host_same_filesystem('/', raw),
                        'probe_label': raw,
                    }
                else:
                    path_note = (
                        'Kayıtlı veri klasörü sunucuda bulunamadı; ölçüm geçici olarak proje veri dizinine göre yapıldı. '
                        'Depolama bölümünden yolu kontrol edin.'
                    )
        else:
            probe = (BASE_DIR / raw.lstrip('./')).resolve()
            if not probe.exists():
                probe = DATA_DIR

    try:
        if host_disk_from_mongo_path is not None:
            total_mib = host_disk_from_mongo_path['total_mib']
            free_mib = host_disk_from_mongo_path['free_mib']
            used_pct = host_disk_from_mongo_path['used_pct']
            same_as_root = host_disk_from_mongo_path['same_as_root']
            probe = Path(host_disk_from_mongo_path['probe_label'])
        else:
            st_probe = os.stat(str(probe))
            st_root = os.stat('/')
            same_as_root = st_probe.st_dev == st_root.st_dev
            sv = os.statvfs(str(probe))
            total_b = sv.f_frsize * sv.f_blocks
            free_b = sv.f_frsize * sv.f_bavail
            total_mib = int(total_b // (1024 * 1024))
            free_mib = int(free_b // (1024 * 1024))
            used_pct = round(100.0 * (total_b - free_b) / total_b, 1) if total_b > 0 else 0.0
    except OSError as e:
        return {
            'ok': False,
            'error': str(e),
            'meetsMinimum': False,
            'showDiskRequirementBanner': False,
            'showSeparateDiskBanner': False,
            'showDataIsolationBanner': False,
            'messages': ['Depolama bilgisi okunamadı.'],
            'pathNote': path_note,
            'dataIsolation': {'ok': True, 'environment': '', 'issues': [], 'warnings': [], 'label': ''},
        }

    messages = []
    min_tot = min_prod_total_mib if is_prod else min_dev_total_mib
    min_free = min_prod_free_mib if is_prod else min_dev_free_mib
    meets = free_mib >= min_free and total_mib >= min_tot

    if not meets:
        if is_prod:
            if free_mib < min_prod_free_mib:
                messages.append(
                    f'Boş alan üretim için düşük (yaklaşık {free_mib // 1024} GB); en az ~1,5 GB boş bırakın.'
                )
            if total_mib < min_prod_total_mib:
                messages.append(
                    f'Disk toplam boyutu üretim için küçük görünüyor (~{total_mib // 1024} GB); en az ~40 GB önerilir.'
                )
        else:
            messages.append(
                'Geliştirme ortamı için yeterli olabilir; canlıya geçerken daha büyük veya ayrı veri diski planlayın.'
            )

    if is_prod and same_as_root:
        messages.append(
            'Log ve yedekler şu an işletim sistemiyle aynı disk bölümünde. Canlı kullanımda ayrı veri diski önerilir — '
            'Ayarlar sekmesinde Depolama bölümünden yönlendirilirsiniz.'
        )

    if is_prod and meets and total_mib < rec_total_mib:
        messages.append(
            f'Toplam kapasite önerilen ~80 GB seviyesinin biraz altında (~{total_mib // 1024} GB görünüyor). Mümkünse diski büyütün.'
        )

    if meets and free_mib < rec_free_mib:
        messages.append(
            f'Boş alan sıkışıyor (~{free_mib // 1024} GB); indeks ve arşiv için yer açın veya diski genişletin.'
        )

    data_isolation = _collect_data_path_isolation()
    messages.extend(data_isolation['warnings'])

    return {
        'ok': True,
        'probePath': str(probe),
        'totalMib': total_mib,
        'freeMib': free_mib,
        'usagePercent': used_pct,
        'sameFilesystemAsRoot': same_as_root,
        'isProd': is_prod,
        'meetsMinimum': meets,
        'showDiskRequirementBanner': bool(not meets and is_prod),
        'showSeparateDiskBanner': bool(is_prod and same_as_root),
        'showDataIsolationBanner': bool(not data_isolation['ok']),
        'pathNote': path_note,
        'messages': messages,
        'docPath': 'docs/PROD_KURULUM_DETAY.md',
        'dataIsolation': data_isolation,
    }


def _get_qc_stream_count():
    """Count messages in quality_control stream (last 1h). Graylog 6.1+: aggregate API."""
    try:
        streams_resp = _graylog_api_get('/streams')
        streams_resp.raise_for_status()
        streams = streams_resp.json().get('streams', [])
        qc = next((s for s in streams if s.get('title') == 'quality_control'), None)
        if not qc:
            return None
        from_ts = datetime.utcnow() - timedelta(hours=1)
        to_ts = datetime.utcnow()
        agg = {
            'query': '*',
            'streams': [qc['id']],
            'timerange': {
                'type': 'absolute',
                'from': from_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                'to': to_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            },
            'group_by': [{'field': 'source', 'limit': 500}],
            'metrics': [{'function': 'count'}],
        }
        r = _graylog_api_post('/search/aggregate', json=agg, timeout=15)
        if r.status_code != 200:
            return None
        rows = (r.json() or {}).get('datarows') or []
        total = 0
        for row in rows:
            if isinstance(row, list) and row:
                try:
                    total += int(row[-1])
                except (TypeError, ValueError):
                    continue
        return total
    except Exception:
        return None


def collect_fluent_bit_metrics():
    metrics = {
        'available': False,
        'inputRecords': None,
        'outputProcessed': None,
        'outputErrors': None,
        'note': ''
    }
    try:
        response = requests.get('http://fluent-bit:2020/api/v1/metrics/prometheus', timeout=3)
        if response.status_code != 200:
            metrics['note'] = f'metrics endpoint status={response.status_code}'
            return metrics
        text = response.text or ''
        metrics['available'] = True

        def pick(pattern):
            match = re.search(pattern, text)
            if not match:
                return None
            try:
                return int(float(match.group(1)))
            except Exception:
                return None

        metrics['inputRecords'] = pick(r'fluentbit_input_records_total\{[^}]*name="udp\.0"[^}]*\}\s+([0-9.eE+-]+)')
        metrics['outputProcessed'] = pick(r'fluentbit_output_proc_records_total\{[^}]*name="kafka\.1"[^}]*\}\s+([0-9.eE+-]+)')
        metrics['outputErrors'] = pick(r'fluentbit_output_errors_total\{[^}]*\}\s+([0-9.eE+-]+)')
        return metrics
    except Exception as e:
        metrics['note'] = str(e)
        return metrics


def _opensearch_internal_base_url() -> str:
    return (os.environ.get('OPENSEARCH_INTERNAL_URL') or 'https://opensearch1:9200').rstrip('/')


def _opensearch_admin_credentials():
    pw = (os.environ.get('OPENSEARCH_INITIAL_ADMIN_PASSWORD') or os.environ.get('OPENSEARCH_PASSWORD') or '').strip()
    user = (os.environ.get('OPENSEARCH_USER') or 'admin').strip()
    return user, pw


def run_settings_post_check(changed_key=None):
    checks = []
    suggestions = []

    try:
        docker_client.ping()
        docker_ok = True
        docker_note = 'Docker API erişilebilir'
    except Exception as e:
        docker_ok = False
        docker_note = f'Docker erişim hatası: {str(e)}'

    checks.append({
        'name': 'Health smoke',
        'status': 'success' if docker_ok else 'failed',
        'message': docker_note
    })
    if not docker_ok:
        suggestions.append('Docker daemon ve socket erişimini doğrulayın.')

    services_status = get_service_status()
    metrics = stack_health_metrics_from_services(services_status) if isinstance(services_status, dict) else {'running': 0, 'total': 0, 'problematic': 0}
    running_count = metrics['running']
    total_count = metrics['total']

    services_ok = running_count > 0
    if not services_ok:
        svc_readiness_status = 'failed'
    elif metrics['problematic'] > 0:
        svc_readiness_status = 'warning'
    else:
        svc_readiness_status = 'success'
    checks.append({
        'name': 'Service readiness',
        'status': svc_readiness_status,
        'message': (
            f'Çalışan: {running_count}/{total_count} • '
            f'sağlıksız veya durmuş (sorunlu): {metrics["problematic"]}'
        )
    })
    if not services_ok:
        suggestions.append('Servisler çalışmıyor görünüyor; Services sekmesinden toparlama yapın.')
    elif metrics['problematic'] > 0:
        suggestions.append('Bazı servisler unhealthy veya durmuş; OpenSearch/Graylog ve bağımlılıklarını kontrol edin.')

    ingest_ok = True
    ingest_note = 'Fluent Bit UDP ingest smoke başarılı'
    try:
        payload = {
            'time': datetime.utcnow().isoformat() + 'Z',
            'message': 'settings-post-check-smoke',
            'level': 'INFO',
            'source': 'dashboard-post-check',
            'pipeline_test': 'settings-post-check'
        }
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.sendto(json.dumps(payload).encode('utf-8'), ('fluent-bit', 5151))
        finally:
            sock.close()
    except Exception as e:
        ingest_ok = False
        ingest_note = f'Ingest smoke hatası: {str(e)}'

    checks.append({
        'name': 'Ingest smoke',
        'status': 'success' if ingest_ok else 'failed',
        'message': ingest_note
    })
    if not ingest_ok:
        suggestions.append('Fluent Bit UDP input portu ve network erişimini kontrol edin.')

    graylog_query_ok = False
    opensearch_query_ok = False
    query_messages = []
    try:
        resp = requests.get('http://graylog:9000/api/system/lbstatus', timeout=3)
        graylog_query_ok = resp.status_code == 200
        query_messages.append(f'Graylog: {resp.status_code}')
    except Exception as e:
        query_messages.append(f'Graylog: {str(e)}')

    try:
        base = _opensearch_internal_base_url()
        user, pw = _opensearch_admin_credentials()
        if not pw:
            query_messages.append('OpenSearch: OPENSEARCH_INITIAL_ADMIN_PASSWORD tanımlı değil')
            opensearch_query_ok = False
        else:
            resp = requests.get(f'{base}/_cluster/health', auth=(user, pw), verify=False, timeout=4)
            if resp.status_code == 200:
                opensearch_query_ok = True
                try:
                    body = resp.json()
                    query_messages.append(f"OpenSearch: cluster={body.get('status', '?')} nodes={body.get('number_of_nodes', '?')}")
                except Exception:
                    query_messages.append(f'OpenSearch: {resp.status_code}')
            else:
                query_messages.append(f'OpenSearch: HTTP {resp.status_code}')
    except Exception as e:
        query_messages.append(f'OpenSearch: {str(e)}')
        opensearch_query_ok = False

    query_ok = bool(graylog_query_ok and opensearch_query_ok)

    checks.append({
        'name': 'Query smoke',
        'status': 'success' if query_ok else 'failed',
        'message': ' • '.join(query_messages)
    })
    if not query_ok:
        suggestions.append('Graylog/OpenSearch query endpoint yanıtlarını kontrol edin.')

    env_map = parse_env_file(ENV_PATH)
    signer_type = str(env_map.get('SIGNER_TYPE', 'OPEN_SOURCE')).strip().upper()
    if signer_type == 'SIMULATED':
        checks.append({
            'name': 'İmzalama tipi',
            'status': 'warning',
            'message': '.env içinde SIGNER_TYPE=SIMULATED kalmış; Ayarlar’dan OPEN_SOURCE veya TUBITAK seçip kaydedin.'
        })
        suggestions.append('SIMULATED kaldırıldı; imza tipini güncelleyin.')

    failed_count = sum(1 for item in checks if item['status'] == 'failed')
    warning_count = sum(1 for item in checks if item['status'] == 'warning')
    success_count = sum(1 for item in checks if item['status'] == 'success')

    if failed_count > 0:
        overall = 'failed'
        summary = f'Post-check başarısız: {failed_count} kontrol hatalı.'
    elif warning_count > 0:
        overall = 'warning'
        summary = f'Post-check uyarılı tamamlandı: {warning_count} kontrol uyarı verdi.'
    else:
        overall = 'success'
        summary = f'Post-check başarılı: {success_count} kontrol geçti.'

    if not suggestions and overall == 'success':
        suggestions.append('Sistem sağlıklı görünüyor; değişiklik etkisini 1-2 dakika trendlerde izlemeye devam edin.')

    return {
        'status': overall,
        'summary': summary,
        'changedKey': changed_key,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'checks': checks,
        'suggestions': suggestions,
        'metrics': {
            'inputRecords': metrics.get('inputRecords'),
            'outputProcessed': metrics.get('outputProcessed'),
            'outputErrors': metrics.get('outputErrors')
        }
    }


def run_compose_sanity_check():
    services_status = get_service_status()
    checks = []
    cluster_os_keys_present = SANITY_OPENSEARCH_CLUSTER_NODES <= set(services_status.keys())
    cluster_os_both_running = cluster_os_keys_present and all(
        str(services_status.get(svc, {}).get('status', '')).lower() == 'running'
        for svc in SANITY_OPENSEARCH_CLUSTER_NODES
    )

    if not isinstance(services_status, dict) or 'error' in services_status:
        return {
            'status': 'failed',
            'summary': 'Servis durumu alınamadı',
            'checks': [{
                'name': 'Service status',
                'status': 'failed',
                'message': services_status.get('error', 'unknown error') if isinstance(services_status, dict) else 'invalid payload'
            }],
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'context': {'openSearchTopology': 'unknown', 'notes': []},
        }

    required = set(SANITY_REQUIRED_SERVICES_BASE)
    if SANITY_OPENSEARCH_CLUSTER_NODES & set(services_status.keys()):
        required |= SANITY_OPENSEARCH_CLUSTER_NODES

    running = []
    missing = []
    for svc in sorted(required):
        entry = services_status.get(svc)
        if entry and str(entry.get('status', '')).lower() == 'running':
            running.append(svc)
        else:
            missing.append(svc)

    checks.append({
        'name': 'Core services',
        'status': 'success' if not missing else 'failed',
        'message': (
            f'Zorunlu servisler {len(running)}/{len(required)} çalışıyor'
            + (f' • Eksik veya durmuş: {", ".join(missing)}' if missing else '')
        ),
    })

    aux_bad = []
    for svc in sorted(SANITY_AUXILIARY_IF_PRESENT):
        entry = services_status.get(svc)
        if not entry:
            continue
        if str(entry.get('status', '')).lower() != 'running':
            aux_bad.append(svc)
    if aux_bad:
        checks.append({
            'name': 'Yardımcı servisler',
            'status': 'warning',
            'message': 'Tanımlı ama çalışmıyor: ' + ', '.join(aux_bad),
        })

    try:
        fb = requests.get('http://fluent-bit:2020', timeout=3)
        checks.append({
            'name': 'Fluent Bit endpoint',
            'status': 'success' if fb.status_code == 200 else 'warning',
            'message': f'status={fb.status_code}'
        })
    except Exception as e:
        checks.append({'name': 'Fluent Bit endpoint', 'status': 'failed', 'message': str(e)})

    try:
        gl = requests.get('http://graylog:9000/api/system/lbstatus', timeout=4)
        checks.append({
            'name': 'Graylog API',
            'status': 'success' if gl.status_code == 200 and 'ALIVE' in (gl.text or '') else 'failed',
            'message': (gl.text or '').strip()[:160] if gl.text else f'status={gl.status_code}'
        })
    except Exception as e:
        checks.append({'name': 'Graylog API', 'status': 'failed', 'message': str(e)})

    try:
        base = _opensearch_internal_base_url()
        user, pw = _opensearch_admin_credentials()
        if not pw:
            checks.append({
                'name': 'OpenSearch cluster',
                'status': 'failed',
                'message': 'OPENSEARCH_INITIAL_ADMIN_PASSWORD tanımlı değil (.env)'
            })
        else:
            resp = requests.get(f'{base}/_cluster/health', auth=(user, pw), verify=False, timeout=6)
            cluster = resp.json() if resp.status_code == 200 else {}
            status = str(cluster.get('status', 'unknown')).lower()
            nodes = int(cluster.get('number_of_nodes', 0) or 0)
            if resp.status_code != 200:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'failed',
                    'message': f'HTTP {resp.status_code}: {(resp.text or "")[:120]}'
                })
            elif status == 'red' or nodes < 1:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'failed',
                    'message': f'status={status} nodes={nodes}'
                })
            elif cluster_os_keys_present and not cluster_os_both_running:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'failed',
                    'message': (
                        'Küme konteynerleri (opensearch2/opensearch3) tanımlı ama ikisi de çalışmıyor; '
                        'tam küme veya tek düğüme dönüş için compose/profil durumunu kontrol edin.'
                    ),
                })
            elif cluster_os_both_running and nodes < 3:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'failed',
                    'message': (
                        f'Üç düğümlü küme bekleniyordu; API number_of_nodes={nodes} '
                        f'(ağ, sertifika veya discovery ile düğümler birleşmemiş olabilir).'
                    ),
                })
            elif status == 'green':
                msg = f'status={status} nodes={nodes}'
                if cluster_os_both_running:
                    msg += ' (3 düğüm küme)'
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'success',
                    'message': msg,
                })
            elif status == 'yellow' and nodes >= 1 and not cluster_os_both_running:
                # Tek düğüm: replica olmayan indekslerde yellow normal.
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'success',
                    'message': f'status={status} nodes={nodes} (tek düğüm için normal)',
                })
            elif status == 'yellow' and cluster_os_both_running and nodes >= 3:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'warning',
                    'message': (
                        f'status={status} nodes={nodes} — küme ayakta; '
                        f'shard/replica veya indeks ayarı kontrolü önerilir.'
                    ),
                })
            else:
                checks.append({
                    'name': 'OpenSearch cluster',
                    'status': 'warning',
                    'message': f'status={status} nodes={nodes}'
                })
    except Exception as e:
        checks.append({'name': 'OpenSearch cluster', 'status': 'failed', 'message': str(e)})

    failed = sum(1 for c in checks if c['status'] == 'failed')
    warning = sum(1 for c in checks if c['status'] == 'warning')
    if failed > 0:
        overall = 'failed'
        summary = f'Sanity failed ({failed} failed, {warning} warning)'
    elif warning > 0:
        overall = 'warning'
        summary = f'Sanity warning ({warning} warning)'
    else:
        overall = 'success'
        summary = 'Sanity passed'

    if cluster_os_keys_present:
        os_topo = 'cluster-3'
        os_notes = (
            'OpenSearch çok düğüm: opensearch2+opensearch3 yalnızca «opensearch-cluster» profili (veya tam küme compose) '
            'ile başlar; yoğun log bunu otomatik tetiklemez. Graylog’un çok URL kullanması için .env/override gerekir.'
        )
    else:
        os_topo = 'single-node'
        os_notes = (
            'OpenSearch tek düğüm (varsayılan): yalnızca opensearch1. Üç düğüm için: '
            '`docker compose --profile opensearch-cluster up -d` ve sertifika/discovery uyumu.'
        )

    return {
        'status': overall,
        'summary': summary,
        'checks': checks,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'context': {
            'openSearchTopology': os_topo,
            'notes': [os_notes],
        },
    }


def run_flow_smoke_test():
    test_id = f"panel_flow_{int(time.time())}_{random.randint(1000, 9999)}"
    payload = {
        'time': datetime.utcnow().isoformat() + 'Z',
        'host': 'log-management-ui',
        'message': f'Panel flow smoke test {test_id}',
        'level': 'INFO',
        'source': 'panel-flow-test',
        'test_id': test_id
    }

    checks = []
    udp_ok = True
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.sendto(json.dumps(payload).encode('utf-8'), ('fluent-bit', 5151))
        finally:
            sock.close()
    except Exception as e:
        udp_ok = False
        checks.append({'name': 'UDP send', 'status': 'failed', 'message': str(e)})

    if udp_ok:
        checks.append({'name': 'UDP send', 'status': 'success', 'message': 'Payload sent to fluent-bit:5151'})

    hit_count = 0
    search_error = None
    base = _opensearch_internal_base_url()
    user, pw = _opensearch_admin_credentials()
    os_auth = (user, pw) if pw else None

    for _ in range(5):
        try:
            if not os_auth:
                search_error = 'OPENSEARCH_INITIAL_ADMIN_PASSWORD tanımlı değil'
                break
            resp = requests.get(
                f'{base}/_search',
                auth=os_auth,
                verify=False,
                params={'q': f'test_id:{test_id}'},
                timeout=6
            )
            data = resp.json() if resp.headers.get('content-type', '').startswith('application/json') else {}
            total = data.get('hits', {}).get('total', {})
            if isinstance(total, dict):
                hit_count = int(total.get('value', 0) or 0)
            elif isinstance(total, int):
                hit_count = total
            if hit_count > 0:
                break
            if resp.status_code == 401:
                search_error = 'OpenSearch 401 (kimlik bilgisi kontrol edin)'
                break
        except Exception as e:
            search_error = str(e)
        time.sleep(1.2)

    if hit_count > 0:
        checks.append({'name': 'OpenSearch lookup', 'status': 'success', 'message': f'hits={hit_count} test_id={test_id}'})
    else:
        checks.append({'name': 'OpenSearch lookup', 'status': 'failed', 'message': search_error or f'No hits for {test_id}'})

    graylog_alive = False
    try:
        gl = requests.get('http://graylog:9000/api/system/lbstatus', timeout=4)
        graylog_alive = gl.status_code == 200 and 'ALIVE' in (gl.text or '')
        checks.append({
            'name': 'Graylog lbstatus',
            'status': 'success' if graylog_alive else 'failed',
            'message': (gl.text or '').strip()[:120] if gl.text else f'status={gl.status_code}'
        })
    except Exception as e:
        checks.append({'name': 'Graylog lbstatus', 'status': 'failed', 'message': str(e)})

    failed = sum(1 for c in checks if c['status'] == 'failed')
    return {
        'status': 'success' if failed == 0 else 'failed',
        'summary': 'Flow test passed' if failed == 0 else f'Flow test failed ({failed} check) ',
        'checks': checks,
        'testId': test_id,
        'timestamp': datetime.utcnow().isoformat() + 'Z'
    }


def run_stream_search_repair():
    graylog_password = os.environ.get('GRAYLOG_ROOT_PASSWORD', 'admin')
    auth = ('admin', graylog_password)
    headers = {'X-Requested-By': 'log-management-ui'}
    results = []

    for index_set_id in STREAM_DEFLECTOR_INDEX_SET_IDS:
        try:
            resp = requests.post(
                f'http://graylog:9000/api/cluster/deflector/{index_set_id}/cycle',
                auth=auth,
                headers=headers,
                timeout=8
            )
            ok = resp.status_code in (200, 204)
            results.append({
                'indexSetId': index_set_id,
                'status': 'success' if ok else 'failed',
                'message': f'HTTP {resp.status_code}'
            })
        except Exception as e:
            results.append({'indexSetId': index_set_id, 'status': 'failed', 'message': str(e)})

    rebuild_status = 'failed'
    rebuild_message = ''
    try:
        rb = requests.post(
            'http://graylog:9000/api/system/indices/ranges/rebuild',
            auth=auth,
            headers=headers,
            timeout=8
        )
        rebuild_status = 'success' if rb.status_code in (200, 202, 204) else 'failed'
        rebuild_message = f'HTTP {rb.status_code}'
    except Exception as e:
        rebuild_message = str(e)

    checks = [{
        'name': 'Deflector cycle',
        'status': 'success' if all(item['status'] == 'success' for item in results) else 'warning',
        'message': f"{sum(1 for i in results if i['status'] == 'success')}/{len(results)} index set cycled"
    }, {
        'name': 'Range rebuild',
        'status': rebuild_status,
        'message': rebuild_message
    }]

    failed = sum(1 for c in checks if c['status'] == 'failed')
    return {
        'status': 'success' if failed == 0 else 'failed',
        'summary': 'Stream search repair executed',
        'checks': checks,
        'details': results,
        'timestamp': datetime.utcnow().isoformat() + 'Z'
    }


def _ensure_docker_image(image: str, pull_timeout_sec: int = 180) -> None:
    """İmaj yoksa çek; zaman aşımı ile (DNS/registry takılmalarını önler)."""
    if not docker_client:
        return
    try:
        docker_client.images.get(image)
        return
    except docker_errors.ImageNotFound:
        pass
    except Exception:
        pass

    def _pull():
        docker_client.images.pull(image)

    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(_pull)
        try:
            fut.result(timeout=pull_timeout_sec)
        except FuturesTimeout:
            raise RuntimeError(
                f'Docker imajı {pull_timeout_sec}s içinde çekilemedi: {image}. '
                f'Konutta deneyin: docker pull {image}'
            ) from None


def _container_run_wait_logs(
    image: str,
    command,
    *,
    volumes=None,
    environment=None,
    user='0',
    privileged=False,
    network_mode=None,
    pid_mode=None,
    run_timeout_sec: int = 60,
) -> bytes:
    """detach + wait + loglar; süre aşımında konteyner sonlandırılır."""
    if not docker_client:
        raise RuntimeError('Docker API erişilemiyor')
    volumes = volumes or {}
    environment = environment or {}
    container = None
    try:
        _ensure_docker_image(image)
        run_kw = dict(
            image=image,
            command=command,
            detach=True,
            remove=False,
            volumes=volumes,
            environment=environment,
            user=user,
            privileged=privileged,
        )
        if network_mode:
            run_kw['network_mode'] = network_mode
        if pid_mode:
            run_kw['pid_mode'] = pid_mode
        container = docker_client.containers.run(**run_kw)
        try:
            wait_ret = container.wait(timeout=run_timeout_sec)
        except TypeError:
            with ThreadPoolExecutor(max_workers=1) as ex:
                fut = ex.submit(container.wait)
                try:
                    wait_ret = fut.result(timeout=run_timeout_sec)
                except FuturesTimeout:
                    raise RuntimeError(
                        f'Docker işlemi {run_timeout_sec}s içinde bitmedi ({image}).'
                    ) from None
        if isinstance(wait_ret, dict):
            exit_code = int(wait_ret.get('StatusCode', -1))
        else:
            exit_code = int(wait_ret) if wait_ret is not None else 0
        logs = container.logs(stdout=True, stderr=True) or b''
        if exit_code != 0:
            msg = logs.decode('utf-8', errors='replace').strip() or f'çıkış kodu {exit_code}'
            raise RuntimeError(msg[:4000])
        return logs
    except Exception as e:
        err_low = str(e).lower()
        if 'timeout' in err_low or 'timed out' in err_low:
            raise RuntimeError(
                f'Docker konteyneri {run_timeout_sec}s içinde tamamlanmadı ({image}). '
                'İmaj çekimi veya disk taraması gecikmiş olabilir; tekrar deneyin.'
            ) from e
        raise
    finally:
        if container is not None:
            try:
                container.reload()
                if container.status == 'running':
                    container.kill()
            except Exception:
                pass
            try:
                container.remove(force=True)
            except Exception:
                pass


def _run_host_probe(host_path, script, mode='ro'):
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    if not host_path or not str(host_path).startswith('/'):
        raise RuntimeError(f'Geçersiz host path: {host_path}')

    image = 'alpine:3.20'
    command = ['sh', '-lc', script]
    volumes = {str(host_path): {'bind': '/host-path', 'mode': mode}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    raw = _container_run_wait_logs(
        image,
        command,
        volumes=volumes,
        user='0',
        network_mode='none',
        run_timeout_sec=tout,
    )
    return raw.decode('utf-8', errors='ignore').strip()


def _probe_path_info(host_path):
    # Pipe ayırıcı awk içinde tırnaklı olmalı; $1""|""$2"" BusyBox awk'ta sözdizimi hatası (keşif hep boş kalır).
    info_script = (
        "set -e; [ -d /host-path ] || exit 12; "
        "df -P /host-path | tail -n1 | awk '{print $1\"|\"$2\"|\"$4\"|\"$6}'"
    )
    try:
        out = _run_host_probe(host_path, info_script, mode='ro')
    except Exception:
        return None

    parts = out.split('|')
    if len(parts) < 4:
        return None

    try:
        total_k = int(parts[1])
    except Exception:
        total_k = 0
    try:
        avail_k = int(parts[2])
    except Exception:
        avail_k = 0

    writable = True
    try:
        _run_host_probe(host_path, 'set -e; [ -d /host-path ] || exit 12; touch /host-path/.panel_write_probe && rm -f /host-path/.panel_write_probe', mode='rw')
    except Exception:
        writable = False

    return {
        'path': host_path,
        'device': parts[0],
        'mountpoint': parts[3],
        'totalKBlocks': total_k,
        'availKBlocks': avail_k,
        'totalGB': round(total_k / 1024 / 1024, 2),
        'availableGB': round(avail_k / 1024 / 1024, 2),
        'writable': writable
    }


def _host_abs_to_container_mount(host_abs: str) -> str:
    """Host mutlak yolu, host / bind-mount’lu konteyner içi yolu (/host/...)."""
    h = (host_abs or '').strip().rstrip('/') or '/'
    if not h.startswith('/'):
        raise ValueError('host path mutlak olmalı')
    if h == '/':
        return '/host'
    return '/host' + h


def _host_path_dir_non_empty(host_abs: str) -> bool:
    """Host mutlak yol dizin mi ve içinde en az bir girdi var mı (mount öncesi relocate önerisi için)."""
    try:
        hp = _host_abs_to_container_mount(host_abs)
    except ValueError:
        return False
    script = (
        'set -eu; D=' + shlex.quote(hp) + '; '
        'if [ ! -d "$D" ]; then echo 0; '
        'elif [ -z "$(ls -A "$D" 2>/dev/null)" ]; then echo 0; '
        'else echo 1; fi'
    )
    image = 'alpine:3.20'
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            image,
            ['sh', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=tout,
        )
        return raw.decode('utf-8', errors='replace').strip() == '1'
    except Exception:
        return False


def _host_same_filesystem(host_a: str, host_b: str) -> bool:
    """İki host yolu aynı dosya sistemi üzerinde mi (stat st_dev). df $1 karşılaştırmasından güvenilir (dm vs mapper)."""
    try:
        ca = _host_abs_to_container_mount(host_a)
        cb = _host_abs_to_container_mount(host_b)
    except ValueError:
        return True
    script = (
        'set -eu; '
        f'test -e {shlex.quote(ca)} || exit 2; test -e {shlex.quote(cb)} || exit 2; '
        f'sa=$(stat -c %d {shlex.quote(ca)}); sb=$(stat -c %d {shlex.quote(cb)}); '
        '[ "$sa" = "$sb" ] && echo 1 || echo 0'
    )
    image = 'alpine:3.20'
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            image,
            ['sh', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=tout,
        )
        out = raw.decode('utf-8', errors='replace').strip()
        return out == '1' or out.endswith('1')
    except Exception:
        try:
            ia = _probe_path_info(host_a)
            ib = _probe_path_info(host_b)
            if ia and ib and ia.get('device') and ib.get('device'):
                return ia.get('device') == ib.get('device')
        except Exception:
            pass
        return True


def _storage_path_allowed_under_opt(selected_path: str) -> bool:
    """Yalnızca ayrı diske bağlı /opt/log-system/data kabul edilir; kod kökü seçilemez."""
    norm = selected_path.rstrip('/')
    if norm == '/opt/log-system/data':
        return True
    if norm == '/opt/log-system' or selected_path.startswith('/opt/log-system/'):
        return False
    return not selected_path.startswith('/opt/log-system')


def discover_storage_candidates():
    env_map = parse_env_file(ENV_PATH)
    known_paths = {
        env_map.get('HOT_DATA_ROOT', ''),
        env_map.get('ARCHIVE_DATA_ROOT', ''),
        env_map.get('DATA_ROOT_PATH', ''),
    }
    known_paths = {p for p in known_paths if p and p.startswith('/')}

    roots = ['/mnt', '/media', '/srv', '/data']
    candidates = set(known_paths)
    # vCenter ikinci disk: genelde /opt/log-system/data (proje küçük diskte, veri burada)
    candidates.add('/opt/log-system/data')

    root_info = _probe_path_info('/')
    root_device = root_info.get('device') if root_info else ''

    for root in roots:
        meta = _probe_path_info(root)
        if not meta:
            continue
        candidates.add(root)
        try:
            dirs_output = _run_host_probe(root, 'set -e; [ -d /host-path ] || exit 12; find /host-path -mindepth 1 -maxdepth 1 -type d -printf "%f\\n"', mode='ro')
            for item in dirs_output.splitlines():
                item = item.strip()
                if not item:
                    continue
                candidates.add(f'{root.rstrip('/')}/{item}')
        except Exception:
            continue

    result = []
    for path in sorted(candidates):
        info = _probe_path_info(path)
        if not info:
            continue
        path_norm = path.rstrip('/') or '/'
        same_as_root = _host_same_filesystem('/', path_norm)
        opt_data_mount = path_norm == '/opt/log-system/data'
        info['recommended'] = (
            info.get('writable', False)
            and (not same_as_root)
            and (not path.startswith('/opt/log-system') or opt_data_mount)
        )
        result.append(info)

    result.sort(key=lambda x: (0 if x.get('recommended') else 1, x.get('path', '')))
    return {
        'rootDevice': root_device,
        'items': result
    }


STORAGE_DATA_MOUNT_DEFAULT = '/opt/log-system/data'

# Genişletme: df kaynağı veya findmnt; kök disk (/dev/sdb) dışlanır (yalnızca bölüm).
_DATA_DISK_PARTITION_DEV_RE = re.compile(
    r'^/dev/(?:'
    r'(?:sd|vd|xvd)[a-z]+\d+|'
    r'nvme\d+n\d+p\d+|'
    r'mmcblk\d+p\d+'
    r')$'
)


def effective_storage_env_name() -> str:
    """log-hot/{env}/… yolları: panelden seçim yerine sunucu APP_ENV / LOG_SYSTEM_ENV (prod|dev|staging)."""
    raw = (os.environ.get('APP_ENV') or os.environ.get('LOG_SYSTEM_ENV') or 'prod').strip().lower()
    env = re.sub(r'[^a-z0-9_-]+', '', raw) or 'prod'
    if env not in ('prod', 'dev', 'staging'):
        env = 'prod'
    return env


class StorageProfileSameRootFilesystem(Exception):
    """Veri yolu / ile aynı FS; API 409 + acknowledgeRootFilesystem veya env ile devam."""

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(
            'Veri yolu henüz OS kökü ile aynı dosya sistemi üzerinde; ayrı diski mount edin veya onaylayın.'
        )


def storage_mount_status_snapshot():
    """Panel: /opt/log-system/data gerçekten ayrı diskte mi (df/st_dev)."""
    path = STORAGE_DATA_MOUNT_DEFAULT
    root = _probe_path_info('/')
    data = _probe_path_info(path)
    same = _host_same_filesystem('/', path)
    allow_extra_prepare = str(os.environ.get('LOG_SYSTEM_ALLOW_EXTRA_DATA_DISK_PREPARE') or '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    # Tek harici veri VMDK: kökten ayrı FS görülünce yeni ham disk hazırlığı panelden kapatılır (genişletme kalır).
    prepare_new_raw_disk_allowed = bool(allow_extra_prepare or same)
    data_disk_phase = 'bound' if (data is not None and not same) else 'initial'
    lines = []
    if same:
        lines.append(
            f'{path} şu an kök (/) ile aynı dosya sisteminde. vCenter’da eklenen ikinci VMDK konutta '
            f'«Diski hazırla ve .env uygula» ile bu dizine bağlanmalı (veya elle fstab+mount).'
        )
    else:
        lines.append(f'{path} kök dosya sisteminden ayrı görünüyor; storage profile uygulanabilir.')
    if root and data:
        lines.append(f'Kök kaynak: {root.get("device") or "?"} • Veri kaynağı: {data.get("device") or "?"}')
    if data is not None and not same:
        lines.append(
            'Politika: Tek harici veri diski — panelden ikinci bir ham disk hazırlığı kapalı; alan için aynı VMDK’yı '
            'büyütüp «Genişlet» kullanın. İstisna: LOG_SYSTEM_ALLOW_EXTRA_DATA_DISK_PREPARE=1.'
        )
    return {
        'dataPath': path,
        'sameFilesystemAsRoot': same,
        'rootSource': root.get('device') if root else None,
        'dataSource': data.get('device') if data else None,
        'rootMountpoint': root.get('mountpoint') if root else None,
        'dataMountpoint': data.get('mountpoint') if data else None,
        'dataProbeOk': data is not None,
        'dataWritable': bool(data and data.get('writable')),
        'status': 'same_as_root' if same else 'separate',
        'summaryLines': lines,
        'prepareNewRawDiskAllowed': prepare_new_raw_disk_allowed,
        'dataDiskPhase': data_disk_phase,
    }


def _partition_number_from_devpath(devpath: str):
    """/dev/sdb1 -> 1, /dev/nvme0n1p3 -> 3 (panel hazırlığındaki GPT tek bölüm senaryosu)."""
    base = (devpath or '').rstrip('/').rsplit('/', 1)[-1]
    if re.search(r'p\d+$', base):
        m = re.search(r'p(\d+)$', base)
        return int(m.group(1)) if m else None
    m = re.search(r'(\d+)$', base)
    return int(m.group(1)) if m else None


def _findmnt_probe_image() -> str:
    """Alpine tabanında findmnt yok; lsblk ile aynı Ubuntu imajı (LOG_SYSTEM_LSBLK_IMAGE)."""
    return (
        os.environ.get('LOG_SYSTEM_FINDMNT_IMAGE')
        or os.environ.get('LOG_SYSTEM_LSBLK_IMAGE')
        or 'ubuntu:22.04'
    ).strip() or 'ubuntu:22.04'


def _host_partition_dev_from_df(mount_host_path: str):
    """df çıktısındaki aygıt: fstab UUID olsa bile çoğu kurulumda /dev/sdXn gösterir."""
    info = _probe_path_info(mount_host_path)
    if not info:
        return None
    dev = (info.get('device') or '').strip()
    if not dev.startswith('/dev/'):
        return None
    if '/dev/mapper/' in dev or dev.startswith('/dev/dm-'):
        return None
    if not _DATA_DISK_PARTITION_DEV_RE.match(dev):
        return None
    return dev


def _host_findmnt_blk_source(mount_host_path: str):
    """findmnt SOURCE → bölüm aygıtı; UUID=/PARTUUID=/LABEL= /host/dev/disk/by-* ile çözülür."""
    try:
        mp = _host_abs_to_container_mount(mount_host_path)
    except ValueError:
        return None
    qmp = shlex.quote(mp)
    script = (
        'set -eu\n'
        f'MP={qmp}\n'
        'SRC=$(findmnt -nro SOURCE --target "$MP" 2>/dev/null || true)\n'
        'test -n "$SRC"\n'
        'SRC=$(printf %s "$SRC" | tr -d \'"\')\n'
        'DEV=\n'
        'case "$SRC" in\n'
        '  /dev/*)\n'
        '    DEV="$SRC"\n'
        '    ;;\n'
        '  UUID=*)\n'
        '    U="${SRC#UUID=}"\n'
        '    if [ -e "/host/dev/disk/by-uuid/$U" ]; then\n'
        '      DEV=$(readlink -f "/host/dev/disk/by-uuid/$U" 2>/dev/null || true)\n'
        '    fi\n'
        '    if [ -z "$DEV" ] && command -v blkid >/dev/null 2>&1; then\n'
        '      DEV=$(blkid -U "$U" -o device 2>/dev/null | head -n1 || true)\n'
        '    fi\n'
        '    ;;\n'
        '  PARTUUID=*)\n'
        '    P="${SRC#PARTUUID=}"\n'
        '    if [ -e "/host/dev/disk/by-partuuid/$P" ]; then\n'
        '      DEV=$(readlink -f "/host/dev/disk/by-partuuid/$P" 2>/dev/null || true)\n'
        '    fi\n'
        '    if [ -z "$DEV" ] && command -v blkid >/dev/null 2>&1; then\n'
        '      DEV=$(blkid --match-token "PARTUUID=$P" -o device 2>/dev/null | head -n1 || true)\n'
        '    fi\n'
        '    ;;\n'
        '  LABEL=*)\n'
        '    L="${SRC#LABEL=}"\n'
        '    if command -v blkid >/dev/null 2>&1; then\n'
        '      DEV=$(blkid -L "$L" -o device 2>/dev/null | head -n1 || true)\n'
        '    fi\n'
        '    ;;\n'
        '  *)\n'
        '    exit 4\n'
        '    ;;\n'
        'esac\n'
        'test -n "$DEV"\n'
        'case "$DEV" in /dev/*) ;; *) exit 5 ;; esac\n'
        'test -b "$DEV"\n'
        'printf %s "$DEV"\n'
    )
    image = _findmnt_probe_image()
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            image, ['bash', '-lc', script], volumes=vol, user='0', network_mode='none', run_timeout_sec=tout
        )
        out = raw.decode('utf-8', errors='replace').strip()
        return out if out.startswith('/dev/') else None
    except Exception:
        return None


def _data_mount_partition_for_grow(mount_host_path: str):
    """Önce df (hızlı, panel fstab UUID ile uyumlu); olmazsa findmnt + UUID çözümü."""
    dev = _host_partition_dev_from_df(mount_host_path)
    if dev:
        return dev
    return _host_findmnt_blk_source(mount_host_path)


def _lsblk_sidecar_image() -> str:
    """Alpine tabanında lsblk yok; JSON liste ve bölüm boyutu aynı imajda (LOG_SYSTEM_LSBLK_IMAGE)."""
    return (os.environ.get('LOG_SYSTEM_LSBLK_IMAGE') or 'ubuntu:22.04').strip() or 'ubuntu:22.04'


def _host_lsblk_bsize_bytes(dev: str) -> int:
    vol = {'/dev': {'bind': '/dev', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    script = 'set -e; lsblk -b -ndo SIZE ' + shlex.quote(dev) + ' | head -n1'
    raw = _container_run_wait_logs(
        _lsblk_sidecar_image(),
        ['bash', '-lc', script],
        volumes=vol,
        user='0',
        network_mode='none',
        run_timeout_sec=tout,
    )
    return int(raw.decode('utf-8', errors='replace').strip() or 0)


def _host_lsblk_parent_disk_path(partition_dev: str):
    vol = {'/dev': {'bind': '/dev', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    script = 'set -e; PK=$(lsblk -ndo PKNAME ' + shlex.quote(partition_dev) + ' | head -n1); test -n "$PK"; ' \
        'case "$PK" in /dev/*) printf %s "$PK" ;; *) printf "/dev/%s" "$PK" ;; esac'
    raw = _container_run_wait_logs(
        _lsblk_sidecar_image(),
        ['bash', '-lc', script],
        volumes=vol,
        user='0',
        network_mode='none',
        run_timeout_sec=tout,
    )
    out = raw.decode('utf-8', errors='replace').strip()
    return out if out.startswith('/dev/') else None


def _host_df_total_kib(mount_host_path: str) -> int:
    try:
        mp = _host_abs_to_container_mount(mount_host_path)
    except ValueError:
        return 0
    script = 'df -P ' + shlex.quote(mp) + " 2>/dev/null | tail -n1 | awk '{print $2}'"
    image = 'alpine:3.20'
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            image, ['sh', '-lc', script], volumes=vol, user='0', network_mode='none', run_timeout_sec=tout
        )
        return int(raw.decode('utf-8', errors='replace').strip() or 0)
    except Exception:
        return 0


def _host_mount_vfstype(mount_host_path: str) -> str:
    """Mount noktasındaki gerçek FS tipi (findmnt; /proc/mounts awk eşlemesi bind/escape ile kaçabilir)."""
    try:
        mp = _host_abs_to_container_mount(mount_host_path)
    except ValueError:
        return 'unknown'
    script = 'findmnt -nro FSTYPE --target ' + shlex.quote(mp) + ' 2>/dev/null || true'
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            _findmnt_probe_image(),
            ['bash', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=tout,
        )
        out = (raw.decode('utf-8', errors='replace').strip() or '').lower()
        return out if out else 'unknown'
    except Exception:
        return 'unknown'


def _host_blkid_fs_type(partition_dev: str) -> str:
    """Bölüm üzerinde blkid TYPE (findmnt unknown iken ext4 doğrulama)."""
    dev = (partition_dev or '').strip()
    if not dev.startswith('/dev/'):
        return ''
    vol = {'/dev': {'bind': '/dev', 'mode': 'ro'}}
    script = 'blkid -o value -s TYPE ' + shlex.quote(dev) + ' 2>/dev/null | head -n1'
    try:
        raw = _container_run_wait_logs(
            _lsblk_sidecar_image(),
            ['bash', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=15,
        )
        return (raw.decode('utf-8', errors='replace').strip() or '').lower()
    except Exception:
        return ''


def _storage_partition_tail_min_grow_bytes(disk_bytes: int) -> int:
    """
    Sanal disk sonunda GPT bölümüne yansımamış alan eşiği.
    ~%1–2 kuyruk (ör. 50G diskte ~2G) çoğu kurulumda hizalama/EFI önbelleği iken «genişlet» tetiklenmesin;
    anlamlı büyüme için ~%4.5 ve üzeri (üst sınır 4 GiB) aranır.
    """
    if disk_bytes <= 0:
        return 256 * 1024 * 1024
    pct = int(disk_bytes * 0.045)
    capped = min(4 * 1024 * 1024 * 1024, pct)
    return max(256 * 1024 * 1024, capped)


def _storage_df_total_vs_block_slack(block_bytes: int) -> int:
    """
    ext4 df toplamı, ayrılmış blok + meta veri yüzünden bölüm/LV blok boyutundan küçük görünür.
    ~%5 ayrılmış blok + güven payı → yanlış «resize2fs gerekir» tetiklenmesin.
    """
    if block_bytes <= 0:
        return 128 * 1024 * 1024
    pct = int(block_bytes * 0.07)
    return max(128 * 1024 * 1024, min(6 * 1024 * 1024 * 1024, pct))


def _storage_pv_report_vs_partition_slack(part_bytes: int) -> int:
    """pvs pv_size ile lsblk bölümü arasındaki tipik yuvarlama (birkaç MiB–yüz MiB)."""
    if part_bytes <= 0:
        return 64 * 1024 * 1024
    return max(64 * 1024 * 1024, min(512 * 1024 * 1024, int(part_bytes * 0.005)))


def data_disk_grow_status_snapshot() -> dict:
    """
    vCenter’da veri VMDK büyütüldükten sonra: disk > bölüm veya bölüm > fs ise genişletme önerilir.
    Yalnızca /opt/log-system/data ayrı FS + düz /dev/sdX1|nvme* stili (LVM değil).
    """
    mp = STORAGE_DATA_MOUNT_DEFAULT
    slack = 64 * 1024 * 1024
    if _host_same_filesystem('/', mp):
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'same_fs_as_root',
            'message': 'Veri dizini kök diskle aynı FS; bu akış yalnızca ayrı veri diski için geçerlidir.',
        }
    src = _data_mount_partition_for_grow(mp)
    if not src:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'no_block_source',
            'message': (
                'Bölüm aygıtı okunamadı (LVM/device-mapper, desteklenmeyen df/findmnt çıktısı veya Docker imajı '
                '(ubuntu:22.04 / LOG_SYSTEM_LSBLK_IMAGE) çekilemiyor). Önerilen düzen: ext4, tek GPT bölümü, '
                '/opt/log-system/data → /dev/sdXn veya nvme…p1.'
            ),
        }
    if '/dev/mapper/' in src or src.startswith('/dev/dm-'):
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'device_mapper',
            'message': (
                'Veri yolu LVM/device-mapper; panel bu düzende otomatik genişletmeyi desteklemiyor. '
                'Önerilen düzen: ext4 ve tek GPT bölümü (ör. /dev/sdX1) veya ham disk.'
            ),
            'partitionPath': src,
        }
    part_num = _partition_number_from_devpath(src)
    if part_num is None:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'partition_parse',
            'message': 'Bölüm numarası çıkarılamadı.',
            'partitionPath': src,
        }
    disk_path = _host_lsblk_parent_disk_path(src)
    if not disk_path:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'no_parent_disk',
            'message': 'Üst disk bulunamadı.',
            'partitionPath': src,
        }
    try:
        part_bytes = _host_lsblk_bsize_bytes(src)
        disk_bytes = _host_lsblk_bsize_bytes(disk_path)
    except Exception as e:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'lsblk_error',
            'message': str(e),
        }
    fs_kib = _host_df_total_kib(mp)
    fs_bytes = max(0, fs_kib) * 1024
    fstype = _host_mount_vfstype(mp)
    if fstype in ('unknown', '') and src:
        blk_t = _host_blkid_fs_type(src)
        if blk_t:
            fstype = blk_t

    tail_min = _storage_partition_tail_min_grow_bytes(disk_bytes)
    needs_partition_grow = part_bytes + tail_min < disk_bytes
    df_slack = _storage_df_total_vs_block_slack(part_bytes)
    needs_fs_grow = fs_bytes + df_slack < part_bytes
    can_grow = bool(needs_partition_grow or needs_fs_grow)

    msg_parts = []
    if needs_partition_grow:
        msg_parts.append('Sanal diskte bölüme yansımamış anlamlı alan var; bölüm sonuna kadar genişletilebilir.')
    elif needs_fs_grow:
        msg_parts.append('Bölüm büyümüş; ext4 dosya sistemi buna göre genişletilebilir (df ile bölüm arasındaki normal fark yok sayıldı).')
    else:
        msg_parts.append(
            'Şu an bölüm ve dosya sistemi disk boyutuna yakın. vCenter’da kapasite artırdıysanız '
            '«Disk veriyollarını tara» veya kısa süre bekleyin / VM yeniden başlatın; ardından yenileyin.'
        )

    supported = fstype in ('ext2', 'ext3', 'ext4')
    if not supported:
        can_grow = False
        msg_parts.append(f'Otomatik genişletme şimdilik ext4 içindir (algılanan: {fstype}).')

    can_do = can_grow and supported
    disk_part_match = abs(disk_bytes - part_bytes) <= slack
    target_fs_after = None
    if can_do:
        # Bölüm büyüyecekse hedef disk boyutu; yalnızca FS büyüyecekse mevcut bölüm boyutu.
        target_fs_after = int(disk_bytes if needs_partition_grow else part_bytes)

    return {
        'eligible': True,
        'canGrow': can_do,
        'partitionPath': src,
        'parentDiskPath': disk_path,
        'partitionNumber': part_num,
        'partitionBytes': part_bytes,
        'diskBytes': disk_bytes,
        'filesystemBytesApprox': fs_bytes,
        'fstype': fstype,
        'needsPartitionGrow': needs_partition_grow,
        'needsFsGrow': needs_fs_grow,
        'supportedFilesystem': supported,
        'message': ' '.join(msg_parts),
        'diskPartitionSizesMatchApprox': disk_part_match,
        'targetFilesystemBytesAfterGrowApprox': target_fs_after,
    }


def _data_disk_grow_image_and_network():
    """
    Genişletme: parted + resize2fs gerekir. _disk_tools_ephemeral_image_and_network() ağ açıkken
    alpine:3.20 döndürür; Alpine’da e2fsprogs yok → «resize2fs: not found». Bu yüzden varsayılan
    olarak panel imajı (veya LOG_SYSTEM_GROW_DISK_IMAGE / LOG_SYSTEM_PREPARE_DISK_IMAGE) kullanılır.
    """
    raw_grow = (os.environ.get('LOG_SYSTEM_GROW_DISK_IMAGE') or '').strip()
    raw_prep = (os.environ.get('LOG_SYSTEM_PREPARE_DISK_IMAGE') or '').strip()
    tag = (os.environ.get('LOG_SYSTEM_RELEASE_TAG') or 'dev').strip()
    fallback_panel = f'log-system/log-management-ui:{tag}'
    image = raw_grow or raw_prep or fallback_panel
    il = image.lower()
    if il.startswith('alpine:') or il == 'alpine':
        image = fallback_panel
    return image, 'none'


def _shell_lines_resize2fs_on_host(block_dev_host: str) -> list:
    """
    ext4 kök (/) veya veri mount’u host üzerindeyken resize2fs, konteyner ad uzayında
    bazen FS’i büyütmez veya tutarsız kalır. pid_mode=host ile nsenter -t 1 kullanılmalı.
    """
    d = (block_dev_host or '').strip()
    if not d.startswith('/dev/'):
        return []
    q = shlex.quote(d)
    return [
        f'echo "[grow] resize2fs -f (host mount ns) {q}"',
        f'nsenter -m -u -i -n -p -t 1 -- resize2fs -f {q}',
    ]


def _shell_lines_gpt_relocate_backup_header(disk_host: str) -> list:
    """
    Sanal disk büyütülünce yedek GPT başlığı eski son LBA’da kalır; parted uyarı/constraint hatası verir.
    sgdisk -e yedek GPT’yi diskin gerçek sonuna taşır (Alpine: gptfdisk paketi).
    """
    d = (disk_host or '').strip()
    if not d.startswith('/dev/'):
        return []
    q = shlex.quote(d)
    return [
        'if command -v sgdisk >/dev/null 2>&1; then',
        f'  echo "[grow] sgdisk -e (GPT yedek başlık) {q}"',
        f'  sgdisk -e {q} 2>&1 || true',
        'else',
        '  echo "[grow] WARN: sgdisk yok; imaja gptfdisk ekleyin veya konutta: sgdisk -e DISK"',
        'fi',
        f'partprobe {q} 2>/dev/null || true',
        'sleep 1',
    ]


def execute_data_disk_grow(rescan_first: bool = True) -> dict:
    """Bölüm (parted) + ext4 resize2fs; önce isteğe bağlı SCSI tarama."""
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    if rescan_first:
        try:
            _host_rescan_block_buses()
        except Exception:
            pass
        time.sleep(2)
    st = data_disk_grow_status_snapshot()
    if not st.get('canGrow'):
        raise RuntimeError(st.get('message') or 'Genişletme gerekmiyor veya uygun değil.')
    if not st.get('supportedFilesystem'):
        raise RuntimeError('Yalnızca ext2/3/4 otomatik genişletilir.')
    part = st['partitionPath']
    disk = st['parentDiskPath']
    num = int(st['partitionNumber'])
    disk_c = '/host' + disk
    part_c = '/host' + part

    lines = [
        'set -eu',
        'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
        f'echo "[grow] disk={disk_c} part={part_c} n={num}"',
    ]
    if st.get('needsPartitionGrow'):
        lines.extend(_shell_lines_gpt_relocate_backup_header(disk))
        lines.append(f'parted -s {shlex.quote(disk_c)} resizepart {num} 100%')
        lines.append(f'partprobe {shlex.quote(disk)} 2>/dev/null || true')
        lines.append('sleep 1')
    if st.get('needsFsGrow') or st.get('needsPartitionGrow'):
        lines.extend(_shell_lines_resize2fs_on_host(part))
    script = '\n'.join(lines)
    image, net_mode = _data_disk_grow_image_and_network()
    vol = {'/dev': {'bind': '/dev', 'mode': 'rw'}, '/': {'bind': '/host', 'mode': 'rw'}}
    tout = int(os.environ.get('LOG_SYSTEM_GROW_DISK_TIMEOUT_SEC', '600'))
    log = _container_run_wait_logs(
        image,
        ['sh', '-lc', script],
        volumes=vol,
        user='0',
        privileged=True,
        network_mode=net_mode,
        pid_mode='host',
        run_timeout_sec=tout,
    )
    log_txt = log.decode('utf-8', errors='replace').strip() if isinstance(log, (bytes, bytearray)) else str(log)
    after = data_disk_grow_status_snapshot()
    _invalidate_service_storage_usage_cache()
    return {'log': log_txt, 'before': {k: st.get(k) for k in ('partitionBytes', 'diskBytes', 'filesystemBytesApprox')}, 'after': after}


def _int_lvm_size_bytes(s: str) -> int:
    try:
        return int((s or '').replace(',', '').strip() or 0)
    except ValueError:
        return 0


def _host_lvm_root_layout_probe(root_lv_dev: str) -> dict:
    """
    Kök LV için VG, tek PV, LV yolu ve boyutlar (panel / grow imajında lvm2 gerekir).
    Çoklu PV → PROBE_ERROR=multi_pv (v1 otomasyonu desteklemez).
    """
    dev = (root_lv_dev or '').strip()
    if not dev.startswith('/dev/'):
        return {'error': 'invalid_device', 'message': 'Geçersiz kök aygıt yolu.'}
    if not docker_available or docker_client is None:
        return {'error': 'docker', 'message': 'Docker API erişilemiyor.'}
    image, net_mode = _data_disk_grow_image_and_network()
    rd = shlex.quote(dev)
    script = f'''export LVM_SUPPRESS_FD_WARNINGS=1
ROOT={rd}
if ! test -b "$ROOT"; then echo PROBE_ERROR=not_block; exit 0; fi
if ! command -v lvs >/dev/null 2>&1; then echo PROBE_ERROR=no_lvm_tools; exit 0; fi
VG=$(lvs "$ROOT" -o vg_name --noheadings 2>/dev/null | head -1 | tr -d " \\t")
if [ -z "$VG" ]; then echo PROBE_ERROR=no_vg; exit 0; fi
LV_PATH=$(lvs "$ROOT" -o lv_path --noheadings 2>/dev/null | head -1 | tr -d " \\t")
if [ -z "$LV_PATH" ]; then LV_PATH="$ROOT"; fi
case "$LV_PATH" in /dev/*) ;; *) LV_PATH="/dev/$LV_PATH" ;; esac
PVC=$(vgs "$VG" -o pv_count --noheadings 2>/dev/null | tr -d " \\t")
if [ -z "$PVC" ] || ! [ "$PVC" -eq "$PVC" ] 2>/dev/null; then echo PROBE_ERROR=no_vg; exit 0; fi
if [ "$PVC" -ne 1 ]; then echo PROBE_ERROR=multi_pv; echo "PROBE_PV_COUNT=$PVC"; exit 0; fi
PV=$(pvs --noheadings -o pv_name,vg_name 2>/dev/null | awk -v v="$VG" '$2==v {{print $1; exit}}')
if [ -z "$PV" ]; then echo PROBE_ERROR=no_pv; exit 0; fi
case "$PV" in /dev/*) ;; *) PV="/dev/$PV" ;; esac
pv_sz=$(pvs "$PV" -o pv_size --units b --nosuffix --noheadings 2>/dev/null | head -1 | tr -d " \\t" | tr -d ',')
vg_fr=$(vgs "$VG" -o vg_free --units b --nosuffix --noheadings 2>/dev/null | head -1 | tr -d " \\t" | tr -d ',')
lv_sz=$(lvs "$ROOT" -o lv_size --units b --nosuffix --noheadings 2>/dev/null | head -1 | tr -d " \\t" | tr -d ',')
echo "PROBE_VG=$VG"
echo "PROBE_LV_PATH=$LV_PATH"
echo "PROBE_PV=$PV"
echo "PROBE_PV_SIZE_BYTES=$pv_sz"
echo "PROBE_VG_FREE_BYTES=$vg_fr"
echo "PROBE_LV_SIZE_BYTES=$lv_sz"
'''
    vol = {'/dev': {'bind': '/dev', 'mode': 'ro'}, '/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_HOST_PROBE_TIMEOUT_SEC', '45'))
    try:
        raw = _container_run_wait_logs(
            image,
            ['sh', '-lc', script],
            volumes=vol,
            user='0',
            privileged=True,
            network_mode=net_mode,
            run_timeout_sec=tout,
        )
    except Exception as e:
        return {'error': 'probe_run', 'message': str(e)}
    blob = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
    kv = {}
    for line in blob.splitlines():
        line = line.strip()
        if '=' in line:
            k, _, v = line.partition('=')
            k, v = k.strip(), v.strip()
            if k.startswith('PROBE_'):
                kv[k] = v
    err = kv.get('PROBE_ERROR', '')
    if err == 'not_block':
        return {'error': 'not_block', 'message': 'Kök aygıt blok dosyası değil.'}
    if err == 'no_lvm_tools':
        return {'error': 'no_lvm_tools', 'message': 'Konteyner imajında lvm2 yok; panel imajını güncelleyin.'}
    if err == 'no_vg':
        return {'error': 'no_vg', 'message': 'LVM volume group okunamadı.'}
    if err == 'no_pv':
        return {'error': 'no_pv', 'message': 'Fiziksel volume bulunamadı.'}
    if err == 'multi_pv':
        try:
            n = int((kv.get('PROBE_PV_COUNT') or '0').strip())
        except ValueError:
            n = 0
        return {
            'error': 'multi_pv',
            'pvCount': n if n > 0 else 99,
            'message': (
                'Bu kök VG birden fazla fiziksel volume kullanıyor; panel otomatik genişletme yalnızca '
                'tek PV + tek disk senaryosunda güvenlidir. Bu kurulumda panel genişletme sunmaz.'
            ),
        }
    vg = kv.get('PROBE_VG', '').strip()
    lv_path = kv.get('PROBE_LV_PATH', '').strip()
    pv = kv.get('PROBE_PV', '').strip()
    if not vg or not lv_path or not pv:
        return {'error': 'parse', 'message': 'LVM düzeni ayrıştırılamadı.'}
    return {
        'vg': vg,
        'lvPath': lv_path,
        'pv': pv,
        'pvSizeBytes': _int_lvm_size_bytes(kv.get('PROBE_PV_SIZE_BYTES', '0')),
        'vgFreeBytes': _int_lvm_size_bytes(kv.get('PROBE_VG_FREE_BYTES', '0')),
        'lvSizeBytes': _int_lvm_size_bytes(kv.get('PROBE_LV_SIZE_BYTES', '0')),
    }


def _os_root_lvm_disk_grow_status_snapshot(root_dev: str, mp: str, slack: int) -> dict:
    pr = _host_lvm_root_layout_probe(root_dev)
    if pr.get('error'):
        return {
            'eligible': False,
            'canGrow': False,
            'reason': pr.get('error'),
            'mountPoint': mp,
            'rootDevice': root_dev,
            'message': pr.get('message') or 'LVM kök düzeni okunamadı.',
        }
    pv = pr['pv']
    lv_path = pr['lvPath']
    vg = pr['vg']
    pv_size = int(pr['pvSizeBytes'])
    vg_free = int(pr['vgFreeBytes'])
    lv_size = int(pr['lvSizeBytes'])
    disk_path = _host_lsblk_parent_disk_path(pv)
    if not disk_path:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'no_parent_disk',
            'mountPoint': mp,
            'rootDevice': root_dev,
            'message': 'PV için üst disk bulunamadı.',
        }
    try:
        part_bytes = _host_lsblk_bsize_bytes(pv)
        disk_bytes = _host_lsblk_bsize_bytes(disk_path)
    except Exception as e:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'lsblk_error',
            'mountPoint': mp,
            'message': str(e),
        }
    part_num = _partition_number_from_devpath(pv)
    if part_num is None:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'partition_parse',
            'mountPoint': mp,
            'rootDevice': root_dev,
            'message': (
                f'PV {pv} için bölüm numarası çıkarılamadı (ör. tüm disk PV). '
                'Otomatik kök genişletme yalnızca bölümlenmiş PV (ör. /dev/sda3) ile desteklenir.'
            ),
        }
    fs_kib = _host_df_total_kib(mp)
    fs_bytes = max(0, fs_kib) * 1024
    fstype = _host_mount_vfstype(mp)
    if fstype in ('unknown', '') and lv_path:
        blk_t = _host_blkid_fs_type(lv_path)
        if blk_t:
            fstype = blk_t

    tail_min = _storage_partition_tail_min_grow_bytes(disk_bytes)
    needs_partition_grow = part_bytes + tail_min < disk_bytes
    pv_slack = _storage_pv_report_vs_partition_slack(part_bytes)
    needs_pv_resize = pv_size + pv_slack < part_bytes
    needs_lvm_vg_free_grow = vg_free > slack
    df_slack_lv = _storage_df_total_vs_block_slack(lv_size)
    needs_fs_grow_only = (
        fs_bytes + df_slack_lv < lv_size and not needs_partition_grow and not needs_pv_resize
    )
    supported = fstype in ('ext2', 'ext3', 'ext4')
    # Yalnızca hypervisor/PV/bölüm hattında veya LV > ext4 (anlamlı fark) iken otomatik; VG içi boşluk tek başına değil.
    run_lvextend = needs_partition_grow or needs_pv_resize
    can_grow_raw = bool(needs_partition_grow or needs_pv_resize or needs_fs_grow_only)
    can_do = supported and can_grow_raw

    msg_parts = []
    if needs_partition_grow:
        msg_parts.append('OS diskinde bölüme yansımamış anlamlı alan var; GPT bölümü uzatılabilir.')
    if needs_pv_resize and not needs_partition_grow:
        msg_parts.append('Bölüm PV’den büyük; pvresize ile fiziksel volume genişletilebilir.')
    if needs_fs_grow_only:
        msg_parts.append('LV, ext4’ten anlamlı şekilde büyük; «Genişlet» dosya sistemini otomatik uzatır.')
    if needs_lvm_vg_free_grow and not can_grow_raw:
        msg_parts.append(
            'Volume group’da iç boş alan var; bu tek başına hypervisor disk artışı anlamına gelmez. '
            'Panel bu yüzden şu an «Genişlet» düğmesi göstermiyor. OS diski gerçekten büyüdüyse '
            '«OS durumu yenile» (rescan) sonrası tekrar deneyin; gerekirse VM yeniden başlatın.'
        )
    if not can_grow_raw:
        msg_parts.append(
            'Kök LVM + bölüm + dosya sistemi bu eşiklere göre güncel görünüyor. Hypervisor’da diski büyüttüyseniz '
            'ama üstteki «Disk» hâlâ eski GiB ise kernel henüz yeni boyutu görmemiştir: «OS durumu yenile» '
            '(içinde rescan vardır), Depolama «Veriyolu tara» veya VM yeniden başlatma sonrası tekrar deneyin.'
        )
    if not supported:
        msg_parts.append(f'Otomatik genişletme şimdilik ext4 içindir (algılanan: {fstype}).')

    disk_part_match = abs(disk_bytes - part_bytes) <= slack
    target_fs_after = None
    if can_do:
        if needs_fs_grow_only:
            target_fs_after = int(lv_size)
        else:
            target_fs_after = int(min(disk_bytes, lv_size + max(0, part_bytes - pv_size)))

    return {
        'eligible': True,
        'canGrow': can_do,
        'scope': 'lvm_root',
        'mountPoint': mp,
        'partitionPath': root_dev,
        'rootDevice': root_dev,
        'lvPath': lv_path,
        'volumeGroup': vg,
        'physicalVolume': pv,
        'parentDiskPath': disk_path,
        'partitionNumber': part_num,
        'partitionBytes': part_bytes,
        'diskBytes': disk_bytes,
        'pvSizeBytes': pv_size,
        'vgFreeBytes': vg_free,
        'lvSizeBytes': lv_size,
        'filesystemBytesApprox': fs_bytes,
        'fstype': fstype,
        'needsPartitionGrow': needs_partition_grow,
        'needsPvResize': needs_pv_resize,
        'needsLvmVgFreeGrow': needs_lvm_vg_free_grow,
        'needsFsGrowOnly': needs_fs_grow_only,
        'needsLvmExtendStep': run_lvextend,
        'supportedFilesystem': supported,
        'message': ' '.join(msg_parts),
        'diskPartitionSizesMatchApprox': disk_part_match,
        'targetFilesystemBytesAfterGrowApprox': target_fs_after,
        'riskWarning': (
            'Kök (/) LVM genişletme canlı sistemde risklidir; yedek ve snapshot önerilir. '
            'Yanlış disk veya çoklu PV senaryosu veri kaybına yol açabilir; yalnızca tek PV doğrulandı.'
        ),
    }


def os_root_disk_grow_status_snapshot() -> dict:
    """
    Kök (/) dosya sistemi: hypervisor’da OS diski büyütüldükten sonra
    ya düz bölüm + ext4 ya da (Ubuntu tipik) LVM kök: bölüm → pvresize → lvextend + resize2fs.
    """
    mp = '/'
    slack = 64 * 1024 * 1024
    root_pi = _probe_path_info(mp)
    rdev = ''
    if root_pi:
        rdev = (root_pi.get('device') or '').strip()
    if rdev and ('/dev/mapper/' in rdev or rdev.startswith('/dev/dm-')):
        return _os_root_lvm_disk_grow_status_snapshot(rdev, mp, slack)
    src = _data_mount_partition_for_grow(mp)
    if not src:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'no_block_source',
            'mountPoint': mp,
            'message': (
                'Kök (/) bölüm aygıtı okunamadı (LVM/device-mapper veya desteklenmeyen düzen). '
                'Bu akış yalnızca düz GPT/MBR bölümü + ext4 için geçerlidir.'
            ),
        }
    if '/dev/mapper/' in src or src.startswith('/dev/dm-'):
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'device_mapper',
            'mountPoint': mp,
            'message': (
                'Kök LVM/device-mapper üzerinde; bu durumda panel LVM kök akışını kullanır. '
                '«OS durumu yenile» ile LVM özetini yükleyip «Genişlet» kullanın (tek PV, ext4).'
            ),
            'partitionPath': src,
        }
    part_num = _partition_number_from_devpath(src)
    if part_num is None:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'partition_parse',
            'mountPoint': mp,
            'message': 'Kök bölüm numarası çıkarılamadı.',
            'partitionPath': src,
        }
    disk_path = _host_lsblk_parent_disk_path(src)
    if not disk_path:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'no_parent_disk',
            'mountPoint': mp,
            'message': 'Üst disk bulunamadı.',
            'partitionPath': src,
        }
    try:
        part_bytes = _host_lsblk_bsize_bytes(src)
        disk_bytes = _host_lsblk_bsize_bytes(disk_path)
    except Exception as e:
        return {
            'eligible': False,
            'canGrow': False,
            'reason': 'lsblk_error',
            'mountPoint': mp,
            'message': str(e),
        }
    fs_kib = _host_df_total_kib(mp)
    fs_bytes = max(0, fs_kib) * 1024
    fstype = _host_mount_vfstype(mp)
    if fstype in ('unknown', '') and src:
        blk_t = _host_blkid_fs_type(src)
        if blk_t:
            fstype = blk_t

    tail_min = _storage_partition_tail_min_grow_bytes(disk_bytes)
    needs_partition_grow = part_bytes + tail_min < disk_bytes
    df_slack = _storage_df_total_vs_block_slack(part_bytes)
    needs_fs_grow = fs_bytes + df_slack < part_bytes
    can_grow = bool(needs_partition_grow or needs_fs_grow)

    msg_parts = []
    if needs_partition_grow:
        msg_parts.append('OS diskinde bölüme yansımamış anlamlı alan var; kök bölümü sonuna kadar genişletilebilir.')
    elif needs_fs_grow:
        msg_parts.append('Kök bölümü büyümüş; ext4 dosya sistemi buna göre genişletilebilir.')
    else:
        msg_parts.append(
            'Kök bölüm ve dosya sistemi disk boyutuna yakın. Hypervisor’da kapasite artırdıysanız '
            '«Veriyolu tara» / VM yeniden başlatma sonrası yenileyin.'
        )

    supported = fstype in ('ext2', 'ext3', 'ext4')
    if not supported:
        can_grow = False
        msg_parts.append(f'Otomatik genişletme şimdilik ext4 içindir (algılanan: {fstype}).')

    can_do = can_grow and supported
    disk_part_match = abs(disk_bytes - part_bytes) <= slack
    target_fs_after = None
    if can_do:
        target_fs_after = int(disk_bytes if needs_partition_grow else part_bytes)

    return {
        'eligible': True,
        'canGrow': can_do,
        'scope': 'root_filesystem',
        'mountPoint': mp,
        'partitionPath': src,
        'parentDiskPath': disk_path,
        'partitionNumber': part_num,
        'partitionBytes': part_bytes,
        'diskBytes': disk_bytes,
        'filesystemBytesApprox': fs_bytes,
        'fstype': fstype,
        'needsPartitionGrow': needs_partition_grow,
        'needsFsGrow': needs_fs_grow,
        'supportedFilesystem': supported,
        'message': ' '.join(msg_parts),
        'diskPartitionSizesMatchApprox': disk_part_match,
        'targetFilesystemBytesAfterGrowApprox': target_fs_after,
        'riskWarning': (
            'Kök (/) genişletme canlı sistemde risklidir; yedek ve snapshot önerilir. '
            'Yanlış disk/bölüm seçimi veri kaybına yol açabilir.'
        ),
    }


def _execute_os_root_lvm_disk_grow(st: dict) -> dict:
    """LVM kök: GPT → pvresize → lvextend + resize2fs (-r kullanılmaz; helper resize2fs bulamıyor)."""
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    if st.get('scope') != 'lvm_root':
        raise RuntimeError('Durum LVM kök değil; yenileyin.')
    if not st.get('canGrow'):
        raise RuntimeError(st.get('message') or 'Kök LVM genişletme gerekmiyor veya uygun değil.')
    if not st.get('supportedFilesystem'):
        raise RuntimeError('Yalnızca ext2/3/4 otomatik genişletilir.')
    disk = st['parentDiskPath']
    pv = st['physicalVolume']
    lv = st['lvPath']
    num = int(st['partitionNumber'])
    disk_c = '/host' + disk

    lines = [
        'set -eu',
        # lvextend -r → lvresize_fs_helper resize2fs arar; Alpine’da PATH yüzünden «not found» olabiliyor.
        'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
        'export LVM_SUPPRESS_FD_WARNINGS=1',
        f'echo "[os-grow-lvm] disk={shlex.quote(disk)} pv={shlex.quote(pv)} lv={shlex.quote(lv)}"',
    ]
    if st.get('needsPartitionGrow'):
        lines.extend(_shell_lines_gpt_relocate_backup_header(disk))
        lines.append(f'parted -s {shlex.quote(disk_c)} resizepart {num} 100%')
        lines.append(f'partprobe {shlex.quote(disk)} 2>/dev/null || true')
        lines.append('sleep 2')
    if st.get('needsPartitionGrow') or st.get('needsPvResize'):
        lines.append(f'pvresize {shlex.quote(pv)}')
    if st.get('needsLvmExtendStep'):
        lines.append(f'lvextend -l +100%FREE {shlex.quote(lv)}')
        lines.extend(_shell_lines_resize2fs_on_host(lv))
    elif st.get('needsFsGrowOnly'):
        lines.extend(_shell_lines_resize2fs_on_host(lv))
    script = '\n'.join(lines)
    image, net_mode = _data_disk_grow_image_and_network()
    vol = {'/dev': {'bind': '/dev', 'mode': 'rw'}, '/': {'bind': '/host', 'mode': 'rw'}}
    tout = int(os.environ.get('LOG_SYSTEM_OS_GROW_DISK_TIMEOUT_SEC', os.environ.get('LOG_SYSTEM_GROW_DISK_TIMEOUT_SEC', '600')))
    log = _container_run_wait_logs(
        image,
        ['sh', '-lc', script],
        volumes=vol,
        user='0',
        privileged=True,
        network_mode=net_mode,
        pid_mode='host',
        run_timeout_sec=tout,
    )
    log_txt = log.decode('utf-8', errors='replace').strip() if isinstance(log, (bytes, bytearray)) else str(log)
    after = os_root_disk_grow_status_snapshot()
    _invalidate_service_storage_usage_cache()
    return {'log': log_txt, 'before': {k: st.get(k) for k in ('partitionBytes', 'diskBytes', 'filesystemBytesApprox')}, 'after': after}


def execute_os_root_disk_grow(rescan_first: bool = True) -> dict:
    """Kök: düz bölüm + ext4 veya LVM (bölüm / pvresize / lvextend + resize2fs)."""
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    if rescan_first:
        try:
            _host_rescan_block_buses()
        except Exception:
            pass
        time.sleep(2)
    st = os_root_disk_grow_status_snapshot()
    if st.get('scope') == 'lvm_root':
        return _execute_os_root_lvm_disk_grow(st)
    if not st.get('canGrow'):
        raise RuntimeError(st.get('message') or 'Kök genişletme gerekmiyor veya uygun değil.')
    if not st.get('supportedFilesystem'):
        raise RuntimeError('Yalnızca ext2/3/4 otomatik genişletilir.')
    part = st['partitionPath']
    disk = st['parentDiskPath']
    num = int(st['partitionNumber'])
    disk_c = '/host' + disk
    part_c = '/host' + part

    lines = [
        'set -eu',
        'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
        f'echo "[os-grow] disk={disk_c} part={part_c} n={num}"',
    ]
    if st.get('needsPartitionGrow'):
        lines.extend(_shell_lines_gpt_relocate_backup_header(disk))
        lines.append(f'parted -s {shlex.quote(disk_c)} resizepart {num} 100%')
        lines.append(f'partprobe {shlex.quote(disk)} 2>/dev/null || true')
        lines.append('sleep 1')
    if st.get('needsFsGrow') or st.get('needsPartitionGrow'):
        lines.extend(_shell_lines_resize2fs_on_host(part))
    script = '\n'.join(lines)
    image, net_mode = _data_disk_grow_image_and_network()
    vol = {'/dev': {'bind': '/dev', 'mode': 'rw'}, '/': {'bind': '/host', 'mode': 'rw'}}
    tout = int(os.environ.get('LOG_SYSTEM_OS_GROW_DISK_TIMEOUT_SEC', os.environ.get('LOG_SYSTEM_GROW_DISK_TIMEOUT_SEC', '600')))
    log = _container_run_wait_logs(
        image,
        ['sh', '-lc', script],
        volumes=vol,
        user='0',
        privileged=True,
        network_mode=net_mode,
        pid_mode='host',
        run_timeout_sec=tout,
    )
    log_txt = log.decode('utf-8', errors='replace').strip() if isinstance(log, (bytes, bytearray)) else str(log)
    after = os_root_disk_grow_status_snapshot()
    _invalidate_service_storage_usage_cache()
    return {'log': log_txt, 'before': {k: st.get(k) for k in ('partitionBytes', 'diskBytes', 'filesystemBytesApprox')}, 'after': after}


def _minimal_bind_paths_for_du(paths):
    """Üst dizin alt klasörü kapsadığı için du çift sayımını önle."""
    seen = set()
    uniq = []
    for p in paths:
        s = (p or '').strip().rstrip('/') or '/'
        if not s.startswith('/'):
            continue
        if s in seen:
            continue
        seen.add(s)
        uniq.append(s)
    uniq.sort(key=lambda x: (len(x), x))
    keep = []
    for p in uniq:
        if any(p != k and p.startswith(k + '/') for k in keep):
            continue
        keep.append(p)
    return keep


def _batch_du_host_paths(host_paths: list) -> dict:
    """Host mutlak yollar için du -sb bayt sözlüğü; hata durumunda {'_error': str}."""
    if not docker_client:
        return {'_error': 'Docker yok'}
    paths = sorted(set(host_paths))
    if not paths:
        return {}
    lines = ['set -eu']
    for p in paths:
        inner = '/host' + p if p != '/' else '/host'
        qi = shlex.quote(inner)
        lines.append(f'if [ -d {qi} ]; then du -sb {qi} 2>/dev/null | head -n1; else printf "0\\t{qi}\\n"; fi')
    script = '\n'.join(lines)
    image = _findmnt_probe_image()
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_SERVICE_STORAGE_DU_TIMEOUT_SEC', '180'))
    try:
        raw = _container_run_wait_logs(
            image,
            ['bash', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=tout,
        )
    except Exception as e:
        return {'_error': str(e)}
    txt = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
    out = {}
    for line in txt.splitlines():
        line = line.strip()
        if not line or '\t' not in line:
            continue
        size_part, path_part = line.split('\t', 1)
        try:
            b = int(size_part)
        except ValueError:
            continue
        hp = path_part.strip()
        if hp.startswith('/host'):
            hpath = hp[5:] or '/'
        else:
            hpath = hp
        out[hpath] = b
    return out


def _batch_df_host_paths(host_paths: list) -> dict:
    """Host mutlak yol -> df ile bölüm: device, totalBytes, usedBytes, availBytes, mountPoint (1K blok * 1024)."""
    if not docker_client:
        return {}
    paths = sorted(set(p for p in host_paths if p and isinstance(p, str) and p.startswith('/')))
    if not paths:
        return {}
    lines = ['set -eu']
    for p in paths:
        inner = '/host' + p if p != '/' else '/host'
        qi = shlex.quote(inner)
        qp = shlex.quote(p)
        lines.append(
            f"printf '%s|' {qp}; "
            f"if [ -e {qi} ]; then df -P {qi} 2>/dev/null | tail -n1 | "
            "awk '{print $1 \"|\" $2 \"|\" $3 \"|\" $4 \"|\" $NF}'; "
            'else echo "||||"; fi'
        )
    script = '\n'.join(lines)
    image = _findmnt_probe_image()
    vol = {'/': {'bind': '/host', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_SERVICE_STORAGE_DF_TIMEOUT_SEC', '120'))
    try:
        raw = _container_run_wait_logs(
            image,
            ['bash', '-lc', script],
            volumes=vol,
            user='0',
            network_mode='none',
            run_timeout_sec=tout,
        )
    except Exception as e:
        return {'_error': str(e)}
    txt = raw.decode('utf-8', errors='replace') if isinstance(raw, (bytes, bytearray)) else str(raw)
    out = {}
    for line in txt.splitlines():
        line = line.strip()
        if not line or '|' not in line:
            continue
        bits = line.split('|')
        if len(bits) < 6:
            continue
        hpath, dev, tk, uk, ak, mnt = bits[0], bits[1], bits[2], bits[3], bits[4], bits[5]
        if not dev or not str(dev).strip():
            continue
        try:
            total_b = int(tk) * 1024
            used_b = int(uk) * 1024
            avail_b = int(ak) * 1024
        except (TypeError, ValueError):
            continue
        out[hpath] = {
            'device': dev.strip(),
            'totalBytes': total_b,
            'usedBytes': used_b,
            'availBytes': avail_b,
            'mountPoint': (mnt or '').strip() or '/',
        }
    return out


def get_service_bind_storage_snapshot() -> dict:
    """
    Stack konteynerleri: bind mount host dizinlerinin du ile yaklaşık toplamı.
    Konteynerlere ayrı kota atanmaz; host FS genişlediğinde tüm servisler aynı havuzu paylaşır.
    """
    global _SERVICE_STORAGE_USAGE_CACHE
    ttl = float(os.environ.get('LOG_SYSTEM_SERVICE_STORAGE_CACHE_SEC', '90'))
    now = time.time()
    if _SERVICE_STORAGE_USAGE_CACHE['payload'] is not None and (now - _SERVICE_STORAGE_USAGE_CACHE['ts']) < ttl:
        pl = _SERVICE_STORAGE_USAGE_CACHE['payload']
        return {**pl, 'cached': True}

    explanation = (
        'Tablo sütunu: yalnızca o servisin bind mount yolları için du ile yaklaşık kullanım. '
        'sharedFilesystems: stack’teki bind yollarının oturduğu dosya sistemleri (df), aygıt bazında bir kez — '
        'konteyner başına ayrı kota yok, büyütme paylaşılan bölümden yapılır.'
    )

    if runtime_platform() == 'k8s':
        payload = {
            'ok': True,
            'byContainer': {},
            'sharedFilesystems': [],
            'explanation': explanation,
            'note': 'Kubernetes modunda bu sürümde bind mount kullanımı listelenmiyor.',
            'collectedAt': datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
        }
        _SERVICE_STORAGE_USAGE_CACHE['ts'] = now
        _SERVICE_STORAGE_USAGE_CACHE['payload'] = payload
        return {**payload, 'cached': False}

    if not docker_available or docker_client is None:
        return {
            'ok': False,
            'error': 'Docker kullanılamıyor.',
            'byContainer': {},
            'sharedFilesystems': [],
            'explanation': explanation,
            'cached': False,
        }

    by_container_meta = {}
    all_paths = []
    try:
        containers = docker_client.containers.list(all=True, ignore_removed=True)
        for container in containers:
            try:
                if not _docker_reload_container_or_skip(container):
                    continue
                if not _include_container_in_service_dashboard(container):
                    continue
                try:
                    name = container.name
                    mounts = container.attrs.get('Mounts') or []
                except docker_errors.NotFound:
                    continue
                except docker_errors.APIError as e:
                    if _docker_client_error_is_missing_container(e):
                        continue
                    raise
                bind_sources = []
                for m in mounts:
                    if m.get('Type') != 'bind':
                        continue
                    src = (m.get('Source') or '').strip()
                    if not src.startswith('/'):
                        continue
                    if src.endswith('.sock') or '/docker.sock' in src:
                        continue
                    bind_sources.append(src)
                bind_sources = _minimal_bind_paths_for_du(bind_sources)
                labels = container.labels or {}
                by_container_meta[name] = {
                    'bindPaths': bind_sources,
                    'composeService': labels.get('com.docker.compose.service') or '',
                }
                all_paths.extend(bind_sources)
            except docker_errors.NotFound:
                continue
            except docker_errors.APIError as e:
                if _docker_client_error_is_missing_container(e):
                    continue
                raise
            except Exception as e:
                if _docker_client_error_is_missing_container(e):
                    continue
                raise
    except Exception as e:
        return {
            'ok': False,
            'error': str(e),
            'byContainer': {},
            'sharedFilesystems': [],
            'explanation': explanation,
            'cached': False,
        }

    du_map = _batch_du_host_paths(all_paths)
    if isinstance(du_map, dict) and du_map.get('_error'):
        return {
            'ok': False,
            'error': du_map['_error'],
            'byContainer': {},
            'sharedFilesystems': [],
            'explanation': explanation,
            'cached': False,
        }

    df_map = _batch_df_host_paths(all_paths)
    if isinstance(df_map, dict) and df_map.get('_error'):
        df_map = {}

    shared_fs = []
    seen_fs_dev = set()
    for p in sorted(set(all_paths)):
        row = df_map.get(p) if isinstance(df_map, dict) else None
        if not row or not row.get('device'):
            continue
        dev = row['device']
        if dev in seen_fs_dev:
            continue
        seen_fs_dev.add(dev)
        shared_fs.append(
            {
                'device': dev,
                'mountPoint': row.get('mountPoint') or '',
                'totalBytes': int(row.get('totalBytes') or 0),
                'usedBytes': int(row.get('usedBytes') or 0),
                'availBytes': int(row.get('availBytes') or 0),
            }
        )
    shared_fs.sort(key=lambda x: (x.get('mountPoint') or '', x.get('device') or ''))

    by_container = {}
    for name, meta in by_container_meta.items():
        total = 0
        for p in meta['bindPaths']:
            total += int(du_map.get(p, 0))
        by_container[name] = {
            'dataBytes': total,
            'bindPaths': meta['bindPaths'],
            'composeService': meta.get('composeService') or '',
        }

    payload = {
        'ok': True,
        'byContainer': by_container,
        'sharedFilesystems': shared_fs,
        'explanation': explanation,
        'collectedAt': datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
    }
    _SERVICE_STORAGE_USAGE_CACHE['ts'] = now
    _SERVICE_STORAGE_USAGE_CACHE['payload'] = payload
    return {**payload, 'cached': False}


def apply_storage_profile(selected_path, env_name='prod', acknowledge_same_as_root: bool = False):
    if not selected_path or not str(selected_path).startswith('/'):
        raise RuntimeError('Seçilen disk yolu absolute olmalı (/ ile başlamalı)')

    selected_path = selected_path.rstrip('/')
    if not _storage_path_allowed_under_opt(selected_path):
        raise RuntimeError(
            '/opt/log-system altında yalnızca /opt/log-system/data seçilebilir '
            '(ikinci diski bu dizine mount edin; kod ve config küçük diskte kalır).'
        )

    probe = _probe_path_info(selected_path)
    if not probe:
        raise RuntimeError(
            'Seçilen yol doğrulanamadı. Dizin hostta var mı? '
            'Örn: sudo mkdir -p /opt/log-system/data && sudo mount /dev/sdb1 /opt/log-system/data'
        )
    if not probe.get('writable'):
        raise RuntimeError('Seçilen disk yazılabilir değil')

    env_allow = str(os.environ.get('LOG_SYSTEM_ALLOW_STORAGE_PROFILE_ON_ROOT_DISK') or '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    if _host_same_filesystem('/', selected_path):
        if acknowledge_same_as_root or env_allow:
            pass
        else:
            raise StorageProfileSameRootFilesystem(
                'İkinci VMDK konutta bu dizine mount edilene kadar veri yolu kök diskle aynı FS üzerindedir. '
                'Adımlar: «Disk veriyollarını tara» → «Diskleri Yenile» → ham diskte «Diski hazırla ve .env uygula». '
                'Doğrulama: `findmnt -no SOURCE /opt/log-system/data` çıktısı, `df / /opt/log-system/data` ile '
                'kökten farklı bir blok aygıt göstermelidir. '
                'Kasıtlı tek-disk / kök üzerinde veri: aşağıda «Yine de uygula» ile onaylayın veya ortamda '
                'LOG_SYSTEM_ALLOW_STORAGE_PROFILE_ON_ROOT_DISK=1.'
            )

    hot_root = f'{selected_path}/log-hot/{env_name}'
    archive_root = f'{selected_path}/log-archive/{env_name}'
    data_root = f'{selected_path}/log-data/{env_name}'

    updates = {
        'HOT_DATA_ROOT': hot_root,
        'ARCHIVE_DATA_ROOT': archive_root,
        'DATA_ROOT_PATH': data_root,
        'MONGODB_DATA_PATH': f'{hot_root}/mongodb_data',
        'KAFKA_DATA1_PATH': f'{hot_root}/kafka_data1',
        'KAFKA_DATA2_PATH': f'{hot_root}/kafka_data2',
        'KAFKA_DATA3_PATH': f'{hot_root}/kafka_data3',
        'OPENSEARCH_DATA1_PATH': f'{hot_root}/opensearch_data1',
        'OPENSEARCH_DATA2_PATH': f'{hot_root}/opensearch_data2',
        'OPENSEARCH_DATA3_PATH': f'{hot_root}/opensearch_data3',
        'GRAFANA_DATA_PATH': f'{hot_root}/grafana_data',
        'MINIO_DATA_PATH': f'{hot_root}/minio_data',
        'PORTAINER_DATA_PATH': f'{hot_root}/portainer_data',
        'NGINX_PROXY_MANAGER_DATA_PATH': f'{hot_root}/nginx-proxy-manager/data',
        'NGINX_PROXY_MANAGER_LETSENCRYPT_PATH': f'{hot_root}/nginx-proxy-manager/letsencrypt',
        'ARSIV_LOG_PATH': f'{archive_root}/arsiv_loglari',
        'ARSIV_IMZALI_PATH': f'{archive_root}/arsiv_imzali',
        'WORM_STORAGE_PATH': f'{archive_root}/worm_storage',
    }

    created_dirs = [
        hot_root, archive_root, data_root,
        updates['MONGODB_DATA_PATH'], updates['KAFKA_DATA1_PATH'], updates['KAFKA_DATA2_PATH'], updates['KAFKA_DATA3_PATH'],
        updates['OPENSEARCH_DATA1_PATH'], updates['OPENSEARCH_DATA2_PATH'], updates['OPENSEARCH_DATA3_PATH'],
        updates['GRAFANA_DATA_PATH'], updates['MINIO_DATA_PATH'], updates['PORTAINER_DATA_PATH'],
        updates['NGINX_PROXY_MANAGER_DATA_PATH'], updates['NGINX_PROXY_MANAGER_LETSENCRYPT_PATH'],
        updates['ARSIV_LOG_PATH'], updates['ARSIV_IMZALI_PATH'], updates['WORM_STORAGE_PATH'],
    ]

    _host_mkdirs_abs(created_dirs)

    for key, value in updates.items():
        try:
            update_env_key(ENV_PATH, key, value)
        except OSError:
            update_env_key_via_runtime(ENV_PATH, key, value)

    return {
        'selectedPath': selected_path,
        'device': probe.get('device'),
        'updatedKeys': sorted(list(updates.keys())),
        'hotRoot': hot_root,
        'archiveRoot': archive_root,
        'dataRoot': data_root
    }


# Tam disk yolları (bölüm değil): SCSI/sd*, VirtIO/vd*, Xen/xvd*, NVMe namespace, eMMC/mmcblk*
_STORAGE_DISK_SAFE = re.compile(
    r'^/dev/('
    r'sd[a-z]+|vd[a-z]+|xvd[a-z]+|'
    r'nvme\d+n\d+|'
    r'mmcblk\d+'
    r')$'
)
_MIN_DATA_DISK_BYTES = 1024 ** 3

_PREPARE_DATA_DISK_SCRIPT = r'''
set -eu
DEV="${PREPARE_DEV:?}"
MP="${PREPARE_MP:?}"
WIPE="${PREPARE_WIPE:-0}"
RELOC="${PREPARE_RELOCATE_DIR:-0}"
HOST=/host
# İmajda parted yoksa (ör. saf alpine) apk add gerekir — apk update kullanma; yavaş ağda uzun süre sessiz kalır.
if ! command -v parted >/dev/null 2>&1; then
  echo "[prepare] Disk araçları yok; apk ile kuruluyor (ağ gerekir, birkaç dakika sürebilir)..."
  apk add --no-cache parted e2fsprogs util-linux
else
  echo "[prepare] Disk araçları hazır; bölümleme ve biçimlendirme..."
fi
test -b "$DEV" || { echo "not_block"; exit 2; }
# Herhangi bir alt aygıtta mount var mı?
if lsblk -nrpo MOUNTPOINTS "$DEV" | tr ' ' '\n' | awk 'NF' | grep -q .; then
  echo "mounted"; exit 3
fi
# Mount noktasını wipe/mkfs ÖNCESİ kontrol et (dolu dizinde yanlışlıkla diski silip sonra takılmayı önler).
MPHOST="${HOST}${MP}"
mkdir -p "$MPHOST"
if mountpoint -q "$MPHOST"; then
  echo "already_mounted"; exit 5
fi
if [ -n "$(ls -A "$MPHOST" 2>/dev/null)" ]; then
  if [ "$RELOC" = "1" ]; then
    BAK="${MP}.panel-relocate-$(date +%Y%m%d%H%M%S)-$$"
    BAKHOST="${HOST}${BAK}"
    echo "[prepare] Mount noktası dolu (${MP}); içerik taşınıyor: ${BAK}"
    mv "$MPHOST" "$BAKHOST"
    mkdir -p "$MPHOST"
  else
    echo "dir_not_empty"; exit 7
  fi
fi
PARTS=$(lsblk -nrpo TYPE "$DEV" | tail -n +2 | grep -c '^part$' || true)
if [ "${PARTS:-0}" -gt 0 ]; then
  if [ "$WIPE" != "1" ]; then
    echo "needs_wipe"; exit 6
  fi
  wipefs -af "$DEV" 2>/dev/null || true
  parted -s "$DEV" mklabel gpt
fi
if ! parted -s "$DEV" print 2>/dev/null | grep -qi 'Partition Table:.*gpt'; then
  parted -s "$DEV" mklabel gpt
fi
PART=$(lsblk -nrpo NAME,TYPE "$DEV" | awk '$2=="part"{print $1; exit}')
if [ -z "$PART" ] || [ ! -b "$PART" ]; then
  parted -s "$DEV" mkpart datastore ext4 1MiB 100%
  sleep 2
  partprobe "$DEV" 2>/dev/null || true
  sleep 1
  PART=$(lsblk -nrpo NAME,TYPE "$DEV" | awk '$2=="part"{print $1; exit}')
fi
test -n "$PART" && test -b "$PART" || { echo "no_partition"; exit 4; }
mkfs.ext4 -F -L logplatform-data "$PART"
mkdir -p "$MPHOST"
if mountpoint -q "$MPHOST"; then
  echo "already_mounted"; exit 5
fi
UUID=$(blkid -s UUID -o value "$PART")
test -n "$UUID" || { echo "no_uuid"; exit 8; }
FSTAB="${HOST}/etc/fstab"
if [ -f "$FSTAB" ]; then
  cp "$FSTAB" "${FSTAB}.bak.panel-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  awk -v mp="$MP" '($2 != mp) {print}' "$FSTAB" > "${FSTAB}.new"
  mv "${FSTAB}.new" "$FSTAB"
fi
echo "UUID=${UUID} ${MP} ext4 defaults,nofail 0 2" >> "$FSTAB"
# Konteyner içi `mount /host/...` çoğu kurulumda host mount ad uzayına yazılmaz; konteyner bitince bağ kalkar.
# pid_mode=host ile PID 1 = host init; nsenter -t 1 -m ile mount gerçek hostta kalır.
if ! command -v nsenter >/dev/null 2>&1; then
  echo "nsenter_missing"; exit 9
fi
nsenter -m -u -i -n -p -t 1 -- mount -t ext4 -U "$UUID" "$MP" || { echo "nsenter_mount_failed"; exit 9; }
nsenter -m -u -i -n -p -t 1 -- mountpoint -q "$MP" || { echo "host_mount_verify_failed"; exit 9; }
echo "ok uuid=${UUID} part=${PART}"
'''


def _node_mount_values(node):
    vals = []
    mp = node.get('mountpoint')
    if mp:
        vals.append(mp)
    for x in (node.get('mountpoints') or []):
        if x:
            vals.append(x)
    return vals


def _is_critical_system_mount(mp: str) -> bool:
    if not mp or not str(mp).strip():
        return False
    m = mp.rstrip('/') or '/'
    if m == '/':
        return True
    return m in ('/boot', '/boot/efi')


def _walk_system_disk_paths(blockdevices):
    system = set()

    def walk(node, disk_path):
        dp = disk_path
        if str(node.get('type') or '').lower() == 'disk':
            p = node.get('path') or ''
            if p:
                dp = p
        for mv in _node_mount_values(node):
            if _is_critical_system_mount(mv) and dp:
                system.add(dp)
        for ch in node.get('children') or []:
            walk(ch, dp)

    for top in blockdevices:
        walk(top, None)
    return system


def _disk_descendant_mounted(node) -> bool:
    for mv in _node_mount_values(node):
        if mv and str(mv).strip():
            return True
    for ch in node.get('children') or []:
        if _disk_descendant_mounted(ch):
            return True
    return False


def _top_level_part_count(node) -> int:
    return sum(1 for c in (node.get('children') or []) if str(c.get('type') or '').lower() == 'part')


def _lsblk_json_blockdevices():
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    # apk/DNS kullanmadan: ubuntu imajında lsblk hazır (eligible-disks takılmasını önler)
    image = _lsblk_sidecar_image()
    cmd = [
        'lsblk', '-J', '-b',
        '-o', 'NAME,PATH,TYPE,SIZE,MODEL,MOUNTPOINTS,MOUNTPOINT',
    ]
    vol = {'/dev': {'bind': '/dev', 'mode': 'ro'}, '/sys': {'bind': '/sys', 'mode': 'ro'}}
    tout = int(os.environ.get('LOG_SYSTEM_LSBLK_TIMEOUT_SEC', '45'))
    raw = _container_run_wait_logs(
        image,
        cmd,
        volumes=vol,
        user='0',
        network_mode='none',
        run_timeout_sec=tout,
    )
    try:
        data = json.loads(raw.decode('utf-8'))
    except json.JSONDecodeError as e:
        raise RuntimeError(f'lsblk JSON okunamadı: {e}') from e
    return data.get('blockdevices') or []


def _block_disk_device_path(node: dict) -> str:
    """lsblk PATH boşsa /dev/<NAME> ile dene (TYPE=disk kök düğümler)."""
    path = (node.get('path') or '').strip()
    if path:
        return path
    name = (node.get('name') or '').strip()
    if not name or '/' in name or '..' in name:
        return ''
    return f'/dev/{name}'


def _host_rescan_block_buses():
    """vCenter hot-add / yeni VMDK + mevcut sanal diskin büyütülmesi: SCSI/NVMe + blok rescan."""
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    image = 'alpine:3.20'
    script = r'''
set -eu
for h in /sys/class/scsi_host/host*/scan; do
  if [ -e "$h" ] && [ -w "$h" ]; then echo "- - -" > "$h" 2>/dev/null || true; fi
done
if [ -d /sys/class/nvme ]; then
  for r in /sys/class/nvme/nvme*/rescan; do
    if [ -e "$r" ] && [ -w "$r" ]; then echo 1 > "$r" 2>/dev/null || true; fi
  done
fi
# Hypervisor’da aynı VMDK/VHD büyütüldüğünde kernel çoğu zaman eski SIZE döner; blok rescan gerekir.
for r in /sys/block/*/device/rescan; do
  if [ -e "$r" ] && [ -w "$r" ]; then echo 1 > "$r" 2>/dev/null || true; fi
done
sleep 3
'''
    cmd = ['sh', '-lc', script]
    vols = {
        '/dev': {'bind': '/dev', 'mode': 'rw'},
        '/sys': {'bind': '/sys', 'mode': 'rw'},
    }
    tout = int(os.environ.get('LOG_SYSTEM_RESCAN_TIMEOUT_SEC', '90'))
    _container_run_wait_logs(
        image,
        cmd,
        volumes=vols,
        user='0',
        privileged=True,
        run_timeout_sec=tout,
    )


def list_eligible_raw_data_disks():
    """vCenter'da eklenmiş, kökte kullanılmayan, mount'suz ham diskler (partition'sız veya wipe ile)."""
    blockdevices = _lsblk_json_blockdevices()
    system_paths = _walk_system_disk_paths(blockdevices)
    out = []
    for node in blockdevices:
        if str(node.get('type') or '').lower() != 'disk':
            continue
        path = _block_disk_device_path(node)
        if not path or not _STORAGE_DISK_SAFE.match(path):
            continue
        if path in system_paths:
            continue
        try:
            size = int(node.get('size') or 0)
        except (TypeError, ValueError):
            size = 0
        if size < _MIN_DATA_DISK_BYTES:
            continue
        if _disk_descendant_mounted(node):
            continue
        parts = _top_level_part_count(node)
        out.append({
            'path': path,
            'sizeBytes': size,
            'sizeGB': round(size / (1024 ** 3), 2),
            'model': (node.get('model') or '').strip() or None,
            'partitionCount': parts,
            'canPrepareWithoutWipe': parts == 0,
        })
    # Büyük disk üstte: vCenter “Hard disk 2” (ör. 150 GB) genelde OS diskinden (50 GB) büyüktür ve zaten sistem diski listede yoktur.
    out.sort(key=lambda x: (-x['sizeBytes'], x['path']))
    if out:
        max_sz = max(d['sizeBytes'] for d in out)
        tied = [d for d in out if d['sizeBytes'] == max_sz]
        best_path = min(tied, key=lambda d: d['path'])['path']
        for d in out:
            d['suggestedForDataDisk'] = d['path'] == best_path
    hints = []
    if not out:
        hints.append(
            'Ham disk listesi boş: vCenter’da eklenen VMDK çoğu zaman konukta SCSI/NVMe taraması ister. '
            '«Disk veriyollarını tara» düğmesini kullanın; hâlâ görünmüyorsa VM’yi yeniden başlatın veya '
            'konukta `lsblk` ile aygıt adını doğrulayın (ör. /dev/sdb, /dev/nvme0n2).'
        )
    elif len(out) == 1:
        hints.append(
            'Tek uygun ham disk listelendi — çoğu kurulumda bu, vCenter’daki ikinci VMDK (Hard disk 2) ile aynı aygıttır. '
            'Yine de boyut (GB) ve yolun resimdeki kapasiteyle uyduğunu doğrulayın.'
        )
    else:
        hints.append(
            'Birden fazla disk var: ★ ile işaretli satır, boyutu en büyük olan adaydır (tipik: Hard disk 2 / veri diski). '
            'OS diski bu listede görünmez; yanlış aygıt seçmeyin.'
        )
    return {
        'disks': out,
        'systemDiskPaths': sorted(system_paths),
        'hints': hints,
        'workflow': {
            'title': 'vCenter ikinci disk → veri deposu',
            'steps': [
                'vSphere’da VM’e Hard disk 2 ekleyin (Edit settings) — konukta ek işlem gerekmez.',
                'Panel (tercih): «Otomatik konumlandırma» → «Planı yükle» → onay yazıp «Önerilen disk ile tam kur» (veya elle adımlar).',
                'Elle akış: «Disk veriyollarını tara» → «Diskleri Yenile» → ham diskte «Diski hazırla».',
                'Bölüm varsa wipe + onay; kökte dolu data için «yedek klasöre taşı» veya elle boşaltma.',
            ],
        },
    }


def recommended_veri_disk_setup_plan(rescan: bool = False) -> dict:
    """
    vCenter ikinci VMDK senaryosu: en büyük uygun ham diski önerir; wipe/taşıma ihtiyacı ve mount durumunu döner.
    """
    if rescan:
        try:
            _host_rescan_block_buses()
        except Exception as e:
            return {
                'ok': False,
                'code': 'RESCAN_FAILED',
                'message': str(e),
                'mountStatus': storage_mount_status_snapshot(),
            }
    elig = list_eligible_raw_data_disks()
    disks = list(elig.get('disks') or [])
    suggested = next((d for d in disks if d.get('suggestedForDataDisk')), None)
    mount = storage_mount_status_snapshot()
    if not suggested:
        return {
            'ok': False,
            'code': 'NO_ELIGIBLE_DISK',
            'message': (
                'Uygun ham veri diski yok. vCenter’da ikinci VMDK ekleyin, ardından «Disk veriyollarını tara» ve '
                '«Diskleri Yenile» kullanın.'
            ),
            'hints': elig.get('hints', []),
            'disks': disks,
            'mountStatus': mount,
            'workflow': elig.get('workflow'),
        }
    dev = suggested['path']
    needs_wipe = not bool(suggested.get('canPrepareWithoutWipe'))
    same = bool(mount.get('sameFilesystemAsRoot'))
    non_empty = _host_path_dir_non_empty(STORAGE_DATA_MOUNT_DEFAULT) if same else False
    relocate_rec = bool(same and non_empty)
    summary_lines = [
        f'Önerilen aygıt: {dev} ({suggested.get("sizeGB")} GB).',
        f'Mount noktası {STORAGE_DATA_MOUNT_DEFAULT} şu an kök ile {"aynı" if same else "farklı"} dosya sisteminde.',
    ]
    if needs_wipe:
        summary_lines.append('Diskte bölüm tablosu var; kurulum için «wipe» onayı gerekir (mevcut bölümler silinir).')
    if relocate_rec:
        summary_lines.append(
            'Kök diskte dolu bir data dizini var; öneri: içeriği yedek klasöre taşı (otomatik akışta varsayılan açık).'
        )
    if not same:
        summary_lines.append(
            'Veri yolu kökten ayrı: «Önerilen disk ile tam kur» bu durumda kullanılmamalı (yeniden biçimlendirme riski). '
            'Gerekirse yalnızca «Storage profile» ile .env yollarını güncelleyin.'
        )
    return {
        'ok': True,
        'code': 'READY',
        'suggestedDevice': dev,
        'suggestedSizeGB': suggested.get('sizeGB'),
        'model': suggested.get('model'),
        'partitionCount': suggested.get('partitionCount'),
        'needsWipe': needs_wipe,
        'relocateRecommended': relocate_rec,
        'sameFilesystemAsRoot': same,
        'dataMountNonEmpty': non_empty,
        'mountStatus': mount,
        'hints': elig.get('hints', []),
        'workflow': elig.get('workflow'),
        'summaryLines': summary_lines,
        'targetMount': STORAGE_DATA_MOUNT_DEFAULT,
    }


def complete_recommended_veri_disk_setup(
    confirm_device: str,
    env_name: str,
    *,
    wipe_existing: bool,
    relocate_mount_dir=None,
    rescan_first: bool = True,
) -> dict:
    """
    Önerilen disk + sabit mount (/opt/log-system/data) + storage profile; sonunda mount ayrılığını doğrular.
    """
    _assert_prepare_new_raw_disk_allowed()
    if rescan_first:
        _host_rescan_block_buses()
    plan = recommended_veri_disk_setup_plan(rescan=False)
    if not plan.get('ok'):
        raise RuntimeError(plan.get('message') or 'Önerilen veri diski planı başarısız.')
    dev = plan['suggestedDevice']
    cd = (confirm_device or '').strip()
    if not cd or cd != dev:
        raise RuntimeError(f'Onay için tam aygıt yolunu yazın: {dev}')
    if not plan.get('sameFilesystemAsRoot'):
        raise RuntimeError(
            f'{STORAGE_DATA_MOUNT_DEFAULT} zaten OS kökünden ayrı bir dosya sisteminde görünüyor. '
            'Bu akış yalnızca veri dizini hâlâ kök diskteyken (ikinci VMDK henüz bağlı değilken) kullanılmalı; '
            'aksi halde biçimlendirme veri kaybına yol açabilir. Gerekirse «Storage profile» ile yalnızca .env güncelleyin.'
        )
    if plan.get('needsWipe') and not wipe_existing:
        raise RuntimeError('Bu diskte bölüm var; wipeExisting: true ile onaylamanız gerekir.')
    if relocate_mount_dir is None:
        relocate_mount_dir = bool(plan.get('relocateRecommended'))
    prep = prepare_data_disk_and_apply_profile(
        dev,
        cd,
        STORAGE_DATA_MOUNT_DEFAULT,
        env_name,
        wipe_existing,
        relocate_mount_dir,
    )
    mount_after = storage_mount_status_snapshot()
    verified = not bool(mount_after.get('sameFilesystemAsRoot'))
    if not verified:
        raise RuntimeError(
            'İşlem tamamlandı ancak panel /opt/log-system/data yolunu hâlâ kök ile aynı dosya sisteminde görüyor. '
            'Konutta: findmnt /opt/log-system/data ve journalctl / fstab kontrol edin.'
        )
    prep['mountStatus'] = mount_after
    prep['setupPlan'] = {
        'suggestedDevice': dev,
        'verifiedSeparateFilesystem': verified,
    }
    return prep


def _validate_prepare_disk_request(device: str, confirm_device: str, mount_point: str, wipe_existing: bool):
    device = (device or '').strip()
    confirm_device = (confirm_device or '').strip()
    mount_point = (mount_point or '').strip().rstrip('/')
    if not device or device != confirm_device:
        raise RuntimeError('Onay için aygıt yolunu tam olarak tekrar yazın (confirmDevice).')
    if not _STORAGE_DISK_SAFE.match(device):
        raise RuntimeError(
            'Geçersiz aygıt (yalnızca tam disk: sd*, vd*, xvd*, nvme*n*, mmcblk*).'
        )
    if mount_point != '/opt/log-system/data':
        raise RuntimeError('Otomatik hazırlık yalnızca /opt/log-system/data mount noktası için desteklenir.')
    blockdevices = _lsblk_json_blockdevices()
    system_paths = _walk_system_disk_paths(blockdevices)
    if device in system_paths:
        raise RuntimeError('Bu aygıt sistem diski olarak görünüyor; işlem reddedildi.')
    node = None
    for n in blockdevices:
        if str(n.get('type') or '').lower() == 'disk' and _block_disk_device_path(n) == device:
            node = n
            break
    if node is None:
        raise RuntimeError('Aygıt bulunamadı veya liste dışı.')
    if _disk_descendant_mounted(node):
        raise RuntimeError('Disk veya bölümü mount durumda; önce ayırın.')
    parts = _top_level_part_count(node)
    if parts > 0 and not wipe_existing:
        raise RuntimeError('Üzerinde bölüm var; mevcut veriyi silmek için wipeExisting: true ve onay gerekir.')
    try:
        size = int(node.get('size') or 0)
    except (TypeError, ValueError):
        size = 0
    if size < _MIN_DATA_DISK_BYTES:
        raise RuntimeError('Disk çok küçük (en az ~1 GB).')
    return node


def _host_mkdirs_abs(paths: list):
    """Host üzerinde mutlak yollar için mkdir -p (.env yolları host içindir)."""
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor')
    seen = set()
    ordered = []
    for p in paths:
        if not p or not str(p).startswith('/'):
            continue
        s = str(p).rstrip('/')
        if not s or s in seen:
            continue
        seen.add(s)
        ordered.append(str(p))
    if not ordered:
        return
    lines = ['set -eu']
    for p in ordered:
        safe = str(p).replace("'", "'\"'\"'")
        lines.append(f"mkdir -p '/host{safe}'")
    script = '\n'.join(lines)
    image = 'alpine:3.20'
    vol = {'/': {'bind': '/host', 'mode': 'rw'}}
    tout = int(os.environ.get('LOG_SYSTEM_MKDIR_TIMEOUT_SEC', '120'))
    _container_run_wait_logs(
        image,
        ['sh', '-lc', script],
        volumes=vol,
        user='0',
        privileged=True,
        network_mode='none',
        run_timeout_sec=tout,
    )


def _disk_tools_ephemeral_image_and_network():
    """
    Hazırlık / genişletme konteyneri imajı.
    NO_NETWORK=1 iken apk yoktur: saf alpine kullanılamaz → panel imajına düşülür.
    """
    no_net = str(os.environ.get('LOG_SYSTEM_PREPARE_DISK_NO_NETWORK') or '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    )
    raw = (os.environ.get('LOG_SYSTEM_PREPARE_DISK_IMAGE') or '').strip()
    tag = (os.environ.get('LOG_SYSTEM_RELEASE_TAG') or 'dev').strip()
    fallback_panel = f'log-system/log-management-ui:{tag}'
    if no_net:
        image = raw or fallback_panel
        il = image.lower()
        if il.startswith('alpine:') or il == 'alpine':
            image = fallback_panel
        return image, 'none'
    image = raw or 'alpine:3.20'
    return image, 'bridge'


def _assert_prepare_new_raw_disk_allowed():
    """Tek veri diski politikası: veri kökten ayrıysa yeni ham disk hazırlığı yasak (override: env)."""
    if str(os.environ.get('LOG_SYSTEM_ALLOW_EXTRA_DATA_DISK_PREPARE') or '').strip().lower() in (
        '1', 'true', 'yes', 'on',
    ):
        return
    snap = storage_mount_status_snapshot()
    if snap.get('dataProbeOk') and not snap.get('sameFilesystemAsRoot'):
        raise RuntimeError(
            'Veri dizini zaten kökten ayrı bir dosya sisteminde bağlı. Bu platformda yalnızca tek harici veri diski '
            'desteklenir: kapasite için vSphere’da aynı VMDK’yı büyütüp panelde «Genişlet» kullanın. '
            'İkinci bir ham disk hazırlığı için (geliştirme / özel göç) LOG_SYSTEM_ALLOW_EXTRA_DATA_DISK_PREPARE=1.'
        )


def prepare_data_disk_and_apply_profile(
    device: str,
    confirm_device: str,
    mount_point: str,
    env_name: str,
    wipe_existing: bool,
    relocate_mount_dir: bool = False,
):
    if not docker_available or docker_client is None:
        raise RuntimeError('Docker API erişilemiyor (disk hazırlama için gerekli).')
    _assert_prepare_new_raw_disk_allowed()
    _validate_prepare_disk_request(device, confirm_device, mount_point, wipe_existing)
    image, net_mode = _disk_tools_ephemeral_image_and_network()
    env = {
        'PREPARE_DEV': device,
        'PREPARE_MP': mount_point.rstrip('/'),
        'PREPARE_WIPE': '1' if wipe_existing else '0',
        'PREPARE_RELOCATE_DIR': '1' if relocate_mount_dir else '0',
    }
    vol = {
        '/dev': {'bind': '/dev', 'mode': 'rw'},
        '/': {'bind': '/host', 'mode': 'rw'},
    }
    tout = int(os.environ.get('LOG_SYSTEM_PREPARE_DISK_TIMEOUT_SEC', '900'))
    try:
        log = _container_run_wait_logs(
            image,
            ['sh', '-lc', _PREPARE_DATA_DISK_SCRIPT],
            environment=env,
            volumes=vol,
            user='0',
            privileged=True,
            network_mode=net_mode,
            pid_mode='host',
            run_timeout_sec=tout,
        )
    except RuntimeError as e:
        err = str(e)
        if 'nsenter_mount_failed' in err or 'host_mount_verify_failed' in err or 'nsenter_missing' in err:
            raise RuntimeError(
                'Veri diski host üzerinde mount edilemedi (nsenter / mount doğrulama). '
                'Konutta: `grep log-system /etc/fstab`, `sudo mount -a`, `findmnt /opt/log-system/data`.'
            ) from None
        if 'dir_not_empty' in err:
            raise RuntimeError(
                'Mount noktası (/opt/log-system/data) boş değil — genelde dizin kök diskte önceden oluşturulmuş '
                '(Docker/compose verisi) ve henüz veri diski buraya bağlanmamış. '
                'Çözüm: panelde «Mevcut içeriği yedek klasöre taşı» kutusunu işaretleyip aynı işlemi tekrarlayın '
                '(içerik /opt/log-system/data.panel-relocate-… altına taşınır), veya stack’i durdurup içeriği elle '
                'başka yere alın ve dizini boşaltın. '
                'Diskte zaten bölüm oluştuysa «Mevcut bölüm tablosunu sil (wipe)» işaretleyin.'
            ) from None
        raise

    log_txt = log.decode('utf-8', errors='replace').strip() if isinstance(log, (bytes, bytearray)) else str(log)
    # Az önce bu mount noktasına ikinci diski bağladık; df/mapper farkı yüzünden yanlış «aynı FS» tetiklenmesin.
    prof = apply_storage_profile(
        mount_point.rstrip('/'), env_name=env_name, acknowledge_same_as_root=True
    )
    verify = storage_mount_status_snapshot()
    return {
        'prepareLog': log_txt,
        'profile': prof,
        'mountVerification': {
            'separateFromRoot': not verify.get('sameFilesystemAsRoot'),
            'dataPath': verify.get('dataPath'),
            'dataSource': verify.get('dataSource'),
            'rootSource': verify.get('rootSource'),
        },
    }


def ops_summary_snapshot():
    services_status = get_service_status()
    metrics = stack_health_metrics_from_services(services_status) if isinstance(services_status, dict) and 'error' not in services_status else {'running': 0, 'total': 0, 'problematic': 0}
    running = metrics['running']
    total = metrics['total']
    problematic = metrics['problematic']

    env_name = os.environ.get('APP_ENV') or os.environ.get('PLATFORM_MODE') or 'unknown'
    return {
        'environment': env_name,
        'platform': runtime_platform(),
        'runningServices': running,
        'totalServices': total,
        'problematicServices': problematic,
        'timestamp': datetime.utcnow().isoformat() + 'Z'
    }


def _is_truthy(value):
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def _is_prod_log_system_env(env_map=None):
    """LOG_SYSTEM_ENV prod/production ise sentetik log-gen ve ilgili ayarlar kapalı olmalı."""
    if env_map is None:
        env_map = parse_env_file(ENV_PATH)
    v = (env_map.get('LOG_SYSTEM_ENV') or os.environ.get('LOG_SYSTEM_ENV') or '').strip().lower()
    return v in ('prod', 'production')


# Sentetik flog servisleri yalnızca bu dosyada; ana/prod compose birleşiminde tanımsız (prod paketine dahil edilmez).
DOCKER_COMPOSE_SYNTHETIC_FILE = 'docker-compose.synthetic-traffic.yml'


def _build_settings_definitions():
    return [
        {
            'key': 'TZ', 'label': 'Zaman Dilimi', 'group': 'Sistem', 'type': 'text', 'requiredRole': 'operator',
            'description': 'Tüm servisler için IANA timezone değeri.', 'default': 'Europe/Istanbul',
            'pattern': r'^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$', 'placeholder': 'Europe/Istanbul',
            'hint': 'Örnek: Europe/Istanbul', 'affectedServices': ['all'], 'restartRequired': True, 'riskLevel': 'low'
        },
        {
            'key': 'NETWORK_SUBNET', 'label': 'Ağ Alt Bloğu', 'group': 'Ağ', 'type': 'text', 'requiredRole': 'admin',
            'description': 'Docker ağı CIDR bloğu.', 'default': '172.20.0.0/16',
            'pattern': r'^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$', 'placeholder': '172.20.0.0/16',
            'affectedServices': ['network', 'all-services'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'NETWORK_GATEWAY', 'label': 'Ağ Gateway', 'group': 'Ağ', 'type': 'text', 'requiredRole': 'admin',
            'description': 'Docker ağı varsayılan geçit IP adresi.', 'default': '172.20.0.1',
            'pattern': r'^\d{1,3}(?:\.\d{1,3}){3}$', 'placeholder': '172.20.0.1',
            'affectedServices': ['network', 'all-services'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'GRAYLOG_PORT', 'label': 'Graylog Portu', 'group': 'Log İşleme', 'type': 'number', 'requiredRole': 'operator',
            'description': 'Graylog web/API portu.', 'default': '9000', 'min': 1, 'max': 65535,
            'affectedServices': ['graylog', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'GRAYLOG_WEB_URL', 'label': 'Graylog Web URL', 'group': 'Log İşleme', 'type': 'text', 'requiredRole': 'operator',
            'description': 'Graylog dış erişim URL bilgisi.', 'default': 'http://localhost:9000',
            'pattern': r'^https?:\/\/[^\s]+$', 'placeholder': 'http://localhost:9000',
            'affectedServices': ['graylog'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'GRAYLOG_PASSWORD_SECRET', 'label': 'Graylog Password Secret', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': (
                'Graylog’un veritabanındaki kullanıcı parolalarını türetmek için kullandığı sunucu tarafı «biber» (pepper). '
                'Giriş şifreniz değildir; yanlış değiştirilirse mevcut kullanıcı hash’leri geçersiz kalabilir.'
            ),
            'default': '', 'minLength': 32,
            'hint': 'Yalnızca ilk kurulum veya güvenlik politikası gerektirirken değiştirin. Üretmek: openssl rand -hex 32 veya benzeri (en az 32 karakter).',
            'affectedServices': ['graylog'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'GRAYLOG_ROOT_PASSWORD', 'label': 'Graylog Admin Parolası', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': (
                'Graylog «admin» parolası (düz metin). Kayıtta `GRAYLOG_ROOT_PASSWORD_SHA2` otomatik yazılır; '
                'mevcut kurulumda parola MongoDB’de saklı olduğu için panel ayrıca admin kullanıcı kaydını siler ve '
                'graylog, bu panel ile watchdog konteynerlerini arka planda yeniden oluşturur (Docker gerekir).'
            ),
            'default': '', 'minLength': 8,
            'hint': 'Kaydet sonrası ~1–2 dk bekleyip sayfayı yenileyin. Otomasyonu kapatmak: LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT=0',
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'OPENSEARCH_CLUSTER_NAME', 'label': 'OpenSearch Cluster Adı', 'group': 'Log İşleme', 'type': 'text', 'requiredRole': 'admin',
            'description': 'OpenSearch cluster adı.', 'default': 'opensearch-cluster', 'pattern': r'^[a-zA-Z0-9._-]{3,64}$',
            'affectedServices': ['opensearch', 'graylog'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'OPENSEARCH_INITIAL_ADMIN_PASSWORD', 'label': 'OpenSearch Admin Parolası', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'OpenSearch bootstrap admin parolası.', 'default': '', 'minLength': 8,
            'affectedServices': ['opensearch'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'GRAFANA_PORT', 'label': 'Grafana Portu', 'group': 'Gözlem', 'type': 'number', 'requiredRole': 'operator',
            'description': 'Grafana web portu.', 'default': '3000', 'min': 1, 'max': 65535,
            'affectedServices': ['grafana', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'GF_SECURITY_ADMIN_PASSWORD', 'label': 'Grafana Admin Parolası', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'Grafana yönetici şifresi.', 'default': '', 'minLength': 8,
            'affectedServices': ['grafana'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'SMTP_ENABLED', 'label': 'SMTP Aktif', 'group': 'Bildirim', 'type': 'select', 'requiredRole': 'operator',
            'description': 'E-posta bildirimlerini aç/kapat.', 'default': 'true', 'options': ['true', 'false'],
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_HOST', 'label': 'SMTP Sunucusu', 'group': 'Bildirim', 'type': 'text', 'requiredRole': 'operator',
            'description': 'SMTP host adı (protokol olmadan).', 'default': 'smtp.gmail.com',
            'pattern': r'^[A-Za-z0-9.-]+$', 'forbiddenPatterns': [r'^https?:\/\/'], 'placeholder': 'smtp.example.com',
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_PORT', 'label': 'SMTP Portu', 'group': 'Bildirim', 'type': 'number', 'requiredRole': 'operator',
            'description': 'SMTP bağlantı portu.', 'default': '587', 'min': 1, 'max': 65535,
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_USE_AUTH', 'label': 'SMTP Auth', 'group': 'Bildirim', 'type': 'select', 'requiredRole': 'operator',
            'description': 'SMTP kimlik doğrulama kullanılsın mı?', 'default': 'true', 'options': ['true', 'false'],
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_USE_TLS', 'label': 'SMTP TLS', 'group': 'Bildirim', 'type': 'select', 'requiredRole': 'operator',
            'description': 'SMTP TLS kullanılsın mı?', 'default': 'true', 'options': ['true', 'false'],
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_USER', 'label': 'SMTP Kullanıcı', 'group': 'Bildirim', 'type': 'text', 'requiredRole': 'admin',
            'description': 'SMTP kullanıcı adı.', 'default': '', 'placeholder': 'user@example.com',
            'visibleWhen': {'allOf': [{'key': 'SMTP_ENABLED', 'truthy': True}, {'key': 'SMTP_USE_AUTH', 'truthy': True}]},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'SMTP_PASSWORD', 'label': 'SMTP Parola', 'group': 'Bildirim', 'type': 'password', 'requiredRole': 'admin',
            'description': 'SMTP parola veya app-password.', 'default': '', 'minLength': 8,
            'visibleWhen': {'allOf': [{'key': 'SMTP_ENABLED', 'truthy': True}, {'key': 'SMTP_USE_AUTH', 'truthy': True}]},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'SMTP_FROM', 'label': 'SMTP Gönderen', 'group': 'Bildirim', 'type': 'text', 'requiredRole': 'operator',
            'description': 'Bildirim e-postası gönderen adresi.', 'default': 'logs@example.com',
            'pattern': r'^[^\s@]+@[^\s@]+\.[^\s@]+$', 'placeholder': 'logs@example.com',
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog', 'watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SMTP_SUBJECT_PREFIX', 'label': 'SMTP Konu Öneki', 'group': 'Bildirim', 'type': 'text', 'requiredRole': 'operator',
            'description': 'Alarm e-postaları için konu başlığı öneki.', 'default': '[Log Platform]',
            'visibleWhen': {'key': 'SMTP_ENABLED', 'truthy': True},
            'affectedServices': ['graylog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'TELEGRAM_BOT_TOKEN', 'label': 'Telegram Bot Token', 'group': 'Bildirim', 'type': 'password', 'requiredRole': 'admin',
            'description': 'Telegram bot erişim tokenı.', 'default': '', 'minLength': 20,
            'affectedServices': ['watchdog'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'TELEGRAM_CHAT_ID', 'label': 'Telegram Chat ID', 'group': 'Bildirim', 'type': 'text', 'requiredRole': 'operator',
            'description': 'Alarmların gönderileceği chat ID.', 'default': '', 'pattern': r'^-?[0-9]{5,}$',
            'visibleWhen': {'key': 'TELEGRAM_BOT_TOKEN', 'hasValue': True},
            'affectedServices': ['watchdog'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'ALERT_THRESHOLD_MINUTES', 'label': 'Alarm Eşiği (dk)', 'group': 'Bildirim', 'type': 'number', 'requiredRole': 'operator',
            'description': 'Telegram watchdog alarm gecikme eşiği.', 'default': '5', 'min': 1, 'max': 1440,
            'affectedServices': ['watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'HEALTH_CHECK_HOURS', 'label': 'Sağlık Kontrol Aralığı (saat)', 'group': 'Bildirim', 'type': 'number', 'requiredRole': 'operator',
            'description': 'Watchdog periyodik sağlık raporu aralığı.', 'default': '1', 'min': 1, 'max': 24,
            'affectedServices': ['watchdog'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'LOG_SYNTHETIC_GENERATOR', 'label': 'Sentetik log üretici (flog / log-gen)', 'group': 'Log toplama', 'type': 'select', 'requiredRole': 'admin',
            'description': 'Kapalı (önerilen): yalnızca gerçek kaynaklardan gelen UDP 5151 trafiği işlenir. Açık: log-gen konteyneri sürekli sahte JSON üretir; Graylog’u gürültüden arındırmak için kapalı tutun, yalnızca testte açın.',
            'default': 'false',
            'options': ['false', 'true'],
            'affectedServices': ['log-gen'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'MINIO_ROOT_USER', 'label': 'MinIO Root Kullanıcı', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'MinIO yönetici kullanıcı adı.', 'default': 'minioadmin', 'pattern': r'^[A-Za-z0-9._-]{3,32}$',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'minio:'},
            'affectedServices': ['minio'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'MINIO_ROOT_PASSWORD', 'label': 'MinIO Root Parolası', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'MinIO yönetici parolası.', 'default': '', 'minLength': 8,
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'minio:'},
            'affectedServices': ['minio'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'MINIO_DEFAULT_BUCKETS', 'label': 'MinIO Varsayılan Bucket', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'Başlangıçta oluşturulacak bucket listesi.', 'default': 'logs-backup', 'pattern': r'^[A-Za-z0-9._,-]{3,128}$',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'minio:'},
            'affectedServices': ['minio'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'MINIO_API_PORT', 'label': 'MinIO API Portu', 'group': 'Arşiv', 'type': 'number', 'requiredRole': 'operator',
            'description': 'MinIO API servis portu.', 'default': '9002', 'min': 1, 'max': 65535,
            'affectedServices': ['minio', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'MINIO_CONSOLE_PORT', 'label': 'MinIO Console Portu', 'group': 'Arşiv', 'type': 'number', 'requiredRole': 'operator',
            'description': 'MinIO Console portu.', 'default': '9003', 'min': 1, 'max': 65535,
            'affectedServices': ['minio', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'NPM_HTTP_PORT', 'label': 'Nginx Proxy HTTP Port', 'group': 'Ağ', 'type': 'number', 'requiredRole': 'admin',
            'description': 'NPM HTTP ingress portu.', 'default': '80', 'min': 1, 'max': 65535,
            'affectedServices': ['nginx-proxy-manager'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'NPM_ADMIN_PORT', 'label': 'Nginx Proxy Admin Port', 'group': 'Ağ', 'type': 'number', 'requiredRole': 'admin',
            'description': 'NPM yönetim panel portu.', 'default': '81', 'min': 1, 'max': 65535,
            'affectedServices': ['nginx-proxy-manager'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'NPM_HTTPS_PORT', 'label': 'Nginx Proxy HTTPS Port', 'group': 'Ağ', 'type': 'number', 'requiredRole': 'admin',
            'description': 'NPM HTTPS ingress portu.', 'default': '443', 'min': 1, 'max': 65535,
            'affectedServices': ['nginx-proxy-manager'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'MANAGEMENT_UI_PORT', 'label': 'Yönetim Paneli Portu', 'group': 'Panel', 'type': 'number', 'requiredRole': 'admin',
            'description': 'Management UI erişim portu.', 'default': '8080', 'min': 1, 'max': 65535,
            'affectedServices': ['log-management-ui', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'MANAGEMENT_UI_SECRET_KEY', 'label': 'Panel Secret Key', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'Panel session/CSRF gizli anahtarı.', 'default': '', 'minLength': 32,
            'affectedServices': ['log-management-ui'], 'restartRequired': True, 'riskLevel': 'high'
        },
        {
            'key': 'SESSION_TIMEOUT_MINUTES', 'label': 'Panel Oturum Süresi (dk)', 'group': 'Panel', 'type': 'number', 'requiredRole': 'admin',
            'description': 'Yönetim paneli oturum zaman aşımı dakikası.', 'default': str(SESSION_TIMEOUT_MINUTES), 'min': 5, 'max': 1440,
            'affectedServices': ['log-management-ui'], 'restartRequired': True, 'riskLevel': 'low'
        },
        {
            'key': 'SIGNING_ENGINE_PORT', 'label': 'İmzalama Motoru Portu', 'group': '5651 Uyum', 'type': 'number', 'requiredRole': 'admin',
            'description': 'Signing engine servis portu.', 'default': '9080', 'min': 1, 'max': 65535,
            'affectedServices': ['signing-engine', 'proxy'], 'restartRequired': True, 'riskLevel': 'medium'
        },
        {
            'key': 'SIGNER_TYPE', 'label': '5651 İmzalama Tipi', 'group': '5651 Uyum', 'type': 'select', 'requiredRole': 'admin',
            'description': 'Üretim: TÜBİTAK KamuSM TSA veya OpenSSL tabanlı özet (SIMULATED kaldırıldı).',
            'default': 'OPEN_SOURCE',
            'options': ['TUBITAK', 'OPEN_SOURCE'],
            'affectedServices': ['signing-engine', 'log-signer-cron'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'ARCHIVE_DESTINATION', 'label': 'Arşiv Hedefi', 'group': '5651 Uyum', 'type': 'text', 'requiredRole': 'admin',
            'description': 'local, minio:bucket, s3:bucket veya sftp:server/path.', 'default': 'local',
            'pattern': r'^(local|minio:[\w./-]+|s3:[\w./-]+|sftp:[^\s:]+\/[^\s]+)$',
            'affectedServices': ['signing-engine', 'minio'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'LOG_HOT_RETENTION_DAYS', 'label': 'Hot Saklama (gün)', 'group': '5651 Uyum', 'type': 'number', 'requiredRole': 'admin',
            'description': 'OpenSearch üzerinde hızlı arama için tutulacak gün sayısı.', 'default': '90', 'min': 7, 'max': 365,
            'affectedServices': ['opensearch', 'graylog'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'LOG_TOTAL_RETENTION_DAYS', 'label': 'Toplam Saklama (gün)', 'group': '5651 Uyum', 'type': 'number', 'requiredRole': 'admin',
            'description': 'Yasal saklama süresi (5651 için önerilen 730 gün).', 'default': '730', 'min': 90, 'max': 3650,
            'affectedServices': ['signing-engine', 'archive-policy'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'ARCHIVE_TRANSFER_ENABLED', 'label': 'Cold Arşiv Transferi Aktif', 'group': '5651 Uyum', 'type': 'select', 'requiredRole': 'operator',
            'description': 'Hot süresi dolan logların arşive taşınmasını aç/kapat.', 'default': 'true', 'options': ['true', 'false'],
            'affectedServices': ['signing-engine', 'archive-policy'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'ARCHIVE_TRANSFER_INTERVAL_MINUTES', 'label': 'Arşiv Transfer Aralığı (dk)', 'group': '5651 Uyum', 'type': 'number', 'requiredRole': 'operator',
            'description': 'Arşiv transfer job çalışma sıklığı.', 'default': '60', 'min': 5, 'max': 1440,
            'visibleWhen': {'key': 'ARCHIVE_TRANSFER_ENABLED', 'truthy': True},
            'affectedServices': ['signing-engine', 'archive-policy'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'ARCHIVE_VERIFY_ON_TRANSFER', 'label': 'Transfer Sonrası Hash Doğrulama', 'group': '5651 Uyum', 'type': 'select', 'requiredRole': 'operator',
            'description': 'Arşiv transferinden sonra bütünlük doğrulaması yap.', 'default': 'true', 'options': ['true', 'false'],
            'visibleWhen': {'key': 'ARCHIVE_TRANSFER_ENABLED', 'truthy': True},
            'affectedServices': ['signing-engine', 'archive-policy'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'S3_ENDPOINT', 'label': 'S3 Endpoint', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'S3 uyumlu servis endpoint adresi (host:port veya URL).', 'default': '',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 's3:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'S3_ACCESS_KEY', 'label': 'S3 Access Key', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'S3 erişim anahtarı.', 'default': '',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 's3:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'S3_SECRET_KEY', 'label': 'S3 Secret Key', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'S3 gizli anahtarı.', 'default': '', 'minLength': 8,
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 's3:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'SFTP_HOST', 'label': 'SFTP Host', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'SFTP sunucu adresi.', 'default': '',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'sftp:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'SFTP_PORT', 'label': 'SFTP Port', 'group': 'Arşiv', 'type': 'number', 'requiredRole': 'admin',
            'description': 'SFTP portu.', 'default': '22', 'min': 1, 'max': 65535,
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'sftp:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'low'
        },
        {
            'key': 'SFTP_USER', 'label': 'SFTP Kullanıcı', 'group': 'Arşiv', 'type': 'text', 'requiredRole': 'admin',
            'description': 'SFTP kullanıcı adı.', 'default': '',
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'sftp:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'SFTP_PASSWORD', 'label': 'SFTP Parola', 'group': 'Güvenlik', 'type': 'password', 'requiredRole': 'admin',
            'description': 'SFTP kullanıcı parolası.', 'default': '', 'minLength': 8,
            'visibleWhen': {'key': 'ARCHIVE_DESTINATION', 'startsWith': 'sftp:'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'high'
        },
        {
            'key': 'TUBITAK_TSA_URL', 'label': 'TÜBİTAK TSA URL', 'group': '5651 Uyum', 'type': 'text', 'requiredRole': 'admin',
            'description': 'TSA zaman damgası endpoint adresi.', 'default': 'https://kamusm.bilgem.tubitak.gov.tr/tsa',
            'pattern': r'^https:\/\/[^\s]+$', 'placeholder': 'https://.../tsa',
            'visibleWhen': {'key': 'SIGNER_TYPE', 'equals': 'TUBITAK'},
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'medium'
        },
        {
            'key': 'SIGNING_ENGINE_SCHEDULE_ENABLED', 'label': 'İmza Motoru Zamanlayıcı', 'group': '5651 Uyum', 'type': 'select', 'requiredRole': 'operator',
            'description': 'Otomatik imzalama zamanlayıcısını aç/kapat.', 'default': 'true', 'options': ['true', 'false'],
            'affectedServices': ['signing-engine'], 'restartRequired': False, 'riskLevel': 'low'
        }
    ]


def _normalize_and_validate_setting(setting, raw_value):
    key = setting.get('key')
    setting_type = setting.get('type', 'text')

    if setting_type == 'password' and raw_value == '********':
        return None, None

    if setting_type == 'number':
        try:
            value_int = int(str(raw_value).strip())
        except Exception:
            return None, 'Sayısal değer girin'
        minimum = setting.get('min')
        maximum = setting.get('max')
        if minimum is not None and value_int < int(minimum):
            return None, f'Değer en az {minimum} olmalı'
        if maximum is not None and value_int > int(maximum):
            return None, f'Değer en fazla {maximum} olmalı'
        return str(value_int), None

    value = '' if raw_value is None else str(raw_value).strip()

    if setting_type == 'select':
        options = setting.get('options', [])
        if value not in options:
            return None, f'Geçersiz değer. Beklenen seçenekler: {options}'

    min_length = setting.get('minLength')
    if min_length and value and len(value) < int(min_length):
        return None, f'Değer en az {min_length} karakter olmalı'

    pattern = setting.get('pattern')
    if pattern and value:
        if not re.match(pattern, value):
            return None, f'{key} formatı geçersiz'

    forbidden_patterns = setting.get('forbiddenPatterns', []) or []
    for bad in forbidden_patterns:
        if value and re.search(bad, value, flags=re.IGNORECASE):
            return None, f'{key} alanında izin verilmeyen format tespit edildi'

    if key == 'NETWORK_SUBNET' and value:
        try:
            ipaddress.ip_network(value, strict=False)
        except Exception:
            return None, 'NETWORK_SUBNET geçerli bir CIDR olmalı'

    if key == 'NETWORK_GATEWAY' and value:
        try:
            ipaddress.ip_address(value)
        except Exception:
            return None, 'NETWORK_GATEWAY geçerli bir IP olmalı'

    return value, None


def _validate_settings_dependencies(candidate_env):
    if _is_truthy(candidate_env.get('LOG_SYNTHETIC_GENERATOR')):
        le = (candidate_env.get('LOG_SYSTEM_ENV') or '').strip().lower()
        if le in ('prod', 'production'):
            return 'Üretim ortamında LOG_SYNTHETIC_GENERATOR açılamaz'

    smtp_enabled = _is_truthy(candidate_env.get('SMTP_ENABLED'))
    if smtp_enabled:
        for required in ('SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM'):
            if not str(candidate_env.get(required, '')).strip():
                return f'{required} boş bırakılamaz (SMTP aktifken)'
        if _is_truthy(candidate_env.get('SMTP_USE_AUTH')):
            for required in ('SMTP_USER', 'SMTP_PASSWORD'):
                if not str(candidate_env.get(required, '')).strip():
                    return f'{required} boş bırakılamaz (SMTP auth aktifken)'

    telegram_token = str(candidate_env.get('TELEGRAM_BOT_TOKEN', '')).strip()
    telegram_chat = str(candidate_env.get('TELEGRAM_CHAT_ID', '')).strip()
    if bool(telegram_token) ^ bool(telegram_chat):
        return 'Telegram kullanımı için TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID birlikte doldurulmalı'

    signer_type = str(candidate_env.get('SIGNER_TYPE', 'OPEN_SOURCE')).strip().upper()
    if signer_type == 'SIMULATED':
        return 'SIGNER_TYPE=SIMULATED artık desteklenmiyor; OPEN_SOURCE veya TUBITAK seçin'
    tsa_url = str(candidate_env.get('TUBITAK_TSA_URL', '')).strip()
    if signer_type == 'TUBITAK' and not tsa_url.startswith('https://'):
        return 'SIGNER_TYPE=TUBITAK iken TUBITAK_TSA_URL https:// ile başlamalı'

    archive_destination = str(candidate_env.get('ARCHIVE_DESTINATION', 'local')).strip().lower()
    hot_days_raw = str(candidate_env.get('LOG_HOT_RETENTION_DAYS', '90')).strip()
    total_days_raw = str(candidate_env.get('LOG_TOTAL_RETENTION_DAYS', '730')).strip()
    try:
        hot_days = int(hot_days_raw)
        total_days = int(total_days_raw)
    except Exception:
        return 'LOG_HOT_RETENTION_DAYS ve LOG_TOTAL_RETENTION_DAYS sayısal olmalı'

    if hot_days < 7:
        return 'LOG_HOT_RETENTION_DAYS en az 7 olmalı'
    if total_days < 90:
        return 'LOG_TOTAL_RETENTION_DAYS en az 90 olmalı'
    if hot_days >= total_days:
        return 'LOG_HOT_RETENTION_DAYS, LOG_TOTAL_RETENTION_DAYS değerinden küçük olmalı'

    if archive_destination.startswith('minio:'):
        if not str(candidate_env.get('MINIO_ROOT_USER', '')).strip() or not str(candidate_env.get('MINIO_ROOT_PASSWORD', '')).strip():
            return 'ARCHIVE_DESTINATION=minio:* iken MINIO_ROOT_USER ve MINIO_ROOT_PASSWORD gereklidir'

    if archive_destination.startswith('s3:'):
        for required in ('S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'):
            if not str(candidate_env.get(required, '')).strip():
                return f'ARCHIVE_DESTINATION=s3:* iken {required} gereklidir'

    if archive_destination.startswith('sftp:'):
        for required in ('SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_PASSWORD'):
            if not str(candidate_env.get(required, '')).strip():
                return f'ARCHIVE_DESTINATION=sftp:* iken {required} gereklidir'

    transfer_enabled = _is_truthy(candidate_env.get('ARCHIVE_TRANSFER_ENABLED', 'true'))
    if transfer_enabled:
        interval_raw = str(candidate_env.get('ARCHIVE_TRANSFER_INTERVAL_MINUTES', '60')).strip()
        try:
            interval = int(interval_raw)
        except Exception:
            return 'ARCHIVE_TRANSFER_INTERVAL_MINUTES sayısal olmalı'
        if interval < 5 or interval > 1440:
            return 'ARCHIVE_TRANSFER_INTERVAL_MINUTES 5-1440 aralığında olmalı'

    ports_to_check = [
        'GRAYLOG_PORT', 'GRAFANA_PORT', 'MANAGEMENT_UI_PORT', 'SIGNING_ENGINE_PORT',
        'MINIO_API_PORT', 'MINIO_CONSOLE_PORT', 'NPM_HTTP_PORT', 'NPM_ADMIN_PORT', 'NPM_HTTPS_PORT'
    ]
    used_ports = {}
    for key in ports_to_check:
        raw = str(candidate_env.get(key, '')).strip()
        if not raw:
            continue
        try:
            port = int(raw)
        except Exception:
            return f'{key} sayısal olmalı'
        if port < 1 or port > 65535:
            return f'{key} 1-65535 aralığında olmalı'
        if port in used_ports and used_ports[port] != key:
            return f'Port çakışması: {key} ve {used_ports[port]} aynı portu kullanıyor ({port})'
        used_ports[port] = key

    subnet_raw = str(candidate_env.get('NETWORK_SUBNET', '')).strip()
    gateway_raw = str(candidate_env.get('NETWORK_GATEWAY', '')).strip()
    if subnet_raw and gateway_raw:
        try:
            subnet = ipaddress.ip_network(subnet_raw, strict=False)
            gateway = ipaddress.ip_address(gateway_raw)
            if gateway not in subnet:
                return 'NETWORK_GATEWAY, NETWORK_SUBNET bloğu içinde olmalı'
        except Exception:
            return 'NETWORK_SUBNET/NETWORK_GATEWAY kombinasyonu geçersiz'

    return None


def _sanitize_audit_value(setting, value):
    setting_key = (setting or {}).get('key', '')
    setting_type = (setting or {}).get('type', '')
    text = '' if value is None else str(value)
    if setting_type == 'password' or any(token in setting_key for token in ('PASSWORD', 'SECRET', 'TOKEN')):
        return '********' if text else ''
    return text


def settings_catalog():
    env_map = parse_env_file(ENV_PATH)
    definitions = _build_settings_definitions()
    catalog = []

    for item in definitions:
        setting = dict(item)
        key = setting.get('key')
        if key == 'LOG_SYNTHETIC_GENERATOR' and _is_prod_log_system_env(env_map):
            continue
        default_value = setting.get('default', '')
        value = env_map.get(key, default_value)
        if key == 'SIGNER_TYPE':
            st = str(value or '').strip().upper()
            if st == 'SIMULATED':
                value = 'OPEN_SOURCE'
                setting['deprecatedCoercion'] = 'SIMULATED artık yok; OPEN_SOURCE gösteriliyor — kaydederek .env güncelleyin.'
        if setting.get('type') == 'number' and value is not None:
            value = str(value)
        setting['value'] = value
        catalog.append(setting)

    return catalog

def apply_config_change(config_type, content):
    """Apply configuration change with dependency handling"""
    if not is_safe_config_path(config_type):
        raise RuntimeError('Invalid config path')

    backup_dir = BASE_DIR / 'backups'
    backup_dir.mkdir(exist_ok=True)
    
    # Determine the actual file path
    file_path = None
    
    # Check if it's a direct match in CONFIG_PATHS
    if config_type in CONFIG_PATHS:
        file_path = CONFIG_PATHS[config_type]
    else:
        # Check for subpaths
        for base_type, base_path in CONFIG_PATHS.items():
            if config_type.startswith(base_type + '/'):
                relative_path = config_type[len(base_type)+1:]
                file_path = base_path / relative_path
                break
    
    # If still not found, try root path
    if file_path is None:
        file_path = BASE_DIR / config_type
    
    # Create backup if file exists
    if file_path and file_path.exists():
        backup_file = backup_dir / f"{config_type.replace('/', '_')}_{os.urandom(4).hex()}.bak"
        try:
            shutil.copy2(file_path, backup_file)
        except Exception as e:
            return f"Error creating backup: {str(e)}"
    
    # Write new content
    try:
        # Ensure parent directory exists
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(file_path, 'w') as f:
            f.write(content)
    except Exception as e:
        return f"Error writing file: {str(e)}"
    
    # Handle dependencies based on config type
    if config_type == 'docker-compose':
        # Restart all services
        subprocess.run(['docker', 'compose', 'down'], cwd='/app/config', capture_output=True)
        subprocess.run(['docker', 'compose', 'up', '-d'], cwd='/app/config', capture_output=True)
        return "Docker Compose updated and services restarted"
    
    elif config_type == 'env':
        # Restart setup service to apply new env vars
        subprocess.run(['docker', 'compose', 'restart', 'setup'], 
                      cwd='/app/config', capture_output=True)
        return ".env updated, setup service restarted"
    
    elif 'fluent-bit' in config_type:
        subprocess.run(['docker', 'compose', 'restart', 'fluent-bit'], 
                      cwd='/app/config', capture_output=True)
        return "Fluent Bit configuration updated and service restarted"
    
    elif 'grafana' in config_type:
        subprocess.run(['docker', 'compose', 'restart', 'grafana'], 
                      cwd='/app/config', capture_output=True)
        return "Grafana configuration updated and service restarted"
    
    elif 'scripts' in config_type:
        # Make script executable
        if file_path.exists():
            os.chmod(file_path, 0o755)
        return "Script updated"
    
    return "Configuration updated"

@app.route('/')
@login_required
def index():
    """Main dashboard - Unified Management Panel"""
    services = get_service_status()
    return render_template(
        'dashboard.html',
        services=services,
        current_user=session.get('username'),
        current_role=session.get('role')
    )


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        if session.get('username'):
            return redirect(url_for('index'))
        return render_template('login.html', csrf_token=get_or_create_csrf_token())

    payload = request.json if request.is_json else request.form
    csrf_token = payload.get('csrf_token') if hasattr(payload, 'get') else None
    if not validate_csrf_token(csrf_token):
        if request.is_json:
            return jsonify({'error': 'CSRF token missing or invalid'}), 403
        flash('Güvenlik doğrulaması başarısız oldu. Sayfayı yenileyin.', 'error')
        return redirect(url_for('login'))

    username = (payload.get('username') or '').strip()
    password = payload.get('password') or ''

    user = get_user(username)
    if not user or not check_password_hash(user.get('password_hash', ''), password):
        audit_event('auth.login', 'failed', {'username': username})
        if request.is_json:
            return jsonify({'error': 'Invalid credentials'}), 401
        flash('Geçersiz kullanıcı adı veya parola', 'error')
        return redirect(url_for('login'))

    session['username'] = user['username']
    session['role'] = user.get('role', 'viewer')
    session['expires_at'] = (datetime.utcnow() + timedelta(minutes=SESSION_TIMEOUT_MINUTES)).timestamp()
    csrf = get_or_create_csrf_token()
    audit_event('auth.login', 'success', {'username': user['username']})

    if request.is_json:
        return jsonify({'message': 'Login successful', 'user': user['username'], 'role': session['role'], 'csrfToken': csrf})

    return redirect(url_for('index'))


@app.route('/logout', methods=['POST', 'GET'])
def logout():
    audit_event('auth.logout', 'success', {'username': session.get('username')})
    session.clear()
    if request.path.startswith('/api/') or request.method == 'POST':
        return jsonify({'message': 'Logged out'})
    return redirect(url_for('login'))


@app.route('/api/auth/me')
@login_required
def auth_me():
    return jsonify({
        'username': session.get('username'),
        'role': session.get('role'),
        'expires_at': session.get('expires_at'),
        'csrfToken': get_or_create_csrf_token()
    })

@app.route('/api/services')
@login_required
def api_services():
    """API endpoint for services status"""
    return jsonify(get_service_status())


@app.route('/api/platform')
@login_required
def api_platform():
    return jsonify({
        'platform': runtime_platform(),
        'mode': PLATFORM_MODE,
        'k8s_available': k8s_available,
        'docker_available': docker_available,
        'namespace': K8S_NAMESPACE,
        'serviceLinkHost': _resolve_service_link_host(),
        'publicPanelBaseUrl': _public_app_base_url(),
    })

@app.route('/api/config/<path:config_type>', methods=['GET'])
@login_required
def get_config(config_type):
    """Get configuration file content"""
    if not is_safe_config_path(config_type):
        return jsonify({'error': 'Invalid config path'}), 400

    # Handle special case for loading config files list
    if config_type == 'config-files-list':
        # Return a list of all available configuration files
        all_files = []
        for name, path in CONFIG_PATHS.items():
            if path.exists():
                if path.is_dir():
                    for file_path in path.rglob('*'):
                        if file_path.is_file():
                            rel_path = file_path.relative_to(path)
                            full_path = f"{name}/{rel_path}"
                            all_files.append(full_path)
                else:
                    all_files.append(name)
        
        # Also add common files that might not be in CONFIG_PATHS
        common_files = [
            'docker-compose.yml',
            '.env',
            'fluent-bit/fluent-bit.conf',
            'grafana_config/datasources.yaml',
            'grafana_config/dashboards.yaml',
            'grafana_config/dashboards/master_dashboard.json',
            'grafana_config/alerting/contact-points.yaml',
            'grafana_config/alerting/notification-policies.yaml',
            'grafana_config/alerting/rules.yaml',
            'scripts/compliance/sign_logs.sh',
            'scripts/monitoring/telegram_watchdog.sh',
            'scripts/monitoring/alert_webhook_server.py',
            'scripts/ops/diagnostic-tool.sh',
            'scripts/ops/system-health-check.sh',
            'scripts/testing/test-system.sh',
            'scripts/testing/test-log-flow.sh'
        ]
        
        for file in common_files:
            if file not in all_files:
                # Check if file exists
                file_path = BASE_DIR / file
                if file_path.exists():
                    all_files.append(file)
        
        return jsonify({'files': sorted(set(all_files))})
    
    # First, check if it's a direct match in CONFIG_PATHS
    if config_type in CONFIG_PATHS:
        path = CONFIG_PATHS[config_type]
        if path.exists():
            if path.is_dir():
                # Return list of files in directory
                files = []
                for file_path in path.rglob('*'):
                    if file_path.is_file():
                        rel_path = file_path.relative_to(path)
                        files.append(str(rel_path))
                return jsonify({'files': files})
            else:
                try:
                    with open(path, 'r') as f:
                        content = f.read()
                    return jsonify({'content': content})
                except Exception as e:
                    return jsonify({'error': f'Cannot read file: {str(e)}'}), 500
    
    # Check for subpaths (e.g., fluent-bit/fluent-bit.conf)
    for base_type, base_path in CONFIG_PATHS.items():
        if config_type.startswith(base_type + '/'):
            # Remove the base_type and the following slash
            relative_path = config_type[len(base_type)+1:]
            file_path = base_path / relative_path
            if file_path.exists() and file_path.is_file():
                try:
                    with open(file_path, 'r') as f:
                        content = f.read()
                    return jsonify({'content': content})
                except Exception as e:
                    return jsonify({'error': f'Cannot read file: {str(e)}'}), 500
            else:
                # Try alternative path
                alt_path = BASE_DIR / config_type
                if alt_path.exists() and alt_path.is_file():
                    try:
                        with open(alt_path, 'r') as f:
                            content = f.read()
                        return jsonify({'content': content})
                    except Exception as e:
                        return jsonify({'error': f'Cannot read file: {str(e)}'}), 500
                return jsonify({'error': f'File not found: {file_path}'}), 404
    
    # Also check for files in the root config directory
    root_path = BASE_DIR / config_type
    if root_path.exists() and root_path.is_file():
        try:
            with open(root_path, 'r') as f:
                content = f.read()
            return jsonify({'content': content})
        except Exception as e:
            return jsonify({'error': f'Cannot read file: {str(e)}'}), 500
    
    # Try to find the file by searching through all directories
    # This is a fallback for any other paths
    for base_type, base_path in CONFIG_PATHS.items():
        if base_path.is_dir():
            # Search recursively
            for file_path in base_path.rglob('*'):
                if file_path.is_file():
                    # Create the full path as it would be in the UI
                    rel_path = file_path.relative_to(base_path)
                    full_path = f"{base_type}/{rel_path}"
                    if full_path == config_type:
                        try:
                            with open(file_path, 'r') as f:
                                content = f.read()
                            return jsonify({'content': content})
                        except Exception as e:
                            return jsonify({'error': f'Cannot read file: {str(e)}'}), 500
    
    return jsonify({'error': f'Config not found: {config_type}. Available paths: {list(CONFIG_PATHS.keys())}'}), 404

@app.route('/api/config/diff', methods=['POST'])
@login_required
@require_role('operator')
def config_diff():
    """Return unified diff of old vs new config."""
    data = request.json or {}
    old_content = data.get('old', '')
    new_content = data.get('new', '')
    old_lines = (old_content or '').splitlines(keepends=True)
    new_lines = (new_content or '').splitlines(keepends=True)
    diff = list(difflib.unified_diff(old_lines, new_lines, fromfile='eski', tofile='yeni', lineterm=''))
    return jsonify({'diff': ''.join(diff), 'hasChanges': old_content != new_content})


@app.route('/api/config/<path:config_type>', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def update_config(config_type):
    """Update configuration file"""
    if not is_safe_config_path(config_type):
        return jsonify({'error': 'Invalid config path'}), 400

    data = request.json
    if not data or 'content' not in data:
        return jsonify({'error': 'No content provided'}), 400
    
    content = data['content']
    
    # Validate
    is_valid, message = validate_config_change(config_type, content)
    if not is_valid:
        return jsonify({'error': message}), 400
    
    # Apply
    try:
        result = apply_config_change(config_type, content)
        audit_event('config.update', 'success', {'config_type': config_type})
        return jsonify({'message': result})
    except Exception as e:
        audit_event('config.update', 'failed', {'config_type': config_type, 'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/service/<service_name>/<action>', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def control_service(service_name, action):
    """Control a service (start, stop, restart)"""
    valid_actions = ['start', 'stop', 'restart']
    if action not in valid_actions:
        return jsonify({'error': 'Invalid action'}), 400
    
    try:
        platform = runtime_platform()
        if platform == 'k8s':
            message = k8s_control_service(service_name, action)
        elif platform == 'compose':
            message = compose_control_service(service_name, action)
        else:
            return jsonify({'error': 'No available runtime platform'}), 500
        audit_event('service.control', 'success', {'service': service_name, 'action': action, 'platform': platform})
        return jsonify({'message': message})
    except Exception as e:
        audit_event('service.control', 'failed', {'service': service_name, 'action': action, 'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/scale/<service_name>', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def scale_service(service_name):
    data = request.json or {}
    replicas = data.get('replicas')
    if replicas is None:
        return jsonify({'error': 'replicas is required'}), 400

    try:
        replicas = int(replicas)
        if replicas < 0:
            return jsonify({'error': 'replicas must be >= 0'}), 400
    except Exception:
        return jsonify({'error': 'replicas must be integer'}), 400

    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Scale API is available only in k8s mode'}), 400

    kind, _ = resolve_k8s_resource(service_name)
    if not kind:
        return jsonify({'error': f'service not found: {service_name}'}), 404

    scale_body = {'spec': {'replicas': replicas}}
    try:
        if kind == 'deployment':
            k8s_apps.patch_namespaced_deployment_scale(service_name, K8S_NAMESPACE, scale_body)
        else:
            k8s_apps.patch_namespaced_stateful_set_scale(service_name, K8S_NAMESPACE, scale_body)
        audit_event('service.scale', 'success', {'service': service_name, 'replicas': replicas})
        return jsonify({'message': f'{service_name} scaled to {replicas}'})
    except Exception as e:
        audit_event('service.scale', 'failed', {'service': service_name, 'replicas': replicas, 'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/health')
def health():
    """Health check endpoint"""
    try:
        # Check if Docker is accessible
        docker_client.ping()
        docker_status = 'healthy'
    except Exception as e:
        docker_status = f'unhealthy: {str(e)}'
    
    # Check if config paths exist (tam liste); genel sağlık yalnızca CONFIG_PATHS_HEALTH_REQUIRED
    config_status = {}
    for key, path in CONFIG_PATHS.items():
        config_status[key] = 'exists' if path.exists() else 'missing'
    config_healthy = all(
        CONFIG_PATHS[k].exists() for k in CONFIG_PATHS_HEALTH_REQUIRED if k in CONFIG_PATHS
    )

    services_status = get_service_status()
    metrics = stack_health_metrics_from_services(services_status) if isinstance(services_status, dict) else {'running': 0, 'total': 0, 'problematic': 0}
    running_count = metrics['running']

    ingest_pipeline = None
    try:
        ingest_pipeline = _ingest_pipeline_health_snapshot()
    except Exception as e:
        ingest_pipeline = {'overall': 'unknown', 'error': str(e)}

    return jsonify({
        'status': 'running',
        'docker': docker_status,
        'config_paths': config_status,
        'config_healthy': config_healthy,
        'services_count': running_count,
        'services_running': metrics['running'],
        'services_total': metrics['total'],
        'services_problematic': metrics['problematic'],
        'timestamp': datetime.now().isoformat(),
        'ingest_pipeline': ingest_pipeline,
        'panel': {
            'storageApiRevision': 5,
            'storageEnv': effective_storage_env_name(),
        },
    })

@app.route('/api/backup', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def backup():
    """Backup configuration files"""
    backup_dir = BASE_DIR / 'backups'
    backup_dir.mkdir(exist_ok=True)
    
    backup_name = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    backup_path = backup_dir / backup_name
    backup_path.mkdir(exist_ok=True)
    
    try:
        # Backup important files
        for config_type in ['docker-compose', 'env', 'fluent-bit', 'grafana_config']:
            source_path = CONFIG_PATHS.get(config_type)
            if source_path and source_path.exists():
                if source_path.is_dir():
                    shutil.copytree(source_path, backup_path / config_type, dirs_exist_ok=True)
                else:
                    shutil.copy2(source_path, backup_path / f"{config_type}")

        audit_event('backup.create', 'success', {'backup_name': backup_name, 'backup_path': str(backup_path)})
        
        return jsonify({
            'message': f'Backup created successfully: {backup_name}',
            'backup_path': str(backup_path)
        })
    except Exception as e:
        audit_event('backup.create', 'failed', {'error': str(e)})
        return jsonify({'error': f'Backup failed: {str(e)}'}), 500


@app.route('/api/ops/summary', methods=['GET'])
@login_required
def ops_summary():
    return jsonify(ops_summary_snapshot())


@app.route('/api/storage/candidates', methods=['GET'])
@login_required
@require_role('operator')
def storage_candidates():
    try:
        data = discover_storage_candidates()
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/mount-status', methods=['GET'])
@login_required
@require_role('operator')
def storage_mount_status():
    """Kök FS ile /opt/log-system/data aynı mı — panel banner ve apply-profile öncesi."""
    try:
        return jsonify(storage_mount_status_snapshot())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/recommended-setup-plan', methods=['GET'])
@login_required
@require_role('operator')
def storage_recommended_setup_plan():
    """Önerilen veri diski + wipe/taşıma önerisi + mount özeti (tek akış planı)."""
    rescan = request.args.get('rescan', '').strip().lower() in ('1', 'true', 'yes', 'on')
    try:
        return jsonify(recommended_veri_disk_setup_plan(rescan=rescan))
    except Exception as e:
        return jsonify({'ok': False, 'code': 'PLAN_ERROR', 'message': str(e)}), 500


@app.route('/api/storage/complete-recommended-setup', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_complete_recommended_setup():
    """
    Önerilen ham diski /opt/log-system/data altına bağlar, .env storage profile uygular, ayrı FS doğrular.
    """
    payload = request.json or {}
    confirm_device = (payload.get('confirmDevice') or '').strip()
    env_name = effective_storage_env_name()
    wipe_existing = bool(payload.get('wipeExisting'))
    rescan_first = payload.get('rescanFirst')
    if rescan_first is None:
        rescan_first = True
    else:
        rescan_first = bool(rescan_first)
    relocate = payload.get('relocateMountDirContents')
    if relocate is None:
        relocate = None
    else:
        relocate = bool(relocate)

    try:
        result = complete_recommended_veri_disk_setup(
            confirm_device,
            env_name,
            wipe_existing=wipe_existing,
            relocate_mount_dir=relocate,
            rescan_first=rescan_first,
        )
        audit_event('storage.complete_recommended_setup', 'success', {
            'device': result.get('setupPlan', {}).get('suggestedDevice'),
            'env_name': env_name,
            'wipeExisting': wipe_existing,
        })
        return jsonify({
            'message': 'Önerilen veri diski bağlandı; .env yolları güncellendi ve mount doğrulandı.',
            'result': result,
        })
    except Exception as e:
        audit_event('storage.complete_recommended_setup', 'failed', {
            'error': str(e),
            'env_name': env_name,
        })
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/data-disk-grow-status', methods=['GET'])
@login_required
@require_role('operator')
def storage_data_disk_grow_status():
    """vCenter VMDK büyütmesi sonrası bölüm/FS genişletme ihtiyacı (ext4, düz /dev/*)."""
    try:
        rescan = request.args.get('rescan', '').strip().lower() in ('1', 'true', 'yes', 'on')
        if rescan:
            try:
                _host_rescan_block_buses()
            except Exception:
                pass
        snap = data_disk_grow_status_snapshot()
        if isinstance(snap, dict):
            snap = {**snap, 'hostBusRescanBeforeProbe': bool(rescan)}
        return jsonify(snap)
    except Exception as e:
        return jsonify({'error': str(e), 'eligible': False, 'canGrow': False}), 500


@app.route('/api/storage/data-disk-grow', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_data_disk_grow():
    """Bölüm + ext4 genişletme; önce isteğe bağlı SCSI/NVMe tarama."""
    payload = request.json or {}
    rescan_first = payload.get('rescanFirst')
    if rescan_first is None:
        rescan_first = True
    else:
        rescan_first = bool(rescan_first)
    try:
        result = execute_data_disk_grow(rescan_first=rescan_first)
        audit_event('storage.data_disk_grow', 'success', {})
        return jsonify({'message': 'Veri diski genişletildi.', 'result': result})
    except Exception as e:
        audit_event('storage.data_disk_grow', 'failed', {'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/os-disk-grow-status', methods=['GET'])
@login_required
@require_role('operator')
def storage_os_disk_grow_status():
    """Hypervisor’da OS / kök disk VMDK büyütmesi sonrası (/) bölüm + ext4 durumu."""
    try:
        rescan = request.args.get('rescan', '').strip().lower() in ('1', 'true', 'yes', 'on')
        if rescan:
            try:
                _host_rescan_block_buses()
            except Exception:
                pass
        snap = os_root_disk_grow_status_snapshot()
        if isinstance(snap, dict):
            snap = {**snap, 'hostBusRescanBeforeProbe': bool(rescan)}
        return jsonify(snap)
    except Exception as e:
        return jsonify({'error': str(e), 'eligible': False, 'canGrow': False}), 500


@app.route('/api/storage/os-disk-grow', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_os_disk_grow():
    """Kök (/) bölüm + ext4 genişletme; yedek önerilir."""
    payload = request.json or {}
    rescan_first = payload.get('rescanFirst')
    if rescan_first is None:
        rescan_first = True
    else:
        rescan_first = bool(rescan_first)
    try:
        result = execute_os_root_disk_grow(rescan_first=rescan_first)
        audit_event('storage.os_disk_grow', 'success', {})
        return jsonify({'message': 'Kök (OS) dosya sistemi genişletildi.', 'result': result})
    except Exception as e:
        audit_event('storage.os_disk_grow', 'failed', {'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/services/storage', methods=['GET'])
@login_required
@require_role('operator')
def api_services_storage():
    """Konteyner başına du özeti + stack için df ile paylaşılan bölüm listesi."""
    try:
        return jsonify(get_service_bind_storage_snapshot())
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e), 'byContainer': {}, 'sharedFilesystems': []}), 500


def _archive_status_snapshot():
    """Build archive status: raw files, signed, WORM, retry queue."""
    raw_dir = DATA_DIR / 'arsiv_loglari'
    signed_dir = DATA_DIR / 'arsiv_imzali'
    worm_dir = DATA_DIR / 'worm_storage'
    retry_list = DATA_DIR / 'worm_retry_queue' / 'retry.list'

    entries = []
    if raw_dir.exists():
        for f in sorted(raw_dir.glob('data-*.log'), reverse=True)[:14]:
            date_str = f.stem.replace('data-', '') if f.stem.startswith('data-') else f.name
            size = f.stat().st_size
            signed_path = signed_dir / date_str / f'data-{date_str}.signed.txt'
            worm_path = worm_dir / date_str / f'data-{date_str}.log.gz'
            signed_exists = signed_path.exists()
            worm_exists = worm_path.exists()
            hash_val = ''
            sig_val = ''
            if signed_exists:
                try:
                    text = signed_path.read_text(errors='replace')
                    for line in text.splitlines():
                        if line.startswith('SHA256 Özeti:'):
                            hash_val = line.split(':', 1)[-1].strip()
                        elif line.startswith('Zaman Damgası:'):
                            sig_val = line.split(':', 1)[-1].strip()
                except Exception:
                    pass
            entries.append({
                'date': date_str,
                'rawSize': size,
                'rawPath': str(f),
                'signed': signed_exists,
                'worm': worm_exists,
                'hash': hash_val or None,
                'signature': sig_val or None,
            })

    retry_count = 0
    if retry_list.exists():
        try:
            retry_count = len([l for l in retry_list.read_text().splitlines() if l.strip()])
        except Exception:
            pass

    return {
        'entries': entries,
        'retryQueueCount': retry_count,
        'paths': {
            'raw': str(raw_dir),
            'signed': str(signed_dir),
            'worm': str(worm_dir),
        }
    }


@app.route('/api/archive/status', methods=['GET'])
@login_required
def archive_status():
    try:
        return jsonify(_archive_status_snapshot())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


LOOKUPS_DIR = BASE_DIR / 'src' / 'services' / 'graylog' / 'lookups'
PROFILE_RESOLVER_CSV = LOOKUPS_DIR / 'profile_resolver.csv'
PROFILE_SRC_CSV = LOOKUPS_DIR / 'profile_source_field.csv'
PROFILE_DST_CSV = LOOKUPS_DIR / 'profile_destination_field.csv'


def _graylog_api_get(path: str, **kwargs):
    url = f"http://graylog:9000/api{path}"
    auth = ('admin', os.environ.get('GRAYLOG_ROOT_PASSWORD', 'admin'))
    headers = kwargs.pop('headers', {})
    headers['X-Requested-By'] = 'log-management-ui'
    timeout = kwargs.pop('timeout', 10)
    return requests.get(url, auth=auth, headers=headers, timeout=timeout, **kwargs)


def _graylog_api_post(path: str, json=None, **kwargs):
    url = f"http://graylog:9000/api{path}"
    auth = ('admin', os.environ.get('GRAYLOG_ROOT_PASSWORD', 'admin'))
    headers = kwargs.pop('headers', {})
    headers['X-Requested-By'] = 'log-management-ui'
    timeout = kwargs.pop('timeout', 10)
    return requests.post(url, auth=auth, headers=headers, json=json, timeout=timeout, **kwargs)


def _ingest_pipeline_health_snapshot() -> dict:
    """Edge ingest: Fluent Bit (UDP giriş) + Graylog API — panelden güvenilir hat özeti."""
    fb_status = None
    fb_health = None
    fb_http_ok = False
    fb_detail = None
    try:
        if docker_available and docker_client is not None:
            c = docker_client.containers.get('fluent-bit')
            fb_status = c.status
            st = c.attrs.get('State') or {}
            fb_health = (st.get('Health') or {}).get('Status')
    except Exception as e:
        fb_detail = f'docker:{e}'
    try:
        r = requests.get('http://fluent-bit:2020/', timeout=4)
        fb_http_ok = bool(r.status_code < 400)
        fb_detail = (fb_detail + '; ' if fb_detail else '') + f'http_{r.status_code}'
    except Exception as e:
        fb_detail = (fb_detail + '; ' if fb_detail else '') + f'http_err:{e}'
    gl_ok = False
    gl_detail = None
    try:
        gr = _graylog_api_get('/system', timeout=6)
        gl_ok = gr.status_code == 200
        gl_detail = f'http_{gr.status_code}'
    except Exception as e:
        gl_detail = str(e)
    docker_running = fb_status == 'running'
    if docker_running and fb_http_ok and gl_ok:
        overall = 'ok'
    elif docker_running or fb_http_ok or gl_ok:
        overall = 'degraded'
    else:
        overall = 'down'
    return {
        'overall': overall,
        'fluentBit': {
            'containerRunning': docker_running,
            'containerStatus': fb_status,
            'containerHealth': fb_health,
            'httpOk': fb_http_ok,
            'detail': fb_detail,
        },
        'graylog': {
            'apiOk': gl_ok,
            'detail': gl_detail,
        },
        'ingestUdpPort': 5151,
        'checkedAt': datetime.utcnow().isoformat() + 'Z',
    }


# --- Performance / Auto-tune (docker-compose.yml single-node entrypoint ile uyumlu) ---


def _compose_aligned_heap_plan(total_ram_mb: int):
    """graylog / opensearch1 servislerinin bash giriş noktasındaki formül ile aynı."""
    if total_ram_mb < 512:
        raise ValueError('RAM en az 512 MB olmalı')
    reserved = total_ram_mb * 20 // 100
    available = total_ram_mb - reserved
    graylog_heap_mb = max(512, available * 25 // 100)
    opensearch_heap_mb = max(512, available * 50 // 100)
    return {
        'totalRamMb': total_ram_mb,
        'reservedRamMb': reserved,
        'availableRamMb': available,
        'graylogJavaHeapMb': graylog_heap_mb,
        'opensearchJavaHeapMb': opensearch_heap_mb,
    }


def _probe_host_total_ram_mb_docker():
    """Host MemTotal (MB), --pid=host alpine ile. Başarısızsa None."""
    if not docker_available or docker_client is None:
        return None
    cmd = "awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo"
    try:
        client = docker.from_env()

        def _run_meminfo_probe():
            return client.containers.run(
                'alpine:3.19',
                command=['sh', '-c', cmd],
                remove=True,
                pid_mode='host',
                network_mode='none',
                stdout=True,
                stderr=True,
            )

        try:
            raw = _run_meminfo_probe()
        except docker_errors.ImageNotFound:
            client.images.pull('alpine:3.19')
            raw = _run_meminfo_probe()
        text = raw.decode('utf-8').strip() if isinstance(raw, bytes) else str(raw).strip()
        if text.isdigit():
            return int(text)
    except Exception:
        return None
    return None


@app.route('/api/performance/recommendations', methods=['GET'])
@login_required
@require_role('operator')
def performance_recommendations():
    """docker-compose.yml (varsayılan single-node) ile aynı heap mantığı."""
    ram_mb = request.args.get('ram_mb', type=int)
    if ram_mb is None or ram_mb < 512:
        return jsonify({'error': 'ram_mb (MB) query param required, min 512'}), 400
    try:
        plan = _compose_aligned_heap_plan(ram_mb)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    g = plan['graylogJavaHeapMb']
    o = plan['opensearchJavaHeapMb']
    return jsonify({
        'totalRamMb': plan['totalRamMb'],
        'reservedRamMb': plan['reservedRamMb'],
        'availableRamMb': plan['availableRamMb'],
        'recommended': {
            'GRAYLOG_JAVA_HEAP_MB': g,
            'OPENSEARCH_JAVA_HEAP_MB': o,
            'GRAYLOG_HEAP': f'{g}m',
            'OPENSEARCH_HEAP': f'{o}m',
        },
        'formula': (
            'docker-compose (single-node): toplam RAM’in %20’si rezerv; kalan üzerinden '
            'Graylog Java heap %25, OpenSearch Java heap %50 (her ikisi min 512 MB).'
        ),
        'applyHint': (
            '«Auto-Tune Uygula» .env anahtarlarını yazar ve (Docker socket erişimi varsa) '
            'hostta docker compose ile önce opensearch1, sonra graylog yeniden kaldırılır '
            '(stop + rm + up; stale container ID hatalarını azaltır). '
            'Farklı compose dosyası: LOG_SYSTEM_HEAP_COMPOSE_FILE. '
            'docker-compose.prod.yml gibi profiller sabit JAVA_OPTS kullanabilir — '
            'bu akış varsayılan docker-compose.yml bash heap mantığı ile uyumludur.'
        ),
    })


@app.route('/api/performance/detect-ram', methods=['GET'])
@login_required
@require_role('operator')
def performance_detect_ram():
    """Host RAM: Docker API ile kısa ömürlü alpine konteyner (--pid=host /proc/meminfo)."""
    try:
        n = _probe_host_total_ram_mb_docker()
        if n is not None:
            return jsonify({'ramMb': n, 'source': 'host'})
    except docker.errors.DockerException as e:
        return jsonify({'ramMb': None, 'error': f'Docker API: {e}'})
    except Exception as e:
        return jsonify({'ramMb': None, 'error': f'Host RAM tespit edilemedi: {e}'})
    return jsonify({'ramMb': None, 'error': 'Host RAM tespit edilemedi (çıktı sayı değil). Manuel girin.'})


def _apply_heap_env_keys(graylog_heap_mb: int, opensearch_heap_mb: int):
    """Panel konteynerından .env güncelle (doğrudan veya runtime helper)."""
    keys = (
        ('GRAYLOG_JAVA_HEAP_MB', str(graylog_heap_mb)),
        ('OPENSEARCH_JAVA_HEAP_MB', str(opensearch_heap_mb)),
    )
    for key, value in keys:
        try:
            update_env_key(ENV_PATH, key, value)
        except OSError:
            update_env_key_via_runtime(ENV_PATH, key, value)


@app.route('/api/performance/apply', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def performance_apply():
    """bash/auto-tune.sh yok: Alpine imajında çalışır. .env heap baypas anahtarlarını yazar."""
    payload = request.json or {}
    raw_ram = payload.get('ramMb', payload.get('ram_mb'))
    ram_mb = None
    if raw_ram is not None and str(raw_ram).strip() != '':
        try:
            ram_mb = int(raw_ram)
        except (TypeError, ValueError):
            return jsonify({'error': 'ramMb geçerli bir tam sayı olmalı'}), 400
    if ram_mb is None:
        ram_mb = _probe_host_total_ram_mb_docker()
    if ram_mb is None or ram_mb < 512:
        return jsonify({
            'error': 'RAM (MB) belirsiz. Kutuya değer girin veya önce «RAM Tespit Et» çalıştırın.',
        }), 400
    try:
        plan = _compose_aligned_heap_plan(ram_mb)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    try:
        _apply_heap_env_keys(plan['graylogJavaHeapMb'], plan['opensearchJavaHeapMb'])
    except Exception as e:
        audit_event('performance.heap_apply', 'failed', {'error': str(e), 'ram_mb': ram_mb})
        return jsonify({'error': f'.env yazılamadı: {e}'}), 500

    compose_result = _run_compose_recreate_graylog_opensearch()
    service_status = {}
    if compose_result.get('ok') and not compose_result.get('skipped'):
        time.sleep(5)
        service_status = _heap_stack_service_status()

    msg_parts = [
        f".env güncellendi: GRAYLOG_JAVA_HEAP_MB={plan['graylogJavaHeapMb']}, "
        f"OPENSEARCH_JAVA_HEAP_MB={plan['opensearchJavaHeapMb']}.",
    ]
    if compose_result.get('skipped'):
        r = compose_result.get('reason') or ''
        if r:
            msg_parts.append(f'Servis yenileme atlandı: {r}')
        msg_parts.append(
            'İsterseniz elle: docker compose up -d --force-recreate --no-deps opensearch1; '
            'healthy olduktan sonra: docker compose up -d --force-recreate --no-deps graylog'
        )
    elif compose_result.get('ok'):
        msg_parts.append('graylog ve opensearch1 yeniden oluşturuldu (docker compose).')
    else:
        err = (compose_result.get('error') or '')[:900]
        msg_parts.append(f'UYARI: .env yazıldı; docker compose başarısız: {err}')
        msg_parts.append(
            'Elle: docker compose up -d --force-recreate --no-deps opensearch1; '
            'bir süre sonra: docker compose up -d --force-recreate --no-deps graylog'
        )

    audit_event('performance.heap_apply', 'success', {
        'ram_mb': ram_mb,
        'graylog_java_heap_mb': plan['graylogJavaHeapMb'],
        'opensearch_java_heap_mb': plan['opensearchJavaHeapMb'],
        'compose_recreate': compose_result,
        'service_status': service_status,
    })
    return jsonify({
        'message': ' '.join(msg_parts),
        'applied': plan,
        'composeRecreate': compose_result,
        'serviceStatus': service_status,
    })


@app.route('/api/observability/metrics', methods=['GET'])
@login_required
def observability_metrics():
    """Aggregate ingest rate, disk pressure, QC count for dashboard cards."""
    fb = collect_fluent_bit_metrics()
    disk_pct = _get_disk_usage()
    qc_count = _get_qc_stream_count()
    disk_profile = _collect_disk_storage_profile()
    return jsonify({
        'ingestRecords': fb.get('inputRecords'),
        'outputProcessed': fb.get('outputProcessed'),
        'outputErrors': fb.get('outputErrors'),
        'diskUsagePercent': disk_pct,
        'qcStreamCount1h': qc_count,
        'fluentBitAvailable': fb.get('available', False),
        'diskProfile': disk_profile,
    })


@app.route('/api/normalization/qc-samples', methods=['GET'])
@login_required
@require_role('operator')
def normalization_qc_samples():
    """Fetch sample messages from quality_control stream for onboarding."""
    try:
        streams_resp = _graylog_api_get('/streams')
        streams_resp.raise_for_status()
        streams = streams_resp.json().get('streams', [])
        qc_stream = next((s for s in streams if s.get('title') == 'quality_control'), None)
        if not qc_stream:
            return jsonify({'samples': [], 'message': 'quality_control stream not found'})

        stream_id = qc_stream.get('id')
        from_ts = datetime.utcnow() - timedelta(hours=24)
        to_ts = datetime.utcnow()
        search_payload = {
            'query': '*',
            'streams': [stream_id],
            'timerange': {
                'type': 'absolute',
                'from': from_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                'to': to_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            },
            'size': 20,
            'fields': ['vendor', 'product', 'os_major', 'message', 'timestamp'],
        }
        search_resp = _graylog_api_post('/search/messages', json=search_payload, timeout=20)
        if search_resp.status_code != 200:
            return jsonify({'samples': [], 'error': search_resp.text[:200]}), 500

        data = search_resp.json()
        schema = data.get('schema') or []
        field_names = []
        for col in schema:
            if col.get('column_type') == 'field' and col.get('field'):
                field_names.append(col['field'])
        datarows = data.get('datarows') or []
        seen = set()
        samples = []
        for row in datarows:
            if not isinstance(row, list):
                continue
            msg = {}
            for i, name in enumerate(field_names):
                if i < len(row):
                    msg[name] = row[i]
            vendor = _graylog_message_scalar(msg, 'vendor') or 'unknown'
            product = _graylog_message_scalar(msg, 'product') or 'unknown'
            os_major = _graylog_message_scalar(msg, 'os_major') or 'unknown'
            if not vendor or vendor == '':
                vendor = 'unknown'
            key = (str(vendor).lower(), str(product).lower(), str(os_major).lower())
            if key not in seen:
                seen.add(key)
                samples.append({
                    'vendor': str(vendor),
                    'product': str(product),
                    'os_major': str(os_major),
                    'lookupKey': f"{str(vendor).lower()}|{str(product).lower()}|{str(os_major)}",
                })
        return jsonify({'samples': samples, 'streamId': stream_id})
    except Exception as e:
        return jsonify({'samples': [], 'error': str(e)}), 500


@app.route('/api/normalization/lookup-rows', methods=['GET'])
@login_required
def normalization_lookup_rows():
    """Return current profile_resolver.csv rows."""
    rows = []
    if PROFILE_RESOLVER_CSV.exists():
        try:
            text = PROFILE_RESOLVER_CSV.read_text(errors='replace')
            for line in text.strip().splitlines()[1:]:
                if ',' in line:
                    key, val = line.split(',', 1)
                    key = key.strip()
                    val = val.strip()
                    if key and key != 'key':
                        parts = key.split('|')
                        rows.append({
                            'key': key,
                            'profile': val,
                            'vendor': parts[0] if len(parts) > 0 else '',
                            'product': parts[1] if len(parts) > 1 else '',
                            'os_major': parts[2] if len(parts) > 2 else '',
                        })
        except Exception as e:
            return jsonify({'rows': [], 'error': str(e)}), 500
    return jsonify({'rows': rows})


@app.route('/api/normalization/dry-run', methods=['POST'])
@login_required
@require_role('operator')
def normalization_dry_run():
    """Preview how a sample message would look after normalization."""
    payload = request.json or {}
    vendor = (payload.get('vendor') or '').strip().lower()
    product = (payload.get('product') or '').strip().lower()
    os_major = (payload.get('os_major') or 'unknown').strip()
    profile = (payload.get('profile') or '').strip() or f"{vendor}_{product}_v{os_major}"
    src_field = (payload.get('srcField') or 'src').strip()
    dst_field = (payload.get('dstField') or 'dst').strip()
    sample = payload.get('sampleMessage') or {}

    if not vendor or not product:
        return jsonify({'error': 'vendor and product required'}), 400

    preview = dict(sample)
    preview['profile'] = profile
    preview['normalization_status'] = 'success'
    preview['vendor'] = vendor
    preview['product'] = product
    preview['os_major'] = os_major
    if isinstance(profile, str):
        src_val = sample.get(src_field) or sample.get('src') or sample.get('source') or 'unknown'
        dst_val = sample.get(dst_field) or sample.get('dst') or sample.get('destination') or 'unknown'
        preview['source'] = src_val
        preview['destination'] = dst_val
    return jsonify({'preview': preview, 'profile': profile})


@app.route('/api/normalization/add-mapping', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def normalization_add_mapping():
    """Add a mapping to profile_resolver.csv. Returns manual instructions if write fails."""
    payload = request.json or {}
    vendor = (payload.get('vendor') or '').strip().lower()
    product = (payload.get('product') or '').strip().lower()
    os_major = (payload.get('os_major') or 'unknown').strip()
    profile = (payload.get('profile') or '').strip() or f"{vendor}_{product}_v{os_major}"
    src_field = (payload.get('srcField') or 'src').strip()
    dst_field = (payload.get('dstField') or 'dst').strip()

    if not vendor or not product:
        return jsonify({'error': 'vendor and product required'}), 400

    lookup_key = f"{vendor}|{product}|{os_major}"
    new_line = f"{lookup_key},{profile}\n"

    written = False
    try:
        PROFILE_RESOLVER_CSV.parent.mkdir(parents=True, exist_ok=True)
        if not PROFILE_RESOLVER_CSV.exists():
            PROFILE_RESOLVER_CSV.write_text("key,value\n")
        with open(PROFILE_RESOLVER_CSV, 'a') as f:
            f.write(new_line)
        written = True
    except OSError as e:
        pass

    if written:
        for csv_path, default_val, row in [
            (PROFILE_SRC_CSV, 'src', f"{profile},{src_field}\n"),
            (PROFILE_DST_CSV, 'dst', f"{profile},{dst_field}\n"),
        ]:
            try:
                if csv_path.exists():
                    content = csv_path.read_text()
                    if profile not in content:
                        with open(csv_path, 'a') as f:
                            f.write(row)
                else:
                    csv_path.parent.mkdir(parents=True, exist_ok=True)
                    csv_path.write_text(f"key,value\n{row}")
            except OSError:
                pass

        audit_event('normalization.add_mapping', 'success', {
            'lookupKey': lookup_key,
            'profile': profile,
        })
        return jsonify({
            'message': 'Mapping added. Lookup will refresh within 60 seconds.',
            'written': True,
            'lookupKey': lookup_key,
            'profile': profile,
        })

    manual_line = new_line.strip()
    return jsonify({
        'message': 'Panel cannot write to lookup files. Add manually:',
        'written': False,
        'manualStepRequired': True,
        'file': str(PROFILE_RESOLVER_CSV),
        'lineToAdd': manual_line,
        'instruction': f"Append to {PROFILE_RESOLVER_CSV}: {manual_line}",
    })


@app.route('/api/release/status', methods=['GET'])
@login_required
def release_status():
    """Return current release tag and promotion info."""
    env_map = parse_env_file(ENV_PATH)
    tag = env_map.get('LOG_SYSTEM_RELEASE_TAG', 'dev')
    env_name = os.environ.get('LOG_SYSTEM_ENV', 'dev')
    return jsonify({
        'currentTag': tag,
        'environment': env_name,
        'promoteCommand': 'make promote-staging TAG=vX.Y.Z  # or make promote-prod TAG=vX.Y.Z',
        'rollbackNote': 'Promotion script auto-rollbacks on deploy failure.',
    })


OPENSEARCH_ISM_POLICY_ID = 'graylog-90gun'
OPENSEARCH_ISM_TEMPLATE_NAME = 'graylog-best-compression'


def probe_opensearch_ism_status():
    """OpenSearch erişimi ve ISM policy + index template varlığı (panel için)."""
    base = _opensearch_internal_base_url()
    user, pw = _opensearch_admin_credentials()
    out = {
        'reachable': False,
        'policyPresent': False,
        'templatePresent': False,
        'policyId': OPENSEARCH_ISM_POLICY_ID,
        'templateName': OPENSEARCH_ISM_TEMPLATE_NAME,
        'error': None,
    }
    if not pw:
        out['error'] = 'OPENSEARCH_INITIAL_ADMIN_PASSWORD tanımlı değil (.env / compose env_file).'
        return out
    auth = (user, pw)
    try:
        r = requests.get(f'{base}/_cluster/health', auth=auth, verify=False, timeout=12)
        out['reachable'] = r.status_code == 200
        if not out['reachable']:
            out['error'] = f'OpenSearch HTTP {r.status_code}: {(r.text or "")[:240]}'
            return out
    except requests.RequestException as e:
        out['error'] = f'OpenSearch bağlantı hatası: {e}'
        return out
    try:
        rp = requests.get(
            f'{base}/_plugins/_ism/policies/{OPENSEARCH_ISM_POLICY_ID}',
            auth=auth,
            verify=False,
            timeout=15,
        )
        if rp.status_code == 200:
            try:
                body = rp.json()
                out['policyPresent'] = bool(body.get('policy') or body.get('policy_id'))
            except Exception:
                out['policyPresent'] = True
    except requests.RequestException:
        pass
    try:
        rt = requests.get(
            f'{base}/_index_template/{OPENSEARCH_ISM_TEMPLATE_NAME}',
            auth=auth,
            verify=False,
            timeout=15,
        )
        out['templatePresent'] = rt.status_code == 200
    except requests.RequestException:
        pass
    return out


def apply_opensearch_ism_from_panel():
    """ISM policy + best_compression index template (apply-opensearch-ism.sh ile aynı iş)."""
    base = _opensearch_internal_base_url()
    user, pw = _opensearch_admin_credentials()
    if not pw:
        raise RuntimeError('OPENSEARCH_INITIAL_ADMIN_PASSWORD tanımlı değil.')
    policy_path = BASE_DIR / 'src/config/opensearch/ism-policy-90gun.json'
    template_path = BASE_DIR / 'src/config/opensearch/index-template-graylog-best-compression.json'
    auth = (user, pw)
    result = {'policyOk': False, 'templateOk': False, 'policyDetail': '', 'templateDetail': ''}

    if policy_path.is_file():
        policy_json = json.loads(policy_path.read_text(encoding='utf-8'))
        pr = requests.put(
            f'{base}/_plugins/_ism/policies/{OPENSEARCH_ISM_POLICY_ID}',
            auth=auth,
            verify=False,
            timeout=60,
            headers={'Content-Type': 'application/json'},
            json=policy_json,
        )
        txt = (pr.text or '')[:800]
        result['policyDetail'] = txt
        result['policyOk'] = pr.status_code in (200, 201) and (
            'policy_id' in txt or ('"policy"' in txt and 'error' not in txt[:400].lower())
        )
        try:
            pj = pr.json()
            if isinstance(pj, dict) and pj.get('error'):
                result['policyOk'] = False
                result['policyDetail'] = json.dumps(pj)[:800]
        except Exception:
            pass
    else:
        result['policyDetail'] = f'Dosya yok: {policy_path}'

    if template_path.is_file():
        template_json = json.loads(template_path.read_text(encoding='utf-8'))
        tr = requests.put(
            f'{base}/_index_template/{OPENSEARCH_ISM_TEMPLATE_NAME}',
            auth=auth,
            verify=False,
            timeout=60,
            headers={'Content-Type': 'application/json'},
            json=template_json,
        )
        txt = (tr.text or '')[:800]
        result['templateDetail'] = txt
        result['templateOk'] = tr.status_code in (200, 201) and 'acknowledged' in txt
        try:
            tj = tr.json()
            if isinstance(tj, dict) and tj.get('error'):
                result['templateOk'] = False
                result['templateDetail'] = json.dumps(tj)[:800]
        except Exception:
            pass
    else:
        result['templateDetail'] = f'Dosya yok: {template_path}'

    if not result['policyOk'] or not result['templateOk']:
        raise RuntimeError(
            'ISM veya index template uygulanamadı. '
            f"policyOk={result['policyOk']} templateOk={result['templateOk']}. "
            f"policy: {result['policyDetail'][:400]} …"
        )
    return result


@app.route('/api/archive/retention', methods=['GET'])
@login_required
def archive_retention_info():
    """Return retention/lifecycle settings from env and ISM policy info.
    90 gün modeli: OpenSearch 90 gün (Grafana arama), WORM 2 yıl (5651 arşiv).
    """
    env_map = parse_env_file(ENV_PATH)
    hot_days = int(env_map.get('LOG_HOT_RETENTION_DAYS', '90') or 90)
    total_days = int(env_map.get('LOG_TOTAL_RETENTION_DAYS', '730') or 730)
    ism_live = probe_opensearch_ism_status()
    ism_live['fullyApplied'] = bool(
        ism_live.get('reachable') and ism_live.get('policyPresent') and ism_live.get('templatePresent')
    )
    return jsonify({
        'rawRetentionDays': hot_days,
        'totalRetentionDays': total_days,
        'ismPolicy': 'graylog-90gun',
        'ismStages': [
            {'name': 'hot', 'minAge': '0d', 'desc': 'Aktif yazma (7 gün)'},
            {'name': 'warm', 'minAge': '7d', 'desc': 'Force merge, read-only (83 gün)'},
            {'name': 'delete', 'minAge': '90d', 'desc': 'Silindi (WORM 2 yıl ayrı)'},
        ],
        'archiveDestination': env_map.get('ARCHIVE_DESTINATION', 'local'),
        'opensearchIsm': ism_live,
    })


@app.route('/api/storage/apply-profile', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_apply_profile():
    payload = request.json or {}
    selected_path = (payload.get('path') or '').strip()
    env_name = effective_storage_env_name()
    acknowledge = bool(payload.get('acknowledgeRootFilesystem'))

    if not selected_path:
        return jsonify({'error': 'path is required'}), 400

    try:
        result = apply_storage_profile(
            selected_path, env_name=env_name, acknowledge_same_as_root=acknowledge
        )
        audit_event('storage.apply_profile', 'success', {
            'path': selected_path,
            'env_name': env_name,
            'device': result.get('device'),
            'acknowledgeRootFilesystem': acknowledge,
        })
        return jsonify({'message': 'Storage profile applied to .env', 'result': result})
    except StorageProfileSameRootFilesystem as e:
        audit_event('storage.apply_profile', 'needs_ack', {
            'path': selected_path,
            'env_name': env_name,
        })
        try:
            mount_snap = storage_mount_status_snapshot()
        except Exception:
            mount_snap = None
        return jsonify({
            'error': str(e),
            'code': 'STORAGE_SAME_AS_ROOT',
            'requiresAck': True,
            'detail': e.detail,
            'mountStatus': mount_snap,
        }), 409
    except Exception as e:
        audit_event('storage.apply_profile', 'failed', {'path': selected_path, 'env_name': env_name, 'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/eligible-disks', methods=['GET'])
@login_required
@require_role('operator')
def storage_eligible_disks():
    try:
        return jsonify(list_eligible_raw_data_disks())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/rescan-host-buses', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_rescan_host_buses():
    """vCenter hot-add VMDK: konukta SCSI host scan (+ NVMe rescan)."""
    try:
        _host_rescan_block_buses()
        audit_event('storage.rescan_buses', 'success', {})
        return jsonify({
            'message': 'Veriyolu + blok rescan tamam. Büyütülen mevcut VMDK boyutu görünmüyorsa VM yeniden başlatın. Ham disk listesi için «Diskleri Yenile».',
        })
    except Exception as e:
        audit_event('storage.rescan_buses', 'failed', {'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/storage/prepare-disk', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def storage_prepare_disk():
    payload = request.json or {}
    device = (payload.get('device') or '').strip()
    confirm_device = (payload.get('confirmDevice') or '').strip()
    mount_point = (payload.get('mountPoint') or '/opt/log-system/data').strip().rstrip('/')
    env_name = effective_storage_env_name()
    wipe_existing = bool(payload.get('wipeExisting'))
    relocate_mount_dir = bool(payload.get('relocateMountDirContents'))

    try:
        result = prepare_data_disk_and_apply_profile(
            device, confirm_device, mount_point, env_name, wipe_existing, relocate_mount_dir
        )
        audit_event('storage.prepare_disk', 'success', {
            'device': device,
            'mountPoint': mount_point,
            'env_name': env_name,
            'wipeExisting': wipe_existing,
            'relocateMountDirContents': relocate_mount_dir,
        })
        return jsonify({'message': 'Disk hazırlandı ve storage profile uygulandı', 'result': result})
    except Exception as e:
        audit_event('storage.prepare_disk', 'failed', {
            'device': device,
            'mountPoint': mount_point,
            'relocateMountDirContents': relocate_mount_dir,
            'error': str(e),
        })
        return jsonify({'error': str(e)}), 500


@app.route('/api/agent/profiles', methods=['GET'])
@login_required
@require_role('operator')
def agent_profiles():
    return jsonify({'profiles': _agent_profile_catalog()})


@app.route('/api/agent/default-ingest', methods=['GET'])
@login_required
def agent_default_ingest():
    """Panelden agent eklerken otomatik doldurulacak ingest host/port."""
    host = _normalize_host(request.host.split(':')[0] if request.host else '') or _normalize_host(
        os.environ.get('LOG_PLATFORM_PUBLIC_HOST', '')
    ) or '127.0.0.1'
    return jsonify({
        'ingestHost': host,
        'ingestPort': 5151,
        'installBaseUrl': _public_app_base_url(),
    })


@app.route('/api/agent/enrollment-tokens', methods=['GET'])
@login_required
@require_role('admin')
def agent_enrollment_tokens():
    tokens = _load_tokens()
    sanitized = []
    for item in tokens:
        row = dict(item)
        row.pop('tokenHash', None)
        row['expired'] = _is_token_expired(item)
        row['effectiveStatus'] = _effective_enrollment_status(item)
        sanitized.append(row)
    sanitized.sort(key=lambda x: x.get('createdAt', ''), reverse=True)
    return jsonify({'tokens': sanitized})


@app.route('/api/agent/enrollment-token', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def agent_enrollment_token_create():
    payload = request.json or {}
    profile_id = (payload.get('profileId') or 'linux-agent-v1').strip()

    try:
        raw_token, record = _new_enrollment_token(profile_id, payload)
    except Exception as e:
        return jsonify({'error': str(e)}), 400

    tokens = _load_tokens()
    tokens.append(record)
    _save_tokens(tokens)

    base = _public_app_base_url()
    install_url_sh = f"{base}/api/agent/install/{raw_token}.sh"
    install_url_ps1 = f"{base}/api/agent/install/{raw_token}.ps1"
    if profile_id == 'windows-agent-v1':
        primary_url = install_url_ps1
    else:
        primary_url = install_url_sh
    audit_event('agent.enrollment_token.create', 'success', {
        'profileId': profile_id,
        'expiresAt': record.get('expiresAt'),
        'metadata': record.get('metadata', {})
    })

    response_record = dict(record)
    response_record.pop('tokenHash', None)
    uninstall_url_ps1 = (
        f"{base}/api/agent/uninstall/{raw_token}.ps1" if profile_id == 'windows-agent-v1' else None
    )
    return jsonify({
        'message': 'Enrollment token created',
        'token': raw_token,
        'installUrl': primary_url,
        'installUrlSh': install_url_sh if profile_id != 'windows-agent-v1' else None,
        'installUrlPs1': install_url_ps1 if profile_id == 'windows-agent-v1' else None,
        'uninstallUrlPs1': uninstall_url_ps1,
        'installKind': 'powershell' if profile_id == 'windows-agent-v1' else 'bash',
        'record': response_record
    })


@app.route('/api/agent/enrollment-token/revoke', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def agent_enrollment_token_revoke():
    payload = request.json or {}
    token_id = str(payload.get('tokenId') or '').strip()
    if not token_id:
        return jsonify({'error': 'tokenId is required'}), 400

    tokens = _load_tokens()
    found = False
    for item in tokens:
        if str(item.get('id')) == token_id:
            item['status'] = 'revoked'
            item['revokedAt'] = _utc_now_iso()
            item['revokedBy'] = session.get('username', 'unknown')
            found = True
            break

    if not found:
        return jsonify({'error': 'token not found'}), 404

    _save_tokens(tokens)
    audit_event('agent.enrollment_token.revoke', 'success', {'tokenId': token_id})
    return jsonify({'message': 'Token revoked'})


@app.route('/api/agent/install/<raw_token>.sh', methods=['GET'])
def agent_install_script(raw_token):
    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404

    if record.get('status') in ('revoked',):
        return jsonify({'error': 'token revoked'}), 403
    if _is_token_expired(record):
        record['status'] = 'expired'
        _save_tokens(tokens)
        return jsonify({'error': 'token expired'}), 403

    if record.get('profileId') == 'windows-agent-v1':
        return jsonify({
            'error': 'This enrollment token is for Windows. Use the .ps1 install URL from the panel.'
        }), 400

    record['scriptDownloads'] = int(record.get('scriptDownloads') or 0) + 1
    record['lastSeenAt'] = _utc_now_iso()
    record['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
    tokens[idx] = record
    _save_tokens(tokens)

    script = _render_installer_script(record, raw_token)
    return app.response_class(script, mimetype='text/x-shellscript')


@app.route('/api/agent/install/<raw_token>.ps1', methods=['GET'])
def agent_install_script_ps1(raw_token):
    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404

    if record.get('status') in ('revoked',):
        return jsonify({'error': 'token revoked'}), 403
    if _is_token_expired(record):
        record['status'] = 'expired'
        _save_tokens(tokens)
        return jsonify({'error': 'token expired'}), 403

    if record.get('profileId') != 'windows-agent-v1':
        return jsonify({
            'error': 'PowerShell installer is only available for windows-agent-v1 tokens.'
        }), 400

    record['scriptDownloads'] = int(record.get('scriptDownloads') or 0) + 1
    record['lastSeenAt'] = _utc_now_iso()
    record['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
    tokens[idx] = record
    _save_tokens(tokens)

    ps1 = _render_installer_ps1(record, raw_token)
    if not ps1:
        return jsonify({'error': 'installer unavailable'}), 500
    return app.response_class(
        ps1,
        mimetype='text/plain; charset=utf-8',
        headers={'Content-Disposition': 'attachment; filename="logplatform-agent-install.ps1"'}
    )


@app.route('/api/agent/uninstall/<raw_token>.ps1', methods=['GET'])
def agent_uninstall_script_ps1(raw_token):
    """Windows kaldırma betiği — token kayıtlı olmalı (süresi dolmuş veya iptal edilmiş olabilir)."""
    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404
    if record.get('profileId') != 'windows-agent-v1':
        return jsonify({
            'error': 'PowerShell uninstall is only available for windows-agent-v1 tokens.'
        }), 400

    record['uninstallScriptDownloads'] = int(record.get('uninstallScriptDownloads') or 0) + 1
    record['lastUninstallScriptAt'] = _utc_now_iso()
    record['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
    tokens[idx] = record
    _save_tokens(tokens)

    ps1 = _render_windows_uninstall_ps1(raw_token)
    return app.response_class(
        ps1,
        mimetype='text/plain; charset=utf-8',
        headers={'Content-Disposition': 'attachment; filename="logplatform-agent-uninstall.ps1"'},
    )


@app.route('/api/agent/activate', methods=['POST'])
def agent_activate():
    payload = request.json or {}
    raw_token = str(payload.get('token') or '').strip()
    hostname = str(payload.get('hostname') or '').strip() or 'unknown-host'

    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404

    if record.get('status') == 'revoked':
        return jsonify({'error': 'token revoked'}), 403
    if _is_token_expired(record):
        record['status'] = 'expired'
        _save_tokens(tokens)
        return jsonify({'error': 'token expired'}), 403

    max_activations = int(record.get('maxActivations') or 1)
    activation_count = int(record.get('activationCount') or 0)
    if activation_count >= max_activations:
        return jsonify({'error': 'token activation limit reached'}), 403

    record['activationCount'] = activation_count + 1
    record['status'] = 'active'
    record['activatedAt'] = _utc_now_iso()
    record['lastSeenAt'] = record['activatedAt']
    record['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
    record['activatedNode'] = {
        'hostname': hostname,
        'ip': record['lastSeenIp'],
        'profileId': record.get('profileId')
    }
    tokens[idx] = record
    _save_tokens(tokens)

    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    nodes = [n for n in nodes if str(n.get('tokenId')) != str(record.get('id'))]
    nodes.append({
        'tokenId': record.get('id'),
        'hostname': hostname,
        'profileId': record.get('profileId'),
        'activatedAt': record.get('activatedAt'),
        'lastSeenAt': record.get('lastSeenAt'),
        'lastSeenIp': record.get('lastSeenIp'),
        'metadata': record.get('metadata', {})
    })
    _safe_write_json(AGENT_NODES_PATH, {'nodes': nodes})

    return jsonify({'message': 'agent activated'})


@app.route('/api/agent/uninstall-notify', methods=['POST'])
def agent_uninstall_notify():
    """Windows kaldırma betiği merkezi bilgilendirir; audit + envanterde uç `uninstalled` işaretlenir."""
    payload = request.json or {}
    raw_token = str(payload.get('token') or '').strip()
    hostname = str(payload.get('hostname') or '').strip() or 'unknown-host'
    reason = str(payload.get('reason') or 'user_uninstall').strip()[:500] or 'user_uninstall'

    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404

    token_id = str(record.get('id') or '')
    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    matched = False
    for node in nodes:
        if str(node.get('tokenId')) == token_id:
            node['agentLifecycle'] = 'uninstalled'
            node['uninstalledAt'] = _utc_now_iso()
            node['uninstallReason'] = reason
            node['lastSeenAt'] = _utc_now_iso()
            node['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
            matched = True
            break
    if matched:
        _safe_write_json(AGENT_NODES_PATH, {'nodes': nodes})

    audit_event('agent.windows_uninstall', 'success', {
        'hostname': hostname,
        'tokenId': token_id,
        'profileId': record.get('profileId'),
        'inventoryUpdated': matched,
        'reason': reason,
    })
    return jsonify({'message': 'uninstall acknowledged', 'inventoryUpdated': matched})


@app.route('/api/agent/heartbeat', methods=['POST'])
def agent_heartbeat():
    payload = request.json or {}
    raw_token = str(payload.get('token') or '').strip()
    hostname = str(payload.get('hostname') or '').strip() or 'unknown-host'
    status = str(payload.get('status') or 'ok').strip() or 'ok'

    if not raw_token:
        return jsonify({'error': 'token is required'}), 400

    tokens, idx, record = _find_token_record(raw_token)
    if idx < 0 or not record:
        return jsonify({'error': 'invalid token'}), 404

    if record.get('status') in ('revoked', 'expired'):
        return jsonify({'error': f"token {record.get('status')}"}), 403

    record['lastSeenAt'] = _utc_now_iso()
    record['lastSeenIp'] = request.headers.get('X-Forwarded-For', request.remote_addr)
    record['lastHeartbeatStatus'] = status
    tokens[idx] = record
    _save_tokens(tokens)

    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    updated = False
    for node in nodes:
        if str(node.get('tokenId')) == str(record.get('id')):
            node['hostname'] = hostname
            node['lastSeenAt'] = record['lastSeenAt']
            node['lastSeenIp'] = record['lastSeenIp']
            node['status'] = status
            updated = True
            break
    if not updated:
        nodes.append({
            'tokenId': record.get('id'),
            'hostname': hostname,
            'profileId': record.get('profileId'),
            'lastSeenAt': record['lastSeenAt'],
            'lastSeenIp': record['lastSeenIp'],
            'status': status,
            'metadata': record.get('metadata', {})
        })
    _safe_write_json(AGENT_NODES_PATH, {'nodes': nodes})

    return jsonify({'message': 'heartbeat accepted'})


@app.route('/api/agent/nodes', methods=['GET'])
@login_required
@require_role('operator')
def agent_nodes():
    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    nodes = sorted(nodes, key=lambda x: x.get('lastSeenAt', ''), reverse=True)
    return jsonify({'nodes': nodes})


@app.route('/api/agent/onboarding-history', methods=['GET'])
@login_required
@require_role('operator')
def agent_onboarding_history():
    tokens = _load_tokens()
    items = []
    for item in tokens:
        eff = _effective_enrollment_status(item)
        row = {
            'id': item.get('id'),
            'profileId': item.get('profileId'),
            'status': item.get('status', 'unknown'),
            'effectiveStatus': eff,
            'createdAt': item.get('createdAt'),
            'expiresAt': item.get('expiresAt'),
            'activatedAt': item.get('activatedAt'),
            'createdBy': item.get('createdBy', 'unknown'),
            'activationCount': int(item.get('activationCount') or 0),
            'scriptDownloads': int(item.get('scriptDownloads') or 0),
            'expired': _is_token_expired(item),
            'lastSeenAt': item.get('lastSeenAt'),
            'lastHeartbeatStatus': item.get('lastHeartbeatStatus', '-'),
            'nodeHost': (item.get('activatedNode') or {}).get('hostname', '-'),
            'metadata': item.get('metadata', {})
        }
        items.append(row)
    items.sort(key=lambda x: x.get('createdAt', ''), reverse=True)
    return jsonify({'items': items[:200]})


def _graylog_lucene_escape_term(term: str) -> str:
    return str(term).replace('\\', '\\\\').replace('"', '\\"')


def _graylog_message_scalar(msg: dict, key: str) -> str:
    if not isinstance(msg, dict):
        return ''
    v = msg.get(key)
    if v is None:
        return ''
    if isinstance(v, list) and v:
        first = v[0]
        if isinstance(first, dict) and first.get('value') is not None:
            return str(first.get('value'))
        return str(first)
    if isinstance(v, dict) and v.get('value') is not None:
        return str(v.get('value'))
    return str(v)


def _graylog_parse_search_totals(body) -> int:
    if not isinstance(body, dict):
        return 0
    total = body.get('total_results')
    if total is None:
        total = (body.get('meta') or {}).get('total_results')
    try:
        return int(total or 0)
    except (TypeError, ValueError):
        return 0


def _graylog_search_universal_absolute_get(
    query_string: str,
    from_iso: str,
    to_iso: str,
    limit: int,
    fields: str = 'timestamp,message,host,source,ComputerName',
):
    """
    Graylog 6.1+: /search/universal/absolute yalnızca GET kabul eder; Accept: application/json ile total_results gelir.
    """
    lim = 1 if int(limit) <= 0 else max(1, min(int(limit), 100))
    return _graylog_api_get(
        '/search/universal/absolute',
        params={
            'query': query_string,
            'from': from_iso,
            'to': to_iso,
            'limit': str(lim),
            'fields': fields,
            'decorate': 'false',
        },
        headers={'Accept': 'application/json'},
        timeout=20,
    )


def _graylog_host_volume(hostname: str, hours: int, limit: int, seen_ip: str | None = None):
    """
    Graylog'ta host/source/ComputerName (+ isteğe bağlı source:IP) ile mesaj sayısı ve örnekler.
    limit=0 yalnızca total_results için (örnek için limit=1 istenir).
    """
    hn = str(hostname or '').strip()
    if not hn or len(hn) > 200:
        return {'totalCount': None, 'samples': [], 'error': 'bad_hostname'}
    esc = _graylog_lucene_escape_term(hn)
    esc_l = _graylog_lucene_escape_term(hn.lower())
    parts = [
        f'host:"{esc}"',
        f'source:"{esc}"',
        f'ComputerName:"{esc}"',
        f'host:"{esc_l}"',
        f'source:"{esc_l}"',
        f'ComputerName:"{esc_l}"',
    ]
    sip = str(seen_ip or '').strip()
    if sip and len(sip) <= 64:
        parts.append(f'source:"{_graylog_lucene_escape_term(sip)}"')
    query_string = '(' + ' OR '.join(parts) + ')'
    try:
        from_ts = datetime.utcnow() - timedelta(hours=max(1, int(hours)))
        to_ts = datetime.utcnow()
        from_iso = from_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        to_iso = to_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        r = _graylog_search_universal_absolute_get(query_string, from_iso, to_iso, limit)
        if r.status_code != 200:
            return {
                'totalCount': None,
                'samples': [],
                'error': f'graylog_http_{r.status_code}',
            }
        data = r.json() if r.content else {}
        total = _graylog_parse_search_totals(data)
        samples = []
        seen_ids = set()
        for m in data.get('messages') or []:
            if not isinstance(m, dict):
                continue
            raw = m.get('message')
            if not isinstance(raw, dict):
                continue
            dedupe_key = (raw.get('_id'), m.get('index'))
            if dedupe_key in seen_ids:
                continue
            seen_ids.add(dedupe_key)
            ts = raw.get('timestamp') or m.get('timestamp') or ''
            text = _graylog_message_scalar(raw, 'message') or _graylog_message_scalar(raw, 'full_message')
            if len(text) > 480:
                text = text[:477] + '...'
            src = _graylog_message_scalar(raw, 'source') or _graylog_message_scalar(raw, 'host')
            samples.append({'timestamp': ts, 'message': text, 'source': src})
            if len(samples) >= max(0, min(int(limit), 50)):
                break
        return {'totalCount': total, 'samples': samples, 'error': None}
    except Exception as exc:
        return {'totalCount': None, 'samples': [], 'error': str(exc)}


@app.route('/api/agent/fleet-overview', methods=['GET'])
@login_required
@require_role('operator')
def agent_fleet_overview():
    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    nodes = sorted(nodes, key=lambda x: x.get('lastSeenAt', ''), reverse=True)
    out = []
    for node in nodes[:120]:
        hn = str(node.get('hostname') or '').strip()
        lip = str(node.get('lastSeenIp') or '').strip() or None
        g24 = (
            _graylog_host_volume(hn, hours=24, limit=0, seen_ip=lip)
            if hn
            else {'totalCount': None, 'error': 'no_hostname'}
        )
        g7 = (
            _graylog_host_volume(hn, hours=24 * 7, limit=0, seen_ip=lip)
            if hn
            else {'totalCount': None, 'error': 'no_hostname'}
        )
        row = {
            **node,
            'logCount24h': g24.get('totalCount'),
            'logCount7d': g7.get('totalCount'),
            'graylogError24h': g24.get('error'),
            'graylogError7d': g7.get('error'),
        }
        out.append(row)
    return jsonify({'nodes': out})


@app.route('/api/agent/fleet-host-detail', methods=['GET'])
@login_required
@require_role('operator')
def agent_fleet_host_detail():
    q = (request.args.get('hostname') or '').strip()
    if not q:
        return jsonify({'error': 'hostname required'}), 400
    nodes_payload = _safe_read_json(AGENT_NODES_PATH, {'nodes': []})
    nodes = nodes_payload.get('nodes', []) if isinstance(nodes_payload, dict) else []
    node = None
    for n in nodes:
        if str(n.get('hostname') or '').strip() == q:
            node = n
            break
    if not node:
        q_lower = q.lower()
        for n in nodes:
            if str(n.get('hostname') or '').strip().lower() == q_lower:
                node = n
                break
    lip = str((node or {}).get('lastSeenIp') or '').strip() or None
    g = _graylog_host_volume(q, hours=24 * 7, limit=10, seen_ip=lip)
    return jsonify({
        'node': node,
        'graylog': {
            'total7d': g.get('totalCount'),
            'samples': g.get('samples') or [],
            'error': g.get('error'),
        },
    })


def _public_ingest_host_for_agent():
    host = _normalize_host(request.host.split(':')[0] if request.host else '') or _normalize_host(
        os.environ.get('LOG_PLATFORM_PUBLIC_HOST', '')
    ) or '127.0.0.1'
    return host


def _graylog_search_phrase_last_minutes(phrase: str, minutes: int = 15):
    """Return (found_count, error_message). phrase is matched as exact phrase in search."""
    if not phrase or len(phrase) < 6:
        return None, 'probe_too_short'
    try:
        from_ts = datetime.utcnow() - timedelta(minutes=max(1, minutes))
        to_ts = datetime.utcnow()
        safe = phrase.replace('\\', '\\\\').replace('"', '\\"')
        q = f'"{safe}"'
        r = _graylog_search_universal_absolute_get(
            q,
            from_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            to_ts.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            1,
            fields='timestamp,message',
        )
        if r.status_code != 200:
            return None, f'graylog_http_{r.status_code}'
        body = r.json() if r.content else {}
        total = body.get('total_results')
        if total is None:
            total = (body.get('meta') or {}).get('total_results')
        if total is None:
            results = body.get('messages') or body.get('results') or []
            total = len(results) if isinstance(results, list) else 0
        return int(total or 0), None
    except Exception as exc:
        return None, str(exc)


@app.route('/api/agent/self-test/instructions', methods=['GET'])
@login_required
@require_role('operator')
def agent_self_test_instructions():
    """Kullanıcı dostu ingest doğrulaması: benzersiz metin içeren UDP JSON komutları üretir."""
    probe = (request.args.get('probe') or '').strip()
    if not probe or len(probe) < 8:
        probe = 'LP-INGEST-' + uuid.uuid4().hex[:12]
    ingest_host = (request.args.get('ingestHost') or '').strip() or _public_ingest_host_for_agent()
    ingest_port = request.args.get('ingestPort', type=int)
    if ingest_port is None or ingest_port < 1 or ingest_port > 65535:
        ingest_port = 5151

    payload_obj = {
        'message': f'{probe} panel bağlantı self-test',
        'host': 'self-test-client',
        'time': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        'log_type': 'ingest_self_test',
        'ingest_self_test': True,
    }
    payload_json = json.dumps(payload_obj, ensure_ascii=False)
    linux_cmd = f'printf %s {shlex.quote(payload_json)} | nc -u -w 2 {shlex.quote(str(ingest_host))} {int(ingest_port)}'

    powershell_lines = [
        f'$MERKEZ = "{ingest_host}"',
        f'$P = {int(ingest_port)}',
        f'$probe = "{probe}"',
        '$log = @{ message = ($probe + " panel bağlantı self-test"); host = $env:COMPUTERNAME; time = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fff") } | ConvertTo-Json -Compress',
        '$b = [System.Text.Encoding]::UTF8.GetBytes($log)',
        '$u = New-Object System.Net.Sockets.UdpClient',
        '$u.Send($b, $b.Length, $MERKEZ, $P) | Out-Null',
        '$u.Close()',
    ]
    powershell_script = '\n'.join(powershell_lines)

    return jsonify({
        'probe': probe,
        'ingestHost': ingest_host,
        'ingestPort': ingest_port,
        'payloadJson': payload_json,
        'linuxCommand': linux_cmd,
        'powershellScript': powershell_script,
        'hint': 'Bu komutu log gönderecek makinede çalıştırın. Ardından «Kontrol et» ile Graylog taraması yapılır (son 15 dk).',
    })


@app.route('/api/agent/self-test/status', methods=['GET'])
@login_required
@require_role('operator')
def agent_self_test_status():
    probe = (request.args.get('probe') or '').strip()
    if not probe or len(probe) < 8:
        return jsonify({'error': 'probe parametresi gerekli (min 8 karakter)'}), 400
    total, err = _graylog_search_phrase_last_minutes(probe, minutes=15)
    if err and total is None:
        return jsonify({
            'found': False,
            'graylogSearched': False,
            'error': err,
            'checklist': [
                'Graylog ayakta mı? (Panel sağlık)',
                'UDP 5151 firewall / yönlendirme',
                'Komutu gönderen makineden merkez IP erişilebilir mi?',
            ]
        })
    found = bool(total and total > 0)
    return jsonify({
        'found': found,
        'totalResults': int(total or 0),
        'graylogSearched': True,
        'probe': probe,
    })


@app.route('/api/ops/sanity', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def ops_sanity():
    result = run_compose_sanity_check()
    audit_event('ops.sanity', 'success' if result.get('status') != 'failed' else 'failed', {'summary': result.get('summary')})
    return jsonify(result)


@app.route('/api/ops/flow-test', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def ops_flow_test():
    result = run_flow_smoke_test()
    audit_event('ops.flow_test', 'success' if result.get('status') != 'failed' else 'failed', {
        'summary': result.get('summary'),
        'testId': result.get('testId')
    })
    return jsonify(result)


@app.route('/api/ops/stream-repair', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def ops_stream_repair():
    result = run_stream_search_repair()
    audit_event('ops.stream_repair', 'success' if result.get('status') != 'failed' else 'failed', {
        'summary': result.get('summary')
    })
    return jsonify(result)


@app.route('/api/ops/apply-opensearch-ism', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def ops_apply_opensearch_ism():
    """ISM policy (90 gün) + graylog-best-compression index template — kurulum atlarsa panelden tamamlama."""
    try:
        result = apply_opensearch_ism_from_panel()
        audit_event('ops.apply_opensearch_ism', 'success', {'policyOk': True, 'templateOk': True})
        return jsonify({
            'message': 'OpenSearch ISM policy ve index template uygulandı.',
            'result': result,
        })
    except Exception as e:
        audit_event('ops.apply_opensearch_ism', 'failed', {'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/dependencies/<path:config_type>')
@login_required
def get_dependencies(config_type):
    """Get dependencies for a configuration type"""
    dependencies = {
        'docker-compose': ['All services'],
        'env': ['setup', 'graylog', 'fluent-bit', 'grafana'],
        'fluent-bit/fluent-bit.conf': ['fluent-bit'],
        'grafana_config/datasources.yaml': ['grafana'],
        'grafana_config/dashboards.yaml': ['grafana'],
        'grafana_config/dashboards/master_dashboard.json': ['grafana'],
        'grafana_config/alerting/contact-points.yaml': ['grafana'],
        'grafana_config/alerting/notification-policies.yaml': ['grafana'],
        'grafana_config/alerting/rules.yaml': ['grafana'],
        'scripts/compliance/sign_logs.sh': ['log-signer-cron', 'signing-engine'],
        'scripts/monitoring/telegram_watchdog.sh': ['watchdog'],
        'scripts/monitoring/alert_webhook_server.py': ['alert-webhook', 'watchdog'],
        'scripts/ops/diagnostic-tool.sh': ['log-management-ui'],
        'scripts/ops/system-health-check.sh': ['log-management-ui'],
        'scripts/testing/test-system.sh': ['graylog', 'opensearch', 'fluent-bit'],
        'scripts/testing/test-log-flow.sh': ['graylog', 'fluent-bit']
    }
    
    deps = dependencies.get(config_type, [])
    return jsonify({'dependencies': deps})

@app.route('/api/validate', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def validate():
    """Validate configuration without applying"""
    data = request.json
    if not data or 'type' not in data or 'content' not in data:
        return jsonify({'error': 'Missing type or content'}), 400
    
    is_valid, message = validate_config_change(data['type'], data['content'])
    return jsonify({'valid': is_valid, 'message': message})


@app.route('/api/settings/catalog', methods=['GET'])
@login_required
def get_settings_catalog():
    settings = settings_catalog()
    role = current_user_role()
    filtered = [s for s in settings if has_role(s.get('requiredRole', 'viewer')) or role == 'admin']
    settings_writable, auto_apply_available, write_message = settings_storage_status()

    masked = []
    for setting in filtered:
        item = dict(setting)
        if item.get('type') == 'password' and item.get('value'):
            item['masked'] = True
            item['value'] = '********'
        item['readOnly'] = not settings_writable and not auto_apply_available
        masked.append(item)

    return jsonify({
        'settings': masked,
        'settingsWritable': settings_writable,
        'settingsAutoApplyAvailable': auto_apply_available,
        'settingsWriteMessage': write_message
    })


@app.route('/api/settings/update', methods=['POST'])
@login_required
@csrf_protect
def update_setting():
    payload = request.json or {}
    key = payload.get('key')
    value = payload.get('value')

    if not key:
        return jsonify({'error': 'key is required'}), 400

    if key == 'LOG_SYNTHETIC_GENERATOR' and _is_prod_log_system_env():
        return jsonify({'error': 'Üretim ortamında sentetik log-gen ayarı kullanılamaz.'}), 400

    setting = next((s for s in settings_catalog() if s.get('key') == key), None)
    if not setting:
        return jsonify({'error': 'unknown setting key'}), 404

    required_role = setting.get('requiredRole', 'admin')
    if not has_role(required_role):
        return jsonify({'error': f'{required_role} role required'}), 403

    if setting.get('type') == 'password' and value == '********':
        audit_event('settings.update', 'success', {'key': key, 'group': setting.get('group'), 'no_change': True})
        return jsonify({'message': 'No change applied (masked value unchanged)'})

    normalized_value, validation_error = _normalize_and_validate_setting(setting, value)
    if validation_error:
        return jsonify({'error': validation_error}), 400
    if normalized_value is None and setting.get('type') == 'password':
        audit_event('settings.update', 'success', {'key': key, 'group': setting.get('group'), 'no_change': True})
        return jsonify({'message': 'No change applied (masked value unchanged)'})
    value = normalized_value

    write_pairs = _settings_env_write_pairs(key, value)

    existing_env = parse_env_file(ENV_PATH)
    old_raw_value = existing_env.get(key, '')
    old_audit_value = _sanitize_audit_value(setting, old_raw_value)
    new_audit_value = _sanitize_audit_value(setting, value)

    candidate_env = dict(existing_env)
    for wk, wv in write_pairs:
        candidate_env[wk] = wv
    dependency_error = _validate_settings_dependencies(candidate_env)
    if dependency_error:
        return jsonify({'error': dependency_error}), 400

    if all(str(existing_env.get(wk, '')) == str(wv) for wk, wv in write_pairs):
        audit_event('settings.update', 'success', {
            'key': key,
            'group': setting.get('group'),
            'no_change': True,
            'old_value': old_audit_value,
            'new_value': new_audit_value
        })
        return jsonify({'message': 'Değişiklik yok; mevcut değer korunuyor'})

    extra_keys = [wk for wk, _ in write_pairs if wk != key]

    def _apply_writes_to_env_file():
        for wk, wv in write_pairs:
            update_env_key(ENV_PATH, wk, wv)

    def _apply_writes_via_runtime():
        writer_container = None
        for wk, wv in write_pairs:
            writer_container = update_env_key_via_runtime(ENV_PATH, wk, wv)
        return writer_container

    try:
        _apply_writes_to_env_file()
    except OSError as e:
        if e.errno in (errno.EROFS, errno.EPERM, errno.EACCES):
            try:
                writer_container = _apply_writes_via_runtime()
                audit_event('settings.update', 'success', {
                    'key': key,
                    'group': setting.get('group'),
                    'auto_applied': True,
                    'writer_container': writer_container,
                    'old_value': old_audit_value,
                    'new_value': new_audit_value,
                    'extra_keys_written': extra_keys,
                })

                side_note = None
                if key == 'SIGNER_TYPE':
                    try:
                        ensure_simulated_log_producer(False)
                        side_note = 'simulated-log-producer durduruldu (SIMULATED modu kaldırıldı).'
                    except Exception as side_error:
                        side_note = f'Üretici durdurma uyarısı: {str(side_error)}'

                if key == 'LOG_SYNTHETIC_GENERATOR':
                    try:
                        en = _is_truthy(value)
                        r = ensure_log_gen(en)
                        if not r.get('ok'):
                            lg = f'log-gen uygulanamadı: {r.get("error")}'
                        elif r.get('skipped'):
                            lg = str(r.get('note') or '')
                        else:
                            lg = 'Sentetik log-gen çalışıyor (flog).' if en else 'log-gen durduruldu; yalnızca gerçek kaynak logları.'
                        side_note = (side_note + ' ' if side_note else '') + lg
                    except Exception as ex:
                        lg = f'log-gen uyarısı: {ex}'
                        side_note = (side_note + ' ' if side_note else '') + lg

                msg_tail = (f' {side_note}' if side_note else '').strip()

                if key in ('SESSION_TIMEOUT_MINUTES',):
                    return jsonify({
                        'message': 'Ayar kaydedildi (otomatik uygulama). Panel servisini yeniden başlatın.' + (f' {side_note}' if side_note else ''),
                        'autoApplied': True,
                        'writerContainer': writer_container
                    })

                base_msg = 'Ayar kaydedildi (salt-okunur ortamda otomatik uygulama kullanıldı).'
                graylog_rollout_info = None
                if key == 'GRAYLOG_ROOT_PASSWORD':
                    ro = os.environ.get('LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT', '1').strip().lower()
                    rollout_on = ro not in ('0', 'false', 'no', 'off')
                    if rollout_on:
                        graylog_rollout_info = _start_graylog_password_rollout_detached()
                    else:
                        graylog_rollout_info = {'ok': True, 'skipped': True, 'reason': 'LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT kapalı'}
                    if rollout_on and graylog_rollout_info.get('ok') and not graylog_rollout_info.get('skipped'):
                        base_msg = (
                            'Graylog admin parolası ve SHA2 .env üzerinde kaydedildi. '
                            'Graylog, ardından watchdog ve panel ayrı bir rollout konteynerinde yenileniyor (~1–2 dk); '
                            'işlem bitince sayfayı yenileyin.'
                        )
                    elif rollout_on and not graylog_rollout_info.get('ok'):
                        base_msg = (
                            'Parola .env\'e yazıldı; otomatik rollout başlatılamadı: '
                            f'{graylog_rollout_info.get("error") or "bilinmeyen hata"}. '
                            'Manuel: docker compose up -d --force-recreate --no-deps graylog; sonra watchdog ve log-management-ui.'
                        )
                    else:
                        base_msg = (
                            'Graylog admin parolası ve SHA2 .env üzerinde kaydedildi. '
                            'Otomatik yenileme kapalı (LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT=0): '
                            'yeni parola için sunucuda graylog ve panel/watchdog için compose recreate gerekir.'
                        )
                ro_body = {
                    'message': f'{base_msg}{msg_tail}',
                    'autoApplied': True,
                    'writerContainer': writer_container,
                    'extraKeysWritten': extra_keys,
                }
                if key == 'GRAYLOG_ROOT_PASSWORD':
                    gr = graylog_rollout_info or {}
                    ro_body['graylogPasswordRollout'] = {
                        'scheduled': bool(gr.get('ok') and not gr.get('skipped')),
                        'rolloutContainerId': gr.get('rolloutContainerId'),
                        'error': gr.get('error'),
                        'skipped': gr.get('skipped'),
                        'reason': gr.get('reason'),
                        'mode': gr.get('mode'),
                    }
                return jsonify(ro_body)
            except Exception as fallback_error:
                message = f'Ayar kaydedilemedi: salt-okunur ortam için otomatik uygulama başarısız ({str(fallback_error)})'
                audit_event('settings.update', 'failed', {'key': key, 'error': message})
                return jsonify({'error': message}), 409
        audit_event('settings.update', 'failed', {'key': key, 'error': str(e)})
        return jsonify({'error': str(e)}), 500

    side_note = None
    if key == 'SIGNER_TYPE':
        try:
            ensure_simulated_log_producer(False)
            side_note = 'simulated-log-producer durduruldu (SIMULATED modu kaldırıldı).'
        except Exception as side_error:
            side_note = f'Üretici durdurma uyarısı: {str(side_error)}'

    if key == 'LOG_SYNTHETIC_GENERATOR':
        try:
            en = _is_truthy(value)
            r = ensure_log_gen(en)
            if not r.get('ok'):
                lg = f'log-gen uygulanamadı: {r.get("error")}'
            elif r.get('skipped'):
                lg = str(r.get('note') or '')
            else:
                lg = 'Sentetik log-gen çalışıyor (flog).' if en else 'log-gen durduruldu; yalnızca gerçek kaynak logları.'
            side_note = (side_note + ' ' if side_note else '') + lg
        except Exception as ex:
            lg = f'log-gen uyarısı: {ex}'
            side_note = (side_note + ' ' if side_note else '') + lg

    audit_event('settings.update', 'success', {
        'key': key,
        'group': setting.get('group'),
        'side_note': side_note,
        'old_value': old_audit_value,
        'new_value': new_audit_value,
        'extra_keys_written': extra_keys,
    })

    if key in ('SESSION_TIMEOUT_MINUTES',):
        return jsonify({'message': 'Ayar kaydedildi. Panel servisini yeniden başlatın.' + (f' {side_note}' if side_note else '')})

    if key == 'GRAYLOG_ROOT_PASSWORD':
        ro = os.environ.get('LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT', '1').strip().lower()
        rollout_on = ro not in ('0', 'false', 'no', 'off')
        if rollout_on:
            graylog_rollout_info = _start_graylog_password_rollout_detached()
        else:
            graylog_rollout_info = {'ok': True, 'skipped': True, 'reason': 'LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT kapalı'}
        if rollout_on and graylog_rollout_info.get('ok') and not graylog_rollout_info.get('skipped'):
            pw_msg = (
                'Graylog admin parolası ve SHA2 .env üzerinde kaydedildi. '
                'Graylog, ardından watchdog ve panel ayrı bir rollout konteynerinde yenileniyor (~1–2 dk); '
                'işlem bitince sayfayı yenileyin.'
            )
        elif rollout_on and not graylog_rollout_info.get('ok'):
            pw_msg = (
                'Parola .env\'e yazıldı; otomatik rollout başlatılamadı: '
                f'{graylog_rollout_info.get("error") or "bilinmeyen hata"}. '
                'Manuel: docker compose up -d --force-recreate --no-deps graylog; sonra watchdog ve log-management-ui.'
            )
        else:
            pw_msg = (
                'Graylog admin parolası ve SHA2 .env üzerinde kaydedildi. '
                'Otomatik yenileme kapalı (LOG_SYSTEM_GRAYLOG_PW_AUTO_ROLLOUT=0): '
                'yeni parola için sunucuda graylog ve panel/watchdog için compose recreate gerekir.'
            )
        gr = graylog_rollout_info
        return jsonify({
            'message': (pw_msg + (f' {side_note}' if side_note else '')).strip(),
            'extraKeysWritten': extra_keys,
            'graylogPasswordRollout': {
                'scheduled': bool(gr.get('ok') and not gr.get('skipped')),
                'rolloutContainerId': gr.get('rolloutContainerId'),
                'error': gr.get('error'),
                'skipped': gr.get('skipped'),
                'reason': gr.get('reason'),
                'mode': gr.get('mode'),
            },
        })

    return jsonify({'message': 'Ayar kaydedildi' + (f'. {side_note}' if side_note else '')})


@app.route('/api/settings/post-check', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def settings_post_check():
    payload = request.json or {}
    key = (payload.get('key') or '').strip() or None

    try:
        result = run_settings_post_check(changed_key=key)
        audit_event('settings.post_check', 'success' if result.get('status') != 'failed' else 'failed', {
            'key': key,
            'status': result.get('status'),
        })
        return jsonify(result)
    except Exception as e:
        audit_event('settings.post_check', 'failed', {'key': key, 'error': str(e)})
        return jsonify({'error': f'post-check failed: {str(e)}'}), 500


def _build_pipeline_status_payload():
    """Fluent Bit / Graylog ingest metrikleri ve latency probe özeti (panel Genel Bakış)."""
    env_map = parse_env_file(ENV_PATH)
    signer_type = str(env_map.get('SIGNER_TYPE', 'OPEN_SOURCE')).strip().upper()
    if signer_type == 'SIMULATED':
        signer_type = 'OPEN_SOURCE'
    probe_profile = get_metrics_probe_profile(env_map)
    target_udp_port = 5152 if probe_profile == 'METRICS_ONLY' else 5153
    producer = safe_container_status('simulated-log-producer')
    log_gen = safe_container_status('log-gen')
    fluent = safe_container_status('fluent-bit')
    graylog = safe_container_status('graylog')
    metrics = collect_fluent_bit_metrics()
    latency = get_cached_pipeline_probe_latency(probe_profile=probe_profile)
    thresholds = pipeline_bottleneck_thresholds_from_env()
    metrics['e2eLatencySec'] = latency.get('seconds')
    metrics['e2eLatencyStatus'] = latency.get('status')
    metrics['e2eLatencyNote'] = latency.get('note')
    metrics['e2eLatencyMeasuredAt'] = latency.get('measuredAt')

    return {
        'signerType': signer_type,
        'metricsProbe': {
            'profile': probe_profile,
            'targetUdpPort': target_udp_port,
        },
        'containers': {
            'simulatedLogProducer': producer,
            'logGen': log_gen,
            'fluentBit': fluent,
            'graylog': graylog,
        },
        'metrics': metrics,
        'thresholds': thresholds,
        'summary': (
            f'İmzalama tipi: {signer_type}. Metrikler Fluent Bit / Graylog ingest hattına aittir.'
        ),
    }


@app.route('/api/pipeline/status', methods=['GET'])
@login_required
@require_role('operator')
def pipeline_status():
    """Ingest hattı (Fluent Bit) sağlık metrikleri ve konteyner özeti."""
    return jsonify(_build_pipeline_status_payload())


@app.route('/api/simulation/status', methods=['GET'])
@login_required
@require_role('operator')
def simulation_status_deprecated():
    """Kaldırıldı: yerine GET /api/pipeline/status kullanın (RFC 8594 Deprecation)."""
    resp = make_response(jsonify(_build_pipeline_status_payload()))
    resp.headers['Deprecation'] = 'true'
    resp.headers['Link'] = '</api/pipeline/status>; rel="successor-version"'
    return resp


@app.route('/api/simulation/control', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def simulation_control():
    body = {
        'error': (
            'Bu uç nokta kaldırıldı. Test için log-gen veya gerçek kaynak kullanın; '
            'doğrulama için Ayarlar → POST /api/settings/post-check.'
        )
    }
    resp = make_response(jsonify(body), 410)
    resp.headers['Deprecation'] = 'true'
    return resp


@app.route('/api/settings/impact/<key>', methods=['GET'])
@login_required
def setting_impact(key):
    setting = next((s for s in settings_catalog() if s.get('key') == key), None)
    if not setting:
        return jsonify({'error': 'unknown setting key'}), 404
    return jsonify({
        'key': key,
        'affectedServices': setting.get('affectedServices', []),
        'restartRequired': setting.get('restartRequired', False),
        'riskLevel': setting.get('riskLevel', 'medium'),
        'description': setting.get('description', '')
    })


@app.route('/api/audit/events', methods=['GET'])
@login_required
@require_role('operator')
def get_audit_events():
    try:
        limit = int(request.args.get('limit', '200'))
    except Exception:
        limit = 200
    limit = max(1, min(limit, 2000))
    return jsonify({'events': read_audit_events(limit)})


@app.route('/api/container-logs', methods=['GET'])
@login_required
@require_role('operator')
def get_container_logs():
    """Docker container loglarını döndür. container=ad&tail=100&since=3600"""
    if not docker_available or docker_client is None:
        return jsonify({'error': 'Docker API erişilemiyor', 'logs': []}), 503
    container_name = (request.args.get('container') or '').strip()
    if not container_name:
        containers = []
        try:
            for c in docker_client.containers.list(all=True, ignore_removed=True):
                if not _docker_reload_container_or_skip(c):
                    continue
                if not _include_container_in_service_dashboard(c):
                    continue
                name = c.name or ''
                if name and not name.startswith('log-system-setup'):
                    containers.append({'name': name, 'status': c.status})
        except Exception as e:
            return jsonify({'error': str(e), 'containers': []}), 500
        return jsonify({'containers': sorted(containers, key=lambda x: x['name'])})
    try:
        tail = min(500, max(10, int(request.args.get('tail', '200'))))
        since = request.args.get('since', '')  # saniye veya timestamp
        since_opt = None
        if since:
            try:
                since_opt = int(since)
            except ValueError:
                pass
        container = docker_client.containers.get(container_name)
        logs = container.logs(tail=tail, since=since_opt, stdout=True, stderr=True)
        if isinstance(logs, bytes):
            logs = logs.decode('utf-8', errors='replace')
        lines = [line.strip() for line in logs.split('\n') if line.strip()]
        return jsonify({'container': container_name, 'logs': lines, 'count': len(lines)})
    except Exception as e:
        return jsonify({'error': str(e), 'logs': []}), 500


@app.route('/api/users', methods=['GET'])
@login_required
@require_role('admin')
def list_users():
    users = load_users()
    safe_users = [
        {
            'username': user.get('username'),
            'role': user.get('role', 'viewer'),
            'enabled': user.get('enabled', True)
        }
        for user in users
    ]
    return jsonify({'users': safe_users})


@app.route('/api/users', methods=['POST'])
@login_required
@require_role('admin')
@csrf_protect
def upsert_user():
    payload = request.json or {}
    username = (payload.get('username') or '').strip()
    role = payload.get('role', 'viewer')
    enabled = bool(payload.get('enabled', True))
    password = payload.get('password')

    if not username:
        return jsonify({'error': 'username is required'}), 400
    if role not in ROLE_WEIGHTS:
        return jsonify({'error': 'invalid role'}), 400

    users = load_users()
    existing = None
    for user in users:
        if user.get('username') == username:
            existing = user
            break

    if existing is None:
        if not password:
            return jsonify({'error': 'password is required for new user'}), 400
        users.append({
            'username': username,
            'password_hash': generate_password_hash(password),
            'role': role,
            'enabled': enabled
        })
    else:
        existing['role'] = role
        existing['enabled'] = enabled
        if password:
            existing['password_hash'] = generate_password_hash(password)

    save_users(users)
    audit_event('users.upsert', 'success', {'username': username, 'role': role, 'enabled': enabled})
    return jsonify({'message': 'user saved'})


@app.route('/api/k8s/hpa', methods=['GET'])
@login_required
def get_hpa_policies():
    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Kubernetes mode required'}), 400
    try:
        return jsonify({'items': list_hpa_policies()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/k8s/hpa/<name>', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def update_hpa_policy(name):
    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Kubernetes mode required'}), 400

    payload = request.json or {}
    min_replicas = payload.get('min_replicas')
    max_replicas = payload.get('max_replicas')
    cpu_target = payload.get('cpu_target')
    memory_target = payload.get('memory_target')

    try:
        if min_replicas is not None:
            min_replicas = int(min_replicas)
        if max_replicas is not None:
            max_replicas = int(max_replicas)
        if cpu_target is not None:
            cpu_target = int(cpu_target)
        if memory_target is not None:
            memory_target = int(memory_target)
    except Exception:
        return jsonify({'error': 'numeric values expected'}), 400

    if min_replicas is not None and min_replicas < 0:
        return jsonify({'error': 'min_replicas must be >= 0'}), 400
    if max_replicas is not None and max_replicas < 1:
        return jsonify({'error': 'max_replicas must be >= 1'}), 400
    if min_replicas is not None and max_replicas is not None and min_replicas > max_replicas:
        return jsonify({'error': 'min_replicas cannot be greater than max_replicas'}), 400

    try:
        patch_hpa_policy(name, min_replicas, max_replicas, cpu_target, memory_target)
        audit_event('hpa.update', 'success', {
            'name': name,
            'min_replicas': min_replicas,
            'max_replicas': max_replicas,
            'cpu_target': cpu_target,
            'memory_target': memory_target
        })
        return jsonify({'message': f'HPA policy updated: {name}'})
    except Exception as e:
        audit_event('hpa.update', 'failed', {'name': name, 'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/k8s/rollout/<deployment_name>/history', methods=['GET'])
@login_required
def get_rollout_history(deployment_name):
    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Kubernetes mode required'}), 400
    try:
        return jsonify({'items': deployment_rollout_history(deployment_name)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/k8s/rollout/<deployment_name>/restart', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def rollout_restart(deployment_name):
    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Kubernetes mode required'}), 400
    try:
        restart_deployment(deployment_name)
        audit_event('rollout.restart', 'success', {'deployment': deployment_name})
        return jsonify({'message': f'Deployment restarted: {deployment_name}'})
    except Exception as e:
        audit_event('rollout.restart', 'failed', {'deployment': deployment_name, 'error': str(e)})
        return jsonify({'error': str(e)}), 500


@app.route('/api/k8s/rollout/<deployment_name>/rollback', methods=['POST'])
@login_required
@require_role('operator')
@csrf_protect
def rollout_rollback(deployment_name):
    if runtime_platform() != 'k8s':
        return jsonify({'error': 'Kubernetes mode required'}), 400

    payload = request.json or {}
    revision = payload.get('revision')
    if revision is None:
        return jsonify({'error': 'revision is required'}), 400

    try:
        rollback_deployment_to_revision(deployment_name, revision)
        audit_event('rollout.rollback', 'success', {'deployment': deployment_name, 'revision': revision})
        return jsonify({'message': f'Deployment rolled back: {deployment_name} -> revision {revision}'})
    except Exception as e:
        audit_event('rollout.rollback', 'failed', {'deployment': deployment_name, 'revision': revision, 'error': str(e)})
        return jsonify({'error': str(e)}), 500

# Dev ortamında varsayılan admin/admin123! girişini garanti et
ensure_dev_admin()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
