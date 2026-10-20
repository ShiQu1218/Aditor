# Aditor — 遊戲錄影與即時偵測設計

日期：2026-10-18
狀態：設計定稿（使用者已逐段確認 §1–§4）；實作分 5 期，第 1 期計畫見 `docs/superpowers/plans/2026-10-18-plan4-recorder-core.md`
範圍：新增子系統。既有的離線分析、快取格式、剪輯與匯出不變。

---

## 0. 需求（使用者原話整理）

| # | 需求 | 來源 |
|---|---|---|
| R1 | 偵測 Apex 是否啟動，啟動後自動進入錄影 | 使用者 |
| R2 | 錄影中即時偵測擊殺，且**不得影響遊戲效能** | 使用者 |
| R3 | 判斷對局開始／結束；使用者可選「一局一個檔」或「從頭錄到尾一個檔」 | 使用者 |
| R4 | 錄影進行中，玩家切出遊戲可在 App 內觀看當局錄影與擊殺紀錄 | 使用者（澄清：不是遊戲內疊加） |
| R5 | 內建錄影與 OBS 兩種後端都支援，預設內建 | 使用者選 C |
| R6 | 一局 = 開局倒數／載入 → 離開這局（含死亡後觀戰與結算）；從頭錄到尾 = Apex 開啟到 Apex 關閉（含大廳） | 使用者選 A |
| R6a | 遊戲結束後**可以不回大廳直接排下一場**（觀戰或結算畫面中排隊），而且有多種模式；**所有模式開局前都有倒數計時** | 使用者補充（2026-10-18），錄影在 `E:\Apex_highlighter_clip` |
| R7 | 內建錄影收「系統聲音＋麥克風」，混成一軌 | 使用者選 B |
| R8 | 開機自動啟動並常駐系統匣（預設），也可只在 App 開啟時偵測 | 使用者選 C |
| R9 | 錄後完整分析可設定：不分析／關遊戲後（預設）／每局結束後低優先序 | 使用者選 D |
| R10 | 效能第一：錄影核心用 Rust 原生程式 | 使用者選方案 3＋Rust |

硬性限制：**不注入遊戲程序、不讀遊戲記憶體**（README 承諾；Apex 使用 EA Javelin Anticheat）。

---

## 1. 程序架構

```
┌─ Electron 主程序（既有 App）──────────────────────────────────┐
│ 遊戲偵測 · 錄影工作狀態機 · 系統匣 · 開機啟動                    │
│ OBS 控制（WebSocket v5）· 事件推送到 renderer · 收尾（串接／排分析）│
└──────┬──────────────────────────────┬────────────────────────┘
       │ JSON-lines（stdin/stdout）    │ JSON-lines（stdin/stdout）
┌──────▼───────────────────────┐  ┌───▼──────────────────────────────┐
│ aditorrec.exe（新，Rust）       │  │ Python 引擎（既有），新增 live 指令  │
│ WGC 擷取 Apex 視窗（D3D11）   │  │ 讀共享記憶體小圖 → 既有圖示偵測     │
│  ├→ D3D11 影格零複製 → 硬體編碼│  │ → 擊殺／對局開始／對局結束事件      │
│  │   → 每 2 秒一段 fMP4        │  └──────────────────────────────────┘
│  └→ GPU 裁切縮放 → 4 fps 讀回  │──── 共享記憶體環形緩衝（序號）────┘
│ WASAPI loopback＋麥克風 → 混音 │
│ → AAC → 與影像同一個 muxer      │
└──────────────────────────────┘
```

決定：

1. **Rust**：`windows` crate 呼叫 WGC（`Windows.Graphics.Capture`）、D3D11、WASAPI。編碼與封裝透過 FFI 連結專案已內建的 LGPL ffmpeg DLL（`build/ffmpeg`，avcodec-63 等）。綁定以 bindgen 預先產生並提交進 repo，建置時不需要 libclang。
2. **影像全程留在 GPU**：WGC 影格（BGRA `ID3D11Texture2D`）複製進 ffmpeg 的 D3D11 hwframe pool，直接交給 `hevc_nvenc`／`h264_nvenc`／`av1_nvenc`／`*_amf`／`*_qsv`。CPU 只碰小圖。
3. **偵測沿用 Python**：`aditorrec` 只輸出小圖（見 §3），Python live 模式用既有偵測器。日後若量測顯示 Python 是瓶頸，再移植到 Rust 並以比對測試確保結果一致。
4. **OBS 模式**：`aditorrec` 仍執行，但只做擷取＋小圖讀回（start 指令 `encode: null, audio: null`），錄影由 OBS 負責。偵測路徑兩種模式相同。
5. **Electron 不碰影像資料**。
6. **不注入**：WGC 是 Windows 官方擷取 API（OBS「視窗擷取」同一套）。

