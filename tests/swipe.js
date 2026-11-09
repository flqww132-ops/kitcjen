const { chromium, devices } = require('playwright');
const fs = require('fs');
// Проверка свайпа назад настоящими касаниями. Запуск: node tests/swipe.js [URL]
const path = require('path');
const make = require('./initdata.js');
const BASE = process.argv[2] || 'https://flqww132-ops.github.io/kitcjen/';
const ok = (c, m) => { if (!c) { console.log('  ✗ ' + m); process.exitCode = 1; } else console.log('  ✓ ' + m); };
(async () => {
  const mock = fs.readFileSync(path.join(__dirname, 'tgmock.js'), 'utf8').replace(/initData: '[^']*'/, 'initData: ' + JSON.stringify(make('123456:TESTTOKEN', 777))).replace("platform: 'android'", "platform: 'ios'");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro Max'], locale: 'ru-RU' });
  await ctx.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: mock }));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + 'index.html?t=' + Date.now()); await page.waitForSelector('body.ready');
  const cdp = await ctx.newCDPSession(page);
  const W = (ms = 300) => page.waitForTimeout(ms);
  // свайп пальцем: от (x0,y0) на dx,dy за steps шагов, пауза между шагами ms
  const swipe = async (x0, y0, dx, dy = 0, steps = 12, ms = 16, shotAt) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps }] });
      await page.waitForTimeout(ms);
      if (shotAt && i === Math.round(steps * 0.6)) await page.screenshot({ path: shotAt });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await W(500);
  };
  const title = () => page.textContent('#title');
  const depth = () => page.evaluate(async () => (await import('./js/ui.js')).depth());
  await page.evaluate(async () => {
    const S = await import('./js/store.js');
    S.put('recipes', { id: 'r1', name: 'Котлета по-киевски', ingredients: [{ id: 'i1', name: 'Филе', netto: 150, unit: 'г', waste: null, wasteMode: 'abs' }], steps: [], photos: [] });
  });
  await page.click('#tabbar [data-tab="ttk"]'); await W();
  // на главном экране — ничего
  await swipe(60, 500, 300);
  ok((await depth()) === 1 && (await title()) === 'ТТК', 'главный экран: свайп ничего не делает');
  await page.click('.rcard'); await W(500);
  ok((await depth()) === 2, 'открыта карта ТТК');
  // короткий медленный — возвращается на место
  await swipe(100, 500, 80, 0, 10, 40);
  ok((await depth()) === 2, 'короткий медленный свайп — остаёмся');
  ok(await page.evaluate(() => [...document.querySelectorAll('#screen > *')].every((e) => !e.style.transform)), 'экран вернулся на место');
  // вертикальная прокрутка — не назад
  await swipe(200, 700, 20, -300);
  ok((await depth()) === 2, 'прокрутка вверх-вниз — не назад');
  // полный свайп с середины экрана
  await swipe(150, 500, 260, 10, 14, 16);
  ok((await depth()) === 1 && (await title()) === 'ТТК', 'свайп вправо с середины — назад к списку');
  // быстрый короткий смах
  await page.click('.rcard'); await W(500);
  await swipe(200, 400, 90, 0, 3, 16);
  ok((await depth()) === 1, 'быстрый короткий смах — назад');
  // форма с изменениями — спросит
  await page.click('.rcard'); await W(500);
  await page.click('[data-act="edit"]'); await W(500);
  await page.fill('[data-f="name"]', 'Котлета по-киевски 2');
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => { window.__popupAnswer = 'cancel'; });
  await swipe(100, 600, 300);
  const ev = await page.evaluate(() => window.__events.filter((e) => e.startsWith('popup:')));
  ok(ev.some((e) => e.includes('без сохранения')), 'несохранённая форма — вопрос «Выйти без сохранения?»');
  ok((await depth()) === 3, 'ответили «отмена» — остались в форме');
  ok(await page.evaluate(() => [...document.querySelectorAll('#screen > *')].every((e) => !e.style.transform)), 'форма на месте');
  // ряд с прокруткой вбок — не назад (Идеи: чипы статусов)
  await page.evaluate(() => { window.__popupAnswer = undefined; });
  await page.evaluate(async () => { (await import('./js/ui.js')).back(true); }); await W(); await page.evaluate(async () => { (await import('./js/ui.js')).back(true); }); await W();
  await page.click('#tabbar [data-tab="prep"]'); await W();
  await page.click('[data-act="add"]:visible'); await W(400);
  await page.click('[data-act="seg"][data-v="repeat"]'); await W(300);
  // поле в фокусе — свайп по нему не уводит
  await page.focus('[data-wd="0"]');
  const b = await page.$eval('[data-wd="0"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; });
  await swipe(b.x, b.y, 250);
  ok((await depth()) === 2, 'свайп по полю, в котором печатаете, — не уводит');
  await page.evaluate(() => document.activeElement.blur());
  await swipe(60, 300, 300);
  ok((await depth()) === 1, 'пустая форма — назад без вопросов');
  // таблица «Неделя» — прокрутка вбок, не назад
  await page.evaluate(async () => { const S = await import('./js/store.js'); for (let i = 0; i < 1; i++) S.put('prepItems', { id: 'w' + i, name: 'Лук фри с очень длинным названием', once: false, norms: [1, 1, 1, 1, 1, 1, 1], times: Array(7).fill(''), reminders: [], unit: 'кг' }); });
  // окно снизу открыто — свайп не работает
  await page.click('#tabbar [data-tab="ttk"]'); await W(); await page.click('#tabbar [data-tab="prep"]'); await W();
  await page.click('.prow .pr-name'); await W(400);
  ok((await depth()) === 2, 'открыта позиция');
  await page.evaluate(async () => { (await import('./js/ui.js')).actionSheet('Тест', [{ label: 'A', value: 'a' }]); }); await W(400);
  await swipe(60, 300, 300);
  ok((await depth()) === 2, 'при открытом окне снизу — свайп не уводит');
  console.log('errors', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
