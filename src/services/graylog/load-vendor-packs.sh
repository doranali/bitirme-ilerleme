#!/usr/bin/env bash
# Vendor pack CSV birlestirme: repo icindeki vendor-packs/*/ altindaki lookup ekleri,
# lookups/*.csv ile birlestirilir (son gelen ayni key'i override eder; idempotent).
# Calistir: graylog-post-init ortaminda /scripts/load-vendor-packs.sh
# Host'ta: bash src/services/graylog/load-vendor-packs.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOKUP_DIR="${LOOKUP_DIR:-$SCRIPT_DIR/lookups}"
PACKS_DIR="${PACKS_DIR:-$SCRIPT_DIR/vendor-packs}"

merge_kv_csv() {
  local outfile="$1"
  shift
  declare -A rows
  local line key
  local -a files=("$@")
  for f in "${files[@]}"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      [[ "$line" == key,value ]] && continue
      key="${line%%,*}"
      [[ -z "$key" ]] && continue
      rows["$key"]="$line"
    done < "$f"
  done
  {
    printf '%s\n' 'key,value'
    local -a sorted
    mapfile -t sorted < <(printf '%s\n' "${!rows[@]}" | LC_ALL=C sort)
    for k in "${sorted[@]}"; do
      [[ -z "$k" ]] && continue
      printf '%s\n' "${rows[$k]}"
    done
  } >"$outfile.tmp"
  mv -f "$outfile.tmp" "$outfile"
}

main() {
  if [[ ! -d "$LOOKUP_DIR" ]]; then
    echo "load-vendor-packs: lookups dizini yok: $LOOKUP_DIR" >&2
    exit 1
  fi

  local base_r="$LOOKUP_DIR/profile_resolver.csv"
  local base_dr="$LOOKUP_DIR/profile_discovery_resolver.csv"
  local base_s="$LOOKUP_DIR/profile_source_field.csv"
  local base_d="$LOOKUP_DIR/profile_destination_field.csv"

  for required in "$base_r" "$base_dr" "$base_s" "$base_d"; do
    if [[ ! -f "$required" ]]; then
      echo "load-vendor-packs: eksik dosya: $required" >&2
      exit 1
    fi
  done

  local -a pr_files=("$base_r")
  local -a pdr_files=("$base_dr")
  local -a ps_files=("$base_s")
  local -a pd_files=("$base_d")

  if [[ -d "$PACKS_DIR" ]]; then
    local d
    for d in "$PACKS_DIR"/*; do
      [[ -d "$d" ]] || continue
      [[ -f "$d/profile_resolver.csv" ]] && pr_files+=("$d/profile_resolver.csv")
      [[ -f "$d/profile_discovery_resolver.csv" ]] && pdr_files+=("$d/profile_discovery_resolver.csv")
      [[ -f "$d/profile_source_field.csv" ]] && ps_files+=("$d/profile_source_field.csv")
      [[ -f "$d/profile_destination_field.csv" ]] && pd_files+=("$d/profile_destination_field.csv")
    done
  fi

  merge_kv_csv "$LOOKUP_DIR/profile_resolver.merged.csv" "${pr_files[@]}"
  merge_kv_csv "$LOOKUP_DIR/profile_discovery_resolver.merged.csv" "${pdr_files[@]}"
  merge_kv_csv "$LOOKUP_DIR/profile_source_field.merged.csv" "${ps_files[@]}"
  merge_kv_csv "$LOOKUP_DIR/profile_destination_field.merged.csv" "${pd_files[@]}"

  mv -f "$LOOKUP_DIR/profile_resolver.merged.csv" "$LOOKUP_DIR/profile_resolver.csv"
  mv -f "$LOOKUP_DIR/profile_discovery_resolver.merged.csv" "$LOOKUP_DIR/profile_discovery_resolver.csv"
  mv -f "$LOOKUP_DIR/profile_source_field.merged.csv" "$LOOKUP_DIR/profile_source_field.csv"
  mv -f "$LOOKUP_DIR/profile_destination_field.merged.csv" "$LOOKUP_DIR/profile_destination_field.csv"

  echo "load-vendor-packs: ${#pr_files[@]} resolver katmani, ${#pdr_files[@]} discovery resolver, ${#ps_files[@]} source, ${#pd_files[@]} dest birlestirildi -> $LOOKUP_DIR"
}

main "$@"
