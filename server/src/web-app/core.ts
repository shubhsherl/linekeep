/**
 * Runtime shared by every view of the employee web app: DOM helpers, the API client bound to the session, the
 * sign-in screens, the app shell (navigation, user menu, router) and the live-refresh poller. Concatenated after
 * logic.ts and before the views, so it may use every function of logic.ts. No backticks or dollar-brace sequences.
 */
export const coreClient = String.raw`
const byId = (id) => document.getElementById(id);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function clearNode(node) { node.replaceChildren(); }
function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'The request could not be completed. Please try again.';
}
function dateText(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not available';
}
function durationText(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'Not available';
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}
function plural(count, one, many) { return count === 1 ? one : many; }
function debounce(work, wait) {
  let timer = 0;
  return function () {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => work.apply(null, args), wait);
  };
}

// ---- Icons (constants only; all data is rendered with textContent) --------------------------------------------------------
const ICONS = {
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  send: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
  document: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  tick: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  ticks: 'M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z',
  alert: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.5 5v5.25l4.5 2.67-.75 1.23L11 13V7h1.5z',
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
  paperclip: 'M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z',
  phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  personAdd: 'M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  chat: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  chevron: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
  template: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z'
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
function iconButton(name, label, className) {
  const button = element('button', undefined, 'icon-btn' + (className ? ' ' + className : ''));
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}
function textButton(label, className, handler, iconName) {
  const button = element('button', undefined, className || '');
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  button.append(document.createTextNode(label));
  if (handler) button.addEventListener('click', handler);
  return button;
}

// ---- Announcements, toast, clipboard, downloads --------------------------------------------------------------------------------
function announce(text) {
  const live = byId('live');
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 30);
}
let toastTimer = 0;
function toast(text, isError) {
  const node = byId('toast');
  node.textContent = text;
  node.className = 'toast' + (isError ? ' toast-error' : '');
  node.hidden = false;
  announce(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = element('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'clip-area';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- Session and API ------------------------------------------------------------------------------------------------------------
// The CSRF token lives in memory only. The session cookie is HttpOnly and never visible to this script.
const session = { employee: null, csrf: '', expiresAt: 0 };
const views = {};
const lifecycle = { signedIn: [], signedOut: [], liveChange: [] };
const apiClient = createApiClient({
  fetch: (url, init) => fetch(url, init),
  getCsrf: () => session.csrf,
  onUnauthorized: () => endSession('Your session has ended. Sign in again to continue.')
});
function api(path, options) { return apiClient.request(path, options); }
function setHash(path) {
  const next = '#' + path;
  if (location.hash !== next) history.replaceState(null, '', location.pathname + location.search + next);
}

// ---- Sign-in screens ---------------------------------------------------------------------------------------------------------------
let auth = authInitial();
let resendTimer = 0;
const EMAIL_KEY = 'linekeep.web.email';
function rememberedEmail() { try { return localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; } }
function rememberEmail(email) { try { localStorage.setItem(EMAIL_KEY, email); } catch { /* Remembering the address is optional. */ } }
function dispatchAuth(event) {
  auth = authReduce(auth, event);
  renderAuth();
}
function showScreen(name) {
  for (const id of ['screen-loading', 'screen-message', 'screen-signin', 'screen-app']) byId(id).hidden = id !== 'screen-' + name;
}
function authMethodLabel(method) { return method === 'whatsapp' ? 'WhatsApp' : 'Email'; }
function authSentText(method) {
  return method === 'whatsapp'
    ? 'If this email is registered, a six-digit code is on its way on WhatsApp. It is valid for 10 minutes.'
    : 'If this email is registered you will receive a six-digit code by email. It is valid for 10 minutes.';
}
function authFailure(error) {
  if (error.code === 'rate_limited') {
    const seconds = error.retryAfter || 0;
    const wait = !seconds ? '' : seconds <= 90 ? seconds + ' ' + plural(seconds, 'second', 'seconds') : Math.ceil(seconds / 60) + ' minutes';
    return 'Too many attempts. ' + (wait ? 'Try again in ' + wait + '.' : 'Try again later.');
  }
  if (error.code === 'method_unavailable') return 'That way of getting a code is not available. Choose another one.';
  if (error.status === 0) return error.message;
  return 'Something went wrong. Please try again.';
}
function authError(text) {
  const node = byId('auth-error');
  if (node) { node.textContent = text; node.hidden = !text; }
}
function authCard(title, intro) {
  const body = byId('auth-body');
  clearNode(body);
  body.append(element('h1', title, 'auth-title'));
  if (auth.notice) {
    const notice = element('p', auth.notice, 'notice');
    notice.setAttribute('role', 'status');
    body.append(notice);
  }
  if (intro) body.append(element('p', intro, 'lede'));
  return body;
}
function fieldLabel(text, input) {
  const label = element('label');
  label.append(element('span', text), input);
  return label;
}
function renderAuth() {
  clearInterval(resendTimer);
  switch (auth.screen) {
    case 'app': showScreen('app'); return;
    case 'loading': showScreen('loading'); return;
    case 'disabled':
    case 'unavailable': renderAuthMessage(); return;
    case 'code': renderCodeScreen(); return;
    default: renderEmailScreen();
  }
}
function renderAuthMessage() {
  const unavailable = auth.screen === 'unavailable';
  const box = byId('message-body');
  clearNode(box);
  box.append(element('h1', unavailable ? 'Linekeep is unavailable' : 'Web access is not enabled', 'auth-title'));
  box.append(element('p', unavailable ? 'Check your connection and try again.' : 'Web access is not enabled. Ask your manager.', 'lede'));
  if (unavailable) box.append(textButton('Try again', '', () => { dispatchAuth({ type: 'signedOut' }); boot(); }));
  showScreen('message');
}
function renderEmailScreen() {
  const body = authCard('Sign in', 'Use the email address your manager added for you. We will send you a six-digit code.');
  const form = element('form', undefined, 'auth-form');
  form.noValidate = true;
  const email = element('input');
  email.type = 'email';
  email.id = 'auth-email';
  email.name = 'email';
  email.required = true;
  email.autocomplete = 'email';
  email.inputMode = 'email';
  email.maxLength = 254;
  email.spellcheck = false;
  email.value = auth.email || rememberedEmail();
  form.append(fieldLabel('Email address', email));
  let methodInputs = [];
  if (auth.methods.length > 1) {
    const set = element('fieldset', undefined, 'method-choice');
    set.append(element('legend', 'Send the code by'));
    methodInputs = auth.methods.map((method) => {
      const radio = element('input');
      radio.type = 'radio';
      radio.name = 'method';
      radio.value = method;
      radio.checked = method === auth.method;
      const label = element('label', undefined, 'radio-row');
      label.append(radio, element('span', authMethodLabel(method) + ' code'));
      set.append(label);
      return radio;
    });
    form.append(set);
  }
  const error = element('p', undefined, 'error-text');
  error.id = 'auth-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = element('button', 'Send code');
  submit.type = 'submit';
  form.append(error, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = normalizeEmail(email.value);
    if (!validEmail(address)) { authError('Enter a valid email address.'); email.focus(); return; }
    const chosen = methodInputs.find((radio) => radio.checked);
    const method = chosen ? chosen.value : auth.method;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    authError('');
    try {
      await requestCode(address, method);
    } catch (failure) {
      submit.disabled = false;
      submit.textContent = 'Send code';
      authError(authFailure(failure));
    }
  });
  body.append(form);
  showScreen('signin');
  email.focus();
}
async function requestCode(address, method) {
  try {
    await api('/auth/request', { method: 'POST', body: { email: address, method }, public: true });
  } catch (failure) {
    if (failure.code === 'web_disabled') { dispatchAuth({ type: 'config', enabled: false, methods: [] }); }
    throw failure;
  }
  rememberEmail(address);
  dispatchAuth({ type: 'codeSent', email: address, method, at: Date.now() });
}
function renderCodeScreen() {
  const body = authCard('Enter your code', authSentText(auth.method));
  body.append(element('p', auth.email, 'auth-email-shown'));
  const form = element('form', undefined, 'auth-form');
  form.noValidate = true;
  const code = element('input', undefined, 'code-input');
  code.type = 'text';
  code.id = 'auth-code';
  code.name = 'code';
  code.inputMode = 'numeric';
  code.autocomplete = 'one-time-code';
  code.pattern = '[0-9 ]*';
  code.maxLength = 14;
  code.spellcheck = false;
  code.setAttribute('aria-describedby', 'auth-error');
  form.append(fieldLabel('Six-digit code', code));
  const error = element('p', undefined, 'error-text');
  error.id = 'auth-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const verify = element('button', 'Sign in');
  verify.type = 'submit';
  form.append(error, verify);
  let verifying = false;
  async function submitCode() {
    if (verifying) return;
    const digits = cleanCode(code.value);
    if (!digits) { authError('Enter the six digits of your code.'); code.focus(); return; }
    verifying = true;
    verify.disabled = true;
    verify.textContent = 'Checking…';
    authError('');
    try {
      const data = await api('/auth/verify', { method: 'POST', body: { email: auth.email, code: digits }, public: true });
      applySession(data);
    } catch (failure) {
      verifying = false;
      verify.disabled = false;
      verify.textContent = 'Sign in';
      if (failure.code === 'invalid_code') authError('That code is not valid or has expired. Check it, or request a new code.');
      else if (failure.code === 'web_disabled') dispatchAuth({ type: 'config', enabled: false, methods: [] });
      else authError(authFailure(failure));
      code.select();
      code.focus();
    }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); submitCode(); });
  code.addEventListener('input', () => { code.value = code.value.replace(/[^0-9 ]/g, ''); authError(''); });
  code.addEventListener('paste', (event) => {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (cleanCode(text)) { event.preventDefault(); code.value = cleanCode(text); setTimeout(submitCode, 0); }
  });
  body.append(form);
  const actions = element('div', undefined, 'auth-actions');
  const resend = textButton('Send a new code', 'secondary');
  function tickResend() {
    const left = resendRemaining(auth.sentAt, Date.now());
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? 'Send a new code in ' + Math.ceil(left / 1000) + ' s' : 'Send a new code';
  }
  tickResend();
  resendTimer = setInterval(tickResend, 1000);
  async function resendWith(method) {
    resend.disabled = true;
    authError('');
    try {
      await requestCode(auth.email, method);
      toast('If this email is registered, a new code was sent.');
    } catch (failure) {
      authError(authFailure(failure));
      tickResend();
    }
  }
  resend.addEventListener('click', () => resendWith(auth.method));
  actions.append(resend);
  const other = auth.methods.find((method) => method !== auth.method);
  if (other) {
    const alternative = textButton('Send by ' + authMethodLabel(other) + ' instead', 'secondary', () => resendWith(other));
    actions.append(alternative);
  }
  actions.append(textButton('Use a different email', 'secondary', () => dispatchAuth({ type: 'back' })));
  body.append(actions);
  showScreen('signin');
  code.focus();
}
async function loadConfig() {
  try {
    const config = await api('/config', { public: true });
    dispatchAuth({ type: 'config', enabled: config.enabled === true, methods: Array.isArray(config.methods) ? config.methods : [] });
  } catch {
    dispatchAuth({ type: 'configFailed' });
  }
}
function applySession(data) {
  if (!data || !data.employee || typeof data.csrfToken !== 'string') throw new Error('The server returned an unreadable session.');
  session.employee = data.employee;
  session.csrf = data.csrfToken;
  session.expiresAt = Date.parse(data.expiresAt) || 0;
  byId('user-name').textContent = session.employee.name;
  byId('user-initial').textContent = initialsOf(session.employee.name);
  dispatchAuth({ type: 'session' });
  for (const handler of lifecycle.signedIn) handler();
  if (!location.hash || location.hash === '#') history.replaceState(null, '', location.pathname + '#customers');
  showRoute();
  startLive();
}
// Everything an employee saw is removed from memory and the page when the session ends.
function endSession(notice) {
  if (auth.screen !== 'app') return;
  stopLive();
  session.employee = null;
  session.csrf = '';
  session.expiresAt = 0;
  for (const handler of lifecycle.signedOut) handler();
  for (const dialog of Array.from(document.querySelectorAll('dialog'))) {
    if (dialog.open) dialog.close();
    if (dialog.classList.contains('js-dialog')) dialog.remove();
  }
  for (const name of ROUTE_VIEWS) clearNode(byId('view-' + name));
  mountedViews.clear();
  activeView = '';
  history.replaceState(null, '', location.pathname);
  closeUserMenu();
  document.title = 'Linekeep';
  dispatchAuth({ type: 'signedOut', notice });
  loadConfig();
}
async function signOut() {
  closeUserMenu();
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* The session is gone locally either way. */ }
  endSession('You have signed out.');
}

// ---- User menu --------------------------------------------------------------------------------------------------------------------------
function closeUserMenu() {
  byId('user-button').setAttribute('aria-expanded', 'false');
  byId('user-menu').hidden = true;
}
function toggleUserMenu() {
  const open = byId('user-menu').hidden;
  byId('user-button').setAttribute('aria-expanded', String(open));
  byId('user-menu').hidden = !open;
  if (open) byId('sign-out').focus();
}
byId('user-button').addEventListener('click', toggleUserMenu);
byId('sign-out').addEventListener('click', signOut);
document.addEventListener('click', (event) => {
  if (!byId('user-menu').hidden && !event.target.closest('.user-menu')) closeUserMenu();
});
byId('user-menu').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeUserMenu(); byId('user-button').focus(); }
});
byId('user-button').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeUserMenu();
  if (event.key === 'ArrowDown' && byId('user-menu').hidden) { event.preventDefault(); toggleUserMenu(); }
});

// ---- Router ---------------------------------------------------------------------------------------------------------------------------------
const VIEW_TITLES = { customers: 'Customers', whatsapp: 'WhatsApp', analytics: 'Call analytics' };
const mountedViews = new Set();
let activeView = '';
function showRoute() {
  if (auth.screen !== 'app') return;
  const route = parseRoute(location.hash);
  const next = route.view;
  if (activeView && activeView !== next && views[activeView] && views[activeView].hide) views[activeView].hide();
  for (const name of ROUTE_VIEWS) {
    byId('view-' + name).hidden = name !== next;
    const link = byId('nav-' + name);
    if (name === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  const view = views[next];
  if (!mountedViews.has(next)) {
    view.mount(byId('view-' + next));
    mountedViews.add(next);
  }
  activeView = next;
  document.title = VIEW_TITLES[next] + ' · Linekeep';
  view.show({ parts: route.parts, query: route.query });
}
window.addEventListener('hashchange', showRoute);

// ---- Live refresh: one cheap version endpoint, polled; views refresh what is on screen when it changes ------------------------
const live = { conversationOpen: false, version: null, disabled: false };
let poller = null;
function conversationOpenChanged(open) {
  live.conversationOpen = open;
  if (poller) poller.poke(0);
}
async function checkLive() {
  const data = await api('/whatsapp/version');
  if (!data || !Number.isSafeInteger(data.version)) throw new Error('The server returned an unreadable version.');
  const first = live.version === null;
  const changed = !first && data.version !== live.version;
  if (changed) {
    const results = await Promise.all(lifecycle.liveChange.map((handler) => Promise.resolve(handler()).then((ok) => ok !== false, () => false)));
    if (results.some((ok) => !ok)) throw new Error('Refresh failed.');
  }
  live.version = data.version;
  return changed;
}
function startLive() {
  stopLive();
  live.version = null;
  poller = createPoller({
    schedule: (work, delay) => setTimeout(work, delay),
    cancel: (handle) => clearTimeout(handle),
    hidden: () => document.hidden,
    policy: () => (live.conversationOpen ? POLL_CONVERSATION : POLL_BROWSING),
    check: async () => {
      try {
        return await checkLive();
      } catch (error) {
        if (error.status === 404 && error.code === 'feature_disabled') { live.disabled = true; stopLive(); return false; }
        throw error;
      }
    }
  });
  poller.start();
  poller.poke(0);
}
function stopLive() {
  if (poller) poller.stop();
  poller = null;
}
function pokeLive() { if (poller) poller.poke(0); }
document.addEventListener('visibilitychange', () => {
  if (auth.screen !== 'app') return;
  if (poller) poller.visibility();
  if (!document.hidden) api('/session').then((data) => { if (data && typeof data.csrfToken === 'string') session.csrf = data.csrfToken; }, () => {});
});

// ---- Boot ----------------------------------------------------------------------------------------------------------------------------------------
async function boot() {
  try {
    applySession(await api('/session', { public: true }));
    return;
  } catch (failure) {
    if (failure.status === 0) { dispatchAuth({ type: 'configFailed' }); return; }
  }
  await loadConfig();
}
`;
