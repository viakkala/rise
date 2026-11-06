// Rise reminders: reads today's list from Firebase and sends it to the user's phone as a notification.
// Run by .github/workflows/reminders.yml on a schedule. Usage: node notify.mjs morning|midday|evening|weekend [--dry]
//
// Needs these environment variables (set as GitHub secrets / workflow env):
//   RISE_BOT_EMAIL, RISE_BOT_PASSWORD  - a read-only Firebase account used just for reminders
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY - the web push keys (the public one is also in index.html)
import webpush from 'web-push';

const FB = { apiKey: 'AIzaSyCEzVsLJ-UasGfJiGzci5qRbCedZAxZoig', projectId: 'rise-app-5fd59' };
const AUTH_URL = process.env.RISE_AUTH_URL || 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const FS_URL = process.env.RISE_FS_URL || 'https://firestore.googleapis.com/v1/';
const DOCS_ROOT = 'projects/' + FB.projectId + '/databases/(default)/documents';
const PARENT = DOCS_ROOT + '/households/main';
const ME_TIME = 'Me Time';
const JS_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_TITLES = 6;

const mode = process.argv[2] || 'morning';
const dry = process.argv.includes('--dry');
if (!['morning', 'midday', 'evening', 'weekend'].includes(mode)) { console.error('Unknown mode ' + mode); process.exit(2); }

// The family's day runs on India time, whatever timezone GitHub's machine is in.
function indiaNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.RISE_TZ || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(process.env.RISE_NOW ? new Date(process.env.RISE_NOW) : new Date()).map((p) => [p.type, p.value]));
  return { date: parts.year + '-' + parts.month + '-' + parts.day, day: parts.weekday.slice(0, 3).toLowerCase() };
}

async function http(url, opts) {
  const r = await fetch(url, opts);
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ((j && j.error && j.error.message) || (Array.isArray(j) && j[0] && j[0].error && j[0].error.message) || url));
  return j;
}

async function signIn() {
  const j = await http(AUTH_URL + '?key=' + FB.apiKey, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.RISE_BOT_EMAIL, password: process.env.RISE_BOT_PASSWORD, returnSecureToken: true })
  });
  return j.idToken;
}

async function loadAll(token) {
  const out = {};
  let cursor = '1970-01-01T00:00:00Z', op = 'GREATER_THAN';
  for (let page = 0; page < 50; page++) {
    const res = await http(FS_URL + PARENT + ':runQuery', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'items' }],
        where: { fieldFilter: { field: { fieldPath: 'u' }, op, value: { timestampValue: cursor } } },
        orderBy: [{ field: { fieldPath: 'u' }, direction: 'ASCENDING' }],
        limit: 1000
      } })
    });
    const docs = (res || []).filter((x) => x.document).map((x) => x.document);
    let fresh = 0;
    for (const d of docs) {
      const key = d.name.split('/').pop();
      if (key in out) continue;
      fresh++;
      const f = d.fields || {};
      if (f.del && f.del.booleanValue) { out[key] = null; continue; }
      try { out[key] = JSON.parse((f.json && f.json.stringValue) || 'null'); } catch (e) { out[key] = null; }
    }
    if (docs.length < 1000 || !fresh) break;
    cursor = docs[docs.length - 1].fields.u.timestampValue; op = 'GREATER_THAN_OR_EQUAL';
  }
  return out;
}

function pick(all, col) {
  return Object.keys(all).filter((k) => k.startsWith(col + '__') && all[k]).map((k) => ({ key: k, v: all[k] }));
}
const hasProgress = (t) => t.timeSpent > 0 || (t.progress || 0) > 0 || (t.subtasks || []).some((s) => s.done) || !!t.runningSince;
const pct = (t) => {
  const subs = t.subtasks || [];
  const steps = subs.length ? Math.round(subs.filter((s) => s.done).length / subs.length * 100) : 0;
  return Math.max(t.progress || 0, steps);
};
const awayBlocks = (cat, plan) => !!(plan && plan.away && (plan.awayKeep || []).indexOf(cat) < 0);
const isSkipped = (tp, plan) => !!plan && ((plan.skip || []).includes(tp.id) || (awayBlocks(tp.category, plan) && !(plan.keep || []).includes(tp.id)));

