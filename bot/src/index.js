// Бот-напоминальщик «Книги кухни».
//
// Приложение присылает сюда список будущих сообщений (напоминания о заготовках и таймеры),
// а бот в нужную секунду отправляет их пользователю в чат Telegram.
// У каждого пользователя свой «будильник» (Durable Object) с точным таймером (alarm).
//
// Запросы подписаны данными Telegram (initData) — бот проверяет подпись своим ключом,
// поэтому чужие запросы и подделки не пройдут.
//
// Секреты/переменные Cloudflare:
//   BOT_TOKEN      — ключ бота от @BotFather (обязательно, секрет)
//   ALLOWED_USERS  — необязательно: id пользователей Telegram через запятую, кому можно пользоваться ботом
//   TG_API         — необязательно, для проверки: другой адрес Bot API
//   APP_URL        — необязательно: адрес приложения (по умолчанию GitHub Pages)
//
// Облако (2.0): у каждого пользователя в его «будильнике» (Durable Object, SQLite) хранится копия всех
// данных приложения (записи) и фото. Приложение в Telegram и приложение на экране телефона синхронизируются
// через /api/sync. Вне Telegram вход — по коду из 6 цифр, который выдаётся в Telegram (/api/login-code),
// после ввода кода устройство получает ключ (хранится у нас только его хэш, можно отозвать).
//
// Новые версии: раз в 5 минут (cron) бот читает CHANGELOG.md на сайте приложения. Когда там появилась
// новая версия (и сайт уже обновился), всем, кто подключал бота, приходит сообщение «что нового».

import { DurableObject } from 'cloudflare:workers';

const MAX_ITEMS = 1000;
const MAX_TEXT = 4000;
const MAX_AGE_DAYS = 30;          // сколько дней действительна подпись initData
const STALE_MS = 6 * 3600e3;      // не слать напоминания, опоздавшие больше чем на 6 часов
const DEFAULT_APP_URL = 'https://flqww132-ops.github.io/kitcjen/';
const appUrl = (env) => { const u = String(env.APP_URL || DEFAULT_APP_URL); return u.endsWith('/') ? u : u + '/'; };
const registry = (env) => env.SCHEDULER.get(env.SCHEDULER.idFromName('__registry'));
const userStub = (env, userId) => env.SCHEDULER.get(env.SCHEDULER.idFromName(String(userId)));

const DATA_QUOTA = 50 * 1024 * 1024;     // записи одного пользователя
const PHOTO_QUOTA = 500 * 1024 * 1024;   // фото одного пользователя
const PHOTO_MAX = 2 * 1024 * 1024 - 1024; // одно фото (ограничение SQLite в Durable Object — 2 МБ)
const CODE_TTL = 10 * 60e3;
const SYNC_PAGE = 3000;

const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
function randCode() {
  const a = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(a).padStart(6, '0');
}

// Кто делает запрос: подпись Telegram (X-Init-Data) или ключ устройства (Authorization: Bearer kb1.<userId>.<секрет>)
async function authenticate(req, env) {
  const initData = req.headers.get('X-Init-Data');
  if (initData) {
    const a = await checkInitData(initData, env.BOT_TOKEN);
    if (!a) return { error: json({ ok: false, error: 'bad_auth', message: 'Подпись Telegram не подошла. Проверьте, что BOT_TOKEN — ключ именно этого бота.' }, 401) };
    if (a.expired) return { error: json({ ok: false, error: 'expired', message: 'Переоткройте приложение в Telegram' }, 401) };
    return { userId: a.user.id, name: a.user.first_name || '', via: 'tg' };
  }
  const m = /^Bearer\s+(kb1\.(\d+)\.[0-9a-f]{64})$/.exec(req.headers.get('Authorization') || '');
  if (m) {
    const s = await userStub(env, m[2]).checkToken(await sha256(m[1]));
    if (s) return { userId: Number(m[2]), name: s.name || '', via: 'token', session: s.id };
    return { error: json({ ok: false, error: 'logged_out', message: 'Вход на этом устройстве отменён. Войдите снова по коду из Telegram.' }, 401) };
  }
  return { error: json({ ok: false, error: 'bad_auth', message: 'Нужен вход' }, 401) };
}
const allowedUser = (env, userId) => !env.ALLOWED_USERS || String(env.ALLOWED_USERS).split(/[\s,]+/).filter(Boolean).includes(String(userId));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data, Authorization, X-Photo-W, X-Photo-H',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Проверка подписи Telegram Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export async function checkInitData(initData, token) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', token);
  const sig = hex(await hmac(secret, dcs));
  if (!safeEqual(sig, hash)) return null;
  const authDate = Number(p.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_DAYS * 86400) return { expired: true };
  let user;
  try { user = JSON.parse(p.get('user') || 'null'); } catch (e) { user = null; }
  if (!user || !user.id) return null;
  return { user };
}

