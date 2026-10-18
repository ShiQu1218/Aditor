# Apex Highlighter — 計畫 4：錄影核心 apexrec（第 1 期）

> **For agentic workers:** 你負責的任務只有一個（B1／B2／B3／B4／C 之一）。先讀規格，再讀本檔「全域限制」與你的任務段落。

**Goal:** `recorder/` Rust 程式 `apexrec.exe`：以 JSON-lines 接受 `start`，WGC 擷取指定 PID 的視窗，硬體編碼成 `init.mp4`＋每 2 秒一段的 `seg_NNNNNN.m4s`，同時錄系統聲音＋麥克風混成一軌 AAC，並把 4 fps 的 banner／spec／thumb 小圖寫進共享記憶體。

**Spec:** `docs/superpowers/specs/2026-10-18-live-recording-design.md`（§1、§2.1、§2.4、§3.3、§3.6、§4.4–§4.6）

**骨架：** `recorder/` 已建立並可編譯。各模組的公開型別與函式簽章已固定（見各檔案開頭說明）。

## 全域限制

- 只改你的任務擁有的檔案（下表）。需要新 crate 時可以改 `recorder/Cargo.toml`（只新增，不刪不改別人的）；`windows` crate 缺 feature 時直接補。
- **不得改動骨架既有的公開簽章**（`pub fn`、`pub struct` 欄位、`pub trait`）。需要的輔助型別／函式放在自己的檔案裡，預設私有。
- 不准用 CPU 軟體編碼當備援；不准注入或開啟 Apex 程序的 handle（除了列舉視窗所需的 PID 比對）。
- 擷取與音訊回呼不得阻塞：只做 GPU 複製／memcpy 與丟進有界佇列，滿了就丟並計數。
- 每個 `unsafe` 區塊上方寫 `// SAFETY:` 說明。正式程式碼不准 `unwrap()`／`expect()`（測試可以）。
- 註解與錯誤訊息用繁體中文，與既有程式一致。
- ffmpeg：標頭與 import lib 在 `D:/Develop/Apex_highlighter/build/ffmpeg/{include,lib}`，DLL 在 `.../build/ffmpeg/bin`。在 worktree 中建置與測試前設定：
  ```powershell
  $env:APEXREC_FFMPEG_DIR = 'D:/Develop/Apex_highlighter/build/ffmpeg'
  $env:PATH = 'D:/Develop/Apex_highlighter/build/ffmpeg/bin;' + $env:PATH
  ```
- 完成條件：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test` 全過（需要 GPU／音訊裝置的測試若環境缺少可 `#[ignore]` 並在報告註明，但本機有 RTX 5080 與音訊裝置，請實際跑過）。
- 在自己的分支 commit（conventional commits，例如 `feat(recorder): …`），不要 merge、不要 push。
- 最後輸出報告：做了什麼、測試結果（貼指令輸出摘要）、已知限制、偏離計畫之處。

## 檔案擁有權

| 任務 | 擁有的檔案 |
|---|---|
| B1 編碼＋封裝 | `src/encode/**`、`build.rs`、`tools/gen-ffi.ps1`、`tests/encode_*.rs` |
| B2 擷取＋小圖 | `src/capture/**`、`tests/capture_*.rs` |
| B3 音訊 | `src/audio/**`、`tests/audio_*.rs` |
| B4 IPC＋共享記憶體＋索引 | `src/ipc.rs`、`src/shm.rs`、`src/index.rs`、`tests/ipc_*.rs` |
| C 整合（B1–B4 合併後） | `src/session.rs`、`src/main.rs`、`tests/e2e_*.rs`、`tools/` 其餘 |

（`tests/` 下的整合測試看不到 binary 的私有模組；需要時可在 `src/` 內以 `#[cfg(test)]` 寫，或用 `#[path]` 引入。）

---

## B1 — 硬體編碼＋fMP4 段落（`src/encode/`）

