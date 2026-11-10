// Вход и ключ устройства для облака бота.
// В Telegram запросы подписаны самим Telegram (initData). Вне Telegram (приложение на экране «Домой», браузер)
// устройство входит один раз по коду из 6 цифр и получает свой ключ.

import { W, inTelegram } from './tg.js';

export const DEFAULT_BOT = 'https://kniga-kuhni-bot.flqww132.workers.dev';
const LS = 'kb_auth';

export function session() {
  try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; }
}
export function setSession(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) { /* нет */ } }
export function clearSession() { try { localStorage.removeItem(LS); } catch (e) { /* нет */ } }

// Можно ли ходить в облако бота
export const loggedIn = () => !!(inTelegram && W?.initData) || !!session()?.token;
export function authHeaders() {
  if (inTelegram && W?.initData) return { 'X-Init-Data': W.initData };
  const s = session();
  return s?.token ? { Authorization: 'Bearer ' + s.token } : {};
}
export const myName = () => (inTelegram ? W?.initDataUnsafe?.user?.first_name : session()?.name) || '';

// Открыто как приложение с экрана «Домой»
export const standalone = () => !!(window.navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches);

export function deviceName() {
  const ua = navigator.userAgent || '';
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Компьютер (Windows)' : 'Устройство';
  return standalone() ? `${dev} · приложение` : `${dev} · браузер`;
}
