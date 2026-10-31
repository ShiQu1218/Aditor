# 背景解碼資源使用（2026-10-26）

分析佇列可能在遊戲進行時處理上一場錄影或監看資料夾的新影片。硬體分析最多同時執行四個分段，每個分段各自啟動 FFmpeg；原本解碼器、濾鏡與 rawvideo 輸出皆使用預設執行緒設定。[FFmpeg 文件](https://ffmpeg.org/ffmpeg.html) 說明濾鏡執行緒預設依可用 CPU 數量配置，因此多個程序會放大背景 CPU 爭用。

共用的 `build_input_args` 現在指定解碼器 `-threads 2`、一般與複合濾鏡各一個執行緒；四個呼叫端的 rawvideo 輸出另指定 `-threads 1`。此設定涵蓋分析、校正、畫面比例與遊戲辨識、對局掃描，以及硬體解碼失敗後的軟體備援。這些是個別元件的設定，不是整個程序的執行緒上限。錄影編碼、分析分段數及辨識規則未更動。

## 量測

Windows、16 個邏輯處理器，使用專案固定版本 `aditor-8.1-20261023.1` FFmpeg。以 `tests/conftest.py::make_video` 產生 10 秒、1920×1080、60 fps H.264 合成影片，採軟體解碼與 Apex 的 `build_filter`，輸出 4 fps BGR24。交錯執行預設設定與限制執行緒設定，各三次；預設組只移除上述執行緒參數。

| 指標 | 預設 | 修改後 |
| --- | ---: | ---: |
| 程序執行緒峰值（每 5 ms 取樣） | 86 | 11 |
| FFmpeg CPU 時間中位數（`-benchmark` 的 user + system） | 2.359 秒 | 1.515 秒 |
| 處理時間中位數（包含管線輸出） | 0.574 秒 | 0.861 秒 |
| FFmpeg 回報的尖峰記憶體中位數 | 216,376 KiB | 64,064 KiB |

六次輸出皆為 147,403,200 bytes，SHA-256 皆為 `4b5b49eb8d9604bdf5065320ad0197d04213d03023ec9ebc26a7c4f91dd73755`。這項量測顯示背景解碼使用較少 CPU 時間與執行緒，但完成較慢；不能據此推算實際遊戲 FPS 或幀時間改善幅度。合成短片、暖快取及單一解碼程序也不代表所有使用情境。

新增回歸測試比對限制前後的 AV1 時間戳記與逐像素輸出，並確認硬體重試與軟體備援皆保留執行緒設定。既有測試涵蓋時間對齊、取消、解碼錯誤、10-bit HEVC、比例判斷與對局掃描。未進行遊戲同時錄影的幀時間量測或 GPU 飽和測試。

驗證共 230 項不同測試通過：`test_decode`、`test_aspect`、`test_matches`、`test_game_detect`，以及排除 `slow` 的 `test_analyze`、`test_calibrate`、`test_valorant`、`test_segment_ownership`。另有四項對局驗收測試因未提供實際影片而略過。

## 前置取樣重疊（2026-10-31）

未帶 `aditor_game` 標籤的影片在分析前會先做遊戲辨識（24 個取樣點）與畫面比例偵測（40 個取樣點）。原本 Apex 錄影不寫入此標籤（`finalize.ts` 只為非預設遊戲寫入），因此每部 Apex 錄影都會執行這兩步；現已改為所有錄影都寫入，見下方「Apex 錄影寫入遊戲標籤」。每個取樣點各啟動一次 FFmpeg 取單幀。

原本的 `sampled_frames` 以四個為一批：等整批解碼完成後，才逐幀執行場景比對，再啟動下一批。現在改為滑動視窗：最多同時四個解碼程序，每交出一幀前先補上下一個取樣點，讓場景比對與解碼重疊，也不必等待批次中最慢的程序。取樣時間、重試位置、輸出順序與最多四個解碼程序的上限皆未改變。

### 量測

Windows、16 個邏輯處理器，git `f2e0f98`，FFmpeg `aditor-8.1-20261023.1`。輸入為 `engine/tests/golden/golden.mp4`（AV1、1916×1080、60 fps、226 秒、無遊戲標籤，暖快取）。以 `aditor analyze --force` 量測端到端時間，交錯執行修改前（A）與修改後（B）各三次。

| 指標 | 修改前（中位數） | 修改後（中位數） |
| --- | ---: | ---: |
| `analyze` 端到端時間 | 17.60 秒 | 15.99 秒 |

修改前以暫時計時拆解各階段：遊戲辨識 2.1 秒（其中場景比對 0.3 秒）、比例偵測 3.6 秒（其中場景比對 0.9 秒）、校正 0.5 秒、分段分析 10.7 秒、關鍵幀與存檔 0.3 秒。單次取幀約 85 毫秒、約 0.17 CPU 秒，主要是從關鍵幀解碼到目標時間；`-noaccurate_seek`、輸入端 `-t`、dav1d `-max_frame_delay 1` 與 `-threads 1` 均未降低成本，且輸出位元相同。四個並行約 147 毫秒、八個並行約 370 毫秒，所以並行上限維持四個。

### 等價性

六次執行的分析文件（移除 `cache_path` 後）SHA-256 前 16 碼皆為 `a95acaee331b5c91`：10 個事件、`aspect_source` 為 `detected`、`h_scale` 為 1.05。引擎 `cargo test`（含所有 parity 測試）、`cargo clippy --all-targets -D warnings` 與 `cargo fmt --check` 通過；設定 `ADITOR_GOLDEN_VIDEO` 後，`golden_jobs_auto`、`golden_jobs_one` 與 `golden_live_matches_offline` 通過。新增單元測試確認消費端處理第一幀時，下一個取樣點已開始解碼。

未量測：其他編碼格式與解析度、長片、冷快取、遊戲同時執行時的幀時間，以及 VALORANT 對局驗收（未提供 `ADITOR_MATCH_DIR`）。`scripts/test.ps1 -Tier fast` 中 recorder 的 `actual_default_loopback_and_microphone_capture_for_two_seconds` 失敗，原因是實機回送擷取到系統其他聲音；此次未修改 recorder。

## Apex 錄影寫入遊戲標籤（2026-10-31）

`gameMetadataArgs` 現在對所有已知遊戲寫入 `aditor_game`，包括 Apex。引擎讀到標籤後直接採用，不再執行 24 個取樣點的遊戲辨識；比例偵測與校正不受影響。媒體庫的遊戲標記（`addRecorded`）未更動。

以與 `remux` 相同的參數（`-c copy -metadata aditor_game=apex -movflags +faststart+use_metadata_tags`）複製 `golden.mp4`，`ffprobe` 確認標籤存在。使用前一節修改後的引擎，交錯執行三次：

| 輸入 | `analyze` 端到端時間（中位數） |
| --- | ---: |
| 無標籤 | 15.74 秒 |
| `aditor_game=apex` | 14.20 秒 |

兩者的事件、觀戰區間、`h_scale` 與比例結果完全相同（10 個事件）。既有錄影沒有標籤，仍會執行遊戲辨識；只有新錄影受益。
