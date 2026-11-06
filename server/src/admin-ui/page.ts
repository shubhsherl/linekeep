import { linekeepMark } from "./brand";

export const adminHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Private Linekeep administration: call history, recordings, customers and WhatsApp chats.">
  <meta name="color-scheme" content="light">
  <title>Call history · Linekeep</title>
  <link rel="stylesheet" href="/admin/styles.css">
  <script src="/admin/client.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar"><div class="shell brand-row">
    <a class="brand" href="/admin">${linekeepMark}Linekeep<span class="brand-caption">ADMIN</span></a>
    <nav class="tabs" role="tablist" aria-label="Workspace">
    <a id="call-history-tab" role="tab" href="#call-history" aria-controls="call-history-panel" aria-selected="true">Call history</a>
    <a id="analytics-tab" role="tab" href="#analytics" aria-controls="analytics-panel" aria-selected="false" tabindex="-1">Call analytics</a>
    <a id="customers-tab" role="tab" href="#customers" aria-controls="customers-panel" aria-selected="false" tabindex="-1">Customers</a>
    <a id="whatsapp-tab" role="tab" href="#whatsapp" aria-controls="whatsapp-panel" aria-selected="false" tabindex="-1">WhatsApp<span id="whatsapp-unread" class="tab-badge" hidden><span id="whatsapp-unread-count" aria-hidden="true"></span><span id="whatsapp-unread-text" class="sr-only"></span></span></a>
    <a id="employees-tab" role="tab" href="#employees" aria-controls="employees-panel" aria-selected="false" tabindex="-1">Employees</a>
    <a id="config-tab" role="tab" href="#config" aria-controls="config-panel" aria-selected="false" tabindex="-1">Config</a>
    </nav>
    <span class="private-label">Private workspace</span>
  </div></header>
  <main id="main" class="shell" tabindex="-1">
    <div class="page-heading"><div><h1 id="page-title">Call history</h1>
      <p class="lede" id="page-description">Calls and recordings, together.</p></div>
    <div class="directory-notice"><p id="directory-status" role="status" aria-live="polite"></p><p id="directory-error" class="error-text" role="alert" hidden></p><button id="refresh-directory" class="secondary" type="button">Refresh employee choices</button></div>
    </div>
    <noscript><p class="notice error">Enable JavaScript to load recordings, view call history, manage customers and chats, and manage employees.</p></noscript>
    <div id="auth-notice" class="notice error" role="alert" hidden>Your admin session is unavailable. <a href="/admin/login">Sign in again</a>, then refresh this page. Production access is managed by Cloudflare Access.</div>
    <section id="player-panel" class="panel player-panel" aria-labelledby="player-title" hidden>
      <div class="section-heading"><div><h2 id="player-title" tabindex="-1"></h2></div><button id="close-player" class="secondary" type="button">Close player</button></div>
      <audio id="audio" controls preload="none" aria-label="Selected call recording"></audio>
      <p id="player-status" class="hint" role="status" aria-live="polite"></p>
      <button id="retry-playback" class="secondary" type="button" hidden>Refresh playback</button>
    </section>
    <section id="call-history-panel" role="tabpanel" aria-labelledby="call-history-tab">
      <section class="panel filters" aria-labelledby="call-history-filter-heading">
        <div class="section-heading"><h2 id="call-history-filter-heading">Find calls</h2><span class="muted">Newest first</span></div>
        <p class="hint">Calls and recordings share one feed. Audio without a reliable call match is labeled Unlinked recording. Unknown line details are never inferred from the device’s current SIM.</p>
        <form id="call-history-form">
          <div class="filter-grid">
            <label class="wide">Employee<select id="call-history-employee" name="employeeId"><option value="">All employees</option></select></label>
            <label class="date-filter">From<input name="from" type="datetime-local"></label>
            <label class="date-filter">To<input name="to" type="datetime-local"></label>
            <label>Call type<select name="callType"><option value="">All types</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option><option value="missed">Missed</option><option value="rejected">Rejected</option><option value="blocked">Blocked</option><option value="voicemail">Voicemail</option><option value="answered_externally">Answered externally</option><option value="unknown">Unknown</option></select></label>
            <label class="wide">Phone number<input name="number" type="search" placeholder="Search by number" maxlength="80" autocomplete="off"></label>
            <label>Per page<input name="limit" type="number" min="1" max="100" step="1" value="50" required></label>
            <label class="checkbox-filter"><input id="has-recording" name="hasRecording" type="checkbox" value="true">With recording</label>
          </div>
          <div class="form-footer"><p id="call-history-timezone-note" class="hint">Dates and times use your local timezone. Number searches match literal text.</p>
            <div class="actions"><button type="reset" class="secondary">Clear</button><button type="submit">Apply filters</button></div></div>
          <p id="call-history-filter-error" class="error-text" role="alert" hidden></p>
        </form>
      </section>
      <section id="call-history-results" aria-labelledby="call-history-heading" aria-busy="false">
        <div class="results-heading"><h2 id="call-history-heading">Call history</h2><button id="call-history-refresh" class="secondary" type="button">Refresh</button></div>
        <p id="call-history-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="call-history-error" class="notice error" role="alert" hidden></p>
        <p id="action-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <div id="call-history-list" class="call-list"></div>
        <nav class="pagination" aria-label="Call history pages"><button id="call-history-previous" class="secondary" type="button" disabled>Previous</button><span id="call-history-page">Page 1</span><button id="call-history-next" class="secondary" type="button" disabled>Next</button></nav>
      </section>
    </section>
    <section id="analytics-panel" role="tabpanel" aria-labelledby="analytics-tab" hidden>
      <section class="panel analytics-head" aria-labelledby="analytics-title">
        <div class="section-heading">
          <div><h2 id="analytics-title" class="analytics-title" tabindex="-1">Call analytics</h2><p id="analytics-subtitle" class="muted"></p></div>
          <button id="analytics-refresh" class="secondary" type="button">Refresh</button>
        </div>
        <div id="analytics-presets" class="preset-row" role="group" aria-label="Quick date ranges">
          <button class="secondary chip" type="button" data-preset="today" aria-pressed="false">Today</button>
          <button class="secondary chip" type="button" data-preset="yesterday" aria-pressed="false">Yesterday</button>
          <button class="secondary chip" type="button" data-preset="7" aria-pressed="false">Last 7 days</button>
          <button class="secondary chip" type="button" data-preset="30" aria-pressed="false">Last 30 days</button>
          <button class="secondary chip" type="button" data-preset="month" aria-pressed="false">This month</button>
        </div>
        <form id="analytics-form" novalidate>
          <div class="analytics-filters">
            <label>From<input id="analytics-from" name="from" type="date" required></label>
            <label>To<input id="analytics-to" name="to" type="date" required></label>
            <div class="multi-field"><span id="analytics-employees-caption" class="field-label">Employees</span>
              <details id="analytics-employees" class="multi">
                <summary aria-labelledby="analytics-employees-caption analytics-employees-label"><span id="analytics-employees-label">All employees</span></summary>
                <div class="multi-menu"><div id="analytics-employee-choices" class="choice-list"></div>
                  <div class="actions"><button id="analytics-employees-clear" class="secondary" type="button">Show all employees</button></div></div>
              </details></div>
            <div class="multi-field"><span id="analytics-types-caption" class="field-label">Call type</span>
              <details id="analytics-types" class="multi">
                <summary aria-labelledby="analytics-types-caption analytics-types-label"><span id="analytics-types-label">All types</span></summary>
                <div class="multi-menu"><div id="analytics-type-choices" class="choice-list"></div>
                  <div class="actions"><button id="analytics-types-clear" class="secondary" type="button">Show all types</button></div></div>
              </details></div>
            <div class="analytics-apply"><button type="submit">Apply</button></div>
          </div>
          <p class="hint">Days run midnight to midnight India time (IST, UTC+05:30), both dates included, up to 366 days. Leave Employees or Call type empty to include everything. The view is saved in the page address so you can bookmark or share it.</p>
          <p id="analytics-filter-error" class="error-text" role="alert" hidden></p>
        </form>
      </section>
      <section id="analytics-results" aria-label="Call analytics results" aria-busy="false">
        <p id="analytics-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="analytics-error" class="notice error" role="alert" hidden></p>
        <div id="analytics-skeleton" class="analytics-skeleton" aria-hidden="true" hidden>
          <div class="kpi-grid"><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div><div class="kpi skeleton"></div></div>
          <div class="panel skeleton skeleton-chart"></div>
        </div>
        <div id="analytics-content" hidden>
          <div id="analytics-kpis" class="kpi-grid"></div>
          <section id="analytics-empty" class="panel empty-state" hidden>
            <h3>No calls in this period</h3>
            <p>No calls matched these dates and filters. Try a wider date range, or choose Show all employees and Show all types. Charts appear as soon as there is at least one call.</p>
          </section>
          <div id="analytics-charts" class="chart-grid">
            <article class="panel chart-card" aria-labelledby="analytics-users-heading">
              <div class="chart-head"><h3 id="analytics-users-heading">Total calls by user</h3><p class="hint">Stacked by call type · top 15</p></div>
              <div id="analytics-legend-users" class="legend"></div>
              <div id="analytics-chart-users" class="chart-body"></div>
              <p id="analytics-summary-users" class="chart-summary"></p>
            </article>
            <article class="panel chart-card" aria-labelledby="analytics-types-heading">
              <div class="chart-head"><h3 id="analytics-types-heading">Calls by type</h3><p class="hint">All eight call types</p></div>
              <div id="analytics-chart-types" class="chart-body"></div>
              <p id="analytics-summary-types" class="chart-summary"></p>
            </article>
            <article class="panel chart-card" aria-labelledby="analytics-days-heading">
              <div class="chart-head"><h3 id="analytics-days-heading">Calls by day</h3><p class="hint">Columns: calls by type · line: connect rate</p></div>
              <div id="analytics-legend-days" class="legend"></div>
              <div id="analytics-chart-days" class="chart-body"></div>
              <p id="analytics-summary-days" class="chart-summary"></p>
            </article>
            <article class="panel chart-card" aria-labelledby="analytics-talk-heading">
              <div class="chart-head"><h3 id="analytics-talk-heading">Talk time by day</h3><p class="hint">Connected calls, hours and minutes</p></div>
              <div id="analytics-legend-talk" class="legend"></div>
              <div id="analytics-chart-talk" class="chart-body"></div>
              <p id="analytics-summary-talk" class="chart-summary"></p>
            </article>
            <article class="panel chart-card chart-wide" aria-labelledby="analytics-heat-heading">
              <div class="chart-head"><h3 id="analytics-heat-heading">When calls happen</h3><p class="hint">Weekday and hour of day, IST</p></div>
              <div id="analytics-chart-heat" class="chart-body"></div>
              <p id="analytics-summary-heat" class="chart-summary"></p>
            </article>
            <article class="panel chart-card" aria-labelledby="analytics-rate-heading">
              <div class="chart-head"><h3 id="analytics-rate-heading">Connect rate by employee</h3><p class="hint">Connected calls ÷ all calls · top 12</p></div>
              <div id="analytics-chart-rate" class="chart-body"></div>
              <p id="analytics-summary-rate" class="chart-summary"></p>
            </article>
            <article class="panel chart-card" aria-labelledby="analytics-length-heading">
              <div class="chart-head"><h3 id="analytics-length-heading">Call length distribution</h3><p class="hint">Connected calls only</p></div>
              <div id="analytics-chart-length" class="chart-body"></div>
              <p id="analytics-summary-length" class="chart-summary"></p>
            </article>
            <article class="panel chart-card chart-wide" aria-labelledby="analytics-leaderboard-heading">
              <div class="chart-head"><h3 id="analytics-leaderboard-heading">Employee leaderboard</h3><p class="hint">Select a column heading to sort</p></div>
              <div id="analytics-leaderboard" class="table-wrap" role="region" aria-labelledby="analytics-leaderboard-heading" tabindex="0"></div>
              <p id="analytics-leaderboard-note" class="chart-summary" role="status" aria-live="polite"></p>
            </article>
          </div>
        </div>
      </section>
    </section>
    <section id="customers-panel" role="tabpanel" aria-labelledby="customers-tab" hidden>
      <div id="customers-browse">
        <section class="panel filters" aria-labelledby="customers-heading">
          <div class="section-heading"><div><h2 id="customers-heading" tabindex="-1">Customers</h2></div><button id="customer-add" type="button">Add customer</button></div>
          <p class="hint">Only name and phone are required. Search matches names, phone digits and email addresses as literal text. Only the employees listed as handling a customer see it in the Linekeep app.</p>
          <form id="customers-form">
            <div class="filter-grid">
              <label class="wide">Search<input name="q" type="search" placeholder="Name, phone or email" maxlength="200" autocomplete="off"></label>
              <label>Handling employee<select id="customers-employee" name="employeeId"><option value="">All employees</option></select></label>
              <label>State<input name="state" type="search" maxlength="120" autocomplete="off"></label>
              <label class="checkbox-filter"><input id="customers-unassigned" name="unassigned" type="checkbox" value="true">Unassigned only</label>
            </div>
            <div class="form-footer"><p class="hint">Results update as you type. Choosing Unassigned only ignores the employee filter.</p>
              <div class="actions"><button type="reset" class="secondary">Clear filters</button></div></div>
          </form>
        </section>
        <section id="customers-results" aria-labelledby="customers-list-heading" aria-busy="false">
          <div class="results-heading"><h2 id="customers-list-heading">Customer list</h2><button id="customers-refresh" class="secondary" type="button">Refresh</button></div>
          <p id="customers-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <p id="customers-error" class="notice error" role="alert" hidden></p>
          <p id="customers-action-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <div id="customers-list" class="call-list"></div>
          <div class="pagination"><button id="customers-more" class="secondary" type="button" hidden>Load more customers</button></div>
        </section>
      </div>
      <section id="customer-detail" class="panel" aria-labelledby="customer-detail-heading" hidden>
        <div class="section-heading"><div><h2 id="customer-detail-heading" tabindex="-1"></h2></div>
          <div class="actions"><button id="customer-detail-refresh" class="secondary" type="button">Refresh</button><button id="customer-detail-back" class="secondary" type="button">Back to customers</button></div></div>
        <p id="customer-detail-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="customer-detail-error" class="error-text" role="alert" hidden></p>
        <div class="actions"><button id="customer-detail-edit" class="secondary" type="button">Edit</button><button id="customer-detail-handlers" class="secondary" type="button">Handled by</button><button id="customer-detail-archive" class="secondary delete-button" type="button">Archive</button></div>
        <dl id="customer-detail-facts" class="device-facts"></dl>
        <section class="detail-section" aria-labelledby="customer-messages-heading">
          <div class="section-heading"><h3 id="customer-messages-heading">WhatsApp</h3><button id="customer-open-chat" class="secondary" type="button">Open WhatsApp chat</button></div>
          <p id="customer-wa-summary" class="muted"></p>
        </section>
        <section class="detail-section" aria-labelledby="customer-calls-heading" aria-busy="false">
          <div class="section-heading"><h3 id="customer-calls-heading">Calls</h3><span class="muted">Newest first · any employee</span></div>
          <p class="hint">Calls are matched by the last 10 digits of the customer’s phone number. Recordings play and download here exactly as in Call history; delete them from Call history.</p>
          <p id="customer-calls-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <p id="customer-calls-action-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <p id="customer-calls-error" class="error-text" role="alert" hidden></p>
          <div id="customer-calls-list" class="call-list"></div>
          <div class="pagination"><button id="customer-calls-more" class="secondary" type="button" hidden>Load more calls</button></div>
        </section>
      </section>
    </section>
    <section id="whatsapp-panel" role="tabpanel" aria-labelledby="whatsapp-tab" hidden>
      <div id="chat-layout" class="wa wa-app" data-view="list">
        <section id="chat-list-section" class="wa-side" aria-labelledby="whatsapp-heading" aria-busy="false">
          <div class="wa-side-head">
            <h2 id="whatsapp-heading" tabindex="-1">Chats</h2>
            <button id="whatsapp-refresh" class="wa-icon-btn" type="button" aria-label="Refresh chats" title="Refresh chats"></button>
          </div>
          <form id="whatsapp-form" class="wa-filters" role="search" aria-label="Search chats">
            <label class="wa-search"><span class="sr-only">Search chats</span><input name="q" type="search" placeholder="Search by name, phone or email" maxlength="200" autocomplete="off"></label>
            <label class="wa-employee"><span class="sr-only">Handling employee</span><select id="whatsapp-employee" name="employeeId"><option value="">All employees</option></select></label>
          </form>
          <p id="whatsapp-status" class="wa-status" role="status" aria-live="polite" aria-atomic="true"></p>
          <p id="whatsapp-error" class="wa-notice wa-error" role="alert" hidden></p>
          <div id="whatsapp-list" class="wa-chats"></div>
          <div class="wa-more"><button id="whatsapp-more" class="wa-text-btn" type="button" hidden>Load more chats</button></div>
        </section>
        <section id="chat-thread" class="wa-main" aria-label="Conversation">
          <div id="chat-thread-empty" class="wa-placeholder"><p>Select a chat to read and reply to its messages.</p></div>
          <div id="chat-conversation" class="wa-conv" hidden></div>
        </section>
      </div>
    </section>
    <section id="employees-panel" role="tabpanel" aria-labelledby="employees-tab" hidden>
      <section class="panel" aria-labelledby="directory-heading">
        <div class="section-heading"><div><h2 id="directory-heading" tabindex="-1">Employees</h2></div><button id="employees-refresh" class="secondary" type="button">Refresh directory</button></div>
        <p class="muted">Manage employees even before their first recording. Device handovers do not require employees to repeat setup.</p>
        <form id="employee-form"><fieldset class="create-employee"><legend>Create employee</legend>
          <label>Full name<input name="name" autocomplete="name" required maxlength="200"></label>
          <label>Phone number (optional)<input name="phoneNumber" type="tel" autocomplete="off" maxlength="32" placeholder="+919876543210" aria-describedby="employee-phone-help"></label>
          <p id="employee-phone-help" class="hint">Used only to fill WhatsApp template messages (for example, who the customer should call).</p>
          <button type="submit">Create employee</button>
        </fieldset><p id="employee-status" role="status" aria-live="polite"></p><p id="employee-error" class="error-text" role="alert" hidden></p></form>
        <p id="employees-status" role="status" aria-live="polite"></p><p id="employees-error" class="error-text" role="alert" hidden></p>
        <div id="employees-list" class="management-list" aria-busy="true"></div>
        <nav class="pagination" aria-label="Employee pages"><button id="employees-previous" class="secondary" type="button" disabled>Previous</button><span id="employees-page">Page 1</span><button id="employees-next" class="secondary" type="button" disabled>Next</button></nav>
      </section>
      <section class="panel" aria-labelledby="devices-heading">
        <div class="section-heading"><h2 id="devices-heading" tabindex="-1">Enrolled devices</h2><button id="devices-refresh" class="secondary" type="button">Refresh devices</button></div>
        <p class="muted">The enrollment ID stays the same when a device changes employees or SIMs. SIM numbers are unverified device reports, not employee identity or authentication.</p>
        <label class="management-filter">Assigned employee<select id="devices-employee"><option value="">All employees</option></select></label>
        <label class="checkbox-filter"><input id="devices-show-revoked" type="checkbox">Show revoked devices</label>
        <p id="devices-status" role="status" aria-live="polite"></p><p id="devices-error" class="error-text" role="alert" hidden></p>
        <div id="devices-list" class="management-list" aria-busy="true"></div>
        <nav class="pagination" aria-label="Device pages"><button id="devices-previous" class="secondary" type="button" disabled>Previous</button><span id="devices-page">Page 1</span><button id="devices-next" class="secondary" type="button" disabled>Next</button></nav>
      </section>
      <section class="panel" aria-labelledby="invitations-heading">
        <div class="section-heading"><h2 id="invitations-heading" tabindex="-1">Device invitations</h2><button id="invitations-refresh" class="secondary" type="button">Refresh history</button></div>
        <label class="management-filter">Employee<select id="invitation-employee"><option value="">Select an employee</option></select></label>
        <label class="checkbox-filter"><input id="invitations-show-revoked" type="checkbox">Show revoked invitations</label>
        <p class="hint">An enrollment invitation creates a new device. After reinstall, use Recover enrollment on the existing device to keep its ID and history. Codes cannot be retrieved after dismissal.</p>
        <form id="invitation-form"><fieldset disabled><legend>New one-time invitation</legend><button type="submit">Generate invitation</button></fieldset><p id="invitation-status" role="status" aria-live="polite"></p><p id="invitation-error" class="error-text" role="alert" hidden></p></form>
        <section id="invitation-result" class="invitation-result" aria-labelledby="invitation-title" hidden>
          <h3 id="invitation-title" tabindex="-1">Invitation ready, shown once</h3>
          <p>Share this code securely with the employee. It is not saved in this browser and cannot be recovered after dismissal. It becomes unusable after redemption, revocation or expiry.</p>
          <div id="invitation-qr" class="invitation-qr" role="group" aria-label="Setup QR code"></div>
          <p class="hint">Scan this QR code in the Linekeep app (Home → Scan QR code). It carries this server’s address and the one-time code, so nothing needs to be typed. Treat it like the code itself.</p>
          <label>Single-use invitation code<input id="invitation-code" readonly autocomplete="off" spellcheck="false"></label>
          <p id="invitation-expiry"></p>
          <div class="actions"><button id="copy-invitation" type="button">Copy code</button><button id="dismiss-invitation" class="secondary" type="button">Dismiss and clear</button></div>
          <p id="copy-status" role="status" aria-live="polite"></p>
        </section>
        <p id="invitations-status" role="status" aria-live="polite"></p><p id="invitations-error" class="error-text" role="alert" hidden></p>
        <div id="invitations-list" class="management-list" aria-busy="false"></div>
        <nav class="pagination" aria-label="Invitation pages"><button id="invitations-previous" class="secondary" type="button" disabled>Previous</button><span id="invitations-page">Page 1</span><button id="invitations-next" class="secondary" type="button" disabled>Next</button></nav>
      </section>
    </section>
    <section id="config-panel" role="tabpanel" aria-labelledby="config-tab" hidden>
      <div class="cfg-layout">
        <nav class="cfg-nav" aria-label="Configuration sections">
          <ul id="config-nav" class="cfg-nav-list" role="list">
            <li><button class="cfg-nav-item" type="button" data-section="features" aria-current="page">Features</button></li>
            <li><button class="cfg-nav-item" type="button" data-section="whatsapp-business">WhatsApp Business</button></li>
            <li id="config-nav-whatsapp" hidden><button class="cfg-nav-item" type="button" data-section="whatsapp">Auto replies &amp; quick messages</button></li>
            <li><button class="cfg-nav-item" type="button" data-section="email">Daily email report</button></li>
            <li><button class="cfg-nav-item" type="button" data-section="push">Push notifications</button></li>
            <li><button class="cfg-nav-item" type="button" data-section="app">Android app</button></li>
          </ul>
        </nav>
        <div class="cfg-content">
          <section id="config-import-banner" class="notice cfg-import" aria-labelledby="config-import-title" hidden>
            <h3 id="config-import-title">Some settings are still stored as Worker secrets</h3>
            <p class="muted">Import them into Linekeep so you can manage them here. They are encrypted before they are stored. Once imported, the old Worker secrets can be deleted from the Cloudflare dashboard or with <code>wrangler secret delete</code>.</p>
            <p id="config-import-fields" class="hint"></p>
            <div class="actions"><button id="config-import-button" type="button">Import from deployment</button></div>
            <p id="config-import-status" class="cfg-status" role="status" aria-live="polite"></p>
            <p id="config-import-error" class="error-text" role="alert" hidden></p>
          </section>
          <p id="config-settings-error" class="error-text" role="alert" hidden></p>
          <section id="config-section-features" class="cfg-section" aria-labelledby="config-features-heading">
            <h2 id="config-features-heading" class="cfg-section-title" tabindex="-1">Features</h2>
            <div id="settings-features-body" class="cfg-body"></div>
          </section>
          <section id="config-section-whatsapp-business" class="cfg-section" aria-labelledby="config-whatsapp-business-heading" hidden>
            <h2 id="config-whatsapp-business-heading" class="cfg-section-title" tabindex="-1">WhatsApp Business</h2>
            <div id="settings-whatsapp-body" class="cfg-body"></div>
          </section>
          <section id="config-section-email" class="cfg-section" aria-labelledby="config-email-heading" hidden>
            <h2 id="config-email-heading" class="cfg-section-title" tabindex="-1">Daily email report</h2>
            <div id="settings-email-body" class="cfg-body"></div>
          </section>
          <section id="config-section-push" class="cfg-section" aria-labelledby="config-push-heading" hidden>
            <h2 id="config-push-heading" class="cfg-section-title" tabindex="-1">Push notifications</h2>
            <div id="settings-push-body" class="cfg-body"></div>
          </section>
          <section id="config-section-app" class="cfg-section" aria-labelledby="config-app-heading" hidden>
            <h2 id="config-app-heading" class="cfg-section-title" tabindex="-1">Android app</h2>
            <div id="settings-app-body" class="cfg-body"></div>
          </section>
          <section id="config-section-whatsapp" class="cfg-section" aria-labelledby="config-whatsapp-heading" hidden>
            <h2 id="config-whatsapp-heading" class="cfg-section-title" tabindex="-1">Auto replies and quick messages</h2>
            <section class="panel cfg-block" aria-labelledby="autoreply-heading">
              <div class="section-heading"><h3 id="autoreply-heading" tabindex="-1">Auto replies</h3><button id="autoreply-add" type="button">Add rule</button></div>
              <p class="muted">When a customer’s message matches a rule, Linekeep replies automatically. The first matching rule in the list is used. Each rule replies at most once per customer within its cooldown.</p>
              <p id="autoreply-status" class="cfg-status" role="status" aria-live="polite"></p>
              <p id="autoreply-error" class="error-text" role="alert" hidden></p>
              <button id="autoreply-retry" class="secondary" type="button" hidden>Try again</button>
              <div id="autoreply-list" class="management-list cfg-list" aria-busy="true"></div>
            </section>
            <section class="panel cfg-block" aria-labelledby="autoreply-activity-heading">
              <div class="section-heading"><h3 id="autoreply-activity-heading" tabindex="-1">Recent auto-replies</h3><button id="autoreply-activity-refresh" class="secondary" type="button">Refresh</button></div>
              <p id="autoreply-activity-status" class="cfg-status" role="status" aria-live="polite"></p>
              <p id="autoreply-activity-error" class="error-text" role="alert" hidden></p>
              <div id="autoreply-activity-list" class="cfg-activity" aria-busy="false"></div>
            </section>
            <section class="panel cfg-block" aria-labelledby="quick-heading">
              <div class="section-heading"><h3 id="quick-heading" tabindex="-1">Quick messages</h3><button id="quick-add" type="button">Add quick message</button></div>
              <p class="muted">Ready-made texts for chats. Employees can insert these into a chat with the lightning button.</p>
              <p id="quick-status" class="cfg-status" role="status" aria-live="polite"></p>
              <p id="quick-error" class="error-text" role="alert" hidden></p>
              <button id="quick-retry" class="secondary" type="button" hidden>Try again</button>
              <div id="quick-list" class="management-list cfg-list" aria-busy="false"></div>
            </section>
          </section>
        </div>
      </div>
    </section>
    <footer class="footer">Linekeep · Private audio, controlled access.<span>Playback links expire automatically.</span></footer>
  <svg class="svg-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
    <pattern id="pat-outgoing" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-1 1L1 -1M0 8L8 0M7 9L9 7" stroke="#17352f" stroke-opacity=".5" stroke-width="1" fill="none"/></pattern>
    <pattern id="pat-missed" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#17352f" fill-opacity=".55"/><circle cx="6" cy="6" r="1.1" fill="#17352f" fill-opacity=".55"/></pattern>
    <pattern id="pat-rejected" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-1 7L1 9M0 0L8 8M7 -1L9 1" stroke="#17352f" stroke-opacity=".5" stroke-width="1" fill="none"/></pattern>
    <pattern id="pat-blocked" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 2H8M0 6H8" stroke="#17352f" stroke-opacity=".5" stroke-width="1" fill="none"/></pattern>
    <pattern id="pat-voicemail" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M2 0V8M6 0V8" stroke="#17352f" stroke-opacity=".5" stroke-width="1" fill="none"/></pattern>
    <pattern id="pat-answered_externally" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 4H8M4 0V8" stroke="#17352f" stroke-opacity=".5" stroke-width="1" fill="none"/></pattern>
    <pattern id="pat-unknown" width="8" height="8" patternUnits="userSpaceOnUse"><rect x="1" y="1" width="2" height="2" fill="#17352f" fill-opacity=".5"/><rect x="5" y="5" width="2" height="2" fill="#17352f" fill-opacity=".5"/></pattern>
    <pattern id="pat-other" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M8 0L0 8" stroke="#17352f" stroke-opacity=".45" stroke-width="1" fill="none"/></pattern>
  </defs></svg>
  </main>
  <div id="drawer-backdrop" class="drawer-backdrop" hidden></div>
  <aside id="drawer" class="drawer" role="dialog" aria-label="Customer" data-open="false" data-mode="customer" inert>
    <header class="drawer-head">
      <button id="drawer-back" class="drawer-icon" type="button" aria-label="Back to customer" title="Back to customer" hidden></button>
      <h2 id="drawer-title" class="drawer-title" tabindex="-1">Customer</h2>
      <button id="drawer-close" class="drawer-icon" type="button" aria-label="Close" title="Close"></button>
    </header>
    <div id="drawer-customer" class="drawer-pane">
      <p id="drawer-customer-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p>
      <div id="drawer-customer-error" class="notice error" hidden>
        <p id="drawer-customer-error-text" role="alert"></p>
        <button id="drawer-retry" class="secondary" type="button">Try again</button>
      </div>
      <div id="drawer-customer-content" hidden>
        <h3 id="drawer-customer-name" class="drawer-name"></h3>
        <p class="drawer-phone"><a id="drawer-phone"></a></p>
        <div class="actions drawer-actions">
          <button id="drawer-open-chat" type="button">WhatsApp chat</button>
          <button id="drawer-open-detail" class="secondary" type="button">Open full details</button>
          <button id="drawer-edit" class="secondary" type="button">Edit</button>
        </div>
        <dl id="drawer-facts" class="drawer-facts"></dl>
        <div class="drawer-notes">
          <h4 class="drawer-label">Notes</h4>
          <p id="drawer-notes-text" class="drawer-notes-text" data-expanded="false"></p>
          <button id="drawer-notes-toggle" class="link-button" type="button" aria-expanded="false" aria-controls="drawer-notes-text" hidden>Show more</button>
        </div>
        <section class="drawer-calls-section" aria-labelledby="drawer-calls-heading">
          <h4 id="drawer-calls-heading" class="drawer-label">Recent calls</h4>
          <p id="drawer-calls-status" class="hint" role="status" aria-live="polite" aria-atomic="true"></p>
          <button id="drawer-calls-retry" class="secondary" type="button" hidden>Try again</button>
          <ul id="drawer-calls" class="drawer-calls"></ul>
        </section>
      </div>
    </div>
    <div id="drawer-chat" class="drawer-pane drawer-chat wa" hidden>
      <div class="drawer-chat-sub"><span id="drawer-chat-phone" class="muted"></span><button id="drawer-chat-detail" class="link-button" type="button">Open full details</button></div>
      <div id="drawer-conversation" class="wa wa-embedded drawer-conv"></div>
    </div>
  </aside>
  <dialog id="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description">
    <h2 id="delete-title"></h2><p id="delete-description"></p>
    <p id="delete-name" class="delete-name"></p><p id="delete-error" class="error-text" role="alert" hidden></p>
    <form id="delete-form"><div class="actions"><button id="cancel-delete" class="secondary" type="button" autofocus>Cancel</button><button id="confirm-delete" class="danger" type="submit">Delete</button></div></form>
  </dialog>
  <dialog id="assignment-dialog" aria-labelledby="assignment-title" aria-describedby="assignment-description">
    <h2 id="assignment-title">Reassign enrolled device</h2>
    <p id="assignment-description">Enrollment and credentials stay unchanged. Historical recordings retain their employee attribution; the employee does not need to repeat setup.</p>
    <p id="assignment-device" class="delete-name"></p>
    <form id="assignment-form"><fieldset><label>Assign to employee<select id="assignment-employee" required><option value="">Select an employee</option></select></label>
      <p id="assignment-status" role="status" aria-live="polite"></p><p id="assignment-error" class="error-text" role="alert" hidden></p>
      <div class="actions"><button id="cancel-assignment" class="secondary" type="button">Cancel</button><button id="confirm-assignment" type="submit">Save assignment</button></div>
    </fieldset></form>
  </dialog>
  <dialog id="revoke-dialog" aria-labelledby="revoke-title" aria-describedby="revoke-description">
    <h2 id="revoke-title"></h2><p id="revoke-description"></p><p id="revoke-name" class="delete-name"></p>
    <p id="revoke-error" class="error-text" role="alert" hidden></p>
    <form id="revoke-form"><div class="actions"><button id="cancel-revoke" class="secondary" type="button" autofocus>Cancel</button><button id="confirm-revoke" class="danger" type="submit">Revoke</button></div></form>
  </dialog>
  <dialog id="recovery-dialog" aria-labelledby="recovery-title" aria-describedby="recovery-description">
    <h2 id="recovery-title">Recover this enrollment?</h2>
    <p id="recovery-description">Issue a one-time code for reinstalling on this enrollment. Issuing it does not interrupt the current installation. Redeeming it rotates the existing credential: the old installation loses access, while the enrollment ID and history stay unchanged. Any outstanding recovery code is replaced. Permissions and recording-folder access must be granted again.</p>
    <p id="recovery-device" class="delete-name"></p>
    <p id="recovery-error" class="error-text" role="alert" hidden></p>
    <form id="recovery-form"><div class="actions"><button id="cancel-recovery" class="secondary" type="button" autofocus>Cancel</button><button id="confirm-recovery" type="submit">Generate recovery code</button></div></form>
  </dialog>
  <dialog id="customer-dialog" aria-labelledby="customer-dialog-title" aria-describedby="customer-dialog-description">
    <h2 id="customer-dialog-title">Add customer</h2>
    <p id="customer-dialog-description" class="hint">Only name and phone are required. A 10-digit phone number is saved as an Indian (+91) number; include the country code for any other country.</p>
    <form id="customer-form"><fieldset id="customer-fields">
      <label>Name<input name="name" required maxlength="200" autocomplete="off"></label>
      <label>Phone<input name="phone" type="tel" inputmode="tel" required maxlength="40" autocomplete="off"></label>
      <label>Email (optional)<input name="email" type="email" maxlength="254" autocomplete="off"></label>
      <label>Source (optional)<input name="source" maxlength="120" autocomplete="off"></label>
      <div class="field-row">
        <label>District (optional)<input name="district" maxlength="120" autocomplete="off"></label>
        <label>State (optional)<input name="state" maxlength="120" autocomplete="off"></label>
      </div>
      <label>Country<input name="country" maxlength="120" value="India" autocomplete="off"></label>
      <label>Notes (optional)<textarea name="notes" rows="3" maxlength="4000"></textarea></label>
      <fieldset id="customer-employee-fields" class="choice-group"><legend>Handled by</legend>
        <p class="hint">Active employees only. Leave everyone unchecked to keep the customer unassigned.</p>
        <div id="customer-employee-choices" class="choice-list"></div>
      </fieldset>
      <p id="customer-dialog-status" role="status" aria-live="polite"></p><p id="customer-dialog-error" class="error-text" role="alert" hidden></p>
      <div class="actions"><button id="cancel-customer" class="secondary" type="button">Cancel</button><button id="confirm-customer" type="submit">Add customer</button></div>
    </fieldset></form>
  </dialog>
  <dialog id="handlers-dialog" aria-labelledby="handlers-title" aria-describedby="handlers-description">
    <h2 id="handlers-title">Handled by</h2>
    <p id="handlers-description">Choose the active employees who handle this customer. Saving replaces the current set; only these employees see the customer and its chat in the Linekeep app. Unchecking everyone leaves the customer unassigned.</p>
    <p id="handlers-customer" class="delete-name"></p>
    <form id="handlers-form"><fieldset id="handlers-fields"><legend>Active employees</legend>
      <div id="handlers-choices" class="choice-list"></div>
      <p id="handlers-status" role="status" aria-live="polite"></p><p id="handlers-error" class="error-text" role="alert" hidden></p>
      <div class="actions"><button id="cancel-handlers" class="secondary" type="button">Cancel</button><button id="confirm-handlers" type="submit">Save handling employees</button></div>
    </fieldset></form>
  </dialog>
  <dialog id="archive-dialog" aria-labelledby="archive-title" aria-describedby="archive-description">
    <h2 id="archive-title">Archive this customer?</h2>
    <p id="archive-description">The customer leaves the customer list, cannot be edited or assigned, and disappears from employees’ apps. Stored WhatsApp messages and call history are kept, and the phone number can be used for a new customer.</p>
    <p id="archive-name" class="delete-name"></p><p id="archive-error" class="error-text" role="alert" hidden></p>
    <form id="archive-form"><div class="actions"><button id="cancel-archive" class="secondary" type="button" autofocus>Keep customer</button><button id="confirm-archive" class="danger" type="submit">Archive customer</button></div></form>
  </dialog>
  <dialog id="template-dialog" class="wa wa-dialog" aria-labelledby="template-title" aria-describedby="template-description">
    <div class="wa-dlg-head">
      <h2 id="template-title">Send a template</h2>
      <button id="template-close" class="wa-icon-btn" type="button" aria-label="Close template picker" title="Close"></button>
    </div>
    <p id="template-description" class="wa-dlg-desc">Choose an approved WhatsApp template, fill in its variables and check the preview.</p>
    <div id="template-body" class="wa-dlg-body" data-view="list">
      <section class="wa-tpl-col" aria-labelledby="template-list-heading">
        <h3 id="template-list-heading" class="sr-only">Templates</h3>
        <label class="wa-search"><span class="sr-only">Search templates</span><input id="template-search" type="search" placeholder="Search templates" maxlength="100" autocomplete="off" autofocus></label>
        <p id="template-list-status" class="wa-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="template-list-error" class="wa-notice wa-error" role="alert" hidden></p>
        <button id="template-reload" class="wa-text-btn" type="button" hidden>Try again</button>
        <div id="template-list" class="wa-tpl-list"></div>
      </section>
      <section class="wa-tpl-col wa-tpl-detail" aria-labelledby="template-detail-heading">
        <h3 id="template-detail-heading" class="sr-only">Selected template</h3>
        <p id="template-placeholder" class="wa-placeholder-text">Select a template to fill in its variables and see a preview.</p>
        <form id="template-form" hidden>
          <button id="template-back" class="wa-text-btn wa-tpl-back" type="button">Back to templates</button>
          <p id="template-selected" class="wa-tpl-selected"></p>
          <fieldset id="template-fields" class="wa-tpl-fields"><legend class="sr-only">Template variables</legend><div id="template-field-list"></div></fieldset>
          <div class="wa-preview" role="group" aria-label="Preview of the message"><div id="template-preview"></div></div>
          <p id="template-error" class="wa-notice wa-error" role="alert" hidden></p>
          <div class="wa-dlg-actions"><button id="template-cancel" class="wa-text-btn" type="button">Cancel</button><button id="template-send" class="wa-send-btn" type="submit" disabled>Send template</button></div>
        </form>
      </section>
    </div>
  </dialog>
  <dialog id="media-dialog" class="wa media-dialog" aria-label="Image viewer">
    <button id="media-close" class="wa-icon-btn" type="button" aria-label="Close image viewer" title="Close"></button>
    <a id="media-download" class="wa-media-viewer-dl" aria-label="Download image" download><span>Download</span></a>
    <img id="media-image" alt="">
  </dialog>
  <dialog id="config-delete-dialog" aria-labelledby="config-delete-title" aria-describedby="config-delete-description">
    <h2 id="config-delete-title"></h2><p id="config-delete-description"></p>
    <p id="config-delete-name" class="delete-name"></p><p id="config-delete-error" class="error-text" role="alert" hidden></p>
    <form id="config-delete-form"><div class="actions"><button id="cancel-config-delete" class="secondary" type="button" autofocus>Cancel</button><button id="confirm-config-delete" class="danger" type="submit">Delete</button></div></form>
  </dialog>
  <dialog id="autoreply-dialog" class="cfg-dialog" aria-labelledby="autoreply-dialog-title" aria-describedby="autoreply-dialog-description">
    <h2 id="autoreply-dialog-title">Add auto-reply rule</h2>
    <p id="autoreply-dialog-description" class="hint">Linekeep sends the reply when an incoming message matches one of the keywords. Rules are checked from the top of the list and the first match wins.</p>
    <form id="autoreply-form"><fieldset id="autoreply-fields">
      <label>Rule name<input id="autoreply-name" required maxlength="120" autocomplete="off"></label>
      <label>Match type<select id="autoreply-match"><option value="contains">Contains</option><option value="exact">Exactly matches</option><option value="starts_with">Starts with</option></select></label>
      <label>Keywords<textarea id="autoreply-keywords" rows="4" required spellcheck="false" aria-describedby="autoreply-keywords-help"></textarea></label>
      <p id="autoreply-keywords-help" class="hint">One keyword or phrase per line (commas also separate keywords). Up to 20 keywords of up to 100 characters. Matching ignores upper and lower case and extra spaces.</p>
      <fieldset class="choice-group"><legend>Reply type</legend>
        <div class="cfg-radios">
          <label class="checkbox-filter"><input id="autoreply-type-text" type="radio" name="replyType" value="text" checked>Text</label>
          <label class="checkbox-filter"><input id="autoreply-type-template" type="radio" name="replyType" value="template">Template</label>
        </div>
      </fieldset>
      <div id="autoreply-text-group">
        <label>Reply text<textarea id="autoreply-text" rows="4" maxlength="4096" aria-describedby="autoreply-text-help"></textarea></label>
        <p id="autoreply-text-help" class="hint">Placeholders: {{name}} is the customer’s name, {{handler_name}} is the first employee handling the customer, {{handler_phone}} is that employee’s contact number.</p>
      </div>
      <div id="autoreply-template-group" hidden>
        <label>Template<select id="autoreply-template"><option value="">Select a template</option></select></label>
        <p id="autoreply-template-status" class="hint" role="status" aria-live="polite"></p>
        <p id="autoreply-template-error" class="error-text" role="alert" hidden></p>
        <button id="autoreply-template-retry" class="secondary" type="button" hidden>Try again</button>
        <p id="autoreply-template-body" class="cfg-tpl-body" hidden></p>
        <div id="autoreply-template-fields" class="cfg-params"></div>
      </div>
      <label>Cooldown (minutes)<input id="autoreply-cooldown" type="number" inputmode="numeric" min="1" max="10080" step="1" value="1440" required aria-describedby="autoreply-cooldown-help"></label>
      <p id="autoreply-cooldown-help" class="hint">A customer gets this rule’s reply at most once in this time. 1440 minutes is 1 day; the maximum is 10080 (7 days). <span id="autoreply-cooldown-text"></span></p>
      <label class="checkbox-filter"><input id="autoreply-enabled" type="checkbox" checked>Enabled</label>
      <p id="autoreply-dialog-status" role="status" aria-live="polite"></p><p id="autoreply-dialog-error" class="error-text" role="alert" hidden></p>
      <div class="actions"><button id="cancel-autoreply" class="secondary" type="button">Cancel</button><button id="confirm-autoreply" type="submit">Add rule</button></div>
    </fieldset></form>
  </dialog>
  <dialog id="quick-dialog" class="cfg-dialog" aria-labelledby="quick-dialog-title" aria-describedby="quick-dialog-description">
    <h2 id="quick-dialog-title">Add quick message</h2>
    <p id="quick-dialog-description" class="hint">Employees insert this text into the message box of a chat with the lightning button. It is never sent automatically.</p>
    <form id="quick-form"><fieldset id="quick-fields">
      <label>Title<input id="quick-title" required maxlength="80" autocomplete="off"></label>
      <label>Message<textarea id="quick-text" rows="6" required maxlength="4096" aria-describedby="quick-text-help"></textarea></label>
      <p id="quick-text-help" class="hint">Placeholders filled in when inserted: {{name}} is the customer’s name, {{handler_name}} is the first employee handling the customer, {{handler_phone}} is that employee’s contact number.</p>
      <p id="quick-dialog-status" role="status" aria-live="polite"></p><p id="quick-dialog-error" class="error-text" role="alert" hidden></p>
      <div class="actions"><button id="cancel-quick" class="secondary" type="button">Cancel</button><button id="confirm-quick" type="submit">Add quick message</button></div>
    </fieldset></form>
  </dialog>
</body>
</html>`;
