# make install-prod Kurulum Sorun Giderme

Bu belge, `make install-prod` tek komut kurulumunda yaşanan yaygın sorunları ve çözümlerini içerir. Benzer sorunlarla karşılaşıldığında bu dokümana bakın.

---

## Özet: Bilinen Sorunlar ve Çözümler

| # | Sorun | Çözüm |
|---|-------|-------|
| 1 | OpenSearch container "unhealthy" | Parola validasyonu + veri temizliği |
| 2 | OpenSearch: "Password does not match validation regex" | `generate_opensearch_password()` ile özel karakter zorunluluğu |
| 3 | Eski OpenSearch verisi yeni parola ile uyumsuz | Kurulum öncesi OpenSearch data dizinlerini temizleme |
| 4 | Kurulum sonunda "admin123!" yazıyor ama gerçek parola farklı | credentials-initial.txt'den parola okuyup gösterme |
| 5 | Dokümantasyonda yanlış parola referansı | Tüm dokümanlarda credentials-initial.txt referansı |
| 6 | İlerleme göstergesi – donup donmadığı anlaşılmıyor | Bölüm 6: İlerleme açıklaması + VERBOSE=1 ile ham çıktı |
| 7 | Kurulum "donmuş" gibi görünüyor | Bölüm 0: Donma sorunları özeti |
| 8 | apk add takılması (signing-engine/log-management-ui build) | Bölüm 8: Docker daemon DNS + build network: host |
| 9 | OpenSearch "ca.crt - is a directory" | Bölüm 9: generate-certs.sh dizin kontrolü |
| 10 | setup "mongodb.pem: Is a directory" | Bölüm 10: setup-init.sh mongodb.pem dizin kontrolü |
| 11 | OpenSearch temizliği yanlış path | docker-compose ${OPENSEARCH_DATA*_PATH}; temizlik aynı path ile |
| 12 | Eski container kalıntıları | docker compose down --remove-orphans |
| 13 | Graylog unhealthy, dependency failed | start_period 180s, GRAYLOG_MESSAGE_JOURNAL_MAX_SIZE, config/ önceden oluştur |
| 14 | Kimlik bilgileri config/ dizinine yazılamadı | init-config-links generate-secrets'tan önce çalıştırılmalı |
| 15 | rsync: `chgrp failed` / `mkdir Permission denied` / `Operation not permitted` | Hedef sunucuda: `sudo chown -R $USER:$USER /opt/log-system` |
| 16 | `fluent-bit is unhealthy` / `dependency failed` (log-gen) | Healthcheck `wget` yoktu → `curl` kullanılmalı (`docker-compose.yml` güncel); `docker compose up -d` veya yeniden kurulum |
| 17 | Grafana: `grafana.com/api/plugins/... context deadline exceeded` (build veya runtime) | `GF_INSTALL_PLUGINS` runtime’da grafana.com ister. Build’de `grafana-cli … <sürüm>` de API’ye gider. Çözüm: `src/services/grafana/Dockerfile` eklentiyi `--pluginUrl` ile **GitHub release zip**’ten kurar (grafana.com gerekmez). `docker compose build grafana --no-cache` |
| 18 | OpenSearch: `high disk watermark [90%] exceeded` | VM diski dolu; **vCenter:** [VCENTER_TEST_VM_DISK_TR.md](VCENTER_TEST_VM_DISK_TR.md); `docker system prune`; eski indeks/veri temizliği |
| 19 | Kafka: `NotEnoughReplicasException` / `logs_raw-0` / `min.isr requirement of 2` | ISR’da yeterli replika yok (disk dolu, broker lag, ağ). Disk temizliği; test için `.env`’de `KAFKA_MIN_INSYNC_REPLICAS=1` + broker restart; gerekirse `logs_raw` topic `min.insync.replicas=1` (Bölüm 19) |
| 20 | `network log_net exists but was not created by compose` / yanlış `com.docker.compose.network` etiketi | Eski `init-network.sh` ağı elle oluşturuyordu. **Güncel repo:** ağı yalnızca compose oluşturur. Geçici çözüm: `docker network rm log_net` (bağlı konteyner yoksa) → `docker compose --env-file .env up -d` |

