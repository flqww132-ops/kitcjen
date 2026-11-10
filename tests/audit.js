// Полная проверка экранов на живом сайте: наложения, обрезанный текст, сдвиги вбок,
// кнопки под нижней панелью. Запуск: node audit.js [URL] [pass-filter]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const make = require('./initdata.js');
const BASE = process.argv[2] || 'https://flqww132-ops.github.io/kitcjen/';
const ONLY = process.argv[3] || '';
const OUT = process.env.AUDIT_OUT || path.join(require('os').tmpdir(), 'kitchen-audit');

const PASSES = [
  { name: 'promax-light', device: 'iPhone 14 Pro Max', theme: 'light' },
  { name: 'promax-dark', device: 'iPhone 14 Pro Max', theme: 'dark' },
  { name: 'se-light', device: 'iPhone SE', theme: 'light' },
];

// ---- детектор (выполняется в странице) ----
function detect(phase) {
  const vw = innerWidth;
  const issues = [];
  const R = (e) => e.getBoundingClientRect();
  const shown = (e) => {
    if (!e.isConnected) return false;
    const r = R(e); if (r.width < 2 || r.height < 2) return false;
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
    }
    return true;
  };
  const label = (e) => {
    const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 28);
    return `${e.tagName.toLowerCase()}${cls}${t ? ' «' + t + '»' : ''}`;
  };
  const inter = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 2 && h > 2 ? w * h : 0; };
  // Слой: открытое окно/этикетка — проверяем только его
  const sheets = [...document.querySelectorAll('.sheet-wrap.open .sheet')];
  const lv = document.querySelector('.label-view');
  const layer = lv || sheets[sheets.length - 1] || document.body;
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`страница шире экрана: ${document.documentElement.scrollWidth}px > ${vw}px`);
  const skip = (e) => e.closest('#toast, .sheet-bg, svg');
  const ctrls = [...layer.querySelectorAll('button, input:not([type=checkbox]):not([type=radio]), select, textarea, a[href], .chip, .badge')].filter((e) => !skip(e) && shown(e));
  const texts = [...layer.querySelectorAll('*')].filter((e) => !skip(e) && !['SCRIPT', 'STYLE', 'svg', 'path', 'circle', 'OPTION'].includes(e.tagName)
    && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && shown(e));
  const all = [...new Set([...ctrls, ...texts])];
  // за краем экрана
  const inHScroll = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true; } return false; };
  for (const e of all) { const r = R(e); if ((r.right > vw + 1 || r.left < -1) && !inHScroll(e)) issues.push(`за краем экрана: ${label(e)} (${Math.round(r.left)}…${Math.round(r.right)})`); }
  // обрезанный текст
  for (const e of all) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)) continue;
    const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0) issues.push(cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis' ? `текст обрезан: ${label(e)}` : `текст вылезает за свой блок: ${label(e)}`);
  }
  // текст в кнопке/переключателе/чипе разъехался на 2 строки
  for (const e of layer.querySelectorAll('.seg button, .chip, .day-chip, .tools-row .btn, .waste-mode')) {
    if (skip(e) || !shown(e)) continue;
    const rg = document.createRange(); rg.selectNodeContents(e);
    const tops = new Set([...rg.getClientRects()].filter((r) => r.width > 1).map((r) => Math.round(r.top)));
    if (tops.size > 1) issues.push(`текст в кнопке на 2 строки: ${label(e)}`);
  }
  // наложения (кроме вложенных друг в друга)
  const fixedOf = (e) => { for (let p = e; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.position === 'fixed' || cs.position === 'sticky') return p; } return null; };
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (fixedOf(a) !== fixedOf(b)) continue; // фиксированные панели — отдельная проверка
      if (a.closest('label') && a.closest('label') === b.closest('label') && (a.tagName === 'INPUT' || b.tagName === 'INPUT') && (a.type === 'checkbox' || b.type === 'checkbox')) continue;
      const s = inter(R(a), R(b));
      if (s > 12) issues.push(`наложение: ${label(a)} ⟷ ${label(b)}`);
    }
  }
  // нижняя панель / кнопка «+» / шапка закрывают элементы (в самом низу прокрутки или наверху)
  if (layer === document.body) {
    const fixed = [...document.querySelectorAll('#tabbar, .bottom-bar, .fab, #header, .topbar, .toolbar.sticky')].filter(shown);
    for (const f of fixed) {
      const fr = R(f);
      for (const e of ctrls) {
        if (f.contains(e) || fixedOf(e)) continue;
        const r = R(e);
        if (inter(fr, r) > 12) {
          // наверху — проверяем только шапку; внизу — нижние панели
          const isBottom = fr.top > innerHeight / 2;
          const noScroll = document.documentElement.scrollHeight - innerHeight <= 40;
          if (((phase === 'bottom' || noScroll) && isBottom) || (phase === 'top' && !isBottom && f.id !== 'tabbar')) issues.push(`закрыто панелью ${label(f).split(' ')[0]}: ${label(e)}`);
        }
      }
    }
  }
  return [...new Set(issues)];
}

