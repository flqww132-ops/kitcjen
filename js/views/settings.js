// Раздел «Настройки»: синхронизация, списки, резервная копия, очистка

import { html, raw, fmtDateTime, plural, blobToDataURL, dataURLToBlob } from '../util.js';
import * as S from '../store.js';
import { push, refresh, toast, confirmDialog, onActs, actionSheet, promptSheet, pickFile, showText, sheet } from '../ui.js';
import { inTelegram, copyText, haptic } from '../tg.js';
import { loggedIn, session, clearSession } from '../auth.js';
import { showLoginScreen } from './login.js';
import { photoPut, photoClear } from '../idb.js';
import { photoRecord } from '../photos.js';
import { icon, busy, segmented } from './common.js';
import { getThemeMode, setThemeMode } from '../theme.js';
import { botUrl, setBotUrl, remState, testBot, syncReminders, botReady, sendFile } from '../reminders.js';

const LISTS = {
  categories: { title: 'Категории', one: 'категорию', usage: () => [...S.list('recipes'), ...S.list('ideas')].map((r) => r.categoryId), field: 'categoryId', where: ['recipes', 'ideas'] },
  restaurants: { title: 'Рестораны', one: 'ресторан', usage: () => S.list('recipes').map((r) => r.sourceId), field: 'sourceId', where: ['recipes'] },
  stations: { title: 'Цеха и станции', one: 'цех', usage: () => S.list('prepItems').map((r) => r.stationId), field: 'stationId', where: ['prepItems'] },
  locations: { title: 'Места хранения', one: 'место', usage: () => S.list('invItems').map((r) => r.locationId), field: 'locationId', where: ['invItems'] },
};

function syncBlock() {
  const s = S.sync;
  let state, cls = '';
  if (s.mode === 'local') {
    state = 'Вход не выполнен — данные хранятся только на этом устройстве. Войдите по коду из Telegram (блок ниже), чтобы данные были общими с Telegram.';
    cls = 'warn';
  } else if (s.state === 'syncing') state = 'Синхронизация…';
  else if (s.state === 'ok') { state = `Синхронизировано ${fmtDateTime(s.lastSync)}`; cls = 'ok'; }
  else if (s.state === 'newer') { state = 'Данные в облаке записаны более новой версией приложения. Закройте и откройте приложение заново, чтобы обновиться.'; cls = 'warn'; }
  else if (s.state === 'toobig') { state = 'Облако Telegram переполнено (лимит ~1024 ячейки по 4 КБ). Данные сохранены на устройстве и в облаке бота.'; cls = 'err'; }
  else if (s.state === 'error') { state = `Ошибка синхронизации: ${s.error}. Данные сохранены на устройстве, попробуем ещё раз.`; cls = 'err'; }
  else state = s.lastSync ? `Последняя синхронизация ${fmtDateTime(s.lastSync)}` : 'Ещё не синхронизировано';
  return html`<div class="card sync-card">
    <div class="card-title">Синхронизация</div>
    <div class="sync-state ${cls}">${state}</div>
    ${s.usage && s.tg ? html`<div class="muted small">Облако Telegram: занято ${s.usage.keys} из ${s.usage.max} ячеек</div>` : ''}
    ${s.recovered ? html`<div class="muted small">Последняя запись в облако Telegram оборвалась — данные восстановлены из предыдущей целой копии.</div>` : ''}
    <ul class="info">
      ${s.srv ? html`<li><b>Всё, включая фото,</b> — в облаке бота: одинаково в Telegram и в приложении на телефоне.</li>` : ''}
      ${s.tg ? html`<li><b>Тексты</b> — ещё и в облаке Telegram (запасная копия).</li>` : ''}
      <li>Копия всего — на этом устройстве, работает и без интернета.</li>
    </ul>
    ${s.mode === 'cloud' ? html`<button class="btn wide" data-act="sync">Синхронизировать сейчас</button>` : ''}
  </div>`;
}