---

## 0. Donma (Freezing) Sorunları – Özet

| Donma Türü | Belirti | Çözüm |
|------------|---------|-------|
| **Ağ/DNS** | Docker Hub erişilemez, pull/build sessizce takılır | Phase 0 pre-flight: Erişilemezse `VERBOSE=1` otomatik → ham çıktı görünür |
| **Compose timeout** | Compose uzun süre yanıt vermez | `COMPOSE_HTTP_TIMEOUT=300`, `DOCKER_CLIENT_TIMEOUT=300` (`run_compose` içinde) |
| **Boş ekran** | Phase 6'da hiçbir şey görünmez | `compose-progress-display.sh` ile `[X/Y] Tamamlandı \| Şu an: ...` her 2 sn güncellenir |
| **Donma sanısı** | Aynı satır dakikalarca değişmez | 2–5 dk normal; 5+ dk donma sayılır (Bölüm 6) |
| **Gerçek donma** | 5+ dk değişiklik yok | `VERBOSE=1 make install-prod` ile ham Docker çıktısı |
| **Ağ/timeout hatası** | Compose başarısız | Retry: 3 deneme, 45 sn aralık |
| **Container çakışması** | Eski container/ağ sorunları | Phase 6 başında `docker compose down`, `docker network rm log_net` |
| **apk add takılması** | signing-engine/log-management-ui build'de `RUN apk add` donuyor | Docker daemon DNS + build network: host (Bölüm 8) |

---

## 1. OpenSearch Parola Validasyonu (Password does not match validation regex)

**Belirti:** OpenSearch container başlamıyor veya "unhealthy" kalıyor. Loglarda:
```
Password ... failed validation: "Password does not match validation regex"
```

