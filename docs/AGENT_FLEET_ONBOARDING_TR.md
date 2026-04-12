# Agent Fleet Onboarding (MVP) - TR

Bu doküman, **panel üzerinden** enrollment token üretip Fluent Bit agent/relay kurulumunu kullanıcı dostu şekilde yapmayı anlatır.

**Adım adım kurulum (Linux agent, Windows Fluent Bit, syslog relay, doğrulama):** [KAYNAK_ENTEGRASYON_KILAVUZU_TR.md](KAYNAK_ENTEGRASYON_KILAVUZU_TR.md)

## 1) Hedef

- **Öncelik:** Panel **Ayarlar → Kaynak toplama (Agent Fleet)** tek kartında **Adım adım** veya **Tüm seçenekler** ile işletim sistemine uygun token / **kurulum URL’si** / **komut** (Linux’ta Bash, Windows’ta PowerShell) — yönetici makinede `curl` ile token API’si **gerekmez**.
- Ingest doğrulama: `GET /api/agent/self-test/instructions`, `GET /api/agent/self-test/status` (operator+) — özet [KULLANICI_DOSTU_ENTEGRASYON_TR.md](KULLANICI_DOSTU_ENTEGRASYON_TR.md).
- Agent kurulabilen sistemlerde hedef sunucuda tek komut kurulum.
- Agent kurulamayan cihazlarda (firewall/switch) relay profili.
- Token + profil + TTL + aktivasyon limiti ile hatalı ayar riskini düşürmek.

## 2) API Uçları

- `GET /api/agent/profiles` (operator+)
- `GET /api/agent/default-ingest` — panelde ingest host için otomatik öneri
- `GET /api/agent/enrollment-tokens` (admin)
- `POST /api/agent/enrollment-token` (admin) — panel bu uçları oturum + CSRF ile çağırır
- `POST /api/agent/enrollment-token/revoke` (admin)
- `GET /api/agent/install/<token>.sh` (public, `linux-agent-v1` / `syslog-relay-v1`)
- `GET /api/agent/install/<token>.ps1` (public, yalnızca `windows-agent-v1`)
- `GET /api/agent/uninstall/<token>.ps1` (public, Windows kaldırma betiği; token kaydı gerekli)
- `POST /api/agent/activate` (public, token tabanlı)
- `POST /api/agent/uninstall-notify` (public, kaldırma sonrası audit + envanter `uninstalled`)
- `POST /api/agent/heartbeat` (public, token tabanlı)
- `GET /api/agent/nodes` (operator+)
- `GET /api/agent/onboarding-history` (operator+)

## 3) Profil Tipleri

### `linux-agent-v1`

- Linux hosta Fluent Bit kurar
- `/var/log/*.log` toplar
- JSON/UDP ile merkeze gönderir (`ingestHost:ingestPort`, varsayılan `5151`)

### `syslog-relay-v1`

- Agent kurulamayan cihazlardan syslog alır
- Relay host üzerinde Fluent Bit syslog input açar (`1514/udp`, `1514/tcp` varsayılan)
- Merkeze JSON/UDP aktarır
- **Not:** Relay betiği Linux içindir (Bash / systemd).

### `windows-agent-v1`

