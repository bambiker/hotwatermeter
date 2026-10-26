/**
 * Hot Water Meter – shared family storage on Google Sheets.
 *
 * Setup (once): see apps-script/README.md
 *   1. Run setup() from the editor (creates the tabs and a key for this sheet's own family).
 *   2. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 *
 * Two modes, both served by the same deployment:
 *   - Hosted: any family can create its own log in one tap. Each family gets a separate
 *     spreadsheet in the deployer's Drive and its own key; the "families" tab indexes them.
 *   - Single family: no family id, the key from setup(), data in this spreadsheet.
 *
 * POST { action: 'create', name }           → { ok, f, key }
 * POST { action: 'contact', name, email, message } → { ok }  (saved to the "messages" tab and emailed)
 * GET  ?f=…&key=…                           → { ok, state }
 * POST { f, key, ops: [...] } (text/plain)  → applies ops in order, returns { ok, state }
 * (omit f for single-family mode)
 */

// Shown at …/exec?version – to check which code a deployment is actually running
const VERSION = '2026-10-26 contact';

const MAX_NEW_FAMILIES_PER_DAY = 50;
const MAX_MESSAGES_PER_DAY = 30;
// Contact messages go to the script property CONTACT_EMAIL (Project Settings → Script properties),
// or to the Google account running the script. The address stays out of the public code.

const TABLES = {
  members: ['id', 'name', 'liters', 'n', 'skip_morning', 'skip_evening'],
  logs: ['id', 't', 'when', 'member_id', 'member_name', 'outcome', 'boiler'],
  boilers: ['id', 't', 'when', 'minutes'],
  config: ['key', 'value']
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABLES).forEach(t => sheet_(ss, t));
  index_();
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('KEY', key);
  }
  Logger.log('KEY: ' + key);
}

function doGet(e) {
  if ('version' in e.parameter) return json_({ ok: true, version: VERSION, contact: true });
  return handle_(e.parameter.f, e.parameter.key, null);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.action === 'create') return guard_(() => createFamily_(body.name));
  if (body.action === 'contact') return guard_(() => contact_(body));
  return handle_(body.f, body.key, body.ops || []);
}

function guard_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json_(fn());
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function handle_(f, key, ops) {
  return guard_(() => {
    const ss = open_(f, key);
    const st = readState_(ss);
    if (ops && ops.length) {
      ops.forEach(o => applyOp_(st, o));
      writeState_(ss, st);
    }
    return { ok: true, state: st };
  });
}

// Resolves and authorizes the spreadsheet holding a family's data
function open_(f, key) {
  if (!f) {
    const expected = PropertiesService.getScriptProperties().getProperty('KEY');
    if (!expected) throw new Error('run setup() first');
    if (key !== expected) throw new Error('bad key');
    return SpreadsheetApp.getActiveSpreadsheet();
  }
  const fam = rowsOf_(index_(), INDEX_COLS).find(r => r.id === f);
  if (!fam || fam.key_hash !== hash_(key)) throw new Error('bad key');
  return SpreadsheetApp.openById(fam.sheet_id);
}

const INDEX_COLS = ['id', 'key_hash', 'sheet_id', 'name', 'created'];

