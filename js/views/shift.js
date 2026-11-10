// Вкладка «Смена»: чек-листы смены (✓ / ✕ и комментарий), журнал по дням, напоминания и раздел для плана.
// Шаблон: checklists { id, name, items: [{ id, text }], time: 'HH:MM', remind, order }
// Заполнение: checkLog { id: 'YYYY-MM-DD|checklistId', date, checklistId, marks: { itemId: { v: 'ok'|'no', note, at } } }

import { html, uid, clone, dateISO, addDays, fmtDayLong, fmtClock, plural } from '../util.js';
import * as S from '../store.js';
import { push, back, refresh, toast, confirmDialog, onActs, promptSheet, actionSheet, sheet } from '../ui.js';
import { haptic } from '../tg.js';
import { loggedIn } from '../auth.js';
import { icon, fab, emptyState, segmented, busy, saveFile } from './common.js';
import { registerPlanSection } from '../plan.js';
import { registerSchedule, botReady, sendFile } from '../reminders.js';

const st = { view: 'today' };
const isoToDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const checklists = () => S.list('checklists').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
const logOf = (iso, clId) => S.get('checkLog', `${iso}|${clId}`) || { marks: {} };
function progress(cl, iso) {
  const marks = logOf(iso, cl.id).marks || {};
  const items = cl.items || [];
  const done = items.filter((i) => marks[i.id]?.v).length;
  const no = items.filter((i) => marks[i.id]?.v === 'no').length;
  return { done, no, total: items.length, complete: items.length > 0 && done === items.length };
}
function deadline(iso, time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
  if (!m) return null;
  const d = isoToDate(iso); d.setHours(+m[1], +m[2], 0, 0);
  return d.getTime();
}
function setMark(iso, clId, itemId, patch) {
  const id = `${iso}|${clId}`;
  const prev = S.get('checkLog', id) || { id, date: iso, checklistId: clId, marks: {} };
  const marks = { ...(prev.marks || {}) };
  const cur = { ...(marks[itemId] || {}) , ...patch };
  if (!cur.v && !cur.note) delete marks[itemId]; else marks[itemId] = cur;
  S.put('checkLog', { ...prev, id, date: iso, checklistId: clId, marks });
}

// Раздел плана: какие чек-листы ещё не заполнены
registerPlanSection({
  id: 'checks',
  label: 'Чек-листы смены',
  emoji: '🧾',
  hint: 'какие чек-листы ещё не заполнены и к какому времени',
  text: (date) => {
    const iso = dateISO(date);
    return checklists().filter((c) => (c.items || []).length).map((c) => {
      const p = progress(c, iso);
      if (p.complete) return null;
      return `• ${c.name} — ${p.done} из ${p.total}${c.time ? ` (к ${c.time})` : ''}`;
    }).filter(Boolean).join('\n');
  },
});

// Напоминание бота, если чек-лист не заполнен к сроку
registerSchedule((now) => {
  const out = [];
  for (const c of checklists()) {
    if (!c.remind || !c.time || !(c.items || []).length) continue;
    for (let d = 0; d < 14; d++) {
      const iso = dateISO(addDays(new Date(now), d));
      const at = deadline(iso, c.time);
      if (!at || at <= now || progress(c, iso).complete) continue;
      out.push({ at, key: `check|${c.id}|${iso}`, text: `🧾 Чек-лист «${c.name}» не заполнен (срок — ${c.time}).` });
    }
  }
  return out;
});

// ---- Вкладка ---------------------------------------------------------------------------------
export function shiftScreen() {
  return {
    tab: 'shift',
    title: 'Смена',
    subtitle: () => fmtDayLong(new Date()),
    render() {
      const list = checklists();
      if (!list.length) {
        return html`${emptyState('Чек-листов пока нет', 'Создайте чек-листы смены — например, открытие и закрытие. Пункты отмечаются ✓ или ✕, к любому можно добавить комментарий.', html`
          <div class="stack">
            <button class="btn primary" data-act="new" data-name="Открытие смены">${icon('plus')} Открытие смены</button>
            <button class="btn" data-act="new" data-name="Закрытие смены">${icon('plus')} Закрытие смены</button>
            <button class="btn ghost" data-act="new" data-name="">Свой чек-лист</button>
          </div>`, '🧾')}`;
      }
      return html`
        <div class="toolbar sticky">${segmented('view', st.view, [{ id: 'today', label: 'Сегодня' }, { id: 'journal', label: 'Журнал' }])}</div>
        ${st.view === 'journal' ? journalView(list) : todayView(list)}
        ${fab()}`;
    },
    mount(el) {
      onActs(el, {
        seg: (t) => { st.view = t.dataset.v; refresh(); },
        new: (t) => push(editorScreen({ name: t.dataset.name || '' })),
        add: () => push(editorScreen({})),
        fill: (t) => push(fillScreen(t.dataset.id, dateISO())),
        day: (t) => push(dayScreen(t.dataset.iso)),
        excel: () => exportJournal(),
      });
    },
  };
}

