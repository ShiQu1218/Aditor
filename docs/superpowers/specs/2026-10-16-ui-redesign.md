# Apex Highlighter — UI／UX 改版提案

日期：2026-10-16
狀態：設計定稿（第 2 版：已納入獨立設計評審，見 §9）；未改動任何 app 原始碼，下一步依 `docs/superpowers/plans/2026-10-16-plan3-ui.md` 實作
範圍：取代 `2026-10-15-apex-highlighter-design.md` §6「使用介面與流程」；§1–§5、§7–§11（引擎、快取格式、匯出規則、授權）不變。
可點擊示意：`docs/design/ui-mock/index.html`（雙擊即可在瀏覽器開啟，無需建置；截圖在 `docs/design/ui-mock/screens/`）。

使用者已選定：視覺風格接近 Outplayed（深色遊戲風、大縮圖卡片、明亮重點色 Apex 紅、時間軸事件圖示），並同意改版流程（可合併檢視器與編輯器）。

---

## 0. 摘要

| 項目 | 現況 | 改版 |
|---|---|---|
| 畫面 | 影片庫／檢視器／剪輯專案三個整頁，靠「返回」與頂端按鈕換頁 | 左側圖示欄＋三個畫面：**影片庫**、**工作室**（檢視器＋專案軌合併）、**設定**；匯出為與側欄同寬的右側抽屜 |
| 精華確認 | 先開「AI 自動剪輯」對話框、再到「片段清單」分頁檢查 | 開啟分析完成的影片時，自動以預設參數放上「建議框」；側欄「精華」分頁以大縮圖卡片逐一 **加入／略過** |
| 專案編輯 | 另一頁，片段是文字卡片＋±0.5 s 小按鈕 | 常駐於工作室時間軸下方的「專案軌」；拖曳起訖把手、拖曳排序，播放器可切換「來源／專案」預覽 |
| 分析 | 只在影片卡片上看進度 | 全域佇列（圖示欄環形進度＋浮層）、監看資料夾；**v1 分析完成後才能在工作室開啟**（分析中檢視為 v2，見 §9） |
| 視覺 | 內嵌 style、色碼散落各檔 | 統一 design token（CSS 變數）、事件類型「形狀＋顏色＋圖示」三重編碼 |

所有現有功能皆保留（§4 對照表逐項列出）；少數互動方式改變，皆附理由。

---

## 1. Outplayed 分析（借用什麼、依據是什麼）

資料來源（唯讀）：`C:\Users\wluis\AppData\Local\Overwolf\Extensions\cghphpbjeabdkomiphingnegihoigeggcfphdofo\176.4.13583\`。

**方法與限制**：Outplayed 是 Overwolf 網頁應用，其樣式編譯進 `indexCss.js`（1.1 MB）、字串在 `index.js`。本分析以 `grep` 統計色碼、CSS 變數、尺寸與字串得出，**未啟動 Outplayed 截圖**，因此版面結構是由 CSS class 名稱與尺寸推得，不是逐像素量測。下列數字為出現次數（越多代表越是其設計系統的核心值）。

### 1.1 色彩（`indexCss.js`）

| 用途 | Outplayed 值 | 證據 | 我們的對應 |
|---|---|---|---|
| 品牌色 | `hsl(340,100%,45%)` = `#E6004D`（洋紅偏紅） | `--brand-color` 15 次；`#E6004D` 64 次 | 換成 Apex 紅 `--accent #D92E25`（白字對比 4.8:1）；深底上文字／線條用 `--accent-bright #FF5348`（對 `#131313` 為 5.8:1） |
| 警示／收藏黃 | `hsl(50,100%,50%)` = `#FFD500` | `--alert` 5 次；`#FFD500` 19 次 | `--favorite`／`--warning` 沿用 `#FFD500` |
| 背景 | `#131313`（21）；`rgba(19,19,19,.9)`（8）；`#272727`（3） | 同上 | `--bg-app #131313`，表面層用 `#1B1B1D` `#242427`（以白色透明度疊層的結果，改成實色以省合成成本） |
| 文字／灰階 | `#F6F6F6`（35）、`#DEDEDE`（62）、`#B6B6B6`（28）、`#A8A8A8`（37）、`#828282`（40）、`#6C6C6C`（11） | 同上 | `--text-1 #F6F6F6`、`--text-2 #B6B6B6`、`--text-3 #828282`、`--text-disabled #6C6C6C`（`#DEDEDE`／`#A8A8A8` 與相鄰階太近，合併） |
| 疊層 | `rgba(255,255,255,.1)` ×71、`.2` ×28、`.05` ×21、`.15` ×11、`.03` ×9；`rgba(0,0,0,.6)` ×9 | `background-color:` 統計 | `--bg-hover .06`、`--bg-active .10`、`--line .08`、`--line-strong .16`、`--bg-scrim .62` |
| 對焦框 | `--focus-visible-color: rgba(255,255,255,.6)` ×7 | CSS 變數 | `--focus-ring: 0 0 0 2px rgba(255,255,255,.6)` |

### 1.2 字型與字級

- 字型：Lato（Regular／Bold／Heavy，一般 UI；`font-family:"LatoRegular"` 47 次）＋ Montserrat（Medium／SemiBold／Bold，標題；woff2 位於 `assets/fonts/lato`、`assets/fonts/montserrat`）。
- 字級次數：`13px` ×27、`12px` ×27、`16px` ×23、`14px` ×18、`20px` ×7、`22px` ×4、`18px` ×4、`26px` ×3、`40px` ×3、`11px` ×3。→ 我們的字級階梯 11／12／13／14／16／18／22／26／40（§5）。
- 繁中：兩者皆無 CJK，改以 `Noto Sans TC`／`Microsoft JhengHei UI` 備援（Windows 必有微軟正黑體，不需額外打包）。

### 1.3 版面與尺寸

| 項目 | Outplayed | 證據 | 我們的採用 |
|---|---|---|---|
| 整體骨架 | 頂欄＋**左側圖示欄**＋主區＋**右側側欄** | `.app-header{grid-template-columns:1fr auto}`、`.app-sidenav{flex-direction:column;background-color:rgba(255,255,255,.1)}`、`.app-aside{grid-area:main/aside/-1/auto;width:440px;contain:strict}` | 圖示欄 56 px、頂欄 52 px、側欄 380 px（1366 px 寬筆電上 440 px 會壓縮播放器，故縮窄） |
| 時間軸高度 | `--media-timeline-height: 175px`（緊湊 135 px） | CSS 變數 | 來源軌 120 px＋專案軌 92 px（§5） |
| 事件標記 | 30 px 圓形圖示（`margin-left:-15px; border-radius:50%`） | `.timeline-event` | 22 px，並以形狀區分類型（圓／圓角方／菱形／六角），因為我們有 5 種同屬「擊殺」的事件，只靠顏色不夠 |
| 剪輯框 | 兩側 9 px 把手、上下 4 px 緣（`grid-template-columns:[left-handle] 9px [main] 1fr [right-handle] 9px`），出現用 `scale(0→1)` 0.25 s | `.editor-timeline-clip` | 把手 9 px 沿用；動畫縮短到 0.15 s |
| 播放頭 | 6×10 px 小把手，hover 時長高到 16 px | `.timeline-seeker-thumb` | 2 px 白線＋三角頭，以 `transform` 移動 |
| 圓角 | `--corner:10px`、預設 `3px` | CSS 變數 | `--r-md 10`、`--r-xs 3`，另加 `--r-sm 6` |
| 卡片格 | `repeat(auto-fill, minmax(min(18vw,320px),1fr))` | grid 統計 | `minmax(280px,1fr)`，間距 16 px |
| 動態 | `transition:.15s`（86 處）、`.25s`（41 處） | 統計 | `--dur-fast 150ms`、`--dur-base 250ms` |

### 1.4 互動模式與快捷鍵（`index.js` 工具提示字串，英文版）

| 模式 | 證據 | 我們的做法 |
|---|---|---|
| 快速剪輯 | `Quick trim <kbd>Ctrl + Q</kbd>`（編輯器中同鍵字串為 Slice／Dividir／Couper，**已證實**同一鍵在編輯器 = 分割） | 來源模式 Ctrl+Q = 快速剪輯（現況）；專案模式 Ctrl+Q = 在播放頭分割（新） |
| 開啟編輯器 | `Open in editor <kbd>Ctrl + E</kbd>` | 現況 Ctrl+E 是「傳送至專案」。改版後仍是 Ctrl+E，但**不換頁** |
| 上／下一個精華 | `Previous/Next highlight <kbd>Ctrl + ←/→</kbd>` | 沿用（現況已有） |
| 速度 | `Toggle speed <kbd>S</kbd>`、`Custom speed 0.07 – 8` | 沿用 S；自訂速度不採用（§4 不採用清單） |
| 縮放 | `Zoom in/out <kbd>Ctrl + +/-</kbd>`、`Zoom-Reset Ctrl + 0`、`Ctrl + Mousewheel` | 沿用，新增 Ctrl+滾輪 |
| 設定起訖 | `Set start/end time to seeker position <kbd>[</kbd> / <kbd>]</kbd> | **新增** `[` `]` |
| 復原 | `Undo Ctrl+Z`、`Redo Ctrl+Shift+Z`、`Actions history Ctrl+H` | 沿用 Ctrl+Z／Y，另加 Ctrl+Shift+Z；動作歷史不採用 |
| 收藏／複製 | `Add to favorites Ctrl+D`（影片庫）、`Duplicate Ctrl+D`（編輯器） | 同鍵依畫面脈絡：影片庫 = 收藏，專案軌 = 複製片段 |
| 搜尋 | `Search by name, game, or event Ctrl+F`；`Clear search Esc` | 沿用 Ctrl+F，新增 Esc 清除 |
| 即時合輯 | `Instant Supercut <kbd>Ctrl + M</kbd>`；`Create Supercut` | 「選取事件 → 建立合輯」新增 Ctrl+M |
| 時間軸切換 | `Timeline <kbd>Ctrl + T</kbd>` | 不採用（專案軌改以收合按鈕） |
| 全螢幕 | `Full screen <kbd>F11</kbd>` | 留給 Electron 預設 |
| 剪輯長度 | 字串 `durationBefore`＝"Before duration"、`durationAfter` | 即我們已有的 before／after 秒數（預設 8／4） |
| 內容組織 | `Sessions`、`Highlights`、`Favorites`、`Collections` | 影片庫依日期分組（相當於 Sessions）；收藏沿用；Collections 不做（§6.5 範圍外） |

### 1.5 不借用的部分（與理由）

| Outplayed 做法 | 不採用原因 |
|---|---|
| `backdrop-filter: blur(20px)`（約 93 處） | 低階 PC 的合成成本高（§6 效能）；改用不透明 `--bg-popover` |
| 品牌 logo、`images/`（`empty-state`、`editor/watermark.png`、`onboarding`、`christmas` 等）、`gameslist.json`、`icon*.png` | 專有素材，不可複製。Mock 的 logo、空狀態、圖示皆自行繪製 |
| 促銷／廣告欄位（`--promotions-main-height`、`full-overlay-ad`）、社群分享（`--social-color`）、雲端上傳 | 非本專案範圍（§6.5：第一版不做上傳分享） |
| 遊戲偵測與錄影 UI | 本專案處理既有影片 |
| Hover 時預覽縮圖播放 | 增加解碼與記憶體負擔，低階 PC 不划算（可日後在「低效能模式」關閉的前提下加入） |

圖示：mock 使用自行繪製的簡單 SVG 路徑；正式實作改用 **lucide-react**（ISC 授權，與 MIT 相容），事件字形（準星、加號、骷髏、星芒）由 lucide 對應圖示取代，幾何與 mock 相同。

---

## 2. 資訊架構與流程

### 2.1 畫面清單

```
┌──────────┬──────────────────────────────────────────────────────┐
│ 圖示欄   │ 主區                                                 │
│ (56 px)  │                                                      │
│  Logo    │  ① 影片庫  ──點卡片──▶  ② 工作室  ──匯出──▶ 匯出抽屜 │
│  影片庫  │      │                   │  ├ 播放器（來源／專案）   │
│  工作室  │      │                   │  ├ 時間軸塢（來源軌＋專案軌）│
│  ……      │      │                   │  └ 側欄：精華｜事件        │
│  分析佇列│      └ 佇列浮層          │      浮層：AI 自動剪輯、新增事件│
│  快捷鍵  │                          │                              │
│  設定 ③  │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

