// Распознавание файлов профессиональных ТТК: Excel (.xlsx/.xls), Word (.docx), PDF с текстом.
// Библиотеки грузятся с CDN только в момент импорта.

import { num, normUnit, norm, uid } from './util.js';
import { emptyRecipe, parseYield } from './textfmt.js';

const LIBS = {
  xlsx: { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', global: 'XLSX' },
  mammoth: { url: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', global: 'mammoth' },
  pdf: { url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', global: 'pdfjsLib' },
};
const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const loading = {};
export function loadLib(name) {
  const lib = LIBS[name];
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  if (!loading[name]) {
    loading[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = lib.url;
      s.async = true;
      s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error('lib')));
      s.onerror = () => { delete loading[name]; reject(new Error('Нет интернета или CDN недоступен — не удалось загрузить модуль чтения файла.')); };
      document.head.appendChild(s);
    });
  }
  return loading[name];
}

export class ImportError extends Error {
  constructor(msg, kind) { super(msg); this.kind = kind; }
}

// ---- Чтение файлов в «строки с ячейками» ------------------------------------------
// Документ = массив строк; строка = { cells: [{ t, x0?, x1? }] }

async function readXlsx(buf) {
  const XLSX = await loadLib('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true });
    return {
      name,
      rows: rows.map((r) => ({ cells: r.map((v) => ({ t: cellStr(v) })) })),
    };
  });
}
function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6).replace('.', ',');
  return String(v).replace(/\s+/g, ' ').trim();
}

// HTML-таблица → сетка с учётом объединённых ячеек (rowspan/colspan)
function tableToRows(table) {
  const grid = [];
  const trs = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
  trs.forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    for (const td of tr.children) {
      while (grid[r][c] !== undefined) c++;
      const text = td.textContent.replace(/\s+/g, ' ').trim();
      const cs = Math.max(1, +td.getAttribute('colspan') || 1);
      const rs = Math.max(1, +td.getAttribute('rowspan') || 1);
      for (let i = 0; i < rs; i++) {
        grid[r + i] = grid[r + i] || [];
        for (let j = 0; j < cs; j++) grid[r + i][c + j] = { t: text, span: j > 0 || i > 0 };
      }
      c += cs;
    }
  });
  return grid.map((row) => ({ cells: [...row].map((x) => x || { t: '' }) }));
}

async function readDocx(buf) {
  const mammoth = await loadLib('mammoth');
  const res = await mammoth.convertToHtml({ arrayBuffer: buf });
  const dom = new DOMParser().parseFromString(res.value, 'text/html');
  const rows = [];
  const walk = (node) => {
    for (const el of node.children) {
      if (el.tagName === 'TABLE') rows.push(...tableToRows(el));
      else if (/^(P|H\d|LI)$/.test(el.tagName)) {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        rows.push({ cells: [{ t }] });
      } else walk(el);
    }
  };
  walk(dom.body);
  return [{ name: '', rows }];
}

async function readPdf(buf) {
  const pdfjs = await loadLib('pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const rows = [];
  let chars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10 }));
    chars += items.reduce((a, it) => a + it.s.trim().length, 0);
    // Группируем в строки по вертикали
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.4));
      if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      const cells = [];
      for (const it of l.items) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x - last.x1 : Infinity;
        if (last && gap < it.h * 0.9) {
          last.t += (gap > it.h * 0.15 && !/\s$/.test(last.t) ? ' ' : '') + it.s;
          last.x1 = it.x + it.w;
        } else cells.push({ t: it.s, x0: it.x, x1: it.x + it.w });
      }
      cells.forEach((c) => { c.t = c.t.replace(/\s+/g, ' ').trim(); });
      rows.push({ cells });
    }
    rows.push({ cells: [] }); // граница страницы
  }
  if (chars < 30) {
    throw new ImportError('В этом PDF нет текстового слоя — похоже, это скан или фото. Такие файлы приложение не распознаёт. Отправьте фото карты Claude с инструкцией из «Вставить из текста» и вставьте его ответ.', 'scan');
  }
  return [{ name: '', rows }];
}

// ---- Распознавание ТТК в строках --------------------------------------------------------
const RE_NAME_COL = /наименован|продукт|сырь|ингредиент|компонент/i;
const RE_BRUTTO = /брутто/i;
const RE_NETTO = /нетто/i;
const RE_UNIT_COL = /^ед\.?|единиц|ед\.\s*изм/i;
const RE_NUM_COL = /^№|п\/п|^n$/i;