1. **綁定**：用 bindgen（`cargo install bindgen-cli`；libclang 在 `C:/Program Files/LLVM/bin`）對 `libavcodec/avcodec.h`、`libavformat/avformat.h`、`libavutil/{hwcontext.h,hwcontext_d3d11va.h,opt.h,channel_layout.h,audio_fifo.h,imgutils.h}`、`libswresample/swresample.h`（若需要）產生 `src/encode/ffi.rs`，以 allowlist 只留用到的符號。指令寫進 `tools/gen-ffi.ps1`。
2. **build.rs**：`APEXREC_FFMPEG_DIR`（預設 `<manifest>/../build/ffmpeg`）的 `lib` 加入搜尋路徑，連結 `avcodec`、`avformat`、`avutil`（以及用到的 `swresample`）。
3. **編碼器選擇**：`probe_encoders` 依序試 `hevc_nvenc, h264_nvenc, av1_nvenc, hevc_amf, h264_amf, av1_amf, hevc_qsv, h264_qsv, av1_qsv`，以 256×144 實際 `avcodec_open2`＋送一格成功才算可用。`encoder="auto"` 時依 `codec` 取第一個可用的同 codec 編碼器；HEVC 都不可用時退到 H.264。都沒有 → 錯誤訊息以 `no_hw_encoder:` 開頭。
4. **零複製**：用 `av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA)`，把 `Gpu.device`／`context` 塞進 `AVD3D11VADeviceContext` 後 `av_hwdevice_ctx_init`。hwframes pool 用 `sw_format` = BGRA（編碼器不收 BGRA 時，用 `ID3D11VideoProcessor` 轉 NV12，同時做縮放）。`push_video` 在呼叫執行緒上：從 pool 取一個 surface → 來源尺寸 = 輸出尺寸時 `CopySubresourceRegion`，否則 VideoProcessor 縮放 → 把 AVFrame 放進有界佇列（容量 8）→ 返回。編碼在獨立執行緒。
5. **時間**：影像 pts 以 tick（100 ns）→ time_base `1/10_000_000`，再由 muxer 轉換。VFR 輸入：依 `fps` 做 CFR 正規化（間隔不足就丟、空太久就重送上一格），讓 GOP 計數可靠。GOP = `fps * 2`，`forced_idr`／`g`／關閉 scenecut，讓每 2 秒一定是關鍵影格。
6. **音訊**：AAC（ffmpeg 原生 `aac`）48 kHz 立體聲 192 kbps；`push_audio` 把樣本放進有界佇列，編碼執行緒以 `AVAudioFifo` 湊 1024 樣本一幀。音訊 pts 依第一個樣本 tick 換算，之後依樣本數遞增；與影像同一個 muxer。
7. **封裝**：libavformat `mp4` muxer＋`movflags=frag_keyframe+empty_moov+default_base_moof+cmaf`（或 `dash`／`hls` muxer 的 fmp4 模式，擇一能穩定產生「獨立 init＋每段 m4s」的方式）。每遇到影像關鍵影格就切新段：寫 `seg_NNNNNN.m4s`（6 位數，從 1 開始）、flush＋`sync_data` 後送 `SegmentInfo`。`init.mp4` 在第一段之前寫出。
8. **測試**：(a) 編碼器選擇的純邏輯單元測試；(b) GPU 整合測試：用 `ClearRenderTargetView` 每格塗不同顏色的 1280×720 BGRA texture，60 fps 推 5 秒＋假音訊（440 Hz 正弦），驗證產生 `init.mp4` 與 2–3 個段落、每段時長 2.0±0.05 秒、把 init＋所有段串起來後 `ffprobe`（`build/ffmpeg/bin/ffprobe.exe`）可解析、影音兩軌都在、總時長 5±0.2 秒；(c) 縮放路徑：1920×1080 輸入、1280×720 輸出。

## B2 — WGC 擷取＋小圖（`src/capture/`）

