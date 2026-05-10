#!/bin/bash

# Graylog GELF UDP (+ Kafka) input otomatik kurulumu.
# Graylog 6.x: input olusturulduktan sonra PUT /system/inputstates/{id} ile RUNNING garanti edilir.
# post-init / manuel tekrar: GRAYLOG_ROOT_PASSWORD .env ile graylog ile ayni olmali.

set -euo pipefail

echo "=== Graylog GELF UDP Input Kurulumu ==="
echo ""

GRAYLOG_ADMIN_PASSWORD=${GRAYLOG_ROOT_PASSWORD:-admin}
GRAYLOG_ADMIN_USER="admin"
GRAYLOG_API="http://graylog:9000/api"
LOG_SYSTEM_ENV=${LOG_SYSTEM_ENV:-dev}

echo "Graylog admin kullanici: $GRAYLOG_ADMIN_USER"
echo "Graylog API URL: $GRAYLOG_API"

echo "Graylog API'sinin hazir olmasi bekleniyor..."
MAX_RETRIES=40
for i in $(seq 1 $MAX_RETRIES); do
    if curl -s -f "$GRAYLOG_API" > /dev/null 2>&1; then
        echo "OK Graylog API hazir (deneme $i/$MAX_RETRIES)"
        break
    elif [ "$i" -eq "$MAX_RETRIES" ]; then
        echo "UYARI Graylog API hazir olmadi ($MAX_RETRIES deneme sonrasi)"
        exit 0
    else
        echo "  Graylog baslatiliyor... ($i/$MAX_RETRIES)"
        sleep 10
    fi
done

AUTH_ARGS=(-u "$GRAYLOG_ADMIN_USER:$GRAYLOG_ADMIN_PASSWORD" -H "X-Requested-By: setup-graylog-input" -H "Accept: application/json")

if ! curl -s -f "${AUTH_ARGS[@]}" "$GRAYLOG_API/system/inputs" >/dev/null 2>&1; then
    echo "HATA Graylog API kimlik dogrulama basarisiz"
    echo "  GRAYLOG_ROOT_PASSWORD .env / graylog-post-init ortami ile Graylog admin sifresi ayni olmali."
    exit 1
fi

echo "OK Graylog API kimlik dogrulama basarili"

# Indeks / deflector hazir olsun (bos kurulumda API bazen gec acilir)
echo "Indexer ozeti bekleniyor (max ~120 sn)..."
for _w in $(seq 1 60); do
    OV=$(curl -s "${AUTH_ARGS[@]}" "$GRAYLOG_API/system/indexer/overview" 2>/dev/null || echo "{}")
    if echo "$OV" | grep -q '"deflector"'; then
        echo "OK Indexer overview yanit verdi"
        break
    fi
    sleep 2
done

fetch_inputs_json() {
    curl -s "${AUTH_ARGS[@]}" "$GRAYLOG_API/system/inputs" 2>/dev/null || echo '{"inputs":[]}'
}

input_title_exists() {
    local title="$1"
    local json="$2"
    # Graylog 6: {"inputs":[{"title":"GELF UDP",...}], "total": N}
    printf '%s' "$json" | grep -Fq "\"title\":\"${title}\""
}

extract_json_id() {
    # Tek satir {"id":"..."} veya gomulu id
    printf '%s' "$1" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

start_input_by_id() {
    local iid="$1"
    [ -n "$iid" ] || return 0
    local sc
    sc=$(curl -s -o /tmp/gl_inputstate_body.txt -w '%{http_code}' \
        "${AUTH_ARGS[@]}" -X PUT \
        -H "Content-Type: application/json" \
        -d '{}' \
        "$GRAYLOG_API/system/inputstates/$iid" 2>/dev/null || echo "000")
    if [ "$sc" = "200" ] || [ "$sc" = "201" ] || [ "$sc" = "204" ]; then
        echo "  OK input state RUNNING: $iid"
    else
        echo "  UYARI input state PUT HTTP=$sc id=$iid body=$(head -c 200 /tmp/gl_inputstate_body.txt 2>/dev/null || true)"
    fi
}

create_input_with_retries() {
    local input_title="$1"
    local input_payload="$2"
    local attempt http_code create_response iid

    for attempt in 1 2 3 4 5; do
        create_response=$(curl -s \
            "${AUTH_ARGS[@]}" \
            -H "Content-Type: application/json" \
            -X POST "$GRAYLOG_API/system/inputs" \
            -d "$input_payload" \
            -w "\n__HTTP_CODE__:%{http_code}" 2>/dev/null || echo "{}")

        http_code=$(echo "$create_response" | sed -n 's/.*__HTTP_CODE__:\([0-9][0-9][0-9]\).*/\1/p')
        create_response=$(echo "$create_response" | sed 's/__HTTP_CODE__:[0-9][0-9][0-9]//')

        if [ "$http_code" = "201" ]; then
            iid=$(extract_json_id "$create_response")
            echo "OK $input_title olusturuldu (id=$iid)"
            start_input_by_id "$iid"
            return 0
        fi
        echo "  Deneme $attempt/5 HTTP=${http_code:-?} — $create_response" | head -c 400
        echo ""
        sleep 5
    done
    echo "HATA $input_title olusturulamadi (5 deneme)"
    return 1
}

create_input_if_missing() {
    local input_title="$1"
    local input_payload="$2"
    local INPUTS_RESPONSE="$3"

    if input_title_exists "$input_title" "$INPUTS_RESPONSE"; then
        echo "OK $input_title input zaten mevcut"
        return 0
    fi

    echo "$input_title olusturuluyor..."
    if ! create_input_with_retries "$input_title" "$input_payload"; then
        echo "  (atlandi veya sonra tekrar deneyin: docker compose run --rm graylog-post-init)"
    fi
}

echo "Mevcut input'lar kontrol ediliyor..."
INPUTS_RESPONSE="$(fetch_inputs_json)"

# Faz C: GELF UDP input default'ta KAPALI. Tek raw kaynak Kafka logs_raw topic.
# Geri uyumluluk: GRAYLOG_KEEP_GELF_INPUT=1 set edilirse yine olusturulur (eski kurulumlar veya
# external GELF gondericileri icin). Yeni kurulumlarda dual-ingest yapilmasi onerilmez.
if [ "${GRAYLOG_KEEP_GELF_INPUT:-0}" = "1" ]; then
    echo "GRAYLOG_KEEP_GELF_INPUT=1 — GELF UDP input olusturulacak"
    create_input_if_missing \
        "GELF UDP" \
        '{
            "title": "GELF UDP",
            "type": "org.graylog2.inputs.gelf.udp.GELFUDPInput",
            "global": true,
            "configuration": {
                "bind_address": "0.0.0.0",
                "port": 12201,
                "recv_buffer_size": 262144,
                "number_worker_threads": 4,
                "decompress_size_limit": 8388608
            },
            "node": null
        }' \
        "$INPUTS_RESPONSE"
    INPUTS_RESPONSE="$(fetch_inputs_json)"
