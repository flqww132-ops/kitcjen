// Данные приложения: схема, миграции, слияние, сохранение и синхронизация.
//
// Документ: { schema, c: { <коллекция>: { <id>: запись } } }
// Каждая запись: { id, updatedAt, deleted?, ... }. Удаление = «надгробие» { id, deleted: true, updatedAt },
// чтобы удаление тоже доезжало до других устройств. Слияние — по каждой записи: побеждает более новая.

import { kvGet, kvSet } from './idb.js';
import { cloudAvailable, readManifest, readCloud, writeCloud, cloudUsage } from './cloud.js';
import { uid, hash, norm, debounce, clone, num } from './util.js';
import { loggedIn, authHeaders, clearSession, DEFAULT_BOT } from './auth.js';

export const SCHEMA_VERSION = 7;
export const APP_VERSION = '2.0.0'; // версия приложения: мелкие правки +0.0.1, средние +0.1.0, крупные +1.0.0

export const COLLECTIONS = [
  'recipes',     // ТТК
  'ideas',       // идеи
  'equipment',   // оборудование к дозаказу
  'prepItems',   // позиции матрицы заготовок
  'prepLog',     // отметки по дням: id = "YYYY-MM-DD|itemId"
  'categories',  // категории блюд (общие для ТТК и идей)
  'restaurants', // рестораны-источники
  'stations',    // цеха/станции
  'products',    // справочник продуктов (под будущую себестоимость: цены, поставщики)
  'timers',      // таймеры: { label, endsAt, durationSec, itemId }
  'settings',    // настройки, общие для устройств: { id: 'botUrl', value }
  'locations',   // места хранения (холодильник, морозильник, склад…)
  'invItems',    // позиции инвентаризации: { name, unit, locationId, minQty, supplier, productId?, prepItemId? }
  'invCounts',   // пересчёты: { date, status: 'open'|'done', counts: { invItemId: qty }, finishedAt }
  'batches',     // партии заготовок (маркировка): { prepItemId, name, qty, madeAt, expiresAt, by, status }
  'checklists',  // чек-листы смены: { name, items: [{ id, text }], time, remind }
  'checkLog',    // заполнение чек-листов: id = "YYYY-MM-DD|checklistId", marks: { itemId: { v, note, at } }
];

export const OWN_SOURCE_ID = 'own'; // «Своя разработка» — всегда есть

const SEED = {
  categories: ['Закуски', 'Салаты', 'Супы', 'Горячее', 'Гарниры', 'Соусы', 'Десерты', 'Выпечка', 'Заготовки', 'Напитки'],
  stations: ['Холодный цех', 'Горячий цех', 'Кондитерский цех', 'Заготовочный цех'],
  locations: ['Холодильник', 'Морозильник', 'Сухой склад', 'Овощной склад'],
};

// Начальные записи с постоянными id и очень старой датой — чтобы два устройства не плодили дубли,
// а любое изменение пользователя всегда «побеждало».
function seedRecords() {
  const out = { categories: {}, stations: {}, restaurants: {}, locations: {} };
  SEED.locations.forEach((name, i) => {
    const id = 'seed_loc_' + i;
    out.locations[id] = { id, name, order: i, updatedAt: 1 };
  });
  SEED.categories.forEach((name, i) => {
    const id = 'seed_cat_' + i;
    out.categories[id] = { id, name, order: i, updatedAt: 1 };
  });
  SEED.stations.forEach((name, i) => {
    const id = 'seed_st_' + i;
    out.stations[id] = { id, name, order: i, updatedAt: 1 };
  });
  out.restaurants[OWN_SOURCE_ID] = { id: OWN_SOURCE_ID, name: 'Своя разработка', order: -1, fixed: true, updatedAt: 1 };
  return out;
}

export function emptyDoc() {
  const doc = { schema: SCHEMA_VERSION, c: {} };
  for (const k of COLLECTIONS) doc.c[k] = {};
  const seed = seedRecords();
  for (const k of Object.keys(seed)) Object.assign(doc.c[k], seed[k]);
  return doc;
}

