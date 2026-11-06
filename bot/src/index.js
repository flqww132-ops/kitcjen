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

import { DurableObject } from 'cloudflare:workers';

const MAX_ITEMS = 1000;
const MAX_TEXT = 4000;
const MAX_AGE_DAYS = 30;          // сколько дней действительна подпись initData
const STALE_MS = 6 * 3600e3;      // не слать напоминания, опоздавшие больше чем на 6 часов

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
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

async function sendMessage(env, chatId, text) {
  const base = env.TG_API || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true }),
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* нет */ }
  return { ok: r.ok && body?.ok, status: r.status, description: body?.description };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'kniga-kuhni-bot', token: !!env.BOT_TOKEN });
    }
    if (!url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    if (!env.BOT_TOKEN) return json({ ok: false, error: 'no_token', message: 'В Cloudflare не задан секрет BOT_TOKEN' }, 500);

    const auth = await checkInitData(req.headers.get('X-Init-Data'), env.BOT_TOKEN);
    if (!auth) return json({ ok: false, error: 'bad_auth', message: 'Подпись Telegram не подошла. Проверьте, что BOT_TOKEN — ключ именно этого бота.' }, 401);
    if (auth.expired) return json({ ok: false, error: 'expired', message: 'Переоткройте приложение в Telegram' }, 401);
    const userId = auth.user.id;
    if (env.ALLOWED_USERS) {
      const allowed = String(env.ALLOWED_USERS).split(/[\s,]+/).filter(Boolean);
      if (!allowed.includes(String(userId))) return json({ ok: false, error: 'forbidden' }, 403);
    }
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName(String(userId)));

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
    if (url.pathname === '/api/test' && req.method === 'POST') {
      const r = await sendMessage(env, userId, '✅ Бот-напоминальщик «Книги кухни» работает. Напоминания и таймеры будут приходить сюда.');
      return json(r.ok ? { ok: true } : { ok: false, error: 'telegram', message: r.description || `Telegram ответил ${r.status}. Нажмите /start в чате с ботом.` }, r.ok ? 200 : 502);
    }
    return json({ ok: false, error: 'not_found' }, 404);
  },
};

// Будильник одного пользователя
export class Scheduler extends DurableObject {
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
