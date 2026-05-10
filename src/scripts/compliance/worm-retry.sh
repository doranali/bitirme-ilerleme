#!/bin/bash
# WORM retry queue processor - retries failed rclone transfers without data loss
# Runs after sign_logs.sh (e.g. 00:15 daily) to retry failed remote archive uploads
# Queue format: one line per file: src_path|dest_path|type|retries

set -euo pipefail

ARCHIVE_DESTINATION=${ARCHIVE_DESTINATION:-local}
RETRY_QUEUE="/fluent-bit/worm_retry_queue"
RETRY_LIST="${RETRY_QUEUE}/retry.list"
LOGDIR="/var/log/5651_archive"
LOGFILE="${LOGDIR}/worm_retry_$(date '+%Y-%m-%d').log"
MAX_RETRIES=${WORM_RETRY_MAX:-5}

mkdir -p "$LOGDIR" "$RETRY_QUEUE" 2>/dev/null || true

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE" 2>/dev/null || echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

if [ "$ARCHIVE_DESTINATION" = "local" ]; then
    log "Arşiv hedefi local, retry atlanıyor"
    exit 0
fi

if [ ! -f "$RETRY_LIST" ]; then
    log "Retry listesi boş"
    exit 0
fi

log "=== WORM Retry Kuyruğu İşleniyor ==="

TMP_LIST="${RETRY_LIST}.tmp"
: > "$TMP_LIST"

while IFS='|' read -r src dest ftype retries; do
    [ -n "$src" ] || continue
    retries=${retries:-0}
    if [ "$retries" -ge "$MAX_RETRIES" ]; then
        log "⚠ Maksimum retry aşıldı, atlanıyor: $(basename "$src")"
        continue
    fi
    if [ ! -f "$src" ]; then
        log "Kaynak dosya yok, kuyruktan siliniyor: $src"
        continue
    fi
    log "Retry ($((retries+1))/$MAX_RETRIES): $ftype -> $dest"
    if rclone copy "$src" "$dest" --progress 2>&1 | tee -a "$LOGFILE"; then
        log "✓ Başarılı: $(basename "$src")"
        rm -f "$src" 2>/dev/null || true
    else
        new_retries=$((retries + 1))
        echo "${src}|${dest}|${ftype}|${new_retries}" >> "$TMP_LIST"
        log "⚠ Başarısız, retry sayısı güncellendi: $new_retries"
    fi
done < "$RETRY_LIST" 2>/dev/null || true

mv "$TMP_LIST" "$RETRY_LIST"

log "=== WORM Retry Tamamlandı ==="