1. **找視窗**：`EnumWindows` → `GetWindowThreadProcessId == pid`、可見、非工具視窗、面積最大者。找不到 → 錯誤訊息以 `window_not_found:` 開頭。
2. **WGC**：`IGraphicsCaptureItemInterop::CreateForWindow`；`Direct3D11CaptureFramePool::CreateFreeThreaded`（BGRA，2 buffers），`GraphicsCaptureSession` 關閉游標（`IsCursorCaptureEnabled=false`），Win11 關黃框（`IsBorderRequired=false`，不支援時忽略），`MinUpdateInterval` 設成 `1/max_fps`（不支援時忽略）。`FrameArrived` 中：取 `SystemRelativeTime`（tick，已是 QPC 時鐘）→ `pts = t - origin_ticks`；依 `max_fps` 節流；`ContentSize` 改變時 `Recreate` frame pool；呼叫 `consumer.on_frame`。
3. **重接與黑畫面**：每秒檢查視窗是否還在／尺寸是否改變；`item.Closed` 或視窗消失 → `WindowLost`，之後每秒重找同 PID 視窗，找到 → 重建並送 `WindowFound`。黑畫面判斷：用小圖讀回的 thumb（平均亮度 < 2）連續 3 秒 → 改用 `CreateForMonitor`（視窗所在螢幕，`MonitorFromWindow`），送 `WindowFound{monitor:true}`。
4. **小圖（`small.rs`）**：每 1/4 秒取樣一次：在 GPU 上把畫面縮放到 1920×1080 基準（`ID3D11VideoProcessor` 或簡單 compute/pixel shader，擇一），再 `CopySubresourceRegion` 出 banner／spec ROI 到 staging（BGRA）；每 4 次取樣另縮出 320×180 給 thumb。staging 雙緩衝，`Map` 上一次取樣的結果，CPU 端轉 BGR24／GRAY8（GRAY = (299R+587G+114B)/1000，與 OpenCV 一致）。來源已是 1920×1080 時跳過縮放。
5. **測試**：建立一個自己的測試視窗（`CreateWindowExW`＋GDI 畫已知色塊與位置），以本程序 PID 擷取 2 秒：收到 ≥ 30 格、pts 遞增、尺寸正確；小圖 banner 區域的像素與畫的色塊相符（容許 ±8）；thumb 尺寸 320×180。關閉視窗 → 收到 `WindowLost`。

## B3 — WASAPI 音訊（`src/audio/`）

1. `list_devices`：`IMMDeviceEnumerator` 列出 render／capture 啟用中的裝置（ID、FriendlyName、是否預設）。
2. `AudioCapture::start`：兩個執行緒（系統 loopback 一個：`eRender` 裝置以 `AUDCLNT_STREAMFLAGS_LOOPBACK` 開 shared mode；麥克風一個：`mic_enabled` 時）。event-driven（`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`）；loopback 在無聲時不會觸發事件，需 10 ms 逾時輪詢並補靜音以維持時間連續。
3. 時間：`GetBuffer` 的 `QPCPosition`（100 ns）− `origin_ticks`；`AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` 時以 QPC 重新對齊。
4. 格式：裝置 mix format（多半 float32、48 kHz/44.1 kHz、2–8 聲道）→ `mix.rs` 轉 48 kHz 立體聲（降混：前左右＋0.707×中置，其餘忽略；重取樣用線性或 windowed-sinc 皆可，需要單元測試頻率保持）。
5. 混音：兩路依 pts 對齊放進共用緩衝，每 10 ms 輸出一塊 `mic*gain + system`，夾在 [-1,1]；麥克風落後超過 200 ms 就以靜音補上，不拖住系統聲。輸出呼叫 `sink.on_audio`。
6. **測試**：`mix.rs` 純函式全部單元測試（降混、重取樣 44.1k→48k 的長度與 1 kHz 正弦頻率、增益、夾值、對齊補靜音）；整合測試（`#[ignore]` 可選）：實際開預設裝置 2 秒，收到的樣本數 ≈ 96000×2 ±5%。

