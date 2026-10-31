# 複雜度優化與效能比較

2026-10-31，本機 Windows，合成資料；前後演算法在同一程序、相同輸入執行，暖機後取五次中位數。前端使用 Vitest/Node；Rust 使用既有 test profile（opt-level=2），不是 release。時間單位 ms；非整個應用程式的端到端效能。

| 路徑 | 1,000 筆 前→後 | 2,000 筆 前→後 | 4,000 筆 前→後 | 8,000 筆 前→後 |
|---|---:|---:|---:|---:|
| 全部加入 | 10.614→2.548 | 15.261→5.231 | 62.835→10.798 | 389.098→22.995 |
| 專案重疊狀態 | 5.111→0.120 | 4.957→0.210 | 21.336→0.550 | 81.986→0.819 |
| 關聯片段同步 | 6.624→0.123 | 12.481→0.255 | 61.090→0.531 | 236.255→0.994 |
| 保留片段開始時間查詢 | 4.865→0.068 | 4.011→0.131 | 18.877→0.187 | 70.876→0.371 |
| 批次狀態更新（reducer） | 11.244→0.045 | 42.164→0.105 | 170.015→0.206 | 415.861→0.441 |
| 自動剪輯（偏斜分割） | 0.438→0.087 | 1.778→0.194 | 7.187→0.376 | 28.732→0.882 |

前端每份輸入包含 N 個片段及 N 個同來源專案項目；項目比片段晚一秒，全部加入會新增 N 筆、重疊查詢只有端點接觸，因此必須檢查完整集合。關聯 ID 一對一。批次更新把全部片段復原為建議。時間查詢包含建索引成本。自動剪輯使用等距事件、n=1、before=after=0、max_len=1，測試原本最差的偏斜分割；不代表一般影片都有相同加速倍數。

## 複雜度

N 為事件數，C 為片段數，P 為專案項目數，M 為本次新增數。

- 關聯同步：O(CP) → 平均 O(C+P)，呼叫端一起改為一次批次更新。
- 重疊狀態：O(CP) → O(P log P + C log P)，保留嚴格重疊判斷。
- 保留片段時間查詢：O(MC) → O(C log C + M log C)。只索引原先保留片段，不排除相鄰的新建議。ID 衝突命名仍有原本的迴圈成本。
- 全部加入：移除反覆複製陣列，以時間分桶縮小查詢範圍；保留來源相等及起訖各差小於 0.001 秒的規則。集中在少數桶的既有資料仍可能造成平方級掃描，未宣稱最差線性。
- 批次狀態更新：O(MC) → 平均 O(C+M)，包含 Undo 復原。
- 自動剪輯分割：最差 O(N²) → O(N log N)，額外 O(N) 記憶體；最大間距相同仍選最左側。
- 自動剪輯合併排序：預建 ID→時間索引，單次 K 筆排序由 O(NK log K) → 平均 O(K log K)，另付 O(N) 建表成本。合併中的 contains、Vec::remove 與重複排序尚未重寫，整個 auto_clips 不保證 O(N log N)。

## 驗證及重跑

前端新增固定種子的 60 組差異測試，涵蓋近似去重邊界、重複關聯、時間查詢與批次 reducer；Rust 保留原版演算法作為測試 oracle，比較 400 組資料，包含重複時間、重複 ID、逆序輸入及多組剪輯參數。既有前端 370 項相關測試及引擎 parity 案例通過。

前端（在 app 目錄，以 PowerShell 執行）：

```powershell
$env:ADITOR_PERF='1'
npx vitest run src/renderer/studio/complexity.test.ts --reporter=verbose --silent=false
```

引擎（在專案根目錄）：

```powershell
cargo test --manifest-path engine/Cargo.toml autoclip --lib
cargo test --manifest-path engine/Cargo.toml autoclip --lib -- --ignored --nocapture
cargo test --manifest-path engine/Cargo.toml --test phase_b_parity derive_and_autoclip_reference_cases
```

效能測試平常略過，不在 CI 斷言耗時。未量測真實影片或 Electron 畫面延遲；未新增相依套件。