---

## 2. 錄影段落、邊錄邊看、輸出檔案

### 2.1 磁碟格式

```
<錄影資料夾>/.sessions/<sessionId>/
  init.mp4          fMP4 初始化段（ftyp+moov）
  seg_000001.m4s …  每段 2 秒；每段第一格是關鍵影格（GOP = 2 秒，強制對齊）
  index.jsonl       每段一行：{"seq":1,"pts":0.0,"dur":2.0,"bytes":…,"wall":"ISO8601"}
  events.jsonl      即時事件：擊殺／match_start／match_end／gap（錄影中斷）
  session.json      設定快照（編碼器、解析度、模式、開始時間、aditorrec 版本）
```

- `sessionId` = `YYYYMMDD-HHMMSS-<4 位隨機>`。
- 段落寫完（含 fsync）才把該行附加到 `index.jsonl`；`index.jsonl` 是唯一真相，播放器與收尾只依它。
- 時間以第一格的 QPC 為 0，單位秒；影音都用同一個 QPC 時鐘（WGC `SystemRelativeTime` 與 WASAPI `QPCPosition` 同源）。

### 2.2 邊錄邊看

- 側欄新增「錄影中」入口，打開 Studio，來源為 session。
- 播放器以 MSE：先 append `init.mp4`，再依 `index.jsonl` 逐段 append；時間軸長度跟著增加；事件即時出現；「跳到最新」按鈕。
- 錄影中即可標記片段、加進專案；專案項目以 `session:<id>` 參照，收尾後自動改指向輸出檔（時間位移依 §2.3 計算）。

### 2.3 收尾

- **一局一個檔**：每局前後各保留 5 秒，以完整段落做 ffmpeg stream copy（faststart）；後留段落落盤後即可輸出，大廳段落於收尾時刪除。
- **從頭錄到尾**：Apex 關閉時全部串成 `Apex_<YYYY-MM-DD_HH-mm>.mp4`，事件含每局起訖。
- 輸出檔加入媒體庫；`events.jsonl` 轉成既有快取格式作為分析結果（標記 `source: "live"`）；依 R9 設定排完整分析。
- 成功串接並寫入快取後才刪除 session 目錄。

#### 2.3.1 逐局輸出與恢復

- 兩種模式都在 Apex 執行期間維持同一個 aditorrec 工作，不重啟擷取，即時觀看持續可用。`recording.json` 快照保存 `startedAt`、`postAnalysis`、`mode`；舊快照缺少或無效的模式視為 `session`。
- 逐局選取 `pts + dur > start - 5` 且 `pts < end + 5` 的索引段落。錄影中等到索引出現 `pts >= end + 5` 才剪；停止時依序停止錄影器、停止 live 引擎取得最終快照，再補剪。未結束的最後一局以最後段落結束時間收尾；沒有 live.json 或沒有對局時保留整段。
- ffmpeg 剪檔序列執行，失敗不影響錄影，收尾時重試。檔名使用 `startedAt + 首段 pts` 的本機時間：`Apex_<YYYY-MM-DD_HH-mm>.mp4`，撞名加 `_2`、`_3`。
- `match-part.json` 記錄本工作的暫存檔路徑。串接到 `.part.mp4` 後，先原子寫入 `matches.json` 的 `cuts`（零起算的對局索引、起訖、首尾序號、輸出路徑、分析／快取／可信狀態），再改名、加入媒體庫、寫快取與通知。恢復時刪除未登記的暫存檔，已登記者直接完成改名，不重複串接；收尾僅回傳這次新剪出的路徑，所有既有剪檔仍補加媒體庫。
- 每個輸出的 live 快取依首段 pts 位移，事件、觀戰與對局均限制於該輸出範圍；錄影中一律不標成可信。最終品質完整時，只重寫 `analysis.source === 'live'` 的自有快取為可信，保留完整分析快取。
- `perMatch` 在逐局剪出後立即排分析且只排一次；`afterExit` 在收尾時只排尚未可信且未排過的剪檔；`none` 不排分析。整段模式的兩種分析時機都在收尾後處理。剪檔與副作用成功後才刪除工作目錄，未使用的大廳段落隨之丟棄。

### 2.4 編碼設定

