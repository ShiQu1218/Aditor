# 對局切分準確度報告（第 4 期離線版 D1）

日期：2026-10-18
程式：`engine/apexhl/scene.py`（場景外框比對）、`engine/apexhl/matches.py`（串流切分）、CLI `python -m apexhl matches <video>`
真值：`engine/tests/fixtures/matches/truth.json`（逐 0.25 秒人工判讀，附依據）
範本：`templates/scene/`（來源見 `templates/scene/PROVENANCE.md`）

## 結果（1 fps 取樣）

| 錄影 | 長度 | 真值局數 | 偵測局數 | 每局 起／訖 誤差（秒） | 處理速度 |
|---|---:|---:|---:|---|---:|
| 外卡模式 | 965.8 s | 1 | 1 | +0.50 / 0.00 | 21× 即時 |
| 大廳~勝利不退出直接下一場 | 1089.6 s | 1 | 1 | +0.50 / 0.00 | 22× |
| 從上場不退出直接下一場~中途死掉，觀戰敵人同時排隊 | 194.0 s | 2 | 2 | 0.00 / +0.25；+0.25 / 0.00 | 21× |
| 從上場不退出直接下一場~勝利退回大廳 | 1107.3 s | 2 | 2 | 0.00 / +0.75；+0.75 / +0.75 | 22× |

全部 6 局的起訖誤差 ≤ 0.75 秒（驗收標準 ±5 秒），無漏局、無多切。誤差主要來自 1 fps 取樣。

## 判斷方式

- 場景只看外框與版面（640×360 灰階、帶遮罩的 `TM_CCOEFF_NORMED`）：開局序列＝模式卡片箭頭＋載入／外卡底板；大廳＝「就緒」按鈕外框＋左下模式選擇框；對局 HUD＝小地圖外框＋左下血條（一般／積分／觀戰三種版面）；總結分頁只用來辨識「錄影從上一局局尾開始」。
- 切分規則（規格 §3.4，已依本次結果修訂）：
  - 開始＝開局序列首次出現，180 秒內未見 HUD 則撤銷。
  - 結束＝下一局開局序列，或大廳**連續兩次取樣**（1 fps 下約 1 秒）後的暫定結束——30 秒內沒有回到對局 HUD 才確定，時間取大廳首次出現；或輸入結束。
  - 原本「大廳連續 15 秒」的規則在「勝利退回大廳」錄影中失敗：回到大廳約 2.5 秒後玩家就開組合包，畫面不再是大廳主畫面，結束被推到錄影結尾（誤差 17 秒）。

## 錯過倒數後以 HUD 恢復開局（2026-10-18）

- 新增 `HUD_RESUME_CONFIRM_SECONDS = 3.0`：沒有進行中的對局、也沒有待確認的開局時，HUD 連續跨越至少 3 秒便以 `hud_resume` 開始，時間回溯到這段第一個 HUD 樣本。非 HUD（包含未知／黑畫面的 `other`）或超過 `_max_gap` 的取樣間隔會重算。原有 `opening_confirmed`、立即恢復的 `initial_match`／`initial_summary` 與結束規則不變。
- live 直接轉送 `MatchTracker.feed()`／`finish()` 的事件與 `reason`，沒有原因白名單；`matches` CLI 只輸出區間及選用的場景時間軸，兩者均不需修改介面。新增的 live 測試以既有大廳／HUD 拼圖還原全畫面，穿插黑畫面，經共享記憶體驗證 `hud_resume` 與 EOF 事件。
- 決策：未知畫面沿用 `other`，不增加場景種類或依賴。現有截圖只涵蓋稀疏時點，無法證明真實錄影的連續 3 秒，因此下列 Alt-Tab 驗證使用完整解碼後的 1 fps 場景串流；原始錄影全程唯讀，沒有複製到專案。