## B4 — IPC 迴圈＋共享記憶體＋索引（`src/ipc.rs`、`src/shm.rs`、`src/index.rs`）

1. `ipc::run`：逐行讀；空行略過；`parse_request` 失敗回 `{"id":…,"ok":false,"code":"bad_request","message":…}`（沒有 id 用 0）。`hello` → `Reply{body:Hello}`；`ping` → ok；`start` → 呼叫 backend，成功回 ok、失敗回錯誤；正在錄影時再 `start` → `busy`；`stop` → backend.stop。stdin EOF → 若在錄影就 stop，然後返回。
2. `shm.rs`：依檔頭註解的版面實作 `ShmWriter`（`CreateFileMappingW`＋`MapViewOfFile`），寫入順序與 fence 照註解。另寫一個 `#[cfg(test)]` 讀端，測試：版面欄位值、連續寫 40 槽後讀最新一槽內容正確、seq 換槽、資料長度不符回錯誤；以及一個多執行緒壓力測試（寫端狂寫、讀端狂讀，讀到的每一槽若判定有效則內容必須完整一致——內容用 seq 填滿以便檢查）。同時在 `engine/` 之外不要寫 Python；只在 `shm.rs` 註解保持為唯一規格。
3. `index.rs`：`IndexWriter::create(dir)` → `append(&SegmentInfo, wall: SystemTime)` 寫一行並 `sync_data`；`write_session_json(dir, &SessionMeta)`（`SessionMeta` 欄位：session_id、started_at（ISO8601 含時區）、encoder、width、height、fps、codec、audio（bool）、apexrec_version）。另提供 `read_index(path) -> Vec<IndexLine>`：忽略最後一行不完整的 JSON。時間格式化自己寫（不引入 chrono）：本地時區用 `GetTimeZoneInformation`／`GetDynamicTimeZoneInformation` 取偏移。
4. **測試**：用 `Cursor` 當 stdin、`Vec<u8>` 當 stdout、假 backend，覆蓋所有指令、錯誤、busy、EOF 自動 stop；index 寫讀往返與截斷行；session.json 欄位。

## C — 整合（B1–B4 合併後才開始）

1. `session::Recorder`：`hello` 回 `SegmentWriter::probe_encoders` 與 `audio::list_devices`（失敗回空清單）。`start`：建立 `Gpu` → 開 `SegmentWriter`（`encode` 為 None 時不開）→ 建 `SmallFrameExtractor` 與 `ShmWriter`（layout 取自 extractor）→ `Capture::start`（consumer 依序呼叫 `push_video` 與 extractor，extractor 有結果就寫 shm）→ `AudioCapture::start`（sink 呼叫 `push_audio`）→ 寫 `session.json` → 送 `started`。段落事件：收 `SegmentInfo` → `index.append` → 送 `segment`。每 5 秒送 `stats`。`CaptureNotice` 轉成 `window_lost`／`window_found`。磁碟剩餘（`GetDiskFreeSpaceExW`）< 1 GB 時自行 stop 並送 `error{disk_full}`（門檻由主程序管理的部分在第 2 期）。
2. 程序優先序設成 `BELOW_NORMAL_PRIORITY_CLASS`；擷取執行緒維持一般優先序（它只做 GPU 複製）。
3. 移除 `main.rs` 的 `#![allow(dead_code)]`。
4. **e2e 測試**：啟動 `apexrec.exe` 子程序，以 IPC 錄自建測試視窗 6 秒 → stop → 檢查 `index.jsonl` 行數＝段落數、`session.json`、init＋段落串接後 ffprobe 影音兩軌、時長 6±0.5 秒；從 shm 讀到有效槽。
5. `tools/rec-cli.ps1`：手動測試用，對指定 PID（例如 Apex）錄 N 秒並輸出結果路徑。
6. 用工作管理員／`Get-Counter` 量一次錄 1440p60 時 apexrec 的 CPU% 與記憶體，寫進報告。
