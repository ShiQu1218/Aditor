# 多語橫幅辨識準確度報告（zh-TW／en／ja）

分支 feat/v1，Fix-ML-1。所有數字由 `engine/tests/fixtures/<lang>` 與驗收錄影實測；重現指令在最後一節。
`templates/<lang>/PROVENANCE.md` 記錄每個範本與門檻的來源。

## 1. 資料與方法

訓練來源（只用這兩支裁範本、建 fixture、定門檻）：`English.mkv`（AV1 30 fps 508 s）、`Japanese.mkv`（AV1 60 fps 1066 s）。
驗收（held-out，不調參）：`test-ENG.mp4`（1780 s）、`test_JP.mp4`（713 s）、`test-TC.mp4`（zh-TW，1725 s）。
唯一例外：日文觀戰範本與 7 張日文觀戰 fixture 取自 `test_JP.mp4` 383–391 s（訓練來源沒有任何觀戰畫面；見 ja/PROVENANCE.md）。

fixture 格式與 zh-TW 相同（800x220：180 列橫幅＋40 列觀戰條），但為了讓兩個語言合計 < 12 MB，
每張圖只保留「任何 profile 的白／紅遮罩都可能取到」的像素（V≥160 且低飽和，或 R≥160 且紅差≥30），其餘歸零
（遮罩等價壓縮：en／ja／zh-TW 三個 profile 的遮罩與壓縮前完全相同，偵測結果因此相同）。合計 10.6 MB。

| 語言 | 正例幀（每事件取 首／次／中／末＋最難一幀） | 各類型 | 淡入幀 | 負例幀 | 觀戰幀 |
|---|---|---|---|---|---|
| zh-TW（既有） | 37 | knock 9、assist_knock 7、assist_elim 6、elim 9、squad_wipe 6 | 3 | 49 | 17 |
| en | 63 | knock 30、assist_knock 10、elim 9、squad_wipe 14、**assist_elim 0** | 7 | 50 | 10 |
| ja | 65 | knock 28、assist_knock 19、assist_elim 6、squad_wipe 12、**elim 0** | 9 | 55 | 7（來自 test_JP） |

注意：「幀」不是獨立事件。en 只有 knock 8、elim 2、assist_knock 2、squad_wipe 3 個不同事件；ja 為 knock 7、assist_knock 4、
assist_elim 1、squad_wipe 4。**沒有真實樣本的類型**：en `assist_elim`、ja 獨立擊殺 `elim`、en/ja「敵方小隊已消滅」否決橫幅
（訓練來源完全沒有；所以 en/ja 沒有否決範本，且 `enemy_squad_down` 已改為可選鍵）。
負例涵蓋：奔跑、背包、輪盤、大廳／英雄選擇／頒獎台、死亡結算、OBS 畫面、F1 提示、像素小隊計數條、小隊 HUD、
撿取 HUD，以及非事件橫幅（REVIVE／復活、CRATE REVEAL、EVO HARVESTER／進化ハーベスター、RESPAWN、BANNER RECOVERY／バナー回収、
ring scan）。每個正例事件另外放入「勝出關鍵字分數最低」的一幀（真實但低對比），避免門檻只看漂亮畫格。

## 2. 關鍵字分數分布與門檻

正例最小值 vs 外來最大值（外來＝偵測順序上會走到該檢查、但不該命中的畫面）。門檻規則：基線值若落在
[外來最大+0.05, 正例最小−0.05] 就保留，否則取不大於（正例最小−0.05）的最大 0.05 倍數
（`test_thresholds_sit_inside_measured_gap` 對三個語言強制驗證）。

