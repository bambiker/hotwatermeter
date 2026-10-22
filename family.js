// Family hot-water planner: tank simulation, shower log and per-person learning.
// Listens for 'hwm:weather' (raw Open-Meteo response) dispatched by index.html.
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
    eff: 0.45,        // collector efficiency / calibration factor (learned)
    tin: 20,          // cold inlet water °C
    tshower: 40,      // comfortable shower temperature °C
    tau: 40,          // tank cooling time constant, hours
    heaterKw: 2.5,    // electric element power
    heaterMax: 60,    // electric element thermostat °C
    perPerson: 40,    // default liters of shower-temperature water per shower
    morning: '07:00',
    evening: '19:00'
  };
  const saved = store.get('hwm.tank', {});
  const cfg = Object.assign({}, DEFAULTS);
  Object.keys(DEFAULTS).forEach(k => { if (saved[k] != null && saved[k] !== '') cfg[k] = saved[k]; });
  const fam = Object.assign({ members: [], logs: [] }, store.get('hwm.family', {}));
  const saveCfg = () => store.set('hwm.tank', cfg);
  const saveFam = () => store.set('hwm.family', fam);

  let wx = null; // { off, hours: [{ start, end, ghi, ta }] }

  // ---------- Model ----------
  const member = (id) => fam.members.find(m => m.id === id);
  const need = (m) => (m && m.liters != null ? m.liters : cfg.perPerson);
  // °C the tank loses per liter of shower-temperature water (energy balance, fully mixed tank)
  const perLiter = () => Math.max(1, cfg.tshower - cfg.tin) / cfg.liters;
  const drawOf = (m) => need(m) * perLiter();
  const capacity = (T) => Math.max(0, (T - cfg.tshower) / perLiter()); // liters at shower temp

  function step(T, h) {
    const gain = (h.ghi || 0) * cfg.area * cfg.eff / 1000 * 3600 / (cfg.liters * CP);
    const ta = h.ta ?? cfg.tin;
    T += gain;
    T = ta + (T - ta) * Math.exp(-1 / cfg.tau);
    return Math.min(T, 95);
  }

  // A logged shower also corrects the simulated state to match what was observed
  function applyLog(T, l) {
    if (l.boiler) T = Math.max(T, cfg.heaterMax);
    const d = drawOf(member(l.member));
    if (l.outcome === 'full') T = Math.max(T - d, cfg.tshower);
    else if (l.outcome === 'partial') T = Math.min(T - d, cfg.tshower - 1);
    else T = Math.min(T - d, cfg.tshower - 3);
    return Math.max(T, cfg.tin);
  }

  // Simulates hour by hour; returns the tank temperature just before stopAt and the trace
  function run(stopAt = Infinity) {
    const H = wx.hours;
    const logs = fam.logs.filter(l => l.t >= H[0].start).sort((a, b) => a.t - b.t);
    let T = (H[0].ta ?? cfg.tin) + 5, li = 0;
    const pts = [];
    for (const h of H) {
      pts.push({ t: h.start, T });
      while (li < logs.length && logs[li].t < h.end && logs[li].t < stopAt) {
        T = applyLog(T, logs[li]);
        pts.push({ t: logs[li].t, T, log: logs[li] });
        li++;
      }
      if (h.end > stopAt) return { T, pts };
      T = step(T, h);
    }
    pts.push({ t: H[H.length - 1].end, T });
    return { T, pts };
  }

  // Learn from a shower outcome, using the tank state the model had just before it
  function learn(l) {
    if (l.boiler) return 'הדוד החשמלי היה דלוק – המקלחת נרשמה בלי ללמוד ממנה.';
    const T0 = run(l.t).T;
    const cap = capacity(T0);
    const m = member(l.member);
    const est = need(m);
    const clampEff = () => { cfg.eff = Math.min(0.9, Math.max(0.05, +cfg.eff.toFixed(3))); saveCfg(); };
    let msg = '';
    if (l.outcome === 'full') {
      if (T0 < cfg.tshower) { cfg.eff *= 1.1; clampEff(); msg = 'המודל העריך שהדוד קר מדי – כיול הדוד עודכן כלפי מעלה.'; }
      else if (m && est > cap) { m.liters = Math.round(est + 0.5 * (cap - est)); msg = `${m.name} כנראה צריך פחות מים – עודכן ל-${m.liters} ליטר.`; }
    } else if (l.outcome === 'partial') {
      if (cap < 5) { cfg.eff *= 1.05; clampEff(); msg = 'היו קצת מים חמים למרות שהמודל העריך שאין – כיול הדוד עודכן.'; }
      else if (m && est < cap) { m.liters = Math.round(est + 0.5 * (cap * 1.15 - est)); msg = `${m.name} כנראה צריך יותר מים – עודכן ל-${m.liters} ליטר.`; }
    } else if (T0 > cfg.tshower + 2) {
      cfg.eff *= 0.9; clampEff(); msg = 'המודל העריך שיש מים חמים ולא היו – כיול הדוד עודכן כלפי מטה.';
    }
    if (m) {
      if (m.liters != null) m.liters = Math.min(200, Math.max(5, m.liters));
      m.n = (m.n || 0) + 1;
    }
    const est0 = `לפי המודל היו בדוד ~${Math.round(T0)}°C (מספיק לכ-${Math.round(cap)} ל׳).`;
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
      T = Math.max(cfg.tin, T - d);
      return { m, st };
    });
    const needT = cfg.tshower + who.reduce((s, m) => s + drawOf(m), 0);
    const target = Math.min(needT, Math.max(cfg.heaterMax, T0));
    const minutes = T0 >= needT ? 0 : Math.ceil((target - T0) * cfg.liters * CP / 3600 / cfg.heaterKw * 60);
    // how many of the list get a full hot shower once the tank is at `target`
    let Th = target, withHeater = 0;
    for (const m of who) { if (Th - drawOf(m) < cfg.tshower - 0.05) break; Th -= drawOf(m); withHeater++; }
    return { T0, cap: capacity(T0), rows, minutes, withHeater, total: who.length };
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
    const advice = !p.rows.length ? `<p class="note">אפשר לשמור בערך ${ltr(fmt(p.cap) + ' ליטר')} מים ב-${cfg.tshower}°.</p>`
      : p.minutes === 0 ? '<p class="advice ok">✅ אין צורך להדליק דוד</p>'
      : p.minutes < 3 ? `<p class="advice warn">⚠️ הדוד כבר חם, אבל יספיק רק ל-${ltr(p.withHeater)} מתוך ${ltr(p.total)} ברצף – כדאי לפזר את המקלחות</p>`
      : `<p class="advice warn">🔌 להדליק דוד כ-${ltr(p.minutes)} דקות לפני${p.withHeater < p.total ? ` – יספיק ל-${ltr(p.withHeater)} מתוך ${ltr(p.total)} ברצף` : ''}</p>`;
    return `<div class="slot ${status}">
      <div class="slot-h"><b>${title}</b> <span class="note">${dayWord(t, now)} ${ltr(hhmm(t))}</span></div>
      <div class="slot-t">${ltr('~' + fmt(p.T0) + '°C')}</div>
      <ul class="who">${p.rows.map(r => `<li>${ICON[r.st]} ${esc(r.m.name)} <span class="note">${ltr(need(r.m) + ' ל׳')}</span></li>`).join('')}</ul>
      ${advice}
    </div>`;
  }

  function render() {
    const root = $('family');
    if (!wx) { root.innerHTML = ''; return; }
    const now = Date.now();
    const cur = run(now).T;
    const morning = nextAt(cfg.morning, now);
    const evening = nextAt(cfg.evening, now);
    const slots = [['עכשיו', now, 'now'], ['בוקר', morning, 'morning'], ['ערב', evening, 'evening']]
      .filter(s => s[1] <= wx.hours[wx.hours.length - 1].end)
      .sort((a, b) => a[1] - b[1]);
    const recent = [...fam.logs].sort((a, b) => b.t - a.t).slice(0, 12);
    const defaultTime = localStr(now).slice(0, 16);

    root.innerHTML = `
    <section class="card fam" id="tankCard">
      <h2>🚿 מצב הדוד</h2>
      <div class="tank-now">
        <div><div class="k">טמפ׳ משוערת עכשיו</div><div class="big">${ltr('~' + fmt(cur) + '°C')}</div></div>
        <div><div class="k">מים חמים זמינים</div><div class="big2">${ltr('~' + fmt(capacity(cur)) + ' ל׳')}</div><div class="note">ב-${cfg.tshower}°C</div></div>
      </div>
      <div class="chart" id="tankChart"></div>
      <div class="legend">
        <span><i style="background:var(--hot)"></i>טמפ׳ הדוד (תחזית בקו מקווקו)</span>
        <span><i style="background:none;border-top:2px dashed var(--clear);border-radius:0;height:0"></i>${cfg.tshower}°C – מקלחת נעימה</span>
        <span>● מקלחת שנרשמה</span>
      </div>
      ${fam.members.length ? '' : '<p class="note">הוסיפו בני משפחה (למטה) כדי לראות מי יכול להתקלח בכל זמן.</p>'}
      <div class="slots">${slots.map(s => slotCard(s[0], s[1], s[2], now)).join('')}</div>
      <p class="note">הסדר ברשימה הוא סדר המקלחות. ההערכה מניחה שהדוד החשמלי כבוי.</p>
    </section>

    <section class="card fam">
      <h2>📝 רישום מקלחת</h2>
      ${fam.members.length ? `
      <div class="log-form">
        <label>מי התקלח<select id="logWho">${fam.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
        <label>מתי<input id="logTime" type="datetime-local" value="${defaultTime}"></label>
        <label class="chk"><input id="logBoiler" type="checkbox"> הדוד החשמלי היה דלוק</label>
      </div>
      <div class="note">איך היו המים?</div>
      <div class="out-btns">
        ${Object.entries(OUT).map(([k, o]) => `<button type="button" data-out="${k}">${o.i} ${o.t}</button>`).join('')}
      </div>
      <div id="learnMsg" class="note"></div>` : '<p class="note">קודם מוסיפים בני משפחה.</p>'}
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

    <details class="card fam" id="cfgBox">
      <summary>⚙️ הגדרות הדוד</summary>
      <div class="grid-inputs">
        <label>נפח הדוד (ליטר)<input data-cfg="liters" type="number" min="30" step="10" value="${cfg.liters}"></label>
        <label>שטח קולטים (מ״ר)<input data-cfg="area" type="number" min="0.5" step="0.1" value="${cfg.area}"></label>
        <label>נצילות / כיול (נלמד אוטומטית)<input data-cfg="eff" type="number" min="0.05" max="0.9" step="0.01" value="${cfg.eff}"></label>
        <label>טמפ׳ מים קרים (°C)<input data-cfg="tin" type="number" step="1" value="${cfg.tin}"></label>
        <label>טמפ׳ מקלחת (°C)<input data-cfg="tshower" type="number" step="1" value="${cfg.tshower}"></label>
        <label>קצב התקררות – קבוע זמן (שעות)<input data-cfg="tau" type="number" min="5" step="1" value="${cfg.tau}"></label>
        <label>הספק גוף חימום (kW)<input data-cfg="heaterKw" type="number" min="0.5" step="0.5" value="${cfg.heaterKw}"></label>
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
      <p class="note">הנתונים נשמרים רק בדפדפן הזה. כדי להעביר לטלפון אחר – ייצוא ואז ייבוא.</p>
    </details>`;

    drawTankChart($('tankChart'), now);
    ['famBox', 'cfgBox'].forEach(id => {
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
    const yMin = Math.floor(Math.min(cfg.tin, ...pts.map(p => p.T)) / 10) * 10;
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
      const lg = best.log ? `<br>${esc(member(best.log.member)?.name ?? '?')}: ${OUT[best.log.outcome].t}` : '';
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
  const uid = () => Math.random().toString(36).slice(2, 10);

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !$('family').contains(b)) return;
    if (b.id === 'addMember') {
      const name = $('newName').value.trim();
      if (!name) return;
      fam.members.push({ id: uid(), name, liters: null, n: 0 });
      saveFam(); render();
      $('newName').focus();
    } else if (b.dataset.out) {
      const v = $('logTime').value;
      const t = v ? Date.parse(v + ':00Z') - wx.off : Date.now();
      const l = { id: uid(), member: $('logWho').value, t, outcome: b.dataset.out, boiler: $('logBoiler').checked };
      const msg = learn(l);
      fam.logs.push(l);
      saveFam(); render();
      $('learnMsg').textContent = 'נרשם ✓ ' + msg;
    } else if (b.dataset.delLog) {
      fam.logs = fam.logs.filter(l => l.id !== b.dataset.delLog);
      saveFam(); render();
    } else if (b.dataset.delM) {
      const m = member(b.dataset.delM);
      if (!confirm(`למחוק את ${m.name}?`)) return;
      fam.members = fam.members.filter(x => x.id !== m.id);
      fam.logs = fam.logs.filter(l => l.member !== m.id);
      saveFam(); render();
    } else if (b.dataset.up) {
      const i = +b.dataset.up;
      [fam.members[i - 1], fam.members[i]] = [fam.members[i], fam.members[i - 1]];
      saveFam(); render();
    } else if (b.id === 'exportBtn') {
      const blob = new Blob([JSON.stringify({ cfg, fam }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hotwatermeter.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (b.id === 'resetLearn') {
      if (!confirm('לאפס את מה שנלמד (ליטרים לכל אחד וכיול הדוד)? יומן המקלחות יישמר.')) return;
      fam.members.forEach(m => { m.liters = null; m.n = 0; });
      cfg.eff = DEFAULTS.eff;
      saveFam(); saveCfg(); render();
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
      if (k === 'morning' || k === 'evening') { if (el.value) cfg[k] = el.value; }
      else if (el.value !== '' && isFinite(+el.value) && +el.value > (k === 'tin' ? -10 : 0)) cfg[k] = +el.value;
      saveCfg(); render();
    } else if (row) {
      const m = member(row.dataset.id);
      if (el.classList.contains('m-name')) { if (el.value.trim()) m.name = el.value.trim(); }
      else if (el.classList.contains('m-liters')) m.liters = el.value === '' ? null : Math.min(200, Math.max(5, +el.value));
      else if (el.classList.contains('m-slot')) { m.skip = m.skip || {}; m.skip[el.dataset.slot] = !el.checked; }
      saveFam(); render();
    } else if (el.id === 'importFile' && el.files[0]) {
      el.files[0].text().then(txt => {
        const j = JSON.parse(txt);
        if (!j.fam || !Array.isArray(j.fam.members)) throw new Error('קובץ לא תקין');
        Object.assign(cfg, j.cfg || {});
        fam.members = j.fam.members; fam.logs = j.fam.logs || [];
        saveCfg(); saveFam(); render();
      }).catch(err => alert('ייבוא נכשל: ' + err.message));
    }
  });

  document.addEventListener('hwm:weather', (e) => {
    const d = e.detail;
    const off = d.utc_offset_seconds * 1000;
    wx = {
      off,
      hours: d.hourly.time.map((t, i) => {
        const end = Date.parse(t + ':00Z') - off;
        return { start: end - HOUR, end, ghi: d.hourly.shortwave_radiation[i], ta: d.hourly.temperature_2m?.[i] };
      })
    };
    render();
  });

  // keep "now" fresh while the page stays open
  setInterval(() => { if (wx && !document.querySelector('#family :focus')) render(); }, 5 * 60000);
})();
