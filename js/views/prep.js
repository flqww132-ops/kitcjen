// Раздел «Заготовки»: нормы и время «Сделать к» по дням недели, напоминания в Telegram, таймеры.
// Режимы «Сегодня/Завтра» и «Неделя».

import { html, uid, clone, num, fmtNum, lsGet, lsSet, WEEKDAYS, dateISO, addDays, weekdayIdx, fmtDayLong, fmtDuration, fmtCountdown, fmtClock } from '../util.js';
import * as S from '../store.js';
import { push, back, refresh, toast, confirmDialog, onActs, showText, sheet } from '../ui.js';
import { haptic, shareText, inTelegram } from '../tg.js';
import { refSelect, bindRefSelects, fab, emptyState, segmented, chips, icon, inNum } from './common.js';
import { recipeDetail } from './ttk.js';
import { planScreen } from './planview.js';
import { getLog, normOf, timeOf, toMake, deadlineOf, putLog, sortItems, grouped, neededOn, statusOf, byTime, prepText } from '../prepcore.js';
export { prepText };
import { botUrl } from '../reminders.js';

const PREP_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'порц', 'гастро', 'конт', 'бут'];
const st = { mode: 'today', list: 'active' };
let tick = null;          // обновление обратного отсчёта таймеров
const firedTimers = new Set();

const dayDate = () => (st.mode === 'tomorrow' ? addDays(new Date(), 1) : new Date());

// ---- Выбор длительности: дни / часы / минуты / секунды -------------------------------
const QUICK = [[30, '30 сек'], [300, '5 мин'], [900, '15 мин'], [1800, '30 мин'], [3600, '1 ч'], [7200, '2 ч'], [10800, '3 ч'], [86400, '1 день']];
export function durationSheet(title, { initial = 0, okLabel = 'Готово', withLabel = false, label = '', allowZero = false } = {}) {
  const split = (s) => [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
  const [d, h, m, sec] = split(initial);
  return sheet({
    title,
    body: html`
      ${withLabel ? html`<label class="fld"><span>Название</span><input class="inp" id="durLabel" value="${label}" placeholder="Например, бульон"></label>` : ''}
      <div class="chips wrap">${QUICK.map(([s, l]) => html`<button class="chip" data-q="${s}">${l}</button>`)}</div>
      <div class="dur">
        <label><input class="inp" id="durD" inputmode="numeric" value="${d || ''}" placeholder="0"><small>дней</small></label>
        <label><input class="inp" id="durH" inputmode="numeric" value="${h || ''}" placeholder="0"><small>часов</small></label>
        <label><input class="inp" id="durM" inputmode="numeric" value="${m || ''}" placeholder="0"><small>минут</small></label>
        <label><input class="inp" id="durS" inputmode="numeric" value="${sec || ''}" placeholder="0"><small>секунд</small></label>
      </div>`,
    buttons: [
      { label: 'Отмена', kind: 'ghost' },
      {
        label: okLabel, kind: 'primary', value: (w) => {
          const v = (id) => Math.max(0, Math.floor(num(w.querySelector(id).value) || 0));
          const total = v('#durD') * 86400 + v('#durH') * 3600 + v('#durM') * 60 + v('#durS');
          if (!total && !allowZero) return null;
          return { sec: total, label: withLabel ? w.querySelector('#durLabel').value.trim() : '' };
        },
      },
    ],
    onMount: (el) => {
      el.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
        const [qd, qh, qm, qs] = split(+b.dataset.q);
        el.querySelector('#durD').value = qd || ''; el.querySelector('#durH').value = qh || '';
        el.querySelector('#durM').value = qm || ''; el.querySelector('#durS').value = qs || '';
        haptic('select');
      }));
    },
  });
}

