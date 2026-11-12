/**
 * Customers view, the customer drawer (also opened from call logs and chats) and the add-customer dialog.
 * An employee can add customers, change a customer's name and notes, and use the phone number; the phone is
 * locked, and there is no delete, archive, handler or bulk action anywhere in this bundle.
 */
export const customersClient = String.raw`
// ---- Shared presentation helpers (also used by the WhatsApp view) -------------------------------------------------------------
const timeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
function parseTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
function dayStartMs(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
function daysAgo(date) { return Math.round((dayStartMs(new Date()) - dayStartMs(date)) / 86400000); }
// Time of day for today, Yesterday, else the date: the way chat lists show a last activity.
function listTimeText(value) {
  const date = parseTime(value);
  if (!date) return '';
  const ago = daysAgo(date);
  if (ago === 0) return timeFormat.format(date);
  if (ago === 1) return 'Yesterday';
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function avatarNode(name, id) {
  let hash = 0;
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const node = element('span', initialsOf(name), 'avatar av' + (hash % 8));
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function setStatus(node, text, isError) {
  node.textContent = text || '';
  node.hidden = !text;
  node.classList.toggle('error-text', Boolean(isError));
}
function featureOffText(error, what) {
  return error && error.code === 'feature_disabled' ? what + ' are turned off. Ask your manager.' : '';
}
function readCustomer(raw) {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.phone !== 'string') throw new Error('The server returned an unreadable customer. Please refresh.');
  return raw;
}

// ---- Customer drawer ---------------------------------------------------------------------------------------------------------------
const customerDrawer = { dialog: null, state: null, token: 0 };
function drawerReset() {
  customerDrawer.dialog = null;
  customerDrawer.state = null;
  customerDrawer.token += 1;
}
lifecycle.signedOut.push(drawerReset);
function ensureDrawer() {
  if (customerDrawer.dialog && customerDrawer.dialog.isConnected) return customerDrawer.dialog;
  const dialog = element('dialog', undefined, 'drawer js-dialog');
  dialog.setAttribute('aria-labelledby', 'drawer-title');
  dialog.addEventListener('close', () => {
    const state = customerDrawer.state;
    customerDrawer.state = null;
    customerDrawer.token += 1;
    if (state && state.opener && state.opener.isConnected) state.opener.focus();
    if (state && state.fromRoute && parseRoute(location.hash).view === 'customers') setHash('customers');
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  customerDrawer.dialog = dialog;
  return dialog;
}
function closeCustomerDrawer() {
  if (customerDrawer.dialog && customerDrawer.dialog.open) customerDrawer.dialog.close();
}
// Opens the drawer for one of the employee's customers. fromRoute: opened by #customers/<id>, so closing restores the list address.
function openCustomer(customerId, opener, options) {
  const dialog = ensureDrawer();
  const settings = options || {};
  const token = ++customerDrawer.token;
  customerDrawer.state = { id: customerId, opener: opener || null, fromRoute: Boolean(settings.fromRoute), customer: null };
  clearNode(dialog);
  const head = element('div', undefined, 'drawer-head');
  const title = element('h2', 'Customer', 'drawer-title');
  title.id = 'drawer-title';
  title.tabIndex = -1;
  const close = iconButton('close', 'Close', 'drawer-close');
  close.addEventListener('click', () => dialog.close());
  head.append(title, close);
  const body = element('div', undefined, 'drawer-body');
  body.append(element('p', 'Loading…', 'muted'));
  dialog.append(head, body);
  if (!dialog.open) dialog.showModal();
  title.focus();
  loadDrawerCustomer(token, customerId, title, body, settings.notice || '');
}
async function loadDrawerCustomer(token, customerId, title, body, notice) {
  try {
    const data = await api('/customers/' + encodeURIComponent(customerId));
    if (token !== customerDrawer.token) return;
    const customer = readCustomer(data.customer);
    customerDrawer.state.customer = customer;
    renderDrawer(token, customer, title, body, notice);
  } catch (error) {
    if (token !== customerDrawer.token || error.status === 401) return;
    clearNode(body);
    const missing = error.status === 404 && error.code !== 'feature_disabled';
    body.append(element('p', missing ? 'This customer is not available.' : featureOffText(error, 'Customers') || errorMessage(error), 'error-text'));
  }
}
function renderDrawer(token, customer, title, body, notice) {
  title.textContent = customer.name;
  clearNode(body);
  const status = element('p', undefined, 'drawer-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  if (notice) setStatus(status, notice, false);

  const form = element('form', undefined, 'drawer-form');
  form.noValidate = true;
  const name = element('input');
  name.type = 'text';
  name.maxLength = 200;
  name.value = customer.name;
  name.required = true;
  name.autocomplete = 'off';
  const phone = element('input');
  phone.type = 'text';
  phone.value = customer.phone;
  phone.readOnly = true;
  phone.setAttribute('aria-describedby', 'phone-lock-note');
  const phoneLabel = fieldLabel('Phone number', phone);
  phoneLabel.firstChild.prepend(icon('lock'));
  phoneLabel.firstChild.className = 'locked-label';
  const lockNote = element('p', 'The phone number identifies the customer and cannot be changed.', 'hint');
  lockNote.id = 'phone-lock-note';
  const notes = element('textarea');
  notes.maxLength = 4000;
  notes.rows = 5;
  notes.value = customer.notes || '';
  const save = element('button', 'Save changes');
  save.type = 'submit';
  save.disabled = true;
  const formError = element('p', undefined, 'error-text');
  formError.setAttribute('role', 'alert');
  formError.hidden = true;
  function changed() { return patchCustomerBody(customer, name.value, notes.value) !== null; }
  function sync() { save.disabled = !changed(); }
  name.addEventListener('input', sync);
  notes.addEventListener('input', sync);
  form.append(fieldLabel('Name', name), phoneLabel, lockNote, fieldLabel('Notes', notes), formError, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const trimmed = name.value.trim();
    if (!trimmed) { setStatus(formError, "Enter the customer's name.", true); name.focus(); return; }
    const patch = patchCustomerBody(customer, name.value, notes.value);
    if (!patch) return;
    save.disabled = true;
    save.textContent = 'Saving…';
    setStatus(formError, '', false);
    try {
      const data = await api('/customers/' + encodeURIComponent(customer.id), { method: 'PATCH', body: patch });
      if (token !== customerDrawer.token) return;
      const updated = readCustomer(data.customer);
      customerDrawer.state.customer = updated;
      customerNotifyChanged(updated);
      renderDrawer(token, updated, title, body, 'Saved.');
      announce('Customer saved.');
    } catch (error) {
      if (token !== customerDrawer.token || error.status === 401) return;
      save.textContent = 'Save changes';
      save.disabled = false;
      setStatus(formError, error.status === 404 ? 'This customer is no longer available.' : errorMessage(error), true);
    }
  });

  const actions = element('div', undefined, 'drawer-actions');
  actions.append(textButton('WhatsApp chat', '', () => { dialogCloseThen(() => { location.hash = '#whatsapp/' + encodeURIComponent(customer.id); }); }, 'chat'));
  const dial = element('a', undefined, 'button secondary');
  dial.href = 'tel:' + customer.phone.replace(/[^0-9+]/g, '');
  dial.append(icon('phone'), document.createTextNode('Dial'));
  actions.append(dial);
  actions.append(textButton('Save contact', 'secondary', () => {
    downloadBlob(new Blob([buildVCard(customer.name, customer.phone)], { type: 'text/vcard;charset=utf-8' }), vcardFileName(customer.name));
    setStatus(status, 'Contact file saved to your downloads.', false);
  }, 'personAdd'));
  actions.append(textButton('Copy phone', 'secondary', async () => {
    const ok = await copyText(customer.phone);
    setStatus(status, ok ? 'Phone number copied.' : 'Could not copy. Select the number and copy it manually.', !ok);
  }, 'copy'));

  const windowNote = element('p', undefined, 'hint');
  const window24 = customer.whatsappWindow;
  windowNote.textContent = window24 && window24.open
    ? 'WhatsApp: you can reply freely until ' + dateText(window24.expiresAt) + '.'
    : 'WhatsApp: the customer has not written in the last 24 hours, so only a template can be sent.';

  const calls = element('section', undefined, 'drawer-section');
  calls.append(element('h3', 'Recent calls'));
  const callList = element('ul', undefined, 'drawer-calls');
  callList.append(element('li', 'Loading…', 'muted'));
  calls.append(callList);

  body.append(status, actions, windowNote, form, calls);
  loadDrawerCalls(token, customer, callList);
}
function dialogCloseThen(work) {
  const dialog = customerDrawer.dialog;
  if (dialog && dialog.open) {
    if (customerDrawer.state) customerDrawer.state.opener = null;
    dialog.close();
  }
  work();
}
async function loadDrawerCalls(token, customer, list) {
  try {
    const data = await api('/customers/' + encodeURIComponent(customer.id) + '/calls?limit=10');
    if (token !== customerDrawer.token) return;
    clearNode(list);
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) { list.append(element('li', 'No calls with this number yet.', 'muted')); return; }
    for (const call of items) {
      const row = element('li', undefined, 'drawer-call');
      row.append(element('span', callTypeNames[call.callType] || 'Call', 'badge'), element('span', dateText(call.startedAt)), element('span', durationText(call.durationSeconds), 'muted'));
      if (call.hasRecording) row.append(element('span', 'Recording', 'badge complete'));
      list.append(row);
    }
  } catch (error) {
    if (token !== customerDrawer.token || error.status === 401) return;
    clearNode(list);
    list.append(element('li', 'Calls could not be loaded.', 'error-text'));
  }
}
function customerNotifyChanged(customer) {
  if (customersApi.applyUpdate) customersApi.applyUpdate(customer);
}
const customersApi = { applyUpdate: null, reload: null };

// ---- Add customer ------------------------------------------------------------------------------------------------------------------
function openAddCustomer(opener) {
  const dialog = element('dialog', undefined, 'js-dialog');
  dialog.setAttribute('aria-labelledby', 'add-title');
  const form = element('form');
  form.noValidate = true;
  const title = element('h2', 'Add customer');
  title.id = 'add-title';
  const name = element('input');
  name.type = 'text';
  name.maxLength = 200;
  name.autocomplete = 'off';
  name.required = true;
  const phone = element('input');
  phone.type = 'tel';
  phone.maxLength = 32;
  phone.inputMode = 'tel';
  phone.autocomplete = 'off';
  phone.required = true;
  phone.setAttribute('aria-describedby', 'add-phone-hint');
  const phoneHint = element('p', 'Include the country code. Ten-digit numbers are saved as India (+91).', 'hint');
  phoneHint.id = 'add-phone-hint';
  const notes = element('textarea');
  notes.maxLength = 4000;
  notes.rows = 4;
  const error = element('p', undefined, 'error-text');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const info = element('p', "The customer is added to your list only. The phone number can't be changed afterwards.", 'hint');
  const cancel = textButton('Cancel', 'secondary', () => dialog.close());
  const submit = element('button', 'Add customer');
  submit.type = 'submit';
  const actions = element('div', undefined, 'actions');
  actions.append(cancel, submit);
  const fields = element('div', undefined, 'dialog-fields');
  fields.append(fieldLabel('Name', name), fieldLabel('Phone number', phone), phoneHint, fieldLabel('Notes (optional)', notes), info, error);
  form.append(title, fields, actions);
  dialog.append(form);
  phone.addEventListener('input', () => {
    const normalized = normalizePhone(phone.value);
    phoneHint.textContent = normalized ? 'Will be saved as ' + normalized.phone : phone.value.trim() ? 'Enter a valid phone number, with country code if it is not an Indian number.' : 'Include the country code. Ten-digit numbers are saved as India (+91).';
    setStatus(error, '', false);
  });
  name.addEventListener('input', () => setStatus(error, '', false));
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener && opener.isConnected) opener.focus();
  });
  let saving = false;
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const problem = validateNewCustomer(name.value, phone.value, notes.value);
    if (problem) { setStatus(error, problem, true); (problem.startsWith('Enter the') ? name : phone).focus(); return; }
    saving = true;
    submit.disabled = true;
    cancel.disabled = true;
    submit.textContent = 'Checking…';
    setStatus(error, '', false);
    try {
      const outcome = await addCustomerFlow(name.value, phone.value, notes.value);
      if (outcome.problem) { setStatus(error, outcome.problem, true); return; }
      dialog.close();
      openCustomer(outcome.customerId, opener, { notice: outcome.notice });
      announce(outcome.notice);
      if (customersApi.reload) customersApi.reload(true);
    } catch (failure) {
      if (failure.status !== 401) setStatus(error, featureOffText(failure, 'Customers') || errorMessage(failure), true);
    } finally {
      saving = false;
      submit.disabled = false;
      cancel.disabled = false;
      submit.textContent = 'Add customer';
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}
// Looks the number up first, exactly like the Android app: yours -> open it, someone else's -> a bare message, free -> create.
async function addCustomerFlow(name, phone, notes) {
  const normalized = normalizePhone(phone).phone;
  const found = await api('/customers/lookup?phone=' + encodeURIComponent(normalized));
  const decision = decideAfterLookup(found);
  if (decision.action === 'open') return { customerId: decision.customerId, notice: 'This number is already in your customers.' };
  if (decision.action === 'other') return { problem: OTHER_HANDLER_MESSAGE };
  try {
    const created = await api('/customers', { method: 'POST', body: createCustomerBody(name, phone, notes) });
    return { customerId: readCustomer(created.customer).id, notice: 'Customer added.' };
  } catch (failure) {
    if (failure.code === 'customer_exists') {
      const existing = failure.customerId || '';
      return existing ? { customerId: existing, notice: 'This number is already in your customers.' } : { problem: OTHER_HANDLER_MESSAGE };
    }
    throw failure;
  }
}

// ---- Customers list -----------------------------------------------------------------------------------------------------------------
views.customers = (() => {
  let ui = null;
  let state = null;
  function reset() { ui = null; state = null; }
  lifecycle.signedOut.push(reset);

  function activityText(customer) {
    const parts = [];
    if (customer.lastMessageAt) parts.push('Message ' + listTimeText(customer.lastMessageAt));
    if (customer.lastCallAt) parts.push('Call ' + listTimeText(customer.lastCallAt));
    return parts.join(' · ');
  }
  function renderRow(customer) {
    const item = element('li', undefined, 'customer-item');
    item.dataset.customerId = customer.id;
    const link = element('a', undefined, 'customer-row');
    link.href = '#customers/' + encodeURIComponent(customer.id);
    link.append(avatarNode(customer.name, customer.id));
    const main = element('span', undefined, 'cr-main');
    main.append(element('strong', customer.name, 'cr-name'), element('span', customer.phone, 'cr-phone'));
    const meta = element('span', undefined, 'cr-meta');
    const text = activityText(customer);
    if (text) meta.append(element('span', text));
    link.append(main, meta);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openCustomer(customer.id, link, { fromRoute: false });
    });
    item.append(link);
    return item;
  }
  function renderList() {
    const nodes = state.items.map(renderRow);
    ui.list.replaceChildren(...nodes);
    ui.more.hidden = !state.nextCursor;
    ui.empty.hidden = state.items.length > 0 || state.loading || Boolean(state.error);
    ui.empty.textContent = state.query ? 'No customers match your search.' : 'You have no customers yet. Add your first customer to get started.';
    ui.list.setAttribute('aria-busy', String(state.loading));
  }
  async function load(reset, silent) {
    if (!state) return;
    const current = state;
    state.controller && state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const version = ++state.version;
    if (reset && !silent) { state.items = []; state.nextCursor = null; }
    state.loading = !silent;
    state.error = '';
    if (!silent) { ui.status.textContent = 'Loading customers…'; ui.error.hidden = true; ui.retry.hidden = true; }
    renderList();
    const params = new URLSearchParams({ limit: '30' });
    if (state.query) params.set('q', state.query);
    if (!reset && state.nextCursor) params.set('cursor', state.nextCursor);
    try {
      const data = await api('/customers?' + params.toString(), { signal: controller.signal });
      if (state !== current || version !== state.version) return;
      const items = (Array.isArray(data.items) ? data.items : []).map(readCustomer);
      state.items = reset ? items : state.items.concat(items);
      state.nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      state.loading = false;
      ui.status.textContent = state.items.length + ' ' + plural(state.items.length, 'customer', 'customers') + (state.nextCursor ? ' shown' : '');
      renderList();
    } catch (error) {
      if (error.name === 'AbortError' || state !== current || version !== state.version || error.status === 401) return;
      state.loading = false;
      if (silent) return;
      state.error = featureOffText(error, 'Customers') || errorMessage(error);
      ui.status.textContent = '';
      setStatus(ui.error, state.error, true);
      ui.retry.hidden = false;
      renderList();
    }
  }
  function mount(root) {
    state = { query: '', items: [], nextCursor: null, loading: false, error: '', version: 0, controller: null };
    const head = element('div', undefined, 'view-head');
    head.append(element('h1', 'Customers'));
    const add = textButton('Add customer', '', () => openAddCustomer(add), 'add');
    head.append(add);
    const searchLabel = element('label', undefined, 'search-field');
    searchLabel.append(element('span', 'Search customer', 'sr-only'));
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'Search customer';
    search.maxLength = 200;
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search customer');
    searchLabel.append(search);
    const bar = element('div', undefined, 'customers-bar');
    bar.append(searchLabel, textButton('Refresh', 'secondary', () => load(true, false), 'refresh'));
    const status = element('p', undefined, 'hint');
    status.setAttribute('role', 'status');
    const error = element('p', undefined, 'notice error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const retry = textButton('Try again', 'secondary', () => load(true, false));
    retry.hidden = true;
    const list = element('ul', undefined, 'customer-list');
    const empty = element('p', undefined, 'empty-state muted');
    empty.hidden = true;
    const more = textButton('Load more', 'secondary', () => load(false, false));
    more.hidden = true;
    root.append(head, bar, status, error, retry, list, empty, more);
    ui = { list, status, error, retry, empty, more, search };
    search.addEventListener('input', debounce(() => {
      const value = search.value.trim();
      if (value === state.query) return;
      state.query = value;
      load(true, false);
    }, 300));
    customersApi.applyUpdate = (customer) => {
      if (!state) return;
      const index = state.items.findIndex((item) => item.id === customer.id);
      if (index >= 0) { state.items[index] = customer; renderList(); }
    };
    customersApi.reload = (silent) => { if (state) return load(true, silent); return undefined; };
    load(true, false);
  }
  return {
    mount,
    show(params) {
      if (!ui) return;
      const id = params.parts[0];
      if (id) openCustomer(id, null, { fromRoute: true });
      else closeCustomerDrawer();
    },
    hide() { closeCustomerDrawer(); },
    refreshQuietly() { if (state && !state.loading && !state.nextCursor && activeView === 'customers') return load(true, true); return undefined; }
  };
})();
lifecycle.liveChange.push(() => views.customers.refreshQuietly());
`;

