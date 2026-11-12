import { linekeepMark } from "../admin-ui/brand";

/** The static shell of the employee app. All employee data is drawn by the client script after sign-in. */
export const webAppHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Linekeep for employees: your customers, WhatsApp chats and call history.">
  <meta name="color-scheme" content="light">
  <meta name="referrer" content="no-referrer">
  <title>Linekeep</title>
  <link rel="stylesheet" href="/app/styles.css">
  <script src="/app/client.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <noscript><p class="notice error">Turn on JavaScript to use Linekeep on the web.</p></noscript>
  <section id="screen-loading" class="center-screen" aria-busy="true"><p class="muted">Loading…</p></section>
  <section id="screen-message" class="center-screen" hidden>
    <div class="auth-card"><div class="auth-brand">${linekeepMark}<span>Linekeep</span></div><div id="message-body"></div></div>
  </section>
  <section id="screen-signin" class="center-screen" hidden>
    <div class="auth-card"><div class="auth-brand">${linekeepMark}<span>Linekeep</span></div><div id="auth-body"></div></div>
  </section>
  <div id="screen-app" hidden>
    <header class="topbar"><div class="topbar-row">
      <a class="brand" href="#customers">${linekeepMark}<span>Linekeep</span></a>
      <nav class="main-nav" aria-label="Main">
        <a id="nav-customers" href="#customers">Customers</a>
        <a id="nav-whatsapp" href="#whatsapp">WhatsApp<span id="whatsapp-unread" class="tab-badge" hidden><span id="whatsapp-unread-count" aria-hidden="true"></span><span id="whatsapp-unread-text" class="sr-only"></span></span></a>
        <a id="nav-analytics" href="#analytics">Call analytics</a>
      </nav>
      <div class="user-menu">
        <button id="user-button" class="user-button secondary" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="user-menu"><span id="user-initial" class="user-initial" aria-hidden="true"></span><span id="user-name" class="user-name"></span></button>
        <div id="user-menu" class="menu" role="menu" hidden><button id="sign-out" class="secondary menu-item" type="button" role="menuitem">Sign out</button></div>
      </div>
    </div></header>
    <main id="main" tabindex="-1">
      <section id="view-customers" aria-label="Customers" hidden></section>
      <section id="view-whatsapp" aria-label="WhatsApp" hidden></section>
      <section id="view-analytics" aria-label="Call analytics" hidden></section>
    </main>
  </div>
  <p id="toast" class="toast" role="status" hidden></p>
</body>
</html>
`;
