// Раздел «ТТК»: список, карточка, форма, импорт из файла и из текста

import { html, uid, lsGet, lsSet, num, fmtNum, norm, clone, toBase, fmtBase, UNITS, plural, debounce } from '../util.js';
import * as S from '../store.js';
import { push, back, replace, refresh, toast, actionSheet, confirmDialog, onActs, pickFile, sheet, showText, setTab } from '../ui.js';
import { shareText, copyText, haptic } from '../tg.js';
import { addPhoto, deletePhoto, hydratePhotos, photoURL } from '../photos.js';
import { recipeToText, parseRecipesText, emptyRecipe, CLAUDE_TTK_PROMPT } from '../textfmt.js';
import { icon, refSelect, bindRefSelects, fab, emptyState, segmented, busy, inNum, catStyle, catTag, saveFile } from './common.js';
import { botReady, sendFile } from '../reminders.js';

// ---- Расчёты ----------------------------------------------------------------------------------
// Отход вводится вручную: в единицах продукта (wasteMode 'abs') или в процентах ('pct')
export function wasteText(i, k = 1) {
  if (i.waste == null) return '—';
  return i.wasteMode === 'pct' ? `${fmtNum(i.waste, 1)}%` : `${fmtNum(i.waste * k)} ${i.unit || 'г'}`;
}
export function totals(ings, k = 1) {
  const t = {};
  for (const i of ings || []) {
    if (i.netto == null) continue;
    const b = toBase(i.netto * k, i.unit || 'г');
    t[b.fam] = t[b.fam] || { netto: 0 };
    t[b.fam].netto += b.v;
  }
  return t;
}
function totalsText(ings, key, k = 1) {
  const t = totals(ings, k);
  const parts = ['mass', 'vol', 'pcs'].filter((f) => t[f] && t[f][key] > 0).map((f) => fmtBase(f, t[f][key]));
  return parts.join(' + ') || '—';
}
const amount = (v, unit) => (v == null ? '—' : `${fmtNum(v)} ${unit || ''}`.trim());

// ---- Состояние списка (живёт между перерисовками) ---------------------------------------
const listState = { q: '', cat: '', src: '' };
// Переключатель внутри вкладки ТТК: карты или идеи
export const ttkState = { view: 'cards' };
export const ttkSwitch = () => segmented('ttkview', ttkState.view, [{ id: 'cards', label: 'Карты' }, { id: 'ideas', label: 'Идеи' }]);

function matches(r, q) {
  if (!q) return true;
  if (norm(r.name).includes(q)) return true;
  return (r.ingredients || []).some((i) => norm(i.name).includes(q));
}

