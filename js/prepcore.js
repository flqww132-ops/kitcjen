// Общая логика заготовок: нормы, время «Сделать к», остатки
import { num, dateISO, weekdayIdx, fmtNum, fmtDayLong } from './util.js';
import * as S from './store.js';

export const logId = (date, itemId) => `${date}|${itemId}`;
export const getLog = (date, itemId) => S.get('prepLog', logId(date, itemId)) || { left: null, done: false };
// Разовая заготовка — на одну дату (it.once + it.date); иначе повторяющаяся по дням недели (нормы и время по дням)
export const isOnce = (it) => !!it.once && !!it.date;
// День, к которому относятся отметки позиции: у разовой — её дата, у повторяющейся — просматриваемый день
export const logDateOf = (it, iso) => (isOnce(it) ? it.date : iso);
export const logFor = (it, iso) => getLog(logDateOf(it, iso), it.id);
export const normOf = (it, wd) => (isOnce(it) ? num(it.qty) ?? null : num(it.norms?.[wd]) ?? null);
export const hasAnyNorm = (it) => (it.norms || []).some((v) => num(v) > 0);
export const neededOn = (it, wd) => normOf(it, wd) > 0 || !hasAnyNorm(it);
// Статус на день: активна / выполнена (✓) / завершена-снята (✕)
export const statusOf = (log) => (log?.closed ? 'closed' : log?.done ? 'done' : 'active');
// Время «Сделать к»: своё на этот день, иначе — у разовой её время, у повторяющейся — по дню недели
export const timeOf = (it, wd, log) => (log && log.time) || (isOnce(it) ? it.time || '' : it.times?.[wd] || '');
// Что показывать в этот день: разовые на эту дату, повторяющиеся с нормой на этот день
// и (только для сегодня) несделанные разовые с прошлых дней — с пометкой, откуда они
export function dayItems(iso, todayIso = dateISO()) {
  const d = new Date(iso + 'T12:00:00');
  const wd = weekdayIdx(d);
  const out = [];
  for (const it of S.list('prepItems')) {
    if (isOnce(it)) {
      if (it.date === iso) out.push({ it, carried: '' });
      else if (iso === todayIso && it.date < todayIso && statusOf(getLog(it.date, it.id)) === 'active') out.push({ it, carried: it.date });
    } else if (neededOn(it, wd)) out.push({ it, carried: '' });
  }
  return out;
}
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const dayMonth = (iso) => { const [, m, dd] = iso.split('-').map(Number); return `${dd} ${MONTHS_GEN[m - 1]}`; };
// «со вчера, 6 ноября» или «с 4 ноября»
export function carriedLabel(fromIso, todayIso = dateISO()) {
  const y = new Date(todayIso + 'T12:00:00'); y.setDate(y.getDate() - 1);
  return fromIso === dateISO(y) ? `со вчера, ${dayMonth(fromIso)}` : `с ${dayMonth(fromIso)}`;
}
// Старые разовые: прошедшая дата, уже выполнены или сняты
export function oldOnceItems(todayIso = dateISO()) {
  return S.list('prepItems').filter((it) => isOnce(it) && it.date < todayIso && statusOf(getLog(it.date, it.id)) !== 'active')
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'ru'));
}
// Убрать старые разовые старше 30 дней (выполненные или снятые)
export function cleanupOldOnce(now = Date.now()) {
  const limit = dateISO(new Date(now - 30 * 864e5));
  const old = oldOnceItems().filter((it) => it.date < limit);
  if (!old.length) return;
  S.batch(() => {
    for (const it of old) {
      S.remove('prepItems', it.id, { silent: true });
      const l = S.get('prepLog', logId(it.date, it.id));
      if (l) S.remove('prepLog', l.id, { silent: true });
    }
  });
}
// 1.7.0: заготовки переделаны (разовые по датам) — все прежние позиции удаляем один раз.
// Удаляются только записи, сохранённые до выхода 1.7.0, поэтому повторный запуск безопасен.
export const PREP_RESET_BEFORE = Date.parse('2026-11-07T18:45:00Z');
export function wipeLegacyPrep() {
  const old = S.list('prepItems').filter((it) => (it.updatedAt || 0) < PREP_RESET_BEFORE);
  const logs = S.list('prepLog').filter((l) => (l.updatedAt || 0) < PREP_RESET_BEFORE);
  if (!old.length && !logs.length) return false;
  S.batch(() => {
    for (const it of old) S.remove('prepItems', it.id, { silent: true });
    for (const l of logs) S.remove('prepLog', l.id, { silent: true });
  });
  return true;
}
export const toMake = (it, wd, log) => {
  const n = normOf(it, wd);
  if (n == null) return null;
  return Math.max(0, Math.round((n - (log.left || 0)) * 1000) / 1000);
};
export function deadlineOf(date, time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
  if (!m) return null;
  const d = new Date(date);
  d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
}
// Записать отметку дня, сохранив остальные поля (остаток, галочку, своё время)
export function putLog(date, itemId, patch) {
  const iso = typeof date === 'string' ? date : dateISO(date);
  const prev = getLog(iso, itemId);
  const rec = { left: prev.left ?? null, done: !!prev.done, time: prev.time || '', ...patch, id: logId(iso, itemId), date: iso, itemId };
  S.put('prepLog', rec);
  return rec;
}
export const sortItems = (arr) => arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'));
export function grouped(items) {
  const stations = S.sortedList('stations');
  const groups = stations.map((s) => ({ id: s.id, name: s.name, items: items.filter((i) => i.stationId === s.id) }));
  const known = new Set(stations.map((s) => s.id));
  const rest = items.filter((i) => !known.has(i.stationId));
  if (rest.length) groups.push({ id: '', name: 'Без цеха', items: rest });
  return groups.filter((g) => g.items.length);
}
// Сортировка внутри цеха: сначала по времени «Сделать к», без времени — в конце
export function byTime(items, wd, iso) {
  return [...items].sort((a, b) => {
    const ta = timeOf(a, wd, logFor(a, iso)) || '99:99';
    const tb = timeOf(b, wd, logFor(b, iso)) || '99:99';
    return ta.localeCompare(tb) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru');
  });
}

