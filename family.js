// Family hot-water planner: tank simulation, shower log and per-person learning.
// Listens for 'hwm:weather' (raw Open-Meteo response) dispatched by index.html, and reads
// window.HWM.weather on start in case the first one fired before this file loaded.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const ltr = (x) => `<span dir="ltr">${x}</span>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const HOUR = 3600000, DAY = 24 * HOUR;
  const CP = 4.186; // kJ/(kg·°C)

  const DEFAULTS = {
    liters: 150,      // tank volume
    area: 2,          // collector area m²
    tilt: 45,         // collector tilt from horizontal, degrees
    azimuth: 0,       // collector facing: 0 = south, -90 = east, 90 = west
    eff: 0.7,         // collector optical efficiency × calibration (learned)
    ul: 5,            // collector heat loss, W/m²·°C (more when it's cold outside)
    tin: null,        // cold inlet water °C; null = follow the season (recent air temperature)
    tshower: null,    // comfortable shower temperature °C; null = by season (warmer in winter)
    tau: 40,          // tank cooling time constant, hours
    heaterKw: 2.5,    // electric element power
    heaterEff: 1,     // how much of the element's nominal heat reaches usable water (learned)
    heaterMax: 65,    // electric element thermostat °C (Israeli practice: 65; factory default often 70)
    tankMax: 80,      // highest the sun can take the tank (no solar limiter: ~80 on a hot idle day)
    perPerson: 40,    // default liters of shower-temperature water per shower
    morning: '07:00',
    evening: '19:00'
  };
  // Settings migrations. 2: tilted-collector irradiance with temperature-dependent losses, so
  // calibration learned under the old horizontal model starts again. 3: seasonal shower temperature.
  // 4: new temperature limits (thermostat 65, sun 80), applied only where the old defaults were kept.
  const MODEL = 4;
  const migration = (from, cur) => Object.assign({},
    (from ?? 0) < 2 ? { eff: DEFAULTS.eff, tin: null } : {},
    (from ?? 0) < 3 ? { tshower: null } : {},
    (from ?? 0) < 4 && (cur.heaterMax == null || cur.heaterMax === 60) ? { heaterMax: DEFAULTS.heaterMax } : {},
    (from ?? 0) < 4 && (cur.tankMax == null || cur.tankMax === 70) ? { tankMax: DEFAULTS.tankMax } : {},
    { model: MODEL });
  const saved = store.get('hwm.tank', {});
  if (saved.model !== MODEL) Object.assign(saved, migration(saved.model, saved));
  const cfg = Object.assign({}, DEFAULTS, { model: MODEL });
  Object.keys(DEFAULTS).forEach(k => { if (saved[k] != null && saved[k] !== '') cfg[k] = saved[k]; });
  const fam = Object.assign({ members: [], logs: [], boilers: [] }, store.get('hwm.family', {}));
  const saveLocal = () => { store.set('hwm.tank', cfg); store.set('hwm.family', fam); };
  if (saved.model !== cfg.model || store.get('hwm.tank', {}).model !== MODEL) store.set('hwm.tank', cfg); // keep the migration

  // Every change is an op: applied locally right away, then queued for the shared sheet.
  // apps-script/Code.gs implements the same applyOp on the server.
  function applyOp(o) {
    switch (o.op) {
      case 'member': {
        const i = fam.members.findIndex(m => m.id === o.m.id);
        if (i >= 0) fam.members[i] = Object.assign({}, fam.members[i], o.m);
        else fam.members.push(Object.assign({ liters: null, n: 0, skip: {} }, o.m));
        break;
      }
      case 'delMember':
        fam.members = fam.members.filter(m => m.id !== o.id);
        fam.logs = fam.logs.filter(l => l.member !== o.id);
        break;
      case 'log':
        if (!fam.logs.some(l => l.id === o.l.id)) fam.logs.push(Object.assign({}, o.l));
        break;
      case 'delLog':
        fam.logs = fam.logs.filter(l => l.id !== o.id);
        break;
      case 'boiler': {
        const i = fam.boilers.findIndex(b => b.id === o.b.id);
        if (i >= 0) fam.boilers[i] = Object.assign({}, fam.boilers[i], o.b);
        else fam.boilers.push(Object.assign({ min: null }, o.b));
        break;
      }
      case 'delBoiler':
        fam.boilers = fam.boilers.filter(b => b.id !== o.id);
        break;
      case 'cfg':
        Object.assign(cfg, o.cfg);
        break;
      case 'order':
        fam.members.sort((a, b) => o.ids.indexOf(a.id) - o.ids.indexOf(b.id));
        break;
      case 'replace':
        fam.members = o.members || [];
        fam.logs = o.logs || [];
        fam.boilers = o.boilers || [];
        Object.keys(cfg).forEach(k => delete cfg[k]);
        Object.assign(cfg, DEFAULTS, o.cfg || {});
        break;
    }
  }

  // ---------- Shared storage (Google Sheets via Apps Script) ----------
  // don't re-render under the user's fingers while they are filling a field
  const typing = () => !!document.querySelector('#family input:focus, #family select:focus, #family textarea:focus');
  const sync = { conf: store.get('hwm.sync', null), outbox: store.get('hwm.outbox', []), busy: false, last: null, err: null };

  const HOSTED_URL = (window.HWM_HOSTED_URL || '').trim();

  async function readJson(r) {
    let j;
    try { j = await r.json(); } catch { throw new Error('תשובה לא תקינה מהשרת (HTTP ' + r.status + ')'); }
    if (j.error) throw new Error(j.error === 'bad key' ? 'מפתח שגוי' : j.error === 'too many new families today' ? 'נוצרו היום יותר מדי יומנים – נסו מחר' : j.error);
    return j;
  }

  // conf: { u: web-app URL, k: key, f: family id (hosted mode only) }
  async function api(ops) {
    const { u, k, f } = sync.conf;
    const q = (f ? 'f=' + encodeURIComponent(f) + '&' : '') + 'key=' + encodeURIComponent(k);
    const r = ops
      ? await fetch(u, { method: 'POST', body: JSON.stringify({ f, key: k, ops }) }) // text/plain → no CORS preflight
      : await fetch(u + (u.includes('?') ? '&' : '?') + q + '&_=' + Date.now());
    return (await readJson(r)).state;
  }

  async function createFamily(name) {
    const r = await fetch(HOSTED_URL, { method: 'POST', body: JSON.stringify({ action: 'create', name }) });
    const j = await readJson(r);
    return connect(HOSTED_URL, j.key, j.f);
  }

  // Server state wins; ops not yet acknowledged are replayed on top of it
  function adopt(st) {
    // a server deployed before boiler logging returns no boilers – keep ours then
    const before = panelKey();
    applyOp({ op: 'replace', members: st.members, logs: st.logs, boilers: st.boilers ?? fam.boilers, cfg: st.cfg });
    sync.outbox.forEach(applyOp);
    saveLocal();
    if (cfg.model !== MODEL && !sync.outbox.some(o => o.op === 'cfg' && o.cfg.model === MODEL)) {
      const m = migration(cfg.model, cfg);
      sync.outbox.push({ op: 'cfg', cfg: m });
      applyOp({ op: 'cfg', cfg: m });
      store.set('hwm.outbox', sync.outbox);
      saveLocal();
    }
    if (panelKey() !== before && window.HWM) HWM.reload(); // irradiance is fetched for the collector's orientation
  }
  const panelKey = () => cfg.tilt + '/' + cfg.azimuth;

  async function syncNow() {
    if (!sync.conf || sync.busy) return;
    sync.busy = true;
    try {
      const sending = sync.outbox.slice();
      const st = await api(sending.length ? sending : null);
      sync.outbox = sync.outbox.slice(sending.length);
      store.set('hwm.outbox', sync.outbox);
      adopt(st);
      sync.last = Date.now();
      sync.err = null;
      homeFromFamily();
    } catch (e) {
      sync.err = e instanceof TypeError ? 'אין חיבור לשרת – השינויים יישלחו כשיחזור' : e.message;
    } finally {
      sync.busy = false;
    }
    if (!typing()) render(); else renderSyncStatus();
    if (!sync.err && sync.outbox.length) syncNow();
  }

  // ---------- Home location: shared in a family, per device for a guest ----------
  const sameLoc = (a, b) => !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  // "my location" means the family's home once it is shared
  const asHome = (l) => ({ name: l.geo ? 'הבית' : l.name, lat: l.lat, lon: l.lon });
  function homeFromFamily() {
    if (!sync.conf || !window.HWM) return;
    if (cfg.loc) { if (!sameLoc(cfg.loc, HWM.loc)) HWM.setLoc(cfg.loc); }
    else if (HWM.loc) { commit([{ op: 'cfg', cfg: { loc: asHome(HWM.loc) } }]); HWM.setLoc(cfg.loc); } // the first device brings its location
    else HWM.askLoc();
  }
  document.addEventListener('hwm:loc', (e) => {
    if (sync.conf && !sameLoc(cfg.loc, e.detail)) commit([{ op: 'cfg', cfg: { loc: asHome(e.detail) } }]);
  });

  // The location card lives at the top for a guest, and inside the family settings in a family
  function placeHome() {
    const card = $('locCard');
    const slot = sync.conf && $('locSlot');
    (slot || $('locHome')).appendChild(card);
    const fp = $('famPlace');
    fp.hidden = !(sync.conf && window.HWM && HWM.loc);
    if (!fp.hidden) fp.innerHTML = `📍 ${esc(HWM.loc.name)} · <button type="button" id="editHome" class="linkish">שינוי מיקום הבית</button>`;
  }
  document.addEventListener('click', (e) => {
    if (e.target.id !== 'editHome') return;
    $('cfgBox').open = true;
    $('cfgBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  function commit(ops) {
    ops.forEach(applyOp);
    saveLocal();
    if (sync.conf) {
      sync.outbox.push(...ops);
      store.set('hwm.outbox', sync.outbox);
      syncNow();
    }
    render();
  }

  async function connect(u, k, f) {
    sync.conf = { u: u.trim(), k: k.trim() };
    if (f) sync.conf.f = f;
    sync.err = null;
    try {
      const st = await api(null);
      // First device to connect uploads what it already has
      if (!st.members.length && !st.logs.length && (fam.members.length || fam.logs.length || fam.boilers.length)) {
        sync.outbox = [{ op: 'replace', members: fam.members, logs: fam.logs, boilers: fam.boilers, cfg: Object.assign({}, cfg) }];
        store.set('hwm.outbox', sync.outbox);
      } else {
        sync.outbox = [];
        store.set('hwm.outbox', sync.outbox);
        adopt(st);
      }
      store.set('hwm.sync', sync.conf);
      await syncNow();
      return true;
    } catch (e) {
      sync.conf = null;
      sync.err = e.message;
      render();
      return false;
    }
  }

  const joinLink = () => location.origin + location.pathname + '#join=' +
    btoa(unescape(encodeURIComponent(JSON.stringify(sync.conf)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function readJoinLink() {
    const m = location.hash.match(/join=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4)))));
    } catch { return null; }
  }

  function syncStatusText() {
    if (!sync.conf) return '';
    if (sync.err) return `⚠️ בעיה בסנכרון: ${esc(sync.err)}${sync.outbox.length ? ' · יש שינויים שממתינים לשליחה' : ''}`;
    if (sync.busy && !sync.last) return '⏳ מסנכרן…';
    return `🔗 משותף עם המשפחה${sync.last ? ' · עודכן ' + new Date(sync.last).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : ''}${sync.outbox.length ? ' · ממתין לשליחה' : ''}`;
  }
  function renderSyncStatus() {
    document.querySelectorAll('.sync-status').forEach(el => { el.innerHTML = syncStatusText(); });
  }

  let wx = null; // { off, hours: [{ start, end, ghi, ta }] }
  let learnNote = null; // { text, at } – survives re-renders for a few minutes

  // ---------- Model ----------
  const member = (id) => fam.members.find(m => m.id === id);
  const need = (m) => (m && m.liters != null ? m.liters : cfg.perPerson);
  // °C the tank loses per liter of shower-temperature water (energy balance, fully mixed tank)
  const perLiter = () => Math.max(1, tsh() - tin()) / cfg.liters;
  const airMean = () => (wx ? wx.airMean : 20); // computed once per forecast (it's used in every simulation step)
  // Comfortable shower temperature follows the season too: ~41° when it's 13° out, ~37° at 28°
  function tsh() {
    return cfg.tshower ?? Math.round(Math.min(42, Math.max(36, 44 - 0.25 * airMean())));
  }
  // Mains water follows the season: by default the average air temperature of the last days
  function tin() {
    if (cfg.tin != null) return cfg.tin;
    return Math.round(Math.min(26, Math.max(12, airMean())));
  }
  const drawOf = (m) => need(m) * perLiter();
  // How much shower-temperature water the tank can still give before it drops to shower temperature
  // (used only for learning; cold water mixes in as hot is drawn, see perLiter)
  const capacity = (T) => Math.max(0, (T - tsh()) / perLiter());

  const STEP = HOUR / 4;
  // A run logged as "until I switch it off" counts up to now, and at most this long if nobody does
  const MAX_OPEN = 3 * HOUR;
  const runEnd = (b, now) => b.min != null ? b.t + b.min * 60000 : Math.min(now, b.t + MAX_OPEN);
  const spansOf = (now) => fam.boilers.map(b => [b.t, runEnd(b, now)]).filter(s => s[1] > s[0]);
  const overlap = (spans, a, b) => spans.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const activeRun = (now) => fam.boilers.find(b => b.t <= now && now < (b.min != null ? b.t + b.min * 60000 : b.t + MAX_OPEN));

  // Useful heat from the collector over `hrs` hours, in °C of tank temperature. Flat-plate model:
  // optical gain minus a loss that grows with (tank − air), so cold days deliver less for the same sun.
  function solarGain(T, h, hrs) {
    const q = cfg.area * (cfg.eff * (h.gti || 0) - cfg.ul * (T - (h.ta ?? tin()))); // W
    if (q <= 0 || T >= cfg.tankMax) return 0; // thermosiphon stops when it would lose heat, or at the limit
    return Math.min(q * 3600 * hrs / 1000 / (cfg.liters * CP), cfg.tankMax - T);
  }

  // One step [a, b) inside weather hour h: solar gain, electric element (up to its thermostat), cooling
  function step(T, h, a, b, spans, sun) {
    const hrs = (b - a) / HOUR;
    T += sun;
    const on = overlap(spans, a, b) / HOUR;
    const stat = Math.min(cfg.heaterMax, cfg.tankMax);
    if (on > 0 && T < stat) T = Math.min(stat, T + cfg.heaterKw * cfg.heaterEff * 3600 * on / (cfg.liters * CP));
    const ta = h.ta ?? tin();
    T = ta + (T - ta) * Math.exp(-hrs / cfg.tau);
    return Math.min(T, cfg.tankMax);
  }

  // A logged shower also corrects the simulated state: the answer says where the tank was before the
  // shower (relative to shower temp ts and this person's draw d), so the temperature is moved into
  // that range first, and then the shower's draw is taken out – as it was in the real tank.
  function applyLog(T, l) {
    if (l.boiler) T = Math.max(T, cfg.heaterMax); // showers logged before boiler runs had their own log
    const d = drawOf(member(l.member)), ts = tsh();
    const within = (lo, hi) => Math.min(hi, Math.max(lo, T));
    if (l.outcome === 'plenty') T = within(ts + d + EDGE, Infinity);
    else if (l.outcome === 'edge') T = within(ts + d, ts + d + EDGE);
    else if (l.outcome === 'full') T = within(ts + d, Infinity);
    else if (l.outcome === 'partial') T = within(ts, ts + d);
    else T = within(-Infinity, ts);
    return Math.max(T - d, tin());
  }

  // Simulates in 15-minute steps; returns the tank temperature just before stopAt, the trace,
  // and the solar heating per local date ({ total, soFar } in °C)
  function run(stopAt = Infinity) {
    const H = wx.hours, now = Date.now(), spans = spansOf(now);
    const logs = fam.logs.filter(l => l.t >= H[0].start).sort((a, b) => a.t - b.t);
    let T = (H[0].ta ?? tin()) + 5, li = 0;
    const pts = [], gains = {}, obs = [];
    for (const h of H) {
      for (let a = h.start; a < h.end; a += STEP) {
        const b = a + STEP;
        pts.push({ t: a, T });
        while (li < logs.length && logs[li].t < b && logs[li].t < stopAt) {
          obs.push({ l: logs[li], T });
          T = applyLog(T, logs[li]);
          pts.push({ t: logs[li].t, T, log: logs[li] });
          li++;
        }
        if (b > stopAt) return { T, pts, gains, obs };
        const sun = solarGain(T, h, (b - a) / HOUR);
        const g = gains[localStr(a).slice(0, 10)] ||= { total: 0, soFar: 0 };
        g.total += sun;
        if (b <= now) g.soFar += sun;
        T = step(T, h, a, b, spans, sun);
      }
    }
    pts.push({ t: H[H.length - 1].end, T });
    return { T, pts, gains, obs };
  }

  // ---------- Learning ----------
  // Nobody needs to know their tank: volume, collector area, angle and efficiency only matter as
  // ratios, so the model keeps fixed defaults for them and learns lumped factors instead:
  //   eff        – how fast this tank heats from the sun (per unit of radiation on the collector)
  //   tau        – how fast it cools down overnight
  //   heaterEff  – how fast the electric element heats it
  //   liters     – per person, how much of the tank's heat one shower takes (relative to the tank)
  // Every shower with weather data (last ~30 days) is a constraint on the tank temperature just
  // before it: "hot to the end" → T − draw ≥ shower temp; "ran out" → T > shower temp > T − draw;
  // "no hot water" → T ≤ shower temp. The fit finds the factors that best satisfy all of them,
  // pulled gently toward the defaults so a few showers don't swing it.
  // Each outcome is treated as uncertain around the threshold (σ ≈ 2.5°C): "hot to the end" when
  // the model says the tank was barely enough counts as weaker evidence than when it was very hot.
  const SIGMA = 2.5;
  const PRIOR_WEIGHT = 1.5; // per (ln of the ratio to the default)²
  const sq = (x) => x * x;
  const cdf = (x) => 1 / (1 + Math.exp(-1.7 * x / SIGMA));
  // Outcomes, by what the tank had left at the end of the shower (x = end temperature − shower temp):
  //   plenty  – still mixing in cold at the end:            x > EDGE
  //   edge    – hot to the end, but on the hot tap only:    0 < x < EDGE   (almost a measurement)
  //   full    – hot to the end (logged before the question): x > 0
  //   partial – ran out during the shower;  none – no hot water from the start
  const EDGE = 3;
  function outcomeProbs(T, d) {
    const x = T - d - tsh();
    const full = cdf(x), plenty = cdf(x - EDGE), none = cdf(tsh() - T);
    return { full, plenty, edge: Math.max(1e-6, full - plenty), none, partial: Math.max(1e-6, 1 - full - none) };
  }
  // For the accuracy score the three main answers are compared: hot to the end / ran out / none
  const coarse = (o) => (o === 'plenty' || o === 'edge' ? 'full' : o);

  // Lean re-simulation for learning: only the tank temperature just before each logged shower
  function tempsBeforeShowers(logs) {
    const H = wx.hours, spans = spansOf(Date.now()), out = [];
    let T = (H[0].ta ?? tin()) + 5, li = 0;
    for (const h of H) {
      for (let a = h.start; a < h.end && li < logs.length; a += STEP) {
        const b = a + STEP;
        while (li < logs.length && logs[li].t < b) { out.push(T); T = applyLog(T, logs[li]); li++; }
        T = step(T, h, a, b, spans, solarGain(T, h, 0.25));
      }
    }
    return out;
  }

  function learnableLogs() {
    const start = wx.hours[0].start, now = Date.now();
    return fam.logs.filter(l => l.t >= start && l.t <= now && !l.boiler).sort((a, b) => a.t - b.t);
  }

  function negLogLik(logs) {
    const Ts = tempsBeforeShowers(logs);
    let e = 0;
    logs.forEach((l, i) => { e -= Math.log(Math.max(1e-6, outcomeProbs(Ts[i], drawOf(member(l.member)))[l.outcome])); });
    return e;
  }

  // How often the model's most likely outcome matches what was logged (shown to the family)
  function accuracy() {
    const logs = learnableLogs();
    if (logs.length < 5) return null;
    const Ts = tempsBeforeShowers(logs);
    // right after someone had no hot water, the next one won't either – too easy to count
    const fair = logs.map((l, i) => i).filter(i => !(i && logs[i - 1].outcome === 'none' && logs[i].t - logs[i - 1].t < 2 * HOUR));
    if (fair.length < 5) return null;
    const hits = fair.filter(i => {
      const p = outcomeProbs(Ts[i], drawOf(member(logs[i].member)));
      return ['full', 'partial', 'none'].reduce((a, b) => (p[a] >= p[b] ? a : b)) === coarse(logs[i].outcome);
    }).length;
    return { pct: Math.round(hits / fair.length * 100), n: fair.length };
  }

  function fit() {
    const logs = learnableLogs(), now = Date.now();
    if (!logs.length) return [];
    const knob = (get, set, prior, lo, hi, group) => ({ get, set, prior, lo, hi, group });
    const knobs = [
      knob(() => cfg.eff, v => { cfg.eff = v; }, DEFAULTS.eff, 0.15, 1.5, 'heat'),
      knob(() => cfg.tau, v => { cfg.tau = v; }, DEFAULTS.tau, 10, 150)
    ];
    if (fam.boilers.some(b => runEnd(b, now) > wx.hours[0].start)) knobs.push(knob(() => cfg.heaterEff, v => { cfg.heaterEff = v; }, DEFAULTS.heaterEff, 0.3, 2, 'heat'));
    for (const id of new Set(logs.map(l => l.member))) {
      const m = member(id);
      if (m) knobs.push(knob(() => need(m), v => { m.liters = v; }, cfg.perPerson, 5, 250, 'use'));
    }
    // Directions to search: each factor alone, plus factors that can stand in for each other moved
    // together (sun + boiler heating; everyone's usage), or the search stalls where one compensates
    const moves = knobs.map(k => [k]);
    for (const g of ['heat', 'use']) {
      const ks = knobs.filter(k => k.group === g);
      if (ks.length > 1) moves.push(ks);
    }
    const cost = () => negLogLik(logs) + PRIOR_WEIGHT * knobs.reduce((s, k) => s + sq(Math.log(k.get() / k.prior)), 0);
    // Multiplicative coordinate search, coarse to fine
    let best = cost();
    for (const f of [1.6, 1.25, 1.08, 1.02]) {
      for (let pass = 0, moved = true; pass < 8 && moved; pass++) {
        moved = false;
        for (const ks of moves) {
          const v0 = ks.map(k => k.get());
          for (const g of [f, 1 / f]) {
            ks.forEach((k, i) => k.set(Math.min(k.hi, Math.max(k.lo, v0[i] * g))));
            const c = cost();
            if (c < best - 1e-6) { best = c; moved = true; break; }
            ks.forEach((k, i) => k.set(v0[i]));
          }
        }
      }
    }
    const ops = [{ op: 'cfg', cfg: { eff: +cfg.eff.toFixed(3), tau: +cfg.tau.toFixed(1), heaterEff: +cfg.heaterEff.toFixed(3) } }];
    for (const m of fam.members) {
      const n = logs.filter(l => l.member === m.id).length;
      if (n) ops.push({ op: 'member', m: { id: m.id, liters: Math.round(need(m)), n } });
    }
    return ops;
  }

  // Share of a hot (60°C) tank one shower takes, at this season's shower and mains temperatures
  const share = (m) => Math.round(need(m) * (tsh() - tin()) / Math.max(1, 60 - tin()) / cfg.liters * 100);

  // What a newly logged shower taught the model, in words
  function lesson(before, l) {
    const m = member(l.member);
    const parts = [];
    if (m && before.liters !== need(m)) {
      const r = need(m) / before.liters;
      if (r > 1.08) parts.push(`${m.name} צורך/ת יותר ממה שחשבנו – עכשיו כ-${share(m)}% מדוד חם למקלחת.`);
      else if (r < 0.93) parts.push(`${m.name} צורך/ת פחות ממה שחשבנו – עכשיו כ-${share(m)}% מדוד חם למקלחת.`);
    }
    const se = cfg.eff / before.eff;
    if (se > 1.08) parts.push('הדוד מתחמם מהשמש מהר יותר ממה שחשבנו.');
    else if (se < 0.93) parts.push('הדוד מתחמם מהשמש לאט יותר ממה שחשבנו.');
    const st = cfg.tau / before.tau;
    if (st > 1.1) parts.push('הדוד שומר חום בלילה טוב יותר ממה שחשבנו.');
    else if (st < 0.9) parts.push('הדוד מתקרר בלילה מהר יותר ממה שחשבנו.');
    const sh = cfg.heaterEff / before.heaterEff;
    if (sh > 1.08) parts.push('הדוד החשמלי מחמם מהר יותר ממה שחשבנו.');
    else if (sh < 0.93) parts.push('הדוד החשמלי מחמם לאט יותר ממה שחשבנו.');
    return parts.length ? parts.join(' ') : 'תואם את מה שכבר למדנו.';
  }

  // ---------- Time helpers (location-local time) ----------
  const localStr = (t) => new Date(t + wx.off).toISOString();
  const hhmm = (t) => localStr(t).slice(11, 16);
  const dayStart = (t) => Date.parse(localStr(t).slice(0, 10) + 'T00:00:00Z') - wx.off;
  function nextAt(time, now) {
    const [h, m] = time.split(':').map(Number);
    let t = dayStart(now) + h * HOUR + m * 60000;
    if (t <= now) t += DAY;
    return t;
  }
  function dayWord(t, now) {
    const d = Math.round((dayStart(t) - dayStart(now)) / DAY);
    return d === 0 ? 'היום' : d === 1 ? 'מחר' : d === -1 ? 'אתמול' : localStr(t).slice(5, 10);
  }

  // ---------- Planning ----------
  function plan(t, slot) {
    const T0 = run(t).T;
    let T = T0;
    const who = fam.members.filter(m => !m.skip || !m.skip[slot]);
    const rows = who.map(m => {
      const d = drawOf(m);
      const st = T - d >= tsh() - 0.05 ? 'ok' : T > tsh() ? 'partial' : 'cold';
      T = Math.max(tin(), T - d);
      return { m, st };
    });
    const needT = tsh() + who.reduce((s, m) => s + drawOf(m), 0);
    const target = Math.min(needT, Math.max(Math.min(cfg.heaterMax, cfg.tankMax), T0));
    const minutes = T0 >= needT ? 0 : Math.ceil((target - T0) * cfg.liters * CP / 3600 / (cfg.heaterKw * cfg.heaterEff) * 60);
    // how many of the list get a full hot shower once the tank is at `target`
    let Th = target, withHeater = 0;
    for (const m of who) { if (Th - drawOf(m) < tsh() - 0.05) break; Th -= drawOf(m); withHeater++; }
    return { T0, rows, minutes, withHeater, total: who.length };
  }

  // ---------- Showers tonight (the family's own measure: their tank, their people, the season) ----------
  function showersTonight(now) {
    const t = nextAt(cfg.evening, now - 3 * HOUR); // "tonight" until 3 hours after the evening showers
    const at = (time) => {
      if (time < wx.hours[0].start || time > wx.hours[wx.hours.length - 1].end) return null;
      const p = plan(time, 'evening');
      if (p.total) return { ok: p.rows.filter(r => r.st === 'ok').length, total: p.total };
      return { n: Math.floor(capacity(p.T0) / cfg.perPerson) }; // nobody listed: default-size showers
    };
    const tonight = at(t), yday = at(t - DAY);
    const say = (x) => x.total != null ? `${ltr(x.ok)} מתוך ${ltr(x.total)}` : `~${ltr(x.n)} מקלחות`;
    const pct = (x) => x.total != null ? Math.round(x.ok / x.total * 100) : null;
    const cls = !tonight ? '' : tonight.total != null ? (pct(tonight) === 100 ? 'good' : pct(tonight) > 0 ? 'mid' : 'bad') : '';
    const html = !tonight ? '' : `<div class="showers">
      <div class="k">🚿 ${t - now > 12 * HOUR ? 'מחר בערב' : 'הערב'} (${ltr(hhmm(t))}) בלי להדליק דוד</div>
      <div class="big2 ${cls}">${tonight.total != null ? `מספיק ל-${say(tonight)}` : say(tonight)}</div>
      <div class="note">${yday ? `אתמול באותה שעה: ${say(yday)}` : ''} · מקלחת ב-${ltr(tsh() + '°')}, מים מהברז ${ltr(tin() + '°')}</div>
    </div>`;
    return { html, tonight, yday };
  }

  // ---------- Rendering ----------
  const ICON = { ok: '✅', partial: '⚠️', cold: '❌' };
  // b: the button text; t: how it reads in the log. 'full' is kept for showers logged before the split.
  const OUT = {
    plenty: { b: 'חם עד הסוף, ובסוף עוד הוספתי קר', t: 'חם, ועוד עם קר בסוף', i: '✅', c: 'var(--good)' },
    edge: { b: 'חם עד הסוף, אבל בסוף כבר רק על חם', t: 'הספיק בדיוק (בסוף רק חם)', i: '🔥', c: 'var(--good)' },
    full: { t: 'חם עד הסוף', i: '✅', c: 'var(--good)' },
    partial: { b: 'נגמר באמצע', t: 'נגמר באמצע', i: '⚠️', c: 'var(--mid)' },
    none: { b: 'לא היו מים חמים', t: 'לא היו מים חמים', i: '❌', c: 'var(--bad)' }
  };

  function slotCard(title, t, slot, now) {
    const p = plan(t, slot);
    const status = !p.rows.length ? '' : p.rows.every(r => r.st === 'ok') ? 'ok' : p.rows.some(r => r.st === 'ok') ? 'partial' : 'cold';
    const running = slot === 'now' && activeRun(now);
    const advice = !p.rows.length ? ''
      : p.minutes === 0 ? `<p class="advice ok">✅ ${running ? 'אפשר לכבות את הדוד' : 'אין צורך להדליק דוד'}</p>`
      : running && p.minutes >= 3 ? `<p class="advice warn">🔥 הדוד דלוק – צריך עוד כ-${ltr(p.minutes)} דקות${p.withHeater < p.total ? ` (יספיק ל-${ltr(p.withHeater)} מתוך ${ltr(p.total)} ברצף)` : ''}</p>`
      : p.minutes < 3 ? `<p class="advice warn">⚠️ הדוד כבר חם, אבל יספיק רק ל-${ltr(p.withHeater)} מתוך ${ltr(p.total)} ברצף – כדאי לפזר את המקלחות</p>`
      : `<p class="advice warn">🔌 להדליק דוד כ-${ltr(p.minutes)} דקות לפני${p.withHeater < p.total ? ` – יספיק ל-${ltr(p.withHeater)} מתוך ${ltr(p.total)} ברצף` : ''}</p>`;
    return `<div class="slot ${status}">
      <div class="slot-h"><b>${title}</b> <span class="note">${dayWord(t, now)} ${ltr(hhmm(t))}</span></div>
      <div class="slot-t">${ltr('~' + fmt(p.T0) + '°C')}</div>
      <ul class="who">${p.rows.map(r => `<li>${ICON[r.st]} ${esc(r.m.name)} <span class="note">${ltr(share(r.m) + '%')}</span></li>`).join('')}</ul>
      ${advice}
    </div>`;
  }

  // A rendering bug should show up as a message, not as a silently missing section
  function render() {
    try {
      renderSection();
    } catch (err) {
      console.error(err);
      $('family').innerHTML = `<p class="card fam err">שגיאה בהצגת מצב הדוד: ${esc(err.message)}</p>`;
    }
  }

  function renderSection() {
    const root = $('family');
    $('locHome').appendChild($('locCard')); // take it out before the section is rebuilt
    if (!wx) { root.innerHTML = ''; placeHome(); return; }
    const now = Date.now();
    const cur = run(now).T;
    const morning = nextAt(cfg.morning, now);
    const evening = nextAt(cfg.evening, now);
    const slots = [['עכשיו', now, 'now'], ['בוקר', morning, 'morning'], ['ערב', evening, 'evening']]
      .filter(s => s[1] <= wx.hours[wx.hours.length - 1].end)
      .sort((a, b) => a[1] - b[1]);
    const recent = [...fam.logs].sort((a, b) => b.t - a.t).slice(0, 12);
    const defaultTime = localStr(now).slice(0, 16);
    const active = activeRun(now);
    const runs = [...fam.boilers].sort((a, b) => b.t - a.t).slice(0, 8);
    const mins = (b) => Math.round((runEnd(b, now) - b.t) / 60000);
    const sh = showersTonight(now);
    const sunToday = run().gains[localStr(now).slice(0, 10)];

    root.innerHTML = `
    <section class="card fam" id="tankCard">
      <h2>🚿 מצב הדוד</h2>
      ${sync.conf ? `<div class="note sync-status">${syncStatusText()}</div>` : '<button type="button" id="openShare" class="linkish">🔗 לשתף את היומן עם כל המשפחה</button>'}
      <div class="tank-now">
        <div><div class="k">טמפ׳ משוערת עכשיו</div><div class="big">${ltr('~' + fmt(cur) + '°C')}</div></div>
        ${sh.html}
        <div class="note drop">כל מקלחת של ${ltr(cfg.perPerson)} ליטר מכניסה לדוד מים קרים ומורידה אותו בכ-${ltr(fmt(cfg.perPerson * perLiter(), 1) + '°')}</div>
      </div>
      ${sunToday && sunToday.total >= 0.5 ? `<p class="note">☀️ השמש מוסיפה לדוד היום כ-${ltr('+' + Math.round(sunToday.total) + '°')}</p>` : ''}
      <div class="chart" id="tankChart"></div>
      <div class="legend">
        <span><i style="background:var(--hot)"></i>טמפ׳ הדוד (תחזית בקו מקווקו)</span>
        <span><i style="background:none;border-top:2px dashed var(--clear);border-radius:0;height:0"></i>${tsh()}°C – מקלחת נעימה</span>
        <span>● מקלחת שנרשמה</span>
        <span><i style="background:var(--mid);opacity:.25"></i>דוד חשמלי דלוק</span>
      </div>
      ${fam.members.length ? '' : '<p class="note">הוסיפו בני משפחה (למטה) כדי לראות מי יכול להתקלח בכל זמן.</p>'}
      <div class="slots">${slots.map(s => slotCard(s[0], s[1], s[2], now)).join('')}</div>
      <p class="note">הסדר ברשימה הוא סדר המקלחות. ההערכה כוללת רק הדלקות דוד שנרשמו.</p>
    </section>

    <section class="card fam" id="boilerCard">
      <h2>🔌 הדוד החשמלי</h2>
      ${active ? `
        <p class="boiler-on">🔥 הדוד דלוק מאז ${ltr(hhmm(active.t))} ·
          ${active.min != null ? `ייכבה בערך ב-${ltr(hhmm(active.t + active.min * 60000))}` : `${ltr(mins(active))} דק׳ עד עכשיו`}</p>
        <button type="button" id="boilerOff" class="primary">כיביתי את הדוד</button>` : `
        <div class="note">הדלקתם את הדוד עכשיו? לכמה זמן:</div>
        <div class="out-btns">
          ${[10, 20, 30, 45, 60, 90].map(m => `<button type="button" data-boil="${m}">${ltr(m)} דק׳</button>`).join('')}
          <button type="button" data-boil="open">עד שאכבה</button>
        </div>`}
      <details class="adv">
        <summary>רישום הדלקה בדיעבד</summary>
        <div class="log-form">
          <label>מתי הודלק<input id="boilStart" type="datetime-local" value="${localStr(now - HOUR).slice(0, 16)}"></label>
          <label>כמה דקות<input id="boilMin" type="number" min="1" max="600" step="1" value="30"></label>
          <button type="button" id="boilAdd">רישום</button>
        </div>
      </details>
      ${runs.length ? `<table class="logs"><thead><tr><th>מתי</th><th>משך</th><th></th></tr></thead><tbody>
        ${runs.map(b => `<tr><td>${dayWord(b.t, now)} ${ltr(hhmm(b.t))}</td>
          <td>${ltr(mins(b))} דק׳${b.min == null ? (b === active ? ' (דלוק)' : ' (לא נרשם כיבוי)') : ''}</td>
          <td><button type="button" class="x" data-del-boil="${b.id}" aria-label="מחיקה">✕</button></td></tr>`).join('')}
      </tbody></table>` : ''}
      <p class="note">מהמקלחות שאחרי הדלקה המודל לומד כמה מהר הדוד שלכם מחמם, וככה ההמלצה "כמה דקות להדליק" משתפרת.</p>
    </section>

    <section class="card fam">
      <h2>📝 רישום מקלחת</h2>
      ${fam.members.length ? `
      <div class="log-form">
        <label>מי התקלח<select id="logWho">${fam.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
        <label>מתי<input id="logTime" type="datetime-local" value="${defaultTime}"></label>
      </div>
      <div class="note">איך היו המים? (ואם היה חם עד הסוף – בסוף המקלחת עוד הוספת קר, או שכבר היית רק על חם?)</div>
      <div class="out-btns">
        ${Object.entries(OUT).filter(([, o]) => o.b).map(([k, o]) => `<button type="button" data-out="${k}">${o.i} ${o.b}</button>`).join('')}
      </div>
      <div id="learnMsg" class="note">${learnNote && Date.now() - learnNote.at < 10 * 60000 ? esc(learnNote.text) : ''}</div>` : '<p class="note">קודם מוסיפים בני משפחה.</p>'}
      ${recent.length ? `<table class="logs"><thead><tr><th>מתי</th><th>מי</th><th>תוצאה</th><th></th></tr></thead><tbody>
        ${recent.map(l => `<tr><td>${dayWord(l.t, now)} ${ltr(hhmm(l.t))}</td><td>${esc(member(l.member)?.name ?? '?')}${l.boiler ? ' 🔌' : ''}</td>
          <td style="color:${OUT[l.outcome].c}">${OUT[l.outcome].i} ${OUT[l.outcome].t}</td>
          <td><button type="button" class="x" data-del-log="${l.id}" aria-label="מחיקה">✕</button></td></tr>`).join('')}
      </tbody></table>` : ''}
    </section>

    <details class="card fam" id="famBox" ${fam.members.length ? '' : 'open'}>
      <summary>👨‍👩‍👧 בני המשפחה</summary>
      <p class="note">לא צריך לדעת כלום על הדוד. אחרי כל מקלחת רושמים אם היו מים חמים עד הסוף, והאתר לומד כמה כל אחד צורך ביחס לדוד שלכם – לפי מי התקלח לפניו ולפי השמש באותו יום. עד שיש מספיק מקלחות משתמשים בהערכה של ${cfg.perPerson} ליטר.</p>
      ${(() => { const acc = accuracy(); return acc ? `<p class="acc">🎯 המודל צודק ב-${ltr(acc.pct + '%')} מ-${ltr(acc.n)} המקלחות של החודש האחרון</p>` : ''; })()}
      ${fam.members.length ? `<table class="members"><thead><tr><th>שם</th><th>מדוד חם למקלחת</th><th>בוקר</th><th>ערב</th><th></th><th></th></tr></thead><tbody>
        ${fam.members.map((m, i) => `<tr data-id="${m.id}">
          <td><input class="m-name" value="${esc(m.name)}" aria-label="שם"></td>
          <td>${ltr('~' + share(m) + '%')}<div class="note">${m.n ? `נלמד מ-${ltr(m.n)}` : 'עדיין הערכה'}</div></td>
          <td><input class="m-slot" data-slot="morning" type="checkbox" ${m.skip?.morning ? '' : 'checked'} aria-label="מתקלח בבוקר"></td>
          <td><input class="m-slot" data-slot="evening" type="checkbox" ${m.skip?.evening ? '' : 'checked'} aria-label="מתקלח בערב"></td>
          <td><button type="button" class="x" data-up="${i}" ${i ? '' : 'disabled'} aria-label="הזזה למעלה">▲</button></td>
          <td><button type="button" class="x" data-del-m="${m.id}" aria-label="מחיקה">✕</button></td>
        </tr>`).join('')}</tbody></table>` : ''}
      <div class="add-row"><input id="newName" placeholder="שם (למשל: נועה)"><button type="button" id="addMember">➕ הוספה</button></div>
    </details>

    <details class="card fam" id="shareBox">
      <summary>🔗 שיתוף עם המשפחה</summary>
      ${sync.conf ? `
        <p class="sync-status">${syncStatusText()}</p>
        <p class="note">כל מי שפותח את קישור ההצטרפות בטלפון שלו רואה ורושם לאותו יומן משותף.</p>
        <div class="add-row">
          <button type="button" id="shareLink">📤 שליחת קישור הצטרפות</button>
          <button type="button" id="syncBtn">🔄 סנכרון עכשיו</button>
          <button type="button" id="disconnect">ניתוק המכשיר הזה</button>
        </div>
        <div id="shareMsg" class="note"></div>` : `
        <p class="note">כדי שכל בני המשפחה ירשמו לאותו יומן מהטלפונים שלהם.
          <b>קיבלתם קישור הצטרפות?</b> פשוט פתחו אותו – זה הכל.</p>
        ${HOSTED_URL ? `
        <p>אחד מבני המשפחה יוצר יומן, ושולח לשאר את קישור ההצטרפות:</p>
        <div class="add-row">
          <input id="famName" placeholder="שם המשפחה (לא חובה)">
          <button type="button" id="createFam" class="primary">✨ יצירת יומן משפחתי</button>
        </div>
        <p class="note">היומן נשמר בשרת של מפעיל האתר, וגישה אליו רק עם קישור ההצטרפות.</p>` : ''}
        ${sync.err ? `<p class="err">${esc(sync.err)}</p>` : ''}
        <details class="adv" ${HOSTED_URL ? '' : 'open'}>
          <summary>${HOSTED_URL ? 'מתקדם: ' : ''}שרת משלכם (גיליון Google בבעלותכם)</summary>
          <p class="note">הקמה חד-פעמית של כ-5 דקות:
            <a href="https://github.com/bambiker/hotwatermeter/blob/main/apps-script/README.md" target="_blank" rel="noopener">הוראות הקמה</a>.</p>
          <div class="grid-inputs">
            <label>כתובת ה-Web App<input id="syncUrl" type="url" dir="ltr" placeholder="https://script.google.com/macros/s/…/exec"></label>
            <label>מפתח<input id="syncKey" dir="ltr" autocomplete="off"></label>
          </div>
          <button type="button" id="connectBtn">התחברות</button>
        </details>`}
    </details>

    <details class="card fam" id="cfgBox">
      <summary>${sync.conf ? '⚙️ הגדרות המשפחה והדוד' : '⚙️ הגדרות הדוד'}</summary>
      ${sync.conf ? '<div class="home-loc"><div class="k">📍 מיקום הבית – משותף לכל המשפחה</div><div id="locSlot"></div></div>' : ''}
      <div class="grid-inputs">
        <label>שעת מקלחות בוקר<input data-cfg="morning" type="time" value="${cfg.morning}"></label>
        <label>שעת מקלחות ערב<input data-cfg="evening" type="time" value="${cfg.evening}"></label>
      </div>
      <details class="adv">
        <summary>מתקדם – לא חובה, האתר לומד את הדוד לבד</summary>
        <p class="note">אם אתם יודעים פרטים על הדוד – אפשר להזין, וזה יעזור ללמידה להתחיל קרוב יותר. ערכים שמסומנים "נלמד" מתעדכנים מהמקלחות שנרשמות.</p>
      <div class="grid-inputs">
        <label>נפח הדוד (ליטר)<input data-cfg="liters" type="number" min="30" step="10" value="${cfg.liters}"></label>
        <label>שטח קולטים (מ״ר)<input data-cfg="area" type="number" min="0.5" step="0.1" value="${cfg.area}"></label>
        <label>זווית הקולטים (מעלות מהאופק)<input data-cfg="tilt" type="number" min="0" max="90" step="5" value="${cfg.tilt}"></label>
        <label>כיוון הקולטים<select data-cfg="azimuth">${[[0, 'דרום'], [-45, 'דרום-מזרח'], [45, 'דרום-מערב'], [-90, 'מזרח'], [90, 'מערב']]
          .map(([v, t]) => `<option value="${v}" ${+cfg.azimuth === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>קצב חימום מהשמש (נלמד)<input data-cfg="eff" type="number" min="0.2" max="1" step="0.01" value="${cfg.eff}"></label>
        <label>הפסדי חום של הקולט (W/m²·°C)<input data-cfg="ul" type="number" min="0" max="20" step="0.5" value="${cfg.ul}"></label>
        <label>טמפ׳ מים קרים (°C)<input data-cfg="tin" type="number" step="1" value="${cfg.tin ?? ''}" placeholder="אוטומטי לפי העונה (~${tin()}°)"></label>
        <label>טמפ׳ מקלחת (°C)<input data-cfg="tshower" type="number" step="1" value="${cfg.tshower ?? ''}" placeholder="אוטומטי לפי העונה (~${tsh()}°)"></label>
        <label>שמירת חום בלילה – קבוע זמן בשעות (נלמד)<input data-cfg="tau" type="number" min="5" step="1" value="${cfg.tau}"></label>
        <label>הספק גוף חימום (kW)<input data-cfg="heaterKw" type="number" min="0.5" step="0.5" value="${cfg.heaterKw}"></label>
        <label>קצב חימום של הדוד החשמלי (נלמד)<input data-cfg="heaterEff" type="number" min="0.3" max="2" step="0.05" value="${cfg.heaterEff}"></label>
        <label>טרמוסטט הדוד החשמלי (°C)<input data-cfg="heaterMax" type="number" step="1" value="${cfg.heaterMax}"></label>
        <label>טמפ׳ מקסימלית של הדוד – ווסת (°C)<input data-cfg="tankMax" type="number" min="40" max="95" step="1" value="${cfg.tankMax}"></label>
        <label>הערכה התחלתית לאדם (ליטר מים במקלחת)<input data-cfg="perPerson" type="number" min="5" step="5" value="${cfg.perPerson}"></label>
      </div>
      </details>
      <div class="add-row">
        <button type="button" id="exportBtn">⬇️ ייצוא נתונים</button>
        <label class="file-btn">⬆️ ייבוא נתונים<input id="importFile" type="file" accept="application/json" hidden></label>
        <button type="button" id="resetLearn">↺ איפוס הלמידה</button>
      </div>
      <p class="note">${sync.conf ? 'ההגדרות ומיקום הבית משותפים לכל המשפחה.' : 'בלי שיתוף, הנתונים נשמרים רק בדפדפן הזה.'}</p>
    </details>`;

    drawTankChart($('tankChart'), now);
    placeHome();
    ['famBox', 'cfgBox', 'shareBox'].forEach(id => {
      const el = $(id), key = 'hwm.open.' + id, v = store.get(key, null);
      if (v != null) el.open = v;
      el.addEventListener('toggle', () => store.set(key, el.open));
    });
  }

  function drawTankChart(host, now) {
    const from = dayStart(now) - DAY, to = Math.min(dayStart(now) + DAY + 12 * HOUR, wx.hours[wx.hours.length - 1].end);
    const pts = run().pts.filter(p => p.t >= from && p.t <= to);
    if (pts.length < 2) { host.innerHTML = ''; return; }
    const W = Math.round(Math.min(640, Math.max(300, host.clientWidth || 640))), H = W < 480 ? 200 : 220, padL = 34, padR = 8, padT = 10, padB = 24;
    const yMin = Math.floor(Math.min(tin(), ...pts.map(p => p.T)) / 10) * 10;
    const yMax = Math.ceil(Math.max(tsh() + 10, ...pts.map(p => p.T)) / 10) * 10;
    const x = t => padL + (W - padL - padR) * (t - from) / (to - from);
    const y = v => padT + (H - padT - padB) * (1 - (v - yMin) / (yMax - yMin));
    const path = arr => arr.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.T).toFixed(1)).join('');
    const past = pts.filter(p => p.t <= now), fut = pts.filter(p => p.t >= now);
    const nowPt = { t: now, T: run(now).T };
    let s = `<svg viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="טמפרטורת הדוד המשוערת">`;
    for (let v = yMin; v <= yMax; v += 10) {
      s += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
      s += `<text x="${padL - 4}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="var(--ink-3)">${v}°</text>`;
    }
    const spans = spansOf(now);
    spans.forEach(([a, b]) => {
      const x0 = x(Math.max(a, from)), x1 = x(Math.min(b, to));
      if (x1 > x0) s += `<rect x="${x0}" y="${padT}" width="${Math.max(1, x1 - x0)}" height="${H - padT - padB}" fill="var(--mid)" opacity=".18"/>`;
    });
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(tsh())}" y2="${y(tsh())}" stroke="var(--clear)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    for (let t = from; t <= to; t += 6 * HOUR) {
      const lbl = hhmm(t) === '00:00' ? dayWord(t, now) : hhmm(t).slice(0, 2);
      s += `<text x="${x(t)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="var(--ink-3)">${lbl}</text>`;
      if (hhmm(t) === '00:00') s += `<line x1="${x(t)}" x2="${x(t)}" y1="${padT}" y2="${H - padB}" stroke="var(--line)"/>`;
    }
    s += `<line x1="${x(now)}" x2="${x(now)}" y1="${padT}" y2="${H - padB}" stroke="var(--ink-3)" stroke-width="1"/>`;
    s += `<text x="${x(now)}" y="${padT + 8}" font-size="10" text-anchor="middle" fill="var(--ink-2)">עכשיו</text>`;
    s += `<path d="${path([...past, nowPt])}" fill="none" stroke="var(--hot)" stroke-width="2" stroke-linejoin="round"/>`;
    s += `<path d="${path([nowPt, ...fut])}" fill="none" stroke="var(--hot)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
    pts.filter(p => p.log).forEach(p => {
      s += `<circle cx="${x(p.t)}" cy="${y(p.T)}" r="5" fill="${OUT[p.log.outcome].c}" stroke="var(--surface)" stroke-width="2"/>`;
    });
    s += `<line class="cross" y1="${padT}" y2="${H - padB}" stroke="var(--ink-3)" visibility="hidden"/>`;
    s += `<rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent"/></svg><div class="tip"></div>`;
    host.innerHTML = s;

    const svg = host.querySelector('svg'), tip = host.querySelector('.tip'), cross = host.querySelector('.cross');
    const move = (ev) => {
      const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
      const sp = p.matrixTransform(svg.getScreenCTM().inverse());
      const t = from + (sp.x - padL) / (W - padL - padR) * (to - from);
      let best = pts[0];
      pts.forEach(q => { if (Math.abs(q.t - t) < Math.abs(best.t - t)) best = q; });
      cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
      const lg = (best.log ? `<br>${esc(member(best.log.member)?.name ?? '?')}: ${OUT[best.log.outcome].t}` : '') +
        (overlap(spans, best.t, best.t + 1) ? '<br>🔌 דוד חשמלי דלוק' : '');
      tip.innerHTML = `<b>${dayWord(best.t, now)} ${ltr(hhmm(best.t))}</b>${best.t > now ? ' (תחזית)' : ''}<br>${ltr('~' + fmt(best.T) + '°C')}${lg}`;
      tip.style.display = 'block';
      const box = host.getBoundingClientRect();
      let left = ev.clientX - box.left + 12;
      if (left + tip.offsetWidth > box.width) left = ev.clientX - box.left - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, ev.clientY - box.top - tip.offsetHeight - 8) + 'px';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  }

  // ---------- Events (delegated; the section is re-rendered on every change) ----------
  const uid = () => 'x' + Math.random().toString(36).slice(2, 10); // letter prefix keeps Sheets from reading it as a number

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !$('family').contains(b)) return;
    if (b.id === 'addMember') {
      const name = $('newName').value.trim();
      if (!name) return;
      commit([{ op: 'member', m: { id: uid(), name, liters: null, n: 0, skip: {} } }]);
      $('newName').focus();
    } else if (b.dataset.out) {
      const v = $('logTime').value;
      const t = v ? Date.parse(v + ':00Z') - wx.off : Date.now();
      const l = { id: uid(), member: $('logWho').value, t, outcome: b.dataset.out };
      const T0 = run(l.t).T;
      const m = member(l.member);
      const before = { liters: need(m), eff: cfg.eff, tau: cfg.tau, heaterEff: cfg.heaterEff };
      fam.logs.push(l);
      const ops = fit(); // adjusts cfg and members in place, and returns them as ops to share
      learnNote = { text: `נרשם ✓ לפי המודל היו בדוד ~${Math.round(T0)}°C. ${lesson(before, l)}`, at: Date.now() };
      commit([{ op: 'log', l }, ...ops]);
    } else if (b.dataset.delLog) {
      fam.logs = fam.logs.filter(l => l.id !== b.dataset.delLog);
      commit([{ op: 'delLog', id: b.dataset.delLog }, ...fit()]);
    } else if (b.dataset.delM) {
      const m = member(b.dataset.delM);
      if (!confirm(`למחוק את ${m.name}?`)) return;
      commit([{ op: 'delMember', id: m.id }]);
    } else if (b.dataset.up) {
      const i = +b.dataset.up;
      const ids = fam.members.map(x => x.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      commit([{ op: 'order', ids }]);
    } else if (b.id === 'exportBtn') {
      const blob = new Blob([JSON.stringify({ cfg, fam }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hotwatermeter.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (b.id === 'resetLearn') {
      if (!confirm('לאפס את מה שנלמד (ליטרים לכל אחד וכיול הדוד)? יומן המקלחות יישמר.')) return;
      commit([...fam.members.map(m => ({ op: 'member', m: { id: m.id, liters: null, n: 0 } })), { op: 'cfg', cfg: { eff: DEFAULTS.eff, heaterEff: DEFAULTS.heaterEff, tau: DEFAULTS.tau } }]);
    } else if (b.id === 'connectBtn') {
      b.disabled = true; b.textContent = 'מתחבר…';
      connect($('syncUrl').value, $('syncKey').value);
    } else if (b.dataset.boil) {
      const min = b.dataset.boil === 'open' ? null : +b.dataset.boil;
      commit([{ op: 'boiler', b: { id: uid(), t: Date.now(), min } }]);
    } else if (b.id === 'boilerOff') {
      const r = activeRun(Date.now());
      if (r) commit([{ op: 'boiler', b: { id: r.id, min: Math.floor((Date.now() - r.t) / 600) / 100 } }]); // rounded down so the run has ended by now
    } else if (b.id === 'boilAdd') {
      const v = $('boilStart').value, min = +$('boilMin').value;
      if (!v || !(min > 0)) return;
      commit([{ op: 'boiler', b: { id: uid(), t: Date.parse(v + ':00Z') - wx.off, min: Math.min(600, Math.round(min)) } }]);
    } else if (b.dataset.delBoil) {
      commit([{ op: 'delBoiler', id: b.dataset.delBoil }]);
    } else if (b.id === 'openShare') {
      $('shareBox').open = true;
      $('shareBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (b.id === 'createFam') {
      b.disabled = true; b.textContent = 'יוצר יומן…';
      createFamily($('famName').value).then(ok => {
        if (ok) { $('shareBox').open = true; $('shareMsg').textContent = 'היומן נוצר ✓ עכשיו שלחו את קישור ההצטרפות לבני המשפחה 👇'; }
      }).catch(err => { sync.err = err instanceof TypeError ? 'אין חיבור לשרת' : err.message; render(); });
    } else if (b.id === 'syncBtn') {
      syncNow();
    } else if (b.id === 'disconnect') {
      if (!confirm('לנתק את המכשיר הזה מהיומן המשותף? הנתונים יישארו בגיליון ובשאר הטלפונים.')) return;
      sync.conf = null; sync.outbox = []; sync.last = null; sync.err = null;
      store.set('hwm.sync', null); store.set('hwm.outbox', []);
      render();
    } else if (b.id === 'shareLink') {
      const url = joinLink();
      const done = (t) => { $('shareMsg').textContent = t; };
      if (navigator.share) navigator.share({ title: 'מד מים חמים', text: 'הצטרפות ליומן המקלחות של המשפחה', url }).catch(() => {});
      else navigator.clipboard.writeText(url).then(() => done('הקישור הועתק ✓ – שלחו אותו לבני המשפחה'), () => done(url));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'newName') $('addMember').click();
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!$('family').contains(el)) return;
    const row = el.closest('tr[data-id]');
    if (el.dataset.cfg) {
      const k = el.dataset.cfg;
      let v = null;
      if (k === 'morning' || k === 'evening') { if (el.value) v = el.value; }
      else if ((k === 'tin' || k === 'tshower') && el.value === '') { commit([{ op: 'cfg', cfg: { [k]: null } }]); return; }
      else if (el.value !== '' && isFinite(+el.value) && (+el.value > 0 || ['tin', 'azimuth', 'tilt', 'ul'].includes(k))) v = +el.value;
      if (v != null) {
        const before = panelKey();
        commit([{ op: 'cfg', cfg: { [k]: v } }]);
        if (panelKey() !== before && window.HWM) HWM.reload();
      } else render();
    } else if (row) {
      const m = member(row.dataset.id);
      const patch = { id: m.id };
      if (el.classList.contains('m-name')) { if (el.value.trim()) patch.name = el.value.trim(); }
      else if (el.classList.contains('m-slot')) patch.skip = Object.assign({}, m.skip, { [el.dataset.slot]: !el.checked });
      commit([{ op: 'member', m: patch }]);
    } else if (el.id === 'importFile' && el.files[0]) {
      el.files[0].text().then(txt => {
        const j = JSON.parse(txt);
        if (!j.fam || !Array.isArray(j.fam.members)) throw new Error('קובץ לא תקין');
        commit([{ op: 'replace', members: j.fam.members, logs: j.fam.logs || [], boilers: j.fam.boilers || [], cfg: Object.assign({}, cfg, j.cfg || {}) }]);
      }).catch(err => alert('ייבוא נכשל: ' + err.message));
    }
  });

  function onWeather(d) {
    const off = d.utc_offset_seconds * 1000;
    const gti = d.hourly.tank_gti || d.hourly.global_tilted_irradiance || d.hourly.shortwave_radiation; // for this family's collector
    const temps = d.hourly.temperature_2m.filter(v => v != null);
    wx = {
      off, lat: d.latitude, lon: d.longitude,
      airMean: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 20,
      hours: d.hourly.time.map((t, i) => {
        const end = Date.parse(t + ':00Z') - off;
        return { start: end - HOUR, end, gti: gti[i], ta: d.hourly.temperature_2m?.[i] };
      })
    };
    render();
  }
  document.addEventListener('hwm:weather', (e) => onWeather(e.detail));
  if (window.HWM && HWM.weather) onWeather(HWM.weather);

  // keep "now" fresh while the page stays open
  setInterval(() => { if (wx && !typing()) render(); }, 5 * 60000);

  // shared log: join via link, pull on start, every minute and when the app comes back to the foreground
  const joined = readJoinLink();
  if (joined && joined.u && joined.k) connect(joined.u, joined.k, joined.f);
  else syncNow();
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
})();
