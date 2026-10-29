# Sentry 診斷設定

組織：`luis12182`；專案：`aditor-desktop`。

目前接入 Electron／React 的 JavaScript 錯誤與啟動／畫面效能追蹤，
以及 Rust 離線分析、即時偵測與錄影子程序的錯誤。
所有網路回報集中於 Electron；子程序不另裝 Sentry SDK，也不保存權杖。

Rust 引擎例外保留 type 與空 frames 陣列；不提供來源堆疊。元件識別為 `rust-engine`（離線分析）、`rust-live`（即時偵測）與 `rust-recorder`（錄影），platform 皆為 `native`；改名前的 `python-engine`／`python-live` 舊 issue 不會與新事件合併。
錄影端會回報擷取／編碼／音訊失敗、通訊異常與非預期退出；目前不擷取 Rust 原生崩潰的記憶體傾印或完整原生堆疊。

## 使用者選擇與資料範圍

「設定 → 關於 → 分享錯誤與效能診斷」預設啟用，首次啟動頁會揭露回報內容。
既有檔案若已儲存 `telemetryEnabled: false`，升級後仍維持關閉；缺少此欄位則採啟用的預設值。
關閉立即阻擋所有程序的後續傳送，已送出的請求無法撤回。重新啟用後須重新啟動。

回報保留錯誤類型、過濾後的訊息、程式內的相對檔名／行號／函式，以及版本與環境。
過濾本機絕對路徑、電子郵件、網址及常見憑證格式；移除使用者資料、請求內容、
任意附加資料、來源程式內容、操作紀錄與效能屬性。網路 IP 以固定占位值取代，避免位置推算。
任意文字的過濾無法保證涵蓋所有敏感資料格式，新增回報內容時須維持欄位白名單。
不啟用影片、截圖、Session Replay、原生記憶體傾印、日誌或自訂指標回報。
傳送佇列只放在記憶體，不將事件存至磁碟等待日後上傳。

正式版標記為 `production`、開發版為 `development`，release 為 `aditor@<package.json 版本>`。
錯誤完整回報；主程序正式版追蹤抽樣 10%、開發版 100%，畫面追蹤抽樣 10%。
子程序以錯誤指紋（來源、代碼、例外類型、最內層程式位置與正規化訊息）去重，相同故障五分鐘最多回報一次；所有來源另共用每五分鐘 20 筆總量上限。取消、忙碌、磁碟已滿、找不到遊戲視窗或不支援硬體等預期狀況不回報。

DSN 是公開的事件接收識別碼，已寫入 `app/src/shared/telemetry.ts`：

```
https://5c57897479340b1a622630935c43a4fb@o4512296943747072.ingest.us.sentry.io/4512296977760256
```

## 正式版 source map

建置會產生隱藏的 source map，安裝包排除所有 `.map` 檔。
上傳會包含此版本的 JavaScript 與其 TypeScript／React 原始碼，目的地僅限上述 Sentry 專案。
預設不會上傳；一般建置不需要 Sentry 權杖。

準備發布時，在建置環境安全設定 `SENTRY_AUTH_TOKEN`，或存入本機的
`app/.env.sentry-build-plugin`（已由 Git 排除）。環境變數只在設定它的 PowerShell 視窗及其子程序生效；
若要交給其他建置程序，可在同一個已設定權杖的視窗執行：

```powershell
if (-not $env:SENTRY_AUTH_TOKEN) { throw '此視窗沒有 Sentry 權杖' }
Set-Content -LiteralPath app/.env.sentry-build-plugin -Value ('SENTRY_AUTH_TOKEN=' + $env:SENTRY_AUTH_TOKEN) -Encoding utf8
```

此檔案含有密鑰，勿分享；環境變數優先於檔案。設定完成後明確啟用上傳：

```powershell
$env:SENTRY_UPLOAD_SOURCEMAPS = '1'
npm --prefix app run build
```

