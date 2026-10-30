# Sentry 錯誤整理與定位（2026-10-30）

專案：`luis12182/aditor-desktop`。查詢最近 30 天有活動的全部 issue，依頻率排序，共 40 個：28 個未解決、12 個已解決。程式碼基準：`e6dce00`。

[Sentry 清單](https://luis12182.sentry.io/issues/?project=4512296977760256)。以下次數為 Sentry 回傳的 issue 累計事件數，不是失敗率；回報有去重及流量限制。

## 判讀限制

- **Users = 1 不能解讀成只有一位使用者受影響。** `app/src/shared/telemetry.ts:116` 將所有事件的 IP 設為 `0.0.0.0`，沒有可用的唯一使用者識別。
- 同一版本號可能有不同建置；目前 package 仍為 0.4.0。不能只看到 `release=aditor@0.4.0` 就認定包含目前 HEAD 的修正。
- Rust 錯誤沒有原生堆疊；操作軌跡、日誌及原始 stderr 不會上傳。只能區分已確認的程式缺口、錯誤觸發點與待驗證假說。
- 已讀取全部未解決 issue 的代表事件；高頻 9／A／C／15 另查 release 分布。其餘已解決項目只整理清單與既有驗證紀錄。

## 優先處理

### P1：分析引擎 stdin 缺少 error listener，可能產生主程序未捕捉例外（本地已修正，尚未發布）

[ADITOR-DESKTOP-18](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-18)，1 次；事件標示 `fatal`、`handled=no`，堆疊指向 `sendReq`，版本為 `0.3.7-local.20261026`。

- **調查時確認的缺口**：`EngineClient.request()` 只在 `stdin.write` callback 中 reject；`_spawn()` 沒有註冊 stdin 的 `error` listener。`cancel()` 的寫入也沒有 callback。後續修復見文末。
- Node Writable 寫入失敗時，callback 與 `error` 事件都可能發生；處理 callback 不會消耗 `error` 事件。`destroyed` 檢查也無法排除檢查後管線才關閉的競態。
- 已以合成 Writable 與 assert 驗證：收到 `callback:EPIPE` 後，仍收到 `uncaught:EPIPE`。這確認缺口的機制，尚非完整 Electron 情境重現。
- 對照：`recording/live-engine.ts:174` 與 `recording/aditorrec-client.ts:122` 已有 stdin error listener。
- 最小修正方向：在 EngineClient 建立程序時統一處理 stdin error，讓待處理請求有受控的失敗結果；補測 request／cancel 遇到關閉管線的情境。不要只加空 catch 或依賴 write callback。
- 涉及呼叫端：`index.ts` 的 probe／derive／autoclip／cancel、`queue.ts`、`ipc-handlers.ts`。對應測試：`engine.test.ts` 及 fake engine fixture。

同一 trace 的事件順序（UTC）：M 於 10/29 19:38:25.739 即時引擎退出、T 於 25.899 錄影程序退出、18 於 26.457 EPIPE、X 於 26.554 分析引擎退出。**EPIPE 是程序退出後寫入失敗的候選連鎖症狀；缺少 listener 是另一個可獨立確認的錯誤處理缺口。** 同 trace 與時間接近不證明誰觸發退出。

### P1：錄影編碼／封裝停滯，目前無法歸咎磁碟或 GPU

| Issue | 累計 | 已定位位置與結論 |
|---|---:|---|
| [A](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-A) | 32 | `recorder/src/session.rs:839` 的 `stats()`：五秒區間內輸入增加、已編碼數不變，觸發 watchdog。這是停滯偵測，尚非驅動根因。 |
| [15](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-15) | 6 | 封裝佇列滿載。全部在 0.4.0；舊訊息「disk cannot keep up」無法證明磁碟過慢。 |
| [J](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-J) | 49 | 舊版編碼執行緒退出的泛用訊息，可能遮蔽真正的先前錯誤，不能視為 49 次獨立根因。代表事件為 0.3.6。 |
| [B](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-B) | 5 | stop 等待逾時；可能與編碼／封裝清理卡住相關，未證實。代表事件為 0.3.3。 |

A 有 30 次在 0.3.2／0.3.3、2 次在 0.4.0。最新事件為台灣時間 10/30 08:22:38，DDA／HEVC／1080p60。A 與 15 的代表事件具有相同 trace，支持同一執行期間曾發生這兩類問題，不足以證明單一因果鏈。

目前已有 `7c22d25`（PR #45）：`encode/mux.rs` 保留 256 筆上限，滿載最多等待兩秒；`encode/mod.rs` 保留實際錯誤與 worker 階段；`session.rs` 在可能阻塞的清理前回報。**屬於已加入緩衝與診斷，尚未取得雲端事件證明根因已排除。** 查到的代表事件仍沒有新的階段快照。

下一個有效證據是包含該 commit 的確切建置所產生的 `stage`、`input`、`encoded`、`queue`、`mux_busy`、`mux_max_ms`。若停在原生呼叫，再於受影響電腦取得本機傾印／追蹤；不要直接移除 watchdog 或無限制擴大佇列。

### P1：音訊時間軸出現超過五秒的缺口

[9](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-9)，71 次。`recorder/src/encode/aac.rs:55` 的 `Audio::advance()` 在目標 sample 與已寫入 sample 相差超過 240,000 時停止，避免大量補靜音造成記憶體累積。

70 次來自 0.3.1～0.3.3；另有 **1 次 0.4.0**，台灣時間 10/29 16:40:11，WGC／AV1 NVENC／1080p60，所以不能僅視為舊版問題。觸發來源可為 audio push、影片進度補音訊或結束補齊；目前事件沒有 sample 計數，不能確定是哪條路徑。

`7c22d25` 已加上 `target_samples`、`written_samples`、`encoded_samples`、`gap_samples` 與輸入時間快照。須用此建置的新事件區分時間基準偏移、音訊丟棄及處理落後；保留五秒保護。

## 其他未解決項目的分類

| Issue（累計次數） | 定位／處置判斷 |
|---|---|
| [C](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-C)（12） | `encode/hardware.rs:243` 拒絕來源尺寸、BGRA 格式或 sample count 不符。12 次均為 0.3.2～0.3.6。`acf3b4a` 已在 WGC `capture/mod.rs:632` 跳過 resize 過渡期尺寸不符影格，並使用轉換後 texture 尺寸。事件符合該問題，但無法單憑訊息排除格式分支；待新版驗證。 |
| [R](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-R)（2） | 系統匣圖示載入失敗造成未處理 rejection。`acf3b4a` 已在 `app/src/main/tray.ts:52` 捕捉建立失敗並允許啟動繼續；有缺圖示測試。尚未驗證受影響發布產物。 |
| [H](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-H)（8）、[G](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-G)（8） | 代表事件同 trace，spawn 錯誤後約 1ms 出現 EPIPE，應作同一啟動故障鏈調查。路徑已遮蔽且缺 errno，不能斷言是檔案遺失、權限或安全政策。 |
| [S](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-S)（7）、[Z](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-Z)（6） | 代表事件為 development／0.3.4，皆在 10/26 05:20:59 UTC；先與正式版故障分開。Z 為 -4058，搭配 spawn 錯誤偏向啟動環境問題，不能當作 Python 業務邏輯崩潰。 |
| [D](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-D)（14）、[12](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-12)（2） | `session.rs:655` 首幀等待與 `aditorrec-client.ts:159` Started 等待逾時。代表事件均為 0.3.6、DDA／HEVC／1080p60；不同啟動階段，不能直接合併為同一根因。 |
| [V](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-V)（3） | hello 逾時，代表事件為 0.4.0。尚無 `probe_stage`，需目前診斷建置區分載入、GPU 探測、編碼器或音訊列舉。 |
| [Y](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-Y)（7） | hook 擷取視窗消失；代表事件 0.3.6、1440p120。定位為視窗生命週期／重新擷取路徑；缺少操作紀錄，無法區分正常遊戲退出與恢復失敗。 |
| [7](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-7)（3）、[W](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-W)（1） | `recorder/src/audio/mod.rs:440` 裝置啟用失敗及 `:266` 啟動等待逾時。屬音訊初始化問題；不是 issue 9 的 sample 缺口證據。 |
| [M](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-M)（13）、[T](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-T)（9）、[X](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-X)（6）、[K](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-K)（1）、[F](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-F)（9） | 子程序退出。M／T／X 的代表事件與 18 同 trace；T／X／K 的 1073807364 不能當成 Windows Application Control 的 0xC0E90002。缺少退出來源，不能宣稱已找到原生 crash 根因。 |
| [E](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-E)（2）、[16](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-16)（1）、[17](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-17)（1） | 前兩者為 Python 舊版；17 為 Rust／0.4.0。現行 `engine/src/decode.rs:299` 在解碼方案耗盡時回報通用錯誤；現有事件不足以分辨來源檔損壞、codec、硬體解碼或 filter 問題。16 的 Sentry suspect commit 只是候選，不是因果證據。 |
| [14](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-14)（1） | Python live 開啟錄影 shared memory 失敗，0.3.6。需與錄影建立／關閉時序對照；目前已為 Rust live，舊 Python stack 不對應現行實作，不能硬套行號。 |
| [5](https://luis12182.sentry.io/issues/ADITOR-DESKTOP-5)（2） | `docs/sentry.md` 明確記載的錄影受控退出驗證，development／0.3.0；仍為 unresolved，應列驗證資料，無須列入產品 crash 優先序。 |

## 已解決與測試資料

- 1／2／3／8：Sentry／source map 驗證。
- 4／6：文件記載的子程序受控錯誤驗證。
- 10／11：訊息為 test／test2。
- N／P／Q：舊 Python 的缺失範本／檔案；已解決，未重新調查。Q 最近仍有事件活動，因此不能以 resolved 狀態證明所有建置都已排除。
- 13：舊 EPIPE，已解決；不能拿它的狀態涵蓋仍未解決的 18，兩者堆疊不同。

## 建議執行順序與驗證結果

1. EngineClient stdin error 處理與 request／cancel 回歸測試已完成本地修正，發布後再驗證 Sentry 是否停止出現 18。
2. 確認發布產物確實包含 `acf3b4a` 與 `7c22d25`，以新建置收集 9／A／15／V 的階段與數值；不要直接把舊 issue 標為已修復。
3. 依新事件判斷編碼、封裝或音訊路徑，再針對受影響電腦重現。其餘舊 Python／開發環境／驗證資料另列追蹤。

初次調查只新增報告；當時缺少 Vitest，僅合成 EPIPE assert 通過。

### 後續修復

- `app/src/main/engine.ts`：建立子程序時監聽 stdin error；管線失敗便終止該引擎，沿用 close 的待處理請求失敗與自動重啟機制。忽略舊程序的晚到錯誤，避免影響新程序或關閉流程。寫入 callback 的錯誤統一轉為 `EngineError('engine_crashed', ...)`，訊息沿用本機路徑遮蔽。
- 新增 `engine-pipe.test.ts`：先確認修正前 stdin error 會拋出，再驗證啟動失敗與啟動中排隊請求、request／cancel 管線失敗、所有待處理請求結束、自動重啟、舊程序晚到錯誤及關閉時不重啟。
- 已按 lockfile 安裝測試依賴，停用安裝腳本；未變更套件版本。既有 `engine.test.ts`、`tray.test.ts`、`queue.test.ts` 與新增管線測試通過，型別檢查通過。ESLint 設定只涵蓋 renderer，不把本次 main 檔案被忽略視為通過檢查。
- WGC resize 與系統匣缺圖示保留既有修正；系統匣測試已執行通過。工作區缺少 `build/ffmpeg/lib/avcodec.lib`，未執行 Rust 錄影測試。
- 未發布、未更動 Sentry issue 狀態，也未進行真實錄影或 Electron 重現；9／A／15／V 的原生根因仍待包含診斷修改的新建置與受影響機器證據。
