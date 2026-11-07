// Мок Telegram WebApp с честными лимитами CloudStorage
(function(){
  const store = window.__cloud = window.__cloud || {};
  const persisted = localStorage.getItem('__mockcloud');
  if (persisted) Object.assign(store, JSON.parse(persisted));
  const save = () => localStorage.setItem('__mockcloud', JSON.stringify(store));
  window.__cloudStats = { sets: 0, failAfter: Infinity };
  const later = (fn) => setTimeout(fn, 5);
  const keyOk = (k) => /^[A-Za-z0-9_-]{1,128}$/.test(k);
  const CS = {
    setItem(k, v, cb) { later(() => {
      if (!keyOk(k)) return cb('KEY_INVALID');
      if (typeof v !== 'string' || v.length > 4096) return cb('VALUE_TOO_LONG');
      if (!(k in store) && Object.keys(store).length >= 1024) return cb('STORAGE_KEYS_LIMIT');
      if (window.__cloudStats.sets >= window.__cloudStats.failAfter) return cb('NETWORK_ERROR');
      window.__cloudStats.sets++;
      store[k] = v; save(); cb(null, true); }); },
    getItem(k, cb) { later(() => cb(null, store[k] ?? '')); },
    getItems(ks, cb) { later(() => { if (ks.length > 100) return cb('TOO_MANY'); const o = {}; ks.forEach(k => o[k] = store[k] ?? ''); cb(null, o); }); },
    removeItem(k, cb) { later(() => { delete store[k]; save(); cb && cb(null, true); }); },
    removeItems(ks, cb) { later(() => { ks.forEach(k => delete store[k]); save(); cb && cb(null, true); }); },
    getKeys(cb) { later(() => cb(null, Object.keys(store))); },
  };
  const noop = () => {};
  const btn = { _cb: null, isVisible: false, show(){ this.isVisible = true; return this; }, hide(){ this.isVisible = false; return this; }, onClick(cb){ this._cb = cb; return this; } };
  window.__events = [];
  window.Telegram = { WebApp: {
    initData: 'query_id=TEST&user=%7B%22id%22%3A1%7D&hash=x', version: '8.0', platform: 'android', colorScheme: 'light',
    themeParams: {}, isVersionAtLeast: (v) => parseFloat(v) <= 8.0,
    ready: noop, expand: noop, close: noop,
    disableVerticalSwipes(){ window.__events.push('disableVerticalSwipes'); },
    enableClosingConfirmation(){ window.__events.push('closingConfirm:on'); }, disableClosingConfirmation(){ window.__events.push('closingConfirm:off'); },
    setHeaderColor: noop, setBackgroundColor: noop, setBottomBarColor: noop, onEvent: noop,
    BackButton: btn, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
    showPopup(p, cb) { window.__events.push('popup:' + p.message); setTimeout(() => cb(window.__popupAnswer ?? p.buttons[0].id), 10); },
    openTelegramLink(u) { window.__events.push('tglink:' + u.slice(0, 80)); },
    openLink(u) { window.__events.push('link:' + u); },
    CloudStorage: CS,
  }};
})();
