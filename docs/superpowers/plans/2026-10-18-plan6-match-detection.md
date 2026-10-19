# Aditor — 計畫 6：對局開始／結束偵測（第 4 期，離線部分 D1）

> **For agentic workers:** 你負責任務 D1。先讀規格 §3.4（已依使用者補充修訂），再讀本檔。

**Goal:** 在 Python 引擎新增「場景判斷＋對局切分」：輸入影片（或之後 live 模式的逐格小圖），輸出每一局的 `[start, end]`。本期只做離線版與驗收；接到 live 模式與 aditorrec 共享記憶體是第 3／4 期的後續任務。

**Spec:** `docs/superpowers/specs/2026-10-18-live-recording-design.md` §3.3、§3.4、R6、R6a

**資料：** `E:\Apex_highlighter_clip`（使用者提供，**唯讀，不得修改、移動或複製進 repo**）：

| 檔案 | 長度 | 內容（使用者命名） |
|---|---|---|
| `外卡模式.mp4` | 16:06 | 外卡模式（可重生），大廳排隊開始 |
| `大廳~勝利不退出直接下一場.mp4` | 18:10 | 大廳 → 勝利 → 不退出直接下一場 |
| `從上場不退出直接下一場~中途死掉，觀戰敵人同時排隊.mp4` | 3:14 | 接續上一場直接開始 → 中途死亡 → 觀戰時排隊 |
| `從上場不退出直接下一場~勝利退回大廳.mp4` | 18:27 | 接續上一場直接開始 → 勝利 → 退回大廳 |

全部 AV1、1916×1080、60 fps（注意：不是 1920 寬，座標要依實際尺寸換算到 1920×1080 基準）。

## 全域限制

- 只改：`engine/aditor/scene.py`（新）、`engine/aditor/matches.py`（新）、`engine/aditor/__main__.py`（只加子指令）、`engine/tests/test_scene.py`、`engine/tests/test_matches.py`、`engine/tests/fixtures/matches/**`、`templates/scene/**`（新）、`tools/match_truth.py`（新，可選）、`docs/accuracy-report-matches.md`（新）。**不得改動既有擊殺偵測的行為**；既有 `engine/tests` 必須全過。
- 依賴只允許既有的 `opencv-python`、`numpy`。執行 Python 一律 `engine/.venv/Scripts/python`（在主工作目錄 `D:/Develop/Aditor/engine/.venv`；worktree 內沒有 venv，直接用主工作目錄的 venv 並以 `-m pytest` 在 worktree 的 `engine/` 執行，確認 import 到的是 worktree 的 `aditor`——必要時設定 `PYTHONPATH`）。ffmpeg：`D:/Develop/Aditor/build/ffmpeg/bin`（`ADITOR_FFMPEG`／`ADITOR_FFPROBE` 環境變數，見 `aditor/ffbin.py`）。
- 判斷依**版面與圖示**（外框、面板形狀、HUD 外框），不依文字內容，維持與語言無關。範本只取自上述錄影，並在 `templates/scene/PROVENANCE.md` 記錄來源檔與時間點。
- 測試用影片路徑由環境變數 `ADITOR_MATCH_DIR`（預設 `E:\Apex_highlighter_clip`）提供，不存在就 `pytest.skip`。
- 在分支 commit（conventional commits，英文），不 merge、不 push。最後回覆為繁體中文報告。

## 步驟

1. **建立真值**：抽影格（例如每 2 秒一張）實際看畫面，標出每段錄影中每一局的開始（開局序列第一次出現：載入畫面模式卡片或倒數面板）與結束（下一局開局序列開始前一刻／大廳出現／錄影結束），以及每局內的重要片段（選角、跳傘、死亡、觀戰、結算、排隊綠框）。寫成 `engine/tests/fixtures/matches/truth.json`：`{ "<檔名>": { "duration": …, "matches": [{"start": s, "end": e, "notes": "…"}], "lobby": [[s,e],…] } }`，每個時間點附上判斷依據（看到什麼畫面）。錄影開頭若已在對局中（接續上一場），從錄影開頭算起並註明。
2. **場景分類（`scene.py`）**：單格 → `SceneFrame`：`pre_match`（載入卡片或倒數面板）、`lobby`、`in_match_hud`（對局 HUD 外框可見）、`other`。輸入為 BGR 或灰階整張畫面（任意解析度，內部換算到 1920×1080 基準後裁需要的區域）。**必須記錄每個判斷用到的區域與最低解析度**：live 模式只有 1 fps 的 320×180 灰階 thumb（規格 §3.3），若不足以判斷，列出需要額外傳的「場景 ROI」（基準座標、大小、頻率），寫進報告與 `scene.py` 的常數，第 3／4 期會把它加進 aditorrec 共享記憶體 v2。
3. **對局切分（`matches.py`）**：串流狀態機，輸入 `(t, SceneFrame)`（約 1 fps），輸出 `match_start`／`match_end` 事件與最後的 `[start, end]` 清單，規則照規格 §3.4：開始＝開局序列第一次出現（180 秒內沒出現 HUD 就撤銷）；結束＝下一局開局序列、大廳連續 ≥ 15 秒、輸入結束三者最早；死亡／觀戰／HUD 消失都不是結束。需要的遲滯與門檻設成具名常數。
4. **CLI**：`python -m aditor matches <video> [--fps 1]` → stdout JSON：`{"matches":[{"start":…,"end":…}],"timeline":[[t,"scene"],…]}`（timeline 選擇性輸出 `--timeline`）。解碼沿用 `ffbin`，可用硬體解碼，整張畫面縮到判斷需要的最低解析度再交給 Python。
5. **驗收**：4 段錄影跑 CLI 與真值比對：每局起訖誤差 ≤ 5 秒、不漏局、不多切。寫 `docs/accuracy-report-matches.md`：每段每局的真值／偵測值／誤差、場景分類混淆矩陣（以真值片段抽樣）、處理速度、已知限制。
6. **測試**：`test_matches.py` 用合成序列覆蓋所有規則（直接下一場、回大廳、取消配對撤銷、可重生模式死亡後回戰場、開地圖導致 HUD 短暫消失、錄影從對局中途開始）；`test_scene.py` 用 `fixtures/matches/` 下的少量小尺寸截圖（只存判斷需要的裁切區域、縮小後 PNG，總量 < 2 MB）驗證各場景分類；整段錄影驗收測試讀 `ADITOR_MATCH_DIR`。
