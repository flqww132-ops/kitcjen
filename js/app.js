// Точка входа «Книги кухни»

import { initTelegram, inTelegram } from './tg.js';
import { session, standalone } from './auth.js';
import { showLoginScreen } from './views/login.js';
import { applyTheme } from './theme.js';
import * as S from './store.js';
import { registerTab, setTab, initNav, top, refresh, toast, getTab } from './ui.js';
import { requestPersist } from './idb.js';
import { photoGC } from './photos.js';
import { recipesList } from './views/ttk.js';
import { ideasList } from './views/ideas.js';
import { shiftScreen } from './views/shift.js';
import { ttkState } from './views/ttk.js';
import { prepScreen } from './views/prep.js';
import { settingsScreen } from './views/settings.js';
import { stockScreen } from './views/inventory.js';
import { initReminders, onRemState } from './reminders.js';
import './batches.js';
import { initSwipeBack } from './swipe.js';
import { wipeLegacyPrep, cleanupOldOnce } from './prepcore.js';

function syncDot() {
  const el = document.getElementById('syncDot');
  if (!el) return;
  const s = S.sync;
  const st = s.mode === 'local' ? 'local' : s.state;
  el.className = 'sync-dot ' + st;
  el.title = {
    local: 'Только на устройстве', syncing: 'Синхронизация…', ok: 'Синхронизировано',
    error: 'Ошибка синхронизации', newer: 'Нужно обновить приложение', toobig: 'Облако переполнено', idle: '',
  }[st] || '';
}

async function main() {
  initTelegram();
  applyTheme();
  await S.loadLocal();
  if (standalone()) document.documentElement.classList.add('standalone');
  // Вне Telegram (приложение на экране «Домой», браузер): вход по коду из Telegram
  if (!inTelegram && !session()) {
    let skipped = false;
    try { skipped = localStorage.getItem('kb_noLogin') === '1'; } catch (e) { /* нет */ }
    if (!skipped) {
      const ok = await showLoginScreen({ first: true });
      if (!ok) try { localStorage.setItem('kb_noLogin', '1'); } catch (e) { /* нет */ }
    }
  }
  S.onLoggedOut(() => {
    toast('Вход на этом устройстве отменён — войдите снова по коду', 'error');
    setTimeout(() => showLoginScreen({ first: false }), 800);
  });
  if (!inTelegram && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { wipeLegacyPrep(); cleanupOldOnce(); } catch (e) { console.error(e); }
  registerTab('ttk', () => (ttkState.view === 'ideas' ? ideasList() : recipesList()));
  registerTab('prep', prepScreen);
  registerTab('stock', stockScreen);
  registerTab('shift', shiftScreen);
  registerTab('settings', settingsScreen);
  initNav();
  initSwipeBack();
  let startTab = 'ttk';
  try { startTab = localStorage.getItem('kb_tab') || 'ttk'; } catch (e) { /* нет */ }
  setTab(['ttk', 'prep', 'stock', 'shift', 'settings'].includes(startTab) ? startTab : (startTab === 'equip' ? 'stock' : 'ttk'));
  document.getElementById('tabbar').addEventListener('click', () => {
    setTimeout(() => { try { localStorage.setItem('kb_tab', getTab()); } catch (e) { /* нет */ } }, 0);
  });

  // Пришли данные из облака / восстановили копию — перерисовать, если не в форме
  S.onChange((src) => {
    if (src === 'remote') { try { wipeLegacyPrep(); } catch (e) { console.error(e); } }
    if (['remote', 'import', 'wipe'].includes(src) && !top()?.form) refresh();
  });
  const typing = () => document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  S.onSync(() => {
    syncDot();
    if (top()?.tab === 'settings' && top()?.title === 'Настройки' && !typing()) {
      const card = document.querySelector('.sync-card');
      if (card) refresh();
    }
  });
  syncDot();
  S.initSync();
  initReminders();
  onRemState(() => { if (top()?.tab === 'settings' && top()?.title === 'Настройки' && document.querySelector('.rem-card') && !typing()) refresh(); });
  requestPersist();
  setTimeout(photoGC, 8000);
  document.body.classList.add('ready');
}

window.addEventListener('error', (e) => { console.error(e.error || e.message); toast('Ошибка: ' + (e.message || 'неизвестная'), 'error'); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('Ошибка: ' + (e.reason?.message || e.reason), 'error'); });

main().catch((e) => {
  console.error(e);
  document.getElementById('screen').innerHTML = '<div class="empty"><div class="empty-title">Не удалось запустить</div><p>' + String(e.message || e).replace(/</g, '&lt;') + '</p></div>';
});