// Today's open list. If a phone already opened Rise today, the cloud has the real list.
// Otherwise this works it out the same way the app's day change does: carried-over work, today's routine, planned follow-ups.
export function todaysList(all, today, dayId) {
  const meta = all.meta__config || {};
  const carryOver = !(meta.settings && meta.settings.carryOver === false);
  const plan = all['plan__' + today] || null;
  let tasks = pick(all, 'tasks').map((x) => x.v);
  if (meta.lastSeedDate !== today) {
    const held = pick(all, 'held').map((x) => x.v);
    tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped' && (t.assignee || t.kind === 'weekend' || (carryOver && hasProgress(t))))
      .map((t) => ({ ...t, carried: true }))
      .concat(held.map((t) => ({ ...t, carried: true })))
      .filter((t) => !awayBlocks(t.category, plan));
    const tpl = (all['tpl__' + dayId] && all['tpl__' + dayId].items) || [];
    const ids = new Set(tasks.map((t) => t.templateId).filter(Boolean));
    const titles = new Set(tasks.map((t) => t.title.toLowerCase() + '|' + t.category));
    for (const tp of tpl) {
      if (ids.has(tp.id) || titles.has(tp.title.toLowerCase() + '|' + tp.category) || isSkipped(tp, plan)) continue;
      tasks.push({ title: tp.title, category: tp.category, kind: tp.kind || 'normal', status: 'active', templateId: tp.id, subtasks: [] });
    }
    for (const { v: sc } of pick(all, 'sched')) {
      if (sc.date !== today || !sc.task || awayBlocks(sc.task.category, plan)) continue;
      const t = sc.task;
      if (t.replaces) {
        const i = tasks.findIndex((o) => o.title.toLowerCase() === t.replaces.toLowerCase() && !hasProgress(o));
        if (i < 0 && tpl.some((tp) => tp.title.toLowerCase() === t.replaces.toLowerCase() && isSkipped(tp, plan))) continue;
        if (i >= 0) tasks.splice(i, 1);
      }
      tasks.push(t);
    }
  }
  // Tasks handed to Love are Love's, not the user's: leave them out of the user's reminders.
  tasks = tasks.filter((t) => !t.assignee);
  return { open: tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped'), all: tasks, away: !!(plan && plan.away) };
}

function label(t) {
  const p = pct(t);
  return t.title + (t.carried && p > 0 ? ' (' + p + '% done)' : '');
}
function listText(ts) {
  const names = ts.slice(0, MAX_TITLES).map(label);
  return names.join(' · ') + (ts.length > MAX_TITLES ? ' · +' + (ts.length - MAX_TITLES) + ' more' : '');
}
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

export function buildMessage(mode, list, dayId) {
  const open = list.open;
  // Me Time is the reward, not a chore: it's mentioned in the morning but never nagged about.
  const chores = open.filter((t) => t.category !== ME_TIME);
  const me = open.filter((t) => t.category === ME_TIME);
  const order = (ts) => ts.slice().sort((a, b) => (b.kind === 'weekend') - (a.kind === 'weekend') || (b.carried ? 1 : 0) - (a.carried ? 1 : 0));
  if (mode === 'morning') {
    if (!open.length) return null;
    return {
      title: (list.away ? '✈ ' : '☀️ ') + plural(chores.length, 'thing') + ' for today' + (me.length ? ' + Me Time' : ''),
      body: listText(order(chores)) + (me.length ? (chores.length ? '\n' : '') + '🎬 Me Time: ' + me.map((t) => t.title).join(' · ') : '')
    };
  }
  if (mode === 'midday') {
    if (!chores.length) return null;
    const done = list.all.filter((t) => t.status === 'done').length;
    return {
      title: '🌤 ' + plural(chores.length, 'thing') + ' left' + (done ? ', ' + done + ' done already' : ''),
      body: listText(order(chores)) + '\nAny small step counts.'
    };
  }
  if (mode === 'evening') {
    const plans = chores.filter((t) => t.kind === 'plan');
    const rest = chores.filter((t) => t.kind !== 'plan');
    if (!chores.length) return null;
    return {
      title: '🌙 Evening check: ' + chores.length + ' left',
      body: (plans.length ? 'Plan ahead: ' + plans.map((t) => t.title).join(' · ') + (rest.length ? '\n' : '') : '') +
            (rest.length ? (plans.length ? 'Also open: ' : '') + listText(order(rest)) : '')
    };
  }
  if (mode === 'weekend') {
    const wk = open.filter((t) => t.kind === 'weekend');
    if (!wk.length) return null;
    return { title: '🗓 ' + wk[0].title, body: 'Still open. Ten calm minutes tonight makes Saturday and Sunday easier for everyone.' };
  }
  return null;
}

async function removeSub(token, key) {
  await http(FS_URL + DOCS_ROOT + ':commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ writes: [{ delete: PARENT + '/items/' + key }] })
  });
}

async function main() {
  const { date, day } = indiaNow();
  const dayId = JS_DAY.includes(day) ? day : 'mon';
  const token = await signIn();
  const all = await loadAll(token);
  const list = todaysList(all, date, dayId);
  const msg = buildMessage(mode, list, dayId);
  console.log('[' + date + ' ' + mode + '] open: ' + list.open.length + ' of ' + list.all.length);
  if (!msg) { console.log('Nothing to send.'); return; }
  console.log(msg.title + '\n' + msg.body);
  const subs = pick(all, 'push').filter((x) => x.v.role === 'user' && x.v.sub && x.v.sub.endpoint);
  if (!subs.length) { console.log('No phone has turned on reminders yet.'); return; }
  if (dry) { console.log('(dry run: not sent to ' + subs.length + ' phone(s))'); return; }
  webpush.setVapidDetails('mailto:rise-reminders@users.noreply.github.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: 'rise-' + mode, url: './index.html' });
  let sent = 0;
  for (const { key, v } of subs) {
    try {
      await webpush.sendNotification(v.sub, payload, { TTL: 4 * 3600, urgency: 'normal' });
      sent++;
    } catch (e) {
      // 404/410: that phone turned reminders off, cleared the app or reinstalled. Forget it.
      if (e.statusCode === 404 || e.statusCode === 410) { console.log('Removing expired phone ' + key); await removeSub(token, key).catch(() => {}); }
      else console.error('Send failed for ' + key + ': ' + (e.statusCode || '') + ' ' + (e.body || e.message));
    }
  }
  console.log('Sent to ' + sent + ' of ' + subs.length + ' phone(s).');
  if (!sent && subs.length) process.exitCode = 1;
}

if (import.meta.url === 'file://' + process.argv[1]) main().catch((e) => { console.error(e.message || e); process.exit(1); });
