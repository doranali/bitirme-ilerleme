/**
 * LogPanel.modules.help — Yardim ve baglamsal "Bilgi al" pencereleri.
 *
 * Sorumluluk:
 *  - Yardim tabinda surum/sistem bilgisi kartini doldurmak.
 *  - Tum tablarda tek tip "Bilgi al" dugmesi ile acilan popover sunmak.
 */
(function attachHelp(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    NS.modules = NS.modules || {};
    if (NS.modules.help && NS.modules.help.__sealed) return;

    const ui = NS.ui;
    const api = NS.api;

    function $(s, r) { return (r || document).querySelector(s); }
    function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

    const HELP_CONTENT = {
        'overview': {
            title: 'Genel Bakış',
            role: 'viewer+',
            body: 'KPI bandı, "bugün ne yapmalıyım" listesi, servis sağlık ve hızlı eylemler. Operasyon Özeti altındaki EPS / drop-rate / gecikme / bottleneck satırı Fluent Bit metrik trendine dayanır; henüz ingest yokken tire (—) ve bottleneck «Henüz ölçülemedi» normaldir.',
            issues: 'Boş kart görüyorsanız panel servisi yeniden başlatılmış olabilir; "Yenile" düğmesini kullanın.'
        },
        'services': {
            title: 'Servisler',
            role: 'operator+',
            body: 'Docker servis durumu, Kafka lag, ISM özeti, canlı özet. Rol ayrımı: Grafana — SOC KPI grafikleri ve alarmlar; Graylog — akış, pipeline, girişler ve ham log araması; bu panel — 5651, kullanıcılar, envanter ve raporlama.',
            issues: 'Bir servis "unhealthy" ise satıra tıklayıp logları açın; Kafka lag yüksekse Graylog Kafka tüketicisini kontrol edin.'
        },
        'config': {
            title: 'Yapılandırma',
            role: 'admin',
            body: 'docker-compose, .env, certs ve dosya tabanlı yapılandırma kataloğu. Değişiklik canlıya yansır.',
            issues: 'Manuel düzenleme yapıyorsanız "Yedek al" düğmesini önce çalıştırın.'
        },
        'agent-fleet': {
            title: 'Uç envanteri',
            role: 'operator+',
            body: 'Agent listesi, token üret, sertifika yenile, toplu eylem, self-test (Faz 5).',
            issues: 'Liste boş gelirse: rolünüz operatör+ olmalı, token üretilmiş olmalı; "Disk eşitle" düğmesi nodes.json hizalama yapar.'
        },
        'settings': {
            title: 'Ayarlar',
            role: 'operator+ (admin alanlar gizli)',
            body: '.env katalog + grup arama, depolama, sürüm bilgisi, kısayollar, Kubernetes operasyonları. Özet kartında kritik ayarları dosya düzenlemeden yönetirsiniz; kyıtlı otomatik kontrol health/ingest smoke çalıştırır.',
            issues: 'Kaydet sonrası ilgili konteyner yeniden başlatılır; sayfa kısa süre yüklenmiyor görünebilir.'
        },
        'settings-overview': {
            title: 'Özet ve doğrulama',
            role: 'operator+',
            body: 'Kritik ayar sayıları, ayar uygulama modu ve kayıt sonrası otomatik kontrol (health, ingest, sorgu smoke) bu blokta gösterilir.',
            issues: 'Kontrol başarısızsa mesaj satırını okuyun; ilgili servis sekmesinden healthy durumunu doğrulayın.'
        },
        'monitoring': {
            title: 'İzleme',
            role: 'viewer+',
            body: 'Üst bant KPI: Ingest rate = Fluent Bit tüm UDP girişleri toplam kayıt (Prometheus); Graylog ile bire bir değildir. Disk basıncı = data dizini kullanımı. QC = quality_control stream mesaj sayısı (1 saat). Output hataları = Fluent Bit çıkış hata sayısı.',
            issues: 'Ingest 0 ise ilk olarak Servisler → fluent-bit healthy mi bakın.'
        },
        'alerts': {
            title: 'Alarmlar (Faz 6)',
            role: 'operator+ (silme/ekleme admin)',
            body: 'Telegram bildirim kanalları, Grafana kural listesi (read-only), eskalasyon merdiveni, geçmiş + susturma.',
            issues: 'Test çalışmıyorsa: Ayarlar → TELEGRAM_BOT_TOKEN dolu mu? Bot, sohbete eklenmiş mi?'
        },
        'log-search': {
            title: 'Log Arama (Faz 2)',
            role: 'viewer+ (export operator+)',
            body: 'OpenSearch tam metin arama (Lucene), zaman aralığı, kaydedilmiş aramalar, CSV export.',
            issues: 'Sonuç gelmiyorsa zaman aralığını genişletin; sorgu boş olabilir.'
        },
        'logs': {
            title: 'Audit Log',
            role: 'admin',
            body: 'Panel içi kullanıcı eylemleri (login/CRUD/silme).',
            issues: 'Eski kayıtlar JSON dosyasında saklanır (data/audit_events.jsonl).'
        },
        'archive': {
            title: '5651 Compliance (Faz 3)',
            role: 'operator+ (rapor admin)',
            body: 'Arşiv durumu, imza geçmişi, manifest doğrulama ve hukuki rapor.',
            issues: 'İmzalar başarısız ise signing-engine konteynerini kontrol edin; TSA bağlantısı zaman aşımı yaygın sebeptir.'
        },
        'users-security': {
            title: 'Kullanıcılar & Güvenlik (Faz 7)',
            role: 'admin',
            body: 'Kullanıcı CRUD, rol matrisi, audit log, login geçmişi.',
            issues: 'Son admin kullanıcıyı silemezsiniz; rol değişikliği oturum sonra etki eder.'
        },
        'help': {
            title: 'Yardım Merkezi (Faz 9)',
            role: 'tüm roller',
            body: 'SSS, tab açıklamaları, sürüm bilgisi ve hızlı bağlantılar.',
            issues: 'Daha detaylı doküman için repo içindeki docs/ klasörüne bakın.'
        },
        'services-storage': {
            title: 'Servislerde Veri (bind) alanı',
            role: 'operator+',
            body: 'Bu sütunda her servisin bind mount dizinlerinin yaklaşık toplamı gösterilir. Konteyner başına kota değil, host üzerindeki paylaşımlı disk kullanımıdır.',
            issues: 'Disk doluluğunda önce paylaşılan bölüm özetine bakın, sonra Ayarlar bölümündeki depolama adımlarını uygulayın.'
        },
        'live-summary-native': {
            title: 'Canlı özet verisi nereden geliyor?',
            role: 'viewer+',
            body: 'Fluent Bit :2020 Prometheus metrikleri, Graylog /system/throughput ve journal, OpenSearch _cluster/health, Kafka consumer-groups (graylog-raw-consumer), signing-engine /health, Grafana /api/health — panel bu uçları doğrudan veya Docker exec ile okur. Grafana veriyi görselleştirir; log satırı araması için Graylog veya Log Arama sekmesi kullanılır.',
            issues: 'signing-engine host ağı kullanıyorsa iç URL erişilemeyebilir; SIGNING_ENGINE_INTERNAL_URL ile düzeltin.'
        },
        'parse-quality': {
            title: 'Parse Kalitesi (QC stream)',
            role: 'operator+',
            body: 'quality_control stream’ine düşen mesajlar OpenSearch üzerinde kaynak kırılımı ile listelenir. Yeni format için src/services/graylog/vendor-packs/ altına CSV ekleyip graylog-post-init çalıştırın. «Yeni format keşfi» tablosunda profil düğmesi varsayılan src/dst alanlarını kullanır; ayrıntı için Ayarlar → Normalizasyon (QC) veya vendor pack dokümanına bakın.',
            issues: 'Agregasyon boşsa source.keyword mapping eksik olabilir; yine de örnek mesajlar görünebilir.'
        },
        'fleet-inventory': {
            title: 'Uç envanteri nasıl okunur?',
            role: 'operator+',
            body: 'Envanter listesi heartbeat ve Graylog hacmini birlikte gösterir. Liste boşsa önce Yenile, hala boşsa Disk eşitle ile nodes.json ve enrollment kayıtlarını hizalayın. Satıra tıklayınca özet ve son mesajlar açılır. «Son panel IP» = HTTP heartbeat/activate; UDP log kaynağı IP’si değildir. Token ile kurulan syslog relay satırları için üstteki Syslog görünürlüğü kartlarına bakın.',
            issues: '"Güncel" etiketi heartbeat tazeliğini ifade eder; 24s/7g alanları mesaj sayısıdır. Syslog-only cihazlar envantere satır düşmeyebilir. Graylog sayımı * veya boş hücre: sorgu hatası veya indeks yok olabilir. Listeden kaldırma token silmez; kalıcı iptal için token iptali kullanın.'
        },
        'fleet-syslog': {
            title: 'Syslog görünürlüğü',
            role: 'operator+',
            body: 'Son 7 günlük network logları taşıyıcı IP bazında gruplanır. Cihazlar için aynı merkez IP üzerinde varsayılan UDP/TCP 1514 hedeflenir; karttan emitter ve örnek kayıt detayına inebilirsiniz.',
            issues: 'source alanı her zaman tek fiziksel cihazı temsil etmeyebilir. Drilldown içinde istemci IP için syslog_sender_ip alanı önceliklidir.'
        },
        'fleet-enrollment': {
            title: 'Kurulum ve token akışı',
            role: 'admin',
            body: 'Sihirbaz akışı: kaynak türü → ajan kurulabilir mi → panelin erişilebilir IP veya hostname (ve ajan UDP portu; çoğu kurulumda 5151) → admin ile kurulum bağlantısı → test komutu ve Graylog kontrolü. '
                + 'Özet: Fluent Bit ajanı merkeze UDP üzerinden JSON gönderir (çoğu kurulumda 5151). Syslog gönderen cihazlar (firewall, vCenter vb.) aynı merkez adresine UDP veya TCP 1514 kullanır; bu iki port karışmamalı. '
                + 'Adım 5 self-testi yalnızca ajan JSON portunu doğrular; syslog için cihazdan gönderim yapıp «Syslog görünürlüğü» bölümünden kontrol edin. Graylog’da kullanıcı profilinde time zone operasyon saat diliminize (ör. Europe/Istanbul) ayarlanmalı. '
                + 'Token üretimi admin ister; gelişmiş modda profil, company/site ve relay ayrıntıları vardır.',
            issues: 'En sık hata: ajan 5151 ile syslog 1514’ü karıştırmak. Sızan token’ı iptal edin. Yanlış public adres kurulumun merkeze ulaşmasını engeller.'
        },
        'fleet-bulk': {
            title: 'Toplu eylemler',
            role: 'admin',
            body: 'Hostname listesiyle sertifika yenileme, config push ve yeniden başlatma talebi kuyruğa alınır.',
            issues: 'Eylemler anında değil, agent bir sonraki heartbeat gönderdiğinde uygulanır.'
        },
        'fleet-selftest': {
            title: 'Hızlı sağlık tanılaması',
            role: 'operator+',
            body: 'Panel, Docker, Graylog, Kafka ve bekleyen agent eylemleri tek ekranda kontrol edilir.',
            issues: 'Bir adım fail ise ilgili tabdaki detay loglara gidip kök nedeni doğrulayın.'
        },
        'alerts-channels': {
            title: 'Telegram bildirim kanalları',
            role: 'operator+',
            body: 'Grafana alarmları alert-webhook üzerinden Telegram kanallarına iletilir.',
            issues: 'Test başarısızsa önce TELEGRAM_BOT_TOKEN tanımını ve botun sohbet yetkilerini doğrulayın.'
        },
        'alerts-rules': {
            title: 'Grafana alarm kuralları',
            role: 'operator+',
            body: 'Bu liste provisioning dosyasından okunur. Kural eşiği ve bekleme süresi genelde rules.yaml üzerinden değiştirilir. Grafana Alerting için tam URL API yanıtıyla ayarlanır.',
            issues: 'Kuralları değiştirdikten sonra Grafana yeniden başlatılmalı veya provisioning yeniden yüklenmelidir.'
        },
        'alerts-escalation': {
            title: 'Eskalasyon merdiveni',
            role: 'admin',
            body: 'Olay süresine göre hangi kanal/etiketin bilgilendirileceğini adım adım belirler.',
            issues: 'Boş channelTag varsayılan kanala düşer; dakika değerlerini küçükten büyüğe girin.'
        },
        'alerts-history': {
            title: 'Alarm geçmişi ve susturma',
            role: 'operator+',
            body: 'Geçmiş kayıtlar alert-webhook loglarından, susturmalar panelde yerel kayıt olarak tutulur.',
            issues: 'Aktif susturma panel filtresidir; Grafana tarafına doğrudan silence kaydı yazmaz.'
        },
        'monitoring-resources': {
            title: 'Kaynak kullanımı metrikleri',
            role: 'viewer+',
            body: 'İlk iki çubuk gerçek host CPU/RAM değil, servis çalışırlık/sağlık özetidir. Disk çubuğu panelin gördüğü kök disk doluluğunu temsil eder.',
            issues: 'Gerçek host metrikleri için node-exporter veya altyapı izleme paneline bakın.'
        },
        'fleet-advanced': {
            title: 'Gelişmiş kurulum modu',
            role: 'admin',
            body: 'Relay senaryoları, ingest host/port, company/site kimlikleri ve TTL gibi ayrıntılı ayarlar bu alanda yönetilir. Profil seçimi token üretiminde doğrudan kullanılır.',
            issues: 'Yanlış ingest/relay portu veri akışını kesebilir. Syslog 1514 ve ajan 5151 ayrımını koruyun, değişiklikten sonra yeni token ile doğrulama yapın.'
        },
        'settings-catalog': {
            title: 'Ortam değişkenleri kataloğu',
            role: 'operator+/admin',
            body: 'Rolünüze açık .env anahtarlarını arayıp güncellersiniz. Akış: ayarı seç → değeri güncelle → detayda etki alanını kontrol et → kaydet; gerekirse üstteki otomatik kontrolü çalıştırın.',
            issues: 'Kritik anahtar değişimlerinden sonra ilgili servislerin yeniden yüklenmesi gerekebilir.'
        },
        'settings-release': {
            title: 'Release yönetimi',
            role: 'admin',
            body: 'Mevcut release tag ve promotion komutları burada listelenir. Deploy başarısız olursa otomatik rollback önceki tag’e döner. Örnek: make promote-staging TAG=v1.0.0 veya make promote-prod TAG=v1.0.0',
            issues: 'Promote komutlarını yalnızca yetkili ortamda çalıştırın; TAG’i doğrulayın.'
        },
        'settings-normalization': {
            title: 'Normalizasyon (QC → mapping)',
            role: 'operator+',
            body: 'Quality Control stream’den örnek mesaj seçilir; vendor, product, os_major doğrulanır ve lookup tablosuna eklenir. Lookup yaklaşık 60 sn içinde yenilenir.',
            issues: 'Örnek gelmiyorsa QC stream ve Graylog pipeline sırasını kontrol edin.'
        },
        'settings-shortcuts': {
            title: 'Yapılandırma kısayolları',
            role: 'operator+',
            body: 'Bu düğmeler sık dosyaları Yapılandırma sekmesinde açar. Düzenleme yetkisi rolunuze bağlıdır (çoğunlukla admin).',
            issues: 'Dosya açılmıyorsa rolünüzü ve dosya yolunu doğrulayın.'
        },
        'settings-k8s-hpa': {
            title: 'HPA politika merkezi',
            role: 'admin',
            body: 'Servislerin min/max replica ve CPU/Memory hedefleri buradan yönetilir (Kubernetes ortamında).',
            issues: 'Grid görünmüyorsa platform Docker modundadır veya API erişimi yoktur.'
        },
        'settings-k8s-rollout': {
            title: 'Rollout / rollback',
            role: 'admin',
            body: 'Deployment yeniden başlatma ve revision bazlı geri dönüş işlemleri bu bloktadır.',
            issues: 'Yanlış deployment seçimi üretim kesintisi yapabilir; aksiyon öncesi adı doğrulayın.'
        },
        'settings-storage-hub': {
            title: 'Depolama hub',
            role: 'operator+',
            body: 'Önerilen veri kökü: /opt/log-system/data. Disk ekledikten sonra «Disk listesini yenile» ve gerekirse «Sistemi yeni diski tanıtsın» kullanın. Log ve arşiv dosyalarının tutulduğu disk; üç özet kutu durumu gösterir. «Kayıtlı veri klasörünü seç» adımında listeden veya özel yol ile seçim yapılır; kayıt öncesi yol onayı yanlış diske yazmayı azaltır. İleri düzey: ham disk, wipe, FS büyütme ve OS kök diski riskli işlemler «İlk kurulum…» bölümündedir — yedek ve onay şarttır.',
            issues: '5651 için veri dizini mümkünse OS diskinden ayrı tutulmalıdır; tek disk kullanımında panel uyarı ve onay ister.'
        },
        'archive-retention': {
            title: 'Retention ve lifecycle',
            role: 'operator+',
            body: 'OpenSearch ISM örneği: graylog-90gun — Hot 7 gün → Warm 83 gün → Delete (90 gün). Grafana/Graylog tam aranabilir pencere. WORM arşiv 5651 için 2 yıl tutulur.',
            issues: 'Retention değişikliği yasal gereksinimle uyumlu olmalıdır.'
        },
        'archive-signing-engine': {
            title: 'İmzalama motoru',
            role: 'operator+',
            body: 'Signer OPEN_SOURCE: SHA256 + manifest zinciri. TUBITAK: TSA zaman damgası. Zamanlanmış görevler: imza (ör. 00:01), günlük rapor (ör. 01:00) — ortamınızdaki cron ile uyumlu olabilir.',
            issues: 'İmza hatasında TSA ağı, disk doluluğu ve signing-engine konteyner loglarına bakın.'
        },
        'archive-verify-hash': {
            title: 'Hash doğrulama',
            role: 'operator+',
            body: 'Elinizdeki SHA256 değerini sistemde kayıtlı imzayla karşılaştırır; adli denetim ve bütünlük kontrolü için kullanılır.',
            issues: 'Tarih ve hash alanlarını tam girin; uyuşmazlıkta arşiv ve manifest dosyalarını inceleyin.'
        },
        'archive-legal-report': {
            title: 'Hukuki rapor',
            role: 'admin',
            body: 'Seçilen dönem için 5651 uyumluluk raporu (JSON): hash zinciri, imzalı/eksik gün listesi, retention bilgisi.',
            issues: 'Rapor üretimi disk ve API yükü oluşturabilir; dar tarih aralığı ile deneyin.'
        },
        'log-search-syntax': {
            title: 'Sorgu ipuçları (Lucene)',
            role: 'viewer+',
            body: 'Örnekler: source:host01 — kaynak; level:<=3 — hata ve üstü; message:"connection refused" — tam metin; NOT message:debug — debug hariç; * — tümü.',
            issues: 'Sonuç yoksa zaman aralığını genişletin ve indeks gecikmesini göz önünde bulundurun.'
        },
        'setup-wizard': {
            title: 'Hızlı kurulum sihirbazı',
            role: 'admin',
            body: 'Dokuz adımlı sihirbaz sistemi devreye almanıza yardım eder. Zorunlu adımlar bitmeden kapanmaz; önerilen ve opsiyonel adımlar atlanabilir. Sol listede: Zorunlu = kapanmadan tamamlanmalı; Önemli = atlanabilir, sonradan önerilir; Opsiyonel = tamamen atlanabilir.',
            issues: 'Takılırsa Yardım sekmesi ve docs/; adım başına «Bilgi al» metinlerini açın.'
        },
        'setup-wizard-admin-password': {
            title: 'Admin parolası',
            role: 'admin',
            body: 'Kullanıcılar sekmesinden admin parolasını değiştirin. Parola en az 12 karakter; en az 1 büyük, 1 küçük harf, 1 sayı ve 1 özel karakter; sözlük veya kullanıcı adına benzer olmamalı.',
            issues: 'Default parola uyarısı görüyorsanız hemen değiştirin.'
        },
        'setup-wizard-company': {
            title: 'Şirket ve panel kimliği',
            role: 'admin',
            body: 'company_id, site_id, panel başlığı ve saat dilimi agent profillerinde, raporlarda ve panel başlığında kullanılır. company_id: yalın, küçük harf, tire veya alt çizgi (ör. firma-merkez).',
            issues: 'Yanlış saat dilimi rapor saatlerini kaydırır.'
        },
        'setup-wizard-public-url': {
            title: 'Public taban URL',
            role: 'admin',
            body: 'Agent kurulum komutlarındaki $LpApi ve Linux MANAGEMENT_API bu adresten türetilir. Yanlış URL uzak agent bağlantısını kırar. Tam https://… adresi girin; mümkünse otomatik tespit önerisini doğrulayın.',
            issues: 'TLS ve reverse proxy arkasında doğru dış hostname kullanıldığından emin olun.'
        },
        'setup-wizard-signer': {
            title: '5651 imzalama tipi',
            role: 'admin',
            body: 'Günlük log arşivleri zaman damgalı imzalanmalı. TÜBİTAK Kamu SM: resmi TSA, internet + müşteri sertifikası, hukuki kabul yüksek. Açık kaynak RFC3161: örn. public TSA, RFC3161, internet gerekir. Yerel offline: RSA-4096 + Merkle, internet yok; güven yerel anahtarda.',
            issues: 'TSA zaman aşımı veya sertifika hatasında signing-engine loglarına bakın.'
        },
        'setup-wizard-tls': {
            title: 'HTTPS / TLS',
            role: 'admin',
            body: 'Üç yol: (1) Kurulumun ürettiği self-signed — tarayıcı uyarısı, OS güven deposu gerekebilir. (2) TLS_CERT_PATH / TLS_KEY_PATH ile kendi sertifikanız — Ayarlar. (3) nginx-proxy-manager + Let\'s Encrypt ile alan adlı CA imzalı sertifika.',
            issues: 'Sertifika süresi dolunca yenileyin; zincir eksikse tarayıcı reddeder.'
        },
        'setup-wizard-retention': {
            title: 'Retention ve veri yolu',
            role: 'admin',
            body: 'Hot retention: OpenSearch’te hızlı arama penceresi (gün). Toplam saklama: 5651 için en az 730 gün. Öneri: hot 7–14 gün, toplam 730–1095 gün. Veri yolu genelde /opt/log-system/data.',
            issues: 'Disk dolmadan önce depolama hub ve ISM politikalarını gözden geçirin.'
        },
        'setup-wizard-backup': {
            title: 'Yedek / arşiv hedefi',
            role: 'admin',
            body: '5651 imzalı arşiv ve günlük yedekler bu hedefe kopyalanır. Yerel: varsayılan, aynı sunucuda arşiv klasörü. MinIO/S3/SFTP: felaket kurtarma için uzak hedef; endpoint, bucket ve kimlik bilgileri adım formunda.',
            issues: 'Erişim anahtarlarını güvenli tutun; bağlantı testi ile doğrulayın.'
        },
        'setup-wizard-telegram': {
            title: 'Telegram bildirimleri',
            role: 'admin',
            body: '@BotFather ile bot oluşturup token alın; sohbette /start sonrası chat_id öğrenin (ör. @userinfobot veya grup id). botfather: https://core.telegram.org/bots#how-do-i-create-a-bot',
            issues: 'Token veya chat_id yanlışsa test mesajı düşmez; botun gruba/kanala ekli olduğundan emin olun. Token alanını boş bırakırsanız mevcut token korunur.'
        },
        'setup-wizard-first-agent': {
            title: 'İlk uç nokta',
            role: 'admin',
            body: 'Linux veya Windows Fluent Bit ajanı ya da syslog cihazı bağlayabilirsiniz. Bu adım atlanabilir; sonradan Uç envanteri sekmesinden devam edilir.',
            issues: 'Ajan adresi ve port (5151 vs 1514) karışmaması için Uç envanteri Bilgi al metnine bakın.'
        },
        'change-summary': {
            title: 'Değişiklik özeti',
            role: 'operator+',
            body: 'Kaydetmeden önce bu özet etki alanını ve değişen anahtarları gösterir. Onayla ve Kaydet ile kalıcı yazma yapılır.',
            issues: 'Emin değilseniz İptal ile çekilin; Audit Log kaydı oluşur.'
        },
        'services-kafka-ism': {
            title: 'Kafka ve ISM (read-only)',
            role: 'operator+',
            body: 'Kafka kartı topic ve consumer lag özetidir. ISM kartı OpenSearch politika özetidir; gün sayılarını değiştirmek için Yapılandırma sekmesindeki ISM düzenleyiciyi kullanın — bu görünüm salt okunur.',
            issues: 'Kafka boşsa cluster veya API erişimini doğrulayın.'
        },
        'settings-perf': {
            title: 'Performans (VM Auto-Tune)',
            role: 'admin',
            body: 'Graylog/OpenSearch heap önerileri RAM’e göre hesaplanır ve .env üzerine yazılır. Uygulama adımı servis yeniden oluşturmayı tetikleyebilir.',
            issues: 'Compose recreate devre dışı ise öneriler yazılır ama konteyner otomatik yeniden kurulmaz.'
        }
    };

    let _activePopover = null;
    let _activeAnchor = null;
    let _onDocumentClick = null;

    function closePopover() {
        if (_activeAnchor) {
            _activeAnchor.setAttribute('aria-expanded', 'false');
            _activeAnchor = null;
        }
        if (_onDocumentClick) {
            document.removeEventListener('click', _onDocumentClick);
            _onDocumentClick = null;
        }
        if (_activePopover) {
            _activePopover.remove();
            _activePopover = null;
        }
    }

    function openPopover(anchorEl, key) {
        const help = HELP_CONTENT[key];
        if (!help) return;
        if (_activeAnchor === anchorEl && _activePopover) {
            closePopover();
            return;
        }
        closePopover();
        const pop = document.createElement('div');
        pop.className = 'lp-help-popover';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', `${help.title} bilgisi`);
        pop.innerHTML = `
            <button type="button" class="lp-help-popover-close" aria-label="Kapat">&times;</button>
            <h4><i class="fas fa-circle-info"></i> ${ui.escapeHtml(help.title)}</h4>
            <span class="lp-help-meta">Yetki: ${ui.escapeHtml(help.role)}</span>
            <p>${ui.escapeHtml(help.body)}</p>
            <div class="lp-help-issues"><strong>Sık sorun:</strong> ${ui.escapeHtml(help.issues)}</div>
        `;
        document.body.appendChild(pop);
        const rect = anchorEl.getBoundingClientRect();
        const top = Math.min(rect.bottom + 6, window.innerHeight - 220);
        const left = Math.min(rect.left, window.innerWidth - 380);
        pop.style.top = `${top}px`;
        pop.style.left = `${Math.max(8, left)}px`;
        pop.querySelector('.lp-help-popover-close').addEventListener('click', closePopover);
        _activePopover = pop;
        _activeAnchor = anchorEl;
        _activeAnchor.setAttribute('aria-expanded', 'true');
        _onDocumentClick = (e) => {
            if (_activePopover && !_activePopover.contains(e.target) && !_activeAnchor.contains(e.target)) {
                closePopover();
            }
        };
        setTimeout(() => document.addEventListener('click', _onDocumentClick), 0);
    }

    function buildInfoButton(helpKey, compact) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = compact ? 'btn btn-sm btn-secondary lp-inline-info-btn' : 'btn btn-sm btn-secondary lp-tab-info-btn';
        btn.setAttribute('data-help-key', helpKey);
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<i class="fas fa-circle-info"></i> Bilgi al';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPopover(btn, helpKey);
        });
        return btn;
    }

    function injectTabInfoButtons() {
        Object.keys(HELP_CONTENT).forEach(key => {
            const tab = document.getElementById(key);
            if (!tab) return;
            const titleEl = tab.querySelector('.section-title h3');
            if (!titleEl) return;
            if (titleEl.parentElement.querySelector('.lp-tab-info-btn')) return;
            titleEl.insertAdjacentElement('afterend', buildInfoButton(key, false));
        });
    }

    function bindInlineInfoButtons() {
        $$('[data-help-key]').forEach((el) => {
            if (el.__helpBound) return;
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openPopover(el, el.getAttribute('data-help-key'));
            });
            el.__helpBound = true;
        });
    }

    // -------- Help tab: version / system info --------
    async function loadVersionInfo() {
        const root = $('#lp-help-version-content');
        if (!root) return;
        ui.loadingState(root, { message: 'Bilgi alınıyor...' });
        try {
            const [release, health] = await Promise.all([
                api.get('/api/release/status').catch(() => ({})),
                api.get('/api/health').catch(() => ({})),
            ]);
            root.innerHTML = `
                <table class="table">
                    <tbody>
                        <tr><td><strong>Sürüm tag</strong></td><td><code>${ui.escapeHtml(release.currentTag || 'dev')}</code></td></tr>
                        <tr><td><strong>Ortam</strong></td><td><span class="badge badge-info">${ui.escapeHtml(release.environment || '-')}</span></td></tr>
                        <tr><td><strong>Docker</strong></td><td>${ui.escapeHtml(health.docker || '-')}</td></tr>
                        <tr><td><strong>Servis sayısı</strong></td><td>${ui.escapeHtml(`${health.services_running || 0} / ${health.services_total || 0}`)}</td></tr>
                        <tr><td><strong>Sorunlu servis</strong></td><td>${ui.escapeHtml(String(health.services_problematic || 0))}</td></tr>
                        <tr><td><strong>Config sağlığı</strong></td><td>${health.config_healthy ? '<span class="badge badge-success">OK</span>' : '<span class="badge badge-warning">Eksik</span>'}</td></tr>
                        <tr><td><strong>Storage env</strong></td><td><code>${ui.escapeHtml((health.panel || {}).storageEnv || '-')}</code></td></tr>
                        <tr><td><strong>Lisans</strong></td><td>Apache 2.0 (panel) — bağımlı bileşenler için ilgili lisanslar.</td></tr>
                    </tbody>
                </table>
            `;
        } catch (e) {
            ui.errorState(root, e, { title: 'Bilgi alınamadı', retry: loadVersionInfo });
        }
    }

    function bind() {
        injectTabInfoButtons();
        bindInlineInfoButtons();
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closePopover();
        });

        const ref = $('#lp-help-version-refresh');
        if (ref && !ref.__bound) { ref.addEventListener('click', loadVersionInfo); ref.__bound = true; }

        const tab = document.getElementById('help');
        if (tab) {
            const obs = new MutationObserver(() => {
                if (tab.classList.contains('active')) loadVersionInfo();
            });
            obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
            if (tab.classList.contains('active')) loadVersionInfo();
        }

        setTimeout(() => { injectTabInfoButtons(); bindInlineInfoButtons(); }, 1500);
        setTimeout(() => { injectTabInfoButtons(); bindInlineInfoButtons(); }, 4000);
    }

    function init() {
        if (!api || !ui) return;
        bind();
    }

    NS.modules.help = {
        __sealed: true, init, loadVersionInfo, openPopover, closePopover,
        /** Dinamik eklenen Bilgi al düğmeleri için (ör. kurulum sihirbazı) */
        bindInlineHelpButtons: bindInlineInfoButtons,
    };

    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
})(window);
