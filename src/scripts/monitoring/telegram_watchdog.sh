#!/bin/bash

# Enterprise Log Platform - Hybrid Notification Watchdog
# Telegram + SMTP notifications for system health and log flow
# Enhanced with Health-Check API integration

set -euo pipefail

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
GRAYLOG_API="${GRAYLOG_API:-http://graylog:9000/api}"
GRAYLOG_USER="${GRAYLOG_USER:-admin}"
GRAYLOG_PASSWORD="${GRAYLOG_ROOT_PASSWORD:-admin}"
ALERT_THRESHOLD_MINUTES="${ALERT_THRESHOLD_MINUTES:-5}"
ALERT_THRESHOLD_SECONDS=$((ALERT_THRESHOLD_MINUTES * 60))
HEALTH_CHECK_HOURS="${HEALTH_CHECK_HOURS:-1}"
HEALTH_CHECK_SECONDS=$((HEALTH_CHECK_HOURS * 3600))

send_telegram_message() {
    local message="$1"

    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        return 1
    fi

    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${message}" > /dev/null
}

if [ "${1:-}" = "--webhook" ]; then
    WEBHOOK_PAYLOAD="$(cat)"
    PAYLOAD_TRIMMED="$(printf '%s' "$WEBHOOK_PAYLOAD" | tr '\n' ' ' | cut -c1-3000)"
    WEBHOOK_MESSAGE="🔔 GRAFANA ALERT - $(date '+%Y-%m-%d %H:%M:%S')\n\n${PAYLOAD_TRIMMED}"

    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "Grafana webhook alındı ancak Telegram değişkenleri tanımlı değil"
        exit 0
    fi

    if send_telegram_message "$WEBHOOK_MESSAGE"; then
        echo "Grafana webhook alarmı Telegram'a iletildi"
        exit 0
    fi

    echo "Grafana webhook alarmı Telegram'a iletilemedi"
    exit 1
fi

# Loglama fonksiyonu
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "=== Enterprise Log Platform Watchdog ==="
log "Time: $(date)"
log "Log Flow Threshold: ${ALERT_THRESHOLD_MINUTES} minutes"
log "Health Check Period: ${HEALTH_CHECK_HOURS} hour(s)"

# Check if Telegram is configured
if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
    log "Telegram bot token veya chat ID ayarlanmamış, sadece log mesajları"
    TELEGRAM_ENABLED=false
else
    TELEGRAM_ENABLED=true
fi

# Graylog API session
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
    if [ "$TELEGRAM_ENABLED" = true ]; then
        MESSAGE="🚨 GRAYLOG API ERİŞİLEMİYOR! $(date '+%Y-%m-%d %H:%M:%S')"
        send_telegram_message "$MESSAGE" > /dev/null 2>&1 || true
    fi
    exit 1
fi

# 1. Check log flow for last X minutes (short-term)
log "1. Kısa vadeli log akışı kontrol ediliyor (${ALERT_THRESHOLD_MINUTES} dakika)..."
SHORT_TERM_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/search/universal/relative?query=*&range=${ALERT_THRESHOLD_SECONDS}&limit=1" 2>/dev/null || echo "{}")

SHORT_TERM_RESULTS=$(echo "$SHORT_TERM_RESPONSE" | grep -o '"total_results":[0-9]*' | cut -d':' -f2 || echo "0")

# 2. Health-Check: Check log flow for last 1 hour (long-term)
log "2. Sağlık kontrolü: Uzun vadeli log akışı (${HEALTH_CHECK_HOURS} saat)..."
HEALTH_CHECK_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/search/universal/relative?query=*&range=${HEALTH_CHECK_SECONDS}&limit=1" 2>/dev/null || echo "{}")

HEALTH_CHECK_RESULTS=$(echo "$HEALTH_CHECK_RESPONSE" | grep -o '"total_results":[0-9]*' | cut -d':' -f2 || echo "0")

# 3. Check system health
log "3. Sistem sağlığı kontrol ediliyor..."
HEALTH_RESPONSE=$(curl -s \
    -H "X-Requested-By: watchdog" \
    -H "Accept: application/json" \
    -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    "$GRAYLOG_API/system" 2>/dev/null || echo "{}")

