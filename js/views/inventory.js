// Раздел «Склад»: позиции по местам хранения, инвентаризация (пересчёт), минимальный остаток и список «к заказу»,
// история пересчётов, выгрузка текстом и в Excel.

import { html, uid, clone, num, fmtNum, norm, plural, dateISO, fmtDayLong } from '../util.js';
import * as S from '../store.js';
import { push, back, replace, refresh, toast, confirmDialog, onActs, actionSheet, sheet, showText } from '../ui.js';
import { haptic, shareText, inTelegram } from '../tg.js';
import { icon, fab, emptyState, segmented, chips, refSelect, bindRefSelects, busy, inNum, saveFile } from './common.js';
import { equipmentSection, equipmentActs, equipmentNeedText } from './equipment.js';
import { botReady, sendFile } from '../reminders.js';

const UNITS_INV = ['кг', 'г', 'л', 'мл', 'шт', 'уп', 'пачка', 'банка', 'бут', 'порц'];
const st = { view: 'items', q: '', loc: '' };

const isoToDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const dayLabel = (iso) => fmtDayLong(isoToDate(iso));
const allSessions = () => S.list('invCounts').sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
const openSession = () => allSessions().find((s) => s.status === 'open');
const doneSessions = () => allSessions().filter((s) => s.status === 'done');
const allItems = () => S.list('invItems').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'));

function groupByLoc(list) {
  const locs = S.sortedList('locations');
  const groups = locs.map((l) => ({ id: l.id, name: l.name, items: list.filter((i) => i.locationId === l.id) }));
  const known = new Set(locs.map((l) => l.id));
  const rest = list.filter((i) => !known.has(i.locationId));
  if (rest.length) groups.push({ id: '', name: 'Без места', items: rest });
  return groups.filter((g) => g.items.length);
}

// Предыдущий известный остаток позиции — из завершённых пересчётов раньше указанного
function prevOf(itemId, before) {
  for (const s of doneSessions()) {
    if (before && s.id === before.id) continue;
    if (before && (s.date > before.date || (s.date === before.date && (s.finishedAt || 0) >= (before.createdAt || Infinity)))) continue;
    const q = s.counts?.[itemId];
    if (q != null) return { qty: q, date: s.date };
  }
  return null;
}
// Последний известный остаток (для списка позиций)
const lastOf = (itemId) => prevOf(itemId, null);

// Список «к заказу»: остаток ниже минимального по последнему завершённому пересчёту (или по указанному)
function orderList(session) {
  const out = [];
  for (const it of allItems()) {
    const min = num(it.minQty);
    if (!(min > 0)) continue;
    const q = session ? session.counts?.[it.id] : lastOf(it.id)?.qty;
    if (q == null) continue;
    if (q < min) out.push({ it, qty: q, min, need: Math.round((min - q) * 1000) / 1000 });
  }
  return out;
}

function orderText(list, date) {
  const L = [`К заказу${date ? ` (инвентаризация ${dayLabel(date)})` : ''}:`];
  const bySup = new Map();
  for (const o of list) {
    const k = o.it.supplier || '';
    if (!bySup.has(k)) bySup.set(k, []);
    bySup.get(k).push(o);
  }
  for (const [sup, arr] of [...bySup.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0], 'ru'))) {
    L.push('', (sup || 'Поставщик не указан') + ':');
    for (const o of arr) L.push(`• ${o.it.name} — ${fmtNum(o.need)} ${o.it.unit} (осталось ${fmtNum(o.qty)}, минимум ${fmtNum(o.min)})`);
  }
  return L.join('\n');
}

function countText(s) {
  const L = [`Инвентаризация ${dayLabel(s.date)}`];
  for (const g of groupByLoc(allItems())) {
    const lines = [];
    for (const it of g.items) {
      const q = s.counts?.[it.id];
      if (q == null) continue;
      const p = prevOf(it.id, s);
      const diff = p ? q - p.qty : null;
      lines.push(`• ${it.name} — ${fmtNum(q)} ${it.unit}${diff ? ` (${diff > 0 ? '+' : '−'}${fmtNum(Math.abs(diff))})` : ''}`);
    }
    if (lines.length) L.push('', g.name + ':', ...lines);
  }
  const ord = orderList(s);
  if (ord.length) L.push('', orderText(ord));
  return L.join('\n');
}