else
    # Mevcut GELF UDP input'u (eski kurulumdan kalma) sil — idempotent migration
    GELF_IDS=$(printf '%s' "$INPUTS_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for it in d.get('inputs', []):
        if 'GELFUDPInput' in (it.get('type') or ''):
            print(it.get('id') or '')
except Exception:
    pass
" 2>/dev/null || true)
    if [ -n "$GELF_IDS" ]; then
        for gid in $GELF_IDS; do
            [ -z "$gid" ] && continue
            sc=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH_ARGS[@]}" -X DELETE "$GRAYLOG_API/system/inputs/$gid" 2>/dev/null || echo "000")
            if [ "$sc" = "204" ] || [ "$sc" = "200" ]; then
                echo "GELF UDP input $gid silindi (Faz C migration)"
            else
                echo "Uyari: GELF UDP input $gid silinemedi HTTP=$sc"
            fi
        done
        INPUTS_RESPONSE="$(fetch_inputs_json)"
    else
        echo "GELF UDP input yok — Faz C zaten uygulanmis (GRAYLOG_KEEP_GELF_INPUT=1 ile geri etkinlestirilebilir)."
    fi
fi

create_input_if_missing \
    "Kafka RAW Logs" \
    '{
        "title": "Kafka RAW Logs",
        "type": "org.graylog2.inputs.raw.kafka.RawKafkaInput",
        "global": true,
        "configuration": {
            "bootstrap_server": "kafka1:9092,kafka2:9092,kafka3:9092",
            "topic_filter": "^logs_raw$",
            "group_id": "graylog-raw-consumer",
            "offset_reset": "largest",
            "fetch_min_bytes": 5,
            "fetch_wait_max": 100,
            "threads": 2,
            "legacy_mode": false,
            "throttling_allowed": false
        },
        "node": null
    }' \
    "$INPUTS_RESPONSE"

INPUTS_RESPONSE="$(fetch_inputs_json)"

if [ "$LOG_SYSTEM_ENV" != "prod" ] && [ "$LOG_SYSTEM_ENV" != "production" ]; then
    create_input_if_missing \
        "Kafka Synthetic Logs" \
        '{
            "title": "Kafka Synthetic Logs",
            "type": "org.graylog2.inputs.raw.kafka.RawKafkaInput",
            "global": true,
            "configuration": {
                "bootstrap_server": "kafka1:9092,kafka2:9092,kafka3:9092",
                "topic_filter": "^logs_synthetic$",
                "group_id": "graylog-synthetic-consumer",
                "offset_reset": "largest",
                "fetch_min_bytes": 5,
                "fetch_wait_max": 100,
                "threads": 1,
                "legacy_mode": false,
                "throttling_allowed": false
            },
            "node": null
        }' \
        "$INPUTS_RESPONSE"
fi

# Mevcut tum inputlar icin RUNNING PUT (idempotent; Graylog 6 setup / duraklatma sonrasi)
echo "Mevcut input id'leri icin RUNNING senkronu..."
IN_ALL="$(fetch_inputs_json)"
for sid in $(printf '%s' "$IN_ALL" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | sort -u); do
    [ -n "$sid" ] || continue
    start_input_by_id "$sid"
done

echo ""
echo "=== Kurulum Tamamlandi ==="
exit 0