// ---- Миграции ----------------------------------------------------------------
// Ключ — версия, ИЗ которой мигрируем.
const MIGRATIONS = {
  // 1 → 2: у заготовок появились время «Сделать к» по дням и напоминания; таймеры и настройки
  1: (doc) => {
    for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
    for (const r of Object.values(doc.c.prepItems)) {
      if (r.deleted) continue;
      if (!Array.isArray(r.times)) r.times = Array(7).fill('');
      if (!Array.isArray(r.reminders)) r.reminders = [];
    }
    return doc;
  },
  // 2 → 3: склад и инвентаризация — места хранения по умолчанию
  2: (doc) => {
    for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
    const seed = seedRecords().locations;
    for (const [id, r] of Object.entries(seed)) if (!doc.c.locations[id]) doc.c.locations[id] = r;
    return doc;
  },
  // 3 → 4: «Срок хранения» у заготовок заменён на «Количество». Если там было просто число и норм нет —
  // переносим его в количество на все дни.
  3: (doc) => {
    for (const r of Object.values(doc.c.prepItems || {})) {
      if (r.deleted) continue;
      const hasNorm = (r.norms || []).some((v) => num(v) > 0);
      if (!hasNorm && /^\s*\d+([.,]\d+)?\s*$/.test(r.shelfLife || '')) {
        r.norms = Array(7).fill(num(r.shelfLife));
        r.shelfLife = '';
      }
    }
    return doc;
  },
  // 4 → 5: партии заготовок (маркировка и сроки) и срок реализации у заготовок
  4: (doc) => {
    for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
    return doc;
  },
  // 5 → 6: чек-листы смены и журнал
  5: (doc) => {
    for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
    return doc;
  },
  // 6 → 7: брутто убрано — у ингредиентов ТТК только нетто и отход (вводится вручную); у идей — ингредиенты
  6: (doc) => {
    for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
    for (const r of Object.values(doc.c.recipes)) {
      if (r.deleted) continue;
      for (const i of r.ingredients || []) {
        delete i.brutto;
        if (i.waste === undefined) i.waste = null;
        if (!i.wasteMode) i.wasteMode = 'abs';
      }
    }
    for (const r of Object.values(doc.c.ideas)) {
      if (r.deleted) continue;
      if (!Array.isArray(r.ingredients)) r.ingredients = [];
    }
    return doc;
  },
  0: (doc) => {
    // «нулевая» версия — документ без поля schema: просто приводим к структуре v1
    const out = emptyDoc();
    for (const k of COLLECTIONS) Object.assign(out.c[k], doc?.c?.[k] || {});
    return out;
  },
};

export function migrate(input) {
  let doc = input && typeof input === 'object' ? input : emptyDoc();
  let v = Number(doc.schema) || 0;
  if (v > SCHEMA_VERSION) {
    // Данные записаны более новой версией приложения — не трогаем
    doc.__newer = true;
    return doc;
  }
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error('Нет миграции со схемы ' + v);
    doc = step(doc);
    v += 1;
    doc.schema = v;
  }
  doc.c = doc.c || {};
  for (const k of COLLECTIONS) doc.c[k] = doc.c[k] || {};
  if (!doc.c.restaurants[OWN_SOURCE_ID]) doc.c.restaurants[OWN_SOURCE_ID] = seedRecords().restaurants[OWN_SOURCE_ID];
  return doc;
}

// ---- Слияние и сериализация -----------------------------------------------------
export function mergeDocs(a, b) {
  const out = { schema: Math.max(a.schema || 0, b.schema || 0), c: {} };
  for (const k of COLLECTIONS) {
    const A = a.c[k] || {}, B = b.c[k] || {};
    const res = { ...A };
    for (const id of Object.keys(B)) {
      if (!res[id] || (B[id].updatedAt || 0) > (res[id].updatedAt || 0)) res[id] = B[id];
    }
    out.c[k] = res;
  }
  return out;
}

// Стабильный JSON (ключи коллекций по порядку) — чтобы хэш одинаковых данных совпадал
export function serialize(doc) {
  const c = {};
  for (const k of COLLECTIONS) {
    const src = doc.c[k] || {};
    const o = {};
    for (const id of Object.keys(src).sort()) o[id] = src[id];
    c[k] = o;
  }
  return JSON.stringify({ schema: doc.schema, c });
}

const TOMBSTONE_TTL = 90 * 864e5;
const PREPLOG_TTL = 21 * 864e5;
function compact(doc) {
  const now = Date.now();
  for (const k of COLLECTIONS) {
    const col = doc.c[k];
    for (const id of Object.keys(col)) {
      const r = col[id];
      if (r.deleted && now - (r.updatedAt || 0) > TOMBSTONE_TTL) delete col[id];
      else if (k === 'prepLog' && now - (r.updatedAt || 0) > PREPLOG_TTL) delete col[id];
      else if (k === 'timers' && r.endsAt && now - r.endsAt > 2 * 864e5) delete col[id];
      else if (k === 'checkLog' && now - (r.updatedAt || 0) > 120 * 864e5) delete col[id];
      else if (k === 'batches' && r.status !== 'active' && now - (r.closedAt || r.updatedAt || 0) > 30 * 864e5) delete col[id];
    }
  }
}

