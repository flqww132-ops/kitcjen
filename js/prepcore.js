// Общая логика заготовок: нормы, время «Сделать к», остатки
import { num, dateISO, weekdayIdx, fmtNum, fmtDayLong } from './util.js';
import * as S from './store.js';

export const logId = (date, itemId) => `${date}|${itemId}`;
export const getLog = (date, itemId) => S.get('prepLog', logId(date, itemId)) || { left: null, done: false };
export const normOf = (it, wd) => num(it.norms?.[wd]) ?? null;
// Нужна ли позиция в этот день: есть норма на день, или нормы не заданы вовсе (тогда — каждый день)
export const hasAnyNorm = (it) => (it.norms || []).some((v) => num(v) > 0);
export const neededOn = (it, wd) => normOf(it, wd) > 0 || !hasAnyNorm(it);
// Статус на день: активна / выполнена (✓) / завершена-снята (✕)
export const statusOf = (log) => (log?.closed ? 'closed' : log?.done ? 'done' : 'active');
// Время «Сделать к» на конкретный день: своё на этот день или из графика по дням недели
export const timeOf = (it, wd, log) => (log && log.time) || it.times?.[wd] || '';
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
    const ta = timeOf(a, wd, getLog(iso, a.id)) || '99:99';
    const tb = timeOf(b, wd, getLog(iso, b.id)) || '99:99';
    return ta.localeCompare(tb) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru');
  });
}

export function prepText(date) {
  const wd = weekdayIdx(date);
  const iso = dateISO(date);
  const items = sortItems(S.list('prepItems')).filter((i) => neededOn(i, wd));
  const L = [`Заготовки на ${fmtDayLong(date)}:`];
  const done = [], closed = [];
  for (const g of grouped(items)) {
    const lines = [];
    for (const it of byTime(g.items, wd, iso)) {
      const log = getLog(iso, it.id);
      const stt = statusOf(log);
      if (stt === 'done') { done.push(it.name); continue; }
      if (stt === 'closed') { closed.push(it.name); continue; }
      const m = toMake(it, wd, log);
      if (m === 0) continue;
      const time = timeOf(it, wd, log);
      let s = `• ${time ? `к ${time} — ` : ''}${it.name}${m != null ? ` — ${fmtNum(m)} ${it.unit || ''}` : ''}`.trim();
      if (log.left) s += ` (норма ${fmtNum(normOf(it, wd))}, остаток ${fmtNum(log.left)})`;
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
