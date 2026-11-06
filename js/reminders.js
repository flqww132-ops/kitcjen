// Напоминания и таймеры: расписание сообщений и отправка его боту-напоминальщику.
// Бот (папка bot/, Cloudflare Workers) в нужную секунду пишет в чат Telegram.

import * as S from './store.js';
import { W, inTelegram } from './tg.js';
import { addDays, dateISO, weekdayIdx, fmtDayLong, fmtNum, fmtDuration, hash, debounce, lsGet, lsSet, fmtClock } from './util.js';
import { getLog, normOf, timeOf, toMake, deadlineOf, sortItems } from './prepcore.js';

const HORIZON_DAYS = 14;
export const remState = { state: 'off', message: '', count: null, next: null, at: 0 };
const listeners = new Set();
export const onRemState = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn(remState));

export const botUrl = () => (S.get('settings', 'botUrl')?.value || '').replace(/\/+$/, '');
export function setBotUrl(url) {
  S.put('settings', { id: 'botUrl', value: String(url || '').trim().replace(/\/+$/, '') });
}

// Все будущие сообщения: напоминания о заготовках на 14 дней вперёд + таймеры
export function buildSchedule(now = Date.now()) {
  const out = [];
  const items = sortItems(S.list('prepItems'));
  const stName = (id) => S.nameOf('stations', id);
  const groups = new Map();
  for (let d = 0; d < HORIZON_DAYS; d++) {
    const date = addDays(new Date(now), d);
    const iso = dateISO(date);
    const wd = weekdayIdx(date);
    for (const it of items) {
      const n = normOf(it, wd);
      if (!(n > 0) || !(it.reminders || []).length) continue;
      const log = getLog(iso, it.id);
      if (log.done) continue;
      const time = timeOf(it, wd, log);
      const deadline = deadlineOf(date, time);
      if (!deadline) continue;
      for (const lead of it.reminders) {
        const at = deadline - Math.max(0, Number(lead) || 0) * 1000;
        if (at <= now) continue;
        const gk = `${at}|${lead}|${iso}|${time}`;
        if (!groups.has(gk)) groups.set(gk, { at, lead: Number(lead) || 0, iso, date, time, deadline, lines: [] });
        const make = toMake(it, wd, log);
        const st = stName(it.stationId);
        groups.get(gk).lines.push(`• ${it.name} — ${fmtNum(make)} ${it.unit || ''}`.trim() + (st ? ` (${st})` : ''));
      }
    }
  }
  for (const g of groups.values()) {
    const otherDay = dateISO(new Date(g.at)) !== g.iso ? ` (${fmtDayLong(g.date)})` : '';
    const head = g.lead > 0
      ? `⏰ Через ${fmtDuration(g.lead)} — к ${g.time}${otherDay} нужно сделать:`
      : `⏰ Пора! К ${g.time}${otherDay} нужно сделать:`;
    out.push({ at: g.at, key: `prep|${g.iso}|${g.time}|${g.lead}`, text: [head, ...g.lines].join('\n') });
  }
  for (const t of S.list('timers')) {
    if (t.endsAt > now) out.push({ at: t.endsAt, key: `timer|${t.id}`, text: `⏱ Таймер «${t.label || 'Таймер'}»: время вышло! (поставлен на ${fmtDuration(t.durationSec || 0)}, в ${fmtClock(t.createdAt || t.endsAt)})` });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 1000);
}

async function api(path, method, body) {
  const r = await fetch(botUrl() + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': W?.initData || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* нет */ }
  if (!r.ok || !j?.ok) throw new Error(j?.message || j?.error || `ошибка ${r.status}`);
  return j;
}

export async function syncReminders(force = false) {
  if (!botUrl()) { Object.assign(remState, { state: 'off', message: '' }); emit(); return; }
  if (!inTelegram) { Object.assign(remState, { state: 'browser', message: '' }); emit(); return; }
  const items = buildSchedule();
  const h = hash(botUrl() + JSON.stringify(items));
  const last = Number(lsGet('kb_remAt') || 0);
  // повторяем раз в 6 часов, чтобы расписание всегда было на 2 недели вперёд
  if (!force && h === lsGet('kb_remHash') && Date.now() - last < 6 * 3600e3) return;
  remState.state = 'syncing'; emit();
  try {
    const r = await api('/api/reminders', 'PUT', { items });
    lsSet('kb_remHash', h);
    lsSet('kb_remAt', String(Date.now()));
    Object.assign(remState, { state: 'ok', message: '', count: r.count, next: r.next, at: Date.now() });
  } catch (e) {
    Object.assign(remState, { state: 'error', message: String(e.message || e) });
  }
  emit();
}
export const scheduleReminders = debounce(() => syncReminders(), 1500);

export async function testBot() {
  await api('/api/test', 'POST');
  await syncReminders(true);
}

export function initReminders() {
  S.onChange((src) => {
    if (['prepItems', 'prepLog', 'timers', 'settings', 'remote', 'import', 'wipe', 'batch'].includes(src)) scheduleReminders();
  });
  syncReminders();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncReminders(); });
}
