// Direct recorder/live workload; the shared harness owns the game and timeline.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

function resolveCapture(method, release = os.release(), platform = process.platform) {
  const build = Number(release.split('.')[2]);
  return method !== 'auto' ? method : platform !== 'win32' || !Number.isFinite(build) || build >= 20348 ? 'wgc' : 'dda';
}

function readFrames(profile) {
  const banner = profile.capture_rois ? profile.capture_rois.banner : profile.banner_roi;
  const spec = profile.capture_rois ? profile.capture_rois.spec : profile.spec_roi;
  const killfeed = profile.capture_rois?.killfeed;
  for (const rect of [banner, spec, ...(killfeed === undefined ? [] : [killfeed])]) {
    assert(Array.isArray(rect) && rect.length === 4 && rect.every(n => Number.isInteger(n) && n >= 0) &&
      rect[2] > 0 && rect[3] > 0 && rect[0] + rect[2] <= 1920 && rect[1] + rect[3] <= 1080, 'Invalid capture ROI');
  }
  return { banner, spec, base: [1920, 1080], ...(killfeed === undefined ? {} : { killfeed }) };
}

function startArgs(config, pid, frames) {
  const capture = resolveCapture(config.captureMethod);
  return { pid, session_dir: path.join(config.runDir, 'session'), session_id: path.basename(config.runDir),
    encode: config.scenario === 'rec_capture' ? null : { codec: 'hevc', gpu: 'auto', encoder: 'auto',
      fps: 60, height: 1080, bitrate_kbps: 10000, preset: config.preset, aspect: 'native' },
    audio: ['rec_audio', 'rec_live'].includes(config.scenario) ? { render: 'default', capture: 'default',
      mic_gain: 1, mic_enabled: true, render_enabled: true, render_gain: 1, render_source: 'device', mic_mono: false } : null,
    frames, capture, ...(capture === 'hook' ? { hook_dir: path.join(config.repo, 'build', 'obs-hook') } : {}), capture_cursor: true };
}

function gameAspect(text) {
  const value = key => Number(new RegExp(`"setting\\.${key}"\\s+"(\\d+)"`).exec(text.replace(/\0/g, ''))?.[1]);
  const w = value('defaultres'), h = value('defaultresheight');
  return w > 0 && h > 0 && [16 / 9, 16 / 10, 4 / 3, 5 / 4].some(a => Math.abs(w / h - a) / a <= 0.01) ? `${w}x${h}` : null;
}

