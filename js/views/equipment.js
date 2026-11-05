// Раздел «Оборудование к дозаказу»

import { html, uid, clone } from '../util.js';
import * as S from '../store.js';
import { push, back, refresh, toast, confirmDialog, onActs, showText } from '../ui.js';
import { haptic, openLink, shareText } from '../tg.js';
import { fab, emptyState, chips, segmented, icon } from './common.js';

export const URGENCY = [
  { id: 'urgent', label: 'Срочно' },
  { id: 'soon', label: 'Скоро' },
  { id: 'low', label: 'Не горит' },
];
export const EQ_STATUS = [
  { id: 'need', label: 'Нужно' },
  { id: 'ordered', label: 'Заказано' },
  { id: 'received', label: 'Получено' },
];
const uLabel = (id) => URGENCY.find((u) => u.id === id)?.label || '';
const uRank = { urgent: 0, soon: 1, low: 2 };
const sRank = { need: 0, ordered: 1, received: 2 };

const st = { status: 'active' };

function sorted(items) {
  return items.sort((a, b) =>
    (sRank[a.status] === 2) - (sRank[b.status] === 2) ||
    uRank[a.urgency] - uRank[b.urgency] ||
    sRank[a.status] - sRank[b.status] ||
    a.name.localeCompare(b.name, 'ru'));
}

function eqCard(e) {
  return html`<div class="card ecard ${e.status === 'received' ? 'done' : ''}">
    <button class="ec-main" data-act="open" data-id="${e.id}">
      <div class="ic-top"><span class="rc-title">${e.name}</span><span class="badge u-${e.urgency}">${uLabel(e.urgency)}</span></div>
      <div class="rc-sub">${e.qty ? html`<b>${e.qty}</b>` : ''}${e.qty && e.supplier ? ' · ' : ''}${e.supplier || ''}</div>
      ${e.note ? html`<div class="ic-desc">${e.note}</div>` : ''}
    </button>
    ${e.link ? html`<button class="ec-link" data-act="link" data-id="${e.id}">${icon('link')} ${e.link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}</button>` : ''}
    <div class="seg small" role="group">${EQ_STATUS.map((s) => html`<button class="${e.status === s.id ? 'on s-' + s.id : ''}" data-act="status" data-id="${e.id}" data-v="${s.id}">${s.label}</button>`)}</div>
  </div>`;
}

export function equipmentText(items) {
  const L = ['Оборудование к заказу:'];
  for (const u of URGENCY) {
    const g = items.filter((e) => e.urgency === u.id);
    if (!g.length) continue;
    L.push('', `${u.id === 'urgent' ? '🔴' : u.id === 'soon' ? '🟡' : '🟢'} ${u.label}:`);
    for (const e of g) {
      let s = `• ${e.name}`;
      if (e.qty) s += ` — ${e.qty}`;
      if (e.supplier) s += ` (${e.supplier})`;
      L.push(s);
      if (e.link) L.push(`  ${e.link}`);
      if (e.note) L.push(`  ${e.note}`);
    }
  }
  return L.join('\n');
}

export function equipmentList() {
  return {
    tab: 'equip',
    title: 'Оборудование',
    render() {
      const all = S.list('equipment');
      const count = (f) => all.filter(f).length;
      const filters = [
        { id: 'active', label: 'Активные', count: count((e) => e.status !== 'received') },
        ...EQ_STATUS.map((s) => ({ ...s, count: count((e) => e.status === s.id) })),
        { id: '', label: 'Все', count: all.length },
      ];
      const items = sorted(all.filter((e) => (st.status === 'active' ? e.status !== 'received' : !st.status || e.status === st.status)));
      const toOrder = all.filter((e) => e.status === 'need').length;
      return html`
        <div class="toolbar sticky">${chips('status', st.status, filters)}</div>
        ${!all.length ? emptyState('Список пуст', 'Добавьте, что нужно дозаказать: ножи, гастроёмкости, термощупы…', html`<button class="btn primary" data-act="add">Добавить позицию</button>`)
          : html`
            ${toOrder ? html`<button class="btn wide mb" data-act="share">${icon('share')} Поделиться списком к заказу (${toOrder})</button>` : ''}
            <div class="muted small pad-x">Сортировка: сначала срочные</div>
            ${items.length ? items.map(eqCard) : html`<div class="empty small">Здесь пусто</div>`}`}
        ${fab()}`;
    },
    mount(el) {
      onActs(el, {
        chip: (t) => { st.status = t.dataset.v; refresh(); },
        add: () => push(equipmentForm({})),
        open: (t) => push(equipmentForm({ item: S.get('equipment', t.dataset.id) })),
        link: (t) => openLink(S.get('equipment', t.dataset.id).link),
        status: (t) => {
          const e = S.get('equipment', t.dataset.id);
          if (e.status === t.dataset.v) return;
          S.put('equipment', { ...e, status: t.dataset.v });
          haptic('select');
          toast(`«${e.name}»: ${EQ_STATUS.find((s) => s.id === t.dataset.v).label.toLowerCase()}`);
          refresh();
        },
        share: async () => {
          const text = equipmentText(sorted(S.list('equipment').filter((e) => e.status === 'need')));
          const r = await shareText(text);
          if (!r.shared) { if (r.copied) toast('Список скопирован — вставьте в чат'); else showText('Список к заказу', text); }
        },
      });
    },
  };
}

function equipmentForm({ item }) {
  const isNew = !item;
  const d = item ? clone(item) : { name: '', qty: '', urgency: 'soon', status: 'need', supplier: '', link: '', note: '' };
  const initial = JSON.stringify(d);
  let saved = false;
  return {
    tab: 'equip',
    form: true,
    title: isNew ? 'Новая позиция' : 'Позиция',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => html`
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" data-f="name" value="${d.name}" placeholder="Например, Гастроёмкость GN 1/1 h65"></label>
        <label class="fld"><span>Количество</span><input class="inp" data-f="qty" value="${d.qty}" placeholder="Например, 4 шт"></label>
        <div class="fld"><span>Срочность</span>${segmented('urgency', d.urgency, URGENCY)}</div>
        <div class="fld"><span>Статус</span>${segmented('status', d.status, EQ_STATUS)}</div>
      </div>
      <div class="card">
        <label class="fld"><span>Поставщик</span><input class="inp" data-f="supplier" value="${d.supplier}" placeholder="Где купить"></label>
        <label class="fld"><span>Ссылка</span><input class="inp" data-f="link" value="${d.link}" inputmode="url" placeholder="https://…"></label>
        <label class="fld"><span>Примечание</span><textarea class="inp" data-f="note" rows="3">${d.note}</textarea></label>
      </div>
      ${!isNew ? html`<div class="card"><button class="btn ghost danger wide" data-act="del">${icon('trash')} Удалить позицию</button></div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">Сохранить</button></div>`,
    mount(el) {
      el.addEventListener('input', (e) => { const f = e.target.dataset.f; if (f) d[f] = e.target.value; });
      onActs(el, {
        seg: (t) => {
          d[t.dataset.seg] = t.dataset.v;
          el.querySelectorAll(`[data-seg="${t.dataset.seg}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === t.dataset.v));
        },
        save: () => {
          if (!d.name.trim()) { toast('Введите название', 'error'); return; }
          saved = true;
          S.put('equipment', { ...d, id: d.id || uid(), name: d.name.trim(), link: d.link.trim() });
          haptic('success');
          toast('Сохранено');
          back(true);
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить «${d.name}»?`, 'Удалить', true))) return;
          S.remove('equipment', d.id);
          saved = true;
          back(true);
        },
      });
    },
  };
}