執行環境：在此工作樹的 `engine/`，使用 `D:/Develop/Apex_highlighter/engine/.venv/Scripts/python.exe`，設定 `PYTHONPATH=D:/Develop/Apex_highlighter/.worktrees/hud-start/engine`；已用 `import apexhl; print(apexhl.__file__)` 確認載入此工作樹。未設定 `APEXHL_FFMPEG`。四部影片逐一執行 `python -m apexhl matches <video> --timeline`（預設 1 fps），依 `truth.json` 比較局數及各起訖誤差。

重跑結果與上表的局數及起訖誤差完全相同：**6/6 局、0 漏局、0 多切，最大誤差 0.75 秒**。偵測區間依表列順序為 `[22, 965.8)`、`[4, 1089.569333)`、`[0, 1)`／`[1, 193.990667)`、`[0, 11)`／`[11, 1091)`。

Alt-Tab 模擬選用「大廳~勝利不退出直接下一場」：第一個開局序列樣本為 4 秒，真值的跳傘 HUD 里程碑為 60 秒，將 **4–80 秒（含端點）**改成 `other`。恢復後第一個 HUD 為 **81 秒**，**84 秒**送出 `match_start(t=81, reason="hud_resume")`；最後仍只有 `[81, 1089.569333)` 一局，沒有額外切分。起點與第一個恢復的 HUD 樣本誤差為 **0 秒**；遮蔽期間的真實開局時間無法還原。

可從 `engine/` 重現（下列 `python` 指上述 venv）：

```python
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from apexhl.matches import MatchTracker
from apexhl.scene import SceneFrame

video = Path("E:/Apex_highlighter_clip/大廳~勝利不退出直接下一場.mp4")
doc = json.loads(subprocess.check_output([
    sys.executable, "-m", "apexhl", "matches", str(video), "--timeline",
]))
tracker = MatchTracker()
for t, kind in doc["timeline"]:
    scene = SceneFrame("other" if 4 <= t <= 80 else kind)
    for event in tracker.feed(t, scene):
        print(t, asdict(event))
tracker.finish(1089.569333)
assert [(m.start, m.end) for m in tracker.matches] == [(81, 1089.569333)]
assert tracker.events[0].reason == "hud_resume"
```

測試先行：先確認新增的 HUD 恢復測試在實作前失敗，再實作並執行下列檢查（同樣從 `engine/` 使用上述 venv）：

- `python -m pytest tests/test_matches.py tests/test_live.py -q -k 'not recording and not golden' --tb=short`：**69 passed、9 deselected**，涵蓋短暫 HUD、未知畫面重算、不同取樣週期的斷樣、恰好 `_max_gap`、過期開局、下一局恢復與 live 事件轉送。
- `python -m pytest ../engine/tests -q --tb=short`（等同工作樹根目錄的 `python -m pytest engine/tests -q`）：**390 passed、3 skipped、1 xfailed**，耗時 427.30 秒。3 項略過皆為未設定 `APEXHL_GOLDEN_VIDEO`；預期失敗為既有的舊賽季「敵方小隊已消滅 +50」圖示限制。
- `git diff --check`：通過。

## live 模式需要的輸入

`classify` 需要 ≥ 640×360 的全畫面灰階，apexrec 現有的 320×180 thumb **不夠**。各判斷區域與最低尺寸列在 `scene.py` 的 `SCENE_ROIS`（基準座標、最低像素尺寸、1 fps）。第 3／4 期接 live 時，二選一：把 thumb 提高到 640×360（GRAY8，230 KB/s @1 fps），或在共享記憶體 v2 加入 `SCENE_ROIS` 各區塊。前者最簡單，讀回量仍遠低於 0.5 MB/s 預算。

## 限制

- **樣本內結果**：前三段錄影同時用於取範本與調門檻，第四段只用於驗證；總共只有 6 段對局區間，不代表跨模式、跨賽季或 UI 改版後的準確率。
- 只看過繁體中文介面與這幾種模式（積分賽、外卡）；其他模式（例如有不同載入畫面的限時模式）需要更多錄影。
- 解析度與比例：已處理 1916×1080；超寬螢幕（21:9）未驗證。
- 外框範本依賴目前 UI 外觀，遊戲改版後可能需要重新取樣。