const SECTIONS = [
  ['steps', /^(технолог[а-яёa-z]*\s+(процесс|приготовлени[а-яёa-z]*|операци[а-яёa-z]*)|описание\s+технолог[а-яёa-z]*|технология|способ\s+приготовления|приготовление)/i],
  ['serving', /^(требования\s+к\s+оформлению|оформление|подача|правила\s+подачи)/i],
  ['storage', /^(услови[а-яёa-z]*\s+и\s+срок[а-яёa-z]*\s+хранени[а-яёa-z]*|срок[а-яёa-z]*\s+(и\s+услови[а-яёa-z]*\s+)?(хранени|годност|реализаци)[а-яёa-z]*|хранение|услови[а-яёa-z]*\s+хранени[а-яёa-z]*)/i],
  ['organo', /^органолептическ/i],
  ['stop', /^(область\s+применени|требовани[а-яёa-z]*\s+к\s+(сырь|качеств)|перечень\s+сырь|рецептур|пищев[а-яёa-z]*\s+(и\s+энергетическ[а-яёa-z]*\s+)?ценност|энергетическ|физико|микробиолог|ответственн|разработ|утвержд|подпис|технолог\s*[:_]|шеф|зав\.?\s*производств|калькуляц|норма\s+закладки)/i],
];

const rowText = (row) => row.cells.map((c) => c.t).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
const stripNum = (s) => s.replace(/^\s*(\d+(\.\d+)*[.)]?|[IVX]+\.)\s+/, '').trim();

function sectionOf(text) {
  const t = stripNum(text);
  for (const [key, re] of SECTIONS) if (re.test(t)) return key;
  return null;
}

function unitFromHeader(t) {
  const s = norm(t);
  if (/(^|[^а-яё])кг([^а-яё]|$)/.test(s)) return 'кг';
  if (/(^|[^а-яё])мл([^а-яё]|$)/.test(s)) return 'мл';
  if (/(,|\s)\s*г\.?(\s|$|,)|(^|[^а-яё])гр([^а-яё]|$)|грамм/.test(s)) return 'г';
  if (/(,|\s)\s*л\.?(\s|$|,)/.test(s)) return 'л';
  return '';
}

function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells;
    const nameCol = cells.findIndex((c) => RE_NAME_COL.test(c.t) && c.t.length < 80);
    if (nameCol < 0) continue;
    let hdr = cells.map((c) => c.t);
    let end = i;
    const hasBN = (arr) => arr.some((t) => RE_BRUTTO.test(t) || RE_NETTO.test(t));
    if (!hasBN(hdr) || !(hdr.some((t) => RE_BRUTTO.test(t)) && hdr.some((t) => RE_NETTO.test(t)))) {
      // Двухэтажная шапка: «Расход на 1 порцию» / «Брутто | Нетто»
      for (let k = 1; k <= 2 && i + k < rows.length; k++) {
        const next = rows[i + k].cells;
        if (hasBN(next.map((c) => c.t))) {
          hdr = mergeHeader(rows[i], rows[i + k]);
          end = i + k;
          break;
        }
      }
    }
    if (!hasBN(hdr)) continue;
    const idx = (re) => hdr.findIndex((t) => re.test(t));
    const cols = {
      name: nameCol,
      brutto: idx(RE_BRUTTO),
      netto: idx(RE_NETTO),
      unit: hdr.findIndex((t) => RE_UNIT_COL.test(t.trim())),
      num: hdr.findIndex((t) => RE_NUM_COL.test(t.trim())),
    };
    const unitHdr = unitFromHeader(hdr[cols.brutto] || '') || unitFromHeader(hdr[cols.netto] || '') || unitFromHeader(hdr.join(' '));
    const portionsHdr = (hdr.join(' ').match(/на\s+(\d+)\s+порц/i) || [])[1];
    // Позиции колонок по горизонтали (для PDF)
    const geo = rows[end].cells[0]?.x0 != null ? buildGeo(rows, i, end, cols) : null;
    return { start: i, end, cols, unitHdr, portions: portionsHdr ? +portionsHdr : null, geo };
  }
  return null;
}