async function seed(page) {
  await page.evaluate(async () => {
    const S = await import('./js/store.js'); const u = await import('./js/util.js');
    const now = Date.now(); const today = u.dateISO(); const day = (n) => u.dateISO(new Date(now + n * 864e5));
    S.put('settings', { id: 'botUrl', value: 'http://127.0.0.1:8787' });
    const cat = S.put('categories', { id: 'c1', name: 'Горячие блюда и основные позиции меню' });
    S.put('categories', { id: 'c2', name: 'Закуски' });
    S.put('restaurants', { id: 'rs1', name: 'Траттория «Марио» на Большой Садовой' });
    S.put('stations', { id: 's1', name: 'Холодный цех' }); S.put('stations', { id: 's2', name: 'Горячий цех и гриль (основная линия)' });
    const ings = [
      { id: 'i1', name: 'Филе куриное охлаждённое (грудка без кожи)', netto: 1250.5, unit: 'г', waste: 120, wasteMode: 'abs' },
      { id: 'i2', name: 'Масло сливочное 82,5%', netto: 30, unit: 'г', waste: 5, wasteMode: 'pct' },
      { id: 'i3', name: 'Яйцо', netto: 2, unit: 'шт', waste: null, wasteMode: 'abs' },
      { id: 'i4', name: 'Сливки 33%', netto: 0.25, unit: 'л', waste: null, wasteMode: 'abs' },
    ];
    S.put('recipes', { id: 'r1', name: 'Котлета по-киевски с картофельным пюре и соусом из белых грибов', categoryId: 'c1', sourceId: 'rs1', ingredients: ings, yieldAmount: 1500, yieldUnit: 'г', portions: 6,
      steps: ['Филе отбить до толщины 5 мм, посолить и поперчить с двух сторон.', 'Завернуть холодное масло с зеленью, запанировать дважды.', 'Обжарить во фритюре 180 °C 4–5 минут, довести в пароконвектомате.'],
      serving: 'Подавать на тёплой тарелке, пюре — кнелью, соус отдельно в соуснике.', storage: 'Полуфабрикат — до 24 ч при +2…+4 °C.', notes: 'Проверено шефом', photos: [] });
    S.put('recipes', { id: 'r2', name: 'Салат Цезарь', categoryId: 'c2', ingredients: [{ id: 'j1', name: 'Романо', netto: 80, unit: 'г', waste: 20, wasteMode: 'abs' }], steps: [], photos: [] });
    S.put('ideas', { id: 'd1', title: 'Тыквенный чизкейк с солёной карамелью и пеканом в карамели', description: 'Плотный, как нью-йоркский, на основе из имбирного печенья. Подача — с шариком ванильного мороженого.', categoryId: 'c2', status: 'work',
      ingredients: [{ id: 'q1', name: 'Тыква запечённая (мякоть)', qty: 400, unit: 'г' }, { id: 'q2', name: 'Сливочный сыр', qty: 600, unit: 'г' }] });
    S.put('ideas', { id: 'd2', title: 'Окрошка на тане', status: 'idea', ingredients: [] });
    const P = (o) => S.put('prepItems', { norms: Array(7).fill(null), times: Array(7).fill(''), reminders: [], unit: 'кг', ...o });
    P({ id: 'p1', name: 'Соус цезарь', stationId: 's1', once: true, date: today, time: '12:00', qty: 2, unit: 'л', shelfH: 48 });
    P({ id: 'p2', name: 'Бульон куриный для супов и соусов (большая кастрюля)', stationId: 's2', once: true, date: day(-1), qty: 12.5, unit: 'л' });
    P({ id: 'p3', name: 'Тесто для пиццы', stationId: 's2', once: true, date: day(1), qty: 3 });
    P({ id: 'p4', name: 'Лук фри', stationId: 's2', once: false, norms: [1, 1, 1, 1, 2, 3, 3], times: ['10:00', '', '', '', '', '', ''], reminders: [3600] });
    P({ id: 'p5', name: 'Майонез домашний', stationId: 's1', once: true, date: day(-3), qty: 1 });
    S.put('prepLog', { id: day(-3) + '|p5', date: day(-3), itemId: 'p5', done: true });
    S.put('batches', { id: 'b1', prepItemId: 'p1', name: 'Соус цезарь', unit: 'л', qty: 2, madeAt: now - 864e5, expiresAt: now + 3 * 3600e3, by: 'Артём', status: 'active' });
    S.put('batches', { id: 'b2', prepItemId: 'p2', name: 'Бульон куриный для супов и соусов (большая кастрюля)', unit: 'л', qty: 12.5, madeAt: now - 3 * 864e5, expiresAt: now - 3600e3, by: 'Константин Константинопольский', status: 'active' });
    S.put('timers', { id: 't1', label: 'Бульон — снять пену', durationSec: 1800, endsAt: now + 1500e3 });
    const L = S.list('locations')[0];
    S.put('invItems', { id: 'v1', name: 'Мука пшеничная высшего сорта «Макфа» 50 кг', unit: 'кг', locationId: L?.id || '', minQty: 20, supplier: 'Метро Кэш энд Керри' });
    S.put('invItems', { id: 'v2', name: 'Сахар', unit: 'кг', locationId: L?.id || '', minQty: 5, supplier: '' });
    S.put('invCounts', { id: 'n1', date: day(-2), status: 'done', counts: { v1: 12, v2: 8 }, finishedAt: now - 2 * 864e5 });
    S.put('equipment', { id: 'e1', name: 'Гастроёмкость GN 1/1 h65 из нержавеющей стали', qty: '6 шт', status: 'urgent', supplier: 'Ресторанный двор', link: '' });
    S.put('checklists', { id: 'k1', name: 'Закрытие смены (горячий цех и мойка)', items: [{ id: 'x1', text: 'Холодильники: температура в норме, журнал заполнен' }, { id: 'x2', text: 'Плиты и пароконвектомат выключены' }], time: '23:00', remind: true, order: 0 });
    S.put('checkLog', { id: today + '|k1', date: today, checklistId: 'k1', marks: { x1: { v: 'ok' }, x2: { v: 'no', note: 'Пароконвектомат не выключается — вызвали мастера' } } });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = {};
  for (const pass of PASSES.filter((p) => !ONLY || p.name.includes(ONLY))) {
    const mock = fs.readFileSync(path.join(__dirname, 'tgmock.js'), 'utf8').replace(/initData: '[^']*'/, 'initData: ' + JSON.stringify(make('123456:TESTTOKEN', 10000 + Math.floor(Math.random() * 1e6))))
      .replace("platform: 'android'", "platform: 'ios'").replace("initData:", "initDataUnsafe: { user: { id: 777, first_name: 'Артём' } }, initData:");
    const ctx = await browser.newContext({ ...devices[pass.device], locale: 'ru-RU', timezoneId: 'Europe/Moscow', permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.route('https://telegram.org/js/telegram-web-app.js*', (r) => r.fulfill({ contentType: 'application/javascript', body: mock }));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + 'index.html?audit=' + Date.now()); await page.waitForSelector('body.ready');
    const ver = await page.evaluate(async () => (await import('./js/store.js')).APP_VERSION);
    await seed(page);
    await page.evaluate(async (t) => (await import('./js/theme.js')).setThemeMode(t), pass.theme);
    const W = (ms = 350) => page.waitForTimeout(ms);
    const back = async () => { await page.evaluate(() => window.Telegram.WebApp.BackButton._cb?.()); await W(); const d = await page.$('.sheet-wrap.open .btn.danger'); if (d) { await d.click(); await W(); } };
    const closeSheets = async () => { for (let i = 0; i < 3; i++) { const bg = await page.$('.sheet-wrap.open .sheet-bg'); if (!bg) break; await bg.click({ position: { x: 10, y: 10 } }); await W(); } const lv = await page.$('.label-view .btn'); if (lv) { await lv.click(); await W(); } };
    const tab = async (t) => { await closeSheets(); await page.click(`#tabbar [data-tab="${t}"]`); await W(); for (let i = 0; i < 4 && (await page.evaluate(() => !document.body.classList.contains('root'))); i++) await back(); await page.click(`#tabbar [data-tab="${t}"]`); await W(); };
    const seg = async (name, v) => { await page.click(`[data-act="seg"][data-seg="${name}"][data-v="${v}"]`); await W(); };
    const res = []; let n = 0;
    const check = async (name, sheet = false) => {
      n++;
      await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
      const id = String(n).padStart(2, '0') + '-' + name;
      if (sheet) {
        const iss = await page.evaluate(detect, 'sheet');
        await page.screenshot({ path: `${OUT}/${pass.name}/${id}.png` });
        res.push({ id, issues: iss });
        return;
      }
      await page.evaluate(() => window.scrollTo(0, 0)); await W(150);
      const top = await page.evaluate(detect, 'top');
      await page.screenshot({ path: `${OUT}/${pass.name}/${id}-a.png` });
      const h = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      let bottom = [];
      if (h > 40) {
        await page.evaluate(() => window.scrollTo(0, 1e6)); await W(200);
        bottom = await page.evaluate(detect, 'bottom');
        await page.screenshot({ path: `${OUT}/${pass.name}/${id}-b.png` });
      }
      res.push({ id, issues: [...new Set([...top, ...bottom])] });
    };
    const step = async (name, fn, sheet) => { try { await fn(); await check(name, sheet); } catch (e) { res.push({ id: name, issues: ['НЕ ОТКРЫЛОСЬ: ' + e.message.split('\n')[0]] }); await closeSheets(); } };
    fs.mkdirSync(`${OUT}/${pass.name}`, { recursive: true });

    // ТТК
    await step('ttk-list', () => tab('ttk'));
    await step('ttk-add-menu', async () => { await page.click('.fab'); await W(); }, true);
    await step('ttk-detail', async () => { await closeSheets(); await page.click('.rcard >> nth=0'); await W(600); });
    await step('ttk-scale', async () => { await seg('scale', 'portions'); await page.fill('#scv', '12'); await W(); });
    await step('ttk-more', async () => { await page.click('[data-act="more"]'); await W(); }, true);
    await step('ttk-edit', async () => { await closeSheets(); await page.click('[data-act="edit"]'); await W(500); });
    await step('ttk-paste', async () => { await back(); await back(); await page.click('.fab'); await W(); await page.click('.sheet .menu-item:has-text("текст")'); await W(500); });
    await step('ideas', async () => { await tab('ttk'); await seg('ttkview', 'ideas'); });
    await step('idea-form', async () => { await page.click('.icard >> nth=0'); await W(); await page.click('[data-act="toggle-ings"]'); await W(); });
    await step('idea-new', async () => { await back(); await page.click('.fab'); await W(); const m = await page.$('.sheet .menu-item >> nth=0'); if (m) { await m.click(); await W(); } });
    await back(); await tab('ttk'); await seg('ttkview', 'cards').catch(() => {});
    // Заготовки
    await step('prep-today', () => tab('prep'));
    await step('prep-tomorrow', () => seg('mode', 'tomorrow'));
    await step('prep-week', () => seg('mode', 'week'));
    await step('prep-exp', () => seg('mode', 'exp'));
    await step('prep-done-list', async () => { await seg('mode', 'today'); await page.click('[data-chips="plist"] [data-v="done"]').catch(() => {}); await W(); });
    await step('prep-more-menu', async () => { await page.click('[data-chips="plist"] [data-v="active"]').catch(() => {}); await W(); await page.click('[data-act="more-menu"]'); await W(); }, true);
    await step('prep-old', async () => { await page.click('.sheet .menu-item:has-text("Старые")'); await W(); await page.click('.old-main >> nth=0'); await W(); });
    await step('prep-old-other', async () => { await page.click('[data-act="back-other"]'); await W(); }, true);
    await step('prep-form-once', async () => { await closeSheets(); await back(); await page.click('[data-act="add"]:visible'); await W(); });
    await step('prep-form-more', async () => { await page.click('[data-act="toggle-more"]'); await W(); });
    await step('prep-form-repeat', async () => { await seg('pmode', 'repeat'); });
    await step('prep-edit', async () => { await back(); await page.click('.prow .pr-name >> nth=0'); await W(); });
    await step('prep-mark', async () => { await back(); await page.click('.prow [data-act="mark"] >> nth=0'); await W(); }, true);
    await step('prep-label', async () => { await page.click('.sheet-btns .btn.primary'); await W(500); }, true);
    await step('prep-time', async () => { await closeSheets(); await page.click('.prow [data-act="time"] >> nth=0'); await W(); }, true);
    await step('prep-timer', async () => { await closeSheets(); await page.click('.tools-row [data-act="timer-new"], .tools-row .btn >> nth=0'); await W(); }, true);
    await step('prep-plan', async () => { await closeSheets(); await page.click('[data-act="plan"]'); await W(500); });
    // Склад
    await step('stock-items', async () => { await back(); await tab('stock'); await seg('view', 'items'); });
    await step('stock-history', () => seg('view', 'history'));
    await step('stock-order', () => seg('view', 'order'));
    await step('stock-eq-form', async () => { await page.click('[data-act="eq-open"] >> nth=0').catch(async () => page.click('.fab')); await W(); });
    await step('stock-item-form', async () => { await back(); await seg('view', 'items'); await page.click('[data-act="open"] >> nth=0').catch(() => {}); await W(); });
    await step('stock-count', async () => { await back(); await page.click('[data-act="start"] >> nth=0'); await W(500); });
    // Смена
    await step('shift', async () => { await back(); await tab('shift'); });
    await step('shift-fill', async () => { await page.click('.ccard >> nth=0'); await W(); });
    await step('shift-edit', async () => { await page.click('[data-act="edit"]').catch(() => {}); await W(); });
    await step('shift-journal', async () => { await back(); await back(); await tab('shift'); await seg('view', 'journal'); });
    await step('shift-day', async () => { await page.click('.jcard >> nth=0'); await W(); });
    // Настройки
    await step('settings', async () => { await back(); await tab('settings'); await W(800); });
    await step('settings-code', async () => { await page.click('[data-act="login-code"]'); await W(1200); }, true);

    report[pass.name] = { ver, res, errors };
    const bad = res.filter((r) => r.issues.length);
    console.log(`\n=== ${pass.name} (версия ${ver}) — экранов ${res.length}, с замечаниями ${bad.length}`);
    for (const r of bad) { console.log(' ' + r.id); r.issues.slice(0, 12).forEach((i) => console.log('    - ' + i)); if (r.issues.length > 12) console.log(`    … ещё ${r.issues.length - 12}`); }
    if (errors.length) console.log(' ошибки:', errors);
    await ctx.close();
  }
  fs.writeFileSync(OUT + '/report.json', JSON.stringify(report, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
