/**
 * WhatsApp view: chat list with unread badges, a WhatsApp-style conversation, composer with quick replies,
 * attachments and templates, and the 24-hour window rule. Everything is scoped to the signed-in employee by the
 * server; this bundle contains no auto-reply, configuration or bulk features.
 */
export const whatsappClient = String.raw`
// ---- Message presentation ------------------------------------------------------------------------------------------------------
const WA_STATUS = {
  queued: { icon: 'clock', label: 'Sending' },
  sent: { icon: 'tick', label: 'Sent' },
  delivered: { icon: 'ticks', label: 'Delivered' },
  read: { icon: 'ticks', label: 'Read' },
  failed: { icon: 'alert', label: 'Message failed to send' }
};
const WA_MEDIA_LABELS = { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', sticker: 'Sticker' };
const WA_WINDOW_TEXT = "Free text can only be sent within 24 hours of the customer's last message. Use a template.";
function waStatusMark(status, detail) {
  if (!Object.hasOwn(WA_STATUS, status)) return null;
  const info = WA_STATUS[status];
  const mark = element('span', undefined, 'wa-mark wa-' + status);
  const label = detail ? info.label + ' · ' + detail : info.label;
  mark.title = label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
  mark.append(icon(info.icon));
  return mark;
}
function waDayLabel(date) {
  const ago = daysAgo(date);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return date.toLocaleDateString([], ago > 1 && ago < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
function waMessageText(item) {
  if (item.body) return item.body;
  if (item.templateName) return 'Template: ' + item.templateName;
  const type = String(item.messageType || '');
  return type && type !== 'text' ? '[' + type.charAt(0).toUpperCase() + type.slice(1) + ']' : 'No text';
}
function waMedia(item) {
  const media = item.media;
  if (!media || typeof media !== 'object' || !Object.hasOwn(WA_MEDIA_LABELS, media.kind)) return null;
  if (typeof media.url !== 'string' || !media.url.startsWith('/') || media.url.startsWith('//')) return null;
  return media;
}
const WA_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'application/pdf': 'pdf' };
function waDownloadName(media, id) {
  if (typeof media.fileName === 'string' && media.fileName.trim()) return media.fileName.trim();
  const type = typeof media.mimeType === 'string' ? media.mimeType.split(';')[0].trim().toLowerCase() : '';
  const extension = Object.hasOwn(WA_EXTENSIONS, type) ? WA_EXTENSIONS[type] : 'bin';
  return 'whatsapp-' + media.kind + '-' + String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '.' + extension;
}
function waDownloadLink(media, id) {
  const label = 'Download ' + (media.kind === 'sticker' ? 'sticker' : media.kind);
  const link = element('a', undefined, 'icon-btn wa-media-dl');
  link.href = media.url;
  link.setAttribute('download', waDownloadName(media, id));
  link.setAttribute('aria-label', label);
  link.title = label;
  link.rel = 'noopener';
  link.append(icon('download'));
  return link;
}
function waViewImage(media, alt, opener, id) {
  const dialog = element('dialog', undefined, 'js-dialog wa-viewer');
  dialog.setAttribute('aria-label', alt);
  const image = element('img');
  image.alt = alt;
  image.src = media.url;
  const bar = element('div', undefined, 'wa-viewer-bar');
  const close = iconButton('close', 'Close');
  close.addEventListener('click', () => dialog.close());
  bar.append(waDownloadLink(media, id), close);
  dialog.append(bar, image);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (opener && opener.isConnected) opener.focus(); });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}
function waMediaNode(media, caption, id, out) {
  const origin = out ? 'sent' : 'from customer';
  const wrap = element('div', undefined, 'wa-media wa-media-' + media.kind);
  const failed = () => {
    wrap.className = 'wa-media wa-media-failed';
    wrap.replaceChildren(element('span', WA_MEDIA_LABELS[media.kind] + ' unavailable', 'wa-media-gone'));
  };
  if (media.kind === 'image' || media.kind === 'sticker') {
    const alt = caption || (media.kind === 'sticker' ? 'Sticker ' + origin : 'Image ' + origin);
    const button = element('button', undefined, 'wa-media-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'View full size: ' + alt);
    const image = element('img');
    image.alt = alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', failed);
    image.src = media.url;
    button.append(image);
    button.addEventListener('click', () => waViewImage(media, alt, button, id));
    const frame = element('div', undefined, 'wa-media-frame');
    frame.append(button, waDownloadLink(media, id));
    wrap.append(frame);
  } else if (media.kind === 'video' || media.kind === 'audio') {
    const player = element(media.kind);
    player.controls = true;
    player.preload = media.kind === 'video' ? 'metadata' : 'none';
    player.setAttribute('aria-label', caption || (media.kind === 'video' ? 'Video ' : 'Audio ') + origin);
    player.addEventListener('error', failed);
    player.src = media.url;
    const frame = element('div', undefined, 'wa-media-frame');
    frame.append(player, waDownloadLink(media, id));
    wrap.append(frame);
  } else {
    const holder = element('span', undefined, 'wa-doc-icon');
    holder.append(icon('document'));
    const info = element('span', undefined, 'wa-doc-info');
    info.append(element('span', typeof media.fileName === 'string' && media.fileName ? media.fileName : 'Document', 'wa-doc-name'));
    const size = fileSizeText(media.size);
    if (size) info.append(element('span', size, 'wa-doc-size'));
    const link = element('a', 'Download', 'wa-doc-link');
    link.href = media.url;
    link.setAttribute('download', waDownloadName(media, id));
    link.rel = 'noopener';
    wrap.append(holder, info, link);
  }
  return wrap;
}
function waBubbleSignature(item) {
  return [item.status, item.readAt || '', item.deliveredAt || '', item.body || '', item.localError || '', item.messageType || ''].join('|');
}
// handlers: { retry(item), discard(item) }
function waBubble(item, handlers) {
  const out = item.direction === 'out';
  const node = element('div', undefined, 'wa-msg ' + item.direction);
  node.dataset.messageId = item.id;
  const bubble = element('div', undefined, 'wa-bubble');
  if (item.templateName) bubble.append(element('span', 'Template', 'wa-tag'));
  const media = waMedia(item);
  if (media) {
    bubble.classList.add('wa-has-media');
    if (media.kind === 'sticker' && !item.body) bubble.classList.add('wa-sticker');
    bubble.append(waMediaNode(media, item.body, item.id, out));
    if (item.body) bubble.append(element('div', item.body, 'wa-text'));
  } else {
    bubble.append(element('div', waMessageText(item), 'wa-text'));
  }
  const meta = element('span', undefined, 'wa-meta');
  const time = element('time', timeFormat.format(new Date(item.sentAt)), 'wa-time');
  time.dateTime = item.sentAt;
  time.title = dateText(item.sentAt);
  meta.append(time);
  if (out) {
    const detail = item.status === 'read' && item.readAt ? dateText(item.readAt) : item.status === 'delivered' && item.deliveredAt ? dateText(item.deliveredAt) : '';
    const mark = waStatusMark(item.status, detail);
    if (mark) meta.append(mark);
  }
  const text = item.body || (item.templateName ? 'Template: ' + item.templateName : '');
  if (text && !item.local) {
    const copy = iconButton('copy', 'Copy message text', 'wa-copy');
    copy.addEventListener('click', async () => {
      const ok = await copyText(text);
      toast(ok ? 'Message copied.' : 'Could not copy the message.', !ok);
    });
    meta.append(copy);
  }
  bubble.append(meta);
  if (item.local && item.status === 'failed') {
    const failure = element('div', undefined, 'wa-send-failed');
    failure.setAttribute('role', 'alert');
    failure.append(element('span', item.localError || 'The message could not be sent.'));
    failure.append(textButton('Retry', 'secondary wa-small', () => handlers.retry(item)), textButton('Discard', 'secondary wa-small', () => handlers.discard(item)));
    bubble.append(failure);
  }
  node.append(bubble);
  return node;
}
function waDaySeparator(date) {
  const separator = element('div', undefined, 'wa-day');
  separator.append(element('span', waDayLabel(date)));
  return separator;
}
function waPreview(chat) {
  const last = chat.lastMessage || {};
  const text = String(last.text || '').replace(/\s+/g, ' ').trim() || 'No text';
  return (last.direction === 'out' ? 'You: ' : '') + text;
}

// ---- Handler profile and quick replies (shared by the composer and the template picker) --------------------------------
const waShared = { profile: null, quick: null, quickAt: 0, templates: null, templatesAt: 0, canSend: null };
lifecycle.signedOut.push(() => { waShared.profile = null; waShared.quick = null; waShared.quickAt = 0; waShared.templates = null; waShared.templatesAt = 0; waShared.canSend = null; });
async function waHandler() {
  if (!waShared.profile) {
    try {
      const data = await api('/profile');
      waShared.profile = { name: String(data.employee.name || '').trim(), phone: String(data.employee.phoneNumber || '').trim() };
    } catch (error) {
      if (error.status === 401) throw error;
      waShared.profile = { name: String(session.employee.name || '').trim(), phone: String(session.employee.phoneNumber || '').trim() };
    }
  }
  return waShared.profile;
}
async function waQuickMessages(force) {
  if (!force && waShared.quick && Date.now() - waShared.quickAt < 60000) return waShared.quick;
  const data = await api('/whatsapp/quick-messages');
  if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable quick replies.');
  waShared.quick = data.items.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.text === 'string')
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  waShared.quickAt = Date.now();
  return waShared.quick;
}
function waReadTemplate(item) {
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
    headerFormat: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(item.headerFormat) ? item.headerFormat : 'NONE',
    headerImageConfigured: item.headerImageConfigured === true,
    headerImageUrl: typeof item.headerImageUrl === 'string' && item.headerImageUrl.startsWith('/') && !item.headerImageUrl.startsWith('//') ? item.headerImageUrl : '',
    reason: typeof item.reason === 'string' ? item.reason : ''
  };
}
async function waTemplates(force) {
  if (!force && waShared.templates && Date.now() - waShared.templatesAt < 300000) return waShared.templates;
  const data = await api('/whatsapp/templates');
  if (!data || !Array.isArray(data.items)) throw new Error('The server returned unreadable templates. Please try again.');
  waShared.templates = data.items.map(waReadTemplate).filter(Boolean);
  waShared.templatesAt = Date.now();
  return waShared.templates;
}
// Uploads one file as the raw request body. Resolves with { attachmentId, kind, mimeType, fileName, size }.
async function waUpload(file, signal) {
  const data = await api('/whatsapp/attachments?fileName=' + encodeURIComponent(file.name), { method: 'POST', rawBody: file, contentType: file.type, signal });
  if (!data || typeof data.attachmentId !== 'string') throw new Error('The server returned an unreadable upload result. Please try again.');
  return { attachmentId: data.attachmentId, kind: data.kind, mimeType: data.mimeType || file.type, fileName: data.fileName || file.name, size: data.size || file.size };
}
// Photos above 4 MB are re-encoded as JPEG so they stay under WhatsApp's 5 MB image limit.
async function waShrinkImage(file) {
  if (!ATTACH_TYPES.image.includes(file.type) || file.size <= 4 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = element('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
function waSendFailureText(error) {
  if (error.code === 'window_closed') return WA_WINDOW_TEXT;
  if (error.code === 'WHATSAPP_NOT_CONFIGURED') return 'WhatsApp sending is not configured.';
  if (error.code === 'WHATSAPP_SEND_FAILED') return 'WhatsApp could not send this message. Try again in a moment.';
  if (error.code === 'template_header_image_required') return 'This template needs a header file. Choose one and try again.';
  if (error.code === 'attachment_not_found') return 'The file is no longer available. Attach it again.';
  if (error.code === 'unsupported_media_type') return 'WhatsApp cannot send this file. Images must be JPEG, PNG or WebP.';
  if (error.code === 'rate_limited') return 'Too many files today. Try again tomorrow.';
  return errorMessage(error);
}

// ---- Template picker ---------------------------------------------------------------------------------------------------------------
// Resolves with the sent message, or null when closed. context: { customerId, customerName }
function waOpenTemplatePicker(context, opener) {
  return new Promise((resolve) => {
    const dialog = element('dialog', undefined, 'js-dialog wa-tpl-dialog');
    dialog.setAttribute('aria-labelledby', 'tpl-title');
    const title = element('h2', 'Send a template');
    title.id = 'tpl-title';
    const closeButton = iconButton('close', 'Close');
    const head = element('div', undefined, 'wa-tpl-head');
    head.append(title, closeButton);
    const state = { templates: null, selected: null, values: [], query: '', headerOverride: null, sending: false, uploading: false, handler: null };
    let sent = null;
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'Search templates';
    search.setAttribute('aria-label', 'Search templates');
    const listStatus = element('p', 'Loading templates…', 'hint');
    listStatus.setAttribute('role', 'status');
    const listError = element('p', undefined, 'error-text');
    listError.setAttribute('role', 'alert');
    listError.hidden = true;
    const reload = textButton('Try again', 'secondary', () => load(true));
    reload.hidden = true;
    const list = element('div', undefined, 'wa-tpl-list');
    const side = element('div', undefined, 'wa-tpl-side');
    side.append(search, listStatus, listError, reload, list);
    const detail = element('div', undefined, 'wa-tpl-detail');
    detail.append(element('p', 'Choose a template to preview it and fill in its variables.', 'muted'));
    const columns = element('div', undefined, 'wa-tpl-columns');
    columns.append(side, detail);
    dialog.append(head, columns);

    function visibleTemplates() {
      const query = state.query.trim().toLowerCase();
      return (state.templates || []).filter((item) => !query || (item.name + ' ' + item.category + ' ' + item.language + ' ' + item.body).toLowerCase().includes(query));
    }
    function sameTemplate(a, b) { return Boolean(a) && Boolean(b) && a.name === b.name && a.language === b.language; }
    function renderList() {
      const shown = visibleTemplates();
      const nodes = shown.map((item) => {
        const button = element('button', undefined, 'wa-tpl-item' + (item.sendable ? '' : ' wa-disabled'));
        button.type = 'button';
        button.setAttribute('aria-pressed', String(sameTemplate(item, state.selected)));
        if (!item.sendable) button.setAttribute('aria-disabled', 'true');
        button.append(element('strong', item.name, 'wa-tpl-name'), element('span', [item.category, item.language].filter(Boolean).join(' · '), 'wa-tpl-sub'));
        if (templateNeedsHeader(item)) button.append(element('span', item.headerFormat.charAt(0) + item.headerFormat.slice(1).toLowerCase() + ' header', 'badge'));
        button.append(element('span', item.body, 'wa-tpl-snippet'));
        if (!item.sendable) button.append(element('span', item.reason || 'This template cannot be sent from here.', 'wa-tpl-reason'));
        button.addEventListener('click', () => select(item));
        return button;
      });
      if (!nodes.length && state.templates) nodes.push(element('p', (state.templates.length ? 'No templates match your search.' : 'No templates are available.'), 'muted'));
      list.replaceChildren(...nodes);
    }
    async function load(force) {
      listError.hidden = true;
      reload.hidden = true;
      listStatus.hidden = false;
      listStatus.textContent = 'Loading templates…';
      try {
        const [templates, handler] = await Promise.all([waTemplates(force), waHandler()]);
        state.templates = templates;
        state.handler = handler;
        listStatus.hidden = true;
        renderList();
      } catch (error) {
        if (error.status === 401) return;
        listStatus.hidden = true;
        setStatus(listError, error.code === 'WHATSAPP_NOT_CONFIGURED' ? 'WhatsApp templates are unavailable because WhatsApp is not configured.' : errorMessage(error), true);
        reload.hidden = false;
      }
    }
    function fillContext() { return { customerName: context.customerName, handlerName: state.handler ? state.handler.name : '', handlerPhone: state.handler ? state.handler.phone : '' }; }
    function parts(text, template) {
      const nodes = [];
      const pattern = /\{\{\s*([^{}\s]+)\s*\}\}/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(text))) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const index = template.variables.findIndex((variable) => variable.key === match[1]);
        const value = index >= 0 ? String(state.values[index] || '').trim() : '';
        nodes.push(value || element('mark', '{{' + match[1] + '}}', 'wa-var'));
        last = pattern.lastIndex;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }
    function previewNode(template) {
      const node = element('div', undefined, 'wa-msg out');
      const bubble = element('div', undefined, 'wa-bubble');
      if (templateNeedsHeader(template)) {
        const media = element('div', undefined, 'wa-tpl-header-media');
        if (state.headerOverride && state.headerOverride.preview) {
          const image = element('img', undefined, 'wa-tpl-header-img');
          image.alt = 'Header file';
          image.src = state.headerOverride.preview;
          media.append(image);
        } else if (template.headerImageConfigured && template.headerFormat === 'IMAGE' && template.headerImageUrl) {
          const image = element('img', undefined, 'wa-tpl-header-img');
          image.alt = 'Default header image';
          image.src = template.headerImageUrl;
          media.append(image);
        } else {
          media.append(element('div', state.headerOverride ? state.headerOverride.fileName : template.headerImageConfigured ? 'Default header ' + template.headerFormat.toLowerCase() : 'Header ' + template.headerFormat.toLowerCase() + ' needed', 'wa-tpl-header-missing'));
        }
        bubble.append(media);
      }
      if (template.header) { const header = element('div', undefined, 'wa-tpl-header'); header.append(...parts(template.header, template)); bubble.append(header); }
      const body = element('div', undefined, 'wa-text');
      body.append(...parts(template.body, template));
      bubble.append(body);
      if (template.footer) { const footer = element('div', undefined, 'wa-tpl-footer'); footer.append(...parts(template.footer, template)); bubble.append(footer); }
      const meta = element('span', undefined, 'wa-meta');
      meta.append(element('time', timeFormat.format(new Date()), 'wa-time'));
      bubble.append(meta);
      node.append(bubble);
      if (template.buttons.length) {
        const buttons = element('div', undefined, 'wa-tpl-btns');
        for (const button of template.buttons) buttons.append(element('span', button.text, 'wa-tpl-btn'));
        node.append(buttons);
      }
      return node;
    }
    function select(template) {
      state.selected = template;
      state.headerOverride = null;
      state.values = initialTemplateValues(template, fillContext());
      renderList();
      renderDetail();
    }
    function renderDetail() {
      const template = state.selected;
      clearNode(detail);
      if (!template) { detail.append(element('p', 'Choose a template to preview it and fill in its variables.', 'muted')); return; }
      detail.append(element('h3', template.name));
      if (!template.sendable) { detail.append(element('p', template.reason || 'This template cannot be sent from here yet.', 'notice error')); return; }
      const previewHost = element('div', undefined, 'wa-tpl-preview');
      previewHost.setAttribute('aria-label', 'Preview');
      const updatePreview = () => { previewHost.replaceChildren(previewNode(template)); sendButton.disabled = Boolean(templateProblem(template, state.values, state.headerOverride)) || state.sending || state.uploading; };
      const form = element('form', undefined, 'wa-tpl-form');
      form.noValidate = true;
      template.variables.forEach((variable, index) => {
        const input = element('input');
        input.type = 'text';
        input.maxLength = 1024;
        input.value = state.values[index] || '';
        input.placeholder = variable.example || '';
        input.addEventListener('input', () => { state.values[index] = cleanVariable(input.value); updatePreview(); });
        form.append(fieldLabel('Variable {{' + variable.key + '}}' + (variable.example ? ' (for example ' + variable.example + ')' : ''), input));
      });
      const error = element('p', undefined, 'error-text');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      if (templateNeedsHeader(template)) {
        const kind = template.headerFormat.toLowerCase();
        const file = element('input');
        file.type = 'file';
        file.accept = attachAccept([kind]);
        file.hidden = true;
        const note = element('p', template.headerImageConfigured ? 'A default header ' + kind + ' is set. You can use a different one for this message.' : 'Choose the header ' + kind + ' for this message.', 'hint');
        const pick = textButton(template.headerImageConfigured ? 'Use a different file' : 'Choose file', 'secondary', () => file.click());
        file.addEventListener('change', async () => {
          const chosen = file.files && file.files[0];
          file.value = '';
          if (!chosen) return;
          const problem = attachProblem(chosen, [kind]);
          if (problem) { setStatus(error, problem, true); return; }
          setStatus(error, '', false);
          state.uploading = true;
          pick.disabled = true;
          note.textContent = 'Uploading…';
          try {
            const upload = await waUpload(await waShrinkImage(chosen));
            state.headerOverride = { attachmentId: upload.attachmentId, fileName: upload.fileName, preview: kind === 'image' ? URL.createObjectURL(chosen) : '' };
            note.textContent = 'Using ' + upload.fileName + ' for this message only.';
          } catch (failure) {
            if (failure.status !== 401) setStatus(error, waSendFailureText(failure), true);
            note.textContent = 'The file could not be uploaded.';
          } finally {
            state.uploading = false;
            pick.disabled = false;
            updatePreview();
          }
        });
        form.append(note, pick, file);
      }
      const sendButton = element('button', 'Send template');
      sendButton.type = 'submit';
      form.append(error, sendButton);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const problem = templateProblem(template, state.values, state.headerOverride);
        if (problem) { setStatus(error, problem, true); return; }
        state.sending = true;
        sendButton.disabled = true;
        sendButton.textContent = 'Sending…';
        setStatus(error, '', false);
        try {
          const body = templateSendBody(newClientMessageId(crypto), template, state.values, state.headerOverride ? state.headerOverride.attachmentId : '');
          const data = await api('/customers/' + encodeURIComponent(context.customerId) + '/messages', { method: 'POST', body });
          sent = data.message;
          dialog.close();
        } catch (failure) {
          state.sending = false;
          sendButton.textContent = 'Send template';
          if (failure.status !== 401) setStatus(error, waSendFailureText(failure), true);
          updatePreview();
        }
      });
      detail.append(previewHost, form);
      updatePreview();
    }
    search.addEventListener('input', () => { state.query = search.value; renderList(); });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', (event) => { if (state.sending) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (state.headerOverride && state.headerOverride.preview) URL.revokeObjectURL(state.headerOverride.preview);
      dialog.remove();
      if (opener && opener.isConnected) opener.focus();
      resolve(sent);
    });
    document.body.append(dialog);
    dialog.showModal();
    search.focus();
    load(false);
  });
}

// ---- WhatsApp view -------------------------------------------------------------------------------------------------------------------
views.whatsapp = (() => {
  let ui = null;
  let chats = null;
  let conv = null;
  let unreadVersion = 0;
  function reset() { ui = null; chats = null; conv = null; unreadVersion += 1; renderBadge(0); }
  lifecycle.signedOut.push(reset);

  // -- Unread badge in the navigation
  function renderBadge(count) {
    byId('whatsapp-unread').hidden = count <= 0;
    byId('whatsapp-unread-count').textContent = count > 0 ? unreadLabel(count) : '';
    byId('whatsapp-unread-text').textContent = count > 0 ? count + ' ' + plural(count, 'chat', 'chats') + ' with unread messages' : '';
  }
  async function refreshUnread() {
    const current = ++unreadVersion;
    try {
      const data = await api('/whatsapp/unread');
      if (current === unreadVersion) renderBadge(data && Number.isInteger(data.chats) && data.chats > 0 ? data.chats : 0);
    } catch (error) {
      if (error.code === 'feature_disabled') byId('nav-whatsapp').hidden = true;
    }
  }
  lifecycle.signedIn.push(() => { byId('nav-whatsapp').hidden = false; refreshUnread(); });

  // -- Chat list
  function chatRow(chat) {
    const item = element('li', undefined, 'wa-chat-item');
    const id = chat.customer.id;
    const link = element('a', undefined, 'wa-chat' + (chat.unreadCount > 0 ? ' wa-unread' : ''));
    link.href = '#whatsapp/' + encodeURIComponent(id);
    link.dataset.customerId = id;
    if (conv && conv.id === id) link.setAttribute('aria-current', 'true');
    link.append(avatarNode(chat.customer.name, id));
    const main = element('span', undefined, 'wa-chat-main');
    const top = element('span', undefined, 'wa-chat-top');
    top.append(element('strong', chat.customer.name, 'wa-chat-name'), element('span', listTimeText(chat.lastMessage && chat.lastMessage.sentAt), 'wa-chat-time'));
    const bottom = element('span', undefined, 'wa-chat-bottom');
    bottom.append(element('span', waPreview(chat), 'wa-chat-preview'));
    if (chat.unreadCount > 0) {
      const badge = element('span', unreadLabel(chat.unreadCount), 'unread-badge');
      badge.setAttribute('aria-label', chat.unreadCount + ' unread ' + plural(chat.unreadCount, 'message', 'messages'));
      bottom.append(badge);
    }
    main.append(top, bottom);
    link.append(main);
    item.append(link);
    return item;
  }
  function renderChats() {
    ui.chatList.replaceChildren(...chats.items.map(chatRow));
    ui.chatMore.hidden = !chats.nextCursor;
    ui.chatEmpty.hidden = chats.items.length > 0 || chats.loading || Boolean(chats.error);
    ui.chatEmpty.textContent = chats.query ? 'No chats match your search.' : 'No chats yet. Open a customer and choose WhatsApp chat to start one.';
  }
  function sortChats(items) {
    return items.slice().sort((a, b) => {
      const left = a.lastMessage ? a.lastMessage.sentAt : '';
      const right = b.lastMessage ? b.lastMessage.sentAt : '';
      return left < right ? 1 : left > right ? -1 : 0;
    });
  }
  async function loadChats(more, silent) {
    if (!chats) return true;
    const current = chats;
    const version = ++chats.version;
    if (chats.controller) chats.controller.abort();
    const controller = new AbortController();
    chats.controller = controller;
    if (!silent) { chats.loading = true; chats.error = ''; ui.chatError.hidden = true; ui.chatRetry.hidden = true; ui.chatStatus.textContent = 'Loading chats…'; }
    const params = new URLSearchParams({ limit: '30' });
    if (chats.query) params.set('q', chats.query);
    if (more && chats.nextCursor) params.set('cursor', chats.nextCursor);
    try {
      const data = await api('/whatsapp/chats?' + params.toString(), { signal: controller.signal });
      if (chats !== current || version !== chats.version) return true;
      const items = (Array.isArray(data.items) ? data.items : []).filter((chat) => chat && chat.customer && typeof chat.customer.id === 'string');
      if (more) {
        const known = new Set(chats.items.map((chat) => chat.customer.id));
        chats.items = chats.items.concat(items.filter((chat) => !known.has(chat.customer.id)));
        chats.nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      } else if (silent && chats.items.length > items.length) {
        // A silent refresh replaces the newest page and keeps the older pages already loaded.
        const fresh = new Set(items.map((chat) => chat.customer.id));
        chats.items = sortChats(items.concat(chats.items.filter((chat) => !fresh.has(chat.customer.id))));
      } else {
        chats.items = items;
        chats.nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      }
      chats.loading = false;
      chats.stale = false;
      ui.chatStatus.textContent = '';
      renderChats();
      return true;
    } catch (error) {
      if (error.name === 'AbortError' || chats !== current || version !== chats.version || error.status === 401) return true;
      chats.loading = false;
      if (silent) return false;
      chats.error = featureOffText(error, 'WhatsApp chats') || errorMessage(error);
      ui.chatStatus.textContent = '';
      setStatus(ui.chatError, chats.error, true);
      ui.chatRetry.hidden = false;
      renderChats();
      return false;
    }
  }

  // -- Conversation
  function windowOpen() {
    const window24 = conv && conv.customer && conv.customer.whatsappWindow;
    if (!window24 || !window24.open) return false;
    const expires = Date.parse(window24.expiresAt);
    return !Number.isFinite(expires) || expires > Date.now();
  }
  function atBottom() {
    const box = ui.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  }
  function renderMessages(stick) {
    if (!conv) return;
    const box = ui.messages;
    const keepBottom = stick || atBottom();
    const before = box.scrollHeight;
    const handlers = { retry: retrySend, discard: discardLocal };
    const nodes = [];
    if (conv.nextCursor) nodes.push(ui.olderButton);
    const used = new Set();
    for (const row of conversationRows(conv.messages)) {
      if (row.day) nodes.push(waDaySeparator(row.day));
      const signature = waBubbleSignature(row.message);
      let cached = conv.bubbles.get(row.message.id);
      if (!cached || cached.signature !== signature) {
        cached = { signature, node: waBubble(row.message, handlers) };
        conv.bubbles.set(row.message.id, cached);
      }
      used.add(row.message.id);
      nodes.push(cached.node);
    }
    for (const id of Array.from(conv.bubbles.keys())) if (!used.has(id)) conv.bubbles.delete(id);
    if (!conv.messages.length && !conv.loading) nodes.push(element('p', 'No messages yet. Say hello below.', 'wa-empty'));
    ui.olderButton.hidden = !conv.nextCursor;
    box.replaceChildren(...nodes);
    if (keepBottom) box.scrollTop = box.scrollHeight;
    else if (conv.keepOffset) box.scrollTop += box.scrollHeight - before;
    conv.keepOffset = false;
  }
  function renderComposer() {
    if (!conv) return;
    const open = windowOpen();
    const unavailable = waShared.canSend === false;
    ui.banner.hidden = open || unavailable;
    ui.composerRow.hidden = !open || unavailable;
    ui.unavailable.hidden = !unavailable;
    ui.attachChip.hidden = !conv.attachment;
    ui.templateBtn.hidden = open || unavailable;
    if (open && !unavailable) ui.templateInline.hidden = false;
    ui.input.disabled = Boolean(conv.sending);
    ui.sendBtn.disabled = Boolean(conv.sending);
    ui.attachBtn.disabled = Boolean(conv.sending);
  }
  function renderHeader() {
    const customer = conv.customer;
    ui.headName.textContent = customer ? customer.name : conv.title || 'Chat';
    ui.headPhone.textContent = customer ? customer.phone : '';
    clearNode(ui.headAvatar);
    if (customer) ui.headAvatar.append(avatarNode(customer.name, customer.id));
    ui.dial.hidden = !customer;
    if (customer) ui.dial.href = 'tel:' + customer.phone.replace(/[^0-9+]/g, '');
    ui.details.hidden = !customer;
  }
  async function loadCustomer(target) {
    try {
      const data = await api('/customers/' + encodeURIComponent(target.id));
      if (conv !== target) return;
      target.customer = readCustomer(data.customer);
      renderHeader();
      renderComposer();
    } catch (error) {
      if (conv !== target || error.status === 401) return;
      target.problem = error.status === 404 ? 'This chat is not available.' : featureOffText(error, 'WhatsApp chats') || errorMessage(error);
      setStatus(ui.convError, target.problem, true);
      renderHeader();
    }
  }
  async function loadMessages(target, older) {
    if (target.loading) return;
    target.loading = true;
    if (target.controller) target.controller.abort();
    const controller = new AbortController();
    target.controller = controller;
    const params = new URLSearchParams({ limit: '30' });
    if (older && target.nextCursor) params.set('cursor', target.nextCursor);
    try {
      const data = await api('/customers/' + encodeURIComponent(target.id) + '/messages?' + params.toString(), { signal: controller.signal });
      if (conv !== target) return;
      const items = (Array.isArray(data.items) ? data.items : []).filter((item) => item && typeof item.id === 'string' && (item.direction === 'in' || item.direction === 'out') && typeof item.sentAt === 'string');
      target.messages = mergeMessages(target.messages, items);
      if (older || !target.loaded) target.nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      target.loaded = true;
      target.loading = false;
      setStatus(ui.convError, '', false);
      target.keepOffset = Boolean(older);
      renderMessages(!older && !target.shown);
      target.shown = true;
      maybeMarkRead();
    } catch (error) {
      target.loading = false;
      if (error.name === 'AbortError' || conv !== target || error.status === 401) return;
      if (!target.loaded) setStatus(ui.convError, error.status === 404 ? 'This chat is not available.' : featureOffText(error, 'WhatsApp chats') || errorMessage(error), true);
    }
    if (conv === target) { ui.olderButton.disabled = false; ui.olderButton.textContent = 'Load older messages'; }
  }
  function newestInbound() {
    return conv.messages.find((message) => message.direction === 'in' && !message.local) || null;
  }
  async function maybeMarkRead() {
    if (!conv || !conv.loaded || document.hidden || activeView !== 'whatsapp') return;
    const newest = newestInbound();
    if (!newest || conv.markedId === newest.id) return;
    const target = conv;
    target.markedId = newest.id;
    try {
      await api('/whatsapp/chats/' + encodeURIComponent(target.id) + '/read', { method: 'POST', body: {} });
      if (chats) {
        const row = chats.items.find((chat) => chat.customer.id === target.id);
        if (row && row.unreadCount) { row.unreadCount = 0; if (ui) renderChats(); }
      }
      refreshUnread();
    } catch (error) {
      if (conv === target) target.markedId = '';
    }
  }
  async function pollConversation() {
    if (!conv || !conv.loaded) return true;
    const target = conv;
    try {
      const data = await api('/customers/' + encodeURIComponent(target.id) + '/messages?limit=30');
      if (conv !== target) return true;
      const items = (Array.isArray(data.items) ? data.items : []).filter((item) => item && typeof item.id === 'string');
      const known = new Set(target.messages.map((message) => message.id));
      const fresh = items.filter((item) => !known.has(item.id) && item.direction === 'in');
      const wasBottom = atBottom();
      target.messages = mergeMessages(target.messages, items);
      renderMessages(wasBottom);
      if (!wasBottom && fresh.length) { ui.newPill.hidden = false; }
      loadCustomer(target);
      maybeMarkRead();
      return true;
    } catch (error) {
      return error.status === 401;
    }
  }
  function makeLocal(clientId, body) {
    return { id: 'local:' + clientId, clientId, direction: 'out', messageType: 'text', body, status: 'queued', sentAt: new Date().toISOString(), local: true, localError: '' };
  }
  function replaceLocal(target, local, message) {
    target.messages = target.messages.filter((item) => item.id !== local.id);
    if (message) target.messages = mergeMessages(target.messages, [message]);
  }
  async function deliver(target, local, body) {
    local.status = 'queued';
    local.localError = '';
    try {
      const data = await api('/customers/' + encodeURIComponent(target.id) + '/messages', { method: 'POST', body });
      replaceLocal(target, local, data.message);
      if (conv === target) { renderMessages(true); pokeLive(); }
    } catch (error) {
      if (error.status === 401) return;
      if (error.status === 0) {
        // The request may never have reached the server: keep the bubble. Retrying with the same id never sends twice.
        local.status = 'failed';
        local.localError = waSendFailureText(error);
        if (conv === target) renderMessages(true);
        return;
      }
      // The server answered. A refused or failed send is already recorded there (a failed one shows in the thread), so the
      // local bubble goes away and the text returns to the composer for another try.
      target.messages = target.messages.filter((item) => item.id !== local.id);
      if (conv !== target) return;
      if (!ui.input.value && !target.attachment) { ui.input.value = local.body; autosize(); }
      setStatus(ui.composeNote, waSendFailureText(error), true);
      renderMessages(false);
      if (error.code === 'window_closed') loadCustomer(target);
      pollConversation();
    }
  }
  function retrySend(item) {
    if (!conv) return;
    const target = conv;
    const local = target.messages.find((message) => message.id === item.id);
    if (!local) return;
    local.status = 'queued';
    renderMessages(true);
    deliver(target, local, textSendBody(local.clientId, local.body));
  }
  function discardLocal(item) {
    if (!conv) return;
    conv.messages = conv.messages.filter((message) => message.id !== item.id);
    renderMessages(false);
  }
  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + 'px';
  }
  async function sendCurrent() {
    if (!conv || conv.sending) return;
    const target = conv;
    if (!windowOpen()) { renderComposer(); return; }
    if (target.attachment) { await sendAttachment(target); return; }
    const text = ui.input.value.trim();
    if (!text) return;
    if (text.length > 4096) { setStatus(ui.composeNote, 'Messages can be up to 4096 characters.', true); return; }
    setStatus(ui.composeNote, '', false);
    const local = makeLocal(newClientMessageId(crypto), text);
    target.messages = mergeMessages(target.messages, [local]);
    ui.input.value = '';
    autosize();
    renderMessages(true);
    await deliver(target, local, textSendBody(local.clientId, text));
    if (conv === target) ui.input.focus();
  }
  async function sendAttachment(target) {
    const attachment = target.attachment;
    target.sending = true;
    renderComposer();
    setStatus(ui.composeNote, 'Uploading ' + attachment.file.name + '…', false);
    try {
      if (!attachment.uploaded) attachment.uploaded = await waUpload(attachment.file);
      const body = mediaSendBody(newClientMessageId(crypto), attachment.uploaded.attachmentId, ui.input.value);
      const data = await api('/customers/' + encodeURIComponent(target.id) + '/messages', { method: 'POST', body });
      if (conv !== target) return;
      target.messages = mergeMessages(target.messages, [data.message]);
      clearAttachment(target);
      ui.input.value = '';
      autosize();
      setStatus(ui.composeNote, '', false);
      renderMessages(true);
      pokeLive();
    } catch (error) {
      if (error.status === 401 || conv !== target) return;
      setStatus(ui.composeNote, waSendFailureText(error), true);
    } finally {
      target.sending = false;
      if (conv === target) { renderComposer(); ui.input.focus(); }
    }
  }
  function clearAttachment(target) {
    if (target.attachment && target.attachment.preview) URL.revokeObjectURL(target.attachment.preview);
    target.attachment = null;
    clearNode(ui.attachChip);
    renderComposer();
  }
  async function chooseAttachment(file) {
    if (!conv) return;
    const target = conv;
    const problem = attachProblem(file, ['image', 'video', 'document']);
    const shrunk = problem && ATTACH_TYPES.image.includes(file.type) && file.size > ATTACH_IMAGE_MAX_BYTES ? await waShrinkImage(file) : file;
    const finalProblem = shrunk === file ? problem : attachProblem(shrunk, ['image']);
    if (finalProblem) { setStatus(ui.composeNote, finalProblem, true); return; }
    if (conv !== target) return;
    const ready = await waShrinkImage(shrunk);
    clearAttachment(target);
    target.attachment = { file: ready, uploaded: null, preview: ATTACH_TYPES.image.includes(ready.type) ? URL.createObjectURL(ready) : '' };
    const chip = ui.attachChip;
    clearNode(chip);
    if (target.attachment.preview) { const thumb = element('img', undefined, 'wa-chip-thumb'); thumb.alt = ''; thumb.src = target.attachment.preview; chip.append(thumb); }
    else { const holder = element('span', undefined, 'wa-chip-thumb wa-chip-icon'); holder.append(icon('document')); chip.append(holder); }
    const info = element('span', undefined, 'wa-chip-info');
    info.append(element('strong', ready.name), element('span', fileSizeText(ready.size) + ' · add a caption below if you like', 'hint'));
    const remove = iconButton('close', 'Remove attachment');
    remove.addEventListener('click', () => { clearAttachment(target); setStatus(ui.composeNote, '', false); ui.input.focus(); });
    chip.append(info, remove);
    setStatus(ui.composeNote, '', false);
    renderComposer();
    ui.input.focus();
  }
  async function toggleQuick() {
    if (!ui.quick.hidden) { ui.quick.hidden = true; ui.quickBtn.setAttribute('aria-expanded', 'false'); return; }
    ui.quick.hidden = false;
    ui.quickBtn.setAttribute('aria-expanded', 'true');
    ui.quick.replaceChildren(element('p', 'Loading quick replies…', 'muted'));
    try {
      const items = await waQuickMessages(false);
      if (!conv || ui.quick.hidden) return;
      if (!items.length) { ui.quick.replaceChildren(element('p', 'No quick replies have been set up yet.', 'muted')); return; }
      ui.quick.replaceChildren(...items.map((item) => {
        const choice = element('button', undefined, 'wa-quick-item secondary');
        choice.type = 'button';
        choice.append(element('strong', item.title), element('span', item.text.replace(/\s+/g, ' ').trim().slice(0, 160), 'wa-quick-preview'));
        choice.addEventListener('click', () => useQuick(item));
        return choice;
      }));
    } catch (error) {
      if (error.status !== 401) ui.quick.replaceChildren(element('p', errorMessage(error), 'error-text'));
    }
  }
  async function useQuick(item) {
    const handler = await waHandler();
    const filled = fillQuickPlaceholders(item.text, { name: conv.customer ? conv.customer.name : '', handler_name: handler.name, handler_phone: handler.phone });
    const current = ui.input.value;
    ui.input.value = current && !current.endsWith('\n') ? current + '\n' + filled.text : current + filled.text;
    autosize();
    ui.quick.hidden = true;
    ui.quickBtn.setAttribute('aria-expanded', 'false');
    ui.input.focus();
    setStatus(ui.composeNote, filled.missing.length ? 'Fill in ' + filled.missing.map((key) => '{{' + key + '}}').join(', ') + ' before you send.' : '', true);
  }
  async function openTemplates(opener) {
    if (!conv || !conv.customer) return;
    const target = conv;
    const message = await waOpenTemplatePicker({ customerId: target.id, customerName: target.customer.name }, opener);
    if (!message || conv !== target) return;
    target.messages = mergeMessages(target.messages, [message]);
    renderMessages(true);
    pokeLive();
    announce('Template sent.');
  }
  function closeConversation() {
    if (conv) {
      if (conv.controller) conv.controller.abort();
      if (conv.attachment && conv.attachment.preview) URL.revokeObjectURL(conv.attachment.preview);
    }
    conv = null;
    if (ui) {
      ui.layout.classList.remove('wa-has-chat');
      ui.convPane.hidden = true;
      ui.placeholder.hidden = false;
      ui.messages.replaceChildren();
      for (const link of ui.chatList.querySelectorAll('[aria-current]')) link.removeAttribute('aria-current');
    }
    conversationOpenChanged(false);
  }
  function openConversation(customerId) {
    if (conv && conv.id === customerId) { ui.layout.classList.add('wa-has-chat'); maybeMarkRead(); return; }
    closeConversation();
    conv = { id: customerId, customer: null, messages: [], nextCursor: null, loaded: false, loading: false, shown: false, controller: null, bubbles: new Map(), attachment: null, sending: false, markedId: '', keepOffset: false, problem: '' };
    ui.layout.classList.add('wa-has-chat');
    ui.convPane.hidden = false;
    ui.placeholder.hidden = true;
    ui.newPill.hidden = true;
    ui.quick.hidden = true;
    ui.input.value = '';
    autosize();
    clearNode(ui.attachChip);
    setStatus(ui.convError, '', false);
    setStatus(ui.composeNote, '', false);
    renderHeader();
    renderComposer();
    renderMessages(true);
    renderChats();
    conversationOpenChanged(true);
    const target = conv;
    loadCustomer(target);
    loadMessages(target, false);
    ui.headName.focus({ preventScroll: true });
    if (waShared.canSend === null) {
      api('/whatsapp/status').then((data) => { waShared.canSend = data.canSend === true; if (conv) renderComposer(); }, () => {});
    }
  }

  function mount(root) {
    chats = { query: '', items: [], nextCursor: null, loading: false, error: '', version: 0, controller: null, stale: false };
    const layout = element('div', undefined, 'wa-layout');
    // Left: chat list
    const listPane = element('section', undefined, 'wa-list-pane');
    listPane.setAttribute('aria-label', 'Chats');
    const listHead = element('div', undefined, 'wa-list-head');
    listHead.append(element('h1', 'WhatsApp'));
    const search = element('input');
    search.type = 'search';
    search.placeholder = 'Search chats';
    search.maxLength = 200;
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search chats');
    const chatStatus = element('p', undefined, 'hint');
    chatStatus.setAttribute('role', 'status');
    const chatError = element('p', undefined, 'notice error');
    chatError.setAttribute('role', 'alert');
    chatError.hidden = true;
    const chatRetry = textButton('Try again', 'secondary', () => loadChats(false, false));
    chatRetry.hidden = true;
    const chatList = element('ul', undefined, 'wa-chat-list');
    const chatEmpty = element('p', undefined, 'wa-empty');
    chatEmpty.hidden = true;
    const chatMore = textButton('Load more', 'secondary', () => loadChats(true, false));
    chatMore.hidden = true;
    listPane.append(listHead, search, chatStatus, chatError, chatRetry, chatList, chatEmpty, chatMore);
    // Right: conversation
    const placeholder = element('section', undefined, 'wa-placeholder');
    placeholder.append(icon('chat'), element('p', 'Choose a chat to read and reply.'));
    const convPane = element('section', undefined, 'wa-conv');
    convPane.setAttribute('aria-label', 'Conversation');
    convPane.hidden = true;
    const head = element('header', undefined, 'wa-head');
    const back = iconButton('back', 'Back to chats', 'wa-back');
    back.addEventListener('click', () => { location.hash = '#whatsapp'; });
    const headAvatar = element('span', undefined, 'wa-head-avatar');
    const headText = element('div', undefined, 'wa-head-text');
    const headName = element('h2', undefined, 'wa-head-name');
    headName.tabIndex = -1;
    const headPhone = element('p', undefined, 'wa-head-phone');
    headText.append(headName, headPhone);
    const dial = element('a', undefined, 'icon-btn');
    dial.append(icon('phone'));
    dial.setAttribute('aria-label', 'Dial');
    dial.title = 'Dial';
    const details = iconButton('personAdd', 'Customer details');
    details.addEventListener('click', () => { if (conv && conv.customer) openCustomer(conv.id, details); });
    head.append(back, headAvatar, headText, dial, details);
    const convError = element('p', undefined, 'notice error');
    convError.setAttribute('role', 'alert');
    convError.hidden = true;
    const messages = element('div', undefined, 'wa-messages');
    messages.setAttribute('role', 'log');
    messages.setAttribute('aria-label', 'Messages');
    messages.tabIndex = 0;
    const olderButton = textButton('Load older messages', 'secondary wa-older', () => { olderButton.disabled = true; olderButton.textContent = 'Loading…'; if (conv) loadMessages(conv, true); });
    olderButton.hidden = true;
    const newPill = textButton('New messages', 'wa-pill', () => { messages.scrollTop = messages.scrollHeight; newPill.hidden = true; });
    newPill.hidden = true;
    messages.addEventListener('scroll', () => { if (atBottom()) newPill.hidden = true; if (messages.scrollTop < 40 && conv && conv.nextCursor && conv.loaded && !conv.loading) { conv.keepOffset = true; loadMessages(conv, true); } });
    // Composer
    const composer = element('div', undefined, 'wa-composer');
    const banner = element('div', undefined, 'wa-banner');
    banner.setAttribute('role', 'status');
    banner.append(element('p', WA_WINDOW_TEXT));
    const templateBtn = textButton('Send template', '', () => openTemplates(templateBtn), 'template');
    banner.append(templateBtn);
    const unavailable = element('p', 'WhatsApp sending is not configured. Ask your manager.', 'wa-banner');
    unavailable.hidden = true;
    const attachChip = element('div', undefined, 'wa-chip');
    attachChip.hidden = true;
    const quick = element('div', undefined, 'wa-quick');
    quick.hidden = true;
    const composerRow = element('form', undefined, 'wa-compose-row');
    composerRow.noValidate = true;
    const attachBtn = iconButton('paperclip', 'Attach a photo, video or document');
    const fileInput = element('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    fileInput.accept = attachAccept(['image', 'video', 'document']);
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { const file = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (file) chooseAttachment(file); });
    const quickBtn = iconButton('bolt', 'Quick replies');
    quickBtn.setAttribute('aria-haspopup', 'true');
    quickBtn.setAttribute('aria-expanded', 'false');
    quickBtn.addEventListener('click', toggleQuick);
    const templateInline = iconButton('template', 'Send a template');
    templateInline.addEventListener('click', () => openTemplates(templateInline));
    const input = element('textarea', undefined, 'wa-input');
    input.rows = 1;
    input.maxLength = 4096;
    input.placeholder = 'Type a message';
    input.setAttribute('aria-label', 'Message');
    const sendBtn = element('button', undefined, 'wa-send');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.title = 'Send message';
    sendBtn.append(icon('send'));
    composerRow.append(attachBtn, fileInput, quickBtn, templateInline, input, sendBtn);
    const composeNote = element('p', undefined, 'hint wa-compose-note');
    composeNote.setAttribute('role', 'status');
    composeNote.hidden = true;
    composer.append(banner, unavailable, quick, attachChip, composerRow, composeNote);
    convPane.append(head, convError, messages, newPill, composer);
    layout.append(listPane, placeholder, convPane);
    root.append(layout);
    ui = { layout, listPane, placeholder, convPane, chatList, chatStatus, chatError, chatRetry, chatEmpty, chatMore, messages, olderButton, newPill, banner, composerRow, unavailable, attachChip, attachBtn, quick, quickBtn, templateBtn, templateInline, input, sendBtn, composeNote, headName, headPhone, headAvatar, dial, details, convError };
    composerRow.addEventListener('submit', (event) => { event.preventDefault(); sendCurrent(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendCurrent(); }
      if (event.key === 'Escape' && !quick.hidden) { quick.hidden = true; quickBtn.setAttribute('aria-expanded', 'false'); }
    });
    input.addEventListener('input', autosize);
    search.addEventListener('input', debounce(() => {
      const value = search.value.trim();
      if (value === chats.query) return;
      chats.query = value;
      loadChats(false, false);
    }, 300));
    chatList.addEventListener('click', () => { /* Links change the hash; the router opens the chat. */ });
    loadChats(false, false);
  }
  function show(params) {
    if (!ui) return;
    if (chats.stale) loadChats(false, true);
    const id = params.parts[0];
    if (id) openConversation(id); else closeConversation();
  }
  function hide() {
    if (conv && conv.controller) conv.controller.abort();
    conversationOpenChanged(false);
  }
  // Called when the server reports a change: badge always, the visible list and conversation when shown.
  async function liveRefresh() {
    refreshUnread();
    if (!ui) return true;
    if (activeView !== 'whatsapp') { chats.stale = true; return true; }
    const results = await Promise.all([loadChats(false, true), conv ? pollConversation() : true]);
    return results.every((ok) => ok !== false);
  }
  lifecycle.liveChange.push(() => liveRefresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeMarkRead(); });
  return { mount, show, hide };
})();
`;

