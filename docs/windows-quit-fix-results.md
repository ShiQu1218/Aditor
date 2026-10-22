# Windows D5 離開流程修補結果

> 協調者最終驗收：`npm run typecheck` 通過；離開流程 12 項測試通過；`npm run test:fast` 共 181 個測試檔、1,844 項測試通過。下文「完整 fast suite 待重跑」記錄的是工作者交件當時的狀態。

- 日期：2026-10-22
- 任務：D5「5 秒離開上限可能中斷錄影收尾」
- 分支：`ShiQu1218/chore-check-win10-win11`
- 基準 commit：`5ee7a1e`
- 執行者：OpenCode `opencode/deepseek-v4.1-flash-free#max`（受協調者監督）
- 實機測試：**未執行**。依任務限制，未啟動 Aditor、未錄影／收音、未啟動遊戲、未安裝或發布產品；亦未執行 `npm install` 或測試，依約由協調者統一準備相依與驗收。

## 1. 問題與根因

`app/src/main/index.ts` 原本以固定 `timeoutMs: 5000` 建立 quit guard，而 quit guard 對**所有**工作套用同一個 `Promise.race` 逾時。錄影收尾 `recordingService.stop()` 會依序等待錄影器停止、即時快照、OBS 與 `finalizeSession()`（含 FFmpeg remux），可能遠超過 5 秒。時間一到，`app.quit()` 直接放行，Electron 主程序可能在 remux、rename 或圖書館入庫完成前結束，造成 `.part`、未入庫或下次啟動重複收尾。

另一方面，原本的 wiring 把 `library?.flush()` 放在一般任務中與錄影停止平行執行。flush 本身是同步呼叫，並非「沒有被 await」；真正的問題是整條工作（含錄影收尾、收尾後在 `finally` 執行的 flush 與 `engineClient.stop()`）都掛在同一個 5 秒 `Promise.race` 上，計時器先到就呼叫 `quit()` 放行。此時錄影收尾可能尚未完成，收尾後才新增的圖書館項目可能還沒 flush，engine stop 也可能還沒開始，程式就結束了；正常路徑下「先完成錄影收尾、再清理一般服務」的順序也沒有被獨立保證。

## 2. 修補設計

### 2.1 `QuitGuardOptions` 新增 `criticalTasks` 與 `earlyTasks`

`app/src/main/quit-guard.ts`：

- `criticalTasks`：必須先完成的工作，**不套用逾時**。每個任務都經由共用的 `run()` 包裝執行；同步拋出例外或 promise reject 都會被吸收並視為已完成，不阻止離開流程，也不會留下未處理的 rejection。
- `earlyTasks`：與 critical 工作同時啟動的獨立清理（立即 flush 圖書館、取消 export／proxy ffmpeg、停止資料夾監看），避免長時間 remux 期間繼續保留無關資源或讓既有變更只留在記憶體。它們仍會在離開前被等待，但若卡住則與一般清理共用逾時。
- `tasks`：既有的一般清理，維持 `timeoutMs` 有界等待；只有所有 `criticalTasks` 都 settle 之後才開始，且逾時從此時**重新起算**，因此長時間收尾不會吃掉 engine stop 的完整額度。
- 狀態機維持 `idle → running → done`：
  - `running` 期間再次收到 `before-quit` 只會 `preventDefault()`，不會重跑任務。
  - 進入 `done` 後才呼叫 `quit()`，因此 `app.quit()` 引發的下一次 `before-quit` 會直接放行，不會重入。
  - 一般清理逾時或全部完成都會清除計時器，`quit()` 只呼叫一次。
- 沒有把 5 秒放大，也沒有在 remux 期間強制 `kill()` 錄影器或 FFmpeg。

### 2.2 main 的 wiring

`app/src/main/index.ts` 改為呼叫新增的 `createAppQuitGuard()`，集中表達主程序的清理順序：