**Neden:** OpenSearch 2.12+ Security Plugin parola için şunları zorunlu kılar:
- Minimum 8 karakter
- En az 1 büyük harf
- En az 1 küçük harf
- En az 1 rakam
- **En az 1 özel karakter** (!@#$%^&* vb.)

`openssl rand -base64` sadece A-Za-z0-9 üretir; özel karakter yok.

**Çözüm:** `src/scripts/ops/generate-secrets.sh` içinde OpenSearch parolaları için `generate_opensearch_password()` kullanılmalı (sondan `A1a!` eklenir).

---

## 2. Veri dizinleri temizliği (OpenSearch / MongoDB / MinIO — eski secret uyumsuzluğu)

**Belirti:** OpenSearch "unhealthy", Graylog REST 401, MinIO erişim hatası.

**Neden:** `generate-secrets.sh` yeni parolalar üretir; bind-mount içindeki **eski** veritabanı veya object store hâlâ önceki kimlik bilgileriyle oluşturulmuş olur.

**Çözüm:** `one-click-prod-install.sh` Phase 6'da `docker compose down` sonrası sırayla: **OpenSearch** data dizinleri, **MongoDB** verisi (Graylog), **MinIO** verisi (yeni `MINIO_ROOT_PASSWORD` ile uyum), kökteki **`panel-setup-state.json`** (ilk kurulum kilidi state) temizlenir. Path'ler `.env` ile compose ile aynı kaynaktan alınır; Mongo/MinIO silme için izin sorunlarında `docker run alpine` ile volume içi temizlik kullanılır. İleri düzey: veriyi korumak için `PRESERVE_APP_DATA=1 make install-prod` (önerilmez; secret uyumsuzluğu riski).

---

## 3. Kurulum Sonu Parola Gösterimi

**Belirti:** Kurulum sonunda "admin / admin123!" yazıyor ama gerçek parola farklı. Kullanıcı yanlış parolayla giriş yapmaya çalışıyor.

**Neden:** Gerçek parola `generate-secrets` ile üretilip `config/credentials-initial.txt` içinde tutuluyordu.

**Çözüm:** Kurulum sonunda parolayı `credentials-initial.txt`'den okuyup gösterme. `access-endpoints.json`'a `credentialsFile` referansı ekleme.

---

## 4. Dokümantasyon Parola Referansı

**Sorun:** Tüm dokümanlarda sabit "admin123!" yazıyordu.

**Çözüm:** `config/credentials-initial.txt` referansı kullanılmalı. Güncellenen dosyalar:
- `docs/PROD_KURULUM_DETAY.md`
- `docs/KURULUM_KILAVUZU.md`
- `docs/TEST_VE_KURULUM_REHBERI_TR.md`

---

## 5. Önceki Oturumda Yapılmış Olabilecek Düzeltmeler (Kontrol Edilmeli)

Aşağıdaki sorunlar önceki oturumda çözülmüş olabilir. Dev ortamında aynı sorunlar varsa uygulanmalıdır.

### 5.1 OpenSearch sertifika SAN (generate-certs.sh)

**Sorun:** Graylog "Hostname opensearch1 not verified" hatası.

**Çözüm:** OpenSearch sertifikalarına SAN (Subject Alternative Name) eklenmeli. ✅ Uygulandı.
```
subjectAltName=DNS:opensearch1,DNS:opensearch2,DNS:opensearch3,DNS:localhost,IP:127.0.0.1
```
Sertifikalar yeniden üretmek için: `./src/scripts/core/generate-certs.sh` ardından `docker compose restart opensearch1 graylog`.

### 5.2 Graylog truststore (docker-compose.yml)

**Sorun:** "None of the TrustManagers trust this certificate chain"

**Çözüm:** `keytool` import'tan `2>/dev/null` kaldırılmalı; hata görünür olmalı. `rm -f /tmp/graylog-truststore.jks` ile önceki truststore silinmeli. ✅ Uygulandı.

### 5.3 Graylog journal boyutu (envs/prod.env veya .env)

**Sorun:** "Journal directory has not enough free space"

**Çözüm:** `GRAYLOG_MESSAGE_JOURNAL_MAX_SIZE` kök diske göre küçültün (ör. `512mb`). Kurulum/preflight: `src/scripts/ops/disk-plan-for-env.sh` boş alana göre otomatik ayarlar; elle sabitlemek için `.env` içinde `GRAYLOG_MESSAGE_JOURNAL_MAX_SIZE_LOCKED=1`.

### 5.4 Pre-flight ağ kontrolü (one-click-prod-install.sh)

**Çözüm:** Phase 0 ile Docker Hub erişimi kontrol edilmeli; erişilemezse `VERBOSE=1` ayarlanmalı. ✅ Uygulandı.

### 5.5 Compose timeout

**Çözüm:** `COMPOSE_HTTP_TIMEOUT=300` ve `DOCKER_CLIENT_TIMEOUT=300` export edilmeli. ✅ Uygulandı.

---

## 9. ca.crt / Sertifika Dizin Hatası

**Belirti:** OpenSearch `ca.crt - is a directory`, `Likely root cause: OpenSearchException[ca.crt - is a directory]`

**Neden:** Sertifika dosyaları yanlışlıkla dizin olarak oluşturulmuş.

**Çözüm:** `generate-certs.sh` script başında sertifika adlarının dizin olup olmadığı kontrol edilir; dizinse silinir. ✅ Uygulandı.

**Manuel acil çözüm:**
```bash
cd /opt/log-system/config/certs
rm -rf ca.crt ca.key ca.srl
cd /opt/log-system && bash src/scripts/core/generate-certs.sh config/certs
docker compose restart opensearch1 graylog
```

---

## 10. setup "mongodb.pem: Is a directory"

**Belirti:** `service "setup" didn't complete successfully: exit 1`, logda `can't create mongodb.pem: Is a directory`

**Neden:** `mongodb.pem` yanlışlıkla dizin olarak oluşturulmuş.

**Çözüm:** `src/scripts/core/setup-init.sh` içinde mongodb.pem oluşturmadan önce `[ -d mongodb.pem ] && rm -rf mongodb.pem` eklenir. ✅ Uygulandı.

**Manuel acil çözüm:** `rm -rf config/certs/mongodb.pem` (dizin ise), ardından setup tekrar çalıştırılır.

---

## 6. İlerleme Göstergesi – Donma Hissi ve Ham Çıktı

### 6.1 Nasıl Çalışır?

Phase 6 (Docker image indirme/build) sırasında:

- Docker Compose arka planda çalışır; çıktı `/tmp/compose-progress-*.log` dosyasına yazılır.
- `compose-progress-display.sh` her **2 saniyede** bu log dosyasını okuyup tek satırda ilerlemeyi günceller:
  ```
  [install-prod]   [1/12] Tamamlandı | Şu an: alert-webhook build ediliyor
  ```
- `[X/Y]`: Tamamlanan image sayısı (Pulled + Built) / Toplam tahmini image sayısı.
- `Şu an:`: Şu anda indirilen veya build edilen servis adı.

### 6.2 Normal Davranış (Donma Değil)

- **Aynı satır 2–5 dakika değişmeden kalabilir** – Özellikle `alert-webhook`, `signing-engine`, `log-management-ui` build edilirken pip/apk adımları uzun sürebilir.
- İlk 30 saniye `Başlatılıyor...` veya `İlk adım hazırlanıyor...` gösterilebilir.
- Registry image'ları (opensearch, graylog vb.) indirilirken de birkaç dakika aynı satırda kalabilir.

### 6.3 Ne Zaman Donma Sayılır?

- **5+ dakika** aynı satırda hiç değişiklik yoksa,
- `[X/Y]` sayısı artmıyorsa,
- Özellikle Docker Hub erişilemiyorsa (Phase 0 uyarısı verilmişse),

kurulum takılmış olabilir.

### 6.4 Ham Çıktı ile Kontrol (VERBOSE=1)

Donma şüphesi varsa ham Docker çıktısını görmek için:

```bash
VERBOSE=1 make install-prod
```

Bu modda:
- Docker Compose çıktısı doğrudan ekrana yazılır (build adımları, pull mesajları vb.).
- İlerleme göstergesi devre dışı kalır.
- Takılma varsa hangi adımda kaldığı görülebilir.

### 6.5 Dev Ortamında Kontrol Listesi

Dev ortamında ilerleme göstergesinin çalışması için:

1. **`src/scripts/ops/compose-progress-display.sh`** dosyası mevcut olmalı.
2. **`one-click-prod-install.sh`** içinde `run_compose` fonksiyonu:
   - `do_run | stdbuf -oL tee "$logfile" >/dev/null` ile compose çıktısı log dosyasına yazılmalı.
   - `bash "$progress_script" "$TOTAL_IMAGES" "$logfile" "$compose_pid"` ile ilerleme scripti arka planda çalıştırılmalı.
3. Varsayılan modda ekrana sadece ilerleme satırı yazılmalı; ham çıktı `>/dev/null` ile gizlenmeli.

---

## 8. apk add / Docker Build Takılması

**Belirti:** Build sırasında `[signing-engine 2/8] RUN apk add ...` veya `[log-management-ui 2/6] RUN apk add ...` adımında kurulum donuyor, dakikalarca ilerleme yok.

**Neden:** Alpine paket sunucularına (dl-cdn.alpinelinux.org) DNS/ağ ile erişilemiyor. Docker build container'ları varsayılan DNS kullanır; systemd-resolved (127.0.0.53) veya firewall nedeniyle çözümleme başarısız olabilir.

**Çözümler (sırayla deneyin):**

### 8.1 Docker daemon DNS (Kalıcı)

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json << 'EOF'
{
  "max-concurrent-downloads": 1,
  "ipv6": false,
  "dns": ["8.8.8.8", "8.8.4.4"]
}
EOF
sudo systemctl restart docker
```

Ardından `make install-prod` tekrar çalıştırın.

### 8.2 Geçici sistem DNS (Bootstrap öncesi)

```bash
echo 'nameserver 8.8.8.8' | sudo tee /etc/resolv.conf
```

### 8.3 Yapılan kod değişiklikleri

- **Dockerfile (signing-engine, log-management-ui):** `apk add` için retry döngüsü; `pip install --timeout 120`
- **docker-compose.yml:** `signing-engine` ve `log-management-ui` build'de `network: host`
- **bootstrap-host.sh:** daemon.json'a `"dns": ["8.8.8.8", "8.8.4.4"]` eklendi

### 8.4 setup "mongodb.pem: Is a directory" (exit 1)

**Belirti:** `service "setup" didn't complete successfully: exit 1`, logda `can't create mongodb.pem: Is a directory`

**Çözüm:** `src/scripts/core/setup-init.sh` içinde mongodb.pem oluşturmadan önce `[ -d mongodb.pem ] && rm -rf mongodb.pem` ekle. ✅ Uygulandı. Manuel: `rm -rf config/certs/mongodb.pem` (dizin ise).

### 8.5 OpenSearch temizliği path uyumu (#11)

**Sorun:** docker-compose `./data` kullanıyor; temizlik farklı path ile yapılırsa OpenSearch verisi temizlenmez.

**Çözüm:** docker-compose.yml'da volume path'leri `${OPENSEARCH_DATA1_PATH:-./data/opensearch_data1}` kullanır; one-click-prod-install.sh aynı .env/env değişkenlerini kullanır. ✅ Uygulandı.

### 8.6 Eski container kalıntıları (#12)

**Çözüm:** `docker compose down --remove-orphans` ile orphan container'lar temizlenir. ✅ Uygulandı.

---

## 10. Graylog Unhealthy / dependency failed to start

**Belirti:** `dependency failed to start: container graylog is unhealthy`

**Nedenler:** Graylog başlangıcı yavaş (OpenSearch/MongoDB bağlantısı); journal disk alanı; healthcheck timeout.

**Çözümler (uygulandı):**
- `start_period: 180s` (Graylog'a 3 dk başlangıç süresi)
- `retries: 8` (daha fazla deneme)
- `GRAYLOG_MESSAGE_JOURNAL_MAX_SIZE=2gb` (varsayılan 5gb yerine)

**Teşhis:** `docker logs graylog 2>&1 | tail -50` ile hata mesajını görün.

---

## 10b. Fluent Bit unhealthy / `dependency failed to start: container fluent-bit is unhealthy`

**Belirti:** `make install-prod` veya `docker compose up` sırasında `log-gen` veya diğer bağımlılıklar fluent-bit sağlığına takılır.

**Neden:** `fluent/fluent-bit:*-debug` imajında **`wget` yok**; eski `docker-compose.yml` healthcheck `wget` kullanıyorsa konteyner sürekli **unhealthy** kalır.

**Çözüm:** Güncel repoda healthcheck **`curl`** ile yapılır. Repoyu güncelleyin veya elle:
```bash
docker compose exec fluent-bit sh -lc 'command -v wget || echo "wget yok"; command -v curl'
```
`docker compose up -d --force-recreate fluent-bit` ile yeniden deneyin.

**Ek:** Kafka/Graylog çıkışları ilk dakikalarda hata verirse Fluent Bit dahili `Health_Check` sıkı olabiliyordu; `fluent-bit.conf` içinde `HC_*` değerleri gevşetildi.

---

## 11. Kimlik bilgileri config/ dizinine yazılamadı

**Belirti:** `UYARI: Kimlik bilgileri config/ dizinine yazılamadı`

**Neden:** `generate-secrets` Phase 1'de çalışır; `config/` dizini Phase 3'te (init-config-links) oluşturuluyordu.

**Çözüm:** Phase 1'de `config/` dizini ve `init-config-links` generate-secrets'tan önce çalıştırılır. ✅ Uygulandı.

---

## 12. rsync / sync-to-test: Permission denied, chgrp failed

**Belirti:** Geliştirme makinesinden Test VM'e `rsync` veya `./scripts/sync-to-test.sh` ile senkron yaparken:
```
rsync: [generator] chgrp "/opt/log-system/src" failed: Operation not permitted (1)
rsync: [generator] recv_generator: mkdir "/opt/log-system/src/config" failed: Permission denied (13)
```

**Neden:** Hedef sunucuda `/opt/log-system` veya alt dizinleri root'a ait (Docker, tar veya önceki kurulum sonrası). rsync alıcı kullanıcının bu dizinlere yazma izni yok.

**Çözüm:** Hedef sunucuda (Test VM) SSH ile bağlanıp sahipliği düzeltin:
```bash
ssh graylog-test@10.13.0.150
sudo chown -R $USER:$USER /opt/log-system
exit
```
Sonra rsync'i tekrarlayın. `sync-to-test.sh` artık `chown -R` kullanıyor; ilk senkron öncesi hedefte dizin yoksa script otomatik düzeltir.

---

## 12b. rsync sonrası `src/scripts/` boş veya `one-click-prod-install.sh` bulunamıyor

**Belirti:** Senkron sonrası hedefte `src/scripts/ops/` altı eksik; `make install-prod` veya doğrulama betikleri dosya bulunamıyor.

**Neden:** rsync’te **`--exclude=scripts`** (tırnaksız segment) kullanıldıysa, rsync bu deseni yolun **herhangi bir dizin adı** `scripts` olan yerde eşleştirir; bu da **`src/scripts/`** ağacını yanlışlıkla hariç tutar.

**Çözüm:** Prod/stage senkronunda kök `scripts/` dizinini dışlamak için **`--exclude=/scripts`** kullanın (`scripts/sync-remote.sh` böyle yapılandırılmıştır). `tar` ile paketlerken dokümandaki gibi **`./scripts`** (köke göreli) kullanın. Hedefi temizleyip kaynaktan doğru exclude ile yeniden senkronlayın veya repoyu geri yükleyin.

---

## 19. Kafka `NotEnoughReplicasException` (`logs_raw`, min ISR)

**Belirti:** `kafka2` (veya başka broker) loglarında:
```
NotEnoughReplicasException: The size of the current ISR Set(2) is insufficient to satisfy the min.isr requirement of 2 for partition logs_raw-0
```
`Set(2)` çoğu zaman ISR içinde yalnızca **broker id 2** olduğunu (yani ISR boyutunun **1** olduğunu) ifade eder; üretici `acks=all` ve topic `min.insync.replicas=2` iken yazamaz.

**Sık nedenler:**
- VM disk dolu veya OpenSearch/Kafka veri birimleri dolu → replikalar ISR’dan düşer (loglarda OpenSearch `high disk watermark` uyarısı ile birlikte görülebilir).
- Broker’lardan biri geç başladı veya sürekli restart oluyor.

**Kalıcı / üretim:** Disk alanı açın, üç broker’ın da sağlıklı olduğunu doğrulayın (`docker compose ps`, broker logları).

**Dar kaynaklı test VM (geçici):**
1. `.env` içine ekleyin (üç broker’a da compose ile yayılır):
   ```bash
   KAFKA_MIN_INSYNC_REPLICAS=1
   KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1
   ```
2. `docker compose up -d kafka1 kafka2 kafka3` (veya tam stack restart).

**Önemli:** Daha önce oluşturulmuş `logs_raw` konusunun kendi `min.insync.replicas` değeri 2 olarak kayıtlı olabilir; broker varsayılanı bunu otomatik düşürmez. O zaman:
```bash
cd /opt/log-system
docker compose exec kafka1 kafka-topics --bootstrap-server kafka1:9092 --describe --topic logs_raw
docker compose exec kafka1 kafka-configs --bootstrap-server kafka1:9092 \
  --entity-type topics --entity-name logs_raw \
  --alter --add-config min.insync.replicas=1
```

Prod ortamında `min.insync.replicas=1` dayanıklılığı düşürür; sadece test veya acil kurtarma için kullanın.

---

## 13. Test

Değişikliklerden sonra:

```bash
cd /opt/log-system
make install-prod
```

**Beklenen sonuç:**
- OpenSearch container "Healthy" olmalı
- Graylog container "Healthy" olmalı
- Kurulum sonunda gerçek Graylog parolası gösterilmeli
- `config/credentials-initial.txt` dosyası oluşmalı ve içinde Graylog + OpenSearch parolaları olmalı

---

*Belge tarihi: 2026-03*