function mergeHeader(r1, r2) {
  if (r1.cells[0]?.x0 == null) {
    const n = Math.max(r1.cells.length, r2.cells.length);
    return Array.from({ length: n }, (_, c) => `${r1.cells[c]?.t || ''} ${r2.cells[c]?.t || ''}`.trim());
  }
  // PDF: склеиваем по горизонтальному положению — берём все ячейки обеих строк
  return [...r1.cells, ...r2.cells].map((c) => c.t);
}

function buildGeo(rows, start, end, cols) {
  // Для PDF: центры колонок «Брутто», «Нетто», «Ед.» и левая граница названия
  const all = [];
  for (let r = start; r <= end; r++) all.push(...rows[r].cells);
  const find = (re) => all.find((c) => re.test(c.t));
  const center = (c) => (c ? (c.x0 + c.x1) / 2 : null);
  // Если в одной ячейке «Брутто Нетто» слиплись — берём по отдельности не получится; используем то, что есть
  return {
    brutto: center(find(RE_BRUTTO)),
    netto: center(all.filter((c) => RE_NETTO.test(c.t)).find((c) => !RE_BRUTTO.test(c.t))),
    unit: center(all.find((c) => RE_UNIT_COL.test(c.t.trim()))),
    nameX: find(RE_NAME_COL)?.x0 ?? null,
  };
}

function cellsByGeo(row, geo) {
  // Распределяем ячейки строки PDF по ближайшим колонкам
  const out = { name: '', brutto: '', netto: '', unit: '' };
  const targets = [['brutto', geo.brutto], ['netto', geo.netto], ['unit', geo.unit]].filter(([, x]) => x != null);
  const leftmostNum = Math.min(...targets.map(([, x]) => x));
  for (const c of row.cells) {
    const cx = (c.x0 + c.x1) / 2;
    if (cx < leftmostNum - 25 || !targets.length) {
      if (/^\d+[.)]?$/.test(c.t) && !out.name) continue; // номер строки
      out.name = (out.name ? out.name + ' ' : '') + c.t;
      continue;
    }
    let best = null, bd = Infinity;
    for (const [k, x] of targets) { const d = Math.abs(cx - x); if (d < bd) { bd = d; best = k; } }
    if (best && !out[best]) out[best] = c.t;
  }
  return out;
}

function guessUnit(vals) {
  // Единицы нигде не указаны: дробные числа меньше 10 — скорее килограммы
  const nums = vals.filter((v) => v != null);
  if (!nums.length) return { unit: 'г', guessed: true };
  const small = nums.every((v) => v < 10) && nums.some((v) => v % 1 !== 0);
  return { unit: small ? 'кг' : 'г', guessed: true };
}

function extractIngredients(rows, h) {
  const out = [];
  let empty = 0, last = h.end;
  let yieldInfo = null;
  for (let r = h.end + 1; r < rows.length; r++) {
    const row = rows[r];
    const text = rowText(row);
    if (!text) { if (++empty >= 3 && out.length) break; continue; }
    empty = 0;
    let name, b, n, u;
    if (h.geo) {
      const g = cellsByGeo(row, h.geo);
      name = g.name; b = g.brutto; n = g.netto; u = g.unit;
    } else {
      const cell = (c) => (c >= 0 ? row.cells[c]?.t || '' : '');
      name = cell(h.cols.name); b = cell(h.cols.brutto); n = cell(h.cols.netto); u = cell(h.cols.unit);
    }
    name = stripNum(String(name || '')).replace(/^[-–—•]\s*/, '');
    const lower = norm(text);
    if (/^(итого|всего)/.test(norm(name)) || /^(итого|всего)/.test(lower)) { last = r; continue; }
    if (/^выход/.test(norm(name)) || /^выход/.test(lower)) {
      yieldInfo = parseYield(text.replace(/^.*?выход[^:\d]*[:]?/i, ''));
      last = r;
      break;
    }
    if (sectionOf(text)) break;
    const bn = num(b), nn = num(n);
    if (!name || /^\d+([.,]\d+)?$/.test(name)) { continue; }
    if (bn == null && nn == null) {
      // строка без чисел: если это длинный текст — таблица закончилась
      if (name.length > 60 || out.length && empty) break;
      continue;
    }
    const unit = normUnit(u) || normUnit(String(b).replace(/[\d.,\s]/g, '')) || h.unitHdr || '';
    out.push({ id: uid(), name: name.trim(), brutto: bn, netto: nn, unit });
    last = r;
  }
  let unitGuessed = false;
  if (out.some((i) => !i.unit)) {
    const g = guessUnit(out.flatMap((i) => [i.brutto, i.netto]));
    out.forEach((i) => { if (!i.unit) i.unit = g.unit; });
    unitGuessed = true;
  }
  return { items: out, last, yieldInfo, unitGuessed };
}