- 編碼器：自動（HEVC 優先 → H.264；AV1 可選）。探測順序 NVENC → AMF → QSV；**沒有硬體編碼器就不錄**（不退回 CPU 編碼）。
- 解析度：原生／720p／1080p／1440p，縮放在 GPU VideoProcessor。FPS：10／20／30／60（預設）／90／120；舊設定 144 遷移成 120。位元率維持 kbps 儲存（2000–150000，預設 40000），選單提供 5000／8000／10000／15000／20000／30000／40000／50000／60000／80000／100000／150000，清單外已存值另列「目前：N」。
- 編碼預設：速度優先（預設）／平衡／品質優先；NVENC 對應 p1／p4／p7，AMF `quality` 對應 speed／balanced／quality，QSV 對應 veryfast／medium／veryslow。品質越高，GPU 使用量越高。
- 可選強制 16:9：適配（等比縮放並補黑邊）／拉伸；高度沿用指定高度或原生高度，寬度為高度 ×16/9 四捨五入至偶數。僅改編碼影像，小圖分析維持原始來源。
- 音訊：48 kHz 立體聲 AAC 192 kbps。

### 2.5 安全措施

- 崩潰最多遺失最後一段（2 秒）。App 啟動時掃描 `.sessions/`，未收尾者依 `session.json` 模式補做收尾。
- 磁碟：開始前與每 30 秒檢查。< 提醒門檻（預設 10 GB）通知；< 停止門檻（預設 2 GB）停止錄影並收尾已錄部分。

### 2.6 OBS 模式（第 5 期）

- OBS ≥ 28 的內建 WebSocket v5 伺服器（工具 → WebSocket 伺服器設定）；App 使用固定版 `obs-websocket-js@5.0.6`，連線與指令各約 3 秒逾時。所有控制只走網路，不接觸遊戲程序。
- 偵測 Apex（自動或手動）時，先查 `GetRecordStatus`：尚未錄影時，整段模式才立即送 `StartRecord`，逐局模式待命到開局；已在錄影則沿用（adopted），絕不對該錄影送開始或停止指令。Apex 結束／手動停止時停止擷取；自行開始的錄影送 `StopRecord`，沿用的錄影則繼續等候 OBS 停止事件（App 結束時解除監聽）。
- `aditorrec` 照常以相同 `capture` 與小圖範本啟動，但指定 `encode: null, audio: null`，live 擊殺與對局偵測路徑不變。OBS 無法連線時通知；預設本次回退內建錄影，關閉回退時只保留即時偵測。中途斷線不停止擷取，依 1、2、4…最多 30 秒退避重連，不重新送 `StartRecord`。重連後若已停止而錯過停止事件，v5 沒有歷史路徑查詢，通知使用者手動匯入並在結束偵測時無檔收尾。
- `.sessions/<id>/recording.json` 記錄本次實際 `backend`、模式與分析設定；`obs.json` 以 `writeJson` 原子寫入 `{ outputPath?, recordStartedAt, captureStartedAt, adopted }`（epoch ms），路徑由 `StopRecord` 回覆或 `RecordStateChanged/OBS_WEBSOCKET_OUTPUT_STOPPED` 補入。OBS 起點取 `OUTPUT_STARTED` 的接收時間，沿用時取目前時間減 `outputDuration`（ms）；擷取起點優先讀 `session.json.started_at`，缺少時取 `started` 事件時間。快取事件時間＝live 秒數＋`(captureStartedAt-recordStartedAt)/1000`；復原用同一份資料，不以「零段落」判定沒有錄影。
- 從頭錄到尾：原路徑加入媒體庫，不搬移、改名或刪除 OBS 原檔；用引擎 probe／ffprobe 取得時長，寫入平移且裁到影片範圍的 live 快取。可信結果略過完整分析，其餘依本次 `postAnalysis` 設定排入分析。
- 一局一個檔：自行控制的 OBS 在大廳只擷取偵測；match_pending（倒數／載入）立即開始錄影，match_start 確認後沿用同一檔；錯過序列時由 match_start 開始錄影（無法補錄前置時間），match_end 等到 max(現在, 結束時間＋5 秒) 停止；下一局開始會立即停止上一檔並重開。原檔直接入庫，不剪輯、不搬移。match_cancel 立即停止，標記 cancelled: true，保留 OBS 原檔但不入庫、不寫快取或排分析，僅送出一次低優先且靜音的 matchCancel 通知。obs-matches.json 原子保存每局起點、confirmed、cancelled、停止路徑、快取及分析進度；起點仍取各檔 OUTPUT_STARTED 接收時間。復原略過 cancelled，confirmed: false 的未確認錄影停止後視同取消；舊紀錄缺少 confirmed 時維持原行為；每局後排 perMatch，結束時補 afterExit 並更新可信快取。復原會核對 OBS 錄影起點再停止，無法連線或確認歸屬時保留工作。沿用使用者錄影與沒有逐局狀態的舊版工作仍走原本整段錄影及剪檔流程。狀態 phase 保持 recording，obsRecording 區分待命與錄影。
- OBS 輸出不是可讀取的本機影片時，舊版整段路徑通知並無檔收尾；逐局路徑保留工作供重試。即時畫面保留擊殺清單與對局資訊，顯示「OBS 錄影中，錄影結束後即可播放」，不建立段落播放器；僅偵測時明確標示未錄影。狀態包含實際 `backend`，系統匣與狀態依 obsRecording 顯示「錄影中（OBS）」或「待命（OBS，等待對局）」。

