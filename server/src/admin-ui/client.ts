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
      throw new Error(detail + requestId);
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
    for (const id of ['call-history-employee', 'devices-employee', 'invitation-employee', 'assignment-employee']) {
      const select = byId(id);
      const selected = select.value;
      const choices = document.createDocumentFragment();
      const empty = element('option', ['call-history-employee', 'devices-employee'].includes(id) ? 'All employees' : 'Select an employee');
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
  function renderRecording(call) {
    if (!call || typeof call.id !== 'string' || !call.employee || typeof call.employee.name !== 'string') throw new Error('A recording could not be read. Please refresh.');
    const row = element('div', undefined, 'recording-row');
    row.dataset.recordingId = call.id;
    const info = element('div', undefined, 'recording-info');
    info.append(element('span', call.displayName || 'Unnamed recording', 'recording-name'));
    const knownStatus = Object.hasOwn(statusNames, call.uploadStatus);
    info.append(element('span', knownStatus ? statusNames[call.uploadStatus] : 'Unknown status', 'badge ' + (knownStatus ? call.uploadStatus : '')));
    const actions = element('div', undefined, 'actions');
    const playButton = button('Play', () => startPlayback(call, row), '');
    const downloadButton = button('Download', () => download(call, downloadButton));
    playButton.disabled = downloadButton.disabled = call.uploadStatus !== 'complete';
    playButton.setAttribute('aria-label', 'Play ' + call.displayName);
    downloadButton.setAttribute('aria-label', 'Download ' + call.displayName);
    const deleteButton = button('Delete recording', () => openDelete('recording', call, deleteButton), 'secondary delete-button');
    deleteButton.disabled = call.uploadStatus === 'deleted';
    deleteButton.setAttribute('aria-label', 'Delete recording ' + call.displayName);
    actions.append(playButton, downloadButton, deleteButton);
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
  function renderCallHistory(call) {
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
    if (isCall) {
      const deleteButton = button('Delete call log', () => openDelete('call', call, deleteButton), 'secondary delete-button history-delete');
      deleteButton.setAttribute('aria-label', 'Delete call log for ' + (call.callerName || call.remoteNumber || 'unknown caller') + ' · ' + dateText(call.startedAt));
      caller.append(deleteButton);
    }
    row.append(caller, employee, time, type, line);
    if (call.recordings.length) {
      const recordings = element('div', undefined, 'row-recordings');
      for (const recording of call.recordings) recordings.append(renderRecording(recording));
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

  async function download(call, downloadButton) {
    downloadButton.disabled = true;
    downloadButton.textContent = 'Downloading…';
    message('action-status', 'Preparing download for ' + call.displayName + '…');
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
      message('action-status', 'Download ready for ' + call.displayName + '. Check your browser downloads.');
    } catch (error) {
      message('action-status', 'Download failed. ' + errorMessage(error));
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
  window.addEventListener('pagehide', () => { clearInvitation(); closePlayer(); cancelCallHistory(); });
  let employeesLoaded = false;
  let activeTab = null;
  const tabNames = ['call-history', 'employees'];
  const tabTitles = { 'call-history': 'Call history', employees: 'Employees' };
  const tabDescriptions = { 'call-history': 'Calls and recordings, together.', employees: 'Manage people, enrolled devices and handovers.' };
  function showTab() {
    const selected = tabNames.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'call-history';
    if (selected !== activeTab) {
      closePlayer();
      if (activeTab === 'call-history') cancelCallHistory();
      if (invitationExpiresAt || invitationPending) clearInvitation('The displayed code was cleared when leaving this view. Invitation history remains available.');
      if (selected === 'call-history') loadCallHistory();
    }
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
    if (selected === 'employees' && !employeesLoaded) {
      employeesLoaded = true;
      employeeList.load();
      deviceList.load();
      invitationList.load();
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
