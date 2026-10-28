# FFmpeg 精簡實作與驗收

日期：2026-10-23。精簡建置、來源切換、完整安裝包重建與全套測試已完成。
GPT-6.1 Sol medium 獨立審查未發現需修正的實質 bug；實機與 golden 素材限制詳列於下。

## 正式成品

- [Release aditor-8.1-20261023.1](https://github.com/ShiQu1218/Aditor-FFmpeg/releases/tag/aditor-8.1-20261023.1)
- [完整成功的 GitHub Actions](https://github.com/ShiQu1218/Aditor-FFmpeg/actions/runs/39827892920)：元件、parser／hwaccel、40 MB、軟體 smoke、MSVC import library 實際連結及執行皆通過。
- Recipe commit：`9fdbff2a8a5ce16285b9cdefdb72bc658067209b`。
- ZIP：`ffmpeg-46d899d-win64-lgpl-shared-aditor-8.1.zip`。
- SHA256：`087FDFD152EA5243CFFBF196BC488BCC9AF0F0898B81FD4A115F32167D489BEB`。

| 量測 | Bytes | 備註 |
|---|---:|---|
| 原版實際會封裝的 FFmpeg DLL／exe | 167,596,544 | 不包含原本就不封裝的 ffplay |
| 精簡 FFmpeg DLL／exe | 20,286,976 | 減少約 87.9% |
| 安裝後 resources/ffmpeg | 21,791,820 | 包含重新編譯的 recorder、依賴授權及 build-config；約 20.78 MiB |
| 完整 win-unpacked | 407,804,398 | 本次實際成品，不與不同版本的整包估算混用 |
| NSIS 安裝檔 | 120,843,364 | dist/Aditor-Setup-0.3.2.exe |
| Portable | 120,526,461 | dist/Aditor-0.3.2-Portable.exe |

執行原有 `scripts/build.ps1` 全部階段成功，當時包括 Python 打包（現已改為 Rust engine Cargo build）、fetch／SHA／Strict 驗證、
`cargo build --release`、app build、electron-builder NSIS／portable。下載、解壓與 SHA stamp 流程保持原樣。

`npm test` 的 192 個檔案、1,975 項測試已全部通過（包含 real-binary 測試）。

## 當時的正式全套測試

以下數字為 2026-10-23 的歷史結果。現行引擎測試改用 `cargo test --manifest-path engine/Cargo.toml`；Python 評估工具測試見 `tools/README.md`。

執行 `scripts/test.ps1 -Tier full -KeepGoing`，明確指定 `ADITOR_MATCH_DIR=E:/Apex_highlighter_clip`。

| 套件 | 結果 |
|---|---|
| FFmpeg Strict／package 驗證 | 通過，清單與成品內清單的 SHA256 相同 |
| app typecheck | 通過 |
| app npm test | 1,975 passed，192 個測試檔案全過 |
| recorder cargo test | 208 passed、6 ignored、0 failed；包含三種 NVENC 的實際編碼／分段／音訊／色彩驗證 |
| 舊引擎測試（含 slow） | 604 passed、3 skipped、1 xfailed、0 failed（14 分 1 秒） |
| E 槽完整場次 truth 驗收 | 所有 test_recording_acceptance 通過，沒有略過或失敗 |
| E2E | 23 passed、0 skipped、0 failed |

調整素材後的完整測試 log：`build/final-tests-fixtures.log`。
engine 剩下的 3 個 skip 均缺少指定 2026-07 golden 影片；不能以 E 槽其他錄影代替正確 truth。
AV1 解碼／fallback 的 2 項測試已實際執行並通過，不再依賴軟體 AV1 編碼器。
E2E 23 項全數實際執行並通過。整個 `-Tier full -KeepGoing` 指令以 exit 0 結束，
顯示 `All 'full' steps passed.`；沒有將略過計入通過。

## 正式版效能

使用 E 槽實際影片 `Apex_2026-10-19_08-49.mp4`（16.32 秒、1920×1080、60 fps、AV1＋AAC），
以 SHA256 驗證過的原 BtbN ZIP 另行解壓作為基準。暖機後交錯順序，每版各五次，中位數結果：

| 工作 | 相對原版時間變化 | 5% 回歸門檻 |
|---|---:|---|
| engine 軟體取樣 | -0.22% | 通過 |
| 完整 engine analyze | -0.53% | 通過 |
| OpenH264＋AAC MP4 匯出 | -0.40% | 通過 |

同輪的 14 種合成匯入格式，軟體解碼、縮圖及 proxy 全部通過；
支援的 H.264／HEVC／AV1／VP9 D3D11VA 路徑通過。
VP8／MPEG4／MJPEG 的 D3D11VA 記為 unavailable，詳見實機矩陣限制。
原始數據在 `build/ffmpeg-final-acceptance/results.json`。

## 獨立審查

原指定 Gemini 因配額耗盡無法使用；OpenCode 的 MiniMax 來源未啟用，實際呼叫回傳 Model unavailable。
使用者後續改指定 **GPT-6.1 Sol、medium** subagent；已啟動唯讀的獨立審查。
主代理負責重現與判定問題，針對成立問題指派修正，再請 subagent 複查。
第一輪未發現可重現、需修正的實質 bug；主代理核對其證據後沒有需指派的修正項目。
審查另獨立執行 Strict／CheckPackage、比對 source／成品 manifest SHA256，
以及用 ffprobe 確認 AV1 fixture 的解析度、幀率、幀數與長度。
最終複查發現一處文件將不可用的硬解路徑概括為通過；主代理判定成立並指派修正。
subagent 修正後逐項對照 JSON，確認未再發現需修正問題；沒有新增程式或測試變更。
原始審查紀錄：`build/ffmpeg-review.md`。

## E 槽真實影片

使用 `E:/Apex_highlighter_clip` 目前全部 13 段 MP4：1 段 HEVC、12 段 AV1，
每段在中途選取 2 秒測試，硬體 D3D11VA 與軟體 engine 解碼皆產生正確的 8 個取樣，
縮圖及 OpenH264＋AAC proxy 全數通過。素材內容沒有修改。
原有 `tests/test_matches.py::test_recording_acceptance` 另使用 truth.json 對完整錄影做場次驗收。
詳細原始證據保存在 `build/real-video-check/results.json` 與 `build/real-video-inventory.json`。

## 實作

- 公開 fork：[ShiQu1218/Aditor-FFmpeg](https://github.com/ShiQu1218/Aditor-FFmpeg/tree/aditor)。
- 元件清單：[ffmpeg-components.json](../scripts/ffmpeg-components.json)；每組有用途與程式／測試出處。
- configure 由清單產生；CLI／configure 的 `png_pipe`、PCM muxer 名稱差異亦記在清單。
- 自動 buffer API filter 僅做 runtime 驗證，不傳無效的 configure 開關。
- 固定原 BtbN 與 FFmpeg commit、NVENC SDK 13.0；保留 shared DLL 與 MSVC import libraries。
- 只建置 dav1d、OpenH264、AMF、nv-codec-headers、libvpl、zlib；zlib 是 PNG overlay fixture 所需。
- CI 檢查元件、實際編譯的 parser／hwaccel 定義、LGPL 設定、assembly、網路 protocol、40 MB、軟體流程與 MSVC 連結。
- 安裝包包含剩餘依賴的授權文字、configure、元件清單及建置 commit。
- 完整 build.ps1 後另外量測安裝資源的 FFmpeg 目錄，包含 recorder 與 notices，以 40,000,000 bytes 驗收。
- test.ps1 讓所有套件使用同一份隨附 FFmpeg，並還原執行前的環境變數。

## 呼叫端盤點

| 呼叫端 | 所需功能 |
|---|---|
| app export/encoders.ts、proxy.ts | H.264 NVENC／AMF／QSV／OpenH264、lavfi/color、null、scale、AAC |
| app export/plan.ts | MP4／MOV／concat、stream copy、PCM MOV、scale/pad/fps/format、anullsrc、aresample |
| app thumbnail.ts | JPEG encoder、image2 muxer、scale |
| app recording/finalize.ts、obs-finalize.ts、export/keyframe.ts | pipe/file、MP4 demux/mux、metadata/faststart、ffprobe |
| engine decode.py | Native H.264／HEVC／AV1／VP9 + D3D11VA/DXVA2、dav1d 軟體 AV1、fps/hwdownload/format/scale/split/crop/pad/vstack、rawvideo |
| engine matches.py、aspect.py、game_detect.py、probe.py | 相同匯入 decoder／容器、gray rawvideo、scale/fps、ffprobe |
| recorder encode/mod.rs、hardware.rs、ffmpeg.rs、mux.rs | 三家硬體編碼器、D3D11VA/QSV device、AAC、fragmented MP4、avcodec/avformat/avutil ABI |
| engine fixture | lavfi/testsrc2/sine、drawbox/overlay/select/setpts、PNG/rawvideo input、FFV1/Matroska |
| app export-real、recording/test-support | MPEG4 encoder、B-frame/open-GOP、s16le raw audio muxer |
| recorder encode/tests.rs | pcm_f32le encoder、f32le muxer、select/scale、rawvideo |
| app encoders.test.ts | h264_mf 僅為 parser 測試字串；正式選擇器不使用，因此未編入 |

所有呼叫點對應到 JSON 的 `sources` 欄位。額外保留的測試元件皆使用 LGPL 相容內建實作。

## 第一個候選成品的驗證證據

這一版尚缺 `png_pipe` configure 名稱對應及測試 raw PCM muxer，未切換為正式下載來源。
這些問題由驗證與原有測試發現後補清單，沒有修改測試斷言。

| 項目 | 結果 |
|---|---|
| bin | 20,285,440 bytes，低於 40 MB |
| 軟體 smoke | OpenH264、AAC、縮圖、engine graph、無音軌 MOV、concat、metadata、VFR／FFV1 通過 |
| 匯入格式 | 14 種格式的軟體 engine 解碼、縮圖、OpenH264 proxy 通過 |
| D3D11VA | H.264、HEVC 8/10-bit、AV1 8/10-bit、VP9 的 engine surface 路徑通過 |
| GPU probe | RTX 5080：H.264／HEVC／AV1 NVENC；AMD 1002:164e：H.264／HEVC AMF |
| AMD encode | 指定 AMD D3D11 device，H.264／HEVC AMF 各編碼 2 秒，成品軟體解碼通過 |
| engine 軟體取樣效能 | 五次中位數比原版快 8.27% |
| 完整 engine analyze 效能 | 五次中位數比原版快 9.94% |
| OpenH264＋AAC MP4 匯出效能 | 五次中位數比原版快 1.99% |

效能素材為相同的 8 秒 1920×1080、60 fps H.264＋AAC；暖機一次，交錯兩版順序，
每版各五次，以中位數檢查 5% 回歸門檻。數字代表本機合成素材，並非所有使用情境的速度保證。

## 實機矩陣限制

- NVIDIA NVENC 三種 codec：原有 recorder 真實 GPU encoding／keyframe／segment／色彩／音訊測試已通過。
- AMD H.264／HEVC：已實測 FFmpeg encoding 與 recorder 的實際 encoder probe；完整 recorder capture session 尚未驗收。
- AMD AV1：這台 AMD adapter 的 recorder 實際 probe 沒有列出 av1_amf，不能記為通過。
- Intel QSV：沒有 Intel GPU，僅能檢查編譯元件與 device API，不能記為實機通過。
- VP8／MPEG4／MJPEG：engine 沒有明確的 D3D11 surface 路徑；auto 成功可能是軟體解碼，故不記為硬體通過。
- DDA 及部分音訊測試需要可切換前景的互動桌面或實體播放裝置；原測試的 ignored 原因會保留。

## LGPL 測試素材調整

task.md 原要求不改測試，但舊 fixture 直接呼叫 GPL-only 的 `libx264`。
使用者於 2026-10-23 明確允許合理調整測試，因此只變更素材產生方式：

- engine/tests/conftest.py、test_aspect.py、test_probe.py 及 app/e2e/helpers/makeFixtures.ts 改用 OpenH264，關閉跳幀；保留 GOP、格式、解析度、時序與所有斷言。
- test_aspect 的 rawvideo 標準輸入改成明確的 `pipe:0`；FFmpeg 8.1 的 `-` 輸入會使用未保留的 fd protocol。
- AV1 兩項解碼／fallback 測試使用 1 秒、60 fps 的純 testsrc2 合成素材，納入版控，附生成命令、來源版本與 SHA256。避免因未隨附 libsvtav1 而略過。
- 重點驗證：decode／probe 37 項通過，aspect 19 項通過。沒有放寬或刪除既有斷言。

測試執行器改用 PATH，讓所有套件使用隨附版本，並避免 ADITOR_FFMPEG override 繞過 missing-binary 測試。

## 重現與升級

見 [ffmpeg-build/README.md](../ffmpeg-build/README.md)。
