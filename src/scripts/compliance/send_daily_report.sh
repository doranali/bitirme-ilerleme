#!/bin/bash

# Günlük 5651 İmzalama Raporu Gönderme Script'i
# Graylog SMTP üzerinden e-posta gönderir

set -euo pipefail

LOGFILE="${1:-}"
TARIH="${2:-$(date -d "yesterday" '+%Y-%m-%d')}"

if [ -z "$LOGFILE" ] || [ ! -f "$LOGFILE" ]; then
    echo "Rapor dosyası bulunamadı"
    exit 0
fi

# Graylog API'sine bağlan ve e-posta gönder
GRAYLOG_API="http://graylog:9000/api"
GRAYLOG_USER="admin"
GRAYLOG_PASSWORD="${GRAYLOG_ROOT_PASSWORD:-admin}"

# Graylog oturumu aç
SESSION_RESPONSE=$(curl -s -f -u "$GRAYLOG_USER:$GRAYLOG_PASSWORD" \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -X POST "$GRAYLOG_API/system/sessions" \
    -d '{"username":"'"$GRAYLOG_USER"'","password":"'"$GRAYLOG_PASSWORD"'","host":""}' 2>/dev/null || echo "")

SESSION_TOKEN=$(echo "$SESSION_RESPONSE" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4 || echo "")

if [ -n "$SESSION_TOKEN" ]; then
    # Rapor içeriğini oku
    REPORT_CONTENT=$(cat "$LOGFILE" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
    
    # E-posta gönder
    EMAIL_RESPONSE=$(curl -s \
        -H "X-Requested-By: daily-report" \
        -H "Accept: application/json" \
        -H "Content-Type: application/json" \
        -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
        -X POST "$GRAYLOG_API/system/notifications" \
        -d '{
            "type": "email",
            "title": "5651 Log İmzalama Raporu - '"$TARIH"'",
            "description": "Günlük 5651 uyumluluk imzalama raporu",
            "config": {
                "sender": "'"${SMTP_FROM:-logs@example.com}"'",
                "subject": "5651 Log İmzalama Raporu - '"$TARIH"'",
                "body_html": "<h2>5651 Log İmzalama Raporu</h2><p>Tarih: '"$TARIH"'</p><pre>'"$REPORT_CONTENT"'</pre>",
                "to": "'"${REPORT_EMAIL:-admin@example.com}"'"
            }
        }' 2>/dev/null || echo "{}")
    
    echo "Rapor e-posta gönderildi"
    
    # Oturumu kapat
    curl -s -H "X-Graylog-Session-ID: $SESSION_TOKEN" \
        -X DELETE "$GRAYLOG_API/system/sessions" > /dev/null 2>&1 || true
else
    echo "Graylog oturumu açılamadı, e-posta gönderilemedi"
fi

exit 0