async function startTimer(defaultLabel = '', itemId = '') {
  const r = await durationSheet('Новый таймер', { withLabel: true, label: defaultLabel, okLabel: 'Запустить' });
  if (!r || !r.sec) return;
  const now = Date.now();
  S.put('timers', { id: uid(), label: r.label || defaultLabel || 'Таймер', durationSec: r.sec, endsAt: now + r.sec * 1000, itemId });
  haptic('success');
  toast(botUrl() && inTelegram ? `Таймер на ${fmtDuration(r.sec)} — бот напишет в Telegram` : `Таймер на ${fmtDuration(r.sec)} запущен`);
  refresh();
}

function timersCard() {
  const now = Date.now();
  const list = S.list('timers').filter((t) => t.endsAt > now - 12 * 3600e3).sort((a, b) => a.endsAt - b.endsAt);
  if (!list.length) return '';
  return html`<div class="card timers">
    <div class="card-title">Таймеры</div>
    ${list.map((t) => html`<div class="trow ${t.endsAt <= now ? 'over' : ''}">
      <div class="t-main"><div class="t-label">${t.label}</div><div class="t-sub">${fmtDuration(t.durationSec)} · до ${fmtClock(t.endsAt)}</div></div>
      <div class="t-count" data-end="${t.endsAt}">${t.endsAt <= now ? 'Готово!' : fmtCountdown(t.endsAt - now)}</div>
      <button class="icon-btn" data-act="timer-del" data-id="${t.id}" aria-label="${t.endsAt <= now ? 'Убрать' : 'Отменить'}">${icon('x')}</button>
    </div>`)}
  </div>`;
}

