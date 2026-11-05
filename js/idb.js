// Локальное хранилище на устройстве (IndexedDB): копия данных и фото.

const DB_NAME = 'kitchen-book';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('abort'));
  });
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k));

export const photoPut = (rec) => tx('photos', 'readwrite', (s) => s.put(rec));
export const photoGet = (id) => tx('photos', 'readonly', (s) => s.get(id));
export const photoDel = (id) => tx('photos', 'readwrite', (s) => s.delete(id));
export const photoKeys = () => tx('photos', 'readonly', (s) => s.getAllKeys());
export const photoAll = () => tx('photos', 'readonly', (s) => s.getAll());
export const photoClear = () => tx('photos', 'readwrite', (s) => s.clear());

export async function requestPersist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (e) { /* нет */ }
}
