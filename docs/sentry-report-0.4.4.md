# Sentry 0.4.4 報告

已在本地程式碼補上 `recording-service` 錯誤回報，涵蓋自動／手動遊戲程序偵測、錄影準備、OBS 啟動與逐局處理／入庫、剪檔、收尾與啟動補收尾。沿用診斷開關及限流，原始命令輸出與錯誤文字不會上傳。以下為修正前的調查紀錄；本地修正尚未發布。

## 傳送阻擋調查（2026-11-05 16:24，台灣時間）

**未發現整體回報通道被擋住，但確認有使用者看得到、Sentry 收不到的錯誤路徑。** 前幾次只查錯誤事件，沒有查效能與本機日誌，資訊不足以區分沒有錯誤與沒有涵蓋回報。

- 主動測試前，0.4.4 錯誤事件為 0，但最近七天已有 **56 筆 production span**；span 數不等於使用者或啟動次數。
- 使用實際安裝的 0.4.4，以獨立暫存設定驗證主程序例外、畫面未捕捉例外與模擬 Rust 診斷格式的事件；三筆均收到 **HTTP 200**，且已逐筆在 Sentry 查到。
- 本機正式設定的 `telemetryEnabled=true`；程式內 DSN 與 Sentry 專案一致。
- Sentry 最近七天的錯誤丟棄統計為空，沒有觀察到伺服器配額、限流、無效事件或過濾造成的丟棄。SDK 的 client report 已關閉，因此不能據此排除所有本機未送出的情況。

