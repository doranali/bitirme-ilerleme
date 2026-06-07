#!/bin/bash

# 5651 Sayılı Kanun Uyumluluk Script'i
# SIGNER_TYPE ortam değişkenine göre imzalama yapar
# Her gece 00:01'de cron job olarak çalıştırılır
# Rclone ile multi-destination archiving destekler

set -euo pipefail

# İmza Tipi: TUBITAK, TUBITAK_TEST, PUBLIC_TSA_TEST, OPEN_SOURCE (SIMULATED kaldırıldı)
SIGNER_TYPE=${SIGNER_TYPE:-OPEN_SOURCE}
# ${var^^} bash'a özgüdür; ash/sh uyumu için tr kullan (signing-engine eski imajda sh ile çağrılabilir)
SIGNER_TYPE=$(printf '%s' "$SIGNER_TYPE" | tr '[:lower:]' '[:upper:]')
if [ "$SIGNER_TYPE" = "SIMULATED" ]; then
    SIGNER_TYPE="OPEN_SOURCE"
fi
MANIFEST_SIGNER="$SIGNER_TYPE"
SIGNER_FALLBACK_TO_OPEN_SOURCE=${SIGNER_FALLBACK_TO_OPEN_SOURCE:-1}
TUBITAK_TSA_URL=${TUBITAK_TSA_URL:-"https://kamusm.bilgem.tubitak.gov.tr/tsa"}
ARCHIVE_DESTINATION=${ARCHIVE_DESTINATION:-local}

ARSIV_KOK="${ARSIV_KOK:-/fluent-bit/arsiv}"
IMZALI_ARSIV="${IMZALI_ARSIV:-/fluent-bit/arsiv_imzali}"
WORM_STORAGE="${WORM_STORAGE:-/fluent-bit/worm_storage}"
RETRY_QUEUE="/fluent-bit/worm_retry_queue"
RETRY_LIST="${RETRY_QUEUE}/retry.list"
mkdir -p "$RETRY_QUEUE" 2>/dev/null || true

if [ -n "${SIGN_TARGET_DATE:-}" ]; then
    TARIH="$SIGN_TARGET_DATE"
else
    TARIH=$(date -d "yesterday" '+%Y-%m-%d')
fi
LOGDIR="/var/log/5651_archive"
LOGFILE="${LOGDIR}/sign_logs_${TARIH}.log"
NOTIFY_SCRIPT="${NOTIFY_SCRIPT:-/scripts/monitoring/notify_dispatch.sh}"

_sign_notify() {
    local sev="$1" title="$2" body="$3"
    if [ -x "$NOTIFY_SCRIPT" ]; then
        "$NOTIFY_SCRIPT" "$sev" signing "$title" "$body" signing || true
    fi
}

_sign_exit_trap() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        _sign_notify critical "5651 imzalama hatası" "Tarih: ${TARIH:-?}, çıkış kodu: ${rc}. Log: ${LOGFILE}"
    fi
}
trap '_sign_exit_trap' EXIT

# Log dizinini oluştur
mkdir -p "$LOGDIR" 2>/dev/null || true

