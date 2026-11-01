# Aditor 更新日誌

## v0.4.3

### 新增與改善

- 新增錄影擷取方式的遊戲 FPS 影響標示，協助選擇擷取方式。

### 修正

- 修正錄影啟動與執行期間的音訊遺失：保留麥克風音訊、回報擷取中斷，並在混音器延遲啟動時保留 AAC 仍可接收的音訊。
- 修正多聲道音訊轉成立體聲時，後方與側邊環繞聲道遭丟棄的問題。
- 修正靜音後音訊時間戳、DDA 擷取可見性計時，以及 Riot Client 斷線時誤刪錄影分段的問題。
- 修正遊戲視窗結束時 Hook 擷取的等待行為，以及缺少引擎或錄影器執行檔時重複回報錯誤的問題。

### 更新方式

- 安裝版可透過應用程式內的更新功能下載並安裝。
- 免安裝版請下載 `Aditor-0.4.3-Portable.exe`。

---

# Aditor Changelog

## v0.4.3

### Improvements

- Show the measured game FPS impact of recording capture methods to help users choose a method.

### Fixes

- Prevent audio loss during recording startup and capture interruptions; preserve microphone audio, report capture failures, and retain startup audio that AAC can still accept when mixing starts late.
- Preserve rear and side surround channels when downmixing multichannel audio to stereo.
- Fix audio timestamps after silence, DDA capture visibility timing, and accidental deletion of recording segments after a Riot Client disconnect.
- Improve Hook capture shutdown when the game window closes and avoid duplicate error reports when the engine or recorder executable is missing.

### Updating

- Installed builds can download and install this update from within the app.
- For the portable build, download `Aditor-0.4.3-Portable.exe`.