權杖需要 Sentry source map 上傳權限，僅提供給建置環境，切勿寫入版本庫或貼到對話中。
若選擇上傳但未提供權杖，建置會失敗。上傳範圍限於 `app/out/main`、`preload`、`renderer`
各自的 `.js` 與 `.map`；Vite 外掛注入 Debug ID 供事件配對，不建立或發布 Sentry release。
必須先上傳再發布該次建置；後補 source map 不會修復既有事件。

仍使用既有 `scripts/build.ps1` 打包流程；上述環境變數會傳入其中的 Electron 建置步驟。
確認新版本的測試事件可還原原始碼後，再依現有 GitHub Releases 流程發布。

## 無須手動操作的驗證

上傳完成後，使用同一次建置執行：

Sentry 可能在上傳成功後繼續於背景建立索引，需等候數分鐘。若剛上傳就觸發的事件仍顯示
JavaScript 檔名，等待索引完成後再送一筆新事件；既有事件不會自動重新套用 source map。

```powershell
npm --prefix app run verify:sentry
```

會啟動真實 Electron 應用程式，使用獨立的暫存設定、假的分析引擎，關閉錄影及更新，
明確開啟該次測試的診斷同意，並經由應用程式本身的 SDK 回報一筆測試錯誤與效能追蹤。
最後關閉診斷並確認立即生效，不更動使用者原本的設定或影片。
輸出的 event ID 可供 Sentry 查詢；仍須確認雲端事件顯示原始 TypeScript 檔名及行號，
不能只憑本機傳送成功判定 source map 已正確配對。

測試觸發器只在未打包的 E2E 模式且 `ADITOR_SENTRY_VERIFY=1` 時執行，
一般啟動與正式安裝版不會觸發，也不會替使用者啟用診斷。

若要連同真實分析引擎與錄影子程序驗證，可在未打包的測試環境額外設定：

```powershell
$env:ADITOR_SENTRY_VERIFY_CHILDREN = '1'
$env:ADITOR_VERIFY_ENGINE = '完整路徑/engine/target/release/aditor.exe'
$env:ADITOR_VERIFY_RECORDER = '完整路徑/build/ffmpeg/bin/aditorrec.exe'
npm --prefix app run verify:sentry
```

會觸發分析引擎的受控 IPC 範本載入例外、即時引擎的範本載入失敗，再終止本次測試啟動的錄影子程序以驗證異常退出回報。
此驗證不開始錄影，也不操作遊戲或終止使用者的其他程序。

以下是移植前的歷史驗證紀錄；Rust 不會產生 Python 來源堆疊。

2026-10-22 已驗證：`ADITOR-DESKTOP-3` 的新事件成功還原至
`src/main/telemetry-verification.ts` 第 16 行，包含原始碼內容。
同日也已從真實子程序確認：`ADITOR-DESKTOP-4` 為 Python IPC 例外、
`ADITOR-DESKTOP-5` 為錄影程序異常退出、`ADITOR-DESKTOP-6` 為即時分析範本載入失敗。
兩個 Python 事件保留實際 `.py` 檔名、函式與行號；錄影退出事件只有錯誤代碼與訊息，沒有原生堆疊。

