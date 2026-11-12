/**
 * Pure logic of the employee web app, written as plain JavaScript so the very same source runs in the browser
 * (concatenated into the client script) and in the unit tests (`new Function`). No DOM, no timers of its own:
 * everything environmental (fetch, timers, clock) is injected. Rules mirror the Android app (ChatLogic.kt,
 * LivePolling.kt, CustomerForms.kt) and the server (normalizePhone in data/customers.ts).
 *
 * The source must not contain backticks or dollar-brace sequences: it is embedded in a template literal.
 */
export const logicJavaScript = String.raw`
const CSRF_HEADER = 'X-Linekeep-CSRF';
const callTypeNames = { incoming: 'Incoming', outgoing: 'Outgoing', missed: 'Missed', rejected: 'Rejected', blocked: 'Blocked', voicemail: 'Voicemail', answered_externally: 'Answered externally', unknown: 'Unknown' };

// ---- Phone numbers and customers ----------------------------------------------------------------------------------
// Same rule as the server: ten digits are Indian, eleven digits with a leading zero too, 8 to 15 digits overall.
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  const normalized = digits.length === 10 ? '91' + digits : digits.length === 11 && digits.startsWith('0') ? '91' + digits.slice(1) : digits;
  if (normalized.length < 8 || normalized.length > 15) return null;
  return { phone: '+' + normalized };
}
// First problem with the add-customer form, or '' when it can be submitted.
function validateNewCustomer(name, phone, notes) {
  if (!String(name).trim()) return "Enter the customer's name.";
  if (String(name).trim().length > 200) return 'The name can be up to 200 characters.';
  if (!normalizePhone(phone)) return 'Enter a valid phone number, with 8 to 15 digits.';
  if (String(notes).length > 4000) return 'Notes can be up to 4000 characters.';
  return '';
}
function createCustomerBody(name, phone, notes) {
  const body = { name: String(name).trim(), phone: normalizePhone(phone).phone };
  const text = String(notes).trim();
  if (text) body.notes = text;
  return body;
}
// Only changed fields are sent and never the phone. null when nothing changed.
function patchCustomerBody(original, name, notes) {
  const body = {};
  if (String(name).trim() !== original.name) body.name = String(name).trim();
  if (String(notes).trim() !== (original.notes || '')) body.notes = String(notes).trim();
  return Object.keys(body).length ? body : null;
}
// What the lookup answers mean (same decisions as the Android app).
function decideAfterLookup(result) {
  if (!result || !result.exists) return { action: 'create' };
  if (result.mine && result.customer && result.customer.id) return { action: 'open', customerId: result.customer.id, name: result.customer.name };
  return { action: 'other' };
}
const OTHER_HANDLER_MESSAGE = 'This number already belongs to another handler. Ask your manager.';
function vcardEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
// A minimal vCard 3.0 with name and phone only; lines end in CRLF as RFC 6350/2426 require.
function buildVCard(name, phone) {
  const display = String(name).replace(/[\r\n]+/g, ' ').trim() || String(phone);
  return ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vcardEscape(display) + ';;;;', 'FN:' + vcardEscape(display), 'TEL;TYPE=CELL:' + String(phone).replace(/[^0-9+]/g, ''), 'END:VCARD', ''].join('\r\n');
}
function vcardFileName(name) {
  const base = String(name).normalize('NFKD').replace(/[^A-Za-z0-9._ -]+/g, '').trim().replace(/\s+/g, '-').replace(/\.{2,}/g, '.').replace(/^\./, '').slice(0, 60);
  return (base || 'contact') + '.vcf';
}
function initialsOf(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '#';
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  const letters = (first + last).replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  return letters || '#';
}

// ---- Routes ----------------------------------------------------------------------------------------------------------
const ROUTE_VIEWS = ['customers', 'whatsapp', 'analytics'];
function safeDecode(part) { try { return decodeURIComponent(part); } catch { return part; } }
// '#whatsapp/cus_1', '#analytics/calls?type=missed' -> { view, parts, query }. Unknown views fall back to customers.
function parseRoute(hash) {
  let text = String(hash == null ? '' : hash).replace(/^#\/?/, '');
  const query = Object.create(null);
  const mark = text.indexOf('?');
  if (mark >= 0) {
    for (const [key, value] of new URLSearchParams(text.slice(mark + 1))) if (!(key in query)) query[key] = value;
    text = text.slice(0, mark);
  }
  const parts = text.split('/').filter(Boolean).map(safeDecode);
  const view = ROUTE_VIEWS.includes(parts[0]) ? parts.shift() : 'customers';
  return { view, parts, query };
}
function formatRoute(route) {
  const path = [route.view].concat(route.parts || []).map(encodeURIComponent).join('/');
  const entries = Object.entries(route.query || {}).filter((entry) => entry[1] !== '' && entry[1] != null);
  return '#' + path + (entries.length ? '?' + new URLSearchParams(entries).toString() : '');
}

// ---- Sign-in state machine ------------------------------------------------------------------------------------------
// screens: loading | disabled | unavailable | email | code | app
const RESEND_COOLDOWN_MS = 30000;
function authInitial() { return { screen: 'loading', methods: [], method: 'email', email: '', sentAt: 0, notice: '' }; }
function authReduce(state, event) {
  switch (event.type) {
    case 'session':
      return Object.assign({}, state, { screen: 'app', notice: '' });
    case 'config': {
      if (!event.enabled) return Object.assign({}, state, { screen: 'disabled', methods: [] });
      const methods = (event.methods || []).filter((method) => method === 'email' || method === 'whatsapp');
      if (!methods.length) return Object.assign({}, state, { screen: 'disabled', methods: [] });
      const method = methods.includes(state.method) ? state.method : methods[0];
      return Object.assign({}, state, { screen: state.screen === 'code' ? 'code' : 'email', methods, method });
    }
    case 'configFailed':
      return Object.assign({}, state, { screen: 'unavailable' });
    case 'method':
      return state.methods.includes(event.method) ? Object.assign({}, state, { method: event.method }) : state;
    case 'codeSent':
      return Object.assign({}, state, { screen: 'code', email: event.email, method: event.method || state.method, sentAt: event.at, notice: '' });
    case 'back':
      return Object.assign({}, state, { screen: state.methods.length ? 'email' : 'loading', notice: '' });
    case 'sessionLost':
      // A lost session returns to the email screen once the config is known; until then the boot code reloads it.
      return Object.assign({}, state, { screen: 'loading', notice: event.notice || '', sentAt: 0 });
    case 'signedOut':
      return Object.assign({}, state, { screen: 'loading', notice: event.notice || '', sentAt: 0, email: state.email });
    default:
      return state;
  }
}
// Milliseconds until a new code may be requested (0 when allowed).
function resendRemaining(sentAt, now, cooldownMs) {
  if (!sentAt) return 0;
  return Math.max(0, sentAt + (cooldownMs == null ? RESEND_COOLDOWN_MS : cooldownMs) - now);
}
function normalizeEmail(value) { return String(value == null ? '' : value).trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254; }
// The six digits of a pasted or typed code, or '' when it does not contain exactly six.
function cleanCode(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length === 6 ? digits : '';
}

// ---- API client with session and CSRF handling --------------------------------------------------------------------------
// deps: { fetch, getCsrf(): string, onUnauthorized(error), base }. Non-GET requests carry the CSRF header; a 401 on a
// request that is not part of signing in reports the lost session (once per burst) and still throws.
function createApiClient(deps) {
  const base = deps.base || '/v1/web';
  let reported = false;
  function failure(response, data, fallback) {
    const detail = data && data.error && typeof data.error.message === 'string' ? data.error.message : fallback;
    const error = new Error(detail);
    error.status = response.status;
    error.code = data && data.error && typeof data.error.code === 'string' ? data.error.code : '';
    error.requestId = data && typeof data.requestId === 'string' ? data.requestId : '';
    const existing = data && data.error && typeof data.error.customerId === 'string' ? data.error.customerId : data && typeof data.customerId === 'string' ? data.customerId : '';
    if (existing) error.customerId = existing;
    const wait = Number(response.headers && response.headers.get ? response.headers.get('Retry-After') : NaN);
    error.retryAfter = Number.isFinite(wait) && wait > 0 ? wait : 0;
    return error;
  }
  async function request(path, options) {
    options = options || {};
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { Accept: 'application/json' };
    let body;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      if (options.contentType) headers['Content-Type'] = options.contentType;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    if (method !== 'GET' && method !== 'HEAD' && !options.public) {
      const token = deps.getCsrf();
      if (token) headers[CSRF_HEADER] = token;
    }
    let response;
    try {
      response = await deps.fetch(base + path, { method, headers, body, signal: options.signal, credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      const lost = new Error('Cannot reach the server. Check your connection and try again.');
      lost.status = 0;
      lost.code = 'network';
      throw lost;
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = failure(response, data, response.status === 401 ? 'Your session has ended.' : 'The server rejected this request.');
      if (response.status === 401 && !options.public && !reported) {
        reported = true;
        deps.onUnauthorized(error);
      }
      throw error;
    }
    if (data === null) {
      const error = failure(response, null, 'The server returned an unreadable answer. Please try again.');
      error.code = 'unreadable';
      throw error;
    }
    reported = false;
    return data;
  }
  return { request, base };
}

// ---- Live refresh policy (LivePolling.kt) ------------------------------------------------------------------------------
const POLL_ERROR_MAX_MS = 60000;
const POLL_BROWSING = { baseMs: 15000, idleMaxMs: 60000, graceUnchanged: 2 };
const POLL_CONVERSATION = { baseMs: 5000, idleMaxMs: 20000, graceUnchanged: 6 };
function pollDoubled(base, times) { return base * Math.pow(2, Math.min(times, 20)); }
function nextPollDelay(policy, unchangedStreak, failureStreak) {
  if (failureStreak > 0) return Math.min(pollDoubled(policy.baseMs, failureStreak), POLL_ERROR_MAX_MS);
  const beyond = unchangedStreak - policy.graceUnchanged;
  if (beyond <= 0) return policy.baseMs;
  return Math.min(pollDoubled(policy.baseMs, beyond), Math.max(policy.idleMaxMs, policy.baseMs));
}
// One polling loop. deps: { schedule(fn, ms) -> handle, cancel(handle), hidden() -> bool, policy() -> policy,
// check() -> Promise<boolean> (true when something changed; throws on failure) }.
function createPoller(deps) {
  let handle = null;
  let running = false;
  let busy = false;
  let unchanged = 0;
  let failures = 0;
  function plan(delay) {
    if (handle !== null) deps.cancel(handle);
    handle = null;
    if (!running || deps.hidden()) return;
    handle = deps.schedule(tick, delay == null ? nextPollDelay(deps.policy(), unchanged, failures) : delay);
  }
  async function tick() {
    handle = null;
    if (!running || busy || deps.hidden()) return;
    busy = true;
    try {
      const changed = await deps.check();
      failures = 0;
      unchanged = changed ? 0 : unchanged + 1;
    } catch {
      failures += 1;
    }
    busy = false;
    plan();
  }
  return {
    start() { running = true; unchanged = 0; failures = 0; plan(); },
    stop() { running = false; if (handle !== null) deps.cancel(handle); handle = null; },
    // A user action or a visible tab again: poll soon and forget the idle back-off.
    poke(delay) { unchanged = 0; if (running) plan(delay == null ? 0 : delay); },
    visibility() { if (deps.hidden()) { if (handle !== null) deps.cancel(handle); handle = null; } else if (running) { unchanged = 0; plan(0); } },
    state() { return { running, busy, unchanged, failures, scheduled: handle !== null }; }
  };
}

// ---- Quick replies and templates (ChatLogic.kt) ---------------------------------------------------------------------------
const QUICK_PLACEHOLDER = /\{\{\s*(name|handler_name|handler_phone)\s*\}\}/g;
// Replaces {{name}}, {{handler_name}} and {{handler_phone}}; a placeholder without a value stays as typed and is reported.
function fillQuickPlaceholders(text, values) {
  const missing = [];
  const filled = String(text).replace(QUICK_PLACEHOLDER, (whole, key) => {
    const value = String(values[key] || '').trim();
    if (value) return value;
    if (!missing.includes(key)) missing.push(key);
    return whole;
  });
  return { text: filled, missing };
}
// Meta rejects tabs and newlines inside a variable.
function cleanVariable(value) { return String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' '); }
function defaultVariableSource(key, index) {
  if (key === '2') return 'handler_phone';
  if (key === '1' || index === 0) return 'handler_name';
  if (index === 1) return 'handler_phone';
  return 'custom';
}
function variableSourceValue(source, context) {
  const value = source === 'handler_name' ? context.handlerName : source === 'handler_phone' ? context.handlerPhone : source === 'customer_name' ? context.customerName : '';
  return cleanVariable(value).trim();
}
function initialTemplateValues(template, context) {
  return template.variables.map((variable, index) => variableSourceValue(defaultVariableSource(variable.key, index), context));
}
function templateNeedsHeader(template) { return template.headerFormat === 'IMAGE' || template.headerFormat === 'VIDEO' || template.headerFormat === 'DOCUMENT'; }
// The text the customer will see; unfilled variables stay as typed.
function renderTemplateText(template, values) {
  const byKey = {};
  template.variables.forEach((variable, index) => { byKey[variable.key] = String(values[index] == null ? '' : values[index]); });
  const fill = (text) => String(text).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key) => (Object.hasOwn(byKey, key) && byKey[key].trim() ? byKey[key] : whole));
  return [template.header, template.body, template.footer].filter(Boolean).map(fill).join('\n');
}
// Why the template cannot be sent yet with these values, or '' when it can.
function templateProblem(template, values, headerOverride) {
  if (!template.sendable) return template.reason || 'This template cannot be sent from here yet.';
  if (template.variables.some((variable, index) => !String(values[index] == null ? '' : values[index]).trim())) return 'Fill in every variable.';
  if (values.some((value) => String(value).length > 1024)) return 'A variable can be up to 1024 characters.';
  if (templateNeedsHeader(template) && !template.headerImageConfigured && !headerOverride) return 'Choose a header file.';
  return '';
}
function templateSendBody(clientMessageId, template, values, headerAttachmentId) {
  const inner = { name: template.name, language: template.language, params: template.variables.map((variable, index) => cleanVariable(values[index]).trim()) };
  if (headerAttachmentId) inner.headerAttachmentId = headerAttachmentId;
  return { clientMessageId, template: inner };
}
function textSendBody(clientMessageId, text) { return { clientMessageId, text }; }
function mediaSendBody(clientMessageId, attachmentId, caption) {
  const body = { clientMessageId, type: 'media', attachmentId };
  const text = String(caption || '').trim();
  if (text) body.caption = text;
  return body;
}

// ---- Attachments -------------------------------------------------------------------------------------------------------------
const ATTACH_MAX_BYTES = 16 * 1024 * 1024;
const ATTACH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const ATTACH_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/csv']
};
function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}
function attachAccept(kinds) { return kinds.flatMap((kind) => ATTACH_TYPES[kind]).join(','); }
// A message when the file cannot be sent, otherwise ''.
function attachProblem(file, kinds) {
  const type = String(file.type || '').split(';')[0].trim().toLowerCase();
  if (!kinds.some((kind) => ATTACH_TYPES[kind].includes(type))) return 'This file type cannot be sent on WhatsApp. Choose a photo, MP4 video, PDF, Office file, text or CSV.';
  if (file.size <= 0) return 'This file is empty.';
  if (ATTACH_TYPES.image.includes(type) && file.size > ATTACH_IMAGE_MAX_BYTES) return 'Photos can be up to 5 MB (this one is ' + fileSizeText(file.size) + ').';
  if (file.size > ATTACH_MAX_BYTES) return 'Files can be up to 16 MB (this one is ' + fileSizeText(file.size) + ').';
  return '';
}
function attachmentKindOf(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return ATTACH_TYPES.image.includes(type) ? 'image' : type === 'video/mp4' ? 'video' : 'document';
}

// ---- Conversation presentation ------------------------------------------------------------------------------------------------
function dayKey(date) { return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate(); }
// Newest-first messages -> chronological rows [{ day: Date|null, message }] where day is set on the first message of each day.
function conversationRows(messages) {
  const ordered = messages.slice().reverse();
  let previous = '';
  return ordered.map((message) => {
    const date = new Date(message.sentAt);
    const valid = !Number.isNaN(date.getTime());
    const key = valid ? dayKey(date) : '';
    const day = valid && key !== previous ? date : null;
    if (valid) previous = key;
    return { day, message };
  });
}
function mergeMessages(current, incoming) {
  const seen = new Map();
  for (const message of current) seen.set(message.id, message);
  for (const message of incoming) seen.set(message.id, message);
  return Array.from(seen.values()).sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.id < b.id ? 1 : -1));
}
function unreadLabel(count) { return count > 99 ? '99+' : String(count); }
function newClientMessageId(random) {
  if (random && typeof random.randomUUID === 'function') return random.randomUUID();
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
`;
