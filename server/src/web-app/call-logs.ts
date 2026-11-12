// Employee call logs panel: the signed-in employee's own calls, filters, cursor paging and recording playback.
// Both exports are concatenated into one browser script: keep them free of backticks and dollar-brace sequences,
// build DOM with createElement/textContent and style only through classes or CSSOM (no inline style attributes).
// Recordings are play-only: there is no download link and no delete control.

export const callLogsClient = String.raw`
function createCallLogsPanel(container) {
  const TYPES = ['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'answered_externally', 'unknown'];
  const TYPE_NAMES = { incoming: 'Incoming', outgoing: 'Outgoing', missed: 'Missed', rejected: 'Rejected', blocked: 'Blocked', voicemail: 'Voicemail', answered_externally: 'Answered externally', unknown: 'Unknown' };
  const COLUMNS = ['Time', 'Caller', 'Number', 'Type', 'Duration', 'SIM', 'Recording'];
  const FILTER_KEYS = ['type', 'number', 'from', 'to', 'rec'];
  const PAGE_SIZE = 50;
  const STALE_MS = 60000;

  const ui = {};
  let filters = emptyFilters();
  let items = [];
  let seen = new Set();
  let nextCursor = null;
  let loadedAt = 0;
  let loading = false;
  let version = 0;
  let controller = null;
  let retryAction = null;
  let player = null;
  let playerVersion = 0;
  let playbackController = null;

  function pad2(value) { return String(value).padStart(2, '0'); }
  function emptyFilters() { return { type: '', number: '', from: '', to: '', rec: false }; }
  function hasFilters() { return Boolean(filters.type || filters.number || filters.from || filters.to || filters.rec); }
  function lengthText(seconds) {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours ? hours + ':' + pad2(minutes) + ':' + pad2(secs) : minutes + ':' + pad2(secs);
  }
  function isoOrEmpty(value) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }
  // The datetime-local input shows and returns local wall-clock time; the API and the hash use UTC ISO.
  function localInput(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }
  function parseFilters(query) {
    const result = emptyFilters();
    if (TYPES.includes(query.type)) result.type = query.type;
    if (typeof query.number === 'string') result.number = query.number.trim().slice(0, 64);
    result.from = isoOrEmpty(query.from);
    result.to = isoOrEmpty(query.to);
    if (result.from && result.to && result.from > result.to) result.to = '';
    result.rec = query.rec === '1' || query.rec === 'true';
    return result;
  }
  function writeHash() {
    const params = new URLSearchParams();
    if (filters.type) params.set('type', filters.type);
    if (filters.number) params.set('number', filters.number);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.rec) params.set('rec', '1');
    const text = params.toString().replaceAll('%3A', ':').replaceAll('%2C', ',');
    setHash('analytics/calls' + (text ? '?' + text : ''));
  }
  function syncForm() {
    ui.type.value = filters.type;
    ui.number.value = filters.number;
    ui.from.value = localInput(filters.from);
    ui.to.value = localInput(filters.to);
    ui.rec.checked = filters.rec;
  }
  function filterProblem(text, focusNode) {
    ui.filterError.textContent = text;
    ui.filterError.hidden = !text;
    if (text && focusNode) focusNode.focus();
  }

  // ---- Response validation ----
  function readItem(raw) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt)) || typeof raw.callType !== 'string') {
      throw new Error('A call could not be read. Please refresh.');
    }
    const customer = raw.customer && typeof raw.customer.id === 'string' && typeof raw.customer.name === 'string' ? { id: raw.customer.id, name: raw.customer.name } : null;
    return {
      id: raw.id,
      startedAt: raw.startedAt,
      durationSeconds: typeof raw.durationSeconds === 'number' && raw.durationSeconds > 0 ? Math.floor(raw.durationSeconds) : 0,
      callType: raw.callType,
      remoteNumber: typeof raw.remoteNumber === 'string' ? raw.remoteNumber : '',
      callerName: typeof raw.callerName === 'string' ? raw.callerName : '',
      simLabel: typeof raw.simLabel === 'string' ? raw.simLabel : '',
      hasRecording: raw.hasRecording === true,
      customer
    };
  }
  function readPage(raw) {
    if (!raw || !Array.isArray(raw.items)) throw new Error('The server returned an unreadable call list. Please refresh.');
    return { items: raw.items.map(readItem), nextCursor: typeof raw.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor : null };
  }
  function callerLabel(call) { return (call.customer && call.customer.name) || call.callerName || call.remoteNumber || 'Unknown caller'; }

  // ---- Rows ----
  function bodyCell(row, label, className) {
    const cell = element('td', undefined, className);
    cell.dataset.label = label;
    row.append(cell);
    return cell;
  }
  function plainCell(row, label, text, className) {
    const cell = bodyCell(row, label, (className || '') + (text ? '' : ' cl-empty'));
    cell.textContent = text || '–';
    return cell;
  }
  function buildRow(call) {
    const row = element('tr', undefined, 'cl-row');
    plainCell(row, 'Time', dateText(call.startedAt), 'cl-time');
    const caller = bodyCell(row, 'Caller', 'cl-caller');
    if (call.customer) {
      const link = element('button', call.customer.name, 'cl-link');
      link.type = 'button';
      link.title = 'View customer';
      link.addEventListener('click', () => openCustomer(call.customer.id, link));
      caller.append(link);
    } else {
      caller.textContent = callerLabel(call);
    }
    plainCell(row, 'Number', call.remoteNumber, 'cl-num');
    const type = bodyCell(row, 'Type', 'cl-type');
    type.append(element('span', TYPE_NAMES[call.callType] || call.callType, 'cl-badge cl-badge-' + (TYPE_NAMES[call.callType] ? call.callType : 'unknown')));
    plainCell(row, 'Duration', lengthText(call.durationSeconds), 'cl-num');
    plainCell(row, 'SIM', call.simLabel, 'cl-sim');
    const recording = bodyCell(row, 'Recording', 'cl-rec' + (call.hasRecording ? '' : ' cl-empty'));
    if (call.hasRecording) {
      const play = element('button', 'Play', 'secondary cl-play');
      play.type = 'button';
      play.setAttribute('aria-label', 'Play recording of call with ' + callerLabel(call) + ', ' + dateText(call.startedAt));
      play.addEventListener('click', () => startPlayback(call, row, play));
      recording.append(play);
    } else {
      recording.textContent = '–';
    }
    return row;
  }

  // ---- Loading ----
  function setLoading(on, more) {
    loading = on;
    ui.results.setAttribute('aria-busy', on ? 'true' : 'false');
    ui.more.setAttribute('aria-disabled', on && more ? 'true' : 'false');
    ui.more.textContent = on && more ? 'Loading…' : 'Load more';
  }
  function showError(text, action) {
    retryAction = action || null;
    ui.errorText.textContent = text;
    ui.errorBox.hidden = !text;
  }
  function updateStatus() {
    if (!items.length) {
      ui.status.textContent = hasFilters() ? 'No calls match these filters.' : 'No calls yet.';
      return;
    }
    ui.status.textContent = 'Showing ' + items.length.toLocaleString() + ' ' + plural(items.length, 'call', 'calls') + ' · newest first' + (nextCursor ? ' · more available' : ' · all loaded');
  }
  function renderEmpty() {
    const empty = !items.length;
    ui.empty.hidden = !empty;
    ui.tableWrap.hidden = empty;
    ui.emptyText.textContent = hasFilters()
      ? 'Try a wider date range, a shorter number, or clear the filters.'
      : 'Calls from your phone appear here after they are uploaded.';
  }
  function cancelLoad() {
    version++;
    if (controller) controller.abort();
    controller = null;
    if (!loading) return;
    setLoading(false, false);
    ui.skeleton.hidden = true;
    loadedAt = 0;
  }
  async function loadPage(more) {
    if (more && (loading || !nextCursor)) return;
    const mine = ++version;
    if (controller) controller.abort();
    controller = new AbortController();
    const cursor = more ? nextCursor : null;
    const hadFocus = more && document.activeElement === ui.more;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (filters.type) params.set('callType', filters.type);
    if (filters.number) params.set('number', filters.number);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.rec) params.set('hasRecording', 'true');
    if (cursor) params.set('cursor', cursor);
    if (!more) {
      closePlayer();
      items = [];
      seen = new Set();
      nextCursor = null;
      loadedAt = 0;
      ui.body.replaceChildren();
      ui.empty.hidden = true;
      ui.tableWrap.hidden = true;
      ui.skeleton.hidden = false;
      ui.moreRow.hidden = true;
    }
    setLoading(true, more);
    showError('');
    ui.status.textContent = more ? 'Loading more calls…' : 'Loading calls…';
    try {
      const page = readPage(await api('/call-history?' + params.toString(), { signal: controller.signal }));
      if (mine !== version) return;
      if (page.nextCursor && page.nextCursor === cursor) throw new Error('Call history paging did not advance. Refresh to start again.');
      const fragment = document.createDocumentFragment();
      let firstNew = null;
      for (const call of page.items) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        items.push(call);
        const row = buildRow(call);
        if (!firstNew) firstNew = row;
        fragment.append(row);
      }
      ui.body.append(fragment);
      nextCursor = page.nextCursor;
      loadedAt = Date.now();
      ui.skeleton.hidden = true;
      ui.moreRow.hidden = !nextCursor;
      renderEmpty();
      updateStatus();
      if (hadFocus && !nextCursor) {
        const target = firstNew ? firstNew.querySelector('button') : null;
        (target || ui.refresh).focus();
      }
    } catch (error) {
      if (mine !== version || (error && error.name === 'AbortError') || (error && error.status === 401)) return;
      ui.skeleton.hidden = true;
      ui.status.textContent = more ? 'More calls could not be loaded.' : 'Calls could not be loaded.';
      ui.empty.hidden = true;
      ui.tableWrap.hidden = !items.length;
      ui.moreRow.hidden = !nextCursor;
      showError(errorMessage(error), () => loadPage(more));
    } finally {
      if (mine === version) setLoading(false, false);
    }
  }
  function applyFilters() {
    filterProblem('');
    const next = emptyFilters();
    next.type = TYPES.includes(ui.type.value) ? ui.type.value : '';
    next.number = ui.number.value.trim();
    next.rec = ui.rec.checked;
    for (const name of ['from', 'to']) {
      const input = ui[name];
      if (!input.value) continue;
      const date = new Date(input.value);
      if (Number.isNaN(date.getTime())) return filterProblem('Choose a valid date and time.', input);
      next[name] = date.toISOString();
    }
    if (next.from && next.to && next.from > next.to) return filterProblem('The From time must be before or equal to the To time.', ui.to);
    filters = next;
    writeHash();
    loadPage(false);
  }
  function clearFilters() {
    filters = emptyFilters();
    filterProblem('');
    syncForm();
    writeHash();
    loadPage(false);
  }

  // ---- Playback ----
  function playerStatus(text) { ui.playerStatus.textContent = text; }
  async function playbackLink(callId, signal) {
    const link = await api('/call-history/' + encodeURIComponent(callId) + '/recording', { signal });
    if (!link || typeof link.url !== 'string' || typeof link.expiresAt !== 'string') throw new Error('The server returned an invalid playback link.');
    let url;
    try { url = new URL(link.url, location.origin); } catch (error) { throw new Error('The server returned an invalid playback link.'); }
    if ((url.protocol !== 'https:' && !(url.origin === location.origin && url.protocol === 'http:')) || url.username || url.password) throw new Error('The server returned an unsafe playback link.');
    const expiresAt = Date.parse(link.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The playback link has already expired. Please try again.');
    return { url: url.href, expiresAt };
  }
  function closePlayer() {
    playerVersion++;
    if (playbackController) playbackController.abort();
    playbackController = null;
    player = null;
    ui.audio.pause();
    ui.audio.removeAttribute('src');
    ui.audio.load();
    ui.audio.hidden = false;
    ui.playerRow.remove();
    ui.retryPlayback.hidden = true;
    playerStatus('');
  }
  async function refreshPlayback(position) {
    if (!player || player.loading) return;
    const selected = player;
    const mine = playerVersion;
    selected.loading = true;
    ui.audio.pause();
    ui.audio.hidden = false;
    playerStatus('Getting a fresh, private playback link…');
    ui.retryPlayback.hidden = true;
    playbackController = new AbortController();
    try {
      const link = await playbackLink(selected.call.id, playbackController.signal);
      if (mine !== playerVersion || selected !== player) return;
      selected.expiresAt = link.expiresAt;
      selected.position = position || 0;
      ui.audio.src = link.url;
      ui.audio.load();
      selected.loading = false;
      playerStatus('Private link expires ' + dateText(new Date(link.expiresAt).toISOString()) + '.');
      try { await ui.audio.play(); }
      catch (error) {
        if (selected !== player) return;
        if (error.name === 'NotAllowedError') playerStatus('The recording is ready. Press play in the audio controls to start.');
        else if (error.name !== 'AbortError') {
          playerStatus('Playback could not start. Try again, or your browser may not support this audio format.');
          ui.retryPlayback.hidden = false;
        }
      }
    } catch (error) {
      if (mine !== playerVersion || (error && error.name === 'AbortError') || (error && error.status === 401)) return;
      if (error && error.status === 404) {
        ui.audio.hidden = true;
        playerStatus('This recording is no longer available.');
      } else {
        playerStatus(errorMessage(error));
        ui.retryPlayback.hidden = false;
      }
    } finally {
      if (selected === player) selected.loading = false;
    }
  }
  function startPlayback(call, row, playButton) {
    closePlayer();
    player = { call, row, playButton, expiresAt: 0, loading: false, position: 0, retried: false };
    ui.playerTitle.textContent = 'Recording · ' + callerLabel(call) + ' · ' + dateText(call.startedAt);
    row.after(ui.playerRow);
    ui.playerTitle.focus({ preventScroll: true });
    ui.playerRow.scrollIntoView({ block: 'nearest' });
    refreshPlayback(0);
  }
  function buildPlayer() {
    ui.playerRow = element('tr', undefined, 'cl-player-row');
    const cell = element('td');
    cell.colSpan = COLUMNS.length;
    const panel = element('div', undefined, 'panel cl-player');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', 'cl-player-title');
    const head = element('div', undefined, 'section-heading');
    ui.playerTitle = element('h4', undefined, 'cl-player-title');
    ui.playerTitle.id = 'cl-player-title';
    ui.playerTitle.tabIndex = -1;
    const close = element('button', 'Close', 'secondary');
    close.type = 'button';
    close.addEventListener('click', () => {
      const back = player && player.playButton && player.playButton.isConnected ? player.playButton : ui.refresh;
      closePlayer();
      back.focus();
    });
    head.append(ui.playerTitle, close);
    ui.audio = document.createElement('audio');
    ui.audio.controls = true;
    ui.audio.preload = 'none';
    ui.audio.setAttribute('controlsList', 'nodownload noplaybackrate');
    ui.audio.setAttribute('aria-label', 'Call recording');
    ui.playerStatus = element('p', undefined, 'cl-player-status');
    ui.playerStatus.setAttribute('role', 'status');
    ui.playerStatus.setAttribute('aria-live', 'polite');
    ui.retryPlayback = element('button', 'Get a fresh link and retry', 'secondary');
    ui.retryPlayback.type = 'button';
    ui.retryPlayback.hidden = true;
    ui.retryPlayback.addEventListener('click', () => {
      if (!player) return;
      player.retried = false;
      refreshPlayback(ui.audio.currentTime);
    });
    ui.audio.addEventListener('loadedmetadata', () => {
      if (!player || !player.position) return;
      ui.audio.currentTime = Number.isFinite(ui.audio.duration) ? Math.min(player.position, Math.max(0, ui.audio.duration - 0.1)) : player.position;
      player.position = 0;
    });
    ui.audio.addEventListener('play', () => {
      if (player && !player.loading && Date.now() >= player.expiresAt) refreshPlayback(ui.audio.currentTime);
    });
    ui.audio.addEventListener('error', () => {
      if (!player || player.loading || !ui.audio.getAttribute('src')) return;
      if (Date.now() >= player.expiresAt && !player.retried) {
        player.retried = true;
        refreshPlayback(ui.audio.currentTime);
        return;
      }
      playerStatus('This audio could not be played. Get a fresh link and try again.');
      ui.retryPlayback.hidden = false;
    });
    panel.append(head, ui.audio, ui.playerStatus, ui.retryPlayback);
    cell.append(panel);
    ui.playerRow.append(cell);
  }

  // ---- DOM ----
  function buildForm() {
    const form = element('form', undefined, 'panel cl-form');
    form.noValidate = true;
    form.setAttribute('aria-label', 'Filter call logs');
    form.addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
    const grid = element('div', undefined, 'filter-grid cl-filters');
    const typeLabel = element('label', 'Call type');
    ui.type = document.createElement('select');
    ui.type.append(new Option('All types', ''));
    for (const type of TYPES) ui.type.append(new Option(TYPE_NAMES[type], type));
    typeLabel.append(ui.type);
    const numberLabel = element('label', 'Phone number contains');
    ui.number = document.createElement('input');
    ui.number.type = 'search';
    ui.number.maxLength = 64;
    ui.number.autocomplete = 'off';
    ui.number.placeholder = 'Part of a number';
    numberLabel.append(ui.number);
    const fromLabel = element('label', 'From');
    ui.from = document.createElement('input');
    ui.from.type = 'datetime-local';
    fromLabel.append(ui.from);
    const toLabel = element('label', 'To');
    ui.to = document.createElement('input');
    ui.to.type = 'datetime-local';
    toLabel.append(ui.to);
    const recLabel = element('label', undefined, 'cl-check');
    ui.rec = document.createElement('input');
    ui.rec.type = 'checkbox';
    recLabel.append(ui.rec, element('span', 'With recording'));
    const actions = element('div', undefined, 'actions cl-filter-actions');
    const apply = element('button', 'Apply');
    apply.type = 'submit';
    const clear = element('button', 'Clear', 'secondary');
    clear.type = 'button';
    clear.addEventListener('click', clearFilters);
    actions.append(apply, clear);
    grid.append(typeLabel, numberLabel, fromLabel, toLabel, recLabel, actions);
    ui.filterError = element('p', undefined, 'error-text');
    ui.filterError.setAttribute('role', 'alert');
    ui.filterError.hidden = true;
    form.append(grid, element('p', 'Times are in your local time zone. Number search matches any part of the number.', 'hint'), ui.filterError);
    return form;
  }
  function buildList() {
    const toolbar = element('div', undefined, 'cl-toolbar');
    ui.status = element('p', undefined, 'cl-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.status.setAttribute('aria-atomic', 'true');
    ui.refresh = element('button', 'Refresh', 'secondary');
    ui.refresh.type = 'button';
    ui.refresh.addEventListener('click', () => loadPage(false));
    toolbar.append(ui.status, ui.refresh);

    ui.errorBox = element('div', undefined, 'notice error cl-error');
    ui.errorBox.setAttribute('role', 'alert');
    ui.errorBox.hidden = true;
    ui.errorText = element('p', undefined, 'cl-error-text');
    const retry = element('button', 'Retry', 'secondary');
    retry.type = 'button';
    retry.addEventListener('click', () => { if (retryAction) retryAction(); });
    ui.errorBox.append(ui.errorText, retry);

    ui.skeleton = element('div', undefined, 'cl-skeleton');
    ui.skeleton.setAttribute('aria-hidden', 'true');
    ui.skeleton.hidden = true;
    for (let index = 0; index < 5; index++) ui.skeleton.append(element('div', undefined, 'cl-skel'));

    ui.empty = element('div', undefined, 'empty-state');
    ui.empty.hidden = true;
    ui.emptyText = element('p');
    ui.empty.append(element('h3', 'No calls to show'), ui.emptyText);

    ui.tableWrap = element('div', undefined, 'cl-table-wrap');
    ui.tableWrap.hidden = true;
    const table = element('table', undefined, 'cl-table');
    table.append(element('caption', 'Your calls, newest first', 'sr-only'));
    const headRow = element('tr');
    for (const label of COLUMNS) {
      const th = element('th', label);
      th.scope = 'col';
      headRow.append(th);
    }
    const head = element('thead');
    head.append(headRow);
    ui.body = element('tbody');
    table.append(head, ui.body);
    ui.tableWrap.append(table);

    ui.moreRow = element('div', undefined, 'cl-more');
    ui.moreRow.hidden = true;
    ui.more = element('button', 'Load more', 'secondary');
    ui.more.type = 'button';
    ui.more.addEventListener('click', () => {
      if (ui.more.getAttribute('aria-disabled') === 'true') return;
      loadPage(true);
    });
    ui.moreRow.append(ui.more);

    ui.results = element('section', undefined, 'cl-results');
    ui.results.setAttribute('aria-label', 'Call log results');
    ui.results.setAttribute('aria-busy', 'false');
    ui.results.append(toolbar, ui.errorBox, ui.skeleton, ui.empty, ui.tableWrap, ui.moreRow);
    return ui.results;
  }

  container.classList.add('cl-root');
  buildPlayer();
  container.append(buildForm(), buildList());

  return {
    show(query) {
      const source = query || {};
      let changed = false;
      if (FILTER_KEYS.some((key) => typeof source[key] === 'string')) {
        const parsed = parseFilters(source);
        if (JSON.stringify(parsed) !== JSON.stringify(filters)) { filters = parsed; changed = true; }
        syncForm();
      }
      writeHash();
      if (changed || !loadedAt || Date.now() - loadedAt > STALE_MS) loadPage(false);
    },
    hide() {
      closePlayer();
      cancelLoad();
    }
  };
}
`;

