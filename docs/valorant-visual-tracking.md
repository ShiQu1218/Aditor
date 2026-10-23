# Valorant 擊殺列追蹤與時間回溯

第一階段將純影像偵測從 `valorant-feed@6` 更新至 `valorant-feed@7`，不使用音訊。比較基準為 commit `703d355` 的純影像結果。以下保留該階段紀錄；目前 `valorant-feed@8` 的延遲與玩家標記修正另見 [後續測試](valorant-visual-followup.md)。

## 實作

- 以受害者文字形狀、列影像及合理的向上移動追蹤同一列。新出現在下方的列，即使受害者相同，也視為另一筆。
- 有隊伍底色與列邊緣、但玩家標記尚不清楚的列，先作為弱候選追蹤。只有後續通過原本的玩家標記判斷，才能建立事件。
- 最多保留 3 秒實際觀察時間；連續證據中斷超過 0.5 秒就重設。確認後回溯到同一列最早的觀察時間，沒有統一扣除秒數。
- 同一位置突然改變外觀、或已知列上方出現可能的動畫複本時，要求兩次強判斷，抑制單幀重複事件。
- 即時與離線使用同一套追蹤。這改變的是事件時間；確認等待與即時快照傳送週期仍可能讓通知較晚出現。

## 結果

真值由助手逐格檢視擊殺 HUD 首次出現時間，間隔 0.1 秒，未經獨立人工複核。配對不校正整體時間偏移，保留重複事件；先最大化一對一配對數，再最小化時間誤差。時間不符的單筆偵測會同時算一筆誤判及一筆漏判。

| 片段 | 容許誤差 | 修改前：正確／誤判／漏判 | 修改後：正確／誤判／漏判 |
| --- | --- | --- | --- |
| 原有 70 秒、11 次擊殺 | ±0.5 秒 | 7／4／4 | 11／1／0 |
| 原有 70 秒、11 次擊殺 | ±1.5 秒 | 9／2／2 | 11／1／0 |
| 未參與調整的 60 秒、6 次擊殺 | ±0.5 秒 | 5／1／1 | 5／1／1 |
| 未參與調整的 60 秒、6 次擊殺 | ±1.5 秒 | 6／0／0 | 6／0／0 |

未參與調整片段為同兩部影片的 200–230 秒及 150–180 秒，於查看這些片段的偵測結果前選定與標註，並非獨立影片驗證。Radiant 177.2 秒的擊殺仍標在 178.0 秒，顯示這次追蹤沒有解決所有延遲。

另有四部完整影片的回歸掃描；下列僅為偵測數量，**沒有全片真值，增加不代表補漏成功**。

| 影片 | 修改前擊殺數 | 修改後擊殺數 |
| --- | --- | --- |
| LFT | 8 | 8 |
| Playing Duelist | 82 | 83 |
| Radiant Visual Guide | 201 | 212 |
| ASCENSION CN 轉播 | 21 | 24 |

原有標註片段中的誤判位於 LFT 68.75 秒；舊版附近亦有 71.25 秒的錯誤標記，疑似同一列回溯後進入 60–70 秒評估窗，尚未逐列確認此對應。該影片攝影機遮擋部分擊殺列，玩家身分判斷仍需改善，不能單靠追蹤排除。

## 重現與限制

- [完整比較資料](experiments/valorant-tracking/comparison.json) 包含四片修改前後的事件時間與逐窗配對。
- [原有真值](experiments/valorant-audio/truth.json)；[未參與調整的片段真值](experiments/valorant-tracking/holdout-truth.json)。保留既有真值路徑，評估僅讀取影像標註。
- 工具 `tools/evaluate_valorant.py` 以 4 FPS 軟體解碼，不讀音訊、不寫使用者分析快取。
- 重跑：`engine\.venv\Scripts\python.exe tools\evaluate_valorant.py --video-root E:\Apex_highlighter_clip\valorant --baseline out\valorant-tracking\baseline.json --truth docs\experiments\valorant-audio\truth.json --output out\valorant-tracking\rerun.json`。baseline 格式為 `{"source":"...","videos":[{"filename":"...","events":[{"t":1.0,"type":"kill"}]}]}`，可從比較資料的 `before_videos` 還原。
- 4 FPS 有 0.25 秒取樣間距；目前解碼時間格與所選來源畫面亦有約 0.117 秒差異。因此表中的小幅負誤差不代表能預知擊殺，時間標記不是子彈命中時間。
- 舊的人工刪除／覆寫仍沿用既有 ±1 秒安全配對。回溯超過此範圍、無法配對的人工修改保留在 `unmatched`，不冒險套用到鄰近連殺；使用者需檢查這些未配對修改。

測試涵蓋弱候選不獨立產生事件、連殺、同名新列、外觀閃爍、延遲回溯、證據中斷、評估一對一配對，以及人工修改的保留。執行 `test_valorant.py`、`test_valorant_rounds.py`、`test_cache.py`、`test_layout.py`、`test_evaluate_valorant.py`、`test_live.py`（排除 slow）：113 passed、3 deselected。
