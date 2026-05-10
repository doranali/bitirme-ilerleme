#!/bin/bash

set -euo pipefail

echo "=== Graylog Smart Normalization Kurulumu ==="
echo ""

GRAYLOG_ADMIN_PASSWORD=${GRAYLOG_ROOT_PASSWORD:-admin}
GRAYLOG_ADMIN_USER="admin"
GRAYLOG_API=${GRAYLOG_API:-http://localhost:9000/api}
AUTH_ARGS=(-u "$GRAYLOG_ADMIN_USER:$GRAYLOG_ADMIN_PASSWORD" -H "X-Requested-By: setup-script" -H "Accept: application/json")

wait_for_graylog() {
  echo "Graylog API'sinin hazır olması bekleniyor..."
  local max_retries=30
  for i in $(seq 1 "$max_retries"); do
    if curl -s -f "$GRAYLOG_API" >/dev/null 2>&1; then
      echo "✓ Graylog API hazır (deneme $i/$max_retries)"
      return 0
    fi
    sleep 5
  done
  echo "✗ Graylog API hazır olmadı"
  return 1
}

api_get() {
  local path="$1"
  curl -s "${AUTH_ARGS[@]}" "$GRAYLOG_API$path"
}

api_post() {
  local path="$1"
  local payload="$2"
  curl -sS -f "${AUTH_ARGS[@]}" -H "Content-Type: application/json" -X POST "$GRAYLOG_API$path" -d "$payload"
}

api_put() {
  local path="$1"
  local payload="$2"
  curl -sS -f "${AUTH_ARGS[@]}" -H "Content-Type: application/json" -X PUT "$GRAYLOG_API$path" -d "$payload"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

upsert_lookup_cache() {
  local name="$1"
  local title="$2"
  local cache_resp
  cache_resp=$(api_get "/system/lookup/caches/$name" || true)
  local cache_id
  cache_id=$(echo "$cache_resp" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)

  local payload
  payload=$(cat <<JSON
{"title":"$title","name":"$name","description":"Normalization cache","config":{"type":"guava_cache","max_size":50000,"expire_after_access":300,"expire_after_access_unit":"SECONDS","expire_after_write":0,"ignore_null":false}}
JSON
)

  if [ -n "$cache_id" ]; then
    echo "$cache_id"
  else
    local created
    created=$(api_post "/system/lookup/caches" "$payload")
    echo "$created" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || api_get "/system/lookup/caches/$name" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4
  fi
}

upsert_lookup_adapter() {
  local name="$1"
  local title="$2"
  local csv_path="$3"
  local adapter_resp
  adapter_resp=$(api_get "/system/lookup/adapters/$name" || true)
  local adapter_id
  adapter_id=$(echo "$adapter_resp" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)

  local payload
  payload=$(cat <<JSON
{"title":"$title","name":"$name","description":"CSV adapter for normalization","config":{"type":"csvfile","path":"$csv_path","separator":",","quotechar":"\"","key_column":"key","value_column":"value","check_interval":60,"case_insensitive_lookup":true,"cidr_lookup":false}}
JSON
)

  if [ -n "$adapter_id" ]; then
    echo "$adapter_id"
  else
    local created
    created=$(api_post "/system/lookup/adapters" "$payload")
    echo "$created" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || api_get "/system/lookup/adapters/$name" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4
  fi
}

upsert_lookup_table() {
  local name="$1"
  local title="$2"
  local adapter_id="$3"
  local cache_id="$4"
  local default_single="$5"

  local table_resp
  table_resp=$(api_get "/system/lookup/tables/$name" || true)
  local table_id
  table_id=$(echo "$table_resp" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)

  local payload
  payload=$(cat <<JSON
{"title":"$title","name":"$name","description":"Lookup table for smart normalization","cache_id":"$cache_id","data_adapter_id":"$adapter_id","default_single_value":"$default_single","default_single_value_type":"STRING","default_multi_value":"{}","default_multi_value_type":"OBJECT"}
JSON
)

  if [ -n "$table_id" ]; then
    echo "$table_id"
  else
    local created
    created=$(api_post "/system/lookup/tables" "$payload")
    echo "$created" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || api_get "/system/lookup/tables/$name" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4
  fi
}

upsert_rule() {
  local title="$1"
  local source="$2"
  local rules_json
  rules_json=$(api_get "/system/pipelines/rule")

  local one_line
  one_line=$(printf '%s' "$rules_json" | tr -d '\n' | tr -d '\r')
  local rule_id
  rule_id=$(printf '%s' "$one_line" \
    | sed 's/},{/}\n{/g' \
    | grep "\"title\":\"$title\"" \
    | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' \
    | head -n1 \
    | tr -d '\r' || true)

  local payload
  payload=$(cat <<JSON
{"title":"$(json_escape "$title")","description":"Auto-generated smart normalization rule","source":"$(json_escape "$source")"}
JSON
)

  if [ -n "$rule_id" ]; then
    api_put "/system/pipelines/rule/$rule_id" "$payload" >/dev/null
  else
    api_post "/system/pipelines/rule" "$payload" >/dev/null
  fi
}

ensure_index_set() {
  local title="$1"
  local description="$2"
  local prefix="$3"
  local lifetime_min="$4"
  local lifetime_max="$5"
  local max_indices="$6"

  local index_sets_json
  index_sets_json=$(api_get "/system/indices/index_sets")
  local index_set_id
  index_set_id=$(echo "$index_sets_json" | grep -o '"id":"[^"]*","title":"[^"]*"' | grep '"title":"'"$title"'"' | head -n1 | cut -d'"' -f4 || true)

  local payload
  payload=$(cat <<JSON
{"title":"$title","description":"$description","index_prefix":"$prefix","shards":1,"replicas":0,"rotation_strategy_class":"org.graylog2.indexer.rotation.strategies.TimeBasedSizeOptimizingStrategy","rotation_strategy":{"type":"org.graylog2.indexer.rotation.strategies.TimeBasedSizeOptimizingStrategyConfig","index_lifetime_min":"$lifetime_min","index_lifetime_max":"$lifetime_max"},"retention_strategy_class":"org.graylog2.indexer.retention.strategies.DeletionRetentionStrategy","retention_strategy":{"type":"org.graylog2.indexer.retention.strategies.DeletionRetentionStrategyConfig","max_number_of_indices":$max_indices},"data_tiering":{"type":"hot_only","index_lifetime_min":"$lifetime_min","index_lifetime_max":"$lifetime_max"},"index_analyzer":"standard","index_optimization_max_num_segments":1,"index_optimization_disabled":false,"field_type_refresh_interval":5000,"use_legacy_rotation":false,"writable":true}
JSON
)

  if [ -z "$index_set_id" ]; then
    local created
    created=$(api_post "/system/indices/index_sets" "$payload")
    index_set_id=$(echo "$created" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4)
  fi

  api_put "/system/indices/index_sets/$index_set_id" "$payload" >/dev/null
  echo "$index_set_id"
}

ensure_stream() {
  local title="$1"
  local description="$2"
  local index_set_id="$3"
  # Faz C: tum yeni streamler default'tan ayrismali (cift sayim engellenir)
  local remove_default="${4:-true}"

  local streams_json
  streams_json=$(api_get "/streams")
  local one_line
  one_line=$(printf '%s' "$streams_json" | tr -d '\n' | tr -d '\r')
  local title_ids
  title_ids=$(printf '%s' "$one_line" \
    | sed 's/},{/}\n{/g' \
    | grep "\"title\":\"$title\"" \
    | sed -n 's/^{"id":"\([^"]*\)".*/\1/p' || true)

  local stream_id
  stream_id=$(printf '%s\n' "$title_ids" | head -n1 | tr -d '\r' || true)

  if [ -z "$stream_id" ]; then
    local payload
    payload=$(cat <<JSON
{"title":"$title","description":"$description","matching_type":"AND","remove_matches_from_default_stream":$remove_default,"index_set_id":"$index_set_id","rules":[]}
JSON
)
    local created
    created=$(api_post "/streams" "$payload")
    stream_id=$(echo "$created" | grep -o '"stream_id":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
  else
    # Var olan streami remove_matches_from_default_stream=true olarak normallestir (idempotent migration)
    local update_payload
    update_payload=$(cat <<JSON
{"title":"$title","description":"$description","matching_type":"AND","remove_matches_from_default_stream":$remove_default,"index_set_id":"$index_set_id","rules":[]}
JSON
)
    api_put "/streams/$stream_id" "$update_payload" >/dev/null 2>&1 || true
  fi

  if [ -n "$stream_id" ]; then
    # Dedupe: if duplicate stream titles exist, keep first one and remove others.
    local sid
    for sid in $(printf '%s\n' "$title_ids" | tr -d '\r'); do
      [ -z "$sid" ] && continue
      if [ "$sid" != "$stream_id" ]; then
        echo "  uyari: duplicate stream bulundu ('$title'): $sid siliniyor, korunacak=$stream_id" >&2
        curl -s "${AUTH_ARGS[@]}" -X DELETE "$GRAYLOG_API/streams/$sid" >/dev/null 2>&1 || true
      fi
    done
    curl -s "${AUTH_ARGS[@]}" -X POST "$GRAYLOG_API/streams/$stream_id/resume" >/dev/null 2>&1 || true
  fi

  echo "$stream_id"
}

ensure_stream_match_input_rule() {
  # raw_ingest stream'ine: gl2_source_input == <Kafka RAW Logs input id> kuralinda eslesen mesaj otomatik gelsin.
  local stream_id="$1"
  local input_id="$2"
  [ -z "$stream_id" ] && return 0
  [ -z "$input_id" ] && { echo "  uyari: kafka input id bulunamadi, raw_ingest stream rule eklenmeyecek"; return 0; }

  local rules_json
  rules_json=$(api_get "/streams/$stream_id/rules" || echo '{}')
  if echo "$rules_json" | grep -q "\"value\":\"$input_id\""; then
    echo "  raw_ingest <- input rule zaten mevcut"
    return 0
  fi

  # type 1 = exact match, field = gl2_source_input
  local rule_payload
  rule_payload=$(cat <<JSON
{"field":"gl2_source_input","type":1,"value":"$input_id","inverted":false,"description":"Auto-route Kafka raw logs to raw_ingest"}
JSON
)
  if api_post "/streams/$stream_id/rules" "$rule_payload" >/dev/null 2>&1; then
    echo "  raw_ingest <- input rule eklendi (input=$input_id)"
    # Stream'i resume etmek gerekiyor, aksi takdirde rule etkin olmaz
    curl -s "${AUTH_ARGS[@]}" -X POST "$GRAYLOG_API/streams/$stream_id/resume" >/dev/null 2>&1 || true
  else
    echo "  uyari: raw_ingest rule eklenemedi"
  fi
}

find_input_id_by_title() {
  # Python3 olmadan çalışır (post-init Alpine container'ı: yalnız curl + bash).
  # Strateji: array seviyesindeki "},{" boundary'lerinde split (nested {} korunur),
  # title'i match eden satirin id'sini al.
  local title="$1"
  local inputs_json
  inputs_json=$(api_get "/system/inputs" || echo '{}')
  local one_line
  one_line=$(printf '%s' "$inputs_json" | tr -d '\n' | tr -d '\r')
  printf '%s' "$one_line" | sed 's/},{/}\
{/g' | grep "\"title\":\"$title\"" | head -n1 | \
    sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

ensure_pipeline_connected() {
  local stream_id="$1"
  local pipeline_id="$2"
  local connections
  connections=$(api_get "/system/pipelines/connections/$stream_id" || true)

  if ! echo "$connections" | grep -q "$pipeline_id"; then
    local payload
    payload=$(cat <<JSON
{"stream_id":"$stream_id","pipeline_ids":["$pipeline_id"]}
JSON
)
    if ! api_post "/system/pipelines/connections" "$payload" >/dev/null 2>&1; then
      # Graylog sürümleri arasında endpoint farkı için fallback.
      api_post "/system/pipelines/connections/to_stream" "$payload" >/dev/null
    fi
  fi
}

if ! wait_for_graylog; then
  echo "⚠ ECS pipeline kurulamadı: Graylog API hazır değil (çıkış 0)."
  echo "  Sonra tekrar: docker compose run --rm --no-deps graylog-post-init"
  exit 0
fi

if ! api_get "/system/lookup/tables" >/dev/null 2>&1; then
  echo "✗ Graylog API kimlik doğrulama başarısız"
  exit 1
fi

echo "✓ Graylog API kimlik doğrulama başarılı"

echo "Index set ve stream ayrımı hazırlanıyor..."
RAW_INDEX_SET_ID=$(ensure_index_set "Raw Logs Index Set" "Immutable raw ingest logs (5651 source of truth)" "rawlog" "P180D" "P365D" 40)
CLEAN_INDEX_SET_ID=$(ensure_index_set "Clean Logs Index Set" "Normalized logs for dashboards and analytics" "cleanlog" "P14D" "P30D" 20)
LOG_SYSTEM_ENV=${LOG_SYSTEM_ENV:-dev}
DEV_INDEX_SET_ID=""
if [ "$LOG_SYSTEM_ENV" != "prod" ] && [ "$LOG_SYSTEM_ENV" != "production" ]; then
  DEV_INDEX_SET_ID=$(ensure_index_set "Dev/Test Logs Index Set" "Synthetic and dev/test-only logs (never promote to prod dashboards)" "devlog" "P7D" "P14D" 10)
fi

RAW_STREAM_ID=$(ensure_stream "raw_ingest" "All incoming raw logs (single source: Kafka logs_raw)" "$RAW_INDEX_SET_ID" true)
CLEAN_STREAM_ID=$(ensure_stream "clean_normalized" "Only normalization_status=success logs" "$CLEAN_INDEX_SET_ID" true)
QUALITY_STREAM_ID=$(ensure_stream "quality_control" "Unknown or newly discovered log formats for normalization review" "$CLEAN_INDEX_SET_ID" true)
DEV_TEST_STREAM_ID=""
if [ -n "$DEV_INDEX_SET_ID" ]; then
  DEV_TEST_STREAM_ID=$(ensure_stream "dev_test" "Synthetic/dev-test logs isolated from production analytics" "$DEV_INDEX_SET_ID" true)
fi
echo "✓ raw_ingest / clean_normalized / quality_control streamleri hazır (default'tan ayri)"

# Faz C: raw_ingest stream'ine "Kafka RAW Logs input'undan gelen her sey buraya akar" rule
KAFKA_INPUT_ID="$(find_input_id_by_title "Kafka RAW Logs")"
echo "  Kafka RAW Logs input id: '${KAFKA_INPUT_ID:-(bos)}'"
if [ -n "$KAFKA_INPUT_ID" ]; then
  ensure_stream_match_input_rule "$RAW_STREAM_ID" "$KAFKA_INPUT_ID"
else
  echo "  uyari: Kafka RAW Logs input bulunamadi -> stream rule eklenmeyecek (post-init'i Graylog input'lari hazir olduktan sonra calistirin)"
fi

echo "Lookup altyapısı hazırlanıyor..."
if [ -f /scripts/load-vendor-packs.sh ]; then
  echo "  vendor-packs CSV birleştiriliyor..."
  bash /scripts/load-vendor-packs.sh || echo "  uyarı: load-vendor-packs başarısız (devam ediliyor)"
fi
CACHE_ID=$(upsert_lookup_cache "normalization_cache" "Normalization Cache")
ADAPTER_RESOLVER_ID=$(upsert_lookup_adapter "profile_resolver_adapter" "Profile Resolver Adapter" "/etc/graylog/lookups/profile_resolver.csv")
ADAPTER_DISCOVERY_RESOLVER_ID=$(upsert_lookup_adapter "profile_discovery_resolver_adapter" "Profile Discovery Resolver Adapter" "/etc/graylog/lookups/profile_discovery_resolver.csv")
ADAPTER_SRC_ID=$(upsert_lookup_adapter "profile_source_field_adapter" "Profile Source Field Adapter" "/etc/graylog/lookups/profile_source_field.csv")
ADAPTER_DST_ID=$(upsert_lookup_adapter "profile_destination_field_adapter" "Profile Destination Field Adapter" "/etc/graylog/lookups/profile_destination_field.csv")

upsert_lookup_table "profile_resolver_lut" "profile_resolver_lut" "$ADAPTER_RESOLVER_ID" "$CACHE_ID" "unknown" >/dev/null
upsert_lookup_table "profile_discovery_resolver_lut" "profile_discovery_resolver_lut" "$ADAPTER_DISCOVERY_RESOLVER_ID" "$CACHE_ID" "unknown" >/dev/null
upsert_lookup_table "profile_source_field_lut" "profile_source_field_lut" "$ADAPTER_SRC_ID" "$CACHE_ID" "src" >/dev/null
upsert_lookup_table "profile_destination_field_lut" "profile_destination_field_lut" "$ADAPTER_DST_ID" "$CACHE_ID" "dst" >/dev/null
echo "✓ Lookup Data Adapter + Cache + Table kurulumları tamamlandı"

echo "Pipeline kuralları hazırlanıyor..."
upsert_rule "Unpack JSON message payload" 'rule "Unpack JSON message payload" when has_field("message") AND (is_json(to_string($message.message)) OR (substring(to_string($message.message), 0, 1) == "{")) then let parsed = parse_json(to_string($message.message)); set_fields(to_map(parsed)); end'
upsert_rule "Unpack KV message payload" 'rule "Unpack KV message payload" when has_field("message") AND (not is_json(to_string($message.message))) AND contains(to_string($message.message), "=") then let parsed = key_value(to_string($message.message)); set_fields(to_map(parsed)); end'

upsert_rule "Stage0 Route to raw_ingest" "rule \"Stage0 Route to raw_ingest\" when true then route_to_stream(name: \"raw_ingest\", remove_from_default: true); end"
if [ -n "$DEV_TEST_STREAM_ID" ]; then
  upsert_rule "Stage0 Route dev_test logs" "rule \"Stage0 Route dev_test logs\" when has_field(\"log_env\") AND lowercase(to_string(\$message.log_env)) == \"dev_test\" then route_to_stream(name: \"dev_test\", remove_from_default: true); end"
fi
upsert_rule "Stage0 Set pending status" "rule \"Stage0 Set pending status\" when true then set_field(\"normalization_status\", \"pending\"); end"
upsert_rule "Stage0 Ensure vendor" "rule \"Stage0 Ensure vendor\" when not has_field(\"vendor\") then set_field(\"vendor\", \"unknown\"); end"
upsert_rule "Stage0 Ensure product" "rule \"Stage0 Ensure product\" when not has_field(\"product\") then set_field(\"product\", \"unknown\"); end"
upsert_rule "Stage0 VMware Component Discovery" "rule \"Stage0 VMware Component Discovery\" when has_field(\"host\") AND (contains(to_string(\$message.host), \"vpxd\") OR contains(to_string(\$message.host), \"vsan\") OR contains(to_string(\$message.host), \"sps\") OR contains(to_string(\$message.host), \"vcenter\")) then set_field(\"vendor\", \"vmware\"); set_field(\"product\", \"vcenter\"); end"
upsert_rule "Stage0 Populate os_major from os_version" "rule \"Stage0 Populate os_major from os_version\" when (not has_field(\"os_major\")) AND has_field(\"os_version\") then set_field(\"os_major\", to_string(\$message.os_version)); end"
upsert_rule "Stage0 Ensure os_major" "rule \"Stage0 Ensure os_major\" when not has_field(\"os_major\") then set_field(\"os_major\", \"unknown\"); end"
upsert_rule "Stage1 Debug" "rule \"Stage1 Debug\" when true then set_field(\"debug_stage1\", \"running\"); end"
upsert_rule "Stage2 Debug" "rule \"Stage2 Debug\" when true then set_field(\"debug_stage2\", \"running\"); end"
upsert_rule "Stage0 Clean syslog_sender_ip" "rule \"Stage0 Clean syslog_sender_ip\" when has_field(\"syslog_sender_ip\") AND contains(to_string(\$message.syslog_sender_ip), \"://\") then let g = grok(pattern: \".*://%{IPORHOST:clean_ip}\", value: to_string(\$message.syslog_sender_ip), only_named_captures: true); set_field(\"syslog_sender_ip\", to_string(g.clean_ip)); end"
upsert_rule "Stage0 Discovery sender from syslog_sender_ip" "rule \"Stage0 Discovery sender from syslog_sender_ip\" when (not has_field(\"normalization_discovery_sender\")) AND has_field(\"syslog_sender_ip\") then set_field(\"normalization_discovery_sender\", lowercase(to_string(\$message.syslog_sender_ip))); end"
upsert_rule "Stage0 Discovery sender from source" "rule \"Stage0 Discovery sender from source\" when (not has_field(\"normalization_discovery_sender\")) AND has_field(\"source\") then set_field(\"normalization_discovery_sender\", lowercase(to_string(\$message.source))); end"
upsert_rule "Stage0 Discovery sender default" "rule \"Stage0 Discovery sender default\" when not has_field(\"normalization_discovery_sender\") then set_field(\"normalization_discovery_sender\", \"-\"); end"
upsert_rule "Stage0 Discovery host from host" "rule \"Stage0 Discovery host from host\" when (not has_field(\"normalization_discovery_host\")) AND has_field(\"host\") then set_field(\"normalization_discovery_host\", lowercase(to_string(\$message.host))); end"
upsert_rule "Stage0 Discovery host from hostname" "rule \"Stage0 Discovery host from hostname\" when (not has_field(\"normalization_discovery_host\")) AND has_field(\"hostname\") then set_field(\"normalization_discovery_host\", lowercase(to_string(\$message.hostname))); end"
upsert_rule "Stage0 Discovery host default" "rule \"Stage0 Discovery host default\" when not has_field(\"normalization_discovery_host\") then set_field(\"normalization_discovery_host\", \"-\"); end"
upsert_rule "Stage0 Discovery program from program" "rule \"Stage0 Discovery program from program\" when (not has_field(\"normalization_discovery_program\")) AND has_field(\"program\") then set_field(\"normalization_discovery_program\", lowercase(to_string(\$message.program))); end"
upsert_rule "Stage0 Discovery program from ident" "rule \"Stage0 Discovery program from ident\" when (not has_field(\"normalization_discovery_program\")) AND has_field(\"ident\") then set_field(\"normalization_discovery_program\", lowercase(to_string(\$message.ident))); end"
upsert_rule "Stage0 Discovery program default" "rule \"Stage0 Discovery program default\" when not has_field(\"normalization_discovery_program\") then set_field(\"normalization_discovery_program\", \"-\"); end"
upsert_rule "Stage0 Discovery log_source from field" "rule \"Stage0 Discovery log_source from field\" when (not has_field(\"normalization_discovery_log_source\")) AND has_field(\"log_source\") then set_field(\"normalization_discovery_log_source\", lowercase(to_string(\$message.log_source))); end"
upsert_rule "Stage0 Discovery log_source default" "rule \"Stage0 Discovery log_source default\" when not has_field(\"normalization_discovery_log_source\") then set_field(\"normalization_discovery_log_source\", \"-\"); end"
upsert_rule "Stage0 Build discovery key" "rule \"Stage0 Build discovery key\" when has_field(\"normalization_discovery_sender\") AND has_field(\"normalization_discovery_host\") AND has_field(\"normalization_discovery_program\") AND has_field(\"normalization_discovery_log_source\") then let dk = concat(concat(concat(to_string(\$message.normalization_discovery_sender), \"|\"), concat(to_string(\$message.normalization_discovery_host), \"|\")), concat(concat(to_string(\$message.normalization_discovery_program), \"|\"), to_string(\$message.normalization_discovery_log_source))); set_field(\"normalization_discovery_key\", dk); end"
upsert_rule "Stage0 Discovery key default" "rule \"Stage0 Discovery key default\" when not has_field(\"normalization_discovery_key\") then set_field(\"normalization_discovery_key\", \"-|-|-|-\"); end"
upsert_rule "Stage0 Build lookup key" "rule \"Stage0 Build lookup key\" when has_field(\"vendor\") AND has_field(\"product\") AND has_field(\"os_major\") then let lk = concat(concat(concat(lowercase(to_string(\$message.vendor)), \"|\"), lowercase(to_string(\$message.product))), concat(\"|\", to_string(\$message.os_major))); set_field(\"normalization_lookup_key\", lk); end"

upsert_rule "Stage1 Resolve profile from discovery lookup" "rule \"Stage1 Resolve profile from discovery lookup\" when has_field(\"normalization_discovery_key\") AND (to_string(lookup_value(\"profile_discovery_resolver_lut\", to_string(\$message.normalization_discovery_key), \"unknown\")) != \"unknown\") then let profile = to_string(lookup_value(\"profile_discovery_resolver_lut\", to_string(\$message.normalization_discovery_key), \"unknown\")); set_field(\"normalization_profile\", profile); end"
upsert_rule "Stage1 Resolve profile from lookup" "rule \"Stage1 Resolve profile from lookup\" when has_field(\"normalization_lookup_key\") then let profile = to_string(lookup_value(\"profile_resolver_lut\", to_string(\$message.normalization_lookup_key), \"unknown\")); set_field(\"normalization_profile\", profile); end"
upsert_rule "Stage1 Resolve alias fields" "rule \"Stage1 Resolve alias fields\" when has_field(\"normalization_lookup_key\") then let profile = to_string(lookup_value(\"profile_resolver_lut\", to_string(\$message.normalization_lookup_key), \"unknown\")); let src_field = to_string(lookup_value(\"profile_source_field_lut\", profile, \"src\")); let dst_field = to_string(lookup_value(\"profile_destination_field_lut\", profile, \"dst\")); set_field(\"normalization_src_field\", src_field); set_field(\"normalization_dst_field\", dst_field); end"
upsert_rule "Stage1 Resolve alias fields fallback profile" "rule \"Stage1 Resolve alias fields fallback profile\" when has_field(\"normalization_profile\") AND (to_string(\$message.normalization_profile) != \"unknown\") then let profile = to_string(\$message.normalization_profile); let src_field = to_string(lookup_value(\"profile_source_field_lut\", profile, \"src\")); let dst_field = to_string(lookup_value(\"profile_destination_field_lut\", profile, \"dst\")); set_field(\"normalization_src_field\", src_field); set_field(\"normalization_dst_field\", dst_field); end"
upsert_rule "Stage1 VendorPack VMware vCenter" "rule \"Stage1 VendorPack VMware vCenter\" when has_field(\"vendor\") AND lowercase(to_string(\$message.vendor)) == \"vmware\" AND has_field(\"product\") AND lowercase(to_string(\$message.product)) == \"vcenter\" then let g = grok(pattern: \"%{TIME:vcenter_time}\\\\+%{DATA:vcenter_tz} %{WORD:log_level} %{WORD:vcenter_process} \\\\[%{DATA:vcenter_thread}\\\\] \\\\[%{DATA:vcenter_context}\\\\] %{GREEDYDATA:vcenter_message}\", value: to_string(\$message.message), only_named_captures: true); set_fields(g); end"
upsert_rule "Stage1 Pass through" "rule \"Stage1 Pass through\" when true then set_field(\"normalization_stage1_seen\", \"true\"); end"

upsert_rule "Stage2 Keep status" "rule \"Stage2 Keep status\" when has_field(\"normalization_status\") then set_field(\"normalization_status\", to_string(\$message.normalization_status)); end"
upsert_rule "Stage2 Map source.ip dynamically" "rule \"Stage2 Map source.ip dynamically\" when has_field(\"normalization_src_field\") AND (to_string(\$message.normalization_src_field) != \"\") AND (not is_null(get_field(to_string(\$message.normalization_src_field)))) then set_field(\"source.ip\", to_string(get_field(to_string(\$message.normalization_src_field)))); end"
upsert_rule "Stage2 Map destination.ip dynamically" "rule \"Stage2 Map destination.ip dynamically\" when has_field(\"normalization_dst_field\") AND (to_string(\$message.normalization_dst_field) != \"\") AND (not is_null(get_field(to_string(\$message.normalization_dst_field)))) then set_field(\"destination.ip\", to_string(get_field(to_string(\$message.normalization_dst_field)))); end"
upsert_rule "Stage2 Fallback source.ip from syslog_sender_ip" "rule \"Stage2 Fallback source.ip from syslog_sender_ip\" when (not has_field(\"source.ip\")) AND has_field(\"syslog_sender_ip\") then set_field(\"source.ip\", to_string(\$message.syslog_sender_ip)); end"
upsert_rule "Stage2 Fallback source.ip from source_ip" "rule \"Stage2 Fallback source.ip from source_ip\" when (not has_field(\"source.ip\")) AND has_field(\"source_ip\") then set_field(\"source.ip\", to_string(\$message.source_ip)); end"
upsert_rule "Stage2 Fallback source.ip from src_ip" "rule \"Stage2 Fallback source.ip from src_ip\" when (not has_field(\"source.ip\")) AND has_field(\"src_ip\") then set_field(\"source.ip\", to_string(\$message.src_ip)); end"
upsert_rule "Stage2 Fallback source.ip from src" "rule \"Stage2 Fallback source.ip from src\" when (not has_field(\"source.ip\")) AND has_field(\"src\") then set_field(\"source.ip\", to_string(\$message.src)); end"
upsert_rule "Stage2 Fallback source.ip from client_ip" "rule \"Stage2 Fallback source.ip from client_ip\" when (not has_field(\"source.ip\")) AND has_field(\"client_ip\") then set_field(\"source.ip\", to_string(\$message.client_ip)); end"
upsert_rule "Stage2 Fallback destination.ip from destination_ip" "rule \"Stage2 Fallback destination.ip from destination_ip\" when (not has_field(\"destination.ip\")) AND has_field(\"destination_ip\") then set_field(\"destination.ip\", to_string(\$message.destination_ip)); end"
upsert_rule "Stage2 Fallback destination.ip from dst_ip" "rule \"Stage2 Fallback destination.ip from dst_ip\" when (not has_field(\"destination.ip\")) AND has_field(\"dst_ip\") then set_field(\"destination.ip\", to_string(\$message.dst_ip)); end"
upsert_rule "Stage2 Fallback destination.ip from dst" "rule \"Stage2 Fallback destination.ip from dst\" when (not has_field(\"destination.ip\")) AND has_field(\"dst\") then set_field(\"destination.ip\", to_string(\$message.dst)); end"
upsert_rule "Stage2 Fallback destination.ip from server_ip" "rule \"Stage2 Fallback destination.ip from server_ip\" when (not has_field(\"destination.ip\")) AND has_field(\"server_ip\") then set_field(\"destination.ip\", to_string(\$message.server_ip)); end"
upsert_rule "Stage2 Fallback event.category from category" "rule \"Stage2 Fallback event.category from category\" when (not has_field(\"event.category\")) AND has_field(\"category\") then set_field(\"event.category\", to_string(\$message.category)); end"
upsert_rule "Stage2 Fallback event.category from event_type" "rule \"Stage2 Fallback event.category from event_type\" when (not has_field(\"event.category\")) AND has_field(\"event_type\") then set_field(\"event.category\", to_string(\$message.event_type)); end"
upsert_rule "Stage2 Fallback event.category from log_type" "rule \"Stage2 Fallback event.category from log_type\" when (not has_field(\"event.category\")) AND has_field(\"log_type\") then set_field(\"event.category\", to_string(\$message.log_type)); end"
upsert_rule "Stage2 Fallback user.name from user" "rule \"Stage2 Fallback user.name from user\" when (not has_field(\"user.name\")) AND has_field(\"user\") then set_field(\"user.name\", to_string(\$message.user)); end"
upsert_rule "Stage2 Fallback user.name from username" "rule \"Stage2 Fallback user.name from username\" when (not has_field(\"user.name\")) AND has_field(\"username\") then set_field(\"user.name\", to_string(\$message.username)); end"
upsert_rule "Stage2 Fallback event.action from action" "rule \"Stage2 Fallback event.action from action\" when (not has_field(\"event.action\")) AND has_field(\"action\") then set_field(\"event.action\", to_string(\$message.action)); end"
upsert_rule "Stage2 Fallback host.name from hostname" "rule \"Stage2 Fallback host.name from hostname\" when (not has_field(\"host.name\")) AND has_field(\"hostname\") then set_field(\"host.name\", to_string(\$message.hostname)); end"
upsert_rule "Stage2 Fallback host.name from Computer" "rule \"Stage2 Fallback host.name from Computer\" when (not has_field(\"host.name\")) AND has_field(\"Computer\") then set_field(\"host.name\", to_string(\$message.Computer)); end"
upsert_rule "Stage2 Fallback host.name from host" "rule \"Stage2 Fallback host.name from host\" when (not has_field(\"host.name\")) AND has_field(\"host\") then set_field(\"host.name\", to_string(\$message.host)); end"

upsert_rule "Stage1 Linux Audit Normalization" 'rule "Stage1 Linux Audit Normalization" when has_field("message") AND contains(to_string($message.message), "arch=") AND contains(to_string($message.message), "syscall=") then let parsed = key_value(to_string($message.message)); set_fields(parsed); set_field("event.category", "process"); set_field("event.type", "info"); set_field("process.name", to_string($message.comm)); set_field("process.executable", to_string($message.exe)); set_field("process.pid", to_string($message.pid)); set_field("user.id", to_string($message.uid)); set_field("event.outcome", lowercase(to_string($message.success))); set_field("normalization_status", "success"); end'
upsert_rule "Stage1 Linux Cron Normalization" 'rule "Stage1 Linux Cron Normalization" when has_field("message") AND contains(to_string($message.message), "(root) CMD") then let g = grok(pattern: "\\(root\\) CMD \\( %{GREEDYDATA:cron_command} \\)", value: to_string($message.message)); set_fields(g); set_field("event.category", "process"); set_field("event.action", "cron_job"); set_field("normalization_status", "success"); end'
upsert_rule "Global Pass-through" 'rule "Global Pass-through" when true then set_field("normalization_pipeline_active", "true"); end'
upsert_rule "Stage2 Mark success for discovery profile" "rule \"Stage2 Mark success for discovery profile\" when has_field(\"normalization_profile\") AND (to_string(\$message.normalization_profile) != \"unknown\") AND (to_string(\$message.normalization_profile) != \"-\") then set_field(\"normalization_status\", \"success\"); end"
upsert_rule "Stage2 Mark normalization success" "rule \"Stage2 Mark normalization success\" when (has_field(\"source.ip\") AND has_field(\"destination.ip\")) OR (has_field(\"source.ip\") AND has_field(\"event.category\")) OR (has_field(\"source.ip\") AND has_field(\"user.name\")) OR (has_field(\"source.ip\") AND has_field(\"event.action\")) OR (has_field(\"source.ip\") AND has_field(\"host.name\")) OR (has_field(\"destination.ip\") AND has_field(\"event.category\")) OR (has_field(\"destination.ip\") AND has_field(\"user.name\")) OR (has_field(\"destination.ip\") AND has_field(\"event.action\")) OR (has_field(\"destination.ip\") AND has_field(\"host.name\")) OR (has_field(\"event.category\") AND has_field(\"user.name\")) OR (has_field(\"event.category\") AND has_field(\"event.action\")) OR (has_field(\"event.category\") AND has_field(\"host.name\")) OR (has_field(\"user.name\") AND has_field(\"event.action\")) OR (has_field(\"user.name\") AND has_field(\"host.name\")) OR (has_field(\"event.action\") AND has_field(\"host.name\")) then set_field(\"normalization_status\", \"success\"); end"
upsert_rule "Stage3 Mark needs_profile" "rule \"Stage3 Mark needs_profile\" when (to_string(\$message.normalization_status) == \"pending\") AND ((not has_field(\"normalization_profile\")) OR (to_string(\$message.normalization_profile) == \"unknown\")) then set_field(\"normalization_status\", \"needs_profile\"); set_field(\"normalization_alert\", \"Yeni bir log formatı keşfedildi\"); end"
upsert_rule "Stage3 Score ecs success" "rule \"Stage3 Score ecs success\" when to_string(\$message.normalization_status) == \"success\" then set_field(\"ecs_parse_quality\", \"100\"); end"
upsert_rule "Stage3 Score ecs needs profile" "rule \"Stage3 Score ecs needs profile\" when to_string(\$message.normalization_status) == \"needs_profile\" then set_field(\"ecs_parse_quality\", \"25\"); end"
upsert_rule "Stage3 Score ecs pending" "rule \"Stage3 Score ecs pending\" when to_string(\$message.normalization_status) == \"pending\" then set_field(\"ecs_parse_quality\", \"50\"); end"
upsert_rule "Stage3 Route to quality_control" "rule \"Stage3 Route to quality_control\" when (to_string(\$message.normalization_status) == \"needs_profile\") OR (not has_field(\"normalization_profile\")) OR (to_string(\$message.normalization_profile) == \"unknown\") OR (to_string(\$message.normalization_status) == \"pending\") then route_to_stream(name: \"quality_control\", remove_from_default: true); end"
upsert_rule "Stage3 Route success to clean_normalized" "rule \"Stage3 Route success to clean_normalized\" when to_string(\$message.normalization_status) == \"success\" then route_to_stream(name: \"clean_normalized\", remove_from_default: true); end"

PIPELINES_JSON=$(api_get "/system/pipelines/pipeline")
PIPELINE_ID=$(echo "$PIPELINES_JSON" | grep -o '"id":"[^"]*","title":"ECS Normalization Pipeline"' | head -n1 | cut -d'"' -f4 || true)

PIPELINE_PAYLOAD=$(cat <<'JSON'
{"title":"ECS Normalization Pipeline","description":"Smart 8-stage normalization pipeline","source":"pipeline \"ECS Normalization Pipeline\"\nstage 0 match either\n  rule \"Unpack JSON message payload\";\n  rule \"Unpack KV message payload\";\n  rule \"Global Pass-through\";\nstage 1 match either\n  rule \"Stage1 Debug\";\n  rule \"Stage0 Clean syslog_sender_ip\";\n  rule \"Stage0 Route to raw_ingest\";\n  rule \"Stage0 Set pending status\";\n  rule \"Global Pass-through\";\nstage 2 match either\n  rule \"Stage2 Debug\";\n  rule \"Stage0 Ensure vendor\";\n  rule \"Stage0 Ensure product\";\n  rule \"Stage0 VMware Component Discovery\";\n  rule \"Stage0 Populate os_major from os_version\";\n  rule \"Stage0 Ensure os_major\";\n  rule \"Stage0 Discovery sender from syslog_sender_ip\";\n  rule \"Stage0 Discovery sender from source\";\n  rule \"Stage0 Discovery host from host\";\n  rule \"Stage0 Discovery host from hostname\";\n  rule \"Stage0 Discovery program from program\";\n  rule \"Stage0 Discovery program from ident\";\n  rule \"Stage0 Discovery log_source from field\";\n  rule \"Global Pass-through\";\nstage 3 match either\n  rule \"Stage0 Discovery sender default\";\n  rule \"Stage0 Discovery host default\";\n  rule \"Stage0 Discovery program default\";\n  rule \"Stage0 Discovery log_source default\";\n  rule \"Global Pass-through\";\nstage 4 match either\n  rule \"Stage0 Build discovery key\";\n  rule \"Stage0 Discovery key default\";\n  rule \"Stage0 Build lookup key\";\n  rule \"Global Pass-through\";\nstage 5 match either\n  rule \"Stage1 Resolve profile from discovery lookup\";\n  rule \"Stage1 Resolve profile from lookup\";\n  rule \"Stage1 Resolve alias fields\";\n  rule \"Stage1 Resolve alias fields fallback profile\";\n  rule \"Stage1 VendorPack VMware vCenter\";\n  rule \"Stage1 Linux Audit Normalization\";\n  rule \"Stage1 Linux Cron Normalization\";\n  rule \"Stage1 Pass through\";\n  rule \"Global Pass-through\";\nstage 6 match either\n  rule \"Stage2 Keep status\";\n  rule \"Stage2 Map source.ip dynamically\";\n  rule \"Stage2 Map destination.ip dynamically\";\n  rule \"Stage2 Fallback source.ip from syslog_sender_ip\";\n  rule \"Stage2 Fallback source.ip from source_ip\";\n  rule \"Stage2 Fallback source.ip from src_ip\";\n  rule \"Stage2 Fallback source.ip from src\";\n  rule \"Stage2 Fallback source.ip from client_ip\";\n  rule \"Stage2 Fallback destination.ip from destination_ip\";\n  rule \"Stage2 Fallback destination.ip from dst_ip\";\n  rule \"Stage2 Fallback destination.ip from dst\";\n  rule \"Stage2 Fallback destination.ip from server_ip\";\n  rule \"Stage2 Fallback event.category from category\";\n  rule \"Stage2 Fallback event.category from event_type\";\n  rule \"Stage2 Fallback event.category from log_type\";\n  rule \"Stage2 Fallback user.name from user\";\n  rule \"Stage2 Fallback user.name from username\";\n  rule \"Stage2 Fallback event.action from action\";\n  rule \"Stage2 Fallback host.name from hostname\";\n  rule \"Stage2 Fallback host.name from Computer\";\n  rule \"Stage2 Fallback host.name from host\";\n  rule \"Stage2 Mark success for discovery profile\";\n  rule \"Stage2 Mark normalization success\";\n  rule \"Global Pass-through\";\nstage 7 match either\n  rule \"Stage3 Mark needs_profile\";\n  rule \"Stage3 Score ecs success\";\n  rule \"Stage3 Score ecs needs profile\";\n  rule \"Stage3 Score ecs pending\";\n  rule \"Global Pass-through\";\nstage 8 match either\n  rule \"Stage3 Route to quality_control\";\n  rule \"Stage3 Route success to clean_normalized\";\n  rule \"Global Pass-through\";\nend"}
JSON
)

# Prevent mutually exclusive Stage 3 routes from being blocked.
PIPELINE_PAYLOAD="${PIPELINE_PAYLOAD//stage 3 match all/stage 3 match either}"

if [ -n "$PIPELINE_ID" ]; then
  api_put "/system/pipelines/pipeline/$PIPELINE_ID" "$PIPELINE_PAYLOAD" >/dev/null
else
  CREATED_PIPELINE=$(api_post "/system/pipelines/pipeline" "$PIPELINE_PAYLOAD")
  PIPELINE_ID=$(echo "$CREATED_PIPELINE" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
fi

if [ -n "$PIPELINE_ID" ]; then
  # Faz C: Pipeline default stream yerine raw_ingest stream'ine baglanir.
  # Default stream artik sadece "kayip / yanlis girise dusmus" mesajlarin gorulebildigi guvenlik agi.
  ensure_pipeline_connected "$RAW_STREAM_ID" "$PIPELINE_ID"
  # Eski kurulumda default'a bagliysa, oradan kaldirmaya da calis (idempotent)
  # Python3 yok (Alpine post-init); sed ile pipeline_ids icindeki PIPELINE_ID'yi cikar
  DEFAULT_PIPE_CONN=$(api_get "/system/pipelines/connections/000000000000000000000001" 2>/dev/null || echo '{}')
  if echo "$DEFAULT_PIPE_CONN" | grep -q "\"$PIPELINE_ID\""; then
    echo "  Default stream'den eski pipeline baglantisi temizleniyor..."
    # pipeline_ids alanini al, PIPELINE_ID'yi kaldir, kalan ID'leri quoted virgulle birak
    REMAIN_IDS=$(printf '%s' "$DEFAULT_PIPE_CONN" | grep -oE '"pipeline_ids":\[[^]]*\]' | \
      sed 's/.*"pipeline_ids":\[//; s/\]$//' | \
      tr ',' '\n' | grep -v "\"$PIPELINE_ID\"" | tr '\n' ',' | sed 's/,$//')
    api_post "/system/pipelines/connections/to_stream" \
      "{\"stream_id\":\"000000000000000000000001\",\"pipeline_ids\":[$REMAIN_IDS]}" >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "✓ Smart Normalization kurulum tamamlandı"
echo "  - raw index set: ${RAW_INDEX_SET_ID:-n/a}"
echo "  - clean index set: ${CLEAN_INDEX_SET_ID:-n/a}"
echo "  - raw_ingest stream: ${RAW_STREAM_ID:-n/a} (pipeline burada calisir)"
echo "  - clean_normalized stream: ${CLEAN_STREAM_ID:-n/a}"
echo "  - quality_control stream: ${QUALITY_STREAM_ID:-n/a}"
echo "  - 4-stage pipeline aktif (default stream'den ayri)"
echo "  - Tek raw kaynak: Kafka logs_raw -> RawKafkaInput -> raw_ingest stream"