# Loglama fonksiyonu
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE" 2>/dev/null || echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# RFC3161 HTTP TSA (openssl ts-query + curl). Çıkış 0 = tsr_store yazıldı.
rfc3161_http_stamp() {
    local datafile="$1"
    local tsr_store="$2"
    local tsa_url="$3"
    local tsq="/tmp/ts-query-rfc3161-$$.tsq"
    local tsr_tmp="/tmp/ts-response-rfc3161-$$.tsr"
    rm -f "$tsq" "$tsr_tmp"
    if ! openssl ts -query -data "$datafile" -sha256 -cert -out "$tsq" 2>/tmp/ts_openssl_err.log; then
        log "   UYARI: openssl ts -query: $(head -3 /tmp/ts_openssl_err.log 2>/dev/null | tr '\n' ' ')"
        rm -f "$tsq" "$tsr_tmp"
        return 1
    fi
    local CURL_EXTRA=(--http1.1 -L --max-time 120 -sS -f \
        -H "Content-Type: application/timestamp-query" \
        --data-binary "@${tsq}" \
        -o "$tsr_tmp")
    if [ "${TUBITAK_TLS_INSECURE:-0}" = "1" ] || [ "${TUBITAK_TLS_INSECURE:-}" = "true" ] || \
       [ "${RFC3161_TLS_INSECURE:-0}" = "1" ] || [ "${RFC3161_TLS_INSECURE:-}" = "true" ]; then
        CURL_EXTRA=(-k "${CURL_EXTRA[@]}")
        log "   UYARI: RFC3161 TLS doğrulaması kapalı (yalnızca test)."
    fi
    if [ -n "${TUBITAK_TSA_CUSTOMER_NO:-}" ] && [ -n "${TUBITAK_TSA_PASSWORD:-}" ]; then
        CURL_EXTRA+=(--user "${TUBITAK_TSA_CUSTOMER_NO}:${TUBITAK_TSA_PASSWORD}")
        log "   TSA isteği müşteri kimlik bilgisi ile gönderiliyor."
    fi
    if ! curl "${CURL_EXTRA[@]}" "$tsa_url"; then
        log "   UYARI: TSA yanıtı alınamadı (${tsa_url})."
        rm -f "$tsq" "$tsr_tmp"
        return 1
    fi
    rm -f "$tsq"
    local tsr_sz
    tsr_sz=$(wc -c < "$tsr_tmp" 2>/dev/null | tr -d ' ' || echo 0)
    if [ "${tsr_sz:-0}" -lt 64 ]; then
        log "   UYARI: TSA yanıtı boş veya geçersiz (${tsr_sz} byte, ${tsa_url})."
        rm -f "$tsr_tmp"
        return 1
    fi
    if ! mv "$tsr_tmp" "$tsr_store" 2>/dev/null; then
        rm -f "$tsr_tmp"
        return 1
    fi
    return 0
}

# Başlangıç
log "=== 5651 Log İmzalama Süreci Başlatıldı - ${TARIH} ==="
log "İmza Tipi: ${SIGNER_TYPE}"
log "Arşiv Hedefi: ${ARCHIVE_DESTINATION}"

RESIGN_ALLOWED=${RESIGN_ALLOWED:-0}
MANIFEST_EXIST="${IMZALI_ARSIV}/${TARIH}/data-${TARIH}.manifest.json"
if [ -f "$MANIFEST_EXIST" ] && [ "$RESIGN_ALLOWED" != "1" ]; then
    log "ℹ ${TARIH} zaten imzalı; tekrar imzalama atlandı (RESIGN_ALLOWED=1 ile geçersiz kılınabilir)."
    exit 0
fi

# Dünün log dosyasını bul
_resolve_archive_file() {
    local d="$1"
    local best="" best_sz=0 f sz
    for f in \
        "${ARSIV_KOK}/data-${d}.log" \
        "${ARSIV_KOK}/archive.day.${d}"; do
        if [ -f "$f" ]; then
            sz=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
            if [ "$sz" -gt "$best_sz" ]; then
                best="$f"
                best_sz=$sz
            fi
        fi
    done
    if [ -n "$best" ]; then
        echo "$best"
        return 0
    fi
    ls -S "${ARSIV_KOK}"/archive.day.* "${ARSIV_KOK}"/data-*.log 2>/dev/null \
        | grep -v 'legacy-' | head -1 || true
}

YESTERDAY_FILE="$(_resolve_archive_file "$TARIH")"
if [ -n "$YESTERDAY_FILE" ] && [ -f "$YESTERDAY_FILE" ]; then
    case "$(basename "$YESTERDAY_FILE")" in
        data-%Y-%m-%d.log|archive.day.*)
            log "   UYARI: Arşiv dosyası $(basename "$YESTERDAY_FILE") (beklenen data-${TARIH}.log değil)."
            ;;
    esac
fi
if [ ! -f "$YESTERDAY_FILE" ]; then
    log "ℹ ${TARIH} tarihli log dosyası bulunamadı: ${ARSIV_KOK}/data-${TARIH}.log"
    log "Mevcut dosyalar:"
    ls -la "$ARSIV_KOK/" 2>/dev/null | head -10 | while read line; do log "  $line"; done
    exit 0
fi

# Canlı syslog arşive yazarken hash / TSR / WORM aynı bayt kümesini kullanmalı
SOURCE_ARCHIVE="$YESTERDAY_FILE"
SIGN_SNAPSHOT="/tmp/sign-snapshot-${TARIH}-$$.log"
cp "$SOURCE_ARCHIVE" "$SIGN_SNAPSHOT"
trap 'rm -f "$SIGN_SNAPSHOT"' EXIT INT TERM
YESTERDAY_FILE="$SIGN_SNAPSHOT"
log "   Anlık kopya: $(basename "$SOURCE_ARCHIVE") → imza özeti (canlı yazım ile yarış önlendi)"