function todayView(list) {
  const iso = dateISO();
  const now = Date.now();
  return html`${list.map((c) => {
    const p = progress(c, iso);
    const dl = deadline(iso, c.time);
    const late = !p.complete && dl && dl < now;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return html`<button class="card ccard ${p.complete ? 'complete' : ''} ${late ? 'late' : ''}" data-act="fill" data-id="${c.id}">
      <div class="ic-top"><span class="rc-title">${c.name}</span>
        <span class="badge ${p.complete ? 'st-menu' : late ? 'u-urgent' : ''}">${p.complete ? 'заполнен' : late ? 'просрочен' : `${p.done} из ${p.total}`}</span></div>
      <div class="cbar"><div style="width:${pct}%"></div></div>
      <div class="rc-sub">${p.total} ${plural(p.total, 'пункт', 'пункта', 'пунктов')}${c.time ? ` · заполнить к ${c.time}` : ''}${c.remind && c.time ? ' · 🔔' : ''}${p.no ? ` · ✕ ${p.no}` : ''}</div>
    </button>`;
  })}`;
}

function journalView(list) {
  const days = [];
  for (let d = 0; d < 30; d++) {
    const iso = dateISO(addDays(new Date(), -d));
    const rows = list.map((c) => ({ c, p: progress(c, iso) })).filter((x) => x.p.done || d === 0);
    if (rows.length) days.push({ iso, rows });
  }
  return html`
    <button class="btn wide mb" data-act="excel">${icon('xls')} Журнал в Excel (30 дней)</button>
    ${days.length ? days.map((d) => html`<button class="card jcard" data-act="day" data-iso="${d.iso}">
      <div class="rc-title">${fmtDayLong(isoToDate(d.iso))}</div>
      ${d.rows.map(({ c, p }) => html`<div class="jrow"><span>${c.name}</span><b class="${p.complete ? 'ok' : ''}">${p.done}/${p.total}${p.no ? ` · ✕ ${p.no}` : ''}</b></div>`)}
    </button>`) : html`<div class="empty small">Записей пока нет</div>`}`;
}

