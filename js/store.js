// Данные приложения: схема, миграции, слияние, сохранение и синхронизация.
//
// Документ: { schema, c: { <коллекция>: { <id>: запись } } }
// Каждая запись: { id, updatedAt, deleted?, ... }. Удаление = «надгробие» { id, deleted: true, updatedAt },
// чтобы удаление тоже доезжало до других устройств. Слияние — по каждой записи: побеждает более новая.

import { kvGet, kvSet } from './idb.js';
import { cloudAvailable, readManifest, readCloud, writeCloud, cloudUsage } from './cloud.js';
import { uid, hash, norm, debounce, clone } from './util.js';

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '1.0.0';

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
];

export const OWN_SOURCE_ID = 'own'; // «Своя разработка» — всегда есть

const SEED = {
  categories: ['Закуски', 'Салаты', 'Супы', 'Горячее', 'Гарниры', 'Соусы', 'Десерты', 'Выпечка', 'Заготовки', 'Напитки'],
  stations: ['Холодный цех', 'Горячий цех', 'Кондитерский цех', 'Заготовочный цех'],
};

// Начальные записи с постоянными id и очень старой датой — чтобы два устройства не плодили дубли,
// а любое изменение пользователя всегда «побеждало».
function seedRecords() {
  const out = { categories: {}, stations: {}, restaurants: {} };
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
// Ключ — версия, ИЗ которой мигрируем. Пример на будущее:
//   1: (doc) => { for (const r of Object.values(doc.c.recipes)) r.costPerPortion ??= null; return doc; }
const MIGRATIONS = {
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
    }
  }
}

// ---- Хранилище в памяти -------------------------------------------------------------
let doc = emptyDoc();
let meta = { deviceId: '', cloudDh: '', lastSync: 0 };
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

// ---- Синхронизация с облаком Telegram ------------------------------------------
export const sync = {
  mode: 'local',   // 'cloud' | 'local'
  state: 'idle',   // idle | syncing | ok | error | newer | toobig
  error: '',
  lastSync: 0,
  usage: null,
  recovered: false,
};
const syncListeners = new Set();
export const onSync = (fn) => { syncListeners.add(fn); return () => syncListeners.delete(fn); };
const emitSync = () => syncListeners.forEach((fn) => fn(sync));

let syncing = false, again = false, cloudManifest = null;
const scheduleSync = debounce(() => syncNow(), 1500);
export const flushSync = () => scheduleSync.flush();

export async function syncNow() {
  if (!cloudAvailable()) {
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
  try {
    const man = await readManifest();
    let base = doc;
    if (man && man.dh !== meta.cloudDh) {
      // В облаке что-то новее того, что мы видели — подтягиваем и сливаем
      const remote = await readCloud(man);
      if (remote) {
        sync.recovered = remote.recovered;
        const rdoc = migrate(JSON.parse(remote.text));
        if (rdoc.__newer) { doc.__newer = true; sync.state = 'newer'; return; }
        base = mergeDocs(doc, rdoc);
      }
    }
    if (base !== doc) {
      const before = serialize(doc);
      doc = base;
      compact(doc);
      if (serialize(doc) !== before) { saveLocal(); emit('remote'); }
    }
    const text = serialize(doc);
    const dh = hash(text);
    if (!man || man.dh !== dh) {
      cloudManifest = await writeCloud(text, man, { dh, dev: meta.deviceId });
    } else cloudManifest = man;
    meta.cloudDh = dh;
    meta.lastSync = Date.now();
    saveMeta();
    sync.lastSync = meta.lastSync;
    sync.state = 'ok';
    sync.error = '';
    try { sync.usage = await cloudUsage(); } catch (e) { /* нет */ }
  } catch (e) {
    console.error('sync', e);
    sync.state = e.code === 'TOO_BIG' ? 'toobig' : 'error';
    sync.error = String(e.message || e);
  } finally {
    syncing = false;
    emitSync();
    if (again) { again = false; scheduleSync(); }
  }
}

export function initSync() {
  sync.lastSync = meta.lastSync || 0;
  sync.mode = cloudAvailable() ? 'cloud' : 'local';
  syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
    else { saveLocal.flush(); scheduleSync.flush(); }
  });
}

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