export const callLogsStyles = `
.cl-root { display: grid; gap: 12px; min-width: 0; }
.cl-root > * { min-width: 0; }
.cl-filters { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.cl-root label.cl-check { flex-direction: row; align-items: center; gap: 8px; min-height: 32px; color: inherit; font-size: 13px; font-weight: 500; }
.cl-check input { width: 18px; height: 18px; min-height: 0; margin: 0; accent-color: var(--accent); }
.cl-filter-actions { align-self: end; }
.cl-form .hint { margin: 8px 0 0; }
.cl-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.cl-status { margin: 0; min-height: 18px; color: var(--muted); font-size: 12px; }
.cl-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.cl-error-text { margin: 0; overflow-wrap: anywhere; }
.cl-skeleton { display: grid; gap: 8px; }
.cl-skel { min-height: 44px; border: 1px solid var(--line); border-radius: 6px; background: linear-gradient(90deg, #f0f3ee, #f8faf6, #f0f3ee); background-size: 200% 100%; }
.cl-table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.cl-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cl-table th { padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--head); color: var(--muted); font-size: 12px; font-weight: 600; text-align: left; white-space: nowrap; }
.cl-table td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.cl-table tbody tr:last-child td { border-bottom: 0; }
.cl-row:hover td { background: var(--hover); }
.cl-time, .cl-num { font-variant-numeric: tabular-nums; }
.cl-caller { font-weight: 600; }
.cl-root button.cl-link { display: inline; min-height: 24px; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--accent); font: inherit; font-weight: 600; text-align: left; text-decoration: underline; text-underline-offset: 3px; }
.cl-root button.cl-link:hover { background: none; text-decoration-thickness: 2px; }
.cl-root button.cl-play { min-height: 30px; padding: 3px 14px; font-size: 12px; }
.cl-badge { display: inline-block; padding: 1px 7px; border-radius: 4px; background: #ecebe7; color: #4a463f; font-size: 12px; font-weight: 600; white-space: nowrap; }
.cl-badge-incoming { background: #dbeaf5; color: #1f4a69; }
.cl-badge-outgoing { background: #e1eee3; color: #2a5731; }
.cl-badge-missed { background: #f8e1e5; color: #8a2c3c; }
.cl-badge-rejected { background: #f6e3df; color: #82392f; }
.cl-badge-blocked { background: #e4e5f2; color: #41437a; }
.cl-badge-voicemail { background: #f6eadb; color: #724c1d; }
.cl-badge-answered_externally { background: #dcefec; color: #285f58; }
.cl-badge-unknown { background: #ecebe7; color: #4a463f; }
.cl-player-row td { padding: 10px; background: #f9fdfc; }
.cl-player { min-width: 0; border-color: #a3cecb; background: #f9fdfc; }
.cl-player-title { font-size: 14px; overflow-wrap: anywhere; }
.cl-player-title:focus-visible { outline-offset: 2px; }
.cl-player audio { display: block; width: 100%; margin: 4px 0; }
.cl-player-status { margin: 4px 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.cl-player-status:empty { display: none; }
.cl-more { display: flex; justify-content: center; }
@media (max-width: 760px) {
  .cl-table-wrap { overflow: visible; border: 0; background: transparent; }
  .cl-table, .cl-table tbody, .cl-table tr, .cl-table td { display: block; }
  .cl-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .cl-table tbody { display: grid; gap: 8px; }
  .cl-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
  .cl-row td, .cl-row:hover td { padding: 0; border: 0; background: transparent; }
  .cl-row td::before { content: attr(data-label); display: block; color: var(--muted); font-size: 11px; font-weight: 500; }
  .cl-row td.cl-caller { grid-column: 1 / -1; font-size: 14px; }
  .cl-row td.cl-caller::before { content: none; }
  .cl-row td.cl-rec { grid-column: 1 / -1; }
  .cl-row td.cl-rec::before { content: none; }
  .cl-root button.cl-play { width: 100%; min-height: 40px; }
  .cl-row td.cl-empty { display: none; }
  .cl-player-row { display: block; margin-top: -4px; }
  .cl-player-row td { padding: 0; }
}
@media (max-width: 560px) {
  .cl-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cl-filters > label:nth-child(2), .cl-filter-actions { grid-column: 1 / -1; }
  .cl-filter-actions button { flex: 1; }
}
@media (max-width: 359px) {
  .cl-filters { grid-template-columns: minmax(0, 1fr); }
  .cl-row { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: no-preference) {
  .cl-skel { animation: cl-shimmer 1.4s linear infinite; }
  @keyframes cl-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
}
`;
