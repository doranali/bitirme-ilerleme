#!/usr/bin/env bash
# OpenSearch erişimi: önce opensearch1 içinden 127.0.0.1 (healthcheck ile aynı),
# olmazsa grafana konteynerinden https://opensearch1:9200 (gerçek datasource yolu).
# Parola konteyner ortamındaki OPENSEARCH_INITIAL_ADMIN_PASSWORD (compose .env ile tutarlı).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

if ! docker compose ps --status running --quiet opensearch1 2>/dev/null | grep -q .; then
  echo "SKIP: opensearch1 çalışmıyor"
  exit 0
fi

os_h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' opensearch1 2>/dev/null || echo unknown)"
if [[ "$os_h" != "healthy" ]]; then
  echo "UYARI: opensearch1 health=$os_h — cluster ayakta değilse test başarısız olur (docker logs opensearch1)."
fi

echo "OpenSearch kimlik kontrolü (opensearch1 → 127.0.0.1:9200)"
out="$(
  docker compose exec -T opensearch1 sh -c \
    'curl -sk -u "admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" "https://127.0.0.1:9200/_cluster/health" 2>&1' || true
)"

if echo "$out" | grep -q '"status"'; then
  echo "OK: OpenSearch cluster health JSON (opensearch1 içi)"
  exit 0
fi

echo "opensearch1 içi curl başarısız veya JSON yok; grafana → https://opensearch1:9200 deneniyor…"
if docker compose ps --status running --quiet grafana 2>/dev/null | grep -q .; then
  out2="$(
    docker compose exec -T grafana sh -c \
      'curl -sk -u "admin:${OPENSEARCH_INITIAL_ADMIN_PASSWORD}" "https://opensearch1:9200/_cluster/health" 2>&1' || true
  )"
  if echo "$out2" | grep -q '"status"'; then
    echo "OK: OpenSearch cluster health JSON (grafana ağı üzerinden)"
    exit 0
  fi
  echo "Grafana yolu ilk 400 karakter:"
  echo "$out2" | head -c 400
  echo
else
  echo "(grafana çalışmıyor; atlandı)"
fi

echo "FAIL: JSON beklenmiyor veya OpenSearch erişilemiyor."
echo "opensearch1 içi ilk 400 karakter:"
echo "$out" | head -c 400
echo
echo "İpucu: opensearch1 unhealthy ise docker logs opensearch1; .env parolası küme ile uyumlu olmalı."
exit 1