| 編號 | 畫面／元件 | 說明 |
|---|---|---|
| ① | 影片庫 | 日期分組的大縮圖卡片網格、搜尋與篩選、匯入、監看資料夾狀態、分析佇列條 |
| ② | 工作室 | 取代舊「檢視器」＋「剪輯專案」。單一畫面完成審閱精華、手動修正、剪輯、排序、送出匯出 |
| ② a | 匯出抽屜 | 取代舊 `ExportDialog` 彈窗；右側滑出，可看到專案軌 |
| ② b | AI 自動剪輯浮層 | 取代舊 `AutoClipDialog` 全螢幕遮罩；錨定在頂欄按鈕下方，參數即時預覽「預計產生 N 段」 |
| ② c | 新增事件對話框 | `M` 開啟 |
| ② d | OpenH264 同意對話框 | 保留授權同意流程（spec §6.4、§11） |
| ③ | 設定 | 新畫面：監看資料夾、解碼、快取位置、代理檔、預設秒數、匯出預設、授權 |
| — | 分析佇列浮層、快捷鍵說明（`?`）、Toast | 全域 |

導覽：圖示欄的「工作室」若尚未開啟影片，會回到最近一次的影片（無則灰階提示）；徽章顯示專案內片段數。**專案是全域的**（跨影片），工作室只是檢視它的地方。

### 2.2 端到端流程（改版後）

```
匯入        分析（背景）       審閱精華            微調             匯出
拖放/資料夾 → 佇列一次一支 → 完成後開啟即見建議框 → 拖把手/[ ]/±0.5 → 抽屜選模式與品質
監看資料夾    環形進度          清單聚焦+Enter/Del     專案軌排序/分割     進度→完成/失敗
            （分析中不可開啟）  事件分頁校正誤判       Ctrl+Z/Y；專案自動儲存
```

1. **匯入**：拖放、「匯入影片／資料夾」、或監看資料夾自動匯入。非 Chromium 可播放或沒有硬體解碼者在卡片上直接標示「AV1 · 建議代理檔」（取代舊版匯入時才跳提示）。
2. **分析**：新影片自動排入佇列（一次一支，spec §6.1）。進度顯示在三處：卡片縮圖覆蓋層、影片庫頂的佇列條、圖示欄環形進度（任何畫面都看得到）。**v1 在分析完成前不能開啟該影片**（點擊時提示「分析完成後才能開啟」）；「分析中即可檢視已分析範圍」需要引擎與快取增量輸出，列為 v2。
3. **審閱精華**：點開卡片。若分析已完成，工作室以預設參數（n=3、gap=20、before=8、after=4、max_len=90）執行一次自動剪輯，**只放上虛線「建議框」**，不會自動加入專案（與 spec §2「AI 只框出，由使用者確認」一致）。側欄「精華」分頁列出每段的大縮圖卡片，可預覽、加入、略過；第一張卡片自動對焦，`Enter` 加入、`Delete` 略過、`Ctrl+→` 到下一個。
4. **校正**：誤判在「事件」分頁處理：刪除（可復原）、計入三態、新增事件（`M`）。每次修正重跑推導並重新整理建議（僅影響仍是「建議」狀態的框，已加入的片段不被動）。
5. **微調**：直接在來源軌拖曳建議框／片段框兩端（或播放頭 + `[` `]`），或在專案軌選取片段後用 ±0.5 s 微調。專案軌上拖曳重排、`Ctrl+Q`（專案模式）分割、`Ctrl+D` 複製、`Delete` 刪除。
6. **匯出**：頂欄「匯出 (N)」開抽屜；選模式（合輯／各一檔）、品質（快速無損／精準重新編碼）、編碼器、輸出資料夾與檔名；進行中顯示百分比與目前片段；完成列出檔案；失敗顯示 ffmpeg stderr 摘要與重試。

### 2.3 與 spec §6 的差異及理由

| # | spec §6 / 現況 | 改版 | 為什麼 |
|---|---|---|---|
| **1（最大）** | 檢視器與剪輯專案是兩頁；`Ctrl+E` 把片段「傳送」後強制換頁（`App.tsx` 的 `setView('editor')`），要回頭補片段得再返回影片庫重進檢視器 | **合併為工作室**；`Ctrl+E` 只是加入專案並顯示 Toast，專案軌常駐在時間軸下 | 使用者的核心動作是「看事件 → 取片段 → 微調 → 再看下一個」，來回換頁打斷節奏；來源與專案並列也讓微調時看得到前後文 |
| **2** | 事件清單是主要審閱介面；AI 自動剪輯需手動開對話框、參數靠猜，結果在另一個分頁 | **精華優先**：開啟即預放建議；大縮圖卡片＋加入／略過；事件清單退為校正用分頁；AI 參數浮層**即時預覽「預計 N 段」** | 使用者想要的是「有哪幾段值得留」，不是 200 筆事件；即時預覽取代試錯 |
| **3** | 分析進度只在卡片上；影片庫是平面格狀 | **分析背景化**：全域佇列、圖示欄進度、監看資料夾設定；影片庫依日期分組並虛擬化。（v1 維持「完成後才能開啟」；分析中檢視為 v2） | 100 分鐘長片的分析可能很久（spec §1 記錄實測倍速），使用者應能繼續操作其他影片；數百支影片時需分組與虛擬化 |
| 4 | 匯出為置中彈窗，`alert()` 回報錯誤 | 右側抽屜；錯誤以頁內 notice／Toast；失敗時 stderr 摘要可複製 | 彈窗遮住專案；`alert()` 阻塞且無法複製 |
| 5 | 色碼與樣式內嵌於各 TSX | design token＋CSS 檔 | 一致性、hover 不再靠 JS 事件、低階 PC 少一堆 inline style 計算 |
| 6 | 事件只以顏色區分（5 色） | 顏色＋形狀＋字形；不計入＝空心環＋40% 透明 | 色盲友善；時間軸縮小時仍可辨識 |

---

## 3. 各畫面規格

通用規則：繁體中文介面；所有可點目標至少 26 px 高（密集區）、主要按鈕 32 px；所有動作有鍵盤路徑；浮層以 `Esc` 關閉；錯誤訊息一律說明原因與下一步。

### 3.1 影片庫

**版面**（mock：`#library`）

```
┌ 頂欄 ───────────────────────────────  [匯入資料夾] [＋匯入影片] ┐
│ 搜尋 Ctrl F │ 全部 7 │ ★收藏 │ 含擊倒 │ 含助攻 │ 有精華(新)   ● 監看中：… 管理 │  ← 黏性工具列
│ ◯ 正在分析 1/3  檔名  ━━━━━━  42% · 約剩 6 分                檢視佇列 ⌄ │  ← 佇列條（有佇列時）
│ 昨天  1 支影片                                                       │
│ ┌─────┐ ┌─────┐ …   16:9 縮圖卡片，4–5 欄（≥280 px）              │
│ 2026 年 7 月 13 日  4 支影片                                         │
│ ……                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**卡片**（`LibraryEntry` 欄位全用上）：16:9 縮圖（`entry.thumb`，缺圖時以深色佔位）；右下長度徽章；左下事件計數徽章（`counts.knock`、`counts.assist` 加事件圖示）與「N 精華」；右上收藏星（hover 顯示、已收藏常駐）；左上「AV1 · 建議代理檔」（由 `media/playability` 判定）；下方檔名（省略）、日期時間、解析度、編碼；hover 顯示「⋯」選單（重新分析、產生代理檔、移除）。

**狀態**

| 狀態 | 呈現 |
|---|---|
| 空（無任何影片） | 置中虛線投放區：大圖示、「把 Apex 錄影拖進來」、三步驟說明（匯入→自動分析→挑選匯出）、〔匯入影片〕〔設定監看資料夾〕 |
| 篩選後無結果 | 「沒有符合條件的影片」＋調整建議 |
| 拖曳中 | 整頁紅色虛線覆蓋層「放開滑鼠以匯入影片」（沿用現行文案精神） |
| `pending` | 縮圖加暗層「等待分析・排在佇列第 N 位」 |
| `analyzing` | 縮圖暗層顯示百分比與剩餘時間估計（由 `progress` 與已耗時推算）、底部 3 px 進度條；點擊顯示 Toast「分析完成後才能開啟」（v1） |
| `done` | 事件計數、精華數徽章，可點開 |
| `error` | 紅框卡片、灰階縮圖、警示圖示、**原因文字**（`entry.error`）、〔重試〕（`queue.enqueue`）〔從影片庫移除〕；不可開啟 |
| 非可播放／無硬體解碼 | 左上黃色徽章；開啟後工作室頂端出現代理檔建議 banner |

**快捷鍵**：`Ctrl+F` 搜尋、`Esc` 清除搜尋、`Ctrl+D` 切換「只看收藏」（現況行為；卡片聚焦時 = 收藏該片為新增）、`Enter` 開啟聚焦卡片、方向鍵移動焦點（網格 roving tabindex，§3.9）、`Delete` 從影片庫移除（需確認對話框）。卡片「⋯」與收藏星在 `:focus-within` 時也會顯示（鍵盤可達）。

**分析佇列浮層**（圖示欄環形按鈕或佇列條開啟）：列出「分析中／等待」影片、百分比、取消（`queue.cancel`）；標明「一次分析一支」。

### 3.2 工作室

**版面**（mock：`#studio`；1440×900 下的實際比例）

```
┌ 頂欄：← 檔名／解析度·編碼·長度  [分析完成]      [AI 自動剪輯⌄] [快速剪輯 Ctrl Q] [匯出(3)] [側欄] ┐
├ notice（可選：分析中／分析失敗／代理檔建議）                                    ┤
│ ┌ 播放器 stage（16:9，黑底，圓角10）───────────────────────┐ ┌ 側欄 380 ──────┐
│ │ [來源·17-17-13]              [近90秒計入 1]           │ │ 精華(4) │ 事件(19)│
│ │                    （事件字樣預覽疊圖）               │ │ 2 項待確認  Enter/Del│
│ └──────────────────────────────────────────────────────┘ │ ┌大縮圖卡片┐      │
│ ▶ ⏮ ⏭  0:50 / 13:42  1×   [擊倒9][助攻擊倒3][助攻消滅3][已消滅2][小隊抹殺2] [＋事件 M] │ │ 4 殺精華 0:42–1:22│
├ 時間軸塢 ─────────────────────────────────────────────────  │ │ ●●●●●● 加入專案  │
│ 來源 │ 尺標／事件圖示（三列防重疊）／熱度條／觀戰斜線／片段框      [−][1×][+] │ └──────────┘      │
├──────┼──────────────────────────────────────────────────────  │ 專案已有3段·1:29  [全部加入專案 Ctrl E]
│ 專案 │ 名稱 3段·1:29·2支影片  #1 [−0:42.0+]→[−1:22.2+] ✂ ⧉ 🗑 ↶ ↷ 開啟 儲存 │
│      │ [#1 4殺精華][#2 3殺精華][#3 快速剪輯][＋從來源加入]                   │
└──────┴──────────────────────────────────────────────────────  └────────────────┘
```

#### 3.2.1 播放器

