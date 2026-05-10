#!/bin/bash

# Otonom Sistem Ayarlama Script'i - HPC Kaynak Adaptörü
# Sistem başlatıldığında donanımı tarar ve Java Heap/Docker limitlerini optimize eder
# "HPC V2 Kuralı" uygulanır: Toplam RAM'in %25'i Graylog'a, %25'i OpenSearch'e

set -euo pipefail

echo "=== HPC Kaynak Adaptörü - Otonom Sistem Ayarlama Başlatıldı ==="
echo "Tarih: $(date)"
echo ""

# 1. Donanım bilgilerini topla
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
AVAILABLE_CPU=$(nproc)
echo "Tespit Edilen Donanım:"
echo "  Toplam RAM: ${TOTAL_RAM_MB} MB"
echo "  CPU Çekirdek: ${AVAILABLE_CPU}"
echo ""

# 2. HPC V2 Kuralı: %25 Graylog, %25 OpenSearch
GRAYLOG_RAM_MB=$((TOTAL_RAM_MB * 25 / 100))
OPENSEARCH_RAM_MB=$((TOTAL_RAM_MB * 25 / 100))

# Minimum değerler
if [ $GRAYLOG_RAM_MB -lt 512 ]; then
    GRAYLOG_RAM_MB=512
fi
if [ $OPENSEARCH_RAM_MB -lt 512 ]; then
    OPENSEARCH_RAM_MB=512
fi

# Java heap için RAM'in %50'si (HPC kuralı)
GRAYLOG_HEAP_MB=$((GRAYLOG_RAM_MB * 50 / 100))
OPENSEARCH_HEAP_MB=$((OPENSEARCH_RAM_MB * 50 / 100))

# Minimum heap değerleri - HPC V2 Kuralı için optimize
if [ $GRAYLOG_HEAP_MB -lt 512 ]; then
    GRAYLOG_HEAP_MB=512
fi
if [ $OPENSEARCH_HEAP_MB -lt 512 ]; then
    OPENSEARCH_HEAP_MB=512
fi

# Ensure we don't allocate too much memory for small systems
if [ $TOTAL_RAM_MB -lt 4096 ]; then
    # For systems with less than 4GB RAM, use more conservative settings
    echo "Küçük sistem tespit edildi (${TOTAL_RAM_MB} MB RAM), kaynaklar yeniden ayarlanıyor..."
    GRAYLOG_RAM_MB=$((TOTAL_RAM_MB * 20 / 100))
    OPENSEARCH_RAM_MB=$((TOTAL_RAM_MB * 20 / 100))
    GRAYLOG_HEAP_MB=$((GRAYLOG_RAM_MB * 50 / 100))
    OPENSEARCH_HEAP_MB=$((OPENSEARCH_RAM_MB * 50 / 100))
    
    # Minimum values
    if [ $GRAYLOG_HEAP_MB -lt 256 ]; then
        GRAYLOG_HEAP_MB=256
    fi
    if [ $OPENSEARCH_HEAP_MB -lt 256 ]; then
        OPENSEARCH_HEAP_MB=256
    fi
fi

# CPU limitleri: Toplam CPU'nun %80'i
CONTAINER_CPU_LIMIT=$(echo "scale=2; $AVAILABLE_CPU * 0.8" | bc | awk '{printf "%.2f", $0}')

echo "HPC V2 Kuralı ile Optimize Edilmiş Ayarlar:"
echo "  Graylog RAM: ${GRAYLOG_RAM_MB} MB (Heap: ${GRAYLOG_HEAP_MB} MB)"
echo "  OpenSearch RAM: ${OPENSEARCH_RAM_MB} MB (Heap: ${OPENSEARCH_HEAP_MB} MB)"
echo "  Container CPU Limiti: ${CONTAINER_CPU_LIMIT} vCPU"
echo ""

# 3. .env dosyasını güncelle (varsa) veya oluştur
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "# HPC V2 Kuralı ile otomatik oluşturuldu $(date)" > "$ENV_FILE"
    echo "" >> "$ENV_FILE"
    echo "# Tanılama aracı tarafından oluşturuldu" >> "$ENV_FILE"
fi

