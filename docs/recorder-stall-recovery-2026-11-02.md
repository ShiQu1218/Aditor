# 錄影卡頓與音訊恢復（2026-11-02）

## 結論與證據邊界

本次修正的是「暫時性卡頓之後，追補工作與缺口保護讓整段錄影失敗」及「音訊裝置失效後不再恢復」。沒有證實所有 Sentry 事件具有同一最初根因；使用 Refs，沒有宣稱 Fixes。

- **已證實**：在原有 `9ce27df` 上，七秒音訊缺口會觸發 `Audio timestamp gap exceeds five seconds`，即使磁碟沒有阻塞。新的合成回歸同時提供 video slots 0、638 和音訊 0–80 ms、7–7.1 s；原版 9/9 次在編碼第一張後失敗，修改後 9/9 次完整收尾。音訊缺口以每次最多 0.5 秒補齊，與視訊交錯處理；超過一分鐘的異常時間跳躍仍拒絕。
- **已證實**：原有 CFR 追補會為這個缺口編碼 639 張；修改後長缺口以稀疏視訊降級為 17 張，省略 622 個補幀時槽，維持原 PTS 時間軸與兩秒關鍵影格邊界。一般短缺口仍補 CFR。`dropped` 現在也包含這些省略的補幀時槽，可能大於輸入影格數。
- **已證實**：`9ce27df` 的兩秒短缺口／排隊音訊回歸仍通過。它解決逐格補幀時過早以靜音取代已排隊音訊，但不限制補幀工作量，也不處理大於五秒的輸入缺口。
- **推測**：1S/1V 的 `encoded=37`、`video_next_slot=37`、`gap_samples=306240` 與上述繼發故障相符；單筆 Sentry 快照不能證明最初由 NVENC、GPU 排程或其他執行緒造成卡頓。1N/1T 的五秒無影格可能是同一鏈條，也可能是獨立的原生編碼呼叫阻塞。沒有重現 i5-9400F／GTX 1650 SUPER。
- **已證實**：2.1 秒滿 mux 佇列後能恢復且保留封包。兩秒門檻不足以容忍工單中的 3.317 秒磁碟延遲，因此調成十秒；超時訊息說明磁碟過慢／不可用、建議更換磁碟，且只承諾保留已完成段落。十秒是工程容忍值，沒有實體慢磁碟分布證明它最佳。
- **已證實**：五秒未輸出影格改發 `encoder_stalled` 警告，不再只因這個時間門檻終止錄影；GPU 回歸驗證持續有輸入但無輸出時不發 error。
- **已證實**：裝置開啟或執行失敗後保留音訊時間軸、約每秒重試原來源，故障注入覆蓋 `0x80070490`、`0x88890004`、執行中失效、取樣率變更、重設時間戳與滿佇列。採用原裝置重試與靜音，避免擅自切換到其他麥克風。原本選「default」會在重開時重新解析目前預設裝置。NUL 裝置 ID、無效增益仍回報錯誤。
- **未證實**：1K「聲音都錄不到」是否由裝置錯誤引起；實體拔插、驅動不報錯卻不送資料、驅動永久卡死、永久磁碟 I/O 卡死的恢復與 stop 超時。這次沒有加入可中斷原生呼叫的機制；永久卡死仍可能讓停止等待。編碼呼叫阻塞超過音訊佇列容量時，已丟棄的原始音訊只能補靜音，無法重建。

## 基底與範圍