function findName(rows, limit) {
  const top = rows.slice(0, limit);
  for (let r = 0; r < top.length; r++) {
    const cells = top[r].cells.map((c) => c.t).filter(Boolean);
    for (let k = 0; k < cells.length; k++) {
      const m = cells[k].match(/^(наименование\s+(блюда|изделия|кулинарной\s+продукции|продукции)|название\s+блюда|блюдо|название)\s*[:：]?\s*(.*)$/i);
      if (m) {
        const v = (m[3] || cells[k + 1] || '').trim();
        if (v && !RE_NAME_COL.test(v)) return clean(v);
        const next = top[r + 1] && rowText(top[r + 1]);
        if (!m[3] && !cells[k + 1] && next && next.length < 100) return clean(next);
      }
    }
  }
  for (let r = 0; r < top.length; r++) {
    const t = rowText(top[r]);
    const m = t.match(/карт[а-яёa-z]*.*?\sна\s+(?:блюдо|изделие|кулинарн[а-яёa-z]+\s+продукци[а-яёa-z]+)\s*[:]?\s*(.+)$/i);
    if (m) return clean(m[1]);
    if (/технологическ[а-яёa-z]*\s+карт/i.test(t)) {
      const q = t.match(/[«"](.+?)[»"]/);
      if (q) return clean(q[0]);
      // Название — следующая короткая строка без служебных слов
      for (let k = r + 1; k < Math.min(top.length, r + 4); k++) {
        const n = rowText(top[k]);
        if (!n) continue;
        if (/[:№]|^\d|утвержд|дата|организац|предприят|ооо|ип\s/i.test(n) || RE_NAME_COL.test(n) || n.length > 90) continue;
        return clean(n);
      }
    }
  }
  return '';
}
const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[«"]\s*/, '').replace(/\s*[»"]$/, '').trim();

function extractSections(rows, skipFrom, skipTo) {
  const res = { steps: [], serving: [], storage: [], organo: [] };
  let cur = null;
  for (let r = 0; r < rows.length; r++) {
    if (r >= skipFrom && r <= skipTo) { cur = null; continue; }
    const row = rows[r];
    const first = row.cells.find((c) => c.t)?.t || '';
    const text = rowText(row);
    if (!text) continue;
    const sec = sectionOf(first) || sectionOf(text);
    if (sec) {
      cur = sec === 'stop' ? null : sec;
      if (cur) {
        // текст после заголовка: «Подача: в тарелке» или во второй ячейке
        const cellsT = row.cells.map((c) => c.t).filter(Boolean);
        let rest = '';
        if (cellsT.length > 1 && sectionOf(cellsT[0])) rest = cellsT.slice(1).join(' ');
        else { const m = text.match(/^[^:]{3,90}:\s*(.+)$/); if (m) rest = m[1]; }
        if (rest) res[cur].push(rest.trim());
      }
      continue;
    }
    if (cur) res[cur].push(text);
  }
  return res;
}

function toSteps(lines) {
  const steps = [];
  for (const l of lines) {
    const numbered = /^\d+[.)]\s/.test(l) || /^[-–—•]\s/.test(l);
    const t = l.replace(/^(\d+[.)]|[-–—•])\s*/, '').trim();
    if (!t) continue;
    if (!numbered && steps.length && /^[a-zа-яё(,]/.test(t)) steps[steps.length - 1] += ' ' + t;
    else steps.push(t);
  }
  if (steps.length === 1 && /\s\d+[.)]\s/.test(steps[0])) {
    return steps[0].split(/\s(?=\d+[.)]\s)/).map((x) => x.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  return steps;
}