log "1. Dosya işleniyor: $(basename "$SOURCE_ARCHIVE")"
log "   Boyut: $(du -h "$YESTERDAY_FILE" | cut -f1)"

# SHA256 hash hesapla
HASH=$(sha256sum "$YESTERDAY_FILE" | cut -d' ' -f1)
log "2. SHA256 hash hesaplandı: ${HASH}"

# İmzalı manifest dizini (TÜBİTAK dalı .tsr dosyasını buraya yazar)
IMZALI_DOSYA_DIR="${IMZALI_ARSIV}/${TARIH}"
mkdir -p "$IMZALI_DOSYA_DIR"

# İmza oluştur
TIMESTAMP_SIGNATURE=""
_tubitak_stamp() {
    local tsr_out="$1"
    local tsa_url="$2"
    log "3. RFC3161 zaman damgası (TSA HTTP) isteniyor: ${tsa_url}..."
    if ! command -v openssl >/dev/null 2>&1 || ! openssl ts -help >/dev/null 2>&1; then
        log "   HATA: openssl 'ts' desteği yok (imajda openssl eksik veya eski)."
        return 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
        log "   HATA: curl yok; TSA HTTP isteği yapılamaz."
        return 1
    fi
    if ! rfc3161_http_stamp "$YESTERDAY_FILE" "$tsr_out" "$tsa_url"; then
        return 1
    fi
    TSR_SHA=$(sha256sum "$tsr_out" | cut -d' ' -f1)
    TIMESTAMP_SIGNATURE="RFC3161-TSR-SHA256:${TSR_SHA}"
    log "   TSA yanıtı kaydedildi: $(basename "$tsr_out") ($(wc -c < "$tsr_out" | tr -d ' ') byte, tsr_sha256=${TSR_SHA:0:16}...)"
    return 0
}

_open_source_stamp() {
    log "3. OPEN_SOURCE: önce herkese açık RFC3161 TSA deneniyor (başarısızsa yerel özet)..."
    # FreeTSA kimlik bilgisi istemez; TUBITAK_TEST fallback'te önceki müşteri no'yu göndermeyelim
    unset TUBITAK_TSA_CUSTOMER_NO TUBITAK_TSA_PASSWORD 2>/dev/null || true
    OPEN_SOURCE_RFC3161_URL=${OPEN_SOURCE_RFC3161_URL:-https://freetsa.org/tsr}
    TSR_OPEN="${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr"
    if rfc3161_http_stamp "$YESTERDAY_FILE" "$TSR_OPEN" "$OPEN_SOURCE_RFC3161_URL"; then
        TSR_SHA=$(sha256sum "$TSR_OPEN" | cut -d' ' -f1)
        TIMESTAMP_SIGNATURE="RFC3161-TSR-SHA256:${TSR_SHA}"
        log "   RFC3161 TSA yanıtı: $(basename "$TSR_OPEN") (özet kayıtlı)"
    else
        log "   RFC3161 başarısız; yerel SHA256 özeti (zincir için metadata) üretiliyor..."
        SIGNATURE_FILE="/tmp/signature_${TARIH}.sig"
        echo -n "$HASH" | openssl dgst -sha256 -binary > "${SIGNATURE_FILE}"
        TIMESTAMP_SIGNATURE="OPENSSL-SHA256-$(base64 <"${SIGNATURE_FILE}" | tr -d '\n' | head -c 32)"
        rm -f "${SIGNATURE_FILE}"
        log "   Yerel özet damgası oluşturuldu"
    fi
}

case "$SIGNER_TYPE" in
    PUBLIC_TSA_TEST)
        MANIFEST_SIGNER="PUBLIC_TSA_TEST"
        TUBITAK_TSA_URL="${TUBITAK_TSA_URL:-${PUBLIC_TSA_DEFAULT_URL:-http://timestamp.digicert.com}}"
        if [ -z "${TUBITAK_TSA_CUSTOMER_NO:-}" ] || [ -z "${TUBITAK_TSA_PASSWORD:-}" ]; then
            unset TUBITAK_TSA_CUSTOMER_NO TUBITAK_TSA_PASSWORD 2>/dev/null || true
        fi
        TSR_STORE="${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr"
        if ! _tubitak_stamp "$TSR_STORE" "$TUBITAK_TSA_URL"; then
            if [ "$SIGNER_FALLBACK_TO_OPEN_SOURCE" = "1" ]; then
                log "   PUBLIC_TSA_TEST TSA başarısız; OPEN_SOURCE fallback deneniyor..."
                MANIFEST_SIGNER="PUBLIC_TSA_FALLBACK_OPEN_SOURCE"
                _open_source_stamp
            else
                exit 1
            fi
        fi
        ;;
    TUBITAK_TEST)
        MANIFEST_SIGNER="TUBITAK_TEST"
        TUBITAK_TSA_URL="${TUBITAK_TEST_TSA_URL:-http://zdsA1.test3.kamusm.gov.tr}"
        TUBITAK_TSA_CUSTOMER_NO="${TUBITAK_TEST_USER:-1}"
        TUBITAK_TSA_PASSWORD="${TUBITAK_TEST_PASSWORD:-12345678}"
        TSR_STORE="${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr"
        if ! _tubitak_stamp "$TSR_STORE" "$TUBITAK_TSA_URL"; then
            if [ "$SIGNER_FALLBACK_TO_OPEN_SOURCE" = "1" ]; then
                log "   TUBITAK_TEST TSA başarısız; OPEN_SOURCE fallback deneniyor..."
                MANIFEST_SIGNER="TUBITAK_FALLBACK_OPEN_SOURCE"
                _open_source_stamp
            else
                exit 1
            fi
        fi
        ;;
    TUBITAK)
        TSR_STORE="${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr"
        if ! _tubitak_stamp "$TSR_STORE" "$TUBITAK_TSA_URL"; then
            if [ "$SIGNER_FALLBACK_TO_OPEN_SOURCE" = "1" ]; then
                log "   TÜBİTAK TSA başarısız; OPEN_SOURCE fallback deneniyor..."
                MANIFEST_SIGNER="TUBITAK_FALLBACK_OPEN_SOURCE"
                _open_source_stamp
            else
                exit 1
            fi
        fi
        ;;
    OPEN_SOURCE)
        _open_source_stamp
        ;;
    *)
        log "3. Varsayılan imza oluşturuluyor..."
        TIMESTAMP_SIGNATURE="SIMULATED-${HASH:0:12}"
        log "   Varsayılan imza oluşturuldu"
        ;;