- `<video>` 來源：有代理檔用代理檔，否則原檔（`proxy.get`，沿用現行行為）；匯出永遠用原檔。
- 左上「模式膠囊」：**來源 · 檔名片段** 或 **專案 · 片段 2/3 · 標籤**。點專案軌的片段 → 專案模式（載入該片段的 `source`，在 `[start,end]` 內播放，結尾自動接下一片段，與現行 Editor 的 `handleTimeUpdate` 邏輯相同）；點來源軌或事件 → 回來源模式。
- 觀戰中顯示黃色「觀戰中」膠囊；右上顯示近 90 秒（對應 dedupe 視窗）計入數（資訊用）。
- 事件字樣預覽：mock 以真實截圖疊在示意畫面上；**實作中不需要**（真實影片自有畫面）。
- 底部傳輸列：播放（36 px 紅色圓鈕）、上／下一精華、時間、速度（循環 1×/0.5×/0.25×/2×，沿用 `S`）、事件類型篩選 chip（含各類計數）、「＋事件 M」。

#### 3.2.2 時間軸塢

**來源軌（Canvas）** — 高 132 px（1366×768 時 112 px）：尺標 0–21 px；**標籤列** 22–38 px（片段標籤獨立一行，不被圖示壓住）；事件／框區 38–126 px；熱度條貼底。

| 圖層（由下至上） | 說明 |
|---|---|
| 尺標 | 依縮放選刻度（1/2/5/10/15/30/60/120/300/600/900/1800 s），標時間 |
| 觀戰區間 | `spectating[]`：灰底＋45° 斜線＋「觀戰（不計入）」（寬 >90 px 才顯示字） |
| 熱度條 | 計入事件密度；**藍灰色**（`--tl-heat`），不使用品牌紅；每 4–6 px 一格 |
| 片段框 | 建議＝白色虛線＋淡白底；已加入／手動＝白色 2 px 實線＋較濃白底＋「✓」標籤；標籤在框上緣獨立一行；框寬 <12 px（縮小檢視）時改畫成實心窄條（不畫虛線，避免雜訊）；把手（6 px 寬、命中區 ±7 px）**只在 hover、選取或目前精華時顯示** |
| 事件 | 依「密度規則」呈現（見下） |
| 播放頭 | DOM 元素＋`transform` 移動（不重繪 canvas） |

**密度規則（以像素密度決定，不以事件總數）**——解決 2 小時影片約 300 事件、時間軸寬 ~1400 px（平均每事件 ~5 px）時圖示疊成一團的問題。設 `W` 為軌寬、`n` 為目前可視範圍內通過類型篩選的事件數：

1. **密度檢視**：`W / n < 8 px`。不畫個別圖示；改畫「熱度條（高度可達 46 px）＋ 2 px 寬、10 px 高的類型色刻度（不計入者 65% 不透明）＋ 建議框／片段框」，左上提示「密度檢視 · N 個事件 · 放大顯示個別圖示」。hover 顯示該 ±6 px 內的事件數與時間；此模式不能個別選取事件（需先放大或框選）。
2. **群集檢視**：`W / n ≥ 8 px`，但相鄰事件圖示中心距 <22 px：以貪婪法由左至右合併，合併後畫「×N」膠囊（白框，下方 2 px 小條表示計入比例）；點擊群集＝放大到該群集（區間 ×3，最小 20 s），**不是 seek**。
3. **圖示檢視**：其餘單一事件畫 22 px 形狀＋字形（§5.2）。
4. 閾值常數 `MIN_PX_PER_EVENT = 8`、`CLUSTER_PX = 22` 放在 `timeline/layout.ts`，純函式 `layoutTimeline(events, view, filter) → { mode, items }`（vitest 以 300／2000／6000 事件樣本測試，耗時 < 5 ms）。
5. 驗收樣本：mock 的「300 事件」資料集（`#studio-long`、`#zoomed`）；截圖 `screens/10`、`11`、`12`。

**互動模型**

| 操作 | 行為 |
|---|---|
| 單擊空白處 | **只 seek**（跳轉到該時間） |
| 單擊事件圖示 | **只 seek**（跳到事件前 8 s），不再同時勾選 |
| `Shift`／`Ctrl` + 單擊事件 | 切換該事件的選取狀態 |
| 單擊群集膠囊 | 放大到群集 |
| 拖曳空白處 | **框選**時間範圍內（通過類型篩選）的事件，完成後 Toast「框選了 N 個事件」＋〔建立合輯〕；加 `Shift`／`Ctrl` 為加選 |
| `Space` + 拖曳、滑鼠中鍵拖曳 | **平移**時間軸（按住 `Space` 時游標變手形；`Space` 同時為播放／暫停，僅在按住 >200 ms 且有拖曳時視為平移，不觸發播放） |
| 滾輪 | 已放大時＝平移；`Ctrl`＋滾輪＝以游標處為錨點縮放 |
| 拖曳片段框把手 | 調整起訖（`resizeClip`），放開後 Toast〔復原〕 |
| 鍵盤（時間軸聚焦） | `←／→` ±5 s、`Ctrl+←／→` 上／下個事件、`Ctrl +／−／0` 縮放 |

hover tooltip 與鍵盤聚焦（`Tab` 到時間軸後以 `Ctrl+←／→` 逐一移動）時的 `aria-live` 播報都包含「類型、時間、計入與原因」，供鍵盤與螢幕閱讀器使用（§3.9）。

**專案軌（DOM）**

- 每個片段是一張按時長比例（6 px/秒，最小 92 px、最大 360 px）的小縮圖卡：序號、標籤、長度；選取＝紅框；目前播放＝白內框＋進度條；兩端把手可拖（`trimItem`）。
- 軌頭：專案名稱（可編輯）、片段數／總長／來源影片數、**選取片段檢視器**（起／終點 ±0.5 s 步進，對應舊 `+S -S -E +E` 四顆小按鈕）、分割、複製、刪除、復原、重做、開啟、儲存（`.apexproj.json`）。
- 軌尾「＋從來源加入」虛線格＝加入下一個待確認建議。
- 可收合（高度 92 → 34 px，軌頭仍可見）；**`max-height: 800px` 的視窗（如 1366×768）預設收合**（使用者已同意），使用者展開後的偏好記在設定。窄寬（<1500 px）時軌頭隱藏「來自 N 支影片」與「已自動儲存」文字（只留綠點）。
- 每個片段右上角有**來源影片色點＋字母**（A／B／C，tooltip 顯示檔名片段），讓跨影片專案一眼可辨。
- 軌頭：**新專案**、**開啟檔案**、**另存檔案**（專案本身自動儲存，見 §3.7）。

#### 3.2.3 側欄

**「精華」分頁**（預設）：每段一張**精簡卡片**（預設）——左側 128×84 縮圖（首個計入事件的畫面、左上斜切角「AI 建議／AI 精華／手動」標籤、右下長度），右側標題「N 殺精華」＋起訖時間、事件字形列（不計入者為淡色，超過 12 個顯示 +N）、動作列；1366×768 側欄一屏可見 4–5 張。清單上方有〔精簡｜大圖〕切換（大圖＝16:9 縮圖卡，供看清畫面時使用）。動作依狀態：

| 狀態 | 動作 |
|---|---|
| 建議 | 〔▶〕預覽、〔略過〕、〔＋加入〕（紅色主按鈕） |
| 已加入 | 綠色「已加入」＋〔移出〕 |
| 已略過 | 淡化＋〔復原〕 |

略過與加入都會顯示帶〔復原〕的 Toast（§3.6）。清單聚焦時 `Enter` 加入目前建議、`Delete` 略過、`↑↓` 移動（§3.2.7）。

底欄：「專案已有 N 段 · 總長」＋〔全部加入專案 Ctrl E〕。空狀態：「找不到符合條件的精華」＋〔調整 AI 參數〕＋提示改用事件分頁建立合輯。

**「事件」分頁**：頂部「計入 N　不計入 M」；每列：勾選框、事件圖示、時間（等寬字）、類型名稱＋原因小字（首次／重複敵人／觀戰中／小隊抹殺不計／手動／強制計入／強制不計入）＋是否含傷害行＋信心%；**計入三態分段按鈕**〔自動｜計入｜不計〕（對應 `counted_override: null｜true｜false`，取代舊版循環按鈕，一眼可見目前值）；刪除 ✕（`deleted: true` 軟刪除，Toast「復原」）。篩選以播放器下方的類型 chip 控制（同一個 `filter` 狀態）。底欄：「已選 N 個事件」〔清除〕〔建立合輯 Ctrl M〕。

> 注意：事件資料（`EngineEvent`）**沒有敵人名稱文字**，只有 `name_sig` 指紋，因此 UI 不顯示敵人名。Mock 畫面中的名字只出現在真實截圖內。

#### 3.2.4 頂欄動作

| 按鈕 | 行為 |
|---|---|
| ← | 回影片庫（自動儲存已由 `dirty` 去抖處理） |
| AI 自動剪輯 ⌄ | 開浮層：n（1–10）、gap（5–60）、before（0–30）、after（0–30）、max_len（15–300）— 數字框＋滑桿，下方「預計產生 N 段 · 共 mm:ss」（以 `engine:autoclip` 去抖呼叫，或在 renderer 內以純函式算；見 §7）；〔重設預設值〕〔取消〕〔套用（取代現有建議）〕。套用只取代 `status: 'suggested'` 的 AI 框，保留已加入與手動 |
| 快速剪輯 Ctrl+Q | `createClipAt(t, before, after)` → 直接標記為已加入並進專案軌（現況是只放框；改為與「加入」合併，因為使用者按快速剪輯就是要它） |
| 匯出 (N) | 開匯出抽屜；N＝專案片段數，0 時停用並提示 |
| 側欄切換 | `Ctrl+B` |

#### 3.2.5 匯出抽屜（與側欄同寬 380 px，從頂欄下緣到視窗底，**只覆蓋側欄**）

覆蓋範圍規則（審查發現舊版 420 px 會蓋住頂欄的「AI 自動剪輯／匯出」、播放器右上與專案軌的「開啟／儲存」）：抽屜只佔側欄的位置，頂欄、播放器、時間軸與專案軌全部保持可見；匯出進行中**編輯區鎖定**（專案軌與來源軌不可修改，避免改到正在匯出的內容），`Esc`／✕ 關閉（進行中關閉＝縮小為頂欄的進度徽章，不取消）。

| 狀態 | 內容 |
|---|---|
| 設定 | 摘要三格（片段數／總長／來源影片數）；**相容性 notice**（例：來源參數不一致 → 已自動改用重新編碼，沿用 `fallbackReencodeNotice`）；匯出模式單選卡（串成一支合輯／每段各一檔）；品質單選卡（快速無損：顯示「片段起點平均多出約 X 秒」，不可用時停用並說明；精準重新編碼：編碼器下拉清單由 `export.detectEncoders` 提供）；無硬體編碼器時顯示 OpenH264 區塊與〔下載〕→ 同意對話框；輸出資料夾（`selectOutDir`）、檔名、預估大小與剩餘磁碟空間 |
| 進行中 | 大百分比＋進度條＋「處理片段 2/3（12.4 秒）· 編碼器」；〔取消匯出〕（**新增 `export:cancel` IPC**：終止 ffmpeg 子程序、刪除未完成的輸出檔、保留已完成者） |
| 完成 | 綠色勾、總長／耗時、輸出檔案清單、〔開啟資料夾〕〔完成〕；顯示 `notices` |
| 失敗 | 紅色 notice、ffmpeg stderr 摘要（等寬、可捲動、〔複製錯誤訊息〕）、常見原因、〔重試〕 |

**OpenH264 同意對話框**：說明為何需要、檔案來源 `ciscobinary.openh264.org`、大小、畫質取捨，〔改用快速無損〕〔同意並下載〕（維持 spec §6.4、§11 的授權流程）。

#### 3.2.6 工作室的狀態

