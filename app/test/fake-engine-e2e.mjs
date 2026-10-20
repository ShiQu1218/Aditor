// E2E fake-engine implementation (loaded by fake-engine.mjs when FAKE_ENGINE_MODE=e2e).
// Mirrors the engine/aditor/ipc.py protocol: probe / analyze (progress, cancel, busy, cache hit) / derive / autoclip / cancel.
// Video metadata comes from the real ffprobe; events are synthetic and generated deterministically from video duration (300 by default).
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'

const ENGINE_VERSION = '0.1.0'
const COUNTING = new Set(['knock', 'assist_knock', 'assist_elim', 'elim'])
// The engine emits only eliminations and assists (elim/squad_wipe are no longer generated).
const TYPES = ['knock', 'assist_knock', 'assist_elim']

function ffprobeBin() {
  if (process.env.ADITOR_FFPROBE) return process.env.ADITOR_FFPROBE
  if (process.env.ADITOR_FFMPEG) {
    const d = path.dirname(process.env.ADITOR_FFMPEG)
    const cand = path.join(d, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    if (fs.existsSync(cand)) return cand
  }
  return 'ffprobe'
}

function runProbe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobeBin(),
      ['-v', 'error', '-of', 'json', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,start_time:format=duration,start_time', file],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(new Error(String(stderr || err.message).slice(-300)), { code: 'probe_failed' }))
        try {
          const doc = JSON.parse(stdout)
          const s = (doc.streams || [])[0]
        if (!s) throw new Error('No video stream found')
          const st = fs.statSync(file)
          resolve({
            path: file,
            duration: Number(doc.format.duration),
            width: Number(s.width),
            height: Number(s.height),
            codec: s.codec_name || '',
            start_time: Number(s.start_time || doc.format.start_time || 0),
            size: st.size,
            mtime: st.mtimeMs / 1000
          })
        } catch (e) {
          reject(Object.assign(new Error(String(e.message)), { code: 'probe_failed' }))
        }
      }
    )
  })
}

export function cachePath(video, cacheDir, beside) {
  if (beside) {
    const p = path.parse(video)
    return path.join(p.dir, p.name + '.aditor.json')
  }
  const key = crypto.createHash('sha1').update(path.resolve(video).toLowerCase().replace(/\\/g, '/')).digest('hex')
  return path.join(cacheDir, key + '.json')
}

function writeDoc(p, doc) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf-8')
  fs.renameSync(tmp, p)
}

function loadDoc(p) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return d && typeof d === 'object' ? d : null
  } catch {
    return null
  }
}

const DEFAULT_TEMPLATES_VERSION = 'icons@1'

/** Mirrors engine profile.load_profile: profile.json in profile_dir provides only the template version (language-independent, single configuration file). */
export function resolveProfile(profileDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf-8'))
    return { templatesVersion: p.templates_version || DEFAULT_TEMPLATES_VERSION }
  } catch {
    return { templatesVersion: DEFAULT_TEMPLATES_VERSION }
  }
}

/** Mirrors the inverse of engine/aditor/cache.needs_reanalysis: fresh means complete, video unchanged, and engine/template versions matching. */
export function isCacheFresh(old, info, prof) {
  const a = old?.analysis
  if (!a || a.status !== 'done') return false
  if (old.video?.size !== info.size || Math.abs(Number(old.video?.mtime) - info.mtime) >= 1e-6) return false
  if (a.engine_version !== ENGINE_VERSION) return false
  return a.templates_version === prof.templatesVersion
}

