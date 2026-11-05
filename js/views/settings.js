// Раздел «Настройки»: синхронизация, списки, резервная копия, очистка

import { html, fmtDateTime, plural, blobToDataURL, dataURLToBlob } from '../util.js';
import * as S from '../store.js';
import { push, refresh, toast, confirmDialog, onActs, actionSheet, promptSheet, pickFile, showText, sheet } from '../ui.js';
import { inTelegram, copyText, haptic } from '../tg.js';
import { photoAll, photoPut, photoClear } from '../idb.js';
import { icon, busy } from './common.js';

const LISTS = {
  categories: { title: 'Категории', one: 'категорию', usage: () => [...S.list('recipes'), ...S.list('ideas')].map((r) => r.categoryId), field: 'categoryId', where: ['recipes', 'ideas'] },
  restaurants: { title: 'Рестораны', one: 'ресторан', usage: () => S.list('recipes').map((r) => r.sourceId), field: 'sourceId', where: ['recipes'] },
  stations: { title: 'Цеха и станции', one: 'цех', usage: () => S.list('prepItems').map((r) => r.stationId), field: 'stationId', where: ['prepItems'] },
};

function syncBlock() {
  const s = S.sync;
  let state, cls = '';
  if (s.mode === 'local') {
    state = inTelegram ? 'Облако Telegram недоступно в этой версии приложения Telegram — данные только на устройстве.' : 'Открыто в браузере: данные хранятся только в этом браузере. Облако работает, когда приложение открыто в Telegram.';
    cls = 'warn';
  } else if (s.state === 'syncing') state = 'Синхронизация…';
  else if (s.state === 'ok') { state = `Синхронизировано ${fmtDateTime(s.lastSync)}`; cls = 'ok'; }
  else if (s.state === 'newer') { state = 'Данные в облаке записаны более новой версией приложения. Закройте и откройте приложение заново, чтобы обновиться.'; cls = 'warn'; }
  else if (s.state === 'toobig') { state = 'Облако Telegram переполнено (лимит ~1024 ячейки по 4 КБ). Данные сохранены на устройстве. Удалите лишнее или сделайте резервную копию.'; cls = 'err'; }
  else if (s.state === 'error') { state = `Ошибка синхронизации: ${s.error}. Данные сохранены на устройстве, попробуем ещё раз.`; cls = 'err'; }
  else state = s.lastSync ? `Последняя синхронизация ${fmtDateTime(s.lastSync)}` : 'Ещё не синхронизировано';
  return html`<div class="card">
    <div class="card-title">Синхронизация</div>
    <div class="sync-state ${cls}">${state}</div>
    ${s.usage ? html`<div class="muted small">Облако: занято ${s.usage.keys} из ${s.usage.max} ячеек</div>` : ''}
    ${s.recovered ? html`<div class="muted small">Последняя запись в облако оборвалась — данные восстановлены из предыдущей целой копии.</div>` : ''}
    <ul class="info">
      <li><b>Тексты</b> (ТТК, идеи, оборудование, заготовки) — в облаке Telegram и копия на телефоне.</li>
      <li><b>Фото</b> — только на этом телефоне. В облако не попадают. Сохраняйте резервную копию файлом.</li>
    </ul>
    ${s.mode === 'cloud' ? html`<button class="btn wide" data-act="sync">Синхронизировать сейчас</button>` : ''}
  </div>`;
}

