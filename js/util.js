// Общие мелкие помощники

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Безопасный шаблон HTML: всё подставленное экранируется, кроме raw()/html``.
export class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s ?? ''));
function part(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// «1 250,5» → 1250.5 ; пусто/мусор → null
export function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[\s  ]/g, '').replace(',', '.');
  const m = s.match(/-?\d*\.?\d+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return isFinite(n) ? n : null;
}

// Красивое число по-русски: 1 250 / 12,5 / 0,15
export function fmtNum(n, maxFrac) {
  if (n == null || !isFinite(n)) return '';
  const a = Math.abs(n);
  const frac = maxFrac ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: frac });
}

// Для поиска: нижний регистр, ё→е, лишние пробелы
export const norm = (s) =>
  String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];

export function dateISO(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export const weekdayIdx = (d) => (d.getDay() + 6) % 7; // 0 = Пн
export const fmtDayLong = (d) => `${WEEKDAYS[weekdayIdx(d)]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const today = dateISO() === dateISO(d);
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return today ? `сегодня в ${t}` : `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${t}`;
}

// Быстрый хэш строки (cyrb53) — для проверки целостности
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Единицы измерения
export const UNITS = ['г', 'кг', 'мл', 'л', 'шт'];
export function normUnit(u) {
  const s = norm(u).replace(/\.$/, '');
  if (!s) return '';
  if (/^(г|гр|грамм[а-яё]*|g)$/.test(s)) return 'г';
  if (/^(кг|килограмм[а-яё]*|kg)$/.test(s)) return 'кг';
  if (/^(мл|миллилитр[а-яё]*|ml)$/.test(s)) return 'мл';
  if (/^(л|литр[а-яё]*|l)$/.test(s)) return 'л';
  if (/^(шт|штук[а-яё]*|штука|pcs)$/.test(s)) return 'шт';
  return '';
}
// В «базовые» единицы: масса в г, объём в мл
export function toBase(v, unit) {
  if (v == null) return null;
  if (unit === 'кг') return { fam: 'mass', v: v * 1000 };
  if (unit === 'г') return { fam: 'mass', v };
  if (unit === 'л') return { fam: 'vol', v: v * 1000 };
  if (unit === 'мл') return { fam: 'vol', v };
  return { fam: 'pcs', v };
}
export function fmtBase(fam, v) {
  if (fam === 'mass') return v >= 1000 ? `${fmtNum(v / 1000)} кг` : `${fmtNum(v)} г`;
  if (fam === 'vol') return v >= 1000 ? `${fmtNum(v / 1000)} л` : `${fmtNum(v)} мл`;
  return `${fmtNum(v)} шт`;
}

export const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
export async function dataURLToBlob(url) {
  const r = await fetch(url);
  return r.blob();
}

// localStorage может быть недоступен в некоторых WebView — не падаем
export function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* нет */ } }
