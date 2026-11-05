// Навигация, нижние вкладки, всплывающие окна, уведомления.

import { html, esc } from './util.js';
import { inTelegram, setBack, setClosingConfirmation, hasTgPopup, tgPopup, haptic } from './tg.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ---- Навигация -------------------------------------------------------------------
// Экран: { tab, title, render(): Raw, mount(el), actions?: Raw, form?: bool, isDirty?(): bool, onLeave?() }
const stack = [];
const roots = {};
let currentTab = 'ttk';

export function registerTab(tab, factory) { roots[tab] = factory; }
export const top = () => stack[stack.length - 1];
export const getTab = () => currentTab;

export function setTab(tab) {
  if (stack.length && top().form) {
    return guardLeave().then((ok) => { if (ok) { stack.length = 0; doSetTab(tab); } });
  }
  doSetTab(tab);
}
function doSetTab(tab) {
  stack.forEach((s) => s.onLeave?.());
  stack.length = 0;
  currentTab = tab;
  stack.push(roots[tab]());
  render(true);
}

export function push(screen) {
  const cur = top();
  if (cur) cur.scrollY = window.scrollY;
  stack.push(screen);
  render(true);
}

export function replace(screen) {
  const old = stack.pop();
  old?.onLeave?.();
  stack.push(screen);
  render(true);
}

async function guardLeave() {
  const cur = top();
  if (cur?.isDirty && cur.isDirty()) {
    return confirmDialog('Выйти без сохранения? Изменения пропадут.', 'Выйти', true);
  }
  return true;
}

export async function back(force = false) {
  if (stack.length <= 1) return;
  if (!force && !(await guardLeave())) return;
  const old = stack.pop();
  old?.onLeave?.();
  render(false);
}

// Перерисовать текущий экран (например, после изменения данных)
export function refresh() { render(false, true); }

function render(scrollTop, keepScroll = false) {
  const s = top();
  // Новый контейнер на каждую отрисовку — чтобы обработчики прошлых экранов не копились
  const oldEl = $('#screen');
  const el = oldEl.cloneNode(false);
  oldEl.replaceWith(el);
  const y = window.scrollY;
  document.body.classList.toggle('is-form', !!s.form);
  // Корневые экраны вкладок — с крупным заголовком (как в iOS), вложенные — с компактным
  const isRoot = stack.length === 1;
  const titleText = typeof s.title === 'function' ? s.title() : s.title;
  const sub = isRoot && s.subtitle ? s.subtitle() : '';
  document.body.classList.toggle('root', isRoot);
  $('#title').textContent = titleText;
  $('#topActions').innerHTML = s.actions ? String(typeof s.actions === 'function' ? s.actions() : s.actions) : '';
  el.innerHTML = (isRoot ? String(html`<header class="lt"><h1>${titleText}</h1>${sub ? html`<div class="lt-sub">${sub}</div>` : ''}</header>`) : '')
    + String(s.render());
  document.body.classList.toggle('has-bar', !!el.querySelector('.bottom-bar'));
  s.mount?.(el);
  const depth = stack.length > 1;
  setBack(depth, () => back());
  $('#navBack').hidden = !depth || inTelegram;
  setClosingConfirmation(!!s.form);
  document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
  if (keepScroll) window.scrollTo(0, y);
  else if (scrollTop) window.scrollTo(0, 0);
  else window.scrollTo(0, s.scrollY || 0);
  onScroll();
}

function onScroll() {
  document.body.classList.toggle('scrolled', window.scrollY > (document.body.classList.contains('root') ? 40 : 4));
}

export function initNav() {
  window.addEventListener('scroll', onScroll, { passive: true });
  document.querySelectorAll('#tabbar [data-tab]').forEach((b) =>
    b.addEventListener('click', () => { haptic('select'); setTab(b.dataset.tab); }));
  $('#navBack').addEventListener('click', () => back());
  $('#topActions').addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (t && top()?.onAction) top().onAction(t.dataset.act, t);
  });
}

// ---- Уведомления ---------------------------------------------------------------
let toastTimer;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

