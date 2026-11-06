// Экран «План в Telegram»: что отправлять, отправить сейчас, расписание

import { html, uid, addDays, WEEKDAYS } from '../util.js';
import { refresh, toast, onActs, showText, confirmDialog } from '../ui.js';
import { haptic } from '../tg.js';
import { icon, busy } from './common.js';
import { planSections, planSettings, savePlanSettings, planText } from '../plan.js';
import { sendText, botReady, botUrl } from '../reminders.js';

export function planScreen() {
  const p = planSettings();
  const save = () => savePlanSettings(p);
  return {
    tab: 'prep',
    title: 'План в Telegram',
    render: () => html`
      ${!botUrl() ? html`<div class="banner">${icon('warn')} Бот ещё не подключён — Настройки → Напоминания в Telegram.</div>` : ''}
      <div class="group-title">Что отправлять</div>
      <div class="card list-card">
        ${planSections().map((s) => html`<label class="switch-row in-list"><input type="checkbox" data-sec="${s.id}" ${p.sections[s.id] ? 'checked' : ''}><span class="sw"></span><span class="sw-text"><b>${s.label}</b><small>${s.hint || ''}</small></span></label>`)}
      </div>
      <div class="group-title">Отправить сейчас</div>
      <div class="card">
        <div class="row gap">
          <button class="btn primary grow" data-act="send" data-d="0">${icon('send')} На сегодня</button>
          <button class="btn grow" data-act="send" data-d="1">${icon('send')} На завтра</button>
        </div>
        <button class="btn ghost wide mt" data-act="preview">Посмотреть текст</button>
      </div>
      <div class="group-title">По расписанию</div>
      ${p.schedules.length ? p.schedules.map((sch, i) => html`<div class="card sched" data-i="${i}">
        <div class="row gap">
          <input class="inp time-mid" type="time" data-sch="time" value="${sch.time || ''}">
          <div class="seg grow">${[['today', 'сегодня'], ['tomorrow', 'завтра']].map(([v, l]) => html`<button class="${sch.target === v ? 'on' : ''}" data-act="target" data-v="${v}">${l}</button>`)}</div>
          <button class="icon-btn danger" data-act="del" aria-label="Удалить">${icon('trash')}</button>
        </div>
        <div class="days mt">${WEEKDAYS.map((w, d) => html`<button class="day ${sch.days?.[d] ? 'on' : ''}" data-act="day" data-d="${d}">${w}</button>`)}</div>
      </div>`) : html`<p class="hint pad-x">Расписаний нет. Например: в 8:00 — план на сегодня, в 22:00 — план на завтра.</p>`}
      <button class="btn wide" data-act="add">${icon('plus')} Добавить время отправки</button>
      <p class="hint pad-x">План собирается из данных приложения и обновляется у бота при каждом изменении. Бот держит расписание на 2 недели вперёд.</p>`,
    mount(el) {
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.sec) { p.sections[t.dataset.sec] = t.checked; save(); }
        if (t.dataset.sch === 'time') { p.schedules[+t.closest('.sched').dataset.i].time = t.value; save(); }
      });
      onActs(el, {
        send: async (t) => {
          if (!botReady()) { toast(!botUrl() ? 'Сначала подключите бота в Настройках' : 'Отправка работает внутри Telegram', 'error'); return; }
          const text = planText(addDays(new Date(), +t.dataset.d), p.sections);
          if (!text) { toast('Нечего отправлять: включите хотя бы один раздел или добавьте данные'); return; }
          const done = busy('Отправляю…');
          try { await sendText(text); haptic('success'); toast('План отправлен в чат'); } catch (e) { toast(e.message || String(e), 'error'); } finally { done(); }
        },
        preview: () => {
          const text = planText(new Date(), p.sections) || 'Пусто — нет данных в выбранных разделах.';
          showText('План на сегодня', text);
        },
        add: () => {
          p.schedules.push({ id: uid(), time: p.schedules.length ? '22:00' : '08:00', target: p.schedules.length ? 'tomorrow' : 'today', days: [true, true, true, true, true, true, true] });
          save(); refresh();
        },
        del: async (t) => {
          if (!(await confirmDialog('Удалить это время отправки?', 'Удалить', true))) return;
          p.schedules.splice(+t.closest('.sched').dataset.i, 1); save(); refresh();
        },
        target: (t) => { p.schedules[+t.closest('.sched').dataset.i].target = t.dataset.v; save(); refresh(); },
        day: (t) => {
          const sch = p.schedules[+t.closest('.sched').dataset.i];
          sch.days = sch.days || Array(7).fill(false);
          sch.days[+t.dataset.d] = !sch.days[+t.dataset.d];
          save(); t.classList.toggle('on', sch.days[+t.dataset.d]); haptic('select');
        },
      });
    },
  };
}
