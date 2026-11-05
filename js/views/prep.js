// Раздел «Заготовки»: матрица норм по дням недели, режим «Сегодня/Завтра» и «Неделя»

import { html, uid, clone, num, fmtNum, WEEKDAYS, dateISO, addDays, weekdayIdx, fmtDayLong } from '../util.js';
import * as S from '../store.js';
import { push, back, refresh, toast, confirmDialog, onActs, showText } from '../ui.js';
import { haptic, shareText } from '../tg.js';
import { refSelect, bindRefSelects, fab, emptyState, segmented, icon, inNum } from './common.js';
import { recipeDetail } from './ttk.js';

const PREP_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'порц', 'гастро', 'конт', 'бут'];
const st = { mode: 'today' };

const dayDate = () => (st.mode === 'tomorrow' ? addDays(new Date(), 1) : new Date());
const logId = (date, itemId) => `${date}|${itemId}`;
const getLog = (date, itemId) => S.get('prepLog', logId(date, itemId)) || { left: null, done: false };
const normOf = (it, wd) => num(it.norms?.[wd]) ?? null;
const toMake = (it, wd, log) => {
  const n = normOf(it, wd);
  if (n == null) return null;
  return Math.max(0, Math.round((n - (log.left || 0)) * 1000) / 1000);
};

function grouped(items) {
  const stations = S.sortedList('stations');
  const groups = stations.map((s) => ({ id: s.id, name: s.name, items: items.filter((i) => i.stationId === s.id) }));
  const known = new Set(stations.map((s) => s.id));
  const rest = items.filter((i) => !known.has(i.stationId));
  if (rest.length) groups.push({ id: '', name: 'Без цеха', items: rest });
  return groups.filter((g) => g.items.length);
}
const sortItems = (arr) => arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'));

export function prepText(date) {
  const wd = weekdayIdx(date);
  const iso = dateISO(date);
  const items = sortItems(S.list('prepItems')).filter((i) => normOf(i, wd) > 0);
  const L = [`Заготовки на ${fmtDayLong(date)}:`];
  const done = [];
  for (const g of grouped(items)) {
    const lines = [];
    for (const it of g.items) {
      const log = getLog(iso, it.id);
      const m = toMake(it, wd, log);
      if (log.done) { done.push(it.name); continue; }
      if (!m) continue;
      let s = `• ${it.name} — ${fmtNum(m)} ${it.unit || ''}`.trim();
      if (log.left) s += ` (норма ${fmtNum(normOf(it, wd))}, остаток ${fmtNum(log.left)})`;
      lines.push(s);
    }
    if (lines.length) L.push('', g.name + ':', ...lines);
  }
  if (L.length === 1) L.push('', 'Всё сделано или ничего не нужно 👍');
  if (done.length) L.push('', '✅ Уже готово: ' + done.join(', '));
  return L.join('\n');
}

function dayView() {
  const date = dayDate();
  const iso = dateISO(date);
  const wd = weekdayIdx(date);
  const all = sortItems(S.list('prepItems'));
  const items = all.filter((i) => normOf(i, wd) > 0);
  const skipped = all.length - items.length;
  const doneN = items.filter((i) => getLog(iso, i.id).done).length;
  const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;
  const row = (it) => {
    const log = getLog(iso, it.id);
    const m = toMake(it, wd, log);
    return html`<div class="prow ${log.done ? 'done' : ''}" data-id="${it.id}">
      <div class="pr-line">
        <button class="pr-name" data-act="edit" data-id="${it.id}">${it.name}</button>
        <button class="pr-check ${log.done ? 'on' : ''}" data-act="done" data-id="${it.id}" aria-label="Сделано">${icon('check')}</button>
      </div>
      <div class="pr-line pr-nums">
        <span class="pr-norm">норма <b>${fmtNum(normOf(it, wd))}</b> ${it.unit}</span>
        <label class="pr-left">остаток <input class="inp sm" data-left="${it.id}" inputmode="decimal" value="${inNum(log.left)}" placeholder="0"></label>
        <span class="pr-make">сделать <b data-make="${it.id}">${fmtNum(m)}</b> ${it.unit}</span>
      </div>
      ${it.shelfLife || it.recipeId ? html`<div class="pr-sub">${it.shelfLife ? `хранение: ${it.shelfLife}` : ''}${it.recipeId && S.get('recipes', it.recipeId) ? html` <button class="linkish" data-act="recipe" data-id="${it.recipeId}">ТТК ›</button>` : ''}</div>` : ''}
    </div>`;
  };
  return html`
    <div class="card day-card">
      <svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="ring-bg"/><circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/></svg>
      <div class="day-head"><b>${fmtDayLong(date)}</b><span class="muted">Готово ${doneN} из ${items.length}${pct === 100 && items.length ? ' 🎉' : ''}</span></div>
      <div class="ring-pct">${pct}%</div>
    </div>
    ${items.length ? grouped(items).map((g) => html`<div class="group-title">${g.name}</div><div class="card plist">${g.items.map(row)}</div>`)
      : html`<div class="empty small">На этот день норм нет</div>`}
    ${skipped ? html`<div class="muted small pad-x">Без нормы на этот день: ${skipped}</div>` : ''}
    <div class="row gap mt">
      <button class="btn grow" data-act="share">${icon('share')} Поделиться</button>
      <button class="btn ghost danger" data-act="reset">Сбросить день</button>
    </div>`;
}

