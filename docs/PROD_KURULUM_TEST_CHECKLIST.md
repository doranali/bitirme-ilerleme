# Prod kurulum doğrulama listesi (test / QA)

[PROD_KURULUM_DETAY.md](PROD_KURULUM_DETAY.md) adımlarıyla kurulumdan sonra bu listeyi sırayla işaretleyin.

## Ön koşullar

- [ ] Hedef sunucuda Ubuntu Server, Docker (kurulum script’i gerekirse kurar)
- [ ] Paket: `tar` ile oluşturuldu; `./backups` ve `./envs/test-sync.env` hariç tutuldu (dokümandaki komut)

## Paket ve prod-benzeri ortam (test kalıntısı yok)

- [ ] Geliştirme makinesinde: `make validate-prod-parity` veya `bash src/scripts/ops/validate-prod-parity.sh bundle` → **PASSED**
- [ ] Kurulu test/prod sunucusunda: `bash src/scripts/ops/validate-prod-parity.sh runtime` → **PASSED**  
  - `envs/test-sync.env` **olmamalı** (yalnızca dev’de rsync için)  
  - `docker-compose.override.yml` **olmamalı** (prod ile birebir için)  
  - `.env` içinde `LOG_SYSTEM_ENV=prod` **olmalı**

## Bölüm 3 — Kurulum

- [ ] `docker-compose.yml`, `Makefile`, `envs/prod.env`, `src/scripts/ops/one-click-prod-install.sh` mevcut
- [ ] `make` yoksa: `sudo apt install -y make` veya doğrudan `bash src/scripts/ops/one-click-prod-install.sh`
- [ ] `make install-prod` tamamlandı (Dashboard + Graylog “OK” mesajları)
- [ ] `docker compose ps`: çekirdek servisler `Up` / `healthy`
- [ ] İsteğe bağlı: `make apply-ism` (disk doluysa ISM policy 403 verebilir; index template yine uygulanabilir)

## Bölüm 3.6 — Hızlı sağlık

- [ ] **Panel ilk kurulum (K1/K2):** Tarayıcıda admin ile giriş → `/first-run` akışı veya `GET /api/setup/gate` ile `gateSatisfied: true` (üretimde varsayılan kilit açık; `LOG_SYSTEM_SETUP_GATE=0` ile kapatılabilir)
- [ ] **Tam repo** (Git clone veya `rsync` ile `scripts/` geliyorsa): `bash scripts/prod-sanity-check.sh` → `RESULT: PASSED` (tek düğüm OpenSearch’ta `opensearch2/3` beklenmez)
- [ ] **Yalnızca `tar.gz` paketi** ([PROD_KURULUM_DETAY.md](PROD_KURULUM_DETAY.md) Bölüm 2’deki pakette `scripts/` yok): `prod-sanity-check` çalıştırmayın; yerine `docker compose ps` (çekirdek servisler `Up` / `healthy`) ve isteğe bağlı `bash src/scripts/testing/test-log-flow.sh` ile doğrulayın. İsterseniz kaynak makineden yalnızca `scripts/prod-sanity-check.sh` dosyasını hedefe kopyalayıp `bash scripts/prod-sanity-check.sh` de çalıştırabilirsiniz.

## Bölüm 4 — Log akışı

- [ ] `bash src/scripts/testing/test-log-flow.sh` → arşiv + OpenSearch + Graylog API adımlarında ✓

## Bilinen ortam notları

| Durum | Açıklama |
|-------|-----------|
| Grafana restart | `data/grafana_data` sahipliği: `init-volumes.sh` Docker ile `chown 472:472` dener; gerekirse `sudo chown -R 472:472 data/grafana_data` |
| `apply-ism` policy 403 | Küme “read-only” / disk eşiği; disk boşaltın veya `make apply-ism` tekrarlayın |
| OpenSearch parolası | `OPENSEARCH_PASSWORD` ile `OPENSEARCH_INITIAL_ADMIN_PASSWORD` aynı olmalı (`generate-secrets.sh` hizalar) |

## Test ortamını sudo olmadan sıfırlama

Örnek (Docker grubundaysanız):

```bash
cd /opt/log-system
docker compose --env-file .env down --remove-orphans 2>/dev/null || true
docker run --rm -v /opt/log-system:/w alpine:3.19 sh -c 'rm -rf /w/* /w/.[!.]* /w/..?*' 2>/dev/null || true
sudo mkdir -p /opt/log-system && sudo chown -R "$USER:$USER" /opt/log-system   # dizin silindiyse
```

Ardından paketi tekrar kopyalayıp `make install-prod`.

---

*Ana kılavuz: [PROD_KURULUM_DETAY.md](PROD_KURULUM_DETAY.md)*
