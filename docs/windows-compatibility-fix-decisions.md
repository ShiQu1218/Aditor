# Windows 相容性問題裁定與修補任務

日期：2026-10-22。協調者負責判斷與驗收；修補由 OpenCode `opencode/deepseek-v4.1-flash-free#max` 執行。原始報告是靜態審查，不能等同實機重現。

| 項目 | 裁定 | 指派方向 |
|---|---|---|
| D1 | 成立：端點錯誤設定音訊共用停止旗標，混音結束後 session watchdog 會終止錄影 | 單一音訊來源失效時保留另一來源與影片，以靜音補缺並發出一次可見警告；保留真正編碼／寫入故障的致命處理 |
| D2 | 部分成立：啟用但缺少裝置時未提示；保留靜音 AAC 軌與 audio=true 不必然錯，這表示容器有音軌 | 補上缺少來源警告，保留相容的音軌與 metadata 語義，不為消除靜音重構 mux |
| D3 | 成立：DDA 重新開啟仍綁原 GPU，跨 adapter 時無限重試 | 偵測確定的跨 adapter 不相容後明確失敗並走既有乾淨收尾；暫時失去顯示器、鎖定、模式切換仍應可重試，不能一律立即中止 |
| D4 | 成立：全域編碼器選單與 DDA 的實際 adapter 不一致 | 在實際 adapter 上處理不相容的指定編碼器，明確警告並回退同 codec 可用的硬體編碼器；不能靜默換 codec 或動到 WGC 手動偏好 |
| D5 | 成立：5 秒離開上限短於 recorder stop 的 15 秒與未定長度 remux | 錄影收尾列為必須等待的工作；其他清理仍保留逾時，避免只把 5 秒任意放大。驗證同步失敗、重複離開與尚在收尾的情形 |
| D6 | 成立：可選游標設定以 ? 傳遞錯誤使整段擷取失敗 | 將該設定改為 best effort 並記錄失敗，不宣稱整套程式因此支援任意舊組建，也不任意提高最低需求 |
| D7 | 成立：WGC fallback 沒有追蹤螢幕搬移，可能繼續錄製舊桌面 | 保存實際 capture monitor，於 monitor fallback 螢幕變更時安全重建，確保先停舊 capture，失敗時不要繼續錄舊螢幕 |
| D8 | 暫緩：逾時是有界等待設計，尚無初始化時間／裝置失敗證據 | 不單純加長逾時、不另做非同步音訊初始化重構；保留實機測試項目 |
| V1～V9 | 不視為已確認缺陷 | 本輪不擴大範圍；維持既有待驗證清單，若讀碼找到新證據再由協調者裁定 |

## 邊界與驗收

- 兩項互不重疊的任務：Rust 錄影器修補 D1/D2/D3/D4/D6/D7；Electron 離開流程修補 D5。
- 不啟動遊戲、不實際錄影／收音、不修改使用者資料、不安裝或發布產品、不建立 commit、不推送。允許使用現有工具鏈、在本工作目錄安裝測試所需相依套件與執行單元測試。
- 原始審查與任務文件保留；各工作者另寫自己的修補結果文件。需要擴大所有權先向協調者詢問。
- Rust 驗收：編譯、針對來源中斷／警告／GPU 相容性／capture 狀態的回歸測試；硬體測試明確標為未執行。
- Electron 驗收：quit guard 行為測試、型別檢查、相關錄影生命週期測試；依賴準備與驗收由協調者統一執行，避免並行安裝或共用 target 衝突。
- `max` 以 OpenCode 工作階段匯出 metadata 驗證；模型自己的文字聲明不作為唯一證據。

## 協調者複核補充

- D6 原報告的 1809 推論需更正：[Microsoft CreateForWindow 文件](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow) 列出的最低版本為 Windows 10 1903（18362）。將游標設定改為可選，只移除 1903／1909 的這一個阻擋，不能推論 1809 因此可用或宣稱整套相容性已驗證。
- 已查驗兩個修補工作階段的匯出 metadata，模型均為 `deepseek-v4.1-flash-free`、provider `opencode`、variant `max`。Rust session：`ses_e9e3ebacbffePIsiRHwZmbElYW`；Electron session：`ses_e9e3e511cffeLtcgD5zod7CnNY`。
- 第一輪 Electron 驗證發現測試斷言雖過，仍有未處理 Promise rejection；已退回工作者修正。修正後 `npm run typecheck`、離開流程 12 項測試，以及 `npm run test:fast`（181 個測試檔、1,844 項測試）均通過。完整測試使用現有相同版本 Electron 的本機執行檔路徑，未修改產品程式以配合測試環境。
- Rust 修補已以 `cargo test --locked --bin aditorrec --no-run` 編譯通過；針對音訊來源失效、跨顯示卡偵測、螢幕 fallback、編碼器回退與廠商辨識的 13 項單元測試通過。編譯有一項既有整合測試才使用的 `take_warning` dead-code 警告，不影響結果。
- 以上是編譯與自動測試證據，尚未在 Windows 10／11 實機重現拔插音訊裝置、跨顯示卡搬移、長時間 remux 等情境；硬體與實際錄影結果仍待實機驗證。
