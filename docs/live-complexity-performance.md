# 即時錄影資料處理優化（2026-10-31）

## 實作

- Apex Run 增量維護連續類型的切割點及 continuation 最大時間；切割點查詢由 O(F) 降為 O(1)，同一長 Run 的累積掃描由 O(F²) 降為 O(F)。重播與 reset 會重新建立統計，其他名稱辨識與分割規則不變。
- Apex snapshot 以原始完整事件及觀戰區間比較快取推導結果，包含既有事件修正、控制模式事件、區間延長及校正重播。內容未變時不再排序與 derive；原始快照複製、內容比較及 JSON 建立仍為 O(E+S)，沒有宣稱整個快照 O(1)。
- derive 的觀戰區間改為排序、前綴最大結束時間及二分搜尋，這部分由 O(ES) 降為 O(S log S + E log S)，其餘事件排序與名稱去重成本仍存在。
- Valorant 回合精華先排序有效事件，再二分選出各回合候選；保留原本回合輸入順序、重疊回合優先權、重複事件 ID 及同時刻排序。成本 O(E log E + R log E + Q)，Q 是各回合候選總數；極端重疊仍可能達 O(RE)。
- LiveSession 使用序號 Set 與原地 append，新增及查詢由 O(S) 改為平均 O(1)，對外 state 仍回傳陣列副本。刪除成功後同步移除 Set 序號。
- 分段清理改用比賽時間區間索引，由 O(SM) 降為 O(M log M + S log M)。路徑驗證、引擎健康檢查、辨識進度、pending 保護及寫入刪檔標記的順序不變。
- 引擎 stats 新增 snapshot_cpu_ms，代表自上次 stats 以來快照計算的累積 process CPU 毫秒；每次 stats 後歸零。原 cpu_ms_per_frame 定義不變。量測涵蓋快照推導、JSON 建立及比對，不含後續 stdout 序列化傳送。

## 合成資料效能

本機 Windows，同一程序暖機後五次中位數，單位 ms。Rust 使用專案 test profile（opt-level=2），不是 release。未量測遊戲 FPS 或硬體編碼效能。

| 操作 | 1,000 筆 前→後 | 2,000 筆 前→後 | 4,000 筆 前→後 | 8,000 筆 前→後 |
|---|---:|---:|---:|---:|
| Run 類型切割點檢查 | 0.871→0.138 | 3.053→0.272 | 11.429→0.503 | 45.126→1.033 |
| Valorant 回合精華 | 1.773→0.161 | 6.531→0.306 | 27.454→0.666 | 117.589→1.325 |
| 逐筆新增所有分段 | 5.427→0.248 | 23.072→0.237 | 93.684→0.446 | 101.476→0.974 |
| 選出可清理分段 | 2.343→0.078 | 6.472→0.130 | 24.339→0.259 | 66.148→0.443 |

Run 測試為同一長 knock 提示，每新增樣本就查切割點，前後共用目前的新增流程，只比較完整掃描與增量查詢；不是整個 EventTracker 或影像辨識耗時。回合測試每十事件一回合、互不重疊。分段測試每兩秒一段，每十段一場短比賽；清理只量測純選擇，不含磁碟刪除。新增分段的新流程包含 LiveSession 通知事件成本。這些輸入用來觀察成長趨勢，不代表一般遊戲的事件密度。

## 驗證與重跑