export const whatsappStyles = `
.wa-layout { display: grid; grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); height: calc(100vh - 112px); min-height: 460px; border: 1px solid var(--line); border-radius: 8px; background: var(--white); overflow: hidden; }
.wa-list-pane { display: flex; flex-direction: column; min-width: 0; padding: 12px; border-right: 1px solid var(--line); overflow-y: auto; }
.wa-list-head { margin-bottom: 8px; }
.wa-chat-list { margin: 8px -12px 0; padding: 0; list-style: none; }
.wa-chat { display: flex; align-items: center; gap: 12px; padding: 10px 12px; color: inherit; text-decoration: none; border-bottom: 1px solid var(--wa-line); }
.wa-chat:hover, .wa-chat[aria-current] { background: var(--wa-panel); }
.wa-chat-main { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 2px; }
.wa-chat-top, .wa-chat-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.wa-chat-name, .wa-chat-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-chat-preview { color: var(--wa-sub); font-size: 13px; }
.wa-chat-time { flex: 0 0 auto; color: var(--wa-sub); font-size: 11px; }
.wa-unread .wa-chat-time { color: var(--wa-green-dark); font-weight: 600; }
.wa-unread .wa-chat-name { font-weight: 800; }
.wa-empty { padding: 20px 8px; color: var(--muted); text-align: center; }
.wa-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: var(--wa-panel); color: var(--wa-sub); }
.wa-placeholder .icon { width: 56px; height: 56px; opacity: .5; }
.wa-conv { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--wa-bg); }
.wa-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--wa-panel); border-bottom: 1px solid var(--wa-line); }
.wa-head-text { flex: 1 1 auto; min-width: 0; }
.wa-head-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.wa-head-name:focus { outline: none; }
.wa-head-phone { margin: 0; color: var(--wa-sub); font-size: 12px; font-variant-numeric: tabular-nums; }
.wa-back { display: none; }
.wa-conv > .notice { margin: 8px; }
.wa-messages { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-height: 0; padding: 12px 6%; overflow-y: auto; }
.wa-older { align-self: center; margin-bottom: 8px; }
.wa-day { align-self: center; margin: 10px 0 4px; padding: 3px 10px; border-radius: 8px; background: #fff; color: var(--wa-sub); font-size: 12px; box-shadow: 0 1px 1px rgba(11, 20, 26, .13); }
.wa-msg { display: flex; max-width: 100%; }
.wa-msg.out { justify-content: flex-end; }
.wa-bubble { position: relative; max-width: min(560px, 86%); padding: 6px 9px 4px; border-radius: 8px; background: var(--wa-in); color: var(--wa-text); box-shadow: 0 1px 1px rgba(11, 20, 26, .13); overflow-wrap: anywhere; }
.wa-msg.out .wa-bubble { background: var(--wa-out); }
.wa-text { white-space: pre-wrap; font-size: 14px; }
.wa-tag { display: inline-block; margin-bottom: 2px; color: var(--wa-green-dark); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.wa-meta { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 2px; color: var(--wa-sub); font-size: 11px; }
.wa-mark .icon { width: 16px; height: 16px; }
.wa-read { color: #53bdeb; } .wa-mark.wa-failed { color: #c0392b; }
.wa-copy { width: 22px; height: 22px; min-height: 22px; opacity: 0; }
.wa-copy .icon { width: 14px; height: 14px; }
.wa-bubble:hover .wa-copy, .wa-copy:focus-visible { opacity: 1; }
.wa-send-failed { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; color: #b3261e; font-size: 12px; }
.wa-small { min-height: 26px; padding: 2px 8px; font-size: 12px; }
.wa-media-frame { position: relative; }
.wa-media img, .wa-media video { display: block; max-width: 100%; max-height: 320px; border-radius: 6px; }
.wa-media-btn { display: block; padding: 0; border: 0; background: transparent; }
.wa-media-btn:hover:not(:disabled) { background: transparent; }
.wa-media-dl { position: absolute; top: 4px; right: 4px; width: 28px; height: 28px; min-height: 28px; background: rgba(255, 255, 255, .85); }
.wa-media audio { max-width: 260px; }
.wa-media-gone { color: var(--wa-sub); font-style: italic; }
.wa-has-media { padding-top: 4px; }
.wa-doc-icon { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 6px; background: rgba(11, 20, 26, .07); }
.wa-media-document { display: flex; align-items: center; gap: 10px; min-width: 220px; }
.wa-doc-info { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.wa-doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-doc-size { color: var(--wa-sub); font-size: 11px; }
.wa-pill { position: absolute; bottom: 130px; left: 50%; transform: translateX(-50%); border-radius: 16px; background: var(--wa-green-dark); box-shadow: var(--shadow); }
.wa-composer { padding: 8px 12px 10px; background: var(--wa-panel); border-top: 1px solid var(--wa-line); }
.wa-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; margin: 0; padding: 8px 12px; border-radius: 8px; background: #fff3d9; color: #815615; font-size: 13px; }
.wa-banner p { margin: 0; }
.wa-compose-row { display: flex; align-items: flex-end; gap: 4px; }
.wa-input { flex: 1 1 auto; min-height: 40px; max-height: 160px; padding: 9px 12px; border: 0; border-radius: 20px; resize: none; background: var(--white); }
.wa-send { flex: 0 0 auto; width: 40px; height: 40px; min-height: 40px; padding: 0; border-radius: 50%; background: var(--wa-green-dark); }
.wa-send:hover:not(:disabled) { background: var(--wa-text); }
.wa-compose-note { margin: 4px 4px 0; }
.wa-chip { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; padding: 6px 8px; border-radius: 8px; background: var(--white); }
.wa-chip-thumb { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; }
.wa-chip-icon { display: inline-flex; align-items: center; justify-content: center; background: rgba(11, 20, 26, .07); }
.wa-chip-info { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.wa-chip-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-quick { display: grid; gap: 4px; max-height: 240px; margin-bottom: 6px; padding: 6px; overflow-y: auto; border-radius: 8px; background: var(--white); box-shadow: var(--shadow); }
.wa-quick-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 6px 10px; text-align: left; font-weight: 400; }
.wa-quick-preview { color: var(--muted); font-size: 12px; }
dialog.wa-tpl-dialog { width: min(900px, calc(100% - 20px)); }
.wa-tpl-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.wa-tpl-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 16px; }
.wa-tpl-side { display: grid; align-content: start; gap: 8px; min-width: 0; }
.wa-tpl-list { display: grid; gap: 6px; max-height: 50vh; overflow-y: auto; }
.wa-tpl-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 8px 10px; text-align: left; font-weight: 400; border-color: var(--line-strong); background: var(--white); color: inherit; }
.wa-tpl-item:hover:not(:disabled) { background: var(--hover); }
.wa-tpl-item[aria-pressed=true] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.wa-tpl-item.wa-disabled { opacity: .6; }
.wa-tpl-name { overflow-wrap: anywhere; }
.wa-tpl-sub, .wa-tpl-reason { color: var(--muted); font-size: 12px; }
.wa-tpl-snippet { color: var(--muted); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; }
.wa-tpl-detail { display: grid; align-content: start; gap: 10px; min-width: 0; }
.wa-tpl-preview { padding: 12px; border-radius: 8px; background: var(--wa-bg); }
.wa-tpl-form { display: grid; gap: 10px; }
.wa-var { background: #fff3a8; color: #6b4f00; border-radius: 3px; padding: 0 2px; }
.wa-tpl-header-img { display: block; max-width: 100%; max-height: 200px; border-radius: 6px; }
.wa-tpl-header-missing { padding: 12px; border-radius: 6px; background: rgba(11, 20, 26, .06); color: var(--wa-sub); font-size: 13px; }
.wa-tpl-header { font-weight: 700; }
.wa-tpl-footer { color: var(--wa-sub); font-size: 12px; }
.wa-tpl-btns { display: grid; gap: 4px; margin-top: 4px; }
.wa-tpl-btn { padding: 6px; border-radius: 8px; background: var(--white); color: #027eb5; text-align: center; font-weight: 600; }
dialog.wa-viewer { width: min(960px, calc(100% - 20px)); padding: 8px; background: #0b141a; }
dialog.wa-viewer img { display: block; max-width: 100%; max-height: calc(100vh - 100px); margin: 0 auto; }
.wa-viewer-bar { display: flex; justify-content: flex-end; gap: 4px; }
.wa-viewer-bar .icon-btn { color: #fff; }
@media (max-width: 900px) {
  .wa-layout { grid-template-columns: minmax(0, 1fr); height: calc(100vh - 120px); }
  .wa-placeholder { display: none; }
  .wa-conv { display: none; }
  .wa-has-chat .wa-list-pane { display: none; }
  .wa-has-chat .wa-conv { display: flex; }
  .wa-back { display: inline-flex; }
  .wa-messages { padding: 10px 8px; }
  .wa-tpl-columns { grid-template-columns: minmax(0, 1fr); }
}
`;
