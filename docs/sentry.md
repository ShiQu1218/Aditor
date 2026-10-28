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
