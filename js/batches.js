// Партии заготовок: маркировка (изготовлено / годен до / кто), сроки, «Истекает».
// Запись: { id, prepItemId, name, unit, qty, madeAt, expiresAt, by, status: 'active'|'used'|'written', closedAt }

import * as S from './store.js';
import { fmtNum, fmtDuration, dateISO, addDays, fmtClock } from './util.js';
import { registerPlanSection } from './plan.js';
import { registerSchedule } from './reminders.js';

export const activeBatches = () => S.list('batches').filter((b) => b.status === 'active').sort((a, b) => a.expiresAt - b.expiresAt);
export const fmtDT = (ts) => { const d = new Date(ts); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${fmtClock(ts)}`; };

export function expirySettings() {
  const r = S.get('settings', 'expiry') || {};
  return { alerts: r.alerts !== false, lead: Number.isFinite(r.lead) ? r.lead : 7200 };
}
export const saveExpirySettings = (e) => S.put('settings', { id: 'expiry', alerts: e.alerts, lead: e.lead });

// Группы для экрана «Сроки»
export function groupBatches(now = Date.now()) {
  const today = dateISO(new Date(now)), tomorrow = dateISO(addDays(new Date(now), 1));
  const g = { over: [], today: [], tomorrow: [], later: [] };
  for (const b of activeBatches()) {
    const d = dateISO(new Date(b.expiresAt));
    if (b.expiresAt <= now) g.over.push(b);
    else if (d === today) g.today.push(b);
    else if (d === tomorrow) g.tomorrow.push(b);
    else g.later.push(b);
  }
  return g;
}

export function relLeft(ts, now = Date.now()) {
  const diff = Math.round((ts - now) / 1000);
  if (diff <= 0) return `просрочено ${fmtDuration(Math.max(60, Math.round(-diff / 60) * 60))} назад`;
  return `осталось ${fmtDuration(diff < 3600 ? Math.max(60, Math.round(diff / 60) * 60) : Math.round(diff / 3600) * 3600)}`;
}
const line = (b) => `• ${b.name}${b.qty != null ? ` — ${fmtNum(b.qty)} ${b.unit || ''}`.trimEnd() : ''} (годен до ${fmtDT(b.expiresAt)})`;

// Раздел плана: что истекает до конца выбранного дня (и что уже просрочено)
registerPlanSection({
  id: 'expiring',
  label: 'Истекает срок',
  emoji: '⏳',
  hint: 'просроченные партии и те, у которых срок кончается в этот день',
  text: (date) => {
    const end = new Date(date); end.setHours(23, 59, 59, 999);
    const now = Date.now();
    const list = activeBatches().filter((b) => b.expiresAt <= end.getTime());
    if (!list.length) return '';
    const over = list.filter((b) => b.expiresAt <= now);
    const rest = list.filter((b) => b.expiresAt > now);
    return [...(over.length ? ['Просрочено:', ...over.map(line)] : []), ...rest.map(line)].join('\n');
  },
});

// Предупреждения бота о конце срока
registerSchedule((now) => {
  const e = expirySettings();
  if (!e.alerts) return [];
  const groups = new Map();
  for (const b of activeBatches()) {
    const at = b.expiresAt - e.lead * 1000;
    if (at <= now) continue;
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(b);
  }
  return [...groups.entries()].map(([at, list]) => ({
    at,
    key: `exp|${at}`,
    text: [e.lead ? `⏳ Через ${fmtDuration(e.lead)} истекает срок:` : '⛔ Истёк срок:', ...list.map(line)].join('\n'),
  }));
});
