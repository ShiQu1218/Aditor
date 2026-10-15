# Apex Highlighter — 計畫 1：分析引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可獨立以 CLI 與 JSON Lines IPC 執行的 Python 分析引擎：輸入 Apex 影片，輸出事件、觀戰區間、關鍵影格與快取 JSON，並附準確率評估與速度基準工具。

**Architecture:** ffmpeg 子程序負責解碼（降幀 → 縮放到 1920×1080 → 裁出提示區與觀戰區 → vstack → bgr24 rawvideo），Python 以 OpenCV 範本比對做單格偵測，串流狀態機產生原始事件，再由 `derive` 對整份清單推導是否計入；`autoclip` 依間隔分群產生片段。範本與閾值放在 `templates/zh-TW/profile.json`。

**Tech Stack:** Python 3.14、opencv-python（abi3 wheel）、numpy、pytest、ffmpeg/ffprobe 8.x（開發期用系統 PATH 上的版本）、ccl_chromium_reader（僅 tools）。

**Spec:** `docs/superpowers/specs/2026-10-15-apex-highlighter-design.md`（執行者必讀，計畫中的 §編號皆指此檔）

## Global Constraints

- 套件路徑：`engine/apexhl/`；測試：`engine/tests/`；虛擬環境：`engine/.venv`（加入 `.gitignore`）。
- 執行 Python 一律 `engine/.venv/Scripts/python -m pytest ...`，工作目錄為 `engine/`。
- 依賴只允許：`opencv-python`、`numpy`（runtime）；`pytest`（dev）；`ccl_chromium_reader`（只給 `tools/outplayed_truth.py`）。
- ffmpeg/ffprobe 路徑解析順序：環境變數 `APEXHL_FFMPEG`/`APEXHL_FFPROBE` → 引擎旁的 `ffmpeg/` 目錄 → PATH。集中在 `apexhl/ffbin.py`。
- 分析取樣率固定 `fps=4`；第 k 格時間 `t = start + k * 0.25`（`start` 為本次解碼的起點秒數），不得解析 showinfo、不得使用 `-copyts`。
- ffmpeg 子程序的 stdout 與 stderr 必須由兩個執行緒同時讀取；stderr 保留最後 64KB。
- 所有座標以 1920×1080 為基準。
- 事件類型字串固定：`knock`、`assist_knock`、`assist_elim`、`elim`、`squad_wipe`；計數類型為前四者。
- 預設值：`gap=20`、`n=3`、`before=8`、`after=4`、`max_len=90`、`dedupe_window=90`、連續命中 2 格、消失 ≥ 0.5 秒為新事件、觀戰連續 ≥ 2 秒成立、接續回退 5 秒、每 30 秒寫入 progress、16:9 容差 1%、校準比例 0.85–1.15 步長 0.05、校準收集 5 次命中。
- `ENGINE_VERSION = "0.1.0"`，定義於 `apexhl/__init__.py`。
- 測試用的真實影片路徑不寫死在測試中：以環境變數 `APEXHL_SAMPLE_DIR`（預設 `E:\Outplayed\Outplayed`）與 `APEXHL_GOLDEN_VIDEO` 指定，不存在時 `pytest.skip`。影片檔不得提交到 git。
- 不得修改 `E:\Outplayed\` 底下任何檔案（唯讀素材）。
- Commit 訊息結尾加上：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

1. **畫面上同時有兩個提示（堆疊）**：使用者預期兩個事件都被記錄 → Task 4 加入堆疊 fixture 測試（Task 2 若證實不會堆疊，改為記錄結論並略過）。
2. **影片中段有長時間沒有任何提示（跑圖、大廳、死亡畫面）**：預期 0 個事件 → Task 4 反例 fixture 測試、Task 10 黃金測試涵蓋。
3. **分析途中程式被關掉後重開**：預期事件不重複、不遺漏 → Task 10 `test_resume_no_duplicates`。
4. **影片檔名或路徑含中文與空白**（使用者的路徑 `E:\Outplayed\Outplayed\Apex Legends\...` 就有空白）：預期正常分析與快取 → Task 3 與 Task 9 測試以含中文與空白的路徑執行。
5. **ffmpeg 不存在或硬體解碼不支援**：預期明確錯誤或自動退回軟體解碼，而非掛住 → Task 3 `test_hwaccel_fallback`、Task 1 `test_ffbin_missing`。

---

## 檔案結構

```
engine/
  pyproject.toml
  apexhl/
    __init__.py        ENGINE_VERSION
    __main__.py        CLI 進入點（analyze / ipc 子命令）
    ffbin.py           ffmpeg/ffprobe 路徑解析
    models.py          VideoInfo, NameSig, FrameResult, Event, SpecInterval, Clip, AutoClipParams
    profile.py         Profile, load_profile, ProfileError
    probe.py           probe, keyframes, is_16x9
    decode.py          build_filter, iter_frames, DecodeError
    detect.py          white_mask, red_mask, Detector
    calibrate.py       calibrate
    events.py          EventTracker
    derive.py          derive, sig_similar
    autoclip.py        auto_clips
    cache.py           cache_path, load_cache, save_cache, needs_reanalysis, merge_reanalysis
    analyze.py         analyze
    ipc.py             serve
  tests/
    conftest.py        合成影片產生器、fixture 路徑
    fixtures/          真實畫面裁切 PNG（Task 2 產生）
    test_*.py
