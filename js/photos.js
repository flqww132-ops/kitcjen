// Фото: сжимаем до ~1280px JPEG и храним в IndexedDB на устройстве + копия в облаке бота (если выполнен вход).

import { photoPut, photoGet, photoDel, photoKeys } from './idb.js';
import { uid } from './util.js';
import { list, srvFetch, onServerPhotos } from './store.js';
import { loggedIn } from './auth.js';

const MAX = 1280;
const QUALITY = 0.8;
const urlCache = new Map();

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
    img.src = url;
  });
}

export async function addPhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', QUALITY));
    const id = 'ph_' + uid();
    await photoPut({ id, blob, w, h, createdAt: Date.now() });
    uploadPhoto(id).catch(() => {}); // не вышло — отправим при следующей синхронизации
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- Облако бота ----
async function uploadPhoto(id) {
  if (!loggedIn()) return;
  const rec = await photoGet(id);
  if (!rec) return;
  const r = await srvFetch('/api/photo/' + encodeURIComponent(id), { method: 'PUT', headers: { 'X-Photo-W': String(rec.w || 0), 'X-Photo-H': String(rec.h || 0) }, body: rec.blob });
  if (!r.ok) throw new Error('upload ' + r.status);
}
const loading = new Map();
function downloadPhoto(id) {
  if (!loggedIn()) return Promise.resolve(null);
  if (!loading.has(id)) {
    loading.set(id, (async () => {
      try {
        const r = await srvFetch('/api/photo/' + encodeURIComponent(id));
        if (!r.ok) return null;
        const blob = await r.blob();
        const rec = { id, blob: new Blob([blob], { type: 'image/jpeg' }), w: Number(r.headers.get('X-Photo-W')) || 0, h: Number(r.headers.get('X-Photo-H')) || 0, createdAt: Date.now() };
        await photoPut(rec);
        return rec;
      } catch (e) { return null; } finally { loading.delete(id); }
    })());
  }
  return loading.get(id);
}
// После синхронизации: отправить в облако фото, которых там ещё нет
let uploading = false;
onServerPhotos(async (onServer) => {
  if (uploading) return;
  uploading = true;
  try {
    const have = new Set(onServer);
    const used = new Set();
    for (const r of list('recipes')) for (const p of r.photos || []) used.add(p.id);
    const keys = await photoKeys();
    for (const id of keys) if (used.has(id) && !have.has(id)) await uploadPhoto(id).catch(() => {});
  } finally { uploading = false; }
});

// Запись фото { blob, w, h }: с устройства, а если нет — из облака
export async function photoRecord(id) {
  return (await photoGet(id).catch(() => null)) || (await downloadPhoto(id));
}

// URL для <img>; null — фото нет ни на устройстве, ни в облаке
export async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const rec = (await photoGet(id).catch(() => null)) || (await downloadPhoto(id));
  const url = rec ? URL.createObjectURL(rec.blob) : null;
  if (url) urlCache.set(id, url); // «нет фото» не запоминаем — оно может появиться после восстановления
  return url;
}

export async function deletePhoto(id) {
  const u = urlCache.get(id);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(id);
  await photoDel(id).catch(() => {});
}

// Подставить картинки во все <img data-photo="id"> внутри элемента
export async function hydratePhotos(root) {
  const imgs = root.querySelectorAll('img[data-photo]');
  for (const img of imgs) {
    const url = await photoURL(img.dataset.photo);
    if (url) img.src = url;
    else img.closest('.ph')?.classList.add('ph-missing');
  }
}

// Убрать фото, на которые больше никто не ссылается (старше суток — чтобы не задеть несохранённые формы)
export async function photoGC() {
  try {
    const used = new Set();
    for (const r of list('recipes')) for (const p of r.photos || []) used.add(p.id);
    const keys = await photoKeys();
    for (const id of keys) {
      const ts = parseInt(String(id).slice(3, 11), 36);
      if (!used.has(id) && Date.now() - ts > 864e5) await deletePhoto(id);
    }
  } catch (e) { /* не критично */ }
}
