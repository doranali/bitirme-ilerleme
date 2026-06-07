#!/usr/bin/env python3
"""
Grafana OpenSearch datasource provisioning — ortam değişkenlerinden üretilir.
Sabit parola içermez; OPENSEARCH_INITIAL_ADMIN_PASSWORD veya OPENSEARCH_PASSWORD kullanılır.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml


def _truthy(name: str, default: str = "true") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _resolve_password() -> str:
    for key in ("OPENSEARCH_INITIAL_ADMIN_PASSWORD", "OPENSEARCH_PASSWORD"):
        v = (os.environ.get(key) or "").strip()
        if v:
            return v
    return ""


def _resolve_url() -> str:
    for key in (
        "GRAFANA_OPENSEARCH_URL",
        "OPENSEARCH_INTERNAL_URL",
    ):
        v = (os.environ.get(key) or "").strip().rstrip("/")
        if v:
            return v
    return "https://opensearch1:9200"


def main() -> int:
    password = _resolve_password()
    url = _resolve_url()
    user = (os.environ.get("OPENSEARCH_USER") or "admin").strip()
    tls_skip = _truthy("OPENSEARCH_TLS_SKIP_VERIFY", "true")
    flavor_version = (os.environ.get("GRAFANA_OPENSEARCH_VERSION") or "2.18.0").strip()
    # Olay zamanı alanı: ECS standardı `@timestamp` (ISO8601 UTC, sonu `Z`). Belgelerde
    # ayrıca TZ'siz özel formatlı `timestamp` ve yerel ofsetli `event_created` bulunur;
    # `@timestamp` belirsizlik/timezone kayması yaşatmadan UTC instant'ı taşır. Alert
    # rules.yaml de `@timestamp` kullanır — datasource ile birebir tutarlılık şart.
    time_field = (os.environ.get("GRAFANA_OPENSEARCH_TIME_FIELD") or "@timestamp").strip()
    # SADECE normalize edilmiş indeks: cleanlog_*. rawlog_* (ham) ve cleanlog_* AYNI logun
    # iki kopyasıdır; ikisini birden sorgulamak tüm count'ları ~2 katına çıkarır (panelin
    # cleanlog_* tabanlı gerçek değerleriyle çelişir). rawlog_* ayrıca ECS/normalize
    # alanlarını (vendor, normalization_status, event.* ...) içermez. Panel da
    # `cleanlog_*` kaynağını kullandığından Grafana ile birebir uyum için cleanlog_*.
    index_pattern = (
        os.environ.get("GRAFANA_OPENSEARCH_INDEX") or "cleanlog_*"
    ).strip()
    # İndeks zaman deseni (Pattern): boş = "No pattern". İndeksler tarih ekli DEĞİL
    # (cleanlog_0/rawlog_0/graylog_0), bu yüzden "Daily" gibi bir desen OpenSearch
    # eklentisinin indeks adına tarih-matematiği ekleyip var olmayan indeks aramasına
    # ("Index not found") ve tüm panel/değişken sorgularının boş dönmesine yol açar.
    # Wildcard/virgüllü çok-indeks deseni desen GEREKTİRMEZ; varsayılan boş bırakılır.
    interval = (os.environ.get("GRAFANA_OPENSEARCH_INTERVAL") or "").strip()
    out_path = Path(
        os.environ.get("GRAFANA_DATASOURCES_OUT")
        or "/etc/grafana/provisioning/datasources/datasources.yaml"
    )

    if not password:
        print(
            "render_grafana_datasources: UYARI: OPENSEARCH_INITIAL_ADMIN_PASSWORD veya "
            "OPENSEARCH_PASSWORD boş; OpenSearch datasource kimlik doğrulaması başarısız olur.",
            file=sys.stderr,
        )

    doc = {
        "apiVersion": 1,
        # Grafana DB'de daha önce timestamp/boş indeks ile kalmış datasource varsa
        # provisioning aynı uid/name'i temizleyip güncel @timestamp konfigürasyonuyla
        # yeniden oluşturur. Dashboards aynı uid'ye bağlanmaya devam eder.
        "deleteDatasources": [
            {
                "name": "OpenSearch-DS",
                "orgId": 1,
            }
        ],
        "datasources": [
            {
                "uid": "opensearch-main",
                "orgId": 1,
                "name": "OpenSearch-DS",
                "type": "grafana-opensearch-datasource",
                "access": "proxy",
                "url": url,
                # Grafana 11 + OpenSearch eklentisi: kök basicAuth olmadan proxy kimliği düşebilir
                "basicAuth": True,
                "basicAuthUser": user,
                "jsonData": {
                    "version": flavor_version,
                    "flavor": "opensearch",
                    "tlsSkipVerify": tls_skip,
                    # interval boşsa "No pattern" — anahtar tamamen atlanır (eklenti
                    # boş string'i de desen sayabildiğinden, yokluk en güvenlisi).
                    **({"interval": interval} if interval else {}),
                    "timeField": time_field,
                    "database": index_pattern,
                    "logMessageField": "message",
                    "logLevelField": "level",
                    "serverless": False,
                },
                "secureJsonData": {"basicAuthPassword": password},
                "editable": True,
                "isDefault": True,
                "version": 12,
            }
        ],
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(doc, default_flow_style=False, sort_keys=False, allow_unicode=True)
    out_path.write_text(text, encoding="utf-8")
    try:
        os.chmod(out_path, 0o644)
    except OSError:
        pass
    try:
        uid = int(os.environ.get("GRAFANA_PROVISIONING_UID", "472"))
        gid = int(os.environ.get("GRAFANA_PROVISIONING_GID", "472"))
        os.chown(out_path, uid, gid)
    except (OSError, ValueError):
        pass

    print(
        f"render_grafana_datasources: {out_path} url={url} user={user} "
        f"password_set={bool(password)} tlsSkipVerify={tls_skip}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
