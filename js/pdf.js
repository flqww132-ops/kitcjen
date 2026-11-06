// ТТК в PDF (A4) с фото. Библиотека jsPDF и шрифт с кириллицей грузятся с CDN только при создании PDF.

import { loadLib } from './importfile.js';
import { photoGet } from './idb.js';
import { fmtNum, blobToDataURL, toBase, fmtBase, fmtDayLong } from './util.js';
import { nameOf } from './store.js';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';
let fontsP = null;
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function loadFonts() {
  if (!fontsP) {
    fontsP = Promise.all(['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map(async (f) => {
      const r = await fetch(FONT_URL + f);
      if (!r.ok) throw new Error('Не удалось загрузить шрифт для PDF');
      return b64(await r.arrayBuffer());
    })).catch((e) => { fontsP = null; throw e; });
  }
  return fontsP;
}

const waste = (b, n) => (b > 0 && n != null ? Math.round(((b - n) / b) * 1000) / 10 : null);
function totals(ings, key, k) {
  const t = {};
  for (const i of ings || []) {
    if (i[key] == null) continue;
    const b = toBase(i[key] * k, i.unit || 'г');
    t[b.fam] = (t[b.fam] || 0) + b.v;
  }
  return ['mass', 'vol', 'pcs'].filter((f) => t[f] > 0).map((f) => fmtBase(f, t[f])).join(' + ') || '—';
}

// r — ТТК; photos — [{ id, kind }] которые включить; factor — коэффициент пересчёта
export async function recipePdf(r, { photos = [], factor = 1, scaledNote = '' } = {}) {
  const lib = await loadLib('jspdf');
  const [reg, bold] = await loadFonts();
  const doc = new lib.jsPDF({ unit: 'mm', format: 'a4' });
  doc.addFileToVFS('DejaVuSans.ttf', reg);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');

  const M = 15, W = 210 - 2 * M, BOTTOM = 297 - M - 6;
  let y = M;
  const k = factor || 1;
  const lh = (size) => size * 0.3528 * 1.32;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const font = (size, b = false, color = [28, 28, 30]) => { doc.setFont('DejaVu', b ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color); };
  const para = (str, { size = 11, b = false, color, indent = 0, gap = 1.5 } = {}) => {
    font(size, b, color);
    for (const ln of doc.splitTextToSize(String(str), W - indent)) { ensure(lh(size)); doc.text(ln, M + indent, y + lh(size) * 0.78); y += lh(size); }
    y += gap;
  };
  const heading = (t) => { y += 3; ensure(12); para(t.toUpperCase(), { size: 10, b: true, color: [217, 86, 11], gap: 1 }); };
  const n = (v) => (v == null ? '—' : fmtNum(v * k));

  // Заголовок
  para(r.name || 'ТТК', { size: 20, b: true, gap: 1 });
  const meta = [nameOf('categories', r.categoryId), nameOf('restaurants', r.sourceId), scaledNote].filter(Boolean).join(' · ');
  if (meta) para(meta, { size: 10, color: [120, 120, 128], gap: 3 });

  // Фото
  const imgs = [];
  for (const p of photos) {
    const rec = await photoGet(p.id).catch(() => null);
    if (rec) imgs.push({ url: await blobToDataURL(rec.blob), w: rec.w || 4, h: rec.h || 3, kind: p.kind });
  }
  if (imgs.length) {
    const single = imgs.length === 1;
    const colW = single ? W : (W - 6) / 2;
    for (let i = 0; i < imgs.length; i += single ? 1 : 2) {
      const row = imgs.slice(i, i + (single ? 1 : 2));
      const hs = row.map((im) => Math.min(colW * (im.h / im.w), single ? 120 : 80));
      const rowH = Math.max(...hs);
      ensure(rowH + 7);
      row.forEach((im, j) => {
        const wImg = hs[j] * (im.w / im.h);
        const x = M + j * (colW + 6) + (colW - wImg) / 2;
        doc.addImage(im.url, 'JPEG', x, y, wImg, hs[j]);
        font(8, false, [120, 120, 128]);
        doc.text(im.kind === 'plating' ? 'Подача' : 'Блюдо', M + j * (colW + 6), y + rowH + 4);
      });
      y += rowH + 8;
    }
  }

  // Ингредиенты
  heading('Ингредиенты');
  const cw = [W - 81, 27, 27, 27];
  const xs = [M, M + cw[0], M + cw[0] + cw[1], M + cw[0] + cw[1] + cw[2]];
  const rowLine = () => { doc.setDrawColor(225, 225, 230); doc.setLineWidth(0.2); doc.line(M, y, M + W, y); };
  font(9, true, [120, 120, 128]);
  ensure(8);
  ['Продукт', 'Брутто', 'Нетто', 'Отход'].forEach((h, i) => doc.text(h, i ? xs[i] + cw[i] - 1 : xs[0], y + 4, i ? { align: 'right' } : undefined));
  y += 6; rowLine();
  for (const i of r.ingredients || []) {
    font(10.5);
    const lines = doc.splitTextToSize(i.name || '', cw[0] - 3);
    const h = lines.length * lh(10.5) + 2.2;
    ensure(h);
    lines.forEach((ln, j) => doc.text(ln, M, y + lh(10.5) * (j + 0.8) + 0.8));
    const u = i.unit || 'г';
    const w = waste(i.brutto, i.netto);
    [i.brutto != null ? `${n(i.brutto)} ${u}` : '—', i.netto != null ? `${n(i.netto)} ${u}` : '—', w == null ? '—' : `${fmtNum(w, 1)}%`]
      .forEach((v, c) => doc.text(v, xs[c + 1] + cw[c + 1] - 1, y + lh(10.5) * 0.8 + 0.8, { align: 'right' }));
    y += h; rowLine();
  }
  y += 2;
  para(`Итого брутто: ${totals(r.ingredients, 'brutto', k)}   ·   нетто: ${totals(r.ingredients, 'netto', k)}`, { size: 10, b: true, gap: 1 });
  const yieldTxt = r.yieldAmount != null ? `${fmtNum(r.yieldAmount * k)} ${r.yieldUnit || 'г'}` : '—';
  para(`Выход: ${yieldTxt}   ·   Порций: ${r.portions ? fmtNum(r.portions * k) : '—'}`, { size: 10, gap: 2 });

  if ((r.steps || []).length) {
    heading('Технология');
    r.steps.forEach((s, idx) => {
      font(11, true, [217, 86, 11]);
      ensure(lh(11));
      doc.text(`${idx + 1}.`, M, y + lh(11) * 0.78);
      para(s, { indent: 7, gap: 1.5 });
    });
  }
  if (r.serving) { heading('Подача'); para(r.serving); }
  if (r.storage) { heading('Условия и сроки хранения'); para(r.storage); }
  if (r.notes) { heading('Примечания'); para(r.notes); }

  // Нижний колонтитул
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font(8, false, [150, 150, 158]);
    doc.text(`Книга кухни · ${r.name || ''} · ${fmtDayLong(new Date())}`, M, 297 - 9);
    doc.text(`${p} / ${pages}`, M + W, 297 - 9, { align: 'right' });
  }
  return doc.output('blob');
}