function filtered() {
  const q = norm(listState.q);
  return S.list('recipes')
    .filter((r) => (!listState.cat || (listState.cat === '-' ? !r.categoryId : r.categoryId === listState.cat)))
    .filter((r) => (!listState.src || (listState.src === '-' ? !r.sourceId : r.sourceId === listState.src)))
    .filter((r) => matches(r, q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function recipeCard(r) {
  const ph = (r.photos || [])[0];
  const cat = S.nameOf('categories', r.categoryId);
  const src = S.nameOf('restaurants', r.sourceId);
  const n = (r.ingredients || []).length;
  const q = norm(listState.q);
  const hit = q && !norm(r.name).includes(q) ? (r.ingredients || []).find((i) => norm(i.name).includes(q)) : null;
  const cs = catStyle(r.categoryId);
  return html`<button class="card rcard" data-act="open" data-id="${r.id}">
    ${ph ? html`<div class="ph thumb"><img data-photo="${ph.id}" alt=""></div>`
      : html`<div class="avatar" style="--c:${cs.color}">${cs.emoji || (r.name || '?').trim().charAt(0).toUpperCase()}</div>`}
    <div class="rc-body">
      <div class="rc-title">${r.name || 'Без названия'}</div>
      <div class="rc-meta">
        ${cat ? catTag(r.categoryId) : ''}
        <span class="src ${src ? '' : 'muted'}">${src || 'источник не указан'}</span>
      </div>
      <div class="rc-sub">${n} ${plural(n, 'ингредиент', 'ингредиента', 'ингредиентов')}${r.yieldAmount != null ? ` · выход ${amount(r.yieldAmount, r.yieldUnit)}` : ''}${r.portions ? ` · ${fmtNum(r.portions)} порц.` : ''}</div>
      ${hit ? html`<div class="rc-hit">содержит: ${hit.name}</div>` : ''}
    </div>
  </button>`;
}

function filterOptions(coll, value, allLabel, noneLabel) {
  return html`<option value="" ${!value ? 'selected' : ''}>${allLabel}</option>
    ${S.sortedList(coll).map((c) => html`<option value="${c.id}" ${c.id === value ? 'selected' : ''}>${c.name}</option>`)}
    <option value="-" ${value === '-' ? 'selected' : ''}>${noneLabel}</option>`;
}

export function recipesList() {
  const renderList = (el) => {
    const items = filtered();
    const total = S.list('recipes').length;
    const box = el.querySelector('#rlist');
    if (!total) {
      box.innerHTML = String(emptyState('Пока нет ни одной ТТК', 'Добавьте первую карту — вручную, из файла или из текста.', html`
        <div class="stack">
          <button class="btn primary" data-act="new">${icon('hand')} Вручную</button>
          <button class="btn" data-act="file">${icon('file')} Из файла (Excel, Word, PDF)</button>
          <button class="btn" data-act="text">${icon('text')} Вставить из текста</button>
        </div>`, '📖'));
      return;
    }
    box.innerHTML = String(html`${items.length !== total ? html`<div class="count">Найдено ${items.length} из ${total}</div>` : ''}
      ${items.length ? items.map(recipeCard) : html`<div class="empty small">Ничего не найдено</div>`}`);
    hydratePhotos(box);
  };
  return {
    tab: 'ttk',
    title: 'ТТК',
    subtitle: () => { const n = S.list('recipes').length; return n ? `${n} ${plural(n, 'карта', 'карты', 'карт')}` : 'Технико-технологические карты'; },
    render: () => html`
      <div class="toolbar sticky">
        ${ttkSwitch()}
        <label class="search">${icon('search')}<input id="rq" type="search" placeholder="Поиск: блюдо или продукт" value="${listState.q}" enterkeyhint="search"></label>
        <div class="filters">
          <select class="inp sm" id="fcat">${filterOptions('categories', listState.cat, 'Все категории', 'Без категории')}</select>
          <select class="inp sm" id="fsrc">${filterOptions('restaurants', listState.src, 'Все рестораны', 'Не указан')}</select>
        </div>
      </div>
      <div id="rlist"></div>
      ${fab()}`,
    mount(el) {
      renderList(el);
      const q = el.querySelector('#rq');
      const upd = debounce(() => renderList(el), 120);
      q.addEventListener('input', () => { listState.q = q.value; upd(); });
      el.querySelector('#fcat').addEventListener('change', (e) => { listState.cat = e.target.value; renderList(el); });
      el.querySelector('#fsrc').addEventListener('change', (e) => { listState.src = e.target.value; renderList(el); });
      onActs(el, {
        seg: (t) => { if (t.dataset.seg === 'ttkview') { ttkState.view = t.dataset.v; setTab('ttk'); } },
        open: (t) => push(recipeDetail(t.dataset.id)),
        add: () => addMenu(),
        new: () => push(recipeForm({ mode: 'new' })),
        file: () => importFromFile(),
        text: () => push(pasteRecipes()),
      });
    },
  };
}

async function addMenu() {
  const v = await actionSheet('Добавить ТТК', [
    { label: 'Вручную', value: 'new', hint: 'заполнить форму' },
    { label: 'Загрузить файл', value: 'file', hint: 'Excel .xlsx/.xls, Word .docx, PDF с текстом' },
    { label: 'Вставить из текста', value: 'text', hint: 'ответ Claude по фото карты' },
  ]);
  if (v === 'new') push(recipeForm({ mode: 'new' }));
  if (v === 'file') importFromFile();
  if (v === 'text') push(pasteRecipes());
}

// ---- Карточка ТТК ----------------------------------------------------------------------------
export function recipeDetail(id) {
  const sc = { mode: 'none', value: '' };
  const factor = (r) => {
    const v = num(sc.value);
    if (sc.mode === 'none' || !(v > 0)) return 1;
    if (sc.mode === 'portions') return v / (r.portions || 1);
    const base = r.yieldAmount != null ? toBase(r.yieldAmount, r.yieldUnit || 'г').v : (totals(r.ingredients).mass?.netto || 0);
    if (!base) return 1;
    const unit = r.yieldAmount != null ? (r.yieldUnit || 'г') : 'г';
    return toBase(v, unit).v / base;
  };
  const ingTable = (r, k) => html`
    <div class="itable">
      <div class="irow head"><span>Продукт</span><span>Нетто</span><span>Отход</span></div>
      ${(r.ingredients || []).map((i) => html`<div class="irow">
        <span class="iname">${i.name}</span>
        <span>${amount(i.netto != null ? i.netto * k : null, i.unit)}</span>
        <span class="muted">${wasteText(i, k)}</span></div>`)}
    </div>
    <div class="totals"><span>Итого нетто: <b>${totalsText(r.ingredients, 'netto', k)}</b></span></div>
    <div class="kv">
      <div><span>Выход</span><b>${r.yieldAmount != null ? amount(r.yieldAmount * k, r.yieldUnit) : (k !== 1 ? `${totalsText(r.ingredients, 'netto', k)} (по нетто)` : '—')}</b></div>
      <div><span>Порций</span><b>${r.portions ? fmtNum(r.portions * k) : '—'}</b></div>
      ${k !== 1 ? html`<div><span>Коэффициент</span><b>×${fmtNum(k, 3)}</b></div>` : ''}
    </div>`;

  const scaleCard = (r) => html`<div class="card">
    <div class="card-title">Пересчёт</div>
    ${segmented('scale', sc.mode, [{ id: 'none', label: 'Как в карте' }, { id: 'yield', label: 'На выход' }, { id: 'portions', label: 'На порции' }])}
    ${sc.mode !== 'none' ? html`<div class="row gap mt">
      <input class="inp" id="scv" inputmode="decimal" placeholder="${sc.mode === 'yield' ? 'Нужный выход' : 'Сколько порций'}" value="${sc.value}">
      <span class="unit-lbl">${sc.mode === 'yield' ? (r.yieldAmount != null ? r.yieldUnit || 'г' : 'г') : 'порц.'}</span>
    </div>
    <p class="hint">${sc.mode === 'yield'
      ? `В карте выход ${r.yieldAmount != null ? amount(r.yieldAmount, r.yieldUnit) : `не указан — считаем от итога нетто (${totalsText(r.ingredients, 'netto')})`}`
      : `В карте порций: ${r.portions ? fmtNum(r.portions) : 'не указано — считаем как 1'}`}</p>` : ''}
  </div>`;

  return {
    tab: 'ttk',
    title: 'ТТК',
    render() {
      const r = S.get('recipes', id);
      if (!r) return emptyState('Карта удалена', '');
      const k = factor(r);
      const cat = S.nameOf('categories', r.categoryId);
      const src = S.nameOf('restaurants', r.sourceId);
      return html`
        ${(r.photos || []).length ? html`<div class="gallery">${r.photos.map((p) => html`
          <button class="ph" data-act="photo" data-id="${p.id}"><img data-photo="${p.id}" alt=""><span class="ph-kind">${p.kind === 'plating' ? 'подача' : 'блюдо'}</span><span class="ph-miss">фото на другом устройстве</span></button>`)}</div>` : ''}
        <div class="card">
          <h2 class="d-title">${r.name}</h2>
          <div class="rc-meta">${cat ? catTag(r.categoryId) : ''}<span class="src ${src ? '' : 'muted'}">${src || 'источник не указан'}</span></div>
        </div>
        ${scaleCard(r)}
        <div class="card"><div class="card-title">Ингредиенты</div><div id="ingbox">${ingTable(r, k)}</div></div>
        ${(r.steps || []).length ? html`<div class="card"><div class="card-title">Технология</div><ol class="steps">${r.steps.map((s) => html`<li>${s}</li>`)}</ol></div>` : ''}
        ${r.serving ? html`<div class="card"><div class="card-title">Подача</div><p class="pre">${r.serving}</p></div>` : ''}
        ${r.storage ? html`<div class="card"><div class="card-title">Условия и сроки хранения</div><p class="pre">${r.storage}</p></div>` : ''}
        ${r.notes ? html`<div class="card"><div class="card-title">Примечания</div><p class="pre">${r.notes}</p></div>` : ''}
        <div class="bottom-bar">
          <button class="btn primary" data-act="edit">${icon('edit')} Изменить</button>
          <button class="btn" data-act="share">${icon('share')} Поделиться</button>
          <button class="btn icon-only" data-act="more" aria-label="Ещё">${icon('more')}</button>
        </div>`;
    },
    mount(el) {
      hydratePhotos(el);
      const r = S.get('recipes', id);
      if (!r) return;
      const scv = el.querySelector('#scv');
      if (scv) {
        scv.addEventListener('input', () => {
          sc.value = scv.value;
          el.querySelector('#ingbox').innerHTML = String(ingTable(r, factor(r)));
        });
      }
      const scaledNote = () => {
        const v = num(sc.value);
        if (sc.mode === 'none' || !(v > 0)) return '';
        return sc.mode === 'portions' ? `на ${fmtNum(v)} порц.` : `на выход ${fmtNum(v)} ${r.yieldAmount != null ? r.yieldUnit || 'г' : 'г'}`;
      };
      const text = () => recipeToText(r, { factor: factor(r), scaledNote: scaledNote() });
      onActs(el, {
        seg: (t) => {
          sc.mode = t.dataset.v;
          refresh();
          if (sc.mode !== 'none') setTimeout(() => document.getElementById('scv')?.focus(), 30);
        },
        photo: (t) => viewPhoto(t.dataset.id),
        edit: () => push(recipeForm({ mode: 'edit', recipe: r })),
        share: async () => {
          const res = await shareText(text());
          if (!res.shared) toast(res.copied ? 'Текст скопирован — вставьте в чат' : 'Не удалось поделиться');
        },
        more: async () => {
          const v = await actionSheet(r.name, [
            { label: 'PDF для печати', value: 'pdf', hint: 'с фото — сохранить или прислать в чат' },
            { label: 'Скопировать текстом', value: 'copy' },
            { label: 'Дублировать', value: 'dup' },
            { label: 'Удалить', value: 'del', danger: true },
          ]);
          if (v === 'pdf') { pdfFlow(r, factor(r), scaledNote()); return; }
          if (v === 'copy') {
            if (await copyText(text())) toast('Скопировано'); else showText('Текст ТТК', text());
          }
          if (v === 'dup') {
            const copy = clone(r);
            delete copy.createdAt;
            copy.id = uid();
            copy.name = r.name + ' (копия)';
            copy.ingredients = (copy.ingredients || []).map((i) => ({ ...i, id: uid() }));
            S.put('recipes', copy);
            toast('Копия создана');
            replace(recipeDetail(copy.id));
          }
          if (v === 'del') {
            if (!(await confirmDialog(`Удалить ТТК «${r.name}»? Это нельзя отменить.`, 'Удалить', true))) return;
            await deleteRecipe(r);
            haptic('success');
            toast('ТТК удалена');
            back(true);
          }
        },
      });
    },
  };
}

// PDF: выбор фото и куда отправить
async function pdfFlow(r, k, note) {
  const photos = r.photos || [];
  const res = await sheet({
    title: 'PDF: ' + r.name,
    body: html`
      ${photos.length ? html`<div class="pg-title">Фото в PDF</div>
        <div class="pdf-photos">${photos.map((p, i) => html`<label class="pdf-ph"><input type="checkbox" data-i="${i}" checked><span class="ph pthumb"><img data-photo="${p.id}" alt=""><span class="ph-miss">нет на этом устройстве</span></span><small>${p.kind === 'plating' ? 'подача' : 'блюдо'}</small></label>`)}</div>`
        : html`<p class="hint mt0">У этой ТТК нет фото — добавить их можно в «Изменить».</p>`}
      ${k !== 1 ? html`<label class="switch-row"><input type="checkbox" id="pdfScale" checked><span class="sw"></span>С пересчётом (${note})</label>` : ''}`,
    buttons: [
      { label: 'Сохранить PDF', kind: botReady() ? '' : 'primary', value: (w) => ({ to: 'save', w }) },
      ...(botReady() ? [{ label: 'В чат', kind: 'primary', value: (w) => ({ to: 'chat', w }) }] : []),
    ],
    onMount: (el) => hydratePhotos(el),
  });
  if (!res) return;
  const chosen = [...res.w.querySelectorAll('.pdf-ph input:checked')].map((c) => photos[+c.dataset.i]);
  const useScale = k !== 1 && res.w.querySelector('#pdfScale')?.checked;
  const done = busy('Готовлю PDF…');
  try {
    const { recipePdf } = await import('../pdf.js');
    const blob = await recipePdf(r, { photos: chosen, factor: useScale ? k : 1, scaledNote: useScale ? note : '' });
    const name = `TTK-${(r.name || 'karta').replace(/[^\wа-яё\- ]+/gi, '').trim().replace(/\s+/g, '-').slice(0, 60)}.pdf`;
    done();
    if (res.to === 'chat') {
      const d2 = busy('Отправляю в чат…');
      try { await sendFile(blob, name, r.name); toast('PDF отправлен в чат с ботом'); } finally { d2(); }
    } else {
      const how = await saveFile(blob, name);
      if (how === 'download') toast('PDF сохранён: ' + name);
    }
  } catch (e) {
    done();
    toast(e.message || 'Не получилось сделать PDF', 'error');
  }
}

async function deleteRecipe(r) {
  S.remove('recipes', r.id);
  const used = new Set();
  for (const x of S.list('recipes')) for (const p of x.photos || []) used.add(p.id);
  for (const p of r.photos || []) if (!used.has(p.id)) await deletePhoto(p.id);
  // ссылки из идей и заготовок
  for (const i of S.list('ideas')) if (i.recipeId === r.id) S.put('ideas', { ...i, recipeId: '' });
  for (const p of S.list('prepItems')) if (p.recipeId === r.id) S.put('prepItems', { ...p, recipeId: '' });
}

async function viewPhoto(pid) {
  const url = await photoURL(pid);
  if (!url) { toast('Это фото хранится на другом устройстве'); return; }
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = String(html`<img src="${url}" alt=""><button class="viewer-x">${icon('x')}</button>`);
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// ---- Форма ТТК ---------------------------------------------------------------------------------
// mode: 'new' | 'edit' | 'import' (из файла/текста — сохраняем в базу) | 'draft' (правка черновика в предпросмотре)
export function recipeForm({ mode, recipe, banner, onSaved, title }) {
  const lastSource = lsGet('kb_lastSource') || '';
  const draft = recipe ? clone(recipe) : { ...emptyRecipe(), sourceId: lastSource && (lastSource === S.OWN_SOURCE_ID || S.get('restaurants', lastSource)) ? lastSource : '' };
  draft.ingredients = (draft.ingredients || []).map((i) => ({ id: i.id || uid(), ...i }));
  if (!draft.ingredients.length && mode === 'new') draft.ingredients.push({ id: uid(), name: '', netto: null, unit: 'г', waste: null, wasteMode: 'abs' });
  draft.steps = draft.steps || [];
  draft.photos = draft.photos || [];
  const initial = JSON.stringify(draft);
  const added = [], removed = [];
  let saved = false;
  const needSource = mode === 'import' || mode === 'draft';

  const ingRow = (i, idx) => html`<div class="ing" data-idx="${idx}">
    <div class="ing-top">
      <div class="ac-wrap"><input class="inp" data-ing="name" value="${i.name}" placeholder="Продукт" autocomplete="off"></div>
      <button class="icon-btn danger" data-act="del-ing" aria-label="Удалить">${icon('x')}</button>
    </div>
    <div class="ing-nums">
      <label><small>Нетто</small><input class="inp" data-ing="netto" inputmode="decimal" value="${inNum(i.netto)}"></label>
      <label><small>Ед.</small><select class="inp" data-ing="unit">${UNITS.map((u) => html`<option ${u === (i.unit || 'г') ? 'selected' : ''}>${u}</option>`)}</select></label>
      <label><small>Отход</small><span class="waste-box"><input class="inp" data-ing="waste" inputmode="decimal" value="${inNum(i.waste)}" placeholder="—"><button type="button" class="waste-mode" data-act="waste-mode">${i.wasteMode === 'pct' ? '%' : i.unit || 'г'}</button></span></label>
    </div>
  </div>`;

  const stepRow = (s, idx) => html`<div class="step" data-idx="${idx}">
    <div class="step-n">${idx + 1}</div>
    <textarea class="inp" data-step rows="2" placeholder="Что делаем">${s}</textarea>
    <div class="step-btns">
      <button class="icon-btn" data-act="step-up" ${idx === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button>
      <button class="icon-btn" data-act="step-down" ${idx === draft.steps.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button>
      <button class="icon-btn danger" data-act="step-del" aria-label="Удалить">${icon('x')}</button>
    </div>
  </div>`;

  const photosBlock = (kind, label) => html`<div class="photo-group">
    <div class="pg-title">${label}</div>
    <div class="pg-list">
      ${draft.photos.filter((p) => p.kind === kind).map((p) => html`<div class="ph pthumb"><img data-photo="${p.id}" alt=""><button class="ph-del" data-act="photo-del" data-id="${p.id}">${icon('x')}</button><span class="ph-miss">на другом устройстве</span></div>`)}
      <button class="ph-add" data-act="photo-add" data-kind="${kind}">${icon('camera')}<span>Добавить</span></button>
    </div>
  </div>`;

  const totalsBlock = () => html`<div class="totals">
    <span>Итого нетто: <b>${totalsText(draft.ingredients, 'netto')}</b></span></div>`;

  const screen = {
    tab: 'ttk',
    form: true,
    title: title || (mode === 'edit' ? 'Изменить ТТК' : mode === 'new' ? 'Новая ТТК' : 'Проверьте ТТК'),
    isDirty: () => !saved && (mode === 'import' || JSON.stringify(draft) !== initial),
    onLeave() {
      if (!saved) added.forEach((id) => deletePhoto(id));
    },
    render: () => html`
      ${banner ? html`<div class="banner">${banner}</div>` : ''}
      <div class="card">
        <label class="fld"><span>Название</span><input class="inp" data-f="name" value="${draft.name}" placeholder="Например, Борщ с говядиной"></label>
        <label class="fld"><span>Категория</span>${refSelect('categories', draft.categoryId, { field: 'categoryId', addLabel: '＋ Новая категория…' })}</label>
        <label class="fld"><span>Ресторан / источник${needSource ? ' *' : ''}</span>${refSelect('restaurants', draft.sourceId, { field: 'sourceId', empty: '— выберите —', addLabel: '＋ Добавить ресторан…', required: needSource })}</label>
      </div>
      <div class="card">
        <div class="card-title">Ингредиенты</div>
        <div id="ings">${draft.ingredients.map(ingRow)}</div>
        <button class="btn ghost wide" data-act="add-ing">${icon('plus')} Ингредиент</button>
        <div id="tot">${totalsBlock()}</div>
      </div>
      <div class="card">
        <div class="card-title">Выход</div>
        <div class="row gap">
          <label class="fld grow"><span>Выход</span><input class="inp" data-f="yieldAmount" inputmode="decimal" value="${inNum(draft.yieldAmount)}" placeholder="250"></label>
          <label class="fld w80"><span>Ед.</span><select class="inp" data-f="yieldUnit">${UNITS.map((u) => html`<option ${u === (draft.yieldUnit || 'г') ? 'selected' : ''}>${u}</option>`)}</select></label>
          <label class="fld w100"><span>Порций</span><input class="inp" data-f="portions" inputmode="decimal" value="${inNum(draft.portions)}" placeholder="1"></label>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Технология</div>
        <div id="steps">${draft.steps.map(stepRow)}</div>
        <button class="btn ghost wide" data-act="add-step">${icon('plus')} Шаг</button>
      </div>
      <div class="card">
        <label class="fld"><span>Подача</span><textarea class="inp" data-f="serving" rows="3">${draft.serving}</textarea></label>
        <label class="fld"><span>Условия и сроки хранения</span><textarea class="inp" data-f="storage" rows="2">${draft.storage}</textarea></label>
        <label class="fld"><span>Примечания</span><textarea class="inp" data-f="notes" rows="2">${draft.notes}</textarea></label>
      </div>
      ${mode !== 'draft' ? html`<div class="card">
        <div class="card-title">Фото</div>
        ${photosBlock('dish', 'Блюдо')}
        ${photosBlock('plating', 'Подача')}
        <p class="hint warn-text">${icon('warn')} Фото хранятся только на этом телефоне и не попадают в облако Telegram. Чтобы не потерять — делайте резервную копию файлом (Настройки).</p>
      </div>` : ''}
      <div class="bottom-bar"><button class="btn primary wide" data-act="save">${mode === 'draft' ? 'Готово' : 'Сохранить'}</button></div>`,
    mount(el) {
      hydratePhotos(el);
      bindRefSelects(el, (f, v) => { draft[f] = v; });
      el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.f) {
          const f = t.dataset.f;
          if (f === 'categoryId' || f === 'sourceId') return;
          draft[f] = ['yieldAmount', 'portions'].includes(f) ? num(t.value) : t.value;
        } else if (t.dataset.ing) {
          const row = t.closest('.ing');
          const ing = draft.ingredients[+row.dataset.idx];
          const k = t.dataset.ing;
          ing[k] = k === 'netto' || k === 'waste' ? num(t.value) : t.value;
          el.querySelector('#tot').innerHTML = String(totalsBlock());
          if (k === 'name') suggest(t, ing);
        } else if (t.hasAttribute('data-step')) {
          draft.steps[+t.closest('.step').dataset.idx] = t.value;
        }
      });
      el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.ing === 'unit') {
          const row = t.closest('.ing');
          draft.ingredients[+row.dataset.idx].unit = t.value;
          if (draft.ingredients[+row.dataset.idx].wasteMode !== 'pct') row.querySelector('.waste-mode').textContent = t.value;
          el.querySelector('#tot').innerHTML = String(totalsBlock());
        }
        if (t.dataset.f === 'yieldUnit') draft.yieldUnit = t.value;
      });
      el.addEventListener('focusout', (e) => {
        if (e.target.dataset.ing === 'name') setTimeout(() => closeSuggest(), 150);
      });
      const rerender = (focusSel) => {
        refresh();
        if (focusSel) setTimeout(() => { const f = document.querySelector(focusSel); f?.focus(); f?.scrollIntoView({ block: 'center' }); }, 30);
      };
      onActs(el, {
        'waste-mode': (t) => {
          const row = t.closest('.ing');
          const ing = draft.ingredients[+row.dataset.idx];
          ing.wasteMode = ing.wasteMode === 'pct' ? 'abs' : 'pct';
          t.textContent = ing.wasteMode === 'pct' ? '%' : ing.unit || 'г';
          haptic('select');
        },
        'add-ing': () => {
          draft.ingredients.push({ id: uid(), name: '', netto: null, unit: draft.ingredients[draft.ingredients.length - 1]?.unit || 'г', waste: null, wasteMode: 'abs' });
          rerender(`.ing[data-idx="${draft.ingredients.length - 1}"] [data-ing="name"]`);
        },
        'del-ing': async (t) => {
          const idx = +t.closest('.ing').dataset.idx;
          const ing = draft.ingredients[idx];
          if ((ing.name || ing.netto != null) && !(await confirmDialog(`Удалить «${ing.name || 'ингредиент'}»?`, 'Удалить', true))) return;
          draft.ingredients.splice(idx, 1);
          rerender();
        },
        'add-step': () => { draft.steps.push(''); rerender(`.step[data-idx="${draft.steps.length - 1}"] textarea`); },
        'step-del': async (t) => {
          const idx = +t.closest('.step').dataset.idx;
          if (draft.steps[idx].trim() && !(await confirmDialog('Удалить этот шаг?', 'Удалить', true))) return;
          draft.steps.splice(idx, 1);
          rerender();
        },
        'step-up': (t) => { const i = +t.closest('.step').dataset.idx; if (i > 0) { [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; rerender(); } },
        'step-down': (t) => { const i = +t.closest('.step').dataset.idx; if (i < draft.steps.length - 1) { [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; rerender(); } },
        'photo-add': async (t) => {
          const files = await pickFile('image/*', { multiple: true });
          if (!files || !files.length) return;
          const done = busy('Сжимаю фото…');
          try {
            for (const f of files) {
              const id = await addPhoto(f);
              added.push(id);
              draft.photos.push({ id, kind: t.dataset.kind });
            }
          } catch (err) { toast(err.message || 'Не удалось добавить фото', 'error'); }
          done();
          rerender();
        },
        'photo-del': async (t) => {
          if (!(await confirmDialog('Убрать это фото?', 'Убрать', true))) return;
          const id = t.dataset.id;
          draft.photos = draft.photos.filter((p) => p.id !== id);
          if (added.includes(id)) { added.splice(added.indexOf(id), 1); deletePhoto(id); } else removed.push(id);
          rerender();
        },
        save: () => save(el),
      });
    },
  };

  // Подсказки продуктов
  let sugEl = null;
  function closeSuggest() { sugEl?.remove(); sugEl = null; }
  function suggest(input, ing) {
    closeSuggest();
    const q = norm(input.value);
    if (q.length < 2) return;
    const names = S.productNames();
    const starts = names.filter((n) => norm(n).startsWith(q));
    const inc = names.filter((n) => !norm(n).startsWith(q) && norm(n).includes(q));
    const res = [...starts, ...inc].filter((n) => norm(n) !== q).slice(0, 6);
    if (!res.length) return;
    sugEl = document.createElement('div');
    sugEl.className = 'suggest';
    sugEl.innerHTML = res.map((n) => String(html`<button type="button" data-v="${n}">${n}</button>`)).join('');
    sugEl.addEventListener('pointerdown', (e) => e.preventDefault());
    sugEl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      input.value = b.dataset.v;
      ing.name = b.dataset.v;
      const p = S.findByName('products', ing.name);
      if (p?.unit && !ing.netto) {
        ing.unit = p.unit;
        const sel = input.closest('.ing').querySelector('[data-ing="unit"]');
        if (sel) sel.value = p.unit;
      }
      closeSuggest();
      input.closest('.ing').querySelector('[data-ing="netto"]').focus();
    });
    input.closest('.ac-wrap').appendChild(sugEl);
  }

  function save(el) {
    if (!draft.name.trim()) {
      toast('Введите название блюда', 'error');
      const f = el.querySelector('[data-f="name"]'); f.focus(); f.scrollIntoView({ block: 'center' });
      return;
    }
    if (needSource && !draft.sourceId) {
      toast('Выберите ресторан-источник', 'error');
      el.querySelector('[data-f="sourceId"]').scrollIntoView({ block: 'center' });
      return;
    }
    draft.name = draft.name.trim();
    draft.ingredients = draft.ingredients.filter((i) => (i.name || '').trim() || i.netto != null)
      .map((i) => ({ ...i, name: (i.name || '').trim() }));
    draft.steps = draft.steps.map((s) => s.trim()).filter(Boolean);
    saved = true;
    if (mode === 'draft') { onSaved?.(draft); back(true); return; }
    const rec = saveRecipe(draft);
    removed.forEach((id) => deletePhoto(id));
    haptic('success');
    toast('Сохранено');
    if (onSaved) onSaved(rec);
    else if (mode === 'edit') back(true);
    else replace(recipeDetail(rec.id));
  }

  return screen;
}

