#!/bin/bash
# Apply OpenSearch ISM policy (90 gün retention) ve best_compression index template
# 90 gün: Grafana/Graylog tam aranabilir; WORM 2 yıl ayrı (DISK_SIKISTIRMA_MIMARISI_90GUN.md)
# Run after OpenSearch is healthy. Requires OPENSEARCH_URL and auth.

set -euo pipefail

# Host'tan çalıştırıldığında localhost kullan (opensearch1 sadece Docker ağında çözümlenir)
OPENSEARCH_URL="${OPENSEARCH_URL:-https://127.0.0.1:9200}"
OPENSEARCH_USER="${OPENSEARCH_USER:-admin}"
# Konteyner OPENSEARCH_INITIAL_ADMIN_PASSWORD kullanır; .env'de PASSWORD eski/ayrı kalabildiğinde önce INITIAL kullan
OPENSEARCH_PASSWORD="${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-${OPENSEARCH_PASSWORD:-admin}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
POLICY_FILE="${POLICY_FILE:-$ROOT_DIR/src/config/opensearch/ism-policy-90gun.json}"
POLICY_ID="${POLICY_ID:-graylog-90gun}"
TEMPLATE_FILE="${ROOT_DIR}/src/config/opensearch/index-template-graylog-best-compression.json"

# Disable SSL verify for self-signed certs
CURL_OPTS="-k -s"
if [ -n "$OPENSEARCH_PASSWORD" ]; then
    AUTH="-u ${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}"
else
    AUTH=""
fi

echo "=== OpenSearch 90 Gün Disk Optimizasyonu ==="

POLICY_OK=0
TEMPLATE_OK=0

# 1. ISM Policy (90 gün: hot 7d -> warm 83d -> delete)
if [ -f "$POLICY_FILE" ]; then
    POLICY_JSON=$(cat "$POLICY_FILE")
    RESP=$(curl $CURL_OPTS $AUTH -X PUT \
        "${OPENSEARCH_URL}/_plugins/_ism/policies/${POLICY_ID}" \
        -H "Content-Type: application/json" \
        -d "$POLICY_JSON" 2>&1)
    if echo "$RESP" | grep -q '"policy_id"'; then
        echo "✓ ISM policy uygulandı: $POLICY_ID (90 gün retention)"
        POLICY_OK=1
    else
        [ -z "$RESP" ] && RESP="(Boş yanıt - bağlantı hatası? OPENSEARCH_URL=$OPENSEARCH_URL kontrol edin)"
        echo "⚠ ISM policy uygulanamadı: $RESP"
    fi
else
    echo "⚠ Policy dosyası bulunamadı: $POLICY_FILE"
fi

# 2. Index Template (best_compression - disk tasarrufu)
if [ -f "$TEMPLATE_FILE" ]; then
    TEMPLATE_JSON=$(cat "$TEMPLATE_FILE")
    RESP=$(curl $CURL_OPTS $AUTH -X PUT \
        "${OPENSEARCH_URL}/_index_template/graylog-best-compression" \
        -H "Content-Type: application/json" \
        -d "$TEMPLATE_JSON" 2>&1)
    if echo "$RESP" | grep -q '"acknowledged"'; then
        echo "✓ Index template uygulandı: best_compression (yeni indeksler için)"
        TEMPLATE_OK=1
    else
        [ -z "$RESP" ] && RESP="(Boş yanıt - bağlantı hatası? OPENSEARCH_URL=$OPENSEARCH_URL kontrol edin)"
        echo "⚠ Index template uygulanamadı: $RESP"
    fi
else
    echo "ℹ Index template dosyası yok: $TEMPLATE_FILE"
fi

echo "=== Tamamlandı ==="
[ "$POLICY_OK" = "1" ] && [ "$TEMPLATE_OK" = "1" ] && exit 0 || exit 1
