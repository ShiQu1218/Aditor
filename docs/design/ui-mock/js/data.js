/* Mock 資料：事件字樣影像取自 engine/tests/fixtures/zh-TW（縮小裁切），其餘為示意內容 */
const ICONS = {
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7z M13 4h4v16h-4z',
  prev: 'M6 5v14 M20 5v14L9 12z',
  next: 'M18 5v14 M4 5v14l11-7z',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 3 1.1-6.2L3 9.7l6.2-.9z',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-5-5',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14 M5 12h14',
  scissors: 'M9 6a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M8.1 8.1L20 20 M14.5 9.5L20 4 M8.1 15.9L12 12',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  export: 'M12 3v12 M7 8l5-5 5 5 M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M16 4v4 M10 10v4 M18 16v4',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  film: 'M4 4h16v16H4z M8 4v16 M16 4v16 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
  x: 'M6 6l12 12 M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  check: 'M5 12l5 5L20 7',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3',
  zin: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-5-5 M11 8v6 M8 11h6',
  zout: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M21 21l-5-5 M8 11h6',
  chev: 'M6 9l6 6 6-6',
  back: 'M15 5l-7 7 7 7',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  warn: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  queue: 'M4 6h16 M4 12h16 M4 18h10',
  kbd: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  eyeoff: 'M3 3l18 18 M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3.2 3.9 M6.2 6.9C3.9 8.5 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h11v11H9z M5 15V5h10',
  flag: 'M5 21V4 M5 4h12l-2 4 2 4H5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  swap: 'M7 4l-4 4 4 4 M3 8h14 M17 20l4-4-4-4 M21 16H7',
  // 事件字形（時間軸 canvas 與 DOM 共用）
  g_knock: 'M17 12a5 5 0 1 1-10 0a5 5 0 0 1 10 0z M12 3v4 M12 17v4 M3 12h4 M17 12h4',
  g_assist: 'M12 5v14 M5 12h14',
  g_x: 'M7 7l10 10 M17 7L7 17',
  g_skull: 'M12 4a7 7 0 0 0-4 12.7V19h8v-2.3A7 7 0 0 0 12 4z M9.5 11.5h.01 M14.5 11.5h.01',
  g_burst: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'
};
const TYPES = {
  knock: { label: '擊倒', glyph: 'g_knock', color: '#ff8a2b' },
  assist_knock: { label: '助攻擊倒', glyph: 'g_assist', color: '#38bdf8' },
  assist_elim: { label: '助攻消滅', glyph: 'g_x', color: '#2dd4bf' },
  elim: { label: '已消滅', glyph: 'g_skull', color: '#f2e65a' },
  squad_wipe: { label: '小隊抹殺', glyph: 'g_burst', color: '#b66dff' }
};
const REASONS = { first: '首次', duplicate: '重複敵人', spectating: '觀戰中', not_counting_type: '小隊抹殺不計', manual: '手動' };
const BANNER = { knock: 'knock_a005000', assist_knock: 'assist_knock_a007150', assist_elim: 'assist_elim_a007400', elim: 'elim_a005375', squad_wipe: 'squad_wipe_a066500' };

/* 影片庫 */
const LIBRARY = [
  { id: 'v1', name: 'Apex Legends_07-13-2026_17-17-13-950.mp4', date: '2026-07-13', time: '17:17', dur: 822, res: '1916×1080', status: 'done', knock: 12, assist: 4, hl: 3, fav: true, scene: 's1', banner: 'knock_a005000' },
  { id: 'v2', name: 'Apex Legends_07-13-2026_17-33-52-100.mp4', date: '2026-07-13', time: '17:33', dur: 738, res: '1916×1080', status: 'done', knock: 7, assist: 3, hl: 1, fav: false, scene: 's2', banner: 'squad_wipe_a066500' },
  { id: 'v3', name: 'Apex Legends_07-13-2026_17-50-59-50.mp4', date: '2026-07-13', time: '17:50', dur: 845, res: '1916×1080', status: 'analyzing', progress: 0.42, eta: '約剩 6 分', scene: 's3' },
  { id: 'v4', name: 'Apex Legends_07-13-2026_18-3-35-350.mp4', date: '2026-07-13', time: '18:03', dur: 807, res: '1916×1080', status: 'pending', scene: 's4' },
  { id: 'v5', name: 'Apex Legends_10-13-2026_20-14-07-420.mp4', date: '2026-10-13', time: '20:14', dur: 6022, res: '1916×1080', codec: 'AV1', status: 'pending', scene: 's5', proxyHint: true },
  { id: 'v6', name: 'Apex Legends_10-13-2026_22-41-18-800.mp4', date: '2026-10-13', time: '22:41', dur: 1260, res: '1916×1080', codec: 'AV1', status: 'done', knock: 15, assist: 6, hl: 4, fav: false, scene: 's6', proxyHint: true, banner: 'elim_a005375' },
  { id: 'v8', name: 'Apex Legends_10-13-2026_16-45-41-533.mp4', date: '2026-10-13', time: '16:45', dur: 8240, res: '1916×1080', codec: 'AV1', status: 'done', knock: 118, assist: 41, hl: 24, fav: false, scene: 's3', proxyHint: true, banner: 'knock_d008550' },
  { id: 'v7', name: 'Apex Legends_10-14-2026_19-02-44-310.mp4', date: '2026-10-14', time: '19:02', dur: 0, res: '', status: 'error', err: '無法讀取影片：ffprobe 回報檔案損壞（moov atom not found）', scene: 's2' }
];

