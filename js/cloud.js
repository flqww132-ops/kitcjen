// Telegram CloudStorage с разбиением на куски.
//
// Лимиты Телеграма: значение до 4096 символов, до 1024 ключей на пользователя.
// Схема записи (защита от обрыва):
//   kb_m        — «оглавление»: какой слот актуален, сколько в нём кусков, длина и хэш;
//   kb_a0..aN   — слот A, kb_b0..bN — слот B.
// Новая версия пишется в НЕактивный слот, и только после записи всех кусков
// обновляется оглавление (одна запись — атомарно). Если запись оборвалась,
// оглавление по-прежнему указывает на старый целый слот. В оглавлении хранится и
// предыдущий слот — если текущий вдруг повреждён, читаем предыдущий.

import { W, ver, inTelegram } from './tg.js';
import { hash } from './util.js';

const P = 'kb_';
const MAN = P + 'm';
const CHUNK = 4000;
const MAX_KEYS = 1024;
const RESERVED = 8; // запас ключей

export const cloudAvailable = () => !!(inTelegram && ver('6.9') && W.CloudStorage);

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      W.CloudStorage[method](...args, (err, res) => (err ? reject(new Error(String(err))) : resolve(res)));
    } catch (e) { reject(e); }
  });
}

async function getMany(keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += 25) {
    Object.assign(out, await call('getItems', keys.slice(i, i + 25)));
  }
  return out;
}

async function setMany(entries, conc = 4) {
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [k, v] = entries[i++];
      let tries = 0;
      for (;;) {
        try { await call('setItem', k, v); break; } catch (e) {
          if (++tries >= 3) throw e;
          await new Promise((r) => setTimeout(r, 400 * tries));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length) }, worker));
}

// Сжатие (если устройство умеет) — помещается в несколько раз больше данных
const canZip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function zip(text) {
  const st = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return b64encode(new Uint8Array(await new Response(st).arrayBuffer()));
}
async function unzip(b64) {
  if (!canZip) throw new Error('NO_DECOMPRESS');
  const st = new Blob([b64decode(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(st).text();
}

export async function readManifest() {
  const s = await call('getItem', MAN);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function readSlot(info) {
  const keys = Array.from({ length: info.n }, (_, i) => P + info.slot + i);
  const vals = await getMany(keys);
  const joined = keys.map((k) => vals[k] || '').join('');
  if (joined.length !== info.len || hash(joined) !== info.hash) throw new Error('CORRUPT');
  return info.z ? unzip(joined) : joined;
}

// → { text, manifest, recovered } или null, если облако пустое
export async function readCloud(manifest) {
  const m = manifest || (await readManifest());
  if (!m || !m.cur) return null;
  try {
    return { text: await readSlot(m.cur), manifest: m, recovered: false };
  } catch (e) {
    if (m.prev) return { text: await readSlot(m.prev), manifest: m, recovered: true };
    throw e;
  }
}

// Записать текст. prev — текущее оглавление из облака (или null).
export async function writeCloud(text, prev, meta = {}) {
  const z = canZip;
  const payload = z ? await zip(text) : text;
  const n = Math.max(1, Math.ceil(payload.length / CHUNK));
  const cur = prev?.cur || null;
  const slot = cur?.slot === 'a' ? 'b' : 'a';
  const busy = cur ? cur.n : 0;
  if (n + busy + 1 + RESERVED > MAX_KEYS) {
    const err = new Error('TOO_BIG');
    err.code = 'TOO_BIG';
    throw err;
  }
  const entries = [];
  for (let i = 0; i < n; i++) entries.push([P + slot + i, payload.slice(i * CHUNK, (i + 1) * CHUNK)]);
  await setMany(entries);
  const info = { slot, n, len: payload.length, hash: hash(payload), z: z ? 1 : 0 };
  const man = { v: 1, cur: info, prev: cur, dh: meta.dh || hash(text), t: Date.now(), dev: meta.dev || '' };
  await call('setItem', MAN, JSON.stringify(man));
  // Уборка лишних старых кусков в этом слоте (не критично)
  try {
    const keys = await call('getKeys');
    const re = new RegExp('^' + P + slot + '(\\d+)$');
    const stale = keys.filter((k) => { const m = k.match(re); return m && +m[1] >= n; });
    if (stale.length) await call('removeItems', stale);
  } catch (e) { /* не страшно */ }
  return man;
}

export async function cloudUsage() {
  const keys = await call('getKeys');
  return { keys: keys.length, max: MAX_KEYS };
}

export async function cloudWipe() {
  const keys = (await call('getKeys')).filter((k) => k.startsWith(P));
  for (let i = 0; i < keys.length; i += 50) await call('removeItems', keys.slice(i, i + 50));
}