// ---- Вход на других устройствах -----------------------------------------------------
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 2) return 'только что';
  if (m < 60) return `${m} мин назад`;
  if (m < 48 * 60) return `${Math.round(m / 60)} ч назад`;
  return fmtDateTime(ts);
};
const sessState = { list: null, error: '' };
async function loadSessions() {
  sessState.at = Date.now();
  if (!loggedIn()) { sessState.list = []; return; }
  try {
    const r = await S.srvFetch('/api/sessions');
    const j = await r.json();
    sessState.list = j.ok ? j.sessions : [];
    sessState.error = j.ok ? '' : (j.message || j.error || '');
  } catch (e) { sessState.error = 'нет связи с облаком'; }
}
function devicesList() {
  if (!sessState.list) return html`<div class="muted small">Загружаю список устройств…</div>`;
  if (!sessState.list.length) return html`<div class="muted small">Вход на других устройствах не выполнен.</div>`;
  return html`<div class="dev-list">${sessState.list.map((d) => html`<div class="dev-row">
    <div class="dev-main"><b>${d.device || 'Устройство'}${d.current ? ' (это)' : ''}</b><small>вход ${fmtDateTime(d.created)} · был ${ago(d.last)}</small></div>
    <button class="btn sm danger" data-act="dev-out" data-id="${d.id}" data-cur="${d.current ? '1' : ''}">Выйти</button>
  </div>`)}</div>`;
}
function loginBlock() {
  if (inTelegram) {
    return html`<div class="group-title">Приложение на телефоне</div>
      <div class="card login-card">
        <p class="small">«Книга кухни» как отдельное приложение на экране «Домой» — открывается без Telegram, данные и фото те же.</p>
        <button class="btn primary wide" data-act="login-code">${icon('key')} Получить код входа</button>
        <div class="card-sub">Устройства со входом</div>
        ${devicesList()}
      </div>`;
  }
  const me = session();
  if (!me) {
    return html`<div class="group-title">Вход</div>
      <div class="card login-card">
        <p class="small">Войдите, чтобы данные были те же, что в Telegram: в Telegram откройте «Книгу кухни» → Настройки → «Получить код входа».</p>
        <button class="btn primary wide" data-act="login">${icon('key')} Войти по коду</button>
      </div>`;
  }
  return html`<div class="group-title">Вход</div>
    <div class="card login-card">
      <div class="sync-state ok">Вы вошли${me.name ? ` как ${me.name}` : ''}. Данные общие с Telegram.</div>
      <div class="card-sub">Устройства со входом</div>
      ${devicesList()}
    </div>`;
}

async function showLoginCode() {
  const done = busy('Получаю код…');
  let j;
  try {
    const r = await S.srvFetch('/api/login-code', { method: 'POST' });
    j = await r.json();
    if (!j.ok) throw new Error(j.message || j.error);
  } catch (e) { toast('Не получилось: ' + (e.message || e), 'error'); return; } finally { done(); }
  const link = location.origin + location.pathname.replace(/index\.html$/, '');
  const mins = Math.round((j.exp - Date.now()) / 60000);
  await sheet({
    title: 'Код входа',
    body: html`<div class="login-code">${j.code.slice(0, 3)} ${j.code.slice(3)}</div>
      <p class="hint center">Действует ${mins} мин, один раз.</p>
      <ol class="steps-ol">
        <li>Откройте в <b>Safari</b> ссылку <button class="linkish" data-copy="${link}">${link}</button> <button class="btn sm" data-copy="${link}">${icon('copy')} Скопировать</button></li>
        <li>Внизу «Поделиться» → <b>«На экран „Домой“»</b>.</li>
        <li>Откройте «Книгу кухни» с экрана и введите этот код.</li>
      </ol>`,
    onMount: (box) => box.addEventListener('click', async (e) => { const b = e.target.closest('[data-copy]'); if (b && await copyText(b.dataset.copy)) toast('Ссылка скопирована'); }),
    buttons: [{ label: 'Готово', kind: 'primary', value: true }],
  });
  loadSessions().then(() => refresh());
}

function remBlock() {
  const url = botUrl();
  const r = remState;
  let state, cls = '';
  if (!url) state = 'Не подключено. Напоминания о заготовках и таймеры приходят в чат с ботом, когда подключён бот-напоминальщик.';
  else if (!loggedIn()) { state = 'Работает после входа по коду из Telegram (блок «Вход» выше).'; cls = 'warn'; }
  else if (r.state === 'ok') { state = `Подключено. В очереди: ${r.count ?? 0}${r.next ? `, ближайшее ${fmtDateTime(r.next)}` : ''}.`; cls = 'ok'; }
  else if (r.state === 'syncing') state = 'Отправляю расписание боту…';
  else if (r.state === 'error') { state = `Ошибка: ${r.message}`; cls = 'err'; }
  else state = 'Подключено.';
  return html`<div class="group-title">Напоминания в Telegram</div>
    <div class="card rem-card">
      <div class="sync-state ${cls}">${state}</div>
      <label class="fld"><span>Адрес бота-напоминальщика</span><input class="inp" id="botUrl" inputmode="url" value="${url}" placeholder="https://kniga-kuhni-bot.….workers.dev" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="row gap">
        <button class="btn primary grow" data-act="bot-save">${icon('send')} Сохранить и проверить</button>
        ${url && loggedIn() ? html`<button class="btn icon-only" data-act="bot-sync" aria-label="Обновить">↻</button>` : ''}
      </div>
      <p class="hint">Бот — это и облако приложения. Менять адрес нужно, только если вы подняли своего бота (папка <b>bot</b>, файл README).</p>
    </div>`;
}