// Сохранить черновик в базу (создаёт новые категории/рестораны/продукты при необходимости)
export function saveRecipe(d) {
  let rec;
  S.batch(() => {
    const categoryId = S.resolveRef('categories', d.categoryId);
    const sourceId = S.resolveRef('restaurants', d.sourceId);
    const ingredients = (d.ingredients || []).map((i) => ({
      id: i.id || uid(), name: i.name, netto: i.netto ?? null, unit: i.unit || 'г', waste: i.waste ?? null, wasteMode: i.wasteMode === 'pct' ? 'pct' : 'abs',
      productId: i.name ? S.ensureProduct(i.name, i.unit) : '',
    }));
    rec = S.put('recipes', {
      id: d.id || uid(), createdAt: d.createdAt, name: d.name, categoryId, sourceId, ingredients,
      yieldAmount: d.yieldAmount ?? null, yieldUnit: d.yieldUnit || 'г', portions: d.portions ?? null,
      steps: d.steps || [], serving: d.serving || '', storage: d.storage || '', notes: d.notes || '',
      photos: d.photos || [], origin: d.origin || 'manual',
    }, { silent: true });
    if (sourceId) lsSet('kb_lastSource', sourceId);
  });
  return rec;
}

// ---- Импорт из файла ------------------------------------------------------------------------------
async function importFromFile() {
  const file = await pickFile('.xlsx,.xls,.xlsm,.ods,.docx,.doc,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  if (!file) return;
  const done = busy('Читаю файл…');
  let results;
  try {
    const mod = await import('../importfile.js');
    results = await mod.importFile(file);
  } catch (e) {
    done();
    await sheet({ title: 'Не получилось распознать', body: html`<p class="confirm-msg">${e.message || String(e)}</p>`, buttons: [{ label: 'Понятно', kind: 'primary' }] });
    if (e.kind === 'scan') push(pasteRecipes());
    return;
  }
  done();
  // Если в шапке файла упомянут ресторан из списка — подставим его (можно поменять)
  const rests = S.list('restaurants').filter((x) => x.id !== S.OWN_SOURCE_ID && norm(x.name).length >= 3);
  const drafts = results.map((r) => {
    const head = norm(r.head);
    const hit = rests.find((x) => head.includes(norm(x.name)));
    return { recipe: { ...r.recipe, origin: 'file', sourceId: hit ? hit.id : '' }, found: r.found, label: r.label };
  });
  if (drafts.length === 1) {
    const d = drafts[0];
    push(recipeForm({ mode: 'import', recipe: d.recipe, banner: foundBanner(d) }));
  } else push(importPreview(drafts, 'file'));
}

function foundBanner(d) {
  const f = d.found;
  const mark = (ok, label) => html`<span class="fb ${ok ? 'ok' : 'no'}">${ok ? '✓' : '—'} ${label}</span>`;
  return html`<b>Распознано из «${d.label}».</b> Проверьте и поправьте всё, что нужно, выберите ресторан и сохраните.
    <div class="fbs">${mark(f.name, 'название')}${mark(f.ingredients, `ингредиенты${f.ingredients ? ': ' + f.ingredients : ''}`)}${mark(f.yield, 'выход')}${mark(f.steps, 'технология')}${mark(f.serving, 'подача')}${mark(f.storage, 'хранение')}</div>
    ${f.unitGuessed ? html`<div class="fb-warn">Единицы (г/кг) в таблице не указаны — определил по числам, проверьте.</div>` : ''}
    <div class="muted small">Что не нашлось — осталось пустым.</div>`;
}

// ---- Предпросмотр нескольких ТТК ------------------------------------------------------------------
function importPreview(items, origin) {
  items.forEach((it) => { it.on = true; });
  let allSource = '';
  return {
    tab: 'ttk',
    form: true,
    title: 'Предпросмотр',
    isDirty: () => true,
    render: () => {
      const n = items.filter((i) => i.on).length;
      return html`
        <div class="banner">Найдено карт: <b>${items.length}</b>. Проверьте каждую (кнопка «Править»), снимите галочку с лишних и сохраните.</div>
        <div class="card">
          <label class="fld"><span>Ресторан / источник для карт, где он не указан</span>${refSelect('restaurants', allSource, { field: 'all', empty: '— выберите —', addLabel: '＋ Добавить ресторан…' })}</label>
        </div>
        ${items.map((it, idx) => {
          const r = it.recipe;
          const src = r.sourceId ? (r.sourceId.startsWith('new:') ? r.sourceId.slice(4) + ' (новый)' : S.nameOf('restaurants', r.sourceId)) : '';
          const cat = r.categoryId ? (r.categoryId.startsWith('new:') ? r.categoryId.slice(4) + ' (новая)' : S.nameOf('categories', r.categoryId)) : '';
          const warn = [];
          if (!r.name) warn.push('нет названия');
          if (!r.ingredients.length) warn.push('нет ингредиентов');
          if (!src && !allSource) warn.push('не выбран ресторан');
          return html`<div class="card pv ${it.on ? '' : 'off'}">
            <label class="pv-check"><input type="checkbox" data-idx="${idx}" ${it.on ? 'checked' : ''}><span></span></label>
            <div class="pv-body">
              <div class="rc-title">${r.name || 'Без названия'}</div>
              <div class="rc-sub">${cat || 'без категории'} · ${src || (allSource ? 'источник: общий' : 'источник не указан')}</div>
              <div class="rc-sub">${r.ingredients.length} ${plural(r.ingredients.length, 'ингредиент', 'ингредиента', 'ингредиентов')} · ${r.steps.length} ${plural(r.steps.length, 'шаг', 'шага', 'шагов')}${r.yieldAmount != null ? ` · выход ${amount(r.yieldAmount, r.yieldUnit)}` : ''}</div>
              ${warn.length ? html`<div class="pv-warn">${icon('warn')} ${warn.join(', ')}</div>` : ''}
              ${it.label ? html`<div class="muted small">${it.label}</div>` : ''}
            </div>
            <button class="btn sm" data-act="edit" data-idx="${idx}">Править</button>
          </div>`;
        })}
        <div class="bottom-bar"><button class="btn primary wide" data-act="save" ${n ? '' : 'disabled'}>Сохранить ${n} ${plural(n, 'карту', 'карты', 'карт')}</button></div>`;
    },
    mount(el) {
      bindRefSelects(el, (f, v) => { allSource = v; refresh(); });
      el.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') { items[+e.target.dataset.idx].on = e.target.checked; refresh(); }
      });
      onActs(el, {
        edit: (t) => {
          const it = items[+t.dataset.idx];
          const rec = { ...it.recipe, sourceId: it.recipe.sourceId || allSource };
          push(recipeForm({ mode: 'draft', recipe: rec, banner: it.found ? foundBanner(it) : null, onSaved: (d) => { it.recipe = d; } }));
        },
        save: () => {
          const chosen = items.filter((i) => i.on);
          const noSrc = chosen.filter((i) => !i.recipe.sourceId && !allSource);
          if (noSrc.length) { toast('Выберите ресторан-источник', 'error'); el.querySelector('select').scrollIntoView({ block: 'center' }); return; }
          const noName = chosen.filter((i) => !i.recipe.name);
          if (noName.length) { toast('У некоторых карт нет названия — нажмите «Править»', 'error'); return; }
          for (const it of chosen) saveRecipe({ ...it.recipe, sourceId: it.recipe.sourceId || allSource, origin });
          haptic('success');
          toast(`Сохранено: ${chosen.length}`);
          back(true);
        },
      });
    },
  };
}

