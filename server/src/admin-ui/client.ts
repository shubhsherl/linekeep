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
    caller.append(element('h3', isCall ? call.callerName || 'Unknown caller' : 'Unlinked recording'));
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
      element('p', (employee.active ? 'Active' : 'Inactive') + ' · Created ' + dateText(employee.createdAt)));
    const actions = element('div', undefined, 'actions');
    const edit = button('Edit name', () => {
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
      const status = element('p');
      status.setAttribute('role', 'status');
      const error = element('p', '', 'error-text');
      error.setAttribute('role', 'alert');
      const controls = element('div', undefined, 'actions');
      const save = element('button', 'Save name');
      save.type = 'submit';
      const cancel = button('Cancel', () => { form.remove(); actions.hidden = false; edit.focus(); });
      controls.append(save, cancel);
      fields.append(label, element('p', 'Correcting a name updates this same employee on historical recordings. If a phone is changing hands, cancel and reassign the device to another employee instead.', 'hint'), controls);
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
        status.textContent = 'Saving name…';
        error.textContent = '';
        try {
          const data = await api('/employees/' + encodeURIComponent(employee.id), { method: 'PATCH', body: JSON.stringify({ name }) });
          rememberEmployee(data.employee);
          updateEmployees();
          const replacement = renderEmployee(data.employee);
          card.replaceWith(replacement);
          replacement.querySelector('button').focus();
          message('employee-status', 'Saved name for ' + data.employee.name + '.');
          deviceList.load();
          if (byId('invitation-employee').value === employee.id && invitationExpiresAt) clearInvitation('The name changed. The displayed code was cleared; it remains usable until redeemed, revoked or expired.');
        } catch (failure) { error.textContent = errorMessage(failure); status.textContent = ''; }
        finally { fields.disabled = false; }
      });
    });
    edit.setAttribute('aria-label', 'Edit name for ' + employee.name);
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
    const name = String(new FormData(form).get('name') || '').trim();
    message('employee-error', '');
    if (!name || name.length > 200) { message('employee-error', 'Enter a name between 1 and 200 characters.'); form.elements.namedItem('name').focus(); return; }
    fields.disabled = true;
    message('employee-status', 'Creating employee…');
    try {
      const data = await api('/employees', { method: 'POST', body: JSON.stringify({ name }) });
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
      byId('invitation-title').textContent = device ? 'Recovery code ready — shown once' : 'Invitation ready — shown once';
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
  const messageStatusNames = { queued: 'Queued', sent: '✓ Sent', delivered: '✓✓ Delivered', read: '✓✓ Read', failed: '✗ Failed' };
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

  // Cursor-paginated list that appends pages ("Load more"). With chronological: true the server's
  // newest-first pages are shown oldest-first and older pages are prepended above the current ones.
  function cursorList(options) {
    const list = byId(options.listId);
    const more = byId(options.moreId);
    let next = null;
    let busy = false;
    let version = 0;
    let controller;
    let seen = new Set();
    let count = 0;
    function controls() {
      more.hidden = !next;
      more.disabled = busy;
    }
    function cancel() {
      version++;
      if (controller) controller.abort();
      busy = false;
      next = null;
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
        const items = options.chronological ? data.items.slice().reverse() : data.items;
        const content = document.createDocumentFragment();
        for (const item of items) content.append(options.render(item));
        count += data.items.length;
        if (!count) {
          list.replaceChildren(options.empty(request.params.size > 0));
        } else if (options.chronological && !reset) {
          const scroller = options.scroller;
          const height = scroller.scrollHeight;
          const top = scroller.scrollTop;
          list.prepend(content);
          scroller.scrollTop = top + scroller.scrollHeight - height;
        } else {
          list.append(content);
          if (options.chronological) options.scroller.scrollTop = options.scroller.scrollHeight;
        }
        next = data.nextCursor;
        message(options.statusId, count ? count + ' ' + plural(count, options.noun[0], options.noun[1]) + ' shown' + (next ? '. More are available.' : '.') : '');
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
    more.addEventListener('click', () => load(false));
    return { load, cancel };
  }

  function renderMessage(item) {
    if (!item || typeof item.id !== 'string' || !['in', 'out'].includes(item.direction)) throw new Error('A WhatsApp message could not be read. Please refresh.');
    const node = element('article', undefined, 'message ' + item.direction);
    node.dataset.messageId = item.id;
    const meta = element('p', undefined, 'message-meta');
    meta.append(element('span', item.direction === 'out' ? 'Out' : 'In', 'badge'), element('span', dateText(item.sentAt)));
    if (item.sentBy && typeof item.sentBy.name === 'string') meta.append(element('span', 'Sent by ' + item.sentBy.name));
    node.append(meta);
    const typeLabel = messageTypeLabel(item.messageType);
    const tags = element('p', undefined, 'message-tags');
    if (typeLabel) tags.append(element('span', typeLabel, 'badge'));
    if (item.templateName) tags.append(element('span', 'Template: ' + item.templateName, 'badge'));
    if (item.mediaUrl) tags.append(element('span', 'Media attached · not shown in this view'));
    if (tags.childElementCount) node.append(tags);
    if (item.body) node.append(element('p', item.body, 'message-body'));
    else if (!tags.childElementCount) node.append(element('p', 'No text', 'message-body hint'));
    const status = Object.hasOwn(messageStatusNames, item.status) ? messageStatusNames[item.status] : 'Status unknown';
    const stamp = item.readAt ? ' · Read ' + dateText(item.readAt) : item.deliveredAt ? ' · Delivered ' + dateText(item.deliveredAt) : '';
    node.append(element('p', status + stamp, 'message-foot'));
    return node;
  }
  function noMessages() { return emptyState('No WhatsApp messages', 'No conversation is stored for this customer yet.'); }

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
    identity.append(element('h3', customer.name), element('p', customer.phone, 'muted'));
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
  }

  // ---- Customer detail ----
  const detailMessages = cursorList({
    listId: 'customer-messages-list', moreId: 'customer-messages-more', statusId: 'customer-messages-status', errorId: 'customer-messages-error', noun: ['message', 'messages'],
    request: () => ({ path: '/customers/' + encodeURIComponent(customerDetail.customer.id) + '/messages', params: new URLSearchParams() }),
    render: renderMessage,
    empty: noMessages
  });
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
    detailMessages.load(true);
    detailCalls.load(true);
    byId('customer-detail-heading').focus();
    byId('customer-detail').scrollIntoView({ block: 'start' });
  }
  function closeCustomerDetail(restoreFocus = true) {
    closePlayer();
    detailMessages.cancel();
    detailCalls.cancel();
    const opener = customerDetail ? customerDetail.opener : null;
    customerDetail = null;
    byId('customer-detail').hidden = true;
    byId('customers-browse').hidden = false;
    if (restoreFocus) (opener && opener.isConnected ? opener : byId('customers-heading')).focus();
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
    if (customerDetail && customerDetail.customer.id === id) { detailMessages.load(true); detailCalls.load(true); }
  }
  byId('customer-detail-back').addEventListener('click', () => closeCustomerDetail());
  byId('customer-detail-refresh').addEventListener('click', refreshCustomerDetail);
  byId('customer-detail-edit').addEventListener('click', (event) => { if (customerDetail) openCustomerDialog(customerDetail.customer, event.currentTarget); });
  byId('customer-detail-handlers').addEventListener('click', (event) => { if (customerDetail) openHandlers(customerDetail.customer, event.currentTarget); });
  byId('customer-detail-archive').addEventListener('click', (event) => { if (customerDetail) openArchive(customerDetail.customer, event.currentTarget); });

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

  // ---- WhatsApp chats ----
  function renderChat(chat) {
    if (!chat || !chat.customer || typeof chat.customer.id !== 'string' || typeof chat.customer.name !== 'string' || typeof chat.customer.phone !== 'string' ||
        !Array.isArray(chat.employees) || !chat.lastMessage || !['in', 'out'].includes(chat.lastMessage.direction)) {
      throw new Error('A WhatsApp chat could not be read. Please refresh.');
    }
    const last = chat.lastMessage;
    const item = element('button', undefined, 'chat-item');
    item.type = 'button';
    item.dataset.customerId = chat.customer.id;
    item.setAttribute('aria-current', String(Boolean(selectedChat) && selectedChat.id === chat.customer.id));
    const top = element('span', undefined, 'chat-top');
    top.append(element('strong', chat.customer.name), element('span', dateText(last.sentAt), 'hint'));
    const typeLabel = messageTypeLabel(last.messageType);
    const preview = (last.direction === 'in' ? 'In: ' : 'Out: ') + (last.text || (typeLabel ? '[' + typeLabel + ']' : 'No text'));
    const total = Number.isInteger(chat.messageCount) ? chat.messageCount : 0;
    item.append(top,
      element('span', chat.customer.phone + ' · ' + (chat.employees.length ? 'Handled by ' + handlerNames(chat.employees) : 'Unassigned'), 'chat-meta'),
      element('span', preview, 'chat-preview'),
      element('span', total + ' ' + plural(total, 'message', 'messages'), 'chat-count'));
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
    empty: (filtered) => emptyState('No chats found', filtered ? 'Try a different search or clear the employee filter. Customers without messages are not listed.' : 'Chats appear here once WhatsApp history has been stored for a customer.')
  });
  const threadList = cursorList({
    listId: 'chat-thread-list', moreId: 'chat-thread-older', statusId: 'chat-thread-status', errorId: 'chat-thread-error', noun: ['message', 'messages'],
    chronological: true,
    scroller: byId('chat-thread-scroll'),
    request: () => ({ path: '/customers/' + encodeURIComponent(selectedChat.id) + '/messages', params: new URLSearchParams() }),
    render: renderMessage,
    empty: noMessages
  });
  function openChat(chat, item) {
    selectedChat = chat.customer;
    for (const node of byId('whatsapp-list').children) node.setAttribute('aria-current', String(node === item));
    byId('chat-layout').dataset.view = 'thread';
    byId('chat-thread-heading').textContent = chat.customer.name;
    byId('chat-thread-subtitle').textContent = chat.customer.phone + ' · ' + (chat.employees.length ? 'Handled by ' + handlerNames(chat.employees) : 'Unassigned');
    byId('chat-open-customer').hidden = false;
    byId('chat-thread-empty').hidden = true;
    byId('chat-thread-body').hidden = false;
    threadList.load(true);
    if (window.matchMedia('(max-width: 900px)').matches) byId('chat-thread-heading').focus();
  }
  byId('chat-thread-back').addEventListener('click', () => {
    byId('chat-layout').dataset.view = 'list';
    const current = selectedChat ? byId('whatsapp-list').querySelector('[data-customer-id="' + CSS.escape(selectedChat.id) + '"]') : null;
    (current || byId('whatsapp-heading')).focus();
  });
  byId('chat-open-customer').addEventListener('click', (event) => {
    if (!selectedChat || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openCustomerById(selectedChat.id);
  });
  whatsappForm.addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(chatSearchTimer); chatList.load(true); });
  whatsappForm.addEventListener('input', (event) => {
    if (event.target.type !== 'search') return;
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(() => chatList.load(true), 350);
  });
  byId('whatsapp-employee').addEventListener('change', () => chatList.load(true));
  byId('whatsapp-refresh').addEventListener('click', () => chatList.load(true));
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
  let employeesLoaded = false;
  let activeTab = null;
  const tabNames = ['call-history', 'analytics', 'customers', 'whatsapp', 'employees'];
  const tabTitles = { 'call-history': 'Call history', analytics: 'Call analytics', customers: 'Customers', whatsapp: 'WhatsApp chats', employees: 'Employees' };
  const tabDescriptions = { 'call-history': 'Calls and recordings, together.', analytics: 'Call volume, talk time, connect rates and busy hours across your team.', customers: 'Customers, who handles them, and their chats and calls.', whatsapp: 'Stored WhatsApp conversations with customers.', employees: 'Manage people, enrolled devices and handovers.' };
  function showTab() {
    const hashTab = location.hash.slice(1).split('?')[0];
    const selected = tabNames.includes(hashTab) ? hashTab : 'call-history';
    if (selected !== activeTab) {
      closePlayer();
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
    if (selected === 'whatsapp' && !chatsLoaded) {
      chatsLoaded = true;
      chatList.load(true);
    }
  }
  for (const name of tabNames) {
    byId(name + '-tab').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', ' '].includes(event.key)) return;
      event.preventDefault();
      const index = tabNames.indexOf(name);
      const target = event.key === 'Home' ? tabNames[0] : event.key === 'End' ? tabNames[tabNames.length - 1] : event.key === ' ' ? name : tabNames[(index + (event.key === 'ArrowRight' ? 1 : tabNames.length - 1)) % tabNames.length];
      location.hash = target;
      showTab();
      byId(target + '-tab').focus();
    });
  }
  window.addEventListener('hashchange', showTab);
  byId('call-history-timezone-note').textContent = 'Dates and times use ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '. Number searches match literal text. Employee choices include the full directory.';
  loadDirectory();
  showTab();
})();`;