function weekView() {
  const all = sortItems(S.list('prepItems'));
  const today = weekdayIdx(new Date());
  return html`
    <p class="hint pad-x">Нормы по дням недели. Меняйте прямо в таблице, нажмите на название, чтобы изменить позицию.</p>
    <div class="wtable-wrap"><table class="wtable">
      <thead><tr><th class="wname">Позиция</th>${WEEKDAYS.map((d, i) => html`<th class="${i === today ? 'today' : ''}">${d}</th>`)}</tr></thead>
      <tbody>${grouped(all).map((g) => html`
        <tr class="wgroup"><td colspan="8">${g.name}</td></tr>
        ${g.items.map((it) => html`<tr>
          <td class="wname"><button class="linkish" data-act="edit" data-id="${it.id}">${it.name}</button><small>${it.unit}</small></td>
          ${WEEKDAYS.map((_, i) => html`<td class="${i === today ? 'today' : ''}"><input class="winp" data-norm="${it.id}" data-wd="${i}" inputmode="decimal" value="${inNum(it.norms?.[i])}"></td>`)}
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
    const prev = getLog(iso, id);
    S.put('prepLog', { id: logId(iso, id), date: iso, itemId: id, left: v, done: !!prev.done });
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
    onLeave: flushLeft,
    render() {
      const any = S.list('prepItems').length;
      return html`
        <div class="toolbar sticky">${segmented('mode', st.mode, [{ id: 'today', label: 'Сегодня' }, { id: 'tomorrow', label: 'Завтра' }, { id: 'week', label: 'Неделя' }])}</div>
        ${!any ? emptyState('Матрица заготовок пуста', 'Добавьте позиции: название, цех, единицу и норму на каждый день недели.', html`<button class="btn primary" data-act="add">Добавить позицию</button>`, '🔪')
          : st.mode === 'week' ? weekView() : dayView()}
        ${fab()}`;
    },
    mount(el) {
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.left) {
          const date = dayDate();
          const iso = dateISO(date);
          const it = S.get('prepItems', t.dataset.left);
          const v = num(t.value);
          const m = toMake(it, weekdayIdx(date), { left: v });
          el.querySelector(`[data-make="${it.id}"]`).textContent = fmtNum(m);
          saveLeft(it.id, iso, v);
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
        seg: (t) => { st.mode = t.dataset.v; refresh(); },
        add: () => push(prepForm({})),
        edit: (t) => push(prepForm({ item: S.get('prepItems', t.dataset.id) })),
        recipe: (t) => push(recipeDetail(t.dataset.id)),
        done: (t) => {
          const iso = dateISO(dayDate());
          const id = t.dataset.id;
          flushLeft();
          const prev = getLog(iso, id);
          const leftInput = el.querySelector(`[data-left="${id}"]`);
          S.put('prepLog', { id: logId(iso, id), date: iso, itemId: id, left: leftInput ? num(leftInput.value) : prev.left, done: !prev.done });
          haptic(prev.done ? 'light' : 'success');
          refresh();
        },
        share: async () => {
          const text = prepText(dayDate());
          const r = await shareText(text);
          if (!r.shared) { if (r.copied) toast('Список скопирован — вставьте в чат'); else showText('Заготовки', text); }
        },
        reset: async () => {
          const iso = dateISO(dayDate());
          if (!(await confirmDialog('Сбросить отметки и остатки за этот день?', 'Сбросить', true))) return;
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

function prepForm({ item }) {
  const isNew = !item;
  const d = item ? clone(item) : { name: '', stationId: '', unit: 'кг', shelfLife: '', recipeId: '', norms: Array(7).fill(null) };
  d.norms = d.norms || Array(7).fill(null);
  const initial = JSON.stringify(d);
  let saved = false;
  const recipes = S.list('recipes').sort((a, b) => a.name.localeCompare(b.name, 'ru'));
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
          <label class="fld grow"><span>Срок хранения</span><input class="inp" data-f="shelfLife" value="${d.shelfLife}" placeholder="Например, 48 ч"></label>
        </div>
        <label class="fld"><span>ТТК (необязательно)</span><select class="inp" data-f="recipeId">
          <option value="">— нет —</option>
          ${recipes.map((r) => html`<option value="${r.id}" ${r.id === d.recipeId ? 'selected' : ''}>${r.name}</option>`)}
        </select></label>
      </div>
      <div class="card">
        <div class="card-title">Норма по дням (${d.unit})</div>
        <div class="norms">${WEEKDAYS.map((w, i) => html`<label><small>${w}</small><input class="inp" data-wd="${i}" inputmode="decimal" value="${inNum(d.norms[i])}"></label>`)}</div>
        <div class="row gap mt">
          <input class="inp grow" id="allNorm" inputmode="decimal" placeholder="Одна норма на все дни">
          <button class="btn" data-act="all">На все дни</button>
        </div>
      </div>
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить позицию</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      bindRefSelects(el, (f, v) => { d[f] = v; });
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.wd != null) d.norms[+t.dataset.wd] = num(t.value);
        else if (t.dataset.f && t.dataset.f !== 'stationId') d[t.dataset.f] = t.value;
      });
      onActs(el, {
        all: () => {
          const v = num(el.querySelector('#allNorm').value);
          if (v == null) { toast('Введите число'); return; }
          d.norms = Array(7).fill(v);
          el.querySelectorAll('[data-wd]').forEach((i) => { i.value = inNum(v); });
          haptic('select');
        },
        save: () => {
          if (!d.name.trim()) { toast('Введите название', 'error'); return; }
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
