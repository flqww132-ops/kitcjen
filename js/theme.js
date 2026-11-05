// Оформление: свои цвета приложения (не зависят от темы Telegram).
// Режим хранится на устройстве: 'light' | 'dark' | 'auto' (как на телефоне).

import { W, ver } from './tg.js';
import { lsGet, lsSet } from './util.js';

const COLORS = {
  light: { header: '#FBEFE3', bg: '#F7F1EA' },
  dark: { header: '#16110E', bg: '#100C0A' },
};
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export const getThemeMode = () => lsGet('kb_theme') || 'light';
const resolved = (mode) => (mode === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : mode);

export function applyTheme(mode = getThemeMode()) {
  const t = resolved(mode);
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.classList.toggle('light', t === 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[t].header);
  if (ver('6.9')) {
    try {
      W.setHeaderColor(COLORS[t].header);
      W.setBackgroundColor(COLORS[t].bg);
      if (ver('7.10')) W.setBottomBarColor?.(COLORS[t].bg);
    } catch (e) { /* нет */ }
  }
}

export function setThemeMode(mode) {
  lsSet('kb_theme', mode);
  applyTheme(mode);
}

mq?.addEventListener?.('change', () => { if (getThemeMode() === 'auto') applyTheme(); });
