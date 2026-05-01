# Bitirme Projesi Haftalık İlerleme Raporu

## Proje Bilgileri


| Alan                   | Bilgi                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Öğrenci Adı Soyadı** | *Ali Doran*                                                                                                                             |
| **Öğrenci No**         | *24360859211*                                                                                                                           |
| **Proje Başlığı**      | Smart Log Engine: 5651 Uyumlu Kurumsal Log Yönetim Platformu (Fluent Bit, Kafka KRaft, Graylog, OpenSearch, Grafana, Log Management UI) |
| **Danışman**           | Prof. Dr. Turgay Tugay Bilgin                                                                                                           |
| **Dönem**              | 2025-2026 Bahar                                                                                                                         |


---

## İş Planı

> **Kullanım:** Tabloda her hafta için planlanan iş ve tahmini tamamlanma oranı yer alır. Haftalık kayıtta ise o haftanın iş planı hedefiyle örtüşen **netleştirilen, dokümante edilen veya teslime uygun hale getirilen** çıktılar özetlenir. Tarih aralıklarını kendi takviminize göre güncelleyin.


| Hafta | Tarih Aralığı      | Planlanan İş                                                                                                                   | Tahmini Tamamlanma (%) | Durum        |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------ |
| 1     | 07.04 - 13.04.2026 | Sistem mimarisi: `docker-compose` topolojisi, ağ ve servis bağımlılıkları; `docs/` ile kurulum–işletme özeti                   | %42                    | ✅ Tamamlandı |
| 2     | 14.04 - 20.04.2026 | Log toplama hattı: Fluent Bit, Y-modeli (arşiv + analiz kolu), Kafka’ya iletim; uçtan uca akış doğrulama (`test-log-flow` vb.) | %58                    | ✅ Tamamlandı |
| 3     | 21.04 - 27.04.2026 | Graylog: input, stream ve index-set yapısı; ham/normalize ayrımı; temel pipeline davranışının doğrulanması                     | %60                    | ✅ Tamamlandı |
| 4     | 28.04 - 04.05.2026 | Akıllı normalizasyon: profil/lookup, kanonik alan eşlemesi, `quality_control` ve bilinmeyen formatların yönetimi               | %68                    | ✅ Tamamlandı |
| 5     | 05.05 - 11.05.2026 | OpenSearch indeks/arama tarafı; Grafana veri kaynağı, SOC/operasyon panelleri; alarm ve webhook hattı                          | %74                    | ⬜ Başlamadı  |
| 6     | 12.05 - 18.05.2026 | 5651 hattı: değiştirilemez ham arşiv, imzalama süreci ve ilgili otomasyonların gözden geçirilmesi/iyileştirilmesi              | %80                    | ⬜ Başlamadı  |
| 7     | 19.05 - 25.05.2026 | Log Management UI: izleme, konfigürasyon ve operasyonel ekranlarda iyileştirme ve stabilizasyon                                | %86                    | ⬜ Başlamadı  |
| 8     | 26.05 - 01.06.2026 | Güvenlik (TLS/sertifika), üretim parity, senkron/test scriptleri; entegrasyon ve sağlık kontrolleri                            | %91                    | ⬜ Başlamadı  |
| 9     | 02.06 - 08.06.2026 | Bitirme raporu taslağı; eksik modüllerin tamamlanması; kenar durum ve regresyon kontrolleri                                    | %96                    | ⬜ Başlamadı  |
| 10    | 09.06 - 15.06.2026 | Bitirme raporu kesinleştirme ve sunum; son hata düzeltmeleri; teslim paketi ve sürüm/etiket notu                               | %100                   | ⬜ Başlamadı  |


**Durum simgeleri:** ⬜ Başlamadı | 🔄 Devam Ediyor | ✅ Tamamlandı | ⚠️ Gecikti

---

## Haftalık İlerleme Kayıtları

> **Kullanım:** Her hafta şablonu kopyalayın; **en güncel hafta en üstte** olacak şekilde ekleyin. Kayıt, ilgili haftanın iş planı maddeleriyle uyumlu özet içermelidir.

---

### Hafta 4 *(Tarih: 28.04.2026 - 04.05.2026)*

