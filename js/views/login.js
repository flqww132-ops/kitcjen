// Экран входа по коду (приложение на экране «Домой» или браузер — без Telegram)

import { html } from '../util.js';
import * as S from '../store.js';
import { setSession, deviceName } from '../auth.js';

export function showLoginScreen({ first = false } = {}) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'login-view';
    box.innerHTML = String(html`<div class="login-box">
      <div class="login-logo">📖</div>
      <h1>Книга кухни</h1>
      <p class="login-lead">Войдите, чтобы здесь были те же данные, что в Telegram.</p>
      <ol class="steps-ol">
        <li>В Telegram откройте «Книгу кухни».</li>
        <li>Настройки → <b>«Получить код входа»</b>.</li>
        <li>Введите код здесь.</li>
      </ol>
      <input class="inp login-inp" id="lcode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000" aria-label="Код входа">
      <div class="login-err" id="lerr"></div>
      <button class="btn primary wide" id="lgo">Войти</button>
      <button class="btn ghost wide" id="lskip">${first ? 'Продолжить без входа' : 'Отмена'}</button>
      ${first ? html`<p class="hint center">Без входа данные хранятся только на этом устройстве.</p>` : ''}
    </div>`);
    document.body.appendChild(box);
    const inp = box.querySelector('#lcode'), err = box.querySelector('#lerr'), go = box.querySelector('#lgo');
    const close = (v) => { box.remove(); resolve(v); };
    inp.addEventListener('input', () => {
      const d = inp.value.replace(/\D/g, '').slice(0, 6);
      inp.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
      err.textContent = '';
      if (d.length === 6) go.click();
    });
    box.querySelector('#lskip').addEventListener('click', () => close(false));
    go.addEventListener('click', async () => {
      const code = inp.value.replace(/\D/g, '');
      if (code.length !== 6) { err.textContent = 'Код — 6 цифр'; return; }
      go.disabled = true; go.textContent = 'Проверяю…';
      try {
        const r = await fetch(S.serverUrl() + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device: deviceName() }) });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) throw new Error(j.message || 'Не получилось войти');
        setSession({ token: j.token, name: j.name || '', userId: j.userId, at: Date.now() });
        await S.resetServerSync();
        go.textContent = 'Загружаю данные…';
        await S.syncNow();
        await S.saveNow();
        close(true);
        location.reload();
      } catch (e) {
        err.textContent = e.message === 'Failed to fetch' ? 'Нет связи с интернетом' : (e.message || String(e));
        go.disabled = false; go.textContent = 'Войти';
      }
    });
    setTimeout(() => inp.focus(), 100);
  });
}
