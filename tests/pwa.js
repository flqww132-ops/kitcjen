// 2.0: приложение вне Telegram + облако бота. A — Telegram, B — приложение на экране «Домой».
const { chromium, devices } = require('playwright');
const fs = require('fs');
// Запуск: node tests/pwa.js [URL приложения] [URL бота] — нужен бот с BOT_TOKEN=123456:TESTTOKEN (wrangler dev)
const path = require('path');
const SP = process.env.AUDIT_OUT || require('os').tmpdir();
fs.mkdirSync(SP + '/shots', { recursive: true });
const make = require('./initdata.js');
const BASE = process.argv[2] || 'http://localhost:8765/';
const BOT = process.argv[3] || 'http://127.0.0.1:8787';
const UID = 7000 + Math.floor(Math.random() * 1000);
const ok = (c, m) => { if (!c) { console.log('  ✗ ' + m); process.exitCode = 1; } else console.log('  ✓ ' + m); };
(async () => {
  const browser = await chromium.launch();
  const mock = fs.readFileSync(path.join(__dirname, 'tgmock.js'), 'utf8').replace(/initData: '[^']*'/, 'initData: ' + JSON.stringify(make('123456:TESTTOKEN', UID)))
    .replace("platform: 'android'", "platform: 'ios'").replace('initData:', "initDataUnsafe: { user: { id: " + UID + ", first_name: 'Артём' } }, initData:");
  const errors = [];
  const ctxA = await browser.newContext({ ...devices['iPhone 14 Pro Max'], locale: 'ru-RU', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctxA.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: mock }));
  const A = await ctxA.newPage(); A.on('pageerror', (e) => errors.push('A: ' + e.message));
  await A.goto(BASE + 'index.html'); await A.waitForSelector('body.ready');
  const W = (p, ms = 350) => p.waitForTimeout(ms);
  await A.evaluate(async (bot) => { const S = await import('./js/store.js'); S.put('settings', { id: 'botUrl', value: bot }); }, BOT);
  // ТТК с фото в Telegram
  await A.evaluate(async () => {
    const S = await import('./js/store.js'); const P = await import('./js/photos.js');
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d'); x.fillStyle = '#e63'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#fff'; x.fillRect(100, 80, 200, 140);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const id = await P.addPhoto(new File([blob], 'a.jpg', { type: 'image/jpeg' }));
    S.put('recipes', { id: 'r1', name: 'Борщ облачный', ingredients: [{ id: 'i1', name: 'Свёкла', netto: 200, unit: 'г', waste: null, wasteMode: 'abs' }], steps: ['Сварить.'], photos: [{ id, kind: 'dish' }] });
    await S.syncNow();
  });
  await W(A, 1500);
  await A.evaluate(async () => (await import('./js/store.js')).syncNow()); await W(A, 800);
  ok(await A.evaluate(async () => (await import('./js/store.js')).sync.srv), 'Telegram: облако бота подключено');
  // код входа
  await A.click('#tabbar [data-tab="settings"]'); await W(A, 800);
  await A.screenshot({ path: SP + '/shots/pwa-1-settings-tg.png' });
  await A.click('[data-act="login-code"]'); await W(A, 1000);
  const code = (await A.textContent('.login-code')).replace(/\D/g, '');
  ok(/^\d{6}$/.test(code), 'код входа: ' + code);
  await A.screenshot({ path: SP + '/shots/pwa-2-code.png' });
  await A.click('.sheet-btns .btn.primary'); await W(A);

  // B — без Telegram, как приложение с экрана «Домой»
  const ctxB = await browser.newContext({ ...devices['iPhone 14 Pro Max'], locale: 'ru-RU' });
  await ctxB.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await ctxB.addInitScript(() => { Object.defineProperty(window.navigator, 'standalone', { get: () => true }); });
  const B = await ctxB.newPage(); B.on('pageerror', (e) => errors.push('B: ' + e.message));
  await B.goto(BASE + 'index.html');
  await B.waitForSelector('.login-view'); await W(B);
  await B.evaluate((bot) => { localStorage.setItem('kb_botDefault', bot); }, BOT);
  await B.screenshot({ path: SP + '/shots/pwa-3-login.png' });
  // адрес бота для теста: подменяем умолчание
  await B.evaluate(async (bot) => { const S = await import('./js/store.js'); S.put('settings', { id: 'botUrl', value: bot }); }, BOT);
  await B.fill('#lcode', '123456'); await W(B, 1200);
  ok((await B.textContent('#lerr')).includes('Неверный'), 'неверный код — «Неверный или устаревший код»');
  await B.fill('#lcode', code);
  await B.waitForSelector('body.ready', { timeout: 20000 }); await W(B, 1500);
  ok(!(await B.$('.login-view')), 'вход по коду — приложение открылось');
  await B.evaluate(async () => (await import('./js/store.js')).syncNow()); await W(B, 1500);
  const names = await B.evaluate(async () => (await import('./js/store.js')).list('recipes').map((r) => r.name));
  ok(names.includes('Борщ облачный'), 'данные из Telegram пришли в приложение');
  await B.click('#tabbar [data-tab="ttk"]'); await W(B, 500);
  await B.click('.rcard:has-text("Борщ")'); await W(B, 2000);
  const ph = await B.evaluate(() => { const i = document.querySelector('img[data-photo]'); return i && i.naturalWidth; });
  ok(ph > 0, 'фото скачалось из облака (' + ph + 'px)');
  await B.screenshot({ path: SP + '/shots/pwa-4-detail.png' });
  // правка в приложении → видно в Telegram
  await B.evaluate(async () => { const S = await import('./js/store.js'); S.put('recipes', { ...S.get('recipes', 'r1'), name: 'Борщ из приложения' }); await S.syncNow(); });
  await W(B, 800);
  await A.evaluate(async () => (await import('./js/store.js')).syncNow()); await W(A, 1000);
  ok((await A.evaluate(async () => (await import('./js/store.js')).get('recipes', 'r1').name)) === 'Борщ из приложения', 'правка в приложении видна в Telegram');
  // настройки в приложении
  await B.evaluate(async () => (await import('./js/ui.js')).back(true)); await W(B);
  await B.click('#tabbar [data-tab="settings"]'); await W(B, 1500);
  const st = await B.textContent('#screen');
  ok(st.includes('Вы вошли как Шеф') && st.includes('(это)'), 'в приложении: «Вы вошли как Шеф», устройство «(это)»');
  await B.screenshot({ path: SP + '/shots/pwa-5-settings-app.png' });
  // напоминание/отправка через ключ
  const send = await B.evaluate(async () => { try { await (await import('./js/reminders.js')).sendText('из приложения'); return 'ok'; } catch (e) { return e.message; } });
  ok(send === 'ok', 'отправка в чат из приложения работает: ' + send);
  // Telegram: список устройств и выход
  await A.click('#tabbar [data-tab="ttk"]'); await W(A, 5200); await A.click('#tabbar [data-tab="settings"]'); await W(A, 1500);
  await A.evaluate(async () => { /* обновить список */ });
  const devs = await A.$$('.dev-row');
  ok(devs.length === 1 && (await A.textContent('.dev-row')).includes('iPhone · приложение'), 'в Telegram виден вход: «iPhone · приложение»');
  await A.screenshot({ path: SP + '/shots/pwa-6-devices.png' });
  await A.evaluate(() => { window.__popupAnswer = 'ok'; });
  await A.click('[data-act="dev-out"]'); await W(A, 1200);
  ok(!(await A.$('.dev-row')), 'выход с устройства из Telegram');
  await B.evaluate(async () => (await import('./js/store.js')).syncNow()); await W(B, 2000);
  ok(!!(await B.$('.login-view')), 'приложение после выхода просит код снова');
  console.log('errors', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