---

## 3. 遊戲與對局偵測、效能預算

### 3.1 遊戲偵測（Electron 主程序）

- 每 3 秒列舉程序，找 `r5apex.exe`／`r5apex_dx12.exe`。找到後把 PID 傳給 `aditorrec`。
- `aditorrec` 依 PID 列舉頂層可見視窗（最大面積者）建立 WGC。視窗重建（換解析度／切全螢幕）時自動重建擷取並在 `events.jsonl` 記錄。
- 獨佔全螢幕可能得到黑畫面：連續 3 秒全黑則改用 `CreateForMonitor`（遊戲視窗所在螢幕）。設定頁建議無邊框視窗。
- 擷取方式提供**視窗擷取（`wgc`，預設）**與**螢幕擷取（`dda`）**；OBS 後端的即時分析固定使用 DDA。
  - **螢幕擷取（`dda`，DXGI Desktop Duplication）**：擷取遊戲視窗所在的整個螢幕，不要求 DWM 合成遊戲視窗，避免 WGC 視窗擷取讓全螢幕遊戲退出獨立翻轉而多一格延遲。裝置建在擁有該螢幕的顯示卡上；`AcquireNextFrame` 以 0 逾時輪詢（等待時會占住共用裝置鎖）；時間戳取 `LastPresentTime` 並以編碼器同樣的四捨五入規則對齊到 1/fps 格點。每個輸出時段僅查詢一次前景視窗 PID 與最小化狀態，只有前景屬於目標 PID 且未最小化時才輸出桌面畫面；其餘時間以重用的 GPU 黑色 texture 按設定 fps 持續供應編碼與共享記憶體小圖，音訊不變，WGC 不受影響。切換時送出 `game_hidden`／`game_visible` 事件，`pts` 為錄影起點後的秒數。限制：遊戲仍在前景時，疊在同螢幕上的其他內容仍可能被錄；旋轉螢幕維持面板原生方向；HDR 由系統轉成 SDR。
  - **視窗擷取（`wgc`，預設）**：只錄遊戲視窗，不受前景切換影響，但大廳滑鼠會有延遲。

### 3.2 狀態機

```
Idle →(Apex 啟動)→ Lobby ⇄ InMatch →(Apex 關閉)→ Finalizing → Idle
                         InMatch →(下一局開局序列)→ InMatch（直接排下一場）
```

錄影器在 Apex 執行期間持續錄；「一局一個檔」在後留段落落盤後剪出該局，收尾時才丟掉未使用的大廳段落。

### 3.3 小圖（aditorrec → 共享記憶體）

| 名稱 | 內容 | 頻率 | 格式 |
|---|---|---|---|
| banner | `profile.capture_rois.banner`（1920×1080 基準座標，依實際解析度等比換算；涵蓋所有遊戲比例下 `banner_roi` 的位置） | 4 fps | BGR24 |
| spec | `profile.capture_rois.spec`（同上，涵蓋 `spec_roi`） | 4 fps | BGR24 |
| thumb | 全畫面縮到 640×360（對局場景判斷的最低需求，見 §3.4） | 1 fps（每 4 格帶一次） | GRAY8 |

ROI 由 Python 端在 live 握手時傳給 aditorrec（Python 讀 profile），aditorrec 不解析 profile。