- Windows sunucu veya iş istasyonunda **Yönetici PowerShell** ile çalışan betik
- [Fluent Bit Windows paketi](https://docs.fluentbit.io/manual/installation/windows) indirilir; `winlog` ile Application / System / Security kanalları toplanır
- Merkeze JSON/UDP (`ingestHost:ingestPort`) gönderilir; Windows hizmeti olarak kaydedilir
- Zip sürümü: `.env` içinde `FLUENT_BIT_WINDOWS_VERSION` veya tam URL `FLUENT_BIT_WINDOWS_ZIP_URL` (panel `log-management-ui` ortamında)

## 4) Kullanım Akışı

### 4.1 Panel (önerilen — terminal gerekmez)

1. Panele **admin** ile giriş yapın.
2. **Ayarlar** sekmesine gidin.
3. **Kaynak toplama (Agent Fleet)** kartında **Tüm seçenekler** görünümünde:
  - Profil seçin: **Linux Agent**, **Windows Agent** veya **Syslog Relay**.
  - **Ingest host** alanını doldurun veya boş bırakın (`.env` / `LOG_PLATFORM_PUBLIC_HOST` ve otomatik çözümleme).
  - Gerekirse company / site / TTL düzenleyin.
4. **Token Üret + Komut Hazırla** düğmesine basın.
5. **Kurulum çıktısı** bölümünde URL ve işletim sistemine uygun komut görünür; **Kopyala** ile panoya alın.
6. **Linux / relay:** hedefte root/sudo ile `curl -fsSL "<.sh url>" | sudo bash`
7. **Windows:** hedefte **Yönetici PowerShell** ile panelde gösterilen komutlar (betiği indirip `powershell -File ...` ile çalıştırma)

**Adım adım** sihirbazı aynı arka ucu kullanır; token üretmeden önce gizli form alanlarını doldurur; **Kurulum çıktısı** her iki modda da kartın altında ortaktır.

### 4.2 Hedef sunucuda kurulum

**Linux / syslog relay**

```bash
curl -fsSL "<installUrl.sh>" | sudo bash
```

**Windows (`windows-agent-v1`)**

- Panelde üretilen `.ps1` URL’si; API yanıtında `installKind: powershell`, `installUrlPs1` alanı da bulunur.
- Örnek akış: `Invoke-WebRequest` ile `.ps1` indirip `powershell -ExecutionPolicy Bypass -File ...` (panel metni birebir kopyalanabilir).
- Kaldırma: API yanıtında `uninstallUrlPs1` ve panelde «Kaldırma» komutu; ayrıntı [WINDOWS_AGENT_TEMIZLEME_TR.md](WINDOWS_AGENT_TEMIZLEME_TR.md).

Adresler tarayıcıdaki panel köküne bağlıdır; reverse proxy kullanıyorsanız **Host / HTTPS** ve gerekirse `LOG_PLATFORM_PUBLIC_HOST` ile tutarlılık sağlayın.

### 4.3 Doğrulama

- Hedefte: `systemctl status fluent-bit`
- Panelde: Agent Fleet — node / heartbeat / onboarding geçmişi
- Akışta: `./scripts/test-log-flow.sh`

### 4.4 API ile token üretimi (otomasyon / ileri düzey)

Panel yerine script veya harici otomasyon kullanacaksanız örnek (oturum çerezi + CSRF gerekir):

```bash
curl -sS -X POST http://127.0.0.1:8080/api/agent/enrollment-token \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <csrf>" \
  -b "session=<session_cookie>" \
  -d '{
    "profileId": "linux-agent-v1",
    "ttlMinutes": 120,
    "companyId": "acme",
    "siteId": "dc-1",
    "logType": "system",
    "ingestHost": "10.10.10.20",
    "ingestPort": 5151
  }'
```

Yanıtta `installUrl` (birincil), `installKind` (`bash`  `powershell`), `installUrlSh` / `installUrlPs1` (profil uyumlu olanlar) döner.

## 5) Guardrail ve Risk Azaltma

- Token tek kullanımlı aktivasyon (`maxActivations=1`)
- Token süresi sınırlı (5 dk - 24 saat)
- Token revoke desteği
- Aktivasyon ve heartbeat ile envanter görünürlüğü
- Profil bazlı varsayılanlar (company/site/log_type) ile standart veri

### 5.1 Heartbeat Alarm Seviyesi

Panelde Agent Fleet kartında heartbeat otomatik sınıflandırılır:

- **Sağlıklı**: son heartbeat <= 3 dakika
- **Gecikmeli**: son heartbeat 3-15 dakika
- **Kritik**: son heartbeat > 15 dakika veya heartbeat yok

### 5.2 Onboarding Geçmişi Tablosu

Panel, son onboarding kayıtlarını gösterir (profil, hostname, durum, aktivasyon, indirme sayısı, son görülme).

## 6) Operasyon Notları

- `GET /api/agent/install/<token>.sh` ve `GET /api/agent/install/<token>.ps1` public endpointtir; güvenlik token rastgeleliği ve TTL ile sağlanır (profil ile eşleşmeyen uç 400 döner).
- Üretimde management UI erişimini IP allowlist + TLS ile sınırlandırın.
- Mümkünse installer URL paylaşımını kısa ömürlü tutun.
- Relay profili firewall/switch gibi agent kurulamaz kaynaklar içindir.

## 7) Sonraki Faz (önerilen)

- Collector health alarmı (heartbeat timeout) → temel sürüm mevcut; bildirim entegrasyonu genişletilebilir
- Canary rollout ve otomatik rollback
- Profil bazlı parser paketleri (FortiGate, Palo Alto, Cisco ASA vb.)