export function settingsScreen() {
  return {
    tab: 'settings',
    title: 'Настройки',
    render() {
      const c = (k) => S.list(k).length;
      return html`
        ${syncBlock()}
        <div class="card">
          <div class="card-title">Списки</div>
          <button class="menu-row" data-act="list" data-k="categories"><span>Категории</span><small>${c('categories')}</small></button>
          <button class="menu-row" data-act="list" data-k="restaurants"><span>Рестораны / источники</span><small>${c('restaurants')}</small></button>
          <button class="menu-row" data-act="list" data-k="stations"><span>Цеха и станции</span><small>${c('stations')}</small></button>
        </div>
        <div class="card">
          <div class="card-title">Резервная копия</div>
          <div class="stack">
            <button class="btn" data-act="backup-file">Сохранить файл (с фото)</button>
            <button class="btn" data-act="backup-text">${icon('copy')} Скопировать текстом (без фото)</button>
            <button class="btn ghost" data-act="restore-file">Восстановить из файла</button>
            <button class="btn ghost" data-act="restore-text">Восстановить из текста</button>
          </div>
          <p class="hint">В копии: ${c('recipes')} ТТК, ${c('ideas')} ${plural(c('ideas'), 'идея', 'идеи', 'идей')}, ${c('equipment')} поз. оборудования, ${c('prepItems')} поз. заготовок.</p>
        </div>
        <div class="card">
          <div class="card-title">Очистка</div>
          <button class="btn ghost danger wide" data-act="wipe">${icon('trash')} Удалить все данные</button>
          <p class="hint">Удалит всё на этом устройстве и в облаке Telegram. Перед этим лучше сохранить резервную копию.</p>
        </div>
        <div class="muted small center">Книга кухни ${S.APP_VERSION} · схема данных ${S.SCHEMA_VERSION}</div>`;
    },
    mount(el) {
      onActs(el, {
        sync: async () => { await S.syncNow(); refresh(); },
        list: (t) => push(listEditor(t.dataset.k)),
        'backup-file': backupFile,
        'backup-text': async () => {
          const text = JSON.stringify(await makeBackup(false));
          if (await copyText(text)) toast('Копия скопирована. Сохраните её, например, в «Избранное» Telegram.');
          else showText('Резервная копия', text);
        },
        'restore-file': async () => {
          const f = await pickFile('.json,application/json,text/plain');
          if (!f) return;
          restore(await f.text());
        },
        'restore-text': async () => {
          const t = await promptSheet('Вставьте текст копии', { multiline: true, okLabel: 'Восстановить', placeholder: '{"app":"kitchen-book", …}' });
          if (t) restore(t);
        },
        wipe: async () => {
          if (!(await confirmDialog('Удалить ВСЕ данные — ТТК, идеи, оборудование, заготовки и фото? На этом устройстве и в облаке.', 'Удалить всё', true))) return;
          if (!(await confirmDialog('Точно? Отменить будет нельзя.', 'Да, удалить', true))) return;
          S.wipeAll();
          await photoClear();
          haptic('warning');
          toast('Данные удалены');
          refresh();
        },
      });
    },
  };
}

async function makeBackup(withPhotos) {
  const out = { app: 'kitchen-book', kind: 'backup', version: S.APP_VERSION, schema: S.SCHEMA_VERSION, exportedAt: new Date().toISOString(), doc: S.exportDoc() };
  if (withPhotos) {
    const used = new Set();
    for (const r of S.list('recipes')) for (const p of r.photos || []) used.add(p.id);
    out.photos = [];
    for (const p of await photoAll()) {
      if (!used.has(p.id)) continue;
      out.photos.push({ id: p.id, w: p.w, h: p.h, createdAt: p.createdAt, data: await blobToDataURL(p.blob) });
    }
  }
  return out;
}

