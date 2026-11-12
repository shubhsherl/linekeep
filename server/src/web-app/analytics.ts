// Employee analytics view: the admin analytics page reduced to the signed-in employee's own calls.
// Both exports are concatenated into one browser script: keep them free of backticks and dollar-brace sequences,
// build DOM with createElement/textContent and style only through classes or CSSOM (no inline style attributes).

export const analyticsClient = String.raw`
views.analytics = (function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TYPES = ['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'answered_externally', 'unknown'];
  const TYPE_NAMES = { incoming: 'Incoming', outgoing: 'Outgoing', missed: 'Missed', rejected: 'Rejected', blocked: 'Blocked', voicemail: 'Voicemail', answered_externally: 'Answered externally', unknown: 'Unknown' };
  const SEGMENT_NAMES = { ...TYPE_NAMES, other: 'Other', connected: 'Connected', notConnected: 'Other not connected' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const METRIC_KEYS = ['total', 'connected', 'notConnected', 'uniqueContacts', 'talkSeconds', 'avgConnectedSeconds', 'incoming', 'incomingSeconds', 'outgoing', 'outgoingSeconds', 'missed', 'rejected', 'other', 'withRecording'];
  const CHART_NAMES = ['types', 'days', 'talk', 'heat', 'rate', 'length'];
  const TIME_STEPS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 432000, 864000, 1728000, 4320000];
  const PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month']];
  const PATTERNS = {
    outgoing: { path: 'M-1 1L1 -1M0 8L8 0M7 9L9 7', opacity: 0.5 },
    missed: { dots: [[2, 2], [6, 6]], opacity: 0.55 },
    rejected: { path: 'M-1 7L1 9M0 0L8 8M7 -1L9 1', opacity: 0.5 },
    blocked: { path: 'M0 2H8M0 6H8', opacity: 0.5 },
    voicemail: { path: 'M2 0V8M6 0V8', opacity: 0.5 },
    answered_externally: { path: 'M0 4H8M4 0V8', opacity: 0.5 },
    unknown: { squares: [[1, 1], [5, 5]], opacity: 0.5 },
    other: { path: 'M0 0L8 8M8 0L0 8', opacity: 0.45 },
    notConnected: { path: 'M0 0L8 8M8 0L0 8', opacity: 0.45 }
  };
  const IST_OFFSET_MS = 330 * 60000;
  const DAY_MS = 86400000;
  const STALE_MS = 300000;
  const TABS = [{ name: 'analytics', label: 'Analytics' }, { name: 'calls', label: 'Call logs' }];

  const ui = { tabs: {}, panels: {}, chart: {}, summary: {}, legend: {}, presets: {} };
  let state = null;
  let data = null;
  let version = 0;
  let controller = null;
  let loading = false;
  let needsLoad = false;
  let loadedAt = 0;
  let widthKey = '';
  let resizeTimer = 0;
  let animTimer = 0;
  let observer = null;
  let active = 'analytics';
  let shown = false;
  let mounted = false;
  let calls = null;

  // ---- Numbers and dates ----
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
    return { day: date.getUTCDate(), month: MONTHS[date.getUTCMonth()], year: date.getUTCFullYear(), weekday: date.getUTCDay() };
  }
  function dayFull(value) {
    const parts = dayParts(value);
    return WEEKDAYS_SHORT[parts.weekday] + ' ' + parts.day + ' ' + parts.month + ' ' + parts.year;
  }
  function dayLabel(value, withWeekday) {
    const parts = dayParts(value);
    return withWeekday ? WEEKDAYS_SHORT[parts.weekday] + ' ' + parts.day : parts.day + ' ' + parts.month;
  }
  function rangeText(from, to) {
    const a = dayParts(from);
    const b = dayParts(to);
    if (from === to) return b.day + ' ' + b.month + ' ' + b.year;
    if (a.year !== b.year) return a.day + ' ' + a.month + ' ' + a.year + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
    if (a.month !== b.month) return a.day + ' ' + a.month + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
    return a.day + ' to ' + b.day + ' ' + b.month + ' ' + b.year;
  }
  function presetRange(name) {
    const today = istToday();
    if (name === 'today') return { from: today, to: today };
    if (name === 'yesterday') { const day = shiftDay(today, -1); return { from: day, to: day }; }
    if (name === 'month') return { from: today.slice(0, 8) + '01', to: today };
    return { from: shiftDay(today, name === '30' ? -29 : -6), to: today };
  }
  function isPreset(name) { return PRESETS.some((item) => item[0] === name); }

  // ---- Filter state (kept in the hash query) ----
  function defaultState() {
    const range = presetRange('7');
    return { preset: '7', from: range.from, to: range.to, callTypes: [] };
  }
  function parseState(query) {
    const result = defaultState();
    const preset = query.preset;
    if (typeof preset === 'string' && isPreset(preset)) {
      const range = presetRange(preset);
      result.preset = preset;
      result.from = range.from;
      result.to = range.to;
    } else {
      const from = query.from;
      const to = query.to;
      const fromOk = !Number.isNaN(parseDay(from));
      const toOk = !Number.isNaN(parseDay(to));
      let nextFrom = result.from;
      let nextTo = result.to;
      if (fromOk && toOk) { nextFrom = from; nextTo = to; }
      else if (fromOk) { nextFrom = from; nextTo = shiftDay(from, 6); }
      else if (toOk) { nextTo = to; nextFrom = shiftDay(to, -6); }
      if (nextFrom <= nextTo && daysBetween(nextFrom, nextTo) <= 366) {
        if (fromOk || toOk) result.preset = null;
        result.from = nextFrom;
        result.to = nextTo;
      }
    }
    const wanted = String(query.callTypes || '').split(',');
    result.callTypes = TYPES.filter((type) => wanted.includes(type));
    return result;
  }
  function sameState(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function stateQuery(current) {
    const params = new URLSearchParams();
    if (current.preset) params.set('preset', current.preset);
    else { params.set('from', current.from); params.set('to', current.to); }
    if (current.callTypes.length) params.set('callTypes', current.callTypes.join(','));
    return params.toString().replaceAll('%2C', ',');
  }
  function apiQuery(current) {
    const params = new URLSearchParams({ from: current.from, to: current.to });
    if (current.callTypes.length) params.set('callTypes', current.callTypes.join(','));
    return params.toString();
  }
  function writeHash() { setHash('analytics?' + stateQuery(state)); }

  // ---- Response validation: structure is checked and every number is clamped to a non-negative integer ----
  function badAnalytics() { return new Error('The server returned unreadable analytics. Please refresh.'); }
  function readMetrics(raw) {
    if (!raw || typeof raw !== 'object') throw badAnalytics();
    const metrics = {};
    for (const key of METRIC_KEYS) metrics[key] = wholeNumber(raw[key]);
    return metrics;
  }
  function readAnalytics(raw) {
    if (!raw || typeof raw !== 'object' || !raw.range || !Array.isArray(raw.byType) || !Array.isArray(raw.byDay) ||
        !Array.isArray(raw.byHourWeekday) || !Array.isArray(raw.durationBuckets)) throw badAnalytics();
    const range = raw.range;
    for (const key of ['from', 'to', 'previousFrom', 'previousTo']) if (Number.isNaN(parseDay(range[key]))) throw badAnalytics();
    const result = {
      range: { from: range.from, to: range.to, previousFrom: range.previousFrom, previousTo: range.previousTo, days: wholeNumber(range.days) || daysBetween(range.from, range.to) },
      totals: readMetrics(raw.totals),
      previous: readMetrics(raw.previous),
      byType: [],
      byDay: [],
      cells: new Array(168).fill(0),
      buckets: []
    };
    const typeRows = new Map();
    for (const item of raw.byType) if (item && TYPES.includes(item.type)) typeRows.set(item.type, item);
    result.byType = TYPES.map((type) => ({ type, count: wholeNumber((typeRows.get(type) || {}).count), seconds: wholeNumber((typeRows.get(type) || {}).seconds) }));
    for (const item of raw.byDay) {
      if (!item || Number.isNaN(parseDay(item.date)) || !item.types || typeof item.types !== 'object') throw badAnalytics();
      const types = {};
      for (const type of TYPES) types[type] = { count: wholeNumber((item.types[type] || {}).count), seconds: wholeNumber((item.types[type] || {}).seconds) };
      result.byDay.push({ date: item.date, total: wholeNumber(item.total), connected: wholeNumber(item.connected), talkSeconds: wholeNumber(item.talkSeconds), types });
    }
    for (const item of raw.byHourWeekday) {
      if (item && Number.isInteger(item.weekday) && item.weekday >= 0 && item.weekday <= 6 && Number.isInteger(item.hour) && item.hour >= 0 && item.hour <= 23) {
        result.cells[item.weekday * 24 + item.hour] = wholeNumber(item.count);
      }
    }
    for (const item of raw.durationBuckets) {
      if (!item || typeof item.label !== 'string') throw badAnalytics();
      result.buckets.push({ key: String(item.key), label: item.label.slice(0, 24), count: wholeNumber(item.count) });
    }
    return result;
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
    const node = svgEl('text', { x: r1(x), y: r1(y), class: 'an-ch-text' + (className ? ' ' + className : ''), 'text-anchor': anchor || 'start' }, parent);
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
    const svg = svgEl('svg', { class: 'an-chart-svg', width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', focusable: 'false' });
    host.append(svg);
    return svg;
  }
  function finishChart(name, svg, title, summary) {
    if (svg) svg.setAttribute('aria-label', title + '. ' + summary);
    ui.summary[name].textContent = summary;
  }
  function chartMessage(name, text) {
    ui.chart[name].replaceChildren(element('p', text, 'an-chart-empty'));
    ui.summary[name].textContent = '';
  }
  function hasPattern(type) { return Object.hasOwn(PATTERNS, type); }
  function swatch(type) {
    const svg = svgEl('svg', { width: 12, height: 12, viewBox: '0 0 12 12', class: 'an-sw an-t-' + type, 'aria-hidden': 'true', focusable: 'false' });
    svgEl('rect', { x: 0.5, y: 0.5, width: 11, height: 11, rx: 2, class: 'an-seg' }, svg);
    if (hasPattern(type)) svgEl('rect', { x: 0.5, y: 0.5, width: 11, height: 11, rx: 2, fill: 'url(#an-pat-' + type + ')' }, svg);
    return svg;
  }
  function buildLegend(name, items) {
    const host = ui.legend[name];
    host.replaceChildren();
    for (const item of items) {
      const entry = element('span', undefined, 'an-legend-item');
      if (item.line) {
        const icon = svgEl('svg', { width: 18, height: 12, viewBox: '0 0 18 12', 'aria-hidden': 'true', focusable: 'false' });
        svgEl('path', { d: 'M1 6H17', class: 'an-rate-line' }, icon);
        svgEl('circle', { cx: 9, cy: 6, r: 3, class: 'an-rate-dot' }, icon);
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
    svgEl('rect', { ...box, class: 'an-seg an-t-' + type }, group);
    if (hasPattern(type) && w >= 7 && h >= 7) svgEl('rect', { ...box, fill: 'url(#an-pat-' + type + ')', 'pointer-events': 'none' }, group);
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
    const step = TIME_STEPS.find((candidate) => candidate >= raw) || TIME_STEPS[TIME_STEPS.length - 1];
    return { step, top: Math.max(step, Math.ceil(max / step) * step) };
  }
  function drawYAxis(svg, left, top, plotW, plotH, scale, format) {
    for (let value = 0; value <= scale.top + 1e-9; value += scale.step) {
      const y = top + plotH - (value / scale.top) * plotH;
      svgEl('line', { x1: left, x2: left + plotW, y1: r1(y), y2: r1(y), class: value === 0 ? 'an-ch-axis' : 'an-ch-grid' }, svg);
      svgText(svg, left - 6, y + 3.5, format(value), 'an-ch-muted', 'end');
    }
  }
  function drawDayLabels(svg, days, left, slot, baseY) {
    const short = days.length <= 10;
    const every = Math.max(1, Math.ceil((short ? 42 : 48) / slot));
    days.forEach((day, index) => {
      if (index % every === 0) svgText(svg, left + index * slot + slot / 2, baseY + 15, dayLabel(day.date, short), 'an-ch-muted', 'middle', dayFull(day.date));
    });
  }
  function busiest(items, value) {
    let best = null;
    for (const item of items) if (!best || value(item) > value(best)) best = item;
    return best;
  }

  // ---- Charts ----
  function renderTypesChart(result) {
    const host = ui.chart.types;
    const width = hostWidth(host);
    const labelW = Math.round(Math.min(160, Math.max(110, width * 0.38)));
    const valueW = 100;
    const barX = labelW + 6;
    const barMax = Math.max(30, width - barX - valueW);
    const rowH = 30;
    const pad = 4;
    const total = result.totals.total;
    const maxCount = Math.max(1, ...result.byType.map((row) => row.count));
    const svg = newChart(host, width, result.byType.length * rowH + pad * 2);
    result.byType.forEach((row, index) => {
      const y = pad + index * rowH;
      const mid = y + rowH / 2 + 4;
      const group = svgEl('g', {}, svg);
      svgTitle(group, TYPE_NAMES[row.type] + ': ' + fmtCount(row.count) + ' calls · talk time ' + talkText(row.seconds));
      const icon = svgEl('g', { transform: 'translate(0 ' + r1(y + rowH / 2 - 6) + ')' }, group);
      icon.append(swatch(row.type));
      svgText(group, 18, mid, fitText(TYPE_NAMES[row.type], labelW - 18), row.count ? '' : 'an-ch-muted', 'start', TYPE_NAMES[row.type]);
      svgEl('rect', { x: barX, y: y + (rowH - 14) / 2, width: barMax, height: 14, rx: 3, class: 'an-track' }, group);
      segment(group, row.type, barX, y + (rowH - 14) / 2, row.count / maxCount * barMax, 14, TYPE_NAMES[row.type] + ': ' + fmtCount(row.count), 'an-grow-x');
      svgText(group, width, mid, row.count ? fmtCount(row.count) + ' · ' + percentText(row.count, total) : '0', row.count ? 'an-ch-strong' : 'an-ch-muted', 'end');
    });
    const ranked = result.byType.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
    const lead = ranked[0];
    const second = ranked[1];
    finishChart('types', svg, 'Calls by type', lead
      ? TYPE_NAMES[lead.type] + ' made up ' + percentText(lead.count, total) + ' of calls (' + fmtCount(lead.count) + ' of ' + fmtCount(total) + ').' +
        (second ? ' Next: ' + TYPE_NAMES[second.type] + ' (' + percentText(second.count, total) + ').' : '')
      : 'No calls by type.');
  }

  function renderDaysChart(result) {
    const host = ui.chart.days;
    const days = result.byDay;
    const used = TYPES.filter((type) => days.some((day) => day.types[type].count > 0));
    buildLegend('days', used.map((type) => ({ type, label: TYPE_NAMES[type] })).concat([{ line: true, label: 'Connect rate (right axis)' }]));
    if (!days.length) return chartMessage('days', 'No days to chart.');
    const width = hostWidth(host);
    const left = 34;
    const right = 40;
    const top = 16;
    const bottom = 28;
    const height = width < 420 ? 220 : 260;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const stackSum = (day) => TYPES.reduce((sum, type) => sum + day.types[type].count, 0);
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
      for (const type of TYPES) {
        const count = day.types[type].count;
        if (!count) continue;
        const h = count / scale.top * plotH;
        y -= h;
        segment(svg, type, x, y, barW, h, dayFull(day.date) + ' · ' + TYPE_NAMES[type] + ': ' + fmtCount(count) + ' ' + plural(count, 'call', 'calls'), 'an-grow-y');
      }
      if (!stackSum(day)) {
        const hit = svgEl('rect', { x: r1(left + index * slot), y: top, width: r1(slot), height: plotH, fill: 'transparent' }, svg);
        svgTitle(hit, dayFull(day.date) + ' · no calls');
      } else if (slot >= 26 && days.length <= 16) {
        svgText(svg, centre, y - 3, fmtCount(day.total), 'an-ch-strong', 'middle');
      }
      points.push(day.total > 0 ? { x: centre, rate: day.connected / day.total, day } : null);
    });
    for (const ratio of [0, 50, 100]) svgText(svg, left + plotW + 6, top + plotH - ratio / 100 * plotH + 3.5, ratio + '%', 'an-ch-muted');
    let path = '';
    points.forEach((point, index) => {
      if (!point) return;
      path += (points[index - 1] ? 'L' : 'M') + r1(point.x) + ' ' + r1(top + plotH - Math.min(1, point.rate) * plotH) + ' ';
    });
    if (path) svgEl('path', { d: path.trim(), class: 'an-rate-line' }, svg);
    points.forEach((point, index) => {
      if (!point) return;
      const isolated = !points[index - 1] && !points[index + 1];
      if (days.length > 45 && !isolated) return;
      const dot = svgEl('circle', { cx: r1(point.x), cy: r1(top + plotH - Math.min(1, point.rate) * plotH), r: 3.5, class: 'an-rate-dot' }, svg);
      svgTitle(dot, dayFull(point.day.date) + ' · connect rate ' + rateText(point.rate * 100) + ' (' + fmtCount(point.day.connected) + ' of ' + fmtCount(point.day.total) + ' connected)');
    });
    drawDayLabels(svg, days, left, slot, top + plotH);
    const peak = busiest(days, (day) => day.total);
    const average = r1(result.totals.total / Math.max(1, days.length));
    finishChart('days', svg, 'Calls by day', 'Busiest day: ' + dayFull(peak.date) + ' with ' + fmtCount(peak.total) + ' ' + plural(peak.total, 'call', 'calls') + '. Average ' + average.toLocaleString() + ' calls a day; ' +
      rateText(rateOf(result.totals.connected, result.totals.total)) + ' of calls connected over the period.');
  }

  function renderTalkChart(result) {
    const host = ui.chart.talk;
    const days = result.byDay.map((day) => {
      const incoming = day.types.incoming.seconds;
      const outgoing = day.types.outgoing.seconds;
      return { date: day.date, incoming, outgoing, other: Math.max(0, day.talkSeconds - incoming - outgoing), total: Math.max(day.talkSeconds, incoming + outgoing) };
    });
    const keys = ['incoming', 'outgoing', 'other'];
    const sums = { incoming: 0, outgoing: 0, other: 0 };
    for (const day of days) for (const key of keys) sums[key] += day[key];
    buildLegend('talk', keys.filter((key) => sums[key] > 0).map((key) => ({ type: key, label: key === 'other' ? 'Other types' : SEGMENT_NAMES[key] })));
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
        segment(svg, key, x, y, barW, h, dayFull(day.date) + ' · ' + (key === 'other' ? 'Other types' : SEGMENT_NAMES[key]) + ': ' + talkText(day[key]), 'an-grow-y');
      }
      if (!day.total) {
        const hit = svgEl('rect', { x: r1(left + index * slot), y: top, width: r1(slot), height: plotH, fill: 'transparent' }, svg);
        svgTitle(hit, dayFull(day.date) + ' · no talk time');
      } else if (slot >= 40 && days.length <= 12) {
        svgText(svg, left + index * slot + slot / 2, y - 3, axisTime(day.total), 'an-ch-strong', 'middle', talkText(day.total));
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
  function renderHeatChart(result) {
    const host = ui.chart.heat;
    const counts = result.cells;
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
    svgText(svg, 0, top - 7, 'IST', 'an-ch-muted');
    const every = cw >= 22 ? 1 : cw >= 14 ? 2 : 3;
    for (let hour = 0; hour < 24; hour += every) svgText(svg, leftW + hour * cw + cw / 2, top - 7, pad2(hour), 'an-ch-muted', 'middle');
    const hourTotals = new Array(24).fill(0);
    const dayTotals = new Array(7).fill(0);
    let peak = { weekday: 1, hour: 0, count: -1, row: 0 };
    WEEKDAY_ORDER.forEach((weekday, row) => {
      const y = top + row * ch;
      svgText(svg, leftW - 6, y + ch / 2 + 3.5, WEEKDAYS_SHORT[weekday], 'an-ch-muted', 'end', WEEKDAYS[weekday]);
      for (let hour = 0; hour < 24; hour++) {
        const count = counts[weekday * 24 + hour];
        hourTotals[hour] += count;
        dayTotals[weekday] += count;
        if (count > peak.count) peak = { weekday, hour, count, row };
        const x = leftW + hour * cw;
        const cell = svgEl('g', {}, svg);
        svgTitle(cell, WEEKDAYS[weekday] + ' ' + hourRange(hour) + ' IST · ' + fmtCount(count) + ' ' + plural(count, 'call', 'calls'));
        svgEl('rect', { x: r1(x), y, width: r1(Math.max(1, cw - 1)), height: ch - 1, rx: 2, fill: heatColor(count, max) }, cell);
        if (cw >= 24 && count > 0) svgText(cell, x + cw / 2, y + ch / 2 + 3.5, fmtCount(count), 'an-ch-seg-label' + (count / max > 0.45 ? ' an-ch-light' : ''), 'middle');
      }
    });
    svgEl('rect', { x: r1(leftW + peak.hour * cw - 1), y: top + peak.row * ch - 1, width: r1(Math.max(2, cw + 1)), height: ch + 1, rx: 3, class: 'an-heat-peak' }, svg);
    const steps = [0, 0.1, 0.3, 0.55, 0.8, 1];
    svgText(svg, leftW, legendY + 10, '0', 'an-ch-muted', 'end');
    steps.forEach((ratio, index) => svgEl('rect', { x: leftW + 6 + index * 22, y: legendY, width: 21, height: 13, rx: 2, fill: heatColor(ratio ? ratio * max : 0, max) }, svg));
    const afterScale = leftW + 6 + steps.length * 22 + 6;
    svgText(svg, afterScale, legendY + 10, fmtCount(max) + ' ' + plural(max, 'call', 'calls') + ' in a slot', 'an-ch-muted');
    const keyX = stacked ? leftW + 6 : afterScale + 118;
    const keyY = stacked ? legendY + 24 : legendY;
    svgEl('rect', { x: keyX, y: keyY, width: 21, height: 13, rx: 3, class: 'an-heat-peak' }, svg);
    svgText(svg, keyX + 28, keyY + 10, 'Outlined = busiest slot', 'an-ch-muted');
    const bestHour = hourTotals.indexOf(Math.max(...hourTotals));
    const bestDay = dayTotals.indexOf(Math.max(...dayTotals));
    finishChart('heat', svg, 'When calls happen', 'Busiest slot: ' + WEEKDAYS[peak.weekday] + ' ' + hourRange(peak.hour) + ' IST with ' + fmtCount(peak.count) + ' ' + plural(peak.count, 'call', 'calls') +
      '. Busiest weekday: ' + WEEKDAYS[bestDay] + ' (' + fmtCount(dayTotals[bestDay]) + '). Busiest hour: ' + hourRange(bestHour) + ' (' + fmtCount(hourTotals[bestHour]) + ').');
  }

  // Answer and miss rate: how the period's calls split into connected and not connected, next to the previous period.
  function renderRateChart(result) {
    const host = ui.chart.rate;
    const rows = [
      { label: 'This period', range: rangeText(result.range.from, result.range.to), metrics: result.totals },
      { label: 'Previous period', range: rangeText(result.range.previousFrom, result.range.previousTo), metrics: result.previous }
    ];
    const keys = ['connected', 'missed', 'rejected', 'notConnected'];
    const parts = (metrics) => {
      const missed = Math.min(metrics.missed, metrics.notConnected);
      const rejected = Math.min(metrics.rejected, Math.max(0, metrics.notConnected - missed));
      return { connected: metrics.connected, missed, rejected, notConnected: Math.max(0, metrics.notConnected - missed - rejected) };
    };
    buildLegend('rate', keys.filter((key) => rows.some((row) => parts(row.metrics)[key] > 0)).map((key) => ({ type: key, label: SEGMENT_NAMES[key] })));
    const width = hostWidth(host);
    const rowH = 66;
    const svg = newChart(host, width, rows.length * rowH + 4);
    rows.forEach((row, index) => {
      const y = 4 + index * rowH;
      const metrics = row.metrics;
      const split = parts(metrics);
      const rate = rateOf(metrics.connected, metrics.total);
      const group = svgEl('g', {}, svg);
      svgTitle(group, row.label + ' (' + row.range + '): ' + (metrics.total ? rateText(rate) + ' connect rate · ' + fmtCount(metrics.connected) + ' of ' + fmtCount(metrics.total) + ' calls connected · missed ' + fmtCount(split.missed) + ' · rejected ' + fmtCount(split.rejected) +
        ' · average length ' + (metrics.avgConnectedSeconds ? talkText(metrics.avgConnectedSeconds) : 'not available') : 'no calls'));
      svgText(group, 0, y + 12, fitText(row.label + ' · ' + row.range, width - 64), '', 'start', row.label + ' · ' + row.range);
      svgText(group, width, y + 12, metrics.total ? rateText(rate) : '–', metrics.total ? 'an-ch-strong' : 'an-ch-muted', 'end');
      svgEl('rect', { x: 0, y: y + 19, width, height: 14, rx: 4, class: 'an-track' }, group);
      let x = 0;
      for (const key of keys) {
        const w = metrics.total ? split[key] / metrics.total * width : 0;
        segment(group, key, x, y + 19, w, 14, row.label + ' · ' + SEGMENT_NAMES[key] + ': ' + fmtCount(split[key]) + ' (' + percentText(split[key], metrics.total) + ')', 'an-grow-x');
        x += w;
      }
      svgText(group, 0, y + 50, metrics.total
        ? fmtCount(metrics.connected) + ' of ' + fmtCount(metrics.total) + ' connected · missed ' + percentText(split.missed, metrics.total) + ' · avg ' + (metrics.avgConnectedSeconds ? talkText(metrics.avgConnectedSeconds) : 'n/a')
        : 'No calls', 'an-ch-muted');
    });
    const now = result.totals;
    const before = result.previous;
    finishChart('rate', svg, 'Answer and miss rate', now.total
      ? 'Connect rate ' + rateText(rateOf(now.connected, now.total)) + ' (' + fmtCount(now.connected) + ' of ' + fmtCount(now.total) + ' calls); missed ' + percentText(now.missed, now.total) + ', rejected ' + percentText(now.rejected, now.total) +
        '. Previous period: ' + (before.total ? rateText(rateOf(before.connected, before.total)) : 'no calls') + '. Rates on few calls swing widely, so check the counts.'
      : 'No calls in this period.');
  }

  function renderLengthChart(result) {
    const host = ui.chart.length;
    const buckets = result.buckets;
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
      if (h > 0) svgEl('rect', { x: r1(centre - barW / 2), y: r1(y), width: r1(barW), height: r1(h), rx: 2, class: 'an-bar-blue an-grow-y' }, group);
      svgText(group, centre, y - 5, fmtCount(bucket.count), 'an-ch-strong', 'middle');
      svgText(group, centre, top + plotH + 15, bucket.label, '', 'middle');
      svgText(group, centre, top + plotH + 29, percentText(bucket.count, total), 'an-ch-muted', 'middle');
    });
    const lead = busiest(buckets, (bucket) => bucket.count);
    finishChart('length', svg, 'Call length distribution', 'Most connected calls (' + percentText(lead.count, total) + ', ' + fmtCount(lead.count) + ' of ' + fmtCount(total) + ') lasted ' + lead.label + '.');
  }

  function visibleWidths() { return CHART_NAMES.map((name) => ui.chart[name].clientWidth); }
  function renderCharts() {
    if (!data || ui.charts.hidden || active !== 'analytics') return;
    const widths = visibleWidths();
    if (widths.some((width) => width < 1)) return;
    widthKey = widths.join(',');
    renderTypesChart(data);
    renderDaysChart(data);
    renderTalkChart(data);
    renderHeatChart(data);
    renderRateChart(data);
    renderLengthChart(data);
  }

  // ---- KPI cards ----
  const KPI_DEFS = [
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
    const card = element('article', undefined, 'an-kpi');
    const label = element('h4', undefined, 'an-kpi-label');
    if (def.type) label.append(swatch(def.type));
    label.append(def.label);
    const current = def.value(totals);
    const prior = def.value(previous);
    card.append(label, element('p', def.format(current), 'an-kpi-value'));
    if (def.sub) card.append(element('p', def.sub(totals), 'an-kpi-sub'));
    const row = element('p', undefined, 'an-kpi-delta');
    const delta = computeDelta(current, prior, def.delta);
    if (delta) {
      let tone = 'flat';
      if (delta.dir !== 'flat' && def.tone !== 'neutral') tone = (delta.dir === 'up') === (def.tone === 'up-good') ? 'good' : 'bad';
      const badge = element('span', undefined, 'an-delta an-delta-' + tone);
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
  function renderKpis(result) {
    const fragment = document.createDocumentFragment();
    for (const def of KPI_DEFS) fragment.append(kpiCard(def, result.totals, result.previous));
    const peak = result.totals.total ? busiest(result.byDay, (day) => day.total) : null;
    const card = element('article', undefined, 'an-kpi');
    card.append(element('h4', 'Busiest day', 'an-kpi-label'), element('p', peak ? dayLabel(peak.date, true) + ' ' + dayParts(peak.date).month : '–', 'an-kpi-value'),
      element('p', peak ? fmtCount(peak.total) + ' ' + plural(peak.total, 'call', 'calls') + ' · ' + fmtCount(peak.connected) + ' connected' : 'No calls', 'an-kpi-sub'),
      element('p', peak ? dayFull(peak.date) : '', 'an-kpi-delta'));
    fragment.append(card);
    ui.kpis.replaceChildren(fragment);
  }

  function setTitle(from, to) { ui.title.textContent = rangeText(from, to) + ' · Total days: ' + daysBetween(from, to); }
  function renderAnalytics(animate) {
    setTitle(data.range.from, data.range.to);
    ui.subtitle.textContent = 'Compared with ' + rangeText(data.range.previousFrom, data.range.previousTo) + ', the ' + data.range.days + ' ' + plural(data.range.days, 'day', 'days') + ' before. Days run midnight to midnight IST.';
    renderKpis(data);
    const empty = data.totals.total === 0;
    ui.empty.hidden = !empty;
    ui.charts.hidden = empty;
    if (empty) return;
    clearTimeout(animTimer);
    ui.content.classList.toggle('an-anim', animate);
    if (animate) animTimer = setTimeout(() => ui.content.classList.remove('an-anim'), 900);
    renderCharts();
  }

  // ---- Loading ----
  function setBusy(busy) {
    loading = busy;
    ui.results.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function showError(text) {
    ui.errorText.textContent = text;
    ui.errorBox.hidden = !text;
  }
  function cancelLoad() {
    version++;
    if (controller) controller.abort();
    controller = null;
    if (!loading) return;
    setBusy(false);
    needsLoad = true;
    ui.skeleton.hidden = true;
    ui.content.classList.remove('an-is-loading');
    ui.status.textContent = '';
  }
  async function load() {
    const mine = ++version;
    if (controller) controller.abort();
    controller = new AbortController();
    const requested = state;
    setBusy(true);
    needsLoad = false;
    showError('');
    setTitle(requested.from, requested.to);
    ui.status.textContent = 'Loading call analytics…';
    ui.skeleton.hidden = Boolean(data);
    ui.content.classList.toggle('an-is-loading', Boolean(data));
    try {
      const raw = await api('/analytics?' + apiQuery(requested), { signal: controller.signal });
      if (mine !== version) return;
      data = readAnalytics(raw);
      loadedAt = Date.now();
      ui.skeleton.hidden = true;
      ui.content.hidden = false;
      ui.content.classList.remove('an-is-loading');
      renderAnalytics(true);
      ui.status.textContent = fmtCount(data.totals.total) + ' ' + plural(data.totals.total, 'call', 'calls') + ' · ' + rangeText(data.range.from, data.range.to) + ' · IST';
    } catch (error) {
      if (mine !== version || (error && error.name === 'AbortError') || (error && error.status === 401)) return;
      data = null;
      loadedAt = 0;
      ui.skeleton.hidden = true;
      ui.content.hidden = true;
      ui.status.textContent = 'Call analytics could not be loaded.';
      showError(errorMessage(error));
    } finally {
      if (mine === version) setBusy(false);
    }
  }

  // ---- Filters ----
  function checkedTypes() { return Array.from(ui.typeChoices.querySelectorAll('input:checked'), (input) => input.value); }
  function updateTypesLabel() {
    const types = checkedTypes();
    ui.typesLabel.textContent = !types.length ? 'All types' : types.length === 1 ? TYPE_NAMES[types[0]] : types.length + ' types';
  }
  function renderTypeChoices(selected) {
    const fragment = document.createDocumentFragment();
    for (const type of TYPES) {
      const label = element('label', undefined, 'an-choice');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = type;
      box.checked = selected.includes(type);
      label.append(box, swatch(type), element('span', TYPE_NAMES[type]));
      fragment.append(label);
    }
    ui.typeChoices.replaceChildren(fragment);
    updateTypesLabel();
  }
  function updatePresetState() {
    const from = ui.from.value;
    const to = ui.to.value;
    for (const [name] of PRESETS) {
      const range = presetRange(name);
      ui.presets[name].setAttribute('aria-pressed', String(range.from === from && range.to === to));
    }
  }
  function syncControls() {
    ui.from.value = state.from;
    ui.to.value = state.to;
    renderTypeChoices(state.callTypes);
    updatePresetState();
    setTitle(state.from, state.to);
  }
  function filterProblem(text, focusNode) {
    ui.filterError.textContent = text;
    ui.filterError.hidden = !text;
    if (text && focusNode) focusNode.focus();
  }
  function applyFilters(range) {
    filterProblem('');
    const from = range ? range.from : ui.from.value;
    const to = range ? range.to : ui.to.value;
    if (range) { ui.from.value = from; ui.to.value = to; }
    let problem = '';
    let focus = ui.from;
    if (Number.isNaN(parseDay(from))) problem = 'Choose a valid start date.';
    else if (Number.isNaN(parseDay(to))) { problem = 'Choose a valid end date.'; focus = ui.to; }
    else if (from > to) problem = 'The start date must be on or before the end date.';
    else if (daysBetween(from, to) > 366) problem = 'Choose a range of 366 days or fewer.';
    if (problem) return filterProblem(problem, focus);
    state = { preset: range && range.preset ? range.preset : null, from, to, callTypes: TYPES.filter((type) => checkedTypes().includes(type)) };
    ui.typesMenu.open = false;
    writeHash();
    syncControls();
    load();
  }
  function onDocumentClick(event) {
    if (ui.typesMenu.open && !ui.typesMenu.contains(event.target)) ui.typesMenu.open = false;
  }

  // ---- Build the DOM ----
  function patternDefs() {
    const svg = svgEl('svg', { class: 'an-defs', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
    const defs = svgEl('defs', {}, svg);
    for (const type of Object.keys(PATTERNS)) {
      const spec = PATTERNS[type];
      const pattern = svgEl('pattern', { id: 'an-pat-' + type, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, defs);
      if (spec.path) svgEl('path', { d: spec.path, stroke: '#17352f', 'stroke-opacity': spec.opacity, 'stroke-width': 1, fill: 'none' }, pattern);
      for (const dot of spec.dots || []) svgEl('circle', { cx: dot[0], cy: dot[1], r: 1.1, fill: '#17352f', 'fill-opacity': spec.opacity }, pattern);
      for (const square of spec.squares || []) svgEl('rect', { x: square[0], y: square[1], width: 2, height: 2, fill: '#17352f', 'fill-opacity': spec.opacity }, pattern);
    }
    return svg;
  }
  function chartCard(name, title, hint, options) {
    const card = element('article', undefined, 'panel an-chart-card' + (options.wide ? ' an-chart-wide' : ''));
    const headingId = 'an-heading-' + name;
    const heading = element('h3', title);
    heading.id = headingId;
    card.setAttribute('aria-labelledby', headingId);
    const head = element('div', undefined, 'an-chart-head');
    head.append(heading, element('p', hint, 'hint'));
    card.append(head);
    if (options.legend) {
      ui.legend[name] = element('div', undefined, 'an-legend');
      card.append(ui.legend[name]);
    }
    ui.chart[name] = element('div', undefined, 'an-chart-body');
    ui.summary[name] = element('p', undefined, 'an-chart-summary');
    card.append(ui.chart[name], ui.summary[name]);
    return card;
  }
  function buildHead() {
    const head = element('section', undefined, 'panel an-head');
    head.setAttribute('aria-label', 'Date range and call types');
    const top = element('div', undefined, 'section-heading');
    const titles = element('div');
    ui.title = element('h3', undefined, 'an-title');
    ui.subtitle = element('p', undefined, 'muted');
    titles.append(ui.title, ui.subtitle);
    ui.refresh = element('button', 'Refresh', 'secondary');
    ui.refresh.type = 'button';
    ui.refresh.addEventListener('click', () => { if (state) load(); });
    top.append(titles, ui.refresh);

    const presets = element('div', undefined, 'an-preset-row');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Quick date ranges');
    for (const [name, text] of PRESETS) {
      const chip = element('button', text, 'secondary an-chip');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => applyFilters({ ...presetRange(name), preset: name }));
      ui.presets[name] = chip;
      presets.append(chip);
    }

    const form = element('form');
    form.noValidate = true;
    form.addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
    const grid = element('div', undefined, 'an-filters');
    const fromLabel = element('label', 'From');
    ui.from = document.createElement('input');
    ui.from.type = 'date';
    ui.from.required = true;
    ui.from.addEventListener('input', updatePresetState);
    fromLabel.append(ui.from);
    const toLabel = element('label', 'To');
    ui.to = document.createElement('input');
    ui.to.type = 'date';
    ui.to.required = true;
    ui.to.addEventListener('input', updatePresetState);
    toLabel.append(ui.to);

    const field = element('div', undefined, 'an-multi-field');
    const caption = element('span', 'Call type', 'an-field-label');
    caption.id = 'an-types-caption';
    ui.typesMenu = element('details', undefined, 'an-multi');
    const summary = element('summary');
    ui.typesLabel = element('span', 'All types');
    ui.typesLabel.id = 'an-types-label';
    summary.setAttribute('aria-labelledby', 'an-types-caption an-types-label');
    summary.append(ui.typesLabel);
    const menu = element('div', undefined, 'an-multi-menu');
    ui.typeChoices = element('div', undefined, 'an-choice-list');
    ui.typeChoices.addEventListener('change', updateTypesLabel);
    const actions = element('div', undefined, 'actions');
    const clear = element('button', 'Show all types', 'secondary');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      for (const box of ui.typeChoices.querySelectorAll('input')) box.checked = false;
      updateTypesLabel();
    });
    actions.append(clear);
    menu.append(ui.typeChoices, actions);
    ui.typesMenu.append(summary, menu);
    ui.typesMenu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !ui.typesMenu.open) return;
      event.preventDefault();
      ui.typesMenu.open = false;
      summary.focus();
    });
    field.append(caption, ui.typesMenu);

    const apply = element('div', undefined, 'an-apply');
    apply.append(element('button', 'Apply'));
    apply.firstChild.type = 'submit';
    grid.append(fromLabel, toLabel, field, apply);
    ui.filterError = element('p', undefined, 'error-text');
    ui.filterError.setAttribute('role', 'alert');
    ui.filterError.hidden = true;
    form.append(grid, element('p', 'Days run midnight to midnight India time (IST, UTC+05:30), both dates included, up to 366 days. Leave Call type empty to include every type. The view is saved in the page address so you can bookmark it.', 'hint'), ui.filterError);
    head.append(top, presets, form);
    return head;
  }
  function buildResults() {
    ui.results = element('section', undefined, 'an-results');
    ui.results.setAttribute('aria-label', 'Call analytics results');
    ui.results.setAttribute('aria-busy', 'false');
    ui.status = element('p', undefined, 'an-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.status.setAttribute('aria-atomic', 'true');
    ui.errorBox = element('div', undefined, 'notice error an-error');
    ui.errorBox.setAttribute('role', 'alert');
    ui.errorBox.hidden = true;
    ui.errorText = element('p', undefined, 'an-error-text');
    const retry = element('button', 'Retry', 'secondary');
    retry.type = 'button';
    retry.addEventListener('click', () => { if (state) load(); });
    ui.errorBox.append(ui.errorText, retry);

    ui.skeleton = element('div', undefined, 'an-skeleton');
    ui.skeleton.setAttribute('aria-hidden', 'true');
    ui.skeleton.hidden = true;
    const skeletonGrid = element('div', undefined, 'an-kpi-grid');
    for (let index = 0; index < 8; index++) skeletonGrid.append(element('div', undefined, 'an-kpi an-skel'));
    ui.skeleton.append(skeletonGrid, element('div', undefined, 'panel an-skel an-skel-chart'));

    ui.content = element('div', undefined, 'an-content');
    ui.content.hidden = true;
    ui.kpis = element('div', undefined, 'an-kpi-grid');
    ui.empty = element('section', undefined, 'panel empty-state');
    ui.empty.hidden = true;
    ui.empty.append(element('h3', 'No calls in this period'), element('p', 'No calls matched these dates and filters. Try a wider date range, or choose Show all types. Charts appear as soon as there is at least one call.'));
    ui.charts = element('div', undefined, 'an-chart-grid');
    ui.charts.append(
      chartCard('types', 'Calls by type', 'All eight call types', {}),
      chartCard('rate', 'Answer and miss rate', 'Connected calls ÷ all calls', { legend: true }),
      chartCard('days', 'Calls by day', 'Columns: calls by type · line: connect rate', { legend: true, wide: true }),
      chartCard('talk', 'Talk time by day', 'Connected calls, hours and minutes', { legend: true }),
      chartCard('length', 'Call length distribution', 'Connected calls only', {}),
      chartCard('heat', 'When calls happen', 'Weekday and hour of day, IST', { wide: true })
    );
    ui.content.append(ui.kpis, ui.empty, ui.charts);
    ui.results.append(ui.status, ui.errorBox, ui.skeleton, ui.content);
  }

  // ---- Sub tabs ----
  function selectTab(name, focusTab) {
    if (name !== active) {
      setHash(name === 'calls' ? 'analytics/calls' : 'analytics?' + stateQuery(state || defaultState()));
      activate(name, {}, false);
    }
    if (focusTab) ui.tabs[name].focus();
  }
  function buildTabs() {
    const list = element('div', undefined, 'an-subtabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Analytics sections');
    for (const def of TABS) {
      const tab = element('button', def.label, 'an-subtab');
      tab.type = 'button';
      tab.id = 'an-tab-' + def.name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'an-panel-' + def.name);
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      tab.addEventListener('click', () => selectTab(def.name, false));
      ui.tabs[def.name] = tab;
      list.append(tab);
    }
    list.addEventListener('keydown', (event) => {
      const index = TABS.findIndex((def) => def.name === active);
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = TABS.length - 1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(TABS[next].name, true);
    });
    return list;
  }
  function activate(name, query, entering) {
    active = name;
    for (const def of TABS) {
      const selected = def.name === name;
      ui.tabs[def.name].setAttribute('aria-selected', String(selected));
      ui.tabs[def.name].tabIndex = selected ? 0 : -1;
      ui.panels[def.name].hidden = !selected;
    }
    if (name === 'calls') {
      cancelLoad();
      if (!calls) calls = createCallLogsPanel(ui.callsHost);
      calls.show(query);
    } else {
      if (calls) calls.hide();
      openAnalytics(query, entering);
    }
  }
  function openAnalytics(query, entering) {
    const parsed = Object.keys(query || {}).length ? parseState(query) : null;
    let changed = false;
    if (!state) state = parsed || defaultState();
    else if (parsed && !sameState(parsed, state)) { state = parsed; changed = true; }
    writeHash();
    syncControls();
    if (!data || entering || changed || needsLoad || Date.now() - loadedAt > STALE_MS) load();
    else renderCharts();
  }

  function mount(root) {
    if (mounted) return;
    mounted = true;
    root.classList.add('an-root');
    ui.root = root;
    const analyticsPanel = element('div', undefined, 'an-panel');
    analyticsPanel.id = 'an-panel-analytics';
    analyticsPanel.setAttribute('role', 'tabpanel');
    analyticsPanel.setAttribute('aria-labelledby', 'an-tab-analytics');
    analyticsPanel.hidden = true;
    analyticsPanel.append(buildHead());
    buildResults();
    analyticsPanel.append(ui.results);
    const callsPanel = element('div', undefined, 'an-panel');
    callsPanel.id = 'an-panel-calls';
    callsPanel.setAttribute('role', 'tabpanel');
    callsPanel.setAttribute('aria-labelledby', 'an-tab-calls');
    callsPanel.hidden = true;
    ui.callsHost = element('div', undefined, 'cl-host');
    callsPanel.append(ui.callsHost);
    ui.panels.analytics = analyticsPanel;
    ui.panels.calls = callsPanel;
    root.append(patternDefs(), buildTabs(), analyticsPanel, callsPanel);
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (!data || !shown || active !== 'analytics' || ui.charts.hidden) return;
        const widths = visibleWidths();
        if (widths.some((width) => width < 1) || widths.join(',') === widthKey) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderCharts, 100);
      });
      observer.observe(ui.charts);
    }
  }
  function show(params) {
    const entering = !shown;
    shown = true;
    if (entering) document.addEventListener('click', onDocumentClick);
    const parts = params && params.parts ? params.parts : [];
    const query = params && params.query ? params.query : {};
    activate(parts[0] === 'calls' ? 'calls' : 'analytics', query, entering);
  }
  function hide() {
    shown = false;
    document.removeEventListener('click', onDocumentClick);
    clearTimeout(resizeTimer);
    cancelLoad();
    if (ui.typesMenu) ui.typesMenu.open = false;
    if (calls) calls.hide();
  }
  return { mount, show, hide };
})();
`;