// ---- Хранилище в памяти -------------------------------------------------------------
let doc = emptyDoc();
let meta = { deviceId: '', cloudDh: '', lastSync: 0, srvRev: 0, srvPushAt: 0, srvFull: false };
const listeners = new Set();

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (src) => listeners.forEach((fn) => { try { fn(src); } catch (e) { console.error(e); } });

const saveLocal = debounce(async () => {
  try { await kvSet('doc', doc); } catch (e) { console.error('IDB save', e); }
}, 250);
const saveMeta = () => kvSet('meta', meta).catch(() => {});

export async function loadLocal() {
  let saved = null;
  try { saved = await kvGet('doc'); } catch (e) { console.error(e); }
  try { meta = { ...meta, ...((await kvGet('meta')) || {}) }; } catch (e) { /* нет */ }
  if (!meta.deviceId) { meta.deviceId = uid(); saveMeta(); }
  doc = migrate(saved || emptyDoc());
  compact(doc);
}

export const getDoc = () => doc;

export function list(coll, { withDeleted = false } = {}) {
  const arr = Object.values(doc.c[coll] || {});
  return withDeleted ? arr : arr.filter((r) => !r.deleted);
}
export function get(coll, id) {
  const r = id ? doc.c[coll]?.[id] : null;
  return r && !r.deleted ? r : null;
}

function stamp(prev) { return Math.max(Date.now(), (prev?.updatedAt || 0) + 1); }

function changed(src) {
  saveLocal();
  scheduleSync();
  emit(src || 'local');
}

export function put(coll, rec, { silent = false } = {}) {
  const prev = doc.c[coll][rec.id];
  const r = { ...rec, id: rec.id || uid(), updatedAt: stamp(prev) };
  if (!r.createdAt) r.createdAt = prev?.createdAt || r.updatedAt;
  delete r.deleted;
  doc.c[coll][r.id] = r;
  if (!silent) changed(coll);
  return r;
}

export function remove(coll, id, { silent = false } = {}) {
  const prev = doc.c[coll][id];
  if (!prev) return;
  doc.c[coll][id] = { id, deleted: true, updatedAt: stamp(prev) };
  if (!silent) changed(coll);
}

export function batch(fn) {
  fn();
  changed('batch');
}

// ---- Списки (категории, рестораны, цеха) -------------------------------------
export function sortedList(coll) {
  return list(coll).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'ru'));
}
export function findByName(coll, name) {
  const n = norm(name);
  if (!n) return null;
  return list(coll).find((r) => norm(r.name) === n) || null;
}
export function ensureNamed(coll, name) {
  const found = findByName(coll, name);
  if (found) return found.id;
  const maxOrder = Math.max(0, ...list(coll).map((r) => r.order ?? 0));
  return put(coll, { id: uid(), name: String(name).trim(), order: maxOrder + 1 }, { silent: true }).id;
}
// Значение из выпадающего списка: id или "new:Название" (создать при сохранении)
export function resolveRef(coll, value) {
  if (!value) return '';
  if (value.startsWith('new:')) return ensureNamed(coll, value.slice(4));
  return value;
}
export const nameOf = (coll, id) => get(coll, id)?.name || '';

// ---- Справочник продуктов ---------------------------------------------------------
// Сейчас: название и единица. Поля price/priceUnit/supplier — под будущую себестоимость.
export function ensureProduct(name, unit) {
  const found = findByName('products', name);
  if (found) return found.id;
  return put('products', {
    id: uid(), name: String(name).trim(), unit: unit || '',
    price: null, priceUnit: null, currency: 'RUB', supplier: '', priceUpdatedAt: null,
  }, { silent: true }).id;
}
export function productNames() {
  const set = new Map();
  for (const p of list('products')) set.set(norm(p.name), p.name);
  for (const r of list('recipes')) for (const i of r.ingredients || []) if (i.name) set.set(norm(i.name), i.name);
  return [...set.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

// ---- Синхронизация ----------------------------------------------------------------
// Два облака: облако Telegram (только внутри Telegram, запасная копия) и облако бота (везде, где выполнен вход).
export const sync = {
  mode: 'local',   // 'cloud' (есть облако) | 'local' (только устройство)
  tg: false,       // облако Telegram доступно
  srv: false,      // облако бота доступно (выполнен вход)
  state: 'idle',   // idle | syncing | ok | error | newer | toobig
  error: '',
  lastSync: 0,
  usage: null,
  recovered: false,
};
const syncListeners = new Set();
export const onSync = (fn) => { syncListeners.add(fn); return () => syncListeners.delete(fn); };
const emitSync = () => syncListeners.forEach((fn) => fn(sync));

// Облако бота: адрес и запросы
export const serverUrl = () => (get('settings', 'botUrl')?.value || DEFAULT_BOT).replace(/\/+$/, '');
const srvListeners = { photos: new Set(), logout: new Set() };
export const onServerPhotos = (fn) => srvListeners.photos.add(fn);
export const onLoggedOut = (fn) => srvListeners.logout.add(fn);
export async function srvFetch(path, opts = {}) {
  const r = await fetch(serverUrl() + path, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() } });
  if (r.status === 401) {
    let j = null;
    try { j = await r.clone().json(); } catch (e) { /* нет */ }
    if (j?.error === 'logged_out') { clearSession(); srvListeners.logout.forEach((fn) => fn()); }
  }
  return r;
}
async function srvJson(path, body) {
  const r = await srvFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { /* нет */ }
  if (!r.ok || !j?.ok) { const e = new Error(j?.message || j?.error || `облако ответило ${r.status}`); e.code = j?.error; throw e; }
  return j;
}

