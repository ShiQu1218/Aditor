# Apex Highlighter — 設計規格

日期：2026-10-15
狀態：第 2 版（已納入審閱意見），待審閱

## 1. 目標

一個類似 Outplayed 的 Windows 桌面剪輯程式。輸入**已錄好的** Apex Legends 遊戲影片，自動標註擊倒／助攻等事件的時間點；使用者可在時間軸上手動剪輯，或讓 AI 自動框出「短時間內多殺」的片段，確認後匯出。

最終以 MIT 授權開源，**必須能在低階電腦上順暢執行**。

### 成功標準

- 繁中介面 1080p 影片的「擊倒」（`knock`）事件：召回率 ≥ 95%、精確率 ≥ 95%（扣除系統性偏移後，容許誤差 ±1.5 秒）。`elim`（自己消滅）在樣本中尚未出現，不列入第一版驗收。
- 以使用者的 2 小時原始錄影（AV1）實測並記錄分析倍速，分別記錄：硬體解碼、強制軟體解碼（模擬低階電腦）。
- 操作流程與 Outplayed 的「影片庫 → 檢視器 → 剪輯專案 → 匯出」一致。

### 與 Outplayed 的關鍵差異

Outplayed（Overwolf JS 應用，`Outplayed.exe` 僅為啟動器）的事件來自 Overwolf Game Events Provider，是遊戲執行時的即時事件，**不分析影片畫面**。本專案處理的是現成影片，因此事件必須以電腦視覺從畫面上辨識。

## 2. 已確認的需求決策

| 項目 | 決策 |
|---|---|
| 影片來源 | 使用者自己錄製 |
| 語言 | **第一版只實作繁體中文**；英文的 profile 格式與範本擷取工具先備妥，取得樣本後補上 |
| 參考樣本 | 繁中。已剪輯：`E:\Outplayed\Outplayed\Exports`（H.264/1080p60）；原始長片：`E:\Outplayed\Outplayed\Apex Legends`（**AV1、1916×1080、固定 60fps、start_time=0**，最長約 100 分鐘） |
| 程式形式 | Electron 桌面應用 + Python 分析引擎 + ffmpeg |
| 偵測方式 | 輕量範本比對（不使用 OCR、不使用 AI 模型）；小型 CNN 列為未來備案 |
| 事件時間基準 | 畫面中央擊倒／淘汰提示**首次出現**的時間。右上角擊殺計數器會延遲到處決後才增加，**不可作為時間基準** |
| 算殺規則 | 擊倒、助攻（擊倒／消滅）、消滅都計入 N；同一敵人去重；小隊抹殺只標記不計入；觀戰期間不計入 |
| AI 自動剪輯 | 只把片段框放上時間軸，由使用者確認／調整後才匯出 |
| 匯出 | 每段各一檔，或串成一支合輯，匯出時選擇 |
| 授權 | 專案 MIT；隨附 **LGPL 版** ffmpeg（見 §11） |

## 3. 遊戲畫面觀察（繁中，1080p）

提示出現在畫面中央、準星下方，約 `x=610..1310, y=760..850`，為深色半透明底板上的文字，**整塊置中對齊**（關鍵字水平位置會隨敵人名稱長度改變），停留約 2.5 秒，出現時有放大淡入動畫。

| 第一行 | 第二行 | 意義 | 敵人名顏色 | 計入 N |
|---|---|---|---|---|
| `擊倒 [敵人名] +150 (段位圖示)` | `造成 N 點傷害` | 自己擊倒 | 紅 | 是 |
| `助攻，擊倒 [敵人名] +100` | — | 助攻擊倒 | 白 | 是 |
| `(圖示) 助攻，消滅 [敵人名]` | — | 助攻消滅 | 白 | 是 |
| `消滅 [敵人名]`（推測，樣本中尚未出現） | — | 自己消滅 | 未知 | 是 |
| `小隊抹殺 +100` | `[隊友, 💀 敵人名]` | 整隊消滅 | 紅（第二行） | 否（只標記） |

**待查證**（實作第一步從長片取樣確認，結果回寫本節）：
- 兩個提示同時出現（例如擊倒＋小隊抹殺）時是否往上堆疊、ROI 位置是否偏移。
- 自己死亡後觀戰隊友時，畫面是否顯示隊友的提示，以及觀戰介面上可作為範本的固定字樣與位置。