| 狀態 | 呈現 |
|---|---|
| 完成（`status:'done'`） | 頂欄綠色「分析完成」；精華建議自動放上 |
| 分析中 | **v1 不開放**（影片庫卡片點擊只顯示 Toast）。v2：頂欄「分析中 N%」＋ info notice＋時間軸「尚未分析」斜帶，需引擎與快取增量輸出 |
| 分析失敗／引擎異常 | 頂部紅色 notice「分析引擎異常結束（代碼）。不會遺失已完成進度」＋〔接續分析〕（spec §5.5）〔複製錯誤訊息〕；時間軸無事件；精華分頁顯示空狀態 |
| 代理檔建議 | 頂部黃色 notice「播放可能不流暢…」＋〔產生代理檔〕（`proxy.generate`，進行中按鈕顯示進度）〔稍後再說〕 |
| 影片缺失／無法播放 | 播放器區顯示錯誤說明與〔重新連結檔案〕／〔返回影片庫〕（現況未處理，新增） |
| 無事件（分析完成但 0 筆） | 精華與事件分頁空狀態：「這支影片沒有偵測到擊倒／助攻。可按 M 手動新增，或到設定確認『遊戲語言』是否與錄影相符」；另有兩種獨立 notice：自動偵測不出語言時「無法判斷錄影語言，請在設定中指定遊戲語言後重新分析」，以及該語言尚無觀戰偵測時「此語言尚不支援觀戰偵測」 |

#### 3.2.7 快捷鍵與焦點模型（工作室）

**焦點區（focus zone）**：工作室有四個可聚焦的清單／軌道——① 來源時間軸 `#tl-wrap`、② 精華清單、③ 事件清單、④ 專案軌；另有按鈕、下拉、數字框、滑桿等**原生控制項**。`Tab` 在區域間移動；區內以方向鍵移動項目（roving tabindex）。滑鼠按下任一區即視為焦點在該區。

**規則**：
1. 焦點在**原生控制項**（`button`、`select`、`input`、`textarea`、`a`、`role=slider`）時，`Enter`、`Space`、方向鍵、`Delete` 保留原生語意，**全域快捷鍵不攔截**（`Ctrl`／`Alt` 組合除外）。
2. `Enter`、`Delete`、`Alt+←/→`、`Ctrl+D` 是**區域鍵**：只在對應清單聚焦時作用（矩陣如下）；其他區按下不動作。
3. 含 `Shift` 的組合必須先於無 `Shift` 的同鍵判斷（`Ctrl+Shift+Z`、`Ctrl+Shift+E` 先於 `Ctrl+Z`、`Ctrl+E`）。
4. 所有刪除／略過／加入／快速剪輯都顯示帶〔復原〕的 Toast（§3.6）；影片庫移除影片需確認對話框。

| 鍵 | 來源時間軸 | 精華清單 | 事件清單 | 專案軌 | 原生控制項聚焦 |
|---|---|---|---|---|---|
| `Space` | 播放／暫停（按住＋拖曳＝平移） | 播放／暫停 | 播放／暫停 | 播放／暫停 | 保留原生（按鈕＝按下） |
| `Enter` | — | **加入**目前建議 | 跳到選取事件 | 播放該片段（進入專案模式） | 保留原生 |
| `Delete` | — | **略過**目前建議 | **刪除**選取事件（軟刪除） | **刪除**選取片段 | 保留原生 |
| `←／→` | ±5 s | — | — | 在片段間移動選取 | 保留原生 |
| `↑／↓` | — | 移動目前建議 | 移動列 | — | 保留原生 |
| `Alt+←／→` | — | — | — | 移動選取片段順序 | 作用 |
| `Ctrl+D` | — | — | — | **複製**選取片段 | 作用 |
| `Ctrl+←／→` | 上／下一個事件 | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl +／−／0`、`Ctrl+滾輪` | 縮放 | 縮放 | 縮放 | 縮放 | 作用（全域） |
| `Ctrl+Q` | 來源模式：快速剪輯（Toast〔復原〕）；專案模式：在播放頭分割 | 同左 | 同左 | 同左 | 作用（全域） |
| `M` | 新增事件 | 同左 | 同左 | 同左 | 保留原生（輸入框） |
| `S` | 切換速度 | 同左 | 同左 | 同左 | 保留原生（輸入框） |
| `[` `]` | 目前片段起／終點＝播放頭 | 同左 | 同左 | 同左 | 保留原生（輸入框） |
| `Ctrl+M` | 選取事件建立合輯 | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl+E` | 加入專案（全部建議） | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl+Z`／`Ctrl+Y`／`Ctrl+Shift+Z` | 復原／重做／重做 | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl+S` | 另存專案檔 | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl+Shift+E` | 開匯出抽屜 | 同左 | 同左 | 同左 | 作用（全域） |
| `Ctrl+B` | 顯示／隱藏側欄 | 同左 | 同左 | 同左 | 作用（全域） |
| `Esc` | 專案模式：返回來源；否則關閉浮層／抽屜／清除選取 | 同左 | 同左 | 同左 | 關閉浮層 |
| `?` | 快捷鍵說明 | 同左 | 同左 | 同左 | 保留原生（輸入框） |

輸入框（專案名稱、數字框、搜尋）取得焦點時一律不攔截無修飾鍵。快捷鍵說明（`?`）以同一份常數表產生，避免文件與行為不一致（plan 3 Task 3 以測試鎖定矩陣）。

### 3.3 設定（兩欄式，3 個分類）

**版面**（mock：`#settings`；截圖 `06-settings.png`（1920×1080）、`07-settings-1366x768.png`）

```
┌ 頂欄：設定 ───────────────────────────────────────────────────────────┐
│          ┌ 分類 200 ┐ ┌ [搜尋設定                         Ctrl F] ┐          │
│  （留白）│▌影片與分析│ │ ┌ 影片來源 ──────────────────────┐ │（留白）  │
│          │ 預覽與剪輯│ │ │ 監看資料夾 …           [新增資料夾]│ │          │
│          │ 匯出與關於│ │ │ 新影片自動分析            ( 開關 ) │ │          │
│          └──────────┘ │ └──────────────────────────────┘ │          │
│  分類欄＋內容欄（≤720 px）為「一組」，整組水平置中            └──────────┘          │
└───────────────────────────────────────────────────────────────────────┘
```

- **分類（3 個，每類 ≥4 列，原 6 類中不足 3 列者合併）**：
  1. **影片與分析**：影片來源（監看資料夾、新影片自動分析）＋分析與效能（解碼方式、快取位置、低效能模式）＝5 列
  2. **預覽與剪輯**：預覽與代理檔（建議代理檔、佔用空間與刪除）＋剪輯預設值（事件前後秒數、AI 預設參數、自動產生建議、專案自動儲存）＝6 列
  3. **匯出與關於**：匯出（預設資料夾、編碼器偵測、OpenH264 狀態）＋關於（版本與授權、商標聲明）＝5 列
- **置中**：分類欄（200 px）＋內容欄（最寬 720 px）作為一組水平置中；1920 寬時左右各留白，不拉伸控制項；內容欄捲動不影響分類欄。
- **搜尋**在內容欄頂端（靠近結果）；`Ctrl+F` 在設定頁聚焦搜尋；跨分類即時過濾，有搜尋字串時列出所有含命中列的卡片（只顯示命中列），分類旁顯示命中數；無命中顯示「沒有符合的設定」。
- **分類欄為 `role=tablist`**（`aria-orientation=vertical`），方向鍵移動並切換、roving tabindex。
- **窄視窗**（<900 px）：分類欄收合為頂部橫向分段列（可橫向捲動，選中項底部 3 px 紅線）；1366×768 全螢幕仍為兩欄。
- 所有設定列皆保留（原 6 類 13 列＋新增「專案自動儲存」、「OpenH264 狀態」、「商標聲明」分列）。**UI 不再顯示「需新增 IPC」等開發註記**：實作期間尚未接上的列以停用狀態＋灰色說明文字呈現（例如「此功能將在後續更新提供」），正式版不應有此狀態。「新」標籤保留於相對於舊版新增的設定。
- 設定儲存見 plan 3（`settings.json`，含預設值與舊版遷移）。

### 3.4 全域元件

- **圖示欄**：Logo、影片庫、工作室（徽章＝專案片段數）、（彈性空間）、分析佇列（環形進度）、快捷鍵、設定。選取項左側 3 px 紅色指示條。
- **Toast**：左下堆疊，4 秒自動消失；可帶〔復原〕動作（刪除事件、略過精華）。取代所有 `alert()`。
- **對焦**：所有可互動元件 `:focus-visible` 顯示 `--focus-ring`。

### 3.5 模式與膠囊（來源 vs 專案）

- 工作室永遠處於兩種模式之一：**來源模式**（播放目前開啟影片，時間軸操作它）與**專案模式**（依序預覽專案片段）。
- **模式膠囊**（播放器左上，30 px 高）：來源＝深底白字「來源 · 檔名片段」；專案＝**白底黑字**「專案預覽 · 片段 2/3 · 標籤」，與背景形成強烈對比。
- 專案模式時，播放器上方出現**白色脈絡橫幅**：「正在預覽專案片段 #2「3 殺精華」，來源影片 17-33-52（不是目前開啟的影片，來源軌與側欄暫時停用）〔返回來源 Esc〕」；來源軌灰化（40%）。若該片段的來源影片≠目前開啟的影片，側欄（精華／事件）同時灰化並不可操作；來源軌**不切換影片**（使用者已同意此行為）。
- 頂欄按鈕文字隨模式改變：來源＝「快速剪輯 Ctrl Q」，專案＝「分割 Ctrl Q」。
- 在來源模式誤按 `Ctrl+Q` 會建立片段並加入專案，Toast 顯示〔復原〕（§3.6）。
- 切換規則：點專案軌片段、`Enter`（專案軌聚焦）→ 專案模式；點來源軌、點事件、點精華卡縮圖、`Esc`、〔返回來源〕→ 來源模式。專案模式播到最後一段結束時停在最後一格，不自動回來源。

### 3.6 Toast 與復原規則

| 動作 | Toast | 復原範圍 |
|---|---|---|
| 加入專案（單張／全部／快速剪輯／合輯） | 「已加入專案（40 秒）」〔復原〕 | 移出該次加入的片段，建議回到「建議」狀態 |
| 略過建議 | 「已略過這段建議」〔復原〕 | 回到「建議」 |
| 刪除事件（單筆／批次） | 「已刪除 N 個事件」〔復原〕 | 取消 `deleted` 旗標 |
| 刪除專案片段 | 「已刪除專案片段」〔復原〕 | 等同 `Ctrl+Z`（專案 History） |
| 調整片段框 | 「片段範圍已調整」〔復原〕 | 還原該次拖曳前的起訖 |
| 計入三態切換 | 「已重新推導計入結果」（無復原；三態可再按一次切回） | — |
| 儲存／另存 | 「已另存為 …」 | — |

規則：Toast 左下堆疊、最多同時 3 則；含〔復原〕者停留 6 秒，其餘 3.8 秒；滑鼠停留時暫停計時；`Ctrl+Z` 對應專案操作，Toast 〔復原〕對應該次操作（兩者不互相覆蓋）；Toast 容器為 `role=status`（`aria-live=polite`）。

### 3.7 專案持久化

