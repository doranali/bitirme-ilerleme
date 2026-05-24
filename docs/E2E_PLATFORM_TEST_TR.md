# Uçtan uca platform testi (Fluent Bit → Y-model → Kafka → Graylog → Grafana → 5651)

Bu belge, **kurulum sonrası** çalışan Docker stack üzerinde tek komutla duman testi yapmayı özetler. **Yeni sunucu kurulumu** için önce `make install-prod` veya mevcut kurulum rehberiniz; stack ayakta olduktan sonra aşağıdaki adımlar uygulanır.

**Not:** Bu komutlar **merkez Linux host**ta (Docker) çalışır. **Windows Server** üzerinde Fluent Bit ajanı testi bu belgenin dışındadır; panel **Uç envanteri** / self-test ile doğrulanır — bkz. [AGENT_FLEET_ONBOARDING_TR.md](AGENT_FLEET_ONBOARDING_TR.md) §0.

## Tek komut

```bash
cd /opt/log-system
make e2e-full-platform
```

İsteğe bağlı:

| Değişken | Anlamı |
|----------|--------|
| `E2E_SKIP_SANITY=1` | `scripts/prod-sanity-check.sh` atlanır (hızlı tekrar). |
| `E2E_SCENARIOS=s01,s02,s03,s06,s09` | `flow-scenarios-test` içinde yalnız seçilen senaryolar. |

## Ne doğrulanır?

1. **Preflight** — Çekirdek konteynerler ve temel health uçları (`prod-sanity-check`).
2. **Y-modeli (merkez)** — `src/services/fluent-bit/fluent-bit.conf`: aynı `test.generator` akışından **dosya arşivi** (5651 ham günlük), **Kafka** (`logs_raw`), **GELF Graylog** çıkışları; ayrıca `compliance_5651` / `ingest_mode` metadata.
3. **Akış** — `scripts/flow-scenarios-test.sh`: UDP 5151, Kafka tüketimi, Graylog API, panel `/api/health`, isteğe bağlı Graylog arama (`.env` içinde `GRAYLOG_ROOT_PASSWORD`).
4. **5651 zinciri** — `make test-5651-signing`: manifest SHA256 = ham arşiv = `gunzip(WORM)` (`SIGNER_TYPE=OPEN_SOURCE` yeterli).
5. **Grafana** — `http://127.0.0.1:${GRAFANA_PORT:-3000}/api/health`.

**Grafana’da “loglar istediğimiz yapıda mı?”** sorusu tamamen **OpenSearch indeks şeması + dashboard sorgularına** bağlıdır; otomatik test yalnız API sağlığını doğrular. İçerik doğrulaması için Grafana’da kaydedilmiş bir panel veya Explore ile `message`, `@timestamp`, `log_type` alanlarını elle kontrol edin.

**5651 içerik yeterliliği** (IP, zaman, kimlik vb.) kaynak uygulamalardan gelir; platform `compliance_5651` ve ingest sözleşmesi alanlarını zenginleştirir. Checklist: `docs/5651_UYUMLULUK.md` §4.1.

## TÜBİTAK (RFC 3161) uç testi

Ayrıntılı rehber: [`TUBITAK_ZAMAN_DAMDASI_TR.md`](TUBITAK_ZAMAN_DAMDASI_TR.md).

| Komut | Açıklama |
|--------|----------|
| `make spike-tubitak-rfc3161` | RFC3161 curl spike (wiki test TSA + `.env` URL) |
| `make test-tubitak-tsa` | `SIGNER_TYPE=TUBITAK` iken `.tsr` üretimi; `SKIP_TUBITAK_TEST=1` ile atlama |

Ön koşul: `TUBITAK_TSA_URL`, isteğe bağlı `TUBITAK_TSA_CUSTOMER_NO` / `TUBITAK_TSA_PASSWORD`, testte `TUBITAK_TLS_INSECURE=1`. Önce Zamane ile test kullanıcısı doğrulaması önerilir.

## Kenar cihaz (Fluent Bit kurulumu) ve farklı log yolları

- **Linux ajan** (`linux-agent-v1`): Panelden üretilen kurulum betiği, yaygın yolları **tek `tail` bloğunda** birden çok `Path` ile tarar (`/var/log/syslog`, `messages`, `auth.log`, `secure`, `/var/log/*.log`). Bu, “farklı dağıtımda dosya yeri değişti” senaryosunda **merkezi compose’u değiştirmeden** çalışır; olmayan dosyalar Fluent Bit tarafından tolere edilir.
- **Windows** (`windows-agent-v1`): Olay Günlüğü kanalları; dosya yolu son kullanıcıya sızdırılmaz.
- **Syslog cihazı** (`syslog-relay-v1`): Ajan kurulamayan cihazlar → relay → merkez UDP JSON.

Özel bir dizin (ör. `/opt/app/logs/app.log`) gerekiyorsa: **yeni bir Agent profili** (`config/agent-fleet` özel JSON) veya mevcut şablonda **tek satırlık `Path` ekleme** yeterlidir; ayrı “uygulama” şart değildir. İleride panelde “ek log dizini” sihirbaz alanı eklenebilir; bugün için operasyonel olarak profil çoğaltması profesyonel çözümdür. Ayrıntı: `docs/AGENT_FLEET_ONBOARDING_TR.md` §6.3.

## Sıra özeti (operasyon)

1. Stack: `docker compose up -d` (kurulum rehberinize göre).  
2. `make e2e-full-platform`  
3. Panel + Grafana ile görsel doğrulama.  
4. `make test-5651-signing` (OPEN_SOURCE zincir) + `make test-tubitak-tsa` (TÜBİTAK, credentials varsa).

İlgili: `docs/DEV_TEST_WORKFLOW.md`, `make flow-scenarios-test`, `make test-5651-signing`, `make test-tubitak-tsa`.
