# templates/icons 範本來源

單一、與語言無關的偵測設定（`profile.json`，`templates_version = icons@1`）。事件偵測（擊倒、助攻）只用 6 張圖示樣板；
唯一與語言有關的樣板是觀戰提示條（5 張，三語言並列）。實驗過程與數字見 `docs/accuracy-report-icon.md`、
`.superpowers/sdd/icon-detect-report.md`。

## 訓練／驗收分割（誠實揭露）

| 素材 | 角色 |
|---|---|
| English.mkv、Japanese.mkv、SC1.mkv（簡中、黃名） | 訓練：圖示樣板、數值門檻（`engine/src/icon_detect.rs` 的 `IconParams`）|
| test-TC.mp4（繁中）、test-ENG.mp4、test_JP.mp4、SC2.mkv（簡中）、H771／H950（繁中） | 驗收：只量測，不得調參 |

## 圖示樣板（灰階 PNG，合計約 4 KB）

| 檔案 | 內容 | 來源 |
|---|---|---|
| chev.png | 「+N」分數右側的三層箭頭（所有加分橫幅都有） | English.mkv t=25.0 s 手動裁切的種子 |
| person.png | 箭頭右側單人圖示（擊倒、助攻擊倒） | English 種子；用 EN／JA／SC1 上圖示分數 ≥0.85 的格對齊後取中位數，裁成 17 欄 |
| group.png | 三人圖示（小隊抹殺、REVIVE、CRATE REVEAL…） | English.mkv t=172.25 s 種子＋平均 |
| skull.png | 骷髏（獨立消滅；小隊抹殺第二行也有）——只當反例 | English.mkv t=37.25 s 種子＋平均 |
| hand.png | 握手（助攻消滅） | Japanese.mkv t=1023.0 s 種子＋平均 |
| plus.png | 「+」號（擋掉大廳小隊卡片「0 ⇑人」） | English.mkv t=25.0 s 種子 |

數值門檻的依據（全部來自訓練素材）逐項列在實驗報告第 2 節。

## 敵人名字色（profile.json 的 `red`）

名字指紋用：紅（`r_min 170, g_max 195, b_max 195, r_diff_min 40`）、黃（紅／藍色盲）、粉紅（綠色盲；只在標準遮罩讀不到像樣字形時備援）。
黃／粉紅規則與 `icon_detect.enemy_color_mask` 相同；紅規則在名字指紋略寬（要讀到完整字形），
以 `tests/fixtures/colorblind`（SC1 黃、English／Japanese 粉紅、SC2 紅）挑選，目的只是名字指紋，不影響事件偵測。

## 觀戰樣板（`spectating`；語言相關的唯一例外）

觀戰區間用來把觀戰中的橫幅（隊友的擊倒）排除，不計入 N 殺（spec §5.3）。觀戰提示條是文字，沒有圖示可用，所以保留既有
樣板，引擎對**全部**樣板比對，任一命中即算觀戰，不需要使用者選語言。每個樣板帶自己的白字遮罩門檻（各語言錄影字亮度不同）。

| 檔案 | 文字 | 來源 | 白字 `v_min` |
|---|---|---|---|
| spec_zh-TW_show_flag.png、spec_zh-TW_next_mate.png | 顯示玩家旗幟／下一位隊友（繁中） | 沿用舊 zh-TW 範本（git 歷史 templates/zh-TW，繁中舊版錄影） | 200 |
| spec_en_show_flag.png、spec_en_next_mate.png | `Show Player Banner`、`Next Teammate` | English.mkv 486.25–494.5 s（同格 1.000） | 170 |
| spec_ja_show_flag.png | `プレイヤーバナー表示` | **test_JP.mp4** t=384.0 s（訓練來源 Japanese.mkv 沒有任何觀戰畫面，屬樣本內） | 200 |

| spec_zh-CN_next_mate.png、spec_zh-CN_show_flag.png | `下一个队友`、`玩家旗帜`（顯示／隱藏共用部分） | SC1.mkv t=835.0 s | 200 |
| spec_ko_next_mate.png、spec_ko_show_flag.png | `다음 팀원`、`플레이어 배너`（顯示／隱藏共用部分） | 使用者韓文錄影 Apex_2026-10-19_09-18.mp4 t=170.0 s | 200 |

簡中、韓文樣板（2026-10-19 加入）以 1 fps 掃過 SC1 全片（842 格）與兩支韓文錄影全片（819＋1330 格）驗收：只在觀戰、死亡回顧與
淘汰結算畫面命中（玩家已陣亡，與英文 `Player Banner` 的行為相同），一般遊玩 0 次誤報。韓文樣板與驗收素材同源，屬樣本內。
沒有範本的語言偵測不到觀戰（觀戰中的擊倒會被計入，使用者可手動標記）。
英文觀戰提示被 `spec_roi`（y=1028, h=40）切掉底部一小段，範本也是從同一個被切過的 ROI 裁的；若改 ROI 必須重裁。

### 三語言樣板互相誤判的量測

`engine/tests/test_icon_detect.py::test_spectating_detected_in_every_language_without_choosing_one`：
把 5 個樣板同時套在 zh-TW 86、en 113、ja 120 張 fixture 的 spec 條上（共 319 張，其中觀戰 34 張）——
觀戰畫格 34/34 命中，非觀戰 285 張 0 次誤報，即使是別的語言的樣板也沒有誤判。
限制：fixture 與日文樣板同源（test_JP），日文只有一個觀戰狀態；真實錄影的長時間誤判率另見準確度報告。
