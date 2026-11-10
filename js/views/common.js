// Общие кусочки интерфейса для экранов

import { html, raw, norm, hash } from '../util.js';
import { sortedList, get } from '../store.js';
import { promptSheet } from '../ui.js';

export const ICONS = {
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M7 8l5-5 5 5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 10h14M5 14h10M5 18h7"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M5 19h14M7 15l8-8 3 3-8 8H7z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.3"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9H3zM9 20v-6h6v6"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 2-7 2 1 3 2 3 4 1-2 1-5 1-8z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M10 2.5h4M18.5 6l1.5-1.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5L12 12l8.5-4.5M12 12v9"/></svg>',
  xls: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 11l5 6M14 11l-5 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3zM12 10v4M12 17v.5"/></svg>',
};
export const icon = (name) => raw(`<span class="ico">${ICONS[name]}</span>`);

// Выпадающий список из справочника + «Добавить…»
export function refSelect(coll, value, { field, empty = '— не выбрано —', addLabel = '＋ Добавить…', required = false } = {}) {
  const items = sortedList(coll);
  const isNew = value && value.startsWith('new:');
  return html`<select class="inp ${required && !value ? 'need' : ''}" data-f="${field}" data-ref="${coll}">
    <option value="" ${!value ? 'selected' : ''}>${empty}</option>
    ${items.map((it) => html`<option value="${it.id}" ${it.id === value ? 'selected' : ''}>${it.name}</option>`)}
    ${isNew ? html`<option value="${value}" selected>${value.slice(4)} (новый)</option>` : ''}
    <option value="__add">${addLabel}</option>
  </select>`;
}

// Обработка «＋ Добавить…» в выпадающем списке. onPick(value) — новое значение.
export function bindRefSelects(root, onPick) {
  root.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-ref]');
    if (!sel) return;
    if (sel.value === '__add') {
      const titles = { categories: 'Новая категория', restaurants: 'Новый ресторан', stations: 'Новый цех' };
      const name = await promptSheet(titles[sel.dataset.ref] || 'Новое значение', { placeholder: 'Название' });
      if (!name) {
        sel.value = sel.dataset.prev || '';
        return;
      }
      const existing = sortedList(sel.dataset.ref).find((x) => x.name.toLowerCase() === name.toLowerCase());
      const v = existing ? existing.id : 'new:' + name;
      if (!existing) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = name + ' (новый)';
        sel.insertBefore(opt, sel.querySelector('option[value="__add"]'));
      }
      sel.value = v;
    }
    sel.dataset.prev = sel.value;
    sel.classList.remove('need');
    onPick(sel.dataset.f, sel.value, sel);
  });
  root.querySelectorAll('select[data-ref]').forEach((s) => { s.dataset.prev = s.value; });
}

export const fab = (act = 'add', label = 'Добавить') =>
  html`<button class="fab" data-act="${act}" aria-label="${label}">${icon('plus')}</button>`;

export function emptyState(title, text, buttons = '', emoji = '') {
  return html`<div class="empty">${emoji ? html`<div class="empty-emoji">${emoji}</div>` : ''}<div class="empty-title">${title}</div><p>${text}</p>${buttons}</div>`;
}

// Цвет и значок категории — чтобы список не был безликим
const PALETTE = ['#FF7A1A', '#FF3B30', '#FF2D55', '#AF52DE', '#5856D6', '#007AFF', '#30B0C7', '#34C759', '#C99A00', '#A2845E'];
const EMOJI = [
  [/закус/, '🫒'], [/салат/, '🥗'], [/суп|бульон/, '🍲'], [/горяч|основн/, '🥘'], [/гарнир/, '🍚'],
  [/соус/, '🥣'], [/десерт|сладк/, '🍰'], [/выпеч|хлеб|тест/, '🥐'], [/заготов|п\/ф|полуфаб/, '🔪'],
  [/напит|коктейл|бар/, '🍹'], [/рыб|море/, '🐟'], [/мяс|стейк|гриль/, '🥩'], [/паст|итал/, '🍝'],
  [/завтрак/, '🍳'], [/пицц/, '🍕'], [/сыр/, '🧀'], [/овощ|веган/, '🥦'], [/мороже/, '🍨'],
];
export function catStyle(id) {
  const c = id ? get('categories', id) : null;
  const name = c ? norm(c.name) : '';
  const color = c ? PALETTE[parseInt(hash(c.id).slice(-4), 36) % PALETTE.length] : '#FF9500';
  const emoji = (EMOJI.find(([re]) => re.test(name)) || [])[1] || '';
  return { color, emoji, name: c?.name || '' };
}
export function catTag(id) {
  const s = catStyle(id);
  if (!s.name) return '';
  return html`<span class="tag" style="--c:${s.color}">${s.name}</span>`;
}

export function segmented(name, value, options) {
  return html`<div class="seg" data-seg="${name}">${options.map((o) =>
    html`<button class="${o.id === value ? 'on' : ''}" data-act="seg" data-seg="${name}" data-v="${o.id}">${o.label}</button>`)}</div>`;
}

export function chips(name, value, options, act = 'chip') {
  return html`<div class="chips" data-chips="${name}">${options.map((o) =>
    html`<button class="chip ${o.id === value ? 'on' : ''}" data-act="${act}" data-chips="${name}" data-v="${o.id}">${o.label}${o.count != null ? html` <b>${o.count}</b>` : ''}</button>`)}</div>`;
}

// Полупрозрачная заглушка «Подождите…»
export function busy(msg) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.innerHTML = String(html`<div class="busy-box"><div class="spinner"></div><div>${msg}</div></div>`);
  document.body.appendChild(el);
  return () => el.remove();
}

// Сохранить файл: на телефоне — через «Поделиться», иначе — загрузка
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return 'download';
}

export const inNum = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));