async function sendDocument(env, chatId, file, filename, caption) {
  const base = env.TG_API || 'https://api.telegram.org';
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  fd.append('document', file, filename);
  const r = await fetch(`${base}/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
  let body = null;
  try { body = await r.json(); } catch (e) { /* нет */ }
  return { ok: r.ok && body?.ok, status: r.status, description: body?.description };
}

async function sendMessage(env, chatId, text, extra = {}) {
  const base = env.TG_API || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true, ...extra }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* нет */ }
  return { ok: r.ok && body?.ok, status: r.status, description: body?.description };
}

// Последняя версия из CHANGELOG.md: { version, items: [строки] } — только если сайт уже на этой версии
export async function latestRelease(env) {
  const base = appUrl(env);
  const t = Date.now();
  const [cl, idx] = await Promise.all([
    fetch(`${base}CHANGELOG.md?t=${t}`, { cf: { cacheTtl: 0 } }).then((r) => (r.ok ? r.text() : '')),
    fetch(`${base}index.html?t=${t}`, { cf: { cacheTtl: 0 } }).then((r) => (r.ok ? r.text() : '')),
  ]);
  const m = /^##\s+(\d+\.\d+\.\d+)\s*$/m.exec(cl);
  if (!m) return null;
  const version = m[1];
  if (!idx.includes(`?v=${version}`)) return null; // сайт ещё не обновился
  const rest = cl.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  const items = (end >= 0 ? rest.slice(0, end) : rest).split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ''));
  return { version, items };
}

export function releaseText({ version, items }) {
  let text = `🆕 Книга кухни обновилась до версии ${version}\n\nЧто изменилось:\n${items.map((i) => '• ' + i).join('\n')}`;
  text += '\n\nЕсли приложение было открыто — закройте его и откройте снова.';
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 2) + '…' : text;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.BOT_TOKEN) return;
    ctx.waitUntil(registry(env).releaseTick());
  },

  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'kniga-kuhni-bot', token: !!env.BOT_TOKEN });
    }
    if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    if (!env.BOT_TOKEN) return json({ ok: false, error: 'no_token', message: 'В Cloudflare не задан секрет BOT_TOKEN' }, 500);

    // Вход по коду — без подписи (код и есть подтверждение)
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
      const code = String(body?.code || '').replace(/\D/g, '');
      if (code.length !== 6) return json({ ok: false, error: 'bad_code', message: 'Код — 6 цифр' }, 400);
      const r = await registry(env).useCode(code);
      if (!r.ok) return json(r, r.error === 'locked' ? 429 : 400);
      if (!allowedUser(env, r.u)) return json({ ok: false, error: 'forbidden' }, 403);
      const sess = await userStub(env, r.u).createSession(String(body?.device || 'Устройство').slice(0, 80), r.name || '');
      return json({ ok: true, token: sess.token, userId: r.u, name: r.name || '' });
    }

    const auth = await authenticate(req, env);
    if (auth.error) return auth.error;
    const userId = auth.userId;
    if (!allowedUser(env, userId)) return json({ ok: false, error: 'forbidden' }, 403);
    const stub = userStub(env, userId);
    // Запоминаем, кому слать сообщения о новых версиях
    ctx.waitUntil(registry(env).register(userId).catch(() => {}));

    if (url.pathname === '/api/reminders' && req.method === 'PUT') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items) return json({ ok: false, error: 'bad_items' }, 400);
      if (items.length > MAX_ITEMS) return json({ ok: false, error: 'too_many', message: `Не больше ${MAX_ITEMS} напоминаний` }, 400);
      const clean = [];
      for (const it of items) {
        const at = Number(it?.at);
        const text = String(it?.text || '').slice(0, MAX_TEXT);
        if (!isFinite(at) || !text) continue;
        clean.push({ at, text, key: String(it?.key || '').slice(0, 200) });
      }
      return json(await stub.setItems(userId, clean));
    }
    if (url.pathname === '/api/status') return json(await stub.status());
    if (url.pathname === '/api/me') return json({ ok: true, userId, name: auth.name, via: auth.via });

    // ---- Вход на других устройствах ----
    if (url.pathname === '/api/login-code' && req.method === 'POST') {
      if (auth.via !== 'tg') return json({ ok: false, error: 'tg_only', message: 'Код выдаётся только в Telegram' }, 403);
      return json(await registry(env).newCode(userId, auth.name));
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') return json(await stub.listSessions(auth.session || null));
    if (url.pathname === '/api/sessions/revoke' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { body = {}; }
      return json(await stub.revokeSession(String(body?.id || auth.session || '')));
    }

    // ---- Облако: записи и фото ----
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
      const r = await stub.sync(body);
      return json(r, r.ok ? 200 : 400);
    }
    const pm = /^\/api\/photo\/(ph_[A-Za-z0-9_-]{1,60})$/.exec(url.pathname);
    if (pm && req.method === 'PUT') {
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > PHOTO_MAX) return json({ ok: false, error: 'bad_size', message: 'Фото слишком большое' }, 400);
      const r = await stub.putPhoto(pm[1], Number(req.headers.get('X-Photo-W')) || 0, Number(req.headers.get('X-Photo-H')) || 0, buf);
      return json(r, r.ok ? 200 : 400);
    }
    if (pm && req.method === 'GET') {
      const p = await stub.getPhoto(pm[1]);
      if (!p) return json({ ok: false, error: 'not_found' }, 404);
      return new Response(p.data, { headers: { 'Content-Type': 'image/jpeg', 'X-Photo-W': String(p.w), 'X-Photo-H': String(p.h), 'Cache-Control': 'private, max-age=31536000', 'Access-Control-Expose-Headers': 'X-Photo-W, X-Photo-H', ...CORS } });
    }
    // Отправить текст сразу (например, «План на сегодня» по кнопке)
    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
      const text = String(body?.text || '').trim();
      if (!text) return json({ ok: false, error: 'empty' }, 400);
      const parts = [];
      for (let i = 0; i < text.length && parts.length < 5; i += MAX_TEXT) parts.push(text.slice(i, i + MAX_TEXT));
      for (const p of parts) {
        const r = await sendMessage(env, userId, p);
        if (!r.ok) return json({ ok: false, error: 'telegram', message: r.description || `Telegram ответил ${r.status}` }, 502);
      }
      return json({ ok: true });
    }
    // Отправить файл в чат (резервная копия, Excel, PDF). multipart/form-data: file, caption
    if (url.pathname === '/api/send-file' && req.method === 'POST') {
      let fd;
      try { fd = await req.formData(); } catch (e) { return json({ ok: false, error: 'bad_form' }, 400); }
      const file = fd.get('file');
      if (!file || typeof file === 'string') return json({ ok: false, error: 'no_file' }, 400);
      if (file.size > 49 * 1024 * 1024) return json({ ok: false, error: 'too_big', message: 'Файл больше 50 МБ — Telegram такой не примет' }, 400);
      const r = await sendDocument(env, userId, file, String(fd.get('filename') || file.name || 'file'), fd.get('caption') || '');
      return json(r.ok ? { ok: true } : { ok: false, error: 'telegram', message: r.description || `Telegram ответил ${r.status}` }, r.ok ? 200 : 502);
    }
    // Для проверки: прислать себе сообщение о текущей версии
    if (url.pathname === '/api/release-preview' && req.method === 'POST') {
      const rel = await latestRelease(env);
      if (!rel) return json({ ok: false, error: 'no_release' }, 404);
      const r = await sendMessage(env, userId, releaseText(rel), openButton(env));
      return json(r.ok ? { ok: true, version: rel.version } : { ok: false, error: 'telegram', message: r.description }, r.ok ? 200 : 502);
    }
    if (url.pathname === '/api/test' && req.method === 'POST') {
      const r = await sendMessage(env, userId, '✅ Бот-напоминальщик «Книги кухни» работает. Напоминания и таймеры будут приходить сюда.');
      return json(r.ok ? { ok: true } : { ok: false, error: 'telegram', message: r.description || `Telegram ответил ${r.status}. Нажмите /start в чате с ботом.` }, r.ok ? 200 : 502);
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};

const openButton = (env) => ({ reply_markup: { inline_keyboard: [[{ text: '📖 Открыть Книгу кухни', web_app: { url: appUrl(env) } }]] } });

// Будильник одного пользователя. Отдельный экземпляр «__registry» хранит список пользователей
// и какую версию каждому уже отправили.
export class Scheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS recs (coll TEXT NOT NULL, id TEXT NOT NULL, upd INTEGER NOT NULL, rev INTEGER NOT NULL, s INTEGER, j TEXT NOT NULL, PRIMARY KEY (coll, id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS recs_rev ON recs (rev)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, w INTEGER, h INTEGER, size INTEGER, at INTEGER, data BLOB)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, hash TEXT NOT NULL, device TEXT, name TEXT, created INTEGER, last INTEGER)`);
  }

  // ---- Ключи устройств ----
  async createSession(device, name) {
    const id = randHex(8);
    const secret = randHex(32);
    const userId = await this.ctx.storage.get('uid');
    const full = `kb1.${userId}.${secret}`;
    const now = Date.now();
    this.sql.exec('INSERT INTO sessions (id, hash, device, name, created, last) VALUES (?, ?, ?, ?, ?, ?)', id, await sha256(full), device, name, now, now);
    return { token: full, id };
  }
  async setUid(uid) { if ((await this.ctx.storage.get('uid')) !== uid) await this.ctx.storage.put('uid', uid); }
  async checkToken(hash) {
    const row = this.sql.exec('SELECT id, name, last FROM sessions WHERE hash = ?', hash).toArray()[0];
    if (!row) return null;
    if (Date.now() - row.last > 3600e3) this.sql.exec('UPDATE sessions SET last = ? WHERE id = ?', Date.now(), row.id);
    return { id: row.id, name: row.name };
  }
  async listSessions(current) {
    const rows = this.sql.exec('SELECT id, device, created, last FROM sessions ORDER BY last DESC').toArray();
    return { ok: true, sessions: rows.map((r) => ({ ...r, current: r.id === current })) };
  }
  async revokeSession(id) {
    this.sql.exec('DELETE FROM sessions WHERE id = ?', id);
    return { ok: true };
  }

  // ---- Записи: слияние «побеждает более новая» ----
  async sync(body) {
    const since = Math.max(0, Number(body?.since) || 0);
    const schema = Math.max(0, Number(body?.schema) || 0);
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    let rev = this.sql.exec('SELECT COALESCE(MAX(rev), 0) AS r FROM recs').one().r;
    if (changes.length) {
      const used = this.sql.exec('SELECT COALESCE(SUM(LENGTH(j)), 0) AS n FROM recs').one().n;
      let add = 0;
      for (const ch of changes) add += JSON.stringify(ch?.r || '').length;
      if (used + add > DATA_QUOTA) return { ok: false, error: 'quota', message: 'В облаке закончилось место для данных' };
    }
    const mine = new Set();
    for (const ch of changes) {
      const coll = String(ch?.c || ''), r = ch?.r;
      if (!/^[A-Za-z]{1,40}$/.test(coll) || !r || typeof r !== 'object') continue;
      const id = String(r.id || '');
      const upd = Number(r.updatedAt) || 0;
      if (!id || id.length > 200) continue;
      const j = JSON.stringify(r);
      if (j.length > 1024 * 1024) continue;
      const cur = this.sql.exec('SELECT upd FROM recs WHERE coll = ? AND id = ?', coll, id).toArray()[0];
      if (cur && cur.upd >= upd) continue;
      rev += 1;
      this.sql.exec('INSERT OR REPLACE INTO recs (coll, id, upd, rev, s, j) VALUES (?, ?, ?, ?, ?, ?)', coll, id, upd, rev, schema, j);
      mine.add(rev);
    }
    const rows = this.sql.exec('SELECT coll, rev, s, j FROM recs WHERE rev > ? ORDER BY rev LIMIT ?', since, SYNC_PAGE + 1).toArray();
    const more = rows.length > SYNC_PAGE;
    const page = more ? rows.slice(0, SYNC_PAGE) : rows;
    const last = more ? page[page.length - 1].rev : rev;
    const out = page.filter((row) => !mine.has(row.rev)).map((row) => ({ c: row.coll, s: row.s, r: JSON.parse(row.j) }));
    const photos = this.sql.exec('SELECT id FROM photos').toArray().map((x) => x.id);
    await this.photoGC();
    return { ok: true, rev: last, more, changes: out, photos };
  }

  // ---- Фото ----
  async putPhoto(id, w, h, buf) {
    const used = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM photos').one().n;
    if (used + buf.byteLength > PHOTO_QUOTA) return { ok: false, error: 'quota', message: 'В облаке закончилось место для фото' };
    this.sql.exec('INSERT OR REPLACE INTO photos (id, w, h, size, at, data) VALUES (?, ?, ?, ?, ?, ?)', id, w, h, buf.byteLength, Date.now(), buf);
    return { ok: true };
  }
  async getPhoto(id) {
    const row = this.sql.exec('SELECT w, h, data FROM photos WHERE id = ?', id).toArray()[0];
    return row ? { w: row.w, h: row.h, data: row.data } : null;
  }
  // Раз в сутки: убрать фото, на которые не ссылается ни одна ТТК (и которым больше 2 суток)
  async photoGC() {
    const last = (await this.ctx.storage.get('photoGC')) || 0;
    if (Date.now() - last < 864e5) return;
    await this.ctx.storage.put('photoGC', Date.now());
    const used = new Set();
    for (const row of this.sql.exec("SELECT j FROM recs WHERE coll = 'recipes'").toArray()) {
      try { for (const p of JSON.parse(row.j).photos || []) used.add(p.id); } catch (e) { /* нет */ }
    }
    for (const row of this.sql.exec('SELECT id, at FROM photos').toArray()) {
      if (!used.has(row.id) && Date.now() - row.at > 2 * 864e5) this.sql.exec('DELETE FROM photos WHERE id = ?', row.id);
    }
  }

  // ---- Реестр (экземпляр «__registry»): коды входа ----
  async newCode(userId, name) {
    const codes = (await this.ctx.storage.get('codes')) || {};
    const now = Date.now();
    for (const [c, v] of Object.entries(codes)) if (v.exp < now || v.u === userId) delete codes[c];
    let code;
    do { code = randCode(); } while (codes[code]);
    codes[code] = { u: userId, name, exp: now + CODE_TTL };
    await this.ctx.storage.put('codes', codes);
    await userStub(this.env, userId).setUid(userId);
    return { ok: true, code, exp: codes[code].exp };
  }
  async useCode(code) {
    const now = Date.now();
    let fails = (await this.ctx.storage.get('fails')) || { n: 0, since: now };
    if (now - fails.since > CODE_TTL) fails = { n: 0, since: now };
    if (fails.n >= 30) return { ok: false, error: 'locked', message: 'Слишком много неверных кодов. Подождите 10 минут.' };
    const codes = (await this.ctx.storage.get('codes')) || {};
    const v = codes[code];
    if (!v || v.exp < now) {
      fails.n += 1;
      await this.ctx.storage.put('fails', fails);
      return { ok: false, error: 'bad_code', message: 'Неверный или устаревший код. Получите новый в Telegram.' };
    }
    delete codes[code];
    await this.ctx.storage.put('codes', codes);
    return { ok: true, u: v.u, name: v.name };
  }

  async register(chatId) {
    const users = (await this.ctx.storage.get('users')) || {};
    if (String(chatId) in users) return { ok: true };
    users[String(chatId)] = { since: Date.now(), sent: null };
    await this.ctx.storage.put('users', users);
    return { ok: true, new: true };
  }

  async releaseTick() {
    const users = (await this.ctx.storage.get('users')) || {};
    const ids = Object.keys(users);
    if (!ids.length) return { ok: true, sent: 0 };
    const rel = await latestRelease(this.env).catch(() => null);
    if (!rel) return { ok: true, sent: 0 };
    let sent = 0, changed = false;
    for (const id of ids) {
      if (users[id].sent === rel.version) continue;
      try {
        const r = await sendMessage(this.env, Number(id), releaseText(rel), openButton(this.env));
        if (r.ok) { users[id].sent = rel.version; sent++; changed = true; }
        else if (r.status === 403) { delete users[id]; changed = true; } // бот заблокирован
      } catch (e) { /* сеть — попробуем через 5 минут */ }
    }
    if (changed) await this.ctx.storage.put('users', users);
    return { ok: true, sent, version: rel.version };
  }

  async setItems(chatId, items) {
    const now = Date.now();
    const future = items.filter((i) => i.at > now - 1000).sort((a, b) => a.at - b.at);
    await this.ctx.storage.put('chat', chatId);
    await this.ctx.storage.put('items', future);
    await this.reschedule(future);
    return { ok: true, count: future.length, next: future[0]?.at || null };
  }

  async status() {
    const items = (await this.ctx.storage.get('items')) || [];
    return { ok: true, count: items.length, next: items[0]?.at || null, lastSent: (await this.ctx.storage.get('lastSent')) || null };
  }

  async reschedule(items) {
    if (items.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, items[0].at));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const chatId = await this.ctx.storage.get('chat');
    const items = (await this.ctx.storage.get('items')) || [];
    const now = Date.now();
    const due = items.filter((i) => i.at <= now + 300);
    const rest = items.filter((i) => i.at > now + 300);
    for (const d of due) {
      if (now - d.at > STALE_MS) continue;
      try {
        const r = await sendMessage(this.env, chatId, d.text);
        if (r.ok) await this.ctx.storage.put('lastSent', { at: now, key: d.key });
      } catch (e) { /* сеть: следующее напоминание всё равно запланируем */ }
    }
    await this.ctx.storage.put('items', rest);
    await this.reschedule(rest);
  }
}