英文介面對應關鍵字預期為 `KNOCKED DOWN`、`ASSIST`、`ELIMINATED`、`SQUAD WIPE`。

## 4. 架構

```
┌────────────── Electron 桌面程式 (TypeScript) ──────────────┐
│  影片庫 │ 檢視器（播放器 + 時間軸 + 事件標記）│ 剪輯專案 / 匯出 │
└───────────────┬─────────────────────────────────────────────┘
                │ JSON Lines over stdin/stdout
┌───────────────▼─────────────────────────────────────────────┐
│  Python 分析引擎（PyInstaller one-dir；依賴 OpenCV + numpy）  │
│   decode → detect → events → autoclip                        │
└───────────────┬─────────────────────────────────────────────┘
                │
        ffmpeg / ffprobe（LGPL 版，隨程式附帶）：分析解碼、代理檔、匯出
```

引擎以 PyInstaller **one-dir** 模式打包（避免 one-file 每次啟動解壓縮的延遲與防毒誤判）。

### 4.1 元件

| 元件 | 職責 | 介面 |
|---|---|---|
| `engine/probe` | ffprobe 讀取編碼、解析度、幀率、`start_time`、時長 | `probe(path) -> VideoInfo` |
| `engine/decode` | ffmpeg 解碼並輸出 ROI 彩色畫格與其 pts（見 §5.1） | `iter_frames(path, info, profile) -> (t, ndarray[BGR])` |
| `engine/detect` | 對單格做關鍵字比對、觀戰判斷、產生名字指紋 | `detect(frame) -> FrameResult`（命中類型、分數、x 位置、名字指紋、是否觀戰） |
| `engine/events` | 狀態機把連續命中合併為事件、去重同一敵人、套用觀戰區間 | `build_events(results) -> list[Event]` |
| `engine/autoclip` | 依間隔分群並產生片段 | `auto_clips(events, params) -> list[Clip]` |
| `engine/ipc` | 接收指令（probe / analyze / cancel / autoclip），回報進度與結果 | JSON Lines |
| `templates/<lang>/` | `profile.json`（ROI、關鍵字清單、閾值、事件類型對照、觀戰範本）＋範本 PNG | 外部檔案，改版時只換範本不需重新打包；含 `templates_version` |
| `app/` | 影片庫、檢視器、剪輯專案、匯出、設定 | Electron main/renderer |
| `tools/` | 範本擷取、準確率評估、速度基準、Outplayed 正確答案匯出 | CLI |

### 4.2 快取與資料格式

快取預設存在 **app data**（`%APPDATA%\ApexHighlighter\cache\<key>.json`），`key = sha1(正規化絕對路徑 + 檔案大小)`；設定中可改為「寫在影片旁」（`<影片名>.apexhl.json`）。不寫入 Outplayed 管理的目錄，除非使用者選擇此選項。

```json
{
  "version": 1,
  "video": { "path": "...", "size": 0, "mtime": 0, "duration": 6002.25, "width": 1916, "height": 1080, "codec": "av1", "start_time": 0.0 },
  "profile": "zh-TW",
  "analysis": { "status": "done", "progress_t": 6002.25, "engine_version": "0.1.0", "templates_version": "zh-TW@1" },
  "events": [
    { "id": "e1", "t": 812.25, "type": "knock", "score": 0.91, "damage_line": true, "name_sig": "base64...", "counted": true, "source": "auto" }
  ],
  "spectating": [ { "start": 3010.0, "end": 3105.5 } ],
  "clips": [
    { "id": "c1", "start": 804.0, "end": 836.5, "origin": "ai", "event_ids": ["e1", "e2", "e3"] }
  ]
}
```

- `t` 一律為**扣除 `start_time` 後的秒數**，與 `<video>.currentTime` 一致。
- `type`：`knock` | `assist_knock` | `assist_elim` | `elim` | `squad_wipe`
- `counted`：去重或位於觀戰區間的事件為 `false`，仍顯示於時間軸。
- `source`：`auto` | `manual`。使用者刪除的自動事件標記 `"deleted": true` 並保留，供準確率評估。
- **重新分析的觸發條件**：影片 `size`/`mtime` 改變、`engine_version` 或 `templates_version` 改變、使用者手動要求。
- **重新分析時**：只取代 `source=auto` 的事件；`manual` 事件與 `deleted` 標記保留（`deleted` 依 ±1 秒且同類型對應到新的自動事件）；`origin=manual` 的片段保留，`origin=ai` 的片段清除。

