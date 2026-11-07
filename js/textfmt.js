// Простой текстовый формат ТТК и идей: чтение и запись.

import { num, normUnit, fmtNum, norm, uid } from './util.js';
import { findByName, nameOf, OWN_SOURCE_ID } from './store.js';

export const IDEA_STATUSES = [
  { id: 'idea', label: 'Идея' },
  { id: 'work', label: 'В работе' },
  { id: 'test', label: 'Тест' },
  { id: 'menu', label: 'В меню' },
  { id: 'hold', label: 'Отложено' },
];
export const statusLabel = (id) => IDEA_STATUSES.find((s) => s.id === id)?.label || 'Идея';

export function parseStatus(s) {
  const n = norm(s).replace(/[.!]/g, '');
  if (!n) return 'idea';
  if (/^(идея|идеи)/.test(n)) return 'idea';
  if (/работ/.test(n)) return 'work';
  if (/тест|проб/.test(n)) return 'test';
  if (/меню/.test(n)) return 'menu';
  if (/отлож|пауз/.test(n)) return 'hold';
  return 'idea';
}

// Значение для выпадающего списка по названию: id, "new:Название" или ''
export function refByName(coll, name) {
  const n = String(name || '').trim();
  if (!n || /^[-—–]+$/.test(n)) return '';
  if (coll === 'restaurants' && /^сво(я|й)\s+(разработк|рецепт)/i.test(n)) return OWN_SOURCE_ID;
  const f = findByName(coll, n);
  return f ? f.id : 'new:' + n;
}

// ---- Общее: подготовка текста --------------------------------------------------------
function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^```[a-zа-я]*\s*$/gim, '')      // ```-блоки
    .replace(/\*\*(.+?)\*\*/g, '$1')            // **жирный**
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');        // # заголовки
}

const isEmptyVal = (s) => !s || /^[-—–]+$/.test(s.trim()) || /^(нет|не указано|не указан[оа]?|н\/д)\.?$/i.test(s.trim());

// ---- ТТК ----------------------------------------------------------------------------------
const RECIPE_FIELDS = [
  ['name', /^(название|наименование|блюдо)$/],
  ['category', /^(категория|раздел)$/],
  ['source', /^(источник|ресторан|ресторан\s*\/\s*источник|откуда)$/],
  ['yield', /^(выход|выход готового блюда|выход блюда)$/],
  ['portions', /^(порци[йия]|кол-?во порций|количество порций|число порций)$/],
  ['ingredients', /^(ингредиенты|сырье|состав|продукты|раскладка)$/],
  ['steps', /^(технология|технология приготовления|приготовление|технологический процесс)$/],
  ['serving', /^(подача|оформление и подача|оформление)$/],
  ['storage', /^(хранение|условия и сроки хранения|сроки хранения|срок хранения)$/],
  ['notes', /^(примечани[ея]|заметки|комментарий)$/],
  ['ignore', /^(пересчет|пересчёт)$/],
];

function fieldOf(line, fields) {
  const m = line.match(/^\s*([А-Яа-яЁёA-Za-z\- /]+?)\s*(?:\([^)]*\))?\s*[:：]\s*(.*)$/);
  if (!m) return null;
  const key = norm(m[1]);
  for (const [f, re] of fields) if (re.test(key)) return { f, rest: m[2].trim() };
  return null;
}

export function parseIngredientLine(line) {
  let s = line.replace(/^\s*(?:[-–—•*·]|\d+[.)])\s*/, '').trim();
  if (!s) return null;
  const blank = (name) => ({ name, netto: null, unit: 'г', waste: null, wasteMode: 'abs' });
  if (s.includes('|')) {
    const p = s.split('|').map((x) => x.trim());
    if (/брутто|нетто|продукт/i.test(p.slice(1).join(' ')) && num(p[1]) == null) return null; // строка-шапка
    const name = p[0];
    if (!name) return null;
    const out = blank(name);
    if (normUnit(p[2] || '')) {
      // Формат: продукт | нетто | ед. | отход
      out.netto = num(p[1]);
      out.unit = normUnit(p[2]);
      const w = (p[3] || '').trim();
      if (w && num(w) != null) { out.waste = num(w); out.wasteMode = /%/.test(w) ? 'pct' : 'abs'; }
    } else {
      // Старый формат: продукт | брутто | нетто | ед. — брутто не берём
      out.netto = p.length >= 3 ? num(p[2]) : num(p[1]);
      out.unit = normUnit(p[3] || '') || normUnit((p[2] || p[1] || '').replace(/[\d.,\s]/g, '')) || 'г';
    }
    return out;
  }
  // Запасной вариант: «Свёкла — 160 г» (или «200/160 г» — берём нетто)
  const m = s.match(/^(.*?)[\s:—–-]+(\d[\d\s.,]*)\s*(?:\/\s*(\d[\d\s.,]*))?\s*(кг|г|гр|мл|л|шт)\.?$/i);
  if (m) return { ...blank(m[1].trim()), netto: m[3] != null ? num(m[3]) : num(m[2]), unit: normUnit(m[4]) };
  return blank(s);
}