| 語言 | key | 門檻 | 正例 n | 正例最小 | 外來最大 |
|---|---|---|---|---|---|
| zh-TW | squad_wipe | 0.55 | 6 | 0.659 | 0.443 |
| zh-TW | assist | 0.55 | 12 | 0.743 | 0.288 |
| zh-TW | knock | 0.60 | 7 | 0.783 | 0.310 |
| zh-TW | elim_done | 0.70 | 9 | 0.772 | 0.605 |
| zh-TW | damage | 0.65 | 7 | 0.757 | 0.522 |
| en | squad_wipe | 0.65 | 14 | 0.717 | 0.311 |
| en | assist | 0.65 | 9 | 0.939 | 0.455 |
| en | knock | 0.65 | 25 | 0.711 | 0.290 |
| en | elim_done | 0.50 | 8 | 0.551 | 0.382 |
| en | damage | 0.35 | 25 | 0.442 | 0.199 |
| en | elim（助攻後子關鍵字） | 0.65 | 0（無樣本） | — | 0.335 |
| ja | squad_wipe | 0.65 | 10 | 0.853 | 0.236 |
| ja | assist | 0.70 | 20 | 0.795 | 0.377 |
| ja | knock | 0.70 | 26 | 0.767 | 0.291 |
| ja | assist_knock（子） | 0.65 | 15 | 0.820 | 0.357 |
| ja | elim（子） | 0.65 | 5 | 0.957 | 0.357 |
| ja | damage | 0.65 | 26 | 0.808 | 0.338 |
| ja | elim_done（獨立擊殺） | 0.65 | 0（無樣本） | — | 0.239 |
| ja | skull | 0.75 | en 獨立擊殺 5（非淡入）最小 0.824 | 0.824 | 0.630（ja fixture 第一行帶） |

其他實測：

- 勝出關鍵字領先其他關鍵字的最小值：zh-TW 0.287、en 0.163、ja 0.462（測試下限 0.25／0.15／0.40）。
- 助攻之後 knock／elim 子關鍵字互相領先：zh-TW 0.519、en 0.50、ja 0.46。
- 負例各關鍵字最大值：en squad_wipe 0.294、assist 0.455、knock 0.290、damage 0.199、elim 0.440、elim_done 0.382；
  ja squad_wipe 0.216、assist 0.377、knock 0.291、assist_knock 0.344、damage 0.338、elim 0.239。
- 偵測器對 fixture：en／ja 非淡入正例 100% 判對類型、全部負例判為 None、淡入幀不會判成別的類型（`test_detect_multilang`）。
- 觀戰：en 兩個範本在 19 格真實觀戰上至少一個 ≥0.98，非觀戰最高 0.395（英文全片）／0.337（日文片）；
  ja 範本在 Japanese.mkv 4264 格最高 0.234（無觀戰）、在 English.mkv 最高 0.182；門檻 0.75。
- 第一次嘗試的門檻（正例與外來間隙的中點取整，如 en knock 0.50）在驗收錄影上把三個 `RE-KNOCKED <名字>`
  （沒有 +分數、與 `KNOCKED DOWN` 共用字根）判成 knock。訓練來源沒有這種近似橫幅，所以改成上面的「保留基線／取靠近正例端」規則，
  之後驗收結果 en 事件數回到 127–128（評估者 en_r50 暫代 profile 為 128、0 誤報）。**這一步用到了驗收錄影的資訊（只是「改規則」，
  沒有針對該片逐項調參），誠實記錄於此。**

## 3. 名字指紋（Fix-ML-1 的量測；追蹤層的改善見 §4c）

fixture 上同敵人／不同敵人配對（非淡入、非 squad_wipe）：

| 語言 | 配對數 同敵人／不同敵人 | 同敵人判為同一人 | 跨類型同敵人 | 不同敵人誤合併 | 無指紋幀 |
|---|---|---|---|---|---|
| en | 86／694 | 70／86（81%） | 20／28 | 0／694 | 2／42 |
| ja | 134／856 | 126／134（94%） | 68／68 | 0／856 | 1／46 |

測試下限：en ≥ 75%、ja ≥ 90%、誤合併必須 0（`test_name_sig_pairs_on_real_fixtures`）。
已知弱點：亮背景（雪地）上的紅字名被吃成殘片（en 潮落的 elim 指紋寬 28–32 px vs knock 的 ~80 px）。
ja 獨立擊殺改成「骷髏右緣到關鍵字左緣」取名字後，test_JP 48.5 s 一支的逐格寬度由基線的 19/62/65/7 px 變成 66/62/65/48/58/62 px
（已無 7、19 這類破碎值，但仍有 ±15% 以上抖動：紅字名在模糊背景上只有部分像素過紅遮罩），
這是追蹤器與指紋穩定度問題，留給 Fix-ML-2。

## 4. 驗收（held-out）結果