// ---- Нижние «шторки» ----------------------------------------------------------------
// Возвращает Promise; закрытие тапом по фону = null
export function sheet({ title, body, buttons = [], onMount }) {
  return new Promise((resolve) => {
    const root = $('#sheet-root');
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = String(html`
      <div class="sheet-bg"></div>
      <div class="sheet" role="dialog">
        <div class="sheet-grip"></div>
        ${title ? html`<div class="sheet-title">${title}</div>` : ''}
        <div class="sheet-body">${body || ''}</div>
        ${buttons.length ? html`<div class="sheet-btns">${buttons.map((b, i) =>
          html`<button class="btn ${b.kind || ''}" data-i="${i}">${b.label}</button>`)}</div>` : ''}
      </div>`);
    root.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const close = (val) => {
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 200);
      resolve(val);
    };
    wrap.querySelector('.sheet-bg').addEventListener('click', () => close(null));
    wrap.querySelectorAll('.sheet-btns [data-i]').forEach((b) => b.addEventListener('click', () => {
      const btn = buttons[+b.dataset.i];
      close(btn.value !== undefined ? (typeof btn.value === 'function' ? btn.value(wrap) : btn.value) : null);
    }));
    onMount?.(wrap.querySelector('.sheet'), close);
  });
}

// Меню действий: items = [{label, value, danger, hint}]
export function actionSheet(title, items) {
  return sheet({
    title,
    body: html`<div class="menu">${items.map((it, i) => html`
      <button class="menu-item ${it.danger ? 'danger' : ''}" data-mi="${i}">
        <span>${it.label}</span>${it.hint ? html`<small>${it.hint}</small>` : ''}
      </button>`)}</div>`,
    buttons: [{ label: 'Отмена', kind: 'ghost' }],
    onMount: (el, close) => el.querySelectorAll('[data-mi]').forEach((b) =>
      b.addEventListener('click', () => close(items[+b.dataset.mi].value))),
  });
}

export function promptSheet(title, { value = '', placeholder = '', okLabel = 'Готово', multiline = false } = {}) {
  return sheet({
    title,
    body: multiline
      ? html`<textarea class="inp" rows="6" placeholder="${placeholder}">${value}</textarea>`
      : html`<input class="inp" value="${value}" placeholder="${placeholder}" enterkeyhint="done">`,
    buttons: [
      { label: 'Отмена', kind: 'ghost' },
      { label: okLabel, kind: 'primary', value: (w) => w.querySelector('.inp').value.trim() || null },
    ],
    onMount: (el, close) => {
      const inp = el.querySelector('.inp');
      setTimeout(() => inp.focus(), 50);
      if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value.trim() || null); });
    },
  });
}

// Подтверждение. В Телеграме — нативный попап, в браузере — своя шторка.
export async function confirmDialog(message, okLabel = 'Да', danger = false) {
  if (hasTgPopup()) {
    const id = await tgPopup({
      message,
      buttons: [{ id: 'ok', type: danger ? 'destructive' : 'default', text: okLabel }, { id: 'cancel', type: 'cancel' }],
    });
    if (id !== undefined) return id === 'ok';
  }
  const r = await sheet({
    body: html`<p class="confirm-msg">${message}</p>`,
    buttons: [{ label: 'Отмена', kind: 'ghost', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }],
  });
  return r === true;
}

// Показ текста с кнопкой «Скопировать» — запасной путь, если буфер обмена недоступен
export function showText(title, text) {
  return sheet({
    title,
    body: html`<textarea class="inp mono" rows="12" readonly>${text}</textarea>
      <p class="hint">Выделите текст и скопируйте вручную, если кнопка не сработала.</p>`,
    buttons: [{ label: 'Закрыть', kind: 'ghost' }],
  });
}

// Делегирование кликов по data-act внутри экрана
export function onActs(el, handlers) {
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !el.contains(t)) return;
    const fn = handlers[t.dataset.act];
    if (fn) { e.preventDefault(); fn(t, e); }
  });
}

export const escAttr = esc;

// Выбор файла
export function pickFile(accept, { multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    if (capture) inp.capture = capture;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      resolve(multiple ? [...inp.files] : inp.files[0] || null);
      inp.remove();
    });
    inp.click();
  });
}
