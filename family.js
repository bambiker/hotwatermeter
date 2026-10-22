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
    tshower: 40,      // comfortable shower temperature °C
    tau: 40,          // tank cooling time constant, hours
    heaterKw: 2.5,    // electric element power
    heaterEff: 1,     // how much of the element's nominal heat reaches usable water (learned)
    heaterMax: 60,    // electric element thermostat °C
    perPerson: 40,    // default liters of shower-temperature water per shower
    morning: '07:00',
    evening: '19:00'
  };
  // model 2: tilted-collector irradiance with temperature-dependent losses. Calibration learned
  // under the old horizontal model doesn't carry over, so it starts again.
  const MODEL = 2;
  const MODEL_RESET = { eff: DEFAULTS.eff, tin: null, model: MODEL };
  const saved = store.get('hwm.tank', {});
  if (saved.model !== MODEL) Object.assign(saved, MODEL_RESET);
  const cfg = Object.assign({}, DEFAULTS, { model: MODEL });
  Object.keys(DEFAULTS).forEach(k => { if (saved[k] != null && saved[k] !== '') cfg[k] = saved[k]; });
  const fam = Object.assign({ members: [], logs: [], boilers: [] }, store.get('hwm.family', {}));
  const saveLocal = () => { store.set('hwm.tank', cfg); store.set('hwm.family', fam); };

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
      sync.outbox.push({ op: 'cfg', cfg: MODEL_RESET });
      applyOp({ op: 'cfg', cfg: MODEL_RESET });
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
  const perLiter = () => Math.max(1, cfg.tshower - tin()) / cfg.liters;
  // Mains water follows the season: by default the average air temperature of the last days
  function tin() {
    if (cfg.tin != null) return cfg.tin;
    const t = wx ? wx.hours.map(h => h.ta).filter(v => v != null) : [];
    return t.length ? Math.round(Math.min(26, Math.max(12, t.reduce((a, b) => a + b, 0) / t.length))) : 20;
  }
  const drawOf = (m) => need(m) * perLiter();
  // How much shower-temperature water the tank can still give before it drops to shower temperature
  // (used only for learning; cold water mixes in as hot is drawn, see perLiter)
  const capacity = (T) => Math.max(0, (T - cfg.tshower) / perLiter());

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
    return q > 0 ? q * 3600 * hrs / 1000 / (cfg.liters * CP) : 0; // thermosiphon stops when it would lose heat
  }

  // One step [a, b) inside weather hour h: solar gain, electric element (up to its thermostat), cooling
  function step(T, h, a, b, spans, sun) {
    const hrs = (b - a) / HOUR;
    T += sun;
    const on = overlap(spans, a, b) / HOUR;
    if (on > 0 && T < cfg.heaterMax) T = Math.min(cfg.heaterMax, T + cfg.heaterKw * cfg.heaterEff * 3600 * on / (cfg.liters * CP));
    const ta = h.ta ?? tin();
    T = ta + (T - ta) * Math.exp(-hrs / cfg.tau);
    return Math.min(T, 95);
  }

  // A logged shower also corrects the simulated state to match what was observed
  function applyLog(T, l) {
    if (l.boiler) T = Math.max(T, cfg.heaterMax); // showers logged before boiler runs had their own log
    const d = drawOf(member(l.member));
    if (l.outcome === 'full') T = Math.max(T - d, cfg.tshower);
    else if (l.outcome === 'partial') T = Math.min(T - d, cfg.tshower - 1);
    else T = Math.min(T - d, cfg.tshower - 3);
    return Math.max(T, tin());
  }

  // Simulates in 15-minute steps; returns the tank temperature just before stopAt, the trace,
  // and the solar heating per local date ({ total, soFar } in °C)
  function run(stopAt = Infinity) {
    const H = wx.hours, now = Date.now(), spans = spansOf(now);
    const logs = fam.logs.filter(l => l.t >= H[0].start).sort((a, b) => a.t - b.t);
    let T = (H[0].ta ?? tin()) + 5, li = 0;
    const pts = [], gains = {};
    for (const h of H) {
      for (let a = h.start; a < h.end; a += STEP) {
        const b = a + STEP;
        pts.push({ t: a, T });
        while (li < logs.length && logs[li].t < b && logs[li].t < stopAt) {
          T = applyLog(T, logs[li]);
          pts.push({ t: logs[li].t, T, log: logs[li] });
          li++;
        }
        if (b > stopAt) return { T, pts, gains };
        const sun = solarGain(T, h, (b - a) / HOUR);
        const g = gains[localStr(a).slice(0, 10)] ||= { total: 0, soFar: 0 };
        g.total += sun;
        if (b <= now) g.soFar += sun;
        T = step(T, h, a, b, spans, sun);
      }
    }
    pts.push({ t: H[H.length - 1].end, T });
    return { T, pts, gains };
  }

  // 100 = the best clear day of the year for this tank: same model on clear-sky sun, a mild day
  // (25°C air) and a lukewarm tank (40°C) at dawn
  let refCache = { key: '', gain: 1 };
  function refGain() {
    const key = [wx.lat, wx.lon, cfg.tilt, cfg.azimuth, cfg.area, cfg.eff, cfg.ul, cfg.liters].join('|');
    if (refCache.key === key) return refCache.gain;
    const y = new Date().getUTCFullYear();
    let best = 1;
    for (let doy = 0; doy < 365; doy += 7) {
      const day = Date.UTC(y, 0, 1) + doy * DAY - wx.off; // local midnight
      let T = 40, gain = 0;
      for (let hr = 1; hr <= 24; hr++) {
        const h = { gti: HWM.clearSkyHourMean(day + hr * HOUR, wx.lat, wx.lon, cfg.tilt, cfg.azimuth), ta: 25 };
        for (let q = 0; q < 4; q++) { const s = solarGain(T, h, 0.25); gain += s; T += s; }
      }
      best = Math.max(best, gain);
    }
    refCache = { key, gain: best };
    return best;
  }

  // Exposed to index.html for the daily cards
  function heatByDate() {
    const gains = run().gains, ref = refGain(), out = {};
    for (const [date, g] of Object.entries(gains)) {
      out[date] = { gain: g.total, gainSoFar: g.soFar, score: Math.min(100, Math.round(g.total / ref * 100)) };
    }
    return out;
  }

  // Learn from a shower outcome, using the tank state the model had just before it
  function learn(l) {
    const T0 = run(l.t).T;
    const cap = capacity(T0);
    const m = member(l.member);
    const est = need(m);
    // A tank-level surprise is blamed on the electric element if it ran in the 8 hours before, else on the solar side
    const electric = overlap(spansOf(l.t), l.t - 8 * HOUR, l.t) > 0;
    const what = electric ? 'כיול הדוד החשמלי' : 'כיול הקולטים';
    const tune = (up) => {
      if (electric) cfg.heaterEff = Math.min(2, Math.max(0.3, +(cfg.heaterEff * (up ? 1.15 : 0.85)).toFixed(3)));
      else cfg.eff = Math.min(1, Math.max(0.2, +(cfg.eff * (up ? 1.1 : 0.9)).toFixed(3)));
    };
    let msg = '';
    if (l.outcome === 'full') {
      if (T0 < cfg.tshower) { tune(true); msg = `המודל העריך שהדוד קר מדי – ${what} עודכן כלפי מעלה.`; }
      else if (m && est > cap) { m.liters = Math.round(est + 0.5 * (cap - est)); msg = `${m.name} כנראה צריך פחות מים – עודכן ל-${m.liters} ליטר.`; }
    } else if (l.outcome === 'partial') {
      if (cap < 5) { tune(true); msg = `היו קצת מים חמים למרות שהמודל העריך שאין – ${what} עודכן.`; }
      else if (m && est < cap) { m.liters = Math.round(est + 0.5 * (cap * 1.15 - est)); msg = `${m.name} כנראה צריך יותר מים – עודכן ל-${m.liters} ליטר.`; }
    } else if (T0 > cfg.tshower + 2) {
      tune(false); msg = `המודל העריך שיש מים חמים ולא היו – ${what} עודכן כלפי מטה.`;
    }
    if (m) {
      if (m.liters != null) m.liters = Math.min(200, Math.max(5, m.liters));
      m.n = (m.n || 0) + 1;
    }
    const est0 = `לפי המודל היו בדוד ~${Math.round(T0)}°C.`;
    return est0 + ' ' + (msg || 'תואם את ההערכה – לא היה צריך לעדכן.');
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
      const st = T - d >= cfg.tshower - 0.05 ? 'ok' : T > cfg.tshower ? 'partial' : 'cold';
      T = Math.max(tin(), T - d);
      return { m, st };
    });
    const needT = cfg.tshower + who.reduce((s, m) => s + drawOf(m), 0);
    const target = Math.min(needT, Math.max(cfg.heaterMax, T0));
    const minutes = T0 >= needT ? 0 : Math.ceil((target - T0) * cfg.liters * CP / 3600 / (cfg.heaterKw * cfg.heaterEff) * 60);
    // how many of the list get a full hot shower once the tank is at `target`
    let Th = target, withHeater = 0;
    for (const m of who) { if (Th - drawOf(m) < cfg.tshower - 0.05) break; Th -= drawOf(m); withHeater++; }
    return { T0, rows, minutes, withHeater, total: who.length };
  }

  // ---------- Rendering ----------
  const ICON = { ok: '✅', partial: '⚠️', cold: '❌' };
  const OUT = {
    full: { t: 'חם עד הסוף', i: '✅', c: 'var(--good)' },
    partial: { t: 'נגמר באמצע', i: '⚠️', c: 'var(--mid)' },
    none: { t: 'לא היו מים חמים', i: '❌', c: 'var(--bad)' }
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
      <ul class="who">${p.rows.map(r => `<li>${ICON[r.st]} ${esc(r.m.name)} <span class="note">${ltr(need(r.m) + ' ל׳')}</span></li>`).join('')}</ul>
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

    root.innerHTML = `
    <section class="card fam" id="tankCard">
      <h2>🚿 מצב הדוד</h2>
      ${sync.conf ? `<div class="note sync-status">${syncStatusText()}</div>` : '<button type="button" id="openShare" class="linkish">🔗 לשתף את היומן עם כל המשפחה</button>'}
      <div class="tank-now">
        <div><div class="k">טמפ׳ משוערת עכשיו</div><div class="big">${ltr('~' + fmt(cur) + '°C')}</div></div>
        <div class="note drop">כל מקלחת של ${ltr(cfg.perPerson)} ליטר מכניסה לדוד מים קרים ומורידה אותו בכ-${ltr(fmt(cfg.perPerson * perLiter(), 1) + '°')}</div>
      </div>
      <div class="chart" id="tankChart"></div>
      <div class="legend">
        <span><i style="background:var(--hot)"></i>טמפ׳ הדוד (תחזית בקו מקווקו)</span>
        <span><i style="background:none;border-top:2px dashed var(--clear);border-radius:0;height:0"></i>${cfg.tshower}°C – מקלחת נעימה</span>
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
      <div class="note">איך היו המים?</div>
      <div class="out-btns">
        ${Object.entries(OUT).map(([k, o]) => `<button type="button" data-out="${k}">${o.i} ${o.t}</button>`).join('')}
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
      <p class="note">כמה ליטר מים ב-${cfg.tshower}°C כל אחד צריך למקלחת. בהתחלה משתמשים בברירת המחדל (${cfg.perPerson} ל׳), ואחרי כל מקלחת שנרשמת המספר מתעדכן.</p>
      ${fam.members.length ? `<table class="members"><thead><tr><th>שם</th><th>ליטר למקלחת</th><th>נלמד מ-</th><th>בוקר</th><th>ערב</th><th></th><th></th></tr></thead><tbody>
        ${fam.members.map((m, i) => `<tr data-id="${m.id}">
          <td><input class="m-name" value="${esc(m.name)}" aria-label="שם"></td>
          <td><input class="m-liters" type="number" min="5" max="200" step="1" value="${m.liters ?? ''}" placeholder="${cfg.perPerson} (ברירת מחדל)" aria-label="ליטר"></td>
          <td>${m.n ? ltr(m.n) + ' מקלחות' : '<span class="note">ברירת מחדל</span>'}</td>
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
        <label>נפח הדוד (ליטר)<input data-cfg="liters" type="number" min="30" step="10" value="${cfg.liters}"></label>
        <label>שטח קולטים (מ״ר)<input data-cfg="area" type="number" min="0.5" step="0.1" value="${cfg.area}"></label>
        <label>זווית הקולטים (מעלות מהאופק)<input data-cfg="tilt" type="number" min="0" max="90" step="5" value="${cfg.tilt}"></label>
        <label>כיוון הקולטים<select data-cfg="azimuth">${[[0, 'דרום'], [-45, 'דרום-מזרח'], [45, 'דרום-מערב'], [-90, 'מזרח'], [90, 'מערב']]
          .map(([v, t]) => `<option value="${v}" ${+cfg.azimuth === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>נצילות / כיול (נלמד אוטומטית)<input data-cfg="eff" type="number" min="0.2" max="1" step="0.01" value="${cfg.eff}"></label>
        <label>הפסדי חום של הקולט (W/m²·°C)<input data-cfg="ul" type="number" min="0" max="20" step="0.5" value="${cfg.ul}"></label>
        <label>טמפ׳ מים קרים (°C)<input data-cfg="tin" type="number" step="1" value="${cfg.tin ?? ''}" placeholder="אוטומטי לפי העונה (~${tin()}°)"></label>
        <label>טמפ׳ מקלחת (°C)<input data-cfg="tshower" type="number" step="1" value="${cfg.tshower}"></label>
        <label>קצב התקררות – קבוע זמן (שעות)<input data-cfg="tau" type="number" min="5" step="1" value="${cfg.tau}"></label>
        <label>הספק גוף חימום (kW)<input data-cfg="heaterKw" type="number" min="0.5" step="0.5" value="${cfg.heaterKw}"></label>
        <label>יעילות הדוד החשמלי (נלמד אוטומטית)<input data-cfg="heaterEff" type="number" min="0.3" max="2" step="0.05" value="${cfg.heaterEff}"></label>
        <label>טרמוסטט הדוד החשמלי (°C)<input data-cfg="heaterMax" type="number" step="1" value="${cfg.heaterMax}"></label>
        <label>ברירת מחדל לאדם (ליטר)<input data-cfg="perPerson" type="number" min="5" step="5" value="${cfg.perPerson}"></label>
        <label>שעת מקלחות בוקר<input data-cfg="morning" type="time" value="${cfg.morning}"></label>
        <label>שעת מקלחות ערב<input data-cfg="evening" type="time" value="${cfg.evening}"></label>
      </div>
      <p class="note">קבוע זמן 40 שעות ≈ דוד מבודד היטב שמאבד כ-10° בלילה. אם המים בבוקר קרים מהצפוי – להקטין.</p>
      <div class="add-row">
        <button type="button" id="exportBtn">⬇️ ייצוא נתונים</button>
        <label class="file-btn">⬆️ ייבוא נתונים<input id="importFile" type="file" accept="application/json" hidden></label>
        <button type="button" id="resetLearn">↺ איפוס הלמידה</button>
      </div>
      <p class="note">${sync.conf ? 'ההגדרות ומיקום הבית משותפים לכל המשפחה.' : 'בלי שיתוף, הנתונים נשמרים רק בדפדפן הזה.'}</p>
    </details>`;

    drawTankChart($('tankChart'), now);
    placeHome();
    heatCache = heatByDate();
    if (window.HWM) HWM.renderDays();
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
    const yMax = Math.ceil(Math.max(cfg.tshower + 10, ...pts.map(p => p.T)) / 10) * 10;
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
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(cfg.tshower)}" y2="${y(cfg.tshower)}" stroke="var(--clear)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
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
      learnNote = { text: 'נרשם ✓ ' + learn(l), at: Date.now() }; // learn() updates the member's liters / cfg in place
      const m = member(l.member);
      commit([{ op: 'log', l }, { op: 'member', m: { id: m.id, liters: m.liters, n: m.n } }, { op: 'cfg', cfg: { eff: cfg.eff, heaterEff: cfg.heaterEff } }]);
    } else if (b.dataset.delLog) {
      commit([{ op: 'delLog', id: b.dataset.delLog }]);
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
      commit([...fam.members.map(m => ({ op: 'member', m: { id: m.id, liters: null, n: 0 } })), { op: 'cfg', cfg: { eff: DEFAULTS.eff, heaterEff: DEFAULTS.heaterEff } }]);
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
      else if (k === 'tin' && el.value === '') { commit([{ op: 'cfg', cfg: { tin: null } }]); return; }
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
      else if (el.classList.contains('m-liters')) patch.liters = el.value === '' ? null : Math.min(200, Math.max(5, +el.value));
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
    const gti = d.hourly.global_tilted_irradiance || d.hourly.shortwave_radiation;
    wx = {
      off, lat: d.latitude, lon: d.longitude,
      hours: d.hourly.time.map((t, i) => {
        const end = Date.parse(t + ':00Z') - off;
        return { start: end - HOUR, end, gti: gti[i], ta: d.hourly.temperature_2m?.[i] };
      })
    };
    render();
  }
  if (window.HWM) HWM.heat = (date) => (wx ? heatCache[date] ?? null : null);
  let heatCache = {};
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