let syncing = false, again = false, cloudManifest = null;
const extraPush = new Map(); // записи, пришедшие из облака Telegram, — отправить и в облако бота
const scheduleSync = debounce(() => syncNow(), 1500);
export const flushSync = () => scheduleSync.flush();

function applyDoc(base, src) {
  if (base === doc) return false;
  const before = serialize(doc);
  doc = base;
  compact(doc);
  if (serialize(doc) === before) return false;
  saveLocal();
  emit(src);
  return true;
}

async function syncTelegram() {
  const man = await readManifest();
  let base = doc;
  if (man && man.dh !== meta.cloudDh) {
    // В облаке что-то новее того, что мы видели — подтягиваем и сливаем
    const remote = await readCloud(man);
    if (remote) {
      sync.recovered = remote.recovered;
      const rdoc = migrate(JSON.parse(remote.text));
      if (rdoc.__newer) { doc.__newer = true; return; }
      for (const k of COLLECTIONS) {
        for (const [id, r] of Object.entries(rdoc.c[k] || {})) {
          const cur = doc.c[k][id];
          if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) extraPush.set(k + '\u0000' + id, k);
        }
      }
      base = mergeDocs(doc, rdoc);
    }
  }
  applyDoc(base, 'remote');
  const text = serialize(doc);
  const dh = hash(text);
  if (!man || man.dh !== dh) cloudManifest = await writeCloud(text, man, { dh, dev: meta.deviceId });
  else cloudManifest = man;
  meta.cloudDh = dh;
  try { sync.usage = await cloudUsage(); } catch (e) { /* нет */ }
}

async function syncServer() {
  const full = !meta.srvRev || meta.srvFull;
  const mark = meta.srvPushAt || 0;
  const changes = [];
  let maxU = mark;
  for (const k of COLLECTIONS) {
    for (const [id, r] of Object.entries(doc.c[k])) {
      if (full || (r.updatedAt || 0) > mark || extraPush.has(k + '\u0000' + id)) {
        changes.push({ c: k, r });
        if ((r.updatedAt || 0) > maxU) maxU = r.updatedAt;
      }
    }
  }
  extraPush.clear();
  let since = meta.srvRev || 0, first = true, more = false, photos = null;
  const incoming = [];
  do {
    const res = await srvJson('/api/sync', { since, schema: SCHEMA_VERSION, changes: first ? changes : [] });
    first = false;
    incoming.push(...(res.changes || []));
    since = res.rev; more = !!res.more; photos = res.photos || [];
  } while (more);
  // Применяем пришедшее: по версии схемы — через миграции
  const bySchema = new Map();
  for (const ch of incoming) {
    if (!COLLECTIONS.includes(ch.c) || !ch.r?.id) continue;
    const s = Number(ch.s) || SCHEMA_VERSION;
    if (!bySchema.has(s)) bySchema.set(s, { schema: s, c: {} });
    const d = bySchema.get(s);
    (d.c[ch.c] = d.c[ch.c] || {})[ch.r.id] = ch.r;
  }
  let base = doc;
  for (const part of bySchema.values()) {
    if (part.schema > SCHEMA_VERSION) { doc.__newer = true; return; }
    const m = migrate(part);
    for (const k of COLLECTIONS) {
      // начальные списки из миграций не тащим — только то, что реально пришло
      for (const id of Object.keys(m.c[k])) if (!part.c[k]?.[id]) delete m.c[k][id];
    }
    base = mergeDocs(base, m);
  }
  applyDoc(base, 'remote');
  meta.srvRev = since;
  meta.srvPushAt = Math.max(maxU, meta.srvPushAt || 0);
  meta.srvFull = false;
  srvListeners.photos.forEach((fn) => { try { fn(photos); } catch (e) { console.error(e); } });
}