async function backupFile() {
  const done = busy('Готовлю копию…');
  let blob, name;
  try {
    const data = await makeBackup(true);
    const d = new Date();
    name = `kniga-kuhni-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  } finally { done(); }
  const file = new File([blob], name, { type: 'application/json' });
  // На телефоне — через «Поделиться» (можно сохранить в Файлы или отправить себе в Telegram)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  if (inTelegram) {
    await sheet({
      title: 'Сохранение файла',
      body: html`<p class="confirm-msg">Файл «${name}» (${Math.round(blob.size / 1024)} КБ) отправлен на сохранение.</p>
        <p class="hint">Если файл не появился в загрузках — ваша версия Telegram не умеет сохранять файлы из мини-приложений.
        Тогда сделайте копию кнопкой «Скопировать текстом» (без фото) и сохраните её, например, в «Избранное».</p>`,
      buttons: [{ label: 'Понятно', kind: 'primary' }],
    });
  } else toast(`Файл ${name} (${Math.round(blob.size / 1024)} КБ)`);
}

async function restore(text) {
  let data;
  try {
    data = JSON.parse(text.trim());
    if (data.app !== 'kitchen-book' || !data.doc) throw new Error();
  } catch (e) {
    toast('Это не похоже на резервную копию «Книги кухни»', 'error');
    return;
  }
  const c = (k) => Object.values(data.doc.c?.[k] || {}).filter((r) => !r.deleted).length;
  const mode = await actionSheet(`Копия от ${new Date(data.exportedAt).toLocaleString('ru-RU')}: ${c('recipes')} ТТК, ${c('ideas')} идей${data.photos ? `, ${data.photos.length} фото` : ', без фото'}`, [
    { label: 'Объединить с текущими данными', value: 'merge', hint: 'по каждой записи останется более свежая версия' },
    { label: 'Заменить всё содержимым копии', value: 'replace', danger: true, hint: 'текущие записи, которых нет в копии, удалятся' },
  ]);
  if (!mode) return;
  if (mode === 'replace' && !(await confirmDialog('Заменить все текущие данные содержимым копии?', 'Заменить', true))) return;
  const done = busy('Восстанавливаю…');
  try {
    S.importDoc(data.doc, mode);
    for (const p of data.photos || []) {
      await photoPut({ id: p.id, w: p.w, h: p.h, createdAt: p.createdAt, blob: await dataURLToBlob(p.data) });
    }
    haptic('success');
    toast('Восстановлено');
  } catch (e) {
    toast(e.message || 'Ошибка восстановления', 'error');
  } finally { done(); }
  refresh();
}

// ---- Редактор списков ----------------------------------------------------------------------
function listEditor(coll) {
  const L = LISTS[coll];
  return {
    tab: 'settings',
    title: L.title,
    render() {
      const items = S.sortedList(coll);
      const used = L.usage();
      return html`
        <div class="card">
          ${items.map((it, idx) => {
            const n = used.filter((x) => x === it.id).length;
            return html`<div class="lrow">
              <button class="lname" data-act="rename" data-id="${it.id}" ${it.fixed ? 'disabled' : ''}>${it.name}${n ? html` <small>${n}</small>` : ''}</button>
              <button class="icon-btn" data-act="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button>
              <button class="icon-btn" data-act="down" data-idx="${idx}" ${idx === items.length - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button>
              ${it.fixed ? html`<span class="icon-btn"></span>` : html`<button class="icon-btn danger" data-act="del" data-id="${it.id}" aria-label="Удалить">${icon('x')}</button>`}
            </div>`;
          })}
        </div>
        <div class="card row gap">
          <input class="inp grow" id="newName" placeholder="Добавить ${L.one}" enterkeyhint="done">
          <button class="btn primary" data-act="add">Добавить</button>
        </div>
        <p class="hint pad-x">Нажмите на название, чтобы переименовать. Цифра — сколько записей используют.</p>`;
    },
    mount(el) {
      const inp = el.querySelector('#newName');
      const add = () => {
        const name = inp.value.trim();
        if (!name) return;
        if (S.findByName(coll, name)) { toast('Такое уже есть'); return; }
        S.ensureNamed(coll, name);
        S.batch(() => {});
        refresh();
        setTimeout(() => document.getElementById('newName')?.focus(), 30);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      const move = (idx, dir) => {
        const items = S.sortedList(coll);
        const j = idx + dir;
        if (j < 0 || j >= items.length) return;
        [items[idx], items[j]] = [items[j], items[idx]];
        S.batch(() => items.forEach((it, i) => { if (it.order !== i) S.put(coll, { ...it, order: i }, { silent: true }); }));
        refresh();
      };
      onActs(el, {
        add,
        up: (t) => move(+t.dataset.idx, -1),
        down: (t) => move(+t.dataset.idx, 1),
        rename: async (t) => {
          const it = S.get(coll, t.dataset.id);
          const name = await promptSheet('Переименовать', { value: it.name });
          if (!name || name === it.name) return;
          const dup = S.findByName(coll, name);
          if (dup && dup.id !== it.id) { toast('Такое название уже есть'); return; }
          S.put(coll, { ...it, name });
          refresh();
        },
        del: async (t) => {
          const it = S.get(coll, t.dataset.id);
          const n = L.usage().filter((x) => x === it.id).length;
          const msg = n ? `«${it.name}» используется в ${n} ${plural(n, 'записи', 'записях', 'записях')}. Удалить? У них поле станет пустым.` : `Удалить «${it.name}»?`;
          if (!(await confirmDialog(msg, 'Удалить', true))) return;
          S.batch(() => {
            for (const w of L.where) for (const r of S.list(w)) if (r[L.field] === it.id) S.put(w, { ...r, [L.field]: '' }, { silent: true });
            S.remove(coll, it.id, { silent: true });
          });
          refresh();
        },
      });
    },
  };
}