1. `earlyTasks`：先取消 export／proxy 並停止資料夾監看，再 `library.flush()`，全部在離開開始時立即啟動；及早 flush 可避免等待長時間 remux 時，既有圖書館變更只留在記憶體。
2. `criticalTasks`：`recordingService.stop()`；無論成功或失敗，`finally` 內再 `library.flush()`，把收尾新增的項目持久化。
3. `tasks`（此時才起算 5 秒）：`engineClient.stop()`。

`createAppQuitGuard()` 位於 `quit-guard.ts`，讓測試能直接驗證 main 實際使用的 wiring，而不是在測試中複製一份容易漂移的任務清單。逾時常數仍為 `5000`。

## 3. 測試

檔案：`app/src/main/quit-guard.test.ts`

新增／保留的測試：

| 測試 | 證明的行為 |
|---|---|
| `never cuts off a critical task at the general timeout` | critical finalization 超過一般 timeout（advance 60 秒）仍未完成時，不呼叫 `quit()`，且一般清理尚未開始；完成後才清理並離開 |
| `starts early cleanup while critical finalization is still in progress` | export／proxy／watcher 類的 early cleanup 在離開開始時立即執行，remux 未完成前不會退出 |
| `lets the quit continue when a critical task rejects` | critical promise reject 後可離開 |
| `lets the quit continue when a critical task throws synchronously` | critical 同步例外後可離開 |
| `still times out ordinary cleanup after critical work completes` | critical 先等待 60 秒後才完成，一般清理仍取得重新起算的完整 5 秒逾時 |
| `runs once while quitting is in progress and lets the quit triggered by quit() through` | 重複 `before-quit` 不重入；`done` 後的事件直接放行 |
| `finalizes the recording before flushing the library and running bounded cleanup` | main wiring 的順序：early flush／取消立即開始；`recording:start → recording:done → library:flush → engine:stop → quit` |
| `flushes the library after a failed recording stop and still bounds the engine stop` | 離開開始與錄影停止失敗後各 flush 一次，且 engine stop hang 仍受 5 秒上限約束 |
| 原有 4 個測試 | 一般任務等待、一般逾時、失敗不阻塞、重複事件不重跑 |

測試使用 `vi.useFakeTimers()`、`vi.advanceTimersByTimeAsync()` 與 deferred promise 控制完成時機，沒有依賴實際耗時；每個新測試都在 `afterEach` 還原真實計時器與 mock。

**執行狀態：** 工作者依指示未自行執行 `npm`／`typecheck`，由協調者統一驗證。協調者回報最新 `npm run typecheck` 已通過，`npx vitest run src/main/quit-guard.test.ts` 12 個測試通過（exit 0）且未處理 rejection 已排除；完整 fast suite 由協調者處理 Electron 環境後重跑。建議驗收命令：

```sh
cd app
npx vitest run src/main/quit-guard.test.ts
npx tsc --noEmit
```

### 3.1 後續修正：critical 失敗測試補上必填 `tasks`

協調者驗收回報 `npx vitest run src/main/quit-guard.test.ts` 有 2 個未處理 Promise rejection，`npm run typecheck` 也在 `quit-guard.test.ts:109/119` 失敗。原因是 `QuitGuardOptions.tasks` 為必填欄位，但「critical task rejects」與「critical task throws synchronously」兩個測試只傳了 `criticalTasks`。

執行時 `opts.tasks.map(...)` 會拋出 `TypeError`；由於 `finally` 仍會呼叫 `quit()`，原本的 assertions 反而維持綠燈，卻讓 async IIFE 留下未處理 rejection，這正是不能只看 assertions 的地方。現在兩個測試都明確補上 `tasks: []`，使型別與執行時設定一致。

同時重新檢查 `earlyTasks`、`criticalTasks` 與 `tasks` 的實作：三者都經由共用的 `run()` 執行，`run()` 以 `try/catch` 包住 `await task()`，因此同步例外與 promise rejection 都會被吸收；`Promise.all`／`Promise.race` 只會等待這些已正規化的 promise。修正後兩條失敗路徑（reject、同步 throw）都不再經過未定義的 `tasks`，也不存在其他由 guard 產生的未處理 rejection。

