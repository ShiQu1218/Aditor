# Apex Highlighter — 遊戲錄影與即時偵測設計

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

硬性限制：**不注入遊戲程序、不讀遊戲記憶體**（README 承諾；Apex 使用 EAC）。

---

## 1. 程序架構

```
┌─ Electron 主程序（既有 App）──────────────────────────────────┐
│ 遊戲偵測 · 錄影工作狀態機 · 系統匣 · 開機啟動                    │
│ OBS 控制（WebSocket v5）· 事件推送到 renderer · 收尾（串接／排分析）│
└──────┬──────────────────────────────┬────────────────────────┘
       │ JSON-lines（stdin/stdout）    │ JSON-lines（stdin/stdout）
┌──────▼───────────────────────┐  ┌───▼──────────────────────────────┐
│ apexrec.exe（新，Rust）       │  │ Python 引擎（既有），新增 live 指令  │
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
3. **偵測沿用 Python**：`apexrec` 只輸出小圖（見 §3），Python live 模式用既有偵測器。日後若量測顯示 Python 是瓶頸，再移植到 Rust 並以比對測試確保結果一致。
4. **OBS 模式**：`apexrec` 仍執行，但只做擷取＋小圖讀回（`--no-encode`），錄影由 OBS 負責。偵測路徑兩種模式相同。
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
  session.json      設定快照（編碼器、解析度、模式、開始時間、apexrec 版本）
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

- 兩種模式都在 Apex 執行期間維持同一個 apexrec 工作，不重啟擷取，即時觀看持續可用。`recording.json` 快照保存 `startedAt`、`postAnalysis`、`mode`；舊快照缺少或無效的模式視為 `session`。
- 逐局選取 `pts + dur > start - 5` 且 `pts < end + 5` 的索引段落。錄影中等到索引出現 `pts >= end + 5` 才剪；停止時依序停止錄影器、停止 live 引擎取得最終快照，再補剪。未結束的最後一局以最後段落結束時間收尾；沒有 live.json 或沒有對局時保留整段。
- ffmpeg 剪檔序列執行，失敗不影響錄影，收尾時重試。檔名使用 `startedAt + 首段 pts` 的本機時間：`Apex_<YYYY-MM-DD_HH-mm>.mp4`，撞名加 `_2`、`_3`。
- `match-part.json` 記錄本工作的暫存檔路徑。串接到 `.part.mp4` 後，先原子寫入 `matches.json` 的 `cuts`（零起算的對局索引、起訖、首尾序號、輸出路徑、分析／快取／可信狀態），再改名、加入媒體庫、寫快取與通知。恢復時刪除未登記的暫存檔，已登記者直接完成改名，不重複串接；收尾僅回傳這次新剪出的路徑，所有既有剪檔仍補加媒體庫。
- 每個輸出的 live 快取依首段 pts 位移，事件、觀戰與對局均限制於該輸出範圍；錄影中一律不標成可信。最終品質完整時，只重寫 `analysis.source === 'live'` 的自有快取為可信，保留完整分析快取。
- `perMatch` 在逐局剪出後立即排分析且只排一次；`afterExit` 在收尾時只排尚未可信且未排過的剪檔；`none` 不排分析。整段模式的兩種分析時機都在收尾後處理。剪檔與副作用成功後才刪除工作目錄，未使用的大廳段落隨之丟棄。

### 2.4 編碼設定

- 編碼器：自動（HEVC 優先 → H.264；AV1 可選）。探測順序 NVENC → AMF → QSV；**沒有硬體編碼器就不錄**（不退回 CPU 編碼）。
- 解析度：原生／1080p（縮放在 GPU，`scale_d3d11` 或 VideoProcessor）。FPS：60（預設）／原生上限 144。位元率預設 HEVC 1440p60 = 40 Mbps、1080p60 = 25 Mbps；H.264 ×1.5。
- 音訊：48 kHz 立體聲 AAC 192 kbps。

### 2.5 安全措施

- 崩潰最多遺失最後一段（2 秒）。App 啟動時掃描 `.sessions/`，未收尾者依 `session.json` 模式補做收尾。
- 磁碟：開始前與每 30 秒檢查。< 提醒門檻（預設 10 GB）通知；< 停止門檻（預設 2 GB）停止錄影並收尾已錄部分。

### 2.6 OBS 模式（第 5 期）

- WebSocket v5：`StartRecord`／`StopRecord`；一局一個檔用 `SplitRecordFile`（OBS ≥ 30）。
- v1 限制：錄影進行中無法播放 OBS 正在寫的檔，只顯示擊殺列表與當下小圖；切檔後可播。追讀 hybrid MP4 留到 v2。

---

## 3. 遊戲與對局偵測、效能預算

### 3.1 遊戲偵測（Electron 主程序）

- 每 3 秒列舉程序，找 `r5apex.exe`／`r5apex_dx12.exe`。找到後把 PID 傳給 `apexrec`。
- `apexrec` 依 PID 列舉頂層可見視窗（最大面積者）建立 WGC。視窗重建（換解析度／切全螢幕）時自動重建擷取並在 `events.jsonl` 記錄。
- 獨佔全螢幕可能得到黑畫面：連續 3 秒全黑則改用 `CreateForMonitor`（遊戲視窗所在螢幕）。設定頁建議無邊框視窗。
- 擷取方式預設為 DDA（DXGI Desktop Duplication，設定「擷取方式」；實機測得大廳滑鼠延遲明顯低於 WGC，WGC 保留為選項）：擷取遊戲視窗所在的整個螢幕，不要求 DWM 合成遊戲視窗，避免 WGC 視窗擷取讓全螢幕遊戲退出獨立翻轉而多一格延遲。裝置建在擁有該螢幕的顯示卡上；`AcquireNextFrame` 以 0 逾時輪詢（等待時會占住共用裝置鎖）；時間戳取 `LastPresentTime` 並以編碼器同樣的四捨五入規則對齊到 1/fps 格點。限制：同螢幕上蓋住遊戲的視窗也會被錄；旋轉螢幕維持面板原生方向；HDR 由系統轉成 SDR。

### 3.2 狀態機

```
Idle →(Apex 啟動)→ Lobby ⇄ InMatch →(Apex 關閉)→ Finalizing → Idle
                         InMatch →(下一局開局序列)→ InMatch（直接排下一場）