## 5. 偵測演算法

### 5.1 解碼與正規化

- 濾鏡順序：**降幀 → 縮放到 1080p 等效 → 裁切 ROI → 轉 BGR24**，管線只傳 ROI。
  ```
  ffmpeg [-hwaccel auto] -i <in> -vf "fps=4,scale=1920:1080,crop=<w>:<h>:<x>:<y>,showinfo" \
         -pix_fmt bgr24 -f rawvideo pipe:1
  ```
  先把整格縮放到 1920×1080 再裁切，因此 1916×1080、1728×1080（拉伸）、1440p、4K 都映射到同一組 1080p 座標與同一套範本，**範本固定不縮放**。`scale` 只作用在降幀後的畫格，成本很低。
- **時間戳記**：每格時間取自 ffmpeg 輸出的 pts（由 `showinfo` 從 stderr 解析，或改用等效方式），減去 `start_time`；**不使用「畫格編號 × 0.25」**，以支援可變幀率與 `start_time ≠ 0` 的影片。
- **非 16:9**：縮放到 1920×1080 會使介面水平變形。此時關鍵字比對改用**水平多尺度**（例如水平比例 0.85–1.15，步長 0.05），並在介面提示「準確度可能下降」。
- 硬體解碼失敗時自動改用軟體解碼並提示。速度基準須比較 `-hwaccel` 開／關的實際差異，若硬體解碼後的影格回傳抵銷了效益，預設改為軟體解碼。

### 5.2 單格偵測

ROI 擴大為約 `x=560..1360, y=700..880`（1080p 座標，實際值依 §3 堆疊查證結果寫入 profile），以容納提示堆疊。

1. **文字遮罩**：
   - `white_mask`：高亮度、低飽和度像素（關鍵字與白色名字）。
   - `red_mask`：R 高、G/B 低的像素（擊倒的紅色名字）。
   - 閾值定義於 profile。
2. **關鍵字比對**：在 `white_mask` 上以 `cv2.matchTemplate`（`TM_CCOEFF_NORMED`）滑動比對，依序 `小隊抹殺` → `助攻` → `擊倒` → `消滅`（「助攻」優先，避免「助攻，擊倒」被判成自己擊倒）。「助攻」命中後，在其右側判斷是「擊倒」或「消滅」。第二行 `造成` 命中時加分並標記 `damage_line`。
3. **名字指紋**：取第一行關鍵字右側到 `+`／行尾之間的區塊，對 `white_mask ∪ red_mask` 做聯集，裁掉空白邊後縮放到固定高度（寬度保留比例），作為**字形**指紋。比對字形而非顏色，因此紅字（擊倒）與白字（助攻）可以跨類型比對。
4. **觀戰判斷**：在 profile 指定的觀戰 ROI 比對觀戰字樣範本（範本於實作第一步從長片取得）。

### 5.3 事件追蹤

1. 同一關鍵字類型至少**連續 2 格**命中才成立（排除淡入動畫變形畫格）；事件時間取首次命中那一格的 pts。
2. 提示消失 ≥ 0.5 秒後再出現，或名字指紋差異超過閾值，視為新事件。
3. **去重**：30 秒內名字指紋相似（寬度比差 < 15% 且相關係數 > 閾值）的計數事件視為同一敵人，只有第一個 `counted=true`。
4. **觀戰**：連續 ≥ 2 秒判定為觀戰的時段寫入 `spectating`，落在其中的事件 `counted=false`。

### 5.4 自動剪輯

參數：`gap`（相鄰計數事件最大間隔，預設 20 秒）、`n`（預設 3）、`before`（預設 8 秒）、`after`（預設 4 秒）、`max_len`（片段最長，預設 90 秒）。

