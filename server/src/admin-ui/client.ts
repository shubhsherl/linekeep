import { communityReleasesUrl } from "../modules/app-download/community-build";

export const clientJavaScript = String.raw`(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const audio = byId('audio');
  const employees = new Map();
  const callTypeNames = { incoming: 'Incoming', outgoing: 'Outgoing', missed: 'Missed', rejected: 'Rejected', blocked: 'Blocked', voicemail: 'Voicemail', answered_externally: 'Answered externally', unknown: 'Unknown' };
  const statusNames = { pending: 'Pending', failed: 'Failed', complete: 'Complete', deleted: 'Deleted' };
  const matchNames = { filename: 'Filename match', media_metadata: 'Media metadata', call_log: 'Call log match', unmatched: 'Unmatched metadata' };
  const statusNotes = {
    pending: 'Waiting for the device to finish uploading. Audio is not available yet.',
    failed: 'The upload failed. Audio is not available.',
    complete: 'Audio is ready. Playback links are generated only when needed.',
    deleted: 'Audio permanently deleted. This entry is retained for reference.'
  };
  let player = null;
  let playerVersion = 0;
  let playbackController;
  let deleteTarget = null;
  let deleting = false;
  let invitationExpiresAt = 0;
  let invitationTimer;
  let invitationVersion = 0;
  let invitationController;
  let invitationPending = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function message(id, text) {
    const node = byId(id);
    node.textContent = text;
    node.hidden = !text;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
  }
  function dateText(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
  }
  function durationText(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'Not available';
    const whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch('/v1/admin' + path, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Cannot reach the server. Check your connection and try again.');
    }
    if (response.status === 401 || response.status === 403) {
      byId('auth-notice').hidden = false;
      throw new Error('Your admin session is unavailable. Sign in again to continue.');
    }
    let data;
    try { data = await response.json(); }
    catch {
      if (response.redirected) byId('auth-notice').hidden = false;
      throw new Error('The server did not return JSON. Your session may have expired; sign in again or refresh the page.');
    }
    if (!response.ok) {
      const detail = data && data.error && typeof data.error.message === 'string' ? data.error.message : 'The server rejected this request.';
      const requestId = data && typeof data.requestId === 'string' ? ' Request ID: ' + data.requestId : '';
      const failure = new Error(detail + requestId);
      failure.status = response.status;
      failure.code = data && data.error && typeof data.error.code === 'string' ? data.error.code : '';
      throw failure;
    }
    byId('auth-notice').hidden = true;
    return data;
  }
  let directoryVersion = 0;
  let directoryController;
  let directoryReady = false;
  function rememberEmployee(employee) {
    if (!employee || typeof employee.id !== 'string' || typeof employee.name !== 'string') return;
    employees.set(employee.id, employee);
  }
  function updateEmployees() {
    for (const id of ['call-history-employee', 'devices-employee', 'customers-employee', 'whatsapp-employee', 'invitation-employee', 'assignment-employee']) {
      const select = byId(id);
      const selected = select.value;
      const choices = document.createDocumentFragment();
      const empty = element('option', ['call-history-employee', 'devices-employee', 'customers-employee', 'whatsapp-employee'].includes(id) ? 'All employees' : 'Select an employee');
      empty.value = '';
      choices.append(empty);
      for (const employee of employees.values()) {
        if (id === 'assignment-employee' && !employee.active) continue;
        const option = element('option', employee.name + ' · ' + employee.id + (employee.active ? '' : ' (inactive)'));
        option.value = employee.id;
        choices.append(option);
      }
      select.replaceChildren(choices);
      if (selected && !Array.from(select.options).some((option) => option.value === selected)) {
        const unavailable = element('option', selected + ' (unavailable)');
        unavailable.value = selected;
        unavailable.disabled = true;
        select.append(unavailable);
      }
      select.value = selected;
    }
    renderAnalyticsEmployeeChoices();
    updateInvitationAvailability();
  }
  function readPage(data) {
    if (!data || !Array.isArray(data.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('The server returned an unreadable page. Please refresh.');
    return data;
  }
  async function loadDirectory() {
    const version = ++directoryVersion;
    if (directoryController) directoryController.abort();
    directoryController = new AbortController();
    directoryReady = false;
    byId('refresh-directory').disabled = true;
    message('directory-error', '');
    message('directory-status', 'Loading employee choices…');
    try {
      const directory = new Map();
      let cursor = null;
      const seen = new Set();
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const data = readPage(await api('/employees?' + params, { signal: directoryController.signal }));
        if (version !== directoryVersion) return false;
        for (const employee of data.items) {
          if (!employee || typeof employee.id !== 'string' || typeof employee.name !== 'string') throw new Error('An employee could not be read. Please refresh.');
          directory.set(employee.id, employee);
        }
        cursor = data.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Employee pagination did not advance. Please refresh.');
        seen.add(cursor);
      } while (cursor);
      employees.clear();
      for (const employee of directory.values()) rememberEmployee(employee);
      directoryReady = true;
      updateEmployees();
      message('directory-status', employees.size + ' employees available in selectors.');
      return true;
    } catch (error) {
      if (version !== directoryVersion || error.name === 'AbortError') return false;
      message('directory-status', 'Employee choices could not be refreshed.');
      message('directory-error', errorMessage(error) + ' Use Refresh employee choices to retry.');
      return false;
    } finally {
      if (version === directoryVersion) byId('refresh-directory').disabled = false;
    }
  }
  byId('refresh-directory').addEventListener('click', loadDirectory);
  function button(label, handler, className = 'secondary') {
    const node = element('button', label, className);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }
  function fact(label, value) {
    const wrapper = element('div');
    wrapper.append(element('dt', label), element('dd', value));
    return wrapper;
  }
  function renderRecording(call, options = {}) {
    if (!call || typeof call.id !== 'string' || !call.employee || typeof call.employee.name !== 'string') throw new Error('A recording could not be read. Please refresh.');
    const row = element('div', undefined, 'recording-row');
    row.dataset.recordingId = call.id;
    const info = element('div', undefined, 'recording-info');
    info.append(element('span', call.displayName || 'Unnamed recording', 'recording-name'));
    const knownStatus = Object.hasOwn(statusNames, call.uploadStatus);
    info.append(element('span', knownStatus ? statusNames[call.uploadStatus] : 'Unknown status', 'badge ' + (knownStatus ? call.uploadStatus : '')));
    const actions = element('div', undefined, 'actions');
    const playButton = button('Play', () => startPlayback(call, row), '');
    const downloadButton = button('Download', () => download(call, downloadButton, options.statusId || 'action-status'));
    playButton.disabled = downloadButton.disabled = call.uploadStatus !== 'complete';
    playButton.setAttribute('aria-label', 'Play ' + call.displayName);
    downloadButton.setAttribute('aria-label', 'Download ' + call.displayName);
    actions.append(playButton, downloadButton);
    if (!options.readOnly) {
      const deleteButton = button('Delete recording', () => openDelete('recording', call, deleteButton), 'secondary delete-button');
      deleteButton.disabled = call.uploadStatus === 'deleted';
      deleteButton.setAttribute('aria-label', 'Delete recording ' + call.displayName);
      actions.append(deleteButton);
    }
    const details = element('details', undefined, 'row-details');
    details.append(element('summary', 'Recording details'));
    details.append(element('p', 'Recording ID: ' + call.id), element('p', 'Uploaded: ' + dateText(call.uploadedAt)),
      element('p', 'Size: ' + (typeof call.actualBytes === 'number' ? call.actualBytes.toLocaleString() + ' bytes' : 'Unknown')),
      element('p', matchNames[call.matchStatus] || 'Metadata unavailable'),
      element('p', statusNotes[call.uploadStatus] || 'Audio is unavailable for this status.'));
    row.append(info, actions, details);
    return row;
  }

  const historyForm = byId('call-history-form');
  const historyList = byId('call-history-list');
  let historyQuery = new URLSearchParams({ limit: '50' });
  let historyCursors = [null];
  let historyPage = 0;
  let historyNext = null;
  let historyLoading = false;
  let historyVersion = 0;
  let historyController;
  function renderCallHistory(call, options = {}) {
    const isCall = call && call.kind === 'call';
    if (!call || !['call', 'recording'].includes(call.kind) || typeof call.id !== 'string' || typeof call.deviceId !== 'string' ||
        !call.employee || typeof call.employee.id !== 'string' || typeof call.employee.name !== 'string' ||
        typeof call.createdAt !== 'string' || !Number.isFinite(Date.parse(call.createdAt)) ||
        !Array.isArray(call.recordings) ||
        (call.startedAt !== undefined && !Number.isFinite(Date.parse(call.startedAt))) ||
        (isCall && (typeof call.startedAt !== 'string' || !Number.isInteger(call.durationSeconds) ||
          call.durationSeconds < 0 || call.durationSeconds > 604800 || !Object.hasOwn(callTypeNames, call.callType)))) {
      throw new Error('A call history entry could not be read. Please refresh.');
    }
    const row = element('article', undefined, 'history-row');
    row.dataset.callLogId = call.id;
    row.dataset.kind = call.kind;
    const caller = element('div', undefined, 'caller-cell');
    const linked = isCall && features.customers && !options.readOnly && call.customer && typeof call.customer.id === 'string' && typeof call.customer.name === 'string' ? call.customer : null;
    const heading = element('h3', linked ? undefined : isCall ? call.callerName || 'Unknown caller' : 'Unlinked recording');
    if (linked) {
      const customerButton = button(linked.name, () => openDrawer(linked, customerButton), 'link-button');
      customerButton.title = 'View customer';
      customerButton.dataset.customerLink = linked.id;
      heading.append(customerButton);
    }
    caller.append(heading);
    caller.append(element('p', isCall ? call.remoteNumber || 'Unknown / restricted number' : call.recordings[0]?.remoteNumber || 'Unknown number', 'muted'));
    const employee = element('div', undefined, 'employee-cell');
    employee.append(element('span', 'Employee', 'cell-label'), element('span', call.employee.name));
    const time = element('div', undefined, 'time-cell');
    time.append(element('span', call.startedAt ? isCall ? 'Call time' : 'Recording time' : 'Upload time', 'cell-label'),
      element('span', dateText(call.startedAt || call.createdAt)));
    const type = element('div', undefined, 'type-cell');
    type.append(element('span', isCall ? callTypeNames[call.callType] : 'Unlinked', 'badge'),
      element('span', durationText(isCall ? call.durationSeconds : call.recordings[0]?.durationSeconds)));
    const line = element('div', undefined, 'line-cell');
    line.append(element('span', 'Local line / SIM', 'cell-label'), element('span', isCall ? call.localNumber || 'Unknown local number' : 'Unknown local number'),
      element('span', isCall ? call.simLabel || 'Unknown SIM' : 'Unknown SIM', 'muted'));
    const details = element('details', undefined, 'row-details');
    details.append(element('summary', 'Call details'), element('p', 'Entry ID: ' + call.id),
      element('p', 'Employee ID: ' + call.employee.id), element('p', 'Enrollment ID: ' + call.deviceId));
    if (isCall) details.append(element('p', 'Phone account: ' + (call.phoneAccountId || 'Unknown')));
    else details.append(element('p', 'No unambiguous call match. This recording has not been assigned a call type or local line.'));
    caller.append(details);
    if (isCall && !options.readOnly) {
      const deleteButton = button('Delete call log', () => openDelete('call', call, deleteButton), 'secondary delete-button history-delete');
      deleteButton.setAttribute('aria-label', 'Delete call log for ' + (call.callerName || call.remoteNumber || 'unknown caller') + ' · ' + dateText(call.startedAt));
      caller.append(deleteButton);
    }
    row.append(caller, employee, time, type, line);
    if (call.recordings.length) {
      const recordings = element('div', undefined, 'row-recordings');
      for (const recording of call.recordings) recordings.append(renderRecording(recording, options));
      row.append(recordings);
    } else {
      type.append(element('span', 'No recording', 'hint'));
    }
    return row;
  }
  function updateHistoryPagination() {
    byId('call-history-previous').disabled = historyLoading || historyPage === 0;
    byId('call-history-next').disabled = historyLoading || !historyNext;
    byId('call-history-refresh').disabled = historyLoading;
    byId('call-history-page').textContent = 'Page ' + (historyPage + 1);
  }
  function cancelCallHistory() {
    historyVersion++;
    if (historyController) historyController.abort();
    if (!historyLoading) return;
    historyLoading = false;
    byId('call-history-results').setAttribute('aria-busy', 'false');
    message('call-history-status', 'Loading cancelled. Return to Call history or use Refresh to retry.');
    updateHistoryPagination();
  }
  async function loadCallHistory() {
    const version = ++historyVersion;
    if (historyController) historyController.abort();
    historyController = new AbortController();
    closePlayer();
    historyLoading = true;
    historyNext = null;
    updateHistoryPagination();
    historyList.replaceChildren();
    byId('call-history-results').setAttribute('aria-busy', 'true');
    message('call-history-error', '');
    message('call-history-status', 'Loading call history…');
    const params = new URLSearchParams(historyQuery);
    if (historyCursors[historyPage]) params.set('cursor', historyCursors[historyPage]);
    try {
      const data = readPage(await api('/call-logs?' + params, { signal: historyController.signal }));
      if (version !== historyVersion) return;
      if (data.nextCursor && historyCursors.some((cursor, index) => index <= historyPage && cursor === data.nextCursor)) throw new Error('Call history pagination did not advance. Clear filters to restart.');
      const content = document.createDocumentFragment();
      for (const call of data.items) content.append(renderCallHistory(call));
      if (!data.items.length) {
        const empty = element('div', undefined, 'empty-state');
        empty.append(element('h3', 'No calls on this page'));
        empty.append(element('p', historyPage > 0 ? 'Go to the previous page or apply filters to restart from the first page.' : historyQuery.size > 1 ? 'Try a wider date range or clear your filters. Unknown numbers do not match a number search; a call-type filter excludes unlinked recordings.' : 'Calls and recordings appear after a device completes setup and grants the required access.'));
        content.append(empty);
      }
      historyList.replaceChildren(content);
      historyNext = data.nextCursor || null;
      message('call-history-status', data.items.length + (data.items.length === 1 ? ' call' : ' calls') + ' on this page · newest first');
    } catch (error) {
      if (version !== historyVersion || error.name === 'AbortError') return;
      historyList.replaceChildren();
      message('call-history-status', 'Call history could not be loaded.');
      message('call-history-error', errorMessage(error) + ' Use Refresh to try this page again.');
    } finally {
      if (version === historyVersion) {
        historyLoading = false;
        byId('call-history-results').setAttribute('aria-busy', 'false');
        updateHistoryPagination();
      }
    }
  }
  function applyHistoryFilters() {
    message('call-history-filter-error', '');
    const form = new FormData(historyForm);
    const updated = new URLSearchParams();
    for (const name of ['employeeId', 'callType', 'number', 'limit']) {
      const value = String(form.get(name) || '').trim();
      if (value) updated.set(name, value);
    }
    if (form.get('hasRecording') === 'true') updated.set('hasRecording', 'true');
    for (const name of ['from', 'to']) {
      const value = String(form.get(name) || '');
      if (!value) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        message('call-history-filter-error', 'Choose a valid date and time.');
        historyForm.elements.namedItem(name).focus();
        return;
      }
      updated.set(name, date.toISOString());
    }
    if (updated.has('from') && updated.has('to') && updated.get('from') > updated.get('to')) {
      message('call-history-filter-error', 'The From date must be before or equal to the To date.');
      historyForm.elements.namedItem('to').focus();
      return;
    }
    historyQuery = updated;
    historyCursors = [null];
    historyPage = 0;
    loadCallHistory();
  }
  historyForm.addEventListener('submit', (event) => { event.preventDefault(); applyHistoryFilters(); });
  historyForm.addEventListener('reset', () => { queueMicrotask(applyHistoryFilters); });
  byId('call-history-refresh').addEventListener('click', loadCallHistory);
  byId('call-history-previous').addEventListener('click', () => {
    if (historyLoading || historyPage === 0) return;
    historyPage--;
    loadCallHistory();
  });
  byId('call-history-next').addEventListener('click', () => {
    if (historyLoading || !historyNext) return;
    historyCursors = historyCursors.slice(0, historyPage + 1);
    historyCursors.push(historyNext);
    historyPage++;
    loadCallHistory();
  });

  async function playbackLink(call, signal) {
    const data = await api('/calls/' + encodeURIComponent(call.id) + '/playback', { method: 'POST', body: '{}', signal });
    if (!data || typeof data.url !== 'string' || typeof data.expiresAt !== 'string') throw new Error('The server returned an invalid playback link.');
    let url;
    try { url = new URL(data.url, location.origin); } catch { throw new Error('The server returned an invalid playback link.'); }
    if ((url.protocol !== 'https:' && !(url.origin === location.origin && url.protocol === 'http:')) || url.username || url.password) throw new Error('The server returned an unsafe playback link.');
    const expiresAt = Date.parse(data.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The playback link has already expired. Please try again.');
    return { url: url.href, expiresAt };
  }
  function closePlayer() {
    playerVersion++;
    if (playbackController) playbackController.abort();
    player = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    byId('player-panel').hidden = true;
    byId('call-history-panel').append(byId('player-panel'));
    byId('retry-playback').hidden = true;
    message('player-status', '');
  }
  async function refreshPlayback(position = 0) {
    if (!player || player.loading) return;
    const selected = player;
    const version = playerVersion;
    selected.loading = true;
    audio.pause();
    message('player-status', 'Getting a fresh, private playback link…');
    byId('retry-playback').hidden = true;
    playbackController = new AbortController();
    try {
      const link = await playbackLink(selected.call, playbackController.signal);
      if (version !== playerVersion || selected !== player) return;
      selected.expiresAt = link.expiresAt;
      selected.position = position;
      audio.src = link.url;
      audio.load();
      selected.loading = false;
      message('player-status', 'Private link expires ' + dateText(new Date(link.expiresAt).toISOString()) + '. If this format is unsupported, use Download.');
      try { await audio.play(); }
      catch (error) {
        if (selected !== player) return;
        if (error.name === 'NotAllowedError') message('player-status', 'Your recording is ready. Press Play in the audio controls to start.');
        else if (error.name !== 'AbortError') {
          message('player-status', 'Playback could not start. Refresh the link or download the recording if your browser does not support its audio format.');
          byId('retry-playback').hidden = false;
        }
      }
    } catch (error) {
      if (version !== playerVersion || error.name === 'AbortError') return;
      message('player-status', errorMessage(error));
      byId('retry-playback').hidden = false;
    } finally {
      if (selected === player) selected.loading = false;
    }
  }
  function startPlayback(call, row) {
    closePlayer();
    player = { call, expiresAt: 0, loading: false, position: 0, retried: false };
    byId('player-title').textContent = call.displayName || 'Call recording';
    row.append(byId('player-panel'));
    byId('player-panel').hidden = false;
    byId('player-title').focus({ preventScroll: true });
    byId('player-panel').scrollIntoView({ block: 'nearest' });
    refreshPlayback();
  }
  audio.addEventListener('loadedmetadata', () => {
    if (!player || !player.position) return;
    const position = Number.isFinite(audio.duration) ? Math.min(player.position, Math.max(0, audio.duration - 0.1)) : player.position;
    audio.currentTime = position;
    player.position = 0;
  });
  audio.addEventListener('play', () => {
    if (player && !player.loading && Date.now() >= player.expiresAt) refreshPlayback(audio.currentTime);
  });
  audio.addEventListener('error', () => {
    if (!player || player.loading || !audio.getAttribute('src')) return;
    if (Date.now() >= player.expiresAt && !player.retried) {
      player.retried = true;
      refreshPlayback(audio.currentTime);
      return;
    }
    message('player-status', 'Audio could not be played. Refresh the link, or use Download if this format is not supported by your browser.');
    byId('retry-playback').hidden = false;
  });
  byId('retry-playback').addEventListener('click', () => { if (player) { player.retried = false; refreshPlayback(audio.currentTime); } });
  byId('close-player').addEventListener('click', () => { closePlayer(); byId('call-history-refresh').focus(); });

  async function download(call, downloadButton, statusId = 'action-status') {
    downloadButton.disabled = true;
    downloadButton.textContent = 'Downloading…';
    message(statusId, 'Preparing download for ' + call.displayName + '…');
    try {
      const link = await playbackLink(call);
      const downloadUrl = new URL(link.url);
      // The Worker supports attachment disposition; external signed URLs must stay unchanged.
      if (downloadUrl.origin === location.origin) downloadUrl.searchParams.set('download', '1');
      const response = await fetch(downloadUrl, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('The audio download failed. Try again to request a fresh link.');
      const contentType = response.headers.get('Content-Type') || '';
      if (!/^(audio\/|application\/octet-stream(?:;|$))/i.test(contentType)) throw new Error('The server did not return audio. Your session may have expired; sign in again and retry.');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = element('a');
      anchor.href = objectUrl;
      anchor.download = call.displayName || 'recording';
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      message(statusId, 'Download ready for ' + call.displayName + '. Check your browser downloads.');
    } catch (error) {
      message(statusId, 'Download failed. ' + errorMessage(error));
    } finally {
      downloadButton.disabled = false;
      downloadButton.textContent = 'Download';
    }
  }
  function openDelete(kind, item, opener) {
    if (deleting) return;
    deleteTarget = { kind, item, opener };
    const isHistory = kind === 'call';
    const label = isHistory ? 'call log' : 'recording';
    byId('delete-title').textContent = 'Delete this ' + label + '?';
    byId('delete-description').textContent = isHistory
      ? 'This call log will be removed from the call history. Its recordings are kept as unlinked audio. Deleted call metadata is retained internally to prevent re-import and incorrect recording matches. The original call log and recordings on the phone are untouched. This cannot be undone.'
      : 'This recording’s stored audio will be permanently removed from Linekeep. Its call log and other recordings are kept. The original recording and call log on the phone are untouched. This cannot be undone.';
    byId('delete-name').textContent = (isHistory
      ? [item.callerName, item.remoteNumber || 'Unknown / restricted number', dateText(item.startedAt)].filter(Boolean).join(' · ')
      : item.displayName || 'Unnamed recording') + ' · ' + item.employee.name + ' · ' + item.id;
    byId('confirm-delete').textContent = 'Delete ' + label;
    byId('cancel-delete').textContent = 'Keep ' + label;
    message('delete-error', '');
    byId('delete-dialog').showModal();
    byId('cancel-delete').focus();
  }
  byId('cancel-delete').addEventListener('click', () => { if (!deleting) byId('delete-dialog').close(); });
  byId('delete-dialog').addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
  byId('delete-dialog').addEventListener('close', () => {
    const opener = deleteTarget?.opener;
    deleteTarget = null;
    if (!deleting) (opener?.isConnected ? opener : byId('call-history-refresh')).focus();
  });
  byId('delete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!deleteTarget || deleting) return;
    deleting = true;
    byId('delete-dialog').setAttribute('aria-busy', 'true');
    byId('confirm-delete').disabled = byId('cancel-delete').disabled = true;
    byId('confirm-delete').textContent = 'Deleting…';
    message('delete-error', '');
    const target = deleteTarget;
    const isHistory = target.kind === 'call';
    try {
      await api((isHistory ? '/call-logs/' : '/calls/') + encodeURIComponent(target.item.id), { method: 'DELETE', body: '{}' });
      // Refresh clears any player attached to the removed row, including pending
      // playback requests. Kept audio can be played again from its unlinked row.
      closePlayer();
      byId('delete-dialog').close();
      message('action-status', isHistory
        ? 'Call log deleted. Recordings are kept as unlinked audio. Phone originals are untouched.'
        : 'Recording deleted: ' + target.item.displayName + '. Call history and phone originals are untouched.');
      historyCursors = [null];
      historyPage = 0;
      await loadCallHistory();
      byId('call-history-refresh').focus();
    } catch (error) {
      message('delete-error', errorMessage(error));
    } finally {
      deleting = false;
      byId('delete-dialog').setAttribute('aria-busy', 'false');
      byId('confirm-delete').disabled = byId('cancel-delete').disabled = false;
      byId('confirm-delete').textContent = isHistory ? 'Delete call log' : 'Delete recording';
      if (byId('delete-dialog').open) byId('cancel-delete').focus();
    }
  });

  function paginatedList(prefix, path, render) {
    let page = 0;
    let history = [null];
    let next = null;
    let busy = false;
    let version = 0;
    let controller;
    function controls() {
      byId(prefix + '-previous').disabled = busy || page === 0;
      byId(prefix + '-next').disabled = busy || !next;
      byId(prefix + '-refresh').disabled = busy;
      byId(prefix + '-page').textContent = 'Page ' + (page + 1);
    }
    async function load(reset = false) {
      if (reset) { page = 0; history = [null]; }
      const current = ++version;
      if (controller) controller.abort();
      controller = new AbortController();
      const endpoint = path();
      next = null;
      busy = true;
      controls();
      const list = byId(prefix + '-list');
      list.replaceChildren();
      list.setAttribute('aria-busy', 'true');
      message(prefix + '-error', '');
      message(prefix + '-status', endpoint ? 'Loading ' + prefix + '…' : 'Select an employee to view invitation history.');
      try {
        if (!endpoint) return;
        const params = new URLSearchParams({ limit: '20' });
        if (history[page]) params.set('cursor', history[page]);
        const data = readPage(await api(endpoint + (endpoint.includes('?') ? '&' : '?') + params, { signal: controller.signal }));
        if (current !== version) return;
        if (data.nextCursor && history.some((cursor, index) => index <= page && cursor === data.nextCursor)) throw new Error('Pagination did not advance. Refresh to restart.');
        const content = document.createDocumentFragment();
        for (const item of data.items) content.append(render(item));
        list.replaceChildren(content);
        next = data.nextCursor;
        message(prefix + '-status', data.items.length ? data.items.length + ' ' + prefix + ' on this page.' : 'No ' + prefix + ' on this page.');
      } catch (error) {
        if (current !== version || error.name === 'AbortError') return;
        message(prefix + '-status', 'Could not load ' + prefix + '.');
        message(prefix + '-error', errorMessage(error) + ' Use Refresh to retry.');
      } finally {
        if (current === version) { busy = false; list.setAttribute('aria-busy', 'false'); controls(); }
      }
    }
    byId(prefix + '-previous').addEventListener('click', () => { if (!busy && page > 0) { page--; load(); } });
    byId(prefix + '-next').addEventListener('click', () => {
      if (busy || !next) return;
      history = history.slice(0, page + 1);
      history.push(next);
      page++;
      load();
    });
    byId(prefix + '-refresh').addEventListener('click', () => load(true));
    return { load };
  }
  function selectInvitationEmployee(id) {
    clearInvitation();
    byId('invitation-employee').value = id;
    message('invitation-error', '');
    updateInvitationAvailability();
    invitationList.load(true);
  }
  function renderEmployee(employee) {
    const card = element('article', undefined, 'management-card');
    card.dataset.employeeId = employee.id;
    const heading = element('h3', employee.name);
    const details = element('details', undefined, 'row-details');
    details.append(element('summary', 'Employee details'), element('p', 'Employee ID: ' + employee.id),
      ...(employee.phoneNumber ? [element('p', 'Phone number: ' + employee.phoneNumber)] : []),
      element('p', (employee.active ? 'Active' : 'Inactive') + ' · Created ' + dateText(employee.createdAt)));
    const actions = element('div', undefined, 'actions');
    const edit = button('Edit details', () => {
      actions.hidden = true;
      const form = element('form');
      const fields = element('fieldset');
      const label = element('label', 'Employee name');
      const input = element('input');
      input.name = 'name';
      input.value = employee.name;
      input.required = true;
      input.maxLength = 200;
      input.autocomplete = 'name';
      label.append(input);
      const phoneLabel = element('label', 'Phone number (optional)');
      const phoneInput = element('input');
      phoneInput.name = 'phoneNumber';
      phoneInput.type = 'tel';
      phoneInput.value = employee.phoneNumber || '';
      phoneInput.maxLength = 32;
      phoneInput.autocomplete = 'off';
      phoneInput.placeholder = '+919876543210';
      phoneLabel.append(phoneInput);
      const status = element('p');
      status.setAttribute('role', 'status');
      const error = element('p', '', 'error-text');
      error.setAttribute('role', 'alert');
      const controls = element('div', undefined, 'actions');
      const save = element('button', 'Save details');
      save.type = 'submit';
      const cancel = button('Cancel', () => { form.remove(); actions.hidden = false; edit.focus(); });
      controls.append(save, cancel);
      fields.append(label, element('p', 'Correcting a name updates this same employee on historical recordings. If a phone is changing hands, cancel and reassign the device to another employee instead.', 'hint'), phoneLabel, element('p', 'Used only to fill WhatsApp template messages (for example, who the customer should call).', 'hint'), controls);
      form.append(fields, status, error);
      card.append(form);
      input.focus();
      input.select();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (fields.disabled) return;
        const name = input.value.trim();
        if (!name || name.length > 200) { error.textContent = 'Enter a name between 1 and 200 characters.'; input.focus(); return; }
        fields.disabled = true;
        status.textContent = 'Saving details…';
        error.textContent = '';
        try {
          const data = await api('/employees/' + encodeURIComponent(employee.id), { method: 'PATCH', body: JSON.stringify({ name, phoneNumber: phoneInput.value.trim() || null }) });
          rememberEmployee(data.employee);
          updateEmployees();
          const replacement = renderEmployee(data.employee);
          card.replaceWith(replacement);
          replacement.querySelector('button').focus();
          message('employee-status', 'Saved details for ' + data.employee.name + '.');
          deviceList.load();
          if (byId('invitation-employee').value === employee.id && invitationExpiresAt) clearInvitation('The name changed. The displayed code was cleared; it remains usable until redeemed, revoked or expired.');
        } catch (failure) { error.textContent = errorMessage(failure); status.textContent = ''; }
        finally { fields.disabled = false; }
      });
    });
    edit.setAttribute('aria-label', 'Edit details for ' + employee.name);
    const invitations = button('Invitations', () => {
      rememberEmployee(employee);
      updateEmployees();
      selectInvitationEmployee(employee.id);
      byId('invitations-heading').focus();
    });
    invitations.setAttribute('aria-label', 'Invitations for ' + employee.name);
    const devices = button('Devices', () => {
      rememberEmployee(employee);
      updateEmployees();
      byId('devices-employee').value = employee.id;
      deviceList.load(true);
      byId('devices-heading').focus();
    });
    devices.setAttribute('aria-label', 'Devices for ' + employee.name);
    actions.append(edit, invitations, devices);
    const top = element('div', undefined, 'management-top');
    top.append(heading, actions);
    card.append(top, details);
    return card;
  }
  function renderDevice(device) {
    const card = element('article', undefined, 'management-card');
    card.dataset.deviceId = device.id;
    const top = element('div', undefined, 'management-top');
    const identity = element('div');
    identity.append(element('h3', device.employee.name + ' · ' + (device.model || 'Unknown device model')),
      element('p', (device.revokedAt ? 'Revoked' : 'Enrolled') + ' · Last seen ' + dateText(device.lastSeenAt), 'hint'));
    const facts = element('dl', undefined, 'device-facts');
    facts.append(
      fact('Enrollment ID', device.id),
      fact('Original invitation ID', device.invitationId || 'Unknown'),
      fact('Latest invitation ID', device.lastInvitationId || 'Unknown'),
      fact('Assigned employee', device.employee.name + ' · ' + device.employeeId),
      fact('Reported SIM numbers (unverified)', device.phoneNumbers.length ? device.phoneNumbers.join(', ') : 'Unknown / unavailable'),
      fact('SIM report received', dateText(device.phoneNumbersReportedAt)),
      fact('Last seen', device.lastSeenAt ? dateText(device.lastSeenAt) : 'Not yet seen'),
      fact('Status', device.revokedAt ? 'Revoked · ' + dateText(device.revokedAt) : 'Enrolled'),
      fact('Assigned since', dateText(device.assignedAt)),
      fact('Enrolled', dateText(device.createdAt)),
      fact('App / Android version', (device.appVersion || 'Unknown') + ' / ' + (device.androidVersion || 'Unknown')),
      fact('Pending uploads reported', device.pendingUploads)
    );
    const actions = element('div', undefined, 'actions');
    const assign = button('Reassign', () => openAssignment(device));
    const revoke = button('Revoke device', () => openRevoke('device', device), 'secondary delete-button');
    const recover = button('Recover enrollment', () => openRecovery(device));
    recover.disabled = Boolean(device.revokedAt) || employees.get(device.employeeId)?.active === false;
    recover.setAttribute('aria-label', 'Recover enrollment ' + device.id);
    assign.disabled = revoke.disabled = Boolean(device.revokedAt);
    assign.setAttribute('aria-label', 'Reassign device ' + device.id);
    revoke.setAttribute('aria-label', 'Revoke device ' + device.id);
    actions.append(assign, recover, revoke);
    top.append(identity, actions);
    const details = element('details', undefined, 'row-details');
    details.append(element('summary', 'Enrollment details'), facts);
    card.append(top, details);
    return card;
  }
  let shownInvitationId = null;
  let shownRecoveryDeviceId = null;
  function renderInvitation(invitation) {
    const card = element('article', undefined, 'management-card');
    card.dataset.invitationId = invitation.id;
    const top = element('div', undefined, 'management-top');
    const identity = element('div');
    identity.append(element('h3', (invitation.purpose === 'recovery' ? 'Recovery' : invitation.purpose === 'enrollment' ? 'Enrollment' : 'Unknown purpose') + ' · ' + invitation.status),
      element('p', 'Expires ' + dateText(invitation.expiresAt), 'hint'));
    top.append(identity);
    const facts = element('dl', undefined, 'device-facts');
    facts.append(fact('Invitation ID', invitation.id), fact('Created', dateText(invitation.createdAt)), fact('Expires', dateText(invitation.expiresAt)));
    facts.append(fact('Redeemed enrollment ID', invitation.deviceId || 'Unknown'));
    if (invitation.purpose === 'recovery') facts.append(fact('Recovery target enrollment ID', invitation.recoveryDeviceId || 'Unknown'));
    if (invitation.redeemedAt) facts.append(fact('Redeemed', dateText(invitation.redeemedAt)));
    if (invitation.revokedAt) facts.append(fact('Revoked', dateText(invitation.revokedAt)));
    const details = element('details', undefined, 'row-details');
    details.append(element('summary', 'Invitation details'), facts);
    card.append(top, details);
    if (shownInvitationId === invitation.id && invitation.status !== 'active') clearInvitation('The invitation is ' + invitation.status + '; its code was cleared.');
    if (invitation.status === 'active') top.append(button('Revoke invitation', () => openRevoke('invitation', invitation), 'secondary delete-button'));
    return card;
  }
  const employeeList = paginatedList('employees', () => '/employees', renderEmployee);
  const deviceList = paginatedList('devices', () => {
    const params = new URLSearchParams();
    if (byId('devices-employee').value) params.set('employeeId', byId('devices-employee').value);
    if (byId('devices-show-revoked').checked) params.set('includeRevoked', 'true');
    return '/devices?' + params;
  }, renderDevice);
  const invitationList = paginatedList('invitations', () => {
    if (!byId('invitation-employee').value) return null;
    return '/employees/' + encodeURIComponent(byId('invitation-employee').value) + '/invitations' + (byId('invitations-show-revoked').checked ? '?includeRevoked=true' : '');
  }, renderInvitation);
  byId('devices-show-revoked').addEventListener('change', () => deviceList.load(true));
  byId('invitations-show-revoked').addEventListener('change', () => invitationList.load(true));
  byId('invitations-refresh').addEventListener('click', () => clearInvitation('The displayed code was cleared while refreshing invitation history.'));
  byId('devices-employee').addEventListener('change', () => deviceList.load(true));
  byId('invitation-employee').addEventListener('change', () => selectInvitationEmployee(byId('invitation-employee').value));
  byId('employees-refresh').addEventListener('click', loadDirectory);
  byId('employee-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.querySelector('fieldset');
    if (fields.disabled) return;
    const formData = new FormData(form);
    const name = String(formData.get('name') || '').trim();
    const phoneNumber = String(formData.get('phoneNumber') || '').trim();
    message('employee-error', '');
    if (!name || name.length > 200) { message('employee-error', 'Enter a name between 1 and 200 characters.'); form.elements.namedItem('name').focus(); return; }
    fields.disabled = true;
    message('employee-status', 'Creating employee…');
    try {
      const data = await api('/employees', { method: 'POST', body: JSON.stringify(phoneNumber ? { name, phoneNumber } : { name }) });
      if (!data || !data.employee || typeof data.employee.id !== 'string' || typeof data.employee.name !== 'string') throw new Error('The employee response could not be read. Refresh the directory before creating a duplicate.');
      rememberEmployee(data.employee);
      updateEmployees();
      selectInvitationEmployee(data.employee.id);
      form.reset();
      message('employee-status', 'Created ' + data.employee.name + '. Employee ID: ' + data.employee.id + '. Selected for a new device invitation.');
      employeeList.load(true);
      byId('invitation-employee').focus();
    } catch (error) { message('employee-status', ''); message('employee-error', errorMessage(error)); }
    finally { fields.disabled = false; }
  });

  let assignmentTarget = null;
  let assigning = false;
  async function openAssignment(device) {
    assignmentTarget = device;
    byId('assignment-device').textContent = device.id + ' · Currently assigned to ' + device.employee.name;
    message('assignment-error', '');
    message('assignment-status', 'Loading the employee directory…');
    byId('assignment-employee').disabled = byId('confirm-assignment').disabled = true;
    byId('assignment-dialog').showModal();
    byId('cancel-assignment').focus();
    const ready = await loadDirectory();
    if (assignmentTarget !== device || !byId('assignment-dialog').open) return;
    byId('assignment-employee').disabled = byId('confirm-assignment').disabled = !ready;
    if (ready) {
      byId('assignment-employee').value = device.employeeId;
      message('assignment-status', 'Choose the employee receiving this device.');
      byId('assignment-employee').focus();
    } else {
      message('assignment-status', '');
      message('assignment-error', 'The directory could not be loaded. Cancel and reopen Reassign to retry.');
    }
  }
  byId('cancel-assignment').addEventListener('click', () => byId('assignment-dialog').close());
  byId('assignment-dialog').addEventListener('cancel', (event) => { if (assigning) event.preventDefault(); });
  byId('assignment-dialog').addEventListener('close', () => { assignmentTarget = null; });
  byId('assignment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (assigning || !assignmentTarget || !directoryReady) return;
    const employeeId = byId('assignment-employee').value;
    message('assignment-error', '');
    if (!employees.get(employeeId)?.active) { message('assignment-error', 'Choose an active employee.'); return; }
    if (employeeId === assignmentTarget.employeeId) { message('assignment-error', 'Choose a different employee or cancel.'); return; }
    const target = assignmentTarget;
    assigning = true;
    const fields = event.currentTarget.querySelector('fieldset');
    fields.disabled = true;
    message('assignment-status', 'Saving assignment…');
    try {
      const data = await api('/devices/' + encodeURIComponent(target.id), { method: 'PATCH', body: JSON.stringify({ employeeId }) });
      if (shownRecoveryDeviceId === target.id) clearInvitation('The enrollment assignment changed and its displayed recovery code was cleared.');
      byId('assignment-dialog').close();
      await deviceList.load();
      message('devices-status', 'Device ' + data.device.id + ' is assigned to ' + data.device.employee.name + '. Enrollment is unchanged.' + (byId('devices-employee').value ? ' The current employee filter may hide this device.' : ''));
      byId('devices-heading').focus();
    } catch (error) { message('assignment-status', ''); message('assignment-error', errorMessage(error)); }
    finally { assigning = false; fields.disabled = false; }
  });
  let revokeTarget = null;
  let revoking = false;
  function openRevoke(kind, item) {
    revokeTarget = { kind, item };
    byId('revoke-title').textContent = kind === 'device' ? 'Revoke this device?' : 'Revoke this invitation?';
    byId('revoke-description').textContent = kind === 'device' ? 'This device will no longer be able to report status or upload recordings. Its current enrollment credential will stop working. Historical recordings are retained.' : 'This unused code will no longer enroll a device. Revoking an invitation does not revoke a device already enrolled with it.';
    byId('revoke-name').textContent = item.id;
    message('revoke-error', '');
    byId('revoke-dialog').showModal();
    byId('cancel-revoke').focus();
  }
  byId('cancel-revoke').addEventListener('click', () => byId('revoke-dialog').close());
  byId('revoke-dialog').addEventListener('cancel', (event) => { if (revoking) event.preventDefault(); });
  byId('revoke-dialog').addEventListener('close', () => { revokeTarget = null; });
  byId('revoke-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!revokeTarget || revoking) return;
    const target = revokeTarget;
    revoking = true;
    byId('confirm-revoke').disabled = byId('cancel-revoke').disabled = true;
    byId('confirm-revoke').textContent = 'Revoking…';
    message('revoke-error', '');
    try {
      const path = target.kind === 'device' ? '/devices/' + encodeURIComponent(target.item.id) : '/employees/' + encodeURIComponent(target.item.employeeId) + '/invitations/' + encodeURIComponent(target.item.id);
      await api(path + '/revoke', { method: 'POST', body: '{}' });
      if (target.kind === 'invitation' && shownInvitationId === target.item.id) clearInvitation('The invitation was revoked and its code cleared.');
      if (target.kind === 'device' && shownRecoveryDeviceId === target.item.id) clearInvitation('The enrollment was revoked and its recovery code cleared.');
      byId('revoke-dialog').close();
      await (target.kind === 'device' ? deviceList : invitationList).load();
      byId(target.kind === 'device' ? 'devices-heading' : 'invitations-heading').focus();
    } catch (error) { message('revoke-error', errorMessage(error)); }
    finally {
      revoking = false;
      byId('confirm-revoke').disabled = byId('cancel-revoke').disabled = false;
      byId('confirm-revoke').textContent = 'Revoke';
    }
  });
  function updateInvitationAvailability() {
    byId('invitation-form').querySelector('fieldset').disabled = invitationPending || Boolean(invitationExpiresAt) || !employees.get(byId('invitation-employee').value)?.active;
  }
  function clearInvitation(text = '') {
    const restoreFocus = byId('invitation-result').contains(document.activeElement);
    invitationVersion++;
    if (invitationController) invitationController.abort();
    clearTimeout(invitationTimer);
    invitationExpiresAt = 0;
    invitationPending = false;
    shownInvitationId = null;
    shownRecoveryDeviceId = null;
    byId('invitation-code').value = '';
    byId('invitation-qr').replaceChildren();
    byId('invitation-expiry').textContent = '';
    byId('invitation-result').hidden = true;
    updateInvitationAvailability();
    message('copy-status', '');
    message('invitation-status', text);
    if (restoreFocus) byId('invitation-employee').focus();
  }
  function scheduleInvitationExpiry() {
    const remaining = invitationExpiresAt - Date.now();
    if (remaining <= 0) { clearInvitation('The invitation expired and its code was cleared. Generate a new invitation if needed.'); return; }
    invitationTimer = setTimeout(scheduleInvitationExpiry, Math.min(remaining, 2147483647));
  }
  async function generateInvitation(employeeId, device = null) {
    clearInvitation();
    const version = invitationVersion;
    invitationController = new AbortController();
    invitationPending = true;
    updateInvitationAvailability();
    const errorId = device ? 'recovery-error' : 'invitation-error';
    message(errorId, '');
    message('invitation-status', 'Generating a single-use ' + (device ? 'recovery code' : 'invitation') + '…');
    try {
      const path = device ? '/devices/' + encodeURIComponent(device.id) + '/recovery-invitations' : '/employees/' + encodeURIComponent(employeeId) + '/invitations';
      const data = await api(path, { method: 'POST', body: '{}', signal: invitationController.signal });
      if (version !== invitationVersion) return;
      if (!data || typeof data.invitationId !== 'string' || typeof data.invitationCode !== 'string' || !data.invitationCode || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()) throw new Error('The server did not return a usable invitation. Refresh history before generating another.');
      invitationExpiresAt = Date.parse(data.expiresAt);
      invitationPending = false;
      shownInvitationId = data.invitationId;
      shownRecoveryDeviceId = device ? device.id : null;
      byId('invitation-title').textContent = device ? 'Recovery code ready, shown once' : 'Invitation ready, shown once';
      byId('invitation-code').value = data.invitationCode;
      // The server renders the QR from its own address and the code; parse it as an SVG document, never as HTML.
      const qrDocument = typeof data.qrSvg === 'string' ? new DOMParser().parseFromString(data.qrSvg, 'image/svg+xml') : null;
      if (qrDocument && qrDocument.documentElement.localName === 'svg' && !qrDocument.querySelector('parsererror')) {
        byId('invitation-qr').replaceChildren(document.importNode(qrDocument.documentElement, true));
      } else {
        byId('invitation-qr').replaceChildren();
      }
      byId('invitation-expiry').textContent = 'Invitation ' + data.invitationId + ' · For employee ' + employeeId + (device ? ' · Enrollment ' + device.id + ' · Existing credential rotates on redemption.' : '') + ' · Expires ' + dateText(data.expiresAt);
      byId('invitation-result').hidden = false;
      message('invitation-status', 'Code generated. Copy it now; dismissing clears the code.');
      scheduleInvitationExpiry();
      if (device) byId('recovery-dialog').close();
      byId('invitation-title').focus();
      byId('invitation-result').scrollIntoView({ block: 'nearest' });
      invitationList.load(true);
    } catch (error) {
      if (version !== invitationVersion || error.name === 'AbortError') return;
      invitationPending = false;
      updateInvitationAvailability();
      message('invitation-status', '');
      message(errorId, errorMessage(error));
    }
  }
  byId('invitation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (event.currentTarget.querySelector('fieldset').disabled) return;
    const employeeId = byId('invitation-employee').value;
    if (!employees.get(employeeId)?.active) { message('invitation-error', 'Select an active employee.'); return; }
    await generateInvitation(employeeId);
  });
  let recoveryTarget = null;
  function openRecovery(device) {
    if (invitationPending || invitationExpiresAt) {
      message('invitation-status', 'Dismiss the current code or wait for generation to finish before requesting a recovery code.');
      byId('invitations-heading').focus();
      return;
    }
    recoveryTarget = device;
    byId('recovery-device').textContent = device.employee.name + ' · ' + device.id;
    message('recovery-error', '');
    byId('recovery-dialog').showModal();
    byId('cancel-recovery').focus();
  }
  byId('cancel-recovery').addEventListener('click', () => byId('recovery-dialog').close());
  byId('recovery-dialog').addEventListener('cancel', (event) => { if (invitationPending) event.preventDefault(); });
  byId('recovery-dialog').addEventListener('close', () => { recoveryTarget = null; });
  byId('recovery-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!recoveryTarget || invitationPending) return;
    const target = recoveryTarget;
    byId('confirm-recovery').disabled = byId('cancel-recovery').disabled = true;
    byId('invitation-employee').value = target.employeeId;
    try { await generateInvitation(target.employeeId, target); }
    finally { byId('confirm-recovery').disabled = byId('cancel-recovery').disabled = false; }
  });
  byId('dismiss-invitation').addEventListener('click', () => {
    clearInvitation('The invitation code was cleared from this page. It remains valid until redeemed, revoked or expired.');
    byId('invitation-employee').focus();
  });
  byId('copy-invitation').addEventListener('click', async () => {
    if (Date.now() >= invitationExpiresAt) { clearInvitation('This invitation has expired.'); return; }
    const version = invitationVersion;
    try {
      await navigator.clipboard.writeText(byId('invitation-code').value);
      if (version !== invitationVersion) return;
      message('copy-status', 'Code copied. Share it securely and clear your clipboard afterward.');
    } catch {
      if (version !== invitationVersion) return;
      byId('invitation-code').focus();
      byId('invitation-code').select();
      message('copy-status', 'Clipboard access is unavailable. Copy the selected code manually.');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (invitationExpiresAt && Date.now() >= invitationExpiresAt) clearInvitation('This invitation expired and its code was cleared.');
  });
  // Customers, customer detail and stored WhatsApp chats. Every customer-supplied string is rendered with textContent.
  const customersForm = byId('customers-form');
  const customersListNode = byId('customers-list');
  const whatsappForm = byId('whatsapp-form');
  let customersLoaded = false;
  let chatsLoaded = false;
  let customerDetail = null;
  let selectedChat = null;
  let customerSearchTimer;
  let chatSearchTimer;

  function plural(count, one, many) { return count === 1 ? one : many; }
  function emptyState(title, text) {
    const empty = element('div', undefined, 'empty-state');
    empty.append(element('h3', title), element('p', text));
    return empty;
  }
  function readCustomer(customer) {
    if (!customer || typeof customer.id !== 'string' || typeof customer.name !== 'string' || typeof customer.phone !== 'string' || !Array.isArray(customer.employees) ||
        customer.employees.some((employee) => !employee || typeof employee.id !== 'string' || typeof employee.name !== 'string')) {
      throw new Error('A customer could not be read. Please refresh.');
    }
    return customer;
  }
  function handlerNames(employeeList) { return employeeList.map((employee) => employee.name).join(', '); }
  function messageTypeLabel(type) {
    if (typeof type !== 'string' || !type || type === 'text') return '';
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
  function sameSet(a, b) { return a.length === b.length && a.every((value) => b.includes(value)); }

  // Cursor-paginated list that appends pages ("Load more").
  function cursorList(options) {
    const list = byId(options.listId);
    const more = byId(options.moreId);
    let next = null;
    let busy = false;
    let version = 0;
    let controller;
    let seen = new Set();
    let count = 0;
    let pages = 0;
    let refreshing = false;
    function controls() {
      more.hidden = !next;
      more.disabled = busy;
    }
    function shownStatus() {
      message(options.statusId, count ? count + ' ' + plural(count, options.noun[0], options.noun[1]) + ' shown' + (next ? '. More are available.' : '.') : '');
    }
    function cancel() {
      version++;
      if (controller) controller.abort();
      busy = false;
      next = null;
      pages = 0;
      list.setAttribute('aria-busy', 'false');
      controls();
    }
    async function load(reset = true) {
      if (!reset && (busy || !next)) return;
      const current = ++version;
      if (controller) controller.abort();
      controller = new AbortController();
      const cursor = reset ? null : next;
      if (reset) {
        if (options.beforeReset) options.beforeReset();
        list.replaceChildren();
        count = 0;
        pages = 0;
        seen = new Set();
        next = null;
      }
      const request = options.request();
      busy = true;
      controls();
      list.setAttribute('aria-busy', 'true');
      message(options.errorId, '');
      message(options.statusId, 'Loading ' + options.noun[1] + '…');
      try {
        const params = new URLSearchParams(request.params);
        params.set('limit', String(options.limit || 50));
        if (cursor) params.set('cursor', cursor);
        const data = readPage(await api(request.path + '?' + params, { signal: controller.signal }));
        if (current !== version) return;
        if (data.nextCursor && (data.nextCursor === cursor || seen.has(data.nextCursor))) throw new Error('Pagination did not advance. Refresh to restart.');
        if (cursor) seen.add(cursor);
        const items = data.items;
        const content = document.createDocumentFragment();
        for (const item of items) content.append(options.render(item));
        count += data.items.length;
        if (!count) list.replaceChildren(options.empty(request.params.size > 0));
        else list.append(content);
        next = data.nextCursor;
        pages++;
        shownStatus();
        if (options.onLoaded) options.onLoaded();
      } catch (error) {
        if (current !== version || error.name === 'AbortError') return;
        message(options.statusId, 'Could not load ' + options.noun[1] + '.');
        message(options.errorId, errorMessage(error) + (reset ? ' Use Refresh to try again.' : ' Use the load button to try again.'));
      } finally {
        if (current === version) {
          busy = false;
          list.setAttribute('aria-busy', 'false');
          controls();
        }
      }
    }
    // Re-reads the first page without a loading state and merges it into the rows already on screen.
    // Unchanged rows keep their nodes (focus, selection), later pages stay loaded and the scroll position is kept.
    // Needs options.nodeKey(node), which returns '' for rows that are not items. Resolves false when the request failed.
    async function refresh() {
      if (busy || refreshing || !pages) return true;
      const current = version;
      refreshing = true;
      try {
        const request = options.request();
        const params = new URLSearchParams(request.params);
        params.set('limit', String(options.limit || 50));
        const data = readPage(await api(request.path + '?' + params));
        if (current !== version || busy) return true;
        const existing = new Map();
        for (const node of list.children) {
          const key = options.nodeKey(node);
          if (key) existing.set(key, node);
        }
        const head = data.items.map((item) => {
          const node = options.render(item);
          const old = existing.get(options.nodeKey(node));
          return old && old.outerHTML === node.outerHTML ? old : node;
        });
        const headKeys = new Set(head.map(options.nodeKey));
        const tail = pages > 1 ? Array.from(list.children).filter((node) => { const key = options.nodeKey(node); return key && !headKeys.has(key); }) : [];
        const nodes = head.concat(tail);
        const active = document.activeElement;
        const focusKey = active && list.contains(active) ? options.nodeKey(active) : '';
        const scrollTop = list.scrollTop;
        if (pages <= 1) {
          next = data.nextCursor;
          seen = new Set();
        }
        count = nodes.length;
        if (!nodes.length) list.replaceChildren(options.empty(request.params.size > 0));
        else if (nodes.length !== list.children.length || nodes.some((node, index) => node !== list.children[index])) list.replaceChildren(...nodes);
        list.scrollTop = scrollTop;
        if (focusKey && !list.contains(document.activeElement)) {
          const again = nodes.find((node) => options.nodeKey(node) === focusKey);
          if (again) again.focus({ preventScroll: true });
        }
        controls();
        shownStatus();
        return true;
      } catch {
        return false;
      } finally {
        refreshing = false;
      }
    }
    more.addEventListener('click', () => load(false));
    return { load, cancel, refresh };
  }

  // ---- Customers list ----
  function customersRequest() {
    const form = new FormData(customersForm);
    const params = new URLSearchParams();
    const q = String(form.get('q') || '').trim();
    if (q) params.set('q', q);
    if (form.get('unassigned') === 'true') params.set('unassigned', 'true');
    else if (form.get('employeeId')) params.set('employeeId', String(form.get('employeeId')));
    const state = String(form.get('state') || '').trim();
    if (state) params.set('state', state);
    return { path: '/customers', params };
  }
  function renderCustomer(customer) {
    readCustomer(customer);
    const row = element('article', undefined, 'history-row customer-row');
    row.dataset.customerId = customer.id;
    const identity = element('div', undefined, 'caller-cell');
    const nameHeading = element('h3');
    const nameButton = button(customer.name, () => openDrawer(customer, nameButton), 'link-button customer-open');
    nameButton.title = 'View customer';
    nameHeading.append(nameButton);
    identity.append(nameHeading, element('p', customer.phone, 'muted'));
    const where = [customer.source ? 'Source: ' + customer.source : '', [customer.district, customer.state, customer.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    if (where) identity.append(element('p', where, 'hint'));
    const handlers = element('div', undefined, 'employee-cell');
    handlers.append(element('span', 'Handled by', 'cell-label'));
    if (customer.employees.length) handlers.append(element('span', handlerNames(customer.employees)));
    else handlers.append(element('span', 'Unassigned', 'badge pending'));
    const messages = element('div', undefined, 'type-cell');
    const total = Number.isInteger(customer.messageCount) ? customer.messageCount : 0;
    messages.append(element('span', 'WhatsApp', 'cell-label'), element('span', total + ' ' + plural(total, 'message', 'messages')));
    const time = element('div', undefined, 'time-cell');
    time.append(element('span', 'Last message', 'cell-label'), element('span', customer.lastMessageAt ? dateText(customer.lastMessageAt) : 'None'),
      element('span', 'Last call', 'cell-label'), element('span', customer.lastCallAt ? dateText(customer.lastCallAt) : 'None'));
    const actions = element('div', undefined, 'actions actions-cell');
    const detailsButton = button('Details', () => openCustomerDetail(customer, detailsButton), '');
    detailsButton.setAttribute('aria-label', 'Details for ' + customer.name);
    const editButton = button('Edit', () => openCustomerDialog(customer, editButton));
    editButton.setAttribute('aria-label', 'Edit ' + customer.name);
    const handlersButton = button('Handled by', () => openHandlers(customer, handlersButton));
    handlersButton.setAttribute('aria-label', 'Change handling employees for ' + customer.name);
    const archiveButton = button('Archive', () => openArchive(customer, archiveButton), 'secondary delete-button');
    archiveButton.setAttribute('aria-label', 'Archive ' + customer.name);
    actions.append(detailsButton, editButton, handlersButton, archiveButton);
    row.append(identity, handlers, messages, time, actions);
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, a, summary, input, select, textarea') || String(window.getSelection()).length) return;
      openDrawer(customer, nameButton);
    });
    return row;
  }
  const customersList = cursorList({
    listId: 'customers-list', moreId: 'customers-more', statusId: 'customers-status', errorId: 'customers-error', noun: ['customer', 'customers'],
    request: customersRequest,
    render: renderCustomer,
    empty: (filtered) => emptyState('No customers found', filtered ? 'Try a different search or clear the filters.' : 'Use Add customer to create the first customer, then choose who handles it.')
  });
  function applyCustomerFilters() {
    clearTimeout(customerSearchTimer);
    byId('customers-employee').disabled = byId('customers-unassigned').checked;
    customersList.load(true);
  }
  customersForm.addEventListener('submit', (event) => { event.preventDefault(); applyCustomerFilters(); });
  customersForm.addEventListener('input', (event) => {
    if (event.target.type !== 'search') return;
    clearTimeout(customerSearchTimer);
    customerSearchTimer = setTimeout(applyCustomerFilters, 350);
  });
  customersForm.addEventListener('change', (event) => { if (event.target.type !== 'search') applyCustomerFilters(); });
  customersForm.addEventListener('reset', () => { queueMicrotask(applyCustomerFilters); });
  byId('customers-refresh').addEventListener('click', () => customersList.load(true));
  byId('customer-add').addEventListener('click', (event) => openCustomerDialog(null, event.currentTarget));

  function announceCustomer(text) {
    message(byId('customer-detail').hidden ? 'customers-action-status' : 'customer-detail-status', text);
  }
  function focusCustomerSurface(opener, customerId) {
    if (opener && opener.isConnected) { opener.focus(); return; }
    const row = customerId ? customersListNode.querySelector('[data-customer-id="' + CSS.escape(customerId) + '"] button') : null;
    if (row) { row.focus(); return; }
    (byId('customer-detail').hidden ? byId('customers-heading') : byId('customer-detail-heading')).focus();
  }
  // Replaces the list row and the open detail view after an edit, assignment change or refresh.
  function applyCustomerUpdate(customer) {
    const row = customersListNode.querySelector('[data-customer-id="' + CSS.escape(customer.id) + '"]');
    if (row) row.replaceWith(renderCustomer(customer));
    if (customerDetail && customerDetail.customer.id === customer.id) {
      customerDetail.customer = customer;
      renderCustomerDetail(customer);
    }
    if (drawerState.open && drawerState.id === customer.id) applyDrawerCustomer(customer);
  }

  // ---- Customer detail ----
  const detailCalls = cursorList({
    listId: 'customer-calls-list', moreId: 'customer-calls-more', statusId: 'customer-calls-status', errorId: 'customer-calls-error', noun: ['call', 'calls'],
    request: () => ({ path: '/customers/' + encodeURIComponent(customerDetail.customer.id) + '/calls', params: new URLSearchParams() }),
    beforeReset: closePlayer,
    render: (call) => renderCallHistory(call, { readOnly: true, statusId: 'customer-calls-action-status' }),
    empty: () => emptyState('No calls', 'No call log matches this phone number yet.')
  });
  function renderCustomerDetail(customer) {
    readCustomer(customer);
    byId('customer-detail-heading').textContent = customer.name;
    const notes = fact('Notes', customer.notes || 'None');
    notes.classList.add('fact-wide');
    notes.querySelector('dd').classList.add('pre');
    byId('customer-detail-facts').replaceChildren(
      fact('Phone', customer.phone), fact('Email', customer.email || 'Not set'), fact('Source', customer.source || 'Not set'),
      fact('District', customer.district || 'Not set'), fact('State', customer.state || 'Not set'), fact('Country', customer.country || 'Not set'),
      fact('Handled by', customer.employees.length ? handlerNames(customer.employees) : 'Unassigned'),
      fact('WhatsApp messages', Number.isInteger(customer.messageCount) ? customer.messageCount : 0),
      fact('Last message', customer.lastMessageAt ? dateText(customer.lastMessageAt) : 'None'),
      fact('Last call', customer.lastCallAt ? dateText(customer.lastCallAt) : 'None'),
      fact('Created', dateText(customer.createdAt)), fact('Updated', dateText(customer.updatedAt)),
      notes, fact('Customer ID', customer.id));
    const messageTotal = Number.isInteger(customer.messageCount) ? customer.messageCount : 0;
    byId('customer-wa-summary').textContent = messageTotal + ' ' + plural(messageTotal, 'message', 'messages') + (customer.lastMessageAt ? ' · Last message ' + dateText(customer.lastMessageAt) : ' · No messages yet');
  }
  function openCustomerDetail(customer, opener) {
    readCustomer(customer);
    closePlayer();
    customerDetail = { customer, opener: opener || null };
    byId('customers-browse').hidden = true;
    byId('customer-detail').hidden = false;
    message('customer-detail-status', '');
    message('customer-detail-error', '');
    message('customer-calls-action-status', '');
    renderCustomerDetail(customer);
    detailCalls.load(true);
    byId('customer-detail-heading').focus();
    byId('customer-detail').scrollIntoView({ block: 'start' });
  }
  function closeCustomerDetail(restoreFocus = true) {
    closePlayer();
    detailCalls.cancel();
    const opener = customerDetail ? customerDetail.opener : null;
    customerDetail = null;
    byId('customer-detail').hidden = true;
    byId('customers-browse').hidden = false;
    if (restoreFocus) (opener && opener.isConnected ? opener : byId('customers-heading')).focus();
  }
  function showCustomerDetail(customer) {
    if (location.hash !== '#customers') location.hash = 'customers';
    showTab();
    if (customerDetail) closeCustomerDetail(false);
    openCustomerDetail(customer, null);
  }
  async function openCustomerById(id) {
    if (location.hash !== '#customers') location.hash = 'customers';
    showTab();
    if (customerDetail) closeCustomerDetail(false);
    message('customers-error', '');
    try {
      const data = await api('/customers/' + encodeURIComponent(id));
      openCustomerDetail(readCustomer(data && data.customer), null);
    } catch (error) {
      message('customers-error', errorMessage(error));
      byId('customers-heading').focus();
    }
  }
  async function refreshCustomerDetail() {
    if (!customerDetail) return;
    const id = customerDetail.customer.id;
    message('customer-detail-error', '');
    try {
      const data = await api('/customers/' + encodeURIComponent(id));
      if (customerDetail && customerDetail.customer.id === id) applyCustomerUpdate(readCustomer(data && data.customer));
    } catch (error) { message('customer-detail-error', errorMessage(error)); }
    if (customerDetail && customerDetail.customer.id === id) detailCalls.load(true);
  }
  byId('customer-detail-back').addEventListener('click', () => closeCustomerDetail());
  byId('customer-detail-refresh').addEventListener('click', refreshCustomerDetail);
  byId('customer-detail-edit').addEventListener('click', (event) => { if (customerDetail) openCustomerDialog(customerDetail.customer, event.currentTarget); });
  byId('customer-detail-handlers').addEventListener('click', (event) => { if (customerDetail) openHandlers(customerDetail.customer, event.currentTarget); });
  byId('customer-detail-archive').addEventListener('click', (event) => { if (customerDetail) openArchive(customerDetail.customer, event.currentTarget); });
  byId('customer-open-chat').addEventListener('click', (event) => { if (customerDetail) openDrawer(customerDetail.customer, event.currentTarget, 'chat'); });

  // ---- Add / edit dialog ----
  const customerDialog = byId('customer-dialog');
  const customerForm = byId('customer-form');
  const customerFieldNames = ['name', 'phone', 'email', 'source', 'district', 'state', 'country', 'notes'];
  const clearableFields = ['email', 'notes', 'source', 'district', 'state'];
  let customerTarget = null;
  let customerOpener = null;
  let customerSaving = false;
  let customerChoicesReady = false;
  let customerDialogVersion = 0;
  function fillEmployeeChoices(container, selected, customer) {
    const children = [];
    const active = Array.from(employees.values()).filter((employee) => employee.active);
    for (const employee of active) {
      const label = element('label', undefined, 'checkbox-filter');
      const input = element('input');
      input.type = 'checkbox';
      input.value = employee.id;
      input.checked = selected.has(employee.id);
      label.append(input, element('span', employee.name + ' · ' + employee.id));
      children.push(label);
    }
    if (!active.length) children.push(element('p', 'No active employees exist yet. Create one in the Employees tab.', 'hint'));
    if (customer && customer.employees.some((employee) => !employees.get(employee.id)?.active)) children.push(element('p', 'Inactive employees cannot be assigned and are removed when the handling employees change.', 'hint'));
    container.replaceChildren(...children);
  }
  function selectedEmployeeIds(container) {
    return Array.from(container.querySelectorAll('input[type=checkbox]:checked'), (input) => input.value);
  }
  function activeHandlerIds(customer) {
    return customer.employees.map((employee) => employee.id).filter((id) => employees.get(id)?.active);
  }
  async function openCustomerDialog(customer, opener) {
    const version = ++customerDialogVersion;
    customerTarget = customer;
    customerOpener = opener || null;
    customerChoicesReady = false;
    customerForm.reset();
    for (const name of customerFieldNames) customerForm.elements.namedItem(name).value = (customer && customer[name]) || (name === 'country' ? 'India' : '');
    byId('customer-dialog-title').textContent = customer ? 'Edit customer' : 'Add customer';
    byId('confirm-customer').textContent = customer ? 'Save changes' : 'Add customer';
    message('customer-dialog-error', '');
    message('customer-dialog-status', '');
    byId('customer-employee-choices').replaceChildren();
    byId('customer-employee-fields').disabled = true;
    customerDialog.showModal();
    customerForm.elements.namedItem('name').focus();
    if (!directoryReady) {
      message('customer-dialog-status', 'Loading employee choices…');
      await loadDirectory();
    }
    if (version !== customerDialogVersion || !customerDialog.open) return;
    message('customer-dialog-status', '');
    if (directoryReady) {
      fillEmployeeChoices(byId('customer-employee-choices'), new Set(customer ? activeHandlerIds(customer) : []), customer);
      byId('customer-employee-fields').disabled = false;
      customerChoicesReady = true;
    } else {
      message('customer-dialog-error', 'Employee choices could not be loaded. You can still save the customer details; handling employees stay unchanged.');
    }
  }
  byId('cancel-customer').addEventListener('click', () => customerDialog.close());
  customerDialog.addEventListener('cancel', (event) => { if (customerSaving) event.preventDefault(); });
  customerDialog.addEventListener('close', () => {
    const opener = customerOpener;
    const id = customerTarget ? customerTarget.id : null;
    customerOpener = null;
    customerTarget = null;
    customerDialogVersion++;
    focusCustomerSurface(opener, id);
  });
  customerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (customerSaving) return;
    const form = new FormData(customerForm);
    const values = {};
    for (const name of customerFieldNames) values[name] = String(form.get(name) || '').trim();
    message('customer-dialog-error', '');
    message('customer-dialog-status', '');
    if (!values.name || values.name.length > 200) { message('customer-dialog-error', 'Enter a name between 1 and 200 characters.'); customerForm.elements.namedItem('name').focus(); return; }
    if (!values.phone) { message('customer-dialog-error', 'Enter a phone number.'); customerForm.elements.namedItem('phone').focus(); return; }
    const target = customerTarget;
    const chosen = customerChoicesReady ? selectedEmployeeIds(byId('customer-employee-choices')) : null;
    if (chosen && chosen.length > 50) { message('customer-dialog-error', 'Choose at most 50 handling employees.'); return; }
    const body = {};
    if (!target) {
      body.name = values.name;
      body.phone = values.phone;
      for (const name of [...clearableFields, 'country']) if (values[name]) body[name] = values[name];
      if (chosen && chosen.length) body.employeeIds = chosen;
    } else {
      if (values.name !== target.name) body.name = values.name;
      if (values.phone !== target.phone) body.phone = values.phone;
      for (const name of clearableFields) if (values[name] !== (target[name] || '')) body[name] = values[name] || null;
      if (values.country && values.country !== (target.country || '')) body.country = values.country;
    }
    const assignmentChanged = Boolean(target && chosen && !sameSet(chosen, activeHandlerIds(target)));
    if (target && !Object.keys(body).length && !assignmentChanged) { message('customer-dialog-status', 'No changes to save.'); return; }
    customerSaving = true;
    byId('customer-fields').disabled = true;
    message('customer-dialog-status', 'Saving customer…');
    let detailsSaved = false;
    try {
      let saved = target;
      if (!target) {
        const data = await api('/customers', { method: 'POST', body: JSON.stringify(body) });
        saved = readCustomer(data && data.customer);
      } else {
        if (Object.keys(body).length) {
          const data = await api('/customers/' + encodeURIComponent(target.id), { method: 'PATCH', body: JSON.stringify(body) });
          saved = readCustomer(data && data.customer);
          customerTarget = saved;
          detailsSaved = true;
          applyCustomerUpdate(saved);
        }
        if (assignmentChanged) {
          const data = await api('/customers/' + encodeURIComponent(target.id) + '/employees', { method: 'PUT', body: JSON.stringify({ employeeIds: chosen }) });
          saved = readCustomer(data && data.customer);
          customerTarget = saved;
          applyCustomerUpdate(saved);
        }
      }
      customerDialog.close();
      if (target) announceCustomer('Saved ' + saved.name + '.');
      else { message('customers-action-status', 'Added ' + saved.name + '.'); customersList.load(true); }
    } catch (failure) {
      customerSaving = false;
      byId('customer-fields').disabled = false;
      message('customer-dialog-status', '');
      message('customer-dialog-error', (detailsSaved ? 'The customer details were saved, but the handling employees could not be updated. ' : '') + errorMessage(failure));
      if (failure.code === 'CUSTOMER_PHONE_EXISTS') customerForm.elements.namedItem('phone').focus();
    } finally {
      customerSaving = false;
      byId('customer-fields').disabled = false;
    }
  });

  // ---- Handled by dialog ----
  const handlersDialog = byId('handlers-dialog');
  let handlersTarget = null;
  let handlersOpener = null;
  let handlersSaving = false;
  let handlersVersion = 0;
  async function openHandlers(customer, opener) {
    const version = ++handlersVersion;
    handlersTarget = customer;
    handlersOpener = opener || null;
    byId('handlers-customer').textContent = customer.name + ' · ' + customer.phone;
    message('handlers-error', '');
    message('handlers-status', '');
    byId('handlers-choices').replaceChildren();
    byId('confirm-handlers').disabled = true;
    handlersDialog.showModal();
    byId('cancel-handlers').focus();
    if (!directoryReady) {
      message('handlers-status', 'Loading employee choices…');
      await loadDirectory();
    }
    if (version !== handlersVersion || !handlersDialog.open) return;
    message('handlers-status', '');
    if (directoryReady) {
      fillEmployeeChoices(byId('handlers-choices'), new Set(activeHandlerIds(customer)), customer);
      byId('confirm-handlers').disabled = false;
      const first = byId('handlers-choices').querySelector('input');
      if (first) first.focus();
    } else {
      message('handlers-error', 'Employee choices could not be loaded. Cancel and reopen to retry.');
    }
  }
  byId('cancel-handlers').addEventListener('click', () => handlersDialog.close());
  handlersDialog.addEventListener('cancel', (event) => { if (handlersSaving) event.preventDefault(); });
  handlersDialog.addEventListener('close', () => {
    const opener = handlersOpener;
    const id = handlersTarget ? handlersTarget.id : null;
    handlersOpener = null;
    handlersTarget = null;
    handlersVersion++;
    focusCustomerSurface(opener, id);
  });
  byId('handlers-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!handlersTarget || handlersSaving || byId('confirm-handlers').disabled) return;
    const employeeIds = selectedEmployeeIds(byId('handlers-choices'));
    message('handlers-error', '');
    if (employeeIds.length > 50) { message('handlers-error', 'Choose at most 50 handling employees.'); return; }
    const target = handlersTarget;
    handlersSaving = true;
    byId('handlers-fields').disabled = true;
    message('handlers-status', 'Saving handling employees…');
    try {
      const data = await api('/customers/' + encodeURIComponent(target.id) + '/employees', { method: 'PUT', body: JSON.stringify({ employeeIds }) });
      const saved = readCustomer(data && data.customer);
      applyCustomerUpdate(saved);
      handlersDialog.close();
      announceCustomer(saved.employees.length ? 'Saved. ' + saved.name + ' is handled by ' + handlerNames(saved.employees) + '.' : 'Saved. ' + saved.name + ' is now unassigned.');
    } catch (failure) {
      message('handlers-status', '');
      message('handlers-error', errorMessage(failure));
    } finally {
      handlersSaving = false;
      byId('handlers-fields').disabled = false;
    }
  });

  // ---- Archive dialog ----
  const archiveDialog = byId('archive-dialog');
  let archiveTarget = null;
  let archiveOpener = null;
  let archiving = false;
  let archiveDone = false;
  function openArchive(customer, opener) {
    if (archiving) return;
    archiveTarget = customer;
    archiveOpener = opener || null;
    archiveDone = false;
    byId('archive-name').textContent = customer.name + ' · ' + customer.phone + ' · ' + customer.id;
    message('archive-error', '');
    archiveDialog.showModal();
    byId('cancel-archive').focus();
  }
  byId('cancel-archive').addEventListener('click', () => { if (!archiving) archiveDialog.close(); });
  archiveDialog.addEventListener('cancel', (event) => { if (archiving) event.preventDefault(); });
  archiveDialog.addEventListener('close', () => {
    const opener = archiveOpener;
    archiveOpener = null;
    archiveTarget = null;
    if (!archiveDone) focusCustomerSurface(opener, null);
  });
  byId('archive-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!archiveTarget || archiving) return;
    const target = archiveTarget;
    archiving = true;
    byId('confirm-archive').disabled = byId('cancel-archive').disabled = true;
    byId('confirm-archive').textContent = 'Archiving…';
    message('archive-error', '');
    try {
      await api('/customers/' + encodeURIComponent(target.id), { method: 'DELETE', body: '{}' });
      archiveDone = true;
      archiveDialog.close();
      if (customerDetail && customerDetail.customer.id === target.id) closeCustomerDetail(false);
      if (drawerState.open && drawerState.id === target.id) closeDrawer(false);
      message('customers-action-status', 'Archived ' + target.name + '. Its WhatsApp messages are kept.');
      await customersList.load(true);
      byId('customers-heading').focus();
    } catch (failure) {
      message('archive-error', errorMessage(failure));
    } finally {
      archiving = false;
      byId('confirm-archive').disabled = byId('cancel-archive').disabled = false;
      byId('confirm-archive').textContent = 'Archive customer';
    }
  });

  // ---- WhatsApp (WhatsApp Web style): chat list, conversation and template picker ----
  // All server strings are rendered with textContent; the only DOM created from constants is the SVG icon set.
  const WA_DAY_MS = 86400000;
  const WA_WINDOW_MS = 24 * 3600000;
  const waTimeFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const waIcons = {
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
    bolt: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z'
  };
  const waStatusInfo = {
    queued: { icon: 'clock', label: 'Sending' },
    sent: { icon: 'tick', label: 'Sent' },
    delivered: { icon: 'ticks', label: 'Delivered' },
    read: { icon: 'ticks', label: 'Read' },
    failed: { icon: 'alert', label: 'Message failed to send' }
  };
  const waNotConfigured = 'WhatsApp sending is not configured.';
  const waWindowClosed = "Free text can only be sent within 24 hours of the customer's last message. Use a template.";
  let waSendState = 'unknown';
  const waConversations = [];

  // ---- Unread tracking: per-viewer counts come from the server. Everything here fails silently. ----
  let unreadVersion = 0;
  function unreadLabel(count) { return count > 99 ? '99+' : String(count); }
  function renderTabBadge(chats) {
    const badge = byId('whatsapp-unread');
    badge.hidden = chats <= 0;
    byId('whatsapp-unread-count').textContent = chats > 0 ? unreadLabel(chats) : '';
    byId('whatsapp-unread-text').textContent = chats > 0 ? chats + ' ' + (chats === 1 ? 'chat' : 'chats') + ' with unread messages' : '';
  }
  async function refreshUnread() {
    if (!featuresLoaded || !features.customers || !features.whatsapp) return;
    const current = ++unreadVersion;
    try {
      const data = await api('/whatsapp/unread');
      if (current !== unreadVersion) return;
      renderTabBadge(data && Number.isInteger(data.chats) && data.chats > 0 ? data.chats : 0);
    } catch { /* The badge keeps its last value until the next refresh. */ }
  }
  // Drops the unread badge from a chat row after the server accepted the mark-read call.
  function clearChatUnread(customerId) {
    const row = byId('whatsapp-list').querySelector('[data-customer-id="' + CSS.escape(customerId) + '"]');
    if (!row) return;
    row.classList.remove('wa-unread');
    const badge = row.querySelector('.wa-unread-badge');
    if (badge) badge.remove();
  }

  // ---- Live updates: one tiny version endpoint is polled; only what is on screen is refreshed when it changes. ----
  // 5 s while a conversation is displayed, 15 s otherwise, paused while the page is hidden, doubled up to 60 s after failures.
  const LIVE_ACTIVE_MS = 5000;
  const LIVE_IDLE_MS = 15000;
  const LIVE_MAX_MS = 60000;
  let liveTimer = 0;
  let liveSeen = null;
  let liveFailures = 0;
  let liveBusy = false;
  let liveWhatsAppStale = false;
  function liveInterval() {
    const base = waConversations.some((conversation) => conversation.displayed()) ? LIVE_ACTIVE_MS : LIVE_IDLE_MS;
    return Math.min(LIVE_MAX_MS, base * 2 ** liveFailures);
  }
  function scheduleLive() {
    clearTimeout(liveTimer);
    liveTimer = 0;
    if (!document.hidden) liveTimer = setTimeout(pollLive, liveInterval());
  }
  // Refreshes the open customer summary (Customers tab detail and drawer) without any loading state.
  async function refreshOpenCustomers() {
    const ids = new Set();
    if (drawerState.open && drawerState.id) ids.add(drawerState.id);
    if (activeTab === 'customers' && customerDetail) ids.add(customerDetail.customer.id);
    await Promise.all(Array.from(ids, async (id) => {
      try {
        const data = await api('/customers/' + encodeURIComponent(id));
        const customer = readCustomer(data && data.customer);
        const open = (drawerState.open && drawerState.id === id) || (customerDetail && customerDetail.customer.id === id);
        if (!open) return;
        const keepChat = drawerState.chatId;
        applyCustomerUpdate(customer);
        drawerState.chatId = keepChat;
      } catch { /* The summary refreshes with the next change or when it is reopened. */ }
    }));
  }
  async function refreshLive() {
    const tasks = [refreshUnread()];
    if (activeTab === 'whatsapp' && chatsLoaded) tasks.push(chatList.refresh());
    else liveWhatsAppStale = true;
    for (const conversation of waConversations) if (conversation.displayed()) tasks.push(conversation.poll());
    tasks.push(refreshOpenCustomers());
    const results = await Promise.all(tasks);
    return results.every((result) => result !== false);
  }
  async function pollLive() {
    clearTimeout(liveTimer);
    if (!featuresLoaded || !features.customers || !features.whatsapp) return;
    liveTimer = 0;
    if (document.hidden || liveBusy) return;
    liveBusy = true;
    let ok = false;
    try {
      const data = await api('/whatsapp/version');
      if (!data || !Number.isSafeInteger(data.version)) throw new Error('The server returned an unreadable version.');
      if (liveSeen === null) {
        liveSeen = data.version;
        ok = true;
      } else if (data.version !== liveSeen) {
        ok = await refreshLive();
        if (ok) liveSeen = data.version;
      } else {
        ok = true;
      }
    } catch { /* Backs off below and tries again. */ }
    liveBusy = false;
    liveFailures = ok ? 0 : liveFailures + 1;
    scheduleLive();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(liveTimer);
      liveTimer = 0;
      return;
    }
    pollLive();
    for (const conversation of waConversations) conversation.markRead();
  });

  // ---- Quick messages: one cache shared by the Config tab and every composer ----
  const QUICK_STALE_MS = 60000;
  const QUICK_PLACEHOLDER = /\{\{\s*(name|handler_name|handler_phone)\s*\}\}/g;
  const quickPlaceholderNames = { name: 'the customer name', handler_name: 'the handler name', handler_phone: 'the handler phone number' };
  const quickState = { items: null, loadedAt: 0, promise: null, error: '' };
  const quickSubscribers = new Set();
  function notifyQuick() { for (const listener of Array.from(quickSubscribers)) listener(); }
  function readQuickMessage(item) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.text !== 'string') return null;
    return { id: item.id, title: item.title, text: item.text };
  }
  function setQuickItems(items) {
    quickState.items = items.slice().sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    quickState.loadedAt = Date.now();
    quickState.error = '';
    notifyQuick();
  }
  // Resolves once the cache is fresh (or the refresh failed; the failure is kept in quickState.error).
  function loadQuickMessages(force) {
    if (quickState.promise) return quickState.promise;
    if (!force && quickState.items && Date.now() - quickState.loadedAt < QUICK_STALE_MS) return Promise.resolve();
    const promise = api('/whatsapp/quick-messages').then((data) => {
      if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable quick messages. Please try again.');
      setQuickItems(data.items.map(readQuickMessage).filter(Boolean));
    }).catch((error) => {
      quickState.error = errorMessage(error);
    }).then(() => {
      quickState.promise = null;
      notifyQuick();
    });
    quickState.promise = promise;
    quickState.error = '';
    notifyQuick();
    return promise;
  }
  // Replaces {{name}}, {{handler_name}} and {{handler_phone}}. Placeholders without a value stay as typed and are reported in missing.
  function fillQuickPlaceholders(text, values) {
    const missing = [];
    const filled = text.replace(QUICK_PLACEHOLDER, (whole, key) => {
      const value = String(values[key] || '').trim();
      if (value) return value;
      if (!missing.includes(key)) missing.push(key);
      return whole;
    });
    return { text: filled, missing };
  }

  function waIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'wa-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', waIcons[name]);
    svg.append(path);
    return svg;
  }
  function waIconButton(icon, label, className) {
    const button = element('button', undefined, 'wa-icon-btn' + (className ? ' ' + className : ''));
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(waIcon(icon));
    return button;
  }
  function waStatusMark(status, detail) {
    if (!Object.hasOwn(waStatusInfo, status)) return null;
    const info = waStatusInfo[status];
    const mark = element('span', undefined, 'wa-mark wa-' + status);
    const label = detail ? info.label + ' · ' + detail : info.label;
    mark.title = label;
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', label);
    mark.append(waIcon(info.icon));
    return mark;
  }
  function waDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function waTime(value) {
    const date = waDate(value);
    return date ? waTimeFormat.format(date) : '';
  }
  function waDayStart(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
  function waDaysAgo(date) { return Math.round((waDayStart(new Date()) - waDayStart(date)) / WA_DAY_MS); }
  function waDayLabel(date) {
    const ago = waDaysAgo(date);
    if (ago === 0) return 'Today';
    if (ago === 1) return 'Yesterday';
    return date.toLocaleDateString([], ago > 1 && ago < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function waListTime(value) {
    const date = waDate(value);
    if (!date) return '';
    const ago = waDaysAgo(date);
    if (ago === 0) return waTimeFormat.format(date);
    if (ago === 1) return 'Yesterday';
    return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function waInitials(name) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const first = Array.from(words[0])[0];
    const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
    return (first + last).toUpperCase();
  }
  function waAvatar(name, id) {
    let hash = 0;
    for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    const node = element('span', waInitials(name), 'wa-avatar wa-av' + (hash % 8));
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  function readWaMessage(item) {
    if (!item || typeof item.id !== 'string' || !['in', 'out'].includes(item.direction) || typeof item.sentAt !== 'string') throw new Error('A WhatsApp message could not be read. Please refresh.');
    return item;
  }
  function waMessageText(item) {
    if (item.body) return item.body;
    if (item.templateName) return 'Template: ' + item.templateName;
    const label = messageTypeLabel(item.messageType);
    return label ? '[' + label + ']' : 'No text';
  }
  const WA_MEDIA_LABELS = { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', sticker: 'Sticker' };
  const WA_MEDIA_PREVIEW = { image: 'Photo', video: 'Video', audio: 'Audio', document: 'Document', sticker: 'Sticker' };
  function readWaMedia(item) {
    const media = item.media;
    if (!media || typeof media !== 'object' || !Object.hasOwn(WA_MEDIA_LABELS, media.kind)) return null;
    if (typeof media.url !== 'string' || !media.url.startsWith('/') || media.url.startsWith('//')) return null;
    return media;
  }
  function waFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return Math.round(bytes) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
  const mediaDialog = byId('media-dialog');
  const mediaImage = byId('media-image');
  let mediaOpener = null;
  byId('media-close').append(waIcon('close'));
  const mediaDownload = byId('media-download');
  mediaDownload.prepend(waIcon('download'));
  function openMediaViewer(media, alt, opener, id) {
    mediaOpener = opener;
    mediaImage.alt = alt;
    mediaImage.src = media.url;
    mediaDownload.href = media.url;
    mediaDownload.setAttribute('download', waDownloadName(media, id));
    mediaDownload.setAttribute('aria-label', 'Download ' + (media.kind === 'sticker' ? 'sticker' : 'image'));
    mediaDialog.showModal();
    byId('media-close').focus();
  }
  byId('media-close').addEventListener('click', () => mediaDialog.close());
  mediaDialog.addEventListener('click', (event) => { if (event.target === mediaDialog) mediaDialog.close(); });
  mediaDialog.addEventListener('close', () => {
    mediaImage.removeAttribute('src');
    mediaDownload.removeAttribute('href');
    const opener = mediaOpener;
    mediaOpener = null;
    if (opener && opener.isConnected) opener.focus();
  });
  const WA_EXTENSIONS = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf'
  };
  function waDownloadName(media, id) {
    if (typeof media.fileName === 'string' && media.fileName.trim()) return media.fileName.trim();
    const type = typeof media.mimeType === 'string' ? media.mimeType.split(';')[0].trim().toLowerCase() : '';
    const subtype = type.includes('/') ? type.split('/')[1].replace(/[^a-z0-9]/g, '') : '';
    const extension = Object.hasOwn(WA_EXTENSIONS, type) ? WA_EXTENSIONS[type] : subtype.slice(0, 8) || 'bin';
    return 'whatsapp-' + media.kind + '-' + String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '.' + extension;
  }
  // Icon-only download link for image, sticker, video and audio bubbles. The server sets the real Content-Type.
  function waDownloadLink(media, id) {
    const label = 'Download ' + (media.kind === 'sticker' ? 'sticker' : media.kind);
    const link = element('a', undefined, 'wa-icon-btn wa-media-dl');
    link.href = media.url;
    link.setAttribute('download', waDownloadName(media, id));
    link.setAttribute('aria-label', label);
    link.title = label;
    link.rel = 'noopener';
    link.append(waIcon('download'));
    return link;
  }
  function waMediaNode(media, caption, id) {
    const wrap = element('div', undefined, 'wa-media wa-media-' + media.kind);
    const label = WA_MEDIA_LABELS[media.kind];
    const failed = () => {
      wrap.className = 'wa-media wa-media-failed';
      wrap.replaceChildren(element('span', label + ' unavailable', 'wa-media-gone'));
    };
    if (media.kind === 'image' || media.kind === 'sticker') {
      const alt = caption || (media.kind === 'sticker' ? 'Sticker from customer' : 'Image from customer');
      const button = element('button', undefined, 'wa-media-btn');
      button.type = 'button';
      button.setAttribute('aria-label', 'View full size: ' + alt);
      const image = document.createElement('img');
      image.alt = alt;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('load', () => wrap.classList.add('wa-media-loaded'));
      image.addEventListener('error', failed);
      image.src = media.url;
      button.append(image);
      button.addEventListener('click', () => openMediaViewer(media, alt, button, id));
      const frame = element('div', undefined, 'wa-media-frame');
      frame.append(button, waDownloadLink(media, id));
      wrap.append(frame);
    } else if (media.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.setAttribute('aria-label', caption || 'Video from customer');
      video.addEventListener('error', failed);
      video.src = media.url;
      const frame = element('div', undefined, 'wa-media-frame');
      frame.append(video, waDownloadLink(media, id));
      wrap.append(frame);
    } else if (media.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.setAttribute('aria-label', caption || 'Audio message');
      audio.addEventListener('error', failed);
      audio.src = media.url;
      const frame = element('div', undefined, 'wa-media-frame wa-media-audio-frame');
      frame.append(audio, waDownloadLink(media, id));
      wrap.append(frame);
    } else {
      const icon = element('span', undefined, 'wa-doc-icon');
      icon.append(waIcon('document'));
      const info = element('span', undefined, 'wa-doc-info');
      info.append(element('span', typeof media.fileName === 'string' && media.fileName ? media.fileName : 'Document', 'wa-doc-name'));
      const size = waFileSize(media.size);
      if (size) info.append(element('span', size, 'wa-doc-size'));
      const link = element('a', 'Download', 'wa-doc-link');
      link.href = media.url;
      link.setAttribute('download', waDownloadName(media, id));
      link.setAttribute('aria-label', 'Download ' + (typeof media.fileName === 'string' && media.fileName ? media.fileName : 'document'));
      link.rel = 'noopener';
      wrap.append(icon, info, link);
    }
    return wrap;
  }
  function waBubble(item, first) {
    const out = item.direction === 'out';
    const node = element('div', undefined, 'wa-msg ' + item.direction + (first ? ' wa-first' : ''));
    node.dataset.messageId = item.id;
    const bubble = element('div', undefined, 'wa-bubble');
    if (item.templateName) bubble.append(element('span', 'Template', 'wa-tag'));
    const media = readWaMedia(item);
    if (media) {
      bubble.classList.add('wa-has-media', 'wa-has-' + media.kind);
      if (media.kind === 'sticker' && !item.body) bubble.classList.add('wa-sticker');
      bubble.append(waMediaNode(media, item.body, item.id));
      if (item.body) bubble.append(element('div', item.body, 'wa-text'));
    } else {
      bubble.append(element('div', waMessageText(item), 'wa-text'));
    }
    const meta = element('span', undefined, 'wa-meta');
    if (out && item.sentBy && typeof item.sentBy.name === 'string') meta.append(element('span', item.sentBy.name, 'wa-by'));
    const time = element('time', waTime(item.sentAt), 'wa-time');
    time.dateTime = item.sentAt;
    time.title = dateText(item.sentAt);
    meta.append(time);
    if (out) {
      const detail = item.status === 'read' && item.readAt ? dateText(item.readAt) : item.status === 'delivered' && item.deliveredAt ? dateText(item.deliveredAt) : '';
      const mark = waStatusMark(item.status, detail);
      if (mark) meta.append(mark);
    }
    bubble.append(meta);
    node.append(bubble);
    return node;
  }
  function waDaySeparator(date) {
    const separator = element('div', undefined, 'wa-day');
    separator.append(element('span', waDayLabel(date)));
    return separator;
  }

  // One conversation view: header (not when embedded), scrolling message list, 24h banner and composer.
  // Messages are kept newest first (server order) and drawn oldest first with the newest at the bottom.
  // Older pages load when the list is scrolled near its top (or with the "Load older messages" button) and keep the visible message in place.
  function createConversation(root, options) {
    const embedded = Boolean(options.embedded);
    const headAvatar = element('span', undefined, 'wa-head-avatar');
    const headName = element('h2', undefined, 'wa-head-name');
    headName.tabIndex = -1;
    const headNameButton = element('button', undefined, 'link-button wa-name-btn');
    headNameButton.type = 'button';
    headName.append(headNameButton);
    const headSub = element('p', undefined, 'wa-head-sub');
    const back = waIconButton('back', 'Back to chats', 'wa-back');
    const openCustomer = element('button', 'View customer', 'wa-text-btn wa-open-customer');
    openCustomer.type = 'button';
    const head = element('header', undefined, 'wa-conv-head');
    const headText = element('div', undefined, 'wa-head-text');
    headText.append(headName, headSub);
    head.append(back, headAvatar, headText, openCustomer);

    const loadStatus = element('p', undefined, 'wa-status');
    loadStatus.setAttribute('role', 'status');
    loadStatus.setAttribute('aria-live', 'polite');
    loadStatus.setAttribute('aria-atomic', 'true');
    const loadError = element('div', undefined, 'wa-notice wa-error');
    loadError.setAttribute('role', 'alert');
    loadError.hidden = true;
    const loadErrorText = element('span');
    const retry = element('button', 'Try again', 'wa-text-btn');
    retry.type = 'button';
    loadError.append(loadErrorText, retry);

    const scroller = element('div', undefined, 'wa-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Messages, oldest first, newest at the bottom');
    const older = element('button', 'Load older messages', 'wa-older');
    older.type = 'button';
    older.hidden = true;
    const list = element('div', undefined, 'wa-list');
    scroller.append(older, list);
    const newPill = element('button', 'New messages', 'wa-new-pill');
    newPill.type = 'button';
    newPill.hidden = true;
    const scrollWrap = element('div', undefined, 'wa-scroll-wrap');
    scrollWrap.append(scroller, newPill);

    const banner = element('p', undefined, 'wa-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const sendError = element('p', undefined, 'wa-notice wa-error');
    sendError.setAttribute('role', 'alert');
    sendError.hidden = true;
    const form = element('form', undefined, 'wa-composer');
    form.setAttribute('aria-label', 'Send WhatsApp message');
    const templateButton = waIconButton('document', 'Send a template message', 'wa-template-btn');
    const input = element('textarea', undefined, 'wa-input');
    input.rows = 1;
    input.maxLength = 4096;
    input.setAttribute('aria-label', 'Message');
    input.placeholder = 'Type a message';
    const sendButton = waIconButton('send', 'Send message', 'wa-send');
    sendButton.type = 'submit';
    const quickButton = waIconButton('bolt', 'Quick messages', 'wa-quick-btn');
    quickButton.setAttribute('aria-expanded', 'false');
    form.append(templateButton, quickButton, input, sendButton);
    const quickPanel = element('div', undefined, 'wa-quick');
    quickPanel.hidden = true;
    quickPanel.tabIndex = -1;
    quickPanel.setAttribute('role', 'group');
    quickPanel.setAttribute('aria-label', 'Quick messages');
    const quickSearch = element('input', undefined, 'wa-quick-search');
    quickSearch.type = 'search';
    quickSearch.placeholder = 'Search quick messages';
    quickSearch.maxLength = 100;
    quickSearch.autocomplete = 'off';
    quickSearch.setAttribute('aria-label', 'Search quick messages');
    const quickNote = element('p', undefined, 'wa-quick-note');
    quickNote.setAttribute('role', 'status');
    quickNote.setAttribute('aria-live', 'polite');
    const quickRetry = element('button', 'Try again', 'wa-text-btn');
    quickRetry.type = 'button';
    const quickList = element('ul', undefined, 'wa-quick-list');
    quickList.setAttribute('role', 'list');
    quickPanel.append(quickSearch, quickNote, quickRetry, quickList);
    const quickNotice = element('p', undefined, 'wa-banner');
    quickNotice.setAttribute('role', 'status');
    quickNotice.hidden = true;
    const composerWrap = element('div', undefined, 'wa-composer-wrap');
    composerWrap.append(quickPanel, form);

    root.replaceChildren();
    if (!embedded) root.append(head);
    root.append(loadError, loadStatus, scrollWrap, banner, quickNotice, sendError, composerWrap);

    let customer = null;
    let messages = [];
    let next = null;
    let loaded = false;
    let busy = false;
    let version = 0;
    let controller;
    let pending = false;
    let attempt = null;
    let serverClosed = false;
    let stickToBottom = false;
    let bubbleCache = new Map();
    let openToken = 0;
    let markedKey = null;
    let markingKey = null;
    let handlerCache = null;
    function customerHandlers() {
      if (!customer) return Promise.resolve([]);
      const id = customer.id;
      if (!handlerCache || handlerCache.id !== id) {
        const held = Array.isArray(customer.employees) ? customer.employees : null;
        const cache = { id, promise: held ? Promise.resolve(held) : api('/customers/' + encodeURIComponent(id)).then((data) => readCustomer(data && data.customer).employees) };
        cache.promise.catch(() => { if (handlerCache === cache) handlerCache = null; });
        handlerCache = cache;
      }
      return handlerCache.promise;
    }

    let quickOpen = false;
    function showQuickNotice(text) {
      quickNotice.textContent = text;
      quickNotice.hidden = !text;
    }
    function renderQuick() {
      const items = quickState.items;
      const showSearch = Boolean(items) && items.length > 8;
      quickSearch.hidden = !showSearch;
      if (!showSearch) quickSearch.value = '';
      const query = quickSearch.value.trim().toLowerCase();
      const shown = (items || []).filter((item) => !query || (item.title + ' ' + item.text).toLowerCase().includes(query));
      quickList.replaceChildren(...shown.map((item) => {
        const row = element('li');
        const choice = element('button', undefined, 'wa-quick-item');
        choice.type = 'button';
        choice.dataset.quickId = item.id;
        choice.append(element('span', item.title, 'wa-quick-title'), element('span', item.text.replace(/\s+/g, ' ').trim().slice(0, 200), 'wa-quick-preview'));
        choice.addEventListener('click', () => useQuick(item));
        row.append(choice);
        return row;
      }));
      quickRetry.hidden = !quickState.error;
      if (!items) {
        quickNote.replaceChildren(quickState.error ? 'Could not load quick messages. ' + quickState.error : 'Loading quick messages…');
      } else if (!items.length) {
        const link = element('a', 'Config');
        link.href = '#config';
        link.addEventListener('click', () => { closeQuick(false); if (embedded) closeDrawer(false); });
        quickNote.replaceChildren('No quick messages yet, add them in ', link);
      } else if (!shown.length) {
        quickNote.replaceChildren('No quick messages match your search.');
      } else if (quickState.error) {
        quickNote.replaceChildren('Could not refresh quick messages. ' + quickState.error);
      } else {
        quickNote.replaceChildren();
      }
    }
    function focusQuick() {
      const first = quickList.querySelector('button');
      if (!quickSearch.hidden) quickSearch.focus();
      else if (first) first.focus();
      else if (!quickRetry.hidden) quickRetry.focus();
      else quickPanel.focus();
    }
    function onQuickChange() {
      const active = document.activeElement;
      const keepId = active && quickList.contains(active) ? active.dataset.quickId : null;
      const onPanel = active === quickPanel;
      renderQuick();
      if (keepId) {
        const same = quickList.querySelector('[data-quick-id="' + CSS.escape(keepId) + '"]');
        if (same) same.focus(); else focusQuick();
      } else if (onPanel || (active === quickRetry && quickRetry.hidden)) {
        focusQuick();
      }
    }
    function quickOutside(event) {
      if (!composerWrap.contains(event.target)) closeQuick(false);
    }
    function closeQuick(restoreFocus) {
      if (!quickOpen) return;
      quickOpen = false;
      quickPanel.hidden = true;
      quickButton.setAttribute('aria-expanded', 'false');
      quickSubscribers.delete(onQuickChange);
      document.removeEventListener('pointerdown', quickOutside, true);
      document.removeEventListener('focusin', quickOutside);
      if (restoreFocus && !quickButton.disabled) quickButton.focus();
    }
    function openQuick() {
      if (quickOpen || quickButton.disabled) return;
      quickOpen = true;
      quickSearch.value = '';
      quickPanel.hidden = false;
      quickButton.setAttribute('aria-expanded', 'true');
      quickSubscribers.add(onQuickChange);
      document.addEventListener('pointerdown', quickOutside, true);
      document.addEventListener('focusin', quickOutside);
      renderQuick();
      focusQuick();
      loadQuickMessages(false);
    }
    // Inserts the chosen text, with placeholders filled, into the message box. Nothing is sent.
    async function useQuick(item) {
      if (!customer || input.disabled) return;
      const customerId = customer.id;
      const values = { name: customer.name, handler_name: '', handler_phone: '' };
      closeQuick(false);
      input.focus();
      if (/\{\{\s*handler_(name|phone)\s*\}\}/.test(item.text)) {
        try {
          const handler = (await customerHandlers())[0];
          if (handler) {
            values.handler_name = handler.name;
            values.handler_phone = (employees.get(handler.id) || {}).phoneNumber || '';
          }
        } catch { /* the handler placeholders are reported as left as typed */ }
      }
      if (!customer || customer.id !== customerId || input.disabled) return;
      const filled = fillQuickPlaceholders(item.text, values);
      const base = input.value.trim() ? input.value : '';
      const gap = !base || /\s$/.test(base) ? '' : base.includes('\n') || filled.text.includes('\n') ? '\n' : ' ';
      const combined = base + gap + filled.text;
      if (combined.length > input.maxLength) {
        showQuickNotice('Not inserted: the message would be longer than ' + input.maxLength + ' characters.');
        return;
      }
      input.value = combined;
      input.rows = Math.min(5, combined.split('\n').length);
      controls();
      input.focus();
      input.setSelectionRange(combined.length, combined.length);
      input.scrollTop = input.scrollHeight;
      showQuickNotice(filled.missing.length ? 'Left as typed: ' + filled.missing.map((key) => '{{' + key + '}} (' + quickPlaceholderNames[key] + ' is not available)').join(', ') + '. Edit the message before sending.' : '');
    }

    function time(item) { return Date.parse(item.sentAt) || 0; }
    function windowState() {
      if (!loaded) return 'unknown';
      if (serverClosed) return 'closed';
      const incoming = messages.find((item) => item.direction === 'in');
      if (incoming) return Date.now() - time(incoming) < WA_WINDOW_MS ? 'open' : 'closed';
      if (!next) return 'closed';
      return Date.now() - time(messages[messages.length - 1]) >= WA_WINDOW_MS ? 'closed' : 'unknown';
    }
    function controls() {
      const state = windowState();
      const canSend = waSendState === 'yes' && Boolean(customer);
      const textOff = pending || !canSend || state === 'closed';
      input.disabled = textOff;
      input.placeholder = state === 'closed' ? 'Use a template to message this customer' : 'Type a message';
      sendButton.disabled = textOff || !input.value.trim();
      templateButton.disabled = pending || !canSend;
      quickButton.disabled = textOff;
      if (quickButton.disabled) closeQuick(false);
      older.disabled = busy;
      const text = waSendState === 'no' ? waNotConfigured : state === 'closed' && customer ? waWindowClosed : '';
      banner.textContent = text;
      banner.hidden = !text;
    }
    function setSendError(text) {
      sendError.textContent = text;
      sendError.hidden = !text;
    }
    function setLoadError(text, canRetry) {
      loadErrorText.textContent = text;
      retry.hidden = !canRetry;
      loadError.hidden = !text;
    }
    function firstVisible() {
      const top = scroller.getBoundingClientRect().top;
      for (const node of list.children) if (node.dataset.messageId && node.getBoundingClientRect().bottom > top) return node;
      return null;
    }
    function render(mode) {
      const anchor = mode === 'prepend' ? firstVisible() : null;
      const anchorId = anchor ? anchor.dataset.messageId : '';
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      const content = document.createDocumentFragment();
      // Unchanged bubbles keep their nodes so playing audio/video, loaded images and focus survive a refresh.
      const nextCache = new Map();
      let day;
      let direction = '';
      for (let index = messages.length - 1; index >= 0; index--) {
        const item = messages[index];
        const date = waDate(item.sentAt);
        const key = date ? waDayStart(date) : null;
        if (key !== day) {
          if (date) content.append(waDaySeparator(date));
          day = key;
          direction = '';
        }
        const first = item.direction !== direction;
        const signature = JSON.stringify(item) + (first ? '|first' : '');
        const cached = bubbleCache.get(item.id);
        const entry = cached && cached.signature === signature ? cached : { signature, node: waBubble(item, first) };
        nextCache.set(item.id, entry);
        content.append(entry.node);
        direction = item.direction;
      }
      if (loaded && !messages.length) content.append(element('p', 'No messages yet. Send a template to start the conversation.', 'wa-empty'));
      const active = document.activeElement;
      const held = active && list.contains(active) ? active : null;
      list.replaceChildren(content);
      bubbleCache = nextCache;
      if (held && held.isConnected && document.activeElement !== held) held.focus({ preventScroll: true });
      older.hidden = !loaded || !next;
      older.disabled = busy;
      if (mode === 'bottom') {
        scroller.scrollTop = scroller.scrollHeight;
        newPill.hidden = true;
      } else if (anchorId) {
        const again = list.querySelector('[data-message-id="' + CSS.escape(anchorId) + '"]');
        if (again) scroller.scrollTop += again.getBoundingClientRect().top - anchorTop;
      }
    }
    function merge(items) {
      const byMessage = new Map();
      for (const item of items) byMessage.set(item.id, item);
      for (const item of messages) if (!byMessage.has(item.id)) byMessage.set(item.id, item);
      messages = Array.from(byMessage.values()).sort((a, b) => time(b) - time(a));
    }
    async function load(mode) {
      if (!customer) return;
      if (mode === 'older' && (busy || !next || !loaded)) return;
      const current = ++version;
      if (controller) controller.abort();
      controller = new AbortController();
      const id = customer.id;
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
      const stick = stickToBottom || nearBottom;
      stickToBottom = false;
      if (mode === 'reset') {
        messages = [];
        next = null;
        loaded = false;
        bubbleCache = new Map();
        newPill.hidden = true;
        list.replaceChildren();
      }
      busy = true;
      setLoadError('', false);
      loadStatus.textContent = mode === 'older' ? 'Loading older messages…' : 'Loading messages…';
      controls();
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (mode === 'older') params.set('cursor', next);
        const data = readPage(await api('/customers/' + encodeURIComponent(id) + '/messages?' + params, { signal: controller.signal }));
        if (current !== version) return;
        const items = data.items.map(readWaMessage);
        if (mode === 'older') {
          if (data.nextCursor && data.nextCursor === next) throw new Error('Pagination did not advance. Reload to restart.');
          merge(items);
          next = data.nextCursor;
          render('prepend');
        } else if (mode === 'refresh' && loaded) {
          const known = new Set(messages.map((item) => item.id));
          const overlaps = !messages.length || !data.nextCursor || items.some((item) => known.has(item.id));
          if (overlaps) {
            merge(items);
            if (!known.size) next = data.nextCursor;
          } else {
            messages = items.slice();
            next = data.nextCursor;
          }
          render(stick ? 'bottom' : 'keep');
        } else {
          messages = items.slice();
          next = data.nextCursor;
          loaded = true;
          render('bottom');
        }
        loaded = true;
        loadStatus.textContent = '';
        markRead();
      } catch (error) {
        if (current !== version || error.name === 'AbortError') return;
        loadStatus.textContent = '';
        setLoadError('Could not load messages. ' + errorMessage(error), !loaded || mode !== 'older');
      } finally {
        if (current === version) {
          busy = false;
          controls();
          if (loaded && next && loadError.hidden && scroller.scrollHeight <= scroller.clientHeight + 4) load('older');
        }
      }
    }
    // Live update: re-reads the newest page without a loading state and merges it by id.
    // Stays at the bottom only when the reader already was there; otherwise the scroll position is left alone and a pill offers the jump.
    // Resolves false when the request failed so the poller can back off.
    async function poll() {
      if (!customer || !loaded || busy) return true;
      const current = ++version;
      if (controller) controller.abort();
      controller = new AbortController();
      const id = customer.id;
      const stick = stickToBottom || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
      try {
        const data = readPage(await api('/customers/' + encodeURIComponent(id) + '/messages?' + new URLSearchParams({ limit: '50' }), { signal: controller.signal }));
        if (current !== version) return true;
        const items = data.items.map(readWaMessage);
        const known = new Map(messages.map((item) => [item.id, JSON.stringify(item)]));
        const added = items.filter((item) => !known.has(item.id)).length;
        const changed = added > 0 || items.some((item) => known.get(item.id) !== JSON.stringify(item));
        if (changed) {
          const overlaps = !messages.length || !data.nextCursor || items.some((item) => known.has(item.id));
          if (overlaps) {
            const empty = !messages.length;
            merge(items);
            if (empty) next = data.nextCursor;
          } else {
            messages = items.slice();
            next = data.nextCursor;
          }
          render(stick ? 'bottom' : 'keep');
          if (added > 0 && !stick) newPill.hidden = false;
          controls();
        }
        markRead();
        return true;
      } catch (error) {
        return error.name === 'AbortError' || current !== version;
      }
    }
    async function sendText() {
      if (pending || !customer || waSendState !== 'yes') return;
      const text = input.value.trim();
      if (!text) return;
      const customerId = customer.id;
      const key = customerId + '|' + text;
      if (!attempt || attempt.key !== key) attempt = { key, id: crypto.randomUUID() };
      pending = true;
      setSendError('');
      showQuickNotice('');
      controls();
      let needTemplate = false;
      try {
        await api('/customers/' + encodeURIComponent(customerId) + '/messages', { method: 'POST', body: JSON.stringify({ clientMessageId: attempt.id, text }) });
        attempt = null;
        if (customer && customer.id === customerId) {
          input.value = '';
          input.rows = 1;
          stickToBottom = true;
          load('refresh');
          if (options.onSent) options.onSent();
          refreshUnread();
        }
      } catch (error) {
        if (customer && customer.id === customerId) {
          if (error.status === 409 && error.code === 'TEMPLATE_REQUIRED') {
            serverClosed = true;
            needTemplate = true;
          } else if (error.status === 502) {
            setSendError('WhatsApp could not send the message. Try again.');
          } else {
            setSendError(errorMessage(error));
          }
        }
      } finally {
        pending = false;
        controls();
        if (needTemplate) templateButton.focus();
      }
    }
    // Marks the open chat read for this viewer once per newest customer message while it is displayed and the page is visible.
    // A hidden page or a failed call is retried by the next refresh, tab switch or visibilitychange.
    async function markRead() {
      if (!customer || !loaded || document.hidden || !options.isDisplayed || !options.isDisplayed()) return;
      const incoming = messages.find((item) => item.direction === 'in');
      const key = incoming ? incoming.id : '';
      if (key === markedKey || key === markingKey) return;
      const id = customer.id;
      const token = openToken;
      markingKey = key;
      try {
        await api('/whatsapp/chats/' + encodeURIComponent(id) + '/read', { method: 'POST' });
      } catch {
        if (token === openToken) markingKey = null;
        return;
      }
      if (token === openToken) {
        markingKey = null;
        markedKey = key;
        const latest = messages.find((item) => item.direction === 'in');
        if ((latest ? latest.id : '') !== key) { markRead(); return; }
      }
      clearChatUnread(id);
      refreshUnread();
    }
    older.addEventListener('click', () => load('older'));
    retry.addEventListener('click', () => load(loaded ? 'refresh' : 'reset'));
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollTop < 120) load('older');
      if (!newPill.hidden && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160) newPill.hidden = true;
    }, { passive: true });
    newPill.addEventListener('click', () => {
      newPill.hidden = true;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.focus({ preventScroll: true });
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); sendText(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    input.addEventListener('input', () => {
      input.rows = Math.min(5, input.value.split('\n').length);
      controls();
    });
    templateButton.addEventListener('click', () => {
      if (!customer) return;
      openTemplatePicker({
        customerId: () => (customer ? customer.id : null),
        customerName: () => (customer ? customer.name : ''),
        handlers: customerHandlers,
        opener: templateButton,
        onSent: () => {
          stickToBottom = true;
          load('refresh');
          if (options.onSent) options.onSent();
          refreshUnread();
        }
      });
    });
    quickButton.addEventListener('click', () => { if (quickOpen) closeQuick(true); else openQuick(); });
    quickSearch.addEventListener('input', renderQuick);
    quickRetry.addEventListener('click', () => { quickPanel.focus(); loadQuickMessages(true); });
    composerWrap.addEventListener('keydown', (event) => {
      if (!quickOpen || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeQuick(true);
        return;
      }
      if (!quickPanel.contains(event.target)) return;
      const choices = Array.from(quickList.querySelectorAll('button'));
      const index = choices.indexOf(event.target);
      let target = null;
      if (event.key === 'ArrowDown' && choices.length) target = choices[index < 0 ? 0 : (index + 1) % choices.length];
      else if (event.key === 'ArrowUp' && choices.length && index >= 0) target = index === 0 && !quickSearch.hidden ? quickSearch : choices[(index + choices.length - 1) % choices.length];
      else if (event.key === 'Home' && index >= 0) target = choices[0];
      else if (event.key === 'End' && index >= 0) target = choices[choices.length - 1];
      else if (event.key === 'Enter' && event.target === quickSearch && choices.length) target = choices[0];
      if (!target) return;
      event.preventDefault();
      if (event.key === 'Enter') target.click(); else target.focus();
    });
    back.addEventListener('click', () => { if (options.onBack) options.onBack(); });
    openCustomer.addEventListener('click', (event) => { if (options.onOpenCustomer) options.onOpenCustomer(event.currentTarget); });
    headNameButton.addEventListener('click', (event) => { if (options.onOpenCustomer) options.onOpenCustomer(event.currentTarget); });
    const conversation = {
      controls,
      open(target, subtitle) {
        customer = target;
        openToken++;
        markedKey = null;
        markingKey = null;
        handlerCache = null;
        serverClosed = false;
        attempt = null;
        input.value = '';
        input.rows = 1;
        setSendError('');
        showQuickNotice('');
        closeQuick(false);
        headAvatar.replaceChildren(waAvatar(target.name, target.id));
        headNameButton.textContent = target.name;
        headSub.textContent = subtitle || target.phone;
        load('reset');
      },
      close() {
        openToken++;
        markedKey = null;
        markingKey = null;
        version++;
        if (controller) controller.abort();
        customer = null;
        handlerCache = null;
        messages = [];
        next = null;
        loaded = false;
        busy = false;
        bubbleCache = new Map();
        newPill.hidden = true;
        attempt = null;
        loadStatus.textContent = '';
        setLoadError('', false);
        setSendError('');
        showQuickNotice('');
        closeQuick(false);
        list.replaceChildren();
        older.hidden = true;
        controls();
      },
      refresh() { return load(loaded ? 'refresh' : 'reset'); },
      poll,
      displayed() { return Boolean(customer) && loaded && Boolean(options.isDisplayed) && options.isDisplayed(); },
      markRead,
      focusHeading() { headName.focus(); }
    };
    waConversations.push(conversation);
    controls();
    return conversation;
  }

  // ---- Template picker ----
  const templateDialog = byId('template-dialog');
  const templateForm = byId('template-form');
  const templateState = { templates: null, loadedAt: 0, loading: false, query: '', selected: null, values: [], sources: [], refs: [], handlers: null, handlerId: '', handlerField: null, handlerToken: 0, target: null, sending: false, attempt: null };
  byId('template-close').append(waIcon('close'));
  function readTemplate(item) {
    if (!item || typeof item.name !== 'string' || typeof item.language !== 'string' || typeof item.body !== 'string' || !Array.isArray(item.variables)) return null;
    return {
      name: item.name,
      language: item.language,
      category: typeof item.category === 'string' ? item.category : '',
      header: typeof item.header === 'string' ? item.header : '',
      body: item.body,
      footer: typeof item.footer === 'string' ? item.footer : '',
      buttons: Array.isArray(item.buttons) ? item.buttons.filter((button) => button && typeof button.text === 'string') : [],
      variables: item.variables.filter((variable) => variable && typeof variable.key === 'string').map((variable) => ({ key: variable.key, example: typeof variable.example === 'string' ? variable.example : '' })),
      sendable: item.sendable === true,
      reason: typeof item.reason === 'string' ? item.reason : ''
    };
  }
  function sameTemplate(a, b) { return Boolean(a) && Boolean(b) && a.name === b.name && a.language === b.language; }
  function renderTemplateList() {
    const query = templateState.query.trim().toLowerCase();
    const all = templateState.templates || [];
    const shown = all.filter((item) => !query || (item.name + ' ' + item.category + ' ' + item.language + ' ' + item.body).toLowerCase().includes(query));
    const nodes = shown.map((item) => {
      const button = element('button', undefined, 'wa-tpl-item' + (item.sendable ? '' : ' wa-disabled'));
      button.type = 'button';
      button.dataset.name = item.name;
      button.dataset.language = item.language;
      button.setAttribute('aria-pressed', String(sameTemplate(item, templateState.selected)));
      if (!item.sendable) button.setAttribute('aria-disabled', 'true');
      button.append(element('strong', item.name, 'wa-tpl-name'), element('span', [item.category, item.language].filter(Boolean).join(' · '), 'wa-tpl-sub'), element('span', item.body, 'wa-tpl-snippet'));
      if (!item.sendable) button.append(element('span', item.reason || 'This template cannot be sent from here.', 'wa-tpl-reason'));
      button.addEventListener('click', () => selectTemplate(item));
      return button;
    });
    if (!nodes.length && templateState.templates) nodes.push(element('p', all.length ? 'No templates match your search.' : 'No templates are available.', 'wa-empty'));
    byId('template-list').replaceChildren(...nodes);
  }
  async function loadTemplates() {
    if (templateState.loading) return;
    if (templateState.templates && Date.now() - templateState.loadedAt < 300000) { renderTemplateList(); return; }
    templateState.loading = true;
    message('template-list-error', '');
    message('template-list-status', 'Loading templates…');
    byId('template-reload').hidden = true;
    try {
      const data = await api('/whatsapp/templates');
      if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable templates. Please try again.');
      templateState.templates = data.items.map(readTemplate).filter(Boolean);
      templateState.loadedAt = Date.now();
    } catch (error) {
      message('template-list-error', error.status === 503 && error.code === 'WHATSAPP_NOT_CONFIGURED' ? 'WhatsApp templates are unavailable because WhatsApp is not configured.' : errorMessage(error));
      byId('template-reload').hidden = false;
    } finally {
      templateState.loading = false;
      message('template-list-status', '');
      renderTemplateList();
    }
  }
  // Splits text around {{key}} placeholders; filled ones become plain text, unfilled ones a highlighted marker.
  function templateParts(text, template, values) {
    const parts = [];
    const pattern = /\{\{\s*([^{}\s]+)\s*\}\}/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const index = template.variables.findIndex((variable) => variable.key === match[1]);
      const value = index >= 0 ? String(values[index] || '').trim() : '';
      parts.push(value || element('mark', '{{' + match[1] + '}}', 'wa-var'));
      last = pattern.lastIndex;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }
  function templatePreview(template, values) {
    const node = element('div', undefined, 'wa-msg out wa-first');
    const bubble = element('div', undefined, 'wa-bubble');
    if (template.header) {
      const header = element('div', undefined, 'wa-tpl-header');
      header.append(...templateParts(template.header, template, values));
      bubble.append(header);
    }
    const body = element('div', undefined, 'wa-text');
    body.append(...templateParts(template.body, template, values));
    bubble.append(body);
    if (template.footer) {
      const footer = element('div', undefined, 'wa-tpl-footer');
      footer.append(...templateParts(template.footer, template, values));
      bubble.append(footer);
    }
    const meta = element('span', undefined, 'wa-meta');
    meta.append(element('time', waTimeFormat.format(new Date()), 'wa-time'));
    bubble.append(meta);
    node.append(bubble);
    if (template.buttons.length) {
      const buttons = element('div', undefined, 'wa-tpl-btns');
      for (const button of template.buttons) buttons.append(element('span', button.text, 'wa-tpl-btn'));
      node.append(buttons);
    }
    return node;
  }
  function templateComplete() {
    const template = templateState.selected;
    return Boolean(template) && template.variables.every((variable, index) => String(templateState.values[index] || '').trim());
  }
  function updateTemplatePreview() {
    const template = templateState.selected;
    if (!template) return;
    byId('template-preview').replaceChildren(templatePreview(template, templateState.values));
    updateTemplateSend();
  }
  function updateTemplateSend() {
    byId('template-send').disabled = templateState.sending || !templateComplete();
    byId('template-send').textContent = templateState.sending ? 'Sending…' : 'Send template';
    byId('template-fields').disabled = templateState.sending;
  }
  const TEMPLATE_SOURCES = [
    ['handler-name', 'Handled by: name'],
    ['handler-phone', 'Handled by: phone number'],
    ['customer-name', 'Customer name'],
    ['custom', 'Custom text']
  ];
  function defaultTemplateSource(variable, index) {
    if (variable.key === '2') return 'handler-phone';
    if (variable.key === '1' || index === 0) return 'handler-name';
    if (index === 1) return 'handler-phone';
    return 'custom';
  }
  function templateHandler() {
    const list = Array.isArray(templateState.handlers) ? templateState.handlers : [];
    return list.find((item) => item.id === templateState.handlerId) || list[0] || null;
  }
  // Resolves a non-custom source to the text it fills and the hint to show when that text is empty.
  function resolveTemplateSource(source) {
    if (source === 'customer-name') return { value: templateState.target ? String(templateState.target.customerName()) : '', hint: '' };
    if (templateState.handlers === null) return { value: '', hint: 'Loading handler…' };
    if (templateState.handlers === 'error') return { value: '', hint: 'Handler could not be loaded' };
    const handler = templateHandler();
    if (!handler) return { value: '', hint: 'No handler assigned' };
    if (source === 'handler-name') return { value: handler.name, hint: '' };
    const phone = employees.get(handler.id)?.phoneNumber || '';
    return { value: phone, hint: phone ? '' : 'Handler has no phone number, add one in Employees' };
  }
  function applyTemplateSource(index) {
    const ref = templateState.refs[index];
    if (!ref) return;
    const source = templateState.sources[index];
    ref.select.value = source;
    if (source === 'custom') { ref.hint.textContent = ''; ref.hint.hidden = true; return; }
    const resolved = resolveTemplateSource(source);
    const value = resolved.value.replace(/[\t\r\n]+/g, ' ');
    ref.input.value = value;
    templateState.values[index] = value;
    ref.hint.textContent = value.trim() ? '' : resolved.hint;
    ref.hint.hidden = !ref.hint.textContent;
  }
  function refreshTemplateSources() {
    if (!templateState.selected) return;
    templateState.refs.forEach((ref, index) => applyTemplateSource(index));
    updateTemplatePreview();
  }
  function ensureTemplateHandlerField() {
    if (templateState.handlerField) { templateState.handlerField.remove(); templateState.handlerField = null; }
    const handlers = Array.isArray(templateState.handlers) ? templateState.handlers : [];
    if (!templateState.selected || !templateState.selected.variables.length || handlers.length < 2) return;
    const label = element('label', undefined, 'wa-field');
    label.append(element('span', 'Handler', 'wa-field-label'));
    const select = element('select');
    select.id = 'template-handler';
    for (const handler of handlers) {
      const option = element('option', handler.name);
      option.value = handler.id;
      select.append(option);
    }
    select.value = templateHandler().id;
    select.addEventListener('change', () => { templateState.handlerId = select.value; refreshTemplateSources(); });
    label.append(select);
    templateState.handlerField = label;
    byId('template-field-list').prepend(label);
  }
  function selectTemplate(template) {
    if (!template.sendable || templateState.sending) return;
    if (!sameTemplate(template, templateState.selected)) {
      templateState.selected = template;
      templateState.values = template.variables.map(() => '');
      templateState.sources = template.variables.map(defaultTemplateSource);
      templateState.refs = [];
      templateState.handlerField = null;
      message('template-error', '');
      byId('template-placeholder').hidden = true;
      templateForm.hidden = false;
      byId('template-selected').textContent = template.name + ' · ' + template.language + (template.category ? ' · ' + template.category : '');
      const fields = template.variables.map((variable, index) => {
        const group = element('div', undefined, 'wa-field');
        group.append(element('span', '{{' + variable.key + '}}', 'wa-field-label'));
        const row = element('div', undefined, 'wa-field-row');
        const select = element('select');
        select.setAttribute('aria-label', 'Fill {{' + variable.key + '}} with');
        for (const [value, text] of TEMPLATE_SOURCES) {
          const option = element('option', text);
          option.value = value;
          select.append(option);
        }
        const field = element('input');
        field.type = 'text';
        field.maxLength = 1024;
        field.autocomplete = 'off';
        field.required = true;
        field.placeholder = variable.example || 'Value';
        field.setAttribute('aria-label', 'Value for {{' + variable.key + '}}');
        const hint = element('p', '', 'wa-field-hint');
        hint.hidden = true;
        select.addEventListener('change', () => {
          templateState.sources[index] = select.value;
          applyTemplateSource(index);
          updateTemplatePreview();
          field.focus();
        });
        field.addEventListener('input', () => {
          if (/[\t\r\n]/.test(field.value)) field.value = field.value.replace(/[\t\r\n]+/g, ' ');
          templateState.values[index] = field.value;
          templateState.sources[index] = 'custom';
          select.value = 'custom';
          hint.textContent = '';
          hint.hidden = true;
          updateTemplatePreview();
        });
        row.append(select, field);
        group.append(row, hint);
        templateState.refs.push({ select, input: field, hint });
        return group;
      });
      if (!fields.length) fields.push(element('p', 'This template has no variables.', 'wa-hint'));
      byId('template-field-list').replaceChildren(...fields);
      ensureTemplateHandlerField();
      templateState.refs.forEach((ref, index) => applyTemplateSource(index));
    }
    for (const node of byId('template-list').children) node.setAttribute('aria-pressed', String(node.dataset.name === template.name && node.dataset.language === template.language));
    byId('template-body').dataset.view = 'form';
    updateTemplatePreview();
    const first = byId('template-field-list').querySelector('input');
    (first || byId('template-send')).focus();
  }
  function openTemplatePicker(target) {
    templateState.target = target;
    templateState.selected = null;
    templateState.values = [];
    templateState.sources = [];
    templateState.refs = [];
    templateState.handlerField = null;
    templateState.handlers = null;
    templateState.handlerId = '';
    const loadToken = ++templateState.handlerToken;
    target.handlers().then((list) => {
      if (loadToken !== templateState.handlerToken) return;
      templateState.handlers = list;
      templateState.handlerId = list.length ? list[0].id : '';
    }, () => {
      if (loadToken !== templateState.handlerToken) return;
      templateState.handlers = 'error';
    }).then(() => {
      if (loadToken !== templateState.handlerToken) return;
      ensureTemplateHandlerField();
      refreshTemplateSources();
    });
    templateState.query = '';
    byId('template-search').value = '';
    byId('template-placeholder').hidden = false;
    templateForm.hidden = true;
    byId('template-body').dataset.view = 'list';
    message('template-error', '');
    renderTemplateList();
    templateDialog.showModal();
    byId('template-search').focus();
    loadTemplates();
  }
  function closeTemplatePicker() { if (!templateState.sending) templateDialog.close(); }
  byId('template-close').addEventListener('click', closeTemplatePicker);
  byId('template-cancel').addEventListener('click', closeTemplatePicker);
  byId('template-reload').addEventListener('click', () => { templateState.templates = null; loadTemplates(); });
  byId('template-back').addEventListener('click', () => {
    byId('template-body').dataset.view = 'list';
    const current = Array.from(byId('template-list').children).find((node) => node.getAttribute('aria-pressed') === 'true');
    (current || byId('template-search')).focus();
  });
  byId('template-search').addEventListener('input', (event) => { templateState.query = event.target.value; renderTemplateList(); });
  templateDialog.addEventListener('cancel', (event) => { if (templateState.sending) event.preventDefault(); });
  templateDialog.addEventListener('close', () => {
    const opener = templateState.target ? templateState.target.opener : null;
    templateState.target = null;
    if (opener && opener.isConnected && !opener.disabled) opener.focus();
  });
  templateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const template = templateState.selected;
    const target = templateState.target;
    if (!template || !target || templateState.sending) return;
    const customerId = target.customerId();
    if (!customerId) { message('template-error', 'Open a chat first.'); return; }
    if (!templateComplete()) { message('template-error', 'Fill in every variable before sending.'); return; }
    const params = template.variables.map((variable, index) => String(templateState.values[index]).trim());
    const key = [customerId, template.name, template.language, JSON.stringify(params)].join('|');
    if (!templateState.attempt || templateState.attempt.key !== key) templateState.attempt = { key, id: crypto.randomUUID() };
    templateState.sending = true;
    message('template-error', '');
    updateTemplateSend();
    let sent = false;
    try {
      const body = { clientMessageId: templateState.attempt.id, template: { name: template.name, language: template.language } };
      if (params.length) body.template.params = params;
      await api('/customers/' + encodeURIComponent(customerId) + '/messages', { method: 'POST', body: JSON.stringify(body) });
      templateState.attempt = null;
      sent = true;
    } catch (error) {
      message('template-error', error.status === 502 ? 'WhatsApp could not send the message. Try again.' : errorMessage(error));
    } finally {
      templateState.sending = false;
      updateTemplateSend();
    }
    if (sent) {
      templateDialog.close();
      target.onSent();
    }
  });

  // ---- Chat list (left pane) ----
  const chatLayout = byId('chat-layout');
  byId('whatsapp-refresh').append(waIcon('refresh'));
  function renderChat(chat) {
    if (!chat || !chat.customer || typeof chat.customer.id !== 'string' || typeof chat.customer.name !== 'string' || typeof chat.customer.phone !== 'string' ||
        !Array.isArray(chat.employees) || !chat.lastMessage || !['in', 'out'].includes(chat.lastMessage.direction)) {
      throw new Error('A WhatsApp chat could not be read. Please refresh.');
    }
    const last = chat.lastMessage;
    const item = element('button', undefined, 'wa-chat');
    item.type = 'button';
    item.dataset.customerId = chat.customer.id;
    item.dataset.phone = chat.customer.phone;
    item.setAttribute('aria-current', String(Boolean(selectedChat) && selectedChat.id === chat.customer.id));
    const unread = Number.isInteger(chat.unreadCount) && chat.unreadCount > 0 ? chat.unreadCount : 0;
    if (unread) item.classList.add('wa-unread');
    const top = element('span', undefined, 'wa-chat-top');
    top.append(element('strong', chat.customer.name, 'wa-chat-name'), element('span', waListTime(last.sentAt), 'wa-chat-time'));
    const typeLabel = messageTypeLabel(last.messageType);
    const preview = element('span', undefined, 'wa-chat-preview');
    if (last.direction === 'out') {
      const mark = waStatusMark(last.status);
      if (mark) preview.append(mark);
    }
    const mediaLabel = Object.hasOwn(WA_MEDIA_PREVIEW, last.messageType) ? WA_MEDIA_PREVIEW[last.messageType] : '';
    const caption = typeof last.text === 'string' && last.text && !/^\[[^\]]*\]$/.test(last.text) ? last.text : '';
    preview.append(element('span', mediaLabel ? (caption ? mediaLabel + ' · ' + caption : mediaLabel) : last.text || (typeLabel ? '[' + typeLabel + ']' : 'No text'), 'wa-chat-snippet'));
    if (unread) {
      const badge = element('span', unreadLabel(unread), 'wa-unread-badge');
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', unread + ' unread ' + (unread === 1 ? 'message' : 'messages'));
      preview.append(badge);
    }
    const body = element('span', undefined, 'wa-chat-body');
    body.append(top, preview, element('span', chat.employees.length ? handlerNames(chat.employees) : 'Unassigned', 'wa-chat-sub'));
    item.append(waAvatar(chat.customer.name, chat.customer.id), body);
    item.addEventListener('click', () => openChat(chat, item));
    return item;
  }
  const chatList = cursorList({
    listId: 'whatsapp-list', moreId: 'whatsapp-more', statusId: 'whatsapp-status', errorId: 'whatsapp-error', noun: ['chat', 'chats'],
    request: () => {
      const params = new URLSearchParams();
      const q = String(new FormData(whatsappForm).get('q') || '').trim();
      if (q) params.set('q', q);
      if (byId('whatsapp-employee').value) params.set('employeeId', byId('whatsapp-employee').value);
      return { path: '/whatsapp/chats', params };
    },
    render: renderChat,
    nodeKey: (node) => node.dataset.customerId || '',
    onLoaded: refreshUnread,
    empty: (filtered) => emptyState('No chats found', filtered ? 'Try a different search or clear the employee filter. Customers without messages are not listed.' : 'Chats appear here once WhatsApp history has been stored for a customer.')
  });
  const chatConversation = createConversation(byId('chat-conversation'), {
    onBack: () => {
      chatLayout.dataset.view = 'list';
      const current = selectedChat ? byId('whatsapp-list').querySelector('[data-customer-id="' + CSS.escape(selectedChat.id) + '"]') : null;
      (current || byId('whatsapp-heading')).focus();
    },
    onOpenCustomer: (opener) => { if (selectedChat) openDrawer(selectedChat, opener); },
    onSent: () => chatList.load(true),
    isDisplayed: () => activeTab === 'whatsapp' && Boolean(selectedChat) && !byId('chat-conversation').hidden && (!window.matchMedia('(max-width: 720px)').matches || chatLayout.dataset.view === 'thread')
  });
  function loadSendState() {
    return api('/whatsapp/status').then((data) => { waSendState = data && data.canSend === true ? 'yes' : 'no'; }, () => { waSendState = 'no'; }).then(() => { for (const conversation of waConversations) conversation.controls(); });
  }
  function openChat(chat, item) {
    selectedChat = chat.customer;
    for (const node of byId('whatsapp-list').children) node.setAttribute('aria-current', String(node === item));
    chatLayout.dataset.view = 'thread';
    byId('chat-thread-empty').hidden = true;
    byId('chat-conversation').hidden = false;
    chatConversation.open(chat.customer, chat.customer.phone + ' · ' + (chat.employees.length ? 'Handled by ' + handlerNames(chat.employees) : 'Unassigned'));
    if (window.matchMedia('(max-width: 720px)').matches) chatConversation.focusHeading();
  }
  whatsappForm.addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(chatSearchTimer); chatList.load(true); });
  whatsappForm.addEventListener('input', (event) => {
    if (event.target.type !== 'search') return;
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(() => chatList.load(true), 350);
  });
  byId('whatsapp-list').addEventListener('scroll', () => {
    const node = byId('whatsapp-list');
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 200) chatList.load(false);
  }, { passive: true });
  byId('whatsapp-employee').addEventListener('change', () => chatList.load(true));
  byId('whatsapp-refresh').addEventListener('click', () => {
    chatList.load(true);
    if (selectedChat) chatConversation.refresh();
  });

  // ---- Customer drawer: one right-hand panel with a customer mini view and a WhatsApp mini chat ----
  // Customer-supplied strings are rendered with textContent only. The drawer is non-modal: Esc, the close button and the backdrop close it.
  const drawerEl = byId('drawer');
  const drawerBackdrop = byId('drawer-backdrop');
  const drawerTitle = byId('drawer-title');
  const drawerState = { open: false, id: null, name: '', customer: null, mode: 'customer', opener: null, version: 0, controller: null, error: '', calls: null, callsError: '', notesOpen: false, chatId: null };
  const drawerConversation = createConversation(byId('drawer-conversation'), {
    embedded: true,
    onSent: () => { if (chatsLoaded) chatList.load(true); refreshDrawerCustomer(); },
    isDisplayed: () => drawerState.open && drawerState.mode === 'chat'
  });
  byId('drawer-back').append(waIcon('back'));
  byId('drawer-close').append(waIcon('close'));

  function renderDrawerHeader() {
    const chat = drawerState.mode === 'chat';
    const name = drawerState.customer ? drawerState.customer.name : drawerState.name || 'Customer';
    drawerTitle.textContent = chat ? name : 'Customer';
    drawerEl.setAttribute('aria-label', (chat ? 'WhatsApp chat with ' : 'Customer ') + name);
    byId('drawer-chat-phone').textContent = drawerState.customer ? drawerState.customer.phone : '';
  }
  function renderDrawerCalls() {
    const list = byId('drawer-calls');
    const retry = byId('drawer-calls-retry');
    list.replaceChildren();
    retry.hidden = !drawerState.callsError;
    if (drawerState.callsError) { message('drawer-calls-status', 'Could not load calls. ' + drawerState.callsError); return; }
    if (drawerState.calls === null) { message('drawer-calls-status', 'Loading calls…'); return; }
    if (!drawerState.calls.length) { message('drawer-calls-status', 'No calls match this phone number yet.'); return; }
    message('drawer-calls-status', '');
    for (const call of drawerState.calls) {
      const isCall = call && call.kind === 'call';
      const item = element('li', undefined, 'drawer-call');
      const seconds = isCall ? call.durationSeconds : call && Array.isArray(call.recordings) && call.recordings[0] ? call.recordings[0].durationSeconds : undefined;
      item.append(
        element('span', dateText(call && (call.startedAt || call.createdAt)), 'drawer-call-time'),
        element('span', isCall && Object.hasOwn(callTypeNames, call.callType) ? callTypeNames[call.callType] : 'Recording', 'badge'),
        element('span', durationText(seconds), 'drawer-call-duration'));
      list.append(item);
    }
  }
  function renderDrawerCustomer() {
    const customer = drawerState.customer;
    message('drawer-customer-status', customer || drawerState.error ? '' : 'Loading customer…');
    message('drawer-customer-error-text', drawerState.error);
    byId('drawer-customer-error').hidden = !drawerState.error;
    byId('drawer-customer-content').hidden = !customer;
    if (!customer) return;
    byId('drawer-customer-name').textContent = customer.name;
    const phone = byId('drawer-phone');
    const dial = customer.phone.replace(/[^0-9+]/g, '');
    phone.textContent = customer.phone;
    if (dial) phone.href = 'tel:' + dial;
    else phone.removeAttribute('href');
    const email = fact('Email', customer.email || 'Not set');
    if (customer.email && /^[^\s@]+@[^\s@]+$/.test(customer.email)) {
      const link = element('a', customer.email);
      link.href = 'mailto:' + customer.email;
      email.querySelector('dd').replaceChildren(link);
    }
    const total = Number.isInteger(customer.messageCount) ? customer.messageCount : 0;
    byId('drawer-facts').replaceChildren(
      email,
      fact('State / district', [customer.state, customer.district].filter(Boolean).join(' / ') || 'Not set'),
      fact('Country', customer.country || 'Not set'),
      fact('Handled by', customer.employees.length ? handlerNames(customer.employees) : 'Unassigned'),
      fact('Source', customer.source || 'Not set'),
      fact('WhatsApp messages', total),
      fact('Last message', customer.lastMessageAt ? dateText(customer.lastMessageAt) : 'None'),
      fact('Last call', customer.lastCallAt ? dateText(customer.lastCallAt) : 'None'));
    const notes = byId('drawer-notes-text');
    const toggle = byId('drawer-notes-toggle');
    notes.textContent = customer.notes || 'None';
    notes.dataset.expanded = String(drawerState.notesOpen);
    toggle.textContent = drawerState.notesOpen ? 'Show less' : 'Show more';
    toggle.setAttribute('aria-expanded', String(drawerState.notesOpen));
    toggle.hidden = !drawerState.notesOpen;
    if (!drawerState.notesOpen && customer.notes) {
      requestAnimationFrame(() => { toggle.hidden = drawerState.notesOpen ? false : notes.scrollHeight <= notes.clientHeight + 1; });
    }
    renderDrawerCalls();
  }
  function startDrawerChat() {
    if (drawerState.chatId === drawerState.id) { drawerConversation.refresh(); return; }
    const customer = drawerState.customer || { id: drawerState.id, name: drawerState.name || 'Customer', phone: '' };
    drawerState.chatId = drawerState.id;
    drawerConversation.open(customer, customer.phone);
  }
  function setDrawerMode(mode) {
    drawerState.mode = mode;
    drawerEl.dataset.mode = mode;
    byId('drawer-customer').hidden = mode !== 'customer';
    byId('drawer-chat').hidden = mode !== 'chat';
    byId('drawer-back').hidden = mode !== 'chat';
    renderDrawerHeader();
    if (mode === 'chat') startDrawerChat();
    else renderDrawerCustomer();
  }
  async function loadDrawerCustomer() {
    const id = drawerState.id;
    const version = ++drawerState.version;
    if (drawerState.controller) drawerState.controller.abort();
    const controller = new AbortController();
    drawerState.controller = controller;
    drawerState.error = '';
    drawerState.callsError = '';
    renderDrawerCustomer();
    const base = '/customers/' + encodeURIComponent(id);
    const [customerResult, callsResult] = await Promise.allSettled([
      api(base, { signal: controller.signal }),
      api(base + '/calls?' + new URLSearchParams({ limit: '3' }), { signal: controller.signal })
    ]);
    if (version !== drawerState.version) return;
    if (customerResult.status === 'fulfilled') {
      try {
        drawerState.customer = readCustomer(customerResult.value && customerResult.value.customer);
        drawerState.chatId = null;
      } catch (error) { drawerState.error = errorMessage(error); }
    } else drawerState.error = errorMessage(customerResult.reason);
    if (callsResult.status === 'fulfilled') {
      try { drawerState.calls = readPage(callsResult.value).items.slice(0, 3); }
      catch (error) { drawerState.callsError = errorMessage(error); }
    } else drawerState.callsError = errorMessage(callsResult.reason);
    renderDrawerHeader();
    renderDrawerCustomer();
  }
  function applyDrawerCustomer(customer) {
    drawerState.customer = customer;
    drawerState.chatId = null;
    renderDrawerHeader();
    renderDrawerCustomer();
  }
  async function refreshDrawerCustomer() {
    if (!drawerState.open) return;
    const id = drawerState.id;
    try {
      const data = await api('/customers/' + encodeURIComponent(id));
      if (drawerState.open && drawerState.id === id) {
        const keepChat = drawerState.chatId;
        applyCustomerUpdate(readCustomer(data && data.customer));
        drawerState.chatId = keepChat;
      }
    } catch { /* The messages were sent; the summary refreshes the next time the drawer opens. */ }
  }
  // target: a customer object or any {id, name}. Opening for another customer replaces the content; reopening refetches.
  function openDrawer(target, opener, mode = 'customer') {
    if (!target || typeof target.id !== 'string') return;
    const wasOpen = drawerState.open;
    if (opener) drawerState.opener = opener;
    else if (!wasOpen) drawerState.opener = null;
    const full = Array.isArray(target.employees) ? target : null;
    if (!(wasOpen && drawerState.id === target.id)) {
      drawerConversation.close();
      drawerState.id = target.id;
      drawerState.name = typeof target.name === 'string' ? target.name : '';
      drawerState.customer = full;
      drawerState.calls = null;
      drawerState.notesOpen = false;
      drawerState.chatId = null;
    } else if (full) {
      drawerState.customer = full;
    }
    drawerState.open = true;
    drawerEl.inert = false;
    drawerEl.dataset.open = 'true';
    drawerBackdrop.hidden = false;
    setDrawerMode(mode);
    loadDrawerCustomer();
    drawerTitle.focus();
  }
  function closeDrawer(restoreFocus = true) {
    if (!drawerState.open) return;
    const opener = drawerState.opener;
    const id = drawerState.id;
    drawerState.open = false;
    drawerState.opener = null;
    drawerState.version++;
    if (drawerState.controller) drawerState.controller.abort();
    drawerState.controller = null;
    drawerConversation.close();
    drawerState.chatId = null;
    drawerEl.dataset.open = 'false';
    drawerEl.inert = true;
    drawerBackdrop.hidden = true;
    if (!restoreFocus) return;
    if (opener && opener.isConnected && !opener.closest('[hidden]')) { opener.focus(); return; }
    const row = id ? customersListNode.querySelector('[data-customer-id="' + CSS.escape(id) + '"] .customer-open') : null;
    if (row && row.offsetParent) { row.focus(); return; }
    byId('main').focus();
  }
  function drawerOpenDetail() {
    const customer = drawerState.customer;
    const id = drawerState.id;
    closeDrawer(false);
    if (customer) showCustomerDetail(customer);
    else openCustomerById(id);
  }
  byId('drawer-close').addEventListener('click', () => closeDrawer());
  drawerBackdrop.addEventListener('click', () => closeDrawer());
  byId('drawer-back').addEventListener('click', () => {
    setDrawerMode('customer');
    const target = byId('drawer-open-chat');
    (target.offsetParent ? target : drawerTitle).focus();
  });
  byId('drawer-open-chat').addEventListener('click', () => { setDrawerMode('chat'); drawerTitle.focus(); });
  byId('drawer-open-detail').addEventListener('click', drawerOpenDetail);
  byId('drawer-chat-detail').addEventListener('click', drawerOpenDetail);
  byId('drawer-edit').addEventListener('click', (event) => { if (drawerState.customer) openCustomerDialog(drawerState.customer, event.currentTarget); });
  byId('drawer-retry').addEventListener('click', loadDrawerCustomer);
  byId('drawer-calls-retry').addEventListener('click', loadDrawerCustomer);
  byId('drawer-notes-toggle').addEventListener('click', () => {
    drawerState.notesOpen = !drawerState.notesOpen;
    byId('drawer-notes-text').dataset.expanded = String(drawerState.notesOpen);
    byId('drawer-notes-toggle').textContent = drawerState.notesOpen ? 'Show less' : 'Show more';
    byId('drawer-notes-toggle').setAttribute('aria-expanded', String(drawerState.notesOpen));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !drawerState.open || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    closeDrawer();
  });
  // ---- Call analytics (aggregates only; every server string is rendered as text) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const analyticsTypes = ['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'answered_externally', 'unknown'];
  const analyticsSegmentNames = { ...callTypeNames, other: 'Other' };
  const userSegments = ['incoming', 'outgoing', 'missed', 'rejected', 'other'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const metricKeys = ['total', 'connected', 'notConnected', 'uniqueContacts', 'talkSeconds', 'avgConnectedSeconds', 'incoming', 'incomingSeconds', 'outgoing', 'outgoingSeconds', 'missed', 'rejected', 'other', 'withRecording'];
  const chartNames = ['users', 'types', 'days', 'talk', 'heat', 'rate', 'length'];
  const timeSteps = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 432000, 864000, 1728000, 4320000];
  const IST_OFFSET_MS = 330 * 60000;
  const DAY_MS = 86400000;
  let analyticsState = null;
  let analyticsData = null;
  let analyticsVersion = 0;
  let analyticsController;
  let analyticsLoading = false;
  let analyticsWidthKey = '';
  let analyticsResizeTimer;
  let analyticsAnimTimer;
  let analyticsSort = { key: 'total', dir: 'desc' };

  function wholeNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }
  function fmtCount(value) { return wholeNumber(value).toLocaleString(); }
  function r1(value) { return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0; }
  function pad2(value) { return String(value).padStart(2, '0'); }
  function talkText(seconds) {
    const total = wholeNumber(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) return hours + 'h ' + minutes + 'm ' + secs + 's';
    if (minutes) return minutes + 'm ' + secs + 's';
    return secs + 's';
  }
  function axisTime(seconds) {
    const total = wholeNumber(seconds);
    if (!total) return '0';
    if (total < 60) return total + 's';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours && minutes) return hours + 'h ' + minutes + 'm';
    return hours ? hours + 'h' : minutes + 'm';
  }
  function percentText(part, whole) { return whole > 0 ? Math.round(part / whole * 1000) / 10 + '%' : '0%'; }
  function rateOf(part, whole) { return whole > 0 ? part / whole * 100 : null; }
  function rateText(rate) { return rate === null ? '–' : r1(rate) + '%'; }

  // Dates are plain YYYY-MM-DD strings; arithmetic happens on UTC midnights so the browser timezone never matters.
  function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
    if (!match) return NaN;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const ms = Date.UTC(year, month - 1, day);
    const check = new Date(ms);
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? ms : NaN;
  }
  function dayString(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function shiftDay(value, days) { return dayString(parseDay(value) + days * DAY_MS); }
  function daysBetween(from, to) { return Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1; }
  function istToday() { return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10); }
  function dayParts(value) {
    const date = new Date(parseDay(value));
    return { day: date.getUTCDate(), month: monthNames[date.getUTCMonth()], year: date.getUTCFullYear(), weekday: date.getUTCDay() };
  }
  function dayFull(value) {
    const parts = dayParts(value);
    return weekdayShort[parts.weekday] + ' ' + parts.day + ' ' + parts.month + ' ' + parts.year;
  }
  function dayLabel(value, withWeekday) {
    const parts = dayParts(value);
    return withWeekday ? weekdayShort[parts.weekday] + ' ' + parts.day : parts.day + ' ' + parts.month;
  }
  function rangeText(from, to) {
    const a = dayParts(from);
    const b = dayParts(to);
    if (from === to) return b.day + ' ' + b.month + ' ' + b.year;
    if (a.year !== b.year) return a.day + ' ' + a.month + ' ' + a.year + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
    if (a.month !== b.month) return a.day + ' ' + a.month + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
    return a.day + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
  }
  function setAnalyticsTitle(from, to) {
    byId('analytics-title').textContent = rangeText(from, to) + ' · Total days: ' + daysBetween(from, to);
  }

  // Filter state lives in the hash query: #analytics?from=..&to=..&employeeIds=a,b&callTypes=incoming
  function defaultAnalyticsState() {
    const to = istToday();
    return { from: shiftDay(to, -6), to, employeeIds: [], callTypes: [] };
  }
  function parseAnalyticsHash() {
    const state = defaultAnalyticsState();
    const mark = location.hash.indexOf('?');
    const params = new URLSearchParams(mark >= 0 ? location.hash.slice(mark + 1) : '');
    const from = params.get('from');
    const to = params.get('to');
    const fromOk = !Number.isNaN(parseDay(from));
    const toOk = !Number.isNaN(parseDay(to));
    let nextFrom = state.from;
    let nextTo = state.to;
    if (fromOk && toOk) { nextFrom = from; nextTo = to; }
    else if (fromOk) { nextFrom = from; nextTo = shiftDay(from, 6); }
    else if (toOk) { nextTo = to; nextFrom = shiftDay(to, -6); }
    if (nextFrom <= nextTo && daysBetween(nextFrom, nextTo) <= 366) { state.from = nextFrom; state.to = nextTo; }
    const ids = [];
    for (const id of (params.get('employeeIds') || '').split(',')) {
      if (id && id.length <= 256 && !ids.includes(id) && ids.length < 50) ids.push(id);
    }
    state.employeeIds = ids;
    const types = (params.get('callTypes') || '').split(',');
    state.callTypes = analyticsTypes.filter((type) => types.includes(type));
    return state;
  }
  function analyticsParams(state) {
    const params = new URLSearchParams({ from: state.from, to: state.to });
    if (state.employeeIds.length) params.set('employeeIds', state.employeeIds.join(','));
    if (state.callTypes.length) params.set('callTypes', state.callTypes.join(','));
    return params;
  }
  function writeAnalyticsHash() {
    const next = '#analytics?' + analyticsParams(analyticsState).toString().replaceAll('%2C', ',');
    if (location.hash !== next) history.replaceState(null, '', location.pathname + location.search + next);
  }
  function sameAnalyticsState(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // Response validation: structure is checked, every number is clamped to a non-negative integer.
  function badAnalytics() { return new Error('The server returned unreadable analytics. Please refresh.'); }
  function readMetrics(raw) {
    if (!raw || typeof raw !== 'object') throw badAnalytics();
    const metrics = {};
    for (const key of metricKeys) metrics[key] = wholeNumber(raw[key]);
    return metrics;
  }
  function readAnalytics(raw) {
    if (!raw || typeof raw !== 'object' || !raw.range || !Array.isArray(raw.employees) || !Array.isArray(raw.byType) || !Array.isArray(raw.byDay) ||
        !Array.isArray(raw.byHourWeekday) || !Array.isArray(raw.durationBuckets)) throw badAnalytics();
    const range = raw.range;
    for (const key of ['from', 'to', 'previousFrom', 'previousTo']) if (Number.isNaN(parseDay(range[key]))) throw badAnalytics();
    const data = {
      range: { from: range.from, to: range.to, previousFrom: range.previousFrom, previousTo: range.previousTo, days: wholeNumber(range.days) || daysBetween(range.from, range.to) },
      totals: readMetrics(raw.totals),
      previous: readMetrics(raw.previous),
      employees: [],
      byType: [],
      byDay: [],
      cells: new Array(168).fill(0),
      buckets: []
    };
    for (const item of raw.employees) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') throw badAnalytics();
      data.employees.push({ id: item.id, name: item.name, ...readMetrics(item) });
    }
    const typeRows = new Map();
    for (const item of raw.byType) if (item && analyticsTypes.includes(item.type)) typeRows.set(item.type, item);
    data.byType = analyticsTypes.map((type) => ({ type, count: wholeNumber(typeRows.get(type)?.count), seconds: wholeNumber(typeRows.get(type)?.seconds) }));
    for (const item of raw.byDay) {
      if (!item || Number.isNaN(parseDay(item.date)) || !item.types || typeof item.types !== 'object') throw badAnalytics();
      const types = {};
      for (const type of analyticsTypes) types[type] = { count: wholeNumber(item.types[type]?.count), seconds: wholeNumber(item.types[type]?.seconds) };
      data.byDay.push({ date: item.date, total: wholeNumber(item.total), connected: wholeNumber(item.connected), talkSeconds: wholeNumber(item.talkSeconds), types });
    }
    for (const item of raw.byHourWeekday) {
      if (item && Number.isInteger(item.weekday) && item.weekday >= 0 && item.weekday <= 6 && Number.isInteger(item.hour) && item.hour >= 0 && item.hour <= 23) {
        data.cells[item.weekday * 24 + item.hour] = wholeNumber(item.count);
      }
    }
    for (const item of raw.durationBuckets) {
      if (!item || typeof item.label !== 'string') throw badAnalytics();
      data.buckets.push({ key: String(item.key), label: item.label.slice(0, 24), count: wholeNumber(item.count) });
    }
    return data;
  }

  // ---- SVG helpers ----
  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.append(node);
    return node;
  }
  function svgTitle(node, text) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = text;
    node.prepend(title);
  }
  function svgText(parent, x, y, text, className, anchor, full) {
    const node = svgEl('text', { x: r1(x), y: r1(y), class: 'ch-text' + (className ? ' ' + className : ''), 'text-anchor': anchor || 'start' }, parent);
    node.textContent = text;
    if (full && full !== text) svgTitle(node, full);
    return node;
  }
  function fitText(text, pixels) {
    const max = Math.max(2, Math.floor(pixels / 6.2));
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
  function hostWidth(host) { return Math.max(240, Math.floor(host.clientWidth)); }
  function newChart(host, width, height) {
    host.replaceChildren();
    const svg = svgEl('svg', { class: 'chart-svg', width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', focusable: 'false' });
    host.append(svg);
    return svg;
  }
  function finishChart(name, svg, title, summary) {
    if (svg) svg.setAttribute('aria-label', title + '. ' + summary);
    byId('analytics-summary-' + name).textContent = summary;
  }
  function chartMessage(name, text) {
    byId('analytics-chart-' + name).replaceChildren(element('p', text, 'chart-empty'));
    byId('analytics-summary-' + name).textContent = '';
  }
  function swatch(type) {
    const svg = svgEl('svg', { width: 12, height: 12, viewBox: '0 0 12 12', class: 'sw t-' + type, 'aria-hidden': 'true', focusable: 'false' });
    svgEl('rect', { x: 0.5, y: 0.5, width: 11, height: 11, rx: 2, class: 'seg' }, svg);
    if (type !== 'incoming') svgEl('rect', { x: 0.5, y: 0.5, width: 11, height: 11, rx: 2, fill: 'url(#pat-' + type + ')' }, svg);
    return svg;
  }
  function buildLegend(name, items) {
    const host = byId('analytics-legend-' + name);
    host.replaceChildren();
    for (const item of items) {
      const entry = element('span', undefined, 'legend-item');
      if (item.line) {
        const icon = svgEl('svg', { width: 18, height: 12, viewBox: '0 0 18 12', 'aria-hidden': 'true', focusable: 'false' });
        svgEl('path', { d: 'M1 6H17', class: 'rate-line' }, icon);
        svgEl('circle', { cx: 9, cy: 6, r: 3, class: 'rate-dot' }, icon);
        entry.append(icon);
      } else {
        entry.append(swatch(item.type));
      }
      entry.append(item.label);
      host.append(entry);
    }
  }
  function segment(parent, type, x, y, w, h, tip, grow) {
    if (!(w > 0) || !(h > 0)) return null;
    const group = svgEl('g', grow ? { class: grow } : {}, parent);
    svgTitle(group, tip);
    const box = { x: r1(x), y: r1(y), width: r1(w), height: r1(h) };
    svgEl('rect', { ...box, class: 'seg t-' + type }, group);
    if (type !== 'incoming' && w >= 7 && h >= 7) svgEl('rect', { ...box, fill: 'url(#pat-' + type + ')', 'pointer-events': 'none' }, group);
    return group;
  }
  function niceCountScale(max) {
    if (max <= 4) return { step: 1, top: Math.max(1, max) };
    const raw = max / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / magnitude;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
    return { step, top: Math.ceil(max / step) * step };
  }
  function niceTimeScale(max) {
    const raw = max / 4;
    const step = timeSteps.find((candidate) => candidate >= raw) || timeSteps[timeSteps.length - 1];
    return { step, top: Math.max(step, Math.ceil(max / step) * step) };
  }
  function drawYAxis(svg, left, top, plotW, plotH, scale, format) {
    for (let value = 0; value <= scale.top + 1e-9; value += scale.step) {
      const y = top + plotH - (value / scale.top) * plotH;
      svgEl('line', { x1: left, x2: left + plotW, y1: r1(y), y2: r1(y), class: value === 0 ? 'ch-axis' : 'ch-grid' }, svg);
      svgText(svg, left - 6, y + 3.5, format(value), 'ch-muted', 'end');
    }
  }
  function drawDayLabels(svg, days, left, slot, baseY) {
    const short = days.length <= 10;
    const every = Math.max(1, Math.ceil((short ? 42 : 48) / slot));
    days.forEach((day, index) => {
      if (index % every === 0) svgText(svg, left + index * slot + slot / 2, baseY + 15, dayLabel(day.date, short), 'ch-muted', 'middle', dayFull(day.date));
    });
  }
  function busiest(items, value) {
    let best = null;
    for (const item of items) if (!best || value(item) > value(best)) best = item;
    return best;
  }

  // ---- Charts ----
  function renderUsersChart(data) {
    const host = byId('analytics-chart-users');
    const rows = data.employees.slice(0, 15);
    buildLegend('users', userSegments.filter((key) => rows.some((row) => row[key] > 0)).map((key) => ({ type: key, label: analyticsSegmentNames[key] })));
    if (!rows.length) return chartMessage('users', 'No employee activity in this period.');
    const width = hostWidth(host);
    const labelW = Math.round(Math.min(150, Math.max(72, width * 0.3)));
    const rowH = 30;
    const barH = 18;
    const pad = 4;
    const barX = labelW + 8;
    const barMax = Math.max(40, width - barX - 58);
    const sumOf = (row) => userSegments.reduce((sum, key) => sum + row[key], 0);
    const maxTotal = Math.max(1, ...rows.map((row) => Math.max(row.total, sumOf(row))));
    const svg = newChart(host, width, rows.length * rowH + pad * 2);
    rows.forEach((row, index) => {
      const y = pad + index * rowH;
      const mid = y + rowH / 2 + 4;
      const group = svgEl('g', {}, svg);
      svgTitle(group, row.name + ': ' + fmtCount(row.total) + ' calls · ' + userSegments.filter((key) => row[key] > 0).map((key) => analyticsSegmentNames[key] + ' ' + fmtCount(row[key])).join(', '));
      svgText(group, labelW, mid, fitText(row.name, labelW), '', 'end', row.name);
      let x = barX;
      for (const key of userSegments) {
        const w = row[key] / maxTotal * barMax;
        const drawn = segment(group, key, x, y + (rowH - barH) / 2, w, barH, row.name + ' · ' + analyticsSegmentNames[key] + ': ' + fmtCount(row[key]), 'grow-x');
        if (drawn && w >= 24) svgText(group, x + w / 2, mid - 1, fmtCount(row[key]), 'ch-seg-label', 'middle');
        x += w;
      }
      svgText(group, x + 6, mid, fmtCount(row.total), 'ch-strong');
    });
    const top = rows[0];
    finishChart('users', svg, 'Total calls by user', top.name + ' made ' + percentText(top.total, data.totals.total) + ' of calls (' + fmtCount(top.total) + ' of ' + fmtCount(data.totals.total) + ').' +
      (data.employees.length > rows.length ? ' Showing the top ' + rows.length + ' of ' + data.employees.length + ' employees; the leaderboard lists everyone.' : ''));
  }

  function renderTypesChart(data) {
    const host = byId('analytics-chart-types');
    const width = hostWidth(host);
    const labelW = Math.round(Math.min(160, Math.max(110, width * 0.38)));
    const valueW = 100;
    const barX = labelW + 6;
    const barMax = Math.max(30, width - barX - valueW);
    const rowH = 30;
    const pad = 4;
    const total = data.totals.total;
    const maxCount = Math.max(1, ...data.byType.map((row) => row.count));
    const svg = newChart(host, width, data.byType.length * rowH + pad * 2);
    data.byType.forEach((row, index) => {
      const y = pad + index * rowH;
      const mid = y + rowH / 2 + 4;
      const group = svgEl('g', {}, svg);
      svgTitle(group, callTypeNames[row.type] + ': ' + fmtCount(row.count) + ' calls · talk time ' + talkText(row.seconds));
      const icon = svgEl('g', { transform: 'translate(0 ' + r1(y + rowH / 2 - 6) + ')' }, group);
      icon.append(swatch(row.type));
      svgText(group, 18, mid, fitText(callTypeNames[row.type], labelW - 18), row.count ? '' : 'ch-muted', 'start', callTypeNames[row.type]);
      svgEl('rect', { x: barX, y: y + (rowH - 14) / 2, width: barMax, height: 14, rx: 3, class: 'track' }, group);
      segment(group, row.type, barX, y + (rowH - 14) / 2, row.count / maxCount * barMax, 14, callTypeNames[row.type] + ': ' + fmtCount(row.count), 'grow-x');
      svgText(group, width, mid, row.count ? fmtCount(row.count) + ' · ' + percentText(row.count, total) : '0', row.count ? 'ch-strong' : 'ch-muted', 'end');
    });
    const ranked = data.byType.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
    const lead = ranked[0];
    const second = ranked[1];
    finishChart('types', svg, 'Calls by type', lead
      ? callTypeNames[lead.type] + ' made up ' + percentText(lead.count, total) + ' of calls (' + fmtCount(lead.count) + ' of ' + fmtCount(total) + ').' +
        (second ? ' Next: ' + callTypeNames[second.type] + ' (' + percentText(second.count, total) + ').' : '')
      : 'No calls by type.');
  }

  function renderDaysChart(data) {
    const host = byId('analytics-chart-days');
    const days = data.byDay;
    const used = analyticsTypes.filter((type) => days.some((day) => day.types[type].count > 0));
    buildLegend('days', used.map((type) => ({ type, label: callTypeNames[type] })).concat([{ line: true, label: 'Connect rate (right axis)' }]));
    if (!days.length) return chartMessage('days', 'No days to chart.');
    const width = hostWidth(host);
    const left = 34;
    const right = 40;
    const top = 16;
    const bottom = 28;
    const height = width < 420 ? 220 : 260;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const stackSum = (day) => analyticsTypes.reduce((sum, type) => sum + day.types[type].count, 0);
    const scale = niceCountScale(Math.max(1, ...days.map((day) => Math.max(day.total, stackSum(day)))));
    const svg = newChart(host, width, height);
    drawYAxis(svg, left, top, plotW, plotH, scale, fmtCount);
    const slot = plotW / days.length;
    const barW = Math.max(1, Math.min(44, slot * 0.72));
    const points = [];
    days.forEach((day, index) => {
      const x = left + index * slot + (slot - barW) / 2;
      const centre = left + index * slot + slot / 2;
      let y = top + plotH;
      for (const type of analyticsTypes) {
        const count = day.types[type].count;
        if (!count) continue;
        const h = count / scale.top * plotH;
        y -= h;
        segment(svg, type, x, y, barW, h, dayFull(day.date) + ' · ' + callTypeNames[type] + ': ' + fmtCount(count) + ' ' + plural(count, 'call', 'calls'), 'grow-y');
      }
      if (!stackSum(day)) {
        const hit = svgEl('rect', { x: r1(left + index * slot), y: top, width: r1(slot), height: plotH, fill: 'transparent' }, svg);
        svgTitle(hit, dayFull(day.date) + ' · no calls');
      } else if (slot >= 26 && days.length <= 16) {
        svgText(svg, centre, y - 3, fmtCount(day.total), 'ch-strong', 'middle');
      }
      points.push(day.total > 0 ? { x: centre, rate: day.connected / day.total, day } : null);
    });
    for (const ratio of [0, 50, 100]) svgText(svg, left + plotW + 6, top + plotH - ratio / 100 * plotH + 3.5, ratio + '%', 'ch-muted');
    let path = '';
    points.forEach((point, index) => {
      if (!point) return;
      path += (points[index - 1] ? 'L' : 'M') + r1(point.x) + ' ' + r1(top + plotH - Math.min(1, point.rate) * plotH) + ' ';
    });
    if (path) svgEl('path', { d: path.trim(), class: 'rate-line' }, svg);
    points.forEach((point, index) => {
      if (!point) return;
      const isolated = !points[index - 1] && !points[index + 1];
      if (days.length > 45 && !isolated) return;
      const dot = svgEl('circle', { cx: r1(point.x), cy: r1(top + plotH - Math.min(1, point.rate) * plotH), r: 3.5, class: 'rate-dot' }, svg);
      svgTitle(dot, dayFull(point.day.date) + ' · connect rate ' + rateText(point.rate * 100) + ' (' + fmtCount(point.day.connected) + ' of ' + fmtCount(point.day.total) + ' connected)');
    });
    drawDayLabels(svg, days, left, slot, top + plotH);
    const peak = busiest(days, (day) => day.total);
    const average = r1(data.totals.total / Math.max(1, days.length));
    finishChart('days', svg, 'Calls by day', 'Busiest day: ' + dayFull(peak.date) + ' with ' + fmtCount(peak.total) + ' ' + plural(peak.total, 'call', 'calls') + '. Average ' + average.toLocaleString() + ' calls a day; ' +
      rateText(rateOf(data.totals.connected, data.totals.total)) + ' of calls connected over the period.');
  }

  function renderTalkChart(data) {
    const host = byId('analytics-chart-talk');
    const days = data.byDay.map((day) => {
      const incoming = day.types.incoming.seconds;
      const outgoing = day.types.outgoing.seconds;
      return { date: day.date, incoming, outgoing, other: Math.max(0, day.talkSeconds - incoming - outgoing), total: Math.max(day.talkSeconds, incoming + outgoing) };
    });
    const keys = ['incoming', 'outgoing', 'other'];
    const sums = { incoming: 0, outgoing: 0, other: 0 };
    for (const day of days) for (const key of keys) sums[key] += day[key];
    buildLegend('talk', keys.filter((key) => sums[key] > 0).map((key) => ({ type: key, label: analyticsSegmentNames[key] === 'Other' ? 'Other types' : analyticsSegmentNames[key] })));
    const grand = sums.incoming + sums.outgoing + sums.other;
    if (!days.length || !grand) return chartMessage('talk', 'No talk time in this period: no connected calls.');
    const width = hostWidth(host);
    const left = 52;
    const right = 8;
    const top = 16;
    const bottom = 28;
    const height = width < 420 ? 220 : 260;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const scale = niceTimeScale(Math.max(1, ...days.map((day) => day.total)));
    const svg = newChart(host, width, height);
    drawYAxis(svg, left, top, plotW, plotH, scale, axisTime);
    const slot = plotW / days.length;
    const barW = Math.max(1, Math.min(44, slot * 0.72));
    days.forEach((day, index) => {
      const x = left + index * slot + (slot - barW) / 2;
      let y = top + plotH;
      for (const key of keys) {
        if (!day[key]) continue;
        const h = day[key] / scale.top * plotH;
        y -= h;
        segment(svg, key, x, y, barW, h, dayFull(day.date) + ' · ' + (key === 'other' ? 'Other types' : analyticsSegmentNames[key]) + ': ' + talkText(day[key]), 'grow-y');
      }
      if (!day.total) {
        const hit = svgEl('rect', { x: r1(left + index * slot), y: top, width: r1(slot), height: plotH, fill: 'transparent' }, svg);
        svgTitle(hit, dayFull(day.date) + ' · no talk time');
      } else if (slot >= 40 && days.length <= 12) {
        svgText(svg, left + index * slot + slot / 2, y - 3, axisTime(day.total), 'ch-strong', 'middle', talkText(day.total));
      }
    });
    drawDayLabels(svg, days, left, slot, top + plotH);
    const peak = busiest(days, (day) => day.total);
    finishChart('talk', svg, 'Talk time by day', 'Total talk time ' + talkText(grand) + ': outgoing ' + percentText(sums.outgoing, grand) + ', incoming ' + percentText(sums.incoming, grand) +
      (sums.other ? ', other types ' + percentText(sums.other, grand) : '') + '. Longest day: ' + dayFull(peak.date) + ' with ' + talkText(peak.total) + '.');
  }

  function heatColor(count, max) {
    if (!count) return '#f3f5f1';
    const s = 0.18 + 0.82 * Math.sqrt(Math.min(1, count / max));
    const from = [232, 241, 234];
    const to = [14, 70, 62];
    return '#' + from.map((channel, i) => Math.round(channel + (to[i] - channel) * s).toString(16).padStart(2, '0')).join('');
  }
  function hourRange(hour) { return pad2(hour) + ':00–' + pad2((hour + 1) % 24) + ':00'; }
  function renderHeatChart(data) {
    const host = byId('analytics-chart-heat');
    const counts = data.cells;
    const max = Math.max(...counts);
    if (max <= 0) return chartMessage('heat', 'No calls to chart.');
    const width = hostWidth(host);
    const leftW = 38;
    const top = 20;
    const cw = (width - leftW - 2) / 24;
    const ch = Math.round(Math.min(28, Math.max(16, cw * 0.9)));
    const legendY = top + 7 * ch + 16;
    const stacked = width < 520;
    const svg = newChart(host, width, legendY + (stacked ? 44 : 24));
    svgText(svg, 0, top - 7, 'IST', 'ch-muted');
    const every = cw >= 22 ? 1 : cw >= 14 ? 2 : 3;
    for (let hour = 0; hour < 24; hour += every) svgText(svg, leftW + hour * cw + cw / 2, top - 7, pad2(hour), 'ch-muted', 'middle');
    const hourTotals = new Array(24).fill(0);
    const dayTotals = new Array(7).fill(0);
    let peak = { weekday: 1, hour: 0, count: -1 };
    weekdayOrder.forEach((weekday, row) => {
      const y = top + row * ch;
      svgText(svg, leftW - 6, y + ch / 2 + 3.5, weekdayShort[weekday], 'ch-muted', 'end', weekdayNames[weekday]);
      for (let hour = 0; hour < 24; hour++) {
        const count = counts[weekday * 24 + hour];
        hourTotals[hour] += count;
        dayTotals[weekday] += count;
        if (count > peak.count) peak = { weekday, hour, count, row };
        const x = leftW + hour * cw;
        const cell = svgEl('g', {}, svg);
        svgTitle(cell, weekdayNames[weekday] + ' ' + hourRange(hour) + ' IST · ' + fmtCount(count) + ' ' + plural(count, 'call', 'calls'));
        svgEl('rect', { x: r1(x), y, width: r1(Math.max(1, cw - 1)), height: ch - 1, rx: 2, fill: heatColor(count, max) }, cell);
        if (cw >= 24 && count > 0) svgText(cell, x + cw / 2, y + ch / 2 + 3.5, fmtCount(count), 'ch-seg-label' + (count / max > 0.45 ? ' ch-light' : ''), 'middle');
      }
    });
    svgEl('rect', { x: r1(leftW + peak.hour * cw - 1), y: top + peak.row * ch - 1, width: r1(Math.max(2, cw + 1)), height: ch + 1, rx: 3, class: 'heat-peak' }, svg);
    const steps = [0, 0.1, 0.3, 0.55, 0.8, 1];
    svgText(svg, leftW, legendY + 10, '0', 'ch-muted', 'end');
    steps.forEach((ratio, index) => svgEl('rect', { x: leftW + 6 + index * 22, y: legendY, width: 21, height: 13, rx: 2, fill: heatColor(ratio ? ratio * max : 0, max) }, svg));
    const afterScale = leftW + 6 + steps.length * 22 + 6;
    svgText(svg, afterScale, legendY + 10, fmtCount(max) + ' ' + plural(max, 'call', 'calls') + ' in a slot', 'ch-muted');
    const keyX = stacked ? leftW + 6 : afterScale + 118;
    const keyY = stacked ? legendY + 24 : legendY;
    svgEl('rect', { x: keyX, y: keyY, width: 21, height: 13, rx: 3, class: 'heat-peak' }, svg);
    svgText(svg, keyX + 28, keyY + 10, 'Outlined = busiest slot', 'ch-muted');
    const bestHour = hourTotals.indexOf(Math.max(...hourTotals));
    const bestDay = dayTotals.indexOf(Math.max(...dayTotals));
    finishChart('heat', svg, 'When calls happen', 'Busiest slot: ' + weekdayNames[peak.weekday] + ' ' + hourRange(peak.hour) + ' IST with ' + fmtCount(peak.count) + ' ' + plural(peak.count, 'call', 'calls') +
      '. Busiest weekday: ' + weekdayNames[bestDay] + ' (' + fmtCount(dayTotals[bestDay]) + '). Busiest hour: ' + hourRange(bestHour) + ' (' + fmtCount(hourTotals[bestHour]) + ').');
  }

  function renderRateChart(data) {
    const host = byId('analytics-chart-rate');
    const rows = data.employees.filter((row) => row.total > 0)
      .sort((a, b) => b.connected / b.total - a.connected / a.total || b.total - a.total || a.name.localeCompare(b.name)).slice(0, 12);
    if (!rows.length) return chartMessage('rate', 'No employee activity in this period.');
    const width = hostWidth(host);
    const rowH = 52;
    const svg = newChart(host, width, rows.length * rowH + 4);
    rows.forEach((row, index) => {
      const y = 4 + index * rowH;
      const rate = row.connected / row.total;
      const group = svgEl('g', {}, svg);
      svgTitle(group, row.name + ': ' + rateText(rate * 100) + ' connect rate · ' + fmtCount(row.connected) + ' of ' + fmtCount(row.total) + ' calls connected · average length ' + (row.avgConnectedSeconds ? talkText(row.avgConnectedSeconds) : 'not available'));
      svgText(group, 0, y + 12, fitText(row.name, width - 64), '', 'start', row.name);
      svgText(group, width, y + 12, rateText(rate * 100), 'ch-strong', 'end');
      svgEl('rect', { x: 0, y: y + 19, width, height: 10, rx: 5, class: 'track' }, group);
      svgEl('rect', { x: 0, y: y + 19, width: r1(Math.max(rate > 0 ? 3 : 0, rate * width)), height: 10, rx: 5, class: 'bar-rate grow-x' }, group);
      svgText(group, 0, y + 44, fmtCount(row.connected) + ' of ' + fmtCount(row.total) + ' connected · avg ' + (row.avgConnectedSeconds ? talkText(row.avgConnectedSeconds) : 'n/a'), 'ch-muted');
    });
    const best = rows[0];
    finishChart('rate', svg, 'Connect rate by employee', 'Highest: ' + best.name + ' at ' + rateText(best.connected / best.total * 100) + ' (' + fmtCount(best.connected) + ' of ' + fmtCount(best.total) + '). Team average ' +
      rateText(rateOf(data.totals.connected, data.totals.total)) + '. Rates on few calls swing widely, so check the counts.');
  }

  function renderLengthChart(data) {
    const host = byId('analytics-chart-length');
    const buckets = data.buckets;
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    if (!buckets.length || !total) return chartMessage('length', 'No connected calls in this period.');
    const width = hostWidth(host);
    const left = 32;
    const right = 6;
    const top = 22;
    const bottom = 42;
    const height = 230;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const scale = niceCountScale(Math.max(1, ...buckets.map((bucket) => bucket.count)));
    const svg = newChart(host, width, height);
    drawYAxis(svg, left, top, plotW, plotH, scale, fmtCount);
    const slot = plotW / buckets.length;
    const barW = Math.max(8, Math.min(56, slot * 0.62));
    buckets.forEach((bucket, index) => {
      const centre = left + index * slot + slot / 2;
      const h = bucket.count / scale.top * plotH;
      const y = top + plotH - h;
      const group = svgEl('g', {}, svg);
      svgTitle(group, bucket.label + ': ' + fmtCount(bucket.count) + ' connected ' + plural(bucket.count, 'call', 'calls') + ' (' + percentText(bucket.count, total) + ')');
      if (h > 0) svgEl('rect', { x: r1(centre - barW / 2), y: r1(y), width: r1(barW), height: r1(h), rx: 2, class: 'bar-blue grow-y' }, group);
      svgText(group, centre, y - 5, fmtCount(bucket.count), 'ch-strong', 'middle');
      svgText(group, centre, top + plotH + 15, bucket.label, '', 'middle');
      svgText(group, centre, top + plotH + 29, percentText(bucket.count, total), 'ch-muted', 'middle');
    });
    const lead = busiest(buckets, (bucket) => bucket.count);
    finishChart('length', svg, 'Call length distribution', 'Most connected calls (' + percentText(lead.count, total) + ', ' + fmtCount(lead.count) + ' of ' + fmtCount(total) + ') lasted ' + lead.label + '.');
  }

  const leaderColumns = [
    { key: 'name', label: 'Employee', value: (row) => row.name, text: (row) => row.name },
    { key: 'total', label: 'Total', value: (row) => row.total, text: (row) => fmtCount(row.total) },
    { key: 'connected', label: 'Connected', value: (row) => row.connected, text: (row) => fmtCount(row.connected) },
    { key: 'rate', label: 'Connect %', value: (row) => rateOf(row.connected, row.total) || 0, text: (row) => rateText(rateOf(row.connected, row.total)) },
    { key: 'talk', label: 'Talk time', value: (row) => row.talkSeconds, text: (row) => talkText(row.talkSeconds) },
    { key: 'avg', label: 'Avg length', value: (row) => row.avgConnectedSeconds, text: (row) => talkText(row.avgConnectedSeconds) },
    { key: 'unique', label: 'Unique contacts', value: (row) => row.uniqueContacts, text: (row) => fmtCount(row.uniqueContacts) },
    { key: 'missed', label: 'Missed', value: (row) => row.missed, text: (row) => fmtCount(row.missed) },
    { key: 'recorded', label: 'Recorded', value: (row) => row.withRecording, text: (row) => fmtCount(row.withRecording) + ' (' + percentText(row.withRecording, row.connected) + ')' }
  ];
  function renderLeaderboard() {
    const host = byId('analytics-leaderboard');
    const data = analyticsData;
    if (!data.employees.length) {
      host.replaceChildren(element('p', 'No employee activity in this period.', 'chart-empty'));
      byId('analytics-leaderboard-note').textContent = '';
      return;
    }
    const column = leaderColumns.find((candidate) => candidate.key === analyticsSort.key) || leaderColumns[1];
    const factor = analyticsSort.dir === 'asc' ? 1 : -1;
    const rows = data.employees.slice().sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      const order = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return order * factor || a.name.localeCompare(b.name);
    });
    const table = element('table', undefined, 'leaderboard');
    table.append(element('caption', 'Employee call statistics for the selected period', 'sr-only'));
    const headRow = element('tr');
    for (const candidate of leaderColumns) {
      const cell = element('th');
      cell.scope = 'col';
      const active = candidate.key === column.key;
      if (active) cell.setAttribute('aria-sort', analyticsSort.dir === 'asc' ? 'ascending' : 'descending');
      const sortButton = element('button', undefined, 'sort');
      sortButton.type = 'button';
      sortButton.dataset.sort = candidate.key;
      const mark = element('span', active ? (analyticsSort.dir === 'asc' ? '▲' : '▼') : '', 'sort-mark');
      mark.setAttribute('aria-hidden', 'true');
      sortButton.append(candidate.label, mark);
      sortButton.addEventListener('click', () => {
        analyticsSort = analyticsSort.key === candidate.key
          ? { key: candidate.key, dir: analyticsSort.dir === 'asc' ? 'desc' : 'asc' }
          : { key: candidate.key, dir: candidate.key === 'name' ? 'asc' : 'desc' };
        renderLeaderboard();
        const focusTarget = host.querySelector('button[data-sort="' + candidate.key + '"]');
        if (focusTarget) focusTarget.focus();
      });
      cell.append(sortButton);
      headRow.append(cell);
    }
    const head = element('thead');
    head.append(headRow);
    const body = element('tbody');
    for (const row of rows) {
      const tr = element('tr');
      leaderColumns.forEach((candidate, index) => {
        const cell = element(index === 0 ? 'th' : 'td', candidate.text(row));
        if (index === 0) { cell.scope = 'row'; cell.title = row.name; }
        tr.append(cell);
      });
      body.append(tr);
    }
    const foot = element('tfoot');
    const totalRow = element('tr');
    const everyone = { name: 'All employees', ...data.totals };
    leaderColumns.forEach((candidate) => totalRow.append(element('td', candidate.text(everyone))));
    foot.append(totalRow);
    table.append(head, body, foot);
    host.replaceChildren(table);
    byId('analytics-leaderboard-note').textContent = data.employees.length + ' ' + plural(data.employees.length, 'employee', 'employees') + ' with calls · sorted by ' + column.label +
      ', ' + (column.key === 'name' ? (analyticsSort.dir === 'asc' ? 'A to Z' : 'Z to A') : (analyticsSort.dir === 'asc' ? 'low to high' : 'high to low')) + '. The bottom row covers everyone; unique contacts are counted once across employees.';
  }

  function renderCharts() {
    if (!analyticsData || byId('analytics-charts').hidden) return;
    const widths = chartNames.map((name) => byId('analytics-chart-' + name).clientWidth);
    if (widths.some((width) => width < 1)) return;
    analyticsWidthKey = widths.join(',');
    renderUsersChart(analyticsData);
    renderTypesChart(analyticsData);
    renderDaysChart(analyticsData);
    renderTalkChart(analyticsData);
    renderHeatChart(analyticsData);
    renderRateChart(analyticsData);
    renderLengthChart(analyticsData);
  }

  // ---- KPI cards ----
  const kpiDefs = [
    { label: 'Total calls', value: (m) => m.total, format: fmtCount, delta: 'percent', tone: 'neutral' },
    { label: 'Connected', value: (m) => m.connected, format: fmtCount, sub: (m) => 'Talk time ' + talkText(m.talkSeconds), delta: 'percent', tone: 'up-good' },
    { label: 'Not connected', value: (m) => m.notConnected, format: fmtCount, sub: () => 'No talk time', delta: 'percent', tone: 'up-bad' },
    { label: 'Unique contacts', value: (m) => m.uniqueContacts, format: fmtCount, delta: 'percent', tone: 'neutral' },
    { label: 'Incoming', type: 'incoming', value: (m) => m.incoming, format: fmtCount, sub: (m) => 'Talk time ' + talkText(m.incomingSeconds), delta: 'percent', tone: 'neutral' },
    { label: 'Outgoing', type: 'outgoing', value: (m) => m.outgoing, format: fmtCount, sub: (m) => 'Talk time ' + talkText(m.outgoingSeconds), delta: 'percent', tone: 'neutral' },
    { label: 'Missed', type: 'missed', value: (m) => m.missed, format: fmtCount, delta: 'percent', tone: 'up-bad' },
    { label: 'Rejected', type: 'rejected', value: (m) => m.rejected, format: fmtCount, delta: 'percent', tone: 'neutral' },
    { label: 'Connect rate', value: (m) => rateOf(m.connected, m.total), format: rateText, sub: (m) => fmtCount(m.connected) + ' of ' + fmtCount(m.total) + ' calls', delta: 'points', tone: 'up-good' },
    { label: 'Avg call length', value: (m) => m.avgConnectedSeconds, format: talkText, sub: () => 'Connected calls only', delta: 'percent', tone: 'neutral' },
    { label: 'Recorded', value: (m) => rateOf(m.withRecording, m.connected), format: rateText, sub: (m) => fmtCount(m.withRecording) + ' of ' + fmtCount(m.connected) + ' connected calls', delta: 'points', tone: 'neutral' }
  ];
  function computeDelta(current, previous, mode) {
    if (current === null) return null;
    if (previous === null || (previous === 0 && current > 0)) return { dir: 'up', text: 'new' };
    const diff = current - previous;
    if (diff === 0) return { dir: 'flat', text: 'No change' };
    if (mode === 'points') {
      const points = r1(Math.abs(diff));
      return points === 0 ? { dir: 'flat', text: 'No change' } : { dir: diff > 0 ? 'up' : 'down', text: points + ' pts' };
    }
    const pct = Math.abs(diff) / previous * 100;
    return { dir: diff > 0 ? 'up' : 'down', text: pct < 1 ? '<1%' : Math.round(pct).toLocaleString() + '%' };
  }
  function kpiCard(def, totals, previous) {
    const card = element('article', undefined, 'kpi');
    const label = element('h3', undefined, 'kpi-label');
    if (def.type) label.append(swatch(def.type));
    label.append(def.label);
    const current = def.value(totals);
    const prior = def.value(previous);
    card.append(label, element('p', def.format(current), 'kpi-value'));
    if (def.sub) card.append(element('p', def.sub(totals), 'kpi-sub'));
    const row = element('p', undefined, 'kpi-delta');
    const delta = computeDelta(current, prior, def.delta);
    if (delta) {
      let tone = 'flat';
      if (delta.dir !== 'flat' && def.tone !== 'neutral') tone = (delta.dir === 'up') === (def.tone === 'up-good') ? 'good' : 'bad';
      const badge = element('span', undefined, 'delta ' + tone);
      const arrow = element('span', delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '–');
      arrow.setAttribute('aria-hidden', 'true');
      badge.append(arrow);
      if (delta.dir !== 'flat') badge.append(element('span', delta.dir === 'up' ? 'Up ' : 'Down ', 'sr-only'));
      badge.append(delta.text);
      row.append(badge, element('span', 'previous ' + def.format(prior)));
      row.title = 'Compared with the previous period of equal length';
    } else {
      row.append(element('span', 'No calls to compare'));
    }
    card.append(row);
    return card;
  }
  function renderKpis(data) {
    const fragment = document.createDocumentFragment();
    for (const def of kpiDefs) fragment.append(kpiCard(def, data.totals, data.previous));
    const peak = data.totals.total ? busiest(data.byDay, (day) => day.total) : null;
    const card = element('article', undefined, 'kpi');
    card.append(element('h3', 'Busiest day', 'kpi-label'), element('p', peak ? dayLabel(peak.date, true) + ' ' + dayParts(peak.date).month : '–', 'kpi-value'),
      element('p', peak ? fmtCount(peak.total) + ' ' + plural(peak.total, 'call', 'calls') + ' · ' + fmtCount(peak.connected) + ' connected' : 'No calls', 'kpi-sub'),
      element('p', peak ? dayFull(peak.date) : '', 'kpi-delta'));
    fragment.append(card);
    byId('analytics-kpis').replaceChildren(fragment);
  }

  function renderAnalytics(animate) {
    const data = analyticsData;
    setAnalyticsTitle(data.range.from, data.range.to);
    byId('analytics-subtitle').textContent = 'Compared with ' + rangeText(data.range.previousFrom, data.range.previousTo) + ', the ' + data.range.days + ' ' + plural(data.range.days, 'day', 'days') + ' before. Days run midnight to midnight IST.';
    renderKpis(data);
    const empty = data.totals.total === 0;
    byId('analytics-empty').hidden = !empty;
    byId('analytics-charts').hidden = empty;
    if (empty) return;
    const content = byId('analytics-content');
    clearTimeout(analyticsAnimTimer);
    content.classList.toggle('anim', animate);
    if (animate) analyticsAnimTimer = setTimeout(() => content.classList.remove('anim'), 900);
    renderCharts();
    renderLeaderboard();
  }

  // ---- Loading ----
  function cancelAnalytics() {
    analyticsVersion++;
    if (analyticsController) analyticsController.abort();
    if (!analyticsLoading) return;
    analyticsLoading = false;
    byId('analytics-results').setAttribute('aria-busy', 'false');
    byId('analytics-refresh').disabled = false;
    byId('analytics-skeleton').hidden = true;
    byId('analytics-content').classList.remove('is-loading');
    message('analytics-status', 'Loading cancelled. Return to Call analytics or use Refresh to retry.');
  }
  async function loadAnalytics() {
    const version = ++analyticsVersion;
    if (analyticsController) analyticsController.abort();
    analyticsController = new AbortController();
    const requested = analyticsState;
    analyticsLoading = true;
    byId('analytics-results').setAttribute('aria-busy', 'true');
    byId('analytics-refresh').disabled = true;
    message('analytics-error', '');
    setAnalyticsTitle(requested.from, requested.to);
    message('analytics-status', 'Loading call analytics…');
    byId('analytics-skeleton').hidden = Boolean(analyticsData);
    byId('analytics-content').classList.toggle('is-loading', Boolean(analyticsData));
    try {
      const raw = await api('/analytics/calls?' + analyticsParams(requested), { signal: analyticsController.signal });
      if (version !== analyticsVersion) return;
      analyticsData = readAnalytics(raw);
      byId('analytics-skeleton').hidden = true;
      byId('analytics-content').hidden = false;
      byId('analytics-content').classList.remove('is-loading');
      renderAnalytics(true);
      message('analytics-status', fmtCount(analyticsData.totals.total) + ' ' + plural(analyticsData.totals.total, 'call', 'calls') + ' · ' + rangeText(analyticsData.range.from, analyticsData.range.to) + ' · IST');
    } catch (error) {
      if (version !== analyticsVersion || error.name === 'AbortError') return;
      analyticsData = null;
      byId('analytics-skeleton').hidden = true;
      byId('analytics-content').hidden = true;
      message('analytics-status', 'Call analytics could not be loaded.');
      message('analytics-error', errorMessage(error) + ' Use Refresh to try again.');
    } finally {
      if (version === analyticsVersion) {
        analyticsLoading = false;
        byId('analytics-results').setAttribute('aria-busy', 'false');
        byId('analytics-refresh').disabled = false;
      }
    }
  }

  // ---- Filters ----
  function checkedValues(box) { return Array.from(box.querySelectorAll('input:checked'), (input) => input.value); }
  function choiceItem(value, text, checked, icon) {
    const label = element('label', undefined, 'checkbox-filter');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = value;
    box.checked = checked;
    label.append(box);
    if (icon) label.append(icon);
    label.append(element('span', text));
    return label;
  }
  function updateMultiLabels() {
    const ids = checkedValues(byId('analytics-employee-choices'));
    byId('analytics-employees-label').textContent = !ids.length ? 'All employees' : ids.length === 1 ? (employees.get(ids[0])?.name || ids[0]) : ids.length + ' employees';
    const types = checkedValues(byId('analytics-type-choices'));
    byId('analytics-types-label').textContent = !types.length ? 'All types' : types.length === 1 ? callTypeNames[types[0]] || types[0] : types.length + ' types';
  }
  function renderAnalyticsEmployeeChoices(selectedIds) {
    const box = byId('analytics-employee-choices');
    const selected = new Set(selectedIds || checkedValues(box));
    const fragment = document.createDocumentFragment();
    for (const employee of employees.values()) fragment.append(choiceItem(employee.id, employee.name + (employee.active === false ? ' (inactive)' : ''), selected.has(employee.id)));
    for (const id of selected) if (!employees.has(id)) fragment.append(choiceItem(id, id + ' (not in directory)', true));
    if (!fragment.childNodes.length) fragment.append(element('p', 'Employee choices are still loading.', 'hint'));
    box.replaceChildren(fragment);
    updateMultiLabels();
  }
  function renderAnalyticsTypeChoices(selectedTypes) {
    const fragment = document.createDocumentFragment();
    for (const type of analyticsTypes) fragment.append(choiceItem(type, callTypeNames[type], selectedTypes.includes(type), swatch(type)));
    byId('analytics-type-choices').replaceChildren(fragment);
    updateMultiLabels();
  }
  function updatePresetState() {
    const from = byId('analytics-from').value;
    const to = byId('analytics-to').value;
    for (const chip of byId('analytics-presets').querySelectorAll('button[data-preset]')) {
      const range = presetRange(chip.dataset.preset);
      chip.setAttribute('aria-pressed', String(range.from === from && range.to === to));
    }
  }
  function presetRange(name) {
    const today = istToday();
    if (name === 'today') return { from: today, to: today };
    if (name === 'yesterday') { const day = shiftDay(today, -1); return { from: day, to: day }; }
    if (name === 'month') return { from: today.slice(0, 8) + '01', to: today };
    return { from: shiftDay(today, name === '30' ? -29 : -6), to: today };
  }
  function syncAnalyticsControls() {
    byId('analytics-from').value = analyticsState.from;
    byId('analytics-to').value = analyticsState.to;
    renderAnalyticsEmployeeChoices(analyticsState.employeeIds);
    renderAnalyticsTypeChoices(analyticsState.callTypes);
    updatePresetState();
    setAnalyticsTitle(analyticsState.from, analyticsState.to);
  }
  function applyAnalyticsFilters(range) {
    message('analytics-filter-error', '');
    const from = range ? range.from : byId('analytics-from').value;
    const to = range ? range.to : byId('analytics-to').value;
    if (range) { byId('analytics-from').value = from; byId('analytics-to').value = to; }
    const employeeIds = checkedValues(byId('analytics-employee-choices'));
    const checkedTypes = checkedValues(byId('analytics-type-choices'));
    let problem = '';
    let focus = byId('analytics-from');
    if (Number.isNaN(parseDay(from))) problem = 'Choose a valid start date.';
    else if (Number.isNaN(parseDay(to))) { problem = 'Choose a valid end date.'; focus = byId('analytics-to'); }
    else if (from > to) problem = 'The start date must be on or before the end date.';
    else if (daysBetween(from, to) > 366) problem = 'Choose a range of 366 days or fewer.';
    else if (employeeIds.length > 50) { problem = 'Choose at most 50 employees, or use Show all employees.'; focus = byId('analytics-employees').querySelector('summary'); }
    if (problem) {
      message('analytics-filter-error', problem);
      focus.focus();
      return;
    }
    analyticsState = { from, to, employeeIds, callTypes: analyticsTypes.filter((type) => checkedTypes.includes(type)) };
    for (const menu of document.querySelectorAll('details.multi')) menu.open = false;
    writeAnalyticsHash();
    syncAnalyticsControls();
    loadAnalytics();
  }
  function openAnalytics(entering) {
    const parsed = location.hash.indexOf('?') >= 0 ? parseAnalyticsHash() : null;
    const first = !analyticsState;
    let changed = false;
    if (first) analyticsState = parsed || defaultAnalyticsState();
    else if (parsed && !sameAnalyticsState(parsed, analyticsState)) { analyticsState = parsed; changed = true; }
    writeAnalyticsHash();
    if (first || changed || entering) {
      syncAnalyticsControls();
      loadAnalytics();
    }
  }
  byId('analytics-form').addEventListener('submit', (event) => { event.preventDefault(); applyAnalyticsFilters(); });
  byId('analytics-refresh').addEventListener('click', () => { if (analyticsState) loadAnalytics(); });
  for (const chip of byId('analytics-presets').querySelectorAll('button[data-preset]')) {
    chip.addEventListener('click', () => applyAnalyticsFilters(presetRange(chip.dataset.preset)));
  }
  byId('analytics-from').addEventListener('input', updatePresetState);
  byId('analytics-to').addEventListener('input', updatePresetState);
  byId('analytics-employee-choices').addEventListener('change', updateMultiLabels);
  byId('analytics-type-choices').addEventListener('change', updateMultiLabels);
  byId('analytics-employees-clear').addEventListener('click', () => {
    for (const box of byId('analytics-employee-choices').querySelectorAll('input')) box.checked = false;
    updateMultiLabels();
  });
  byId('analytics-types-clear').addEventListener('click', () => {
    for (const box of byId('analytics-type-choices').querySelectorAll('input')) box.checked = false;
    updateMultiLabels();
  });
  for (const menu of document.querySelectorAll('details.multi')) {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of document.querySelectorAll('details.multi[open]')) if (other !== menu) other.open = false;
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector('summary').focus();
    });
  }
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('details.multi[open]')) if (!menu.contains(event.target)) menu.open = false;
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!analyticsData || byId('analytics-panel').hidden || byId('analytics-charts').hidden) return;
      if (chartNames.map((name) => byId('analytics-chart-' + name).clientWidth).join(',') === analyticsWidthKey) return;
      clearTimeout(analyticsResizeTimer);
      analyticsResizeTimer = setTimeout(renderCharts, 100);
    }).observe(byId('analytics-charts'));
  }
  window.addEventListener('pagehide', () => { clearInvitation(); closePlayer(); cancelCallHistory(); cancelAnalytics(); });

  // ---- Config tab: WhatsApp auto replies and quick messages ----
  // Everything shown comes from the server through textContent; the lists are rebuilt from state after each change.
  const MATCH_LABELS = { contains: 'Contains', exact: 'Exactly matches', starts_with: 'Starts with' };
  const AUTO_SOURCES = TEMPLATE_SOURCES.map(([value, text]) => [value.replace('-', '_'), text]);
  const AUTO_BASE = '/whatsapp/auto-replies';
  const QUICK_BASE = '/whatsapp/quick-messages';
  let autoReplies = null;
  let autoReplyBusy = false;
  let autoReplyVersion = 0;
  let autoReplyController;
  let activityVersion = 0;
  let activityController;
  let quickLoadingShown = false;

  function singleLine(text, limit) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit).trimEnd() + '…' : flat;
  }
  function cooldownText(minutes) {
    if (minutes >= 1440 && minutes % 1440 === 0) return minutes / 1440 + ' ' + plural(minutes / 1440, 'day', 'days');
    if (minutes >= 60 && minutes % 60 === 0) return minutes / 60 + ' ' + plural(minutes / 60, 'hour', 'hours');
    if (minutes > 60) return Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min';
    return minutes + ' ' + plural(minutes, 'minute', 'minutes');
  }
  // Focuses the first enabled control with one of the actions in a list row, else the fallback element.
  function focusRow(listId, attribute, id, actions, fallbackId) {
    const row = id ? byId(listId).querySelector('[' + attribute + '="' + CSS.escape(id) + '"]') : null;
    let target = null;
    if (row) for (const action of actions) { target = row.querySelector('[data-action="' + action + '"]:not(:disabled)'); if (target) break; }
    (target || byId(fallbackId)).focus();
  }
  async function fetchTemplateList() {
    if (templateState.templates && Date.now() - templateState.loadedAt < 300000) return templateState.templates;
    const data = await api('/whatsapp/templates');
    if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable templates. Please try again.');
    templateState.templates = data.items.map(readTemplate).filter(Boolean);
    templateState.loadedAt = Date.now();
    return templateState.templates;
  }

  // Sidebar: a list of sections, each with a content block id config-section-NAME.
  const configNavItems = Array.from(byId('config-nav').querySelectorAll('button[data-section]'));
  for (const item of configNavItems) {
    item.addEventListener('click', () => selectConfigSection(item.dataset.section, true));
  }

  // Shared confirmation dialog for the Config tab.
  const configDeleteDialog = byId('config-delete-dialog');
  const configDelete = { run: null, after: null, opener: null, busy: false, done: false };
  function openConfigDelete(options) {
    if (configDelete.busy) return;
    configDelete.run = options.run;
    configDelete.after = options.after;
    configDelete.opener = options.opener || null;
    configDelete.done = false;
    byId('config-delete-title').textContent = options.title;
    byId('config-delete-description').textContent = options.description;
    byId('config-delete-name').textContent = options.name;
    byId('confirm-config-delete').textContent = options.confirmLabel;
    byId('cancel-config-delete').textContent = options.cancelLabel;
    message('config-delete-error', '');
    configDeleteDialog.showModal();
    byId('cancel-config-delete').focus();
  }
  byId('cancel-config-delete').addEventListener('click', () => { if (!configDelete.busy) configDeleteDialog.close(); });
  configDeleteDialog.addEventListener('cancel', (event) => { if (configDelete.busy) event.preventDefault(); });
  configDeleteDialog.addEventListener('close', () => {
    const { opener, after, done } = configDelete;
    configDelete.run = configDelete.after = configDelete.opener = null;
    if (done && after) after();
    else if (opener && opener.isConnected) opener.focus();
  });
  byId('config-delete-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (configDelete.busy || !configDelete.run) return;
    configDelete.busy = true;
    const label = byId('confirm-config-delete').textContent;
    byId('confirm-config-delete').disabled = byId('cancel-config-delete').disabled = true;
    byId('confirm-config-delete').textContent = 'Deleting…';
    message('config-delete-error', '');
    try {
      await configDelete.run();
      configDelete.done = true;
      configDeleteDialog.close();
    } catch (error) {
      message('config-delete-error', errorMessage(error));
    } finally {
      configDelete.busy = false;
      byId('confirm-config-delete').disabled = byId('cancel-config-delete').disabled = false;
      byId('confirm-config-delete').textContent = label;
      if (configDeleteDialog.open) byId('cancel-config-delete').focus();
    }
  });

  // -- Auto reply rules --
  function readAutoReply(item) {
    const bad = () => new Error('An auto-reply rule could not be read. Please refresh.');
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !Object.hasOwn(MATCH_LABELS, item.matchType) || !Array.isArray(item.keywords) || !item.reply || typeof item.reply !== 'object') throw bad();
    let reply;
    if (item.reply.type === 'text' && typeof item.reply.text === 'string') {
      reply = { type: 'text', text: item.reply.text };
    } else if (item.reply.type === 'template' && typeof item.reply.name === 'string' && typeof item.reply.language === 'string') {
      const sources = AUTO_SOURCES.map((pair) => pair[0]);
      const params = Array.isArray(item.reply.params) ? item.reply.params : [];
      reply = {
        type: 'template',
        name: item.reply.name,
        language: item.reply.language,
        params: params.map((param) => ({ source: param && sources.includes(param.source) ? param.source : 'custom', value: param && typeof param.value === 'string' ? param.value : '' }))
      };
    } else {
      throw bad();
    }
    return {
      id: item.id,
      name: item.name,
      enabled: item.enabled === true,
      matchType: item.matchType,
      keywords: item.keywords.filter((word) => typeof word === 'string'),
      reply,
      cooldownMinutes: Number.isInteger(item.cooldownMinutes) ? item.cooldownMinutes : 1440,
      triggerCount: Number.isInteger(item.triggerCount) ? item.triggerCount : 0,
      lastTriggeredAt: typeof item.lastTriggeredAt === 'string' ? item.lastTriggeredAt : ''
    };
  }
  function readAutoReplyList(data) {
    if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable auto-reply rules. Please try again.');
    return data.items.map(readAutoReply);
  }
  function keywordSummary(rule) {
    const shown = rule.keywords.slice(0, 3).join(', ');
    const more = rule.keywords.length - 3;
    return MATCH_LABELS[rule.matchType] + ': ' + shown + (more > 0 ? ' +' + more + ' more' : '');
  }
  function replySummary(rule) {
    return rule.reply.type === 'template' ? 'Template: ' + rule.reply.name : singleLine(rule.reply.text, 80);
  }
  function renderAutoReply(rule, index, total) {
    const card = element('article', undefined, 'management-card cfg-rule');
    card.dataset.ruleId = rule.id;
    card.dataset.enabled = String(rule.enabled);
    const title = element('div', undefined, 'cfg-rule-title');
    title.append(element('span', '#' + (index + 1), 'cfg-rule-pos'), element('h4', rule.name, 'cfg-rule-name'));
    const toggle = element('label', undefined, 'cfg-switch');
    const box = element('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.setAttribute('aria-label', 'Enabled: ' + rule.name);
    box.checked = rule.enabled;
    box.dataset.action = 'toggle';
    box.addEventListener('change', () => setAutoReplyEnabled(rule, box.checked));
    toggle.append(box, element('span', 'Enabled'));
    const head = element('div', undefined, 'cfg-rule-head');
    head.append(title, toggle);
    const facts = element('dl', undefined, 'cfg-facts');
    facts.append(
      fact('Matches', keywordSummary(rule)),
      fact('Reply', replySummary(rule)),
      fact('Cooldown', cooldownText(rule.cooldownMinutes) + ' per customer'),
      fact('Triggered', rule.triggerCount === 0 ? 'Not yet' : rule.triggerCount.toLocaleString() + ' ' + plural(rule.triggerCount, 'time', 'times') + (rule.lastTriggeredAt ? ' · last ' + dateText(rule.lastTriggeredAt) : ''))
    );
    const actions = element('div', undefined, 'actions');
    const up = button('Move up', () => moveAutoReply(rule, -1));
    up.dataset.action = 'up';
    up.disabled = index === 0;
    up.setAttribute('aria-label', 'Move up: ' + rule.name);
    const down = button('Move down', () => moveAutoReply(rule, 1));
    down.dataset.action = 'down';
    down.disabled = index === total - 1;
    down.setAttribute('aria-label', 'Move down: ' + rule.name);
    const edit = button('Edit', () => openAutoReplyDialog(rule, edit));
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-label', 'Edit ' + rule.name);
    const remove = button('Delete', () => deleteAutoReply(rule, remove), 'secondary delete-button');
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', 'Delete ' + rule.name);
    actions.append(up, down, edit, remove);
    card.append(head, facts, actions);
    return card;
  }
  function renderAutoReplies(focus) {
    const list = byId('autoreply-list');
    if (!autoReplies) {
      list.replaceChildren();
    } else if (!autoReplies.length) {
      list.replaceChildren(emptyState('No auto-reply rules yet', 'Add a rule to reply automatically when a customer’s message contains certain words.'));
    } else {
      list.replaceChildren(...autoReplies.map((rule, index) => renderAutoReply(rule, index, autoReplies.length)));
    }
    if (focus) focusRow('autoreply-list', 'data-rule-id', focus.id, focus.actions, 'autoreply-heading');
  }
  function cancelAutoReplyLoad() {
    autoReplyVersion++;
    if (autoReplyController) autoReplyController.abort();
    byId('autoreply-list').setAttribute('aria-busy', 'false');
    message('autoreply-status', '');
  }
  async function loadAutoReplies() {
    const version = ++autoReplyVersion;
    if (autoReplyController) autoReplyController.abort();
    autoReplyController = new AbortController();
    byId('autoreply-list').setAttribute('aria-busy', 'true');
    message('autoreply-error', '');
    byId('autoreply-retry').hidden = true;
    message('autoreply-status', autoReplies ? '' : 'Loading auto-reply rules…');
    try {
      const rules = readAutoReplyList(await api(AUTO_BASE, { signal: autoReplyController.signal }));
      if (version !== autoReplyVersion) return;
      autoReplies = rules;
      message('autoreply-status', '');
      renderAutoReplies();
    } catch (error) {
      if (version !== autoReplyVersion || error.name === 'AbortError') return;
      message('autoreply-status', '');
      message('autoreply-error', 'Could not load auto-reply rules. ' + errorMessage(error));
      byId('autoreply-retry').hidden = false;
    } finally {
      if (version === autoReplyVersion) byId('autoreply-list').setAttribute('aria-busy', 'false');
    }
  }
  // Runs one change on the list at a time; the list is rebuilt from state afterwards, which also reverts a failed switch.
  async function runAutoReplyAction(focus, work) {
    if (autoReplyBusy || !autoReplies) return;
    autoReplyBusy = true;
    cancelAutoReplyLoad();
    for (const control of byId('autoreply-list').querySelectorAll('button, input')) control.disabled = true;
    message('autoreply-error', '');
    byId('autoreply-retry').hidden = true;
    try {
      await work();
    } catch (error) {
      message('autoreply-error', errorMessage(error));
    } finally {
      autoReplyBusy = false;
      renderAutoReplies(focus);
    }
  }
  function setAutoReplyEnabled(rule, enabled) {
    runAutoReplyAction({ id: rule.id, actions: ['toggle'] }, async () => {
      const data = await api(AUTO_BASE + '/' + encodeURIComponent(rule.id), { method: 'PATCH', body: JSON.stringify({ enabled }) });
      autoReplies = autoReplies.map((item) => (item.id === rule.id ? readAutoReply(data && data.rule) : item));
      message('autoreply-status', (enabled ? 'Turned on ' : 'Turned off ') + rule.name + '.');
    });
  }
  function moveAutoReply(rule, offset) {
    const from = autoReplies ? autoReplies.findIndex((item) => item.id === rule.id) : -1;
    const to = from + offset;
    if (from < 0 || to < 0 || to >= autoReplies.length) return;
    runAutoReplyAction({ id: rule.id, actions: offset < 0 ? ['up', 'down'] : ['down', 'up'] }, async () => {
      const ids = autoReplies.map((item) => item.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      const data = await api(AUTO_BASE + '/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
      autoReplies = readAutoReplyList(data);
      message('autoreply-status', 'Moved ' + rule.name + ' to position ' + (autoReplies.findIndex((item) => item.id === rule.id) + 1) + ' of ' + autoReplies.length + '.');
    });
  }
  function deleteAutoReply(rule, opener) {
    if (autoReplyBusy) return;
    openConfigDelete({
      title: 'Delete this auto-reply rule?',
      description: 'Customers will no longer receive this automatic reply. Messages already sent stay in their chats. This cannot be undone.',
      name: rule.name + ' · ' + keywordSummary(rule),
      confirmLabel: 'Delete rule',
      cancelLabel: 'Keep rule',
      opener,
      run: async () => {
        cancelAutoReplyLoad();
        await api(AUTO_BASE + '/' + encodeURIComponent(rule.id), { method: 'DELETE', body: '{}' });
        if (autoReplies) autoReplies = autoReplies.filter((item) => item.id !== rule.id);
        renderAutoReplies();
        message('autoreply-status', 'Deleted ' + rule.name + '.');
      },
      after: () => byId('autoreply-heading').focus()
    });
  }
  byId('autoreply-add').addEventListener('click', (event) => openAutoReplyDialog(null, event.currentTarget));
  byId('autoreply-retry').addEventListener('click', loadAutoReplies);

  // -- Recent auto-replies --
  function readActivity(item) {
    if (!item || typeof item.id !== 'string' || typeof item.ruleName !== 'string' || typeof item.customerName !== 'string' || !['sent', 'failed'].includes(item.status) || typeof item.at !== 'string') {
      throw new Error('An auto-reply entry could not be read. Please refresh.');
    }
    return item;
  }
  function renderActivity(item) {
    const row = element('div', undefined, 'cfg-activity-row');
    const time = element('time', dateText(item.at), 'cfg-activity-time');
    time.dateTime = item.at;
    row.append(time, element('span', item.ruleName), element('span', item.customerName), element('span', item.status === 'sent' ? 'Sent' : 'Failed', 'badge ' + (item.status === 'sent' ? 'complete' : 'failed')));
    return row;
  }
  async function loadActivity() {
    const version = ++activityVersion;
    if (activityController) activityController.abort();
    activityController = new AbortController();
    const list = byId('autoreply-activity-list');
    list.setAttribute('aria-busy', 'true');
    byId('autoreply-activity-refresh').disabled = true;
    message('autoreply-activity-error', '');
    message('autoreply-activity-status', 'Loading recent auto-replies…');
    try {
      const data = await api(AUTO_BASE + '/activity?limit=20', { signal: activityController.signal });
      if (version !== activityVersion) return;
      if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable auto-reply activity. Please try again.');
      const items = data.items.map(readActivity);
      list.replaceChildren(...items.map(renderActivity));
      message('autoreply-activity-status', items.length ? '' : 'No automatic replies have been sent yet.');
    } catch (error) {
      if (version !== activityVersion || error.name === 'AbortError') return;
      message('autoreply-activity-status', '');
      message('autoreply-activity-error', 'Could not load recent auto-replies. ' + errorMessage(error));
    } finally {
      if (version === activityVersion) {
        list.setAttribute('aria-busy', 'false');
        byId('autoreply-activity-refresh').disabled = false;
      }
    }
  }
  byId('autoreply-activity-refresh').addEventListener('click', loadActivity);

  // -- Auto reply dialog --
  const autoReplyDialog = byId('autoreply-dialog');
  const arDialog = { rule: null, opener: null, saving: false, version: 0, options: [], current: null, refs: [], savedId: '', templatesRequested: false };
  function applyReplyType() {
    const template = byId('autoreply-type-template').checked;
    byId('autoreply-text-group').hidden = template;
    byId('autoreply-template-group').hidden = !template;
    byId('autoreply-text').required = !template;
    byId('autoreply-template').required = template;
    if (template && !arDialog.templatesRequested) loadAutoReplyTemplates();
  }
  function updateCooldownText() {
    const raw = byId('autoreply-cooldown').value.trim();
    const value = Number(raw);
    byId('autoreply-cooldown-text').textContent = raw && Number.isInteger(value) && value >= 1 && value <= 10080 ? 'That is ' + cooldownText(value) + '.' : '';
  }
  function renderAutoReplyParams(template, prefill) {
    arDialog.current = template;
    arDialog.refs = [];
    const body = byId('autoreply-template-body');
    body.textContent = template ? template.body : '';
    body.hidden = !template || !template.body;
    if (!template) { byId('autoreply-template-fields').replaceChildren(); return; }
    const usable = prefill && prefill.length === template.variables.length ? prefill : null;
    const fields = template.variables.map((variable, index) => {
      const saved = usable ? usable[index] : null;
      const group = element('div', undefined, 'cfg-param');
      group.append(element('span', '{{' + variable.key + '}}', 'cfg-param-label'));
      const row = element('div', undefined, 'cfg-param-row');
      const select = element('select');
      select.setAttribute('aria-label', 'Fill {{' + variable.key + '}} with');
      for (const [value, text] of AUTO_SOURCES) {
        const option = element('option', text);
        option.value = value;
        select.append(option);
      }
      select.value = saved ? saved.source : defaultTemplateSource(variable, index).replace('-', '_');
      const field = element('input');
      field.type = 'text';
      field.maxLength = 1024;
      field.autocomplete = 'off';
      field.placeholder = variable.example || 'Text to send';
      field.setAttribute('aria-label', 'Custom text for {{' + variable.key + '}}');
      field.value = saved && saved.source === 'custom' ? saved.value : '';
      const sync = () => { field.hidden = select.value !== 'custom'; field.required = select.value === 'custom'; };
      select.addEventListener('change', () => { sync(); if (select.value === 'custom') field.focus(); });
      sync();
      row.append(select, field);
      group.append(row);
      arDialog.refs.push({ select, input: field, key: variable.key });
      return group;
    });
    if (!fields.length) fields.push(element('p', 'This template has no variables.', 'hint'));
    byId('autoreply-template-fields').replaceChildren(...fields);
  }
  function fillAutoReplyTemplates(list) {
    const existing = arDialog.rule && arDialog.rule.reply.type === 'template' ? arDialog.rule.reply : null;
    const options = list.slice();
    let wanted = existing ? options.findIndex((item) => sameTemplate(item, existing)) : -1;
    if (existing && wanted < 0) {
      options.push({ name: existing.name, language: existing.language, category: '', body: '', variables: existing.params.map((param, index) => ({ key: String(index + 1), example: '' })), unavailable: true });
      wanted = options.length - 1;
    }
    arDialog.options = options;
    const select = byId('autoreply-template');
    const placeholder = element('option', 'Select a template');
    placeholder.value = '';
    select.replaceChildren(placeholder, ...options.map((item, index) => {
      const option = element('option', item.name + ' · ' + item.language + (item.unavailable ? ' (not available for sending)' : ''));
      option.value = String(index);
      return option;
    }));
    if (wanted >= 0) {
      select.value = String(wanted);
      renderAutoReplyParams(options[wanted], existing.params);
    } else {
      select.value = '';
      renderAutoReplyParams(null, null);
    }
  }
  async function loadAutoReplyTemplates() {
    const version = arDialog.version;
    arDialog.templatesRequested = true;
    const select = byId('autoreply-template');
    select.disabled = true;
    message('autoreply-template-error', '');
    byId('autoreply-template-retry').hidden = true;
    message('autoreply-template-status', 'Loading templates…');
    let list = [];
    let failed = false;
    try {
      list = (await fetchTemplateList()).filter((item) => item.sendable);
    } catch (error) {
      failed = true;
      if (version === arDialog.version) message('autoreply-template-error', error.status === 503 && error.code === 'WHATSAPP_NOT_CONFIGURED' ? 'WhatsApp templates are unavailable because WhatsApp is not configured.' : 'Could not load templates. ' + errorMessage(error));
    }
    if (version !== arDialog.version) return;
    message('autoreply-template-status', '');
    byId('autoreply-template-retry').hidden = !failed;
    fillAutoReplyTemplates(list);
    select.disabled = false;
  }
  function parseKeywords(text) {
    const seen = new Set();
    const words = [];
    for (const raw of text.split(/[\r\n,]+/)) {
      const word = raw.replace(/\s+/g, ' ').trim();
      const key = word.toLowerCase();
      if (!word || seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
    return words;
  }
  function collectAutoReply() {
    if (!byId('autoreply-type-template').checked) {
      const text = byId('autoreply-text').value.trim();
      if (!text) return { error: 'Enter the reply text.', focus: byId('autoreply-text') };
      if (text.length > 4096) return { error: 'The reply text can be at most 4096 characters.', focus: byId('autoreply-text') };
      return { reply: { type: 'text', text } };
    }
    const template = arDialog.current;
    if (!template) return { error: 'Choose a template.', focus: byId('autoreply-template') };
    const params = [];
    for (const ref of arDialog.refs) {
      const param = { source: ref.select.value };
      if (param.source === 'custom') {
        param.value = ref.input.value.replace(/[\t\r\n]+/g, ' ').trim();
        if (!param.value) return { error: 'Enter the custom text for {{' + ref.key + '}}.', focus: ref.input };
      }
      params.push(param);
    }
    return { reply: { type: 'template', name: template.name, language: template.language, params } };
  }
  function openAutoReplyDialog(rule, opener) {
    arDialog.version++;
    arDialog.rule = rule;
    arDialog.opener = opener || null;
    arDialog.saving = false;
    arDialog.savedId = '';
    arDialog.options = [];
    arDialog.refs = [];
    arDialog.current = null;
    arDialog.templatesRequested = false;
    byId('autoreply-form').reset();
    byId('autoreply-dialog-title').textContent = rule ? 'Edit auto-reply rule' : 'Add auto-reply rule';
    byId('confirm-autoreply').textContent = rule ? 'Save changes' : 'Add rule';
    if (rule) {
      byId('autoreply-name').value = rule.name;
      byId('autoreply-match').value = rule.matchType;
      byId('autoreply-keywords').value = rule.keywords.join('\n');
      byId('autoreply-cooldown').value = String(rule.cooldownMinutes);
      byId('autoreply-enabled').checked = rule.enabled;
      byId(rule.reply.type === 'template' ? 'autoreply-type-template' : 'autoreply-type-text').checked = true;
      if (rule.reply.type === 'text') byId('autoreply-text').value = rule.reply.text;
    }
    const placeholder = element('option', 'Select a template');
    placeholder.value = '';
    byId('autoreply-template').replaceChildren(placeholder);
    byId('autoreply-template').disabled = false;
    renderAutoReplyParams(null, null);
    message('autoreply-template-status', '');
    message('autoreply-template-error', '');
    byId('autoreply-template-retry').hidden = true;
    message('autoreply-dialog-status', '');
    message('autoreply-dialog-error', '');
    byId('autoreply-fields').disabled = false;
    updateCooldownText();
    applyReplyType();
    autoReplyDialog.showModal();
    byId('autoreply-name').focus();
  }
  for (const id of ['autoreply-type-text', 'autoreply-type-template']) byId(id).addEventListener('change', applyReplyType);
  byId('autoreply-cooldown').addEventListener('input', updateCooldownText);
  byId('autoreply-template').addEventListener('change', () => {
    const value = byId('autoreply-template').value;
    renderAutoReplyParams(value === '' ? null : arDialog.options[Number(value)], null);
  });
  byId('autoreply-template-retry').addEventListener('click', loadAutoReplyTemplates);
  byId('cancel-autoreply').addEventListener('click', () => { if (!arDialog.saving) autoReplyDialog.close(); });
  autoReplyDialog.addEventListener('cancel', (event) => { if (arDialog.saving) event.preventDefault(); });
  autoReplyDialog.addEventListener('close', () => {
    arDialog.version++;
    const { opener, savedId } = arDialog;
    arDialog.opener = null;
    arDialog.rule = null;
    if (savedId) focusRow('autoreply-list', 'data-rule-id', savedId, ['edit'], 'autoreply-heading');
    else (opener && opener.isConnected ? opener : byId('autoreply-add')).focus();
  });
  byId('autoreply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (arDialog.saving) return;
    message('autoreply-dialog-error', '');
    message('autoreply-dialog-status', '');
    const fail = (text, target) => { message('autoreply-dialog-error', text); if (target) target.focus(); };
    const name = byId('autoreply-name').value.trim();
    if (!name) return fail('Enter a name for this rule.', byId('autoreply-name'));
    const keywordBox = byId('autoreply-keywords');
    const keywords = parseKeywords(keywordBox.value);
    if (!keywords.length) return fail('Enter at least one keyword.', keywordBox);
    if (keywords.length > 20) return fail('Use at most 20 keywords; you entered ' + keywords.length + '.', keywordBox);
    const tooLong = keywords.find((word) => word.length > 100);
    if (tooLong) return fail('Each keyword can be at most 100 characters. “' + singleLine(tooLong, 30) + '” is too long.', keywordBox);
    const collected = collectAutoReply();
    if (collected.error) return fail(collected.error, collected.focus);
    const cooldownRaw = byId('autoreply-cooldown').value.trim();
    const cooldown = Number(cooldownRaw);
    if (!cooldownRaw || !Number.isInteger(cooldown) || cooldown < 1 || cooldown > 10080) return fail('The cooldown must be a whole number of minutes from 1 to 10080.', byId('autoreply-cooldown'));
    const body = { name, enabled: byId('autoreply-enabled').checked, matchType: byId('autoreply-match').value, keywords, reply: collected.reply, cooldownMinutes: cooldown };
    const target = arDialog.rule;
    arDialog.saving = true;
    byId('autoreply-fields').disabled = true;
    message('autoreply-dialog-status', 'Saving rule…');
    cancelAutoReplyLoad();
    try {
      const data = target
        ? await api(AUTO_BASE + '/' + encodeURIComponent(target.id), { method: 'PATCH', body: JSON.stringify(body) })
        : await api(AUTO_BASE, { method: 'POST', body: JSON.stringify(body) });
      const saved = readAutoReply(data && data.rule);
      arDialog.savedId = saved.id;
      if (autoReplies && target) {
        autoReplies = autoReplies.map((item) => (item.id === saved.id ? saved : item));
        renderAutoReplies();
      } else {
        if (autoReplies) { autoReplies = autoReplies.concat(saved); renderAutoReplies(); }
        loadAutoReplies();
      }
      autoReplyDialog.close();
      message('autoreply-status', (target ? 'Saved ' : 'Added ') + saved.name + '.');
    } catch (failure) {
      message('autoreply-dialog-status', '');
      message('autoreply-dialog-error', errorMessage(failure));
    } finally {
      arDialog.saving = false;
      byId('autoreply-fields').disabled = false;
      if (autoReplyDialog.open) byId('confirm-autoreply').focus();
    }
  });

  // -- Quick messages --
  function renderQuickMessage(item) {
    const card = element('article', undefined, 'management-card');
    card.dataset.quickId = item.id;
    const text = element('div');
    text.append(element('h4', item.title, 'cfg-rule-name'), element('p', singleLine(item.text, 300), 'cfg-quick-text'));
    const actions = element('div', undefined, 'actions');
    const edit = button('Edit', () => openQuickDialog(item, edit));
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-label', 'Edit ' + item.title);
    const remove = button('Delete', () => deleteQuick(item, remove), 'secondary delete-button');
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', 'Delete ' + item.title);
    actions.append(edit, remove);
    const top = element('div', undefined, 'management-top');
    top.append(text, actions);
    card.append(top);
    return card;
  }
  function renderQuickConfig() {
    const list = byId('quick-list');
    const items = quickState.items;
    const loading = Boolean(quickState.promise) && !items;
    const active = document.activeElement;
    const row = active && list.contains(active) ? active.closest('[data-quick-id]') : null;
    const keep = row ? { id: row.dataset.quickId, action: active.dataset.action || 'edit' } : null;
    if (loading) message('quick-status', 'Loading quick messages…');
    else if (quickLoadingShown) message('quick-status', '');
    quickLoadingShown = loading;
    message('quick-error', quickState.error ? 'Could not load quick messages. ' + quickState.error : '');
    byId('quick-retry').hidden = !quickState.error;
    list.setAttribute('aria-busy', String(loading));
    if (!items) list.replaceChildren();
    else if (!items.length) list.replaceChildren(emptyState('No quick messages yet', 'Add ready-made texts that employees can insert into a chat.'));
    else list.replaceChildren(...items.map(renderQuickMessage));
    if (keep) focusRow('quick-list', 'data-quick-id', keep.id, [keep.action, 'edit'], 'quick-add');
  }
  quickSubscribers.add(renderQuickConfig);
  renderQuickConfig();
  byId('quick-retry').addEventListener('click', () => loadQuickMessages(true));
  byId('quick-add').addEventListener('click', (event) => openQuickDialog(null, event.currentTarget));
  function deleteQuick(item, opener) {
    openConfigDelete({
      title: 'Delete this quick message?',
      description: 'Employees will no longer be able to insert it into chats. Messages already sent are not affected. This cannot be undone.',
      name: item.title + ' · ' + singleLine(item.text, 120),
      confirmLabel: 'Delete quick message',
      cancelLabel: 'Keep quick message',
      opener,
      run: async () => {
        await api(QUICK_BASE + '/' + encodeURIComponent(item.id), { method: 'DELETE', body: '{}' });
        if (quickState.items) setQuickItems(quickState.items.filter((other) => other.id !== item.id));
        else loadQuickMessages(true);
        message('quick-status', 'Deleted ' + item.title + '.');
      },
      after: () => byId('quick-heading').focus()
    });
  }

  const quickDialog = byId('quick-dialog');
  const quickEdit = { item: null, opener: null, saving: false, savedId: '' };
  function openQuickDialog(item, opener) {
    quickEdit.item = item;
    quickEdit.opener = opener || null;
    quickEdit.saving = false;
    quickEdit.savedId = '';
    byId('quick-form').reset();
    byId('quick-dialog-title').textContent = item ? 'Edit quick message' : 'Add quick message';
    byId('confirm-quick').textContent = item ? 'Save changes' : 'Add quick message';
    if (item) {
      byId('quick-title').value = item.title;
      byId('quick-text').value = item.text;
    }
    message('quick-dialog-status', '');
    message('quick-dialog-error', '');
    byId('quick-fields').disabled = false;
    quickDialog.showModal();
    byId('quick-title').focus();
  }
  byId('cancel-quick').addEventListener('click', () => { if (!quickEdit.saving) quickDialog.close(); });
  quickDialog.addEventListener('cancel', (event) => { if (quickEdit.saving) event.preventDefault(); });
  quickDialog.addEventListener('close', () => {
    const { opener, savedId } = quickEdit;
    quickEdit.opener = null;
    quickEdit.item = null;
    if (savedId) focusRow('quick-list', 'data-quick-id', savedId, ['edit'], 'quick-add');
    else (opener && opener.isConnected ? opener : byId('quick-add')).focus();
  });
  byId('quick-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (quickEdit.saving) return;
    message('quick-dialog-error', '');
    message('quick-dialog-status', '');
    const title = byId('quick-title').value.trim();
    const text = byId('quick-text').value.trim();
    if (!title || title.length > 80) { message('quick-dialog-error', 'Enter a title between 1 and 80 characters.'); byId('quick-title').focus(); return; }
    if (!text || text.length > 4096) { message('quick-dialog-error', 'Enter a message between 1 and 4096 characters.'); byId('quick-text').focus(); return; }
    const target = quickEdit.item;
    quickEdit.saving = true;
    byId('quick-fields').disabled = true;
    message('quick-dialog-status', 'Saving quick message…');
    try {
      const data = target
        ? await api(QUICK_BASE + '/' + encodeURIComponent(target.id), { method: 'PATCH', body: JSON.stringify({ title, text }) })
        : await api(QUICK_BASE, { method: 'POST', body: JSON.stringify({ title, text }) });
      const saved = readQuickMessage(data && data.message);
      if (!saved) throw new Error('The server returned an unreadable quick message. Please refresh.');
      quickEdit.savedId = saved.id;
      if (quickState.items) setQuickItems(quickState.items.filter((other) => other.id !== saved.id).concat(saved));
      else loadQuickMessages(true);
      quickDialog.close();
      message('quick-status', (target ? 'Saved ' : 'Added ') + saved.title + '.');
    } catch (failure) {
      message('quick-dialog-status', '');
      message('quick-dialog-error', errorMessage(failure));
    } finally {
      quickEdit.saving = false;
      byId('quick-fields').disabled = false;
      if (quickDialog.open) byId('confirm-quick').focus();
    }
  });

  // ---- Config: features, integrations and import (values come from /v1/admin/settings; secrets are write-only) ----
  const features = { customers: true, whatsapp: true };
  let featuresLoaded = false;
  const settingsState = { data: null, generatedToken: '', importedNote: '' };
  const SAVED_TEXT = { database: 'Saved (database)', deployment: 'Saved (deployment)' };
  const PUSH_PACKAGE = 'com.microorganics.calltracker';
  function whatsappAvailable() { return features.customers && features.whatsapp; }
  function tabAvailable(name) {
    if (name === 'customers') return features.customers;
    if (name === 'whatsapp') return whatsappAvailable();
    return true;
  }
  function selectConfigSection(name, focus) {
    for (const item of configNavItems) {
      const active = item.dataset.section === name;
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      byId('config-section-' + item.dataset.section).hidden = !active;
    }
    if (focus) byId('config-' + name + '-heading').focus();
  }
  function applyFeatures() {
    for (const name of ['customers', 'whatsapp']) byId(name + '-tab').hidden = !tabAvailable(name);
    document.body.dataset.customers = features.customers ? 'on' : 'off';
    byId('config-nav-whatsapp').hidden = !whatsappAvailable();
    if (!whatsappAvailable() && !byId('config-section-whatsapp').hidden) selectConfigSection('features', false);
    if (activeTab && !tabAvailable(activeTab)) { location.hash = 'call-history'; showTab(); }
  }
  async function loadFeatures() {
    try {
      const data = await api('/features');
      features.customers = data.customers === true;
      features.whatsapp = data.whatsapp === true;
    } catch { return; }
    featuresLoaded = true;
    applyFeatures();
    if (whatsappAvailable()) { loadSendState(); refreshUnread(); if (!liveTimer) pollLive(); }
  }

  function note(node, text) {
    if (!node) return;
    node.textContent = text;
    node.hidden = !text;
  }
  function extLink(text, href) {
    const link = element('a', text);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function stepsBlock(title, items) {
    const box = element('section', undefined, 'panel cfg-block cfg-steps');
    box.setAttribute('aria-label', title);
    box.append(element('h3', title));
    const list = element('ol');
    for (const item of items) {
      const li = element('li');
      li.append(...(Array.isArray(item) ? item : [item]));
      list.append(li);
    }
    box.append(list);
    return box;
  }
  function formPanel(title, intro) {
    const box = element('section', undefined, 'panel cfg-block');
    box.append(element('h3', title));
    if (intro) box.append(element('p', intro, 'muted'));
    return box;
  }
  function settingsPage(name, bodyId) {
    const body = byId(bodyId);
    body.replaceChildren();
    const ui = { name, body, busy: false, buttons: [] };
    ui.status = element('p', undefined, 'cfg-status');
    ui.status.id = 'settings-' + name + '-status';
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.error = element('p', undefined, 'error-text');
    ui.error.id = 'settings-' + name + '-error';
    ui.error.setAttribute('role', 'alert');
    ui.error.hidden = true;
    return ui;
  }
  function settingsButton(ui, text, onClick, secondary) {
    const b = element('button', text, secondary ? 'secondary' : undefined);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    ui.buttons.push(b);
    return b;
  }
  async function runSetting(ui, button, pending, work) {
    if (ui.busy) return;
    ui.busy = true;
    const label = button.textContent;
    for (const b of ui.buttons) b.disabled = true;
    button.textContent = pending;
    note(ui.error, '');
    note(ui.status, '');
    try { await work(); }
    catch (error) { note(byId(ui.error.id) || ui.error, errorMessage(error)); }
    finally {
      ui.busy = false;
      for (const b of ui.buttons) b.disabled = false;
      button.textContent = label;
    }
  }
  function textField(ui, key, labelText, value, options = {}) {
    const label = element('label', labelText);
    const input = element(options.multiline ? 'textarea' : 'input');
    input.id = 'set-' + ui.name + '-' + key;
    input.name = key;
    if (!options.multiline) input.type = options.type || 'text';
    input.value = value || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.inputMode) input.inputMode = options.inputMode;
    if (options.pattern) { input.pattern = options.pattern; input.title = options.title || ''; }
    if (options.step) input.step = options.step;
    if (options.rows) input.rows = options.rows;
    label.append(input);
    if (options.hint) {
      const hint = element('span', options.hint, 'hint');
      hint.id = input.id + '-hint';
      input.setAttribute('aria-describedby', hint.id);
      label.append(hint);
    }
    return { node: label, input, value: () => input.value.trim() };
  }
  function selectField(ui, key, labelText, value, choices) {
    const label = element('label', labelText);
    const select = element('select');
    select.id = 'set-' + ui.name + '-' + key;
    for (const [v, text] of choices) {
      const option = element('option', text);
      option.value = v;
      select.append(option);
    }
    select.value = value;
    label.append(select);
    return { node: label, input: select, value: () => select.value };
  }
  function switchField(ui, key, labelText, checked) {
    const label = element('label', undefined, 'cfg-switch');
    const input = element('input');
    input.type = 'checkbox';
    input.id = 'set-' + ui.name + '-' + key;
    input.checked = checked === true;
    label.append(input, element('span', labelText));
    return { node: label, input, value: () => input.checked };
  }
  // Write-only secret: never shows or prefills a stored value. value() is undefined (unchanged), a string (replace) or null (clear).
  function secretField(ui, key, labelText, info, options = {}) {
    const id = 'set-' + ui.name + '-' + key;
    const wrap = element('div', undefined, 'cfg-secret');
    const labelNode = element('label', labelText);
    labelNode.htmlFor = id;
    const stateNode = element('span', undefined, 'cfg-secret-state');
    stateNode.setAttribute('role', 'status');
    stateNode.setAttribute('aria-live', 'polite');
    const input = element(options.multiline ? 'textarea' : 'input');
    input.id = id;
    input.name = key;
    if (!options.multiline) input.type = 'password';
    else input.rows = 5;
    input.autocomplete = options.multiline ? 'off' : 'new-password';
    input.spellcheck = false;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.hint) {
      const hint = element('span', options.hint, 'hint');
      hint.id = id + '-hint';
      input.setAttribute('aria-describedby', hint.id);
      wrap.hintNode = hint;
    }
    const row = element('div', undefined, 'actions');
    const field = { mode: info.set ? 'keep' : 'replace' };
    function make(text, mode) {
      const b = element('button', text, 'secondary');
      b.type = 'button';
      b.addEventListener('click', () => {
        field.mode = mode;
        if (mode !== 'replace') input.value = '';
        render();
        if (mode === 'replace') input.focus();
      });
      ui.buttons.push(b);
      return b;
    }
    function render() {
      row.replaceChildren();
      const isSet = info.set === true;
      input.hidden = field.mode !== 'replace';
      if (field.mode === 'keep') {
        stateNode.textContent = (SAVED_TEXT[info.source] || 'Saved') + (typeof info.hint === 'string' && info.hint ? ': ' + info.hint : '');
        const replace = make('Replace', 'replace');
        replace.setAttribute('aria-label', 'Replace ' + labelText);
        row.append(replace);
        if (info.source !== 'deployment') {
          const clear = make('Clear', 'clear');
          clear.setAttribute('aria-label', 'Clear ' + labelText);
          row.append(clear);
        }
      } else if (field.mode === 'clear') {
        stateNode.textContent = 'Will be cleared when you save';
        row.append(make('Undo', 'keep'));
      } else {
        stateNode.textContent = isSet ? 'Enter the new value' : 'Not set';
        if (isSet) row.append(make('Cancel', 'keep'));
      }
      for (const extra of options.extra || []) row.append(extra);
    }
    wrap.append(labelNode, stateNode, input);
    if (wrap.hintNode) wrap.append(wrap.hintNode);
    if (options.file) {
      const pick = element('input');
      pick.type = 'file';
      pick.accept = options.file.accept;
      pick.setAttribute('aria-label', options.file.label);
      pick.addEventListener('change', async () => {
        const file = pick.files && pick.files[0];
        pick.value = '';
        if (!file) return;
        try {
          if (file.size > 100000) throw new Error('That file is too large.');
          input.value = await file.text();
          field.mode = 'replace';
          render();
          input.dispatchEvent(new Event('input'));
        } catch (error) { note(ui.error, errorMessage(error)); }
      });
      const fileRow = element('label', options.file.label, 'cfg-file');
      fileRow.append(pick);
      wrap.append(fileRow);
    }
    wrap.append(row);
    render();
    return {
      node: wrap,
      input,
      value: () => {
        if (field.mode === 'clear') return null;
        if (field.mode === 'replace' && input.value.trim()) return input.value.trim();
        return undefined;
      }
    };
  }
  function copyField(ui, key, labelText, value, hint) {
    const label = element('label', labelText);
    const input = element('input');
    input.id = 'set-' + ui.name + '-' + key;
    input.readOnly = true;
    input.value = value;
    label.append(input);
    const state = element('span', undefined, 'cfg-copy-state');
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const button = element('button', 'Copy', 'secondary');
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy ' + labelText);
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); state.textContent = 'Copied.'; }
      catch { input.focus(); input.select(); state.textContent = 'Press Ctrl+C or Cmd+C to copy the selected text.'; }
    });
    const row = element('div', undefined, 'cfg-copy');
    row.append(label, button, state);
    if (hint) row.append(element('span', hint, 'hint'));
    return row;
  }
  // A value fixed by the deployment: shown as text to paste elsewhere, never as a field to edit.
  function fixedValue(ui, key, labelText, value, note) {
    const wrap = element('div', undefined, 'cfg-fixed');
    wrap.append(element('p', labelText, 'cfg-fixed-label'));
    const code = element('code', value);
    code.id = 'set-' + ui.name + '-' + key;
    const state = element('span', undefined, 'cfg-copy-state');
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    const button = element('button', 'Copy', 'secondary');
    button.type = 'button';
    button.setAttribute('aria-label', 'Copy ' + labelText);
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(value); state.textContent = 'Copied.'; }
      catch { const range = document.createRange(); range.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); state.textContent = 'Press Ctrl+C or Cmd+C to copy the selected text.'; }
    });
    const row = element('div', undefined, 'cfg-copy');
    row.append(code, button, state);
    wrap.append(row);
    if (note) wrap.append(element('p', note, 'hint'));
    return wrap;
  }
  function fieldGrid(...nodes) {
    const grid = element('div', undefined, 'filter-grid cfg-grid');
    grid.append(...nodes.map((n) => n.node || n));
    return grid;
  }
  function actionRow(ui, ...buttons) {
    const row = element('div', undefined, 'actions cfg-save');
    row.append(...buttons);
    return row;
  }
  function settingsForm(ui, onSubmit) {
    const form = element('form');
    form.id = 'settings-' + ui.name + '-form';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type=submit]');
      runSetting(ui, submit, 'Saving…', async () => { await onSubmit(); });
    });
    return form;
  }
  function saveButton(ui) {
    const b = element('button', 'Save');
    b.type = 'submit';
    ui.buttons.push(b);
    return b;
  }
  function blankToNull(value) { return value === '' ? null : value; }

  async function putSettings(name, payload, reloadAll) {
    const res = await api('/settings/' + name, { method: 'PUT', body: JSON.stringify(payload) });
    await loadSettings(reloadAll ? undefined : name);
    return res;
  }
  async function loadSettings(only) {
    let data;
    try { data = await api('/settings'); }
    catch (error) {
      message('config-settings-error', 'Could not load settings. ' + errorMessage(error));
      return;
    }
    message('config-settings-error', '');
    settingsState.data = data;
    renderSettings(only);
  }
  function settingsSection(name) {
    return settingsState.data && settingsState.data.settings ? settingsState.data.settings[name] || {} : {};
  }
  function renderSettings(only) {
    renderImportBanner();
    const pages = { features: renderFeaturesPage, whatsapp: renderWhatsappPage, email: renderEmailPage, push: renderPushPage };
    for (const [name, render] of Object.entries(pages)) if (!only || only === name) render();
  }

  function renderImportBanner() {
    const deployment = settingsState.data && settingsState.data.deployment;
    const list = deployment && Array.isArray(deployment.importable) ? deployment.importable : [];
    const banner = byId('config-import-banner');
    banner.hidden = !list.length && !settingsState.importedNote;
    byId('config-import-fields').textContent = list.length ? 'Found: ' + list.join(', ') : '';
    byId('config-import-fields').hidden = !list.length;
    byId('config-import-button').hidden = !list.length;
    note(byId('config-import-status'), settingsState.importedNote);
  }
  byId('config-import-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    message('config-import-error', '');
    try {
      const result = await api('/settings/import-deployment', { method: 'POST' });
      const count = Array.isArray(result.imported) ? result.imported.length : 0;
      settingsState.importedNote = 'Imported ' + count + (count === 1 ? ' setting' : ' settings') + '. The old Worker secrets can now be deleted; they are no longer needed.';
      await loadSettings();
      loadFeatures();
    } catch (error) {
      message('config-import-error', errorMessage(error));
    } finally { button.disabled = false; }
  });

  function renderFeaturesPage() {
    const ui = settingsPage('features', 'settings-features-body');
    const current = settingsSection('features');
    ui.body.append(stepsBlock('How to turn features on', [
      'Turn on Customers to keep a customer directory and link calls to customers.',
      'Turn on WhatsApp Business to chat with customers. It needs Customers, so it is switched off whenever Customers is off.',
      'Click Save. Then open WhatsApp Business in the left menu to connect your number.'
    ]));
    const customers = switchField(ui, 'customers', 'Customers', current.customers);
    const whatsapp = switchField(ui, 'whatsapp', 'WhatsApp Business', current.whatsapp);
    function sync() {
      if (!customers.input.checked) whatsapp.input.checked = false;
      whatsapp.input.disabled = !customers.input.checked;
    }
    customers.input.addEventListener('change', sync);
    sync();
    const form = settingsForm(ui, async () => {
      await putSettings('features', { customers: customers.value(), whatsapp: customers.value() && whatsapp.value() }, true);
      await loadFeatures();
      note(byId(ui.status.id), 'Saved.');
    });
    const panel = formPanel('Features');
    panel.append(customers.node, whatsapp.node, element('p', 'WhatsApp Business requires Customers.', 'hint'));
    form.append(panel, actionRow(ui, saveButton(ui)), ui.status, ui.error);
    ui.body.append(form);
  }

  function renderWhatsappPage() {
    const ui = settingsPage('whatsapp', 'settings-whatsapp-body');
    const current = settingsSection('whatsapp');
    const callback = location.origin + '/v1/webhooks/whatsapp';
    if (!whatsappAvailable()) ui.body.append(element('p', 'WhatsApp Business is turned off. Turn it on under Features to use these settings.', 'notice'));
    ui.body.append(stepsBlock('Set up WhatsApp Business', [
      ['Open ', extLink('developers.facebook.com', 'https://developers.facebook.com/apps'), ', create an app of type Business and add the WhatsApp product.'],
      'In WhatsApp > API Setup, add your phone number to a WhatsApp Business Account and verify it with the code Meta sends.',
      'In Meta Business Settings > Users > System users, add a system user, assign it your app and WhatsApp account, then click Generate token. Set expiry to Never and tick whatsapp_business_management and whatsapp_business_messaging. Paste the token below.',
      'Copy the Phone number ID and WhatsApp Business Account ID from WhatsApp > API Setup, and the App ID and App secret from App settings > Basic. Paste them below.',
      'Click Generate verify token below. In WhatsApp > Configuration, click Edit under Webhook, paste the callback URL and the verify token, then click Verify and save.',
      'Under Webhook fields, subscribe to messages.',
      'Click Save, then Test connection. Before real customers can message you, add a privacy policy URL, app icon and category in App settings > Basic and switch the app to Live.'
    ]));
    const phone = textField(ui, 'phoneNumberId', 'Phone number ID', current.phoneNumberId, { inputMode: 'numeric', pattern: '[0-9]+', title: 'Digits only' });
    const waba = textField(ui, 'wabaId', 'WhatsApp Business Account ID', current.wabaId, { inputMode: 'numeric', pattern: '[0-9]+', title: 'Digits only' });
    const app = textField(ui, 'appId', 'App ID', current.appId, { inputMode: 'numeric', pattern: '[0-9]+', title: 'Digits only' });
    const version = textField(ui, 'graphVersion', 'Graph API version', current.graphVersion, { placeholder: 'v23.0', pattern: 'v[0-9]+\\.[0-9]+', title: 'For example v23.0' });
    const token = secretField(ui, 'token', 'Access token', current.token || {}, { hint: 'System user token. Stored encrypted and never shown again.' });
    const appSecret = secretField(ui, 'appSecret', 'App secret', current.appSecret || {}, { hint: 'Used to verify that webhooks come from Meta.' });
    const generate = settingsButton(ui, 'Generate verify token', null, true);
    generate.id = 'settings-whatsapp-generate';
    const verify = secretField(ui, 'verifyToken', 'Verify token', current.verifyToken || {}, { hint: 'Any secret string. Generate one, or paste your own.', extra: [generate] });
    function payload() {
      const body = {
        phoneNumberId: blankToNull(phone.value()),
        wabaId: blankToNull(waba.value()),
        appId: blankToNull(app.value()),
        graphVersion: blankToNull(version.value())
      };
      for (const [key, field] of [['token', token], ['appSecret', appSecret], ['verifyToken', verify]]) {
        const value = field.value();
        if (value !== undefined) body[key] = value;
      }
      return body;
    }
    const form = settingsForm(ui, async () => {
      await putSettings('whatsapp', payload());
      note(byId(ui.status.id), 'Saved.');
    });
    generate.addEventListener('click', () => runSetting(ui, generate, 'Generating…', async () => {
      const body = payload();
      body.verifyToken = { generate: true };
      const res = await putSettings('whatsapp', body);
      const generated = res.generatedVerifyToken || (res.settings && res.settings.whatsapp && res.settings.whatsapp.generatedVerifyToken) || '';
      settingsState.generatedToken = typeof generated === 'string' ? generated : '';
      renderWhatsappPage();
      note(byId('settings-whatsapp-status'), 'Saved with a new verify token. Copy it now; it is shown only once.');
    }));
    const test = settingsButton(ui, 'Test connection', () => runSetting(ui, test, 'Testing…', async () => {
      const result = await api('/settings/whatsapp/test', { method: 'POST' });
      if (result.ok) {
        const parts = [result.verifiedName, result.displayPhoneNumber].filter((v) => typeof v === 'string' && v);
        note(byId(ui.status.id), 'Connected' + (parts.length ? ': ' + parts.join(' · ') : '.'));
      } else {
        note(byId(ui.error.id), 'Connection failed. ' + (typeof result.error === 'string' && result.error ? result.error : 'Check the token and Phone number ID.'));
      }
    }), true);
    test.id = 'settings-whatsapp-test';
    const credentials = formPanel('Meta app and phone number');
    credentials.append(fieldGrid(phone, waba, app, version), token.node, appSecret.node);
    const webhook = formPanel('Webhook', 'Meta calls this address when a customer sends you a message.');
    webhook.append(fixedValue(ui, 'callback', 'Callback URL', callback, 'This address is set by your deployment and cannot be changed here. Paste it into Meta as the webhook callback URL.'));
    webhook.append(verify.node);
    if (settingsState.generatedToken) {
      const box = element('div', undefined, 'notice cfg-generated');
      box.append(element('p', 'New verify token. Copy it into Meta now; it will not be shown again.'));
      box.append(copyField(ui, 'generated', 'Generated verify token', settingsState.generatedToken));
      webhook.append(box);
    }
    form.append(credentials, webhook, actionRow(ui, saveButton(ui), test), ui.status, ui.error);
    ui.body.append(form);
  }

  function parseRecipients(text) { return text.split(/[\s,;]+/).filter(Boolean); }
  function renderEmailPage() {
    const ui = settingsPage('email', 'settings-email-body');
    const current = settingsSection('email');
    ui.body.append(stepsBlock('Set up the daily email report', [
      ['Only Mailgun is supported. Create an account at ', extLink('mailgun.com', 'https://www.mailgun.com/'), ' and go to Sending > Domains > Add new domain. A subdomain such as mg.example.com works well.'],
      'Add the DNS records Mailgun shows to your domain and wait until the domain is Verified.',
      'Go to Settings > API security > Add new key and choose a Sending key. Copy it straight away because Mailgun shows it once. Paste it below.',
      'Enter the domain, a From address on that domain, and the region (US or EU) where you created the domain.',
      'Add the recipients and the send time, switch on Enabled, click Save, then Send test email.'
    ]));
    const enabled = switchField(ui, 'enabled', 'Send the daily report', current.enabled);
    const domain = textField(ui, 'domain', 'Mailgun domain', current.domain, { placeholder: 'mg.example.com' });
    const from = textField(ui, 'fromEmail', 'From email', current.fromEmail, { type: 'email', placeholder: 'reports@mg.example.com' });
    const region = selectField(ui, 'region', 'Mailgun region', current.region === 'eu' ? 'eu' : 'us', [['us', 'US'], ['eu', 'EU']]);
    const apiKey = secretField(ui, 'apiKey', 'Mailgun sending API key', current.apiKey || {}, { hint: 'Stored encrypted and never shown again.' });
    const recipients = textField(ui, 'recipients', 'Recipients', Array.isArray(current.recipients) ? current.recipients.join('\n') : '', { multiline: true, rows: 3, hint: 'Separate addresses with commas or new lines.' });
    const time = textField(ui, 'sendTime', 'Send time (India time, IST)', current.sendTime, { type: 'time', step: '1800', hint: 'The report covers calls from midnight to the send time, in 30-minute steps.' });
    const form = settingsForm(ui, async () => {
      const list = parseRecipients(recipients.input.value);
      const body = {
        enabled: enabled.value(),
        domain: blankToNull(domain.value()),
        fromEmail: blankToNull(from.value()),
        region: region.value(),
        recipients: list,
        sendTime: blankToNull(time.value())
      };
      const key = apiKey.value();
      if (key !== undefined) body.apiKey = key;
      await putSettings('email', body);
      note(byId(ui.status.id), 'Saved.');
    });
    const test = settingsButton(ui, 'Send test email', () => runSetting(ui, test, 'Sending…', async () => {
      const result = await api('/settings/email/test', { method: 'POST' });
      if (result.ok) note(byId(ui.status.id), 'Test email sent.');
      else note(byId(ui.error.id), 'Test email failed. ' + (typeof result.error === 'string' && result.error ? result.error : 'Check the settings and try again.'));
    }), true);
    test.id = 'settings-email-test';
    const panel = formPanel('Mailgun');
    panel.append(enabled.node, fieldGrid(domain, from, region), apiKey.node);
    const schedule = formPanel('Report');
    schedule.append(recipients.node, fieldGrid(time));
    const last = current.lastSent;
    const lastText = last && typeof last === 'object' ? 'Last report: ' + String(last.date) + ' · ' + String(last.status) : 'No report has been sent yet.';
    schedule.append(element('p', lastText, 'hint'));
    form.append(panel, schedule, actionRow(ui, saveButton(ui), test), ui.status, ui.error);
    ui.body.append(form);
  }

  function parseGoogleServices(text) {
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
    const info = json && json.project_info;
    const clients = Array.isArray(json && json.client) ? json.client : [];
    const match = clients.find((c) => c && c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name === PUSH_PACKAGE);
    if (!match) throw new Error('This file has no Android app for ' + PUSH_PACKAGE + '. Add that app in Firebase and download google-services.json again.');
    const key = Array.isArray(match.api_key) && match.api_key[0] ? match.api_key[0].current_key : undefined;
    const values = { apiKey: key, appId: match.client_info.mobilesdk_app_id, projectId: info && info.project_id, senderId: info && info.project_number };
    for (const value of Object.values(values)) if (typeof value !== 'string' || !value) throw new Error('google-services.json is missing some values. Download it again from Firebase.');
    return values;
  }
  function serviceAccountProject(text) {
    try {
      const json = JSON.parse(text);
      return json && json.type === 'service_account' && typeof json.project_id === 'string' ? json.project_id : null;
    } catch { return null; }
  }
  function renderPushPage() {
    const ui = settingsPage('push', 'settings-push-body');
    const current = settingsSection('push');
    const client = current.clientConfig || {};
    const account = current.serviceAccount || {};
    ui.body.append(stepsBlock('Set up push notifications', [
      ['In the ', extLink('Firebase console', 'https://console.firebase.google.com/'), ', click Add project and finish the wizard.'],
      ['In Project overview click Add app > Android and enter the package name ', element('code', PUSH_PACKAGE), '. Register the app and skip the remaining steps.'],
      'Download google-services.json. Choose that file below (it is read in your browser and never uploaded) or paste the four values yourself.',
      'In Project settings > Service accounts click Generate new private key. Choose the downloaded JSON file below or paste its text.',
      'Click Save. The project ID found in the key must match the Project ID above.'
    ]));
    const apiKey = textField(ui, 'apiKey', 'API key', client.apiKey);
    const appId = textField(ui, 'appId', 'App ID', client.appId, { placeholder: '1:1234567890:android:abc123' });
    const projectId = textField(ui, 'projectId', 'Project ID', client.projectId);
    const senderId = textField(ui, 'senderId', 'Sender ID (project number)', client.senderId, { inputMode: 'numeric' });
    const pickLabel = element('label', 'Fill from google-services.json', 'cfg-file');
    const pick = element('input');
    pick.type = 'file';
    pick.id = 'settings-push-google-services';
    pick.accept = '.json,application/json';
    pickLabel.append(pick);
    const found = element('p', undefined, 'cfg-status');
    found.id = 'settings-push-project';
    found.setAttribute('role', 'status');
    found.setAttribute('aria-live', 'polite');
    const serviceAccount = secretField(ui, 'serviceAccount', 'Service account key (JSON)', account, {
      multiline: true,
      hint: 'Stored encrypted and never shown again.',
      file: { accept: '.json,application/json', label: 'Choose service account JSON file' }
    });
    function updateFound() {
      const text = serviceAccount.input.value;
      const project = text.trim() ? serviceAccountProject(text) : null;
      let line = '';
      if (text.trim()) line = project ? 'Project ID found in the key: ' + project : 'This does not look like a service account key.';
      else if (account.set && typeof account.projectId === 'string') line = 'Project ID of the saved key: ' + account.projectId;
      const known = project || (text.trim() ? null : account.projectId);
      if (known && projectId.value() && known !== projectId.value()) line += ' It does not match the Project ID above (' + projectId.value() + ').';
      found.textContent = line;
      found.hidden = !line;
    }
    serviceAccount.input.addEventListener('input', updateFound);
    projectId.input.addEventListener('input', updateFound);
    pick.addEventListener('change', async () => {
      const file = pick.files && pick.files[0];
      pick.value = '';
      if (!file) return;
      note(ui.error, '');
      try {
        if (file.size > 100000) throw new Error('That file is too large.');
        const values = parseGoogleServices(await file.text());
        apiKey.input.value = values.apiKey;
        appId.input.value = values.appId;
        projectId.input.value = values.projectId;
        senderId.input.value = values.senderId;
        updateFound();
        note(byId(ui.status.id), 'Filled from google-services.json. Click Save to keep these values.');
      } catch (error) { note(byId(ui.error.id), errorMessage(error)); }
    });
    const form = settingsForm(ui, async () => {
      const values = { apiKey: apiKey.value(), appId: appId.value(), projectId: projectId.value(), senderId: senderId.value() };
      const body = { clientConfig: Object.values(values).every((v) => !v) ? null : values };
      const secret = serviceAccount.value();
      if (secret !== undefined) body.serviceAccount = secret;
      await putSettings('push', body);
      note(byId(ui.status.id), 'Saved.');
    });
    const clientPanel = formPanel('Android app', 'These identifiers are not secret. They are sent to the app so it can connect to your Firebase project.');
    clientPanel.append(pickLabel, fieldGrid(apiKey, appId, projectId, senderId));
    const accountPanel = formPanel('Service account');
    accountPanel.append(serviceAccount.node, found);
    form.append(clientPanel, accountPanel, actionRow(ui, saveButton(ui)), ui.status, ui.error);
    ui.body.append(form);
    updateFound();
  }

  // ---- Config: Android app (the Community Android build is published on GitHub; this page shares the link) ----
  const COMMUNITY_RELEASES_URL = ${JSON.stringify(communityReleasesUrl)};
  function renderAppPage() {
    const ui = settingsPage('app', 'settings-app-body');
    const pageUrl = location.origin + '/download';
    ui.body.append(stepsBlock('Share the Android app with your team', [
      'Send employees the link below, or show them the QR code.',
      ['They open it on their Android phone and install the Community Android build, which is downloaded from the ', extLink('GitHub releases', COMMUNITY_RELEASES_URL), '. It is a generic release build with no server address built in.'],
      'They then scan the enrollment QR code (or enter the code) that you create under Employees.'
    ]));
    const link = formPanel('Link and QR code', 'Anyone with the link or the QR code can open the download page. It needs no sign-in and shows no company data.');
    link.append(fixedValue(ui, 'link', 'Download page link', pageUrl));
    const qr = element('img', undefined, 'cfg-qr');
    qr.src = '/v1/admin/app/qr.svg';
    qr.alt = 'QR code for the download page link';
    qr.width = 220;
    qr.height = 220;
    const save = element('a', 'Download QR as SVG', 'button secondary');
    save.href = '/v1/admin/app/qr.svg';
    save.download = 'linekeep-download-qr.svg';
    const row = element('div', undefined, 'actions cfg-app-actions');
    row.append(save, extLink('Open the GitHub releases page', COMMUNITY_RELEASES_URL));
    link.append(qr, row);
    ui.body.append(link);
  }

  function enterConfig() {
    settingsState.importedNote = '';
    loadSettings();
    loadFeatures();
    renderAppPage();
    if (whatsappAvailable()) {
      loadAutoReplies();
      loadActivity();
      loadQuickMessages(false);
    }
  }
  let employeesLoaded = false;
  let activeTab = null;
  const tabNames = ['call-history', 'analytics', 'customers', 'whatsapp', 'employees', 'config'];
  const tabTitles = { 'call-history': 'Call history', analytics: 'Call analytics', customers: 'Customers', whatsapp: 'WhatsApp chats', employees: 'Employees', config: 'Config' };
  const tabDescriptions = { 'call-history': 'Calls and recordings, together.', analytics: 'Call volume, talk time, connect rates and busy hours across your team.', customers: 'Customers, who handles them, and their chats and calls.', whatsapp: 'Stored WhatsApp conversations with customers.', employees: 'Manage people, enrolled devices and handovers.', config: 'Features, WhatsApp, daily email, push notifications, the Android app and automatic replies.' };
  function showTab() {
    const hashTab = location.hash.slice(1).split('?')[0];
    const selected = tabNames.includes(hashTab) && tabAvailable(hashTab) ? hashTab : 'call-history';
    if (selected !== activeTab) {
      closePlayer();
      if (activeTab === 'config') settingsState.generatedToken = '';
      if (activeTab === 'call-history') cancelCallHistory();
      if (activeTab === 'analytics') cancelAnalytics();
      if (invitationExpiresAt || invitationPending) clearInvitation('The displayed code was cleared when leaving this view. Invitation history remains available.');
      if (selected === 'call-history') loadCallHistory();
    }
    const entering = selected !== activeTab;
    activeTab = selected;
    for (const name of tabNames) {
      const tab = byId(name + '-tab');
      tab.setAttribute('aria-selected', String(name === selected));
      tab.tabIndex = name === selected ? 0 : -1;
      const panel = byId(name + '-panel');
      const wasFocused = panel.contains(document.activeElement);
      panel.hidden = name !== selected;
      if (panel.hidden && wasFocused) byId(selected + '-tab').focus();
    }
    const title = tabTitles[selected];
    document.title = title + ' · Linekeep';
    byId('page-title').textContent = title;
    byId('page-description').textContent = tabDescriptions[selected];
    if (selected === 'analytics') openAnalytics(entering);
    if (selected === 'employees' && !employeesLoaded) {
      employeesLoaded = true;
      employeeList.load();
      deviceList.load();
      invitationList.load();
    }
    if (selected === 'customers' && !customersLoaded) {
      customersLoaded = true;
      customersList.load(true);
    }
    if (selected === 'config' && entering) enterConfig();
    if (selected === 'whatsapp' && !chatsLoaded) {
      chatsLoaded = true;
      liveWhatsAppStale = false;
      chatList.load(true);
    }
    if (selected === 'whatsapp' && entering && chatsLoaded && liveWhatsAppStale) {
      liveWhatsAppStale = false;
      chatList.refresh();
      if (chatConversation.displayed()) chatConversation.poll();
    }
    if (selected === 'whatsapp' && entering) chatConversation.markRead();
  }
  for (const name of tabNames) {
    byId(name + '-tab').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', ' '].includes(event.key)) return;
      event.preventDefault();
      const available = tabNames.filter(tabAvailable);
      const index = available.indexOf(name);
      const target = event.key === 'Home' ? available[0] : event.key === 'End' ? available[available.length - 1] : event.key === ' ' ? name : available[(index + (event.key === 'ArrowRight' ? 1 : available.length - 1)) % available.length];
      location.hash = target;
      showTab();
      byId(target + '-tab').focus();
    });
  }
  window.addEventListener('hashchange', showTab);
  byId('call-history-timezone-note').textContent = 'Dates and times use ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '. Number searches match literal text. Employee choices include the full directory.';
  loadDirectory();
  showTab();
  loadFeatures();
})();`;