- **自動儲存**：專案（`Project`）每次變更後去抖 500 ms 寫入 `%APPDATA%\ApexHighlighter\projects\<projectId>.apexproj.json`（原子寫入：先寫暫存檔再改名）；軌頭顯示「已自動儲存」（寫入中顯示黃點＋「儲存中…」）。
- **啟動還原**：啟動時還原最近一個專案（`settings.lastProjectId`）；若檔案損毀則保留為 `.bak` 並建立空專案，顯示 notice。
- **新專案**：軌頭〔新專案〕。目前專案有片段時開確認對話框：「目前專案已自動儲存，之後可從「開啟檔案」找回」〔取消〕〔另存檔案後新增〕〔直接新增〕。專案清單（開啟檔案對話框的預設位置為 `projects\` 資料夾）。
- **另存檔案／開啟檔案**：`.apexproj.json` 只用於分享與備份，不是主要儲存途徑；開啟他人檔案時若來源影片路徑不存在，片段顯示「來源遺失」警示且不可預覽／匯出（匯出前列出缺少的來源並阻擋）。
- **未儲存提示**：因為自動儲存，不會有「未儲存」關閉提示；唯一需要確認的是「新專案」與「刪除專案」。
- 設定中可關閉自動儲存（關閉後恢復「未儲存變更」提示行為）。

### 3.8 無障礙需求（至少）

- **鍵盤全可達**：所有功能有鍵盤路徑；`Tab` 順序＝視覺順序；焦點環 `--focus-ring`（2 px 白）在所有互動元件顯示；影片庫網格、精華清單、事件清單、專案軌、設定分類皆為 roving tabindex。
- **ARIA**：圖示欄按鈕 `aria-label`；分頁 `role=tablist/tab`＋`aria-selected`；清單 `role=list/listitem`＋`aria-label`（事件列含「類型、時間、計入與原因」）；專案片段含序號、標籤、長度；Toast `role=status`；對話框 `role=dialog`＋`aria-modal`＋焦點陷阱，關閉後焦點回到觸發元素；篩選 chip 用 `aria-pressed`。
- **目標大小**：互動元素最小 26×26 px（密集區）／32 px（主要按鈕），較小圖示以透明 padding 擴大命中區；步進鈕 26 px；收藏星 30 px。
- **不只靠顏色**：事件類型＝形狀＋字形＋顏色；不計入＝淡色＋原因文字（列表與 tooltip，鍵盤聚焦時也顯示）；狀態徽章帶文字。
- **對比**：見 §5.1（含各表面層組合）；`prefers-reduced-motion` 時關閉動畫。
- **即時 tooltip**：圖示欄無文字標籤，改以 CSS 即時 tooltip（`data-tip`，hover／`focus-visible` 即顯示，無 1 秒延遲）＋`aria-label`；不採用常駐文字標籤（維持 56 px 窄欄）。

### 3.9 繁中排版（CJK Typography）

- **行高**：中文內文 `--lh-body: 1.5`；標題與按鈕 `--lh-tight: 1.35`；不使用小於 1.3 的行高（避免中文筆畫貼行）。
- **字重一致性**：Montserrat／Lato 沒有 CJK 字形，粗體英數會與備援字型的中文字重不一致。規則：**標題與按鈕文字一律用 `--font-ui` 的 700**（Lato Bold＋微軟正黑體 Bold，字重相近）；`--font-display`（Montserrat）只用於**純拉丁字母／數字**的元素（大數字、時間碼標題、空狀態的英文品牌字），中英混排的標題不使用 display 字型。
- **字距**：中文不加 `letter-spacing`（全域 `letter-spacing: 0`）；全大寫拉丁小標可加 0.4 px。
- **等寬字**：時間碼、數字用 `--font-mono`（Cascadia Mono／Consolas，`tabular-nums`）；中文備援不得出現在等寬欄位（欄位只放數字與 `:`）。
- **斷行**：`word-break: normal; overflow-wrap: anywhere` 僅用於檔名；其餘中文以預設斷行；檔名單行省略（`text-overflow: ellipsis`），title 顯示全名。
- **字型打包**：Lato（Regular／Bold）、Montserrat（Bold／Black，只含拉丁與數字子集）以 woff2 隨程式打包（OFL，附授權文字於 `THIRD_PARTY_NOTICES.md`）；中文使用系統字型 `Microsoft JhengHei UI`／`Noto Sans TC`（不打包，約 8 MB/字重）；`font-display: swap`、`font-synthesis: none`。

---

## 4. 功能對照表（舊功能 → 新位置）

「來源」欄為現況程式位置。沒有任何功能被悄悄移除；改變互動方式者在「說明」欄交代。

| # | 舊功能（來源） | 新位置 | 說明 |
|---|---|---|---|
| **影片庫** | | | |
| 1 | 匯入影片（`library.selectFiles`，Library） | 影片庫頂欄主按鈕；空狀態按鈕 | 不變 |
| 2 | 選擇資料夾（`library.selectFolder`） | 頂欄次按鈕；空狀態 | 不變 |
| 3 | 拖放匯入（`library.add`） | 影片庫整頁投放區＋覆蓋層 | 不變 |
| 4 | 設定監看資料夾（i18n 有字串，`main/library.watchFolder` 已實作，**preload 未暴露**） | 設定 › 影片來源；影片庫「監看中」chip | 需新增 IPC（§7.4）；現況 UI 其實沒有此按鈕 |
| 5 | 搜尋 `Ctrl+F` | 工具列搜尋框，`Esc` 清除 | 加 Esc |
| 6 | 只看收藏 `Ctrl+D`、`toggleFavorite` | 「收藏」chip；卡片星形按鈕 | 卡片上多一個收藏入口 |
| 7 | 事件篩選（全部／含擊倒／含助攻） | 同名 chip（加事件圖示） | 另增「有精華」chip（需分析結束時把預設參數的精華數寫入快取，§7.4） |
| 8 | 卡片：縮圖、長度、擊倒／助攻徽章 | 卡片（大縮圖＋徽章） | 視覺放大 |
| 9 | 分析狀態 pending／analyzing／done／error＋進度 | 卡片覆蓋層、佇列條、圖示欄環形進度 | 新增剩餘時間估計；v1 分析完成才可開啟 |
| 10 | 重試（`queue.enqueue`） | 錯誤卡片〔重試〕、卡片選單「重新分析」 | 不變 |
| 11 | 取消分析（`queue.cancel`） | 佇列浮層〔取消〕 | 現況 UI 無取消入口，新增 |
| 12 | 移除（`library.remove`） | 卡片 ⋯ 選單、錯誤卡片 | 不變 |
| 13 | 匯入時代理檔提示／`mediaCapabilities` 建議（spec §6.1） | 卡片黃色徽章＋工作室 banner | 由「匯入時才跳」改為常駐可見 |
| 14 | 頂端「進入剪輯專案 (n) →」（App.tsx） | 圖示欄「工作室」＋徽章；頂欄「匯出 (N)」 | 因頁面合併而移除（理由見 §2.3 #1） |
| **檢視器** | | | |
| 15 | `<video>` 播放（含代理檔來源） | 工作室播放器 | 不變 |
| 16 | Canvas 時間軸：事件標記、觀戰灰底、熱度條、片段框 | 來源軌 | 標記加形狀與字形；觀戰加斜線；新增未分析斜帶 |
| 17 | 縮放 `Ctrl +/−/0` | 同＋按鈕＋`Ctrl+滾輪` | 加強 |
| 18 | 事件類型篩選（`EventTypeFilter`） | 播放器下方 chip（含計數） | 位置移到時間軸旁，使篩選與時間軸同屏 |
| 19 | 事件清單（勾選、時間、徽章、傷害行、信心／手動） | 側欄「事件」分頁 | 不變；原因小字更明確 |
| 20 | 點標記／列 → 跳事件前 8 秒 | 同 | 不變 |
| 21 | 上／下一事件 `Ctrl+←/→` | 同＋傳輸列按鈕 | 不變 |
| 22 | 速度 `S` | 同 | 不變 |
| 23 | 播放／暫停 `Space` | 同＋大播放鍵 | 不變 |
| 24 | 快速剪輯 `Ctrl+Q`（只放框） | 頂欄按鈕／同快捷鍵 | 改為直接加入專案（使用者意圖）；框仍顯示於時間軸 |
| 25 | 新增事件 `M`（含類型單選） | 同對話框（顯示時間、Enter 確認） | 不變 |
| 26 | 計入三態（`counted_override`，循環小按鈕） | 每列分段按鈕〔自動｜計入｜不計〕 | 由循環改為直選，語意相同 |
| 27 | 刪除事件（軟刪除 `deleted`） | 列尾 ✕＋Toast「復原」 | 新增復原 |
| 28 | 選取事件 → 建立合輯（`supercut`） | 事件分頁底欄／`Ctrl+M` | 加快捷鍵；合併重疊仍用 `mergeOverlapping` |
| 29 | AI 自動剪輯對話框（gap／n／before／after／max_len） | 頂欄浮層（五參數＋即時預覽） | 浮層取代對話框；開啟影片時自動以預設值先跑一次 |
| 30 | 片段清單分頁（播放／移除） | 「精華」分頁卡片（預覽／略過／移出） | 分頁合併進精華卡片；手動片段同列 |
| 31 | 拖曳片段框兩端（`resizeClip`） | 來源軌把手；`[` `]` | 加鍵盤路徑 |
| 32 | 傳送至專案 `Ctrl+E`（並換頁） | 〔加入專案〕／〔全部加入專案〕／`Ctrl+E`（不換頁） | 移除換頁副作用（§2.3 #1） |
| 33 | 代理檔建議 banner／產生（`proxy.generate`） | 工作室頂部 notice；設定 › 預覽與代理檔（刪除） | 新增刪除入口（`proxy.delete` 已存在） |
| 34 | 返回影片庫 | 頂欄 ←、圖示欄 | 不變 |
| 35 | 自動儲存（`dirty` 去抖 → `cache.save`） | 不變（可加「已儲存」小提示） | — |
| 36 | `cache.load`／`engine.analyze` 開啟時載入 | 不變 | — |
| **剪輯專案** | | | |
| 37 | 專案預覽播放（依序、結尾自動接下一片） | 播放器「專案模式」 | 與來源共用同一播放器 |
| 38 | 專案名稱編輯 | 專案軌頭輸入框 | 不變 |
| 39 | 分割（`splitItem`，按鈕「在此處分割」） | 軌頭 ✂ 按鈕；專案模式 `Ctrl+Q` | 加快捷鍵 |
| 40 | 刪除／複製（`removeItem`／`duplicateItem`） | 軌頭按鈕；`Delete`／`Ctrl+D` | 加快捷鍵 |
| 41 | 排序 ◀ ▶（`moveItem`） | 拖曳重排；`Alt+←/→` | **按鈕移除**：拖曳是更直覺的操作，鍵盤路徑由 Alt+方向鍵提供，無功能損失 |
| 42 | 微調起訖 ±0.5 s（`trimItem` 四顆小按鈕） | 選取片段檢視器步進鈕＋片段兩端把手拖曳 | 保留步進、新增拖曳 |
| 43 | 復原／重做（`History`，`Ctrl+Z/Y`） | 軌頭按鈕＋快捷鍵（加 `Ctrl+Shift+Z`） | 不變 |
| 44 | 儲存／開啟專案（`project.*`，`.apexproj.json`） | 軌頭〔儲存〕〔開啟〕；`Ctrl+S` | 加快捷鍵 |
| 45 | 專案內總長、片段數顯示 | 軌頭資訊＋圖示欄徽章＋匯出按鈕 | 不變 |
| **匯出** | | | |
| 46 | 模式：每段各一檔／串成合輯 | 抽屜單選卡 | 不變 |
| 47 | 品質：快速無損／精準重新編碼 | 抽屜單選卡 | 不變 |
| 48 | 「多出約 X 秒」提示、來源不一致改重新編碼提示 | 抽屜 notice | 不變 |
| 49 | 編碼器偵測與選擇、OpenH264 狀態與下載（`export.*`） | 抽屜編碼器下拉＋OpenH264 同意對話框 | 下載前先同意（現況直接下載，改為明確同意以符合 spec §11） |
| 50 | 輸出資料夾、檔名 | 抽屜輸出區 | 不變；新增預估大小與剩餘空間（spec §6.4「匯出前檢查磁碟空間」） |
| 51 | 進度、完成輸出清單、錯誤訊息 | 抽屜進行中／完成／失敗狀態 | `alert()` 改為頁內；失敗可複製 stderr |
| 52 | 取消 | 〔取消匯出〕 | 現況「取消」只關閉視窗；真正中止需新增 IPC |
| **新增（補現況缺口，非舊功能）** | | | |
| 53 | 設定畫面（兩欄、3 分類、整組置中、搜尋在內容欄頂端，窄視窗收合為頂部分段列）、快捷鍵說明、分析佇列浮層、Toast | 見 §3.3–3.4 | 設定列全數保留，合併為 3 類避免一長串捲動或空白分類 |
| 54 | 專案只在記憶體（App 層 state），手動存／開 `.apexproj.json` | 專案自動儲存到 `%APPDATA%`；〔新專案〕〔開啟檔案〕〔另存檔案〕 | 補專案持久化（§3.7）；`.apexproj.json` 檔案流程仍保留 |
| 55 | 事件圖示只靠顏色區分、時間軸圖示疊成一團 | 密度檢視／群集／圖示三級＋框選／平移模型 | §3.2.2 |

**不採用的 Outplayed 功能**：Actions history（Ctrl+H）、自訂速度 0.07–8、Ctrl+T 時間軸切換、Collections／分享／雲端（理由見 §1.5）；以上皆不在現有功能或 spec 範圍內，不構成功能遺失。

---

## 5. 設計 Token（可直接成為 CSS 變數）

完整檔案：`docs/design/ui-mock/css/tokens.css`（mock 與正式實作共用同一份）。下方為全文，供審閱。

```css
/* Apex Highlighter — design tokens (可直接搬進 app/src/renderer/styles/tokens.css)
   來源與依據見 docs/superpowers/specs/2026-10-16-ui-redesign.md §1、§4 */
