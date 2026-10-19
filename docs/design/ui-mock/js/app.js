/* Aditor UI mock — 純前端示意（無建置步驟） */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (t) => {
    t = Math.max(0, t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmt1 = (t) => `${fmt(t)}.${Math.floor((t % 1) * 10)}`;
  const ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24"><path d="${ICONS[name]}"/></svg>`;
  const evt = (type, off) => `<span class="evt ${type}${off ? ' off' : ''}">${ic(TYPES[type].glyph)}</span>`;
  const isC = (e) => !e.deleted && (e.ov !== null && e.ov !== undefined ? e.ov : e.counted);
  const V0 = VIDEO, E0 = EVENTS, SP0 = SPECTATING;
  const SRC_COLOR = { v1: '#9fb4d6', v2: '#d6c39f', v8: '#a8d6a0' };
  const SRC_LETTER = { v1: 'A', v2: 'B', v8: 'C' };

  function hydrate(root = document) {
    $$('svg[data-ic]', root).forEach((s) => {
      s.setAttribute('viewBox', '0 0 24 24');
      s.innerHTML = `<path d="${ICONS[s.dataset.ic]}"/>`;
      s.removeAttribute('data-ic');
    });
  }

  /* ---------------- 狀態 ---------------- */
  const S = {
    screen: 'library', libFilter: 'all', libEmpty: false,
    t: 50, playing: false, speed: 1, mode: 'source', tab: 'hl', zone: null,
    filter: new Set(Object.keys(TYPES)), selected: new Set(['e7', 'e8']),
    events: JSON.parse(JSON.stringify(EVENTS)), clips: [],
    project: JSON.parse(JSON.stringify(PROJECT_SEED)), selProj: 'p1', curProj: 'p1',
    view: { start: 0, span: VIDEO.duration },
    studio: 'ready', // ready | long | error | proxy
    asideOpen: true, hlBig: false, projCollapsed: window.innerHeight <= 800,
    ac: { n: 3, gap: 20, before: 8, after: 4, max: 90 },
    export: 'config', activeHl: null, hoverClip: null, space: false
  };
  const visibleEvents = () => (S.studio === 'error' ? [] : S.events);

  /* ---------------- 自動剪輯（對應 spec §5.4，僅供示意） ---------------- */
  function autoclip(events, p, dur) {
    const ev = events.filter(isC).sort((a, b) => a.t - b.t);
    const groups = [];
    ev.forEach((e) => {
      const g = groups[groups.length - 1];
      if (g && e.t - g[g.length - 1].t <= p.gap) g.push(e); else groups.push([e]);
    });
    const make = (g) => {
      const s = Math.max(0, g[0].t - p.before), en = Math.min(dur, g[g.length - 1].t + p.after);
      if (en - s <= p.max || g.length < 2) return [{ start: s, end: en, ids: g.map((x) => x.id) }];
      let bi = 1, bg = -1;
      for (let i = 1; i < g.length; i++) { const d = g[i].t - g[i - 1].t; if (d > bg) { bg = d; bi = i; } }
      return [g.slice(0, bi), g.slice(bi)].filter((x) => x.length >= p.n).flatMap(make);
    };
    return groups.filter((g) => g.length >= p.n).flatMap(make);
  }
  function regenSuggestions() {
    const keep = S.clips.filter((c) => c.origin === 'manual' || c.status === 'accepted');
    const res = autoclip(S.events, S.ac, VIDEO.duration).map((c, i) => ({
      id: 'ai' + i + '_' + Math.round(c.start), start: c.start, end: c.end, ids: c.ids, origin: 'ai', status: 'suggested'
    }));
    S.clips = keep.concat(res.filter((r) => !keep.some((k) => Math.abs(k.start - r.start) < 1)));
    S.clips.sort((a, b) => a.start - b.start);
  }
  function initClips() {
    S.clips = [];
    regenSuggestions();
    if (S.studio !== 'long') {
      S.clips.push({ id: 'm1', start: 402, end: 414, ids: ['e11'], origin: 'manual', status: 'accepted' });
      const first = S.clips.find((c) => c.start < 60);
      if (first) first.status = 'accepted';
    }
    S.clips.sort((a, b) => a.start - b.start);
  }

  /* ---------------- 路由 ---------------- */
  function go(name) {
    S.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + name));
    $$('.rail-btn[data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
    closePops();
    if (name === 'studio') { renderStudio(); requestAnimationFrame(drawTL); }
  }
  function closePops() { $('#pop-ac').classList.remove('show'); $('#qpop').classList.remove('show'); }
  function toast(msg, action, fn) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span>${msg}</span>${action ? `<button>${action}</button>` : ''}`;
    if (action) el.querySelector('button').onclick = () => { fn && fn(); el.remove(); };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), action ? 6000 : 3800);
  }

  /* ---------------- 影片庫 ---------------- */
  function libMatch(v) {
    const q = $('#lib-search').value.trim().toLowerCase();
    if (q && !v.name.toLowerCase().includes(q)) return false;
    const f = S.libFilter;
    if (f === 'fav') return v.fav;
    if (f === 'knock') return (v.knock || 0) > 0;
    if (f === 'assist') return (v.assist || 0) > 0;
    if (f === 'hl') return (v.hl || 0) > 0;
    return true;
  }
  function cardHtml(v) {
    const sc = `<div class="scene ${v.scene} thumb">${v.banner && v.status === 'done' ? `<img class="banner" src="img/${v.banner}.jpg" alt="" loading="lazy" decoding="async">` : ''}</div>`;
    let overlay = '', prog = '', badges = '';
    if (v.status === 'done') {
      badges = `<div class="tl-badges"><span class="cnt">${evt('knock')}${v.knock}</span><span class="cnt">${evt('assist_knock')}${v.assist}</span>${v.hl ? `<span class="cnt slant" style="padding-left:8px">${ic('sparkles', 'sm')}${v.hl} 精華</span>` : ''}</div>`;
    } else if (v.status === 'analyzing') {
      overlay = `<div class="overlay-c"><div>分析中 ${Math.round(v.progress * 100)}%<small>${v.eta} · 完成後可開啟</small></div></div>`;
      prog = `<div class="progress"><i style="width:${v.progress * 100}%"></i></div>`;
    } else if (v.status === 'pending') {
      overlay = `<div class="overlay-c"><div style="color:var(--text-2)">等待分析<small>排在佇列第 2 位</small></div></div>`;
    }
    if (v.status === 'error') {
      return `<div class="card err" data-id="${v.id}"><div class="thumb-wrap"><div class="scene ${v.scene} thumb" style="filter:grayscale(1) brightness(.5)"></div><div class="overlay-c" style="color:var(--danger)">${ic('warn', 'lg')}</div></div>
        <div class="body"><div class="name">${v.name}</div><div class="meta" style="color:var(--danger)">${v.err}</div>
        <div class="row-actions"><button class="btn sm">重試</button><button class="btn sm ghost danger">從影片庫移除</button></div></div></div>`;
    }
    return `<div class="card" data-id="${v.id}" tabindex="0" role="button" aria-label="${v.name}">
      <div class="thumb-wrap">${sc}${overlay}${prog}
        ${v.proxyHint ? `<div class="badge-tl"><span class="pill warn slant">${v.codec} · 建議代理檔</span></div>` : ''}
        <button class="fav ${v.fav ? 'on' : ''}" title="收藏 (Ctrl+D)" aria-label="收藏">${ic('star', 'sm')}</button>
        ${badges}<span class="time-badge slant" style="padding-right:10px">${v.dur ? fmt(v.dur) : '--:--'}</span>
      </div>
      <div class="body"><div class="name" title="${v.name}">${v.name}</div>
        <div class="meta"><span>${v.date} ${v.time}</span><span>${v.res}</span>${v.codec ? `<span>${v.codec}</span>` : ''}</div></div>
      <button class="btn ghost icon more" title="更多" aria-label="更多">${ic('more', 'sm')}</button></div>`;
  }
  function renderLibrary() {
    const list = LIBRARY.filter(libMatch);
    $('#n-all').textContent = LIBRARY.length;
    $('#lib-empty').classList.toggle('hidden', !S.libEmpty);
    $('#lib-groups').classList.toggle('hidden', S.libEmpty);
    $('#queue-strip').classList.toggle('hidden', S.libEmpty);
    $('.lib-tools').classList.toggle('hidden', S.libEmpty);
    if (S.libEmpty) { $('#lib-groups').innerHTML = ''; return; }
    const groups = {};
    list.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).forEach((v) => (groups[v.date] = groups[v.date] || []).push(v));
    const label = (d) => (d === '2026-10-15' ? '今天' : d === '2026-10-14' ? '昨天' : d.replace(/^(\d+)-(\d+)-(\d+)$/, (m, y, mo, da) => `${y} 年 ${+mo} 月 ${+da} 日`));
    $('#lib-groups').innerHTML = Object.keys(groups).sort().reverse().map((d) =>
      `<div class="sect-h"><h2>${label(d)}</h2><span>${groups[d].length} 支影片</span></div><div class="grid">${groups[d].map(cardHtml).join('')}</div>`).join('') ||
      `<div class="dim" style="padding:60px;text-align:center"><b style="font-size:16px;color:var(--text-2)">沒有符合條件的影片</b><br>調整搜尋關鍵字或篩選條件。</div>`;
    $$('.card[data-id]').forEach((c) => {
      const open = (e) => {
        if (c.classList.contains('err')) return;
        if (e && e.target.closest && e.target.closest('.fav')) { const v = LIBRARY.find((x) => x.id === c.dataset.id); v.fav = !v.fav; renderLibrary(); return; }
        openStudio(c.dataset.id);
      };
      c.onclick = open;
      c.onkeydown = (e) => { if (e.key === 'Enter' && e.target === c) open(); };
    });
  }
  function openStudio(id) {
    const v = LIBRARY.find((x) => x.id === id);
    if (v.status !== 'done') { toast('分析完成後才能開啟（分析中即可檢視為第二版項目）'); return; }
    S.studio = id === 'v6' ? 'proxy' : id === 'v8' ? 'long' : 'ready';
    go('studio'); applyStudioState();
  }

  /* ---------------- 工作室 ---------------- */
  function loadDataset() {
    if (S.studio === 'long') { const g = genLong(); VIDEO = g.video; SPECTATING = g.spec; S.events = g.events; }
    else { VIDEO = V0; SPECTATING = SP0; S.events = JSON.parse(JSON.stringify(E0)); }
    S.selected = new Set(S.studio === 'long' ? [] : ['e7', 'e8']);
    S.t = 50; S.mode = 'source'; S.playing = false; clearInterval(timer);
  }
  function renderFilters() {
    const ev = visibleEvents();
    $('#filters').innerHTML = Object.keys(TYPES).map((k) => {
      const n = ev.filter((e) => e.type === k && !e.deleted).length;
      return `<button class="fchip ${S.filter.has(k) ? '' : 'off'}" data-f="${k}" aria-pressed="${S.filter.has(k)}" title="${TYPES[k].label}">${evt(k)}<span class="lb">${TYPES[k].label}</span><span class="n">${n}</span></button>`;
    }).join('');
    $$('#filters .fchip').forEach((b) => (b.onclick = () => { const k = b.dataset.f; S.filter.has(k) ? S.filter.delete(k) : S.filter.add(k); renderFilters(); renderAside(); drawTL(); }));
  }
  function applyStudioState() {
    const st = S.studio;
    loadDataset();
    $('#st-name').textContent = VIDEO.name;
    $('#st-meta').textContent = `${VIDEO.res} · ${VIDEO.codec} · ${fmt(VIDEO.duration)} · ${S.events.length} 個事件`;
    $('#st-status').innerHTML = st === 'error' ? '<span class="pill err">分析失敗</span>' : '<span class="pill ok">分析完成</span>';
    const n = $('#st-notice');
    if (st === 'error') n.innerHTML = `<div class="notice err">${ic('warn')}<div class="grow"><b>分析引擎異常結束</b>　程序結束代碼 3221225477。不會遺失已完成的進度，可從上次位置接續。</div><button class="btn sm">接續分析</button><button class="btn sm ghost">複製錯誤訊息</button></div>`;
    else if (st === 'proxy' || st === 'long') n.innerHTML = `<div class="notice warn">${ic('warn')}<div class="grow"><b>播放可能不流暢</b>　這支 AV1 影片在本機沒有硬體解碼，建議產生預覽用代理檔（匯出仍使用原始檔）。</div><button class="btn sm primary">產生代理檔</button><button class="btn sm ghost">稍後再說</button></div>`;
    else n.innerHTML = '';
    S.view = { start: 0, span: VIDEO.duration };
    initClips();
    if (st === 'error') S.clips = S.clips.filter((c) => c.origin === 'manual');
    S.tab = 'hl';
    renderStudio();
  }
  function renderStudio() {
    renderFilters(); renderAside(); renderProject(); updatePlayer(); drawTL();
    $('#rail-proj').textContent = S.project.length;
    $('#exp-n').textContent = S.project.length;
    $('#studio').classList.toggle('no-aside', !S.asideOpen);
    $('#project-lane').classList.toggle('collapsed', S.projCollapsed);
  }
  const clipEvents = (c) => visibleEvents().filter((e) => !e.deleted && e.t >= c.start && e.t <= c.end);
  function hlCard(c, i) {
    const evs = clipEvents(c);
    const counted = evs.filter(isC).length;
    const first = evs.find(isC) || evs[0];
    const label = c.origin === 'manual' ? '快速剪輯' : `${counted} 殺精華`;
    const tagT = c.origin === 'ai' ? (c.status === 'accepted' ? 'AI 精華' : 'AI 建議') : '手動';
    const stl = c.status === 'accepted' ? 'accepted' : c.status === 'skipped' ? 'skipped' : '';
    const acts = c.status === 'accepted'
      ? `<span class="pill ok">${ic('check', 'sm')}已加入</span><span class="grow"></span><button class="btn sm ghost" data-a="undo" data-id="${c.id}">移出</button>`
      : c.status === 'skipped'
        ? `<span class="dim">已略過</span><span class="grow"></span><button class="btn sm" data-a="restore" data-id="${c.id}">復原</button>`
        : `<button class="btn sm icon" data-a="play" data-id="${c.id}" title="預覽" aria-label="預覽">${ic('play', 'sm')}</button><span class="grow"></span><button class="btn sm ghost" data-a="skip" data-id="${c.id}">略過</button><button class="btn sm primary" data-a="accept" data-id="${c.id}">${ic('plus', 'sm')}加入</button>`;
    const shown = evs.slice(0, 12);
    return `<div class="hl ${S.hlBig ? '' : 'compact'} ${stl} ${S.activeHl === c.id ? 'active' : ''}" data-id="${c.id}" role="listitem">
      <div class="thumb"><div class="scene s${(i % 6) + 1}" style="position:absolute;inset:0">${first ? `<img class="banner" src="img/${BANNER[first.type]}.jpg" alt="">` : ''}</div><span class="pill slant tag" style="background:rgba(0,0,0,.75);color:#fff">${tagT}</span><span class="play">${ic('play')}</span><span class="time-badge">${fmt(c.end - c.start)}</span></div>
      <div class="info"><h4>${label}<span class="dim mono" style="font-weight:400;font-size:12px">${fmt(c.start)}–${fmt(c.end)}</span></h4>
      <div class="evts">${shown.map((e) => evt(e.type, !isC(e))).join('')}${evs.length > 12 ? `<span class="dim" style="font-size:11px">+${evs.length - 12}</span>` : ''}</div>
      <div class="acts">${acts}</div></div></div>`;
  }
  function renderAside() {
    const body = $('#tab-body'), foot = $('#aside-foot');
    const vis = visibleEvents();
    $$('.tab').forEach((t) => { t.classList.toggle('active', t.dataset.tab === S.tab); t.setAttribute('aria-selected', t.dataset.tab === S.tab); });
    const hls = S.clips;
    $('#n-hl').textContent = hls.length;
    $('#n-ev').textContent = vis.filter((e) => !e.deleted).length;
    if (S.tab === 'hl') {
      const pending = hls.filter((c) => c.status === 'suggested').length;
      body.setAttribute('role', 'list'); body.setAttribute('aria-label', '精華清單');
      if (!hls.length) {
        body.innerHTML = `<div class="dim" style="text-align:center;padding:48px 16px"><div style="color:var(--text-2)">${ic('sparkles', 'lg')}</div><b style="display:block;color:var(--text-2);font-size:15px;margin:8px 0 4px">${S.studio === 'error' ? '尚無分析結果' : '找不到符合條件的精華'}</b>${S.studio === 'error' ? '接續分析完成後，這裡會出現多殺精華建議。' : '試試調高 gap、調低 n，或到「事件」分頁勾選事件建立合輯。'}<div style="margin-top:14px"><button class="btn sm" id="empty-ac">調整 AI 參數</button></div></div>`;
        foot.innerHTML = '';
        const b = $('#empty-ac'); if (b) b.onclick = () => togglePop('pop-ac');
      } else {
        body.innerHTML = `<div class="list-h"><span><b style="color:var(--text-1)">${pending}</b> 項待確認</span><span class="grow"></span><span class="seg"><button data-v="c" class="${S.hlBig ? '' : 'on'}">精簡</button><button data-v="b" class="${S.hlBig ? 'on' : ''}">大圖</button></span></div><div class="dim" style="font-size:12px">聚焦清單後：<kbd>Enter</kbd> 加入　<kbd>Delete</kbd> 略過　<kbd>↑↓</kbd> 移動</div>` + hls.map(hlCard).join('');
        $$('.seg button', body).forEach((b) => (b.onclick = () => { S.hlBig = b.dataset.v === 'b'; renderAside(); }));
        foot.innerHTML = `<span class="summary">專案 <b>${S.project.length}</b> 段 · ${fmt(S.project.reduce((a, p) => a + p.end - p.start, 0))}</span><span class="grow"></span><button class="btn primary sm" id="acc-all" ${pending ? '' : 'disabled'}>全部加入 <kbd style="color:#fff">Ctrl E</kbd></button>`;
        $('#acc-all').onclick = acceptAll;
      }
    } else {
      body.setAttribute('role', 'list'); body.setAttribute('aria-label', '事件清單');
      const list = vis.filter((e) => S.filter.has(e.type));
      const cnt = vis.filter((e) => !e.deleted && isC(e)).length;
      body.innerHTML = `<div class="list-h"><span class="summary">計入 <b>${cnt}</b>　不計入 <b>${vis.filter((e) => !e.deleted).length - cnt}</b></span><span class="grow"></span><span class="dim">單擊跳轉；勾選或 Shift+點時間軸選取</span></div>` +
        (list.length ? list.map((e) => {
          const c = isC(e);
          const reason = e.ov === true ? '強制計入' : e.ov === false ? '強制不計入' : REASONS[e.reason] || '';
          return `<div class="rowev ${S.selected.has(e.id) ? 'sel' : ''} ${e.deleted ? 'deleted' : ''} ${Math.abs(S.t - e.t) < 3 ? 'cur' : ''}" data-id="${e.id}" role="listitem" aria-label="${TYPES[e.type].label} ${fmt(e.t)} ${c ? '計入' : '不計入：' + reason}">
            <input type="checkbox" ${S.selected.has(e.id) ? 'checked' : ''} aria-label="選取">
            ${evt(e.type, !c)}<span class="t">${fmt(e.t)}</span>
            <span class="lbl">${TYPES[e.type].label}<small>${reason}${e.dmg ? ' · 含傷害行' : ''}${e.src === 'manual' ? '' : ' · ' + Math.round(e.score * 100) + '%'}</small></span>
            <span class="tri" data-id="${e.id}" role="group" aria-label="計入統計"><button data-v="null" class="${e.ov == null ? 'on' : ''}">自動</button><button data-v="true" class="${e.ov === true ? 'on yes' : ''}">計入</button><button data-v="false" class="${e.ov === false ? 'on no' : ''}">不計</button></span>
            <button class="x" title="刪除（可復原）" aria-label="刪除事件">${ic('x', 'sm')}</button></div>`;
        }).join('') : `<div class="dim" style="text-align:center;padding:40px">${S.studio === 'error' ? '尚無事件' : '沒有符合篩選條件的事件'}</div>`);
      foot.innerHTML = `<span class="summary">已選 <b>${S.selected.size}</b> 個事件</span><span class="grow"></span><button class="btn sm" id="sel-clear" ${S.selected.size ? '' : 'disabled'}>清除</button><button class="btn primary sm" id="sup" ${S.selected.size ? '' : 'disabled'}>${ic('film', 'sm')}建立合輯 <kbd style="color:#fff">Ctrl M</kbd></button>`;
      $('#sel-clear').onclick = () => { S.selected.clear(); renderAside(); drawTL(); };
      $('#sup').onclick = createSupercut;
      $$('.rowev', body).forEach((r) => {
        const id = r.dataset.id, e = S.events.find((x) => x.id === id);
        r.onclick = (ev) => {
          if (ev.target.closest('.tri') || ev.target.closest('.x')) return;
          if (ev.target.type === 'checkbox') { S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); renderAside(); drawTL(); return; }
          seek(Math.max(0, e.t - 8));
        };
        $$('.tri button', r).forEach((b) => (b.onclick = () => { e.ov = b.dataset.v === 'null' ? null : b.dataset.v === 'true'; renderAside(); drawTL(); toast('已重新推導計入結果'); }));
        $('.x', r).onclick = () => deleteEvents([id]);
      });
    }
    $$('.hl [data-a]').forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); hlAction(b.dataset.a, b.dataset.id); }));
    $$('.hl .thumb').forEach((t) => (t.onclick = () => { const c = S.clips.find((x) => x.id === t.parentElement.dataset.id); S.activeHl = c.id; S.mode = 'source'; seek(c.start); renderAside(); drawTL(); }));
  }
  function deleteEvents(ids) {
    const evs = S.events.filter((e) => ids.includes(e.id) && !e.deleted);
    if (!evs.length) return;
    evs.forEach((e) => { e.deleted = true; S.selected.delete(e.id); });
    renderAside(); renderFilters(); drawTL();
    toast(`已刪除 ${evs.length} 個事件`, '復原', () => { evs.forEach((e) => (e.deleted = false)); renderAside(); renderFilters(); drawTL(); });
  }
  function hlAction(a, id) {
    const c = S.clips.find((x) => x.id === id);
    if (a === 'accept') { c.status = 'accepted'; addToProject(c); toast(`已加入專案（${fmt(c.end - c.start)}）`, '復原', () => { c.status = 'suggested'; S.project = S.project.filter((p) => !(p.start === c.start && p.video === VIDEO.id)); renderStudio(); }); }
    if (a === 'skip') { c.status = 'skipped'; toast('已略過這段建議', '復原', () => { c.status = 'suggested'; renderStudio(); }); }
    if (a === 'restore') c.status = 'suggested';
    if (a === 'undo') { c.status = 'suggested'; S.project = S.project.filter((p) => !(p.start === c.start && p.video === VIDEO.id)); }
    if (a === 'play') { S.mode = 'source'; S.activeHl = id; seek(c.start); play(true); }
    renderStudio();
  }
  function addToProject(c) {
    if (S.project.some((p) => p.video === VIDEO.id && p.start === c.start)) return;
    const ft = (clipEvents(c).find(isC) || { type: 'knock' }).type;
    S.project.push({ id: 'p' + Date.now() + Math.random().toString(16).slice(2, 5), video: VIDEO.id, vname: VIDEO.name.match(/(\d+-\d+-\d+)-\d+\.mp4$/)[1], start: c.start, end: c.end, label: c.origin === 'manual' ? '快速剪輯' : `${clipEvents(c).filter(isC).length} 殺精華`, scene: S.studio === 'long' ? 's3' : 's1', banner: BANNER[ft] });
    markSaved();
  }
  function acceptAll() {
    const ps = S.clips.filter((c) => c.status === 'suggested');
    if (!ps.length) return;
    ps.forEach((c) => { c.status = 'accepted'; addToProject(c); });
    toast(`已加入 ${ps.length} 段到專案`, '復原', () => { ps.forEach((c) => { c.status = 'suggested'; S.project = S.project.filter((p) => !(p.start === c.start && p.video === VIDEO.id)); }); renderStudio(); });
    renderStudio();
  }
  function createSupercut() {
    const evs = S.events.filter((e) => S.selected.has(e.id) && !e.deleted).sort((a, b) => a.t - b.t);
    if (!evs.length) return;
    const raw = evs.map((e) => ({ start: Math.max(0, e.t - 8), end: Math.min(VIDEO.duration, e.t + 4), ids: [e.id] }));
    const merged = [];
    raw.forEach((r) => { const l = merged[merged.length - 1]; if (l && r.start <= l.end) { l.end = Math.max(l.end, r.end); l.ids.push(...r.ids); } else merged.push({ ...r }); });
    const added = merged.map((m, i) => ({ id: 'sc' + Date.now() + i, start: m.start, end: m.end, ids: m.ids, origin: 'manual', status: 'accepted' }));
    added.forEach((c) => { S.clips.push(c); addToProject(c); });
    S.clips.sort((a, b) => a.start - b.start);
    S.tab = 'hl'; S.selected.clear();
    toast(`已建立 ${merged.length} 段合輯並加入專案（重疊已合併）`, '復原', () => { added.forEach((c) => { S.clips = S.clips.filter((x) => x !== c); S.project = S.project.filter((p) => !(p.start === c.start && p.video === VIDEO.id)); }); renderStudio(); });
    renderStudio();
  }

  /* ---- 專案軌 ---- */
  const plen = (p) => p.end - p.start;
  let hist = [], redoS = [];
  function markSaved() { const el = $('#saved'); if (!el) return; el.innerHTML = '<i style="background:var(--warning)"></i>儲存中…'; setTimeout(() => (el.innerHTML = '<i></i>已自動儲存'), 700); }
  const snap = () => { hist.push(JSON.stringify(S.project)); redoS = []; markSaved(); };
  function renderProject() {
    const tr = $('#track');
    const total = S.project.reduce((a, p) => a + plen(p), 0);
    $('#proj-sub').textContent = fmt(total);
    $('#proj-info').innerHTML = `<span class="dim">${S.project.length} 段 · 總長 <b style="color:var(--text-1)">${fmt(total)}</b><span class="xtra"> · 來自 ${new Set(S.project.map((p) => p.video)).size} 支影片</span></span>`;
    $('#p-fold').style.transform = S.projCollapsed ? 'rotate(-90deg)' : '';
    tr.innerHTML = S.project.map((p, i) => {
      const w = Math.max(92, Math.min(360, plen(p) * 6));
      const cur = S.mode === 'project' && S.curProj === p.id;
      const pct = cur ? Math.min(100, ((S.t - p.start) / plen(p)) * 100) : 0;
      return `<div class="pclip ${S.selProj === p.id ? 'sel' : ''} ${cur ? 'cur' : ''}" draggable="true" data-id="${p.id}" role="listitem" aria-label="片段 ${i + 1} ${p.label} ${fmt(plen(p))}" style="width:${w}px">
        <div class="scene ${p.scene}"><img class="banner" alt=""></div><span class="idx">#${i + 1}</span><span class="src" style="background:${SRC_COLOR[p.video]}" title="來源：${p.vname}">${SRC_LETTER[p.video]}</span><i class="h l"></i><i class="h r"></i>
        <div class="cap"><span>${p.label}</span><span class="mono">${fmt(plen(p))}</span></div>${pct ? `<span class="prog" style="width:${pct}%"></span>` : ''}</div>`;
    }).join('') + `<button class="add-slot" id="add-slot">+<br>從來源加入<br><span class="dim">Ctrl E</span></button>`;
    const sel = S.project.find((p) => p.id === S.selProj);
    $('#insp').innerHTML = sel ? `<span class="dim">#${S.project.indexOf(sel) + 1}</span><span class="stepper" data-e="start"><button aria-label="起點 -0.5 秒">−</button><span>${fmt1(sel.start)}</span><button aria-label="起點 +0.5 秒">+</button></span><span class="dim">→</span><span class="stepper" data-e="end"><button aria-label="終點 -0.5 秒">−</button><span>${fmt1(sel.end)}</span><button aria-label="終點 +0.5 秒">+</button></span>` : '';
    $$('#insp .stepper').forEach((st) => {
      const [m, p] = $$('button', st); const e = st.dataset.e;
      m.onclick = () => { snap(); sel[e] = Math.max(0, sel[e] - 0.5); renderProject(); };
      p.onclick = () => { snap(); sel[e] = Math.min(VIDEO.duration, sel[e] + 0.5); renderProject(); };
    });
    $$('.pclip', tr).forEach((el) => {
      const id = el.dataset.id, p = S.project.find((x) => x.id === id);
      $('.banner', el).src = `img/${p.banner}.jpg`;
      el.onclick = () => { S.selProj = id; S.curProj = id; S.mode = 'project'; S.t = p.start; play(false); renderStudio(); };
      el.ondragstart = (e) => e.dataTransfer.setData('text/plain', id);
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData('text/plain'); if (from === id) return;
        snap();
        const a = S.project.findIndex((x) => x.id === from), b = S.project.findIndex((x) => x.id === id);
        const [m] = S.project.splice(a, 1); S.project.splice(b, 0, m); renderProject();
      };
    });
    $('#add-slot').onclick = () => { const c = S.clips.find((x) => x.status === 'suggested'); if (c) hlAction('accept', c.id); else toast('沒有待加入的片段'); };
  }

  /* ---- 播放 ---- */
  let timer = null;
  function play(on) {
    S.playing = on === undefined ? !S.playing : on;
    clearInterval(timer);
    if (S.playing) {
      timer = setInterval(() => {
        S.t += 0.1 * S.speed;
        if (S.mode === 'project') {
          const p = S.project.find((x) => x.id === S.curProj);
          if (!p) { play(false); return; }
          if (S.t >= p.end) { const i = S.project.indexOf(p); if (i < S.project.length - 1) { S.curProj = S.project[i + 1].id; S.selProj = S.curProj; S.t = S.project[i + 1].start; renderProject(); } else play(false); }
        } else if (S.t >= VIDEO.duration) { S.t = VIDEO.duration; play(false); }
        updatePlayer();
      }, 100);
    }
    updatePlayer();
  }
  function seek(t) { S.t = Math.max(0, Math.min(VIDEO.duration, t)); S.mode = 'source'; updatePlayer(); if (S.tab === 'ev') renderAside(); }
  function updatePlayer() {
    const proj = S.mode === 'project' ? S.project.find((x) => x.id === S.curProj) : null;
    const pill = $('#mode-pill');
    pill.classList.toggle('project', !!proj);
    pill.querySelector('span').textContent = proj ? `專案預覽 · 片段 ${S.project.indexOf(proj) + 1}/${S.project.length} · ${proj.label}` : `來源 · ${VIDEO.name.match(/(\d+-\d+-\d+)-\d+\.mp4$/)[1]}`;
    const st = $('#studio'); st.classList.toggle('proj-mode', !!proj); st.classList.toggle('foreign', !!proj && proj.video !== VIDEO.id);
    const cb = $('#ctx-banner');
    cb.innerHTML = proj ? `<span>正在預覽專案片段 #${S.project.indexOf(proj) + 1}「${proj.label}」，來源影片 ${proj.vname}${proj.video !== VIDEO.id ? '（不是目前開啟的影片，來源軌與側欄暫時停用）' : ''}</span><span style="flex:1"></span><button class="btn" id="back-src">返回來源 <kbd>Esc</kbd></button>` : '';
    const bs = $('#back-src'); if (bs) bs.onclick = backToSource;
    $('#btn-quick').innerHTML = proj ? `${ic('scissors')}分割 <kbd>Ctrl Q</kbd>` : `${ic('scissors')}快速剪輯 <kbd>Ctrl Q</kbd>`;
    $('#stage-scene').className = 'scene ' + (proj ? proj.scene : S.studio === 'long' ? 's3' : 's1');
    const evs = visibleEvents().filter((e) => !e.deleted && S.t >= e.t && S.t - e.t <= 2.5 && S.filter.has(e.type));
    const b = $('#stage-banner');
    if (proj && !evs.length) { b.src = `img/${proj.banner}.jpg`; b.classList.add('show'); }
    else if (evs.length && !proj) { b.src = `img/${BANNER[evs[evs.length - 1].type]}.jpg`; b.classList.add('show'); }
    else b.classList.remove('show');
    const spec = S.mode === 'source' && SPECTATING.some((s) => S.t >= s.start && S.t <= s.end);
    $('#spec-pill').classList.toggle('hidden', !spec);
    $('#time').textContent = proj ? `${fmt(S.t - proj.start)} / ${fmt(plen(proj))}` : `${fmt(S.t)} / ${fmt(VIDEO.duration)}`;
    const cnt = visibleEvents().filter((e) => !e.deleted && isC(e) && e.t <= S.t && S.t - e.t < 90).length;
    $('#stage-counter').innerHTML = proj ? '' : (cnt ? `<span class="pill accent">近 90 秒計入 ${cnt}</span>` : '');
    $('#btn-play').innerHTML = ic(S.playing ? 'pause' : 'play');
    $('#big-play').innerHTML = ic(S.playing ? 'pause' : 'play');
    $('#btn-speed').textContent = S.speed + '×';
    $('#src-sub').textContent = fmt(VIDEO.duration);
    movePlayhead();
  }
  function backToSource() { S.mode = 'source'; play(false); renderStudio(); }
  function movePlayhead() {
    const wrap = $('#tl-wrap'), W = wrap.clientWidth, ph = $('#playhead');
    ph.style.display = S.mode === 'source' ? '' : 'none';
    const x = ((S.t - S.view.start) / S.view.span) * W;
    ph.style.transform = `translateX(${x}px)`;
    ph.style.opacity = x < 0 || x > W ? 0 : 1;
  }

  /* ---- 時間軸 canvas：依像素密度切換「密度檢視」與「圖示檢視」 ---- */
  const MIN_PX_PER_EVENT = 8; // 平均每事件 < 8px → 只畫熱度條＋刻度＋建議框
  const CLUSTER_PX = 22; // 圖示間距 < 22px → 合併為群集徽章
  function shapePath(g, type, x, y, R) {
    g.beginPath();
    if (type === 'elim') g.roundRect(x - R + 1, y - R + 1, 2 * R - 2, 2 * R - 2, 4);
    else if (type === 'assist_knock') { for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k + Math.PI / 6 * 0; g[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * (R + 1), y + Math.sin(a) * (R + 1)); } g.closePath(); }
    else if (type === 'assist_elim') { g.moveTo(x, y - R - 2); g.lineTo(x + R + 2, y); g.lineTo(x, y + R + 2); g.lineTo(x - R - 2, y); g.closePath(); }
    else if (type === 'squad_wipe') { for (let k = 0; k < 10; k++) { const a = (Math.PI / 5) * k - Math.PI / 2, r = k % 2 ? R * 0.55 : R + 2; g[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); }
    else g.arc(x, y, R, 0, Math.PI * 2);
  }
  function tlGeom() {
    const c = $('#tl'); const W = c.parentElement.clientWidth, H = c.parentElement.clientHeight;
    return { W, H, X: (t) => ((t - S.view.start) / S.view.span) * W, T: (x) => S.view.start + (x / W) * S.view.span };
  }
  function layout(ev, X, W) {
    const vis = ev.filter((e) => S.filter.has(e.type)).filter((e) => { const x = X(e.t); return x > -14 && x < W + 14; }).sort((a, b) => a.t - b.t);
    if (vis.length && W / vis.length < MIN_PX_PER_EVENT) return { mode: 'density', vis };
    const items = []; let cur = null;
    vis.forEach((e) => {
      const x = X(e.t);
      if (cur && x - cur.xEnd < CLUSTER_PX) { cur.es.push(e); cur.xEnd = x; } else { cur = { es: [e], x0: x, xEnd: x }; items.push(cur); }
    });
    items.forEach((it) => (it.x = (it.x0 + it.xEnd) / 2));
    return { mode: 'icons', items, vis };
  }
  let lastLayout = null;
  function drawTL() {
    const c = $('#tl'); if (!c || !c.parentElement.clientWidth) return;
    const { W, H, X } = tlGeom(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const v = S.view, D = VIDEO.duration;
    const BOT = H - 6, TOP = 40;
    g.font = '11px Lato, "Microsoft JhengHei UI", sans-serif'; g.textBaseline = 'top';
    // 尺標
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => v.span / s <= W / 80) || 1800;
    g.fillStyle = '#9a9a9a'; g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1;
    for (let t = Math.ceil(v.start / step) * step; t <= v.start + v.span; t += step) {
      const x = Math.round(X(t)) + 0.5;
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x, 21); g.stroke(); g.fillText(fmt(t), x + 3, 2);
    }
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, 21.5); g.lineTo(W, 21.5); g.stroke();
    // 觀戰斜線
    SPECTATING.forEach((s) => {
      const x0 = X(s.start), x1 = X(s.end); if (x1 < 0 || x0 > W) return;
      g.save(); g.beginPath(); g.rect(x0, 22, Math.max(2, x1 - x0), H - 22); g.clip();
      g.fillStyle = 'rgba(168,168,168,.14)'; g.fillRect(x0, 22, x1 - x0, H - 22);
      g.strokeStyle = 'rgba(168,168,168,.32)';
      for (let x = x0 - H; x < x1 + H; x += 8) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 22); g.stroke(); }
      g.restore();
      if (x1 - x0 > 90) { g.fillStyle = '#b6b6b6'; g.fillText('觀戰（不計入）', x0 + 4, H - 20); }
    });
    const ev = visibleEvents().filter((e) => !e.deleted);
    const L = layout(ev, X, W); lastLayout = L;
    // 熱度條（藍灰；每 ~4px 一格）
    const binPx = L.mode === 'density' ? 4 : 6, nb = Math.ceil(W / binPx), hc = new Float32Array(nb); let mx = 0;
    ev.filter(isC).forEach((e) => { const x = X(e.t); if (x < 0 || x >= W) return; const b = Math.floor(x / binPx); hc[b]++; if (hc[b] > mx) mx = hc[b]; });
    const maxH = L.mode === 'density' ? 46 : 16;
    for (let i = 0; i < nb; i++) if (hc[i]) {
      const h = 3 + (hc[i] / mx) * (maxH - 3);
      g.fillStyle = `rgba(143,163,191,${0.35 + (hc[i] / mx) * 0.55})`; g.fillRect(i * binPx, BOT - h, binPx - 1, h);
    }
    // 片段框（標籤獨立一行在框上緣）
    S.clips.filter((cl) => cl.status !== 'skipped').forEach((cl) => {
      const x0 = X(cl.start), x1 = X(cl.end); if (x1 < 0 || x0 > W) return;
      const sug = cl.status === 'suggested', hov = S.hoverClip === cl.id || S.activeHl === cl.id;
      const narrow = x1 - x0 < 12;
      g.fillStyle = narrow ? (sug ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.5)') : sug ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.16)'; g.fillRect(x0, TOP, Math.max(3, x1 - x0), BOT - TOP);
      if (!narrow) { g.strokeStyle = sug ? 'rgba(255,255,255,.85)' : '#f6f6f6'; g.lineWidth = sug ? 1.5 : 2; g.setLineDash(sug ? [5, 3] : []);
      g.strokeRect(x0 + .5, TOP + .5, Math.max(1, x1 - x0), BOT - TOP - 1); g.setLineDash([]); }
      if (hov) { g.fillStyle = '#fff'; g.fillRect(x0 - 2, TOP + 6, 6, BOT - TOP - 12); g.fillRect(x1 - 4, TOP + 6, 6, BOT - TOP - 12); }
      const lbl = (sug ? '' : '✓ ') + (cl.origin === 'ai' ? 'AI ' : '') + fmt(cl.end - cl.start);
      const lw = g.measureText(lbl).width + 8;
      if (x1 - x0 > lw - 4) { g.fillStyle = sug ? 'rgba(40,40,44,.95)' : '#f6f6f6'; g.fillRect(x0, 24, lw, 14); g.fillStyle = sug ? '#fff' : '#131313'; g.fillText(lbl, x0 + 4, 25); }
    });
    // 事件
    if (L.mode === 'density') {
      L.vis.forEach((e) => {
        const x = Math.round(X(e.t)); g.globalAlpha = isC(e) ? 1 : 0.65;
        g.fillStyle = TYPES[e.type].color; g.fillRect(x, TOP + 8, 2, 10); g.globalAlpha = 1;
      });
      g.fillStyle = '#9a9a9a'; g.fillText(`密度檢視 · ${L.vis.length} 個事件 · 放大（Ctrl +／滾輪）顯示個別圖示`, 8, 24);
    } else {
      const Y = 66, R = 10;
      L.items.forEach((it) => {
        const e = it.es[0];
        if (it.es.length === 1) {
          const T = TYPES[e.type], on = isC(e);
          g.globalAlpha = on ? 1 : 0.65;
          g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1; g.beginPath(); g.moveTo(it.x, Y + R + 2); g.lineTo(it.x, BOT - 18); g.stroke();
          shapePath(g, e.type, it.x, Y, R);
          if (on) { g.fillStyle = T.color; g.fill(); } else { g.fillStyle = T.color + '24'; g.fill(); g.strokeStyle = T.color; g.lineWidth = 2; g.stroke(); }
          g.save(); g.translate(it.x - 8, Y - 8); g.scale(16 / 24, 16 / 24); g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round';
          g.strokeStyle = on ? '#121212' : T.color; g.stroke(new Path2D(ICONS[T.glyph])); g.restore();
          g.globalAlpha = 1;
          if (Math.abs(S.t - e.t) < 0.2 || S.selected.has(e.id)) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(it.x, Y, R + 5, 0, Math.PI * 2); g.stroke(); }
        } else {
          const n = it.es.length, label = '×' + n, w = g.measureText(label).width + 16;
          g.fillStyle = '#2c2c30'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
          g.beginPath(); g.roundRect(it.x - w / 2, Y - 10, w, 20, 10); g.fill(); g.stroke();
          const sel = it.es.some((x) => S.selected.has(x.id));
          g.fillStyle = sel ? '#fff' : '#f6f6f6'; g.textBaseline = 'middle'; g.fillText(label, it.x - w / 2 + 8, Y + 1); g.textBaseline = 'top';
          // 群集內計入比例小點
          const cnt = it.es.filter(isC).length;
          g.fillStyle = '#9a9a9a'; g.fillRect(it.x - w / 2 + 4, Y + 14, (w - 8) * (cnt / n), 2);
        }
      });
    }
    movePlayhead();
  }
  function hitTL(mx, my) {
    const L = lastLayout; if (!L || my < TOP_Y || my > 100) return null;
    if (L.mode === 'density') return { density: true, t: tlGeom().T(mx) };
    let best = null, bd = 13;
    L.items.forEach((it) => { const d = Math.abs(it.x - mx); if (d < bd) { bd = d; best = it; } });
    return best;
  }
  const TOP_Y = 28;
  function setupTL() {
    const wrap = $('#tl-wrap'), tip = $('#tl-tip'), box = $('#boxsel');
    const edgeAt = (mx, my) => {
      if (my < 38 || my > wrap.clientHeight - 4) return null;
      const { X } = tlGeom();
      for (const c of S.clips) {
        if (c.status === 'skipped') continue;
        if (Math.abs(X(c.start) - mx) < 7) return { c, e: 'start' };
        if (Math.abs(X(c.end) - mx) < 7) return { c, e: 'end' };
      }
      return null;
    };
    const clipAt = (mx, my) => { const { X } = tlGeom(); return my > 38 ? S.clips.find((c) => c.status !== 'skipped' && mx >= X(c.start) - 7 && mx <= X(c.end) + 7) : null; };
    let down = null, edge = null, pan = null;
    wrap.addEventListener('mousedown', (ev) => {
      wrap.focus(); S.zone = 'src';
      const r = wrap.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      if (ev.button === 1 || S.space) { ev.preventDefault(); pan = { x0: ev.clientX, s0: S.view.start }; wrap.style.cursor = 'grabbing'; return; }
      const ed = edgeAt(mx, my); if (ed) { edge = ed; return; }
      down = { x: mx, y: my, t0: tlGeom().T(mx), moved: false, shift: ev.shiftKey || ev.ctrlKey };
    });
    window.addEventListener('mousemove', (ev) => {
      const r = wrap.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, G = tlGeom();
      if (pan) { const dt = ((pan.x0 - ev.clientX) / G.W) * S.view.span; S.view = { ...S.view, start: Math.max(0, Math.min(VIDEO.duration - S.view.span, pan.s0 + dt)) }; drawTL(); return; }
      if (edge) { edge.c[edge.e] = Math.max(0, Math.min(VIDEO.duration, G.T(mx))); drawTL(); renderAside(); return; }
      if (down) {
        if (Math.abs(mx - down.x) > 4) down.moved = true;
        if (down.moved) { box.style.display = 'block'; box.style.left = Math.min(down.x, mx) + 'px'; box.style.width = Math.abs(mx - down.x) + 'px'; }
        return;
      }
      if (ev.target.closest && ev.target.closest('#tl-wrap')) {
        const h = hitTL(mx, my), ed = edgeAt(mx, my), cl = clipAt(mx, my);
        const hid = cl ? cl.id : null; if (hid !== S.hoverClip) { S.hoverClip = hid; drawTL(); }
        wrap.style.cursor = S.space ? 'grab' : ed ? 'ew-resize' : 'pointer';
        let html = '';
        if (h && h.density) { const t = h.t; const near = lastLayout.vis.filter((e) => Math.abs(G.X(e.t) - mx) < 6); html = near.length ? `${near.length} 個事件 · ${fmt(near[0].t)}（計入 ${near.filter(isC).length}）` : ''; }
        else if (h && h.es.length === 1) { const e = h.es[0]; html = `${TYPES[e.type].label} · ${fmt(e.t)} · ${isC(e) ? '計入' : '不計入（' + (e.ov === false ? '強制' : REASONS[e.reason]) + '）'}`; }
        else if (h) html = `${h.es.length} 個事件 · ${fmt(h.es[0].t)}–${fmt(h.es[h.es.length - 1].t)} · 點擊放大`;
        if (html) { tip.style.display = 'block'; tip.style.left = Math.min(mx + 10, G.W - 260) + 'px'; tip.style.top = Math.max(my - 34, 24) + 'px'; tip.textContent = html; } else tip.style.display = 'none';
      } else tip.style.display = 'none';
    });
    window.addEventListener('mouseup', (ev) => {
      const r = wrap.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, G = tlGeom();
      if (pan) { pan = null; wrap.style.cursor = 'pointer'; return; }
      if (edge) { toast('片段範圍已調整', '復原', () => {}); edge = null; return; }
      if (!down) return;
      const d = down; down = null; box.style.display = 'none';
      if (d.moved) {
        const t1 = Math.min(d.t0, G.T(mx)), t2 = Math.max(d.t0, G.T(mx));
        const ids = visibleEvents().filter((e) => !e.deleted && S.filter.has(e.type) && e.t >= t1 && e.t <= t2).map((e) => e.id);
        if (!d.shift) S.selected.clear();
        ids.forEach((id) => S.selected.add(id));
        S.tab = 'ev'; renderAside(); drawTL();
        toast(`框選了 ${ids.length} 個事件（${fmt(t1)}–${fmt(t2)}）`, '建立合輯', createSupercut);
        return;
      }
      const h = hitTL(d.x, d.y);
      if (h && !h.density && h.es.length === 1) {
        const e = h.es[0];
        if (d.shift) { S.selected.has(e.id) ? S.selected.delete(e.id) : S.selected.add(e.id); renderAside(); drawTL(); }
        else seek(Math.max(0, e.t - 8));
      } else if (h && !h.density) {
        const a = h.es[0].t, b = h.es[h.es.length - 1].t, span = Math.max(20, (b - a) * 3);
        S.view = { span: Math.min(VIDEO.duration, span), start: Math.max(0, Math.min(VIDEO.duration - span, (a + b) / 2 - span / 2)) }; drawTL();
      } else seek(G.T(d.x));
    });
    wrap.addEventListener('wheel', (ev) => {
      const r = wrap.getBoundingClientRect(), G = tlGeom();
      if (ev.ctrlKey) { ev.preventDefault(); zoom(ev.deltaY < 0 ? 0.7 : 1.4, G.T(ev.clientX - r.left)); }
      else if (S.view.span < VIDEO.duration) { ev.preventDefault(); const dt = (ev.deltaY / 100) * S.view.span * 0.15; S.view = { ...S.view, start: Math.max(0, Math.min(VIDEO.duration - S.view.span, S.view.start + dt)) }; drawTL(); }
    }, { passive: false });
    $('#z-in').onclick = () => zoom(0.6, S.t);
    $('#z-out').onclick = () => zoom(1.6, S.t);
    $('#z-reset').onclick = () => zoom(0, 0);
    new ResizeObserver(() => drawTL()).observe(wrap);
  }
  function zoom(f, anchor) {
    const v = S.view, D = VIDEO.duration;
    if (!f) S.view = { start: 0, span: D };
    else {
      const span = Math.min(D, Math.max(10, v.span * f)), frac = (anchor - v.start) / v.span;
      S.view = { span, start: Math.max(0, Math.min(D - span, anchor - frac * span)) };
    }
    $('#z-reset').textContent = (D / S.view.span).toFixed(S.view.span === D ? 0 : 1) + '×';
    drawTL();
  }

  /* ---------------- 浮層 ---------------- */
  function togglePop(id) {
    const p = $('#' + id), show = !p.classList.contains('show');
    closePops(); p.classList.toggle('show', show);
    if (id === 'pop-ac' && show) updateAcPrev();
  }
  function updateAcPrev() {
    const r = autoclip(S.events, S.ac, VIDEO.duration);
    const total = r.reduce((a, c) => a + c.end - c.start, 0);
    $('#ac-prev').innerHTML = `${ic('sparkles')}預計產生 <span style="color:#fff;font-size:16px">${r.length}</span> 段 · 共 ${fmt(total)}`;
  }
  function wireAc() {
    [['n', 'ac-n'], ['gap', 'ac-gap'], ['before', 'ac-before'], ['after', 'ac-after'], ['max', 'ac-max']].forEach(([k, id]) => {
      const num = $('#' + id), rng = $('#' + id + '-r');
      const set = (val) => { S.ac[k] = Number(val); num.value = val; rng.value = val; updateAcPrev(); };
      num.oninput = () => set(num.value); rng.oninput = () => set(rng.value);
    });
    $('#ac-reset').onclick = () => { S.ac = { n: 3, gap: 20, before: 8, after: 4, max: 90 }; Object.entries({ n: 'ac-n', gap: 'ac-gap', before: 'ac-before', after: 'ac-after', max: 'ac-max' }).forEach(([k, id]) => { $('#' + id).value = S.ac[k]; $('#' + id + '-r').value = S.ac[k]; }); updateAcPrev(); };
    $('#ac-apply').onclick = () => { regenSuggestions(); closePops(); S.tab = 'hl'; renderStudio(); toast(`已放上 ${S.clips.filter((c) => c.status === 'suggested').length} 段 AI 建議`); };
  }
  function openDlg(id) { $('#' + id).classList.add('show'); }
  function closeDlg() { $$('.scrim').forEach((s) => s.classList.remove('show')); }
  function openAddEvent() {
    $('#addev-t').textContent = fmt(S.t);
    $('#addev-list').innerHTML = Object.keys(TYPES).map((k, i) => `<label><input type="radio" name="evt" value="${k}" ${i === 0 ? 'checked' : ''}>${evt(k)}<b>${TYPES[k].label}</b></label>`).join('');
    openDlg('dlg-addev');
  }

  /* ---- 匯出抽屜（與側欄同寬，只覆蓋側欄；頂欄、播放器、時間軸與專案軌保持可見） ---- */
  function renderExport() {
    const total = S.project.reduce((a, p) => a + plen(p), 0), body = $('#dr-body'), foot = $('#dr-foot');
    const st = S.export;
    if (st === 'config') {
      body.innerHTML = `<div class="stat-row"><div class="stat"><b>${S.project.length}</b><span>片段</span></div><div class="stat"><b>${fmt(total)}</b><span>總長度</span></div><div class="stat"><b>${new Set(S.project.map((p) => p.video)).size}</b><span>來源影片</span></div></div>
      <div class="notice warn" style="margin:0">${ic('warn')}<div class="grow">來源參數不一致（B 影片為 1728×1080、60fps），無法無損串接，已自動改用「精準重新編碼」。</div></div>
      <div class="sec"><h4>匯出模式</h4><label class="opt on"><input type="radio" name="m" checked><div><b>串成一支合輯</b><small>依專案順序合併成單一檔案</small></div></label><label class="opt"><input type="radio" name="m"><div><b>每段各一檔</b><small>產生 ${S.project.length} 個檔案，檔名加上序號</small></div></label></div>
      <div class="sec"><h4>品質</h4><label class="opt"><input type="radio" name="q" disabled><div><b>快速無損 <span class="pill">不可用</span></b><small>從關鍵影格切，片段起點平均多出約 0.5 秒。來源參數不一致時停用。</small></div></label><label class="opt on"><input type="radio" name="q" checked><div><b>精準重新編碼</b><small>起訖點精準到畫格；速度取決於編碼器</small></div></label>
      <div style="margin-top:8px"><select class="select" aria-label="編碼器"><option>NVIDIA NVENC（偵測到）</option><option>OpenH264（CPU，畫質較低）</option></select></div>
      <div class="dim" style="margin-top:6px;font-size:12px">沒有硬體編碼器時會詢問是否下載 Cisco OpenH264。 <button class="btn ghost sm" id="dr-h264" style="height:24px;padding:0 6px">預覽同意流程</button></div></div>
      <div class="sec"><h4>輸出</h4><div style="display:flex;gap:6px;margin-bottom:6px"><input class="textin" value="D:\\Videos\\Apex" readonly aria-label="輸出資料夾"><button class="btn">瀏覽</button></div><input class="textin" value="我的精華專案" aria-label="檔名"><div class="dim" style="margin-top:6px;font-size:12px">預估 ${Math.round(total * 1.6)} MB · D: 可用 212 GB</div></div>`;
      foot.innerHTML = `<button class="btn" id="dr-cancel">取消</button><span class="grow"></span><button class="btn primary" id="dr-go">${ic('export')}開始匯出</button>`;
    } else if (st === 'run') {
      body.innerHTML = `<div class="sec"><h4>匯出中</h4><div style="font-family:var(--font-display);font-size:32px;font-weight:900">47%</div><div class="big-progress" style="margin:10px 0"><i style="width:47%"></i></div><div class="muted">處理片段 2/${S.project.length}（12.4 秒）· NVENC</div></div><div class="dim">編輯區已鎖定，避免匯出中修改專案。可隨時取消；取消會刪除未完成的檔案，已完成的檔案保留。</div>`;
      foot.innerHTML = `<span class="grow"></span><button class="btn danger" id="dr-cancel">取消匯出</button>`;
    } else if (st === 'done') {
      body.innerHTML = `<div style="text-align:center;padding:20px 0"><div style="color:var(--success)">${ic('check', 'lg').replace('class="ic lg"', 'class="ic lg" style="width:48px;height:48px"')}</div><h3 style="font-family:var(--font-display);margin:10px 0 2px">匯出完成</h3><div class="muted">共 ${fmt(total)}　·　耗時 38 秒</div></div><div class="sec"><h4>輸出檔案</h4><div class="codebox">D:\\Videos\\Apex\\我的精華專案.mp4</div></div><div class="notice info" style="margin:0">${ic('sparkles')}<div class="grow">已自動改用精準重新編碼（來源參數不一致）。</div></div>`;
      foot.innerHTML = `<button class="btn">${ic('folder')}開啟資料夾</button><span class="grow"></span><button class="btn primary" id="dr-cancel">完成</button>`;
    } else {
      body.innerHTML = `<div class="notice err" style="margin:0">${ic('warn')}<div class="grow"><b>匯出失敗</b>　ffmpeg 結束代碼 1。未完成的檔案已清除，已完成的檔案仍保留。</div></div><div class="sec"><h4>ffmpeg 錯誤摘要</h4><div class="codebox">[libopenh264 @ 0000020a] Incorrect library version loaded
Error initializing output stream 0:0 --
Conversion failed!</div></div><div class="dim">常見原因：磁碟空間不足、輸出檔被其他程式占用、編碼器不可用。</div>`;
      foot.innerHTML = `<button class="btn" id="dr-copy">複製錯誤訊息</button><span class="grow"></span><button class="btn" id="dr-cancel">關閉</button><button class="btn primary" id="dr-go">重試</button>`;
    }
    const c = $('#dr-cancel'); if (c) c.onclick = () => $('#drawer').classList.remove('show');
    const go1 = $('#dr-go'); if (go1) go1.onclick = () => { S.export = 'run'; renderExport(); };
    const h = $('#dr-h264'); if (h) h.onclick = () => openDlg('dlg-h264');
    hydrate($('#drawer'));
  }
  function openExport(state) { S.export = state || 'config'; renderExport(); $('#drawer').classList.add('show'); }

  /* ---- 快捷鍵清單（與 spec §3.2.7 矩陣一致） ---- */
  const KEYS = [
    ['播放與瀏覽（全域）', [['播放／暫停（焦點在按鈕時為原生行為）', 'Space'], ['切換速度', 'S'], ['上一個／下一個事件', 'Ctrl ← / →'], ['前後快轉 5 秒', '← / →', 1], ['縮放時間軸', 'Ctrl + / − / 0'], ['顯示／隱藏側欄', 'Ctrl B', 1]]],
    ['剪輯', [['快速剪輯（來源）／分割（專案）', 'Ctrl Q'], ['新增事件', 'M'], ['起點／終點設為播放頭', '[ / ]', 1], ['選取事件建立合輯', 'Ctrl M', 1], ['加入專案（全部建議）', 'Ctrl E'], ['返回來源模式', 'Esc', 1]]],
    ['依焦點區（精華清單／事件清單／專案軌）', [['加入目前建議（精華清單）', 'Enter', 1], ['略過建議／刪除選取事件／刪除專案片段', 'Delete', 1], ['移動專案片段', 'Alt ← / →', 1], ['複製專案片段', 'Ctrl D', 1], ['時間軸：平移', 'Space＋拖曳 / 中鍵', 1], ['時間軸：框選事件', '拖曳空白', 1], ['時間軸：加選事件', 'Shift＋點擊', 1]]],
    ['專案與通用', [['復原／重做', 'Ctrl Z / Y 或 Ctrl Shift Z'], ['另存專案檔', 'Ctrl S', 1], ['匯出', 'Ctrl Shift E', 1], ['影片庫搜尋／收藏', 'Ctrl F / Ctrl D'], ['快捷鍵說明', '?', 1]]]
  ];
  function renderKeys() {
    $('#sc-grid').innerHTML = KEYS.map(([h, rows]) => `<h4>${h}</h4>` + rows.map(([a, k, n]) => `<div><span>${a}${n ? '<span class="newtag">新</span>' : ''}</span><kbd>${k}</kbd></div>`).join('')).join('');
  }

  /* ---------------- 設定 ---------------- */
  function setupSettings() {
    const cats = $$('.set-cat'), cards = $$('.setcard[data-cat]'), q = $('#set-search');
    let cur = 'a';
    const sel = (k, focus) => { cur = k; q.value = ''; apply(); if (focus) cats.find((b) => b.dataset.cat === k).focus(); };
    function apply() {
      const t = q.value.trim().toLowerCase(); let any = false;
      cats.forEach((b) => { const h = b.querySelector('.cnt-hit'); if (h) h.remove(); });
      const hits = {};
      cards.forEach((c) => {
        let hit = 0;
        $$('.setrow', c).forEach((r) => { const m = !t || r.textContent.toLowerCase().includes(t) || c.querySelector('h3').textContent.toLowerCase().includes(t); r.classList.toggle('hide', !m); if (m) hit++; });
        const show = t ? hit > 0 : c.dataset.cat === cur;
        c.classList.toggle('hide', !show); if (show) any = true;
        hits[c.dataset.cat] = (hits[c.dataset.cat] || 0) + hit;
      });
      if (t) cats.forEach((b) => { if (hits[b.dataset.cat]) b.insertAdjacentHTML('beforeend', `<span class="cnt-hit">${hits[b.dataset.cat]}</span>`); });
      cats.forEach((b) => { const on = !t && b.dataset.cat === cur; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); b.tabIndex = on || (t && b === cats[0]) ? 0 : -1; });
      $('#set-none').classList.toggle('hidden', any);
    }
    cats.forEach((b, i) => {
      b.onclick = () => sel(b.dataset.cat);
      b.onkeydown = (e) => { const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0; if (d) { e.preventDefault(); sel(cats[(i + d + cats.length) % cats.length].dataset.cat, true); } };
    });
    q.oninput = apply;
    const m = /settings-(\w+)/.exec(location.hash); if (m) cur = m[1];
    apply();
  }

  /* ---------------- 全域事件 ---------------- */
  function newProject() {
    if (!S.project.length) return;
    $('#np-n').textContent = S.project.length; openDlg('dlg-newproj');
  }
  function wire() {
    $$('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    $$('[data-close]').forEach((b) => (b.onclick = () => $('#' + b.dataset.close).classList.remove('show')));
    $$('[data-lf]').forEach((b) => (b.onclick = () => { S.libFilter = b.dataset.lf; $$('[data-lf]').forEach((x) => x.classList.toggle('on', x === b)); renderLibrary(); }));
    $('#lib-search').oninput = renderLibrary;
    $$('.tab').forEach((t) => (t.onclick = () => { S.tab = t.dataset.tab; renderAside(); }));
    $('#btn-play').onclick = () => play();
    $('#big-play').onclick = () => play();
    $('#stage').onclick = (e) => { if (!e.target.closest('button')) play(); };
    $('#btn-speed').onclick = () => { const l = [1, 0.5, 0.25, 2]; S.speed = l[(l.indexOf(S.speed) + 1) % 4]; updatePlayer(); };
    $('#btn-prev').onclick = () => jump(-1); $('#btn-next').onclick = () => jump(1);
    $('#btn-ac').onclick = (e) => { e.stopPropagation(); togglePop('pop-ac'); };
    $('#pop-ac').onclick = (e) => e.stopPropagation();
    $('#btn-quick').onclick = quickOrSplit;
    $('#btn-export').onclick = () => openExport('config');
    $('#dr-close').onclick = () => $('#drawer').classList.remove('show');
    $('#btn-aside').onclick = () => { S.asideOpen = !S.asideOpen; $('#studio').classList.toggle('no-aside', !S.asideOpen); setTimeout(drawTL, 300); };
    $('#btn-addev').onclick = openAddEvent;
    $('#addev-ok').onclick = () => {
      const type = ($('input[name=evt]:checked') || {}).value || 'knock';
      S.events.push({ id: 'm' + Date.now(), t: S.t, type, score: 1, counted: true, reason: 'manual', ov: null, src: 'manual' });
      S.events.sort((a, b) => a.t - b.t); closeDlg(); renderStudio(); toast(`已於 ${fmt(S.t)} 新增「${TYPES[type].label}」`);
    };
    $('#rail-queue').onclick = (e) => { e.stopPropagation(); togglePop('qpop'); };
    $('#queue-strip').onclick = (e) => { e.stopPropagation(); togglePop('qpop'); };
    $('#qpop').onclick = (e) => e.stopPropagation();
    $('#rail-kbd').onclick = () => openDlg('dlg-kbd');
    $('#p-split').onclick = splitProject; $('#p-dup').onclick = dupProject; $('#p-del').onclick = delProject;
    $('#p-undo').onclick = undo; $('#p-redo').onclick = redo;
    $('#p-fold').onclick = () => { S.projCollapsed = !S.projCollapsed; renderStudio(); };
    $('#p-new').onclick = newProject;
    $('#np-ok').onclick = () => { S.project = []; hist = []; redoS = []; S.selProj = null; closeDlg(); renderStudio(); toast('已建立新專案；舊專案已自動儲存，可從「開啟檔案」或專案清單找回'); };
    $('#np-save').onclick = () => { closeDlg(); toast('已另存為 我的精華專案.aditorproj.json'); };
    $('#p-save').onclick = () => toast('已另存為 我的精華專案.aditorproj.json（專案本身已自動儲存）');
    $('#p-open').onclick = () => toast('（示意）開啟 .aditorproj.json 檔案選擇器');
    document.addEventListener('click', () => closePops());
    $('#btn-import').onclick = () => toast('（示意）開啟檔案選擇器');
    $('#mb-tog').onclick = () => $('#mockbar').classList.toggle('min');
    $$('[data-mock]').forEach((b) => (b.onclick = () => applyMock(b.dataset.mock)));
    let dc = 0;
    $('#lib-body').addEventListener('dragenter', () => { dc++; $('#drop-ov').classList.add('show'); });
    $('#lib-body').addEventListener('dragleave', () => { if (--dc <= 0) $('#drop-ov').classList.remove('show'); });
    $('#lib-body').addEventListener('dragover', (e) => e.preventDefault());
    $('#lib-body').addEventListener('drop', (e) => { e.preventDefault(); dc = 0; $('#drop-ov').classList.remove('show'); toast('已加入影片庫並排入分析（示意）'); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') S.space = false; });
    document.addEventListener('mousedown', (e) => { const z = zoneOf(e.target); if (z) S.zone = z; });
  }
  function zoneOf(el) {
    if (!el || !el.closest) return null;
    if (el.closest('#tl-wrap')) return 'src';
    if (el.closest('#tab-body')) return S.tab === 'hl' ? 'hl' : 'ev';
    if (el.closest('#track') || el.closest('.plane-head')) return 'proj';
    return null;
  }
  function jump(d) {
    const evs = visibleEvents().filter((e) => !e.deleted && S.filter.has(e.type)).sort((a, b) => a.t - b.t);
    const n = d > 0 ? evs.find((e) => e.t > S.t + 8.1) : evs.slice().reverse().find((e) => e.t < S.t + 7.9);
    if (n) seek(Math.max(0, n.t - 8));
  }
  function quickOrSplit() { S.mode === 'project' ? splitProject() : quickClip(); }
  function quickClip() {
    const c = { id: 'q' + Date.now(), start: Math.max(0, S.t - 8), end: Math.min(VIDEO.duration, S.t + 4), ids: [], origin: 'manual', status: 'accepted' };
    S.clips.push(c); S.clips.sort((a, b) => a.start - b.start); addToProject(c); renderStudio();
    toast(`已建立快速剪輯 ${fmt(c.start)}–${fmt(c.end)} 並加入專案`, '復原', () => { S.clips = S.clips.filter((x) => x !== c); S.project = S.project.filter((p) => !(p.start === c.start && p.video === VIDEO.id)); renderStudio(); });
  }
  function splitProject() {
    const p = S.project.find((x) => x.id === S.curProj);
    if (!p || S.mode !== 'project' || S.t <= p.start + 0.5 || S.t >= p.end - 0.5) { toast('請先在專案軌選取片段，並把播放頭移到片段內部'); return; }
    snap(); const i = S.project.indexOf(p);
    S.project.splice(i, 1, { ...p, end: S.t, id: p.id + 'a' }, { ...p, start: S.t, id: p.id + 'b' }); S.curProj = p.id + 'b'; S.selProj = p.id + 'b'; renderProject();
  }
  function dupProject() { const p = S.project.find((x) => x.id === S.selProj); if (!p) return; snap(); S.project.splice(S.project.indexOf(p) + 1, 0, { ...p, id: p.id + 'c' + Date.now() }); renderProject(); }
  function delProject() {
    const p = S.project.find((x) => x.id === S.selProj); if (!p) return;
    snap(); S.project = S.project.filter((x) => x !== p); S.selProj = null; renderStudio();
    toast('已刪除專案片段', '復原', undo);
  }
  function undo() { if (!hist.length) return; redoS.push(JSON.stringify(S.project)); S.project = JSON.parse(hist.pop()); renderStudio(); markSaved(); }
  function redo() { if (!redoS.length) return; hist.push(JSON.stringify(S.project)); S.project = JSON.parse(redoS.pop()); renderStudio(); markSaved(); }
  function setEdge(which) {
    const cl = S.clips.find((c) => c.id === S.activeHl) || S.clips.find((c) => c.status !== 'skipped' && S.t >= c.start && S.t <= c.end);
    if (!cl) { toast('播放頭不在任何片段內'); return; }
    if (which === 'start' && S.t < cl.end - 1) cl.start = S.t; if (which === 'end' && S.t > cl.start + 1) cl.end = S.t;
    renderAside(); drawTL(); toast(`已將${which === 'start' ? '起點' : '終點'}設為 ${fmt(S.t)}`);
  }
  /* 鍵 × 聚焦區：見 spec §3.2.7 矩陣 */
  function onKey(e) {
    const tag = (e.target.tagName || '').toUpperCase();
    const native = ['BUTTON', 'SELECT', 'TEXTAREA', 'A'].includes(tag) || (tag === 'INPUT');
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { if (S.mode === 'project' && !$$('.scrim.show').length) backToSource(); closeDlg(); closePops(); $('#drawer').classList.remove('show'); return; }
    if (tag === 'INPUT' && !ctrl) return;
    if (e.key === '?' && !native) { openDlg('dlg-kbd'); return; }
    if (S.screen === 'library') { if (ctrl && k === 'f') { e.preventDefault(); $('#lib-search').focus(); } if (ctrl && k === 'd') { e.preventDefault(); $('[data-lf=fav]').click(); } return; }
    if (S.screen === 'settings') { if (ctrl && k === 'f') { e.preventDefault(); $('#set-search').focus(); } return; }
    if (S.screen !== 'studio') return;
    const zone = zoneOf(document.activeElement) || S.zone;
    // 先處理含修飾鍵的組合（Shift 組合必須在無 Shift 之前）
    if (ctrl && e.shiftKey && k === 'e') { e.preventDefault(); openExport('config'); return; }
    if (ctrl && e.shiftKey && k === 'z') { e.preventDefault(); redo(); return; }
    if (ctrl && k === 'z') { e.preventDefault(); undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && k === 's') { e.preventDefault(); $('#p-save').click(); return; }
    if (ctrl && k === 'q') { e.preventDefault(); quickOrSplit(); return; }
    if (ctrl && k === 'e') { e.preventDefault(); acceptAll(); return; }
    if (ctrl && k === 'm') { e.preventDefault(); createSupercut(); return; }
    if (ctrl && k === 'b') { e.preventDefault(); $('#btn-aside').click(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); if (zone === 'proj' || S.selProj) dupProject(); return; }
    if (ctrl && e.key === 'ArrowLeft') { e.preventDefault(); jump(-1); return; }
    if (ctrl && e.key === 'ArrowRight') { e.preventDefault(); jump(1); return; }
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(0.6, S.t); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); zoom(1.6, S.t); return; }
    if (ctrl && e.key === '0') { e.preventDefault(); zoom(0, 0); return; }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const i = S.project.findIndex((p) => p.id === S.selProj), j = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (i >= 0 && j >= 0 && j < S.project.length) { e.preventDefault(); snap(); const [m] = S.project.splice(i, 1); S.project.splice(j, 0, m); renderProject(); }
      return;
    }
    if (native) return; // 按鈕／下拉／數字框保留原生 Enter、Space、方向鍵、Delete 語意
    if (e.code === 'Space') { e.preventDefault(); S.space = true; if (!e.repeat) play(); return; }
    if (!ctrl && k === 's') { $('#btn-speed').click(); return; }
    if (!ctrl && k === 'm') { openAddEvent(); return; }
    if (e.key === '[') { setEdge('start'); return; }
    if (e.key === ']') { setEdge('end'); return; }
    if (e.key === 'ArrowLeft') { seek(S.t - 5); return; }
    if (e.key === 'ArrowRight') { seek(S.t + 5); return; }
    if (e.key === 'Enter') {
      if (zone === 'hl') { e.preventDefault(); const c = S.clips.find((x) => x.id === S.activeHl && x.status === 'suggested') || S.clips.find((x) => x.status === 'suggested'); if (c) hlAction('accept', c.id); }
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (zone === 'hl') { const c = S.clips.find((x) => x.id === S.activeHl && x.status === 'suggested') || S.clips.find((x) => x.status === 'suggested'); if (c) hlAction('skip', c.id); }
      else if (zone === 'ev') deleteEvents([...S.selected]);
      else if (zone === 'proj') delProject();
      return;
    }
  }

  /* ---------------- Mock 狀態切換 / hash ---------------- */
  function applyMock(k) {
    closeDlg(); $('#drawer').classList.remove('show'); $('#drop-ov').classList.remove('show');
    if (k.startsWith('lib')) { S.libEmpty = k === 'lib-empty'; go('library'); renderLibrary(); if (k === 'lib-drag') $('#drop-ov').classList.add('show'); }
    else if (k.startsWith('st')) { S.studio = { 'st-ready': 'ready', 'st-long': 'long', 'st-error': 'error', 'st-proxy': 'proxy' }[k]; go('studio'); applyStudioState(); }
    else if (k.startsWith('ex')) { if (S.screen !== 'studio') { S.studio = 'ready'; go('studio'); applyStudioState(); } openExport({ 'ex-config': 'config', 'ex-run': 'run', 'ex-done': 'done', 'ex-err': 'err' }[k]); }
  }
  function boot() {
    setupSettings(); hydrate(); renderKeys(); wireAc(); setupTL(); wire();
    if (/[?&]shot/.test(location.search)) $('#mockbar').classList.add('hidden');
    $('#qlist').innerHTML = QUEUE.map((q) => `<div class="qrow"><div style="min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700">${q.name}</div><div class="dim" style="font-size:12px">${q.state}${q.eta ? ' · ' + q.eta : ''}</div></div><button class="btn sm ghost">取消</button>${q.p ? `<div class="bar"><i style="width:${q.p * 100}%"></i></div>` : ''}</div>`).join('');
    renderLibrary();
    const h = (location.hash || '').replace('#', '');
    const map = { library: 'lib-full', 'library-empty': 'lib-empty', 'library-drag': 'lib-drag', studio: 'st-ready', 'studio-long': 'st-long', 'studio-error': 'st-error', 'studio-proxy': 'st-proxy', export: 'ex-config', 'export-run': 'ex-run', 'export-done': 'ex-done', 'export-err': 'ex-err' };
    if (h.startsWith('settings')) go('settings');
    else if (h === 'autoclip') { applyMock('st-ready'); setTimeout(() => togglePop('pop-ac'), 0); }
    else if (h === 'events') { applyMock('st-ready'); S.tab = 'ev'; seek(332); renderAside(); }
    else if (h === 'zoomed') { applyMock('st-long'); zoom(0.04, 1850); }
    else if (h === 'project-mode') { applyMock('st-ready'); S.mode = 'project'; S.curProj = 'p2'; S.selProj = 'p2'; S.t = 140; renderStudio(); }
    else if (h === 'shortcuts') openDlg('dlg-kbd');
    else if (h === 'queue') setTimeout(() => togglePop('qpop'), 0);
    else if (map[h]) applyMock(map[h]);
  }
  boot();
})();
