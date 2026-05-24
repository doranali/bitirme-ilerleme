# Dev → Test iş akışı (otomatik senkron ve prod benzeri test)

**Günlük kullanım (en basit):** `cp envs/test-sync.env.example envs/test-sync.env` → `TEST_VM` / `TEST_USER` doldur → **`make rsync-test`**. Uzakta sudo veya `docker compose` çalışmaz; sadece dosya kopyalanır. İmaj yenilemek isterseniz test VM’de kendiniz `docker compose up -d --build`.

**Güncel test sunucusu IP (örnek):** `10.13.0.115` — DHCP değiştirdiyse `envs/test-sync.env` içindeki `TEST_VM` değerini güncelleyin. Sabit IP / rezervasyon: [PROD_KURULUM_DETAY.md](PROD_KURULUM_DETAY.md) Bölüm 0.4.


**Prod ile birebir test ortamı:** `sync-to-test` artık `envs/test-sync.env` ve `docker-compose.override.yml` dosyalarını **göndermez** (yalnızca geliştirme makinenizde kalır). Kurulum sonrası doğrulama: `bash src/scripts/ops/validate-prod-parity.sh runtime` ([PROD_KURULUM_TEST_CHECKLIST.md](PROD_KURULUM_TEST_CHECKLIST.md)).

**Yönetim paneli ilk kurulum kilidi (K1/K2):** `LOG_SYSTEM_ENV=prod` iken (ve `LOG_SYSTEM_SETUP_GATE` açıkken) panel, kimlik/dış adres ve operasyonel ön koşullar tamamlanana kadar kısıtlanır; yönlendirme: `/first-run`. Durum API: `GET /api/setup/gate`. Acil durumda kapatma: `.env` içinde `LOG_SYSTEM_SETUP_GATE=0`.