// ---- Заполнение чек-листа ------------------------------------------------------------------------
function fillScreen(clId, iso) {
  return {
    tab: 'shift',
    title: 'Чек-лист',
    render() {
      const c = S.get('checklists', clId);
      if (!c) return emptyState('Чек-лист удалён', '');
      const marks = logOf(iso, clId).marks || {};
      const p = progress(c, iso);
      return html`
        <div class="card day-card">
          <div class="day-head"><b>${c.name}</b><span class="muted">${fmtDayLong(isoToDate(iso))} · отмечено ${p.done} из ${p.total}${p.no ? ` · ✕ ${p.no}` : ''}${c.time ? ` · к ${c.time}` : ''}</span></div>
          <div class="ring-pct">${p.total ? Math.round((p.done / p.total) * 100) : 0}%</div>
        </div>
        ${(c.items || []).length ? html`<div class="card list-card">${c.items.map((it) => {
          const m = marks[it.id] || {};
          return html`<div class="crow2 ${m.v || ''}">
            <div class="c2-main"><div class="c2-text">${it.text}</div>
              ${m.at ? html`<div class="c2-at">${fmtClock(m.at)}${m.by ? ` · ${m.by}` : ''}</div>` : ''}</div>
            <button class="note-btn ${m.note ? 'on' : ''}" data-act="note" data-id="${it.id}" aria-label="Комментарий">💬</button>
            <button class="pr-x ${m.v === 'no' ? 'on' : ''}" data-act="no" data-id="${it.id}" aria-label="Нет">${icon('x')}</button>
            <button class="pr-check ${m.v === 'ok' ? 'on' : ''}" data-act="ok" data-id="${it.id}" aria-label="Да">${icon('check')}</button>
            ${m.note ? html`<div class="c2-note wide">💬 ${m.note}</div>` : ''}
          </div>`;
        })}</div>` : html`<div class="empty small">В чек-листе нет пунктов</div>`}
        <button class="btn ghost wide" data-act="edit">${icon('edit')} Изменить пункты</button>`;
    },
    mount(el) {
      const toggle = (t, v) => {
        const cur = logOf(iso, clId).marks?.[t.dataset.id]?.v;
        setMark(iso, clId, t.dataset.id, cur === v ? { v: null, at: null } : { v, at: Date.now() });
        haptic(v === 'ok' ? 'success' : 'light');
        const c = S.get('checklists', clId);
        if (progress(c, iso).complete && cur !== v) toast(`Чек-лист «${c.name}» заполнен ✓`);
        refresh();
      };
      onActs(el, {
        ok: (t) => toggle(t, 'ok'),
        no: (t) => toggle(t, 'no'),
        note: async (t) => {
          const cur = logOf(iso, clId).marks?.[t.dataset.id]?.note || '';
          const v = await promptSheet('Комментарий', { value: cur, placeholder: 'Например: холодильник №2 — +9 °C, вызвали мастера', multiline: true, okLabel: 'Сохранить' });
          if (v === null && !cur) return;
          setMark(iso, clId, t.dataset.id, { note: v || '' });
          refresh();
        },
        edit: () => push(editorScreen({ item: S.get('checklists', clId) })),
      });
    },
  };
}

// Просмотр дня из журнала
function dayScreen(iso) {
  return {
    tab: 'shift',
    title: fmtDayLong(isoToDate(iso)),
    render: () => html`${checklists().map((c) => {
      const marks = logOf(iso, c.id).marks || {};
      const p = progress(c, iso);
      return html`<div class="group-title">${c.name} · ${p.done}/${p.total}</div>
        <div class="card list-card">${(c.items || []).map((it) => {
          const m = marks[it.id] || {};
          return html`<div class="crow2 ${m.v || ''} ro">
            <span class="pr-mark ${m.v === 'ok' ? 'done' : m.v === 'no' ? 'no' : 'none'}">${m.v ? icon(m.v === 'ok' ? 'check' : 'x') : ''}</span>
            <div class="c2-main"><div class="c2-text">${it.text}</div>${m.note ? html`<div class="c2-note">💬 ${m.note}</div>` : ''}</div>
            ${m.at ? html`<small class="c2-at">${fmtClock(m.at)}</small>` : ''}
          </div>`;
        })}</div>`;
    })}
    ${iso === dateISO() ? '' : html`<p class="hint pad-x">Чтобы исправить отметки за этот день, откройте чек-лист:</p>${checklists().map((c) => html`<button class="btn wide mb" data-act="fix" data-id="${c.id}">${c.name}</button>`)}`}`,
    mount(el) { onActs(el, { fix: (t) => push(fillScreen(t.dataset.id, iso)) }); },
  };
}