工作區 `D:/Develop/Aditor-wt/sentry-recorder`，分支 `fix/sentry-recorder-stalls`。依工單先 fetch，以 `origin/fix/recorder-audio-during-frame-catchup` 建立 worktree。後確認 [#66](https://github.com/ShiQu1218/Aditor/pull/66) 已合併，將分支 fast-forward 至 `origin/main` 的 `83a848e`。相依 `9ce27df` 已包含於 main，不需等待合併。未修改 `~/.codex/config.toml`，未在主工作區編輯產品檔案。

改動涵蓋 AAC／編碼排程、mux 工作執行緒、session 警告、WASAPI 重連，以及音訊／端對端回歸。IPC 格式、公開函式簽章與既有儲存格式不變。音訊子工作由 Codex Astra 實際提交檔案修改，已在本工作區重新整合驗證。

ADITOR-DESKTOP-C：目前 main 的 WGC 已跳過池中舊尺寸紋理，歸還舊影格後 `pool.Recreate`；HDR→SDR 轉換後重新 `GetDesc`，以實際紋理尺寸交付。DDA 同樣以紋理 descriptor 交付尺寸，`Copier` 會依來源尺寸重建 processor。保留其尺寸／格式驗證，沒有移除檢查來掩蓋錯誤。本次 WGC resize/reconnect 測試通過；未在真實遊戲切換解析度重現舊版 C，因此只判斷已知尺寸錯配路徑已有防護，不宣稱所有 GPU copy failure 不再可能。

## 量測設定與前後數據

- CPU AMD Ryzen 7 7700，GPU RTX 5080，驅動 `32.0.16.2101`，另有 AMD 內顯；Windows。
- 專案 FFmpeg `46d899d-20261022`，來自 `D:/Develop/Aditor/build/ffmpeg`。
- Rust release，HEVC NVENC、NV12、2560×1440、90 fps、4000 kbps、speed。GPU 上固定色面，合成 7.1 秒時間軸；沒有遊戲、擷取回呼或實際慢磁碟。
- 原版 `9ce27df` 只加相同測試與測試限定計時；新版為本 PR 的執行邏輯。兩個獨立保存的測試執行檔，交錯 A B A B A B；每個執行檔每個情境三次，共每版每情境九次，表列九次中位數。建置與其他 GPU 測試完成後才取這批數據。
- 原版執行檔 SHA-256 `281f68bdc4ba8e0f780852cb0f3d9d56d4512765761dd09b265bb2a81a538816`；新版 `43ab23143c8729fffc64b2c82adeec5fcb68f2cdcde0ee2372377c157e02e5a1`。
- [全部 36 筆原始數據](experiments/recorder-recovery/measurements.csv)。前版音訊缺口測試的 exit 101 是預期重現結果，不是通過。

| 指標 | 前：9ce27df | 後 |
|---|---:|---:|
| 七秒視訊缺口：完成追補與收尾 | 872.871 ms | 30.458 ms |
| 實際編碼張數／省略補幀時槽 | 639／0 | 17／622 |
| 平均單次 video encoder send+receive | 1.333 ms | 0.821 ms |
| video encoder 呼叫 p99 | 1.431 ms | 2.523 ms |
| 該情境 process peak working set | 94.09 MiB | 92.64 MiB |
| 七秒音訊缺口：成功收尾 | 0/9 | 9/9 |
| 音訊缺口情境時間 | 3.276 ms 後失敗 | 33.855 ms 完整收尾 |
| 音訊缺口情境 process peak working set | 94.88 MiB（失敗） | 97.43 MiB（完成） |
| 遊戲平均 FPS／1% low／0.1% low 影響 | 未量測 | 未量測 |

較少補幀降低追補總時間約 96.5%，不是提升正常錄影 FPS 的證據。新版本僅 17 次送幀，關鍵影格比例更高，p99 **上升**；這是不同送幀分布，不能拿 encoder p99 推算遊戲 1% low。沒有真實遊戲／PresentMon 前景樣本；沒有為量測接管使用者的前景視窗，改採不需要桌面擷取的 GPU 合成負載。這台 RTX 5080 的結果不代表 GTX 1650 SUPER。process peak working set 不包含專用 VRAM，也不是整個產品記憶體上限。

產物回歸：串接 init＋所有 m4s 後 ffprobe 成功，段落 metadata 時間連續，總長約 7.1 秒，A/V stream 時長差小於 50 ms，視訊 packet 數與編碼計數一致；FFmpeg 能解碼音訊，7–7.1 秒恢復區 RMS >0.1。既有普通錄影／靜態畫面／短缺口測試維持 CFR 與解碼檢查。

## 記憶體與降級限制

- 保留視訊佇列 8、GPU surface pool 12；沒有在 capture callback 或 D3D11 immediate context 新增等待、Map、回讀、鎖或配置。
- 音訊輸入 64 個 job，每個最多一秒 48 kHz stereo f32，另保留一個分批補音 job：sample payload 上限 24,960,000 bytes，另計 Vec／channel metadata。
- mux 最多 256 批 compressed job，並新增 64 MiB payload 預算，包含目前處理中的批次；單批超過 64 MiB 拒絕。mux 內尚未封段的 packet 最多 2048，另限 64 MiB。呼叫端待送單批另計最多 64 MiB；三處保守合計最多 192 MiB 壓縮 payload，**不含 FFmpeg 自有緩衝、GPU 資源或 metadata**。
- 半秒補靜音最多約 25 個 AAC packet；原有一般 advance 的五秒上限仍存在，避免其他呼叫一次建出無限 packet Vec。WASAPI packet 與音訊警告佇列各 32；來源 mixer timeline 維持原有固定容量。
- 記憶體與時間預算用完會回報失敗，並保留已完成的磁碟段落；尚未完成／同步失敗的最後一段不保證完整。沒有用無上限佇列換穩定。

## 量測前的十六層檢查

| 層 | 結果／證據 |
|---|---|
| 演算法 | 原 run_worker 為每個缺少的時槽重編；639→17 的量測支持跳過長缺口重複工作。 |
| 複雜度 | 原補幀 O(gap×fps)；長缺口降級約 O(gap×2)，一般短缺口不變；資料佇列皆有上限。 |
| 資料結構 | 保留 sync_channel、surface pool、AAC FIFO；新增一個 pending audio job，不建新動態佇列。 |
| 實作 | 保留 9ce27df 的逐輪排空音訊；有待處理音訊時不以 video catch-up 過早補靜音。 |
| 語言 | Rust 工作執行緒與 FFmpeg FFI，沒有新增跨程序熱路徑。 |
| 編譯 | 最終數據使用既有 release 設定 opt-level=3、thin LTO、codegen-units=1；未用 target-cpu=native。 |
| Runtime | Rust 無 GC/JIT；合成測試不包含 Electron。 |
| 記憶體管理 | 封包位元組上限、sample job 容量與實測 working set 如上；計時樣本只在 cfg(test) 且最多 2048 筆。 |
| 記憶體存取 | 保留 GPU NV12 surface 與 interleaved PCM；未改像素遍歷或 layout。 |
| 平行度 | 保留 capture、encoder、mux、audio source/mix 執行緒；WASAPI 僅在自己的失效來源執行緒重試。 |
| 同步 | 擷取仍 try_lock／try_send；等待只在 encoder mux 入列或失效音訊 worker；沒有改 immediate-context 同步。 |
| I/O | 原兩秒 timeout；2.1 秒滿佇列回歸支持增加容忍度，沒有實體磁碟壓測。 |
| OS | 實際 GPU/WASAPI 測試可跑，部分原有 foreground 測試維持 ignore；沒有改排程優先權。 |
| 第三方 | 保持同一 FFmpeg 與 windows crate，沒有加相依；NVENC 原生卡死未能重現。 |
| 輸入資料 | 固定色 GPU 面與兩類缺口；普通短缺口、靜態錄影、WGC resize另有回歸；不代表高動態遊戲。 |
| 系統設定 | 相同硬體、FFmpeg、release、90fps/1440p/speed；無遊戲或擷取成本數據，沒有宣稱平均 FPS／1% low 不受影響。 |

結構替代方案：分拆獨立音訊編碼工作執行緒可進一步隔離原生 video send 卡死，但會改變 mux 排序、停止協定與音訊補時鐘。本次選擇保留既有工作執行緒，先消除已重現的追補放大效應；永久原生阻塞仍列限制。

## 實跑指令與驗證結果

所有直接 cargo 指令先設定：

```powershell
$env:PATH = 'D:/Develop/Aditor/build/ffmpeg/bin;' + $env:PATH
$env:ADITORREC_FFMPEG_DIR = 'D:/Develop/Aditor/build/ffmpeg'
```

`ADITORREC_FFMPEG_DIR` 必須是含 lib、bin 的 root；PATH 才是 bin。未修改使用者 Codex 設定。

```powershell
git fetch origin
git worktree add D:/Develop/Aditor-wt/sentry-recorder -b fix/sentry-recorder-stalls origin/fix/recorder-audio-during-frame-catchup
cargo test --manifest-path recorder/Cargo.toml --bin aditorrec -- --test-threads=1
# 基準：172 passed，36.71 s。
cargo test --manifest-path recorder/Cargo.toml --bin aditorrec gpu_recovery_backlog_measurement -- --ignored --nocapture
# 基準：音訊缺口失敗三次；修改後通過三次（初步 debug 測試）。
cargo test --release --manifest-path D:/Develop/Aditor-wt/sentry-recorder-baseline/recorder/Cargo.toml --bin aditorrec --no-run --message-format=json
cargo test --release --manifest-path recorder/Cargo.toml --bin aditorrec --no-run --message-format=json
# 保存兩個測試執行檔後，以下依序交錯各三次：
./validation/baseline-recovery.exe gpu_recovery_backlog_measurement --ignored --nocapture
./validation/final-recovery.exe gpu_recovery_backlog_measurement --ignored --nocapture
# A 每次 exit 101，B 每次 exit 0。原始樣本見 CSV。
cargo test --manifest-path recorder/Cargo.toml --no-fail-fast -- --test-threads=1
# 完整結果見下表；未把基底也失敗的硬體音訊排除測試算成通過。
cargo test --manifest-path recorder/Cargo.toml --no-fail-fast -- --test-threads=1 --skip actual_default_loopback_and_microphone_capture_for_two_seconds
# 最終：362 passed、0 failed、7 ignored、1 filtered out（已知基底也失敗的實體音訊排除測試）。
cargo clippy --manifest-path recorder/Cargo.toml --all-targets -- -D warnings
# 通過。
cargo fmt --manifest-path recorder/Cargo.toml --check
# 失敗：基底即有未格式化區域；只格式化本次修改區塊，未做整個專案的無關重排。
git diff --check
# 通過；修改檔案使用 LF。
pwsh -NoProfile -File scripts/test.ps1 -Tier fast
pwsh -NoProfile -File scripts/test.ps1 -Tier full
# 兩者在 worktree 的 build/ffmpeg/bin/ffmpeg.exe 缺少時停止，exit 1。
# 直接 cargo 使用上方明確指定的原工作區 FFmpeg 成功建置及執行。
```

完整套件第一次整合另抓到兩個舊預期：audio_capture 與 e2e_recording 仍要求不存在裝置回報 audio_failed。已更新為裝置失效時成功錄影並發警告；NUL ID 仍失敗並釋放資源，再次啟動缺裝置錄影可於 EOF 收尾。第一次更新 E2E 曾因警告在 started 前送出而等待第二次警告逾時，已改檢查已收到的啟動警告。

既有硬體音訊測試失敗（同一基底可重現，未放寬斷言）：

```text
原始基底：actual_default_loopback_and_microphone_capture_for_two_seconds
thread 'actual_default_loopback_and_microphone_capture_for_two_seconds' (39112) panicked at tests\audio_capture.rs:243:5:
Excluded loopback still captured this process's tone: 0.014666069 vs 0.036904242
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 41 filtered out

本次完整套件同項：Excluded loopback still captured this process's tone: 0.0074199033 vs 0.027200198
```

未執行／未宣稱通過：全產品 fast/full gate、Engine/App/Playwright 完整套件、golden/match 資料驗收、真實遊戲平均與 1% low／0.1% low、實體拔插與慢磁碟、GTX 1650 SUPER、CodeScene 結構分數、測試覆蓋率。全產品 wrapper 的 FFmpeg 路徑前置條件未滿足；沒有為與本次修改無關的 Engine/App 安裝新環境或改測試設定。Rust 編譯、clippy、相關回歸與差異檢查作為此次審查證據，PR 保留草稿供檢視，不能據此直接發布。


| 最終檢查 | 實際結果 |
|---|---|
| recorder bin | 179 passed、1 ignored |
| audio_capture（排除已知硬體項） | 43 passed、1 ignored、1 filtered out |
| capture_dda | 65 passed、2 ignored |
| capture_wgc（包含尺寸變更） | 66 passed |
| e2e_recording（更新缺裝置契約後） | 7 passed、3 ignored |
| ipc_process | 2 passed |
| release 合成回歸 | 新版 18/18 情境成功；前版音訊缺口 9/9 失敗、純補幀 9/9 成功 |
| clippy --all-targets -D warnings | 通過 |
| LF／差異空白與新增秘密字串檢查 | 通過；未修改無關檔案 |
| cargo fmt --check | 未通過：原有格式差異仍存在，沒有無關重排 |
| 全產品 fast/full | 前置路徑檢查失敗，未宣稱通過 |

第一次未篩選完整 cargo test：361 passed、2 failed、7 ignored；其中一項是已更新的舊 E2E 契約，另一項是基底可重現的實體音訊排除測試。更新契約後重新跑其餘完整套件，exit 0；保留前一個實體音訊失敗紀錄，沒有把它計為通過。

驗證結論：可審查草稿 PR；不具備直接發布所需的完整產品／遊戲效能證據。CodeScene 未配置，不捏造分數；未做覆蓋率量測。
