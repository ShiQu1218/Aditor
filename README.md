<p align="center"><img src="app/resources/icon.png" alt="Aditor app icon" width="128" height="128"></p>

# Aditor

**English** ｜ [繁體中文](README.zh-TW.md)

> **Automatic highlight recording, analysis and editing for Apex Legends and VALORANT**
>
> Record your *Apex Legends* or *VALORANT* matches, or drag in videos you already have. Aditor marks every Apex knockdown and assist, or every VALORANT kill and death, automatically, then lets you pick highlights on a timeline and export them. Everything runs locally on your PC from on-screen pixels only — no cloud, no game injection.

> [!IMPORTANT]
> **Apex Legends: Battle Royale (casual) and Ranked only.** Wildcard, Team Deathmatch and other modes are not supported.
>
> **VALORANT:** kills, deaths, rounds, multi-kills and aces. Deathmatch records kills and deaths but has no rounds. See [Known limitations](#known-limitations) for the recommended window mode and other caveats.

**Download:** [Releases](https://github.com/ShiQu1218/Aditor/releases) (Windows 10 / 11, 64-bit)

---

## Screenshots

Real Apex Legends recordings and saved analysis results, shown in the Traditional Chinese UI.

### Video library

Each recording shows its detected knockdowns, assists and highlights. For example, the 08:57 recording has **10 knockdowns and 4 assists**.

<p align="center"><img src="docs/screenshots/library.jpg" alt="Video library with saved knockdown and assist counts on recording cards" width="960"></p>

### Studio overview

The same recording has **14 recorded events**, marked across the timeline alongside the gameplay preview and suggested highlights.

<p align="center"><img src="docs/screenshots/studio-overview.jpg" alt="Studio showing a knockdown in the gameplay preview and 14 events on the timeline" width="960"></p>

### Event detail and editing

Zoom in to see individual knockdown and assist markers, then add a suggested highlight to the project for export.

<p align="center"><img src="docs/screenshots/studio-detail.jpg" alt="Zoomed timeline with knockdown and assist markers and a 19-second highlight added to the project" width="960"></p>

---

## Features

| Feature | Description |
|---|---|
| Multiple games | Apex Legends and VALORANT; the game is recognized automatically, or you can pick it, or re-analyze a video as another game, from the video card |
| Offline analysis | Drop in a recording (MP4 / MKV / MOV / WebM); Apex knockdowns and assists, or VALORANT kills and deaths, are marked automatically |
| VALORANT rounds | Round win/loss strip on the timeline, plus multi-kill and ace highlights |
| Spectate filter | Apex: teammates' kills while you spectate after dying are not counted as yours |
| Built-in recording | Starts when a supported game launches; "one file per match" or "start to finish" |
| Recording GPU | On PCs with more than one GPU, choose which one captures and encodes (automatic by default) |
| OBS mode | OBS records, Aditor only detects and splits files |
| AI auto-compilation | Groups dense kills into multi-kill fight clips |
| Editing & export | Split, trim, reorder, undo, autosave; fast lossless or precise hardware re-encode |
| Multilingual UI | 繁體中文, 简体中文, English, 日本語, 한국어 |

---

## How it works

<p align="center"><img src="docs/diagrams/architecture.en.png" alt="Architecture" width="720"></p>

Three separate programs: the **Electron app** (UI), the **recorder `aditorrec`** (Rust, GPU capture and encoding) and the **analysis engine** (Python). A crash on one side never takes down the others.

### Kill detection

<p align="center"><img src="docs/diagrams/pipeline.en.png" alt="Detection pipeline" width="720"></p>

No machine learning — just template matching on the kill-banner icons, so it works in any game language. To reject lookalike banners, each video learns its own text templates from the first clear kills.

<p align="center"><img src="docs/diagrams/banner-decision.en.png" alt="Banner decision" width="720"></p>

### Match segmentation

<p align="center"><img src="docs/diagrams/match-state.en.png" alt="Match state machine" width="720"></p>

### VALORANT detection

The pipeline above is Apex Legends. VALORANT is also detected from on-screen pixels with image processing, without machine learning:

- **Kills and deaths:** the local player's yellow marker in the top-right kill feed, together with the victim's team color. Deaths are never counted as kills.
- **Rounds, multi-kills and aces:** rounds come from changes in the scoreboard digits at the top; two to four kills in a round form a multi-kill and five an ace. Deathmatch has no rounds.
- **Match boundaries while recording:** read from the Riot Client's local API (read-only; Aditor never touches game memory). If it is unreachable, Aditor tells you and records the whole session as one file.
- **Screen layouts:** 16:9, 16:10, 4:3 and 5:4, stretched or letterboxed.

### Recording

<p align="center"><img src="docs/diagrams/recording.en.png" alt="Recording pipeline" width="720"></p>

Video stays on the GPU and only hardware encoders are used, so the impact on the game is small. Recording is written in 2-second segments: a crash loses at most 2 seconds, and in "one file per match" mode the lobby is not kept.

<sub>Diagram sources: [`docs/diagrams/src/`](docs/diagrams/src)</sub>

---

## Resource usage measurements

Two local Windows sessions were measured on October 20, 2026 (UTC+8), with the recording bitrate set to **40,000 kbps (40 Mbps)**. Values cover Aditor and its child processes, including the recorder and analysis engines; they exclude the game and unrelated apps. These are observations from one PC. Hardware, recording resolution, frame rate and codec were not saved in the monitoring logs, so the results are not an RTX 3060 benchmark or a comparison with other recorders.

| Metric | 9 min 17 sec: average / peak | 60 min: average / peak |
|---|---|---|
| CPU, normalized to the whole machine | 0.75% / 2.52% | 0.72% / 8.70% |
| Resident working set, summed | 773 / 810 MiB | 962 / 1,397 MiB |
| Private committed memory | 1,884 / 1,904 MiB | 1,995 / 2,412 MiB |
| Process write I/O | 7.05 / 20.58 MiB/s | 15.01 / 606.10 MiB/s |
| GPU VideoEncode engine utilization, summed | 5.52% / 10% | Not collected |

The short session ran from 13:30:37 to 13:39:55 (552 samples, approximately one second apart); the long session ran from 14:00:08 to 15:00:08 (720 samples, approximately five seconds apart). Averages are arithmetic means of available samples. CPU and I/O rates exclude the initial sample without a baseline.

During the hour-long session, the recorder and live analysis engine showed about **4.2 MiB** and **1.0 MiB** of growth respectively, comparing the first and last three minute-window medians after five minutes of warmup. One UI process rose from approximately 73 MiB to 408 MiB near minute 51, then fell to about 255 MiB and stayed there through the end. No process met the sustained-growth screening criteria, but the retained UI memory warrants checking across repeated equivalent operations; this test does not establish the absence of leaks.

Working-set sums can double-count shared pages. Private committed memory includes non-resident pages and is not physical RAM usage. Process I/O includes cached and device I/O, so its peaks are not physical disk throughput. GPU values sum encoder-engine counters rather than total GPU usage. Game FPS, frame times, recording frame drops and GPU memory were not measured; these results do not quantify gameplay impact.

---

## Known limitations

- **Apex Legends:** only Battle Royale (casual) and Ranked are supported; Wildcard, Team Deathmatch and other modes are not.
- **Apex Legends:** only **knockdowns** and **assists** are detected; solo eliminations and squad wipes are not.
- **Apex Legends:** the spectate filter recognizes the hint bar in Traditional/Simplified Chinese, English, Japanese and Korean only.
- **VALORANT:** detection assumes the default HUD position; overlays that cover the top-right kill feed can cause missed kills.
- **VALORANT:** playing in **borderless window** (windowed fullscreen) is recommended; in exclusive fullscreen the game window can pop up or minimize and disturb recording. Non-16:9 layouts such as 4:3 normally require exclusive fullscreen.
- **VALORANT:** per-match splitting relies on the Riot Client's unofficial local API, which a Riot update may break; when that happens the session is recorded as one file. An imported video that is not 16:9 and carries no Aditor aspect tag is analyzed as 16:9.
- Some interface text still says "Apex" even when the video is another game.
- Recording needs a hardware encoder (NVENC / AMF / QSV); without one nothing is recorded.
- Detection relies on the game's UI; a game update may require updated templates.
- Accuracy reports (Traditional Chinese): [`docs/accuracy-report-icon.md`](docs/accuracy-report-icon.md), [`docs/accuracy-report-matches.md`](docs/accuracy-report-matches.md).

---

## Building from source

Requires Node.js 20+, Python 3.11+ and the Rust stable toolchain.

```powershell
git clone https://github.com/ShiQu1218/Aditor.git
cd Aditor
python -m venv engine\.venv
.\engine\.venv\Scripts\python.exe -m pip install -e "engine[dev]" pyinstaller
npm --prefix app install
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

The installer and portable build are written to `dist\`. Tests: `engine\.venv\Scripts\python.exe -m pytest -q` and `npm --prefix app test`.

---

## License

[GNU General Public License v3.0](LICENSE). The bundled FFmpeg is an LGPL v3 build; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

*Apex Legends* is a registered trademark of Electronic Arts Inc. *VALORANT* and Riot Games are trademarks or registered trademarks of Riot Games, Inc. Aditor is an independent open-source tool, not affiliated with or endorsed by Electronic Arts Inc., Respawn Entertainment or Riot Games, Inc.
