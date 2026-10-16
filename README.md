# Apex Highlighter

> **Apex 英雄自動精彩時刻分析與剪輯工具**
>
> 專為《Apex 英雄》（Apex Legends）長錄影與精華重播設計的本機自動精彩時刻擷取軟體。透過純視覺特徵與多層次模板匹配技術，在毫秒級速度下自動標記擊倒、助攻與全滅，並提供直覺的時間軸預覽與無損快速剪輯匯出功能。

---

## 🌟 核心特色

1. **純視覺模板分析（安全無封號風險）**
   - 僅讀取本機影片畫面（MP4 / MKV / MOV / WebM），不掛鉤遊戲程序、不讀取遊戲記憶體。
   - 支援 1080p、1440p、4K 等多種錄影解析度的自動等比例縮放與定位。
   - 整合擊倒橫幅比對、傷害值確認與名稱簽章防重複計入（90 秒防洗榜）機制。

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

## 🌐 支援的遊戲語言

《Apex 英雄》的擊倒／助攻橫幅隨遊戲介面語言而不同，本工具目前內建三組範本：

| 語言 | 代碼 | 狀態 |
|---|---|---|
| 繁體中文 | `zh-TW` | 完整支援（主要開發與驗證語言） |
| English | `en` | 支援；樣本較少，準確度證據弱於繁中（見下） |
| 日本語 | `ja` | 支援；觀戰偵測的範本取自驗收錄影，屬樣本內驗證 |

- **設定 → 遊戲介面語言**預設「自動偵測」：引擎先看影片畫面判斷語言；判斷不出來時會明確提示並請你手動指定，不會硬分析。
  也可手動選擇語言。**變更只影響之後的分析**。
- 簡體中文與其他語言尚未支援；沒有「敵方小隊已消滅」否決橫幅與較少的觀戰狀態是已知缺口（缺真實樣本）。
- 色盲模式：紅色盲／藍色盲（黃色名字）已處理，綠色盲未驗證。
- 準確度數字與限制：[`docs/accuracy-report-multilang.md`](docs/accuracy-report-multilang.md)；各語言範本來源：`templates/<lang>/PROVENANCE.md`。

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

---

## 📜 授權與第三方說明

- 本專案核心原始碼依據 [MIT 授權條款](LICENSE) 開源發布。
- 專案打包隨附之 FFmpeg 執行檔與動態連結函式庫嚴格遵循 **LGPL** 授權協議，不含任何 GPL 或非自由授權限制組件。詳細第三方套件與授權宣告請參閱 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## ⚠️ 免責聲明

《Apex 英雄》（Apex Legends）為 Electronic Arts Inc. 之註冊商標。
Apex Highlighter 為獨立開發之開源工具，非 Electronic Arts Inc. 或 Respawn Entertainment 所官方授權、贊助或附屬之軟體。
