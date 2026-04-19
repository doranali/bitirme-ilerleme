# Smart Log Engine v2.0 (Enterprise)

Production-ready, vendor-agnostic log platform with hybrid architecture:

- Edge collection and immutable raw archive (5651 path)
- Central smart normalization (Graylog lookup + pipeline)
- Real-time analytics (OpenSearch + Grafana SOC dashboards)
- Alert routing (Grafana Alerting -> Webhook Bridge -> Telegram Watchdog)

Türkçe:
Üretime hazır, üretici-bağımsız hibrit mimarili log platformu:

- Edge katmanda toplama ve değiştirilemez ham arşiv (5651 hattı)
- Merkezi akıllı normalizasyon (Graylog lookup + pipeline)
- Gerçek zamanlı analiz (OpenSearch + Grafana SOC panelleri)
- Alarm yönlendirme (Grafana Alerting -> Webhook Bridge -> Telegram Watchdog)

## Core Superpowers

1. **Smart Normalization**: Unknown vendor logs are mapped into canonical fields (`source.ip`, `destination.ip`, `event.category`) through profile-driven rules.
2. **Legal Shield (5651)**: Raw logs are archived and signed without mutating normalized analytics data.
3. **Early Warning**: Unknown/needs_profile events are routed into `quality_control` and surfaced in SOC dashboard + Telegram workflow.
4. **High Throughput**: 3x Kafka KRaft architecture absorbs burst traffic (Zookeeper-free).

Türkçe:

1. **Akıllı Normalizasyon**: Tanınmayan üretici logları, profil tabanlı kurallarla kanonik alanlara (`source.ip`, `destination.ip`, `event.category`) eşlenir.
2. **Yasal Kalkan (5651)**: Ham loglar, normalize analitik veriye dokunmadan arşivlenir ve imzalanır.
3. **Erken Uyarı**: Unknown/needs_profile olayları `quality_control` akışına yönlendirilir ve SOC paneli + Telegram iş akışında görünür olur.
4. **Yüksek Hacim**: 3x Kafka KRaft mimarisi ani trafik artışlarını karşılar (Zookeeper yok).

## Runtime Topology

- `fluent-bit` -> `kafka1/2/3` -> `graylog` -> `opensearch1` -> `grafana`
- Data governance streams:
  - `raw_ingest`
  - `clean_normalized`
  - `quality_control`

Türkçe:

- Çalışma topolojisi: `fluent-bit` -> `kafka1/2/3` -> `graylog` -> `opensearch1` -> `grafana`
- Veri yönetişimi akışları:
  - `raw_ingest`
  - `clean_normalized`
  - `quality_control`

## Enterprise v2.0 Scope

- Graylog 4-stage smart normalization pipeline with lookup-driven profile resolution
- Raw/Clean stream and index-set separation to avoid dashboard double counting
- SOC dashboard with dynamic variables, repeat rows, drill-down links, and quality-control early warning
- Provisioned Grafana Alerting rules and webhook contact point

Türkçe:

- Lookup tabanlı profil çözümlemeli Graylog 4-aşamalı akıllı normalizasyon hattı
- Dashboard çift sayımını önlemek için Raw/Clean stream ve index-set ayrımı
- Dinamik değişkenler, tekrar eden satırlar, drill-down linkler ve quality-control erken uyarı içeren SOC paneli
- Provision edilmiş Grafana alarm kuralları ve webhook contact point

## Quick Operations

```bash
# start / update services
docker compose up -d

# system sanity tests
./scripts/test-system.sh
./scripts/test-log-flow.sh

# inspect critical service health
docker compose ps
```

Türkçe:
Hızlı operasyon komutları:

```bash
# servisleri başlat / güncelle
docker compose up -d

# sistem sanity testleri
./scripts/test-system.sh
./scripts/test-log-flow.sh

# kritik servis sağlık durumunu kontrol et
docker compose ps
```

## Documentation

- End-to-end log flow & normalization (TR): `docs/LOG_AKISI_UCTAN_UCA_NORMALIZASYON_TR.md`
- Syslog devices → relay → platform (TR): `docs/SYSLOG_CIHAZLARDAN_BAGLANTI_TR.md`
- Operations manual: `docs/OPERATIONS_MANUAL.md`
- Project structure: `docs/PROJECT_STRUCTURE.md`
- Changelog: `CHANGELOG.md`
- Release notes: `RELEASE_NOTES_v2.0.md`
- Product vision archive: `PROJECT_VISION.md`
- Weekly progress & term plan (TR): `HAFTALIK_ILERLEME.md`

Türkçe:

- Haftalık ilerleme ve dönem iş planı: `HAFTALIK_ILERLEME.md`
- Log akışı ve normalizasyon (uçtan uca, TR): `docs/LOG_AKISI_UCTAN_UCA_NORMALIZASYON_TR.md`
- Syslog cihazları ve relay (TR): `docs/SYSLOG_CIHAZLARDAN_BAGLANTI_TR.md`
- Operasyon kılavuzu: `docs/OPERATIONS_MANUAL.md`
- Proje yapısı: `docs/PROJECT_STRUCTURE.md`
- Değişiklik günlüğü: `CHANGELOG.md`
- Sürüm notları: `RELEASE_NOTES_v2.0.md`
- Ürün vizyon arşivi: `PROJECT_VISION.md`

## Release Tag Suggestion

```bash
git tag -a v2.0.0-enterprise -m "Smart Log Engine v2.0 Enterprise"
git push origin v2.0.0-enterprise
```

Türkçe:
Önerilen sürüm etiketi:

```bash
git tag -a v2.0.0-enterprise -m "Smart Log Engine v2.0 Enterprise"
git push origin v2.0.0-enterprise
```

