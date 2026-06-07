#!/bin/bash
# Apply OpenSearch ISM policy (90 gün retention) ve best_compression index template
# 90 gün: Grafana/Graylog tam aranabilir; WORM 2 yıl ayrı (DISK_SIKISTIRMA_MIMARISI_90GUN.md)
# Run after OpenSearch is healthy. Requires OPENSEARCH_URL and auth (host modunda).
#
# Öncelik: opensearch1 konteyneri içinden curl — OPENSEARCH_INITIAL_ADMIN_PASSWORD ile
# aynı ortam (kurulum/host .env parse veya CRLF farklarından kaynaklı Unauthorized önlenir).
# Yedek: host üzerinden OPENSEARCH_URL (https://127.0.0.1:9200) ve --user ile tırnaklı parola.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [ -f "$ENV_FILE" ] && [ -z "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-}" ] && [ -z "${OPENSEARCH_PASSWORD:-}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Host'tan çalıştırıldığında localhost kullan (opensearch1 sadece Docker ağında çözümlenir)
OPENSEARCH_URL="${OPENSEARCH_URL:-https://127.0.0.1:9200}"
OPENSEARCH_USER="${OPENSEARCH_USER:-admin}"
# Konteyner OPENSEARCH_INITIAL_ADMIN_PASSWORD kullanır; .env'de PASSWORD eski/ayrı kalabildiğinde önce INITIAL kullan
OPENSEARCH_PASSWORD="${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-${OPENSEARCH_PASSWORD:-admin}}"

POLICY_FILE="${POLICY_FILE:-$ROOT_DIR/src/config/opensearch/ism-policy-90gun.json}"
POLICY_ID="${POLICY_ID:-graylog-90gun}"
TEMPLATE_FILE="${ROOT_DIR}/src/config/opensearch/index-template-cleanlog-strict.json"
TEMPLATE_NAME="${TEMPLATE_NAME:-cleanlog-strict}"
RAWLOG_TEMPLATE_FILE="${ROOT_DIR}/src/config/opensearch/index-template-rawlog-discovery.json"
RAWLOG_TEMPLATE_NAME="${RAWLOG_TEMPLATE_NAME:-rawlog-discovery}"
ECS_COMPONENTS=(
  "component-template-ecs-base"
  "component-template-ecs-extended"
  "component-template-vendor-overlay"
  "component-template-tenant"
)

strip_env() {
  # .env CRLF ve baş/son boşluk (Unauthorized'ın sık nedeni)
  printf '%s' "${1:-}" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

OPENSEARCH_USER="$(strip_env "$OPENSEARCH_USER")"
OPENSEARCH_PASSWORD="$(strip_env "$OPENSEARCH_PASSWORD")"
OPENSEARCH_INITIAL_ADMIN_PASSWORD="$(strip_env "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-}")"
if [ -n "$OPENSEARCH_INITIAL_ADMIN_PASSWORD" ]; then
  OPENSEARCH_PASSWORD="$(strip_env "${OPENSEARCH_INITIAL_ADMIN_PASSWORD:-$OPENSEARCH_PASSWORD}")"
fi

echo "=== OpenSearch 90 Gün Disk Optimizasyonu ==="

POLICY_OK=0
TEMPLATE_OK=0

compose_opensearch_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -f "$ROOT_DIR/docker-compose.yml" ] || return 1
  (
    cd "$ROOT_DIR" || exit 1
    local args=()
    [ -f "$ENV_FILE" ] && args+=(--env-file "$ENV_FILE")
    docker compose "${args[@]}" ps -q --status running opensearch1 2>/dev/null | grep -q .
  )
}

apply_policy_curl() {
  local url="$1"
  local user="$2"
  local pass="$3"
  local outfile http
  outfile=$(mktemp)
  http=$(curl -sk -o "$outfile" -w '%{http_code}' --max-time 120 \
    --user "${user}:${pass}" \
    -X PUT "${url}/_plugins/_ism/policies/${POLICY_ID}" \
    -H "Content-Type: application/json" \
    --data-binary @"$POLICY_FILE" 2>/dev/null || echo "000")
  RESP=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  if [ "$http" = "409" ] && echo "$RESP" | grep -q 'version_conflict_engine_exception'; then
    return 0
  fi
  if { [ "$http" = "200" ] || [ "$http" = "201" ]; } && echo "$RESP" | grep -q '"policy_id"'; then
    return 0
  fi
  [ -z "$RESP" ] && RESP="(HTTP ${http}, boş gövde — ${url} / kimlik doğrulama)"
  echo "$RESP"
  return 1
}