**遊戲比例（4:3／5:4／16:10）**：Apex 依寬度 1920 排 HUD，高度隨比例改變，各元素貼齊上緣、畫面中間或下緣。拉伸成 16:9（或錄 4:3 畫面再縮成 1920×1080）後，寬度與 x 不變，高度乘上壓縮比例（比例 ÷ 16/9：16:10 為 0.9、4:3 為 0.75、5:4 為 0.703），y 往貼齊的邊靠攏。App 開始錄影時讀 `Saved Games/Respawn/Apex/local/videoconfig.txt` 的 `setting.defaultres`／`defaultresheight`，寫入 `recording.json` 的 `gameAspect`，並以 `--aspect WxH` 傳給 live 引擎；內建錄影的完整輸出、逐局剪檔及 OBS 經 FFmpeg 重新封裝的輸出，會將該次錄影的比例寫入 MP4 中繼資料標記 `aditor_game_aspect`，未記錄比例時不寫入。離線分析（`analyze`／`matches`）不再使用目前的 Apex 設定，比例依序取：明確指定的 CLI `--aspect` 或 IPC `aspect` > 影片標記 > 自動偵測；live 模式不變（App 一定知道設定）。標記缺漏、無效或比例不受支援的影片（例如從其他電腦匯入的影片）會用場景模板自動偵測：在影片上平均取樣約 40 格（`DETECT_SAMPLES`），以 640×360 灰階分別用四種比例的 `SceneDetector` 分類，取正向格數（`pre_match`＋`lobby`＋`in_match_hud`）最多的比例；正向格數不足 3 格（`MIN_POSITIVE_FRAMES`），或 16:9 與最高格數並列時沿用 16:9，其餘比例並列時取 HUD／大廳模板分數總和較高者。偵測只在分析真的要解碼影片時才執行：`analyze` 對未標記且未指定比例的影片，不論 `aspect_squash` 為何都直接沿用已完成的快取（快取記錄的就是偵測出的比例），續跑未完成的分析時沿用部分快取內的 `aspect_squash` 而不重新偵測；明確指定或有標記的比例仍嚴格比對 `aspect_squash`。分析結果以 `analysis.aspect_source`（`explicit`／`tag`／`detected`／`default`）記錄比例來源，`default` 表示偵測不到足夠的正向格數而沿用 16:9。aditorrec 一律裁切 `capture_rois`（四種比例的聯集，與遊戲設定無關），引擎依比例取出對應範圍再縮放回 `banner_roi`／`spec_roi` 大小；場景縮圖則依各 ROI 的貼齊方向（`SCENE_ROIS[*].anchor`）重建成 16:9 版面，模板與門檻不變。16:9 時完全等同舊行為。分析快取及可信 live 結果記錄 `aspect_squash`，與影片比例不符時會重新分析。保留黑邊（不拉伸）的輸出未處理。

共享記憶體：具名 file mapping `Local\aditorrec-<sessionId>`，固定 16 槽環形緩衝；槽頭含 `seq`（u64，寫完最後才更新，讀端比對前後 seq 判斷撕裂）、`pts`、各區塊尺寸與 offset。讀端落後超過 16 槽就跳到最新（偵測丟格不阻塞擷取）。

### 3.4 對局判斷（Python live）

使用者錄影（`E:\Apex_highlighter_clip`，4 段共約 56 分鐘：積分賽、外卡模式、勝利、中途死亡、觀戰中排隊、直接下一場、退回大廳）觀察到的開局序列，所有模式共通：

```
（大廳排隊 或 上一局觀戰／結算畫面中排隊）
→ 載入畫面（左上角模式名＋地圖名卡片）
→ 等候區＋上方中央「倒數計時」面板（數字遞減）
→ 選角（底部角色格）→「你的小隊」→ Apex 標誌 → 跳傘 → 對局 HUD
```

結束側：死亡後畫面上方出現「即時／總結」分頁（觀戰）；最終有「比賽總結」畫面；右上出現排隊中的綠框時代表已在排下一場。外卡等可重生模式中，死亡與觀戰**不是**結束。

- **倒數（`match_pending`）與取消（`match_cancel`）**：新的開局序列第一次設為等待確認時送出 `match_pending`，時間取當次取樣、原因 `pre_match`；同一序列不重送。等待中遇到大廳、超過 180 秒仍無 HUD、或串流結束時送出 `match_cancel`，原因分別為 `lobby`／`timeout`／`eof`，時間取取消樣本或結束時間。直接排下一場時先送上一局 `match_end(next_match)` 再送 `match_pending`。兩者僅屬串流事件，不加入確認對局清單，不改變離線結果與準確度。內建錄影器忽略這兩種事件。
- **開始（`match_start`）**：偵測到**開局序列**（倒數面板，或載入畫面的模式卡片）→ 時間取序列第一次出現。對局 HUD（左上小地圖外框、左下血條／護甲欄）出現後確認（`opening_confirmed`）；若開局序列後 180 秒內沒有出現 HUD（例如取消配對），撤銷這次開始。
- **錯過開局序列時恢復開始（`hud_resume`）**：目前沒有進行中的對局、也沒有等待 HUD 確認的開始時，對局 HUD 連續取樣跨越至少 `HUD_RESUME_CONFIRM_SECONDS = 3.0` 秒，送出 `match_start`，時間回溯到這一段的第一個 HUD 樣本。相鄰樣本間隔不得超過 `_max_gap`（取樣週期 × 2.5），任何非 HUD 場景（包含未知／黑畫面的 `other`）都會重算。適用於切回遊戲時已在跳傘／對局中，以及上一局的大廳結束已確定後又漏看下一局序列。錄影開頭的 `initial_match`／`initial_summary` 只在第一個樣本後 `INITIAL_RECOVERY_SECONDS = 10.0` 秒內（含）立即恢復、不等待 3 秒；超過後永久停用，之後只能以 `hud_resume` 恢復。這個時間窗配合 App 清理保留的 15 秒減去 5 秒前置緩衝；清理過段落後，App 也會把早於最早保留段落的開始時間改成該段落的時間（記在 `live.json` 的 `retained_from`）。大廳結束仍在暫定期間時，HUD 仍只取消結束、延續同一局。
- **結束（`match_end`）**取下列最早者：
  1. **下一局的開局序列**出現（直接排下一場）→ 上一局在序列開始前一刻結束，緊接著新局開始；
  2. **大廳畫面**正向偵測連續兩次取樣（1 fps 約 1 秒）→ 暫定結束，時間取大廳首次出現；30 秒內沒有回到對局 HUD 才確定（回大廳後玩家常立刻開組合包／獎勵／商店，畫面不會一直停在大廳，原本「連續 15 秒」的規則在使用者錄影中失敗）；
  3. Apex 關閉。