export function prepText(date) {
  const wd = weekdayIdx(date);
  const iso = dateISO(date);
  const entries = dayItems(iso);
  const carried = new Map(entries.filter((e) => e.carried).map((e) => [e.it.id, e.carried]));
  const items = sortItems(entries.map((e) => e.it));
  const L = [`Заготовки на ${fmtDayLong(date)}:`];
  const done = [], closed = [];
  for (const g of grouped(items)) {
    const lines = [];
    for (const it of byTime(g.items, wd, iso)) {
      const log = logFor(it, iso);
      const stt = statusOf(log);
      if (stt === 'done') { done.push(it.name); continue; }
      if (stt === 'closed') { closed.push(it.name); continue; }
      const m = toMake(it, wd, log);
      if (m === 0) continue;
      const time = timeOf(it, wd, log);
      let s = `• ${time ? `к ${time} — ` : ''}${it.name}${m != null ? ` — ${fmtNum(m)} ${it.unit || ''}` : ''}`.trim();
      if (log.left) s += ` (норма ${fmtNum(normOf(it, wd))}, остаток ${fmtNum(log.left)})`;
      if (carried.has(it.id)) s += ` (${carriedLabel(carried.get(it.id))})`;
      lines.push(s);
    }
    if (lines.length) L.push('', g.name + ':', ...lines);
  }
  if (L.length === 1) L.push('', 'Всё сделано или ничего не нужно 👍');
  if (done.length) L.push('', '✅ Уже готово: ' + done.join(', '));
  if (closed.length) L.push('', '✖️ Снято: ' + closed.join(', '));
  return L.join('\n');
}

export { weekdayIdx };