export const customersStyles = `
.customers-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.search-field { flex: 1 1 280px; max-width: 520px; }
.customer-list { margin: 8px 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 8px; background: var(--white); overflow: hidden; }
.customer-list:empty { display: none; }
.customer-item + .customer-item { border-top: 1px solid var(--line); }
.customer-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; color: inherit; text-decoration: none; }
.customer-row:hover { background: var(--hover); }
.cr-main { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; }
.cr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-phone { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cr-meta { flex: 0 1 auto; color: var(--muted); font-size: 12px; text-align: right; }
.avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%; color: var(--white); font-size: 14px; font-weight: 700; }
.av0 { background: #1b6e5f; } .av1 { background: #5b6bb0; } .av2 { background: #a1557a; } .av3 { background: #b86b2a; }
.av4 { background: #4a7f9e; } .av5 { background: #7a6a3a; } .av6 { background: #8a4f4f; } .av7 { background: #5a7a4a; }
dialog.drawer { width: min(460px, 100%); height: 100%; max-height: 100%; margin: 0 0 0 auto; padding: 0; border-radius: 0; flex-direction: column; overflow: hidden; }
dialog.drawer[open] { display: flex; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.drawer-title { overflow-wrap: anywhere; }
.drawer-body { display: grid; flex: 1 1 auto; align-content: start; gap: 14px; padding: 16px; overflow-y: auto; }
.drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.drawer-form { display: grid; gap: 12px; }
.locked-label { display: inline-flex; align-items: center; gap: 4px; }
.locked-label .icon { width: 14px; height: 14px; }
.drawer-section h3 { margin-bottom: 6px; }
.drawer-calls { margin: 0; padding: 0; list-style: none; }
.drawer-call { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.badge.complete { background: #b9e7cf; color: var(--accent); }
.dialog-fields { display: grid; gap: 12px; margin-top: 12px; }
.drawer-status:empty { display: none; }
.drawer-status { color: var(--accent); font-size: 13px; }
@media (max-width: 760px) { .cr-meta { display: none; } }
`;