templates/zh-TW/
  profile.json
  kw_*.png, spec_*.png
tools/
  extract_templates.py
  outplayed_truth.py
  evaluate.py
  benchmark.py
```

---

### Task 1: 專案骨架、資料模型、profile 載入、probe

**Files:**
- Create: `.gitignore`、`engine/pyproject.toml`、`engine/apexhl/__init__.py`、`engine/apexhl/ffbin.py`、`engine/apexhl/models.py`、`engine/apexhl/profile.py`、`engine/apexhl/probe.py`、`engine/tests/conftest.py`
- Test: `engine/tests/test_models.py`、`engine/tests/test_probe.py`、`engine/tests/test_ffbin.py`

**Interfaces:**
- Produces:
  - `ffbin.ffmpeg() -> str`、`ffbin.ffprobe() -> str`；找不到時 raise `FileNotFoundError("ffmpeg not found ...")`。
  - `models.VideoInfo(path: str, duration: float, width: int, height: int, codec: str, start_time: float, size: int, mtime: float)`（frozen dataclass）
  - `models.NameSig(width: int, bits: np.ndarray)`：`bits` 為 `uint8` 0/1，高度固定 16；`to_b64() -> str`、`NameSig.from_b64(s) -> NameSig`（格式：`f"{width}:{base64(np.packbits(bits))}"`）。
  - `models.FrameResult(kind: str | None, score: float, x: int, damage_line: bool, name_sig: NameSig | None, spectating: bool)`
  - `models.Event(id: str, t: float, type: str, score: float, damage_line: bool, name_sig: str | None, counted: bool = False, counted_reason: str = "", counted_override: bool | None = None, source: str = "auto", deleted: bool = False)`；`to_dict()`／`Event.from_dict(d)`。
  - `models.SpecInterval(start: float, end: float)`、`models.Clip(id: str, start: float, end: float, origin: str, event_ids: list[str])`、`models.AutoClipParams(gap=20.0, n=3, before=8.0, after=4.0, max_len=90.0)`，皆有 `to_dict/from_dict`。
  - `models.COUNTING_TYPES = frozenset({"knock","assist_knock","assist_elim","elim"})`
  - `profile.Profile`：`lang: str`、`templates_version: str`、`banner_roi: tuple[int,int,int,int]`（x,y,w,h）、`spec_roi: tuple[int,int,int,int]`、`white: dict`（`v_min`, `s_max`）、`red: dict`（`r_min`, `g_max`, `b_max`）、`keywords: dict[str, KeywordSpec]`（`file`, `threshold`）、`spec_templates: list[KeywordSpec]`、`name_sig_threshold: float`、`dedupe_window: float`、`dir: Path`；`profile.load_profile(dir: Path) -> Profile`；格式錯誤或檔案缺漏 raise `ProfileError`（訊息含缺漏的檔名）。
  - `probe.probe(path: str) -> VideoInfo`（ffprobe 失敗 raise `ProbeError`）、`probe.keyframes(path: str) -> list[float]`（以 `ffprobe -skip_frame nokey -select_streams v:0 -show_entries frame=pts_time` 取得，已扣除 start_time）、`probe.is_16x9(w: int, h: int) -> bool`。
  - `conftest.make_video(tmp_path, name, duration, *, start_time=0.0, vfr=False, marks: list[tuple[float, float]] = []) -> Path`：用 ffmpeg `testsrc2` 產生 1920×1080 H.264 影片；`marks` 為 `(t_start, t_end)`，在這些時間於 banner ROI 中央畫實心白框（`drawbox ... enable='between(t,a,b)'`）；`start_time` 以 `-output_ts_offset` 達成；`vfr=True` 以 `setpts` 抖動產生可變幀率。

- [x] **Step 1: 建立骨架**：`git` 已初始化；建立 `.gitignore`（`engine/.venv/`、`__pycache__/`、`*.mp4`、`*.mkv`、`node_modules/`、`dist/`、`out/`）、`engine/pyproject.toml`（套件 `apexhl`，依賴 `opencv-python`, `numpy`；dev 依賴 `pytest`），以 `py -3.14 -m venv engine/.venv` 建立環境並 `pip install -e engine[dev]`。
- [x] **Step 2: 寫失敗測試**

```python
# test_models.py
def test_namesig_roundtrip():
    bits = (np.random.default_rng(0).random((16, 40)) > 0.5).astype(np.uint8)
    s = NameSig(40, bits).to_b64()
    back = NameSig.from_b64(s)
    assert back.width == 40 and np.array_equal(back.bits, bits)

def test_event_dict_roundtrip():
    e = Event(id="e1", t=812.25, type="knock", score=0.91, damage_line=True, name_sig=None)
    assert Event.from_dict(e.to_dict()) == e
    assert e.to_dict()["counted_override"] is None

# test_probe.py
def test_is_16x9():
    assert is_16x9(1920, 1080) and is_16x9(1916, 1080)
    assert not is_16x9(1728, 1080) and not is_16x9(1440, 1080)

def test_probe_start_time(tmp_path):
    v = make_video(tmp_path, "空白 名稱.mp4", 4.0, start_time=5.0)
    info = probe(str(v))
    assert info.width == 1920 and info.height == 1080
    assert abs(info.start_time - 5.0) < 0.1 and abs(info.duration - 4.0) < 0.2