:root {
  /* 表面（Outplayed 基底 #131313，疊白色透明度形成層級） */
  --bg-app: #131313;
  --bg-rail: #0d0d0e;
  --bg-surface: #1b1b1d;
  --bg-raised: #242427;
  --bg-input: #0f0f10;
  --bg-hover: rgba(255, 255, 255, 0.06);
  --bg-active: rgba(255, 255, 255, 0.1);
  --bg-scrim: rgba(0, 0, 0, 0.62);
  --bg-popover: #1f1f22; /* 不透明，不使用 backdrop-filter */
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.16);

  /* 文字 */
  --text-1: #f6f6f6;
  --text-2: #b6b6b6;
  --text-3: #9a9a9a; /* 對 #131313 6.0、#1b1b1d 5.6、#242427 5.0、#2c2c30 4.6 */
  --text-disabled: #6c6c6c;

  /* 品牌色：Apex 紅（填色用 --accent，深底上的文字/線條用 --accent-bright） */
  --accent: #d92e25;
  --accent-hover: #c22820; /* hover/press 變暗：白字 5.8:1（舊 #EE3A30 僅 3.97） */
  --accent-press: #a8231c;
  --accent-bright: #ff5348;
  --accent-soft: rgba(217, 46, 37, 0.16);
  --on-accent: #ffffff;

  /* 狀態色 */
  --favorite: #ffd500;
  --success: #34d399;
  --warning: #ffd500;
  --danger: #ff7a93; /* 錯誤專用粉紅，與品牌紅區隔 */
  --info: #38bdf8;

  /* 事件類型（形狀＋顏色＋圖示三重編碼，不單靠顏色） */
  --ev-knock: #ff8a2b; /* 圓形 · 十字準星（與品牌紅 ΔE 35.6） */
  --ev-assist-knock: #38bdf8; /* 六角形 · 加號 */
  --ev-assist-elim: #2dd4bf; /* 菱形 · 叉號 */
  --ev-elim: #f2e65a; /* 方形 · 骷髏 */
  --ev-squad-wipe: #b66dff; /* 星形 · 星芒 */
  --ev-uncounted-alpha: 0.65; /* 不計入：空心環＋65% 不透明（環 ≥3:1） */

  /* 時間軸 */
  --tl-bg: #101011;
  --tl-ruler: #828282;
  --tl-spectating-fill: rgba(168, 168, 168, 0.14);
  --tl-spectating-hatch: rgba(168, 168, 168, 0.3);
  --tl-unanalyzed: rgba(255, 213, 0, 0.1);
  --tl-heat: 143, 163, 191; /* 藍灰，不使用品牌紅；alpha 0.3–0.9 */
  --tl-clip-suggest-line: rgba(255, 255, 255, 0.85); /* AI 建議：白色虛線 */
  --tl-clip-suggest-fill: rgba(255, 255, 255, 0.08);
  --tl-clip-line: #f6f6f6; /* 已加入／手動：白色實線 2px＋勾選角標 */
  --tl-clip-fill: rgba(255, 255, 255, 0.16);
  --tl-playhead: #ffffff;

  /* 字型 */
  --font-display: 'Montserrat', 'Noto Sans TC', 'Microsoft JhengHei UI', 'Segoe UI', sans-serif;
  --font-ui: 'Lato', 'Noto Sans TC', 'Microsoft JhengHei UI', 'Segoe UI', sans-serif;
  --font-mono: 'Cascadia Mono', 'Consolas', 'Microsoft JhengHei UI', monospace;
  --lh-body: 1.5; /* 中文內文 */
  --lh-tight: 1.35; /* 中文標題 */
  --fs-caption: 11px;
  --fs-small: 12px;
  --fs-body: 13px;
  --fs-body-lg: 14px;
  --fs-subtitle: 16px;
  --fs-title: 18px;
  --fs-h2: 22px;
  --fs-h1: 26px;
  --fs-display: 40px;
  --fw-regular: 400;
  --fw-bold: 700;
  --fw-heavy: 900;

  /* 間距（4px 基準） */
  --sp-0: 2px;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --sp-8: 32px;
  --sp-12: 48px;

  /* 圓角（3 為 Outplayed 預設、10 為其 --corner） */
  --r-xs: 3px;
  --r-sm: 6px;
  --r-md: 10px;
  --r-pill: 999px;

  /* 版面 */
  --rail-w: 56px;
  --topbar-h: 52px;
  --aside-w: 380px;
  --tl-source-h: 132px;
  --tl-project-h: 92px;
  --card-min: 280px;

  /* 動態 */
  --dur-fast: 150ms;
  --dur-base: 250ms;
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.5); /* 僅限小型浮層 */
  --focus-ring: 0 0 0 2px rgba(255, 255, 255, 0.6);
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0ms;
    --dur-base: 0ms;
  }
}
```

### 5.1 對比檢查（WCAG；已實際計算）

| 前景 | `#131313` app | `#1B1B1D` surface | `#242427` raised | `#2C2C30` selected | 備註 |
|---|---|---|---|---|---|
| `--text-1 #F6F6F6` | 17.0 | 15.9 | 14.4 | 13.0 | 主文字 |
| `--text-2 #B6B6B6` | 9.3 | 8.7 | 7.9 | 7.1 | 次要文字 |
| `--text-3 #9A9A9A` | 6.0 | 5.6 | 5.0 | 4.6 | 輔助說明（舊 `#828282` 對 surface 4.48、raised 4.03，不合格，已提高） |
| `--accent-bright #FF5348` | 5.8 | 5.4 | 4.9 | 4.4 | 深底上的紅色文字／線條（僅用於選取與 CTA 邊） |
| 白字 on `--accent #D92E25` | 4.8 | — | — | — | 主按鈕 |
| 白字 on `--accent-hover #C22820` | 5.8 | — | — | — | hover／press 改為**變暗**（舊 `#EE3A30` 僅 3.97，不合格） |
| 五種事件色（時間軸底 `#101011`） | 6.0–14.7 | 5.4–13.3 | 4.9–12.0 | 4.4–10.8 | 皆 ≥4.4:1 |
| 不計入（65% 不透明，時間軸底） | knock 3.98／assist_knock 4.30／assist_elim 4.82／elim 6.63／squad_wipe 3.16 | | | | 圖形物件 ≥3:1；舊 40% 僅 1.9–2.9 |

### 5.2 事件類型編碼（形狀＋顏色＋字形，三重編碼）

| 類型 | 中文 | 顏色 | 形狀 | 字形（3.2 px 粗筆畫） |
|---|---|---|---|---|
| `knock` | 擊倒 | `#FF8A2B` | 圓 | 十字準星 |
| `elim` | 已消滅 | `#F2E65A` | 圓角方 | 骷髏 |
| `assist_knock` | 助攻擊倒 | `#38BDF8` | 六角 | 加號 |
| `assist_elim` | 助攻消滅 | `#2DD4BF` | 菱形 | 叉號 |
| `squad_wipe` | 小隊抹殺 | `#B66DFF` | 星形 | 星芒 |

- 不計入（`isCounted` 為假）：淡色底（14%）＋65% 不透明＋（canvas 另畫 2 px 同色描邊）；原因文字在列表與 tooltip 提供：重複敵人／觀戰中／小隊抹殺不計／強制不計入；鍵盤聚焦也顯示。
- 觀戰區間：`rgba(168,168,168,.14)` 底＋`.32` 的 45° 斜線（每 8 px 一條線，成本極低）。
- **品牌紅角色收斂**：品牌紅 `--accent` 只用於主要 CTA（匯出、加入、播放鈕）、選取指示（分頁底線、圖示欄指示條）與開關；**不用於**資料編碼（事件、熱度條、片段框）與錯誤。片段框＝白色（建議虛線／已加入實線）；熱度條＝藍灰；錯誤＝`--danger #FF7A93`（粉紅）；「N 精華」徽章＝白字深底斜切角。
- knock 與品牌紅的區隔：舊值 `#FF5A36` 與 `#FF5348` 的 ΔE76 僅 10.7；改為 `#FF8A2B`（ΔE 35.6），並且由於資料編碼已不使用品牌紅，兩者不會出現在同一元素類別中。
- 色盲：不依賴顏色單獨辨識——五種類型外形各異（圓／圓角方／六角／菱形／星）、字形各異；兩種「助攻」（天藍／青綠，在 tritanopia 下接近）以外形（六角 vs 菱形）與字形（加號 vs 叉號）區分。

### 5.2 事件類型編碼

| 類型 | 中文 | 顏色 | 形狀 | 字形 |
|---|---|---|---|---|
| `knock` | 擊倒 | `#FF5A36` | 圓 | 十字準星 |
| `assist_knock` | 助攻擊倒 | `#38BDF8` | 圓角方 | 加號 |
| `assist_elim` | 助攻消滅 | `#2DD4BF` | 菱形 | 加號 |
| `elim` | 已消滅 | `#FFC93C` | 圓 | 骷髏 |
| `squad_wipe` | 小隊抹殺 | `#B66DFF` | 六角 | 星芒 |

- 不計入（`isCounted` 為假）：空心環＋40% 透明（原因文字在列表與 tooltip 提供：重複敵人／觀戰中／小隊抹殺不計／強制不計入）。
- 觀戰區間：`rgba(168,168,168,.14)` 底＋`.30` 的 45° 斜線（canvas 每 8 px 一條線，成本極低）。
- 片段框：建議＝白色虛線；已加入／手動＝紅色實線。刻意避開事件色，避免誤認。
- 與現行 `TYPE_COLORS` 的差異：現況 knock 紅 `#e13b30` 與品牌紅相同，易混淆；改為橙紅 `#FF5A36`，並讓品牌紅專屬於互動元件與片段框。

### 5.3 字型與間距摘要

- 字型：`--font-display`（Montserrat → Noto Sans TC → 微軟正黑體 UI）、`--font-ui`（Lato → 同上）、`--font-mono`（Cascadia Mono／Consolas，時間與數字，`tabular-nums`）。Lato／Montserrat 為 OFL，可打包（子集化後約 100–200 KB）；若不打包則自動退回系統字型，版面不受影響（見 §8 問題 5）。
- 字級：caption 11／small 12／body 13（預設）／body-lg 14／subtitle 16／title 18／h2 22／h1 26／display 40。
- 間距 4 px 基準：2／4／8／12／16／20／24／32／48。圓角 3／6／10／pill。
- 動態：150 ms（hover）、250 ms（側欄／抽屜）；`prefers-reduced-motion` 時降為 0。僅動 `transform`／`opacity`／`grid-template-columns`（側欄）。

---

## 6. 低階 PC 效能注意

目標：4 GB RAM、無獨顯、1366×768 的筆電也要順（spec §1）。