- 不得以「HUD 消失」或「死亡／觀戰」判斷結束（開地圖、背包、選單時 HUD 也會消失；可重生模式死亡後會回到戰場）。
- 判斷依版面與圖示（面板外框、模式卡片外框、HUD 外框），不依文字，維持與語言無關。
- 小圖：場景判斷需要 ≥ 640×360 灰階（`engine/aditor/scene.py` 的 `SCENE_ROIS`），320×180 的 thumb 不夠；接 live 時把 thumb 提高到 640×360（或在共享記憶體 v2 加場景 ROI）。準確度見 `docs/accuracy-report-matches.md`。
- 範本來源與驗收：上述 4 段錄影；驗收標準為每局起訖誤差 ±5 秒、不得漏局或多切。

### 3.5 擊殺偵測

沿用既有圖示偵測與事件狀態機（4 fps、`banner_roi`／`spec_roi`）。離線版會先以前 900 秒學習關鍵字；live 版改為邊玩邊學（累積到足夠錨點後才啟用依賴關鍵字的判斷），初期準確度可能稍低，由 R9 的完整分析校正。

### 3.6 效能預算（驗收標準）

| 項目 | 目標 |
|---|---|
| 遊戲 FPS | PresentMon 量測，平均與 1% low 下降 < 3%（RTX 5080，1440p） |
| CPU（aditorrec＋live 引擎） | 合計 < 3%；兩者以 `BELOW_NORMAL_PRIORITY_CLASS` 執行 |
| GPU→CPU 讀回 | ≤ 0.5 MB/s |
| 記憶體 | aditorrec < 300 MB；live 引擎 < 200 MB |
| 編碼 | 只用硬體編碼單元 |
| 背壓 | 編碼佇列滿 → 丟格（計數並回報）；偵測落後 → 跳格；擷取執行緒永不阻塞 |

附 `tools/perf/presentmon_ab.ps1`：同一場景錄影關／開各量一次並輸出差異。

---

## 4. 介面、錯誤處理、IPC、建置、測試

### 4.1 設定（新「錄影」分頁）

錄影後端（內建／OBS：位址、連接埠、密碼、測試連線）；模式（一局一個檔／從頭錄到尾）；開機啟動並常駐系統匣（預設開）；自動錄影開關；錄影資料夾（預設＝監看資料夾，輸出檔由錄影流程直接加入媒體庫，監看端忽略 `.sessions/` 並以路徑去重）；畫質（編碼器、解析度、FPS、位元率）；聲音（系統裝置、麥克風裝置、麥克風音量、關閉麥克風）；錄後分析（不分析／關遊戲後／每局後低優先序）；磁碟門檻（提醒、停止）。

`recording.backend` 預設仍為 `builtin`；OBS 設定為 `obsHost: '127.0.0.1'`、`obsPort: 4455`（整數 1–65535）、`obsPasswordEnc: null`、`obsFallbackBuiltin: true`，由 `pickRecording` 正規化。密碼只能從設定頁唯寫欄位送入，由 Electron `safeStorage` 加密成 base64 後持久化；加密服務不可用時拒絕儲存並顯示錯誤，不能改存明文。`settings:get/set/changed` 一律移除密文及輸入密碼，renderer 只取得 `hasPassword` 與「已設定」狀態。空字串代表移除密碼；密碼不進入錄影快照、狀態或日誌。測試連線只查 OBS／obs-websocket 版本，不開始錄影。OBS 模式隱藏影像、編碼與音訊設定，提示在 OBS 設定品質與音訊；擷取方式仍適用於 live 偵測。