**Plandaki hedef:**

- Akıllı normalizasyon: profil/lookup, kanonik alan eşlemesi, `quality_control` ve bilinmeyen formatların yönetimi

**Bu hafta yaptıklarım:**

- Profil/lookup yapısını gözden geçirip logların kanonik alanlara daha tutarlı eşlenmesini sağladım.
- Normalizasyon akışında bilinmeyen formatların `quality_control` tarafına düşmesini doğruladım.
- Kural setlerinde saha eşleşmelerini netleştirerek hatalı sınıflandırma oranını düşürecek düzenlemeler yaptım.
- Akış doğrulamalarını senaryolarla kontrol edip haftalık kayıt kapsamına aldım.

**Plana göre durumum:**

- Hafta 4 hedefleri planlanan kapsamda tamamlandı.

**Karşılaştığım sorunlar / zorluklar:**

- Bazı log kaynaklarında alan isimlerinin beklenenden farklı gelmesi nedeniyle ek eşleme kuralı ihtiyacı oluştu.

**Gelecek hafta hedefim:**

- İş planı **Hafta 5:** OpenSearch/Grafana tarafı, SOC panelleri ve alarm-webhook hattının doğrulanması.

---

### Hafta 3 *(Tarih: 21.04.2026 - 27.04.2026)*

**Plandaki hedef:**

- Graylog: input, stream ve index-set yapısı; ham/normalize ayrımı; temel pipeline davranışının doğrulanması

**Bu hafta yaptıklarım:**

- Graylog input ve stream yapısını hedeflenen akışa göre düzenleyip ham/normalize ayrımını netleştirdim.
- Index-set tarafında ham ve normalize veri ayrımına uygun kuralları kontrol ettim.
- Pipeline davranışını temel senaryolarla doğrulayarak akışın beklenen şekilde çalıştığını test ettim.
- Haftalık hedefe yönelik teknik düzenlemeleri raporlanabilir şekilde dokümante ettim.

**Plana göre durumum:**

- Hafta 3 hedefleri tamamlandı ve iş planı tablosunda "Tamamlandı" olarak güncellendi.

**Karşılaştığım sorunlar / zorluklar:**

- İlk akış testlerinde bazı stream eşleşmelerinde öncelik sırası kaynaklı sapma görüldü; kural öncelikleri düzenlenerek çözüldü.

**Gelecek hafta hedefim:**

- İş planı **Hafta 4:** akıllı normalizasyon ve `quality_control` akışının güçlendirilmesi.

---

### Hafta 2 *(Tarih: 14.04.2026 - 20.04.2026)*

**Plandaki hedef:**

- Log toplama hattı: Fluent Bit, Y-modeli (arşiv + analiz kolu), Kafka’ya iletim; uçtan uca akış doğrulama (`test-log-flow` vb.)

**Bu hafta yaptıklarım:**

- **5651 / syslog izlenebilirlik:** Merkez Fluent Bit’te syslog UDP/TCP girişlerinde `Source_Address_Key` ile `syslog_sender_ip`; `ingest.syslog` için ham arşiv JSON şablonunda taşıma IP’si ve `compliance_5651` alanı; `docker-compose.syslog-host.yml` ile köprü/NAT durumunun dokümante edilmesi.
- **Şirket / kiracı kodu:** `company_id` için konteyner `COMPANY_ID` ve `.env` üzerinden `LOG_SYSTEM_COMPANY_ID`; `start-fluent-bit.sh` ile yedek varsayılan; `docker-compose.prod.yml` ve geliştirme override ile ortam aktarımı.
- **Log yönetim arayüzü:** Syslog Graylog özetinde transport IP odaklı hiyerarşi, servis (`source`) drilldown, `/api/ingest/syslog-drilldown` uç noktası; envanter tablosunda **Tür** (ajan / syslog relay) ve modal açıklamaları.
- **Grafana SOC:** `master_dashboard.json` içinde ağ/syslog panellerinin `vendor` ve boş tekrarlayıcıdan kaynaklanan boş sonuç sorununun giderilmesi; ECS tabanlı ajan bölümünün syslog’tan ayrıştırılması; syslog hacim ve gönderen IP dağılım sorgularının sadeleştirilmesi.
- **Helm parity:** `fluent-bit` ConfigMap’e syslog parser; syslog girişleri, servis/deployment portları ve `COMPANY_ID` ortamı.

