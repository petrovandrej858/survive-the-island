/* Survive the Island — game layer (Supabase).
   Admin cheat sheet (Supabase → Table Editor):
   - settings.entry_code : the secret word you show in the latest Reel (players need it to join)
   - settings.followers  : your follower count → unlocks island areas shown in the game
   - codes               : add a row (code, energy, wood, stone, fish, expires_at) for each Story bonus
   - goals               : island-wide event; set active=false on the old one and add a new row
   - players             : if someone loses access, copy their token and send them
                           https://survive-theisland.netlify.app/?t=TOKEN                          */
(function () {
  const SB_URL = 'https://hrsygmwhwwrcfqrqemep.supabase.co';
  const SB_KEY = 'sb_publishable_TAEZAhI9skSMYLb6Z3bkBw_LVpffMzE';
  const HANDLE = '@survive_theisland';
  const UNLOCKS = [
    { f: 500, name: 'Hidden cave' },
    { f: 1000, name: 'Volcano summit' },
    { f: 2500, name: 'Pirate shipwreck' },
    { f: 5000, name: 'A second island' }
  ];
  const LV = [null,
    { name: 'Straw hut' },
    { name: 'Wooden hut', c: '#a0522d', x: ['fire'] },
    { name: 'Stone house', c: '#9aa1a6', roof: '#6c757d', x: ['fire', 'chest'] },
    { name: 'Stone tower', c: '#9aa1a6', roof: '#6c757d', x: ['tower', 'flag', 'chest'] },
    { name: 'Fortress', c: '#6c757d', roof: '#343a40', x: ['tower', 'flag', 'watchtower', 'shield'] }];
  const COST = [null, { w: 10, s: 0, f: 0 }, { w: 20, s: 10, f: 0 }, { w: 35, s: 25, f: 10 }, { w: 60, s: 45, f: 25 }];
  const TASKS = [
    { id: 'chop', icon: '🪓', name: 'Chop wood', hint: '+2–4 wood' },
    { id: 'fish', icon: '🎣', name: 'Go fishing', hint: '+1–3 fish' },
    { id: 'mine', icon: '⛏️', name: 'Mine stone', hint: '+1–2 stone' },
    { id: 'explore', icon: '🧭', name: 'Explore', hint: 'Could be treasure…' }];
  const SWATCH = {
    shirt: ['#f1faee', '#ff6b4a', '#2a9d8f', '#ffd166', '#9b5de5', '#16292f'],
    skin: ['#f6d5b8', '#e0a87a', '#c68642', '#8d5524', '#5c3a21'],
    hat: ['#e3b55b', '#e63946', '#3a86ff', '#2b2d42', '#06d6a0'],
    pants: ['#355070', '#6b4a2b', '#2b2d42', '#8d99ae', '#7f5539']
  };
  const ERR = {
    BAD_CODE: 'Wrong code. Watch the latest Reel on ' + HANDLE + ' to find it 👀',
    TAKEN: 'That username already has a survivor. If it’s you, DM ' + HANDLE + ' to get your link back.',
    BAD_NAME: 'Type your Instagram username (letters, numbers, . and _ only).',
    NO_ENERGY: 'Out of energy! It refills tomorrow, or find a bonus code in our Story.',
    NOT_ENOUGH: 'Not enough resources yet.',
    USED: 'You already used that code.',
    MAX_LEVEL: 'Your hut is already a fortress!',
    NO_GOAL: 'No island event right now.'
  };

  // ---------- storage + URL params ----------
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch (e) { } }
  };
  const qs = new URLSearchParams(location.search);
  if (qs.get('t')) store.set('sti_token', qs.get('t'));
  if (qs.get('ref')) store.set('sti_ref', qs.get('ref').replace(/^@/, '').toLowerCase());
  if (qs.get('t') || qs.get('ref')) history.replaceState(null, '', location.pathname);

  let TOKEN = store.get('sti_token');
  let ME = null, STATE = null, PLAYERS = [];
  let draftLook = { shirt: '#ff6b4a', skin: '#e0a87a', hat: '#e3b55b', pants: '#355070' };

  // ---------- Supabase ----------
  const H = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  async function rpc(fn, args) {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j && j.message) || 'ERROR'); e.code = e.message; throw e }
    return j;
  }
  const errText = e => ERR[e.code] || (e.code === 'NOT_FOUND' ? 'Your survivor was not found on this device.' : 'Something went wrong. Try again.');

  // ---------- merge game players into the island before it is built ----------
  function levelize(p) {
    if (!p._base) p._base = { x: (p.x || []).slice(), c: p.c, roof: p.roof, flag: p.flag };
    const L = LV[Math.min(5, Math.max(1, p.lvl || 1))];
    const b = p._base;
    p.c = p.lvl > 1 ? L.c : b.c;
    p.roof = p.lvl > 1 ? L.roof || b.roof : b.roof;
    p.flag = b.flag || (p.look && p.look.shirt) || undefined;
    const xs = b.x.slice();
    (L.x || []).forEach(e => { if (!xs.includes(e)) xs.push(e) });
    xs.unshift('Lv ' + p.lvl + ' · ' + L.name);
    p.x = xs;
  }
  window.STI_merge = function (RES, CFG) {
    PLAYERS.forEach(gp => {
      const u = gp.username.toLowerCase();
      let p = RES.find(r => r.u.toLowerCase() === u);
      if (!p) { p = { u: gp.username, day: CFG.day, game: 1 }; RES.push(p) }
      p.lvl = gp.hut_level || 1; p.look = gp.look || {};
      levelize(p);
    });
  };
  window.STI_look = () => (ME && ME.look) || null;

  async function boot() {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch(`${SB_URL}/rest/v1/players_public?select=username,look,hut_level&order=created_at`, { headers: H, signal: ctl.signal });
      clearTimeout(tm);
      if (r.ok) PLAYERS = await r.json();
    } catch (e) { }
    if (TOKEN) { try { ME = await rpc('me', { p_token: TOKEN }) } catch (e) { if (e.code === 'NOT_FOUND') { TOKEN = null; store.set('sti_token', null) } } }
    window.__MAIN();
    ui();
  }

  // ---------- UI ----------
  const css = `
#gp{position:fixed;z-index:8;right:14px;top:14px;bottom:14px;width:min(380px,calc(100vw - 28px));overflow:auto;display:none;padding:18px 18px 22px;border-radius:18px}
#gp.on{display:block}body.reel #gp{display:none!important}
#gp h2{margin:0 0 4px;font:800 28px/1.05 'Baloo 2',sans-serif}
#gp h3{margin:18px 0 8px;font:800 19px/1.1 'Baloo 2',sans-serif}
#gp p{margin:4px 0}#gp .mut{color:var(--muted);font-size:14px}
#gp .x{position:absolute;top:8px;right:8px;height:38px;width:38px;padding:0;background:transparent;color:var(--muted);font-size:24px}
#gp input{width:100%;margin:4px 0 8px}
#gp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#gp .res{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
#gp .res div{background:#fff;border:2px solid #e2d3ad;border-radius:12px;padding:6px 8px;text-align:center;font-weight:800;font-size:18px}
#gp .res small{display:block;font-weight:700;font-size:12px;color:var(--muted)}
#gp .bar{height:14px;background:#fff;border:2px solid #e2d3ad;border-radius:999px;overflow:hidden;margin:6px 0}
#gp .bar i{display:block;height:100%;background:var(--coral);border-radius:999px;transition:width .4s}
#gp .bar.en i{background:#ffb703}
#gp .tasks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#gp .tasks button{height:auto;padding:10px 8px;line-height:1.15;background:var(--sea);text-align:center}
#gp .tasks button span{display:block;font-size:22px}#gp .tasks button small{display:block;font-weight:700;opacity:.8;font-size:12px}
#gp button:disabled{opacity:.45;cursor:default}
#gp .sw{display:flex;gap:6px;margin:4px 0 8px;flex-wrap:wrap}
#gp .sw b{width:32px;height:32px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 2px #e2d3ad;cursor:pointer}
#gp .sw b.on{box-shadow:0 0 0 3px var(--coral)}
#gp ol{margin:6px 0 0;padding-left:24px}#gp li{margin:2px 0}#gp li.me{font-weight:800;color:var(--coral)}
#gp .lock{display:flex;justify-content:space-between;font-size:14px;padding:4px 0;border-bottom:1px dashed #e2d3ad}
#gp .err{color:#c1121f;font-weight:700;font-size:14px;min-height:1em}
#gtoast{position:fixed;z-index:9;left:50%;top:18px;transform:translate(-50%,-20px);opacity:0;transition:.25s;pointer-events:none;font-weight:800;max-width:90vw;text-align:center}
#gtoast.on{opacity:1;transform:translate(-50%,0)}
body.gp-open #top form{display:none}
@media(max-width:600px){#gp{top:auto;max-height:72vh;bottom:0;right:0;width:100vw;border-radius:18px 18px 0 0}}`;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let panel, toastT;

  function toast(t) {
    const el = $('gtoast'); el.textContent = t; el.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600);
  }

  function ui() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    panel = document.createElement('div'); panel.id = 'gp'; panel.className = 'chip'; document.body.appendChild(panel);
    const t = document.createElement('div'); t.id = 'gtoast'; t.className = 'chip'; document.body.appendChild(t);
    const btn = $('gameBtn');
    btn.textContent = ME ? 'My survivor' : 'Join the game';
    btn.onclick = () => open();
    if (!ME && store.get('sti_ref')) open();
  }

  async function open() {
    panel.classList.add('on'); document.body.classList.add('gp-open');
    render();
    try { STATE = await rpc('island_state'); render() } catch (e) { }
  }
  function close() { panel.classList.remove('on'); document.body.classList.remove('gp-open') }

  function swatches(key) {
    return `<div class="sw" data-k="${key}">${SWATCH[key].map(c => `<b style="background:${c}" data-c="${c}" class="${draftLook[key] === c ? 'on' : ''}" role="button" aria-label="${key} ${c}"></b>`).join('')}</div>`;
  }

  function render() {
    if (!panel.classList.contains('on')) return;
    const s = STATE || {};
    let h = `<button class="x" type="button" aria-label="Close">×</button>`;
    if (!ME) {
      const ref = store.get('sti_ref');
      h += `<h2>Join the island</h2>
        <p class="mut">Get your own survivor, gather resources and grow your hut from straw to fortress. ${s.players ? `<b>${s.players}</b> survivors already playing.` : ''}</p>
        ${ref ? `<p>🎁 Invited by <b>@${esc(ref)}</b>: you both get bonus wood.</p>` : ''}
        <h3>1. Your Instagram</h3><input id="g_u" placeholder="@username" autocomplete="off" autocapitalize="off">
        <h3>2. Secret code</h3><p class="mut">It’s hidden in our latest Reel on ${HANDLE}.</p><input id="g_c" placeholder="Code from the Reel" autocomplete="off" autocapitalize="characters">
        <h3>3. Your survivor</h3>
        <p class="mut">Shirt</p>${swatches('shirt')}<p class="mut">Skin</p>${swatches('skin')}<p class="mut">Hat</p>${swatches('hat')}<p class="mut">Pants</p>${swatches('pants')}
        <p class="err" id="g_err"></p><button id="g_join" type="button" style="width:100%">Join the island</button>`;
    } else {
      const m = ME, L = LV[m.hut_level], next = COST[m.hut_level];
      const can = next && m.wood >= next.w && m.stone >= next.s && m.fish >= next.f;
      const g = s.goal;
      const inviteUrl = location.origin + location.pathname + '?ref=' + encodeURIComponent(m.username);
      const resIcon = { wood: '🪵', fish: '🐟', stone: '🪨' };
      h += `<h2>@${esc(m.username)}</h2><p class="mut">${L.name} · Level ${m.hut_level} · Rank #${m.rank} · ${m.score} pts</p>
        <div class="res"><div>🪵 ${m.wood}<small>wood</small></div><div>🐟 ${m.fish}<small>fish</small></div><div>🪨 ${m.stone}<small>stone</small></div></div>
        <h3>⚡ Energy ${m.energy}</h3><div class="bar en"><i style="width:${Math.min(100, m.energy * 20)}%"></i></div><p class="mut">Refills every day. Come back tomorrow!</p>
        <h3>Today’s tasks</h3><div class="tasks">${TASKS.map(t => `<button type="button" data-task="${t.id}" ${m.energy <= 0 ? 'disabled' : ''}><span>${t.icon}</span>${t.name}<small>${t.hint}</small></button>`).join('')}</div>
        <h3>🏠 Upgrade your hut</h3>${next ? `<p>Next: <b>${LV[m.hut_level + 1].name}</b></p><p class="mut">Costs 🪵 ${next.w}${next.s ? ` · 🪨 ${next.s}` : ''}${next.f ? ` · 🐟 ${next.f}` : ''}</p>
          <button id="g_up" type="button" ${can ? '' : 'disabled'}>Upgrade</button>` : `<p>Your fortress is complete. 🏰</p>`}
        <div class="row" style="margin-top:8px"><button class="alt" id="g_walk" type="button">Walk to my hut</button><button class="alt" id="g_see" type="button">Show my hut</button></div>
        ${g ? `<h3>🌪️ Island event</h3><p><b>${esc(g.title)}</b></p><div class="bar"><i style="width:${Math.min(100, g.progress / g.target * 100)}%"></i></div>
          <p class="mut">${g.progress}/${g.target} ${g.resource} ${resIcon[g.resource] || ''}${g.ends_at ? ' · ends ' + new Date(g.ends_at).toLocaleDateString() : ''}</p>
          ${(g.top || []).length ? `<p class="mut">Top helpers: ${g.top.map(t => '@' + esc(t.username) + ' (' + t.amount + ')').join(', ')}</p>` : ''}
          ${g.progress < g.target ? `<div class="row"><button type="button" data-give="5">Give 5</button><button type="button" data-give="all">Give all</button></div>` : '<p>✅ Completed! The island survived.</p>'}` : ''}
        <h3>🎁 Story bonus code</h3><p class="mut">New codes drop in our Instagram Story.</p>
        <div class="row"><input id="g_code" placeholder="Bonus code" style="flex:1;margin:0" autocomplete="off"><button id="g_red" type="button">Use</button></div>
        <h3>👥 Invite friends</h3><p class="mut">For every friend who joins with your link: +5 wood, +2 stone. You invited <b>${m.invites}</b>.</p>
        <div class="row"><button id="g_inv" type="button" data-url="${esc(inviteUrl)}">Copy my invite link</button></div>`;
    }
    if (s.followers != null) {
      h += `<h3>🔒 Unlock the island</h3><p class="mut">New areas open as ${HANDLE} grows. Share to unlock them sooner!</p>` +
        UNLOCKS.map(u => `<div class="lock"><span>${s.followers >= u.f ? '✅' : '🔒'} ${u.name}</span><span>${Math.min(s.followers, u.f)}/${u.f} followers</span></div>`).join('');
    }
    if (s.leaders && s.leaders.length) {
      h += `<h3>🏆 Top survivors</h3><ol>${s.leaders.map(l => `<li class="${ME && l.username === ME.username ? 'me' : ''}">@${esc(l.username)} · ${l.score} pts</li>`).join('')}</ol>`;
    }
    panel.innerHTML = h;
    bind();
  }

  function bind() {
    panel.querySelector('.x').onclick = close;
    panel.querySelectorAll('.sw').forEach(sw => sw.onclick = e => {
      const c = e.target.dataset.c; if (!c) return; draftLook[sw.dataset.k] = c;
      sw.querySelectorAll('b').forEach(b => b.classList.toggle('on', b.dataset.c === c));
    });
    const j = $('g_join');
    if (j) j.onclick = async () => {
      const u = $('g_u').value, c = $('g_c').value; $('g_err').textContent = ''; j.disabled = true; j.textContent = 'Building your hut…';
      try {
        const r = await rpc('join_island', { p_username: u, p_code: c, p_ref: store.get('sti_ref'), p_look: draftLook });
        store.set('sti_token', r.token); store.set('sti_ref', null);
        location.reload();
      } catch (e) { $('g_err').textContent = errText(e); j.disabled = false; j.textContent = 'Join the island' }
    };
    panel.querySelectorAll('[data-task]').forEach(b => b.onclick = () => act(async () => {
      const r = await rpc('do_task', { p_token: TOKEN, p_task: b.dataset.task }); ME = r.me; toast(r.msg);
    }));
    const up = $('g_up'); if (up) up.onclick = () => act(async () => {
      ME = await rpc('upgrade_hut', { p_token: TOKEN }); toast('Your hut is now a ' + LV[ME.hut_level].name + '! 🎉'); rebuildMyHut(); showMine();
    });
    const red = $('g_red'); if (red) red.onclick = () => act(async () => {
      ME = await rpc('redeem', { p_token: TOKEN, p_code: $('g_code').value }); toast('Bonus unlocked! 🎁');
    });
    panel.querySelectorAll('[data-give]').forEach(b => b.onclick = () => act(async () => {
      const g = STATE && STATE.goal; const have = g ? ME[g.resource] : 0;
      ME = await rpc('contribute', { p_token: TOKEN, p_amount: b.dataset.give === 'all' ? have : 5 }); toast('Thanks for helping the island! 💪');
    }));
    const inv = $('g_inv'); if (inv) inv.onclick = async () => {
      const url = inv.dataset.url;
      try { if (navigator.share) await navigator.share({ title: 'Survive the Island', text: 'Join me on the island!', url }); else { await navigator.clipboard.writeText(url); toast('Link copied! Send it to your friends.') } }
      catch (e) { try { await navigator.clipboard.writeText(url); toast('Link copied!') } catch (e2) { prompt('Copy your link:', url) } }
    };
    const walk = $('g_walk'); if (walk) walk.onclick = () => {
      const I = window.ISLAND, h = I.byName[ME.username.toLowerCase()]; close();
      if (!I.PLAY.on) I.startPlay(); if (h) { I.PLAY.goal = h; I.PLAY.near = null }
    };
    const see = $('g_see'); if (see) see.onclick = () => { close(); showMine() };
  }

  async function act(fn) {
    panel.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await fn(); try { STATE = await rpc('island_state') } catch (e) { } }
    catch (e) { toast(errText(e)) }
    render();
  }
  function showMine() {
    const I = window.ISLAND, h = ME && I.byName[ME.username.toLowerCase()];
    if (I.PLAY.on) I.stopPlay();
    if (h) I.show(h);
  }
  function rebuildMyHut() {
    const I = window.ISLAND, h = I.byName[ME.username.toLowerCase()]; if (!h) return;
    h.p.lvl = ME.hut_level; h.p.look = ME.look; levelize(h.p);
    I.scene.remove(h.g); h.g = I.hut(h.p, h.x, h.z);
  }

  boot();
})();
