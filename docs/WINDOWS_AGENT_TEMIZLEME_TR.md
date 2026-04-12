# Windows log ajanını temizleme ve yeniden test

Bu doküman, **Log Platform Windows Fluent Bit ajanını** hedef makineden kaldırmak ve yeni bir enrollment token ile tekrar denemek için kullanılır.

## Önerilen yol: panelden üretilen kaldırma betiği (tek komut)

1. Panele **admin** ile girin → **Ayarlar** → **Kaynak toplama (Agent Fleet)**.
2. **Windows Agent** ile yeni token ürettiğinizde veya daha önce ürettiğiniz token için aynı blokta şunlar görünür:
  - **Kurulum URL** / kurulum komutu
  - **Windows kaldırma URL** (`…/api/agent/uninstall/<TOKEN>.ps1`)
  - **Kaldırma** için tek satırda kopyalanabilir PowerShell bloğu
3. Kaldırma komutunu hedef Windows’ta **Yönetici PowerShell** ile çalıştırın.

Betiğin yaptıkları (kurulum betiğiyle uyumlu):

- `LogPlatformFluentBit` (veya `.env` içindeki `FLUENT_BIT_WINDOWS_SERVICE_NAME`) hizmetini durdurur ve siler
- **LogPlatformAgentHeartbeat** zamanlanmış görevini kaldırır
- `%ProgramData%\LogPlatformFluentBit` ve `%SystemDrive%\LogPlatformFluentBit` dizinlerini siler
- Merkeze `**POST /api/agent/uninstall-notify`** ile bildirim gönderir:
  - **Loglar** sekmesinde **audit** satırı: `agent.windows_uninstall`
  - **Uç nokta envanteri**nde ilgili kayıt **Kaldırıldı** olarak işaretlenir (`agentLifecycle: uninstalled`)

**Not:** Kaldırma URL’si, kurulumda kullandığınız **aynı ham enrollment token**’ı içerir. Token panel kayıtlarında tanımlı olmalıdır (süresi dolmuş veya iptal edilmiş token ile de indirilebilir; geçersiz token ile indirme 404 döner).

## Elle temizlik (betik kullanmadan)

Yönetici PowerShell veya CMD:

```powershell
Stop-Service -Name LogPlatformFluentBit -Force -ErrorAction SilentlyContinue
sc.exe delete LogPlatformFluentBit
Unregister-ScheduledTask -TaskName 'LogPlatformAgentHeartbeat' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$env:ProgramData\LogPlatformFluentBit" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$env:SystemDrive\LogPlatformFluentBit" -Recurse -Force -ErrorAction SilentlyContinue
```

Servis adını özelleştirdiyseniz `LogPlatformFluentBit` yerine `.env` içindeki `FLUENT_BIT_WINDOWS_SERVICE_NAME` değerini kullanın.

`**sc delete` sonrası yeniden kurulum:** Bazen SCM kaydı tam temizlenene kadar birkaç saniye veya **bir kez yeniden başlatma** gerekir. Kurulum betiği `sc query` ile bekler; yine de «Cannot start service» görürseniz sunucuyu yeniden başlatıp aynı `.ps1` ile tekrar deneyin.

### Olay Günlüğü: 7045 «servis kuruldu» yeterli değil

**7045** yalnızca kurulum kaydıdır; **başlatma hatası** çoğunlukla şu System günlüğü kayıtlarındadır (İngilizce Windows’ta ileti metinleri İngilizce olur):

- **7000** — The … service failed to start
- **7001** — User logon notification
- **7009** — A timeout was reached (1053)
- **7023** — The … service terminated with the following error
- **7024** — The … service terminated unexpectedly

Aşağıdaki sorgu, son **3 saat** içinde **Service Control Manager** kaynaklı ilgili olayları listeler (`AddHours(-3)` değerini kurulum saatinize göre büyütün):

```powershell
$t = (Get-Date).AddHours(-3)
Get-WinEvent -LogName System -MaxEvents 800 |
  Where-Object {
    $_.TimeCreated -gt $t -and
    $_.ProviderName -eq 'Service Control Manager' -and
    $_.Id -in @(7000,7001,7009,7023,7024,7040,7045)
  } |
  Select-Object TimeCreated, Id, Message |
  Format-List
```

Servisin SCM’de kayıtlı **tam komut satırını** görmek için:

```powershell
sc.exe qc LogPlatformFluentBit
```

Elle başlatıp **metin çıktısını** görmek (CMD veya PowerShell):

```powershell
sc.exe start LogPlatformFluentBit
# veya
net start LogPlatformFluentBit
```

Çıkan hata kodu (ör. **1053**, **1069**) araması genelde doğrudan kök nedeni gösterir.

`**sc.exe create` → `Invalid start= field` veya yalnızca USAGE / DESCRIPTION:** `sc.exe` komut satırı yanlış ayrıştığında (özellikle PowerShell’de `& sc.exe create …` ile birleşik argümanlar) `sc` yardım metnini basar. Güncel betik `sc` argümanlarını **dizi (splatting)** ile verir; görünen ad **boşluksuz** `LogPlatformFluentBit` olur, açıklama `sc description` ile «Log Platform Fluent Bit agent» kalır. Eski `.ps1` kullanmayın; panelden yeniden indirin.

### «Servis başlatılamadı» ama Fluent Bit elle çalışıyorsa

Bu genelde **Hizmet Denetim Yöneticisi** (binPath / bağımlılık / gecikmeli başlatma) kaynaklıdır; zip veya `winlog` çoğu zaman sağlamdır. Güncel kurulum betiği `sc.exe create` ile `binPath` üretir; merkez `.env` için:

- `FLUENT_BIT_WINDOWS_SERVICE_DEPEND_TCP=0` (varsayılan; Tcpip bağımlılığı kapalı)
- `FLUENT_BIT_WINDOWS_DELAYED_START=0` (varsayılan; gecikmeli otostart kapalı)

Panel `log-management-ui` konteynerini bu `.env` ile yeniden oluşturduktan sonra Windows’tan **yeni indirilen** kurulum `.ps1` dosyasını tekrar çalıştırın.

Elle silme sonrası panelde otomatik kayıt oluşmaz; envanter/audit için yukarıdaki **kaldırma betiğini** bir kez çalıştırmanız veya kaydı operasyonel olarak yok saymanız gerekir.

## Yeniden kurulum

1. Panelden **yeni** Windows enrollment token üretin (önceki test için token süresi dolduysa veya limit dolduysa zorunlu).
2. **Kurulum URL** veya kopyalanan kurulum komutunu Yönetici PowerShell’de çalıştırın.
3. **Genel bakış** / **Uç nokta envanteri** ve gerekirse **Loglar → Audit** ile doğrulayın.

## API özeti (referans)


| Yöntem | Yol                                | Açıklama                                                                       |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/api/agent/uninstall/<token>.ps1` | Kaldırma PowerShell betiği (public, token kayıtlı olmalı)                      |
| POST   | `/api/agent/uninstall-notify`      | Betiğin gönderdiği bildirim (JSON: `token`, `hostname`, isteğe bağlı `reason`) |


İlgili onboarding özeti: [AGENT_FLEET_ONBOARDING_TR.md](AGENT_FLEET_ONBOARDING_TR.md).