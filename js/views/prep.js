// Раздел «Заготовки»: нормы и время «Сделать к» по дням недели, напоминания в Telegram, таймеры.
// Режимы «Сегодня/Завтра» и «Неделя».

import { html, uid, clone, num, fmtNum, lsGet, lsSet, WEEKDAYS, dateISO, addDays, weekdayIdx, fmtDayLong, fmtDuration, fmtCountdown, fmtClock } from '../util.js';
import * as S from '../store.js';
import { push, back, refresh, toast, confirmDialog, onActs, showText, sheet, actionSheet } from '../ui.js';
import { haptic, shareText, inTelegram } from '../tg.js';
import { refSelect, bindRefSelects, fab, emptyState, segmented, chips, icon, inNum } from './common.js';
import { recipeDetail } from './ttk.js';
import { planScreen } from './planview.js';
import { activeBatches, groupBatches, relLeft, fmtDT, expirySettings, saveExpirySettings } from '../batches.js';
import { W } from '../tg.js';
import { getLog, normOf, timeOf, toMake, deadlineOf, putLog, sortItems, grouped, neededOn, statusOf, byTime, prepText, isOnce, logDateOf, logFor, dayItems, carriedLabel, dayMonth, oldOnceItems } from '../prepcore.js';
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
  const entries = dayItems(iso);
  const carried = new Map(entries.filter((e) => e.carried).map((e) => [e.it.id, e.carried]));
  const items = sortItems(entries.map((e) => e.it));
  const skipped = S.list('prepItems').filter((i) => !isOnce(i) && !neededOn(i, wd)).length;
  const by = { active: [], done: [], closed: [] };
  for (const it of items) by[statusOf(logFor(it, iso))].push(it);
  const doneN = by.done.length;
  const total = items.length - by.closed.length;
  const pct = total ? Math.round((doneN / total) * 100) : 0;
  const activeRow = (it) => {
    const log = logFor(it, iso);
    const n = normOf(it, wd);
    const m = toMake(it, wd, log);
    const time = timeOf(it, wd, log);
    const dl = deadlineOf(isOnce(it) ? new Date(it.date + 'T00:00:00') : date, time);
    const late = dl && dl < now;
    const rem = (it.reminders || []).length;
    const from = carried.get(it.id);
    return html`<div class="prow ${late ? 'late' : ''}" data-id="${it.id}">
      ${from ? html`<div class="pr-carried">${icon('clock')} ${carriedLabel(from)}</div>` : ''}
      <div class="pr-line">
        <button class="pr-name" data-act="edit" data-id="${it.id}">${it.name}</button>
        <button class="icon-btn pr-timer" data-act="timer" data-id="${it.id}" aria-label="Таймер">${icon('timer')}</button>
        <button class="icon-btn pr-tag" data-act="mark" data-id="${it.id}" aria-label="Маркировка">${icon('tag')}</button>
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
        ${it.shelfH ? html`<span class="pr-rem">срок ${shelfLabel(it.shelfH)}</span>` : ''}
        ${!isOnce(it) ? html`<span class="pr-rem">↻ повтор</span>` : ''}
        ${it.recipeId && S.get('recipes', it.recipeId) ? html`<button class="linkish" data-act="recipe" data-id="${it.recipeId}">ТТК ›</button>` : ''}
      </div>
    </div>`;
  };
  const closedRow = (it, kind) => {
    const log = logFor(it, iso);
    const at = kind === 'done' ? log.doneAt : log.closedAt;
    const n = normOf(it, wd);
    return html`<div class="prow ${kind}" data-id="${it.id}">
      <div class="pr-line">
        <span class="pr-mark ${kind}">${icon(kind === 'done' ? 'check' : 'x')}</span>
        <button class="pr-name" data-act="edit" data-id="${it.id}">${it.name}</button>
        ${kind === 'done' ? html`<button class="icon-btn pr-tag" data-act="mark" data-id="${it.id}" aria-label="Маркировка">${icon('tag')}</button>` : ''}
        <button class="btn sm" data-act="restore" data-id="${it.id}">Вернуть</button>
      </div>
      <div class="pr-sub">${kind === 'done' ? 'выполнено' : 'завершено без выполнения'}${at ? ` в ${fmtClock(at)}` : ''}${n != null && kind === 'done' ? ` · ${fmtNum(n)} ${it.unit}` : ''}</div>
    </div>`;
  };
  const list = by[st.list] || by.active;
  const rowFn = st.list === 'active' ? activeRow : (it) => closedRow(it, st.list);
  const emptyText = { active: items.length ? 'Все задачи на этот день закрыты 👍' : 'На этот день заготовок нет — нажмите «+»', done: 'Пока ничего не выполнено', closed: 'Ничего не завершено без выполнения' }[st.list];
  return html`
    <div class="card day-card">
      <svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="ring-bg"/>${pct ? html`<circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/>` : ''}</svg>
      <div class="day-head"><b>${fmtDayLong(date)}</b><span class="muted">Готово ${doneN} из ${total}${pct === 100 && total ? ' 🎉' : ''}</span></div>
      <div class="ring-pct">${pct}%</div>
    </div>
    ${toolsRow()}
    ${timersCard()}
    ${chips('plist', st.list, [
      { id: 'active', label: 'Активные', count: by.active.length },
      { id: 'done', label: 'Выполнено', count: by.done.length },
      { id: 'closed', label: 'Завершено', count: by.closed.length },
    ])}
    ${list.length ? grouped(list).map((g) => html`<div class="group-title">${g.name}</div><div class="card plist">${byTime(g.items, wd, iso).map(rowFn)}</div>`)
      : html`<div class="empty small">${emptyText}</div>`}
    ${st.list === 'active' && by.active.length ? html`<p class="hint pad-x">✓ — выполнено, ✕ — завершить без выполнения.</p>` : ''}
    ${skipped ? html`<div class="muted small pad-x">Повторяющихся без нормы на этот день: ${skipped}</div>` : ''}
    <div class="row gap mt">
      <button class="btn grow" data-act="share">${icon('share')} Поделиться</button>
      <button class="btn ghost danger" data-act="reset">Сбросить день</button>
    </div>`;
}