1. 計數事件依時間排序；相鄰事件間隔 ≤ `gap` 就歸為同一群。
2. 群內計數事件 ≥ `n` 才成立。
3. 片段為 `[首殺 − before, 末殺 + after]`，限制在影片範圍內。
4. 若片段超過 `max_len`：在群內最大的事件間隔處切開，對切開後的子群遞迴套用規則 2–4。
5. 重疊的片段合併（合併後仍受 `max_len` 限制，超過則不合併）。

### 5.5 接續分析

每 30 秒寫入 `progress_t`。接續時從 `progress_t − 5 秒` 開始解碼，新產生的事件與既有事件依「同類型且時間差 ≤ 1 秒」去重。

## 6. 使用介面與流程（仿 Outplayed）

### 6.1 影片庫
- 卡片格狀清單：縮圖、日期、長度、擊倒／助攻數徽章、分析狀態（未分析／分析中 xx%／完成／錯誤）。
- 匯入：拖放檔案、選擇資料夾；可設定監看資料夾，新影片自動排入分析佇列（一次只分析一支）。
- 匯入時以 ffprobe 檢查：容器與編碼不在 Chromium 可播放清單（H.264、HEVC（需系統支援）、VP9、AV1，容器 MP4/WebM）中時，提示並提供「產生代理檔」。
- 搜尋 `Ctrl+F`、收藏 `Ctrl+D`、依事件類型篩選。

### 6.2 檢視器
- 播放器（Chromium `<video>`）＋ Canvas 時間軸：事件標記（依類型使用不同顏色／圖示；`counted=false` 以淡色顯示）、觀戰區間灰底、熱度條、片段框、縮放 `Ctrl + + / - / 0`。
- 點擊標記或右側事件清單 → 跳到事件前 `before` 秒播放；`Ctrl+←/→` 上一個／下一個事件；`S` 切換播放速度；`Space` 播放／暫停。
- **長片拖曳流暢度**：若原始影片關鍵影格間距過大導致拖曳卡頓，設定中可開啟「代理檔」（ffmpeg 產生低解析度、短關鍵影格間距的檔案，只用於預覽，匯出仍使用原檔）。
- 事件類型篩選勾選框。
- 快速剪輯 `Ctrl+Q`：以播放頭為事件點建立片段；拖曳片段框兩端調整長度。
- 勾選事件 → 「建立合輯」：每個事件依前後秒數變成片段，重疊合併。
- 「AI 自動剪輯」：對話框設定 `gap`、`n`、`before`、`after`、`max_len`，結果以「AI」標籤片段框加入時間軸，可調整或刪除。
- 手動修正：刪除誤判事件、`M` 於播放頭新增事件（可選類型）、切換事件的 `counted`。修正寫回快取。

### 6.3 剪輯專案
- `Ctrl+E` 把選取的片段送進專案；專案時間軸支援分割、刪除、複製、拖曳排序、微調起訖點、`Ctrl+Z / Ctrl+Y`。
- 專案存成 `.apexproj.json`（片段來源影片路徑＋起訖時間）。

### 6.4 匯出
- 模式：每段各一檔／串成一支合輯。
- 品質：
  - 「快速無損」：`-c copy`，從關鍵影格切，可能多出 1–2 秒。**串接時先以 ffprobe 比對所有來源的編碼、解析度、幀率、像素格式、音訊參數**，不一致就自動改用重新編碼並提示原因。
  - 「精準重新編碼」：依序嘗試 NVENC、QSV、AMF；皆不可用時使用 OpenH264（LGPL 版 ffmpeg 不含 libx264，見 §11）。
- 匯出前檢查磁碟空間；失敗時保留 ffmpeg stderr 供回報。

### 6.5 第一版不做
上傳分享、浮水印、畫面裁切、音軌管理、轉場特效、遊戲內錄影、OCR、英文範本的實際擷取。

## 7. 錯誤處理

| 狀況 | 處理 |
|---|---|
| 硬體解碼失敗 | 自動改用軟體解碼並在介面提示 |
| ffprobe 無法讀取／檔案損壞 | 影片庫卡片標紅並顯示原因，不中斷佇列 |
| 解析度非 16:9 | 啟用水平多尺度比對，警告「準確度可能下降」 |
| 容器／編碼無法在 Chromium 播放 | 匯入時提示，提供產生代理檔 |
| 分析中取消或程式關閉 | 依 §5.5 接續 |
| 引擎程序異常結束 | Electron 偵測到程序結束，標記錯誤並允許重試 |
| 快取所在目錄唯讀 | 改寫入 app data 並提示 |
| 串接來源參數不一致 | 自動改用重新編碼並提示 |
| 匯出磁碟空間不足／ffmpeg 失敗 | 事前檢查；失敗時顯示 stderr 摘要 |
| 範本檔遺失或 profile 格式錯誤 | 啟動時驗證，顯示明確錯誤 |

