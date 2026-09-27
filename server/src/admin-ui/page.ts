import { linekeepMark } from "./brand";

export const adminHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Call history · Linekeep</title>
  <link rel="stylesheet" href="/admin/styles.css">
  <script src="/admin/client.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar"><div class="shell brand-row">
    <a class="brand" href="/admin">${linekeepMark}Linekeep<span class="brand-caption">ADMIN</span></a>
    <span class="private-label">Private workspace</span>
  </div></header>
  <main id="main" class="shell" tabindex="-1">
    <div class="page-heading"><div><p class="eyebrow">PRIVATE WORKSPACE</p><h1 id="page-title">Call history</h1>
      <p class="lede" id="page-description">Calls and recordings, together.</p></div>
    </div>
    <nav class="tabs" role="tablist" aria-label="Workspace">
      <a id="call-history-tab" role="tab" href="#call-history" aria-controls="call-history-panel" aria-selected="true">Call history</a>
      <a id="employees-tab" role="tab" href="#employees" aria-controls="employees-panel" aria-selected="false" tabindex="-1">Employees</a>
    </nav>
    <noscript><p class="notice error">Enable JavaScript to load recordings, view call history and manage employees.</p></noscript>
    <div id="auth-notice" class="notice error" role="alert" hidden>Your admin session is unavailable. <a href="/admin/login">Sign in again</a>, then refresh this page. Production access is managed by Cloudflare Access.</div>
    <div class="directory-notice"><p id="directory-status" role="status" aria-live="polite"></p><p id="directory-error" class="error-text" role="alert" hidden></p><button id="refresh-directory" class="secondary" type="button">Refresh employee choices</button></div>
    <section id="player-panel" class="panel player-panel" aria-labelledby="player-title" hidden>
      <div class="section-heading"><div><p class="eyebrow">NOW PLAYING</p><h2 id="player-title" tabindex="-1"></h2></div><button id="close-player" class="secondary" type="button">Close player</button></div>
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
    <section id="employees-panel" role="tabpanel" aria-labelledby="employees-tab" hidden>
      <section class="panel" aria-labelledby="directory-heading">
        <div class="section-heading"><div><p class="eyebrow">EMPLOYEE DIRECTORY</p><h2 id="directory-heading" tabindex="-1">Employees</h2></div><button id="employees-refresh" class="secondary" type="button">Refresh directory</button></div>
        <p class="muted">Manage employees even before their first recording. Device handovers do not require employees to repeat setup.</p>
        <form id="employee-form"><fieldset class="create-employee"><legend>Create employee</legend>
          <label>Full name<input name="name" autocomplete="name" required maxlength="200"></label>
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
          <h3 id="invitation-title" tabindex="-1">Invitation ready — shown once</h3>
          <p>Share this code securely with the employee. It is not saved in this browser and cannot be recovered after dismissal. It becomes unusable after redemption, revocation or expiry.</p>
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
    <footer class="footer">Linekeep · Private audio, controlled access.<span>Playback links expire automatically.</span></footer>
  </main>
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
</body>
</html>`;
