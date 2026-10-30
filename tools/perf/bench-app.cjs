// Run one scenario through the existing IPC bridge without changing application code.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

function measuredSeconds(csv) {
  const rows = csv.trim().split(/\r?\n/);
  assert.equal(rows.shift(), 'frame_index,qpc_ms,frame_ms');
  return rows.reduce((sum, row, i) => {
    const values = row.split(',').map(Number);
    assert.equal(values.length, 3);
    assert.equal(values[0], i);
    assert(values.every(Number.isFinite) && values[2] > 0);
    return sum + values[2] / 1000;
  }, 0);
}

function samePath(a, b) {
  return typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A restart replaces the process, so checking the original pids catches both a stop and a restart.
function checkLiveEngine(pids, alive = processAlive) {
  assert(pids.length > 0 && pids.every(alive), 'Live engine stopped or restarted during measurement');
}

function checkDeferredAnalysis(payload, destination) {
  assert.equal(payload.queue.waitingForGame, true, 'Analysis queue is not waiting for game exit');
  assert.equal(payload.queue.analyzing, null, 'Offline analysis started while the game was running');
  assert.equal(payload.current, null, 'Offline analysis is active while the game is running');
  return payload.queue.queued.some(item => samePath(item, destination));
}

if (process.argv[2] === '--self-test') {
  assert.equal(measuredSeconds('frame_index,qpc_ms,frame_ms\n0,10,10\n1,30,20\n'), 0.03);
  assert.throws(() => measuredSeconds('bad\n'));
  assert.throws(() => measuredSeconds('frame_index,qpc_ms,frame_ms\n0,0,NaN'));
  assert(samePath(path.resolve('Apex.mp4'), path.resolve('apex.mp4')));
  assert(!samePath(null, 'apex.mp4'));
  checkLiveEngine([process.pid]);
  assert.throws(() => checkLiveEngine([]), /stopped or restarted/);
  assert.throws(() => checkLiveEngine([1, 2], pid => pid === 1), /stopped or restarted/);
  const deferred = { queue: { waitingForGame: true, analyzing: null, queued: ['apex.mp4'] }, current: null };
  assert(checkDeferredAnalysis(deferred, 'APEX.mp4'));
  assert(!checkDeferredAnalysis(deferred, 'other.mp4'));
  assert.throws(() => checkDeferredAnalysis({ ...deferred, queue: { ...deferred.queue, waitingForGame: false } }, 'apex.mp4'));
  assert.throws(() => checkDeferredAnalysis({ ...deferred, queue: { ...deferred.queue, analyzing: 'other.mp4' } }, 'apex.mp4'));
  console.log('driver self-test passed');
} else {
  run(JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, '')))
    .catch(error => { console.error(error.stack); process.exit(1); });
}