- 原有錄影相關 78 項測試通過；新增 100 組清理索引差異測試及分段公開快照／去重檢查。
- Rust library 31 項測試通過；新增增量統計與原掃描比對（包含 reset）、快照快取事件修正及觀戰區間變更檢查。
- 新增 100 組回合精華差異測試，包含亂序、重複 ID 與重疊回合；既有 derive/autoclip parity、derive、Valorant round parity 及即時 CLI parity 通過。
- TypeScript typecheck 通過。ESLint 配置未涵蓋這次變更的 main 檔案，未將略過視為 lint 通過。
- synthetic_and_stretched_capture_live_match_offline 已通過（包含原比例與拉伸影格、即時／離線結果比對）。最初誤用 PATH 的 MSYS2 FFmpeg，該版本缺少 libopenh264；執行 scripts/fetch-ffmpeg.ps1 安裝專案指定版本並通過 SHA256／元件驗證後，改用 build/ffmpeg/bin 重跑成功。未修改測試斷言或編碼設定。另兩個真實影片長測試仍依原設定略過。

在 app 目錄（PowerShell）：

```powershell
$env:ADITOR_PERF='1'
npx vitest run src/main/recording/live-complexity.test.ts --reporter=verbose --silent=false
```

在專案根目錄（PowerShell，使用專案指定 FFmpeg）：

```powershell
./scripts/fetch-ffmpeg.ps1
$env:PATH = "$(Join-Path $PWD 'build/ffmpeg/bin');$env:PATH"
cargo test --manifest-path engine/Cargo.toml --test live synthetic_and_stretched_capture_live_match_offline
cargo test --manifest-path engine/Cargo.toml --lib benchmark_tracking -- --ignored --nocapture
cargo test --manifest-path engine/Cargo.toml --test live_complexity -- --include-ignored --nocapture
```

未改動擷取、GPU 色彩轉換、硬體編碼、補影格、封裝或磁碟同步；未新增套件。遮罩樣板比對先保留原實作，避免未量測就改動辨識的浮點累加與門檻結果。

一般測試可使用 `./scripts/test.ps1 -Tier fast`；此入口會檢查隨附 FFmpeg 並自動設定測試用 PATH。直接執行 cargo test 時仍需依上方指令指定正確環境。

## FFT 頻譜快取容量（2026-10-31）

症狀：即時偵測每影格 20.9 ms 牆鐘時間（不重複影格）。歸因：穩態 `Detector::prepare` 每影格約 41 次頻譜快取未命中，其中約 35 次是固定不變的 mixtape／icon 樣板頻譜；每影格工作集（約 41 筆）大於 LRU 上限 40 筆，LRU 循環淘汰，樣板 FFT 每影格重算。

設定：AMD Ryzen 7 7700、RTX 5080（32.0.16.2101）、release（thin LTO）、git e61bc99、`tests/parity/phase_c` 的 3 張 banner（800×180）與 8 張 spec（480×118）輪替，每次呼叫翻轉稀疏低位元使每個 ROI 裁切都不同；交錯 A/B 各 3 輪，取中位數。

| 指標（ms/影格） | 上限 40 | 上限 128 |
|---|---:|---:|
| `LiveKills::feed` 不重複影格（新增 `unique_frame_detection_performance`） | 20.94 | 15.78 |
| 穩態 `Detector::prepare` | 19.96 | 15.23 |
| 校正階段（multi.features + chev_best + mixtape + spectating） | 32.8 | 23.3 |

上限 256 無額外改善。48 MiB 位元組上限保留不變，且在 128 筆時成為實際上限：快取峰值由 40.1 MiB 升至 47.9 MiB（每個執行緒；離線分析每個 worker 執行緒各一份）。

等價性：快取只決定是否重算，頻譜由相同輸入確定性產生，值不變；引擎全部 38 個測試執行檔（含 cv／module／phase_b／phase_c／analyze parity）通過。新增回歸測試 `template_spectra_survive_a_frame_with_more_templates_than_the_old_cap`（上限 40 時失敗）。

既有 `fixture_frame_detection_performance` 重複同一影格，來源頻譜、moments 與 `MATCHES` 快取都會命中，8.6 ms 低估真實成本；故新增不重複影格版本，不修改原測試與 Python 基準比較。

未量測：真實遊戲影格與事件密度、遊戲 FPS、`aditor analyze` 離線速度、process RSS（只量快取位元組）。