function dayView() {
  const date = dayDate();
  const iso = dateISO(date);
  const wd = weekdayIdx(date);
  const now = Date.now();
  const all = sortItems(S.list('prepItems'));
  const items = all.filter((i) => neededOn(i, wd));
  const skipped = all.length - items.length;
  const by = { active: [], done: [], closed: [] };
  for (const it of items) by[statusOf(getLog(iso, it.id))].push(it);
  const doneN = by.done.length;
  const total = items.length - by.closed.length;
  const pct = total ? Math.round((doneN / total) * 100) : 0;
  const activeRow = (it) => {
    const log = getLog(iso, it.id);
    const n = normOf(it, wd);
    const m = toMake(it, wd, log);
    const time = timeOf(it, wd, log);
    const dl = deadlineOf(date, time);
    const late = dl && dl < now;
    const rem = (it.reminders || []).length;
    return html`<div class="prow ${late ? 'late' : ''}" data-id="${it.id}">
      <div class="pr-line">
        <button class="pr-name" data-act="edit" data-id="${it.id}">${it.name}</button>
        <button class="icon-btn pr-timer" data-act="timer" data-id="${it.id}" aria-label="Таймер">${icon('timer')}</button>
        <button class="pr-x" data-act="close" data-id="${it.id}" aria-label="Завершить без выполнения">${icon('x')}</button>
        <button class="pr-check" data-act="done" data-id="${it.id}" aria-label="Выполнено">${icon('check')}</button>
      </div>
      ${n != null ? html`<div class="pr-line pr-nums">
        <span class="pr-norm">норма <b>${fmtNum(n)}</b> ${it.unit}</span>
        <label class="pr-left">остаток <input class="inp sm" data-left="${it.id}" inputmode="decimal" value="${inNum(log.left)}" placeholder="0"></label>
        <span class="pr-make">сделать <b data-make="${it.id}">${fmtNum(m)}</b> ${it.unit}</span>
      </div>` : ''}
      <div class="pr-sub">
        <button class="pr-time ${time ? '' : 'empty'} ${late ? 'late' : ''} ${log.time ? 'custom' : ''}" data-act="time" data-id="${it.id}">${icon('clock')} ${time ? `к ${time}` : 'время'}${late ? ' · просрочено' : ''}</button>
        ${rem ? html`<span class="pr-rem">${icon('bell')} ${it.reminders.map((sec) => (sec ? `за ${fmtDuration(sec)}` : 'в срок')).join(', ')}</span>` : ''}
        ${it.recipeId && S.get('recipes', it.recipeId) ? html`<button class="linkish" data-act="recipe" data-id="${it.recipeId}">ТТК ›</button>` : ''}
      </div>
    </div>`;
  };
  const closedRow = (it, kind) => {
    const log = getLog(iso, it.id);
    const at = kind === 'done' ? log.doneAt : log.closedAt;
    const n = normOf(it, wd);
    return html`<div class="prow ${kind}" data-id="${it.id}">
      <div class="pr-line">
        <span class="pr-mark ${kind}">${icon(kind === 'done' ? 'check' : 'x')}</span>
        <button class="pr-name" data-act="edit" data-id="${it.id}">${it.name}</button>
        <button class="btn sm" data-act="restore" data-id="${it.id}">Вернуть</button>
      </div>
      <div class="pr-sub">${kind === 'done' ? 'выполнено' : 'завершено без выполнения'}${at ? ` в ${fmtClock(at)}` : ''}${n != null && kind === 'done' ? ` · норма ${fmtNum(n)} ${it.unit}` : ''}</div>
    </div>`;
  };
  const list = by[st.list] || by.active;
  const rowFn = st.list === 'active' ? activeRow : (it) => closedRow(it, st.list);
  const emptyText = { active: items.length ? 'Все задачи на этот день закрыты 👍' : 'На этот день заготовок нет', done: 'Пока ничего не выполнено', closed: 'Ничего не завершено без выполнения' }[st.list];
  return html`
    <div class="card day-card">
      <svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="ring-bg"/>${pct ? html`<circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/>` : ''}</svg>
      <div class="day-head"><b>${fmtDayLong(date)}</b><span class="muted">Готово ${doneN} из ${total}${pct === 100 && total ? ' 🎉' : ''}</span></div>
      <div class="ring-pct">${pct}%</div>
    </div>
    <div class="row gap mb">
      <button class="btn grow" data-act="timer-new">${icon('timer')} Таймер</button>
      <button class="btn grow" data-act="plan">${icon('send')} План в Telegram</button>
    </div>
    ${timersCard()}
    ${chips('plist', st.list, [
      { id: 'active', label: 'Активные', count: by.active.length },
      { id: 'done', label: 'Выполненные', count: by.done.length },
      { id: 'closed', label: 'Завершённые', count: by.closed.length },
    ])}
    ${list.length ? grouped(list).map((g) => html`<div class="group-title">${g.name}</div><div class="card plist">${byTime(g.items, wd, iso).map(rowFn)}</div>`)
      : html`<div class="empty small">${emptyText}</div>`}
    ${st.list === 'active' && by.active.length ? html`<p class="hint pad-x">✓ — выполнено, ✕ — завершить без выполнения (не нужно сегодня).</p>` : ''}
    ${skipped ? html`<div class="muted small pad-x">Не нужны в этот день (норма 0 или пусто): ${skipped}</div>` : ''}
    <div class="row gap mt">
      <button class="btn grow" data-act="share">${icon('share')} Поделиться</button>
      <button class="btn ghost danger" data-act="reset">Сбросить день</button>
    </div>`;
}

function weekView() {
  const all = sortItems(S.list('prepItems'));
  const today = weekdayIdx(new Date());
  return html`
    <p class="hint pad-x">Нормы по дням недели. Меняйте прямо в таблице. Время «Сделать к» и напоминания — в карточке позиции (нажмите на название).</p>
    <div class="wtable-wrap"><table class="wtable">
      <thead><tr><th class="wname">Позиция</th>${WEEKDAYS.map((d, i) => html`<th class="${i === today ? 'today' : ''}">${d}</th>`)}</tr></thead>
      <tbody>${grouped(all).map((g) => html`
        <tr class="wgroup"><td colspan="8">${g.name}</td></tr>
        ${g.items.map((it) => html`<tr>
          <td class="wname"><button class="linkish" data-act="edit" data-id="${it.id}">${it.name}</button><small>${it.unit}</small></td>
          ${WEEKDAYS.map((_, i) => html`<td class="${i === today ? 'today' : ''}"><input class="winp" data-norm="${it.id}" data-wd="${i}" inputmode="decimal" value="${inNum(it.norms?.[i])}">${it.times?.[i] ? html`<small class="wtime">${it.times[i]}</small>` : ''}</td>`)}
        </tr>`)}`)}
      </tbody>
    </table></div>`;
}