```

錄影器在 Apex 執行期間持續錄；「一局一個檔」在後留段落落盤後剪出該局，收尾時才丟掉未使用的大廳段落。

### 3.3 小圖（apexrec → 共享記憶體）

| 名稱 | 內容 | 頻率 | 格式 |
|---|---|---|---|
| banner | `profile.banner_roi`（1920×1080 基準座標，依實際解析度等比換算） | 4 fps | BGR24 |
| spec | `profile.spec_roi` | 4 fps | BGR24 |
| thumb | 全畫面縮到 640×360（對局場景判斷的最低需求，見 §3.4） | 1 fps（每 4 格帶一次） | GRAY8 |

ROI 由 Python 端在 live 握手時傳給 apexrec（Python 讀 profile），apexrec 不解析 profile。

共享記憶體：具名 file mapping `Local\apexrec-<sessionId>`，固定 16 槽環形緩衝；槽頭含 `seq`（u64，寫完最後才更新，讀端比對前後 seq 判斷撕裂）、`pts`、各區塊尺寸與 offset。讀端落後超過 16 槽就跳到最新（偵測丟格不阻塞擷取）。

### 3.4 對局判斷（Python live）

使用者錄影（`E:\Apex_highlighter_clip`，4 段共約 56 分鐘：積分賽、外卡模式、勝利、中途死亡、觀戰中排隊、直接下一場、退回大廳）觀察到的開局序列，所有模式共通：

```
（大廳排隊 或 上一局觀戰／結算畫面中排隊）
→ 載入畫面（左上角模式名＋地圖名卡片）
→ 等候區＋上方中央「倒數計時」面板（數字遞減）
→ 選角（底部角色格）→「你的小隊」→ Apex 標誌 → 跳傘 → 對局 HUD
```

結束側：死亡後畫面上方出現「即時／總結」分頁（觀戰）；最終有「比賽總結」畫面；右上出現排隊中的綠框時代表已在排下一場。外卡等可重生模式中，死亡與觀戰**不是**結束。

- **開始（`match_start`）**：偵測到**開局序列**（倒數面板，或載入畫面的模式卡片）→ 時間取序列第一次出現。對局 HUD（左上小地圖外框、左下血條／護甲欄）出現後確認；若開局序列後 180 秒內沒有出現 HUD（例如取消配對），撤銷這次開始。
- **結束（`match_end`）**取下列最早者：
  1. **下一局的開局序列**出現（直接排下一場）→ 上一局在序列開始前一刻結束，緊接著新局開始；
  2. **大廳畫面**正向偵測連續兩次取樣（1 fps 約 1 秒）→ 暫定結束，時間取大廳首次出現；30 秒內沒有回到對局 HUD 才確定（回大廳後玩家常立刻開組合包／獎勵／商店，畫面不會一直停在大廳，原本「連續 15 秒」的規則在使用者錄影中失敗）；
  3. Apex 關閉。
- 不得以「HUD 消失」或「死亡／觀戰」判斷結束（開地圖、背包、選單時 HUD 也會消失；可重生模式死亡後會回到戰場）。
- 判斷依版面與圖示（面板外框、模式卡片外框、HUD 外框），不依文字，維持與語言無關。
- 小圖：場景判斷需要 ≥ 640×360 灰階（`engine/apexhl/scene.py` 的 `SCENE_ROIS`），320×180 的 thumb 不夠；接 live 時把 thumb 提高到 640×360（或在共享記憶體 v2 加場景 ROI）。準確度見 `docs/accuracy-report-matches.md`。
- 範本來源與驗收：上述 4 段錄影；驗收標準為每局起訖誤差 ±5 秒、不得漏局或多切。

### 3.5 擊殺偵測

沿用既有圖示偵測與事件狀態機（4 fps、`banner_roi`／`spec_roi`）。離線版會先以前 900 秒學習關鍵字；live 版改為邊玩邊學（累積到足夠錨點後才啟用依賴關鍵字的判斷），初期準確度可能稍低，由 R9 的完整分析校正。

### 3.6 效能預算（驗收標準）

| 項目 | 目標 |
|---|---|
| 遊戲 FPS | PresentMon 量測，平均與 1% low 下降 < 3%（RTX 5080，1440p） |
| CPU（apexrec＋live 引擎） | 合計 < 3%；兩者以 `BELOW_NORMAL_PRIORITY_CLASS` 執行 |
| GPU→CPU 讀回 | ≤ 0.5 MB/s |
| 記憶體 | apexrec < 300 MB；live 引擎 < 200 MB |
| 編碼 | 只用硬體編碼單元 |
| 背壓 | 編碼佇列滿 → 丟格（計數並回報）；偵測落後 → 跳格；擷取執行緒永不阻塞 |

附 `tools/perf/presentmon_ab.ps1`：同一場景錄影關／開各量一次並輸出差異。

---

## 4. 介面、錯誤處理、IPC、建置、測試

### 4.1 設定（新「錄影」分頁）

錄影後端（內建／OBS：位址、連接埠、密碼、測試連線）；模式（一局一個檔／從頭錄到尾）；開機啟動並常駐系統匣（預設開）；自動錄影開關；錄影資料夾（預設＝監看資料夾，輸出檔由錄影流程直接加入媒體庫，監看端忽略 `.sessions/` 並以路徑去重）；畫質（編碼器、解析度、FPS、位元率）；聲音（系統裝置、麥克風裝置、麥克風音量、關閉麥克風）；錄後分析（不分析／關遊戲後／每局後低優先序）；磁碟門檻（提醒、停止）。

### 4.2 系統匣與 App

- 系統匣圖示：待命／錄影中（紅點）／錯誤；選單：打開 App、開始／停止錄影、暫停自動錄影、結束。
- Windows 通知：對局開始、對局結束、錯誤（預設只開錯誤）。
- 側欄「錄影中」（錄影時紅點）；頂部狀態列：錄影時間、第幾局、本局擊殺、磁碟剩餘。

### 4.3 錯誤處理

| 情況 | 處理 |
|---|---|
| apexrec 當掉 | 主程序自動重啟（指數退避，最多 5 次/10 分鐘），新段落序列續錄；`events.jsonl` 寫 `gap` |
| live 引擎當掉 | 自動重啟；錄影不受影響；漏掉的區間由完整分析補 |
| 無硬體編碼器 | 不錄並通知 |
| OBS 連不上 | 通知；偵測照常；提供「改用內建錄影」 |
| 磁碟不足 | §2.5 |
| App 意外關閉 | 下次啟動補收尾 |

### 4.4 IPC（主程序 ⇄ apexrec）

JSON-lines，stdin 指令、stdout 事件，stderr 為日誌。每行 ≤ 64 KB。

指令：
- `{"id":1,"cmd":"hello"}` → `{"id":1,"ok":true,"version":"0.1.0","encoders":["hevc_nvenc",…],"audio":{"render":[…],"capture":[…]}}`
- `{"id":2,"cmd":"start","pid":1234,"session_dir":"…","session_id":"…","encode":{"codec":"hevc","encoder":"auto","fps":60,"height":0,"bitrate_kbps":40000},"audio":{"render":"default","capture":"default","mic_gain":1.0,"mic_enabled":true},"frames":{"banner":[x,y,w,h],"spec":[x,y,w,h],"base":[1920,1080]}}`（`encode` 為 `null` 時只擷取不編碼；選填 `"capture":"wgc"|"dda"`，預設 `wgc`，其他值為 `bad_request`）
- `{"id":3,"cmd":"stop"}`；`{"id":4,"cmd":"ping"}`（小圖 ROI 只在 `start` 指定；要換 ROI 就 stop 再 start）

事件（無 `id`）：`{"ev":"started","encoder":"hevc_nvenc","width":2560,"height":1440,"fps":60,"shm":"Local\\apexrec-…"}`、`{"ev":"segment","seq":12,"pts":22.0,"dur":2.0}`、`{"ev":"stats","fps_in":…,"fps_enc":…,"dropped":…,"q":…}`（每 5 秒）、`{"ev":"window_lost"}`、`{"ev":"stopped","reason":"…"}`、`{"ev":"error","code":"…","message":"…"}`。

錯誤碼：`no_hw_encoder`、`window_not_found`、`capture_failed`、`encode_failed`、`audio_failed`、`disk_full`、`bad_request`、`internal`。

### 4.5 建置

- `recorder/`：Cargo 專案（binary `apexrec`），`windows` crate、`serde_json`；ffmpeg 綁定在 `recorder/src/ffi/` 預先產生。
- 連結 `build/ffmpeg/lib/*.lib`（環境變數 `APEXREC_FFMPEG_DIR` 可覆寫）；執行期由 `ffmpeg/bin` 載入 DLL（打包時與 `apexrec.exe` 同層或設定 DLL 搜尋路徑）。
- `scripts/build.ps1` 加 `cargo build --release`；electron-builder `extraResources` 加入 `apexrec.exe`。

### 4.6 測試

- Rust 單元測試：段落索引、收尾串接範圍、共享記憶體版面、IPC 編解碼、混音。
- Rust 整合測試：擷取自建測試視窗 5 秒 → 段落可解碼、時間連續；共享記憶體小圖內容正確。無 GPU 編碼器的環境 `#[ignore]`。
- Python：live 模式以黃金錄影模擬即時串流，與離線分析比對（召回差 ≤ 5%、無新增誤判）；對局判斷以使用者錄影驗收（±5 秒）。
- App：vitest＋假 apexrec 模擬完整流程與錯誤情境。
- 效能驗收：§3.6 腳本，於使用者機器實測。

---

## 5. 分期

| 期 | 內容 | 可驗收的成果 |
|---|---|---|
| 1 | apexrec 核心：WGC、硬體編碼、音訊、fMP4 段落、共享記憶體小圖、IPC | `apexrec.exe` 以 CLI／IPC 錄 Apex（或任意視窗）成可播放段落 |
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