| 面向 | 規則 |
|---|---|
| 視覺成本 | **不使用 `backdrop-filter`**（Outplayed 用了約 93 處 `blur(20px)`）；不對大面積使用 `box-shadow`／`filter`；陰影僅限小型浮層（`--shadow-pop`）；表面層用不透明實色，不疊多層半透明；不使用漸層動畫與持續動畫（紅色環形進度以 `conic-gradient` 靜態繪製，更新只改 CSS 變數 `--p`） |
| 時間軸 | Canvas 繪製（與現況一致）；**分層**：靜態層（尺標、觀戰、熱度、片段框、事件）只在資料／縮放／視窗改變時重繪（`requestAnimationFrame` 合併、以 `ResizeObserver` 觸發）；**播放頭是 DOM 元素以 `transform` 移動**，播放中不重繪 canvas；處理 `devicePixelRatio`，但上限 2；熱度條固定 120 bin（低效能模式 60）；**依像素密度**（非總數）切換：平均每事件 <8 px 時只畫熱度條＋刻度＋框，不畫個別圖示；其餘以 22 px 為門檻合併群集（§3.2.2）；2000 事件的 `layoutTimeline` 目標 <5 ms |
| 影片庫 | **虛擬化**：卡片固定高度，依容器寬度算欄數（`columns = floor((W+gap)/(280+gap))`），只渲染可視列＋上下各 2 列 overscan；日期分組標題也是虛擬列；縮圖 `loading="lazy" decoding="async"`，縮圖檔由主程序產生 ≤320×180 JPEG；`content-visibility:auto`（mock 已示範）；進度更新以 2 Hz 節流，且只重繪該張卡片（`React.memo` + 以 path 為 key 訂閱） |
| 事件清單 | 事件 >200 筆時虛擬化（列高固定 44 px）；勾選狀態用 `Set` 查詢 |
| 播放 | 優先硬體解碼；低階機建議代理檔（`mediaCapabilities`）；播放中以 `requestVideoFrameCallback` 或 `timeupdate`（4 Hz）更新時間，不逐幀 setState |
| 記憶體 | 專案軌縮圖用同一張小圖（不另建 `<video>`）；專案預覽只維持一個 `<video>` 元素，切換片段時換 `src` |
| 重繪範圍 | 側欄 `contain: layout paint`（Outplayed 亦用 `contain: strict`）；卡片 `contain` 同理；避免在 `timeupdate` 內改變大型清單的 state |
| 低效能模式（設定，預設關） | 關閉所有 transition、縮圖不做 hover 位移、熱度條 60 格、事件群集更積極；偵測到無硬體解碼時於首次啟動詢問是否開啟 |
| 載入 | 首屏只需 tokens＋影片庫；工作室以 `React.lazy` 動態載入；字型 `font-display: swap` |

---

## 7. 實作大綱

### 7.1 元件樹

```
App
├─ AppShell                       // 圖示欄、全域 Toast、OverlayHost、快捷鍵註冊
│   ├─ Rail (RailButton, QueueRing)
│   ├─ ToastHost
│   └─ QueuePopover, ShortcutsDialog
├─ LibraryScreen
│   ├─ LibraryToolbar (SearchBox, FilterChips, WatchChip)
│   ├─ QueueStrip
│   ├─ VirtualGrid → DateHeader | VideoCard (Thumb, CountBadges, FavButton, StatusOverlay, CardMenu)
│   ├─ EmptyState, DropOverlay
├─ StudioScreen                   // 取代 Viewer + Editor
│   ├─ StudioHeader (StatusPill, AutoClipButton, QuickClipButton, ExportButton)
│   ├─ NoticeBar (AnalyzingNotice | ErrorNotice | ProxyNotice)
│   ├─ PlayerStage (VideoElement, ModePill, SpecPill)
│   ├─ TransportBar (PlayButton, SpeedButton, TimeLabel, EventFilterChips, AddEventButton)
│   ├─ TimelineDock
│   │   ├─ SourceTimeline        // 改寫自 TimelineCanvas（沿用 model.ts）
│   │   │   └─ Playhead (DOM)
│   │   └─ ProjectTrack          // 取代 Editor 頁：ProjectClip, TrimInspector, ProjectToolbar
│   ├─ Aside
│   │   ├─ HighlightsTab → HighlightCard
│   │   └─ EventsTab → EventRow (TriStateToggle) | ActionFooter
│   ├─ AutoClipPopover
│   ├─ AddEventDialog
│   └─ ExportDrawer (ExportConfig | ExportProgress | ExportDone | ExportError, OpenH264Dialog)
└─ SettingsScreen                // 兩欄，整組置中
    ├─ SettingsNav (CategoryButton×3, role=tablist；< 900 px 變 SegmentedBar)
    └─ SettingsPane (SettingsSearch, SettingsCard, SettingRow, Switch)   // 內容欄 max-width 720，依分類／搜尋過濾列
```

狀態：`StudioScreen` 內沿用 `useReducer(viewerReducer)`；**專案**提升到 `ProjectProvider`（context：`project`、`History<Project>`、`apply()`、`undo()`、`redo()`、自動儲存狀態），因為專案跨影片、跨畫面存在（圖示欄徽章也要讀）。焦點區與快捷鍵由 `FocusZoneProvider`＋`keymap.ts`（純資料表）驅動。

### 7.2 不動、直接重用的模組

| 模組 | 內容 |
|---|---|
| `renderer/timeline/model.ts` | `timeToX`、`xToTime`、`zoom`、`pan`、`heatmap`、`hitTestEvent`、`nextEvent` |
| `renderer/timeline/clips.ts` | `createClipAt`、`resizeClip`、`mergeOverlapping`、`supercut` |
| `renderer/editor/project.ts` | `createProject`、`addItems`、`removeItem`、`splitItem`、`duplicateItem`、`moveItem`、`trimItem`、`totalDuration`、`serializeProject`、`deserializeProject` |
| `renderer/editor/history.ts` | `History<T>` |
| `renderer/media/playability.ts` | 可播放與硬體解碼判定（卡片徽章與代理檔建議） |
| `renderer/viewer/state.ts` | `viewerReducer`（僅**新增** action：`acceptClip`／`skipClip`／`restoreClip`，與 `status` 欄位） |
| `shared/types.ts` | 全部沿用；`Clip` 新增**可選**欄位 `status?: 'suggested' | 'accepted' | 'skipped'`（快取格式向下相容，`version` 不變，舊檔視為 `accepted`） |
| `shared/time.ts` | `formatTime`、`toCurrentTime`、`fromCurrentTime` |
| `main/*` | 引擎、佇列、library、proxy、匯出、快取——不動，僅補 §7.4 的 IPC |

既有測試（`model.test`、`clips.test`、`project.test`、`history.test`、`state.test`、`playability.test`）應全數維持通過。

### 7.3 需變更或新增的 renderer 檔案

| 檔案 | 動作 |
|---|---|
| `renderer/styles/tokens.css`（新）、`base.css`、`components/*.css` | 由 mock 的 `tokens.css`、`app.css` 切分；以 CSS Modules 或單純 class，去除 inline style |
| `App.tsx` | 改為 AppShell＋簡易路由（`library`／`studio`／`settings`）；移除 `setView('editor')` 換頁邏輯 |
| `pages/Library.tsx`、`components/VideoCard.tsx` | 重寫為 VirtualGrid＋新卡片；新增 `lib/groupByDate.ts`、`lib/gridLayout.ts` |
| `pages/Viewer.tsx` → `pages/Studio.tsx` | 吸收 `Editor.tsx` 的播放序列邏輯；拆成 §7.1 的子元件 |
| `pages/Editor.tsx` | 刪除；邏輯移入 `components/ProjectTrack.tsx`、`ProjectProvider` |
| `timeline/TimelineCanvas.tsx` | 改版：分層重繪、事件形狀＋字形（`Path2D`）、觀戰斜線、未分析斜帶、三列防重疊、片段框建議／已採用樣式與把手、tooltip；新增純函式 `timeline/packRows.ts`（附 vitest） |
| `components/EventList.tsx` | 加三態分段按鈕、原因文字、虛擬化 |
| `components/ClipList.tsx` → `HighlightCard.tsx` | 大縮圖卡片＋狀態動作 |
| `components/AutoClipDialog.tsx` → `AutoClipPopover.tsx` | 浮層＋即時預覽 |
| `components/ExportDialog.tsx` → `ExportDrawer.tsx` | 四狀態＋OpenH264 同意對話框；沿用現有 `window.api.export.*` 呼叫 |
| `components/EventTypeFilter.tsx` | 改為 chip（含計數、事件字形） |
| `hooks/useShortcuts.ts` | 新增 handler：`[` `]`、`Ctrl+M`、`Ctrl+D`、`Ctrl+S`、`Ctrl+Shift+E`、`Ctrl+B`、`←/→`、`Enter`、`Delete`、`Esc`、`?`，並依「模式／聚焦區」分派（Ctrl+Q 在專案模式 = 分割） |
| `i18n/zh-TW.ts` | 擴充字串（所有新文案集中，不再於 TSX 內硬寫） |
| `components/icons/*`（新） | 事件字形與 UI 圖示（lucide-react） |

### 7.4 主程序／preload 需補的小缺口（皆為加法）

| 缺口 | 說明 |
|---|---|
| 監看資料夾 API | `main/library.ts` 已有 `watchFolder()`，但 `preload` 與 `ipc-handlers` 沒暴露：新增 `library:getWatchFolders`、`library:addWatchFolder`、`library:removeWatchFolder`，設定儲存 |
| 匯出取消 | 新增 `export:cancel`（終止 ffmpeg 子程序並保留已完成檔案） |
| 設定儲存 | 簡單 JSON（`%APPDATA%\ApexHighlighter\settings.json`）＋ `settings:get/set` |
| 精華數 | 分析結束時以預設參數呼叫 autoclip，把 `hl` 數寫入 `LibraryEntry`（供卡片徽章與「有精華」篩選）；若不想動快取，可改為卡片首次進入視窗時惰性計算 |
| 磁碟空間 | `export:getDiskSpace(dir)`（spec §6.4 要求匯出前檢查） |
| 縮圖 | 確認 `entry.thumb` 尺寸 ≤320×180；缺圖時由主程序以 ffmpeg 擷取（可惰性） |
| 開啟時的預設建議 | 純 renderer：載入 `CacheDoc` 後呼叫既有 `engine.autoclip`；若 `doc.clips` 已有資料則不覆寫 |

### 7.5 工作拆解與估計

以 `docs/superpowers/plans/2026-10-16-plan3-ui.md` 為準（18 個任務、約 50 工作天；審查者估 40–45 天，原規格 27 天偏樂觀）。主要調整：時間軸 Canvas 3→6.5、專案軌 3.5→5.5、影片庫 3→4.5、匯出 2.5→4、新增專案持久化／Clip.status 遷移／無障礙／E2E／設定遷移等項目。

### 7.6 驗收重點

- 既有功能逐項走過 §4 對照表（以表為勾選清單）。
- 新增純函式的 vitest：`groupByDate`、`gridLayout`、`packRows`、reducer 新 action、快捷鍵分派（模式／聚焦區）。
- 低階機基準：影片庫 500 筆捲動不掉格（< 16 ms 主執行緒長任務）、時間軸播放時 CPU 使用率較現況不增加。
- 對比與焦點：用 §5.1 清單檢查；全部操作可純鍵盤完成。

### 7.7 風險

| 風險 | 緩解 |
|---|---|
| 專案跨影片＋播放器單一 `<video>` 切換 `src` 時的黑畫面／延遲 | 專案模式切片時預先設定下一片段 `src` 並 seek，使用 `loadeddata` 後再顯示；必要時雙 video 元素交替（僅專案模式） |
| `Ctrl+Q` 依模式改變語意可能混淆 | 模式膠囊始終可見；按鈕 tooltip 隨模式改文字；§8 問題 2 請使用者確認 |
| 自動預放建議造成「快取 clips 被覆寫」的疑慮 | 只在 `doc.clips` 無 AI 框時執行；重新分析規則沿用 spec §4.2（`origin=ai` 清除、`manual` 保留）；`status: 'accepted'` 的片段在重新分析時**保留並標示「來源已更新」**（建議在實作時補此規則） |
| 現況 Viewer 初始 doc 為占位資料、`state.clips` 是否隨 `cache.save` 持久化未確認 | plan 3 Task 2 Step 5 先驗證並補測試 |

