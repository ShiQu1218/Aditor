# 擷取與分析成本實驗（2026-10-31）

這份報告延續 [recording-gpu-cost.md](recording-gpu-cost.md)，記錄 #49、#50 兩項改善，以及幾個**沒有採用**的實驗，避免之後重複嘗試。

## 摘要

- 合併：#49（WGC 最小更新間隔 50% → 75%）、#50（場景評分與快取讀取去重）。
- 沒有採用：ROI 直接取樣、DDA 時槽排程、DDA 格式轉換假設、游標整幀複製、編碼器 view 快取等。
- DDA 擷取扣除游標後仍有約 -4.2% 的平均 FPS 成本，看起來來自桌面複製本身，我們這端沒有便宜的改善。
- 遊戲中成本由高到低：DDA 路徑、WGC 擷取本身、編碼與寫檔；Electron、音訊、即時引擎在雜訊範圍內。

## 量測方法

- **工具**：`tools/fakegame` 與 `tools/perf/run-fakegame-bench.ps1`，見 `tools/perf/README.md`。
- **機器**：RTX 5080、3840×2160 240 Hz、Windows 11；另有一顆 AMD 內顯只用於 ROI 縮放實驗。
- **共同參數**：`-Source engine/tests/golden/golden.mp4 -ClipStart 210 -ClipSeconds 12 -LoadPasses 6 -DurationS 30 -WarmupS 5 -CooldownS 5 -Preset speed`。baseline 約 178.4 FPS，受 GPU 限制。
- **比較方式**：每個版本跑 3 輪，輪內交錯，每次都附同批 `baseline`，取相對該 baseline 的百分比，再取 3 輪中位數。表中為「平均 FPS／1% low／0.1% low」相對 baseline 的變化。
- **執行環境**：Aditor 與遊戲全部關閉，量測期間不動滑鼠與鍵盤，`background_frames` 為 0。

## 1. #49：WGC 最小更新間隔

`SetMinUpdateInterval` 原本是半個輸出影格。遊戲 FPS 高於錄影 FPS 時，WGC 每秒交付的影格比錄影所需多一倍，多出來的每一張都要付一次整幅複製，之後才被時槽篩選丟掉。

`rec_capture`，WGC，3 輪：

| 間隔 | WGC 每秒交付 | 實際用到 | 平均 FPS | 1% low | 0.1% low |
|---|---:|---:|---:|---:|---:|
| 50%（原本） | 118 | 59.5 | -2.15% | +0.30% | -1.02% |
| **75%（採用）** | 79 | 59.4 | -1.81% | -0.01% | -0.69% |
| 100% | 59 | 59.4 | -1.53% | -0.01% | -0.14% |

- 平均 FPS 在 3 輪內的最小與最大值互不重疊（50%：174.44–174.76；75%：175.08–175.37；100%：175.58–175.71）。lows 差距在雜訊內。
- 上限 100 FPS 時，75% 仍有 58.9 個時槽（50% 為 58.6）；`rec_encode` 下編碼器輸入約 60 fps、`dropped` 為 0。
- 沒有選 100%：原註解指出整幀間隔會讓 WGC 跳過稍早呈現的影格，編碼器再補重複影格；多省的約 0.3 個百分點不值得冒險。
- 預設改為 75%，並新增 `ADITOR_WGC_MIN_INTERVAL_PCT`（1–100）覆蓋值與擷取結束時的 `WGC stats:` 統計行。

## 2. #50：場景評分與快取讀取去重

沒有 FPS 影響（離線分析階段），省的是遊戲結束後的分析時間。

- `SceneMatcher::scores` 對每個樣板項各呼叫一次 `match_score`，`control_objectives` 有 3 個變體，所以被算了 3 次：每張完整評分 22 次樣板比對，實際只需要 16 次。改為每個名稱只算一次，仍取變體最大值。
- `resolveCacheFile` 對每個候選快取重複讀檔與解析：3 份候選都存在時讀 7 次（加載入共 8 次）。改為每份讀一次，共 3 次（加載入共 4 次）。
- 驗證：引擎 `cargo test --test scene`（含與 Python 分數比對的 fixture）通過；前端相關 15 項測試與 `tsc --noEmit` 通過。
- **沒有重測完整分析耗時**。參考基準：226 秒 AV1 影片、四分段、全新快取，自動辨識遊戲與比例 18.04 秒對明確指定 12.07 秒（中位數，各 3 次）。辨識前置約占 6 秒，但外部影片仍需要辨識。