export function settingsScreen() {
  return {
    tab: 'settings',
    title: 'Настройки',
    render() {
      const c = (k) => S.list(k).length;
      const row = (act, color, ico, label, extra = '', attrs = '') => html`<button class="menu-row" data-act="${act}" ${raw(attrs)}>
        <span class="mr-ico" style="--c:${color}">${icon(ico)}</span><span class="mr-label">${label}</span>${extra ? html`<small>${extra}</small>` : ''}</button>`;
      return html`
        ${syncBlock()}
        ${loginBlock()}
        ${remBlock()}
        <div class="group-title">Оформление</div>
        <div class="card">${segmented('theme', getThemeMode(), [{ id: 'light', label: 'Светлая' }, { id: 'dark', label: 'Тёмная' }, { id: 'auto', label: 'Авто' }])}</div>
        <p class="hint pad-x">«Авто» — светлая или тёмная, как настроено на телефоне.</p>
        <div class="group-title">Списки</div>
        <div class="card list-card">
          ${row('list', '#FF9500', 'tag', 'Категории', c('categories'), 'data-k="categories"')}
          ${row('list', '#007AFF', 'home', 'Рестораны / источники', c('restaurants'), 'data-k="restaurants"')}
          ${row('list', '#34C759', 'flame', 'Цеха и станции', c('stations'), 'data-k="stations"')}
          ${row('list', '#A2845E', 'box', 'Места хранения', c('locations'), 'data-k="locations"')}
        </div>
        <div class="group-title">Резервная копия</div>
        <div class="card list-card">
          ${row('backup-chat', '#007AFF', 'send', 'Прислать копию в чат с ботом (с фото)')}
          ${row('backup-file', '#5856D6', 'download', 'Сохранить файл (с фото)')}
          ${row('backup-text', '#30B0C7', 'copy', 'Скопировать текстом (без фото)')}
          ${row('restore-file', '#AF52DE', 'file', 'Восстановить из файла')}
          ${row('restore-text', '#A2845E', 'text', 'Восстановить из текста')}
        </div>
        <p class="hint pad-x">В копии: ${c('recipes')} ТТК, ${c('ideas')} ${plural(c('ideas'), 'идея', 'идеи', 'идей')}, ${c('equipment')} поз. оборудования, ${c('prepItems')} поз. заготовок, ${c('invItems')} поз. склада, ${c('invCounts')} инвентаризаций.</p>
        <div class="group-title">Очистка</div>
        <div class="card list-card">${row('wipe', '#FF3B30', 'trash', html`<span class="danger-text">Удалить все данные</span>`)}</div>
        <p class="hint pad-x">Удалит всё на этом устройстве и в облаках (бота и Telegram). Перед этим лучше сохранить резервную копию.</p>
        <div class="muted small center">Книга кухни ${S.APP_VERSION} · схема данных ${S.SCHEMA_VERSION}</div>`;
    },
    mount(el) {
      if (loggedIn() && !sessState.loading && Date.now() - (sessState.at || 0) > 5000) {
        sessState.loading = true;
        loadSessions().then(() => { sessState.loading = false; if (el.isConnected && document.querySelector('.login-card')) refresh(); });
      }
      onActs(el, {
        seg: (t) => { setThemeMode(t.dataset.v); haptic('select'); refresh(); },
        'bot-save': async () => {
          const v = el.querySelector('#botUrl').value.trim();
          if (v && !/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/i.test(v)) { toast('Адрес должен начинаться с https://', 'error'); return; }
          setBotUrl(v);
          if (!v) { toast('Напоминания отключены'); await syncReminders(true); refresh(); return; }
          if (!loggedIn()) { toast('Сохранено. Проверить можно после входа'); refresh(); return; }
          const done = busy('Проверяю бота…');
          try { await testBot(); haptic('success'); toast('Бот работает — проверьте чат с ботом'); }
          catch (e) { toast('Не получилось: ' + (e.message || e), 'error'); }
          finally { done(); refresh(); }
        },
        'bot-sync': async () => { await syncReminders(true); refresh(); },
        'login-code': showLoginCode,
        login: () => showLoginScreen(),
        'dev-out': async (t) => {
          const cur = !!t.dataset.cur;
          if (!(await confirmDialog(cur ? 'Выйти на этом устройстве? Данные останутся в облаке и в Telegram.' : 'Выйти на этом устройстве? Ему понадобится новый код.', 'Выйти', true))) return;
          try {
            await S.srvFetch('/api/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.dataset.id }) });
          } catch (e) { toast('Нет связи с облаком', 'error'); return; }
          if (cur) { clearSession(); location.reload(); return; }
          toast('Вход отменён');
          await loadSessions(); refresh();
        },
        sync: async () => { await S.syncNow(); refresh(); },
        list: (t) => push(listEditor(t.dataset.k)),
        'backup-file': backupFile,
        'backup-chat': async () => {
          if (!botReady()) { toast(!botUrl() ? 'Сначала подключите бота (блок «Напоминания в Telegram» выше)' : 'Отправка работает внутри Telegram', 'error'); return; }
          const done = busy('Готовлю копию…');
          try {
            const data = await makeBackup(true);
            const d = new Date();
            const name = `kniga-kuhni-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
            const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
            await sendFile(blob, name, `Резервная копия «Книги кухни» от ${d.toLocaleString('ru-RU')}. Чтобы восстановить: Настройки → Восстановить из файла.`);
            haptic('success');
            toast('Копия отправлена в чат с ботом');
          } catch (e) { toast(e.message || String(e), 'error'); } finally { done(); }
        },
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
    for (const id of used) {
      const p = await photoRecord(id).catch(() => null);
      if (!p) continue;
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