**Plana göre durumum:**

- Hafta 2 iş planının ingest, arşiv ve gözlemlenebilirlik başlıkları büyük ölçüde ilerletildi; tam kapanış için uçtan uca otomatik test (`test-log-flow`) ve Graylog pipeline doğrulaması sonraki iterasyonda sürdürülecek.

**Karşılaştığım sorunlar / zorluklar:**

- Docker köprüsünde `syslog_sender_ip`’nin bazen iç NAT adresi görünmesi (topoloji kısıtı).
- Grafana–OpenSearch tarafında alan adı ve `log_type` eşlemesinin kuruluma göre farklılık gösterebilmesi.

**Gelecek hafta hedefim:**

- İş planı **Hafta 3:** Graylog input, stream ve index-set yapısı; ham/normalize ayrımı ve temel pipeline davranışının sistematik doğrulanması.

---

### Hafta 1 *(Tarih: 07.04.2026 - 13.04.2026)*

**Plandaki hedef:**

- Sistem mimarisi: `docker-compose` topolojisi, ağ ve servis bağımlılıkları; `docs/` ile kurulum–işletme özeti

**Bu hafta yaptıklarım:**

- **Mimari çerçeve:** `docker-compose` ile tanımlı servis topolojisini (Kafka KRaft, Graylog, OpenSearch, Fluent Bit, Log Management UI) Hafta 1 hedefi doğrultusunda gözden geçirdim; `log_net` ağı ile `depends_on` / healthcheck bağımlılıklarını özetleyerek dokümantasyonla tutarlı hale getirdim.
- **Yönetim arayüzü:** Uç nokta envanteri (Agent Fleet), Linux ve Windows tarafı kayıt akışı, kurulum adreslerinin ortam değişkenleriyle tutarlı üretimi ve merkez ingest hattına ilişkin sağlık özetinin panele yansıtılması üzerinde çalışmaları bu haftanın teslim kapsamında toparladım.
- **Windows ajanı:** Fluent Bit için PowerShell kurulumunda Windows hizmet kaydının `sc.exe` ile güvenilir biçimde oluşturulması, kaldırma senaryosu (betik ve panele düşen kayıt) ile servis çöküşünde yeniden deneme ayarlarını netleştirdim.
- **Dokümantasyon:** Agent Fleet ile Windows ajan kurulum ve temizlik adımlarını `docs` altında yazılı hale getirdim; `.env.example` içinde kurulum ve ters vekil senaryosu için kısa yönergeler ekledim.

**Plana göre durumum:**

- İş planındaki Hafta 1 hedefi (mimari özeti ve kurulum–işletme dokümantasyonu) bu rapor kapsamında karşılanmış sayılır. Tablodaki %42 ara hedefi ile uyumludur. Sonraki adımda Hafta 2’deki log toplama hattı ve uçtan uca doğrulama işine geçilebilir.

**Karşılaştığım sorunlar / zorluklar:**

- Graylog REST arayüzünde sürüme bağlı davranış farkları (istek biçimi ve yanıt yapısı) yönetim arayüzü kodunda uyum çalışması gerektirdi.
- Windows’ta `sc.exe create` satırının PowerShell tarafından yanlış parçalanması ve `sc` yardım metninin basılması; servis oluşturma komutunu tek tek argüman olarak iletecek biçimde düzenleyerek ve görünen adı sadeleştirerek giderildi.
- Ters vekil kullanıldığında ajan betiklerinde panel adresinin doğru çıkması için `LOG_PLATFORM_PUBLIC_BASE_URL` (veya eşdeğer) ortam değişkenlerinin doğru tanımlanması gerektiği.

**Gelecek hafta hedefim:**

- İş planı **Hafta 2:** log toplama hattı (Fluent Bit, Y-modeli, Kafka’ya iletim); uçtan uca akış doğrulama (`test-log-flow` ve benzeri senaryolar).

---