def test_probe_bad_file(tmp_path):
    p = tmp_path / "x.mp4"; p.write_bytes(b"not a video")
    with pytest.raises(ProbeError): probe(str(p))

def test_keyframes_relative(tmp_path):
    v = make_video(tmp_path, "k.mp4", 6.0, start_time=5.0)   # make_video 用 -g 60
    kf = keyframes(str(v))
    assert kf[0] == pytest.approx(0.0, abs=0.05) and kf[1] == pytest.approx(1.0, abs=0.05)

# test_ffbin.py
def test_ffbin_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("APEXHL_FFMPEG", str(tmp_path / "nope.exe"))
    with pytest.raises(FileNotFoundError): ffbin.ffmpeg()
```

- [x] **Step 3: 確認失敗**：`.venv/Scripts/python -m pytest tests -v` → 匯入錯誤。
- [x] **Step 4: 實作** `ffbin.py`、`models.py`、`profile.py`（本 Task 只需能載入，先以 `tests/fixtures/profile_min/` 內的最小 profile 做 `test_load_profile_missing_file` 測試：缺 PNG 時 `ProfileError` 訊息包含檔名）、`probe.py`、`conftest.make_video`。
- [x] **Step 5: 確認通過**：`.venv/Scripts/python -m pytest tests -v` 全數 PASS。
- [x] **Step 6: Commit** `feat(engine): scaffold package, models, profile loader, probe`

---

### Task 2: 素材查證與 zh-TW 範本、測試 fixture

這是調查型任務，結果決定後續閾值與 ROI。執行者需**親自查看**產生的 PNG。

**Files:**
- Create: `tools/extract_templates.py`、`templates/zh-TW/profile.json`、`templates/zh-TW/*.png`、`engine/tests/fixtures/zh-TW/{pos,neg}/*.png`、`engine/tests/fixtures/zh-TW/labels.json`、`engine/tests/test_profile_zh.py`
- Modify: `docs/superpowers/specs/2026-10-15-apex-highlighter-design.md` §3（回寫查證結果）

**Interfaces:**
- Consumes: `ffbin.ffmpeg()`、`profile.load_profile`
- Produces:
  - `tools/extract_templates.py dump <video> --start S --end E [--fps 4] [--roi x,y,w,h] --out DIR`：把 1920×1080 正規化後的 ROI 逐格存成 `t{秒數:08.2f}.png`。
  - `tools/extract_templates.py crop <png> --rect x,y,w,h --out FILE`。
  - `tools/extract_templates.py sheet <dir> --out FILE [--cols 4]`：把一批 PNG 拼成總覽圖方便目視。
  - `templates/zh-TW/profile.json`，鍵與 Task 1 的 `Profile` 一致，`templates_version: "zh-TW@1"`；`keywords` 至少含 `squad_wipe`（小隊抹殺）、`assist`（助攻）、`knock`（擊倒）、`damage`（造成）；`elim`（消滅）——「助攻，消滅」中的「消滅」字形即可作為 `elim` 範本。
  - `labels.json`：`{ "<fixture檔名>": {"kind": "knock"|...|null, "damage_line": bool, "spectating": bool, "enemy": "<名字或 null>"} }`。

- [x] **Step 1: 實作 `extract_templates.py`**（dump 使用 `fps=4,scale=1920:1080,crop=...` 並以 `-f image2`）。
- [x] **Step 2: 從 `E:\Outplayed\Outplayed\Exports\*.mp4` dump 寬鬆 ROI `560,700,800,180`**，用 `sheet` 目視，找出各類提示畫格。已知 `Project 63_...mp4` 含「小隊抹殺」「助攻，擊倒」「助攻，消滅」，`Project 60_...mp4` 第 2.5–5 秒含「擊倒 土豆 / 造成 60 點傷害」。
- [x] **Step 3: 查證 §3 待查證項目**，對原始長片 `E:\Outplayed\Outplayed\Apex Legends\Apex Legends_10-13-2026_16-46-44-410\Apex Legends_10-13-2026_18-26-50-167.mp4`（約 100 分鐘）以 `--fps 1` 分段 dump 整個畫面縮圖（`--roi 0,0,1920,1080` 搭配縮放或 sheet）找出：(a) 兩個提示同時出現時的版面；(b) 自己死亡後觀戰的畫面、觀戰固定字樣與位置；(c) 擊倒紅字與助攻白字的名字字型粗細是否相同；(d) 以 `probe.keyframes` 量測關鍵影格間距。
- [x] **Step 4: 決定最終 `banner_roi` 與 `spec_roi`**（banner 需容納堆疊；`spec_roi` 寬度 ≤ banner 寬度），裁出關鍵字範本（只含字形、緊貼邊界、以白字遮罩後的二值圖儲存）與觀戰字樣範本，寫 `profile.json`（閾值先填 0.75，Task 11 再調整）。
- [x] **Step 5: 建立 fixtures**：banner+spec 大小的 PNG，正例每類 ≥ 3 張（含淡入動畫第一格 1 張，標為 `kind` 正確但測試允許漏判）、堆疊 ≥ 1 張（若存在）、反例 ≥ 15 張（跑圖、物品欄、死亡畫面、觀戰、爆炸火光、大廳），填寫 `labels.json`。
- [x] **Step 6: 寫測試並通過**

```python
def test_zh_profile_loads():
    p = load_profile(REPO / "templates/zh-TW")
    assert p.templates_version == "zh-TW@1"
    assert {"squad_wipe","assist","knock","damage","elim"} <= set(p.keywords)
    x, y, w, h = p.banner_roi; assert 0 <= x and x + w <= 1920 and y + h <= 1080
    assert p.spec_roi[2] <= w
```

- [x] **Step 7: 回寫 spec §3**：把每個「待查證」改成查證結論（附證據：影片名＋時間點）。
- [x] **Step 8: Commit** `feat(templates): add zh-TW profile, templates, fixtures; record §3 findings`

---

### Task 3: 解碼管線

**Files:**
- Create: `engine/apexhl/decode.py`
- Test: `engine/tests/test_decode.py`

**Interfaces:**
- Consumes: `ffbin`, `VideoInfo`, `Profile`
- Produces:
  - `decode.build_filter(profile: Profile) -> str`：產生 §5.1 的 `-filter_complex` 字串（`fps=4,scale=1920:1080,split` → 兩路 `crop` → spec 路 `pad` 到 banner 寬 → `vstack`）。
  - `decode.iter_frames(path: str, profile: Profile, *, start: float = 0.0, hwaccel: bool = True) -> Iterator[tuple[float, np.ndarray, np.ndarray]]`：產出 `(t, banner_bgr, spec_bgr)`，`t = start + k*0.25`；`start > 0` 時用輸入端 `-ss start`。產生器被關閉（`close()`）時終止 ffmpeg。
  - `decode.DecodeError(message: str, stderr_tail: str)`。
  - 硬體解碼失敗回退：`hwaccel=True` 時若 ffmpeg 在輸出第一格前以非 0 結束，自動以 `hwaccel=False` 重試一次，並在產生器屬性 `used_hwaccel: bool` 上反映（以 class 包裝 iterator：`FrameStream`，有 `__iter__`、`close()`、`used_hwaccel`、`stderr_tail`）。

- [x] **Step 1: 寫失敗測試**

```python
def test_frame_times_and_shapes(tmp_path, zh_profile):
    v = make_video(tmp_path, "中文 路徑.mp4", 3.0)
    frames = list(FrameStream(str(v), zh_profile))
    assert len(frames) == 12
    assert [f[0] for f in frames[:3]] == [0.0, 0.25, 0.5]
    x, y, w, h = zh_profile.banner_roi
    assert frames[0][1].shape == (h, w, 3)
    assert frames[0][2].shape == (zh_profile.spec_roi[3], zh_profile.spec_roi[2], 3)

@pytest.mark.parametrize("start_time,vfr", [(5.0, False), (0.0, True)])
def test_mark_time_alignment(tmp_path, zh_profile, start_time, vfr):
    v = make_video(tmp_path, "m.mp4", 6.0, start_time=start_time, vfr=vfr, marks=[(3.0, 3.6)])
    lit = [t for t, b, s in FrameStream(str(v), zh_profile) if b.mean() > 200]
    assert lit[0] == pytest.approx(3.0, abs=0.25)

def test_resume_start(tmp_path, zh_profile):
    v = make_video(tmp_path, "r.mp4", 6.0, marks=[(4.0, 4.6)])
    lit = [t for t, b, s in FrameStream(str(v), zh_profile, start=2.0) if b.mean() > 200]
    assert lit[0] == pytest.approx(4.0, abs=0.25)

def test_hwaccel_fallback(tmp_path, zh_profile, monkeypatch):
    monkeypatch.setattr(decode, "HWACCEL_ARGS", ["-hwaccel", "nonexistent_accel"])
    v = make_video(tmp_path, "h.mp4", 1.0)
    fs = FrameStream(str(v), zh_profile)
    assert len(list(fs)) == 4 and fs.used_hwaccel is False

def test_stderr_flood_no_deadlock(tmp_path, zh_profile, monkeypatch):
    monkeypatch.setattr(decode, "LOGLEVEL", "debug")   # 大量 stderr
    v = make_video(tmp_path, "d.mp4", 10.0)
    assert len(list(FrameStream(str(v), zh_profile))) == 40   # 以 pytest timeout 60s 保護
```

- [x] **Step 2: 確認失敗**：`.venv/Scripts/python -m pytest tests/test_decode.py -v`
- [x] **Step 3: 實作 `decode.py`**：模組常數 `HWACCEL_ARGS = ["-hwaccel", "auto"]`、`LOGLEVEL = "error"`；stdout 以 `readinto` 讀固定位元組數（`banner_w * (banner_h + spec_h) * 3`），stderr 由 daemon thread 讀進 `collections.deque` 限 64KB。
- [x] **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): ffmpeg two-ROI decode pipeline with hwaccel fallback`

---

### Task 4: 單格偵測

**Files:**
- Create: `engine/apexhl/detect.py`
- Test: `engine/tests/test_detect.py`

**Interfaces:**
- Consumes: `Profile`, `NameSig`, `FrameResult`
- Produces:
  - `detect.white_mask(img_bgr, profile) -> np.ndarray[uint8 0/255]`（HSV：`V >= white.v_min` 且 `S <= white.s_max`）
  - `detect.red_mask(img_bgr, profile) -> np.ndarray`（`R >= r_min` 且 `G <= g_max` 且 `B <= b_max`）
  - `detect.Detector(profile: Profile, h_scale: float = 1.0)`；`Detector.detect(banner_bgr, spec_bgr) -> FrameResult`；`Detector.best_scale_score(banner_bgr, scale: float) -> float`（給 calibrate 用：該比例下所有關鍵字的最高分）。
- 演算法（§5.2）：banner 依 `h_scale` 水平縮放後求 `white_mask`；依序比對 `squad_wipe` → `assist` → `knock` → `elim`（`TM_CCOEFF_NORMED`，分數 ≥ 該關鍵字 `threshold` 即命中）；`assist` 命中時在其右側搜尋 `knock`/`elim` 決定 `assist_knock`/`assist_elim`（都找不到時視為 `assist_elim`，`score` 取 assist 分數）；`knock` 時在第一行下方搜尋 `damage` 設 `damage_line`。名字指紋：取關鍵字右緣到同一行 `white_mask ∪ red_mask` 的連續文字區塊（遇到超過 `1.5 × 字高` 的空白即停止，以排除 `+150`），裁邊後縮放成高 16 的 0/1 陣列，寬度依比例。`spectating`：`spec_templates` 任一分數 ≥ threshold。

- [x] **Step 1: 寫失敗測試**（讀取 `fixtures/zh-TW/labels.json`）

```python
def test_positive_fixtures(zh_detector, labeled):
    for name, lab in labeled(kind_not_null=True, exclude_fadein=True):
        r = zh_detector.detect(*load_fixture(name))
        assert r.kind == lab["kind"], name
        assert r.damage_line == lab["damage_line"], name

def test_negative_fixtures(zh_detector, labeled):
    for name, lab in labeled(kind_null=True):
        assert zh_detector.detect(*load_fixture(name)).kind is None, name

def test_spectating_fixtures(zh_detector, labeled):
    for name, lab in labeled():
        assert zh_detector.detect(*load_fixture(name)).spectating == lab["spectating"], name

def test_assist_not_confused_with_knock(zh_detector, labeled):
    for name, _ in labeled(kind="assist_knock"):
        assert zh_detector.detect(*load_fixture(name)).kind == "assist_knock"

def test_name_sig_same_enemy_across_colors(zh_detector, labeled):
    # 同一 enemy 的 knock（紅字）與 assist_*（白字）fixture 配對；若 Task 2 找不到此配對則以同一類型的同名配對測試
    a, b = same_enemy_pair(labeled)
    sa = zh_detector.detect(*load_fixture(a)).name_sig
    sb = zh_detector.detect(*load_fixture(b)).name_sig
    assert sig_similar(sa, sb, zh_profile.name_sig_threshold)

def test_stacked_banner(zh_detector, labeled):   # Task 2 證實不會堆疊時改為 pytest.skip 並註明證據
    ...
```

（`sig_similar` 於本 Task 先在 `detect.py` 內提供 `name_sig_similarity(a: NameSig, b: NameSig) -> float`；`derive.sig_similar` 於 Task 7 包裝它。）

- [x] **Step 2: 確認失敗**
- [x] **Step 3: 實作 `detect.py`**
- [x] **Step 4: 確認通過**；若因閾值不通過，只允許調整 `profile.json` 數值，並在 commit 訊息說明。
- [x] **Step 5: 加一個效能測試**：`test_detect_speed`——對 1 張 fixture 連續 `detect` 200 次，平均 < 3ms。
- [x] **Step 6: Commit** `feat(engine): template-matching frame detector`

---

### Task 5: 水平比例校準

**Files:**
- Create: `engine/apexhl/calibrate.py`
- Test: `engine/tests/test_calibrate.py`

**Interfaces:**
- Consumes: `FrameStream`, `Detector.best_scale_score`
- Produces: `calibrate.calibrate(path: str, info: VideoInfo, profile: Profile, *, max_scan_seconds: float = 600.0) -> float`：從 `duration/2` 開始解碼（到尾端後從 0 繼續，總計最多 `max_scan_seconds`），每格以 `scale=1.0` 偵測；命中（任一關鍵字 ≥ threshold）的畫格保留，收滿 5 張後，對比例 0.85…1.15（步長 0.05）各自求 5 張的平均 `best_scale_score`，回傳最高者；收不滿 5 張則用已收集的；一張都沒有回傳 1.0。另提供 `calibrate.scan_scales(frames: list[np.ndarray], detector) -> float`（純函式，供測試）。

- [x] **Step 1: 寫失敗測試**

```python
def test_scan_scales_identity(zh_detector, pos_banners):
    assert calibrate.scan_scales(pos_banners[:5], zh_detector) == pytest.approx(1.0)

def test_scan_scales_stretched(zh_detector, pos_banners):
    # 把正例 banner 水平拉伸 1.10 倍（模擬拉伸解析度），應找回 1/1.10 ≈ 0.90
    stretched = [cv2.resize(b, None, fx=1.10, fy=1.0) for b in pos_banners[:5]]
    assert calibrate.scan_scales(stretched, zh_detector) == pytest.approx(0.90, abs=0.05)

def test_scan_scales_empty(zh_detector):
    assert calibrate.scan_scales([], zh_detector) == 1.0
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): per-video horizontal scale calibration`

---

### Task 6: 串流事件追蹤

**Files:**
- Create: `engine/apexhl/events.py`
- Test: `engine/tests/test_events.py`

**Interfaces:**
- Consumes: `FrameResult`, `Event`, `SpecInterval`, `detect.name_sig_similarity`
- Produces: `events.EventTracker(profile: Profile, *, resume_start: float | None = None)`；`feed(t: float, r: FrameResult) -> None`；`finish() -> tuple[list[Event], list[SpecInterval]]`。規則（§5.3 串流階段）：
  - 同一 `kind` 連續 2 格命中才成立，`t` 取第一格；
  - 新事件條件：該提示消失 ≥ 0.5 秒（即 ≥ 2 格無命中）後再出現，或 `kind` 改變，或名字指紋相似度 < `name_sig_threshold`；
  - `resume_start` 不為 None 時，若在 `t == resume_start` 那一格就已命中，該提示視為延續、不產生事件（直到它消失）；
  - 觀戰連續 ≥ 2 秒（8 格）才成立，區間為 `[第一格 t, 最後一格 t + 0.25]`；
  - `Event.id = f"a{int(round(t*1000))}"`，`source="auto"`，`name_sig` 以 `NameSig.to_b64()` 存入。

- [x] **Step 1: 寫失敗測試**（以 `FrameResult` 序列餵入，輔助函式 `seq("..KK KK..", kind="knock")` 以字元表示每 0.25 秒一格）

```python
def test_two_frame_minimum():           # 單格命中不成立
def test_event_time_is_first_hit():      # "..KKKK" → t == 0.5
def test_gap_creates_new_event():        # "KKK..KKK"（2 格空白 = 0.5 秒）→ 2 事件
def test_short_flicker_same_event():     # "KKK.KKK"（1 格空白）→ 1 事件
def test_name_change_new_event():        # 同 kind 連續，但名字指紋不同 → 2 事件
def test_kind_change_new_event():        # assist_knock 直接接 knock → 2 事件
def test_resume_continuation_skipped():  # resume_start=10.0，第一格(10.0)即命中 → 該提示不產生事件；之後的新提示正常
def test_spectating_interval():          # 9 格觀戰 → [t0, t0+2.25]；7 格 → 無區間
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): streaming event tracker`

---

### Task 7: 計數推導

**Files:**
- Create: `engine/apexhl/derive.py`
- Test: `engine/tests/test_derive.py`

**Interfaces:**
- Consumes: `Event`, `SpecInterval`, `COUNTING_TYPES`, `detect.name_sig_similarity`
- Produces:
  - `derive.sig_similar(a: str | None, b: str | None, threshold: float) -> bool`：任一為 None → False；寬度比差 ≥ 15% → False；否則 `name_sig_similarity ≥ threshold`。
  - `derive.derive(events: list[Event], spectating: list[SpecInterval], profile: Profile) -> list[Event]`：回傳新清單（依 `t` 排序），依 §5.3 推導階段設定 `counted` 與 `counted_reason`；不修改 `counted_override`；`deleted` 事件 `counted=False`、`counted_reason="deleted"` 且不參與去重。
  - `derive.is_counted(e: Event) -> bool`：`e.counted_override if e.counted_override is not None else e.counted`，且 `deleted` 一律 False。

- [x] **Step 1: 寫失敗測試**

```python
def test_squad_wipe_not_counted():        # reason == "not_counting_type"
def test_spectating_not_counted():        # t 在區間內 → reason == "spectating"
def test_dedupe_same_enemy_within_window(): # knock(sigA, t=100) + assist_elim(sigA, t=180) → 第二筆 duplicate
def test_dedupe_outside_window():          # 間隔 91 秒 → 兩筆都 first
def test_different_enemy_both_counted():
def test_deleted_first_promotes_next():    # 刪除第一筆後重跑 derive，第二筆變 first
def test_override_respected():             # counted_override=False 的 first 事件：is_counted False；derive 不改 override
def test_manual_event_without_sig_counted(): # name_sig=None 的 manual knock → first（不與任何人去重）
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): derive counted flags with dedupe and spectating`

---

### Task 8: 自動剪輯

**Files:**
- Create: `engine/apexhl/autoclip.py`
- Test: `engine/tests/test_autoclip.py`

**Interfaces:**
- Consumes: `Event`, `Clip`, `AutoClipParams`, `derive.is_counted`
- Produces: `autoclip.auto_clips(events: list[Event], params: AutoClipParams, duration: float) -> list[Clip]`（只使用 `is_counted` 為真的事件；`Clip.origin="ai"`；`Clip.id = f"c{int(start*1000)}"`；依 start 排序）。
- 演算法（§5.4），切割規則補充：在群內**最大**相鄰間隔處切成兩個子群，各自遞迴；不合併的重疊片段交界設為重疊區中點。

- [x] **Step 1: 寫失敗測試**（以事件時間列表建構）

```python
P = AutoClipParams()   # gap=20, n=3, before=8, after=4, max_len=90
def test_basic_triple():      # [100,105,110] → [(92,114)]
def test_below_n():           # [100,105] → []
def test_gap_breaks_group():  # [100,105,126,130,135] → 只有 [126,130,135] → [(118,139)]
def test_clamped_to_video():  # [2,4,6], duration=8 → [(0,8)]
def test_max_len_split():     # 時間 0,15,...,180（每 15 秒一殺，13 殺）→ 每段長度 ≤ 90，且所有事件都被某段涵蓋
def test_overlap_merge():     # 兩群合併後 ≤ 90 → 合為一段
def test_overlap_no_merge_midpoint(): # 合併後 > 90 → 前段 end == 後段 start == 重疊區中點
def test_uses_final_counted():  # counted_override=False 的事件不計入
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): auto clip grouping`

---

### Task 9: 快取與重新分析合併

**Files:**
- Create: `engine/apexhl/cache.py`
- Test: `engine/tests/test_cache.py`

**Interfaces:**
- Consumes: `VideoInfo`, `Event`, `Clip`, `SpecInterval`, `ENGINE_VERSION`
- Produces:
  - 快取文件為 dict，結構同 spec §4.2，另加 `"keyframes": list[float]`。
  - `cache.cache_path(video_path: str, cache_dir: Path, beside: bool = False) -> Path`：`beside=False` → `cache_dir / (sha1(normalize(path)).hexdigest() + ".json")`，`normalize` = `os.path.abspath` → 小寫 → `\` 統一為 `/`；`beside=True` → 影片同目錄 `<stem>.apexhl.json`。
  - `cache.load_cache(p: Path) -> dict | None`（不存在或 JSON 損毀回 None）；`cache.save_cache(p: Path, doc: dict) -> Path`（先寫 `.tmp` 再 `os.replace`；目標目錄不可寫時改寫到 `fallback_dir` 參數並回傳實際路徑）。
  - `cache.needs_reanalysis(doc: dict, info: VideoInfo, templates_version: str) -> bool`：size、mtime、engine_version、templates_version 任一不同，或 `analysis.status != "done"`。
  - `cache.merge_reanalysis(old_events: list[Event], new_auto: list[Event]) -> tuple[list[Event], list[Event]]`：回傳 `(merged, unmatched)`；保留所有 `source="manual"`；舊 auto 事件的 `deleted`/`counted_override` 依「同 type 且 |Δt| ≤ 1.0」轉移到最近的新 auto 事件；轉移不到且帶有使用者狀態的舊事件放入 `unmatched`。
  - `cache.merge_clips(old_clips: list[Clip], new_ai: list[Clip]) -> list[Clip]`：保留 `origin="manual"`，`ai` 換成新的。

- [x] **Step 1: 寫失敗測試**

```python
def test_cache_key_path_only(tmp_path):     # 同路徑不同大小寫/斜線 → 同一個 key；檔案內容改變 key 不變
def test_cache_beside_chinese_space(tmp_path):  # "Apex 影片/a b.mp4" → "a b.apexhl.json"
def test_atomic_save_and_load(tmp_path):
def test_corrupt_cache_returns_none(tmp_path):
def test_readonly_dir_falls_back(tmp_path):  # 以不存在且無法建立的目錄模擬 → 寫到 fallback_dir
def test_needs_reanalysis_triggers():        # size/mtime/engine/templates/status 各一
def test_merge_keeps_manual_and_transfers_state():
def test_merge_reports_unmatched():
def test_merge_clips_keeps_manual():
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: Commit** `feat(engine): cache storage and reanalysis merge`

---

### Task 10: 分析流程、接續、CLI、IPC

**Files:**
- Create: `engine/apexhl/analyze.py`、`engine/apexhl/ipc.py`、`engine/apexhl/__main__.py`
- Test: `engine/tests/test_analyze.py`、`engine/tests/test_ipc.py`、`engine/tests/test_golden.py`

**Interfaces:**
- Consumes: 前述所有模組
- Produces:
  - `analyze.analyze(path: str, profile: Profile, *, cache_dir: Path, beside: bool = False, force: bool = False, on_progress: Callable[[float, float], None] = noop, cancel: threading.Event | None = None, hwaccel: bool = True) -> dict`：回傳完整快取文件，並在文件中加入 `"cache_path": <實際寫入的快取檔絕對路徑>`（前端依此路徑寫回手動修正；下次分析時 `merge_reanalysis` 讀到的就是含修正的版本）。流程：`probe` → 讀快取；若不需重新分析且非 `force` 直接回傳；若快取 `status="partial"` 且 size/mtime 未變，從 `progress_t - 5` 接續（`EventTracker(resume_start=...)`，新事件與既有事件以「同 type、|Δt| ≤ 1、名字指紋相似」去重）；否則 `calibrate` → 從 0 解碼。每 30 秒（影片時間）寫入 `status="partial"`、`progress_t` 與目前事件；完成後 `keyframes`、`derive`、`merge_reanalysis`、`status="done"`。取消時寫入 partial 後 raise `Cancelled`。
  - IPC 協定（`python -m apexhl ipc`，stdin/stdout 每行一個 JSON，UTF-8）：
    - 請求：`{"id": str, "cmd": "probe"|"analyze"|"cancel"|"derive"|"autoclip", "args": {...}}`
    - `probe` args `{"path"}` → result `VideoInfo` dict
    - `analyze` args `{"path","profile_dir","cache_dir","beside"?,"force"?,"hwaccel"?}` → 期間送 `{"id","type":"progress","t","duration"}`，結束送 `{"id","type":"result","data": <快取文件>}`；同時只執行一個 analyze（第二個請求回 error `"busy"`）
    - `cancel` args `{"target": <analyze 請求的 id>}` → 被取消的 analyze 回 `{"id","type":"error","code":"cancelled"}`
    - `derive` args `{"events","spectating","profile_dir"}` → result `{"events"}`
    - `autoclip` args `{"events","params","duration"}` → result `{"clips"}`
    - 任何例外 → `{"id","type":"error","code": str,"message": str}`，`code` 取值：`bad_request`、`probe_failed`、`decode_failed`、`profile_error`、`busy`、`cancelled`、`internal`
    - 啟動時先送 `{"type":"ready","engine_version": ENGINE_VERSION}`
  - CLI：`python -m apexhl analyze <video> --profile-dir templates/zh-TW --cache-dir <dir> [--force] [--no-hwaccel] [--out file.json]`，進度印到 stderr。

- [x] **Step 1: 寫失敗測試**

```python
def test_analyze_synthetic_no_events(tmp_path, zh_profile):   # testsrc2 影片 → events == [] 且 status == "done"
def test_analyze_uses_cache(tmp_path, zh_profile, monkeypatch):  # 第二次呼叫不呼叫 FrameStream
def test_cancel_writes_partial(tmp_path, zh_profile):
def test_resume_no_duplicates(tmp_path, zh_profile, fixture_video):
    # fixture_video：由 Task 2 的正例 banner 疊到合成影片上（conftest 以 ffmpeg overlay 產生，
    # 於 2.0–4.5s、10.0–12.5s 各出現一次擊倒提示）。在 t≈11 時取消，再接續 → 恰好 2 個 knock，時間 ≈ 2.0、10.0
def test_ipc_ready_probe_and_error(tmp_path):   # 以 subprocess 啟動 ipc，驗證 ready、probe 結果、bad_request
def test_ipc_busy_and_cancel(tmp_path):
def test_ipc_autoclip_roundtrip():

# test_golden.py：APEXHL_GOLDEN_VIDEO 不存在則 skip；結果與 engine/tests/golden/expected.json 比對（事件 type 與 t ±0.5）
```

- [x] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 確認通過**
- [x] **Step 5: 製作黃金短片**：從長片截 3–5 分鐘含多種事件的片段（`ffmpeg -ss … -t … -c copy`）存到 `E:\` 以外的本機路徑（例如 `D:\Develop\apexhl-samples\golden.mp4`，不進 git），跑 CLI，**人工逐一核對**事件後存成 `engine/tests/golden/expected.json`；設定 `APEXHL_GOLDEN_VIDEO` 後跑 `test_golden.py` 通過。
- [x] **Step 6: Commit** `feat(engine): analyze pipeline with resume, CLI and JSON Lines IPC`

---

### Task 11: 正確答案、準確率評估、速度基準與調校

**Files:**
- Create: `tools/outplayed_truth.py`、`tools/evaluate.py`、`tools/benchmark.py`、`engine/tests/test_evaluate.py`、`docs/accuracy-report.md`

**Interfaces:**
- Consumes: CLI `python -m apexhl analyze`、快取文件格式
- Produces:
  - `tools/outplayed_truth.py --out truth_dir`：用 `ccl_chromium_reader` 讀 spec §8 的 IndexedDB 路徑（**先複製整個資料夾到暫存目錄再讀**，避免鎖檔與誤改），輸出每支原始影片一個 `truth.json`：`{"video": <檔名>, "events": [{"t": float, "type": "knock"|"assist"|"kill"|...}]}`，時間換算為相對影片開頭的秒數。若無法解析，輸出錯誤原因並以非 0 結束；此時改走人工標註（於 Plan 2 完成後以介面手動修正）。
  - `tools/evaluate.py --truth truth.json --pred cache.json [--tolerance 1.5] [--types knock]`：以真值與預測的配對時間差中位數估計系統性偏移並扣除後，以貪婪最近配對計算各類型召回率／精確率，列出漏抓／誤抓時間點（`HH:MM:SS`）。核心函式 `evaluate(truth: list[tuple[float,str]], pred: list[tuple[float,str]], tolerance: float) -> Report` 可單元測試。
  - `tools/benchmark.py <video> [--seconds 600]`：分別以 hwaccel 開／關分析前 N 秒，輸出「影片秒數 / 實際秒數」倍速。

- [ ] **Step 1: 寫 `evaluate` 的失敗測試**：完全一致 → 1.0/1.0；全部偏移 +0.8 秒 → 估計偏移 0.8 且 1.0/1.0；一個漏抓、一個誤抓的數值正確。
- [ ] **Step 2: 實作三個工具並通過測試**
- [ ] **Step 3: 實跑**：對 `E:\Outplayed\Outplayed\Apex Legends` 下兩支 10 月長片執行 truth、analyze、evaluate；對 `..._18-26-50-167.mp4` 執行 benchmark。
- [ ] **Step 4: 調校**：只調 `profile.json` 閾值與 ROI（必要時補範本），直到 `knock` 召回率與精確率 ≥ 95% 或確認無法達成並記錄原因；每次調整後重跑全部 pytest。
- [ ] **Step 5: 寫 `docs/accuracy-report.md`**：各類型指標、估計偏移、倍速（hwaccel 開／關）、剩餘誤判類型分析。
- [ ] **Step 6: Commit** `feat(tools): truth export, evaluation, benchmark; tune zh-TW profile`