esac

# İmzalı metin manifest
IMZALI_DOSYA="${IMZALI_DOSYA_DIR}/data-${TARIH}.signed.txt"

{
    echo "=== 5651 SAYILI KANUN UYUMLU LOG ARŞİVİ ==="
    echo "Proje: Log Yönetim Sistemi"
    echo "Kanun: 5651 Sayılı İnternet Ortamında Yapılan Yayınların Düzenlenmesi"
    echo "Tarih: ${TARIH}"
    echo "Orijinal Dosya: data-${TARIH}.log"
    echo "SHA256 Özeti: ${HASH}"
    echo "İmzalama Zamanı: $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "İmza Tipi: ${MANIFEST_SIGNER}"
    echo "Zaman Damgası: ${TIMESTAMP_SIGNATURE}"
    if [ "$MANIFEST_SIGNER" = "TUBITAK" ] || [ "$MANIFEST_SIGNER" = "TUBITAK_TEST" ] || [ "$MANIFEST_SIGNER" = "PUBLIC_TSA_TEST" ]; then
        echo "TSA URL: ${TUBITAK_TSA_URL}"
        if [ -f "${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr" ]; then
            echo "RFC3161_TSR_DOSYA: data-${TARIH}.tsr"
            echo "RFC3161_TSR_SHA256: $(sha256sum "${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr" | cut -d' ' -f1)"
        fi
    fi
    if [ "$MANIFEST_SIGNER" = "TUBITAK_FALLBACK_OPEN_SOURCE" ] || [ "$MANIFEST_SIGNER" = "PUBLIC_TSA_FALLBACK_OPEN_SOURCE" ]; then
        if [ -f "${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr" ]; then
            echo "RFC3161_TSR_DOSYA: data-${TARIH}.rfc3161.tsr"
            echo "RFC3161_TSR_SHA256: $(sha256sum "${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr" | cut -d' ' -f1)"
            echo "OPEN_SOURCE_RFC3161_URL: ${OPEN_SOURCE_RFC3161_URL:-}"
        fi
    fi
    if [ "$SIGNER_TYPE" = "OPEN_SOURCE" ] && [ -f "${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr" ]; then
        echo "RFC3161_TSR_DOSYA: data-${TARIH}.rfc3161.tsr"
        echo "RFC3161_TSR_SHA256: $(sha256sum "${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr" | cut -d' ' -f1)"
        echo "OPEN_SOURCE_RFC3161_URL: ${OPEN_SOURCE_RFC3161_URL:-}"
    fi
    echo "=== SON ==="
} > "$IMZALI_DOSYA"

log "4. İmzalı dosya oluşturuldu: $(basename "$IMZALI_DOSYA")"
log "   Konum: $IMZALI_DOSYA"

# Manifest zinciri (günlük JSON + önceki manifest SHA256)
MANIFEST_DIR="${MANIFEST_CHAIN_DIR:-/fluent-bit/manifests}"
mkdir -p "$MANIFEST_DIR"
LATEST_SHA_FILE="${MANIFEST_DIR}/latest_manifest.sha256"
PREV_HASH=""
if [ -f "$LATEST_SHA_FILE" ]; then
    PREV_HASH=$(tr -d '\n\r ' < "$LATEST_SHA_FILE" || true)
fi
TSR_SHA_VAL=""
for f in "${IMZALI_DOSYA_DIR}/data-${TARIH}.tsr" "${IMZALI_DOSYA_DIR}/data-${TARIH}.rfc3161.tsr"; do
    if [ -f "$f" ]; then
        TSR_SHA_VAL=$(sha256sum "$f" | cut -d' ' -f1)
        break
    fi
done
ESC_TSR=$(printf '%s' "$TSR_SHA_VAL" | sed 's/\\/\\\\/g; s/"/\\"/g')
ESC_SIG=$(printf '%s' "$TIMESTAMP_SIGNATURE" | sed 's/\\/\\\\/g; s/"/\\"/g')
ESC_PREV=$(printf '%s' "$PREV_HASH" | sed 's/\\/\\\\/g; s/"/\\"/g')
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
THIS_MANIFEST="${IMZALI_DOSYA_DIR}/data-${TARIH}.manifest.json"
{
    printf '{\n'
    printf '  "date": "%s",\n' "$TARIH"
    printf '  "file": "data-%s.log",\n' "$TARIH"
    printf '  "archive_file": "data-%s.log",\n' "$TARIH"
    printf '  "sha256": "%s",\n' "$HASH"
    printf '  "prevManifestSha256": "%s",\n' "$ESC_PREV"
    printf '  "previous_manifest_sha256": "%s",\n' "$ESC_PREV"
    printf '  "timestamp_signature": "%s",\n' "$ESC_SIG"
    printf '  "tsr_sha256": "%s",\n' "$ESC_TSR"
    printf '  "signer": "%s",\n' "$MANIFEST_SIGNER"
    printf '  "signer_type": "%s",\n' "$MANIFEST_SIGNER"
    printf '  "signed_at": "%s",\n' "$GENERATED_AT"
    printf '  "generatedAt": "%s",\n' "$GENERATED_AT"
    printf '  "signed_text_path": "%s"\n' "$(basename "$IMZALI_DOSYA")"
    printf '}\n'
} > "$THIS_MANIFEST"
M_SHA=$(sha256sum "$THIS_MANIFEST" | cut -d' ' -f1)
printf '%s\n' "$M_SHA" > "$LATEST_SHA_FILE"
log "4b. Manifest zinciri güncellendi: $(basename "$THIS_MANIFEST") (this_sha256=${M_SHA:0:16}...)"

# Panel / doğrulama API: günlük imza dizininde manifest.json (içerik signed-manifests ile aynı)
cp -f "$THIS_MANIFEST" "${IMZALI_DOSYA_DIR}/manifest.json"
log "4c. Panel manifest kopyası: ${IMZALI_DOSYA_DIR}/manifest.json"

# WORM depolamaya taşı
WORM_HEDEF_DIR="${WORM_STORAGE}/${TARIH}"
mkdir -p "$WORM_HEDEF_DIR"
WORM_HEDEF="${WORM_HEDEF_DIR}/data-${TARIH}.log.gz"

# Dosyayı sıkıştır ve taşı (gzip -9: maksimum sıkıştırma, disk tasarrufu)
if gzip -9 -c "$YESTERDAY_FILE" > "$WORM_HEDEF"; then
    chmod 444 "$WORM_HEDEF" 2>/dev/null || true
    if command -v chattr >/dev/null 2>&1; then
        if chattr +i "$WORM_HEDEF" 2>/dev/null; then
            log "5. WORM depolamaya taşındı (immutable): $(basename "$WORM_HEDEF")"
        else
            log "5. WORM depolamaya taşındı (chattr +i başarısız — cap LINUX_IMMUTABLE kontrol edin): $(basename "$WORM_HEDEF")"
        fi
    else
        log "5. WORM depolamaya taşındı (chattr yok, yalnızca chmod 444): $(basename "$WORM_HEDEF")"
    fi
    log "   Sıkıştırılmış boyut: $(du -h "$WORM_HEDEF" | cut -f1)"
else
    log "⚠ WORM depolamaya taşıma başarısız"
fi

if [ -f "$IMZALI_DOSYA" ]; then
    chmod 444 "$IMZALI_DOSYA" 2>/dev/null || true
fi

# Rclone ile arşivleme
if [ "$ARCHIVE_DESTINATION" != "local" ]; then
    log "6. Rclone ile uzak arşivleme başlatılıyor (Hedef: ${ARCHIVE_DESTINATION})..."
    if command -v rclone >/dev/null 2>&1; then
        # İmzalı dosyayı arşivle
        log "   İmzalı dosya arşivleniyor: ${IMZALI_DOSYA}"
        if rclone copy "$IMZALI_DOSYA" "${ARCHIVE_DESTINATION}/imzali_arsiv/${TARIH}/" --progress 2>&1 | tee -a "$LOGFILE"; then
            log "✓ İmzalı dosya başarıyla arşivlendi"
            rm -f "$IMZALI_DOSYA"
            log "✓ Yerel imzalı dosya silindi (uzak kopya korundu)"
        else
            RCLONE_EXIT_CODE=$?
            log "⚠ İmzalı dosya arşivlenemedi (Exit: ${RCLONE_EXIT_CODE}), retry kuyruğuna eklendi"
            echo "${IMZALI_DOSYA}|${ARCHIVE_DESTINATION}/imzali_arsiv/${TARIH}/|signed|0" >> "$RETRY_LIST" 2>/dev/null || true
        fi

        log "   Sıkıştırılmış log dosyası arşivleniyor: ${WORM_HEDEF}"
        if rclone copy "$WORM_HEDEF" "${ARCHIVE_DESTINATION}/worm_storage/${TARIH}/" --progress 2>&1 | tee -a "$LOGFILE"; then
            log "✓ Sıkıştırılmış log dosyası başarıyla arşivlendi"
            rm -f "$WORM_HEDEF"
            log "✓ Yerel sıkıştırılmış dosya silindi (uzak kopya korundu)"
        else
            RCLONE_EXIT_CODE=$?
            log "⚠ Sıkıştırılmış log dosyası arşivlenemedi (Exit: ${RCLONE_EXIT_CODE}), retry kuyruğuna eklendi"
            echo "${WORM_HEDEF}|${ARCHIVE_DESTINATION}/worm_storage/${TARIH}/|worm|0" >> "$RETRY_LIST" 2>/dev/null || true
        fi
    else
        log "⚠ Rclone bulunamadı, arşivleme atlanıyor"
    fi
else
    log "6. Arşiv hedefi 'local' olarak ayarlandı, uzak arşivleme atlanıyor"
fi

# 5651 uyumu: 2 yıl (730 gün) retention. 730 günden eski ham logları temizle.
# (İmzalı ve WORM kopyaları zaten 2 yıl saklanır)
log "7. 730 günden (2 yıl) eski ham logları temizleme..."
find "$ARSIV_KOK" -type f -name "data-*.log" -mtime +730 -delete 2>/dev/null || log "ℹ Eski loglar temizlenemedi"

log "=== 5651 Log İmzalama Süreci Tamamlandı ==="
log "Rapor kaydedildi: ${LOGFILE}"

# Günlük raporu e-posta ile gönder (opsiyonel)
if [ -f "/scripts/send_daily_report.sh" ]; then
    /scripts/send_daily_report.sh "$LOGFILE" "$TARIH"
fi

trap - EXIT
_sign_notify info "5651 imzalama tamamlandı" "Tarih: ${TARIH}, imza tipi: ${MANIFEST_SIGNER}, SHA256: ${HASH:0:16}..."

exit 0