export const analyticsStyles = `
.an-root, .cl-root {
  --t-incoming-c: #8bb4d3; --t-incoming-s: #4f7fa3;
  --t-outgoing-c: #c9dccb; --t-outgoing-s: #7fa384;
  --t-missed-c: #cf7886; --t-missed-s: #a24a59;
  --t-rejected-c: #d4968a; --t-rejected-s: #a8625a;
  --t-blocked-c: #8a8cb8; --t-blocked-s: #5d5f91;
  --t-voicemail-c: #e3bf9c; --t-voicemail-s: #b98d5d;
  --t-answered_externally-c: #a9cdc8; --t-answered_externally-s: #5f918a;
  --t-unknown-c: #cfcac2; --t-unknown-s: #8b857d;
  --t-other-c: #bdb7a8; --t-other-s: #7d7766;
  --t-connected-c: #9cc5a8; --t-connected-s: #5b9071;
  --t-notConnected-c: #bdb7a8; --t-notConnected-s: #7d7766;
  --an-ink: #17261f; --an-ink-2: #29424d; --an-track: #eef2ed; --an-grid: #e3e9e2; --an-axis: #9fb0a8; --an-rate: #0e5a4e;
  --an-chip-on: #edf7ee; --an-card: #ffffff;
}
.an-root { display: grid; gap: 14px; min-width: 0; }
.an-root > * { min-width: 0; }
.an-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.an-subtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.an-root button.an-subtab { min-height: 40px; padding: 6px 14px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); font-size: 14px; font-weight: 500; white-space: nowrap; }
.an-root button.an-subtab:hover { background: var(--hover); color: var(--accent); }
.an-root button.an-subtab[aria-selected=true] { border-bottom-color: var(--accent); color: var(--accent); font-weight: 650; }
.an-panel { display: grid; gap: 14px; min-width: 0; }
.an-panel[hidden] { display: none; }
.an-head { min-width: 0; }
.an-title { font-size: 18px; letter-spacing: -.2px; overflow-wrap: anywhere; }
.an-preset-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
.an-root button.an-chip { min-height: 32px; padding: 3px 12px; border-radius: 999px; font-size: 12px; }
.an-root button.an-chip[aria-pressed=true] { border-color: var(--accent); background: var(--an-chip-on); color: var(--accent); }
.an-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; align-items: end; }
.an-apply button { width: 100%; }
.an-multi-field { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.an-field-label { font-size: 12px; font-weight: 650; }
.an-multi { position: relative; min-width: 0; }
.an-multi > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; color: #1d3039; font-size: 13px; list-style: none; cursor: pointer; }
.an-multi > summary::-webkit-details-marker { display: none; }
.an-multi > summary::after { content: '▾'; color: var(--muted); flex-shrink: 0; }
.an-multi[open] > summary { border-color: var(--accent); }
.an-multi > summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-multi > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.an-multi-menu { position: absolute; z-index: 6; top: 100%; left: 0; min-width: max(100%, 250px); max-width: min(360px, calc(100vw - 20px)); margin-top: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 2px 8px rgba(20, 43, 69, .15); }
.an-choice-list { display: grid; gap: 2px; max-height: 240px; margin-bottom: 8px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.an-root label.an-choice { display: flex; flex-direction: row; align-items: center; gap: 8px; min-height: 32px; margin: 0; color: inherit; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.an-choice input { width: 18px; height: 18px; min-height: 0; margin: 0; flex-shrink: 0; accent-color: var(--accent); }
.an-choice svg { flex-shrink: 0; }
.an-multi-menu .actions button { font-size: 12px; }
.an-status { margin: 0 0 8px; color: var(--muted); font-size: 12px; min-height: 18px; }
.an-status:empty { display: none; }
.an-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin: 0 0 12px; }
.an-error-text { margin: 0; overflow-wrap: anywhere; }
.an-content { display: grid; gap: 14px; transition: opacity .15s ease; }
.an-content.an-is-loading { opacity: .55; }
.an-skeleton { display: grid; gap: 14px; }
.an-skel { min-height: 104px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(90deg, #f0f3ee, #f8faf6, #f0f3ee); background-size: 200% 100%; }
.an-skel-chart { min-height: 220px; }
.an-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.an-kpi { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--an-card); }
.an-kpi-label { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: 12px; font-weight: 500; }
.an-kpi-value { margin: 0; font-size: 24px; font-weight: 650; line-height: 1.2; letter-spacing: -.3px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.an-kpi-sub { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.an-kpi-delta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 4px 0 0; min-height: 22px; font-size: 11px; color: var(--muted); }
.an-delta { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 750; background: #edf1f3; color: #4e626c; white-space: nowrap; }
.an-delta-good { background: #dff0e6; color: #0f5a38; }
.an-delta-bad { background: #fbe6e9; color: #96283a; }
.an-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.an-chart-card { min-width: 0; }
.an-chart-wide { grid-column: 1 / -1; }
.an-chart-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; margin-bottom: 6px; }
.an-chart-head .hint { margin: 0; }
.an-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 8px; padding: 0; font-size: 12px; color: var(--muted); }
.an-legend:empty { display: none; }
.an-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.an-sw { flex-shrink: 0; }
.an-sw .an-seg { stroke-width: 1; }
.an-chart-body { min-width: 0; }
.an-chart-svg { display: block; width: 100%; max-width: 100%; height: auto; overflow: visible; }
.an-chart-empty { margin: 14px 0; color: var(--muted); }
.an-chart-summary { margin: 8px 0 0; color: var(--an-ink-2); font-size: 13px; overflow-wrap: anywhere; }
.an-chart-summary:empty { display: none; }
.an-t-incoming { --c: var(--t-incoming-c); --s: var(--t-incoming-s); }
.an-t-outgoing { --c: var(--t-outgoing-c); --s: var(--t-outgoing-s); }
.an-t-missed { --c: var(--t-missed-c); --s: var(--t-missed-s); }
.an-t-rejected { --c: var(--t-rejected-c); --s: var(--t-rejected-s); }
.an-t-blocked { --c: var(--t-blocked-c); --s: var(--t-blocked-s); }
.an-t-voicemail { --c: var(--t-voicemail-c); --s: var(--t-voicemail-s); }
.an-t-answered_externally { --c: var(--t-answered_externally-c); --s: var(--t-answered_externally-s); }
.an-t-unknown { --c: var(--t-unknown-c); --s: var(--t-unknown-s); }
.an-t-other { --c: var(--t-other-c); --s: var(--t-other-s); }
.an-t-connected { --c: var(--t-connected-c); --s: var(--t-connected-s); }
.an-t-notConnected { --c: var(--t-notConnected-c); --s: var(--t-notConnected-s); }
.an-seg { fill: var(--c); stroke: var(--s); stroke-width: .75; }
.an-bar-blue { fill: #8bb4d3; stroke: #4f7fa3; stroke-width: .75; }
.an-track { fill: var(--an-track); }
.an-ch-text { fill: var(--an-ink); font-size: 11px; }
.an-ch-muted { fill: var(--muted); }
.an-ch-strong { font-weight: 700; }
.an-ch-seg-label { font-size: 10px; pointer-events: none; }
.an-ch-light { fill: #fff; }
.an-ch-grid { stroke: var(--an-grid); stroke-width: 1; }
.an-ch-axis { stroke: var(--an-axis); stroke-width: 1; }
.an-rate-line { fill: none; stroke: var(--an-rate); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.an-rate-dot { fill: #fff; stroke: var(--an-rate); stroke-width: 2; }
.an-heat-peak { fill: none; stroke: var(--an-ink); stroke-width: 2; pointer-events: none; }
@media (max-width: 900px) {
  .an-chart-grid { grid-template-columns: minmax(0, 1fr); }
  .an-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .an-title { font-size: 16px; }
  .an-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .an-multi-field, .an-apply { grid-column: 1 / -1; }
  .an-multi-menu { min-width: 100%; }
  .an-kpi { padding: 10px; }
  .an-kpi-value { font-size: 20px; }
  .an-chart-grid { gap: 12px; }
}
@media (max-width: 359px) {
  .an-kpi-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: no-preference) {
  .an-skel { animation: an-shimmer 1.4s linear infinite; }
  @keyframes an-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .an-anim .an-grow-x { transform-box: fill-box; transform-origin: left center; animation: an-grow-x .5s ease-out both; }
  .an-anim .an-grow-y { transform-box: fill-box; transform-origin: center bottom; animation: an-grow-y .5s ease-out both; }
  @keyframes an-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes an-grow-y { from { transform: scaleY(0); } to { transform: scaleY(1); } }
}
`;
