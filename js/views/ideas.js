// Раздел «Идеи»

import { html, uid, clone, plural, norm } from '../util.js';
import * as S from '../store.js';
import { push, back, replace, refresh, toast, confirmDialog, onActs, actionSheet, setTab } from '../ui.js';
import { haptic } from '../tg.js';
import { IDEA_STATUSES, statusLabel, parseIdeasText, CLAUDE_IDEAS_PROMPT, emptyRecipe } from '../textfmt.js';
import { refSelect, bindRefSelects, fab, emptyState, chips, segmented, icon, catTag } from './common.js';
import { recipeForm, recipeDetail, pasteScreen, ttkState, ttkSwitch } from './ttk.js';

const st = { status: '' };

function ideaCard(i) {
  const cat = S.nameOf('categories', i.categoryId);
  const hasRecipe = i.recipeId && S.get('recipes', i.recipeId);
  return html`<button class="card icard" data-act="open" data-id="${i.id}">
    <div class="ic-top"><span class="rc-title">${i.title}</span><span class="badge st-${i.status}">${statusLabel(i.status)}</span></div>
    ${i.description ? html`<div class="ic-desc">${i.description}</div>` : ''}
    <div class="rc-meta">${cat ? catTag(i.categoryId) : ''}${hasRecipe ? html`<span class="has-ttk">${icon('check')} есть ТТК</span>` : ''}</div>
  </button>`;
}

export function ideasList() {
  return {
    tab: 'ttk',
    title: 'Идеи',
    subtitle: () => { const n = S.list('ideas').length; return n ? `${n} ${plural(n, 'идея', 'идеи', 'идей')}` : 'Что попробовать'; },
    render() {
      const all = S.list('ideas');
      const counts = Object.fromEntries(IDEA_STATUSES.map((s) => [s.id, all.filter((i) => i.status === s.id).length]));
      const items = all.filter((i) => !st.status || i.status === st.status)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return html`
        <div class="toolbar sticky">${ttkSwitch()}<div class="mt">${chips('status', st.status, [{ id: '', label: 'Все', count: all.length }, ...IDEA_STATUSES.map((s) => ({ ...s, count: counts[s.id] }))])}</div></div>
        ${!all.length ? emptyState('Идей пока нет', 'Запишите первую идею или вставьте список, который прислал Claude.', html`
          <div class="stack"><button class="btn primary" data-act="new">Новая идея</button><button class="btn" data-act="paste">${icon('text')} Вставить идеи из текста</button></div>`, '💡')
        : items.length ? items.map(ideaCard) : html`<div class="empty small">В этом статусе пусто</div>`}
        ${fab()}`;
    },
    mount(el) {
      onActs(el, {
        seg: (t) => { if (t.dataset.seg === 'ttkview') { ttkState.view = t.dataset.v; setTab('ttk'); } },
        chip: (t) => { st.status = t.dataset.v; refresh(); },
        open: (t) => push(ideaForm({ idea: S.get('ideas', t.dataset.id) })),
        new: () => push(ideaForm({})),
        paste: () => push(pasteIdeas()),
        add: async () => {
          const v = await actionSheet('Добавить', [
            { label: 'Новая идея', value: 'new' },
            { label: 'Вставить идеи из текста', value: 'paste', hint: 'список от Claude' },
          ]);
          if (v === 'new') push(ideaForm({}));
          if (v === 'paste') push(pasteIdeas());
        },
      });
    },
  };
}