// Склеиваем строки, разорванные переносом (PDF): следующая строка с маленькой буквы
function joinWrapped(lines) {
  const out = [];
  for (const l of lines) {
    if (out.length && !/[.!?:;»"]$/.test(out[out.length - 1]) && /^[a-zа-яё0-9(,–—-]/.test(l)) out[out.length - 1] += ' ' + l;
    else out.push(l);
  }
  return out;
}

function findPortions(rows, h) {
  const all = rows.slice(0, 60).map(rowText).join('\n');
  const m = all.match(/(?:кол-?во|количество|число)\s+порций\s*[:\-]?\s*(\d+)/i) || all.match(/выход\s+порций\s*[:\-]?\s*(\d+)/i);
  if (m) return +m[1];
  return h?.portions || null;
}

function findYieldAnywhere(rows) {
  for (const row of rows) {
    const t = rowText(row);
    if (/^выход/i.test(stripNum(t)) || /выход\s+(готового\s+)?(блюда|изделия|продукции)/i.test(t)) {
      const y = parseYield(t.replace(/^.*?выход[^:\d]*:?/i, ''));
      if (y.amount != null) return y;
    }
  }
  return null;
}

export function recognize(rows) {
  const r = emptyRecipe();
  const found = { name: false, ingredients: 0, yield: false, steps: false, serving: false, storage: false, unitGuessed: false };
  const h = findHeader(rows);
  let ing = null;
  if (h) {
    ing = extractIngredients(rows, h);
    r.ingredients = ing.items;
    found.ingredients = ing.items.length;
    found.unitGuessed = ing.unitGuessed;
  }
  r.name = findName(rows, h ? h.start + 1 : 25);
  found.name = !!r.name;
  const y = (ing && ing.yieldInfo && ing.yieldInfo.amount != null ? ing.yieldInfo : null) || findYieldAnywhere(rows);
  if (y && y.amount != null) {
    r.yieldAmount = y.amount;
    r.yieldUnit = y.unit || (ing?.items[0]?.unit === 'кг' ? 'кг' : 'г');
    found.yield = true;
  }
  r.portions = findPortions(rows, h);
  const sec = extractSections(rows, h ? h.start : -1, ing ? ing.last : -1);
  r.steps = toSteps(sec.steps);
  r.serving = joinWrapped(sec.serving).join('\n');
  r.storage = joinWrapped(sec.storage).join('\n');
  if (sec.organo.length) r.notes = 'Органолептические показатели: ' + joinWrapped(sec.organo).join(' ');
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  r.serving = cap(r.serving);
  r.storage = cap(r.storage);
  found.steps = r.steps.length > 0;
  found.serving = !!r.serving;
  found.storage = !!r.storage;
  // Начало документа — чтобы узнать ресторан, если он упомянут
  const head = rows.slice(0, h ? h.start + 1 : 30).map(rowText).join(' ');
  return { recipe: r, found, head };
}

// Главная функция: файл → [{ recipe, found, label }]
export async function importFile(file) {
  const name = file.name || '';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  if (/^(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(ext) || /^image\//.test(file.type)) {
    throw new ImportError('Это фото — приложение не распознаёт текст на картинках. Отправьте фото карты Claude с инструкцией (кнопка «Вставить из текста» → «Скопировать инструкцию для Claude») и вставьте его ответ.', 'scan');
  }
  if (ext === 'doc') throw new ImportError('Старый формат Word (.doc) не поддерживается. Откройте файл в Word и сохраните как .docx (или PDF).', 'format');
  const buf = await file.arrayBuffer();
  let docs;
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods') docs = await readXlsx(buf);
  else if (ext === 'docx') docs = await readDocx(buf);
  else if (ext === 'pdf') docs = await readPdf(buf);
  else throw new ImportError('Этот тип файла не поддерживается. Подойдут Excel (.xlsx, .xls), Word (.docx) или PDF с текстом.', 'format');

  const results = [];
  for (const d of docs) {
    if (!d.rows.some((row) => rowText(row))) continue;
    const res = recognize(d.rows);
    if (!res.found.ingredients && !res.found.name && docs.length > 1) continue; // пустой лист
    res.label = docs.length > 1 && d.name ? `${name} — лист «${d.name}»` : name;
    results.push(res);
  }
  if (!results.length) throw new ImportError('В файле не нашлось ничего похожего на ТТК (таблицу с колонками «Наименование», «Брутто», «Нетто»). Можно добавить карту вручную или через «Вставить из текста».', 'empty');
  return results;
}