**Kalıcı değişiklik sırası:** Önce **repoda** düzeltin; doğrulama için **sonra** teste **`make rsync-test`** (yalnız rsync) veya tam otomasyon için `make sync-to-test` (rsync + uzak compose). Yalnızca test VM’de yapılan düzenlemeler, ortam silindiğinde kaybolur ve repo/prod ile uyumsuzluk yaratır. Ayrıntı: [Tek doğru kaynak: repo → sonra test](#repo-then-test).

**5651 WORM immutable (test):** `sign_logs.sh` WORM `.log.gz` dosyalarına `chmod 444` ve `chattr +i` uygular; `signing-engine` / `log-signer-cron` için `cap_add: LINUX_IMMUTABLE` ve Alpine `e2fsprogs` gerekir. Doğrulama: `lsattr data/worm_storage/<tarih>/data-*.log.gz` → `i` bayrağı; panel Arşiv sekmesinde **İmmutable** rozeti.

**Akıllı Normalizasyon Merkezi:** [AKILLI_NORMALIZASYON_MERKEZI.md](AKILLI_NORMALIZASYON_MERKEZI.md). Test VM: `bash scripts/qa/run-unit-tests-normalization.sh`, `bash scripts/qa/normalization-integration.sh`, `bash scripts/ops/normalization-health-check.sh`.

---

<a id="repo-then-test"></a>

## Tek doğru kaynak: repo → sonra test

Test sunucusunu sık sıfırdan kurduğunuzda aynı davranışı almak için tek kalıcı kaynak **git deposu**dır (geliştirme makinenizdeki proje dizini, örn. `/opt/log-system`).

| Adım | Nerede | Ne |
|------|--------|-----|
| 1 | **Repo (dev makine)** | Hatayı giderin veya özelliği ekleyin (`docker-compose.yml`, `src/`, `docs/` …). Gerekirse commit. |
| 2 | **Repo → test** | Çoğu zaman: **`make rsync-test`** (`scripts/rsync-to-test.sh`). Uzakta compose da isteniyorsa: `make sync-to-test` veya `make sync-and-test`. |
| 3 | **Test VM** | `docker compose ps`, health kontrolleri, `scripts/test-log-flow.sh` / `prod-sanity-check` ile doğrulayın. |

**Yapmayın:** Sorunu yalnızca test VM’de düzeltip (ör. uzaktan elle düzenleme) repoya yansıtmamak. Bir sonraki kurulumda aynı hata tekrar eder.


<a id="hata-sonrasi-test"></a>

### Hata düzeltmesi sonrası teste yansıtma (her zaman)


| Senaryo | Ne yapın |
|---------|----------|
| Kod **geliştirme makinesinde**; test ayrı VM | Önce **`make rsync-test`**. İmajları testte de yenilemek istiyorsanız: SSH ile `docker compose up -d --build` veya `make sync-to-test` / `make sync-and-test`. |
| Düzenleme **doğrudan test sunucusundaki** `/opt/log-system` içinde | Rsync gerekmez; değişen servisler için örn. `docker compose build log-management-ui grafana && docker compose up -d log-management-ui grafana`. |
| Sadece dosya göndermek | **`make rsync-test`** (tercih). Alternatif: `SYNC_REBUILD=0 make sync-to-test`. |

Kalıcı kural: `.cursor/rules/repo-first-test-sync.mdc` (`alwaysApply: true`).

---

## Nerede ne yapılır?

İki farklı makine var: **geliştirme makineniz** (kod yazdığınız yer) ve **test sunucusu** (Docker ile stack’in çalıştığı VM).

| Ne | Nerede yapılır | Ne zaman |
|----|----------------|----------|
| Projeyi klonlamak / kod düzenlemek | **Geliştirme makineniz** (`/opt/log-system` veya kendi yolunuz) | Sürekli |
| `envs/test-sync.env` oluşturmak (`TEST_VM=10.13.0.115`, `TEST_USER=...`) | **Geliştirme makineniz**, repo kökünde | Bir kez (IP veya kullanıcı değişince tekrar) |
| `make setup-test-ssh` (anahtar + `ssh-copy-id`) | **Geliştirme makineniz** — komut Test sunucusuna bağlanır | Bir kez (parola bir kez sorulur) |
| **`make rsync-test`** | **Geliştirme makineniz** — yalnız rsync (sudo/compose yok) | Çoğu gün |
| `make sync-to-test` / `make sync-and-test` | **Geliştirme makineniz** — rsync + uzakta compose vb. | Tam otomatik güncelleme istendiğinde |
| `/opt/log-system` izinleri (`chown`), ilk kurulum (`make install-prod`) | **Test sunucusu** — SSH ile `ssh kullanici@10.13.0.115` | Kurulumda veya rsync “permission denied” olunca |
| Statik IP veya DHCP rezervasyonu | **Test sunucusu** (Netplan) veya **ağ/hipervizör paneli** | IP’nin sabit kalmasını istediğinizde |
| `sudo` ile `mkdir`/`chown` parolasız (isteğe bağlı) | **Test sunucusu** (`visudo`) | Her senkron’da sudo şifresi istemek istemiyorsanız |

**Kısa yol:** Kodu **dev’de** düzenlersiniz; senkron ve test komutlarını yine **dev’de** çalıştırırsınız. Test sunucusuna doğrudan sadece kurulum, izin düzeltme veya teşhis için girersiniz.

**Dikkat:** Geliştirme makinesinde (repo dizininde) Docker çalışıyor olsa bile, **o makinede `log-management-ui` build/restart** yapmak test sunucusunu güncellemez ve syslog/akış doğrulamasının yerine geçmez. Panel veya Fluent Bit değiştiyse kalıcı yol: **repoda commit düzeyinde dosya** → **`make rsync-test`** (veya `make sync-to-test`) → **test VM’de** ilgili servisler için `docker compose build … && up -d …`.

---

## Özet komutlar (hepsi geliştirme makinenizde)

| Adım | Komut |
|------|--------|
| 1. Yerel ayar (bir kez) | `cp envs/test-sync.env.example envs/test-sync.env` → `TEST_VM` ve `TEST_USER` düzenle |
| 2. SSH anahtarı (bir kez) | `make setup-test-ssh` veya `./scripts/setup-test-ssh.sh` |
| 3. **Sadece rsync** (çoğu gün) | **`make rsync-test`** — sudo/uzak compose yok |
| 4. Rsync + uzakta `docker compose up -d --build` | `make sync-to-test` |
| 4b. `sync-to-test` ama uzak mkdir/sudo atla | `make sync-to-test-quick` |
| 4c. İlk kurulum; uzakta TTY ile sudo | `make sync-to-test-interactive` |
| 5. Sadece uzakta prod benzeri test | `make test-remote` |
| 6. Gönder + bekle + test | `make sync-and-test` |

`envs/test-sync.env` git’e eklenmez (`.gitignore`).

### `envs/test-sync.env` içinde mutlaka kontrol edin

```bash
# Geliştirme makinenizde, repo kökünde:
nano envs/test-sync.env
```

Örnek satırlar:

```env
TEST_VM=10.13.0.115
TEST_USER=graylog-test
```

Dosya yoksa örnekten kopyalayın:

```bash
cp envs/test-sync.env.example envs/test-sync.env
```

---

## Test VM dış erişim (SSH refused / Grafana kapalı görünüyor)

VM konsolunda servisler ayakta olsa bile geliştirme makinesinden **Connection refused** alıyorsanız çoğunlukla **IP çakışması** vardır (ARP yanlış MAC). Ayrıntı: [TEST_VM_ERISIM_IP_CAKISMASI.md](TEST_VM_ERISIM_IP_CAKISMASI.md).

Test VM’de (rsync sonrası):

```bash
cd /opt/log-system
sudo DEV_WORKSTATION_IP=10.13.0.152 bash scripts/ops/configure-test-vm-access.sh
```

Geliştirme makinesinde MAC doğrulama: `ip neigh show 10.13.0.115` → VM `ens192` MAC ile aynı olmalı.

---

## Test sunucusunda kalıcı IP (10.13.0.115)

Şu an test sunucunuz **10.13.0.115/16**, gateway **10.13.0.254**, arayüz **ens192** (DHCP). Aynı adresi makinede sabitlemek için:

- **Yöntem A:** Router/hipervizörde bu VM’nin MAC adresine **10.13.0.115** rezervasyonu (tercih edilen yöntem; OS değişmez).
- **Yöntem B (Netplan):** Repoda hazır şablon + yedekleyen script:

**Yapılacak yer:** Test sunucusu — önce `make rsync-test`, sonra:

```bash
ssh kullanici@10.13.0.115
cd /opt/log-system
sudo bash scripts/ops/apply-test-vm-static-ip.sh
```

Bu işlem `/etc/netplan/` altını yedekler, `scripts/ops/netplan/99-ens192-static-test-vm.yaml` dosyasını kopyalar ve `netplan apply` çalıştırır. Ağ bilgisi değişirse (farklı gateway, arayüz adı) aynı YAML’ı repoda düzenleyip tekrar uygulayın.

---

## SSH anahtarı (şifre sormadan senkron)

**Yapılacak yer:** Geliştirme makineniz (proje dizininde).

1. `envs/test-sync.env` hazır olsun (`TEST_VM=10.13.0.115`, `TEST_USER` doğru).
2. `make setup-test-ssh`  
   - İlk seferde **Test sunucusu kullanıcı parolası** bir kez sorulur (`ssh-copy-id`).
3. Anahtar varsayılan: `~/.ssh/log_system_test_ed25519`

İsteğe bağlı `~/.ssh/config` (**geliştirme makinenizde**):

```
Host log-system-test
  HostName 10.13.0.115
  User graylog-test
  IdentityFile ~/.ssh/log_system_test_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

---

## Senkron sırasında `sudo` parolası

**IP kaynağı:** `make rsync-test`, `make test-remote`, `make sync-to-test` vb. test hedefini **`envs/test-sync.env` içindeki `TEST_VM`** üzerinden alır (`Makefile` artık kabuktaki `TEST_VM` değişkenini argüman olarak geçirmez; böylece eski `export TEST_VM=…` env dosyasını ezmez). Tek seferlik farklı IP: `./scripts/rsync-to-test.sh 10.x.x.x`.

**Senaryo akış testi (Fluent Bit → arşiv / Kafka / Graylog):** Yerelde stack açıkken `make flow-scenarios-test` veya `./scripts/flow-scenarios-test.sh`. Senaryo listesi ve ortam değişkenleri için betik başındaki yorumlara bakın (`SCENARIOS`, `FLOW_UDP_HOST`, `FLOW_RUN_LOG_FLOW=1`, `FLOW_RUN_HYBRID=1`).

**Uçtan uca platform (sanity + Y-model şablonu + akış + 5651 zinciri + Grafana):** `make e2e-full-platform` veya `./scripts/e2e-full-platform-test.sh`. Ayrıntı: `docs/E2E_PLATFORM_TEST_TR.md`.

**TÜBİTAK Kamu SM zaman damgası:** `docs/TUBITAK_ZAMAN_DAMDASI_TR.md`, `make spike-tubitak-rfc3161`, `make test-tubitak-tsa` (`SKIP_TUBITAK_TEST=1` ile atlama).

**`make rsync-test` bu bölümü tamamen atlar** (uzakta hiç komut çalışmaz). Sudo yalnızca `make sync-to-test` ve benzeri tam senkron kullanıldığında gündeme gelir.

`sync-to-test.sh` önce **`/opt/log-system` zaten varsa ve kullanıcı yazabiliyorsa** `sudo` kullanmaz. Gerekirse yalnızca **`sudo -n`** (parolasız sudo) dener; TTY ile parola istenmez — bu yüzden ilk kurulumda dizin yoksa veya sahibi root ise, aşağıdaki adımlardan biri gerekir.

**Seçenek 0 — dizin hazırsa:** Geliştirme makinenizde tek seferlik:
`SYNC_SKIP_REMOTE_PREP=1 make sync-to-test` (veya `envs/test-sync.env` içine ekleyin).

**Seçenek 1 — elle (Test sunucusunda):** Sorun çıkınca bir kez:

```bash
ssh graylog-test@10.13.0.115
sudo chown -R graylog-test:graylog-test /opt/log-system
exit
```

**Seçenek 2 — parolasız sudo (Test sunucusunda, riski bilerek):**

```bash
sudo visudo -f /etc/sudoers.d/log-system-sync
```

Örnek satır (kullanıcı adınızı yazın):

```
graylog-test ALL=(ALL) NOPASSWD: /usr/bin/mkdir, /usr/bin/chown
```

---

## `make sync-and-test` ne yapar?

Çalıştırdığınız yer: **geliştirme makineniz**.

1. Test sunucusuna rsync (`data`, `.env`, `config`, sertifikalar hariç).
2. Uzakta `docker compose up -d --build` ( `SYNC_REBUILD=1` ise).
4. Uzakta `docker compose config` ve `scripts/prod-sanity-check.sh`.

Uzaktaki script `envs/test-sync.env` içinde `REMOTE_PROD_SANITY` ile değiştirilebilir.

---


## Sorun giderme

- **rsync Permission denied / chgrp:** `docs/TROUBLESHOOTING_INSTALL_PROD.md` Bölüm 12  
- **OpenSearch / apply-ism:** `docs/TROUBLESHOOTING_INSTALL_PROD.md`, `make apply-ism`

---

*İlgili dosyalar: `scripts/rsync-to-test.sh`, `scripts/sync-to-test.sh`, `scripts/setup-test-ssh.sh`, `scripts/run-remote-tests.sh`, `scripts/sync-and-test.sh`, `envs/test-sync.env.example`*
