export const adminStyles = `
/* Hallmark · checked: 2026-10-30 · genre: modern-minimal (inferred)
 * floor: 0 FAIL · fixed: shell, density, rows, tabs · structural: layout gates left as built
 * built: the project · redesign: full (app) · v2.0.0 */
:root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--c-17352f); background: var(--c-f7f8f4); font-synthesis: none; --accent: #103F3A; --line: #dfe4e0; --line-strong: #c4ccc7; --hover: #f3f6f4; --head: #f8faf8; --muted: #55635d; --wa-green: #00a884; --wa-green-dark: #008069; --wa-out: #d9fdd3; --wa-in: #fff; --wa-bg: #efeae2; --wa-panel: #f0f2f5; --wa-line: #e9edef; --wa-text: #111b21; --wa-sub: #54656f; --c-17352f: #17261f; --c-f7f8f4: #f3f5f3; --c-1b554b: #1b554b; --c-c9d7db: #c9d7db; --c-29424d: #29424d; --c-edf3f4: #edf3f4; --c-a62d36: #a62d36; --c-85212a: #85212a; --c-962b34: #962b34; --c-b56c11: #b56c11; --c-beced3: #beced3; --c-1d3039: #1d3039; --c-687b84: #687b84; --c-eccbd0: #eccbd0; --c-fff5f5: #fff5f5; --c-942832: #942832; --c-edf1f3: #edf1f3; --c-4e626c: #4e626c; --c-b9e7cf: #b9e7cf; --c-815615: #815615; --c-fff3d9: #fff3d9; --c-ffecef: #ffecef; --c-58636a: #58636a; --c-edf0f2: #edf0f2; --c-edf1f2: #edf1f2; --c-a3cecb: #a3cecb; --c-f9fdfc: #f9fdfc; --c-075452: #075452; --c-edf7ee: #edf7ee; --c-142b4540: #142b4540; --c-162c3b88: #162c3b88; --c-f4f6f7: #f4f6f7; --c-0b141a14: #0b141a14; --c-00a88418: #00a88418; --c-667781: #667781; --c-53bdeb: #53bdeb; --c-ea0038: #ea0038; --c-f5c2c0: #f5c2c0; --c-fdecea: #fdecea; --c-ffffffb3: #ffffffb3; --c-00836a: #00836a; --c-2d7fb8: #2d7fb8; --c-8a52c2: #8a52c2; --c-c8553d: #c8553d; --c-9a6a0d: #9a6a0d; --c-3f8f5a: #3f8f5a; --c-bd3f77: #bd3f77; --c-5a6ac8: #5a6ac8; --c-f5f6f6: #f5f6f6; --c-0b141a21: #0b141a21; --c-027eb5: #027eb5; --c-fff3a8: #fff3a8; --c-6b4f00: #6b4f00; --c-efe0a0: #efe0a0; --c-fff5c4: #fff5c4; --c-54440a: #54440a; --c-ffffff26: #ffffff26; --c-fafafa: #fafafa; --c-f0fbf8: #f0fbf8; --c-3b4a54: #3b4a54; --c-c4ced3: #c4ced3; --c-142b4526: #142b4526; --c-dff0e6: #dff0e6; --c-0f5a38: #0f5a38; --c-fbe6e9: #fbe6e9; --c-96283a: #96283a; --c-f0f3ee: #f0f3ee; --c-f8faf6: #f8faf6; --c-8bb4d3: #8bb4d3; --c-4f7fa3: #4f7fa3; --c-9cc5a8: #9cc5a8; --c-5b9071: #5b9071; --c-eef2ed: #eef2ed; --c-e3e9e2: #e3e9e2; --c-9fb0a8: #9fb0a8; --c-0e5a4e: #0e5a4e; --c-f4f8f5: #f4f8f5; --c-f7faf6: #f7faf6; --c-f9fbf8: #f9fbf8; --c-e8f0ea: #e8f0ea; --t-incoming-c: #8bb4d3; --t-incoming-s: #4f7fa3; --t-outgoing-c: #c9dccb; --t-outgoing-s: #7fa384; --t-missed-c: #cf7886; --t-missed-s: #a24a59; --t-rejected-c: #d4968a; --t-rejected-s: #a8625a; --t-blocked-c: #8a8cb8; --t-blocked-s: #5d5f91; --t-voicemail-c: #e3bf9c; --t-voicemail-s: #b98d5d; --t-answered_externally-c: #a9cdc8; --t-answered_externally-s: #5f918a; --t-unknown-c: #cfcac2; --t-unknown-s: #8b857d; --t-other-c: #bdb7a8; --t-other-s: #7d7766; }
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; font-size: 14px; line-height: 1.45; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
button, input, select { font: inherit; }
button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 4px 12px; border: 1px solid transparent; border-radius: 6px; background: var(--accent); color: var(--wa-in); font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; gap: 8px; }
button:hover, .button:hover { background: var(--c-1b554b); }
button:active:not(:disabled), .button:active { transform: translateY(1px); }
@media (prefers-reduced-motion: reduce) { button:active:not(:disabled), .button:active { transform: none; } }
button.secondary { border-color: var(--line-strong); background: var(--wa-in); color: var(--c-29424d); }
button.secondary:hover { background: var(--c-edf3f4); }
button.danger { background: var(--c-a62d36); }
button.danger:hover { background: var(--c-85212a); }
button.delete-button { color: var(--c-962b34); }
button:disabled { cursor: not-allowed; opacity: .5; }
:focus-visible { outline: 3px solid var(--c-b56c11); outline-offset: 3px; }
.skip-link { position: absolute; top: -90px; left: 16px; padding: 12px; background: var(--wa-in); z-index: 10; }
.skip-link:focus { top: 8px; }
.shell { width: min(1280px, calc(100% - 48px)); margin: 0 auto; }
.topbar { position: sticky; top: 0; z-index: 5; background: var(--wa-in); border-bottom: 1px solid var(--line); }
.brand-row { display: flex; align-items: stretch; gap: 32px; min-height: 52px; }
.brand { display: flex; align-items: center; gap: 8px; align-self: center; color: var(--accent); font-size: 18px; font-weight: 700; text-decoration: none; letter-spacing: -.3px; }
.brand-mark { flex-shrink: 0; }
.brand-caption { border-left: 1px solid var(--line); padding-left: 10px; color: var(--muted); font-size: 12px; font-weight: 500; letter-spacing: 0; }
.private-label { align-self: center; margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; }
.page-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 24px; margin: 20px 0 12px; }
h1, h2, h3 { text-wrap: balance; }
h1 { margin: 0; font-size: 22px; line-height: 1.25; letter-spacing: -.3px; }
h2 { margin: 0; font-size: 16px; line-height: 1.35; }
h3 { margin: 0; font-size: 14px; }
p { margin: 6px 0; }
.lede { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.panel { border: 1px solid var(--line); background: var(--wa-in); padding: 12px 16px; border-radius: 6px; }
.section-heading, .results-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.muted, .hint { color: var(--muted); }
.hint { font-size: 12px; }
.filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 12px; align-items: end; }
.filter-grid .wide { grid-column: span 2; }
label { display: flex; min-width: 0; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--muted); }
input, select { min-width: 0; width: 100%; min-height: 32px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 8px; background: var(--wa-in); color: var(--c-1d3039); font-size: 13px; }
input::placeholder { color: var(--c-687b84); }
input:focus-visible, select:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 1px; }
.checkbox-filter { flex-direction: row; align-items: center; gap: 8px; min-height: 32px; align-self: end; width: fit-content; color: inherit; }
.checkbox-filter input { width: 18px; height: 18px; min-height: 0; margin: 0; accent-color: var(--accent); }
.form-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
.form-footer .hint { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.form-footer .actions { flex-shrink: 0; }
.notice { padding: 10px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--wa-in); }
.error { border-color: var(--c-eccbd0); background: var(--c-fff5f5); color: var(--c-942832); }
.error-text { color: var(--c-942832); font-size: 13px; overflow-wrap: anywhere; }
.results-heading { margin: 18px 0 0; }
#call-history-status { color: var(--muted); font-size: 12px; min-height: 18px; }
#action-status:empty, [role=status]:empty { display: none; }
#action-status { color: var(--accent); }
.call-list, .management-list { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--wa-in); }
.call-list:empty, .management-list:empty { border: 0; }
.history-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, .8fr) minmax(0, 1fr) minmax(0, .9fr) minmax(0, 1fr); gap: 4px 16px; align-items: start; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.history-row:hover { background: var(--hover); }
.history-row .cell-label { display: none; }
.history-row:last-child, .management-card:last-child { border-bottom: 0; }
.history-row > div, .management-top > div { min-width: 0; overflow-wrap: anywhere; }
.caller-cell p { margin: 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.employee-cell, .time-cell, .type-cell, .line-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.cell-label { font-size: 12px; font-weight: 500; color: var(--muted); }
.badge { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; background: var(--c-edf1f3); color: var(--c-4e626c); }
.badge.complete { color: var(--accent); background: var(--c-b9e7cf); }
.badge.pending { color: var(--c-815615); background: var(--c-fff3d9); }
.badge.failed { color: var(--c-962b34); background: var(--c-ffecef); }
.badge.deleted { color: var(--c-58636a); background: var(--c-edf0f2); }
.row-details { color: var(--muted); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; width: fit-content; padding: 3px 0; }
.row-details p { margin: 4px 0; }
.history-delete { min-height: 24px; margin-top: 4px; padding: 0 8px; font-size: 12px; font-weight: 500; }
.row-recordings { grid-column: 1 / -1; }
.recording-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; border-top: 1px solid var(--c-edf1f2); padding: 7px 0 2px; }
.recording-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.recording-name { overflow-wrap: anywhere; font-size: 12px; }
.recording-row > .row-details, .recording-row > .player-panel { grid-column: 1 / -1; }
.recording-row button { font-size: 12px; }
.empty-state { padding: 28px 18px; text-align: center; }
.empty-state p { color: var(--muted); max-width: 560px; margin: 6px auto; }
.pagination { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 12px 0 24px; font-size: 12px; color: var(--muted); }
.player-panel { margin-top: 6px; border-color: var(--c-a3cecb); background: var(--c-f9fdfc); width: 100%; min-width: 0; }
.player-panel h2 { font-size: 15px; overflow-wrap: anywhere; }
audio { width: 100%; margin: 4px 0; }
.tabs { display: flex; gap: 4px; align-self: stretch; margin: 0; }
.tabs a { display: inline-flex; align-items: center; padding: 0 12px; color: var(--muted); font-size: 13px; font-weight: 500; text-decoration: none; border-bottom: 2px solid transparent; }
.tabs a:hover { color: var(--accent); background: var(--hover); }
.tabs a[aria-selected=true] { color: var(--accent); font-weight: 650; border-color: var(--accent); }
.tab-badge, .wa-unread-badge { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--wa-green-dark); color: var(--wa-in); font-size: 11px; font-weight: 700; line-height: 18px; font-variant-numeric: tabular-nums; }
.tab-badge { margin-left: 6px; }
.directory-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 12px; color: var(--muted); }
.directory-notice p { margin: 0; }
.directory-notice button { min-height: 24px; padding: 0 8px; font-size: 12px; font-weight: 500; }
#employees-panel { display: grid; gap: 16px; }
.management-list { margin-top: 10px; }
.management-card { min-width: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; overflow-wrap: anywhere; }
#employees-panel > .panel, #customers-panel > .panel { border: 0; padding: 0; background: transparent; }
.management-card { padding: 8px 12px; }
.management-card .actions button { min-height: 28px; padding: 2px 10px; font-size: 12px; font-weight: 500; }
.management-top { display: flex; align-items: center; justify-content: space-between; gap: 8px 18px; }
.management-top .actions { flex-shrink: 0; }
.management-card form { margin-top: 10px; }
.management-card form .actions { margin-top: 8px; }
.management-card .hint { margin: 3px 0; }
.management-filter { max-width: 520px; }
.device-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 10px 0; }
dt { font-size: 10px; color: var(--muted); margin-bottom: 2px; }
dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.create-employee { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; margin: 14px 0 8px; }
.create-employee label { flex: 1 1 220px; margin: 0; }
.create-employee button { margin: 0; }
.management-card [role=status], #employees-panel > .panel > [role=status] { font-size: 12px; color: var(--muted); }
fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
legend { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
fieldset label { margin-bottom: 10px; }
fieldset button { margin-top: 4px; }
.invitation-result { padding: 16px; background: var(--c-edf7ee); border: 1px solid var(--c-b9e7cf); border-radius: 7px; margin-top: 14px; overflow-wrap: anywhere; }
.invitation-result p { font-size: 13px; }
.invitation-qr:empty { display: none; }
.invitation-qr svg { display: block; width: min(280px, 100%); height: auto; margin: 8px 0; border: 1px solid var(--c-b9e7cf); border-radius: 6px; background: var(--wa-in); }
#invitation-code { font: 17px ui-monospace, monospace; margin-top: 4px; }
.footer { display: flex; justify-content: space-between; gap: 12px; padding: 16px 0 24px; font-size: 12px; color: var(--muted); }
dialog { width: min(520px, calc(100% - 28px)); max-height: calc(100% - 28px); overflow-y: auto; border: 0; border-radius: 8px; padding: 20px; color: inherit; box-shadow: 0 16px 48px var(--c-142b4540); }
dialog::backdrop { background: var(--c-162c3b88); }
dialog .actions { justify-content: flex-end; margin-top: 18px; }
.delete-name { padding: 10px; background: var(--c-f4f6f7); border-radius: 6px; overflow-wrap: anywhere; font-size: 13px; }
textarea { font: inherit; display: block; min-width: 0; width: 100%; min-height: 72px; border: 1px solid var(--c-beced3); border-radius: 6px; padding: 6px 8px; background: var(--wa-in); color: var(--c-1d3039); font-size: 14px; resize: vertical; }
textarea:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 1px; }
a.button.secondary { border-color: var(--c-c9d7db); background: var(--wa-in); color: var(--c-29424d); }
a.button.secondary:hover { background: var(--c-edf3f4); }
#customers-panel, #whatsapp-panel { display: grid; gap: 16px; }
#customers-browse { display: grid; gap: 0; }
#customers-status, #customer-calls-status { color: var(--muted); font-size: 12px; }
#customers-action-status, #customer-detail-status, #customer-calls-action-status { color: var(--accent); }
.customer-row .actions-cell { align-content: flex-start; }
.customer-row .actions-cell button { font-size: 12px; }
.customer-row .time-cell .cell-label:not(:first-child) { margin-top: 4px; }
.detail-section { margin-top: 22px; }
.detail-section .section-heading { margin-bottom: 4px; }
.fact-wide { grid-column: 1 / -1; }
dd.pre { white-space: pre-wrap; }
.field-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.choice-group { margin: 0 0 10px; }
.choice-group .hint { margin: 0 0 6px; }
.choice-list { display: grid; gap: 2px; max-height: 200px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.choice-list:empty { display: none; }
.choice-list .checkbox-filter { align-self: auto; width: auto; max-width: 100%; margin: 0; font-weight: 500; font-size: 13px; overflow-wrap: anywhere; }
.choice-list .hint { margin: 4px 0; }
dialog.bulk-dialog { width: min(780px, calc(100% - 20px)); }
.bulk-steps { display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 10px 0 14px; padding: 0; list-style: none; counter-reset: bulk; }
.bulk-steps li { counter-increment: bulk; padding: 2px 10px; border: 1px solid var(--line); border-radius: 12px; font-size: 12px; color: var(--muted); }
.bulk-steps li::before { content: counter(bulk) ". "; }
.bulk-steps li[aria-current=step] { border-color: var(--accent); background: var(--accent); color: var(--wa-in); font-weight: 600; }
.bulk-step { display: grid; gap: 10px; }
.bulk-step h3 { margin: 0; font-size: 15px; }
.bulk-step h3:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bulk-step fieldset { min-width: 0; margin: 0; border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px 10px; }
.bulk-step legend { padding: 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.bulk-step p, .bulk-step ol { margin: 0; }
.bulk-file-actions { margin-top: 0; justify-content: flex-start; }
dialog .bulk-file-actions { margin-top: 0; justify-content: flex-start; }
.bulk-file-label { cursor: pointer; }
.bulk-file-actions input:focus-visible + .bulk-file-label { outline: 2px solid var(--accent); outline-offset: 2px; }
.bulk-summary { font-size: 13px; font-weight: 600; }
.bulk-table { max-height: min(340px, 45vh); overflow: auto; }
.bulk-table table { width: 100%; min-width: 520px; border-collapse: collapse; font-size: 13px; }
.bulk-table th, .bulk-table td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.bulk-table thead th { position: sticky; top: 0; background: var(--c-f4f8f5); font-size: 12px; }
.bulk-table tbody tr:last-child td { border-bottom: 0; }
.bulk-table td.bulk-bad { color: var(--c-942832); }
.bulk-table td.bulk-good { color: var(--c-0f5a38); }
.bulk-warning { margin: 0; font-size: 13px; border-color: var(--c-b56c11); background: var(--c-fff3d9); color: var(--c-815615); }
.bulk-vars { display: grid; gap: 8px; }
.bulk-var { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 4px 8px; align-items: end; }
.bulk-var > span { grid-column: 1 / -1; font-size: 12px; font-weight: 600; color: var(--muted); }
.bulk-var input[hidden] { display: none; }
.bulk-header { display: grid; gap: 6px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; }
.bulk-header .actions, dialog .bulk-header .actions { margin-top: 0; justify-content: flex-start; }
.bulk-header .bulk-warn { color: var(--c-942832); }
.bulk-bubble { padding: 8px 10px; border-radius: 8px; background: var(--wa-out); color: var(--wa-text); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bulk-bubble mark { background: var(--c-fff3a8); color: var(--c-6b4f00); border-radius: 3px; padding: 0 2px; }
.bulk-bubble .bulk-bubble-part + .bulk-bubble-part { margin-top: 6px; }
.bulk-bubble .bulk-bubble-footer { color: var(--wa-sub); font-size: 12px; }
#bulk-progress { width: 100%; height: 14px; accent-color: var(--accent); }
.bulk-sample { color: var(--muted); }
.wa { color: var(--wa-text); }
.wa .wa-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 40px; height: 40px; min-height: 40px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--wa-sub); }
.wa .wa-icon-btn:hover { background: var(--c-0b141a14); }
.wa .wa-icon-btn:disabled { opacity: .4; color: var(--wa-sub); background: transparent; cursor: not-allowed; }
.wa .wa-text-btn { min-height: 32px; padding: 4px 10px; border: 0; border-radius: 16px; background: transparent; color: var(--wa-green-dark); font-weight: 650; }
.wa .wa-text-btn:hover { background: var(--c-00a88418); }
.wa .wa-send-btn { min-height: 38px; padding: 6px 20px; border: 0; border-radius: 19px; background: var(--wa-green-dark); color: var(--wa-in); font-weight: 650; }
.wa .wa-send-btn:hover { background: var(--wa-text); }
.wa .wa-send { background: var(--wa-green-dark); color: var(--wa-in); }
.wa .wa-send:hover { background: var(--wa-green-dark); }
.wa-icon { width: 22px; height: 22px; fill: currentColor; flex-shrink: 0; }
.wa-mark { display: inline-flex; align-items: center; color: var(--c-667781); }
.wa-mark .wa-icon { width: 16px; height: 16px; }
.wa-mark.wa-read { color: var(--c-53bdeb); }
.wa-mark.wa-failed { color: var(--c-ea0038); }
.wa-status { margin: 0; padding: 2px 16px; color: var(--wa-sub); font-size: 11px; }
.wa-status:empty { display: none; }
.wa-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 8px 12px; padding: 8px 10px; border-radius: 8px; font-size: 13px; overflow-wrap: anywhere; }
.wa-error { border: 1px solid var(--c-f5c2c0); background: var(--c-fdecea); color: var(--c-a62d36); }
.wa-empty { max-width: 420px; margin: 16px auto; padding: 8px 14px; border-radius: 8px; background: var(--c-ffffffb3); color: var(--wa-sub); text-align: center; font-size: 13px; }
.wa-hint { margin: 0; color: var(--wa-sub); font-size: 13px; }
.wa-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 49px; height: 49px; border-radius: 50%; color: var(--wa-in); font-size: 17px; font-weight: 650; }
.wa-av0 { background: var(--c-00836a); } .wa-av1 { background: var(--c-2d7fb8); } .wa-av2 { background: var(--c-8a52c2); } .wa-av3 { background: var(--c-c8553d); }
.wa-av4 { background: var(--c-9a6a0d); } .wa-av5 { background: var(--c-3f8f5a); } .wa-av6 { background: var(--c-bd3f77); } .wa-av7 { background: var(--c-5a6ac8); }
.wa-app { display: grid; grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); height: max(520px, calc(100vh - 180px)); height: max(520px, calc(100dvh - 180px)); border: 1px solid var(--wa-line); border-radius: 8px; overflow: hidden; background: var(--wa-in); }
.wa-side { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--wa-line); background: var(--wa-in); }
.wa-side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 56px; padding: 8px 8px 8px 16px; background: var(--wa-panel); }
.wa-side-head h2 { font-size: 18px; }
.wa-filters { display: grid; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--wa-line); }
.wa-search { display: block; font-weight: 400; }
.wa-search input { height: 36px; min-height: 36px; padding: 0 14px; border: 1px solid transparent; border-radius: 8px; background: var(--wa-panel); }
.wa-search input:focus-visible { outline: 2px solid var(--wa-green); outline-offset: 1px; border-color: var(--wa-green); background: var(--wa-in); }
.wa-employee select { height: 32px; min-height: 32px; padding: 0 8px; border-color: var(--wa-line); border-radius: 8px; background: var(--wa-in); font-size: 13px; }
.wa-chats { flex: 1; min-height: 0; overflow-y: auto; }
.wa-chats .empty-state { padding: 24px 16px; }
.wa-more { display: flex; justify-content: center; }
.wa-more:has(button[hidden]) { display: none; }
.wa .wa-chat { display: flex; align-items: center; gap: 13px; width: 100%; min-height: 72px; padding: 0 0 0 14px; border: 0; border-radius: 0; background: var(--wa-in); color: inherit; text-align: left; font-weight: 400; }
.wa .wa-chat:hover { background: var(--c-f5f6f6); }
.wa .wa-chat[aria-current=true] { background: var(--wa-panel); }
.wa-chat-body { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 1px; align-self: stretch; min-width: 0; padding: 9px 14px 9px 0; border-bottom: 1px solid var(--wa-line); }
.wa-chat-top { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.wa-chat-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 500; }
.wa-chat-time { flex-shrink: 0; color: var(--wa-sub); font-size: 12px; }
.wa-unread-badge { margin-left: auto; }
.wa .wa-chat.wa-unread .wa-chat-name, .wa .wa-chat.wa-unread .wa-chat-time { font-weight: 700; }
.wa .wa-chat.wa-unread .wa-chat-time { color: var(--wa-green-dark); }
.wa-chat-preview { display: flex; align-items: center; gap: 3px; min-width: 0; color: var(--wa-sub); font-size: 14px; }
.wa-chat-snippet { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wa-chat-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wa-sub); font-size: 11.5px; }
.wa-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--wa-bg); }
.wa-placeholder { display: flex; flex: 1; align-items: center; justify-content: center; padding: 24px; background: var(--wa-panel); color: var(--wa-sub); text-align: center; }
.wa-conv { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; background: var(--wa-bg); }
.wa-conv-head { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px 8px 16px; background: var(--wa-panel); border-bottom: 1px solid var(--wa-line); }
.wa-head-avatar .wa-avatar { width: 40px; height: 40px; font-size: 15px; }
.wa-head-text { flex: 1; min-width: 0; }
.wa-head-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 500; }
.wa-conv-head { position: relative; }
.wa-head-sub .wa-handler-btn { min-height: 0; padding: 0 2px; border: 0; border-radius: 3px; background: transparent; color: var(--accent, #103F3A); font: inherit; font-weight: 500; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.wa-head-sub .wa-handler-btn:hover, .wa-head-sub .wa-handler-btn[aria-expanded="true"] { background: transparent; color: var(--accent, #103F3A); text-decoration-style: solid; }
.wa-head-sub .wa-handler-btn:focus-visible { outline: 2px solid var(--accent, #103F3A); outline-offset: 2px; background: transparent; }
.wa-handler-panel { position: absolute; z-index: 20; top: 100%; left: 56px; width: min(320px, calc(100% - 72px)); max-height: 60vh; overflow: auto; padding: 12px; border: 1px solid var(--border, #d9e0d6); border-radius: 10px; background: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14); }
.wa-handler-title { margin: 0 0 8px; font-weight: 600; font-size: 14px; }
.wa-handler-choices { display: grid; gap: 4px; }
.wa-handler-error { margin: 8px 0 0; color: var(--error, #a02020); font-size: 13px; }
.wa-handler-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.wa-head-sub { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wa-sub); font-size: 13px; }
.wa .wa-back { display: none; margin-left: -8px; }
.wa-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 6% 8px; background: var(--wa-bg); }
.wa .wa-older { display: flex; margin: 0 auto 8px; min-height: 32px; padding: 4px 14px; border: 0; border-radius: 8px; background: var(--wa-in); color: var(--wa-green-dark); font-size: 13px; font-weight: 650; box-shadow: 0 1px 1px var(--c-0b141a21); }
.wa .wa-older:hover { background: var(--c-f5f6f6); }
.wa-list { display: flex; flex-direction: column; gap: 2px; }
.wa-day { display: flex; justify-content: center; align-self: center; margin: 10px 0 6px; }
.wa-day span { padding: 5px 12px; border-radius: 8px; background: var(--wa-in); box-shadow: 0 1px 1px var(--c-0b141a21); color: var(--wa-sub); font-size: 12.5px; }
.wa-msg { display: flex; flex-direction: column; min-width: 0; max-width: min(75%, 560px); }
.wa-msg.in { align-self: flex-start; }
.wa-msg.out { align-self: flex-end; }
.wa-msg.wa-first { margin-top: 6px; }
.wa-bubble { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: 0 8px; padding: 6px 8px 5px 9px; border-radius: 8px; box-shadow: 0 1px 1px var(--c-0b141a21); font-size: 14.2px; line-height: 19px; overflow-wrap: anywhere; }
.wa-msg.in .wa-bubble { background: var(--wa-in); }
.wa-msg.out .wa-bubble { background: var(--wa-out); }
.wa-msg.wa-first.in .wa-bubble { border-top-left-radius: 0; }
.wa-msg.wa-first.out .wa-bubble { border-top-right-radius: 0; }
.wa-msg.wa-first .wa-bubble::before { content: ""; position: absolute; top: 0; width: 8px; height: 13px; }
.wa-msg.wa-first.in .wa-bubble::before { left: -8px; background: var(--wa-in); clip-path: polygon(0 0, 100% 0, 100% 100%); }
.wa-msg.wa-first.out .wa-bubble::before { right: -8px; background: var(--wa-out); clip-path: polygon(0 0, 100% 0, 0 100%); }
.wa-tag { flex: 0 0 100%; margin-bottom: 1px; color: var(--wa-green-dark); font-size: 12px; font-weight: 600; }
.wa-text { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; text-align: left; }
.wa-meta { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 3px; margin-left: auto; padding-top: 2px; color: var(--wa-sub); font-size: 11px; line-height: 15px; white-space: nowrap; }
.wa-by { max-width: 110px; margin-right: 4px; overflow: hidden; text-overflow: ellipsis; }
.wa-tpl-header { flex: 0 0 100%; font-weight: 700; white-space: pre-wrap; }
.wa-media { flex: 0 0 100%; min-width: 0; margin-bottom: 4px; }
.wa-media-btn { display: block; width: fit-content; max-width: 100%; min-height: 0; padding: 0; border: 0; border-radius: 6px; background: var(--wa-panel); color: inherit; line-height: 0; overflow: hidden; cursor: zoom-in; }
.wa-media-btn:hover, .wa-media-btn:active { background: var(--wa-panel); transform: none; }
.wa-media-sticker .wa-media-btn:hover, .wa-media-sticker .wa-media-btn:active { background: transparent; }
.wa-media-btn:focus-visible { outline: 2px solid var(--wa-green-dark); outline-offset: 2px; }
.wa-media-btn img { display: block; width: auto; max-width: min(240px, 60vw); height: auto; min-width: 96px; min-height: 96px; border-radius: 6px; object-fit: contain; }
.wa-media-loaded .wa-media-btn img { min-width: 0; min-height: 0; }
.wa-media-sticker .wa-media-btn { background: transparent; }
.wa-media-sticker .wa-media-btn img { max-width: min(140px, 40vw); min-width: 64px; min-height: 64px; }
.wa-sticker { background: transparent !important; box-shadow: none; }
.wa-sticker::before { display: none; }
.wa-has-sticker .wa-media-btn img { max-width: min(140px, 40vw); }
.wa-media video { display: block; width: 240px; max-width: 100%; height: auto; border-radius: 6px; background: var(--wa-text); }
.wa-media audio { display: block; width: 260px; max-width: 100%; height: 40px; }
.wa-media-document { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; border-radius: 6px; background: var(--wa-panel); }
.wa-doc-icon { display: inline-flex; flex: 0 0 auto; color: var(--wa-sub); }
.wa-doc-info { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; max-width: 180px; }
.wa-doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.wa-doc-size { color: var(--wa-sub); font-size: 12px; }
.wa-doc-link { flex: 0 0 auto; color: var(--wa-green-dark); font-weight: 650; font-size: 13px; }
.wa-media-frame { position: relative; width: fit-content; max-width: 100%; }
.wa-media-audio-frame { display: flex; align-items: center; gap: 6px; width: auto; }
.wa .wa-media-dl { width: 30px; height: 30px; min-height: 30px; background: var(--wa-in); color: var(--wa-text); box-shadow: 0 1px 2px var(--c-0b141a21); text-decoration: none; }
.wa .wa-media-dl:hover { background: var(--wa-panel); }
.wa .wa-media-dl:focus-visible { outline: 2px solid var(--wa-green-dark); outline-offset: 2px; }
.wa .wa-media-dl .wa-icon { width: 18px; height: 18px; }
.wa-media-frame:not(.wa-media-audio-frame) .wa-media-dl { position: absolute; top: 6px; right: 6px; opacity: 0; transition: opacity .12s; }
.wa-media-frame:hover .wa-media-dl, .wa-media-frame:focus-within .wa-media-dl { opacity: 1; }
.wa-scroll-wrap { position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; }
.wa .wa-new-pill { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); min-height: 32px; padding: 4px 16px; border: 0; border-radius: 16px; background: var(--wa-green-dark); color: var(--wa-in); font-size: 13px; font-weight: 650; box-shadow: 0 1px 3px var(--c-0b141a21); }
.wa .wa-new-pill:hover { background: var(--wa-green-dark); transform: translateX(-50%); }
.wa .wa-new-pill:focus-visible { outline: 2px solid var(--wa-text); outline-offset: 2px; }
.wa-media-failed { padding: 2px 0; }
.wa-media-gone { color: var(--wa-sub); font-size: 13px; font-style: italic; }
dialog.media-dialog { position: fixed; inset: 0; width: min(96vw, 1000px); max-width: none; height: min(96vh, 900px); height: min(96dvh, 900px); max-height: none; margin: auto; padding: 0; overflow: hidden; border-radius: 8px; background: var(--wa-text); }
dialog.media-dialog[open] { display: flex; align-items: center; justify-content: center; }
dialog.media-dialog img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
dialog.media-dialog .wa-icon-btn { position: absolute; top: 8px; right: 8px; background: var(--wa-in); color: var(--wa-text); }
dialog.media-dialog .wa-icon-btn:hover { background: var(--wa-panel); }
dialog.media-dialog .wa-media-viewer-dl { position: absolute; top: 8px; left: 8px; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 20px; background: var(--wa-in); color: var(--wa-text); font-size: 14px; font-weight: 650; text-decoration: none; }
dialog.media-dialog .wa-media-viewer-dl:hover { background: var(--wa-panel); }
dialog.media-dialog .wa-media-viewer-dl:focus-visible { outline: 2px solid var(--wa-green-dark); outline-offset: 2px; }
dialog.media-dialog .wa-media-viewer-dl .wa-icon { width: 20px; height: 20px; }
.wa-tpl-footer { flex: 0 0 100%; margin-top: 2px; color: var(--wa-sub); font-size: 12.5px; line-height: 17px; white-space: pre-wrap; }
.wa-tpl-btns { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.wa-tpl-btn { padding: 8px 10px; border-radius: 8px; background: var(--wa-in); box-shadow: 0 1px 1px var(--c-0b141a21); color: var(--c-027eb5); font-size: 14px; font-weight: 500; text-align: center; overflow-wrap: anywhere; }
.wa-var { padding: 0 3px; border-radius: 3px; background: var(--c-fff3a8); color: var(--c-6b4f00); }
.wa-banner { margin: 0; padding: 8px 16px; border-top: 1px solid var(--c-efe0a0); background: var(--c-fff5c4); color: var(--c-54440a); font-size: 13px; text-align: center; overflow-wrap: anywhere; }
.wa-composer { display: flex; align-items: flex-end; gap: 6px; padding: 8px 10px; background: var(--wa-panel); }
.wa .wa-input { flex: 1; min-width: 0; width: auto; height: auto; min-height: 42px; max-height: 120px; padding: 10px 14px; border: 1px solid transparent; border-radius: 21px; background: var(--wa-in); color: var(--wa-text); font-size: 15px; line-height: 20px; resize: none; field-sizing: content; }
.wa .wa-input:focus-visible { border-color: var(--wa-green); outline: 0; }
.wa .wa-input:disabled { background: var(--wa-line); cursor: not-allowed; }
.wa-embedded { display: flex; flex-direction: column; height: min(640px, 80vh); height: min(640px, 80dvh); margin-top: 8px; overflow: hidden; border: 1px solid var(--wa-line); border-radius: 8px; }
.wa-embedded .wa-scroll { padding: 12px; }
dialog.wa-dialog { width: min(940px, calc(100% - 20px)); height: min(680px, calc(100vh - 28px)); height: min(680px, calc(100dvh - 28px)); padding: 0; overflow: hidden; border-radius: 12px; }
dialog.wa-dialog[open] { display: flex; flex-direction: column; }
.wa-dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 20px; background: var(--wa-green-dark); color: var(--wa-in); }
.wa-dlg-head h2 { font-size: 18px; }
.wa .wa-dlg-head .wa-icon-btn { color: var(--wa-in); }
.wa .wa-dlg-head .wa-icon-btn:hover { background: var(--c-ffffff26); }
.wa-dlg-desc { margin: 0; padding: 10px 20px; border-bottom: 1px solid var(--wa-line); color: var(--wa-sub); font-size: 13px; }
.wa-dlg-body { display: grid; flex: 1; grid-template-columns: minmax(240px, 5fr) minmax(0, 6fr); min-height: 0; }
.wa-tpl-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; padding: 12px; overflow-y: auto; }
.wa-tpl-col + .wa-tpl-col { border-left: 1px solid var(--wa-line); background: var(--c-fafafa); }
.wa-tpl-col > .wa-notice { margin: 0; }
.wa-tpl-col > .wa-status { padding: 0; }
.wa-tpl-list { display: flex; flex-direction: column; gap: 6px; }
.wa .wa-tpl-item { display: flex; flex-direction: column; align-items: stretch; gap: 2px; min-height: 0; padding: 9px 11px; border: 1px solid var(--wa-line); border-radius: 8px; background: var(--wa-in); color: inherit; font-weight: 400; text-align: left; }
.wa .wa-tpl-item:hover { background: var(--c-f5f6f6); }
.wa .wa-tpl-item[aria-pressed=true] { border-color: var(--wa-green); background: var(--c-f0fbf8); box-shadow: inset 0 0 0 1px var(--wa-green); }
.wa .wa-tpl-item.wa-disabled { background: var(--c-f5f6f6); cursor: not-allowed; }
.wa-tpl-name { overflow-wrap: anywhere; font-weight: 650; }
.wa-tpl-sub { color: var(--wa-sub); font-size: 12px; }
.wa-tpl-snippet { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--c-3b4a54); font-size: 13px; overflow-wrap: anywhere; }
.wa-disabled .wa-tpl-name, .wa-disabled .wa-tpl-snippet { color: var(--c-667781); }
.wa-tpl-reason { color: var(--c-a62d36); font-size: 12px; }
.wa-placeholder-text { margin: 24px 0; color: var(--wa-sub); text-align: center; }
#template-form { display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
.wa-tpl-selected { margin: 0; color: var(--wa-sub); font-size: 13px; overflow-wrap: anywhere; }
.wa-tpl-fields { min-width: 0; margin: 0; padding: 0; border: 0; }
#template-field-list { display: grid; gap: 10px; }
.wa-field { display: flex; min-width: 0; flex-direction: column; gap: 3px; font-weight: 400; }
.wa-field-label { font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
.wa-field input, .wa-field select { height: 38px; padding: 0 10px; border-color: var(--c-c4ced3); border-radius: 8px; }
.wa-field input:focus-visible, .wa-field select:focus-visible { border-color: var(--wa-green); outline: 2px solid var(--wa-green); outline-offset: 1px; }
.wa-field-row { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr); gap: 6px; }
.wa-field-hint { color: var(--c-a62d36); font-size: 12px; }
.wa-preview { display: flex; flex-direction: column; padding: 14px 14px 14px 10px; border-radius: 8px; background: var(--wa-bg); }
.wa-preview .wa-msg { max-width: min(100%, 360px); }
.wa-dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; padding-top: 4px; }
.wa .wa-tpl-back { display: none; align-self: flex-start; }
#analytics-panel { display: grid; gap: 16px; }
.svg-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.analytics-title { font-size: 18px; letter-spacing: -.2px; overflow-wrap: anywhere; }
.preset-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
button.chip { min-height: 30px; padding: 3px 12px; border-radius: 999px; font-size: 12px; }
button.chip[aria-pressed=true] { border-color: var(--accent); background: var(--c-edf7ee); color: var(--accent); }
.analytics-filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 10px; align-items: end; }
.analytics-apply { display: flex; }
.analytics-apply button { width: 100%; }
.multi-field { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.field-label { font-size: 12px; font-weight: 650; }
details.multi { position: relative; min-width: 0; }
details.multi > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 36px; padding: 6px 8px; border: 1px solid var(--c-beced3); border-radius: 6px; background: var(--wa-in); color: var(--c-1d3039); font-size: 14px; list-style: none; cursor: pointer; }
details.multi > summary::-webkit-details-marker { display: none; }
details.multi > summary::after { content: '▾'; color: var(--muted); flex-shrink: 0; }
details.multi[open] > summary { border-color: var(--accent); }
details.multi > summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.multi-menu { position: absolute; z-index: 6; top: 100%; left: 0; min-width: max(100%, 250px); max-width: min(360px, calc(100vw - 20px)); margin-top: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--wa-in); box-shadow: 0 2px 8px var(--c-142b4526); }
.multi-menu .choice-list { max-height: 240px; margin-bottom: 8px; }
.multi-menu .choice-list .checkbox-filter { display: flex; align-items: center; gap: 8px; }
.multi-menu .actions button { font-size: 12px; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.kpi { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--wa-in); }
.kpi-label { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: 12px; font-weight: 500; }
.kpi-value { margin: 0; font-size: 24px; font-weight: 650; line-height: 1.2; letter-spacing: -.3px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.kpi-sub { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.kpi-delta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 4px 0 0; min-height: 22px; font-size: 11px; color: var(--muted); }
.delta { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 750; background: var(--c-edf1f3); color: var(--c-4e626c); white-space: nowrap; }
.delta.good { background: var(--c-dff0e6); color: var(--c-0f5a38); }
.delta.bad { background: var(--c-fbe6e9); color: var(--c-96283a); }
.analytics-skeleton { display: grid; gap: 16px; }
.skeleton { min-height: 104px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(90deg, var(--c-f0f3ee), var(--c-f8faf6), var(--c-f0f3ee)); background-size: 200% 100%; }
.skeleton-chart { min-height: 220px; }
#analytics-content { display: grid; gap: 16px; transition: opacity .15s ease; }
#analytics-content.is-loading { opacity: .55; }
#analytics-status { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
#analytics-error { margin: 0 0 12px; }
.chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.chart-card { min-width: 0; }
.chart-wide { grid-column: 1 / -1; }
.chart-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; margin-bottom: 6px; }
.chart-head .hint { margin: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 8px; padding: 0; font-size: 12px; color: var(--muted); }
.legend:empty { display: none; }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.sw { flex-shrink: 0; }
.sw .seg { stroke-width: 1; }
.chart-body { min-width: 0; }
.chart-svg { display: block; width: 100%; max-width: 100%; height: auto; overflow: visible; }
.chart-empty { margin: 14px 0; color: var(--muted); }
.chart-summary { margin: 8px 0 0; color: var(--c-29424d); font-size: 13px; overflow-wrap: anywhere; }
.chart-summary:empty { display: none; }
.t-incoming { --c: var(--t-incoming-c); --s: var(--t-incoming-s); }
.t-outgoing { --c: var(--t-outgoing-c); --s: var(--t-outgoing-s); }
.t-missed { --c: var(--t-missed-c); --s: var(--t-missed-s); }
.t-rejected { --c: var(--t-rejected-c); --s: var(--t-rejected-s); }
.t-blocked { --c: var(--t-blocked-c); --s: var(--t-blocked-s); }
.t-voicemail { --c: var(--t-voicemail-c); --s: var(--t-voicemail-s); }
.t-answered_externally { --c: var(--t-answered_externally-c); --s: var(--t-answered_externally-s); }
.t-unknown { --c: var(--t-unknown-c); --s: var(--t-unknown-s); }
.t-other { --c: var(--t-other-c); --s: var(--t-other-s); }
.seg { fill: var(--c); stroke: var(--s); stroke-width: .75; }
.bar-blue { fill: var(--c-8bb4d3); stroke: var(--c-4f7fa3); stroke-width: .75; }
.bar-rate { fill: var(--c-9cc5a8); stroke: var(--c-5b9071); stroke-width: .75; }
.track { fill: var(--c-eef2ed); }
.ch-text { fill: var(--c-17352f); font-size: 11px; }
.ch-muted { fill: var(--muted); }
.ch-strong { font-weight: 700; }
.ch-seg-label { font-size: 10px; pointer-events: none; }
.ch-grid { stroke: var(--c-e3e9e2); stroke-width: 1; }
.ch-axis { stroke: var(--c-9fb0a8); stroke-width: 1; }
.rate-line { fill: none; stroke: var(--c-0e5a4e); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.rate-dot { fill: var(--wa-in); stroke: var(--c-0e5a4e); stroke-width: 2; }
.heat-peak { fill: none; stroke: var(--c-17352f); stroke-width: 2; pointer-events: none; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 7px; }
.leaderboard { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 13px; }
.leaderboard th, .leaderboard td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
.leaderboard th:first-child, .leaderboard td:first-child { position: sticky; left: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; text-align: left; background: var(--wa-in); }
.leaderboard thead th { background: var(--c-f4f8f5); font-weight: 700; padding: 0; }
.leaderboard thead th:first-child { background: var(--c-f4f8f5); }
.leaderboard tbody tr:last-child td { border-bottom: 0; }
.leaderboard tbody tr:hover td { background: var(--c-f7faf6); }
.leaderboard tfoot td { border-top: 2px solid var(--line); border-bottom: 0; background: var(--c-f9fbf8); font-weight: 700; }
.leaderboard tfoot td:first-child { background: var(--c-f9fbf8); }
button.sort { display: flex; width: 100%; min-height: 38px; padding: 8px 10px; border: 0; border-radius: 0; background: transparent; color: var(--c-29424d); font-size: 12px; font-weight: 700; gap: 4px; justify-content: flex-end; }
th:first-child > button.sort { justify-content: flex-start; }
button.sort:hover { background: var(--c-e8f0ea); }
button.sort .sort-mark { display: inline-block; min-width: 10px; color: var(--accent); }
.ch-light { fill: var(--wa-in); }
@media (max-width: 900px) {
  .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .history-row { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; }
  .management-top { flex-wrap: wrap; }
  .management-top .actions { flex-shrink: 1; }
  .form-footer { align-items: flex-start; flex-direction: column; gap: 10px; }
  .customer-row .actions-cell { grid-column: 1 / -1; }
}
@media (max-width: 560px) {
  .shell { width: calc(100% - 20px); }
  .brand-row { min-height: 50px; gap: 8px; }
  .brand { font-size: 19px; gap: 8px; }
  .brand-caption { padding-left: 8px; font-size: 9px; }
  .private-label { font-size: 10px; }
  .page-heading { margin: 16px 0 12px; }
  h1 { font-size: 27px; }
  .panel { padding: 12px; }
  .filter-grid { gap: 10px 8px; }
  .wide, .date-filter { grid-column: 1 / -1; }
  .history-row { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 10px; gap: 7px 10px; }
  .caller-cell { grid-column: 1 / -1; }
  .recording-row { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .recording-row .actions { width: 100%; }
  .recording-row .actions button { flex: 1; }
  .section-heading { flex-wrap: wrap; }
  .management-card { padding: 10px; }
  .device-facts { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  button, input, select, .tabs a, summary { min-height: 42px; }
  summary { display: flex; align-items: center; }
  summary::before { content: '›'; margin-right: 6px; }
  details[open] > summary::before { content: '⌄'; }
  .checkbox-filter input { min-height: 18px; }
  .management-card .actions button { flex: 1 1 auto; }
  .pagination { gap: 10px; }
  .pagination span { white-space: nowrap; }
  .tabs a { flex: 1; justify-content: center; padding: 8px; font-size: 13px; }
  .footer { flex-direction: column; gap: 4px; }
  .player-panel .section-heading { align-items: flex-start; flex-direction: column; }
  dialog .actions button { flex: 1; }
  .field-row { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .bulk-var { grid-template-columns: minmax(0, 1fr); }
  dialog.bulk-dialog { padding: 14px; }
  .bulk-steps li { padding: 2px 8px; }
  .bulk-file-actions .button { flex: 1 1 100%; }
  .choice-list .checkbox-filter { min-height: 42px; }
}
@media (max-width: 900px) {
  .analytics-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .analytics-apply { grid-column: 1 / -1; }
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .analytics-title { font-size: 20px; }
  .tabs { overflow-x: auto; }
  .tabs a { flex: 1 0 auto; white-space: nowrap; }
  .multi-menu { min-width: 100%; }
  details.multi > summary::before, details.multi[open] > summary::before { content: none; margin: 0; }
  details.multi > summary { display: flex; }
  .kpi { padding: 10px; }
  .kpi-grid { gap: 8px; }
  .chart-grid { gap: 12px; }
  button.sort { min-height: 42px; }
}
@media (max-width: 359px) {
  .kpi-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: no-preference) {
  .skeleton { animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .anim .grow-x { transform-box: fill-box; transform-origin: left center; animation: grow-x .5s ease-out both; }
  .anim .grow-y { transform-box: fill-box; transform-origin: center bottom; animation: grow-y .5s ease-out both; }
  @keyframes grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes grow-y { from { transform: scaleY(0); } to { transform: scaleY(1); } }
}
@media (hover: none), (pointer: coarse), (max-width: 720px) {
  .wa-media-frame:not(.wa-media-audio-frame) .wa-media-dl { opacity: 1; }
  .wa .wa-media-dl { width: 36px; height: 36px; min-height: 36px; }
}
@media (max-width: 720px) {
  .wa-app { grid-template-columns: minmax(0, 1fr); height: max(420px, calc(100vh - 210px)); height: max(420px, calc(100dvh - 210px)); }
  .wa-app[data-view=list] .wa-main, .wa-app[data-view=thread] .wa-side { display: none; }
  .wa .wa-back { display: inline-flex; }
  .wa-scroll { padding: 10px 10px 6px; }
  .wa-msg { max-width: 88%; }
  .wa-dlg-body { grid-template-columns: minmax(0, 1fr); }
  .wa-dlg-body[data-view=list] .wa-tpl-detail, .wa-dlg-body[data-view=form] .wa-tpl-col:first-child { display: none; }
  .wa-tpl-col + .wa-tpl-col { border-left: 0; }
  .wa .wa-tpl-back { display: inline-flex; }
  .wa-dlg-head { padding-left: 14px; }
}
@media (max-width: 720px) {
  .brand-row { flex-wrap: wrap; gap: 0 16px; min-height: 0; }
  .brand { min-height: 48px; }
  .private-label { display: none; }
  .tabs { order: 3; flex: 1 0 100%; overflow-x: auto; scrollbar-width: none; margin: 0 -4px; }
  .tabs a { flex: 0 0 auto; min-height: 44px; }
  h1 { font-size: 22px; }
}
@media print {
  body { background: var(--wa-in); }
  .skip-link, .topbar, .tabs, .directory-notice, #analytics-form, #analytics-presets, #analytics-refresh, .footer, .drawer, .drawer-backdrop { display: none !important; }
  .panel, .kpi { break-inside: avoid; }
  .sw, .seg, .kpi, .delta, .track, .bar-blue, .bar-rate { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .table-wrap { overflow: visible; border: 0; }
  .leaderboard { min-width: 0; font-size: 11px; }
  button.sort { padding: 4px; min-height: 0; }
  .chart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: no-preference) { button, .button { transition: background-color .15s ease; } }
.link-button { display: inline; min-height: 24px; padding: 0; border: 0; border-radius: 2px; background: none; color: var(--accent); font: inherit; text-align: left; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.link-button:hover { background: none; color: var(--c-1b554b); }
.customer-row { cursor: pointer; }
.wa .wa-name-btn { display: block; max-width: 100%; overflow: hidden; color: inherit; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.wa .wa-name-btn:hover { background: none; color: inherit; text-decoration: underline; }
.drawer-backdrop { position: fixed; inset: 0; z-index: 20; background: var(--c-162c3b88); }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 21; display: flex; flex-direction: column; width: min(420px, 100%); max-width: 100%; border-left: 1px solid var(--line); background: var(--wa-in); box-shadow: -8px 0 24px var(--c-142b4526); transform: translateX(100%); visibility: hidden; overscroll-behavior: contain; }
.drawer[data-open=true] { transform: none; visibility: visible; }
.drawer-head { display: flex; align-items: center; flex: 0 0 auto; gap: 8px; min-height: 56px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--line); background: var(--head); }
.drawer-head:has(#drawer-back:not([hidden])) { padding-left: 8px; }
.drawer-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.drawer-title:focus-visible { outline-offset: -2px; }
.drawer-icon { flex: 0 0 auto; width: 40px; height: 40px; min-height: 40px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--muted); }
.drawer-icon:hover { background: var(--hover); color: var(--accent); }
.drawer-pane { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 16px; }
.drawer-pane :focus-visible, .drawer-head :focus-visible { outline-offset: -2px; }
.drawer-name { font-size: 18px; line-height: 1.3; overflow-wrap: anywhere; }
.drawer-phone { margin: 2px 0 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.drawer-actions { margin-bottom: 12px; }
.drawer-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin: 0 0 16px; }
.drawer-facts > div { min-width: 0; }
.drawer-facts dt { font-size: 12px; }
.drawer-facts dd { font-size: 13px; }
.drawer-label { margin: 0 0 4px; color: var(--muted); font-size: 12px; font-weight: 500; }
.drawer-notes { margin-bottom: 16px; }
.drawer-notes-text { display: -webkit-box; margin: 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 4; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.drawer-notes-text[data-expanded=true] { display: block; overflow: visible; }
.drawer-notes .link-button { margin-top: 4px; font-size: 13px; }
.drawer-calls { margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 6px; }
.drawer-calls:empty { display: none; }
.drawer-call { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.drawer-call:last-child { border-bottom: 0; }
.drawer-call-duration { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
.drawer-chat { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.drawer-chat-sub { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; gap: 8px 12px; padding: 8px 16px; border-bottom: 1px solid var(--wa-line); background: var(--wa-panel); font-size: 13px; }
.drawer-chat-sub .muted { min-width: 0; overflow-wrap: anywhere; }
.drawer .wa-embedded.drawer-conv { flex: 1; height: auto; min-height: 0; margin: 0; border: 0; border-radius: 0; }
.drawer .wa-msg { max-width: 88%; }
@media (max-width: 720px) {
  .drawer { width: 100%; border-left: 0; }
  .drawer-facts { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: no-preference) {
  .drawer { transition: transform .2s ease-out, visibility 0s linear .2s; }
  .drawer[data-open=true] { transition: transform .2s ease-out, visibility 0s; }
}
/* Config tab */
.cfg-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; margin-bottom: 24px; }
.cfg-nav { position: sticky; top: 68px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--wa-in); }
.cfg-nav-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.cfg-nav-item { width: 100%; justify-content: flex-start; border: 0; background: transparent; color: var(--c-29424d); font-weight: 500; text-align: left; }
.cfg-nav-item:hover { background: var(--hover); }
.cfg-nav-item[aria-current=page] { background: var(--c-edf7ee); color: var(--accent); font-weight: 650; }
.cfg-content, .cfg-section { display: grid; gap: 16px; min-width: 0; }
.cfg-section-title { font-size: 18px; letter-spacing: -.2px; }
.cfg-block { min-width: 0; }
.cfg-block .section-heading { margin-bottom: 4px; }
.cfg-block > p { margin: 4px 0; }
.cfg-status { color: var(--muted); font-size: 12px; }
.cfg-list:empty { display: none; }
.cfg-block > button.secondary { margin: 4px 0; }
.cfg-rule { display: grid; gap: 8px; }
.cfg-rule-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; }
.cfg-rule-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.cfg-rule-pos { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.cfg-rule-name { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.cfg-rule[data-enabled=false] .cfg-rule-name, .cfg-rule[data-enabled=false] .cfg-facts dd { color: var(--muted); }
.cfg-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 16px; margin: 0; }
.cfg-facts > div { min-width: 0; }
.cfg-facts dt { font-size: 12px; }
.cfg-facts dd { font-size: 13px; overflow-wrap: anywhere; }
.cfg-switch { flex-direction: row; align-items: center; gap: 8px; width: fit-content; color: var(--c-29424d); font-size: 13px; font-weight: 500; cursor: pointer; }
.cfg-switch input { appearance: none; -webkit-appearance: none; position: relative; flex: 0 0 auto; width: 36px; height: 20px; min-height: 0; margin: 0; padding: 0; border: 1px solid var(--c-687b84); border-radius: 999px; background: var(--c-687b84); cursor: pointer; }
.cfg-switch input::before { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--wa-in); }
.cfg-switch input:checked { border-color: var(--accent); background: var(--accent); }
.cfg-switch input:checked::before { transform: translateX(16px); }
.cfg-switch input:disabled { cursor: not-allowed; opacity: .5; }
.cfg-quick-text { margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.cfg-activity { margin: 10px 0 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--wa-in); }
.cfg-activity:empty { display: none; }
.cfg-activity-row { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(0, 1.4fr) minmax(0, 1.4fr) auto; align-items: center; gap: 4px 12px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; overflow-wrap: anywhere; }
.cfg-activity-row:last-child { border-bottom: 0; }
.cfg-activity-time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
dialog.cfg-dialog { width: min(640px, calc(100% - 28px)); }
.cfg-radios { display: flex; flex-wrap: wrap; gap: 4px 18px; }
.cfg-params { display: grid; gap: 10px; margin-bottom: 10px; }
.cfg-params:empty { display: none; }
.cfg-param { display: grid; gap: 3px; min-width: 0; }
.cfg-param-label { font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
.cfg-param-row { display: grid; grid-template-columns: minmax(0, 12rem) minmax(0, 1fr); gap: 6px; }
.cfg-tpl-body { margin: 0 0 10px; padding: 8px 10px; border-radius: 6px; background: var(--c-f4f6f7); color: var(--c-3b4a54); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
#autoreply-dialog [role=status], #quick-dialog [role=status] { color: var(--muted); font-size: 12px; }
@media (prefers-reduced-motion: no-preference) { .cfg-switch input::before { transition: transform .15s ease; } }
@media (max-width: 720px) {
  .cfg-layout { grid-template-columns: minmax(0, 1fr); }
  .cfg-nav { position: static; }
  .cfg-nav-list { display: flex; flex-wrap: wrap; }
  .cfg-nav-item { width: auto; }
  .cfg-activity-row { grid-template-columns: minmax(0, 1fr) auto; }
  .cfg-activity-time { grid-column: 1 / -1; }
}
@media (max-width: 560px) {
  .cfg-param-row { grid-template-columns: minmax(0, 1fr); }
  .cfg-block .section-heading > button { flex: 1 1 auto; }
}
/* Config: settings pages */
.tabs a[hidden], .cfg-nav-list li[hidden] { display: none; }
.cfg-body { display: grid; gap: 16px; min-width: 0; }
.cfg-body form { display: grid; gap: 16px; min-width: 0; }
.cfg-steps ol { margin: 6px 0 0; padding-left: 22px; display: grid; gap: 6px; font-size: 13px; }
.cfg-steps li { overflow-wrap: anywhere; }
.cfg-steps a, .cfg-import a { color: var(--accent); }
.cfg-import { display: grid; gap: 8px; }
.cfg-import h3, .cfg-import p { margin: 0; }
.cfg-block > .cfg-grid { margin: 8px 0; }
.cfg-block > label, .cfg-block > .cfg-secret, .cfg-block > .cfg-copy, .cfg-block > .cfg-switch { margin: 8px 0; }
.cfg-secret { display: grid; gap: 4px; min-width: 0; }
.cfg-secret > label { font-size: 12px; font-weight: 500; color: var(--muted); }
.cfg-secret-state { font-size: 13px; color: var(--c-29424d); }
.cfg-secret-state:empty, .cfg-copy-state:empty { display: none; }
.cfg-fixed { margin: 0 0 12px; }
.cfg-fixed-label { margin: 0 0 4px; font-weight: 600; }
.cfg-fixed code { padding: 8px 10px; border: 1px dashed var(--border, #c9d3cc); border-radius: 6px; background: var(--surface-muted, #f1f4f1); overflow-wrap: anywhere; user-select: all; }
.cfg-preview { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--border, #c9d3cc); border-radius: 6px; background: var(--surface-muted, #f1f4f1); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.cfg-checklist { list-style: none; margin: 8px 0 12px; padding: 0; }
.cfg-check { margin: 2px 0; font-weight: 600; }
.cfg-check.ok { color: var(--accent); }
.cfg-check.bad { color: var(--c-962b34); }
.cfg-secret .actions button { min-height: 28px; padding: 2px 10px; font-size: 12px; font-weight: 500; }
.cfg-qr { display: block; width: 220px; height: 220px; max-width: 100%; margin: 8px 0; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.cfg-app-actions { margin: 8px 0; }
.cfg-file { width: fit-content; max-width: 100%; }
.cfg-file input[type=file] { min-height: 0; padding: 4px 0; border: 0; background: transparent; }
.cfg-copy { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 4px 8px; }
.cfg-copy > .hint, .cfg-copy-state { grid-column: 1 / -1; }
.cfg-copy-state { font-size: 12px; color: var(--muted); }
.cfg-generated { display: grid; gap: 6px; }
.cfg-generated p { margin: 0; }
.cfg-save { margin-top: 0; }
.cfg-block code { overflow-wrap: anywhere; }
/* Composer quick messages */
.wa-composer-wrap { position: relative; }
.wa-quick { position: absolute; z-index: 3; left: 8px; bottom: calc(100% + 4px); display: flex; flex-direction: column; gap: 6px; width: min(360px, calc(100% - 16px)); max-height: min(340px, 60vh); padding: 8px; border: 1px solid var(--wa-line); border-radius: 12px; background: var(--wa-in); box-shadow: 0 2px 10px var(--c-142b4526); }
.wa-quick:focus-visible { outline-offset: 0; }
.wa .wa-quick-search { width: 100%; height: 36px; min-height: 36px; padding: 0 12px; border: 1px solid transparent; border-radius: 8px; background: var(--wa-panel); color: var(--wa-text); }
.wa .wa-quick-search:focus-visible { border-color: var(--wa-green); outline: 2px solid var(--wa-green); outline-offset: 1px; background: var(--wa-in); }
.wa-quick-note { margin: 0; padding: 6px 8px; color: var(--wa-sub); font-size: 13px; overflow-wrap: anywhere; }
.wa-quick-note:empty { display: none; }
.wa-quick-list { min-height: 0; margin: 0; padding: 0; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
.wa-quick-list:empty { display: none; }
.wa .wa-quick-item { display: flex; flex-direction: column; align-items: stretch; gap: 1px; width: 100%; min-height: 0; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: inherit; font-weight: 400; text-align: left; }
.wa .wa-quick-item:hover { background: var(--c-f5f6f6); }
.wa .wa-quick-item:focus-visible { background: var(--c-f5f6f6); outline-offset: -3px; }
.wa-quick-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.wa-quick-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--wa-sub); font-size: 13px; }
/* Attachments and template header files */
.wa-attach-chip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-top: 1px solid var(--wa-line); background: var(--wa-panel); }
.wa-attach-chip[hidden] { display: none; }
.wa-attach-thumb { display: inline-flex; flex: 0 0 auto; width: 48px; height: 48px; border-radius: 8px; background: var(--wa-in); overflow: hidden; align-items: center; justify-content: center; }
.wa-attach-img { width: 100%; height: 100%; object-fit: cover; }
.wa-attach-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--wa-sub); }
.wa-attach-text { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.wa-attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.wa-attach-meta { color: var(--wa-sub); font-size: 12px; }
.wa-tpl-badge { align-self: flex-start; padding: 1px 8px; border-radius: 10px; background: var(--wa-panel); color: var(--wa-sub); font-size: 11px; font-weight: 650; }
.wa-tpl-header-media { flex: 0 0 100%; min-width: 0; margin-bottom: 4px; }
.wa-tpl-header-img { display: block; width: 100%; max-height: 220px; border-radius: 6px; object-fit: cover; }
.wa-tpl-header-media .wa-attach-icon { height: 80px; border-radius: 6px; background: var(--wa-panel); }
.wa-tpl-header-missing { padding: 24px 12px; border-radius: 6px; background: var(--wa-panel); color: var(--wa-sub); font-size: 13px; text-align: center; }
.wa-tpl-media { display: flex; flex-direction: column; gap: 4px; }
.wa-tpl-media[hidden] { display: none; }
.wa-tpl-media-note { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.wa-tpl-media-warn { color: var(--c-a62d36); }
.wa-tpl-media-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.tplimg-thumb { display: inline-flex; flex: 0 0 auto; width: 64px; height: 64px; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 6px; background: var(--head); overflow: hidden; }
.tplimg-thumb img { width: 100%; height: 100%; object-fit: cover; }
.tplimg-icon, .tplimg-none { color: var(--muted); font-size: 12px; text-align: center; }
.tplimg-icon .wa-icon { width: 28px; height: 28px; }
#tplimg-list .management-top > div:not(.actions) { flex: 1; }
#activity-panel { display: grid; gap: 16px; }
#activity-panel > .panel { border: 0; padding: 0; background: transparent; }
#activity-status { color: var(--muted); font-size: 12px; min-height: 18px; }
.act-retry { margin: 0 0 8px; }
.act-row { display: grid; grid-template-columns: minmax(96px, .5fr) minmax(0, 3fr) auto; gap: 4px 16px; align-items: start; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
.act-row:last-child { border-bottom: 0; }
.act-row:hover { background: var(--hover); }
.act-time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; padding-top: 2px; }
.act-main { min-width: 0; overflow-wrap: anywhere; }
.act-sentence { margin: 0; }
.act-target, .act-link { font-weight: 600; }
.act-meta { display: flex; align-items: center; gap: 8px; }
.act-channel-app { color: var(--accent); background: var(--c-b9e7cf); }
.act-channel-admin { color: var(--c-815615); background: var(--c-fff3d9); }
.act-channel-system { color: var(--c-58636a); background: var(--c-edf0f2); }
.act-toggle { min-height: 24px; padding: 0 8px; font-size: 12px; font-weight: 500; }
.act-toggle::after { content: "▾"; font-size: 10px; }
.act-toggle[aria-expanded=true]::after { content: "▴"; }
.act-details { grid-column: 1 / -1; margin-top: 4px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--head); }
.act-facts { margin: 0; }
.act-list[aria-busy=true]:empty { min-height: 112px; border: 1px solid var(--line); border-radius: 6px; background: linear-gradient(90deg, var(--c-f0f3ee), var(--c-f8faf6), var(--c-f0f3ee)); background-size: 200% 100%; }
@media (prefers-reduced-motion: no-preference) { .act-list[aria-busy=true]:empty { animation: shimmer 1.4s linear infinite; } }
@media (max-width: 1000px) {
  .private-label { display: none; }
  .tabs { min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .tabs a { flex: 0 0 auto; white-space: nowrap; }
}
@media (max-width: 720px) {
  .act-row { grid-template-columns: minmax(0, 1fr) auto; }
  .act-time { grid-column: 1; grid-row: 1; align-self: center; }
  .act-meta { grid-column: 2; grid-row: 1; }
  .act-main { grid-column: 1 / -1; }
}
@media (max-width: 560px) {
  .act-row { padding: 10px; }
  .act-toggle { min-height: 36px; }
}
`;
