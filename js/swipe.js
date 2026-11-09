// Свайп назад: на вложенном экране ведёте пальцем вправо — экран уезжает за пальцем,
// отпустили дальше трети экрана или быстро смахнули — возврат на предыдущий экран.
// Не срабатывает: на главных экранах вкладок, при открытом окне снизу, в полях ввода
// и там, где содержимое само прокручивается вбок (ряды фильтров, таблица «Неделя»).

import { top, back, depth } from './ui.js';
import { haptic } from './tg.js';

const START = 10;          // сколько пикселей пройти, чтобы понять направление
const DONE_PART = 0.33;    // доля ширины экрана, после которой отпускание = назад
const FLICK = 0.45;        // px/мс — быстрый смах засчитывается и на коротком расстоянии

let g = null; // текущий жест

function blocked(target) {
  if (depth() <= 1) return true;
  if (document.querySelector('.sheet-wrap, .label-view, .viewer, .busy')) return true;
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && target.closest('input, textarea, select')) return true;
  if (target.closest('input[type=range], [data-noswipe]')) return true;
  for (let p = target; p && p !== document.body; p = p.parentElement) {
    const ox = getComputedStyle(p).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 2) return true;
  }
  return false;
}

// Двигаем детей #screen (а не сам #screen): у фиксированных панелей не должна меняться точка отсчёта
const parts = () => [...document.querySelectorAll('#screen > *'), document.getElementById('title')].filter(Boolean);
function move(dx, animate) {
  const w = window.innerWidth;
  for (const el of parts()) {
    el.style.transition = animate ? 'transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none';
    el.style.transform = dx ? `translateX(${dx}px)` : '';
    el.style.opacity = el.id === 'title' && dx ? String(Math.max(0, 1 - dx / (w * 0.5))) : '';
  }
  document.body.classList.toggle('swiping', !!dx);
}

function onStart(e) {
  if (e.touches.length !== 1) { g = null; return; }
  const t = e.touches[0];
  if (blocked(e.target)) { g = null; return; }
  g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, on: false, lastX: t.clientX, lastT: Date.now(), v: 0 };
}

function onMove(e) {
  if (!g) return;
  if (e.touches.length !== 1) { cancel(); return; }
  const t = e.touches[0];
  const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
  if (!g.on) {
    if (Math.abs(dx) < START && Math.abs(dy) < START) return;
    if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2) g.on = true;
    else { g = null; return; } // вертикальная прокрутка или свайп влево — не наш жест
  }
  e.preventDefault();
  const now = Date.now();
  g.v = (t.clientX - g.lastX) / Math.max(1, now - g.lastT);
  g.lastX = t.clientX; g.lastT = now;
  g.dx = Math.max(0, dx);
  move(g.dx, false);
}

function cancel() { if (g?.on) move(0, true); g = null; }

function onEnd() {
  if (!g) return;
  const st = g; g = null;
  if (!st.on) return;
  const w = window.innerWidth;
  const go = st.dx > w * DONE_PART || (st.v > FLICK && st.dx > 40);
  if (!go) { move(0, true); return; }
  haptic('light');
  const dirty = top()?.isDirty?.();
  if (dirty) { move(0, true); back(); return; } // спросит «Выйти без сохранения?»
  move(w, true);
  setTimeout(() => {
    move(0, false);
    back(true);
    const s = document.getElementById('screen');
    s.classList.add('swipe-in');
    setTimeout(() => s.classList.remove('swipe-in'), 260);
  }, 190);
}

export function initSwipeBack() {
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });
}
