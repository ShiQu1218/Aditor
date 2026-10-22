# Windows 10／11 相容性檢查清單

日期：2026-10-22。範圍：目前 Aditor 工作目錄的 Electron 介面、Rust 錄影器、Python 引擎、安裝與更新。

本文件是交給 OpenCode `opencode/deepseek-v4.1-flash-free`、推理強度 `max` 的審查任務。下列項目是候選風險，不代表已確認的錯誤，也不代表已在 Windows 10 與 11 上完成實機測試。

## 候選錯誤與檢查入口

| 類別 | 可能遇到的錯誤／觸發情境 | 優先檢查入口 |
|---|---|---|
| 系統版本與 API | 較舊 Windows 10 缺少擷取／音訊介面，啟動失敗、黑畫面或功能無法使用；確認最低支援組建與功能偵測 | `recorder/src/capture/mod.rs`、`recorder/src/audio/process.rs`、README |
| WGC 可選介面 | 滑鼠、邊框等設定呼叫失敗導致整段擷取停止；分辨必要能力與可忽略設定 | `recorder/src/capture/mod.rs` |
| 遊戲音訊回退 | 程序音訊不可用時改錄系統聲音，使用者是否收到明確提示；回退也失敗時是否正確停止 | `recorder/src/audio/mod.rs`、`process.rs`、錄影 IPC |
| 音訊裝置 | 沒有預設裝置、麥克風權限關閉、耳機拔除／藍牙切換、獨佔模式、取樣率與聲道改變，導致無聲、不同步或錄影中止 | `recorder/src/audio/`、`recorder/src/session.rs` |
| GPU 與編碼器 | NVENC／AMF／QSV 不支援所選格式、驅動過舊、編碼工作階段額滿、顯存不足、DLL 缺少或架構不符 | `recorder/src/gpu.rs`、`recorder/src/encode/`、`app/src/main/codecs.ts` |
| 多顯卡與多螢幕 | 筆電混合顯卡、指定編碼卡與顯示器所屬卡不同、遊戲移到另一螢幕，造成擷取失敗、黑畫面或尺寸錯誤 | `recorder/src/capture/dda.rs`、`gpu.rs`、`session.rs` |
| 顯示模式 | 獨佔全螢幕、Alt-Tab、最小化、解析度／DPI／更新率變動、HDR／SDR 切換，造成黑畫面、錯色或擷取無法恢復 | `recorder/src/capture/`、`app/src/main/recording/game-aspect.ts` |
| 工作階段切換 | 鎖定／解鎖、睡眠／喚醒、遠端桌面、驅動重啟，導致 DDA 存取遺失、計時中斷或工作執行緒卡住 | `recorder/src/capture/dda.rs`、`clock.rs`、`session.rs` |
| 程序與權限 | 管理員權限落差、遊戲重啟／PID 更換／視窗重建、反作弊環境，使偵測或錄影狀態失準；不可自行要求提升權限或停用防護 | `app/src/main/recording/game-watcher.ts`、`recorder/src/capture/mod.rs` |
| 路徑與編碼 | 中文／空白／特殊字元使用者名稱、長路徑、磁碟代號大小寫、保留檔名、結尾空白或句點、UNC 路徑，導致開檔或子程序啟動失敗 | `app/src/main/safe-path.ts`、`export/export-ipc.ts`、`engine.ts`、`engine/aditor/ffbin.py` |
| 儲存位置 | OneDrive 等同步資料夾、網路磁碟、拔除外接碟、唯讀或受控資料夾、磁碟已滿、FAT32 大檔限制，導致影片不完整或設定無法儲存 | `app/src/main/recording/storage-location.ts`、`disk.ts`、`storage-root.ts`、`library.ts` |
| 檔案鎖與復原 | Defender／播放器占用、EPERM／EBUSY、當機或強制關機，使暫存清理、重新命名、分段合併與復原失敗；不得刪除使用者影片驗證 | `recording/finalize.ts`、`recovery.ts`、`prune.ts`、`export/run.ts` |
| 子程序生命週期 | FFmpeg／Python／錄影器找不到、啟動失敗、IPC 中斷、取消匯出或離開程式後殘留子程序 | `app/src/main/engine.ts`、`recording/aditorrec-client.ts`、`export/killTree.ts`、`quit-guard.ts` |
| 封裝與執行環境 | 安裝版／免安裝版資源位置不同、FFmpeg DLL／Python 相依檔缺漏、寫入安裝目錄、工作目錄改變而無法啟動 | `app/electron-builder.yml`、`scripts/build.ps1`、`recorder/build.rs`、`engine/aditor.spec` |
| 安裝與更新 | 一般帳號、Program Files、更新時檔案被鎖定、離線／代理伺服器／TLS 失敗、版本或更新資產不一致；審查勿實際安裝或更新 | `app/src/main/updater.ts`、`updater-runtime.test.ts`、`app/electron-builder.yml` |
| OBS 與 Riot 整合 | OBS 未啟動／斷線／認證失敗、Riot 本機 API 或設定檔改變，導致錄影或切檔失敗、錯誤狀態未傳到介面 | `app/src/main/recording/obs-client.ts`、`obs-session.ts`、`valorant-client.ts` |
| PowerShell 與語系 | Windows PowerShell 5.1 與 PowerShell 7 差異、CIM 不可用、地區設定／時間／輸出編碼差異、環境變數 Path 大小寫 | `scripts/`、`recording/storage-location.ts`、`recorder/src/index.rs`、`proxy.ts` |

## 審查規則與交付

1. 使用繁體中文、台灣用語。檢查目前工作目錄，先閱讀適用的 AGENTS.md；保留所有既有變更。
2. 只做程式碼審查，不修改產品程式碼、不安裝相依套件、不更新系統、不錄製畫面／音訊、不啟動遊戲、不執行發布或遠端寫入。僅允許新增或更新 `docs/windows-compatibility-review.md` 作為結果報告。
3. 逐項追蹤實際呼叫、錯誤處理、回退與介面提示。既有保護或測試已涵蓋的情況應註明，不可當成新缺陷。例如音訊模組已存在程序音訊失敗時回退至系統音訊的邏輯，需評估完整路徑。
4. 每個已確認缺陷需附嚴重度、Windows 版本／組建條件、檔案與行號、觸發步驟、影響、最小修正建議、可行驗證方式。缺乏證據的項目列為「待驗證」，不要捏造 HRESULT 或測試結果。
5. Windows API 的最低組建若需確認，以 Microsoft 官方文件為準並附來源；無法查證就明記未知。不可將 Windows 11 或單台機器結果當作 Windows 10 證據。
6. 建議測試矩陣包含 Windows 10 22H2 與 Windows 11 各受測組建、NVIDIA／AMD／Intel／混合顯卡、一般帳號、安裝版／免安裝版、SDR／HDR、中文／長路徑。區分建議測試與已完成測試；Windows 10 更早版本的支援範圍需從 API 要求與專案政策確認。
7. 最後列出已確認問題、已防護項目、待實機驗證風險及未涵蓋範圍，並回報實際使用的模型與 max 設定；若設定不受支援，明確回報，勿默默改用其他模型或強度。