內建錄影設定分成「一般／影像／音訊」；影像與音訊各有預設收合、搜尋時展開的「進階選項」。影像進階含強制 16:9（預設關）、裁切方式（適配，未強制時停用）、編碼格式、編碼器、編碼預設、擷取方式。音訊提供系統聲音與麥克風各自的開關、裝置及 0–200% 音量；進階含系統聲音只錄遊戲（預設關，啟用時忽略裝置）、麥克風強制單聲道（預設關）。兩個音源皆停用或沒有預設裝置時仍輸出靜音音軌。

### 4.2 系統匣與 App

- 系統匣圖示：待命／錄影中（紅點）／錯誤；選單：打開 App、開始／停止錄影、暫停自動錄影、結束。
- Windows 通知：對局開始、對局結束、錯誤（預設只開錯誤）。
- 側欄「錄影中」（錄影時紅點）；頂部狀態列：錄影時間、第幾局、本局擊殺、磁碟剩餘。

### 4.3 錯誤處理

| 情況 | 處理 |
|---|---|
| aditorrec 當掉 | 主程序自動重啟（指數退避，最多 5 次/10 分鐘），新段落序列續錄；`events.jsonl` 寫 `gap` |
| live 引擎當掉 | 自動重啟；錄影不受影響；漏掉的區間由完整分析補 |
| 無硬體編碼器 | 不錄並通知 |
| OBS 連不上／驗證失敗 | 通知；預設本次回退內建錄影，關閉回退時只做即時偵測 |
| OBS 中途斷線 | 即時偵測照常，退避重連；停止事件遺失且無路徑時通知手動匯入，不猜測或掃描 OBS 資料夾 |
| OBS 輸出非可讀本機檔案 | 通知，無檔收尾，不變更媒體庫或 OBS 原檔 |
| 密碼加密服務無法使用 | 拒絕儲存並顯示錯誤，原密碼設定保留 |
| 磁碟不足 | §2.5 |
| App 意外關閉 | 下次啟動補收尾 |

### 4.4 IPC（主程序 ⇄ aditorrec）

JSON-lines，stdin 指令、stdout 事件，stderr 為日誌。每行 ≤ 64 KB。

指令：
- `{"id":1,"cmd":"hello"}` → `{"id":1,"ok":true,"version":"0.1.0","encoders":["hevc_nvenc",…],"audio":{"render":[…],"capture":[…]}}`
- `{"id":2,"cmd":"start","pid":1234,"session_dir":"…","session_id":"…","encode":{"codec":"hevc","encoder":"auto","fps":60,"height":0,"bitrate_kbps":40000},"audio":{"render":"default","capture":"default","mic_gain":1.0,"mic_enabled":true},"frames":{"banner":[x,y,w,h],"spec":[x,y,w,h],"base":[1920,1080]}}`（`encode` 為 `null` 時只擷取不編碼；選填 `"capture":"wgc"|"dda"`，預設 `wgc`，其他值為 `bad_request`）
- `encode` 新增選填 `preset: "speed"|"balanced"|"quality"`（預設 speed）、`aspect: "native"|"fit"|"stretch"`（預設 native）；`audio` 新增選填 `render_enabled: bool`（true）、`render_gain: 0..2`（1.0）、`mic_mono: bool`（false）、`render_source: "device"|"game"`（device）。未知列舉及無效增益回覆 `bad_request`，省略欄位保留既有行為。
- `render_source: "game"` 以 `ActivateAudioInterfaceAsync`／`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`／`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` 擷取錄影 PID 與子程序，請求 48 kHz float 立體聲並進入既有混音流程，不開啟程序 handle。需要 Windows 組建 20348 起的系統；啟用失敗時退回裝置 loopback，發出 `{"ev":"warning","code":"game_audio_unavailable","message":"…"}`，App 顯示非致命通知，錄影繼續。
- `{"id":3,"cmd":"stop"}`；`{"id":4,"cmd":"ping"}`（小圖 ROI 只在 `start` 指定；要換 ROI 就 stop 再 start）

事件（無 `id`）：`{"ev":"started","encoder":"hevc_nvenc","width":2560,"height":1440,"fps":60,"shm":"Local\\aditorrec-…"}`、`{"ev":"segment","seq":12,"pts":22.0,"dur":2.0}`、`{"ev":"stats","fps_in":…,"fps_enc":…,"dropped":…,"q":…}`（每 5 秒）、`{"ev":"window_lost"}`、`{"ev":"stopped","reason":"…"}`、`{"ev":"error","code":"…","message":"…"}`。