## 4. 驗收對照

| 驗收條件 | 結果 |
|---|---|
| 超過一般 timeout 時 critical finalization 未完成仍不能退出 | 已由 fake timer 測試涵蓋 |
| critical 完成或失敗後才可退出 | 完成、reject、同步例外皆有測試 |
| 普通清理 hang 仍能逾時 | 一般 guard 與 main wiring 各有測試 |
| 重複離開不重入 | 進行中第二次事件被阻擋且任務只跑一次；完成後放行 |
| 錄影 stop 後 library flush 與 engine stop 順序正確 | wiring 測試斷言完整順序；flush 位於 critical 的 `finally` |
| 型別與測試設定一致 | `tasks` 維持必填；兩個 critical 失敗測試明確傳入 `tasks: []`，協調者回報 typecheck 通過 |
| 不以 assertions 綠燈掩蓋未處理錯誤 | 所有任務經 `run()` 吸收同步例外與 rejection；協調者重驗回報未處理 rejection 已排除 |
| export／proxy 取消與 watcher 及早開始 | early tasks 在 critical 進行中即啟動，並有測試涵蓋 |
| engine stop 在錄影後取得完整 timeout | 一般清理計時器在 critical settle 後才建立，測試以先等待 60 秒再完成收尾驗證 |
| 不放大 5 秒、不硬殺 remux | `timeoutMs` 維持 5000；critical 無 timeout、無 kill |
| 所有權 | 僅修改 `quit-guard.ts`、`quit-guard.test.ts`、`index.ts`，新增本報告 |

## 5. 剩餘風險

1. **真正卡死的 remux 會讓程式無法自動結束**：這是刻意取捨，避免截斷正在寫入的影片。若 FFmpeg 真的永久卡住，使用者只能強制結束程序；目前沒有收尾進度 UI 或「第二次確認強制離開」。錄影器 `stop` 指令本身仍有既有的 15 秒通訊逾時，無上限等待的是 `recordingService.stop()` 的收尾／`finalizeSession()`／remux。
2. **強制結束／斷電仍可能留下未完成收尾**：本次只處理正常 `app.quit()` 路徑；程序被工作管理員終止、當機或斷電仍依賴既有下次啟動復原流程。
3. **一般清理仍可能在 5 秒被截斷**：例如 export／proxy 取消卡住、engine 父程序未結束。這是保留有界等待的既定行為；引擎子程序樹（V3）不在本次範圍。
4. **重複離開不會提供強制離開**：critical 等待期間使用者再按離開仍會被擋下，符合「不得截斷 remux」的要求，但缺少可見的「正在收尾」提示。
5. **尚未實機驗證**：未測量大檔案、HDD、OneDrive／網路磁碟或 Defender 掃描下的實際 remux 時間；單元測試只證明控制流與順序。建議依原報告 T08 以 30 分鐘以上、多分段錄影驗證。
6. **測試由協調者統一驗證**：本修訂依協調者回報的 2 個未處理 rejection 與 `quit-guard.test.ts:109/119` 型別錯誤修正；工作者未自行執行 `npm`／`typecheck`。協調者重驗回報 typecheck 通過、12 個測試通過且未處理 rejection 已排除，完整 fast suite 仍由協調者在 Electron 環境重跑。

## 6. 變更檔案

- `app/src/main/quit-guard.ts`：新增 `criticalTasks`、`earlyTasks`、`createAppQuitGuard()` 與不重入的離開流程；`tasks` 維持必填並在註解說明可傳空陣列。
- `app/src/main/quit-guard.test.ts`：新增 fake timer／deferred promise 的 D5 與 wiring 測試；critical 失敗測試補上必填的 `tasks: []`，消除型別錯誤與未處理 rejection。
- `app/src/main/index.ts`：改用 `createAppQuitGuard()`；取消工作與 watcher 及早開始，錄影收尾列為 critical，library flush 緊接其後，engine stop 維持 5 秒有界。
- `docs/windows-quit-fix-results.md`：本報告。