async function exportJournal() {
  const done = busy('Готовлю Excel…');
  try {
    const { loadLib } = await import('../importfile.js');
    const XLSX = await loadLib('xlsx');
    const rows = [['Дата', 'Чек-лист', 'Пункт', 'Отметка', 'Время', 'Комментарий']];
    for (let d = 29; d >= 0; d--) {
      const iso = dateISO(addDays(new Date(), -d));
      for (const c of checklists()) {
        const marks = logOf(iso, c.id).marks || {};
        if (!Object.keys(marks).length) continue;
        for (const it of c.items || []) {
          const m = marks[it.id] || {};
          rows.push([iso.split('-').reverse().join('.'), c.name, it.text, m.v === 'ok' ? '✓' : m.v === 'no' ? '✕' : '', m.at ? fmtClock(m.at) : '', m.note || '']);
        }
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 11 }, { wch: 20 }, { wch: 40 }, { wch: 8 }, { wch: 7 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Журнал смен');
    const blob = new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    done();
    const name = `zhurnal-smen-${dateISO()}.xlsx`;
    if (botReady()) {
      const v = await actionSheet('Журнал в Excel', [{ label: 'Прислать в чат с ботом', value: 'chat' }, { label: 'Сохранить на телефон', value: 'save' }]);
      if (!v) return;
      if (v === 'chat') { const d2 = busy('Отправляю…'); try { await sendFile(blob, name, 'Журнал смен за 30 дней'); toast('Файл отправлен в чат'); } catch (e) { toast(e.message, 'error'); } finally { d2(); } return; }
    }
    const how = await saveFile(blob, name);
    if (how === 'download') toast('Файл сохранён: ' + name);
  } catch (e) { done(); toast(e.message || 'Не получилось', 'error'); }
}

// ---- Редактор чек-листа --------------------------------------------------------------------------
function editorScreen({ item, name = '' }) {
  const isNew = !item;
  const d = item ? clone(item) : { name, items: [], time: '', remind: false };
  d.items = d.items || [];
  const initial = JSON.stringify(d);
  let saved = false;
  return {
    tab: 'shift',
    form: true,
    title: isNew ? 'Новый чек-лист' : 'Чек-лист',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => html`
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" id="clName" value="${d.name}" placeholder="Например, Закрытие смены"></label>
      </div>
      <div class="card">
        <div class="card-title">Пункты</div>
        <div id="clItems">${d.items.map((it, i) => html`<div class="step" data-idx="${i}">
          <div class="step-n">${i + 1}</div>
          <textarea class="inp" data-item rows="1" placeholder="Что проверить">${it.text}</textarea>
          <div class="step-btns">
            <button class="icon-btn" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button>
            <button class="icon-btn" data-act="down" ${i === d.items.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button>
            <button class="icon-btn danger" data-act="del-item" aria-label="Удалить">${icon('x')}</button>
          </div></div>`)}</div>
        <button class="btn ghost wide" data-act="add-item">${icon('plus')} Пункт</button>
      </div>
      <div class="card">
        <div class="row gap"><label class="fld grow"><span>Заполнить к (необязательно)</span><input class="inp" type="time" id="clTime" value="${d.time || ''}"></label></div>
        <label class="switch-row" data-act="remind" style="margin:0"><input type="checkbox" ${d.remind ? 'checked' : ''}><span class="sw"></span><span class="sw-text"><b>Напомнить в Telegram</b><small>если к этому времени чек-лист не заполнен</small></span></label>
      </div>
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить чек-лист</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'clName') d.name = t.value;
        if (t.id === 'clTime') d.time = t.value;
        if (t.hasAttribute('data-item')) d.items[+t.closest('.step').dataset.idx].text = t.value;
      });
      const rer = (focusLast) => { refresh(); if (focusLast) setTimeout(() => { const all = document.querySelectorAll('[data-item]'); all[all.length - 1]?.focus(); }, 30); };
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.hasAttribute('data-item')) { e.preventDefault(); d.items.push({ id: uid(), text: '' }); rer(true); }
      });
      onActs(el, {
        'add-item': () => { d.items.push({ id: uid(), text: '' }); rer(true); },
        'del-item': (t) => { d.items.splice(+t.closest('.step').dataset.idx, 1); rer(); },
        up: (t) => { const i = +t.closest('.step').dataset.idx; [d.items[i - 1], d.items[i]] = [d.items[i], d.items[i - 1]]; rer(); },
        down: (t) => { const i = +t.closest('.step').dataset.idx; [d.items[i + 1], d.items[i]] = [d.items[i], d.items[i + 1]]; rer(); },
        remind: () => {
          d.remind = !d.remind;
          if (d.remind && !d.time) toast('Укажите время «Заполнить к» — от него считается напоминание');
          if (d.remind && !loggedIn()) toast('Напоминания работают после входа: Настройки → Вход');
          rer();
        },
        save: () => {
          d.name = d.name.trim();
          if (!d.name) { toast('Введите название', 'error'); return; }
          d.items = d.items.map((i) => ({ ...i, text: (i.text || '').trim() })).filter((i) => i.text);
          saved = true;
          S.put('checklists', { ...d, id: d.id || uid(), order: d.order ?? S.list('checklists').length });
          haptic('success');
          toast('Сохранено');
          back(true);
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить чек-лист «${d.name}»? Записи журнала по нему пропадут из списка.`, 'Удалить', true))) return;
          S.remove('checklists', d.id);
          saved = true;
          back(true);
        },
      });
    },
  };
}
