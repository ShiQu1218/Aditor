# 任務 C：錄影核心整合與實機驗證

日期：2026-10-18；分支：`rec/c`。

## 實作

- `src/session.rs` 接通 WGC → GPU 硬體編碼／小圖 → 共享記憶體，以及 WASAPI → AAC；第一個實際輸入影格的 QPC 是影音共同起點。
- 管理執行緒寫入 session 設定、同步段落索引後公布事件、每五秒公布統計；開始前及每三十秒檢查可用空間，低於 1 GiB 收尾停止。另檢查擷取執行緒中斷、編碼停滯與音訊停止輸出。
- 停止／EOF 先關擷取與音訊，再 flush 編碼器、公布尾段並檢查落盤索引；初始化失敗會釋放已開啟的資源，不公布未成功啟動的段落事件。OBS 模式不開編碼器與音訊。
- `src/main.rs` 移除骨架的全域 dead-code 豁免；程序採 below-normal，WGC 回呼執行緒回到一般基準優先序。FFmpeg 的預期探測失敗不污染 IPC，操作錯誤仍透過 Result／協定回報。
- `tests/e2e_recording.rs` 包含實際子程序 IPC、六秒影音錄影、紅色色塊共享記憶體驗證、段落／索引／事件一致性、完整解碼、失敗後重啟、保留既有資料、busy、OBS／編碼模式 EOF 收尾及 CLI 驗證。
- `tools/rec-cli.ps1` 可指定 PID、時長、編碼／音訊裝置與 ROI，輸出錄影路徑、IPC 記錄、CPU、峰值工作集、dropped 及逐段大小；已以 PowerShell 7 實際執行。

## 驗證

在 `recorder/` 設定以下環境後執行：

```powershell
$env:APEXREC_FFMPEG_DIR = 'D:/Develop/Apex_highlighter/build/ffmpeg'
$env:PATH = 'D:/Develop/Apex_highlighter/build/ffmpeg/bin;' + $env:PATH
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
$env:APEXREC_TEST_EXE = (Resolve-Path target/release/apexrec.exe).Path
cargo test --test e2e_recording measure_sixty_seconds_hevc_1440p60 -- --ignored --nocapture
```

- 格式檢查、Clippy（零警告）及 release 建置通過。
- `cargo test`：92 passed、0 failed；唯一預設 ignored 是長達六十秒的量測，已用最後一行指令另外執行，1 passed、0 failed。
- GPU／音訊測試沒有略過：包含 NVENC、NV12／縮放、靜止畫面 CFR、WGC 視窗重接／尺寸改變／黑畫面備援，以及實際預設 loopback＋麥克風。AMF／QSV 在目前 D3D11 裝置上的探測失敗屬預期結果。
- e2e 與量測皆以 ffprobe 確認 HEVC、AAC 48 kHz 立體聲及時長，再以 ffmpeg 解碼完整影音，無解碼錯誤。

## 六十秒量測

RTX 5080、Ryzen 7 7700（16 個邏輯處理器）；使用 release `apexrec.exe` 擷取自己的 2560×1440 持續重繪 GDI 測試視窗。設定 HEVC auto → `hevc_nvenc`、60 fps、40,000 kbps、預設系統音訊＋麥克風。

| 指標 | 結果 |
| --- | ---: |
| 實際量測區間 | 60.0118782 秒 |
| 平均 CPU（全機） | 0.133437% |
| 峰值工作集 | 139,333,632 bytes（132.878906 MiB） |
| 編碼 dropped | 4 格 |
| 小圖 dropped | 0 格 |
| 段落 | 31 段，含 0.0333333 秒尾段 |
| 索引總時長 | 60.0333333 秒 |
| 全部 m4s 合計 | 2,523,345 bytes |

CPU 使用 Windows `GetProcessTimes` 的 user＋kernel 累積 CPU 秒差，除以量測牆鐘秒及 `GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)`，乘 100；不使用單核心百分比。峰值工作集使用 `GetProcessMemoryInfo.PeakWorkingSetSize`，涵蓋初始化至收尾；不含 GPU VRAM。dropped 採停止輸入後、flush 前的既有 EncodeStats；其包含 CFR 時間槽重複／節流，並非影片一定有時間缺口。

原始 `measurement.json`、`index.jsonl`、`session.json`、段落及解碼用串接檔留在本 worktree 的 `recorder/target/e2e-results/36376-1792293789790998300/`，不提交產物。

| 段號 | bytes | 段號 | bytes | 段號 | bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 80,337 | 12 | 85,978 | 23 | 84,171 |
| 2 | 82,769 | 13 | 86,742 | 24 | 84,248 |
| 3 | 83,032 | 14 | 86,247 | 25 | 80,576 |
| 4 | 91,682 | 15 | 87,520 | 26 | 82,602 |
| 5 | 86,819 | 16 | 77,939 | 27 | 81,161 |
| 6 | 87,171 | 17 | 80,547 | 28 | 82,135 |
| 7 | 83,638 | 18 | 85,985 | 29 | 78,741 |
| 8 | 89,020 | 19 | 81,834 | 30 | 80,157 |
| 9 | 82,285 | 20 | 88,104 | 31（尾段） | 4,572 |
| 10 | 82,638 | 21 | 85,973 | | |
| 11 | 84,660 | 22 | 84,062 | | |

## 偏離計畫與其他模組修正

1. 唯一非 C 擁有檔案：`src/ipc.rs`。原本的區域 recording 旗標不會因背景 disk_full／錯誤自行停止而清除，後續 start 永遠回 busy。新增共享 stopped 世代計數，使迴圈同步背景停止狀態，並加入回歸測試；既有公開方法／型別欄位的簽章均未更動，只新增私有狀態。
2. 建立順序先啟動 WGC 取得來源尺寸，再開編碼器；管線就緒前回呼直接略過，管線就緒後第一格才建立 QPC 原點。這避免依視窗外框猜測實際擷取尺寸，且回呼不等待初始化。
3. 為保留 `pub struct Recorder;` 的骨架建構介面，錄影工作私有狀態放在 IPC 控制執行緒的 thread-local。背景管理執行緒持有資源並完整收尾。
4. CPU／記憶體使用 Windows 原生程序計數 API，取代人工工作管理員／Get-Counter；可避免語系與同名程序 counter instance 的歧義，亦可精確限定量測區間。

## 已知限制

- 此次是持續重繪測試視窗，未啟動 Apex，也未執行遊戲 FPS／1% low 的 PresentMon A/B、Python live 引擎合計 CPU 或長時間壓力驗收。
- 測試圖案易壓縮，實際碼率遠低於設定上限；逐段大小不能代表 Apex 遊戲內容。
- 為避免覆寫資料，start 僅接受不存在或空的 session 目錄；同目錄崩潰續錄、段號接續與主程序復原流程仍待後續階段串接。初始化失敗可能留下可辨識的部分輸出，沒有自動刪除使用者資料。
- 磁碟門檻已有邊界單元測試及 IPC 背景停止回歸測試，未實際填滿磁碟；未實測錄影中拔除音訊／GPU 裝置。
- 本機實測 NVENC；AMF／QSV 在其他 GPU 的整條錄影管線尚未實測。