export function parseYield(s) {
  const str = String(s || '');
  const withUnit = str.match(/(\d[\d.,]*)\s*(кг|гр|г|мл|л|шт)\.?(?![а-яё])/i);
  if (withUnit) return { amount: num(withUnit[1]), unit: normUnit(withUnit[2]) };
  const m = str.match(/(\d[\d.,]*)\s*(порц)?/i);
  if (!m || m[2]) return { amount: null, unit: '' };
  return { amount: num(m[1]), unit: '' };
}

function splitSteps(lines) {
  const steps = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const numbered = /^(\d+[.)]|[-–—•*])\s*/.test(l);
    const t = l.replace(/^(\d+[.)]|[-–—•*])\s*/, '').trim();
    if (!t) continue;
    if (!numbered && steps.length && /^[a-zа-яё(,]/.test(t)) steps[steps.length - 1] += ' ' + t;
    else steps.push(t);
  }
  // Один абзац с «1. … 2. …» внутри — разрезаем
  if (steps.length === 1 && /\s\d+[.)]\s/.test(steps[0])) {
    return steps[0].split(/\s(?=\d+[.)]\s)/).map((x) => x.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  return steps;
}

export function emptyRecipe() {
  return {
    name: '', categoryId: '', sourceId: '', ingredients: [], yieldAmount: null, yieldUnit: 'г',
    portions: null, steps: [], serving: '', storage: '', notes: '', photos: [],
  };
}

function recipeFromFields(fields) {
  const r = emptyRecipe();
  const one = (k) => (fields[k] || []).join(' ').trim();
  const multi = (k) => (fields[k] || []).map((x) => x.trim()).filter(Boolean).join('\n');
  r.name = isEmptyVal(one('name')) ? '' : one('name').replace(/^[«"]|[»"]$/g, '').trim();
  r.categoryId = isEmptyVal(one('category')) ? '' : refByName('categories', one('category'));
  r.sourceId = isEmptyVal(one('source')) ? '' : refByName('restaurants', one('source'));
  const y = parseYield(one('yield'));
  r.yieldAmount = y.amount;
  r.yieldUnit = y.unit || 'г';
  r.portions = num(one('portions'));
  r.ingredients = (fields.ingredients || []).map(parseIngredientLine).filter(Boolean).map((i) => ({ id: uid(), ...i }));
  r.steps = splitSteps(fields.steps || []).filter((s) => !isEmptyVal(s));
  r.serving = isEmptyVal(multi('serving')) ? '' : multi('serving');
  r.storage = isEmptyVal(multi('storage')) ? '' : multi('storage');
  r.notes = isEmptyVal(multi('notes')) ? '' : multi('notes');
  return r;
}

function parseBlocks(text, startRe, endRe, fields) {
  const lines = cleanText(text).split('\n');
  const blocks = [];
  let cur = null, field = null;
  const hasMarkers = lines.some((l) => startRe.test(l.trim()));
  const begin = () => { cur = {}; field = null; blocks.push(cur); };
  if (!hasMarkers) begin();
  for (const line of lines) {
    const t = line.trim();
    if (startRe.test(t)) { begin(); continue; }
    if (endRe.test(t)) { cur = null; field = null; continue; }
    if (!cur) continue;
    const f = fieldOf(t, fields);
    if (f) {
      // Без маркеров: новое «Название:» при уже заполненном — начинаем следующую карточку
      if (!hasMarkers && f.f === 'name' && cur.name) begin();
      field = f.f;
      cur[field] = cur[field] || [];
      if (f.rest) cur[field].push(f.rest);
      continue;
    }
    if (field && t) cur[field].push(t);
  }
  return blocks.filter((b) => Object.keys(b).length);
}

// → массив черновиков ТТК
export function parseRecipesText(text) {
  const blocks = parseBlocks(text, /^=+\s*ТТК\s*=*$/i, /^=+\s*(конец|end)\s*=*$/i, RECIPE_FIELDS);
  return blocks.map(recipeFromFields).filter((r) => r.name || r.ingredients.length || r.steps.length);
}

// ТТК → текст (для «Поделиться» и «Копировать»). Совпадает с форматом вставки.
export function recipeToText(r, { factor = 1, scaledNote = '' } = {}) {
  const L = [];
  const k = factor || 1;
  const n = (v) => (v == null ? '' : fmtNum(v * k).replace(/\s/g, ''));
  L.push('=== ТТК ===');
  L.push('Название: ' + (r.name || ''));
  L.push('Категория: ' + (nameOf('categories', r.categoryId) || ''));
  L.push('Источник: ' + (nameOf('restaurants', r.sourceId) || ''));
  if (scaledNote) L.push('Пересчёт: ' + scaledNote);
  L.push('Выход: ' + (r.yieldAmount != null ? `${n(r.yieldAmount)} ${r.yieldUnit || 'г'}` : ''));
  L.push('Порций: ' + (r.portions != null ? fmtNum(r.portions * k).replace(/\s/g, '') : ''));
  L.push('Ингредиенты (продукт | нетто | ед. | отход):');
  for (const i of r.ingredients || []) {
    const w = i.waste == null ? '' : i.wasteMode === 'pct' ? `${fmtNum(i.waste, 1)}%` : `${n(i.waste)} ${i.unit || 'г'}`;
    L.push(`- ${i.name} | ${n(i.netto)} | ${i.unit || 'г'}${w ? ` | ${w}` : ''}`);
  }
  L.push('Технология:');
  (r.steps || []).forEach((s, idx) => L.push(`${idx + 1}. ${s}`));
  L.push('Подача: ' + (r.serving || ''));
  L.push('Хранение: ' + (r.storage || ''));
  if (r.notes) L.push('Примечания: ' + r.notes);
  L.push('=== КОНЕЦ ===');
  return L.join('\n');
}