參考：[Sentry Electron](https://docs.sentry.io/platforms/javascript/guides/electron/)、
[Vite source map 上傳](https://docs.sentry.io/platforms/javascript/guides/electron/sourcemaps/uploading/vite/)。

## 錄影錯誤定位（0.4.0 後的診斷）

舊事件沒有原生堆疊、操作軌跡及 stderr，無法回溯是哪個驅動呼叫卡住。
新診斷仍不傳送原始 stderr、裝置 ID 或本機路徑，只保留固定階段標記與數值；須使用包含本次修改的新建置重現，舊事件不會補上資料。
Electron 啟動錄影程序時會設定 `ADITORREC_DIAGNOSTICS=1`，才啟用 stderr 探測標記；直接執行原生程序／CLI 時預設不輸出進度，維持既有 JSON 輸出契約。

- `recorder_timeout`：查看 `probe_stage`、`probe_encoder`。`gpu_enumerate`／`gpu_create` 是顯卡初始化，`probe_open` 是建立硬體編碼器，`probe_copy` 是試拷貝，`probe_send`／`probe_flush` 是 FFmpeg 編碼呼叫，`probe_close` 是釋放資源，`audio_devices` 是音訊列舉。這是最後一個探測階段，不代表呼叫已完成；沒有標記表示尚未進入探測，需查程序載入。hello 整體仍有 30 秒逾時，不嘗試強制中斷驅動執行緒。
- 無影格錯誤：訊息含 `stage`、`input`、`encoded`、`dropped`、`queue`、`audio_dropped`、`mux_busy`、`mux_max_ms`。`video_send` 指向 FFmpeg／GPU 編碼路徑，`mux_enqueue` 指向封裝背壓，`audio_encode` 指向音訊處理；`mux_busy=1` 表示封裝尚未返回，`mux_max_ms` 是已完成封裝呼叫的最長時間，不是當下卡住時間。
- 音訊間隔錯誤：保留五秒記憶體保護，新增 `target_samples`、`written_samples`、`encoded_samples`、`gap_samples`（48 kHz）。從音訊輸入觸發時另含 `pts`（每秒一千萬刻度）、`video_next_slot`、`fps` 與佇列計數，可分辨音訊時間超前影片、開頭尚未寫入，或累積丟棄後的缺口。單筆快照仍無法證明驅動或排程的因果關係。
- 封裝佇列：保留 256 筆上限，滿載時只讓編碼執行緒最多等待兩秒，擷取端仍以原本上限丟影格；持續滿載才停止，且不再直接歸咎於磁碟。已保留的分段依既有復原流程處理。

編碼錯誤會在可能阻塞的資源釋放前鎖存；管理執行緒先送出一次 `Error`，清理完成後才送 `Stopped`。兩秒只限制佇列等待，不保證驅動／磁碟清理能在兩秒內完成；停止仍無回應時，由應用程式既有的 15 秒逾時終止子程序。

若新事件仍只停在 `video_send`／`probe_send` 等原生呼叫，需要在受影響電腦重現當下取得 aditorrec 的程序傾印或 Windows Performance Recorder 追蹤，才能分辨 FFmpeg、顯卡驅動及鎖定等待。程序傾印可能包含記憶體中的私人資料，應留在本機分析，不自動上傳 Sentry。

### `0xC0E90002`：找出 Windows 封鎖的檔案

此碼表示 Application Control 政策封鎖檔案；程序可能在 Rust main 執行前就被擋，因此應用程式無法報出 DLL 名稱。新事件保留十六進位 `exit_code` 並顯示政策封鎖提示，但不能僅憑此碼判定是 Smart App Control 或哪一個檔案。

在**受影響電腦**重現後查最近十分鐘的 CodeIntegrity 記錄：

```powershell
Get-WinEvent -FilterHashtable @{
  LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
  StartTime = (Get-Date).AddMinutes(-10)
} | Where-Object { $_.Id -in 3033, 3077, 3089 } |
  Select-Object TimeCreated, Id, Message | Format-List
```

記錄會指出被封鎖的檔案及政策。對該檔案執行 `Get-AuthenticodeSignature -LiteralPath '記錄中的完整檔案路徑'`，檢查簽章狀態與簽署者，再確認它是否與發布產物相符。這些記錄可能含本機路徑，分享前須遮蔽個人資訊。

發布流程目前設定 `CSC_IDENTITY_AUTO_DISCOVERY=false`；這不足以證明某個發布檔案未簽章，但應檢查實際發布的 `aditorrec.exe` 與相依 DLL。修復應針對被擋檔案的可信簽章／發布完整性或由管理員調整明確允許政策，不要求使用者關閉 Windows 安全功能。取得真正被擋檔案與政策前，不能宣稱已修復此問題。