export function prepScreen() {
  // Остаток сохраняем с небольшой задержкой, чтобы не писать на каждую цифру
  let pending = null, timer = null;
  const flushLeft = () => {
    clearTimeout(timer);
    if (!pending) return;
    const { id, iso, v } = pending;
    pending = null;
    putLog(iso, id, { left: v });
  };
  const saveLeft = (id, iso, v) => {
    if (pending && pending.id !== id) flushLeft();
    pending = { id, iso, v };
    clearTimeout(timer);
    timer = setTimeout(flushLeft, 400);
  };
  return {
    tab: 'prep',
    title: 'Заготовки',
    subtitle: () => fmtDayLong(new Date()),
    onLeave: () => { flushLeft(); clearInterval(tick); },
    render() {
      const any = S.list('prepItems').length;
      return html`
        <div class="toolbar sticky">${segmented('mode', st.mode, [{ id: 'today', label: 'Сегодня' }, { id: 'tomorrow', label: 'Завтра' }, { id: 'week', label: 'Неделя' }])}</div>
        ${!any ? html`${timersCard()}${emptyState('Матрица заготовок пуста', 'Добавьте позиции: название, цех, единицу, норму и время на каждый день недели.', html`<div class="stack"><button class="btn primary" data-act="add">Добавить позицию</button><button class="btn" data-act="timer-new">${icon('timer')} Таймер</button></div>`, '🔪')}`
          : st.mode === 'week' ? weekView() : dayView()}
        ${fab()}`;
    },
    mount(el) {
      // Живой обратный отсчёт таймеров
      clearInterval(tick);
      tick = setInterval(() => {
        const now = Date.now();
        el.querySelectorAll('[data-end]').forEach((c) => {
          const end = +c.dataset.end;
          if (end > now) { c.textContent = fmtCountdown(end - now); return; }
          if (c.textContent !== 'Готово!') {
            c.textContent = 'Готово!';
            c.closest('.trow')?.classList.add('over');
            if (!firedTimers.has(end)) {
              firedTimers.add(end);
              haptic('warning');
              toast(`⏱ ${c.closest('.trow')?.querySelector('.t-label')?.textContent || 'Таймер'}: время вышло!`);
            }
          }
        });
      }, 1000);
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.left) {
          const date = dayDate();
          const it = S.get('prepItems', t.dataset.left);
          const v = num(t.value);
          el.querySelector(`[data-make="${it.id}"]`).textContent = fmtNum(toMake(it, weekdayIdx(date), { left: v }));
          saveLeft(it.id, dateISO(date), v);
        }
      });
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.norm) {
          const it = S.get('prepItems', t.dataset.norm);
          const norms = [...(it.norms || Array(7).fill(null))];
          norms[+t.dataset.wd] = num(t.value);
          S.put('prepItems', { ...it, norms });
          t.value = inNum(norms[+t.dataset.wd]);
        }
      });
      onActs(el, {
        seg: (t) => { flushLeft(); st.mode = t.dataset.v; refresh(); },
        add: () => push(prepForm({})),
        edit: (t) => push(prepForm({ item: S.get('prepItems', t.dataset.id) })),
        recipe: (t) => push(recipeDetail(t.dataset.id)),
        chip: (t) => { flushLeft(); st.list = t.dataset.v; refresh(); },
        done: (t) => {
          const iso = dateISO(dayDate());
          const id = t.dataset.id;
          flushLeft();
          const prev = getLog(iso, id);
          const leftInput = el.querySelector(`[data-left="${id}"]`);
          putLog(iso, id, { left: leftInput ? num(leftInput.value) : prev.left, done: true, closed: false, doneAt: Date.now() });
          haptic('success');
          toast(`✓ ${S.get('prepItems', id)?.name || ''} — в выполненных`);
          refresh();
        },
        close: (t) => {
          const iso = dateISO(dayDate());
          const id = t.dataset.id;
          flushLeft();
          putLog(iso, id, { done: false, closed: true, closedAt: Date.now() });
          haptic('light');
          toast(`✕ ${S.get('prepItems', id)?.name || ''} — в завершённых`);
          refresh();
        },
        restore: (t) => {
          putLog(dateISO(dayDate()), t.dataset.id, { done: false, closed: false, doneAt: null, closedAt: null });
          haptic('select');
          toast('Вернули в активные');
          refresh();
        },
        time: async (t) => {
          const date = dayDate();
          const iso = dateISO(date);
          const it = S.get('prepItems', t.dataset.id);
          const log = getLog(iso, it.id);
          const usual = it.times?.[weekdayIdx(date)] || '';
          const r = await sheet({
            title: `${it.name}: сделать к — ${fmtDayLong(date)}`,
            body: html`<input class="inp time-big" type="time" id="tval" value="${timeOf(it, weekdayIdx(date), log)}">
              <p class="hint">${usual ? `Обычно в этот день — к ${usual}.` : 'Обычного времени на этот день нет.'} Изменение действует только на ${st.mode === 'tomorrow' ? 'завтра' : 'сегодня'}; постоянное время — в карточке позиции.</p>`,
            buttons: [
              ...(log.time ? [{ label: 'Как обычно', kind: 'ghost', value: { reset: true } }] : [{ label: 'Отмена', kind: 'ghost' }]),
              { label: 'Сохранить', kind: 'primary', value: (w) => ({ time: w.querySelector('#tval').value }) },
            ],
          });
          if (!r) return;
          flushLeft();
          putLog(iso, it.id, { time: r.reset ? '' : (r.time === usual ? '' : r.time) });
          refresh();
        },
        timer: (t) => startTimer(S.get('prepItems', t.dataset.id)?.name || '', t.dataset.id),
        'timer-new': () => startTimer(''),
        plan: () => push(planScreen()),
        'timer-del': async (t) => {
          const tm = S.get('timers', t.dataset.id);
          if (tm && tm.endsAt > Date.now() && !(await confirmDialog(`Отменить таймер «${tm.label}»?`, 'Отменить', true))) return;
          S.remove('timers', t.dataset.id);
          refresh();
        },
        share: async () => {
          const text = prepText(dayDate());
          const r = await shareText(text);
          if (!r.shared) { if (r.copied) toast('Список скопирован — вставьте в чат'); else showText('Заготовки', text); }
        },
        reset: async () => {
          const iso = dateISO(dayDate());
          if (!(await confirmDialog('Сбросить отметки, остатки и время на этот день?', 'Сбросить', true))) return;
          S.batch(() => {
            for (const l of S.list('prepLog')) if (l.date === iso) S.remove('prepLog', l.id, { silent: true });
          });
          toast('День сброшен');
          refresh();
        },
      });
    },
  };
}