# Close session
curl -s -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
    -X DELETE "$GRAYLOG_API/system/sessions" > /dev/null 2>&1 || true

# Evaluate and send alerts
ALERT_TRIGGERED=false
ALERT_MESSAGES=()

# Short-term log flow check
if [ "$SHORT_TERM_RESULTS" -eq 0 ]; then
    log "🚨 LOG DURDU! Son ${ALERT_THRESHOLD_MINUTES} dakikada hiç log alınamadı."
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("🚨 LOG DURDU! Son ${ALERT_THRESHOLD_MINUTES} dakikadır hiç log alınamadı.")
else
    log "✓ Kısa vadeli log akışı normal: Son ${ALERT_THRESHOLD_MINUTES} dakikada $SHORT_TERM_RESULTS log"
fi

# Health-Check: Long-term log flow
if [ "$HEALTH_CHECK_RESULTS" -eq 0 ]; then
    log "⚠ SAĞLIK UYARISI! Son ${HEALTH_CHECK_HOURS} saatte hiç log alınamadı."
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("⚠ SAĞLIK UYARISI! Son ${HEALTH_CHECK_HOURS} saatte hiç log alınamadı.")
else
    log "✓ Uzun vadeli log akışı normal: Son ${HEALTH_CHECK_HOURS} saatte $HEALTH_CHECK_RESULTS log"
fi

# System health check
if echo "$HEALTH_RESPONSE" | grep -q '"lifecycle":"running"'; then
    log "✓ Graylog cluster sağlıklı"
else
    log "⚠ Graylog cluster durumu belirsiz"
    ALERT_TRIGGERED=true
    ALERT_MESSAGES+=("⚠ Graylog Cluster Durumu Belirsiz")
fi

# Send Telegram alerts if any issues detected
if [ "$ALERT_TRIGGERED" = true ] && [ "$TELEGRAM_ENABLED" = true ]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    MESSAGE="🔔 LOG PLATFORM UYARILARI - $TIMESTAMP\n\n"
    for alert_msg in "${ALERT_MESSAGES[@]}"; do
        MESSAGE+="• $alert_msg\n"
    done
    MESSAGE+="\n📊 İstatistikler:\n"
    MESSAGE+="• Son ${ALERT_THRESHOLD_MINUTES} dakika: $SHORT_TERM_RESULTS log\n"
    MESSAGE+="• Son ${HEALTH_CHECK_HOURS} saat: $HEALTH_CHECK_RESULTS log\n"
    MESSAGE+="\n🔧 Kontrol önerilir."

    if send_telegram_message "$MESSAGE" > /dev/null; then
        log "Telegram alarmı gönderildi"
    else
        log "⚠ Telegram alarmı gönderilemedi"
    fi
fi

# Send periodic heartbeat if everything is normal
if [ "$ALERT_TRIGGERED" = false ]; then
    log "✓ Tüm sistem kontrolleri başarılı"
    
    # Optional: Send periodic heartbeat to Telegram (once per hour)
    CURRENT_HOUR=$(date +%H)
    if [ "$TELEGRAM_ENABLED" = true ] && [ "$CURRENT_HOUR" = "00" ]; then
        MESSAGE="✅ Log Platform Sağlıklı - $(date '+%Y-%m-%d %H:%M:%S')\n\n"
        MESSAGE+="📊 Son ${ALERT_THRESHOLD_MINUTES} dakika: $SHORT_TERM_RESULTS log\n"
        MESSAGE+="📊 Son ${HEALTH_CHECK_HOURS} saat: $HEALTH_CHECK_RESULTS log\n"
        MESSAGE+="🔄 Tüm servisler çalışıyor."

        if send_telegram_message "$MESSAGE" > /dev/null 2>&1; then
            log "Telegram heartbeat gönderildi"
        else
            log "⚠ Telegram heartbeat gönderilemedi"
        fi
    fi
fi

log "=== Watchdog kontrolü tamamlandı ==="
exit 0
