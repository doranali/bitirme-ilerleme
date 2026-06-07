#!/bin/bash

# Enterprise Log Platform - Hybrid Notification Watchdog
# Çoklu Telegram alıcı: notify_dispatch.sh / panel dispatcher

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY_SCRIPT="${NOTIFY_SCRIPT:-${SCRIPT_DIR}/notify_dispatch.sh}"
GRAYLOG_API="${GRAYLOG_API:-http://graylog:9000/api}"
GRAYLOG_USER="${GRAYLOG_USER:-admin}"
GRAYLOG_PASSWORD="${GRAYLOG_ROOT_PASSWORD:-admin}"
ALERT_THRESHOLD_MINUTES="${ALERT_THRESHOLD_MINUTES:-5}"
ALERT_THRESHOLD_SECONDS=$((ALERT_THRESHOLD_MINUTES * 60))
HEALTH_CHECK_HOURS="${HEALTH_CHECK_HOURS:-1}"
HEALTH_CHECK_SECONDS=$((HEALTH_CHECK_HOURS * 3600))

dispatch_notify() {
    local severity="$1"
    local category="$2"
    local title="$3"
    local body="${4:-}"
    local tags="${5:-watchdog}"
    if [ ! -x "$NOTIFY_SCRIPT" ]; then
        return 1
    fi
    "$NOTIFY_SCRIPT" "$severity" "$category" "$title" "$body" "$tags" || true
}

if [ "${1:-}" = "--webhook" ]; then
    WEBHOOK_PAYLOAD="$(cat)"
    PAYLOAD_TRIMMED="$(printf '%s' "$WEBHOOK_PAYLOAD" | tr '\n' ' ' | cut -c1-3000)"
    SEVERITY="warning"
    if echo "$PAYLOAD_TRIMMED" | grep -qiE 'critical|firing.*critical'; then
        SEVERITY="critical"
    fi
    TITLE="Grafana Alert"
    BODY="Grafana webhook — $(date '+%Y-%m-%d %H:%M:%S')\n\n${PAYLOAD_TRIMMED}"
    if dispatch_notify "$SEVERITY" "grafana" "$TITLE" "$BODY" "grafana,alert"; then
        echo "Grafana webhook alarmı dispatcher ile iletildi"
        exit 0
    fi
    echo "Grafana webhook dispatcher ile iletilemedi"
    exit 1
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "=== Enterprise Log Platform Watchdog ==="
log "Time: $(date)"
log "Log Flow Threshold: ${ALERT_THRESHOLD_MINUTES} minutes"
log "Health Check Period: ${HEALTH_CHECK_HOURS} hour(s)"

NOTIFY_AVAILABLE=false
if [ -x "$NOTIFY_SCRIPT" ]; then
    NOTIFY_AVAILABLE=true
else
    log "notify_dispatch.sh bulunamadı — bildirimler atlanacak"
fi

SESSION_TOKEN=""
MAX_RETRIES=3
for attempt in {1..3}; do
    SESSION_RESPONSE=$(curl -s -f -u "$GRAYLOG_USER:$GRAYLOG_PASSWORD" \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -X POST "$GRAYLOG_API/system/sessions" \
        -d '{"username":"'"$GRAYLOG_USER"'","password":"'"$GRAYLOG_PASSWORD"'","host":""}' 2>/dev/null || echo "")

    SESSION_TOKEN=$(echo "$SESSION_RESPONSE" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4 || echo "")

    if [ -n "$SESSION_TOKEN" ]; then
        log "✓ Graylog oturumu açıldı (deneme $attempt)"
        break
    else
        log "  Oturum açma denemesi $attempt başarısız"
        sleep 2
    fi
done

if [ -z "$SESSION_TOKEN" ]; then
    log "✗ Graylog oturumu açılamadı"
    if [ "$NOTIFY_AVAILABLE" = true ]; then
        dispatch_notify critical watchdog "Graylog API erişilemiyor" "$(date '+%Y-%m-%d %H:%M:%S')" "graylog,critical"
    fi
    exit 1
fi

log "1. Kısa vadeli log akışı kontrol ediliyor (${ALERT_THRESHOLD_MINUTES} dakika)..."
SHORT_TERM_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/search/universal/relative?query=*&range=${ALERT_THRESHOLD_SECONDS}&limit=1" 2>/dev/null || echo "{}")