function index_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('families');
  if (!sh) {
    sh = ss.insertSheet('families');
    sh.getRange(1, 1, 1, INDEX_COLS.length).setValues([INDEX_COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:D').setNumberFormat('@');
  }
  return sh;
}

function contact_(b) {
  if (b.website) return { ok: true }; // honeypot: only bots fill the hidden field
  const message = String(b.message || '').trim().slice(0, 3000);
  if (message.length < 2) throw new Error('empty message');
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().slice(0, 200);
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  let quota = JSON.parse(props.getProperty('MESSAGES') || '{}');
  if (quota.d !== today) quota = { d: today, n: 0 };
  if (quota.n >= MAX_MESSAGES_PER_DAY) throw new Error('too many messages today');
  quota.n++;
  props.setProperty('MESSAGES', JSON.stringify(quota));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('messages');
  if (!sh) {
    sh = ss.insertSheet('messages');
    sh.getRange(1, 1, 1, 4).setValues([['when', 'name', 'email', 'message']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:D').setNumberFormat('@');
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[new Date(), name, email, message]]);

  const to = props.getProperty('CONTACT_EMAIL') || Session.getEffectiveUser().getEmail();
  const opts = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { replyTo: email } : {};
  MailApp.sendEmail(to, 'מד מים חמים – הודעה חדשה' + (name ? ' מ' + name : ''),
    message + '\n\n—\n' + (name || 'בלי שם') + (email ? ' · ' + email : ' · בלי מייל לחזרה'), opts);
  return { ok: true };
}

function createFamily_(name) {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
  let quota = JSON.parse(props.getProperty('NEW_FAMILIES') || '{}');
  if (quota.d !== today) quota = { d: today, n: 0 };
  if (quota.n >= MAX_NEW_FAMILIES_PER_DAY) throw new Error('too many new families today');
  quota.n++;
  props.setProperty('NEW_FAMILIES', JSON.stringify(quota));

  const f = 'f' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  const label = String(name || '').trim().slice(0, 40);
  const ss = SpreadsheetApp.create('מד מים חמים – ' + (label || f));
  const blank = ss.getSheets()[0];
  Object.keys(TABLES).forEach(t => sheet_(ss, t));
  ss.deleteSheet(blank);
  const sh = index_();
  sh.getRange(sh.getLastRow() + 1, 1, 1, INDEX_COLS.length).setValues([[f, hash_(key), ss.getId(), label, new Date()]]);
  return { ok: true, f, key };
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

// Same semantics as applyOp() in family.js
function applyOp_(st, o) {
  switch (o.op) {
    case 'member': {
      const i = st.members.findIndex(m => m.id === o.m.id);
      if (i >= 0) st.members[i] = Object.assign({}, st.members[i], o.m);
      else st.members.push(Object.assign({ liters: null, n: 0, skip: {} }, o.m));
      break;
    }
    case 'delMember':
      st.members = st.members.filter(m => m.id !== o.id);
      st.logs = st.logs.filter(l => l.member !== o.id);
      break;
    case 'log':
      if (!st.logs.some(l => l.id === o.l.id)) st.logs.push(o.l);
      break;
    case 'delLog':
      st.logs = st.logs.filter(l => l.id !== o.id);
      break;
    case 'boiler': {
      const i = st.boilers.findIndex(b => b.id === o.b.id);
      if (i >= 0) st.boilers[i] = Object.assign({}, st.boilers[i], o.b);
      else st.boilers.push(Object.assign({ min: null }, o.b));
      break;
    }
    case 'delBoiler':
      st.boilers = st.boilers.filter(b => b.id !== o.id);
      break;
    case 'cfg':
      Object.assign(st.cfg, o.cfg);
      break;
    case 'order':
      st.members.sort((a, b) => o.ids.indexOf(a.id) - o.ids.indexOf(b.id));
      break;
    case 'replace':
      st.members = o.members || [];
      st.logs = o.logs || [];
      st.boilers = o.boilers || [];
      st.cfg = o.cfg || {};
      break;
  }
}

function readState_(ss) {
  const members = rows_(ss, 'members').map(r => ({
    id: String(r.id),
    name: String(r.name),
    liters: r.liters === '' ? null : Number(r.liters),
    n: Number(r.n) || 0,
    skip: { morning: r.skip_morning === true, evening: r.skip_evening === true }
  }));
  const logs = rows_(ss, 'logs').map(r => ({
    id: String(r.id),
    t: Number(r.t),
    member: String(r.member_id),
    outcome: String(r.outcome),
    boiler: r.boiler === true
  }));
  const boilers = rows_(ss, 'boilers').map(r => ({
    id: String(r.id),
    t: Number(r.t),
    min: r.minutes === '' ? null : Number(r.minutes)
  }));
  const cfg = {};
  rows_(ss, 'config').forEach(r => {
    try { cfg[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; } catch (e) { cfg[r.key] = r.value; }
  });
  return { members, logs, boilers, cfg };
}

function writeState_(ss, st) {
  const names = {};
  st.members.forEach(m => { names[m.id] = m.name; });
  write_(ss, 'members', st.members.map(m => [m.id, m.name, m.liters == null ? '' : m.liters, m.n || 0,
    !!(m.skip && m.skip.morning), !!(m.skip && m.skip.evening)]));
  write_(ss, 'logs', st.logs.slice().sort((a, b) => a.t - b.t).map(l => [l.id, l.t, new Date(l.t), l.member,
    names[l.member] || '', l.outcome, !!l.boiler]));
  write_(ss, 'boilers', st.boilers.slice().sort((a, b) => a.t - b.t).map(b => [b.id, b.t, new Date(b.t),
    b.min == null ? '' : b.min]));
  write_(ss, 'config', Object.keys(st.cfg).map(k => [k, JSON.stringify(st.cfg[k])]));
}

function sheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // ids and JSON must stay text (e.g. "12e4" would otherwise become a number)
    sh.getRange('A:B').setNumberFormat('@');
    if (name === 'logs' || name === 'boilers') {
      sh.getRange('B:B').setNumberFormat('0');
      sh.getRange('C:C').setNumberFormat('yyyy-mm-dd hh:mm');
      if (name === 'logs') sh.getRange('D:D').setNumberFormat('@');
    }
  }
  return sh;
}

function rows_(ss, name) {
  return rowsOf_(sheet_(ss, name), TABLES[name]);
}

function rowsOf_(sh, head) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, head.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function write_(ss, name, data) {
  const sh = sheet_(ss, name);
  const w = TABLES[name].length;
  const old = sh.getLastRow() - 1;
  if (old > 0) sh.getRange(2, 1, old, w).clearContent();
  if (data.length) sh.getRange(2, 1, data.length, w).setValues(data);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
