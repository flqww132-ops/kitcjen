// План дня для Telegram: из каких разделов собирать текст и по какому расписанию отправлять.
// Настройки хранятся в settings: { id: 'plan', sections: { prep: true, … }, schedules: [{ id, time, days[7], target }] }

import * as S from './store.js';
import { addDays, dateISO, fmtDayLong } from './util.js';
import { prepText } from './prepcore.js';

// Разделы плана. Новые разделы (сроки, чек-листы) добавляются сюда — у каждого своя функция текста.
const SECTIONS = [];
export function registerPlanSection(sec) { if (!SECTIONS.some((s) => s.id === sec.id)) SECTIONS.push(sec); }
export const planSections = () => SECTIONS;

registerPlanSection({
  id: 'prep',
  label: 'Заготовки на день',
  emoji: '🔪',
  hint: 'что сделать, к какому времени, сколько; что уже готово и что снято',
  text: (date) => prepText(date).split('\n').slice(1).join('\n').trim(),
});

export function planSettings() {
  const r = S.get('settings', 'plan') || {};
  const sections = { ...Object.fromEntries(SECTIONS.map((s) => [s.id, true])), ...(r.sections || {}) };
  return { sections, schedules: Array.isArray(r.schedules) ? r.schedules : [] };
}
export function savePlanSettings(p) { S.put('settings', { id: 'plan', sections: p.sections, schedules: p.schedules }); }

export function planText(date, sections = planSettings().sections) {
  const parts = [`📋 План на ${fmtDayLong(date)}`];
  for (const sec of SECTIONS) {
    if (!sections[sec.id]) continue;
    const t = (sec.text(date) || '').trim();
    if (t) parts.push(`${sec.emoji || '▪️'} ${sec.label}:\n${t}`);
  }
  return parts.length > 1 ? parts.join('\n\n') : '';
}

// Сообщения плана по расписанию на 14 дней вперёд
export function planSchedule(now = Date.now()) {
  const p = planSettings();
  const out = [];
  for (const sch of p.schedules) {
    const m = /^(\d{1,2}):(\d{2})/.exec(sch.time || '');
    if (!m) continue;
    for (let d = 0; d < 14; d++) {
      const day = addDays(new Date(now), d);
      const wd = (day.getDay() + 6) % 7;
      if (!sch.days?.[wd]) continue;
      day.setHours(+m[1], +m[2], 0, 0);
      if (day.getTime() <= now) continue;
      const target = sch.target === 'tomorrow' ? addDays(day, 1) : day;
      const text = planText(target, p.sections);
      if (text) out.push({ at: day.getTime(), key: `plan|${sch.id}|${dateISO(day)}`, text });
    }
  }
  return out;
}
