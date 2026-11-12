import { analyticsStyles } from "./analytics";
import { callLogsStyles } from "./call-logs";
import { customersStyles } from "./customers";
import { whatsappStyles } from "./whatsapp";

const baseStyles = `
:root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17261f; background: #f3f5f3; font-synthesis: none; --accent: #103F3A; --accent-hover: #1b554b; --line: #dfe4e0; --line-strong: #c4ccc7; --hover: #f3f6f4; --head: #f8faf8; --muted: #55635d; --danger: #942832; --danger-bg: #fff5f5; --danger-line: #eccbd0; --focus: #b56c11; --white: #fff; --wa-green: #00a884; --wa-green-dark: #008069; --wa-out: #d9fdd3; --wa-in: #fff; --wa-bg: #efeae2; --wa-panel: #f0f2f5; --wa-line: #e9edef; --wa-text: #111b21; --wa-sub: #54656f; --shadow: 0 16px 48px rgba(20, 43, 69, .25); }
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; font-size: 14px; line-height: 1.45; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
button, input, select, textarea { font: inherit; }
h1, h2, h3 { text-wrap: balance; margin: 0; }
h1 { font-size: 22px; line-height: 1.25; letter-spacing: -.3px; }
h2 { font-size: 16px; line-height: 1.35; }
h3 { font-size: 14px; }
p { margin: 6px 0; }
button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 4px 14px; border: 1px solid transparent; border-radius: 6px; background: var(--accent); color: var(--white); font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; gap: 8px; }
button:hover:not(:disabled), .button:hover { background: var(--accent-hover); }
button.secondary, a.button.secondary { border-color: var(--line-strong); background: var(--white); color: #29424d; }
button.secondary:hover:not(:disabled), a.button.secondary:hover { background: #edf3f4; }
button.danger { background: #a62d36; }
button:disabled { cursor: not-allowed; opacity: .5; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.icon { width: 20px; height: 20px; fill: currentColor; flex: 0 0 auto; }
.icon-btn { width: 36px; height: 36px; min-height: 36px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted); }
.icon-btn:hover:not(:disabled) { background: rgba(11, 20, 26, .08); color: var(--accent); }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; top: -90px; left: 16px; padding: 12px; background: var(--white); z-index: 50; }
.skip-link:focus { top: 8px; }
.muted, .hint { color: var(--muted); }
.hint { font-size: 12px; }
.lede { color: var(--muted); font-size: 13px; }
.notice { padding: 10px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--white); }
.notice.error { border-color: var(--danger-line); background: var(--danger-bg); color: var(--danger); }
.error-text { color: var(--danger); font-size: 13px; overflow-wrap: anywhere; }
.panel { border: 1px solid var(--line); background: var(--white); padding: 12px 16px; border-radius: 6px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.badge { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; background: #edf1f3; color: #4e626c; }
.empty-state { padding: 28px 18px; text-align: center; }
.empty-state p { color: var(--muted); max-width: 560px; margin: 6px auto; }
.pagination { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 12px 0 24px; font-size: 12px; color: var(--muted); }
.filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 12px; align-items: end; }
label { display: flex; min-width: 0; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--muted); }
input, select, textarea { min-width: 0; width: 100%; min-height: 34px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 8px; background: var(--white); color: #1d3039; font-size: 14px; }
textarea { display: block; min-height: 72px; resize: vertical; }
input::placeholder, textarea::placeholder { color: #687b84; }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 1px; }
input[readonly] { background: var(--head); color: var(--muted); }
input[type=checkbox], input[type=radio] { width: 18px; height: 18px; min-height: 0; margin: 0; accent-color: var(--accent); }
.radio-row { flex-direction: row; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: inherit; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 6px; padding: 0; font-size: 12px; font-weight: 500; color: var(--muted); }
dialog { width: min(520px, calc(100% - 28px)); max-height: calc(100% - 28px); overflow-y: auto; border: 0; border-radius: 8px; padding: 20px; color: inherit; box-shadow: var(--shadow); }
dialog::backdrop { background: rgba(22, 44, 59, .53); }
dialog .actions { justify-content: flex-end; margin-top: 18px; }
.clip-area { position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; }
.toast { position: fixed; left: 50%; bottom: 20px; z-index: 60; transform: translateX(-50%); max-width: min(480px, calc(100% - 32px)); margin: 0; padding: 10px 16px; border-radius: 8px; background: #17261f; color: var(--white); box-shadow: var(--shadow); }
.toast-error { background: #85212a; }

.center-screen { display: grid; min-height: 100vh; place-items: center; padding: 24px 16px; }
.auth-card { width: min(440px, 100%); padding: 28px; border: 1px solid var(--line); border-radius: 10px; background: var(--white); box-shadow: 0 8px 28px rgba(20, 43, 69, .08); }
.auth-brand { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--accent); font-size: 18px; font-weight: 700; }
.auth-title { margin-bottom: 8px; }
.auth-form { display: grid; gap: 14px; margin-top: 14px; }
.auth-form input { min-height: 40px; font-size: 16px; }
.code-input { font-size: 26px !important; letter-spacing: .35em; text-align: center; font-variant-numeric: tabular-nums; }
.auth-email-shown { margin: 4px 0 0; font-weight: 600; overflow-wrap: anywhere; }
.auth-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.method-choice { display: grid; gap: 6px; }

.topbar { position: sticky; top: 0; z-index: 20; background: var(--white); border-bottom: 1px solid var(--line); }
.topbar-row { display: flex; align-items: center; gap: 24px; width: min(1360px, calc(100% - 32px)); min-height: 52px; margin: 0 auto; }
.brand { display: flex; align-items: center; gap: 8px; color: var(--accent); font-size: 18px; font-weight: 700; text-decoration: none; letter-spacing: -.3px; }
.main-nav { display: flex; align-self: stretch; gap: 4px; }
.main-nav a { display: inline-flex; align-items: center; padding: 0 12px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; }
.main-nav a:hover { color: var(--accent); background: var(--hover); }
.main-nav a[aria-current=page] { color: var(--accent); font-weight: 650; border-color: var(--accent); }
.tab-badge, .unread-badge { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--wa-green-dark); color: var(--white); font-size: 11px; font-weight: 700; line-height: 18px; font-variant-numeric: tabular-nums; }
.tab-badge { margin-left: 6px; }
.user-menu { position: relative; margin-left: auto; }
.user-button { gap: 8px; min-height: 36px; }
.user-initial { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: var(--white); font-size: 11px; }
.user-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 160px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--white); box-shadow: var(--shadow); }
.menu-item { width: 100%; justify-content: flex-start; border: 0 !important; }
main { width: min(1360px, calc(100% - 32px)); margin: 0 auto; padding: 16px 0 32px; }
main:focus { outline: none; }
.view-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-bottom: 12px; }

@media (max-width: 760px) {
  .topbar-row { flex-wrap: wrap; gap: 4px 12px; padding: 6px 0; }
  .brand span { display: none; }
  .main-nav { order: 3; width: 100%; overflow-x: auto; }
  .main-nav a { min-height: 40px; }
  .user-name { max-width: 90px; }
  main { width: calc(100% - 20px); }
  .auth-card { padding: 20px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`;

export const webAppStyles = [baseStyles, customersStyles, whatsappStyles, analyticsStyles, callLogsStyles].join("\n");