class RecorderWorkload {
  constructor(config, metadata, killTree, gameExited = () => false) {
    this.config = config;
    this.metadata = metadata;
    this.killTree = killTree;
    this.gameExited = gameExited;
    this.children = [];
    this.pending = new Map();
    this.seq = 0;
  }
  check() {
    if (this.failure) throw this.failure;
    for (const child of this.children) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${child.benchName} exited during workload`);
    }
    if (this.stopped) throw new Error(`Recorder stopped early: ${this.stopped.reason}`);
  }
  launch(name, exe, args, env, onLine) {
    this.metadata[`${name}_command`] = [exe, ...args];
    const child = spawn(exe, args, { env, windowsHide: true, stdio: 'pipe' });
    child.benchName = name;
    this.children.push(child);
    this.metadata[`${name}_pid`] = child.pid;
    child.on('spawn', () => {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch (error) { this.failure = error; }
    });
    child.on('error', error => { this.failure = error; });
    child.stdin.on('error', error => { if (!this.closing) this.failure = error; });
    child.on('close', (code, signal) => {
      child.benchClosed = true;
      this.metadata[`${name}_exit_code`] = code;
      this.metadata[`${name}_exit_signal`] = signal;
    });
    child.stderr.on('data', data => fs.appendFileSync(path.join(this.config.runDir, `${name}.stderr.log`), data));
    readline.createInterface({ input: child.stdout }).on('line', line => {
      fs.appendFileSync(path.join(this.config.runDir, `${name}.jsonl`), line + '\n');
      try { onLine(JSON.parse(line)); } catch (error) { this.failure = error; }
    });
    return child;
  }
  async wait(label, predicate, timeout = this.config.startTimeoutS * 1000, check = true) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (check) this.check();
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}; see recorder/live logs`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (check) this.check();
  }
  async request(cmd, args = {}, timeout = 30000) {
    const id = ++this.seq;
    this.recorder.stdin.write(JSON.stringify({ ...args, id, cmd }) + '\n');
    await this.wait(`${cmd} reply`, () => this.pending.has(id), timeout, cmd !== 'stop');
    const reply = this.pending.get(id);
    this.pending.delete(id);
    assert.equal(reply.ok, true, `${cmd}: ${reply.code}: ${reply.message}`);
    return reply;
  }
  async start(pid) {
    const { config, metadata } = this;
    const profileDir = path.join(config.repo, 'templates', 'icons');
    const args = startArgs(config, pid, readFrames(JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf8'))));
    fs.mkdirSync(args.session_dir);
    metadata.recorder_start = args;
    metadata.capture_method_actual = args.capture;
    const env = { ...process.env, PATH: path.dirname(config.ffmpeg) + path.delimiter + process.env.PATH };
    this.recorder = this.launch('recorder', path.join(config.repo, 'recorder', 'target', 'release', 'aditorrec.exe'), [], env, msg => {
      if (typeof msg.id === 'number') this.pending.set(msg.id, msg);
      if (msg.ev === 'started') this.started = metadata.recording_started = msg;
      if (msg.ev === 'stopped') this.stopped = msg;
      if (msg.ev === 'error') {
        if (this.gameExited()) (metadata.recorder_errors_after_game_exit ??= []).push(msg);
        else this.failure = new Error(`Recorder ${msg.code}: ${msg.message}`);
      }
    });
    metadata.recorder_capabilities = await this.request('hello');
    await this.request('start', args);
    await this.wait('capture started', () => !!this.started);
    assert(this.started.width > 0 && this.started.height > 0 && typeof this.started.shm === 'string');
    assert.equal(this.started.shm, `Local\\aditorrec-${args.session_id}`);
    if (config.scenario !== 'rec_live') return;
    let aspect = null;
    try { aspect = gameAspect(fs.readFileSync(path.join(os.homedir(), 'Saved Games', 'Respawn', 'Apex', 'local', 'videoconfig.txt'), 'utf8')); } catch { /* Same missing-config fallback as the app. */ }
    const liveArgs = ['live', '--shm', this.started.shm, '--profile-dir', profileDir,
      '--scene-dir', path.join(config.repo, 'templates', 'scene'), ...(aspect ? ['--aspect', aspect] : [])];
    // Apex is the engine default, so the app omits --game.
    this.live = this.launch('live_engine', path.join(config.repo, 'engine', 'target', 'release', 'aditor.exe'), liveArgs, process.env, msg => {
      if (msg.ev === 'error') this.failure = new Error(`Live engine: ${msg.message}`);
      if (msg.ev === 'stats' && msg.frames > 0) this.liveProgress = metadata.live_engine_first_progress = msg;
    });
    await this.wait('live engine frame progress', () => !!this.liveProgress);
  }
  async stop() {
    this.closing = true;
    await this.request('stop', {}, 15000);
    this.recorder.stdin.end();
    await this.wait('recorder exit', () => this.recorder.benchClosed, 1000, false);
    if (this.live) {
      this.live.stdin.end('{"cmd":"stop"}\n');
      await this.wait('live engine exit', () => this.live.benchClosed, 5000, false);
    }
    if (this.failure) throw this.failure;
    for (const child of this.children) assert.equal(child.exitCode, 0, `${child.benchName} failed`);
    if (this.config.scenario !== 'rec_capture') {
      const dir = this.metadata.recorder_start.session_dir;
      const segments = fs.readdirSync(dir).filter(name => /^seg_\d+\.m4s$/.test(name)).map(name => path.join(dir, name));
      assert(segments.length && segments.every(file => fs.statSync(file).size > 0), 'Encoded segments missing or empty');
      assert(fs.statSync(path.join(dir, 'init.mp4')).size > 0, 'Mux init missing');
      this.metadata.recording_outputs = segments;
    }
  }
  async cleanup() {
    for (const child of this.children) this.killTree(child.benchClosed ? undefined : child.pid);
    try {
      await this.wait('child cleanup', () => this.children.every(child => child.benchClosed), 5000, false);
    } catch (error) { (this.metadata.cleanup_errors ??= []).push(error.message); }
  }
}

async function selfTest() {
  const repo = path.resolve(__dirname, '../..');
  const profile = JSON.parse(fs.readFileSync(path.join(repo, 'templates/icons/profile.json'), 'utf8'));
  const frames = readFrames(profile);
  const config = { repo, runDir: path.join(repo, 'test-run'), captureMethod: 'wgc', preset: 'speed', scenario: 'rec_live' };
  const args = startArgs(config, 123, frames);
  // Evaluate only the literal defaults, then mirror session.ts's mapping independently.
  const source = fs.readFileSync(path.join(repo, 'app/src/shared/recording.ts'), 'utf8');
  const defaults = require('node:vm').runInNewContext('(' + source.match(/DEFAULT_RECORDING_SETTINGS: RecordingSettings = (\{[\s\S]*?\n\})/)[1] + ')');
  const s = defaults;
  assert.deepEqual(args.encode, { codec: s.codec, gpu: s.gpu, encoder: s.encoder, fps: s.fps, height: s.height,
    bitrate_kbps: s.bitrateKbps, preset: s.preset, aspect: s.forceAspect ? s.aspectMode : 'native' });
  assert.deepEqual(args.audio, { render: s.renderDevice, capture: s.captureDevice, mic_gain: s.micGain, mic_enabled: s.micEnabled,
    render_enabled: s.systemAudioEnabled, render_gain: s.systemGain, render_source: s.gameAudioOnly ? 'game' : 'device', mic_mono: s.micMono });
  assert.equal(args.capture_cursor, s.captureCursor);
  assert.deepEqual(frames, { ...profile.capture_rois, base: [1920, 1080] });
  assert.throws(() => readFrames({ banner_roi: [0, 0, 1921, 1], spec_roi: [0, 0, 1, 1] }));
  for (const scenario of ['rec_capture', 'rec_encode', 'rec_audio', 'rec_live']) {
    const request = startArgs({ ...config, scenario }, 123, frames);
    assert.equal(request.encode !== null, scenario !== 'rec_capture');
    assert.equal(request.audio !== null, ['rec_audio', 'rec_live'].includes(scenario));
  }
  assert.equal(resolveCapture('auto', '10.0.19045', 'win32'), 'dda');
  assert.equal(resolveCapture('auto', '10.0.20348', 'win32'), 'wgc');
  assert.equal(resolveCapture('auto', 'unknown', 'win32'), 'wgc');
  assert.equal(resolveCapture('hook'), 'hook');
  assert.equal(startArgs({ ...config, captureMethod: 'hook' }, 123, frames).hook_dir, path.join(repo, 'build/obs-hook'));
  assert.equal(gameAspect('"setting.defaultres" "1920"\n"setting.defaultresheight" "1080"'), '1920x1080');
  assert.equal(gameAspect(''), null);
  const workload = new RecorderWorkload({ startTimeoutS: 0.01 }, {}, () => {});
  const requests = [];
  workload.recorder = { stdin: { write(line) {
    const req = JSON.parse(line);
    requests.push(req);
    workload.pending.set(req.id, { id: req.id, ok: req.cmd !== 'bad', message: 'rejected' });
  } } };
  assert.equal((await workload.request('hello')).ok, true);
  await assert.rejects(workload.request('bad'), /rejected/);
  assert.deepEqual(requests.map(r => [r.id, r.cmd]), [[1, 'hello'], [2, 'bad']]);
  await assert.rejects(workload.wait('missing notification', () => false, 0), /Timed out/);
  workload.stopped = { reason: 'unexpected' };
  assert.throws(() => workload.check(), /stopped early/);
  workload.stopped = null;
  workload.children = [{ exitCode: 1, benchName: 'recorder' }];
  assert.throws(() => workload.check(), /exited during workload/);
  // Exercise readiness and shutdown with an in-memory protocol peer, without a window or native binaries.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aditor-recorder-self-test-'));
  try {
    const meta = {};
    let gameExited = false;
    let recorderMessage;
    const peer = new RecorderWorkload({ ...config, runDir: tmp, startTimeoutS: 1, ffmpeg: 'ffmpeg.exe' }, meta, () => {}, () => gameExited);
    let liveProcessed = false;
    peer.launch = function(name, exe, argv, env, onLine) {
      if (name === 'recorder') recorderMessage = onLine;
      const child = { benchName: name, exitCode: null, signalCode: null, benchClosed: false };
      child.stdin = {
        write: line => {
          const req = JSON.parse(line);
          if (req.cmd === 'start') {
            // Notification before reply is legal and must not release startup on its own.
            onLine({ ev: 'started', width: 1920, height: 1080, shm: `Local\\aditorrec-${path.basename(tmp)}` });
            setImmediate(() => onLine({ id: req.id, ok: true }));
          } else onLine({ id: req.id, ok: true });
        },
        end: () => { child.exitCode = 0; child.benchClosed = true; }
      };
      if (name === 'live_engine') {
        assert.deepEqual(argv.slice(0, 5), ['live', '--shm', `Local\\aditorrec-${path.basename(tmp)}`, '--profile-dir', path.join(repo, 'templates/icons')]);
        onLine({ ev: 'ready' });
        setImmediate(() => { liveProcessed = true; onLine({ ev: 'stats', frames: 1, t: 0 }); });
      }
      this.children.push(child);
      return child;
    };
    await peer.start(123);
    assert(liveProcessed, 'Live ready alone must not release the gate');
    const captureError = { ev: 'error', code: 'hook_unavailable', message: 'Game capture window disappeared' };
    recorderMessage(captureError);
    assert.throws(() => peer.check(), /hook_unavailable/);
    gameExited = true;
    recorderMessage(captureError);
    assert.throws(() => peer.check(), /hook_unavailable/);
    peer.failure = null;
    recorderMessage(captureError);
    peer.check();
    assert.deepEqual(meta.recorder_errors_after_game_exit, [captureError, captureError]);
    fs.writeFileSync(path.join(tmp, 'session', 'init.mp4'), 'init');
    await assert.rejects(peer.stop(), /segments missing/);
    fs.writeFileSync(path.join(tmp, 'session', 'seg_000001.m4s'), 'segment');
    await peer.stop();
    assert.equal(meta.recording_outputs.length, 1);
    await peer.cleanup();
  } finally {
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert(path.basename(tmp).startsWith('aditor-recorder-self-test-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('recorder driver self-test passed');
}
module.exports = { RecorderWorkload };
if (require.main === module && process.argv[2] === '--self-test') {
  selfTest().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
