# Aditor

**English** ｜ [繁體中文](README.zh-TW.md)

> **Automatic highlight recording, analysis and editing for Apex Legends**
>
> Record your *Apex Legends* matches locally, or analyze footage you already have. Aditor marks every knockdown and assist automatically, then lets you pick highlights on a timeline and sequence editor and export them to files.
> Bring in your own game videos by dragging them into the app (or choose files), and Aditor analyzes them right on your PC. Everything works from on-screen pixels only, with no cloud services.

---

## Table of contents

1. [What it does](#what-it-does)
2. [How it works: overview](#how-it-works-overview)
3. [Detection: how kills and assists are recognized](#detection-how-kills-and-assists-are-recognized)
4. [Match segmentation: how a match start is found](#match-segmentation-how-a-match-start-is-found)
5. [Recording](#recording)
6. [Editing and export](#editing-and-export)
7. [Accuracy and known limitations](#accuracy-and-known-limitations)
8. [Project layout](#project-layout)
9. [System requirements](#system-requirements)
10. [Building from source](#building-from-source)
11. [License and third-party notices](#license-and-third-party-notices)
12. [Disclaimer](#disclaimer)

---

## What it does

| Feature | Description |
|---|---|
| Offline analysis | Drop in any Apex recording (MP4 / MKV / MOV / WebM) and every knockdown and assist is marked automatically |
| Spectate filter | While you spectate teammates after dying, their kills are not counted as your highlights |
| Built-in recording | Starts recording as soon as Apex is detected and detects while recording; choose "one file per match" or "record start to finish" |
| OBS mode | Let OBS do the recording; Aditor only detects and splits files |
| Viewer | Timeline, event distribution, manual additions, keyboard shortcuts |
| AI auto-compilation | Groups dense kills into multi-kill fight clips automatically |
| Edit projects | Split, trim, reorder, unlimited undo, autosave |
| Export | Fast lossless (stream copy) or precise re-encode (hardware encoders) |
| Multilingual UI | 繁體中文, 简体中文, English, 日本語, 한국어; follow the system language or pick one in Settings |

---

## How it works: overview

The software is made of three programs, each doing one job:

<p align="center"><img src="docs/diagrams/architecture.en.png" alt="Architecture: Electron App, aditorrec and the analysis engine" width="720"></p>

<sub>Diagram source: [`docs/diagrams/src/architecture.en.mmd`](docs/diagrams/src/architecture.en.mmd)</sub>

- **Analysis engine (Python)**: consumes frames only and outputs "what happened at which second". Offline analysis and live detection share the same logic; only the frame source differs (decoded video vs. crops sent live by the recorder).
- **Recorder aditorrec (Rust)**: captures the screen, encodes it on the GPU, and downsizes the small regions needed for detection into shared memory for the engine to read.
- **Electron App**: ties everything together and provides all the UI. The app itself never touches image data.

The two child programs are separate executables that talk over a line-per-JSON text protocol, so a crash on one side never takes down the other: if the engine dies, recording continues and analysis is filled in afterwards.

---

## Detection: how kills and assists are recognized

### The short version: no machine learning

The whole pipeline is classic computer vision: **template matching (OpenCV `matchTemplate`), color masks, stroke measurement, plus hand-written rules and thresholds**. No neural network, no model file, no GPU inference, and no labeled data.

The upside is that behavior is explainable and a wrong result can be traced to a specific rule. The cost is a dependence on the game UI's fixed appearance: when the game updates, templates and thresholds need retuning.

### Pipeline overview

<p align="center"><img src="docs/diagrams/pipeline.en.png" alt="Detection pipeline overview" width="720"></p>

<sub>Diagram source: [`docs/diagrams/src/pipeline.en.mmd`](docs/diagrams/src/pipeline.en.mmd)</sub>

### ① Sampling: look only where needed

- Frames are decoded with ffmpeg at **4 frames per second** (`FPS = 4`, so event timing resolution is 0.25 s).
- Whether the source is 1080p, 1440p or 4K, it is first scaled to 1920×1080 so all coordinates and template sizes can stay fixed.
- Only two small regions are cropped and stacked into one small image handed to Python:
  - **Kill-banner region**: lower middle of the screen, `(560, 700)`, size 800×180, where knockdown and assist notices appear.
  - **Spectate-hint region**: lower left, `(60, 1028)`, size 480×40.
- When GPU decoding is available, frames stay in GPU memory and are only copied back to the CPU after sampling, saving a lot of copying.

### ② Per-frame detection: icons first, language independent

The **text** on kill banners changes with the game language, but the **icons** do not. Detection therefore relies mainly on these icons and layout cues:

| Cue | Purpose |
|---|---|
| Triple arrow to the right of the score, "+" to the left of the arrow | Every "score banner" has them; without them it is not a banner we want |
| **Single-person icon** right of the arrow | Personal score: knockdown, assisted knockdown |
| **Three-person icon** right of the arrow | Squad score (squad wipe, respawn, etc.) → excluded |
| **Handshake icon** left of the first line | Assisted elimination |
| **Skull icon** left of the first line | Solo elimination → excluded |
| A **second, thinner line** under the first line | Only knockdowns have the "damage" line |
| **Enemy-colored text** on the first line | The enemy name of a knockdown is red (yellow or pink in colorblind mode); an assist is white text |

Each icon has just one tiny grayscale template (about 4 KB in total). Detection runs `matchTemplate` over the banner region, takes the best similarity, and judges by thresholds:

- Arrow + "+" + single-person icon, enemy-colored first line, second line present → **knockdown**
- Arrow + "+" + single-person icon, but white first line → **assisted knockdown**
- Handshake left of the first line → **assisted elimination**
- Anything else (solo elimination, squad wipe, respawn, supply bin, …) → **treated as no banner**

<p align="center"><img src="docs/diagrams/banner-decision.en.png" alt="Banner decision diagram" width="720"></p>

<sub>Diagram source: [`docs/diagrams/src/banner-decision.en.mmd`](docs/diagrams/src/banner-decision.en.mmd)</sub>

To handle icon size differences between resolutions, each video starts with a **one-time icon scale calibration** (picking the best fit between 0.9× and 1.1×); after that a single scale is used for matching to stay fast.

### ③ Keyword verification: templates are "learned" from the video itself

Icons alone leave a loophole: some other banners in the game (for example "Enemy squad eliminated") also use the single-person score icon. Telling them apart takes **text**, but words look completely different across languages, and shipping templates for every language is impractical.

So Aditor **learns from the video itself**:

1. It scans the **first 900 seconds at most** and picks banners that are clearly kills as anchors:
   - Banners with a very high handshake score → assisted-elimination anchors
   - Banners with a damage line and a plausibly readable enemy name → knockdown anchors
2. For each anchor kind it takes the first 4 banners, 2 frames each, and extracts the stroke image (a mask of the thin white strokes) of the first line.
3. **Averaging across banners**: backgrounds differ between banners, so averaging erases them and leaves only the few characters that are identical every time. That is this video's "keyword template".
4. Every candidate banner afterwards is matched against the templates (similarity ≥ 0.7 counts as a hit):
   - Hits the assist prefix → reclassified as assisted knockdown
   - Hits the knockdown keyword → stays a knockdown
   - Hits neither while a matching template exists → discarded as not a kill banner

So Korean, Japanese, Simplified Chinese or any other UI language **needs no text template built in beforehand**. There are two costs:

- Each template needs at least **3 distinct banners** to activate. If the first 900 seconds do not provide enough, Aditor **keeps looking for anchors through the rest of the video**, fills in only the missing template, and then re-judges the whole video from what it already recorded (no second decode). Only when the entire video has fewer than 3 usable kills does it fall back to icons only, where banners like "Enemy squad eliminated" are more likely to be counted by mistake.
- A template already learned in the first 900 seconds is never changed by later anchors.
- If an analysis is cancelled while it is still learning past 900 seconds, it restarts from the beginning next time.

Live detection learns while recording: frames are buffered during the learning phase and judged retroactively afterwards. If the first 900 seconds are not enough, it keeps learning while you play and re-judges what has been recorded so far as soon as a template is learned. The final result is the same as offline analysis.

### ④ Event tracking: merging consecutive hits into one event

A single banner stays on screen for about 2–10 seconds, so it hits many frames in a row. `EventTracker` merges them into **one event**:

- Consecutive hit frames (tolerating a 1-frame gap) belong to the same *run*; a gap longer than 0.5 s (2 frames in a row) means the banner is gone, and the next appearance is a new event.
- A run's type is decided by **majority vote**, because icon cues are less reliable while the banner fades in.
- If the enemy name genuinely changes inside one run (name fingerprint changes, with a gap or a score dip in between), the run is split into two events; jitter caused merely by HUD occlusion does not split it.
- Enemy names are compared by "fingerprint": the strokes of the name region are turned into a small bitmap and compared by similarity. No text recognition is done.

### ⑤ Derivation: deciding what "counts"

Each event is judged in order:

1. Deleted by the user → not counted.
2. Inside a **spectate interval** → not counted (see below).
3. **Within 90 seconds, only the first event per enemy fingerprint counts**; the rest are marked duplicates. Events without an enemy name, such as assists, are not deduplicated.
4. Everything else → counted.

Users can also manually override whether any event counts; on re-analysis these edits are kept by matching "same type, time difference ≤ 1 s".

### Spectate filter

After you die you spectate teammates, and their kills pop up the same banners on screen; those must not count as yours. Aditor looks at the **control-hint bar at the lower left** ("Show player banners", "Next teammate" and the like):

- The hint bar is text with no icon to use, so this is the **only language-dependent part** of the whole detection.
- Built-in templates: Traditional Chinese, Simplified Chinese, English, Japanese, Korean. **A hit on any template counts as spectating**, so the user does not have to choose a language.
- The hint must appear for at least 2 seconds in a row to count, and then every event inside that interval is excluded.
- Languages without a template cannot detect spectating, so kills made while spectating get counted and have to be excluded by hand.

### Independent of the game language

Apart from the spectate hint bar, kill detection therefore **does not require choosing a language**. The icon templates were cropped only from English, Japanese and Simplified Chinese recordings; Traditional Chinese and other languages were used only for acceptance testing (never for tuning), to make sure it does not work for just one language.

---

## Match segmentation: how a match start is found

"One file per match" and "keep only matches, not the lobby" both need to know **where a match starts and ends**. This also uses no machine learning, just **scene classification + a state machine**.

### Scene classification

Once per second, a full-screen grayscale thumbnail at 640×360 is matched against a set of templates of "fixed UI elements" to decide what kind of screen this is:

| Scene | Criteria (any one group fully satisfied) |
|---|---|
| `pre_match` (countdown / loading / character select) | Mode-card arrow + loading footer (or wildcard footer) |
| `lobby` | "Ready" button frame + mode-select frame |
| `in_match_hud` (in a match) | Minimap frame + health frame (including ranked and spectate variants) |
| `other` | None of the above (including the results screen; the results tabs are recorded separately as "match context") |

These templates match **frames and shapes**, not text, so they too are language independent.

### State machine (MatchTracker)

Classification results are fed into the state machine frame by frame, and it emits four kinds of events:

<p align="center"><img src="docs/diagrams/match-state.en.png" alt="Match state machine" width="720"></p>

<sub>Diagram source: [`docs/diagrams/src/match-state.en.mmd`](docs/diagrams/src/match-state.en.mmd)</sub>

Key points:

- **`match_pending` is emitted already during the countdown**, so OBS or the built-in recorder can keep footage from the countdown, character select and drop ship, instead of starting only once the HUD is seen after landing.
- **Confirmation is delayed, but timestamps are rewound**: a start is confirmed only once the HUD appears, and an end only after the lobby has persisted for 30 s without returning to the match; once confirmed, the event timestamp is moved back to the moment it actually happened.
- **The lobby does not end a match immediately**: returning to the lobby often leads straight into rewards or the store, and may also be a false reading, so there is a 30 s buffer, and returning to the HUD cancels it so one match is not cut into two.
- **Cancel**: if after the countdown the player returns to the lobby (matchmaking cancelled) or 180 s pass without entering a match, `match_cancel` is emitted.
- **Missed start**: if recording begins in the middle of a match, 3 s of continuous HUD is taken as the match start (`hud_resume`).

---

## Recording

### No injection, no memory reading

Recording uses the public Windows screen-capture APIs (the same kind OBS uses) and reads only "pixels on the screen":

- No injection into the game process, no hooking, no reading of game memory.
- Detecting whether Apex is running relies only on the process name and window.

This is a design principle, but this project cannot vouch for how any third-party anti-cheat system will judge it. Please assess the risk yourself.

### Two capture methods

| Method | Characteristics |
|---|---|
| **DDA** (default, Desktop Duplication) | Captures the whole screen with lower latency and no effect on mouse feel. Cost: when Apex is not in the foreground (for example you Alt+Tab to another window), the recorded Apex picture is **black**; this is deliberate, so another window is never mistaken for game footage |
| **WGC** (Windows Graphics Capture) | Captures the Apex window directly, unaffected by other windows covering it, but with slightly higher latency |

In DDA mode the picture only returns when Apex is back in the foreground; match segmentation recovers by seeing the HUD for 3 s in a row, so if you switch away mid-match and come back, the match is still recognized correctly.

### Recording pipeline

<p align="center"><img src="docs/diagrams/recording.en.png" alt="Recording pipeline" width="720"></p>

<sub>Diagram source: [`docs/diagrams/src/recording.en.mmd`](docs/diagrams/src/recording.en.mmd)</sub>

- **Video stays on the GPU throughout**: only the small detection crops are moved to the CPU, so the impact on game performance is small.
- **Hardware encoding only**: NVENC → AMF → QSV are tried in order; **if no hardware encoder is found, nothing is recorded**, rather than falling back to CPU encoding that would slow the game.
- **Audio**: system audio can be "game only" (process-level loopback), and a microphone can be mixed in separately.
- **Shared memory**: a 16-slot ring buffer; the writer never waits for the reader, and the reader checks sequence numbers before and after reading and drops torn frames. When the engine cannot keep up it only skips frames and never slows recording down.

### Where files go

The first launch walks you through choosing a root folder, a recording mode (one file per match / start to finish) and recording quality (default 1080p, 60 fps, 10000 kbps). All output then goes into fixed subfolders under that root:

```
<root folder>/
  Recordings/<YYYY-MM-DD>/Apex_….mp4    recordings, grouped by date (a match crossing midnight counts as the day it started)
  Exports/Merged/…                       edit output: merged into one file
  Exports/Clips/…                        edit output: one file per clip
```

Folder names are always English and do not change with the UI language, so switching language never changes a path. Temporary work (see below) lives in `Recordings/.sessions/`.

### Why 2-second segments

Recording is not written as one big file but as **one fMP4 segment every 2 seconds**, each starting with a keyframe:

```
<root folder>/Recordings/.sessions/<session id>/
  init.mp4          initialization segment
  seg_000001.m4s …  2 seconds each
  index.jsonl       one line appended after each segment is written; the single source of truth
  events.jsonl      events detected live
  session.json      snapshot of this session's settings
```

This design solves several things at once:

- **A crash loses at most 2 seconds**: every finished segment is valid, and on the next launch the app scans for unfinished sessions and finalizes them.
- **Watch while recording**: the player loads segments one by one through MSE following the index, the timeline grows along with it, and events appear live.
- **Cutting needs no re-encode**: every segment starts at a keyframe, so picking a set of segments and concatenating them directly (stream copy) gives a valid video.
- **Deleting afterwards is possible**: lobby segments can simply be deleted (see below).

### Two recording modes

**Start to finish**: after Apex closes, all segments are concatenated into one `Apex_<date_time>.mp4`, with events including each match's start and end.

**One file per match**:

- Each match is output from **5 seconds before the countdown** to **5 seconds after the end**, using whole segments with stream copy.
- **The lobby is only kept for roughly the last 15 seconds**: some people idle in the lobby for hours, and keeping everything would fill the disk. Segments are therefore deleted while recording, keeping only "the last 15 seconds", "the match in progress" and "the countdown portion".
- Deletion happens only when live detection is **verifiably working** (judged from the progress the engine reports every 5 s, and deletion never goes past the time the engine has already analyzed); if detection is broken nothing is deleted, preferring to keep too much over missing a match.
- If the whole recording has no match and detection was healthy throughout → no file is output (just sitting in the lobby produces no video).

### OBS mode

If you want OBS's encoder settings, let OBS do the recording:

- Start and stop are controlled through OBS's built-in WebSocket (v5), over the network only, without touching the game.
- `aditorrec` still runs, but only captures and emits detection crops without encoding; the detection flow is the same as with built-in recording.
- In "one file per match", OBS starts recording when it sees the countdown (`match_pending`) and keeps the same file once the match is confirmed; if the countdown is cancelled it stops, and that file is not added to the library.
- If OBS is taken over while you had already started recording manually, Aditor only reuses it and never stops it for you.

### Safety measures

- Disk space is checked before and during every recording; below a threshold you are warned, and below a lower one recording stops and finalizes what was recorded.
- Capture starts 20 seconds after the game launches, avoiding the period when the game is most likely to misbehave right after opening.
- All key steps are written to the diagnostic log `%APPDATA%\Aditor\recording.log` (each line flushed to disk immediately), so a crash can be investigated afterwards.

---

## Editing and export

### AI auto-compilation

Clips are generated automatically from the counted events by these rules (defaults are adjustable):

1. Adjacent kills ≤ 20 s apart belong to the same group.
2. A group needs at least 3 kills.
3. The clip range is [first kill − 8 s, last kill + 4 s].
4. Anything over 90 s is split in two at the largest gap between kills.
5. Overlapping clips are merged when possible; if the merged clip is too long it is split again at the midpoint of the overlap.

### Edit projects

- The sequence editor supports split, trim, duplicate, drag-to-reorder, and full undo / redo.
- Projects autosave and are restored on the next launch.
- You can mark clips and add them to a project while still recording; after finalization they are repointed to the output file automatically.

### Export

| Mode | How | Characteristics |
|---|---|---|
| **Fast lossless** | Copies the stream directly starting from keyframes | Almost instant with no quality loss; cut points snap to keyframes |
| **Precise re-encode** | Re-encodes, with millisecond-accurate cut points | Slower; supports NVENC, QSV, AMF hardware encoding, and OpenH264 CPU encoding |

---

## Accuracy and known limitations

- Only **knockdowns** and **assists** (assisted knockdown, assisted elimination) are detected; solo eliminations and squad wipes are not.
- Known false positive: in older game versions (before about 2026-07) the "Enemy squad eliminated" banner also used the single-person score icon; when no keyword template was learned it gets counted.
- The spectate filter only supports hint bars in Traditional Chinese, Simplified Chinese, English, Japanese and Korean.
- Icon judgment depends on the game UI's fixed appearance, so a game update may require updated templates.
- Accuracy figures and how they were tested: [`docs/accuracy-report-icon.md`](docs/accuracy-report-icon.md) (icon detection), [`docs/accuracy-report-matches.md`](docs/accuracy-report-matches.md) (match segmentation). These reports are written in Traditional Chinese.
- Template provenance and the training / acceptance split: [`templates/icons/PROVENANCE.md`](templates/icons/PROVENANCE.md).

---

## Project layout

```
app/        Electron app (main: recording state machine, OBS, export, library; renderer: React UI)
engine/     Python analysis engine aditor (icon detection, event tracking, scene classification, match state machine, live mode)
recorder/   Rust recorder aditorrec (capture, hardware encoding, audio, shared memory)
templates/  Icon templates (icons) and scene templates (scene)
scripts/    Build scripts (build.ps1, fetch-ffmpeg.ps1)
tools/      Template extraction and accuracy acceptance tools
docs/       Accuracy reports and design documents
```

---

## System requirements

- **OS**: Windows 10 / 11 64-bit
- **GPU**: recording needs a GPU with hardware encoding (NVIDIA NVENC, AMD AMF or Intel QSV); offline analysis and editing alone do not
- **Memory**: 8 GB RAM or more recommended
- **Video decoding**: H.264, HEVC, VP9 and AV1 (bundled dav1d decoder)
- **Storage**: about 300 MB for installation, plus space for recordings

---

## Building from source

### Prerequisites

- **Node.js**: v20 or later (v24 LTS recommended) and npm
- **Python**: v3.11 or later
- **Rust**: stable toolchain (to build the recorder)
- **PowerShell**: the one built into Windows is enough

### Build steps

1. Get the source:
   ```bash
   git clone https://github.com/ShiQu1218/Aditor.git
   cd Aditor
   ```

2. Set up the Python virtual environment and install the engine dependencies:
   ```powershell
   python -m venv engine\.venv
   .\engine\.venv\Scripts\python.exe -m pip install -e "engine[dev]" pyinstaller
   ```

3. Install the front-end dependencies:
   ```powershell
   cd app
   npm install
   cd ..
   ```

4. Run the one-step build script:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\build.ps1
   ```
   The script does, in order:
   - Builds the engine with PyInstaller (`build\engine\aditor\`)
   - Downloads and verifies the LGPL build of FFmpeg (`build\ffmpeg\`)
   - Compiles the Rust recorder
   - Compiles the front end and packages an installer and a portable build with `electron-builder` (output in `dist\`)

   If you only changed the app and left the engine and FFmpeg alone, add `-SkipEngine -SkipFfmpeg` to go faster.

   FFmpeg is pinned to a named BtbN autobuild (version and SHA-256 are in `scripts\fetch-ffmpeg.ps1`); on a hash mismatch the script **fails** instead of warning. If an old archive was downloaded, delete it and re-run.

### Pre-release checklist

1. Run the tests first:
   - `engine\.venv\Scripts\python.exe -m pytest -q` (the golden tests only really run when `ADITOR_GOLDEN_VIDEO` is set)
   - `npm --prefix app test`
   - `npm --prefix app run typecheck`
   - `npm --prefix app run test:e2e`
2. Move the old `dist\`, `build\engine` and `build\pyinstaller-temp` to a backup location so stale artifacts don't get mixed in, then run `scripts\build.ps1`.
3. Check the artifacts:
   - `dist\win-unpacked\resources\templates\icons\` contains `profile.json`, the 6 icons and all spectate templates, with contents identical to git.
   - In the ready message of `dist\win-unpacked\resources\engine\aditor\aditor.exe ipc`, `engine_version` is `0.3.0`.
   - `ffmpeg.exe -buildconf` has neither `--enable-gpl` nor `--enable-nonfree`, and has `--enable-version3` and `--enable-libdav1d`.
   - The installer includes `THIRD_PARTY_NOTICES.md` and `LICENSE`.
4. Engine 0.3.0 / icons@1 switched to icon detection; caches produced by the older text-keyword method are re-analyzed automatically, and user deletions and overrides are kept by matching "same type, time difference ≤ 1 s".

---

## License and third-party notices

- The core source code of this project is released as open source under the [MIT License](LICENSE).
- The bundled FFmpeg executables and dynamic libraries are an **LGPL v3** build (`--enable-version3`, without `--enable-gpl` / `--enable-nonfree`); the libopenh264 in it is compiled from source rather than Cisco's official binary. For the full list of third-party packages and license notices see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Disclaimer

*Apex Legends* is a registered trademark of Electronic Arts Inc.
Aditor is an independently developed open-source tool and is not officially licensed by, sponsored by, or affiliated with Electronic Arts Inc. or Respawn Entertainment.