/** Synthetic events: 3 fights (around 12%/50%/88%), each with N/3 events; every 7th event repeats the previous name (duplicate enemy). */
export function synthEvents(duration, count) {
  const n = Math.max(1, count)
  const centers = [0.12, 0.5, 0.88].map((f) => duration * f)
  const width = Math.min(1.2, duration * 0.08)
  const per = Math.ceil(n / 3)
  const out = []
  for (let i = 0; i < n; i++) {
    const fight = i % 3
    const k = Math.floor(i / 3)
    const t = Math.round((centers[fight] - width / 2 + (width * k) / Math.max(1, per)) * 1000) / 1000
    out.push({
      id: `a${Math.round(t * 1000)}_${i}`,
      t,
      type: TYPES[i % TYPES.length],
      score: 0.9,
      damage_line: i % 2 === 0,
      name_sig: i % 7 === 6 ? `sig_${i - 1}` : `sig_${i}`,
      counted: false,
      counted_reason: '',
      counted_override: null,
      source: 'auto',
      deleted: false
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

const DEDUPE = 5
export function derive(events, spectating) {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const firsts = []
  return sorted.map((e) => {
    let counted
    let reason
    if (e.deleted) {
      counted = false
      reason = 'deleted'
    } else if (!COUNTING.has(e.type)) {
      counted = false
      reason = 'not_counting_type'
    } else if (spectating.some((s) => s.start <= e.t && e.t < s.end)) {
      counted = false
      reason = 'spectating'
    } else if (e.name_sig && firsts.some((f) => e.t - f.t >= 0 && e.t - f.t <= DEDUPE && f.name_sig === e.name_sig)) {
      counted = false
      reason = 'duplicate'
    } else {
      counted = true
      reason = 'first'
      if (e.name_sig) firsts.push(e)
    }
    return { ...e, counted, counted_reason: reason }
  })
}

const isCounted = (e) => (e.deleted ? false : e.counted_override !== null && e.counted_override !== undefined ? e.counted_override : e.counted)

/** Port of engine/aditor/autoclip.py. */
export function autoClips(events, params, duration) {
  const p = { gap: 20, n: 3, before: 8, after: 4, max_len: 90, ...params }
  const counted = events.filter(isCounted).sort((a, b) => a.t - b.t)
  if (!counted.length) return []
  const byId = new Map(counted.map((e) => [e.id, e]))
  const groups = []
  let cur = []
  for (const e of counted) {
    if (!cur.length || e.t - cur[cur.length - 1].t <= p.gap) cur.push(e)
    else {
      groups.push(cur)
      cur = [e]
    }
  }
  if (cur.length) groups.push(cur)
  const valid = groups.filter((g) => g.length >= p.n)
  const split = (grp) => {
    if (grp.length < p.n) return []
    const start = Math.max(0, grp[0].t - p.before)
    const end = Math.min(duration, grp[grp.length - 1].t + p.after)
    if (end <= start) return []
    if (end - start <= p.max_len + 1e-9) return [{ start, end, ids: grp.map((e) => e.id) }]
    const gaps = grp.slice(0, -1).map((e, i) => grp[i + 1].t - e.t)
    if (!gaps.length || Math.max(...gaps) <= 0) {
      const center = (grp[0].t + grp[grp.length - 1].t) / 2
      let cs = Math.max(0, center - p.max_len / 2)
      const ce = Math.min(duration, cs + p.max_len)
      if (ce - cs < p.max_len && cs > 0) cs = Math.max(0, ce - p.max_len)
      return [{ start: cs, end: ce, ids: grp.map((e) => e.id) }]
    }
    const candidates = []
    for (let i = p.n - 1; i < grp.length - p.n; i++) candidates.push(i)
    const pool = candidates.length ? candidates : grp.slice(0, -1).map((_, i) => i)
    let best = pool[0]
    for (const i of pool) if (grp[i + 1].t - grp[i].t > grp[best + 1].t - grp[best].t) best = i
    return [...split(grp.slice(0, best + 1)), ...split(grp.slice(best + 1))]
  }
  const drafts = valid.flatMap(split)
  if (!drafts.length) return []
  for (;;) {
    drafts.sort((a, b) => a.start - b.start || a.end - b.end)
    let changed = false
    let i = 0
    while (i < drafts.length - 1) {
      const prev = drafts[i]
      const nxt = drafts[i + 1]
      if (nxt.start < prev.end) {
        const ms = Math.min(prev.start, nxt.start)
        const me = Math.max(prev.end, nxt.end)
        if (me - ms <= p.max_len + 1e-9) {
          const ids = [...new Set([...prev.ids, ...nxt.ids])].sort((a, b) => byId.get(a).t - byId.get(b).t)
          drafts[i] = { start: ms, end: me, ids }
          drafts.splice(i + 1, 1)
          changed = true
          continue
        }
        const mid = (nxt.start + prev.end) / 2
        if (Math.abs(prev.end - mid) > 1e-9 || Math.abs(nxt.start - mid) > 1e-9) {
          prev.end = mid
          nxt.start = mid
          changed = true
        }
      }
      i++
    }
    if (!changed) break
  }
  return drafts
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((c) => ({ id: `c${Math.round(c.start * 1000)}`, start: c.start, end: c.end, origin: 'ai', event_ids: c.ids }))
}

function mergeReanalysis(oldEvents, fresh) {
  const out = fresh.map((e) => ({ ...e }))
  const used = new Set()
  const withState = oldEvents.filter((e) => e.source !== 'manual' && (e.deleted || (e.counted_override !== null && e.counted_override !== undefined)))
  for (const o of withState) {
    let best = -1
    let bd = Infinity
    out.forEach((n, i) => {
      if (used.has(i) || n.type !== o.type) return
      const d = Math.abs(n.t - o.t)
      if (d <= 1 && d < bd) {
        best = i
        bd = d
      }
    })
    if (best >= 0) {
      used.add(best)
      out[best] = { ...out[best], deleted: o.deleted, counted_override: o.counted_override }
    }
  }
  const manual = oldEvents.filter((e) => e.source === 'manual')
  return [...manual, ...out].sort((a, b) => a.t - b.t)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createE2EHandler(send) {
  let current = null // { id, cancel }

  async function analyze(id, args) {
    if (current) return send({ id, type: 'error', code: 'busy', message: 'An analysis is already in progress' })
    const run = { id, cancel: false }
    current = run
    try {
      const info = await runProbe(args.path)
      const cp = cachePath(args.path, args.cache_dir, !!args.beside)
      const prof = resolveProfile(args.profile_dir || '')
      const old = loadDoc(cp)
      if (!args.force && isCacheFresh(old, info, prof)) {
        old.cache_path = cp
        return send({ id, type: 'result', data: old })
      }
      const oldClips = Array.isArray(old?.clips) ? old.clips : []
      const manualClips = oldClips.filter((c) => c.origin === 'manual')
      const baseEvents = old ? (old.analysis?.status === 'partial' ? old.base_events : old.events) : null
      const spectating = [{ start: Math.round(info.duration * 0.95 * 100) / 100, end: info.duration }]
      const mk = (status, t, events, extra) => ({
        version: 1,
        video: info,
        analysis: {
          status,
          progress_t: t,
          engine_version: ENGINE_VERSION,
          templates_version: prof.templatesVersion,
          h_scale: 1.0
        },
        events,
        spectating: status === 'done' ? spectating : [],
        clips: manualClips,
        cache_path: cp,
        ...extra
      })
      const steps = Number(process.env.FAKE_ENGINE_STEPS || 10)
      const stepMs = Number(process.env.FAKE_ENGINE_STEP_MS || 30)
      const gate = process.env.FAKE_ENGINE_GATE_DIR ? path.join(process.env.FAKE_ENGINE_GATE_DIR, 'hold') : null
      for (let k = 1; k <= steps; k++) {
        await sleep(stepMs)
        if (gate && k === Math.ceil(steps / 2)) {
          // Pause midway until the hold file is removed (a deterministic way for tests to produce an "analyzing" state).
          while (fs.existsSync(gate) && !run.cancel) await sleep(20)
        }
        if (run.cancel) {
          const doc = mk('partial', (info.duration * (k - 1)) / steps, [], baseEvents ? { base_events: baseEvents } : {})
          writeDoc(cp, doc)
          return send({ id, type: 'error', code: 'cancelled', message: 'cancelled' })
        }
        send({ id, type: 'progress', t: (info.duration * k) / steps, duration: info.duration })
      }
      const count = Number(process.env.FAKE_ENGINE_EVENTS || 300)
      let events = synthEvents(info.duration, count)
      if (Array.isArray(baseEvents) && baseEvents.length) events = mergeReanalysis(baseEvents, events)
      events = derive(events, spectating)
      const keyframes = []
      for (let t = 0; t < info.duration; t += 2) keyframes.push(t)
      const doc = mk('done', info.duration, events, { keyframes, unmatched: [] })
      writeDoc(cp, doc)
      send({ id, type: 'result', data: doc })
    } catch (e) {
      send({ id, type: 'error', code: e.code || 'internal', message: String(e.message || e) })
    } finally {
      if (current === run) current = null
    }
  }

  return async function handle(req) {
    const { id, cmd } = req
    const args = req.args || {}
    try {
      if (cmd === 'cancel') {
        const hit = !!current && current.id === args.target
        if (hit) current.cancel = true
        return send({ id, type: 'result', data: { cancelled: hit } })
      }
      if (cmd === 'probe') return send({ id, type: 'result', data: await runProbe(args.path) })
      if (cmd === 'analyze') return void analyze(id, args)
      if (cmd === 'derive') return send({ id, type: 'result', data: { events: derive(args.events, args.spectating || []) } })
      if (cmd === 'autoclip') return send({ id, type: 'result', data: { clips: autoClips(args.events, args.params, Number(args.duration)) } })
      return send({ id, type: 'error', code: 'bad_request', message: `Unknown command: ${cmd}` })
    } catch (e) {
      send({ id, type: 'error', code: e.code || 'internal', message: String(e.message || e) })
    }
  }
}