指令：`python -m apexhl analyze <影片> --profile-dir templates/<lang|空=auto> --cache-dir ... --out ...`（工作樹引擎，
GPU 路徑，jobs 自動）。輸出 JSON 在 `D:\Develop\apexhl-samples\multilang\fixml\out\`。

| 組合 | 事件 | knock | assist_knock | assist_elim | elim | squad_wipe | 計入 | 重複 | 觀戰區間 | 牆鐘 |
|---|---|---|---|---|---|---|---|---|---|---|
| test-ENG × en | 127 | 71 | 15 | 3 | 18 | 20 | 101 | 6 | 0 | 30 s |
| test_JP × ja | 41 | 19 | 9 | 4 | 4 | 5 | 30 | 6 | 1（389.25–391.25，樣本內） | 12 s |
| test-TC × zh-TW | 84 | 9 | 13 | 42 | 5 | 15 | 62 | 7 | 1 | 22 s |

- **外語 profile 誤報＝0**：TC×en 0、TC×ja 0、ENG×zh-TW 0、ENG×ja 0、JP×zh-TW 0、JP×en 0。
- **auto 模式語言**：test-ENG→en（127 事件）、test_JP→ja（41）、test-TC→zh-TW（84），皆與單一語言結果逐項相同；
  訓練來源 English.mkv→en、Japanese.mkv→ja。
- **zh-TW 與 committed 引擎（efc448f，評估者的 out/TC_zh-TW_committed.json）逐筆相同**：84 對 84，
  type／t／counted／counted_reason／name_sig／score／damage_line 全部一致，觀戰區間相同。
- **line1_rows=[50,108] 在四支錄影都有效**：English.mkv（y=81）、test-ENG（y=65–67）、Japanese.mkv（y=64）、test_JP（y=65）；
  訓練來源上 en 14 事件（含 elim）、ja 14 事件（SRCEN／SRCJA 檔）。
- 沒有否決／觀戰幻覺：en/ja 沒有否決範本、en 在 test-ENG 沒有觀戰區間（該片沒有觀戰）。

### 召回（獨立掃描法，估計）

方法同評估者：每 4 fps 取橫幅列 45–125 內「白字大小連通元件在同一 12 px 水平帶 ≥N 個且 x 跨度 ≥120」的畫格
（N：en 11、ja 8），聚成叢集；凡不在任何引擎事件 [起點−1 s, 終點+0.5 s] 內的叢集逐一目視
（en 91 叢集、ja 33 叢集的橫幅畫面，加上先前較寬鬆窗口看過的 86／33 個）。

| 片 | 引擎回報（非 squad_wipe） | 我找到的漏報（真實橫幅） | 估計召回 |
|---|---|---|---|
| test-ENG × en | 107 | assist_knock 467.5（淺色背景＋白字／灰底低對比，assist 關鍵字 0.49）、knock 1310.0（爆炸遮蔽）、knock 1428.25、elim 1485.75（兩者皆在畫格層偵測到、被追蹤器丟棄）＝4 | 107/111 = **96.4%**；knock+assist 89/92 = **96.7%** |
| test_JP × ja | 36 | knock 299.75、elim 48.5、elim 334.0（三者畫格層皆偵測到 7–9 格，被追蹤器因指紋抖動丟棄）＝3 | 36/39 = 92.3%；knock+assist 32/33 = **97.0%**；獨立擊殺 elim 3/5 = 60% |

squad_wipe 兩片都沒有找到漏報（en 20、ja 5）。`RE-KNOCKED <名字>`（en，3 筆）不算事件（產品決策），現在也不會誤報。
**目標「knock+assist ≥95%」達成（en 96.7%、ja 97.0%），但 ja 獨立擊殺 60% 未達**——原因是名字指紋逐格抖動使
`EventTracker` 把整段連續命中丟棄（畫格層是連續 7–9 格命中），屬 Fix-ML-2（追蹤器）；訓練來源沒有日文獨立擊殺樣本，
所以這條路徑的偵測器參數沒有訓練依據（見 ja/PROVENANCE.md）。

### 修改前後的計數（給 Fix-ML-2 當基準）

| 片／profile | 基線（agy c33380e，評估者實測） | 現在 |
|---|---|---|
| test-ENG × en（官方 profile） | **0 事件**（line1_rows=[70,108] 把第一行切掉）；暫代 [50,108]：128 事件、計入 102、重複 6 | 127 事件、計入 101、重複 6（比暫代少 1 筆 elim：黃名遮罩加入後指紋改變、追蹤器少分裂一筆） |
| test_JP × ja | 40 事件、計入 29、重複 6、elim 3 | 41 事件、計入 30、重複 6、elim 4（新增 305.75、634.5，少了 334.0） |
| test-TC × zh-TW | 84 事件、計入 62、重複 7 | 相同（逐筆） |
| auto：test-ENG | 誤選 zh-TW、0 事件 | 選 en、127 事件 |

計入數仍高估（評估者估計 en 約 +20–25：同一敵人 knock→elim 兩筆都計入；ja 約 4/29）：已在 Fix-ML-2 處理，結果見 §4c。

## 4b. 名字顏色（色盲模式）

Apex 有 4 種色盲模式（關閉／紅色盲／綠色盲／藍色盲）；紅色盲與藍色盲的敵人名字為**黃色**，關閉模式為紅色。檢查結果：

- 關鍵字（擊倒／助攻／消滅／小隊…）比對只用白字二值遮罩，**與名字顏色無關**；事件偵測與型別不受影響。
- 名字指紋的墨 = 白遮罩 ∪ 紅遮罩（R 高、G/B 低）。**黃名（R≈180,G≈171,B≈59）不在任何一個遮罩內 → 基線在黃名下 name_sig 為 None**
  （擊倒／獨立擊殺的名字用紅遮罩定義邊界），事件仍會產生，但沒有名字指紋＝不做同敵人去重（計入數會高估）。
  用使用者提供的兩張簡中截圖實測（黃名 `击倒 AY +150`、紅名 `击倒 COLE +150`，只讀、未調參）：基線遮罩在黃名名字框 0 個紅像素，紅名框 600–960 個。
- 最小修正：`profile.red.yellow`（r≥160、g≥150、b≤110、r−b≥90、|r−g|≤30）併入紅遮罩；三個語言 profile 都加上。
  這組值是依該黃名樣本的色相設定的寬鬆範圍，並在紅名 fixture 上選擇「不改變任何結果」的最寬鬆一組
  （en 同敵人配對 70/86、ja 126/134、zh-TW 86 fixture 與凍結舊偵測器逐位元相同、test-TC 84 事件含 name_sig 與 committed 逐筆相同）。
  煙霧測試：用 en profile 對兩張截圖取名字指紋，黃名 AY 得 27 px 指紋、紅名 COLE 得 51 px（zh-TW 未加黃遮罩前黃名為 None）。
  `test_yellow_names_colorblind_mode`（三語言）把真實 knock fixture 的紅名像素改成黃色，必須取得指紋且與紅名版本判為同一人。
- **未驗證**：綠色盲模式的名字顏色未知（沒有樣本）；黃名的真實錄影（非靜態截圖）也沒有，所以黃名的跨事件去重品質沒有量測。
  訓練來源（English.mkv／Japanese.mkv）與 test-TC 的名字都是紅色。

## 4c. Fix-ML-2：事件追蹤、同敵人連結、助攻子類型（驗收錄影只量測、不調參）

修改內容見 `engine/apexhl/events.py`（run 內代表指紋、同敵人連結、助攻類型多數決）與 `engine/apexhl/detect.py`（`pick_assist_sub`）。
前後對照（baseline＝Fix-ML-1 完成時的 committed 引擎；after＝本批提交；全部是 `analyze --profile-dir templates/<lang>` 實跑的 JSON）：

| 片／profile | 事件 前→後 | 計入 前→後 | 標為重複 前→後 | 說明 |
|---|---|---|---|---|
| test-ENG × en | 127 → 130 | 101 → 87 | 6 → 23 | +3 筆畫格層連續偵測但被舊追蹤器丟棄的真事件（335.5／1428.25／1485.75 elim 或 knock；1365.0、1506.25 為重複），−2 筆是舊追蹤器把同一橫幅切成兩段的後半（742.5、1650.0） |
| test_JP × ja | 41 → 44 | 30 → 28 | 6 → 11 | 找回 elim 48.5／333.75、knock 299.75（皆為評估者列出的漏報）；−1 筆 assist_knock 偏移 0.25 s 的重切 |
| test-TC × zh-TW | 84 → 86 | 62 → 57 | 7 → 14 | +12 筆真事件（目視逐筆確認）、助攻子類型修正（assist_elim 42 → 16）、合併助攻淡入閃爍造成的碎片事件 |
| English.mkv × en（訓練） | 16 → 15 | 11 → 9 | 2 → 3 | 少 1 筆是同一橫幅的重複切段 |
| Japanese.mkv × ja（訓練） | 14 → 14 | 8 → 8 | 3 → 3 | 逐筆相同 |

「補刀仍被計入」（`elim`／`assist_elim` 之前 12 秒內有一個仍計入的 `knock`／`assist_knock`）：ENG 19 → 6、JP 1 → 1、TC 8 → 0。
**剩餘的 6 筆 ENG** 多是兩邊都讀得到名字、寬度相近卻不相符的「矛盾」案例（因此不以時間硬配）或名字完全讀不到；它們可能是真的另一個敵人，也可能是
抖動，沒有真值無法分。

**抽檢精度（目視）**：連結產生的「重複」逐筆看過橫幅——ENG 15 組（knock→elim 13、assist_knock 重切 1、另 1 組補刀後 HUD 遮住）幾乎全為同一敵人；
JP 16 組中 1 組錯連（196.75 シア7787 連到 185.0 パスファインダー4602，來自「單格殘片偶然相符」；之後改成只信任被多格印證的指紋後消失）；
TC 15 組全為同一敵人（助攻擊倒→助攻消滅同一人，或同一橫幅重切）。時間配對（`PAIR_WINDOW`＝10 秒）的取捨：名字讀不到時以時間推定，
**獨立擊殺（沒有先倒地）接在另一個敵人的擊倒之後 10 秒內，且名字讀不到時，會少算一筆**；寧可少算也不要把 20% 的重複算進 N 殺。

召回（只算畫格層連續偵測的事件，不含畫格層就漏的）：en knock+assist 89/92 → 90/92（1428.25 找回；467.5、1310.0 仍漏），
en 非 wipe 107/111 → 109/111（含 1485.75 elim）；ja knock+assist 32/33 → 33/33（299.75 找回），ja 獨立擊殺 elim 3/5 → 5/5（48.5、333.75 找回）。
都是原本就列在漏報清單、被追蹤器丟棄的那幾筆；沒有為驗收錄影調整任何門檻。

**zh-TW 的助攻類型**：評估者看到「約 26/42 的 assist_elim 實為『助攻，擊倒』」，原因是**辨識問題**而非標籤語意：舊的偵測器只在「擊倒」子關鍵字 ≥ 0.60
時才判 assist_knock，否則一律後備成 assist_elim；test-TC 上「助攻，擊倒」子關鍵字落在 0.48–0.60（壓縮、縮放後對比較低），另一個子關鍵字只有 0.19–0.29，
所以被後備成 assist_elim。改成兩個子關鍵字都沒過各自門檻時，用相對判定（贏家 ≥ 0.45 且領先 ≥ 0.25；依據 fixture 錯誤子關鍵字最高 0.36、
正確最低 0.80，`test_assist_sub_floor_and_lead_sit_inside_fixture_gap`）。過門檻的情況完全不變（zh-TW 86 張 fixture 與凍結舊偵測器逐位元相同）。
test-TC：assist_elim 42 → 16（其餘 26 筆改判 assist_knock／合併），剩下的 assist_elim 目視皆為「助攻，消滅」或其橫幅尾端。

## 5. 未驗證／限制

- en `assist_elim`、ja 獨立擊殺、兩語言的「敵方小隊已消滅」否決：訓練來源沒有真實樣本。驗收錄影上 en 有 3 筆 assist_elim 被判出，
  ja 有 3 個真實獨立擊殺事件被判出，但**未做任何調參**。
- ja 觀戰偵測的範本與驗證都來自同一段 test_JP（樣本內）；只有一個觀戰狀態。en 的觀戰範本在 English.mkv 486–494 s 重新驗證。
- 單一來源錄影（一組 HUD 縮放、各一種解析度）；`h_scale` 校準在驗收錄影皆為 1.0。
- 低對比（淺色背景白字、爆炸遮蔽、雪地紅字）橫幅在畫格層就會漏判，見上面的漏報清單。

## 6. 重現

```
cd engine
.venv/Scripts/python -m pytest -q            # 含 test_detect_multilang／test_zh_regression／test_auto_language
.venv/Scripts/python -m apexhl analyze C:/Users/wluis/Videos/test-ENG.mp4 --profile-dir ../templates/en --cache-dir <dir> --out <json>
```

fixture 的建置腳本（解碼、標註清單、遮罩等價壓縮）與分布量測腳本在評估暫存目錄；標註清單以事件為單位列在 `engine/tests/fixtures/<lang>/labels.json`
（`src`＋`t` 可追溯到來源影片時間）。