// mode: обычная правка или 'draft' (в предпросмотре вставки)
export function ideaForm({ idea, draftMode = false, onSaved }) {
  const isNew = !idea;
  const d = idea ? clone(idea) : { title: '', description: '', categoryId: '', status: 'idea' };
  const initial = JSON.stringify(d);
  let saved = false;
  return {
    tab: 'ttk',
    form: true,
    title: isNew ? 'Новая идея' : draftMode ? 'Проверьте идею' : 'Идея',
    isDirty: () => !saved && JSON.stringify(d) !== initial,
    render: () => {
      const recipe = d.recipeId && S.get('recipes', d.recipeId);
      return html`
        <div class="card">
          <label class="fld"><span>Название</span><input class="inp" data-f="title" value="${d.title}" placeholder="Например, Тартар из свёклы с хреном"></label>
          <label class="fld"><span>Описание</span><textarea class="inp" data-f="description" rows="5" placeholder="Суть, вкусы, подача">${d.description}</textarea></label>
          <label class="fld"><span>Категория</span>${refSelect('categories', d.categoryId, { field: 'categoryId', addLabel: '＋ Новая категория…' })}</label>
          <div class="fld"><span>Статус</span>${segmented('status', d.status, IDEA_STATUSES)}</div>
        </div>
        ${!isNew && !draftMode ? html`<div class="card stack">
          ${recipe ? html`<button class="btn" data-act="open-recipe">Открыть ТТК «${recipe.name}»</button>`
            : html`<button class="btn" data-act="to-recipe">${icon('plus')} Создать ТТК из идеи</button>`}
          <button class="btn ghost danger" data-act="del">${icon('trash')} Удалить идею</button>
        </div>` : ''}
        <div class="bottom-bar"><button class="btn primary wide" data-act="save">${draftMode ? 'Готово' : 'Сохранить'}</button></div>`;
    },
    mount(el) {
      bindRefSelects(el, (f, v) => { d[f] = v; });
      el.addEventListener('input', (e) => {
        const f = e.target.dataset.f;
        if (f === 'title' || f === 'description') d[f] = e.target.value;
      });
      const doSave = () => {
        if (!d.title.trim()) { toast('Введите название', 'error'); return null; }
        d.title = d.title.trim();
        saved = true;
        if (draftMode) { onSaved?.(d); return d; }
        let rec;
        S.batch(() => {
          rec = S.put('ideas', { ...d, id: d.id || uid(), categoryId: S.resolveRef('categories', d.categoryId) }, { silent: true });
        });
        return rec;
      };
      onActs(el, {
        seg: (t) => { d.status = t.dataset.v; el.querySelectorAll('[data-seg="status"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === d.status)); },
        save: () => {
          const rec = doSave();
          if (!rec) return;
          haptic('success');
          if (!draftMode) toast('Сохранено');
          back(true);
        },
        'open-recipe': () => push(recipeDetail(d.recipeId)),
        'to-recipe': () => {
          // Сохраняем правки идеи и открываем форму ТТК с её данными
          const rec = doSave();
          if (!rec) return;
          const r = { ...emptyRecipe(), name: rec.title, categoryId: rec.categoryId, notes: rec.description };
          replace(recipeForm({
            mode: 'new',
            recipe: r,
            title: 'ТТК из идеи',
            onSaved: (saved) => {
              S.put('ideas', { ...S.get('ideas', rec.id), recipeId: saved.id, status: rec.status === 'idea' ? 'work' : rec.status });
              replace(recipeDetail(saved.id));
            },
          }));
        },
        del: async () => {
          if (!(await confirmDialog(`Удалить идею «${d.title}»?`, 'Удалить', true))) return;
          S.remove('ideas', d.id);
          saved = true;
          toast('Удалено');
          back(true);
        },
      });
    },
  };
}

function pasteIdeas() {
  return pasteScreen({
    tab: 'ttk',
    title: 'Идеи из текста',
    intro: 'Вставьте идеи в формате «=== ИДЕЯ === … === КОНЕЦ ===» или просто список: одна строка — одна идея («Название — описание»).',
    prompt: CLAUDE_IDEAS_PROMPT,
    example: `=== ИДЕЯ ===
Название: Тартар из печёной свёклы
Категория: Закуски
Статус: идея
Описание: Свёкла, запечённая в соли, с хреном и копчёным желтком. Подача в кольце, сверху крошка из ржаного хлеба.
=== КОНЕЦ ===
=== ИДЕЯ ===
Название: Уха из судака на сливочном бульоне
Категория: Супы
Статус: тест
Описание: Прозрачный бульон, сливочный акцент, укропное масло.
=== КОНЕЦ ===`,
    parse: parseIdeasText,
    onParsed: (ideas) => replace(ideasPreview(ideas)),
  });
}

function ideasPreview(ideas) {
  const items = ideas.map((i) => ({ idea: i, on: true }));
  return {
    tab: 'ttk',
    form: true,
    title: 'Предпросмотр идей',
    isDirty: () => true,
    render: () => {
      const n = items.filter((i) => i.on).length;
      const exists = new Set(S.list('ideas').map((i) => norm(i.title)));
      return html`
        <div class="banner">Найдено идей: <b>${items.length}</b>. Снимите галочку с лишних, нажмите «Править», чтобы поправить.</div>
        ${items.map((it, idx) => {
          const i = it.idea;
          const cat = i.categoryId ? (i.categoryId.startsWith('new:') ? i.categoryId.slice(4) + ' (новая)' : S.nameOf('categories', i.categoryId)) : '';
          return html`<div class="card pv ${it.on ? '' : 'off'}">
            <label class="pv-check"><input type="checkbox" data-idx="${idx}" ${it.on ? 'checked' : ''}><span></span></label>
            <div class="pv-body">
              <div class="ic-top"><span class="rc-title">${i.title}</span><span class="badge st-${i.status}">${statusLabel(i.status)}</span></div>
              ${i.description ? html`<div class="ic-desc">${i.description}</div>` : ''}
              <div class="rc-sub">${cat || 'без категории'}</div>
              ${exists.has(norm(i.title)) ? html`<div class="pv-warn">${icon('warn')} такая идея уже есть</div>` : ''}
            </div>
            <button class="btn sm" data-act="edit" data-idx="${idx}">Править</button>
          </div>`;
        })}
        <div class="bottom-bar"><button class="btn primary wide" data-act="save" ${n ? '' : 'disabled'}>Добавить ${n} ${plural(n, 'идею', 'идеи', 'идей')}</button></div>`;
    },
    mount(el) {
      el.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') { items[+e.target.dataset.idx].on = e.target.checked; refresh(); }
      });
      onActs(el, {
        edit: (t) => {
          const it = items[+t.dataset.idx];
          push(ideaForm({ idea: it.idea, draftMode: true, onSaved: (d) => { it.idea = d; } }));
        },
        save: () => {
          const chosen = items.filter((i) => i.on);
          S.batch(() => {
            for (const it of chosen) {
              S.put('ideas', { ...it.idea, id: uid(), categoryId: S.resolveRef('categories', it.idea.categoryId) }, { silent: true });
            }
          });
          haptic('success');
          toast(`Добавлено: ${chosen.length}`);
          back(true);
        },
      });
    },
  };
}