## 3. 實驗：ROI 直接取樣（未採用）

非 1080p 輸入時，`small.rs` 先把整張畫面縮放到 1920×1080 再裁出 ROI。實驗改為只縮放 ROI 涵蓋的對齊區域（單一範圍，或每個 ROI 一個範圍）。

- **像素一致**：對齊到取樣格點（`1920 / gcd(寬, 1920)` 的倍數，外加一格邊界）後，兩種做法的 ROI 像素與原路徑逐位元相同（差異 0 bytes）。輸入小於 1920×1080 時不保證一致，維持原路徑。
- **GPU 時間（每 120 次縮放的牆鐘時間，含完成回讀）**：

| GPU／遊戲／尺寸 | 整張縮放 | 單一範圍 | 每個 ROI 分開 |
|---|---:|---:|---:|
| AMD 內顯，Valorant，4K | 440 ms | 95 ms | **68 ms** |
| AMD 內顯，Apex，4K | 440 ms | 410 ms | **160 ms** |
| AMD 內顯，Apex，1440p | 273 ms | 257 ms | **103 ms** |
| RTX 5080，Apex／Valorant，各尺寸 | 約 2.7–4.0 ms | 約 2.1–4.0 ms | 約 4.0–7.5 ms |

- RTX 5080 上一次整張縮放只要約 0.025 ms，4 Hz 下占用約 0.01%，沒有可改善的空間；內顯一次縮放約 2.3–3.7 ms。
- **最佳做法取決於 GPU，不只取決於遊戲**：Apex 在 NVIDIA 上分開縮放反而慢 2 倍，在 AMD 上卻最快。
- 實作了依 GPU 自動選擇的版本（量測一次後僅在成本不超過原路徑 80% 時啟用；整張縮放低於 0.5 ms 的 GPU 直接略過），但因為主要 GPU 上沒有收益，**沒有合併，分支已刪除**。

## 4. 實驗：DDA 路徑

DDA 是 Windows 10 組建 20348 以前，或 WGC 失敗時的退路。

### 4.1 游標路徑

DDA 不含游標，錄影器每張畫面要自己疊上去：整幀 `CopyResource`、複製游標背景 ROI、畫游標。`rec_capture`，DDA，游標開與關各 3 輪：

| 游標 | 平均 FPS | 1% low | 0.1% low |
|---|---:|---:|---:|
| 開 | -5.10% | -2.75% | -1.67% |
| 關 | -4.18% | -0.44% | -1.15% |
| 差距 | 約 0.9 個百分點 | 約 2.3 個百分點 | 約 0.5 個百分點 |

- 「開」的 3 輪 overlay 次數都等於交付次數，GDI 退路為 0，確認游標真的有畫。
- 平均 FPS 與 1% low 的差距三輪一致；0.1% low 範圍重疊，不能下結論。
- 游標路徑約占 DDA 平均 FPS 成本的 18%。要消除整幀複製，得讓編碼器的 VideoProcessor 多疊含 alpha 的游標串流，是否可行取決於驅動，XOR 游標還要保留舊路徑；以約 0.9 個百分點的上限，**不實作**。

### 4.2 時槽排程擷取（失敗）

假設：60 fps 輸出時，迴圈固定睡 8 ms，約 125 次取得／秒，約一半被時槽篩選丟掉；改成睡到下一個時槽中心再取得，應該省掉無效的取得。

| 版本 | `rec_capture` 平均 FPS | `rec_encode` 平均 FPS | 每 35 秒交付影格 |
|---|---:|---:|---:|
| 原本 | -5.05% | -5.90% | 約 2000（約 60 fps） |
| 時槽排程 | -5.17% | -5.26% | 約 972（約 30 fps） |

- 實作讓交付影格數減半（錄影只剩約 30 fps），不合格；即使如此遊戲 FPS 沒有改善，表示成本不在取得次數，而在桌面更新本身（由系統複製）。已捨棄。

### 4.3 DXGI 隱藏格式轉換（沒有）

假設：假遊戲 swap chain 是 RGBA8，DDA 的 SDR 路徑只接受 BGRA8，DXGI 可能在回傳前做了轉換。將假遊戲改為 BGRA8 對照：

| 假遊戲格式 | `rec_capture` | `rec_encode` |
|---|---:|---:|
| RGBA8 | -5.26% | -6.00% |
| BGRA8 | -5.30% | -6.03% |

沒有差異，假設不成立。

### 4.4 其他候選（未實作）

