# OpenSearch datasource: eklenti imajda (zip GitHub); provisioning Python ile ortamdan üretilir.
# Entrypoint root ile başlar: bind mount izinleri düzeltilir, sonra su-exec grafana /run.sh.
FROM grafana/grafana:11.5.0

USER root

RUN apk add --no-cache python3 py3-yaml su-exec

ARG TARGETARCH=amd64
ARG OPENSEARCH_DS_VERSION=2.23.0
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) PLUGIN_ARCH=linux_amd64 ;; \
      arm64) PLUGIN_ARCH=linux_arm64 ;; \
      *) PLUGIN_ARCH=linux_amd64 ;; \
    esac; \
    PLUGIN_ZIP="https://github.com/grafana/opensearch-datasource/releases/download/v${OPENSEARCH_DS_VERSION}/grafana-opensearch-datasource-${OPENSEARCH_DS_VERSION}.${PLUGIN_ARCH}.zip"; \
    mkdir -p /opt/grafana-plugins; \
    /usr/share/grafana/bin/grafana-cli \
      --pluginsDir /opt/grafana-plugins \
      --pluginUrl "$PLUGIN_ZIP" \
      plugins install grafana-opensearch-datasource; \
    chown -R 472:0 /opt/grafana-plugins

COPY src/services/grafana/render_grafana_datasources.py /usr/local/bin/render_grafana_datasources.py
RUN chmod +x /usr/local/bin/render_grafana_datasources.py

COPY src/services/grafana/grafana-entrypoint.sh /grafana-entrypoint.sh
RUN chmod +x /grafana-entrypoint.sh

ENV GF_PATHS_PLUGINS=/opt/grafana-plugins

ENTRYPOINT ["/grafana-entrypoint.sh"]