const toolsRow = () => html`<div class="tools-row">
  <button class="btn" data-act="timer-new">${icon('timer')} Таймер</button>
  <button class="btn" data-act="plan">${icon('send')} План</button>
  <button class="btn icon-only" data-act="more-menu" aria-label="Ещё">${icon('more')}</button>
</div>`;

function weekView() {
  const all = sortItems(S.list('prepItems').filter((i) => !isOnce(i)));
  if (!all.length) return emptyState('Повторяющихся заготовок нет', 'Здесь таблица норм по дням недели для заготовок с включённым «Повторять». Разовые заготовки — на «Сегодня» и «Завтра».', '', '↻');
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


// ---- Срок реализации, маркировка, «Сроки» --------------------------------------------------
const shelfSplit = (h) => (!(h > 0) ? { n: null, u: 'h' } : h % 24 === 0 ? { n: h / 24, u: 'd' } : { n: h, u: 'h' });
const shelfLabel = (h) => { const x = shelfSplit(h); return x.n ? `${fmtNum(x.n)} ${x.u === 'd' ? 'сут' : 'ч'}` : ''; };
const toLocalInput = (ts) => { const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
function expLabel() {
  const g = groupBatches();
  const n = g.over.length + g.today.length;
  return n ? `Сроки · ${n}` : 'Сроки';
}

async function markFlow(it) {
  if (!it) return;
  const iso = dateISO(dayDate());
  const wd = weekdayIdx(dayDate());
  const log = logFor(it, iso);
  const qty0 = toMake(it, wd, log) || normOf(it, wd);
  const who0 = lsGet('kb_who') || W?.initDataUnsafe?.user?.first_name || '';
  const sh = shelfSplit(it.shelfH);
  const r = await sheet({
    title: `Маркировка: ${it.name}`,
    body: html`
      <label class="fld"><span>Изготовлено</span><input class="inp" type="datetime-local" id="mMade" value="${toLocalInput(Date.now())}"></label>
      <div class="row gap">
        <label class="fld grow"><span>Срок реализации</span><input class="inp" id="mShelf" inputmode="decimal" value="${inNum(sh.n)}" placeholder="часов или суток"></label>
        <label class="fld w100"><span>Ед.</span><select class="inp" id="mShelfU"><option value="h" ${sh.u === 'h' ? 'selected' : ''}>ч</option><option value="d" ${sh.u === 'd' ? 'selected' : ''}>сут</option></select></label>
      </div>
      <div class="mark-until">Годен до: <b id="mUntil">—</b></div>
      <div class="row gap">
        <label class="fld grow"><span>Количество</span><input class="inp" id="mQty" inputmode="decimal" value="${inNum(qty0)}"></label>
        <label class="fld w100"><span>Ед.</span><input class="inp" id="mUnit" value="${it.unit || ''}"></label>
      </div>
      <label class="fld"><span>Кто сделал</span><input class="inp" id="mWho" value="${who0}" placeholder="Имя"></label>`,
    buttons: [
      { label: 'Отмена', kind: 'ghost' },
      {
        label: 'Сохранить', kind: 'primary', value: (w) => {
          const made = new Date(w.querySelector('#mMade').value).getTime() || Date.now();
          const n = num(w.querySelector('#mShelf').value);
          const hours = n > 0 ? (w.querySelector('#mShelfU').value === 'd' ? n * 24 : n) : null;
          return { made, hours, qty: num(w.querySelector('#mQty').value), unit: w.querySelector('#mUnit').value.trim(), who: w.querySelector('#mWho').value.trim() };
        },
      },
    ],
    onMount: (el) => {
      const upd = () => {
        const made = new Date(el.querySelector('#mMade').value).getTime();
        const n = num(el.querySelector('#mShelf').value);
        const h = n > 0 ? (el.querySelector('#mShelfU').value === 'd' ? n * 24 : n) : null;
        el.querySelector('#mUntil').textContent = made && h ? fmtDT(made + h * 3600e3) : 'укажите срок реализации';
      };
      el.addEventListener('input', upd); el.addEventListener('change', upd); upd();
    },
  });
  if (!r) return;
  if (!r.hours) { toast('Укажите срок реализации — без него не посчитать «годен до»', 'error'); return; }
  if (r.who) lsSet('kb_who', r.who);
  if (!it.shelfH) S.put('prepItems', { ...it, shelfH: r.hours }); // запомним срок у позиции
  const b = S.put('batches', { id: uid(), prepItemId: it.id, name: it.name, unit: r.unit, qty: r.qty, madeAt: r.made, expiresAt: r.made + r.hours * 3600e3, by: r.who, status: 'active' });
  haptic('success');
  showLabel(b);
}

function showLabel(b) {
  if (!b) return;
  const el = document.createElement('div');
  el.className = 'label-view';
  el.innerHTML = String(html`<div class="label-card">
      <div class="lb-name">${b.name}</div>
      <div class="lb-row"><span>Изготовлено</span><b>${fmtDT(b.madeAt)}</b></div>
      <div class="lb-row big"><span>Годен до</span><b>${fmtDT(b.expiresAt)}</b></div>
      ${b.qty != null ? html`<div class="lb-row"><span>Количество</span><b>${fmtNum(b.qty)} ${b.unit || ''}</b></div>` : ''}
      ${b.by ? html`<div class="lb-row"><span>Кто</span><b>${b.by}</b></div>` : ''}
    </div>
    <p class="lb-hint">Перепишите на стикер. Партия сохранена в «Заготовки → Сроки».</p>
    <button class="btn primary wide">Готово</button>`);
  el.querySelector('.btn').addEventListener('click', () => { el.remove(); refresh(); });
  document.body.appendChild(el);
}

async function closeBatch(id, status) {
  const b = S.get('batches', id);
  if (!b) return;
  if (status === 'written' && !(await confirmDialog(`Списать «${b.name}»?`, 'Списать', true))) return;
  S.put('batches', { ...b, status, closedAt: Date.now() });
  haptic(status === 'used' ? 'success' : 'light');
  toast(status === 'used' ? 'Отмечено: использовано' : 'Списано');
  refresh();
}

function expView() {
  const now = Date.now();
  const g = groupBatches(now);
  const e = expirySettings();
  const row = (b) => html`<div class="brow ${b.expiresAt <= now ? 'over' : ''}">
    <button class="b-main" data-act="b-label" data-id="${b.id}">
      <div class="b-name">${b.name}${b.qty != null ? html` <small>${fmtNum(b.qty)} ${b.unit || ''}</small>` : ''}</div>
      <div class="b-sub">до ${fmtDT(b.expiresAt)} · ${relLeft(b.expiresAt, now)}${b.by ? ` · ${b.by}` : ''}</div>
    </button>
    <div class="b-btns">
      <button class="btn sm" data-act="b-used" data-id="${b.id}">Использовано</button>
      <button class="btn sm ghost danger" data-act="b-written" data-id="${b.id}">Списано</button>
    </div>
  </div>`;
  const block = (title, list, cls = '') => (list.length ? html`<div class="group-title ${cls}">${title} · ${list.length}</div><div class="card list-card">${list.map(row)}</div>` : '');
  const total = activeBatches().length;
  return html`
    <div class="card">
      <label class="switch-row" style="margin:0" data-act="exp-alerts"><input type="checkbox" ${e.alerts ? 'checked' : ''}><span class="sw"></span><span class="sw-text"><b>Предупреждать в Telegram</b><small>о конце срока — бот напишет заранее</small></span></label>
      ${e.alerts ? html`<button class="btn wide mt" data-act="exp-lead">${icon('bell')} ${e.lead ? `за ${fmtDuration(e.lead)} до конца срока` : 'в момент окончания срока'}</button>` : ''}
    </div>
    ${total ? html`${block('Просрочено', g.over, 'danger-text')}${block('Истекает сегодня', g.today)}${block('Завтра', g.tomorrow)}${block('Позже', g.later)}`
      : emptyState('Партий пока нет', 'Нажмите 🏷 у заготовки на «Сегодня», чтобы промаркировать её — партия появится здесь со сроком годности.', '', '🏷')}`;
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
        <div class="toolbar sticky">${segmented('mode', st.mode, [{ id: 'today', label: 'Сегодня' }, { id: 'tomorrow', label: 'Завтра' }, { id: 'week', label: 'Неделя' }, { id: 'exp', label: expLabel() }])}</div>
        ${!any ? html`${timersCard()}${emptyState('Заготовок пока нет', 'Добавьте заготовку на сегодня или на любой день. Постоянные можно сделать повторяющимися.', html`<div class="stack"><button class="btn primary" data-act="add">Добавить заготовку</button><button class="btn" data-act="timer-new">${icon('timer')} Таймер</button><button class="btn" data-act="plan">${icon('send')} План в Telegram</button></div>`, '🔪')}`
          : st.mode === 'week' ? weekView() : st.mode === 'exp' ? expView() : dayView()}
        ${st.mode === 'exp' && any ? '' : fab()}`;
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
          saveLeft(it.id, logDateOf(it, dateISO(date)), v);
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
        add: () => push(prepForm({ date: dayDate() })),
        edit: (t) => push(prepForm({ item: S.get('prepItems', t.dataset.id) })),
        recipe: (t) => push(recipeDetail(t.dataset.id)),
        chip: (t) => { flushLeft(); st.list = t.dataset.v; refresh(); },
        done: (t) => {
          const id = t.dataset.id;
          const iso = logDateOf(S.get('prepItems', id), dateISO(dayDate()));
          flushLeft();
          const prev = getLog(iso, id);
          const leftInput = el.querySelector(`[data-left="${id}"]`);
          putLog(iso, id, { left: leftInput ? num(leftInput.value) : prev.left, done: true, closed: false, doneAt: Date.now() });
          haptic('success');
          toast(`✓ ${S.get('prepItems', id)?.name || ''} — в выполненных`);
          refresh();
        },
        close: (t) => {
          const id = t.dataset.id;
          const iso = logDateOf(S.get('prepItems', id), dateISO(dayDate()));
          flushLeft();
          putLog(iso, id, { done: false, closed: true, closedAt: Date.now() });
          haptic('light');
          toast(`✕ ${S.get('prepItems', id)?.name || ''} — в завершённых`);
          refresh();
        },
        restore: (t) => {
          putLog(logDateOf(S.get('prepItems', t.dataset.id), dateISO(dayDate())), t.dataset.id, { done: false, closed: false, doneAt: null, closedAt: null });
          haptic('select');
          toast('Вернули в активные');
          refresh();
        },
        time: async (t) => {
          const date = dayDate();
          const it = S.get('prepItems', t.dataset.id);
          const iso = logDateOf(it, dateISO(date));
          const log = getLog(iso, it.id);
          const usual = isOnce(it) ? it.time || '' : it.times?.[weekdayIdx(date)] || '';
          const r = await sheet({
            title: `${it.name}: сделать к — ${fmtDayLong(date)}`,
            body: html`<input class="inp time-big" type="time" id="tval" value="${timeOf(it, weekdayIdx(date), log)}">
              <p class="hint">${usual ? `Обычно в этот день — к ${usual}.` : 'Обычного времени на этот день нет.'} ${isOnce(it) ? '' : `Изменение действует только на ${st.mode === 'tomorrow' ? 'завтра' : 'сегодня'}; постоянное время — в карточке позиции.`}</p>`,
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
        'more-menu': async () => {
          const n = oldOnceItems().length;
          const v = await actionSheet('Заготовки', [
            { label: `Старые разовые заготовки${n ? ` (${n})` : ''}`, value: 'old', hint: 'выполненные и снятые за прошлые дни — вернуть можно отсюда' },
          ]);
          if (v === 'old') push(oldScreen());
        },
        mark: (t) => markFlow(S.get('prepItems', t.dataset.id)),
        'b-used': (t) => closeBatch(t.dataset.id, 'used'),
        'b-written': (t) => closeBatch(t.dataset.id, 'written'),
        'b-label': (t) => showLabel(S.get('batches', t.dataset.id)),
        'exp-alerts': () => { const e = expirySettings(); e.alerts = !e.alerts; saveExpirySettings(e); refresh(); },
        'exp-lead': async () => {
          const e = expirySettings();
          const r = await durationSheet('Предупреждать за сколько до конца срока?', { initial: e.lead, okLabel: 'Готово', allowZero: true });
          if (!r) return;
          e.lead = r.sec; saveExpirySettings(e); refresh();
        },
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

// ---- Старые разовые заготовки ------------------------------------------------------------------
function oldScreen() {
  let open = '';
  return {
    tab: 'prep',
    title: 'Старые разовые',
    render() {
      const list = oldOnceItems();
      if (!list.length) return emptyState('Пусто', 'Здесь появляются выполненные и снятые разовые заготовки прошлых дней. Хранятся 30 дней.', '', '🗂');
      const byDate = new Map();
      for (const it of list) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
      return html`<p class="hint pad-x mt0">Нажмите на заготовку, чтобы вернуть её в работу. Хранятся 30 дней.</p>
        ${[...byDate.entries()].map(([iso, items]) => html`<div class="group-title">${fmtDayLong(new Date(iso + 'T12:00:00'))}</div>
          <div class="card list-card">${items.map((it) => {
            const log = getLog(it.date, it.id);
            const kind = statusOf(log);
            return html`<div class="old-row ${open === it.id ? 'open' : ''}">
              <button class="old-main" data-act="toggle" data-id="${it.id}">
                <span class="pr-mark ${kind}">${icon(kind === 'done' ? 'check' : 'x')}</span>
                <span class="old-name">${it.name}${it.qty != null ? html` <small>${fmtNum(it.qty)} ${it.unit || ''}</small>` : ''}</span>
                <span class="chev">${icon('down')}</span>
              </button>
              ${open === it.id ? html`<div class="old-btns">
                <button class="btn sm" data-act="back-same" data-id="${it.id}">Вернуть на ${dayMonth(it.date)}</button>
                <button class="btn sm" data-act="back-other" data-id="${it.id}">${icon('clock')} Вернуть на другую дату</button>
              </div>` : ''}
            </div>`;
          })}</div>`)}`;
    },
    mount(el) {
      const clearLog = (it) => { const l = S.get('prepLog', `${it.date}|${it.id}`); if (l) S.remove('prepLog', l.id, { silent: true }); };
      onActs(el, {
        toggle: (t) => { open = open === t.dataset.id ? '' : t.dataset.id; refresh(); },
        'back-same': (t) => {
          const it = S.get('prepItems', t.dataset.id);
          S.batch(() => clearLog(it));
          haptic('success');
          toast(`«${it.name}» снова в работе — ${carriedLabel(it.date)}`);
          refresh();
        },
        'back-other': async (t) => {
          const it = S.get('prepItems', t.dataset.id);
          const r = await sheet({
            title: `Вернуть «${it.name}» на дату`,
            body: html`<label class="fld"><span>Дата</span><input class="inp" type="date" id="bd" value="${dateISO()}"></label>
              <label class="fld"><span>Сделать к (необязательно)</span><input class="inp" type="time" id="bt" value="${it.time || ''}"></label>`,
            buttons: [{ label: 'Отмена', kind: 'ghost' }, { label: 'Вернуть', kind: 'primary', value: (w) => ({ date: w.querySelector('#bd').value, time: w.querySelector('#bt').value }) }],
          });
          if (!r || !r.date) return;
          S.batch(() => { clearLog(it); S.put('prepItems', { ...it, date: r.date, time: r.time || '' }, { silent: true }); });
          haptic('success');
          toast(`«${it.name}» перенесена на ${dayMonth(r.date)}${r.time ? `, к ${r.time}` : ''}`);
          refresh();
        },
      });
    },
  };
}

// ---- Карточка позиции ---------------------------------------------------------------------
function prepForm({ item, date }) {
  const isNew = !item;
  const d = item ? clone(item) : {
    name: '', stationId: '', once: true, date: dateISO(date || new Date()), time: '', qty: null, unit: 'кг', shelfH: null, recipeId: '',
    norms: Array(7).fill(null), times: Array(7).fill(''), reminders: [],
  };
  d.norms = d.norms || Array(7).fill(null);
  d.times = Array.isArray(d.times) ? d.times : Array(7).fill('');
  d.reminders = Array.isArray(d.reminders) ? d.reminders : [];
  if (!d.once && !d.date) d.date = dateISO();
  const initial = JSON.stringify(d);
  let saved = false;
  let moreOpen = false; // «Подробнее» всегда открывается свёрнутым
  const recipes = S.list('recipes').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const filled = () => d.norms.map((v) => (num(v) > 0 ? num(v) : null));
  const normsDiffer = () => new Set(filled().map(String)).size > 1;
  const sameNorm = () => (normsDiffer() ? null : filled()[0]);
  const qtyVal = () => (d.once ? d.qty : sameNorm());
  const moreSummary = () => {
    const parts = [];
    const q = qtyVal();
    if (q != null) parts.push(`${fmtNum(q)} ${d.unit}`);
    else if (!d.once && normsDiffer()) parts.push('количество по дням');
    if (d.shelfH) parts.push(`срок ${shelfLabel(d.shelfH)}`);
    const r = d.recipeId && S.get('recipes', d.recipeId);
    if (r) parts.push(`ТТК: ${r.name}`);
    return parts.join(' · ') || 'единица, количество, срок реализации, ТТК';
  };
  const today = dateISO(), tomorrow = dateISO(addDays(new Date(), 1));
  const remChips = () => html`${d.reminders.length
    ? [...d.reminders].sort((a, b) => b - a).map((s) => html`<span class="rchip">${icon('bell')} ${s ? `за ${fmtDuration(s)}` : 'в срок'}<button data-act="rem-del" data-s="${s}" aria-label="Убрать">${icon('x')}</button></span>`)
    : html`<span class="muted small">Выключены</span>`}`;
  return {
    tab: 'prep',
    form: true,
    title: isNew ? 'Новая заготовка' : 'Заготовка',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => html`
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" data-f="name" value="${d.name}" placeholder="Например, Соус цезарь"></label>
        <label class="fld"><span>Цех / станция</span>${refSelect('stations', d.stationId, { field: 'stationId', addLabel: '＋ Новый цех…' })}</label>
      </div>
      <div class="card">
        ${segmented('pmode', d.once ? 'once' : 'repeat', [{ id: 'once', label: 'Разовая' }, { id: 'repeat', label: '↻ Повторять' }])}
        ${d.once ? html`
          <div class="fld mt"><span>Когда</span>
            <div class="day-chips">
              <button class="day-chip ${d.date === today ? 'on' : ''}" data-act="pick-day" data-v="${today}">Сегодня</button>
              <button class="day-chip ${d.date === tomorrow ? 'on' : ''}" data-act="pick-day" data-v="${tomorrow}">Завтра</button>
              <input class="inp" type="date" id="pDate" value="${d.date}" style="flex:1;min-width:0">
            </div>
          </div>
          <div class="fld"><span>Сделать к (необязательно)</span>
            <div class="row gap"><input class="inp grow" type="time" id="pTime" value="${d.time || ''}"><button class="icon-btn" data-act="clear-time" aria-label="Убрать время" ${d.time ? '' : 'disabled'}>${icon('x')}</button></div>
          </div>`
        : html`
          <div class="dgrid mt">
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
          <p class="hint">Пустая норма — в этот день не нужна (если нормы не заданы совсем — каждый день).</p>`}
      </div>
      <div class="card">
        <button class="collapse-head ${moreOpen ? 'open' : ''}" data-act="toggle-more">
          <span class="card-title">Подробнее</span>
          <span class="ch-sum" id="moreSum">${moreSummary()}</span>
          <span class="chev">${icon('down')}</span>
        </button>
        <div class="collapse-body" id="moreBody" ${moreOpen ? '' : 'hidden'}>
          <div class="row gap">
            <label class="fld w100"><span>Единица</span><select class="inp" data-f="unit">${[...new Set([...PREP_UNITS, d.unit])].map((u) => html`<option ${u === d.unit ? 'selected' : ''}>${u}</option>`)}</select></label>
            <label class="fld grow"><span>${d.once ? 'Количество' : 'Количество (на каждый день)'}</span><input class="inp" id="qtyAll" inputmode="decimal" value="${inNum(qtyVal())}" placeholder="${!d.once && normsDiffer() ? 'разное по дням' : 'не задано'}"></label>
          </div>
          <div class="row gap">
            <label class="fld grow"><span>Срок реализации</span><input class="inp" id="shelfN" inputmode="decimal" value="${inNum(shelfSplit(d.shelfH).n)}" placeholder="например, 48"></label>
            <label class="fld w100"><span>Ед.</span><select class="inp" id="shelfU"><option value="h" ${shelfSplit(d.shelfH).u === 'h' ? 'selected' : ''}>ч</option><option value="d" ${shelfSplit(d.shelfH).u === 'd' ? 'selected' : ''}>сут</option></select></label>
          </div>
          <label class="fld"><span>ТТК (необязательно)</span><select class="inp" data-f="recipeId">
            <option value="">— нет —</option>
            ${recipes.map((r) => html`<option value="${r.id}" ${r.id === d.recipeId ? 'selected' : ''}>${r.name}</option>`)}
          </select></label>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Напоминания в Telegram</div>
        <div class="rchips" id="rems">${remChips()}</div>
        <button class="btn wide mt" data-act="rem-add">${icon('bell')} Добавить напоминание</button>
        <p class="hint">Бот напишет в чат за выбранное время до «Сделать к». Если заготовка уже отмечена сделанной — не напишет.
          ${!botUrl() ? html`<br><b>Бот ещё не подключён</b> — Настройки → Напоминания в Telegram.` : ''}</p>
      </div>
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить заготовку</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      bindRefSelects(el, (f, v) => { d[f] = v; });
      const sum = () => { const m = el.querySelector('#moreSum'); if (m) m.textContent = moreSummary(); };
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'pDate') { d.date = t.value || dateISO(); el.querySelectorAll('.day-chip').forEach((b) => b.classList.toggle('on', b.dataset.v === d.date)); return; }
        if (t.id === 'pTime') { d.time = t.value || ''; const b = el.querySelector('[data-act="clear-time"]'); if (b) b.disabled = !t.value; return; }
        if (t.id === 'shelfN' || t.id === 'shelfU') {
          const nv = num(el.querySelector('#shelfN').value);
          d.shelfH = nv > 0 ? (el.querySelector('#shelfU').value === 'd' ? nv * 24 : nv) : null;
          sum(); return;
        }
        if (t.id === 'qtyAll') {
          const v = num(t.value);
          if (d.once) d.qty = v;
          else { d.norms = Array(7).fill(v); el.querySelectorAll('[data-wd]').forEach((i) => { i.value = inNum(v); }); }
          sum(); return;
        }
        if (t.dataset.wd != null) {
          d.norms[+t.dataset.wd] = num(t.value);
          const q = el.querySelector('#qtyAll');
          if (q) { q.value = inNum(sameNorm()); q.placeholder = normsDiffer() ? 'разное по дням' : 'не задано'; }
          sum();
        } else if (t.dataset.time != null) {
          d.times[+t.dataset.time] = t.value || '';
          const b = el.querySelector(`[data-act="time-clear"][data-i="${t.dataset.time}"]`);
          if (b) b.disabled = !t.value;
        } else if (t.dataset.f && t.dataset.f !== 'stationId') {
          d[t.dataset.f] = t.value;
          if (t.dataset.f === 'unit') { const u = el.querySelector('.unit-now'); if (u) u.textContent = t.value; }
          sum();
        }
      });
      const redrawRems = () => { el.querySelector('#rems').innerHTML = String(remChips()); };
      onActs(el, {
        seg: (t) => {
          if (t.dataset.seg !== 'pmode') return;
          const toOnce = t.dataset.v === 'once';
          if (toOnce === !!d.once) return;
          if (toOnce) { d.once = true; d.date = d.date || dateISO(); d.qty = d.qty ?? sameNorm(); }
          else { d.once = false; if (d.qty != null && !d.norms.some((v) => num(v) > 0)) d.norms = Array(7).fill(d.qty); if (d.time && !d.times.some(Boolean)) d.times = Array(7).fill(d.time); }
          refresh();
        },
        'pick-day': (t) => { d.date = t.dataset.v; el.querySelector('#pDate').value = d.date; el.querySelectorAll('.day-chip').forEach((b) => b.classList.toggle('on', b.dataset.v === d.date)); haptic('select'); },
        'clear-time': (t) => { d.time = ''; el.querySelector('#pTime').value = ''; t.disabled = true; },
        'toggle-more': (t) => {
          moreOpen = !moreOpen;
          el.querySelector('#moreBody').hidden = !moreOpen;
          t.classList.toggle('open', moreOpen);
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
          const q = el.querySelector('#qtyAll'); if (q) q.value = inNum(sameNorm());
          sum();
          haptic('select');
        },
        'time-clear': (t) => {
          const i = +t.dataset.i;
          d.times[i] = '';
          el.querySelector(`[data-time="${i}"]`).value = '';
          t.disabled = true;
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
          const hasTime = d.once ? !!d.time : d.times.some(Boolean);
          if (d.reminders.length && !hasTime) toast('Напоминания сработают, когда будет задано время «Сделать к»');
          saved = true;
          S.batch(() => {
            S.put('prepItems', { ...d, once: !!d.once, date: d.once ? d.date || dateISO() : '', id: d.id || uid(), name: d.name.trim(), stationId: S.resolveRef('stations', d.stationId) }, { silent: true });
          });
          haptic('success');
          toast(d.once && d.date !== dateISO() ? `Сохранено на ${dayMonth(d.date)}` : 'Сохранено');
          back(true);
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить заготовку «${d.name}»?`, 'Удалить', true))) return;
          S.remove('prepItems', d.id);
          saved = true;
          back(true);
        },
      });
    },
  };
}