[0.4.4 效能資料](https://luis12182.sentry.io/explore/traces/?query=release%3Aaditor%400.4.4&project=4512296977760256&statsPeriod=7d)。

### 已確認缺口：遊戲程序偵測失敗只記本機日誌

本機 `recording.log` 在 0.4.4 發布後，有三次 `tasklist /FO CSV /NH` 執行失敗，台灣時間分別為 **11/04 03:05:33、15:02:27、16:01:05**。

`v0.4.4` 的 `app/src/main/recording/session.ts` 在 GameWatcher 失敗 callback 中只呼叫 `notice('error', ...)`；`notice()` 只寫日誌與顯示通知，沒有呼叫診斷處理器。這些例外已被捕捉，不會觸發 Sentry 的未捕捉例外處理器，因此不會出現在 Sentry。

`game-watcher.ts` 的指令設有 10 秒 timeout 與 4 MiB 輸出上限，但日誌只有一般失敗訊息；**無法證明這三次是逾時、程序被終止或其他系統錯誤**。具體修正點是在此捕捉點加入經過濾的結構化診斷，保留固定錯誤類型、errno、signal／timeout 狀態，避免上傳程序清單與原始命令輸出。

其他由 `RecordingSession.fail()`／`notice()` 處理的錯誤，例如收尾或 OBS 處理失敗，也不能單靠未捕捉例外整合取得；部分底層另有診斷，但不能把每個 error 通知都視為已回報。直接上傳全部通知會重複計入已由錄影子程序回報的事件，並混入正常狀態。

### 刻意不回報的情況

- `window_not_found` 不在子程序可回報代碼清單。本機另有兩次遊戲視窗消失與一次找不到可見視窗；不送 Sentry 符合目前策略，單靠日誌無法區分正常退出遊戲與恢復異常。
- 0.4.4 排除退出碼 `0x40010004`、`0xC000013A` 的子程序退出事件，其餘錯誤並未因此全部排除。
- 相同子程序錯誤五分鐘去重、所有子程序合計每五分鐘最多 20 筆；不是跨天永久封鎖。
- 診斷關閉或設定檔無法讀取時會停止回報。

### 雲端驗證證據

正式安裝程式 `D:/Aditor/Aditor.exe` 的 app.asar 版本為 0.4.4。每次驗證均使用新的 APPDATA／userData，關閉自動錄影與更新；未修改原本設定、未中斷原本程序、未開始錄影。

| 測試 | 環境 | 雲端證據 |
| --- | --- | --- |
| 主程序 captureException | production | [ADITOR-DESKTOP-20](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-20)，event `e29d2611bc7f4aceaea9b5ab40d0f2cd` |
| 模擬 native 子程序事件，經實際主程序 sanitizer／transport | production | [ADITOR-DESKTOP-21](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-21)，event `92ea70b772634c6685357987f44fb832` |
| 畫面 setTimeout 未捕捉例外，經 renderer → main IPC | production | [ADITOR-DESKTOP-22](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-22)，event `5331e20385ee4d47ad681c09a600d6a5` |
| 既有 source map 驗證流程 | development | [ADITOR-DESKTOP-8](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-8)，event `e2dd824f0d9e40f99471ada06fa98460` |
| 開發建置主程序額外傳送測試 | development | ADITOR-DESKTOP-20，event `ca767471c1c847ffae2efbf8ded472ec` |

截至本次查詢，0.4.4 共 **5 筆錯誤事件：production 3、development 2，全部由本次診斷產生**，不得列為自然發生的產品故障。未手動變更 Sentry issue 狀態。

既有 `verify:sentry` 腳本在 `flushed=true` 後因 `debugImageCount=0` 回傳失敗，其事件確實已送達。該流程同時驗證 source map，不能把缺少 Debug ID 解讀成事件傳送被擋。

在主儲存庫的 0.4.4 執行 `src/main/telemetry.test.ts`、`src/shared/telemetry.test.ts`，共 **48 個測試通過**。目前工作目錄仍為 0.4.3，因此另對照 `v0.4.4` 原始碼與實際安裝產物。

本次未修改產品程式碼；未重現 tasklist 失敗、未驗證其他使用者網路，也未讓真實錄影子程序故意失敗。native 測試驗證格式與傳送路徑，不等同驗證實際錄影器所有錯誤分支。

## 以下為主動測試前的歷史快照

最新查詢時間：2026-11-05 16:14（台灣時間）；前次查詢為 2026-11-04 19:31。專案：`luis12182/aditor-desktop`。

## 結論

**目前未查到 0.4.4 的錯誤事件，尚無足夠資料判斷穩定性或確認舊問題已修復。**

| 項目 | 結果 |
| --- | --- |
| Release | `aditor@0.4.4` |
| Release 建立時間 | 2026-11-03 22:31:06（台灣時間） |
| 最近 90 天錯誤事件數 | 0 |
| 最近 90 天符合版本條件的 issue | 0；未限制解決狀態或環境 |
| `release:*0.4.4*` 錯誤事件查詢 | 無結果，未找到帶有版本後綴的事件 |
| Release 中繼資料 | `newIssues=0`；`dateReleased`、`firstEvent`、`lastEvent`、`lastCommit`、`lastDeploy` 皆為空 |

[開啟 0.4.4 issue 清單](https://luis12182.sentry.io/issues/?project=4512296977760256&query=release%3Aaditor%400.4.4&statsPeriod=90d)。
[開啟錯誤事件數查詢](https://luis12182.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=release%3Aaditor%400.4.4&project=4512296977760256&field=count%28%29&statsPeriod=90d&mode=aggregate&yAxis=count%28%29)。

## 與其他版本區隔

本次查詢往前 24 小時、未限制環境的錯誤事件，其他版本仍有回報：

| 版本 | 事件數 |
| --- | ---: |
| 0.4.3 | 5 |
| 0.4.0 | 6 |
| 0.3.6 | 1 |
| 0.3.4 | 1 |
| 0.3.3 | 2 |
| 0.3.2 | 17 |
| 合計 | 32 |

這些事件屬於其他版本，不能列為 0.4.4 的故障，也不能用來推論 0.4.4 的修復成效。
[開啟各版本事件統計](https://luis12182.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&project=4512296977760256&field=release&field=environment&field=count%28%29&sort=-count%28%29&statsPeriod=24h&mode=aggregate&yAxis=count%28%29)。

## 後續確認

1. 確認實際發布與執行的產物為 0.4.4。此工作目錄的 `app/package.json` 仍為 0.4.3，不能視為 0.4.4 的程式碼基準。
2. 確認 0.4.4 的診斷傳送及 release 標記正常；如需驗證，可依 [Sentry 診斷設定](sentry.md) 使用同一次建置的驗證流程。本次未觸發測試事件。
3. 取得 0.4.4 實際事件與使用量後，再判斷錄影停滯、音訊時間戳落差、啟動或停止逾時等舊問題是否仍存在。

## 判讀限制

- Release 存在只證明有建立紀錄，不代表已部署或有人使用。
- 本次統計為錯誤事件，未查詢效能追蹤、session 或 crash-free 指標；沒有使用量分母，不能換算失敗率。
- 專案診斷可由使用者關閉，子程序另有去重與流量限制；零回報不等於零故障。
- 本次只整理報告，未修改程式碼或 Sentry issue 狀態。
