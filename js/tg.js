// Обёртка над Telegram WebApp. Вне Телеграма всё работает через запасные варианты.

export const W = window.Telegram?.WebApp || null;
export const inTelegram = !!(W && W.initData);
export const ver = (v) => !!(inTelegram && W.isVersionAtLeast && W.isVersionAtLeast(v));

export function initTelegram() {
  const root = document.documentElement;
  if (!inTelegram) {
    root.classList.add('no-tg');
    return;
  }
  root.classList.add('tg');
  try { W.ready(); } catch (e) { /* нет */ }
  try { W.expand(); } catch (e) { /* нет */ }
  // Не закрывать приложение свайпом вниз
  if (ver('7.7')) try { W.disableVerticalSwipes(); } catch (e) { /* нет */ }
}

export function haptic(kind = 'light') {
  if (!ver('6.1')) return;
  try {
    const H = W.HapticFeedback;
    if (kind === 'success' || kind === 'error' || kind === 'warning') H.notificationOccurred(kind);
    else if (kind === 'select') H.selectionChanged();
    else H.impactOccurred(kind);
  } catch (e) { /* нет */ }
}

// Кнопка «Назад» Телеграма
let backHandler = null;
export function setBack(visible, handler) {
  backHandler = handler;
  if (!ver('6.1')) return;
  if (visible) W.BackButton.show(); else W.BackButton.hide();
}
if (inTelegram && W.BackButton) W.BackButton.onClick(() => backHandler && backHandler());

let closingConfirm = false;
export function setClosingConfirmation(on) {
  if (!ver('6.2') || on === closingConfirm) return;
  closingConfirm = on;
  try { on ? W.enableClosingConfirmation() : W.disableClosingConfirmation(); } catch (e) { /* нет */ }
}

// Нативный попап Телеграма (если есть). Возвращает id кнопки или null.
export function tgPopup({ title, message, buttons }) {
  return new Promise((resolve) => {
    try {
      W.showPopup({ title, message: message.slice(0, 250), buttons }, (id) => resolve(id || null));
    } catch (e) { resolve(undefined); }
  });
}
export const hasTgPopup = () => ver('6.2');

export function openLink(url) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (inTelegram) {
    if (/^https:\/\/t\.me\//i.test(url)) W.openTelegramLink(url);
    else W.openLink(url);
  } else window.open(url, '_blank', 'noopener');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    return ok;
  }
}

// Поделиться текстом в чат Телеграма. Текст заодно копируется — на случай, если не влезет.
export async function shareText(text) {
  const copied = await copyText(text);
  if (inTelegram) {
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(text.slice(0, 3500));
    try { W.openTelegramLink(url); return { shared: true, copied }; } catch (e) { /* дальше */ }
  } else if (navigator.share) {
    try { await navigator.share({ text }); return { shared: true, copied }; } catch (e) { /* отмена */ }
  }
  return { shared: false, copied };
}