編碼器輸入／輸出 view 快取、延後游標形狀 GPU 上傳、快取螢幕查詢：都是 CPU 端呼叫，量級約每秒 60 次，預期量不出 GPU 限制下的 FPS 差異。合併 HDR 路徑的 `Flush` 只影響 HDR，量測需要切換顯示器 HDR 狀態，沒有做。

## 4.5 三種擷取方式比較（2026-10-31 晚間，`main` `5aeadb6`）

`baseline` 與 `rec_capture`，LoadPasses 6，60 秒量測、10 秒暖機，DDA 與 hook 各 3 輪交錯執行；WGC 取自同設定的元件拆解（2 輪，非交錯）。metadata 的 `capture_method_actual` 皆與要求一致，hook 沒有退回 DDA。

| 擷取方式 | 平均 FPS 成本（中位數） | 1% low 成本 |
|---|---:|---:|
| hook（OBS graphics-hook 32.1.2） | -0.62% | -1.4% |
| WGC | -1.88% | -1.6% |
| DDA（Windows 10 的自動選擇） | -5.81% | -6.7% |

- DDA 三輪 -5.8% 到 -5.9%；hook 三輪 -1.6%、-0.6%、-0.7%（第 1 輪 baseline 偏高）。
- 設定頁的擷取方式選項依此標示高／中／低效率。
- 假遊戲為 D3D11；沒有在真實 Apex 上驗證 hook 與 EasyAntiCheat 的相容性。

## 5. 耗能模組排序（以對遊戲 FPS 的影響衡量）

遊戲進行中，WGC＋SDR（#37 之後）：

| 排名 | 模組 | 平均 FPS 影響 | 改善空間 |
|---|---|---|---|
| 1 | DDA 擷取路徑 | 約 -4% 到 -6%，lows 約 -3% | 小：成本看起來是桌面複製本身 |
| 2 | WGC 擷取本身 | 約 -1.5% 到 -2%，lows 量不出來 | 小：間隔拉到 100% 仍剩 -1.5% |
| 3 | 編碼、封裝、寫檔 | 約 -1.4 FPS（#37 前） | 小：NVENC 是硬體編碼 |
| 4 | small frames（ROI、縮圖） | RTX 5080 可忽略 | 只有內顯有空間（見第 3 節） |
| 5 | Electron、音訊、即時引擎 | 雜訊範圍內 | 沒有 |

遊戲結束後（離線分析，看耗時）：辨識前置約 6 秒、主分析約 12 秒（226 秒影片）；檢查點寫入阻擋其他分段、媒體庫進度更新重取清單兩項**尚未量測**，不能排名。

## 限制

- 全部來自合成負載與單一機器（RTX 5080，內顯僅用於 ROI 縮放實驗），**不能直接推算實際 Apex 的 FPS**。
- 每個設定只跑 3 輪，lows 的雜訊很大，只有平均 FPS 的差距在輪間一致時才下結論。
- 沒有量測 CPU 用量與耗電，只量遊戲 FPS 與分析耗時。
- WGC 間隔只測了約 178 FPS 與 100 FPS 上限兩種遊戲幀率，沒有用真實遊戲的影格時間抖動驗證重複影格；#49 的測試計畫中保留了這一項。
- Windows 10 實機、HDR、單色或 XOR 游標都沒有測。
- 其他：`session.test.ts` 的「automatically starts and stops…」測試曾因 `droppedFrames` 競態不穩定地失敗（#50 的 CI 重跑後通過），與本報告的改動無關。

## 重現

```powershell
$env:PATH = "$PWD/build/ffmpeg/bin;" + $env:PATH
$env:ADITORREC_FFMPEG_DIR = "$PWD/build/ffmpeg/bin"
cargo build --release --manifest-path recorder/Cargo.toml
pwsh -File tools/perf/run-fakegame-bench.ps1 -Source engine/tests/golden/golden.mp4 `
  -ClipStart 210 -ClipSeconds 12 -Scenarios baseline,rec_capture -Repeat 3 `
  -DurationS 30 -WarmupS 5 -CooldownS 5 -LoadPasses 6 -CaptureMethod wgc -Preset speed
```

WGC 間隔實驗在執行前設定 `$env:ADITOR_WGC_MIN_INTERVAL_PCT`（50、75、100）；擷取結束時的 `WGC stats:` 行在各 run 目錄的 `recorder.stderr.log`。DDA 游標開關與 `DDA stats:` 統計是實驗用的本地修補，**沒有合併**。
