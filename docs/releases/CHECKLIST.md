# Release checklist

There is no CI, so this checklist is the release gate. Complete every item before tagging.

## 1. Automated tests

- [ ] Tool tests pass: `python -m pytest tools/tests -q` using `tools/requirements.txt`.
- [ ] `scripts\test.ps1 -Tier full` passes (typecheck, vitest incl. real engine/ffmpeg tests, engine/recorder cargo test, Playwright e2e).
- [ ] If the analysis engine changed: set `ADITOR_GOLDEN_VIDEO` and confirm the golden tests ran (not skipped).

## 2. Packaged build smoke test

Run against the installer produced by `scripts\build.ps1`, not the dev build.

- [ ] Install `Aditor-Setup-<version>.exe` on a clean profile; the app starts.
- [ ] Import a video, let analysis finish, and confirm highlights appear.
- [ ] Export a clip and play the result.
- [ ] Portable build starts and runs the same flow.

## 3. Recording changes only

Required when anything under `recorder/`, `app/src/main/recording/`, or the bundled FFmpeg changed.

- [ ] Record a 2+ minute clip on an NVIDIA (NVENC) machine; the file plays and segments are indexed.
- [ ] Record a 2+ minute clip on an AMD (AMF) machine; the recording does not stop early.
- [ ] Manual-only recorder tests (interactive desktop / hardware) still pass: `cargo test -- --ignored`.

## 4. Versioning and notes

- [ ] Version bumped in `app/package.json`.
- [ ] `docs/releases/v<version>.md` written (Traditional Chinese section, then English section).
- [ ] Release notes state which installed versions can auto-update and which need a manual download.