// ---- Карточка позиции ---------------------------------------------------------------------
function prepForm({ item }) {
  const isNew = !item;
  const d = item ? clone(item) : { name: '', stationId: '', unit: 'кг', shelfLife: '', recipeId: '', norms: Array(7).fill(null), times: Array(7).fill(''), reminders: [3600] };
  d.norms = d.norms || Array(7).fill(null);
  d.times = Array.isArray(d.times) ? d.times : Array(7).fill('');
  d.reminders = Array.isArray(d.reminders) ? d.reminders : [];
  const initial = JSON.stringify(d);
  let saved = false;
  let daysOpen = lsGet('kb_daysOpen') === '1';
  const recipes = S.list('recipes').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  // Одинаковая норма на все дни (или null) и сводка для свёрнутого блока
  const filled = () => d.norms.map((v) => (num(v) > 0 ? num(v) : null));
  const normsDiffer = () => new Set(filled().map(String)).size > 1;
  const sameNorm = () => (normsDiffer() ? null : filled()[0]);
  const daysSummary = () => {
    const parts = [];
    if (normsDiffer()) parts.push('норма разная по дням');
    else if (sameNorm() != null) parts.push(`${fmtNum(sameNorm())} ${d.unit} каждый день`);
    else parts.push('каждый день, без нормы');
    const ts = new Set(d.times.map((t) => t || ''));
    if (ts.size > 1) parts.push('время по дням');
    else if (d.times[0]) parts.push(`к ${d.times[0]}`);
    return parts.join(' · ');
  };
  const remChips = () => html`${d.reminders.length
    ? [...d.reminders].sort((a, b) => b - a).map((s) => html`<span class="rchip">${icon('bell')} ${s ? `за ${fmtDuration(s)}` : 'в срок'}<button data-act="rem-del" data-s="${s}" aria-label="Убрать">${icon('x')}</button></span>`)
    : html`<span class="muted small">Напоминаний нет</span>`}`;
  return {
    tab: 'prep',
    form: true,
    title: isNew ? 'Новая позиция' : 'Позиция заготовки',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => html`
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" data-f="name" value="${d.name}" placeholder="Например, Соус цезарь"></label>
        <label class="fld"><span>Цех / станция</span>${refSelect('stations', d.stationId, { field: 'stationId', addLabel: '＋ Новый цех…' })}</label>
        <div class="row gap">
          <label class="fld w100"><span>Единица</span><select class="inp" data-f="unit">${[...new Set([...PREP_UNITS, d.unit])].map((u) => html`<option ${u === d.unit ? 'selected' : ''}>${u}</option>`)}</select></label>
          <label class="fld grow"><span>Количество (на каждый день)</span><input class="inp" id="qtyAll" inputmode="decimal" value="${inNum(sameNorm())}" placeholder="${normsDiffer() ? 'разное по дням' : 'не задано'}"></label>
        </div>
        <label class="fld"><span>ТТК (необязательно)</span><select class="inp" data-f="recipeId">
          <option value="">— нет —</option>
          ${recipes.map((r) => html`<option value="${r.id}" ${r.id === d.recipeId ? 'selected' : ''}>${r.name}</option>`)}
        </select></label>
      </div>
      <div class="card">
        <button class="collapse-head ${daysOpen ? 'open' : ''}" data-act="toggle-days">
          <span class="card-title">Норма и время по дням</span>
          <span class="ch-sum" id="daysSum">${daysSummary()}</span>
          <span class="chev">${icon('down')}</span>
        </button>
        <div class="collapse-body" id="daysBody" ${daysOpen ? '' : 'hidden'}>
        <div class="dgrid">
          <div class="dg-h"></div><div class="dg-h">Норма, <span class="unit-now">${d.unit}</span></div><div class="dg-h">Сделать к</div><div class="dg-h"></div>
          ${WEEKDAYS.map((w, i) => html`
            <div class="dg-day">${w}</div>
            <input class="inp" data-wd="${i}" inputmode="decimal" value="${inNum(d.norms[i])}" placeholder="—">
            <input class="inp" type="time" data-time="${i}" value="${d.times[i] || ''}">
            <button class="icon-btn" data-act="time-clear" data-i="${i}" aria-label="Убрать время" ${d.times[i] ? '' : 'disabled'}>${icon('x')}</button>`)}
          <div class="dg-day all">Все</div>
          <input class="inp" id="allNorm" inputmode="decimal" placeholder="норма">
          <input class="inp" type="time" id="allTime">
          <div></div>
        </div>
        <button class="btn wide mt" data-act="all">Заполнить все дни</button>
        <p class="hint">Пустая норма — в этот день позиция не нужна (если нормы не заданы совсем — нужна каждый день). Время можно оставить пустым.</p>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Напоминания в Telegram</div>
        <div class="rchips" id="rems">${remChips()}</div>
        <button class="btn wide mt" data-act="rem-add">${icon('bell')} Добавить напоминание</button>
        <p class="hint">Бот напишет в чат за выбранное время до «Сделать к». Если позиция уже отмечена сделанной — не напишет.
          ${!botUrl() ? html`<br><b>Бот ещё не подключён</b> — Настройки → Напоминания в Telegram.` : ''}</p>
      </div>
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить позицию</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      bindRefSelects(el, (f, v) => { d[f] = v; });
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'qtyAll') {
          const v = num(t.value);
          d.norms = Array(7).fill(v);
          el.querySelectorAll('[data-wd]').forEach((i) => { i.value = inNum(v); });
          el.querySelector('#daysSum').textContent = daysSummary();
          return;
        }
        if (t.dataset.wd != null) {
          d.norms[+t.dataset.wd] = num(t.value);
          const q = el.querySelector('#qtyAll');
          q.value = inNum(sameNorm());
          q.placeholder = normsDiffer() ? 'разное по дням' : 'не задано';
        }
        else if (t.dataset.time != null) {
          d.times[+t.dataset.time] = t.value || '';
          el.querySelector('#daysSum').textContent = daysSummary();
          const b = el.querySelector(`[data-act="time-clear"][data-i="${t.dataset.time}"]`);
          if (b) b.disabled = !t.value;
        } else if (t.dataset.f && t.dataset.f !== 'stationId') {
          d[t.dataset.f] = t.value;
          if (t.dataset.f === 'unit') { el.querySelector('.unit-now').textContent = t.value; el.querySelector('#daysSum').textContent = daysSummary(); }
        }
      });
      const redrawRems = () => { el.querySelector('#rems').innerHTML = String(remChips()); };
      onActs(el, {
        'toggle-days': (t) => {
          daysOpen = !daysOpen;
          lsSet('kb_daysOpen', daysOpen ? '1' : '0');
          el.querySelector('#daysBody').hidden = !daysOpen;
          t.classList.toggle('open', daysOpen);
        },
        all: () => {
          const v = num(el.querySelector('#allNorm').value);
          const tm = el.querySelector('#allTime').value;
          if (v == null && !tm) { toast('Введите норму и/или время'); return; }
          if (v != null) { d.norms = Array(7).fill(v); el.querySelectorAll('[data-wd]').forEach((i) => { i.value = inNum(v); }); }
          if (tm) {
            d.times = Array(7).fill(tm);
            el.querySelectorAll('[data-time]').forEach((i) => { i.value = tm; });
            el.querySelectorAll('[data-act="time-clear"]').forEach((b) => { b.disabled = false; });
          }
          el.querySelector('#qtyAll').value = inNum(sameNorm());
          el.querySelector('#daysSum').textContent = daysSummary();
          haptic('select');
        },
        'time-clear': (t) => {
          const i = +t.dataset.i;
          d.times[i] = '';
          el.querySelector(`[data-time="${i}"]`).value = '';
          t.disabled = true;
          el.querySelector('#daysSum').textContent = daysSummary();
        },
        'rem-add': async () => {
          const r = await durationSheet('Напомнить заранее — за сколько до «Сделать к»?', { okLabel: 'Добавить', allowZero: true });
          if (!r) return;
          if (d.reminders.includes(r.sec)) { toast('Такое напоминание уже есть'); return; }
          d.reminders.push(r.sec);
          redrawRems();
          haptic('select');
        },
        'rem-del': (t) => {
          d.reminders = d.reminders.filter((s) => s !== +t.dataset.s);
          redrawRems();
        },
        save: () => {
          if (!d.name.trim()) { toast('Введите название', 'error'); return; }
          if (d.reminders.length && !d.times.some(Boolean)) toast('Напоминания сработают, когда будет задано время «Сделать к»');
          saved = true;
          S.batch(() => {
            S.put('prepItems', { ...d, id: d.id || uid(), name: d.name.trim(), stationId: S.resolveRef('stations', d.stationId) }, { silent: true });
          });
          haptic('success');
          toast('Сохранено');
          back(true);
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить позицию «${d.name}»?`, 'Удалить', true))) return;
          S.remove('prepItems', d.id);
          saved = true;
          back(true);
        },
      });
    },
  };
}