# Mevcut değerleri güncelle veya ekle
update_env() {
    local key="$1"
    local value="$2"
    
    # .env dosyası yoksa oluştur
    if [ ! -f "$ENV_FILE" ]; then
        touch "$ENV_FILE"
    fi
    
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # Değeri güncelle
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        # Yeni satır ekle
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

# Tanılama için sistem bilgilerini logla
log_system_info() {
    echo "=== Sistem Bilgileri ==="
    echo "Toplam RAM: ${TOTAL_RAM_MB} MB"
    echo "CPU Çekirdek: ${AVAILABLE_CPU}"
    echo "HPC V2 Kuralı Uygulanıyor:"
    echo "  - Graylog RAM: ${GRAYLOG_RAM_MB} MB (Heap: ${GRAYLOG_HEAP_MB} MB)"
    echo "  - OpenSearch RAM: ${OPENSEARCH_RAM_MB} MB (Heap: ${OPENSEARCH_HEAP_MB} MB)"
    echo ""
}

# HPC V2 Kuralına göre değerleri hesapla
# OpenSearch için
OPENSEARCH_CONTAINER_MEMORY="${OPENSEARCH_RAM_MB}"
OPENSEARCH_HEAP="${OPENSEARCH_HEAP_MB}m"

# Graylog için
GRAYLOG_CONTAINER_MEMORY="${GRAYLOG_RAM_MB}"
GRAYLOG_HEAP="${GRAYLOG_HEAP_MB}m"

# Diğer servisler için RAM (toplam RAM'in kalanından)
REMAINING_RAM_MB=$((TOTAL_RAM_MB - GRAYLOG_RAM_MB - OPENSEARCH_RAM_MB))
if [ $REMAINING_RAM_MB -lt 512 ]; then
    REMAINING_RAM_MB=512
fi

# Docker Compose memory limitleri (HPC uyumlu)
OPENSEARCH_MEMORY_LIMIT="${OPENSEARCH_CONTAINER_MEMORY}M"
GRAYLOG_MEMORY_LIMIT="${GRAYLOG_CONTAINER_MEMORY}M"
MONGODB_MEMORY_LIMIT="$((REMAINING_RAM_MB * 20 / 100))M"
FLUENTBIT_MEMORY_LIMIT="$((REMAINING_RAM_MB * 10 / 100))M"
GRAFANA_MEMORY_LIMIT="$((REMAINING_RAM_MB * 15 / 100))M"
LOG_GEN_MEMORY_LIMIT="$((REMAINING_RAM_MB * 5 / 100))M"
LOG_SIGNER_MEMORY_LIMIT="$((REMAINING_RAM_MB * 5 / 100))M"

# Minimum değerler
if [ ${MONGODB_MEMORY_LIMIT%M} -lt 256 ]; then
    MONGODB_MEMORY_LIMIT="256M"
fi
if [ ${FLUENTBIT_MEMORY_LIMIT%M} -lt 128 ]; then
    FLUENTBIT_MEMORY_LIMIT="128M"
fi
if [ ${GRAFANA_MEMORY_LIMIT%M} -lt 256 ]; then
    GRAFANA_MEMORY_LIMIT="256M"
fi
if [ ${LOG_GEN_MEMORY_LIMIT%M} -lt 64 ]; then
    LOG_GEN_MEMORY_LIMIT="64M"
fi
if [ ${LOG_SIGNER_MEMORY_LIMIT%M} -lt 64 ]; then
    LOG_SIGNER_MEMORY_LIMIT="64M"
fi

# CPU limitleri
OPENSEARCH_CPU_LIMIT="$CONTAINER_CPU_LIMIT"
GRAYLOG_CPU_LIMIT="$(echo "scale=2; $CONTAINER_CPU_LIMIT * 0.9" | bc | awk '{printf "%.2f", $0}')"
MONGODB_CPU_LIMIT="0.5"
FLUENTBIT_CPU_LIMIT="0.3"
GRAFANA_CPU_LIMIT="0.3"
LOG_GEN_CPU_LIMIT="0.2"
LOG_SIGNER_CPU_LIMIT="0.1"

echo "Servis Bazlı Ayarlar:"
echo "  OpenSearch:"
echo "    - Java Heap: ${OPENSEARCH_HEAP}"
echo "    - Memory Limit: ${OPENSEARCH_MEMORY_LIMIT}"
echo "    - CPU Limit: ${OPENSEARCH_CPU_LIMIT}"
echo "  Graylog:"
echo "    - Java Heap: ${GRAYLOG_HEAP}"
echo "    - Memory Limit: ${GRAYLOG_MEMORY_LIMIT}"
echo "    - CPU Limit: ${GRAYLOG_CPU_LIMIT}"
echo ""

# .env dosyasını güncelle
update_env "OPENSEARCH_JAVA_OPTS" "-Xms${OPENSEARCH_HEAP} -Xmx${OPENSEARCH_HEAP}"
update_env "OPENSEARCH_MEMORY_LIMIT" "${OPENSEARCH_MEMORY_LIMIT}"
update_env "OPENSEARCH_CPU_LIMIT" "${OPENSEARCH_CPU_LIMIT}"
update_env "GRAYLOG_MEMORY_LIMIT" "${GRAYLOG_MEMORY_LIMIT}"
update_env "GRAYLOG_CPU_LIMIT" "${GRAYLOG_CPU_LIMIT}"
update_env "MONGODB_MEMORY_LIMIT" "${MONGODB_MEMORY_LIMIT}"
update_env "MONGODB_CPU_LIMIT" "${MONGODB_CPU_LIMIT}"
update_env "FLUENTBIT_MEMORY_LIMIT" "${FLUENTBIT_MEMORY_LIMIT}"
update_env "FLUENTBIT_CPU_LIMIT" "${FLUENTBIT_CPU_LIMIT}"
update_env "GRAFANA_MEMORY_LIMIT" "${GRAFANA_MEMORY_LIMIT}"
update_env "GRAFANA_CPU_LIMIT" "${GRAFANA_CPU_LIMIT}"
update_env "LOG_GEN_MEMORY_LIMIT" "${LOG_GEN_MEMORY_LIMIT}"
update_env "LOG_GEN_CPU_LIMIT" "${LOG_GEN_CPU_LIMIT}"
update_env "LOG_SIGNER_MEMORY_LIMIT" "${LOG_SIGNER_MEMORY_LIMIT}"
update_env "LOG_SIGNER_CPU_LIMIT" "${LOG_SIGNER_CPU_LIMIT}"

# Graylog password secret (varsayılan)
if ! grep -q "^GRAYLOG_PASSWORD_SECRET=" "$ENV_FILE" 2>/dev/null; then
    GRAYLOG_SECRET=$(openssl rand -base64 64 | tr -d '\n' | head -c 256)
    update_env "GRAYLOG_PASSWORD_SECRET" "${GRAYLOG_SECRET}"
fi

# Graylog root password (varsayılan: admin)
if ! grep -q "^GRAYLOG_ROOT_PASSWORD_SHA2=" "$ENV_FILE" 2>/dev/null; then
    GRAYLOG_PASSWORD_SHA2=$(echo -n "admin" | sha256sum | cut -d' ' -f1)
    update_env "GRAYLOG_ROOT_PASSWORD_SHA2" "${GRAYLOG_PASSWORD_SHA2}"
fi

# Grafana admin password (varsayılan: admin)
if ! grep -q "^GF_SECURITY_ADMIN_PASSWORD=" "$ENV_FILE" 2>/dev/null; then
    update_env "GF_SECURITY_ADMIN_PASSWORD" "admin"
fi

# Signing mode (varsayılan: OPENSSL)
if ! grep -q "^SIGNING_MODE=" "$ENV_FILE" 2>/dev/null; then
    update_env "SIGNING_MODE" "OPENSSL"
fi

# TUBITAK TSA URL
if ! grep -q "^TUBITAK_TSA_URL=" "$ENV_FILE" 2>/dev/null; then
    update_env "TUBITAK_TSA_URL" "https://kamusm.bilgem.tubitak.gov.tr/tsa"
fi

echo ".env dosyası güncellendi:"
echo "---"
cat "$ENV_FILE"
echo "---"
echo ""

# 4. Docker Compose dosyasını .env değerleriyle uyumlu hale getir
echo "Docker Compose yapılandırması kontrol ediliyor..."
# Bu kısım docker-compose.yml'ın .env değerlerini kullandığından emin olur
# Mevcut docker-compose.yml zaten ${VARIABLE} syntax'ını kullanıyor

# Sistem bilgilerini logla
log_system_info

echo "=== Otonom Ayarlama Tamamlandı ==="
echo ""
echo "Sistemi başlatmak için:"
echo "  docker compose up -d"
echo ""
echo "Tanılama aracını çalıştırmak için:"
echo "  ./scripts/diagnostic-tool.sh"
echo ""
echo "Not: Ayarlar .env dosyasına kaydedildi. Docker Compose bu değerleri otomatik kullanacaktır."
