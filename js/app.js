// Точка входа «Книги кухни»

import { initTelegram } from './tg.js';
import { applyTheme } from './theme.js';
import * as S from './store.js';
import { registerTab, setTab, initNav, top, refresh, toast, getTab } from './ui.js';
import { requestPersist } from './idb.js';
import { photoGC } from './photos.js';
import { recipesList } from './views/ttk.js';
import { ideasList } from './views/ideas.js';
import { equipmentList } from './views/equipment.js';
import { prepScreen } from './views/prep.js';
import { settingsScreen } from './views/settings.js';

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
  registerTab('ttk', recipesList);
  registerTab('ideas', ideasList);
  registerTab('equip', equipmentList);
  registerTab('prep', prepScreen);
  registerTab('settings', settingsScreen);
  initNav();
  let startTab = 'ttk';
  try { startTab = localStorage.getItem('kb_tab') || 'ttk'; } catch (e) { /* нет */ }
  setTab(['ttk', 'ideas', 'equip', 'prep', 'settings'].includes(startTab) ? startTab : 'ttk');
  document.getElementById('tabbar').addEventListener('click', () => {
    setTimeout(() => { try { localStorage.setItem('kb_tab', getTab()); } catch (e) { /* нет */ } }, 0);
  });

  // Пришли данные из облака / восстановили копию — перерисовать, если не в форме
  S.onChange((src) => {
    if (['remote', 'import', 'wipe'].includes(src) && !top()?.form) refresh();
  });
  S.onSync(() => {
    syncDot();
    if (top()?.tab === 'settings' && top()?.title === 'Настройки') {
      const card = document.querySelector('.sync-card');
      if (card) refresh();
    }
  });
  syncDot();
  S.initSync();
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