apply_template_curl() {
  local url="$1"
  local user="$2"
  local pass="$3"
  local template_file="$4"
  local template_name="$5"
  local outfile http
  outfile=$(mktemp)
  http=$(curl -sk -o "$outfile" -w '%{http_code}' --max-time 120 \
    --user "${user}:${pass}" \
    -X PUT "${url}/_index_template/${template_name}" \
    -H "Content-Type: application/json" \
    --data-binary @"$template_file" 2>/dev/null || echo "000")
  RESP=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  if { [ "$http" = "200" ] || [ "$http" = "201" ]; } && echo "$RESP" | grep -q '"acknowledged"'; then
    return 0
  fi
  [ -z "$RESP" ] && RESP="(HTTP ${http}, boş gövde — ${url} / kimlik doğrulama)"
  echo "$RESP"
  return 1
}

apply_component_template_curl() {
  local url="$1"
  local user="$2"
  local pass="$3"
  local template_file="$4"
  local template_name="$5"
  local outfile http
  outfile=$(mktemp)
  http=$(curl -sk -o "$outfile" -w '%{http_code}' --max-time 120 \
    --user "${user}:${pass}" \
    -X PUT "${url}/_component_template/${template_name}" \
    -H "Content-Type: application/json" \
    --data-binary @"$template_file" 2>/dev/null || echo "000")
  RESP=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  if { [ "$http" = "200" ] || [ "$http" = "201" ]; } && echo "$RESP" | grep -q '"acknowledged"'; then
    return 0
  fi
  [ -z "$RESP" ] && RESP="(HTTP ${http}, boş gövde — ${url} / kimlik doğrulama)"
  echo "$RESP"
  return 1
}

