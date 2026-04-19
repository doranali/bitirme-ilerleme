#!/bin/bash

# Graylog `log_env` alanı: compose `environment` ile geçirilir; yoksa varsayılan prod.
# Lab ayrımı için konteynerde: LOG_SYSTEM_ENV=dev_test
export LOG_SYSTEM_ENV="${LOG_SYSTEM_ENV:-prod}"

# Grafana/OpenSearch `company_id`: compose COMPANY_ID veya LOG_SYSTEM_COMPANY_ID; yoksa default (fluent-bit.conf ${COMPANY_ID})
export COMPANY_ID="${COMPANY_ID:-${LOG_SYSTEM_COMPANY_ID:-default}}"

# Fluent Bit başlatma script'i
# Graylog'un hazır olup olmadığını kontrol et (opsiyonel)
# Ancak UDP port kontrolü güvenilir olmayabilir, bu yüzden sadece kısa bir bekleme yap

echo "Fluent Bit başlatılıyor..."
echo "Sistem saat dilimi: $(date)"
echo "Graylog host: graylog"
echo "Graylog GELF UDP port: 12201"

# Graylog'un başlaması için kısa bir süre bekle (30 saniye)
MAX_WAIT=30
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if timeout 1 bash -c 'cat < /dev/null > /dev/tcp/graylog/12201' 2>/dev/null; then
        echo "Graylog GELF UDP portu hazır."
        break
    fi
    echo "Graylog hazır değil ($((WAIT_COUNT+1))/$MAX_WAIT)..."
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT+1))
done

if [ $WAIT_COUNT -eq $MAX_WAIT ]; then
    echo "Uyarı: Graylog tam hazır olmayabilir, ancak Fluent Bit başlatılıyor..."
fi

# Fluent Bit'ı başlat
echo "Fluent Bit konfigürasyonu ile başlatılıyor..."
exec /fluent-bit/bin/fluent-bit -c /fluent-bit/etc/fluent-bit.conf
