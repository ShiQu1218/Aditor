# Aditor 精簡 FFmpeg

建置 fork：[ShiQu1218/Aditor-FFmpeg](https://github.com/ShiQu1218/Aditor-FFmpeg/tree/aditor)。
本目錄維護 fork 的 `aditor/` overlay 與 `.github/workflows/build-aditor.yml`；
元件的唯一來源是主專案的 `scripts/ffmpeg-components.json`；
發佈到 fork 的 `aditor/ffmpeg-components.json` 作為該次建置快照。

## 固定來源

- BtbN：`63ac3265b0789ea16c7b1f8351cd2ad195a28722`，對應原安裝包的 autobuild tag。
- FFmpeg：`46d899d7a02bc63237472cc4897258d5ddf274ac`，release/8.1 的原版本，保持 recorder 的 ABI。
- NVENC headers：`ced4f8eba3ba5dd431932cba17928f0dffdaeb2b`，SDK 13.0，保留 Pascal/Maxwell 的驅動相容性。
- 其餘第三方來源沿用上述 BtbN commit 的 recipe pin：dav1d、OpenH264、AMF、libvpl，以及 PNG fixture 所需的 zlib。

清單的 `names` 是 CLI 名稱；`configureNames` 處理 `png_pipe`、原始 PCM muxer 等
名稱差異，空陣列表示 FFmpeg 自動加入的 buffer API filter。驗證仍檢查所有 CLI 元件。

`prepare.py` 繼承 `win64-lgpl-shared` 的授權／封裝環境，裁減依賴 recipe 與下載圖，
從 JSON 產生 configure，並把 FFmpeg checkout 固定到完整 commit。
版本 addin 仍為 `8.1`；這些第三方函式庫在 BtbN 中稱為 dependency recipes，不是 addins。
8.1 已無 postproc 函式庫，因此不傳不存在的 `--disable-postproc`。

## 重現建置

需要 Linux、Docker、Python 3、Git，以及 BtbN 的公開 base/base-win64 toolchain images。
Windows 本機只需要 PowerShell 5.1 以上即可驗證成品。

```sh
git clone --branch aditor https://github.com/ShiQu1218/Aditor-FFmpeg.git
cd Aditor-FFmpeg
python3 aditor/prepare.py . --manifest aditor/ffmpeg-components.json
python3 aditor/download-licenses.py
export QUICKBUILD=1 GITHUB_REPOSITORY=btbn/ffmpeg-builds
./makeimage.sh win64 lgpl-shared-aditor 8.1
./build.sh win64 lgpl-shared-aditor 8.1
```

沿用 BtbN Docker 化 toolchain、nasm 與最佳化設定。QUICKBUILD 省去重新編譯
交叉工具鏈，所有保留的第三方函式庫及 FFmpeg 仍依本地 recipe 重新編譯。
toolchain base image 的 `latest` 是上游管理的可變映像，因此這是固定原始碼／
recipe 的重建流程，不保證位元組完全相同；成品始終以 release ZIP 的 SHA256 固定。

ZIP 保留單一頂層目錄，包含 `bin/*.exe`、shared DLL、`lib/*.lib`、GNU import libraries、
`include/`、`LICENSE.txt`、`third-party-licenses/`、`build-config/`。
`build-config` 保存實際 `config.h`／`config_components.h`、完整 configure 參數、
清單、recipe 及 recipe commit。這些定義可查核 CLI 不提供列舉的 parser 與細分 hwaccel。

## 更新與發佈

1. 更新本專案的元件 JSON，填入用途與所有呼叫端／測試素材出處。
2. 將 `ffmpeg-build/*.py`、`smoke-test.ps1`、`link-check.c` 複製到 fork 的 `aditor/`；
   將 `scripts/ffmpeg-components.json` 和 `verify-ffmpeg-components.ps1` 也複製到 `aditor/`。
   將 `build-aditor.yml` 複製到 fork 的 `.github/workflows/`。提交並推送 fork。
3. 手動啟動 Build Aditor FFmpeg。`release_tag` 空白只產生 artifacts；指定
   `aditor-8.1-...` 才會在驗證通過後發佈。已存在的 tag 不得覆寫。
4. Windows CI 驗證元件、禁止 GPL/nonfree、x86asm、僅 file/pipe、bin ≤ **40,000,000 bytes**、
   軟體冒煙流程，以及真正用 MSVC 連結三個 import library 並執行。
5. 從 release 的 `SHA256SUMS` 更新 fetch 的 tag、asset、SHA256、URL；
   完整重建 recorder／engine／app，執行下列驗收後更新 THIRD_PARTY_NOTICES。

以下驗收指令在 **Aditor 主專案根目錄**執行；FFmpeg fork 本身不包含 engine／app／recorder。

```powershell
./scripts/verify-ffmpeg-components.ps1 -Strict -CheckPackage
./ffmpeg-build/smoke-test.ps1 -FfmpegPath ./build/ffmpeg/bin/ffmpeg.exe
./engine/.venv/Scripts/python.exe ./ffmpeg-build/acceptance.py `
  --ffmpeg ./build/ffmpeg/bin/ffmpeg.exe `
  --fixture-ffmpeg C:/path/to/developer/ffmpeg.exe `
  --baseline-ffmpeg C:/path/to/original/BtbN/bin/ffmpeg.exe
./scripts/build.ps1
./scripts/test.ps1 -Tier full -KeepGoing
```

`acceptance.py` 用額外的開發用 FFmpeg 產生輸入格式，所有受測分析、縮圖、proxy、
軟體解碼與匯出都使用 `--ffmpeg`。它不會把 `auto` 的軟體 fallback 記成硬體通過。
JSON 結果及素材留在忽略版控的 `build/ffmpeg-acceptance/`；效能比較交錯順序、暖機後
各執行五次，以中位數檢查 5% 回歸門檻。NVIDIA／AMD／Intel 錄影與真實長錄影仍需實機驗收。

## LGPL 測試素材

2026-10-23 使用者同意調整測試。engine／E2E 的 H.264 合成素材改用隨附的
`libopenh264`，關閉跳幀並保留原來的 GOP、解析度、時序與所有測試斷言。
rawvideo 標準輸入明確使用 `pipe:0`，符合成品只保留 file／pipe 的設定。
AV1 解碼／fallback 測試改用版控內的合成 AV1 fixture，避免依賴未隨附的
`libsvtav1` 而跳過。生成命令、版本與 SHA256 記在該 fixture 的 README。
獨立格式驗收另直接測試 AV1 8/10-bit。

## 回滾

將 `fetch-ffmpeg.ps1` 的 release pin 改回原 BtbN 四個值後執行 fetch。
既有 SHA stamp 會替換成正確的 DLL；接著必須重新編譯 recorder，不能混用兩個 FFmpeg 版本。