/* 工作室：單支影片 17-17-13（822 秒） */
let VIDEO = { id: 'v1', name: LIBRARY[0].name, duration: 822, codec: 'H.264', res: '1916×1080' };
let EVENTS = [
  { id: 'e1', t: 50.0, type: 'knock', score: 0.93, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e2', t: 53.75, type: 'elim', score: 0.88, counted: false, reason: 'duplicate', ov: null, src: 'auto' },
  { id: 'e3', t: 64.5, type: 'assist_knock', score: 0.9, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e4', t: 71.5, type: 'assist_knock', score: 0.86, counted: false, reason: 'duplicate', ov: null, src: 'auto' },
  { id: 'e5', t: 74.0, type: 'assist_elim', score: 0.84, counted: false, reason: 'duplicate', ov: true, src: 'auto' },
  { id: 'e6', t: 78.25, type: 'knock', score: 0.95, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e7', t: 332.5, type: 'knock', score: 0.91, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e8', t: 338.0, type: 'knock', score: 0.92, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e9', t: 349.25, type: 'assist_elim', score: 0.85, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e10', t: 352.0, type: 'knock', score: 0.94, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e11', t: 410.0, type: 'knock', score: 1, counted: true, reason: 'manual', ov: null, src: 'manual' },
  { id: 'e12', t: 520.0, type: 'assist_elim', score: 0.83, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e13', t: 580.0, type: 'elim', score: 0.9, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e14', t: 648.0, type: 'assist_knock', score: 0.87, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e15', t: 655.0, type: 'knock', score: 0.92, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e16', t: 662.25, type: 'knock', score: 0.96, dmg: true, counted: true, reason: 'first', ov: null, src: 'auto' },
  { id: 'e17', t: 664.5, type: 'squad_wipe', score: 0.97, counted: false, reason: 'not_counting_type', ov: null, src: 'auto' },
  { id: 'e18', t: 736.5, type: 'knock', score: 0.89, counted: false, reason: 'spectating', ov: null, src: 'auto' },
  { id: 'e19', t: 739.5, type: 'squad_wipe', score: 0.9, counted: false, reason: 'spectating', ov: null, src: 'auto' }
];
let SPECTATING = [{ start: 726.0, end: 740.5 }];
const PROJECT_SEED = [
  { id: 'p1', video: 'v1', vname: '17-17-13', start: 42.0, end: 82.25, label: '4 殺精華', scene: 's1', banner: 'knock_a005000' },
  { id: 'p2', video: 'v2', vname: '17-33-52', start: 131.0, end: 168.5, label: '3 殺精華', scene: 's2', banner: 'squad_wipe_a066500' },
  { id: 'p3', video: 'v1', vname: '17-17-13', start: 402.0, end: 414.0, label: '快速剪輯', scene: 's1', banner: 'knock_d008550' }
];
const QUEUE = [
  { name: 'Apex Legends_07-13-2026_17-50-59-50.mp4', p: 0.42, eta: '約剩 6 分', state: '分析中' },
  { name: 'Apex Legends_10-13-2026_20-14-07-420.mp4', p: 0.18, eta: '約剩 41 分', state: '等待（一次分析一支）' },
  { name: 'Apex Legends_07-13-2026_18-3-35-350.mp4', p: 0, eta: '', state: '等待' }
];

/* 2 小時長片驗收資料集：約 300 個事件（確定性偽隨機） */
function genLong() {
  let seed = 7;
  const r = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const dur = 8240.5;
  const spec = [{ start: 2650, end: 2702 }, { start: 5120, end: 5181 }, { start: 7905, end: 7962 }];
  const pick = () => { const x = r(); return x < 0.5 ? 'knock' : x < 0.62 ? 'assist_knock' : x < 0.72 ? 'assist_elim' : x < 0.9 ? 'elim' : 'squad_wipe'; };
  const ev = [];
  const push = (t, big) => {
    const type = big ? 'knock' : pick();
    ev.push({ t: Math.round(t * 4) / 4, type, score: 0.8 + r() * 0.19, dmg: type === 'knock' && r() > 0.4 });
  };
  for (let f = 0; f < 46; f++) {
    const n = f % 7 === 0 ? 7 : f % 3 === 0 ? 5 : 3 + Math.floor(r() * 2);
    let t = 120 + f * ((dur - 300) / 46) + r() * 60;
    for (let i = 0; i < n; i++) { t += 3 + r() * 13; push(t, i === 0); }
  }
  for (let i = 0; i < 100; i++) push(60 + r() * (dur - 120), false);
  ev.sort((a, b) => a.t - b.t);
  const out = ev.map((e, i) => {
    const inSpec = spec.some((s) => e.t >= s.start && e.t <= s.end);
    const wipe = e.type === 'squad_wipe';
    const dup = !inSpec && !wipe && r() > 0.82;
    return { id: 'L' + i, t: e.t, type: e.type, score: e.score, dmg: e.dmg, counted: !inSpec && !wipe && !dup, reason: inSpec ? 'spectating' : wipe ? 'not_counting_type' : dup ? 'duplicate' : 'first', ov: null, src: 'auto' };
  });
  return { events: out, spec, video: { id: 'v8', name: LIBRARY.find((v) => v.id === 'v8').name, duration: dur, codec: 'AV1', res: '1916×1080' } };
}