## 8. 測試

- **引擎單元測試（pytest）**：以從使用者影片擷取的 ROI PNG 作為測試資料。
  - 正例：各事件類型、提示堆疊。
  - 反例：跑圖、物品欄、死亡畫面、**觀戰畫面**、爆炸火光。
  - 名字指紋：同一敵人的紅字（擊倒）與白字（助攻）判定為相同；不同敵人判定為不同。
  - 事件追蹤、去重、觀戰區間、自動剪輯（分群、`max_len` 切割、合併）、接續分析去重、pts 換算（含 `start_time ≠ 0` 的合成影片）各自測試。
- **前端單元測試（vitest）**：時間軸座標換算、片段拖曳／合併、快捷鍵、專案時間軸編輯與復原、快取重新分析時保留手動修正的合併邏輯。
- **端到端黃金測試**：從原始長片截一段 3–5 分鐘、包含多種事件的短片（只存在本機，不提交到 repo），由 CLI 跑完整流程產生 JSON，與已確認的黃金結果比對，防止改版退化。
- **準確率評估**（`tools/evaluate`）：
  - 正確答案優先從 Outplayed 的 IndexedDB（`%LOCALAPPDATA%\Overwolf\CefBrowserCache\Default\IndexedDB\overwolf-extension_cghphpbjeabdkomiphingnegihoigeggcfphdofo_0.indexeddb.leveldb`，已確認含 `knockdown`／`assist`／`killCount` 記錄）解析，使用 `ccl_chromium_reader` 讀取 LevelDB 與 V8 序列化資料。若無法解析，改以程式的手動修正功能人工標註一支長片。
  - Outplayed 事件（遊戲即時事件）與畫面提示出現時間可能有固定偏移：評估時先以中位數估計並扣除系統性偏移，再套用 ±1.5 秒容許誤差；報告中列出估計的偏移值。
  - 輸出各類事件的召回率／精確率與漏抓、誤抓清單（含時間點，方便直接跳過去檢查）。
- **速度基準**（`tools/benchmark`）：同一支長片分別以 `-hwaccel auto` 與強制軟體解碼執行，記錄倍速；AV1 軟體解碼視為低階電腦最差情況。

## 9. 專案結構

```
apex-highlighter/
  app/          Electron + TypeScript
  engine/       Python：probe/ decode/ detect/ events/ autoclip/ ipc/
  templates/    zh-TW/ en/
  tools/        extract_templates, evaluate, benchmark, outplayed_truth
  docs/
  LICENSE       MIT
  THIRD_PARTY_NOTICES.md
```

## 10. 未來擴充（不在第一版）
- 小型 CNN 分類器（以 Outplayed 記錄或手動修正資料訓練），取代或輔助範本比對。
- OCR 高準確模式外掛（讀取敵人名稱、傷害數字）。
- 英文及其他語言範本。

## 11. 授權

- 專案程式碼：**MIT**。
- 隨附 **LGPL 版 ffmpeg/ffprobe**（不含 `--enable-gpl` 與 `--enable-nonfree` 元件），以獨立執行檔的方式呼叫（不連結），並在 `THIRD_PARTY_NOTICES.md` 註明版本、編譯設定與原始碼取得方式。
  - 解碼：內建解碼器 + dav1d（AV1，BSD）可用。
  - 編碼：NVENC／QSV／AMF 可用；**不含 libx264**，CPU 編碼改用 OpenH264（品質較差，僅在無 GPU 編碼器時使用）。「快速無損」匯出不受影響。
- 範本 PNG 擷取自遊戲畫面，屬少量介面素材；README 加註免責聲明（Apex Legends 為 Electronic Arts／Respawn 之商標，本專案與其無關）。
- Python 依賴 OpenCV（Apache-2.0）、numpy（BSD）與 MIT 相容。
