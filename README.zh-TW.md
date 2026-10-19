# Aditor

[English](README.md) ｜ **繁體中文**

> **Apex Legends 精彩片段自動錄影、分析與剪輯工具**
>
> 錄下你的 *Apex Legends* 對局，或直接拖入手上已有的遊戲影片。Aditor 會自動標出每一次擊倒與助攻，讓你在時間軸上挑選精彩片段並匯出。全部在你的電腦上完成，只看畫面像素——不上雲端、不注入遊戲。

> [!IMPORTANT]
> **目前只支援「快速對戰」與「積分」模式。** 不支援外卡、死鬥等其他模式。

**下載：** [Releases](https://github.com/ShiQu1218/Aditor/releases)（Windows 10 / 11 64 位元）

---

## 功能

| 功能 | 說明 |
|---|---|
| 離線分析 | 拖入錄影檔（MP4 / MKV / MOV / WebM），自動標出擊倒與助攻 |
| 觀戰過濾 | 陣亡後觀戰隊友時，隊友的擊殺不會算成你的 |
| 內建錄影 | 偵測到 Apex 啟動就開始錄；可選「一局一個檔」或「從頭錄到尾」 |
| OBS 模式 | 由 OBS 錄影，Aditor 只負責偵測與切檔 |
| AI 自動剪輯 | 把密集擊殺自動組成多殺團戰片段 |
| 剪輯與匯出 | 分割、修剪、排序、復原、自動儲存；快速無損或硬體精準重新編碼 |
| 多語系介面 | 繁體中文、简体中文、English、日本語、한국어 |

---

## 運作方式

<p align="center"><img src="docs/diagrams/architecture.zh-TW.png" alt="架構" width="720"></p>

由三個獨立程式組成：**Electron App**（介面）、**錄影器 `aditorrec`**（Rust，GPU 擷取與編碼）與**分析引擎**（Python）。任一邊當掉都不會拖垮其他部分。

### 擊殺偵測

<p align="center"><img src="docs/diagrams/pipeline.zh-TW.png" alt="偵測流程" width="720"></p>

不使用機器學習，只對擊殺橫幅上的圖示做樣板比對，所以不論遊戲語言都能用。為了排除長得很像的其他橫幅，每支影片會從開頭幾次明確的擊殺自己學出文字樣板。

<p align="center"><img src="docs/diagrams/banner-decision.zh-TW.png" alt="橫幅判斷" width="720"></p>

### 對局切分

<p align="center"><img src="docs/diagrams/match-state.zh-TW.png" alt="對局狀態機" width="720"></p>

### 錄影

<p align="center"><img src="docs/diagrams/recording.zh-TW.png" alt="錄影流程" width="720"></p>

畫面全程留在 GPU，且只用硬體編碼器，對遊戲效能影響很小。錄影以 2 秒為一段寫入：當機最多損失 2 秒；「一局一個檔」模式不保留大廳畫面。

<sub>流程圖原始檔：[`docs/diagrams/src/`](docs/diagrams/src)</sub>

---

## 已知限制

- 只支援快速對戰與積分；外卡、死鬥等模式不支援。
- 只偵測**擊倒**與**助攻**，不偵測單獨淘汰與滅隊。
- 觀戰過濾只認得繁中、簡中、英文、日文、韓文的提示列。
- 錄影需要硬體編碼器（NVENC / AMF / QSV），沒有就不錄。
- 偵測依賴遊戲介面外觀，遊戲改版後可能需要更新樣板。
- 準確率報告：[`docs/accuracy-report-icon.md`](docs/accuracy-report-icon.md)、[`docs/accuracy-report-matches.md`](docs/accuracy-report-matches.md)。

---

## 從原始碼建置

需要 Node.js 20+、Python 3.11+ 與 Rust stable 工具鏈。

```powershell
git clone https://github.com/ShiQu1218/Aditor.git
cd Aditor
python -m venv engine\.venv
.\engine\.venv\Scripts\python.exe -m pip install -e "engine[dev]" pyinstaller
npm --prefix app install
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

安裝檔與免安裝版輸出在 `dist\`。測試：`engine\.venv\Scripts\python.exe -m pytest -q` 與 `npm --prefix app test`。

---

## 授權

[MIT 授權](LICENSE)。隨附的 FFmpeg 為 LGPL v3 版本，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

*Apex Legends* 為 Electronic Arts Inc. 的註冊商標。Aditor 為獨立開發的開源工具，與 Electronic Arts Inc. 及 Respawn Entertainment 無任何關聯，亦未獲其授權或贊助。