async function run(config) {
  const { appDir, runDir, scenario } = config;
  const direct = scenario.startsWith('rec_');
  const idle = scenario === 'app_idle';
  const deferred = scenario === 'record_deferred_analysis';
  assert.notEqual(scenario, 'record_analyze', 'record_analyze was retired; use record_deferred_analysis (a different workload)');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const file = name => path.join(runDir, name);
  const metadata = JSON.parse(fs.readFileSync(file('metadata.json'), 'utf8').replace(/^\uFEFF/, ''));
  const saveMetadata = () => fs.writeFileSync(file('metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  let electron, game, appPid, page, recorder;
  let liveSeen = false;
  let copied = false;
  let measuring = false;
  let liveEngine;
  let gameExit;
  const killTree = pid => {
    if (!pid) return;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) {
      (metadata.cleanup_errors ??= []).push(`taskkill PID ${pid}: ${result.error?.message ?? result.stderr}`);
    }
  };
  const interrupted = () => {
    killTree(gameExit === undefined ? game?.pid : undefined);
    killTree(appPid);
    for (const child of recorder?.children ?? []) killTree(child.benchClosed ? undefined : child.pid);
    metadata.status = 'failed';
    metadata.error = 'Interrupted';
    saveMetadata();
    process.exit(130);
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  async function waitFor(label, predicate, timeout = config.startTimeoutS * 1000, afterGameExit = false) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      recorder?.check();
      if (await predicate()) return;
      if (gameExit !== undefined && !afterGameExit) throw new Error(`Game exited (${gameExit}) while waiting for ${label}; see game.stderr.log`);
      if (electron && electron.process().exitCode !== null) throw new Error(`Aditor exited while waiting for ${label}`);
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}; see app.log and app-state.jsonl in ${runDir}`);
  }
  // The game marks the end of measurement before closing its window; capture loss and the app's own
  // shutdown can be observed before Node sees the game's 'close'.
  function measurementOver() {
    return gameExit !== undefined || fs.existsSync(file('measurement.done'));
  }
  function liveEnginePids() {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='aditor.exe'\" | Where-Object { $_.CommandLine -like '*--shm*' }).ProcessId"],
      { windowsHide: true, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
  }
  async function sample() {
    const state = await page.evaluate(async () => ({
      recording: await window.api.recording.getStatus(),
      queue: await window.api.queue.getState(),
      analysisStarts: window.benchAnalysisStarts,
      liveSeen: window.benchLiveSeen === true
    }));
    liveSeen ||= state.liveSeen;
    const epochMs = Date.now();
    fs.appendFileSync(file('app-state.jsonl'), JSON.stringify({ epoch_ms: epochMs, ...state }) + '\n');
    if (idle) assert.equal(state.recording.phase, 'idle', 'app_idle unexpectedly started recording');
    if (state.recording.phase === 'error') throw new Error(`Recording failed: ${JSON.stringify(state.recording.error)}`);
    if (!idle && measuring && !measurementOver() && state.recording.phase !== 'recording') throw new Error(`Recording stopped during measurement: ${state.recording.phase}`);
    // The pid probe is a cheap syscall; the CIM query that finds the pids runs only before measurement.
    if (!idle && measuring && !measurementOver()) checkLiveEngine(liveEngine);
    if (deferred && measuring && !measurementOver() && checkDeferredAnalysis(state.queue, config.analysisDestination)) {
      metadata.analysis_queued_epoch_ms ??= epochMs;
    }
    metadata.analysis_starts = state.analysisStarts;
    const started = state.analysisStarts.find(item => samePath(item.path, config.analysisDestination));
    if (started) metadata.analysis_started_epoch_ms ??= started.epoch_ms;
    if (copied && samePath(state.queue.current?.path, config.analysisDestination) && state.queue.current.progress > 0) {
      metadata.analysis_first_progress_epoch_ms ??= epochMs;
      metadata.analysis_last_progress = state.queue.current.progress;
    }
    return state;
  }
  try {
    if (scenario !== 'baseline' && !direct) {
      const appRequire = createRequire(path.join(appDir, 'package.json'));
      const { _electron } = appRequire('@playwright/test');
      // E2E mode disables the game watcher; isolate APPDATA directly so normal recording runs.
      const env = { ...process.env, ADITOR_ENGINE: 'real', APPDATA: config.appData,
        ADITOR_APPDATA: config.appData, ADITOR_FFMPEG: config.ffmpeg };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'ADITOR_E2E', 'ADITOR_E2E_FAKE_FFMPEG', 'ADITOR_SENTRY_VERIFY', 'ADITOR_SENTRY_VERIFY_CHILDREN']) delete env[key];
      electron = await _electron.launch({ executablePath: appRequire('electron'), args: [appDir],
        cwd: appDir, env, timeout: config.startTimeoutS * 1000 });
      appPid = electron.process().pid;
      metadata.app_pid = appPid;
      for (const stream of [electron.process().stdout, electron.process().stderr]) {
        stream.on('data', data => fs.appendFileSync(file('app.log'), data));
      }
      page = await electron.firstWindow();
      await page.waitForSelector('.app', { timeout: config.startTimeoutS * 1000 });
      await page.evaluate(() => {
        window.benchLiveSeen = false;
        window.benchAnalysisStarts = [];
        window.api.library.onUpdated(payload => {
          if (payload?.queue?.analyzing && window.benchAnalysisStarts.at(-1)?.path !== payload.queue.analyzing) {
            window.benchAnalysisStarts.push({ path: payload.queue.analyzing,
              epoch_ms: payload.current?.analyzingSince ?? Date.now() });
          }
        });
        window.api.recording.onLive(update => {
          if (Array.isArray(update.events)) window.benchLiveSeen = true;
        });
      });
      assert(await page.evaluate(() => window.api.recording.getCapabilities()), 'Recorder capabilities unavailable');
      metadata.effective_settings = await page.evaluate(() => window.api.settings.get());
      await page.evaluate(source => window.api.engine.probe(source), config.source);
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.minimize()));
    }
    const gameArgs = ['--raw', config.raw, '--size', config.size, '--clip-fps', String(config.clipFps),
      '--load-passes', String(config.loadPasses), '--fps-cap', String(config.fpsCap),
      '--duration-s', String(config.durationS), '--warmup-s', String(config.warmupS),
      '--csv', file('frames.csv'), '--ready-file', file('ready'), '--start-file', file('start'),
      '--measurement-file', file('measurement.json')];
    if (config.windowed) gameArgs.push('--windowed', config.windowed);
    metadata.game_command = [config.gameExe, ...gameArgs];
    game = spawn(config.gameExe, gameArgs, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    game.stdout.on('data', data => { stdout += data; });
    game.stderr.on('data', data => fs.appendFileSync(file('game.stderr.log'), data));
    game.on('error', error => { gameExit = error.message; });
    // 'close' waits for stdout/stderr to drain, so the stats JSON and the stderr log are complete.
    game.on('close', code => {
      gameExit = code ?? 'signal';
      metadata.game_exit_epoch_ms = Date.now();
    });
    metadata.game_pid = game.pid;
    await waitFor('GPU footage upload', () => fs.existsSync(file('ready')));
    if (direct) {
      const { RecorderWorkload } = require('./bench-recorder.cjs');
      recorder = new RecorderWorkload(config, metadata, killTree, measurementOver);
      await recorder.start(game.pid);
    }
    if (page && !idle) {
      await waitFor('active recording and running live engine', async () => {
        const state = await sample();
        // Snapshots arrive only when detected events change, so a quiet clip never sends one; require the live process instead.
        if (state.recording.phase !== 'recording') return false;
        liveEngine = liveEnginePids();
        if (!liveEngine.length) return false;
        metadata.recording_started = state.recording;
        return true;
      });
      const diagnostic = fs.readFileSync(path.join(config.appData, 'Aditor', 'recording.log'), 'utf8');
      const captures = [...diagnostic.matchAll(new RegExp(`begin pid=${game.pid} .*capture=(\\w+)`, 'g'))];
      metadata.capture_method_actual = captures.at(-1)?.[1];
      assert(metadata.capture_method_actual, 'Actual capture method was not recorded in diagnostics');
      assert(metadata.capture_method === 'auto' || metadata.capture_method === metadata.capture_method_actual,
        `Requested ${metadata.capture_method} capture fell back to ${metadata.capture_method_actual}; rerun with that method explicitly`);
    }
    if (idle) {
      assert.equal(metadata.effective_settings.recording.autoRecord, false);
      await sample();
    }
    fs.writeFileSync(file('start'), 'start\n');
    await waitFor('measurement start', () => fs.existsSync(file('measurement.json')),
      (config.warmupS + config.startTimeoutS) * 1000);
    const measurement = JSON.parse(fs.readFileSync(file('measurement.json'), 'utf8'));
    metadata.measurement = measurement;
    measuring = true;
    const deadline = Date.now() + (config.durationS + 30) * 1000;
    while (gameExit === undefined) {
      if (Date.now() > deadline) throw new Error('Game did not finish within measurement deadline');
      if (deferred && !copied && !measurementOver() && Date.now() >= measurement.epoch_ms + config.analyzeAtS * 1000) {
        copied = true;
        metadata.analysis_copy_start_epoch_ms = Date.now();
        // Include the actual copy/import cost in this scenario's measured workload.
        // Stage outside the watched folder, then rename: Windows preallocates copies, so the watcher's
        // size-stability check would import a half-copied file.
        const staged = file('Apex_bench_analysis.staging.mp4');
        await fs.promises.copyFile(config.analysisSource, staged);
        await fs.promises.rename(staged, config.analysisDestination);
        metadata.analysis_copy_end_epoch_ms = Date.now();
      }
      if (gameExit === undefined) {
        recorder?.check();
        if (page) await sample();
      }
      await sleep(1000); // Sparse polling keeps harness IPC load low during measurement.
    }
    measuring = false;
    assert.equal(gameExit, 0, `Game failed; see ${file('game.stderr.log')}`);
    const stats = JSON.parse(stdout.trim());
    assert(stats.frames > 0, 'No measured frames');
    const seconds = measuredSeconds(fs.readFileSync(file('frames.csv'), 'utf8'));
    assert(seconds >= config.durationS * 0.95, `Game closed early: only ${seconds.toFixed(2)} measured seconds`);
    metadata.measured_seconds = seconds;
    if (deferred) {
      assert(copied, 'Analysis copy was never triggered');
      assert(metadata.analysis_queued_epoch_ms, 'Imported video was not observed queued during measurement; increase duration');
    }
    await Promise.all([(async () => {
      if (recorder) await recorder.stop();
      if (page && !idle) {
        await waitFor('recording finalization', async () => (await sample()).recording.phase === 'idle', config.finalizeTimeoutS * 1000, true);
        const outputs = [];
        function findOutputs(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const item = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== '.sessions') findOutputs(item);
            else if (entry.isFile() && entry.name.endsWith('.mp4')) outputs.push(item);
          }
        }
        findOutputs(config.recordings);
        assert(outputs.length, 'Finalized recording output missing');
        for (const output of outputs) {
          assert(fs.statSync(output).size > 0, `Empty recording: ${output}`);
          const info = await page.evaluate(video => window.api.engine.probe(video), output);
          assert(info.duration > 0, `Invalid recording: ${output}`);
        }
        metadata.recording_outputs = outputs;
      }
    })(), (async () => {
      if (deferred) {
        await waitFor('deferred analysis completion', async () => {
          await sample();
          const entries = await page.evaluate(() => window.api.library.getEntries());
          const entry = entries.find(item => samePath(item.path, config.analysisDestination));
          assert.notEqual(entry?.status, 'error', `Deferred analysis failed: ${entry?.error}`);
          return entry?.status === 'done';
        }, config.analysisTimeoutS * 1000, true);
        metadata.analysis_completed_epoch_ms = Date.now();
        assert(metadata.analysis_started_epoch_ms, 'Target analysis start was not observed');
        const measurementEnd = fs.statSync(file('measurement.done')).mtimeMs;
        assert(metadata.analysis_starts.every(item => item.epoch_ms >= measurementEnd), 'Offline analysis started before game measurement ended');
        const cache = await page.evaluate(video => window.api.cache.loadByVideo(video), config.analysisDestination);
        assert(cache?.analysis?.status === 'done' && samePath(cache.video?.path, config.analysisDestination), 'Completed target analysis cache missing');
        assert(metadata.analysis_started_epoch_ms >= metadata.game_exit_epoch_ms, 'Target analysis started before game exit');
        metadata.analysis_resume_wait_ms = metadata.analysis_started_epoch_ms - metadata.game_exit_epoch_ms;
        metadata.analysis_after_exit_ms = metadata.analysis_completed_epoch_ms - metadata.game_exit_epoch_ms;
      }
    })()]);
    const gpuLog = fs.readFileSync(file('game.stderr.log'), 'utf8');
    metadata.render_gpu = gpuLog.split(/\r?\n/).find(line => line.startsWith('GPU:'));
    metadata.live_engine_snapshot_observed = liveSeen;
    metadata.status = 'complete';
    fs.writeFileSync(file('stats.json'), JSON.stringify(stats, null, 2) + '\n');
    console.log(JSON.stringify(stats));
  } catch (error) {
    metadata.status = 'failed';
    metadata.error = error.message;
    throw error;
  } finally {
    // Keep the Electron parent alive until taskkill has enumerated its descendants.
    killTree(gameExit === undefined ? game?.pid : undefined);
    killTree(appPid);
    await electron?.close().catch(() => {});
    await recorder?.cleanup();
    metadata.game_exit_code = gameExit;
    const cleanupFailed = metadata.status === 'complete' && metadata.cleanup_errors?.length;
    if (cleanupFailed) {
      metadata.status = 'failed';
      metadata.error = 'Process tree cleanup failed; see cleanup_errors';
    }
    metadata.finished_at = new Date().toISOString();
    saveMetadata();
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (cleanupFailed) throw new Error(metadata.error);
  }
}
