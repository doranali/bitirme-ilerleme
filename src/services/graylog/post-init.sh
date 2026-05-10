#!/bin/sh
set -e

apk add --no-cache curl bash
echo 'Graylog post-init başlatılıyor...'

# Graylog API (compose: graylog service_healthy sonrası da kısa süre gecikme olabilir)
echo 'Graylog API bekleniyor...'
MAX_WAIT=120
WAIT_COUNT=0
API_READY=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
  if curl -s -f http://graylog:9000/api > /dev/null 2>&1; then
    echo 'Graylog API hazır.'
    API_READY=1
    break
  fi
  echo "Graylog hazır değil ($((WAIT_COUNT+1))/$MAX_WAIT)..."
  sleep 5
  WAIT_COUNT=$((WAIT_COUNT+1))
done

if [ "$API_READY" != 1 ]; then
  echo '⚠ Graylog API yanıt vermedi; GELF ve ECS adımları atlanıyor (çıkış 0).'
  echo '  Graylog sağlıklı olduktan sonra: docker compose run --rm --no-deps graylog-post-init'
  exit 0
fi

# GELF UDP input'u kur
echo 'GELF UDP input kuruluyor...'
/bin/bash /scripts/setup-graylog-input.sh

# ECS pipeline'ı kur
echo 'ECS pipeline kuruluyor...'
/bin/bash /scripts/create-ecs-pipeline.sh

echo 'Post-init tamamlandı.'