apply_via_compose_exec() {
  [ -f "$POLICY_FILE" ] || return 1
  [ -f "$TEMPLATE_FILE" ] || return 1
  compose_opensearch_running || return 1
  local args=()
  [ -f "$ENV_FILE" ] && args+=(--env-file "$ENV_FILE")

  local pol_http pol_json tmpl_http tmpl_json
  # shellcheck disable=SC2016
  pol_http=$(docker compose -f "$ROOT_DIR/docker-compose.yml" "${args[@]}" exec -T opensearch1 sh -eu -c "
    curl -sk -o /tmp/ism_p.json -w '%{http_code}' --max-time 120 \\
      -u \"admin:\${OPENSEARCH_INITIAL_ADMIN_PASSWORD}\" \\
      -X PUT \"https://127.0.0.1:9200/_plugins/_ism/policies/${POLICY_ID}\" \\
      -H 'Content-Type: application/json' \\
      --data-binary @-
  " <"$POLICY_FILE") || return 1
  pol_http=$(printf '%s' "$pol_http" | tr -d ' \n\r')
  pol_json=$(docker compose -f "$ROOT_DIR/docker-compose.yml" "${args[@]}" exec -T opensearch1 cat /tmp/ism_p.json 2>/dev/null) || return 1
  if [ "$pol_http" = "409" ] && echo "$pol_json" | grep -q 'version_conflict_engine_exception'; then
    POLICY_OK=1
  elif { [ "$pol_http" = "200" ] || [ "$pol_http" = "201" ]; } && echo "$pol_json" | grep -q '"policy_id"'; then
    POLICY_OK=1
  else
    echo "⚠ ISM policy (compose exec): $(printf '%.600s' "$pol_json") (HTTP ${pol_http:-?})"
  fi

  for comp in "${ECS_COMPONENTS[@]}"; do
    comp_file="$ROOT_DIR/src/config/opensearch/${comp}.json"
    [ -f "$comp_file" ] || continue
    echo "→ component $comp"
    docker compose -f "$ROOT_DIR/docker-compose.yml" "${args[@]}" exec -T opensearch1 sh -eu -c "
      curl -sk -o /tmp/comp.json -w '%{http_code}' --max-time 120 \\
        -u \"admin:\${OPENSEARCH_INITIAL_ADMIN_PASSWORD}\" \\
        -X PUT \"https://127.0.0.1:9200/_component_template/${comp}\" \\
        -H 'Content-Type: application/json' \\
        --data-binary @-
    " <"$comp_file" >/dev/null 2>&1 || true
  done

  # shellcheck disable=SC2016
  tmpl_http=$(docker compose -f "$ROOT_DIR/docker-compose.yml" "${args[@]}" exec -T opensearch1 sh -eu -c "
    curl -sk -o /tmp/ism_t.json -w '%{http_code}' --max-time 120 \\
      -u \"admin:\${OPENSEARCH_INITIAL_ADMIN_PASSWORD}\" \\
      -X PUT \"https://127.0.0.1:9200/_index_template/${TEMPLATE_NAME}\" \\
      -H 'Content-Type: application/json' \\
      --data-binary @-
  " <"$TEMPLATE_FILE") || return 1
  tmpl_http=$(printf '%s' "$tmpl_http" | tr -d ' \n\r')
  tmpl_json=$(docker compose -f "$ROOT_DIR/docker-compose.yml" "${args[@]}" exec -T opensearch1 cat /tmp/ism_t.json 2>/dev/null) || return 1
  if { [ "$tmpl_http" = "200" ] || [ "$tmpl_http" = "201" ]; } && echo "$tmpl_json" | grep -q '"acknowledged"'; then
    TEMPLATE_OK=1
  else
    echo "⚠ Index template (compose exec): $(printf '%.600s' "$tmpl_json") (HTTP ${tmpl_http:-?})"
  fi

  [ "$POLICY_OK" = "1" ] && [ "$TEMPLATE_OK" = "1" ]
}

apply_via_host_curl() {
  local url="${OPENSEARCH_URL%/}"
  local user="$OPENSEARCH_USER"
  local pass="$OPENSEARCH_PASSWORD"
  if [ -f "$POLICY_FILE" ]; then
    if RESP=$(apply_policy_curl "$url" "$user" "$pass" 2>&1); then
      echo "✓ ISM policy uygulandı: $POLICY_ID (90 gün retention)"
      POLICY_OK=1
    else
      echo "⚠ ISM policy uygulanamadı: $RESP"
    fi
  else
    echo "⚠ Policy dosyası bulunamadı: $POLICY_FILE"
  fi

  if [ -f "$TEMPLATE_FILE" ]; then
    if RESP=$(apply_template_curl "$url" "$user" "$pass" "$TEMPLATE_FILE" "$TEMPLATE_NAME" 2>&1); then
      echo "✓ Index template uygulandı: best_compression (yeni indeksler için)"
      TEMPLATE_OK=1
    else
      echo "⚠ Index template uygulanamadı: $RESP"
    fi
  else
    echo "ℹ Index template dosyası yok: $TEMPLATE_FILE"
  fi
  for comp in "${ECS_COMPONENTS[@]}"; do
    comp_file="$ROOT_DIR/src/config/opensearch/${comp}.json"
    [ -f "$comp_file" ] || continue
    if RESP=$(apply_component_template_curl "$url" "$user" "$pass" "$comp_file" "$comp" 2>&1); then
      echo "✓ Component template: $comp"
    else
      echo "⚠ Component $comp: $RESP"
    fi
  done
  if [ -f "$RAWLOG_TEMPLATE_FILE" ]; then
    if RESP=$(apply_template_curl "$url" "$user" "$pass" "$RAWLOG_TEMPLATE_FILE" "$RAWLOG_TEMPLATE_NAME" 2>&1); then
      echo "✓ Rawlog discovery template uygulandı"
    else
      echo "⚠ Rawlog template uygulanamadı: $RESP"
    fi
  fi
  [ "$POLICY_OK" = "1" ] && [ "$TEMPLATE_OK" = "1" ]
}

# 1) Konteyner içi (önerilen — kurulum ile aynı kimlik bilgisi)
if apply_via_compose_exec 2>/dev/null; then
  echo "✓ ISM policy uygulandı: $POLICY_ID (90 gün retention)"
  echo "✓ Index template uygulandı: best_compression (yeni indeksler için)"
  echo "=== Tamamlandı (docker compose exec opensearch1) ==="
  exit 0
fi
POLICY_OK=0
TEMPLATE_OK=0

# 2) Host curl yedeği
apply_via_host_curl || true

echo "=== Tamamlandı ==="
[ "$POLICY_OK" = "1" ] && [ "$TEMPLATE_OK" = "1" ] && exit 0 || exit 1
