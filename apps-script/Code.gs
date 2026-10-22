/**
 * Hot Water Meter – shared family storage on Google Sheets.
 *
 * Setup (once): see apps-script/README.md
 *   1. Run setup() from the editor and copy the key it logs.
 *   2. Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 *   3. In the site: Settings → "שיתוף עם המשפחה", paste the web-app URL and the key.
 *
 * GET  ?key=…                      → { ok, state }
 * POST { key, ops: [...] } (text)  → applies ops in order, returns { ok, state }
 */

const TABLES = {
  members: ['id', 'name', 'liters', 'n', 'skip_morning', 'skip_evening'],
  logs: ['id', 't', 'when', 'member_id', 'member_name', 'outcome', 'boiler'],
  config: ['key', 'value']
};

function setup() {
  Object.keys(TABLES).forEach(sheet_);
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('KEY', key);
  }
  Logger.log('KEY: ' + key);
}

function doGet(e) {
  return handle_(e.parameter.key, null);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  return handle_(body.key, body.ops || []);
}

function handle_(key, ops) {
  const expected = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!expected) return json_({ error: 'run setup() first' });
  if (key !== expected) return json_({ error: 'bad key' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const st = readState_();
    if (ops && ops.length) {
      ops.forEach(o => applyOp_(st, o));
      writeState_(st);
    }
    return json_({ ok: true, state: st });
  } finally {
    lock.releaseLock();
  }
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
    case 'cfg':
      Object.assign(st.cfg, o.cfg);
      break;
    case 'order':
      st.members.sort((a, b) => o.ids.indexOf(a.id) - o.ids.indexOf(b.id));
      break;
    case 'replace':
      st.members = o.members || [];
      st.logs = o.logs || [];
      st.cfg = o.cfg || {};
      break;
  }
}

function readState_() {
  const members = rows_('members').map(r => ({
    id: String(r.id),
    name: String(r.name),
    liters: r.liters === '' ? null : Number(r.liters),
    n: Number(r.n) || 0,
    skip: { morning: r.skip_morning === true, evening: r.skip_evening === true }
  }));
  const logs = rows_('logs').map(r => ({
    id: String(r.id),
    t: Number(r.t),
    member: String(r.member_id),
    outcome: String(r.outcome),
    boiler: r.boiler === true
  }));
  const cfg = {};
  rows_('config').forEach(r => {
    try { cfg[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; } catch (e) { cfg[r.key] = r.value; }
  });
  return { members, logs, cfg };
}

function writeState_(st) {
  const names = {};
  st.members.forEach(m => { names[m.id] = m.name; });
  write_('members', st.members.map(m => [m.id, m.name, m.liters == null ? '' : m.liters, m.n || 0,
    !!(m.skip && m.skip.morning), !!(m.skip && m.skip.evening)]));
  write_('logs', st.logs.slice().sort((a, b) => a.t - b.t).map(l => [l.id, l.t, new Date(l.t), l.member,
    names[l.member] || '', l.outcome, !!l.boiler]));
  write_('config', Object.keys(st.cfg).map(k => [k, JSON.stringify(st.cfg[k])]));
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // ids and JSON must stay text (e.g. "12e4" would otherwise become a number)
    sh.getRange('A:B').setNumberFormat('@');
    if (name === 'logs') {
      sh.getRange('B:B').setNumberFormat('0');
      sh.getRange('C:C').setNumberFormat('yyyy-mm-dd hh:mm');
      sh.getRange('D:D').setNumberFormat('@');
    }
  }
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const head = TABLES[name];
  return sh.getRange(2, 1, n, head.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function write_(name, data) {
  const sh = sheet_(name);
  const w = TABLES[name].length;
  const old = sh.getLastRow() - 1;
  if (old > 0) sh.getRange(2, 1, old, w).clearContent();
  if (data.length) sh.getRange(2, 1, data.length, w).setValues(data);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