錯誤碼：`no_hw_encoder`、`window_not_found`、`capture_failed`、`encode_failed`、`audio_failed`、`disk_full`、`bad_request`、`internal`。

### 4.5 建置

- `recorder/`：Cargo 專案（binary `aditorrec`），`windows` crate、`serde_json`；ffmpeg 綁定在 `recorder/src/ffi/` 預先產生。
- 連結 `build/ffmpeg/lib/*.lib`（環境變數 `ADITORREC_FFMPEG_DIR` 可覆寫）；執行期由 `ffmpeg/bin` 載入 DLL（打包時與 `aditorrec.exe` 同層或設定 DLL 搜尋路徑）。
- `scripts/build.ps1` 加 `cargo build --release`；electron-builder `extraResources` 加入 `aditorrec.exe`。

### 4.6 測試

- Rust 單元測試：段落索引、收尾串接範圍、共享記憶體版面、IPC 編解碼、混音。
- Rust 整合測試：擷取自建測試視窗 5 秒 → 段落可解碼、時間連續；共享記憶體小圖內容正確。無 GPU 編碼器的環境 `#[ignore]`。
- Python：live 模式以黃金錄影模擬即時串流，與離線分析比對（召回差 ≤ 5%、無新增誤判）；對局判斷以使用者錄影驗收（±5 秒）。
- App：vitest＋假 aditorrec 模擬完整流程與錯誤情境。
- 效能驗收：§3.6 腳本，於使用者機器實測。

---

## 5. 分期

| 期 | 內容 | 可驗收的成果 |
|---|---|---|
| 1 | aditorrec 核心：WGC、硬體編碼、音訊、fMP4 段落、共享記憶體小圖、IPC | `aditorrec.exe` 以 CLI／IPC 錄 Apex（或任意視窗）成可播放段落 |
| 2 | App 整合：遊戲偵測、狀態機、系統匣、設定、從頭錄到尾、收尾、崩潰補收尾 | 開 Apex 自動錄、關 Apex 得到一個檔進媒體庫 |
| 3 | live 偵測＋錄影中 Studio（MSE） | 錄影中切出遊戲看到當局影片與即時擊殺 |
| 4 | 對局偵測＋一局一個檔 | 使用者錄影已提供（`E:\Apex_highlighter_clip`） |
| 5 | OBS 後端 | |

每期各自 計畫 → 實作 → 審查。

## 6. 風險

| 風險 | 對策 |
|---|---|
| ffmpeg 9（avcodec-63）沒有現成 Rust crate | 自行 bindgen 產生並提交綁定，只包需要的函式 |
| 硬體編碼器對 BGRA D3D11 輸入的支援差異 | 不支援時在 GPU 以 VideoProcessor 轉 NV12 |
| 獨佔全螢幕黑畫面 | 自動改擷取螢幕 |
| WGC 黃框 | Windows 11 以 `IsBorderRequired = false` 關閉；Win10 無法關閉（已知限制） |
| live 準確度低於離線 | R9 完整分析校正 |

## 7. 內建逐局錄影的大廳暫存

內建後端在「一局一個檔」模式持續擷取與編碼，每個段落通知都透過既有剪檔序列清理未受保護的 `seg_*.m4s`，不修改 aditorrec 的 `index.jsonl` 或 `init.mp4`。從頭錄到尾與 OBS 後端不清理。

保護範圍為所有已確認對局的開始前 5 秒至結束後 5 秒（包含已剪出的對局）、尚未確認的倒數開始前 5 秒起，以及 `pts + dur > latest_pts - 15` 的大廳滾動暫存。段落完整保留，因此 2 秒段落通常保留約 18 秒。尚未收到結束確認的對局維持開放範圍；大廳結束晚約 30 秒確認時，才依回溯的結束時間套用後留 5 秒。取消倒數後解除該倒數保護；直接排下一場保護兩局及新倒數。

僅在即時引擎啟動且已產生快照時清理；重啟後至少等待 30 秒且收到新快照。放棄偵測後停止清理；若已清理過再發生引擎重啟，保守地停用本工作後續清理，避免偵測空窗誤刪對局。

第一次刪除前先原子寫入 `pruned.json`。補收尾沿用原始完整索引，只讀取對局範圍需要的片段；必要片段遺失時明確失敗並保留工作供重試。清理過且沒有對局的工作不產生整段影片，完成後移除工作目錄；未清理的工作仍沿用「無對局則輸出整段」回退。

清理後推播完整可讀片段清單，LiveSession 拒絕讀取已移除序號；MSE 替換片段清單並容許起始序號晚於 1，忽略清理期間已失效的讀取。狀態的 `durationSec` 與 `segments` 仍表示累計錄製量。