async function exportExcel(s) {
  const done = busy('Готовлю Excel…');
  try {
    const { loadLib } = await import('../importfile.js');
    const XLSX = await loadLib('xlsx');
    const rows = [['Место хранения', 'Позиция', 'Ед.', 'Было', 'Факт', 'Разница', 'Мин. остаток', 'К заказу', 'Поставщик']];
    for (const g of groupByLoc(allItems())) {
      for (const it of g.items) {
        const q = s.counts?.[it.id] ?? null;
        const p = prevOf(it.id, s);
        const min = num(it.minQty);
        rows.push([g.name, it.name, it.unit, p ? p.qty : null, q, q != null && p ? Math.round((q - p.qty) * 1000) / 1000 : null,
          min ?? null, q != null && min > 0 && q < min ? Math.round((min - q) * 1000) / 1000 : null, it.supplier || '']);
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 6 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 12 }, { wch: 9 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Инвентаризация');
    const ord = orderList(s);
    if (ord.length) {
      const ws2 = XLSX.utils.aoa_to_sheet([['Позиция', 'Ед.', 'Заказать', 'Остаток', 'Минимум', 'Поставщик'],
        ...ord.map((o) => [o.it.name, o.it.unit, o.need, o.qty, o.min, o.it.supplier || ''])]);
      ws2['!cols'] = [{ wch: 30 }, { wch: 6 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'К заказу');
    }
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    done();
    const name = `inventarizaciya-${s.date}.xlsx`;
    if (botReady()) {
      const v = await actionSheet('Excel: ' + name, [
        { label: 'Прислать в чат с ботом', value: 'chat', hint: 'файл придёт сообщением — можно сохранить или переслать' },
        { label: 'Сохранить на телефон', value: 'save' },
      ]);
      if (!v) return;
      if (v === 'chat') {
        const d2 = busy('Отправляю в чат…');
        try { await sendFile(blob, name, `Инвентаризация ${dayLabel(s.date)}`); toast('Файл отправлен в чат с ботом'); } catch (e) { toast(e.message || String(e), 'error'); } finally { d2(); }
        return;
      }
    }
    const how = await saveFile(blob, name);
    if (how === 'download' && inTelegram) {
      await sheet({
        title: 'Excel',
        body: html`<p class="confirm-msg">Файл «${name}» отправлен на сохранение.</p>
          <p class="hint">Если файл не появился — ваша версия Telegram не умеет сохранять файлы из мини-приложений. Тогда воспользуйтесь «Поделиться» (текстом) или откройте книгу на компьютере в Telegram Desktop.</p>`,
        buttons: [{ label: 'Понятно', kind: 'primary' }],
      });
    } else if (how === 'download') toast('Файл сохранён: ' + name);
  } catch (e) {
    done();
    toast(e.message || 'Не получилось сделать Excel', 'error');
  }
}

async function shareTextOrShow(text, title) {
  const r = await shareText(text);
  if (!r.shared) { if (r.copied) toast('Текст скопирован — вставьте в чат'); else showText(title, text); }
}

function startCount() {
  const ex = openSession();
  if (ex) { push(countScreen(ex.id)); return; }
  const rec = S.put('invCounts', { id: uid(), date: dateISO(), status: 'open', counts: {} });
  haptic('success');
  push(countScreen(rec.id));
}

// ---- Главный экран раздела ---------------------------------------------------------------
export function stockScreen() {
  return {
    tab: 'stock',
    title: 'Склад',
    subtitle: () => {
      const last = doneSessions()[0];
      const n = S.list('invItems').length;
      if (!n) return 'Инвентаризация';
      return last ? `Последняя инвентаризация: ${dayLabel(last.date)}` : `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
    },
    render() {
      const items = allItems();
      if (!items.length && st.view !== 'order') {
        return html`${segBar()}${emptyState('Склад пока пуст', 'Добавьте позиции для инвентаризации — из справочника продуктов (всё, что вы вводили в ТТК), из заготовок или вручную.', html`
          <div class="stack">
            <button class="btn primary" data-act="add-products">${icon('box')} Из справочника продуктов</button>
            <button class="btn" data-act="add-prep">Из заготовок</button>
            <button class="btn ghost" data-act="add-manual">${icon('plus')} Новая позиция вручную</button>
          </div>`, '📦')}${fab()}`;
      }
      return html`
        ${segBar()}
        ${st.view === 'history' ? historyView() : st.view === 'order' ? orderView() : itemsView(items)}
        ${st.view === 'order' ? fab('eq-add', 'Добавить оборудование') : fab()}`;
    },
    mount(el) {
      const q = el.querySelector('#iq');
      if (q) q.addEventListener('input', () => { st.q = q.value; renderItems(el); });
      onActs(el, {
        ...equipmentActs(),
        'share-all': () => {
          const last = doneSessions()[0];
          const ord = last ? orderList(last) : [];
          const parts = [];
          if (ord.length) parts.push(orderText(ord, last.date));
          const eq = equipmentNeedText();
          if (eq) parts.push(eq);
          if (!parts.length) { toast('Заказывать нечего'); return; }
          shareTextOrShow(parts.join('\n\n'), 'К заказу');
        },
        seg: (t) => { st.view = t.dataset.v; refresh(); },
        chip: (t) => { st.loc = t.dataset.v; refresh(); },
        start: startCount,
        open: (t) => push(itemForm({ item: S.get('invItems', t.dataset.id) })),
        session: (t) => {
          const s = S.get('invCounts', t.dataset.id);
          push(s.status === 'open' ? countScreen(s.id) : resultScreen(s.id));
        },
        'share-order': () => { const last = doneSessions()[0]; shareTextOrShow(orderText(orderList(last), last?.date), 'К заказу'); },
        add: () => addMenu(),
        'add-products': () => addFromProducts(),
        'add-prep': () => addFromPrep(),
        'add-manual': () => push(itemForm({})),
      });
      renderItems(el);
    },
  };
}

const segBar = () => html`<div class="toolbar sticky">${segmented('view', st.view, [{ id: 'items', label: 'Позиции' }, { id: 'history', label: 'Пересчёты' }, { id: 'order', label: 'Дозаказ' }])}</div>`;

function orderView() {
  const last = doneSessions()[0];
  const ord = last ? orderList(last) : [];
  const eqN = S.list('equipment').filter((e) => e.status === 'need').length;
  return html`
    ${ord.length || eqN ? html`<button class="btn primary wide mb" data-act="share-all">${icon('share')} Поделиться всем списком к заказу</button>` : ''}
    <div class="group-title">Продукты${last ? ` · по инвентаризации ${dayLabel(last.date)}` : ''}</div>
    ${ord.length ? html`<div class="card order-card">
        ${ord.map((o) => html`<div class="ord-row"><span>${o.it.name}<small>осталось ${fmtNum(o.qty)}, мин. ${fmtNum(o.min)}${o.it.supplier ? ` · ${o.it.supplier}` : ''}</small></span><b>${fmtNum(o.need)} ${o.it.unit}</b></div>`)}
        <button class="btn wide mt" data-act="share-order">${icon('share')} Поделиться продуктами</button>
      </div>`
      : html`<div class="card"><p class="hint mt0">${last ? 'По последней инвентаризации всего хватает 👍' : 'Список появится после инвентаризации — для позиций с минимальным остатком.'}</p></div>`}
    ${equipmentSection()}`;
}

function itemsView(items) {
  const open = openSession();
  const last = doneSessions()[0];
  const ord = last ? orderList(last) : [];
  const locs = S.sortedList('locations').filter((l) => items.some((i) => i.locationId === l.id));
  const counted = open ? items.filter((i) => open.counts?.[i.id] != null).length : 0;
  return html`
    ${open ? html`<div class="card inv-open">
        <div><b>Идёт инвентаризация</b><div class="muted small">${dayLabel(open.date)} · посчитано ${counted} из ${items.length}</div></div>
        <button class="btn primary" data-act="start">Продолжить</button>
      </div>`
    : html`<button class="btn primary wide mb" data-act="start">${icon('box')} Новая инвентаризация</button>`}
    ${ord.length ? html`<div class="card order-card">
        <div class="card-title">К заказу · ${ord.length}</div>
        ${ord.slice(0, 6).map((o) => html`<div class="ord-row"><span>${o.it.name}</span><b>${fmtNum(o.need)} ${o.it.unit}</b></div>`)}
        ${ord.length > 6 ? html`<div class="muted small">и ещё ${ord.length - 6}…</div>` : ''}
        <button class="btn wide mt" data-act="share-order">${icon('share')} Поделиться списком к заказу</button>
      </div>` : ''}
    <label class="search">${icon('search')}<input id="iq" type="search" placeholder="Поиск позиции" value="${st.q}"></label>
    ${locs.length > 1 ? html`<div class="mt">${chips('loc', st.loc, [{ id: '', label: 'Все' }, ...locs.map((l) => ({ id: l.id, label: l.name }))])}</div>` : ''}
    <div id="ilist" class="mt"></div>`;
}

function renderItems(el) {
  const box = el.querySelector('#ilist');
  if (!box) return;
  const q = norm(st.q);
  const list = allItems().filter((i) => (!st.loc || i.locationId === st.loc) && (!q || norm(i.name).includes(q)));
  if (!list.length) { box.innerHTML = String(html`<div class="empty small">Ничего не найдено</div>`); return; }
  box.innerHTML = String(groupByLoc(list).map((g) => html`<div class="group-title">${g.name}</div><div class="card list-card inv-list">${g.items.map((it) => {
    const last = lastOf(it.id);
    const min = num(it.minQty);
    const low = last && min > 0 && last.qty < min;
    return html`<button class="inv-row" data-act="open" data-id="${it.id}">
      <div class="inv-main"><div class="inv-name">${it.name}</div>
        <div class="inv-sub">${min > 0 ? `мин. ${fmtNum(min)} ${it.unit}` : 'без минимума'}${it.supplier ? ` · ${it.supplier}` : ''}</div></div>
      <div class="inv-qty ${low ? 'low' : ''}">${last ? html`<b>${fmtNum(last.qty)}</b> ${it.unit}` : html`<span class="muted">—</span>`}${low ? html`<small>мало</small>` : ''}</div>
    </button>`;
  })}</div>`).join(''));
}

function historyView() {
  const list = allSessions();
  const n = S.list('invItems').length;
  if (!list.length) return emptyState('Инвентаризаций ещё не было', 'Нажмите «Новая инвентаризация» на вкладке «Позиции».', '', '🗒️');
  return html`${list.map((s) => {
    const counted = Object.values(s.counts || {}).filter((v) => v != null).length;
    const low = s.status === 'done' ? orderList(s).length : 0;
    return html`<button class="card icard" data-act="session" data-id="${s.id}">
      <div class="ic-top"><span class="rc-title">${dayLabel(s.date)}</span><span class="badge ${s.status === 'open' ? 'st-test' : 'st-menu'}">${s.status === 'open' ? 'идёт' : 'завершена'}</span></div>
      <div class="rc-sub">Посчитано ${counted} из ${n}${low ? ` · к заказу ${low}` : ''}</div>
    </button>`;
  })}`;
}

// ---- Добавление позиций -------------------------------------------------------------------------
async function addMenu() {
  const v = await actionSheet('Добавить на склад', [
    { label: 'Из справочника продуктов', value: 'p', hint: 'всё, что вы вводили в ТТК' },
    { label: 'Из заготовок', value: 'z', hint: 'позиции из вкладки «Заготовки»' },
    { label: 'Новая позиция вручную', value: 'm' },
  ]);
  if (v === 'p') addFromProducts();
  if (v === 'z') addFromPrep();
  if (v === 'm') push(itemForm({}));
}

// Выбор нескольких позиций из списка + место хранения для всех
function pickSheet(title, options) {
  return sheet({
    title,
    body: html`
      <label class="fld"><span>Место хранения для выбранных</span>${refSelect('locations', st.loc || S.sortedList('locations')[0]?.id || '', { field: 'locationId', empty: '— без места —', addLabel: '＋ Новое место…' })}</label>
      <label class="search inset">${icon('search')}<input id="pq" type="search" placeholder="Поиск"></label>
      <div class="pick-actions"><button class="linkish" data-all="1">Выбрать все</button><button class="linkish" data-all="0">Снять все</button></div>
      <div class="pick-list">${options.map((o, i) => html`<label class="pick-row" data-n="${norm(o.name)}"><input type="checkbox" data-i="${i}"><span class="pick-box"></span><span class="pick-name">${o.name}</span><small>${o.unit || ''}</small></label>`)}</div>`,
    buttons: [
      { label: 'Отмена', kind: 'ghost' },
      {
        label: 'Добавить', kind: 'primary', value: (w) => {
          const idx = [...w.querySelectorAll('.pick-row input:checked')].map((c) => +c.dataset.i);
          return idx.length ? { chosen: idx.map((i) => options[i]), locationId: w.querySelector('select[data-ref]').value } : null;
        },
      },
    ],
    onMount: (el) => {
      bindRefSelects(el, () => {});
      const q = el.querySelector('#pq');
      q.addEventListener('input', () => {
        const n = norm(q.value);
        el.querySelectorAll('.pick-row').forEach((r) => { r.hidden = n && !r.dataset.n.includes(n); });
      });
      el.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll('.pick-row:not([hidden]) input').forEach((c) => { c.checked = b.dataset.all === '1'; });
      }));
    },
  });
}

function addChosen(res, map) {
  if (!res) return;
  const existing = new Set(S.list('invItems').map((i) => norm(i.name)));
  let n = 0;
  S.batch(() => {
    const locationId = S.resolveRef('locations', res.locationId);
    for (const o of res.chosen) {
      if (existing.has(norm(o.name))) continue;
      S.put('invItems', { id: uid(), name: o.name, unit: o.unit || 'кг', locationId, minQty: null, supplier: '', ...map(o) }, { silent: true });
      n++;
    }
  });
  haptic('success');
  toast(n ? `Добавлено: ${n}` : 'Все выбранные уже есть на складе');
  refresh();
}

async function addFromProducts() {
  const have = new Set(S.list('invItems').map((i) => norm(i.name)));
  const opts = S.list('products').filter((p) => !have.has(norm(p.name))).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .map((p) => ({ name: p.name, unit: p.unit === 'г' ? 'кг' : p.unit === 'мл' ? 'л' : p.unit || 'кг', productId: p.id }));
  if (!opts.length) { toast('В справочнике нет новых продуктов. Они появляются, когда вы сохраняете ТТК.'); return; }
  addChosen(await pickSheet('Продукты из справочника', opts), (o) => ({ productId: o.productId }));
}

async function addFromPrep() {
  const have = new Set(S.list('invItems').map((i) => norm(i.name)));
  const opts = S.list('prepItems').filter((p) => !have.has(norm(p.name))).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .map((p) => ({ name: p.name, unit: p.unit || 'кг', prepItemId: p.id }));
  if (!opts.length) { toast('Нет заготовок, которых ещё нет на складе'); return; }
  addChosen(await pickSheet('Заготовки', opts), (o) => ({ prepItemId: o.prepItemId }));
}

// ---- Карточка позиции ------------------------------------------------------------------------
function itemForm({ item }) {
  const isNew = !item;
  const d = item ? clone(item) : { name: '', unit: 'кг', locationId: st.loc || '', minQty: null, supplier: '', note: '' };
  const initial = JSON.stringify(d);
  let saved = false;
  const hist = isNew ? [] : doneSessions().filter((s) => s.counts?.[d.id] != null).slice(0, 6);
  return {
    tab: 'stock',
    form: true,
    title: isNew ? 'Новая позиция' : 'Позиция склада',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => html`
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" data-f="name" value="${d.name}" placeholder="Например, Сливки 33%"></label>
        <div class="row gap">
          <label class="fld w100"><span>Единица</span><select class="inp" data-f="unit">${[...new Set([...UNITS_INV, d.unit])].map((u) => html`<option ${u === d.unit ? 'selected' : ''}>${u}</option>`)}</select></label>
          <label class="fld grow"><span>Минимальный остаток</span><input class="inp" data-f="minQty" inputmode="decimal" value="${inNum(d.minQty)}" placeholder="не задан"></label>
        </div>
        <label class="fld"><span>Место хранения</span>${refSelect('locations', d.locationId, { field: 'locationId', empty: '— без места —', addLabel: '＋ Новое место…' })}</label>
        <label class="fld"><span>Поставщик</span><input class="inp" data-f="supplier" value="${d.supplier}" placeholder="Где заказывать"></label>
        <label class="fld"><span>Примечание</span><textarea class="inp" data-f="note" rows="2">${d.note || ''}</textarea></label>
        <p class="hint">Если после инвентаризации остаток окажется меньше минимального — позиция попадёт в список «к заказу».</p>
      </div>
      ${hist.length ? html`<div class="card"><div class="card-title">Последние пересчёты</div>
        ${hist.map((s) => html`<div class="ord-row"><span>${dayLabel(s.date)}</span><b>${fmtNum(s.counts[d.id])} ${d.unit}</b></div>`)}</div>` : ''}
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить позицию</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      bindRefSelects(el, (f, v) => { d[f] = v; });
      el.addEventListener('input', (e) => {
        const f = e.target.dataset.f;
        if (!f || f === 'locationId') return;
        d[f] = f === 'minQty' ? num(e.target.value) : e.target.value;
      });
      onActs(el, {
        save: () => {
          if (!d.name.trim()) { toast('Введите название', 'error'); return; }
          const dup = S.list('invItems').find((i) => norm(i.name) === norm(d.name) && i.id !== d.id);
          if (dup) { toast('Такая позиция уже есть на складе', 'error'); return; }
          saved = true;
          S.batch(() => {
            S.put('invItems', { ...d, id: d.id || uid(), name: d.name.trim(), supplier: (d.supplier || '').trim(), locationId: S.resolveRef('locations', d.locationId) }, { silent: true });
          });
          haptic('success');
          toast('Сохранено');
          back(true);
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить «${d.name}» со склада? История пересчётов по ней останется в файлах, но из списков пропадёт.`, 'Удалить', true))) return;
          S.remove('invItems', d.id);
          saved = true;
          back(true);
        },
      });
    },
  };
}

// ---- Пересчёт --------------------------------------------------------------------------------------
function countScreen(sessionId) {
  const f = { q: '', loc: '', onlyEmpty: false };
  let pending = null, timer = null;
  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    const s = S.get('invCounts', sessionId);
    if (s) S.put('invCounts', { ...s, counts: { ...(s.counts || {}), ...pending } });
    pending = null;
  };
  const setQty = (id, v) => {
    pending = pending || {};
    pending[id] = v;
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const cur = () => {
    const s = S.get('invCounts', sessionId);
    return s ? { ...s, counts: { ...(s.counts || {}), ...(pending || {}) } } : null;
  };
  const diffHtml = (q, prev) => {
    if (q == null || !prev) return '';
    const dlt = Math.round((q - prev.qty) * 1000) / 1000;
    if (!dlt) return html`<span class="c-diff zero">=</span>`;
    return html`<span class="c-diff ${dlt > 0 ? 'up' : 'down'}">${dlt > 0 ? '+' : '−'}${fmtNum(Math.abs(dlt))}</span>`;
  };
  return {
    tab: 'stock',
    title: 'Инвентаризация',
    onLeave: flush,
    render() {
      const s = cur();
      if (!s) return emptyState('Инвентаризация удалена', '');
      const items = allItems();
      const counted = items.filter((i) => s.counts[i.id] != null).length;
      const q = norm(f.q);
      const list = items.filter((i) => (!f.loc || i.locationId === f.loc) && (!q || norm(i.name).includes(q)) && (!f.onlyEmpty || s.counts[i.id] == null));
      const locs = S.sortedList('locations').filter((l) => items.some((i) => i.locationId === l.id));
      const pct = items.length ? Math.round((counted / items.length) * 100) : 0;
      return html`
        <div class="card day-card">
          <svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="ring-bg"/>${pct ? html`<circle cx="22" cy="22" r="18" class="ring-fg" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/>` : ''}</svg>
          <div class="day-head"><b>${dayLabel(s.date)}</b><span class="muted" id="cprog">Посчитано ${counted} из ${items.length}</span></div>
          <button class="icon-btn" data-act="add-item" aria-label="Добавить позицию">${icon('plus')}</button>
        </div>
        <label class="search">${icon('search')}<input id="cq" type="search" placeholder="Поиск позиции" value="${f.q}"></label>
        <div class="mt">${chips('loc', f.loc, [{ id: '', label: 'Все места' }, ...locs.map((l) => ({ id: l.id, label: l.name }))])}</div>
        <label class="switch-row"><input type="checkbox" id="onlyEmpty" ${f.onlyEmpty ? 'checked' : ''}><span class="sw"></span>Только непосчитанные</label>
        ${list.length ? groupByLoc(list).map((g) => html`<div class="group-title">${g.name}</div><div class="card list-card">${g.items.map((it) => {
          const prev = prevOf(it.id, s);
          const qv = s.counts[it.id];
          return html`<div class="crow ${qv != null ? 'filled' : ''}" data-id="${it.id}">
            <div class="c-main"><div class="c-name">${it.name}</div>
              <div class="c-sub">${prev ? `было ${fmtNum(prev.qty)}` : 'раньше не считали'}${num(it.minQty) > 0 ? ` · мин. ${fmtNum(num(it.minQty))}` : ''}</div></div>
            <span class="c-diffbox" data-diff="${it.id}">${diffHtml(qv, prev)}</span>
            <input class="inp c-inp" data-qty="${it.id}" inputmode="decimal" enterkeyhint="next" value="${inNum(qv)}" placeholder="0">
            <span class="c-unit">${it.unit}</span>
          </div>`;
        })}</div>`) : html`<div class="empty small">${f.onlyEmpty ? 'Всё посчитано 👍' : 'Ничего не найдено'}</div>`}
        <div class="bottom-bar"><button class="btn primary wide" data-act="finish">${icon('check')} Завершить</button></div>`;
    },
    mount(el) {
      const s0 = cur();
      if (!s0) return;
      const items = allItems();
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'cq') { f.q = t.value; flush(); clearTimeout(t._t); t._t = setTimeout(() => { refresh(); const n = document.getElementById('cq'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); return; }
        if (!t.dataset.qty) return;
        const id = t.dataset.qty;
        const v = t.value.trim() === '' ? null : num(t.value);
        setQty(id, v);
        const s = cur();
        el.querySelector(`[data-diff="${id}"]`).innerHTML = String(diffHtml(v, prevOf(id, s)));
        t.closest('.crow').classList.toggle('filled', v != null);
        el.querySelector('#cprog').textContent = `Посчитано ${items.filter((i) => s.counts[i.id] != null).length} из ${items.length}`;
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.dataset.qty) return;
        e.preventDefault();
        const all = [...el.querySelectorAll('[data-qty]')];
        const nx = all[all.indexOf(e.target) + 1];
        if (nx) { nx.focus(); nx.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else e.target.blur();
      });
      el.addEventListener('change', (e) => {
        if (e.target.id === 'onlyEmpty') { flush(); f.onlyEmpty = e.target.checked; refresh(); }
      });
      onActs(el, {
        chip: (t) => { flush(); f.loc = t.dataset.v; refresh(); },
        'add-item': () => { flush(); push(itemForm({})); },
        finish: async () => {
          flush();
          const s = cur();
          const left = items.filter((i) => s.counts[i.id] == null).length;
          const msg = left ? `Не посчитано ${left} ${plural(left, 'позиция', 'позиции', 'позиций')} — они останутся пустыми. Завершить инвентаризацию?` : 'Завершить инвентаризацию?';
          if (!(await confirmDialog(msg, 'Завершить'))) return;
          S.put('invCounts', { ...S.get('invCounts', sessionId), status: 'done', finishedAt: Date.now() });
          haptic('success');
          replace(resultScreen(sessionId));
        },
      });
    },
  };
}

// ---- Итоги пересчёта ------------------------------------------------------------------------------
function resultScreen(sessionId) {
  return {
    tab: 'stock',
    title: 'Итоги',
    render() {
      const s = S.get('invCounts', sessionId);
      if (!s) return emptyState('Инвентаризация удалена', '');
      const items = allItems();
      const counted = items.filter((i) => s.counts?.[i.id] != null);
      const ord = orderList(s);
      return html`
        <div class="card">
          <h2 class="d-title">Инвентаризация</h2>
          <div class="rc-sub">${dayLabel(s.date)}${s.status === 'open' ? ' · ещё идёт' : ''}</div>
          <div class="kv">
            <div><span>Посчитано</span><b>${counted.length} из ${items.length}</b></div>
            <div><span>К заказу</span><b>${ord.length}</b></div>
          </div>
        </div>
        ${ord.length ? html`<div class="card order-card"><div class="card-title">К заказу</div>
          ${ord.map((o) => html`<div class="ord-row"><span>${o.it.name}<small>осталось ${fmtNum(o.qty)}, мин. ${fmtNum(o.min)}${o.it.supplier ? ` · ${o.it.supplier}` : ''}</small></span><b>${fmtNum(o.need)} ${o.it.unit}</b></div>`)}
          <button class="btn wide mt" data-act="share-order">${icon('share')} Поделиться списком к заказу</button></div>` : ''}
        ${groupByLoc(counted).map((g) => html`<div class="group-title">${g.name}</div><div class="card list-card">${g.items.map((it) => {
          const q = s.counts[it.id];
          const p = prevOf(it.id, s);
          const dlt = p ? Math.round((q - p.qty) * 1000) / 1000 : null;
          return html`<div class="inv-row static"><div class="inv-main"><div class="inv-name">${it.name}</div><div class="inv-sub">${p ? `было ${fmtNum(p.qty)} ${it.unit}` : 'раньше не считали'}</div></div>
            <div class="inv-qty"><b>${fmtNum(q)}</b> ${it.unit}${dlt ? html`<small class="${dlt > 0 ? 'up' : 'down'}">${dlt > 0 ? '+' : '−'}${fmtNum(Math.abs(dlt))}</small>` : ''}</div></div>`;
        })}</div>`)}
        <div class="bottom-bar">
          <button class="btn primary" data-act="share">${icon('share')} Поделиться</button>
          <button class="btn" data-act="excel">${icon('xls')} Excel</button>
          <button class="btn icon-only" data-act="more" aria-label="Ещё">${icon('more')}</button>
        </div>`;
    },
    mount(el) {
      const s = S.get('invCounts', sessionId);
      if (!s) return;
      onActs(el, {
        share: () => shareTextOrShow(countText(S.get('invCounts', sessionId)), 'Инвентаризация'),
        'share-order': () => shareTextOrShow(orderText(orderList(s), s.date), 'К заказу'),
        excel: () => exportExcel(S.get('invCounts', sessionId)),
        more: async () => {
          const v = await actionSheet('Инвентаризация ' + dayLabel(s.date), [
            ...(s.status === 'done' && !openSession() ? [{ label: 'Открыть для правки', value: 'reopen', hint: 'изменить цифры этого пересчёта' }] : []),
            { label: 'Удалить инвентаризацию', value: 'del', danger: true },
          ]);
          if (v === 'reopen') { S.put('invCounts', { ...s, status: 'open' }); replace(countScreen(s.id)); }
          if (v === 'del') {
            if (!(await confirmDialog(`Удалить инвентаризацию от ${dayLabel(s.date)}?`, 'Удалить', true))) return;
            S.remove('invCounts', s.id);
            toast('Удалено');
            back(true);
          }
        },
      });
    },
  };
}