// ---- Идеи ------------------------------------------------------------------------------------
const IDEA_FIELDS = [
  ['name', /^(название|идея|блюдо)$/],
  ['category', /^(категория|раздел)$/],
  ['status', /^(статус)$/],
  ['description', /^(описание|суть|подробности|заметки)$/],
];

export function parseIdeasText(text) {
  const clean = cleanText(text);
  const startRe = /^=+\s*ИДЕЯ\s*=*$/i;
  const hasMarkers = clean.split('\n').some((l) => startRe.test(l.trim()));
  const hasFields = /^\s*название\s*[:：]/im.test(clean);
  let ideas;
  if (hasMarkers || hasFields) {
    ideas = parseBlocks(clean, startRe, /^=+\s*(конец|end)\s*=*$/i, IDEA_FIELDS).map((b) => ({
      title: (b.name || []).join(' ').trim(),
      description: (b.description || []).join('\n').trim(),
      categoryId: refByName('categories', (b.category || []).join(' ')),
      status: parseStatus((b.status || []).join(' ')),
    }));
  } else {
    // Простой список: одна строка — одна идея; «Название — описание»
    ideas = clean.split('\n').map((l) => l.replace(/^\s*(?:[-–—•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)\s+[—–-]\s+(.+)$/) || l.match(/^(.{3,80}?):\s+(.+)$/);
      return { title: (m ? m[1] : l).trim(), description: m ? m[2].trim() : '', categoryId: '', status: 'idea' };
    });
  }
  return ideas.filter((i) => i.title);
}

// ---- Инструкции-шаблоны для Claude (их же можно скопировать в приложении) -----------
export const CLAUDE_TTK_PROMPT = `Я пришлю фото технико-технологических карт (ТТК). Перепиши каждую карту строго в этом формате — без вступлений, пояснений и markdown, только текст карт:

=== ТТК ===
Название: <название блюда>
Категория: <Закуски / Салаты / Супы / Горячее / Гарниры / Соусы / Десерты / Выпечка / Заготовки / Напитки — если не ясно, оставь пустым>
Источник: <ресторан, если указан на карте; иначе пусто>
Выход: <число и единица, например 250 г>
Порций: <число>
Ингредиенты:
- <продукт> | <нетто> | <ед.>
Технология:
1. <шаг>
2. <шаг>
Подача: <как подавать>
Хранение: <условия и сроки хранения>
Примечания: <всё остальное важное с карты>
=== КОНЕЦ ===

Правила:
1. Каждый ингредиент — отдельная строка: продукт | нетто | единица (г, кг, мл, л или шт). Брутто не пиши — только нетто.
2. Числа пиши как на карте, десятичные — через запятую (0,150). Единицу бери из шапки таблицы (г или кг) — не переводи.
3. Если нетто нет на карте — оставь место пустым: - Соль | | г
4. Строки «Итого» и «Выход» из таблицы в ингредиенты не пиши — выход укажи в поле «Выход».
5. Если на карте есть расход на 1 порцию и на 10 порций — бери на 1 порцию и пиши «Порций: 1».
6. Ничего не придумывай: если что-то не видно или не указано — оставь поле пустым. Неразборчивое слово пометь знаком (?).
7. Если карт несколько — повтори блок от «=== ТТК ===» до «=== КОНЕЦ ===» для каждой.`;

export const CLAUDE_IDEAS_PROMPT = `Когда я прошу идеи блюд, отвечай списком строго в этом формате — без вступлений и markdown, только блоки идей:

=== ИДЕЯ ===
Название: <короткое название блюда>
Категория: <Закуски / Салаты / Супы / Горячее / Гарниры / Соусы / Десерты / Выпечка / Заготовки / Напитки>
Статус: идея
Описание: <2–4 предложения: основа, вкусовой акцент, подача, сезонность или фишка>
=== КОНЕЦ ===

Правила:
1. Каждая идея — отдельный блок от «=== ИДЕЯ ===» до «=== КОНЕЦ ===».
2. Статус всегда «идея», если я не попросил другое (возможны: идея, в работе, тест, в меню, отложено).
3. Описание можно в несколько строк, но без пустых строк внутри.
4. Не добавляй ничего до первого блока и после последнего.`;
