<p align="center"><img src="app/resources/icon.png" alt="Aditor 應用程式圖示" width="128" height="128"></p>

# Aditor

[English](README.md) ｜ **繁體中文**

> **Apex Legends 精彩片段自動錄影、分析與剪輯工具**
>
> 錄下你的 *Apex Legends* 對局，或直接拖入手上已有的遊戲影片。Aditor 會自動標出每一次擊倒與助攻，讓你在時間軸上挑選精彩片段並匯出。全部在你的電腦上完成，只看畫面像素——不上雲端、不注入遊戲。

> [!IMPORTANT]
> **目前只支援「快速對戰」與「積分」模式。** 不支援外卡、死鬥等其他模式。

**下載：** [Releases](https://github.com/ShiQu1218/Aditor/releases)（Windows 10 / 11 64 位元）

---

## 介面預覽

以下使用實際錄影與已儲存的分析結果，介面語言為繁體中文。

### 影片庫

每支錄影都會顯示偵測到的擊倒、助攻與精華數量。例如 08:57 的錄影已記錄 **10 次擊倒、4 次助攻**。

<p align="center"><img src="docs/screenshots/library.jpg" alt="影片庫中的錄影卡片，顯示已儲存的擊倒與助攻統計" width="960"></p>

### 工作室全覽

同一支錄影共有 **14 個已記錄事件**，時間軸標出事件位置，並搭配遊戲畫面預覽與精華建議。

<p align="center"><img src="docs/screenshots/studio-overview.jpg" alt="工作室顯示遊戲中的擊倒畫面，以及時間軸上的 14 個事件" width="960"></p>

### 事件細節與剪輯

放大時間軸即可查看個別擊倒與助攻標記，再將建議精華加入專案，準備匯出。

<p align="center"><img src="docs/screenshots/studio-detail.jpg" alt="放大的時間軸顯示擊倒與助攻標記，並已將 19 秒精華加入專案" width="960"></p>

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

## 資源占用實測

於 **2026 年 10 月 20 日（UTC+8）**在同一台 Windows 電腦進行兩次量測，錄影位元率設定為 **40,000 kbps（40 Mbps）**。數據涵蓋 Aditor 及其子程序，包含錄影器與分析引擎，不含遊戲及其他軟體。監控紀錄未保存硬體型號、錄影解析度、FPS 與編碼格式，因此這些結果不代表 RTX 3060 效能，也不作為不同錄影軟體的排名依據。

| 項目 | 9 分 17 秒：平均／最高 | 60 分鐘：平均／最高 |
|---|---|---|
| CPU（以整台電腦為 100%） | 0.75%／2.52% | 0.72%／8.70% |
| 常駐記憶體合計 | 773／810 MiB | 962／1,397 MiB |
| 私有認可記憶體 | 1,884／1,904 MiB | 1,995／2,412 MiB |
| 程序寫入 I/O | 7.05／20.58 MiB/s | 15.01／606.10 MiB/s |
| GPU 編碼引擎使用率加總 | 5.52%／10% | 未收集 |

短時間測試為 13:30:37～13:39:55，共 552 次取樣，間隔約 1 秒；長時間測試為 14:00:08～15:00:08，共 720 次取樣，間隔約 5 秒。平均值為有效取樣的算術平均；CPU 與 I/O 速率排除沒有比較基準的首筆取樣。

一小時測試排除前 5 分鐘暖機後，以最初與最後各三個一分鐘視窗的記憶體中位數比較，錄影器與即時分析引擎分別增加約 **4.2 MiB** 與 **1.0 MiB**。其中一個介面程序在第 51 分鐘附近從約 73 MiB 升至 408 MiB，之後降至約 255 MiB，並維持至結束。沒有程序符合持續增長的篩檢條件，但介面保留的記憶體仍需透過重複相同操作追蹤；本次測試不能證明完全沒有記憶體洩漏。

常駐記憶體合計可能重複計入共享頁面；私有認可記憶體包含未常駐的頁面，不等同實際 RAM 占用。程序 I/O 包含快取與裝置 I/O，尖峰不代表實體磁碟吞吐量。GPU 數值是編碼引擎計數器的加總，不是整張顯示卡使用率。未量測遊戲 FPS、幀時間、錄影掉幀及顯示記憶體，無法由此推算對遊戲流暢度的影響。

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

[GNU GPL v3.0 授權](LICENSE)。隨附的 FFmpeg 為 LGPL v3 版本，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

*Apex Legends* 為 Electronic Arts Inc. 的註冊商標。Aditor 為獨立開發的開源工具，與 Electronic Arts Inc. 及 Respawn Entertainment 無任何關聯，亦未獲其授權或贊助。