// ---- Вставка ТТК из текста ---------------------------------------------------------------------
const EXAMPLE_TTK = `=== ТТК ===
Название: Салат «Цезарь» с курицей
Категория: Салаты
Источник: Ресторан «Белуга»
Выход: 250 г
Порций: 1
Ингредиенты:
- Филе куриное | 100 | г
- Салат романо | 60 | г
- Соус цезарь | 40 | г
- Пармезан | 15 | г
- Гренки | 20 | г
Технология:
1. Филе посолить, обжарить на гриле до готовности, нарезать слайсами.
2. Романо порвать руками, заправить соусом.
3. Выложить курицу, гренки, натереть пармезан.
Подача: На плоской тарелке горкой, пармезан стружкой сверху.
Хранение: Собранный салат — не более 1 часа при +2…+6 °C.
=== КОНЕЦ ===`;

export function pasteScreen({ tab, title, intro, prompt, example, parse, onParsed }) {
  let text = '';
  return {
    tab,
    form: true,
    title,
    isDirty: () => !!text.trim(),
    render: () => html`
      <div class="card">
        <p class="hint mt0">${intro}</p>
        <textarea class="inp mono" id="ptext" rows="12" placeholder="Вставьте текст сюда">${text}</textarea>
        <div class="row gap mt">
          ${navigator.clipboard?.readText ? html`<button class="btn" data-act="paste">Вставить из буфера</button>` : ''}
          <button class="btn ghost" data-act="clear">Очистить</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Как получить такой текст</div>
        <ol class="steps small">
          <li>Нажмите «Скопировать инструкцию для Claude».</li>
          <li>В чате с Claude вставьте инструкцию и приложите фото (или напишите задачу).</li>
          <li>Скопируйте ответ Claude целиком и вставьте сюда.</li>
        </ol>
        <div class="stack">
          <button class="btn" data-act="prompt">${icon('copy')} Скопировать инструкцию для Claude</button>
          <button class="btn ghost" data-act="example">Вставить пример</button>
        </div>
      </div>
      <div class="bottom-bar"><button class="btn primary wide" data-act="parse">Распознать</button></div>`,
    mount(el) {
      const ta = el.querySelector('#ptext');
      ta.addEventListener('input', () => { text = ta.value; });
      onActs(el, {
        paste: async () => {
          try { const t = await navigator.clipboard.readText(); if (t) { text = t; ta.value = t; } else toast('Буфер пуст'); } catch (e) { toast('Нет доступа к буферу — вставьте вручную (долгое нажатие → Вставить)'); }
        },
        clear: () => { text = ''; ta.value = ''; ta.focus(); },
        prompt: async () => { if (await copyText(prompt)) toast('Инструкция скопирована'); else showText('Инструкция для Claude', prompt); },
        example: () => { text = example; ta.value = example; },
        parse: () => {
          const items = parse(text);
          if (!items.length) { toast('Не нашёл ни одной записи. Проверьте формат.', 'error'); return; }
          text = ''; // чтобы не спрашивать «выйти без сохранения» после перехода
          onParsed(items);
        },
      });
    },
  };
}

function pasteRecipes() {
  return pasteScreen({
    tab: 'ttk',
    title: 'ТТК из текста',
    intro: 'Вставьте одну или несколько карт в формате «=== ТТК === … === КОНЕЦ ===». Перед сохранением всё можно проверить и поправить.',
    prompt: CLAUDE_TTK_PROMPT,
    example: EXAMPLE_TTK,
    parse: parseRecipesText,
    onParsed: (recipes) => {
      const drafts = recipes.map((r) => ({ recipe: { ...r, origin: 'text' }, label: '' }));
      if (drafts.length === 1) replace(recipeForm({ mode: 'import', recipe: drafts[0].recipe, banner: html`Проверьте распознанное, выберите ресторан и сохраните.` }));
      else replace(importPreview(drafts, 'text'));
    },
  });
}

export { pasteRecipes };
