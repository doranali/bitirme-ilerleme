#!/bin/bash

# Log akış test script'i
# Log üreticiden Graylog'a kadar tüm akışı test eder

set -euo pipefail

echo "=== Log Akış Testi ==="
echo "Tarih: $(date)"
echo ""

# Test mesajı oluştur
TEST_ID="test_flow_$(date +%s)_$RANDOM"
TEST_MESSAGE="Log akış test mesajı - ID: $TEST_ID"
TEST_LOG="{\"time\":\"$(date -Iseconds)\",\"host\":\"test-log-flow\",\"message\":\"$TEST_MESSAGE\",\"level\":\"INFO\",\"source\":\"test-log-flow\",\"test_id\":\"$TEST_ID\"}"

echo "1. Test logu oluşturuldu:"
echo "   $TEST_LOG"
echo ""

echo "2. Log'u fluent-bit'e gönderiliyor (port 5151)..."
# Try multiple methods
if command -v nc > /dev/null 2>&1; then
    if echo "$TEST_LOG" | nc -u -w 2 localhost 5151; then
        echo "   ✓ Log gönderildi (host nc)"
    else
        echo "   ✗ Host nc ile gönderilemedi"
    fi
fi

# Also try via docker
if docker compose ps log-gen | grep -q "Up"; then
    if echo "$TEST_LOG" | docker compose exec -T log-gen nc -u -w 2 fluent-bit 5151; then
        echo "   ✓ Log gönderildi (via log-gen container)"
    else
        echo "   ✗ Log-gen container ile gönderilemedi"
    fi
else
    echo "   ℹ log-gen container çalışmıyor, host üzerinden gönderim deneniyor"
fi
echo ""

echo "3. 5 saniye bekleniyor (işlenmesi için)..."
sleep 5
echo ""

echo "4. Arşiv klasörü kontrolü..."
ARCHIVE_FILES=$(find ./data/arsiv_loglari -name "*.log" -type f -mmin -2 2>/dev/null | head -5)
if [ -n "$ARCHIVE_FILES" ]; then
    echo "   ✓ Arşiv dosyaları bulundu:"
    for file in $ARCHIVE_FILES; do
        echo "   - $file (boyut: $(stat -c%s "$file" 2>/dev/null || echo "?") bytes)"
        # Check if test message is in the file
        if grep -q "$TEST_ID" "$file" 2>/dev/null; then
            echo "     ✓ Test ID bulundu"
        fi
    done
else
    echo "   ✗ Son 2 dakikada arşiv dosyası bulunamadı"
fi
echo ""

echo "5. OpenSearch kontrolü..."
OS_PASS=""
[ -f .env ] && OS_PASS=$(grep -E '^OPENSEARCH_INITIAL_ADMIN_PASSWORD=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "'\"" || true)
if [ -n "$OS_PASS" ]; then
    OS_CURL="curl -sk -u admin:${OS_PASS} 'https://opensearch1:9200/_search?q=test_id:${TEST_ID}'"
else
    OS_CURL="curl -sk 'https://opensearch1:9200/_search?q=test_id:${TEST_ID}'"
fi
RESPONSE=$(docker compose exec -T graylog sh -lc "$OS_CURL" 2>/dev/null || true)
if [ -n "$RESPONSE" ] && echo "$RESPONSE" | grep -q "hits"; then
    echo "   ✓ Log OpenSearch'te bulundu"
    # Get details
    HITS=$(echo "$RESPONSE" | grep -o '"total":{"value":[0-9]*' | cut -d: -f3)
    echo "   - Toplam eşleşme: $HITS"
else
    echo "   ✗ Log OpenSearch'te bulunamadı"
    echo "   ℹ İndeks listesi: docker compose exec -T graylog sh -lc 'curl -sk -u admin:PAROLA https://opensearch1:9200/_cat/indices?v'"
fi
echo ""

echo "6. Graylog servis kontrolü..."
if curl -s -m 5 http://localhost:9000/api/system/lbstatus 2>/dev/null | grep -q "ALIVE"; then
    echo "   ✓ Graylog API canlı (lbstatus=ALIVE)"
    echo "   ℹ Graylog UI'da doğrulama için:"
    echo "     - Query: test_id:$TEST_ID"
    echo "     - Time range: Last 1 hour"
    echo "     - Stream: All events veya raw_ingest"
else
    echo "   ✗ Graylog API canlılık kontrolü başarısız"
    echo "   ℹ Graylog input'larını kontrol et: http://localhost:9000/system/inputs"
fi
echo ""

echo "=== Test Tamamlandı ==="
echo ""
echo "Not: Eğer loglar Graylog'a ulaşmıyorsa:"
echo "1. Graylog GELF UDP input'unun açık olduğundan emin olun"
echo "2. Network bağlantısını kontrol edin: docker compose exec fluent-bit nc -z graylog 12201"
echo "3. Fluent-bit loglarını kontrol edin: docker compose logs fluent-bit --tail=20"
echo "4. Graylog loglarını kontrol edin: docker compose logs graylog --tail=20"