SHORT_TERM_RESULTS=$(echo "$SHORT_TERM_RESPONSE" | grep -o '"total_results":[0-9]*' | cut -d':' -f2 || echo "0")

log "2. Sağlık kontrolü: Uzun vadeli log akışı (${HEALTH_CHECK_HOURS} saat)..."
HEALTH_CHECK_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/search/universal/relative?query=*&range=${HEALTH_CHECK_SECONDS}&limit=1" 2>/dev/null || echo "{}")

HEALTH_CHECK_RESULTS=$(echo "$HEALTH_CHECK_RESPONSE" | grep -o '"total_results":[0-9]*' | cut -d':' -f2 || echo "0")

log "3. Sistem sağlığı kontrol ediliyor..."
HEALTH_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/system" 2>/dev/null || echo "{}")

curl -s -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    -X DELETE "$GRAYLOG_API/system/sessions" > /dev/null 2>&1 || true

ALERT_TRIGGERED=false
ALERT_MESSAGES=()

if [ "$SHORT_TERM_RESULTS" -eq 0 ]; then
    log "🚨 LOG DURDU! Son ${ALERT_THRESHOLD_MINUTES} dakikada hiç log alınamadı."
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("🚨 LOG DURDU! Son ${ALERT_THRESHOLD_MINUTES} dakikadır hiç log alınamadı.")
else
    log "✓ Kısa vadeli log akışı normal: Son ${ALERT_THRESHOLD_MINUTES} dakikada $SHORT_TERM_RESULTS log"
fi

if [ "$HEALTH_CHECK_RESULTS" -eq 0 ]; then
    log "⚠ SAĞLIK UYARISI! Son ${HEALTH_CHECK_HOURS} saatte hiç log alınamadı."
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("⚠ SAĞLIK UYARISI! Son ${HEALTH_CHECK_HOURS} saatte hiç log alınamadı.")
else
    log "✓ Uzun vadeli log akışı normal: Son ${HEALTH_CHECK_HOURS} saatte $HEALTH_CHECK_RESULTS log"
fi

if echo "$HEALTH_RESPONSE" | grep -q '"lifecycle":"running"'; then
    log "✓ Graylog cluster sağlıklı"
else
    log "⚠ Graylog cluster durumu belirsiz"
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("⚠ Graylog Cluster Durumu Belirsiz")
fi

if [ "$ALERT_TRIGGERED" = true ] && [ "$NOTIFY_AVAILABLE" = true ]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    BODY=""
    for alert_msg in "${ALERT_MESSAGES[@]}"; do
        BODY+="• ${alert_msg}\n"
    done
    BODY+="\n📊 İstatistikler:\n"
    BODY+="• Son ${ALERT_THRESHOLD_MINUTES} dakika: $SHORT_TERM_RESULTS log\n"
    BODY+="• Son ${HEALTH_CHECK_HOURS} saat: $HEALTH_CHECK_RESULTS log\n"
    BODY+="\n🔧 Kontrol önerilir."
    if dispatch_notify critical watchdog "Log Platform uyarıları - $TIMESTAMP" "$BODY" "watchdog,logflow"; then
        log "Telegram alarmı gönderildi (dispatcher)"
    else
        log "⚠ Telegram alarmı gönderilemedi"
    fi
fi

if [ "$ALERT_TRIGGERED" = false ]; then
    log "✓ Tüm sistem kontrolleri başarılı"
    CURRENT_HOUR=$(date +%H)
    if [ "$NOTIFY_AVAILABLE" = true ] && [ "$CURRENT_HOUR" = "00" ]; then
        BODY="📊 Son ${ALERT_THRESHOLD_MINUTES} dakika: $SHORT_TERM_RESULTS log\n"
        BODY+="📊 Son ${HEALTH_CHECK_HOURS} saat: $HEALTH_CHECK_RESULTS log\n"
        BODY+="🔄 Tüm servisler çalışıyor."
        if dispatch_notify info watchdog "Log Platform sağlıklı" "$BODY" "watchdog,heartbeat"; then
            log "Telegram heartbeat gönderildi"
        else
            log "⚠ Telegram heartbeat gönderilemedi"
        fi
    fi
fi

log "=== Watchdog kontrolü tamamlandı ==="
exit 0
