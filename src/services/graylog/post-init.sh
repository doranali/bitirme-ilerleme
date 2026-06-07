#!/bin/sh
# Idempotent post-init: Graylog hazır olunca GELF input + ECS pipeline + vendor packs.
# - Marker dosya: /state/.graylog-post-init.done (her başarılı çalıştırmada güncellenir)
# - Hatada exit 0 — deploy zinciri kırılmasın; panel /api/system/bootstrap ile tekrar tetikler.
set -e

if ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  apk add --no-cache curl bash python3 >/dev/null 2>&1 || true
fi
MARKER="${BOOTSTRAP_MARKER:-/state/.graylog-post-init.done}"
mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
log() { echo "[graylog-post-init] $*"; }
log 'Başlatılıyor...'

# Graylog API hazır olana kadar bekle (en fazla 10 dakika)
MAX_WAIT=120
WAIT_COUNT=0
API_READY=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
  if curl -s -f http://graylog:9000/api > /dev/null 2>&1; then
    log 'Graylog API hazır.'
    API_READY=1
    break
  fi
  log "Graylog API hazır değil ($((WAIT_COUNT+1))/$MAX_WAIT)..."
  sleep 5
  WAIT_COUNT=$((WAIT_COUNT+1))
done

if [ "$API_READY" != 1 ]; then
  log 'Graylog API yanıt vermedi; sonraki yeniden başlatmada tekrar denenecek (exit 0).'
  exit 0
fi

# 1) GELF UDP input
if [ -f /scripts/setup-graylog-input.sh ]; then
  /bin/bash /scripts/setup-graylog-input.sh || log '⚠ setup-graylog-input başarısız (devam ediliyor)'
fi

# 2) Vendor pack v3 rules yeniden üretilsin
if [ -f /scripts/load-vendor-packs-v2.sh ]; then
  log 'Vendor pack v3 lookup/rules yeniden üretiliyor...'
  /bin/bash /scripts/load-vendor-packs-v2.sh || log '⚠ load-vendor-packs-v2 başarısız (devam ediliyor)'
fi

# 3) ECS pipeline kur
export GRAYLOG_API="${GRAYLOG_API:-http://graylog:9000/api}"
log 'ECS pipeline kuruluyor...'
/bin/bash /scripts/create-ecs-pipeline.sh || log '⚠ create-ecs-pipeline başarısız (devam ediliyor)'

# 4) Doğrulama
if [ -f /scripts/verify-normalization-pipeline.sh ]; then
  /bin/bash /scripts/verify-normalization-pipeline.sh || log '⚠ verify-normalization-pipeline'
fi

# 5) Deflector alias onarımı (idempotent; dosya artık aynı volume içinde)
if [ -f /scripts/fix-graylog-deflectors.sh ]; then
  export OPENSEARCH_INTERNAL_URL="${OPENSEARCH_INTERNAL_URL:-https://opensearch1:9200}"
  /bin/bash /scripts/fix-graylog-deflectors.sh || log '⚠ fix-graylog-deflectors'
fi

date -u +%FT%TZ > "$MARKER" 2>/dev/null || true
log 'Tamamlandı.'
