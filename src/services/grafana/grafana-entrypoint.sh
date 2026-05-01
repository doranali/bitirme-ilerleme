#!/bin/sh
set -eu
# Root: bind mount edilen /var/lib/grafana çoğu kurulumda root sahipli; 472 yazabilsin.
# Ardından provisioning üretilir; Grafana süreci grafana kullanıcısı ile başlar (su-exec).

GRAFANA_USER="${GRAFANA_CONTAINER_USER:-grafana}"
GRAFANA_UID="$(id -u "$GRAFANA_USER" 2>/dev/null || echo 472)"
GRAFANA_GID="$(id -g "$GRAFANA_USER" 2>/dev/null || echo 0)"

ensure_paths_writable() {
  for dir in /var/lib/grafana /var/log/grafana; do
    if [ ! -d "$dir" ]; then
      mkdir -p "$dir" 2>/dev/null || true
    fi
    if [ -d "$dir" ]; then
      chown -R "${GRAFANA_UID}:${GRAFANA_GID}" "$dir" 2>/dev/null || {
        echo "grafana-entrypoint: UYARI: ${dir} chown başarısız (NFS/root_squash?). Hostta çalıştırın: scripts/ensure-grafana-data-perms.sh" >&2
      }
      chmod -R u+rwX "$dir" 2>/dev/null || true
    fi
  done
}

ensure_paths_writable

python3 /usr/local/bin/render_grafana_datasources.py
DS_OUT="${GRAFANA_DATASOURCES_OUT:-/etc/grafana/provisioning/datasources/datasources.yaml}"
if [ -f "$DS_OUT" ]; then
  chown "${GRAFANA_UID}:${GRAFANA_GID}" "$DS_OUT" 2>/dev/null || true
fi

exec su-exec "$GRAFANA_USER" /run.sh "$@"