export async function syncNow() {
  sync.tg = cloudAvailable();
  sync.srv = loggedIn();
  if (!sync.tg && !sync.srv) {
    sync.mode = 'local';
    sync.state = 'idle';
    emitSync();
    return;
  }
  sync.mode = 'cloud';
  if (doc.__newer) { sync.state = 'newer'; emitSync(); return; }
  if (syncing) { again = true; return; }
  syncing = true;
  sync.state = 'syncing';
  emitSync();
  const errors = [];
  try {
    if (sync.tg) {
      try { await syncTelegram(); } catch (e) { console.error('sync tg', e); errors.push(e); }
    }
    if (doc.__newer) { sync.state = 'newer'; return; }
    if (sync.srv) {
      try { await syncServer(); } catch (e) { console.error('sync srv', e); errors.push(e); }
    }
    if (doc.__newer) { sync.state = 'newer'; return; }
    // Хватает одного облака: ошибка второго — не повод пугать
    const okAny = errors.length < (sync.tg ? 1 : 0) + (sync.srv ? 1 : 0);
    if (okAny) {
      meta.lastSync = Date.now();
      sync.lastSync = meta.lastSync;
    }
    saveMeta();
    const bad = errors[0];
    if (!bad) { sync.state = 'ok'; sync.error = ''; }
    else if (okAny && bad.code === 'TOO_BIG') { sync.state = 'ok'; sync.error = ''; }
    else { sync.state = bad.code === 'TOO_BIG' ? 'toobig' : 'error'; sync.error = String(bad.message || bad); }
  } finally {
    syncing = false;
    emitSync();
    if (again) { again = false; scheduleSync(); }
  }
}

export function initSync() {
  sync.lastSync = meta.lastSync || 0;
  sync.tg = cloudAvailable();
  sync.srv = loggedIn();
  sync.mode = sync.tg || sync.srv ? 'cloud' : 'local';
  syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
    else { saveLocal.flush(); scheduleSync.flush(); }
  });
  // Облако бота: подтягивать изменения с других устройств, пока приложение открыто
  setInterval(() => { if (document.visibilityState === 'visible' && loggedIn()) syncNow(); }, 30000);
}
// После входа на новом устройстве — забрать всё из облака и отправить своё
export function resetServerSync() { meta.srvRev = 0; meta.srvPushAt = 0; meta.srvFull = true; saveMeta(); }

// ---- Резервная копия / восстановление / очистка ---------------------------------
export function exportDoc() { return JSON.parse(serialize(doc)); }

// mode: 'merge' — объединить по времени изменения; 'replace' — заменить всё содержимым копии
export function importDoc(incoming, mode) {
  const inc = migrate(clone(incoming));
  if (inc.__newer) throw new Error('Копия сделана более новой версией приложения. Обновите приложение.');
  if (mode === 'replace') {
    const now = Date.now();
    const next = { schema: SCHEMA_VERSION, c: {} };
    for (const k of COLLECTIONS) {
      next.c[k] = {};
      // всё, чего нет в копии, помечаем удалённым (чтобы удалилось и в облаке)
      for (const id of Object.keys(doc.c[k])) next.c[k][id] = { id, deleted: true, updatedAt: Math.max(now, (doc.c[k][id].updatedAt || 0) + 1) };
      for (const [id, r] of Object.entries(inc.c[k])) {
        next.c[k][id] = { ...r, updatedAt: Math.max(now, (doc.c[k][id]?.updatedAt || 0) + 1, (r.updatedAt || 0) + 1) };
      }
    }
    doc = migrate(next);
  } else {
    doc = mergeDocs(doc, inc);
    meta.srvFull = true; saveMeta(); // старые записи из копии — тоже в облако бота
  }
  changed('import');
}

export function wipeAll() {
  const now = Date.now();
  const seed = emptyDoc();
  for (const k of COLLECTIONS) {
    for (const id of Object.keys(doc.c[k])) {
      if (seed.c[k][id]) doc.c[k][id] = { ...seed.c[k][id], updatedAt: Math.max(now, (doc.c[k][id].updatedAt || 0) + 1) };
      else doc.c[k][id] = { id, deleted: true, updatedAt: Math.max(now, (doc.c[k][id].updatedAt || 0) + 1) };
    }
    for (const id of Object.keys(seed.c[k])) if (!doc.c[k][id]) doc.c[k][id] = { ...seed.c[k][id], updatedAt: now };
  }
  changed('wipe');
}
