# Apex Highlighter

> **Apex 英雄自動精彩時刻分析與剪輯工具**
>
> 專為《Apex 英雄》（Apex Legends）長錄影與精華重播設計的本機自動精彩時刻擷取軟體。透過純視覺特徵與多層次模板匹配技術，在毫秒級速度下自動標記擊倒與助攻，並提供直覺的時間軸預覽與無損快速剪輯匯出功能。

---

## 🌟 核心特色

1. **純視覺模板分析（安全無封號風險）**
   - 僅讀取本機影片畫面（MP4 / MKV / MOV / WebM），不掛鉤遊戲程序、不讀取遊戲記憶體。
   - 支援 1080p、1440p、4K 等多種錄影解析度的自動等比例縮放與定位。
   - 整合擊倒／助攻圖示比對、名稱簽章防重複計入（90 秒防洗榜）機制。

2. **智慧隊友觀戰過濾**
   - 偵測死亡後觀戰隊友視角，自動排除隊友擊倒標記，保證個人精華純度。

3. **強大檢視器與 AI 自動合輯**
   - 互動式畫布時間軸、事件熱度分佈與三態標記修正（計入／排除／手動補記）。
   - 快捷鍵支援（空白鍵播放／暫停、`S` 倍速切換、`Ctrl+←/→` 跳至事件、`Ctrl+E` 送入剪輯專案）。
   - 一鍵 AI 智慧片段產生（基於事件密集度自動聚合多擊倒團戰高潮）。

4. **剪輯專案與序列編輯器**
   - 支援片段分割（Split）、微調（Trim）、複製、拖曳排序與完整 Undo/Redo 歷史堆疊（`Ctrl+Z` / `Ctrl+Y`）。
   - 專案存取（`.apexproj.json`）隨時還原與二次編輯。

5. **彈性匯出選項**
   - **快速無損模式（Stream Copy）**：直接複製關鍵影格串流，毫秒即刻產出，極速零失真。
   - **精準轉碼模式（Precise Re-encode）**：畫面精準至毫秒切點，支援 NVIDIA NVENC、Intel QSV、AMD AMF GPU 硬體加速編碼，以及 Cisco OpenH264 CPU 編碼。

---

## 🌐 與遊戲語言無關

擊倒／助攻橫幅的**文字**隨遊戲介面語言而不同，但橫幅上的**圖示**（分數箭頭、單人／三人圖示、握手、骷髏、「+」號）不會。
本工具只用圖示加與語言無關的版面線索（敵人名字色、第二行）偵測，**不需要選擇遊戲語言**，繁體中文、簡體中文、English、日本語等介面都適用，新增語言不需要任何事件樣板。

- 只偵測**擊倒**與**助攻**（助攻擊倒、助攻消滅）；獨立消滅與小隊抹殺不偵測。
- 圖示樣板只從 English／Japanese／簡中錄影取得；繁中與其他錄影只用來驗收（見準確度報告的訓練／驗收分割）。
- 唯一與語言有關的是觀戰提示條樣板（繁中／英／日並列，任一命中即算觀戰）；簡中沒有觀戰樣板，偵測不到觀戰。
- 色盲模式：紅（預設）、黃（紅／藍色盲）、粉紅（綠色盲）的敵人名字都處理。
- 已知限制：舊版遊戲（約 2026-07 以前）的「敵方小隊已消滅」橫幅也用單人加分圖示，會被誤判；擊倒與助攻擊倒只靠版面線索區分。
- 準確度數字與限制：[`docs/accuracy-report-icon.md`](docs/accuracy-report-icon.md)；範本來源：`templates/icons/PROVENANCE.md`。

---

## 💻 系統需求

- **作業系統**：Windows 10 / 11 64-bit
- **記憶體**：建議 8 GB RAM 以上
- **視訊解碼**：支援 H.264、HEVC、VP9、AV1（內建 dav1d 高效能解碼器）
- **儲存空間**：安裝需約 300 MB 可用空間

---

## 🚀 從原始碼建置

### 前置需求
- **Node.js**：v20 或以上（建議 v24 LTS）與 npm
- **Python**：v3.11 或以上
- **PowerShell**：Windows 內建 PowerShell

### 建置步驟
1. 複製專案庫：
   ```bash
   git clone https://github.com/ShiQu1218/Apex_highlighter.git
   cd Apex_highlighter
   ```

2. 設定 Python 虛擬環境與安裝引擎相依套件：
   ```powershell
   python -m venv engine\.venv
   .\engine\.venv\Scripts\python.exe -m pip install -e engine
   ```

3. 安裝前端相依套件：
   ```powershell
   cd app
   npm install
   cd ..
   ```

4. 執行一鍵自動化建置腳本：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build.ps1
   ```
   腳本將依序完成：
   - 使用 PyInstaller 建置引擎獨立目錄 (`build/engine/apexhl/`)
   - 下載並驗證 LGPL FFmpeg 執行檔 (`build/ffmpeg/`)
   - 編譯前端頁面並使用 `electron-builder` 打包出 NSIS 安裝檔與免安裝 Portable 版（輸出於 `dist/` 目錄）。

   FFmpeg 固定為 BtbN 的具名 autobuild（版本與 SHA-256 寫在 `scripts/fetch-ffmpeg.ps1`），下載檔雜湊不符時腳本會**失敗**而不是警告；
   若 `buildfmpeg-lgpl-shared.zip` 是舊版下載，請先刪除再重跑。

### 發版前重建檢查清單
1. 先跑測試：`engine\.venv\Scripts\python.exe -m pytest -q`（設定 `APEXHL_GOLDEN_VIDEO` 讓 test_golden 真的執行）、`npm --prefix app test`、`npm --prefix app run typecheck`、`npm --prefix app run test:e2e`。
2. 把舊的 `dist\`、`build\engine`、`build\pyinstaller-temp` 搬到備份位置（避免舊產物混入），再執行 `scriptsuild.ps1`。
3. 產物檢查：`dist\win-unpackedesources	emplates\icons\` 含 `profile.json`、6 張圖示與觀戰樣板且與 git 相同；`resources\enginepexhlpexhl.exe ipc` 的 ready 訊息 `engine_version` 為 `0.3.0`；
   `resourcesfmpeginfmpeg.exe -buildconf` 無 `--enable-gpl`／`--enable-nonfree`、有 `--enable-version3` 與 `--enable-libdav1d`；安裝檔內含 `THIRD_PARTY_NOTICES.md`、`LICENSE`。
4. 引擎版本 0.3.0／icons@1 起（改為圖示偵測），舊版（文字關鍵字法）產生的快取會自動重新分析；首次開啟舊專案會看到重新分析，使用者的刪除／覆寫依「同類型家族、時間差 ≤ 1 秒」保留。

---

## 📜 授權與第三方說明

- 本專案核心原始碼依據 [MIT 授權條款](LICENSE) 開源發布。
- 專案打包隨附之 FFmpeg 執行檔與動態連結函式庫為 **LGPL v3** 建置（`--enable-version3`，無 `--enable-gpl`／`--enable-nonfree`），其中的 libopenh264 為原始碼編譯而非 Cisco 官方二進位，詳見聲明檔。詳細第三方套件與授權宣告請參閱 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## ⚠️ 免責聲明

《Apex 英雄》（Apex Legends）為 Electronic Arts Inc. 之註冊商標。
Apex Highlighter 為獨立開發之開源工具，非 Electronic Arts Inc. 或 Respawn Entertainment 所官方授權、贊助或附屬之軟體。