---

## 8. 待使用者確認的問題與裁決

使用者已同意問題 1–6 的提案，**依下列方式落實**（不再重開討論）：

| # | 決定 | 落實位置 |
|---|---|---|
| 1 | 專案跨影片；來源軌不切換影片 | §3.5（脈絡橫幅、灰化、來源色點） |
| 2 | 專案模式 `Ctrl+Q` = 分割 | §3.2.7 矩陣、§3.5（按鈕文字隨模式、誤按 Toast〔復原〕） |
| 3 | 開啟影片自動預放 AI 建議，設定可關閉 | §2.2、§3.3 |
| 4 | 品牌紅 `#D92E25`（填色）／`#FF5348`（文字線條） | §5.1、§5.2（角色收斂） |
| 5 | 打包 Lato／Montserrat | §3.9 |
| 6 | 1366×768 專案軌預設收合 | §3.2.2（`max-height:800px`）、mock 已實作 |

其餘三題裁決：

7. **設定畫面範圍** — **Ruling：第一版全做，分兩批**：不需新 IPC 的列先交付，監看資料夾、匯出取消、設定儲存依賴的列隨 plan 3 對應任務補上。理由：UI 骨架一次到位，未接上的列暫以停用＋灰色說明呈現，避免日後重排版面。
8. **「N 精華」徽章與「有精華」篩選** — **Ruling：做，採惰性計算**：卡片首次進入視窗時對已分析影片以預設參數跑一次 autoclip 並快取數字。理由：這是「精華優先」流程在影片庫的入口；惰性計算不拖慢分析、不動快取格式。
9. **Hover 預覽縮圖** — **Ruling：第一版不做**。理由：增加解碼與記憶體負擔，與低階 PC 目標衝突。

## 9. 設計評審紀錄

獨立前端設計評審（評價者 agentId a7a60742074a258a7，評分 7.0/10）共提出 20 項發現、6 項規格與 mock 不一致、一份工作量清單。以下逐項記錄決定。**每項主張先自行驗證**（計算對比、ΔE，檢查所引用的 CSS／JS 行）：對比與 ΔE 數值經重算全部屬實（白字對 `#EE3A30` = 3.97；`#828282` 對 surface 4.48、raised 4.03；knock 與品牌紅 ΔE76 = 10.7；40% 不透明僅 1.9–2.9:1）。

決定統計：**接受 13、修改 7（含 1 項依控制者裁決延後）、整項駁回 0**；另有 3 處局部主張被駁回（見備註）。

| # | 發現 | 決定 | 理由 | 變更位置 |
|---|---|---|---|---|
| 1 | 時間軸真實密度無證據；群集內圖示互疊、標籤被壓 | **接受** | 驗證：舊 mock 僅 19 事件，2 小時 300 事件時每事件 ~5 px，22 px 圖示必疊 | §3.2.2 密度規則（<8 px/事件改熱度條）、標籤獨立一行；mock `#studio-long`／`#zoomed`、截圖 10–12 |
| 2 | 鍵盤／焦點模型衝突（Enter／Delete 全域） | **接受** | 驗證：舊 `onKey` 對 `Enter`、`Delete` 不分焦點，按鈕上的 Enter 會被攔截 | §3.2.7 焦點區＋鍵×焦點區矩陣；mock `onKey` 重寫；plan 3 Task 3 |
| 3 | 模式混淆（Ctrl+Q 在來源模式直接建立並加入） | **接受** | 膠囊確實太小；快速剪輯會改動專案 | §3.5：白底膠囊、脈絡橫幅、按鈕文字隨模式、Toast〔復原〕 |
| 4 | 專案持久化缺規格 | **接受**（控制者裁決：納入 v1） | 現況專案僅在 App state，手動存檔 | §3.7 自動儲存／新專案／還原；設定列；mock〔新專案〕對話框；plan 3 Task 9 |
| 5 | 匯出抽屜 420 px 蓋住頂欄與專案軌 | **修改** | 驗證屬實。採評價者方案 A：抽屜縮為側欄同寬並只覆蓋側欄，另加編輯區鎖定 | §3.2.5；CSS `.drawer`（`top:var(--topbar-h); width:var(--aside-w)`）；截圖 05 |
| 6 | 對比不足（accent-hover、text-3 於表面層） | **接受** | 重算屬實 | tokens：`--text-3 #9A9A9A`、`--accent-hover #C22820`；§5.1 補表面層組合 |
| 7 | knock 色與品牌紅過近；品牌紅語意重疊 | **接受** | ΔE76 10.7 屬實 | knock→`#FF8A2B`（ΔE 35.6）、elim→`#F2E65A`；片段框改白、熱度條改藍灰（§5.2） |
| 8 | 色盲辨識僅靠形狀、字形過小 | **修改** | 我沒有自己做色盲模擬，接受評價者數值為近似；解法採「形狀＋字形重設」而非再調色 | 5 種外形各異、字形 3.2 px 粗筆畫、兩種助攻字形不同（加號／叉號）；chip 圖示 20 px |
| 9 | 不計入 40% 對比 1.9–2.9:1 | **修改** | 評價者建議 55–60%；重算 60% 時 squad_wipe 仍 2.88，故採 **65%**（最低 3.16）；鍵盤聚焦也顯示原因 | `--ev-uncounted-alpha: .65`；§5.1、§5.2；mock |
| 10 | 精華卡大縮圖一屏只能 1.3 張 | **接受** | 驗證屬實（~310 px 高） | §3.2.3 精簡卡（128×84 側置，一屏 4–5 張）預設、〔大圖〕切換；截圖 11 |
| 11 | 1366×768 專案軌預設收合未落實；軌頭擠壓 | **接受** | mock 先前確為展開 | `projCollapsed = innerHeight<=800`；窄寬隱藏「來自 N 支影片」與儲存文字；截圖 11 |
| 12 | 專案模式播放別支影片時缺脈絡提示 | **接受** | 使用者已同意跨影片行為，需配套提示 | §3.5 脈絡橫幅、灰化、專案軌來源色點；截圖 13 |
| 13 | 可發現性：把手、拖曳/點擊語意、無框選 | **接受** | 驗證：舊版點事件同時 seek＋勾選；拖曳空白無框選 | §3.2.2 互動模型：click=seek、Shift/Ctrl+點=選取、拖曳=框選、Space/中鍵=平移、把手 hover 才顯示且命中區 ±7 px |
| 14 | 紅色語意過載 | **接受** | 同 #7 | §5.2 品牌紅角色收斂；錯誤改粉紅；精華徽章白字 |
| 15 | 「分析中即可開啟」缺引擎／快取增量輸出任務 | **修改**（控制者裁決：v1 刪除，列 v2） | 需引擎增量輸出與快取格式變更，超出 v1 範圍 | §0、§2.2、§3.1、§3.2.6；卡片仍顯示進度，點擊提示；v2 項目寫入 plan 3 的「後續」 |
| 16 | 設定頁空洞、分類不足 3 列、開發註記標籤、搜尋離內容遠、缺 tablist | **修改** | 全部屬實；分類合併為 3 類（各 ≥5 列）、整組置中；搜尋移到內容欄頂端；移除「需新增 IPC」 | §3.3；mock settings；`Ctrl+F` 聚焦搜尋、tablist＋方向鍵 |
| 17 | 目標大小／聚焦顯示 | **修改** | `.card .more` 僅 hover 顯示（屬實→`:focus-within` 顯示）；步進鈕 20 px（屬實→26 px）；**收藏星 28 px 並未低於 26 px**（局部駁回，仍提高到 30 px）；**事件圖示 18 px 是非互動裝飾**（局部駁回，chip 本身 26 px 高）；aria 不足屬實 | §3.8；CSS；mock 補 `role`／`aria-*` |
| 18 | 中文排版（字重、行高、字距） | **接受** | 屬實，原 `line-height:1.4`、display 字型含中文 | §3.9；tokens `--lh-body 1.5`／`--lh-tight 1.35`；全域 `letter-spacing:0` |
| 19 | 套版感（全部同一縮圖、同一卡片配方） | **修改** | 縮圖重複為 mock 限制（真實縮圖會不同）→ mock 改每卡不同場景色；卡片形式本身維持（影片庫的標準樣式是使用者要求的 Outplayed 風格），僅加斜切角標籤 | CSS `.slant`；mock 場景輪替 |
| 20 | 圖示欄無文字、title 延遲 | **修改** | 即時 tooltip＋`aria-label` 屬實需要；**不加常駐文字標籤**（維持 56 px 窄欄） | §3.8；CSS `[data-tip]` |

**規格 vs mock 不一致**

| 項目 | 決定 | 說明 |
|---|---|---|
| §8#6 專案軌 1366 未收合 | 修正 | 見 #11 |
| §3.2.7 快捷鍵缺 `[` `]`、Alt+←/→、Ctrl+S、Ctrl+Shift+Z、Ctrl+滾輪；Ctrl+Shift+E／Z 分支順序錯誤 | 修正 | mock `onKey` 重寫並將含 Shift 的判斷置前；快捷鍵說明由同一份表產生 |
| §5.1 對比只算 `#131313` | 修正 | §5.1 改為表面層矩陣 |
| §5.2「改橙紅避免混淆」未達成 | 修正 | 見 #7 |
| §3.3 ASCII 與 mock 類別數不符 | 修正 | §3.3 改為 3 類並與 mock 一致 |
| §1.4 Ctrl+Q「推論」 | 修正為「已證實」 | 英文字串為 "Slice"；另 §1.1 的 `--focus-visible-color: rgba(255,255,255,.6)` 評價者稱無法證實，**駁回此說**：`indexCss.js` 中該變數出現 7 次（`--focus-visible-color: rgba(255, 255, 255, 0.6)`） |

**工作量**：評價者估 40–45 天（原 27）。**接受**；plan 3 逐項重估為約 50 工作天（含審查未列的 Electron 層 smoke/E2E、設定遷移、export:cancel 子程序終止與半成品清理）。

---

## 附錄 A：Mock 使用方式

- 開啟 `docs/design/ui-mock/index.html`（雙擊即可；字型來自 Google Fonts，離線時自動退回系統字型）。
- 右下角「Mock 狀態」列可切換：影片庫（有影片／空／拖放）、工作室（完成／300 事件／錯誤／代理檔建議）、匯出（設定／進行中／完成／失敗）。也可用網址 hash：`#library`、`#library-empty`、`#studio`、`#studio-partial`、`#studio-error`、`#studio-proxy`、`#events`、`#autoclip`、`#export`、`#export-run`、`#export-done`、`#export-err`、`#settings`、`#shortcuts`、`#queue`、`#settings-perf`（及其他分類）。加上 `?shot` 可隱藏 Mock 狀態列。
- 可操作：點卡片進工作室、點／拖時間軸、點事件、切換篩選 chip、精華卡片加入／略過／預覽、事件三態與刪除復原、建立合輯、AI 浮層（參數即時改變預計段數）、快速剪輯、專案軌選取／拖曳排序／分割／複製／刪除／復原、匯出抽屜各狀態、快捷鍵（`Space`、`S`、`M`、`Ctrl+Q`、`Ctrl+E`、`Ctrl+M`、`Ctrl+←/→`、`Ctrl+±/0`、`Ctrl+Z/Y`、`?` 等）。
- 示意內容的事件字樣影像來自 `engine/tests/fixtures/zh-TW/pos/`（縮小並裁切為 6 張，位於 `img/`）；其餘畫面為 CSS 漸層模擬。Mock 中的時間軸事件時間點是依 spec §3 查證結果與測試標註（例如 50.0 擊倒、53.75 已消滅、71.5 助攻擊倒、74.0 助攻消滅）編排的示意資料。
- Mock 不含 Outplayed 的任何圖片、logo 或樣式檔；圖示為自行繪製。
