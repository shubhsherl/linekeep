export const adminStyles = `
:root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17352f; background: #F7F8F4; font-synthesis: none; --accent: #103F3A; --line: #dce5dd; --muted: #52675e; }
* { box-sizing: border-box; }
body { margin: 0; font-size: 14px; line-height: 1.45; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
button, input, select { font: inherit; }
button, .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 6px 11px; border: 1px solid transparent; border-radius: 6px; background: var(--accent); color: white; font-weight: 650; text-decoration: none; cursor: pointer; gap: 6px; }
button:hover, .button:hover { background: #1b554b; }
button.secondary { border-color: #c9d7db; background: white; color: #29424d; }
button.secondary:hover { background: #edf3f4; }
button.danger { background: #a62d36; }
button.danger:hover { background: #85212a; }
button.delete-button { color: #962b34; }
button:disabled { cursor: not-allowed; opacity: .5; }
:focus-visible { outline: 3px solid #b56c11; outline-offset: 3px; }
.skip-link { position: absolute; top: -90px; left: 16px; padding: 12px; background: white; z-index: 10; }
.skip-link:focus { top: 8px; }
.shell { width: min(1320px, calc(100% - 48px)); margin: 0 auto; }
.topbar { background: #fff; border-bottom: 1px solid var(--line); }
.brand-row { display: flex; justify-content: space-between; align-items: center; min-height: 56px; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; color: #103F3A; font-size: 21px; font-weight: 750; text-decoration: none; letter-spacing: -.5px; }
.brand-mark { flex-shrink: 0; }
.brand-caption { border-left: 1px solid var(--line); padding-left: 12px; color: var(--muted); font-size: 10px; letter-spacing: 1.5px; }
.private-label { font-size: 11px; color: var(--muted); }
.page-heading { margin: 22px 0 16px; }
.eyebrow { margin: 0 0 4px; font-size: 10px; font-weight: 750; letter-spacing: 1.5px; color: var(--accent); }
h1 { margin: 0; font-size: 30px; line-height: 1.2; letter-spacing: -1px; }
h2 { margin: 0; font-size: 18px; line-height: 1.35; }
h3 { margin: 0; font-size: 14px; }
p { margin: 6px 0; }
.lede { margin: 6px 0 0; color: var(--muted); }
.panel { border: 1px solid var(--line); background: #fff; padding: 16px; border-radius: 8px; }
.section-heading, .results-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.muted, .hint { color: var(--muted); }
.hint { font-size: 12px; }
.filter-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
label { display: flex; min-width: 0; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 650; }
input, select { min-width: 0; width: 100%; min-height: 36px; border: 1px solid #beced3; border-radius: 6px; padding: 6px 8px; background: white; color: #1d3039; font-size: 14px; }
input::placeholder { color: #687b84; }
input:focus, select:focus { border-color: var(--accent); }
.checkbox-filter { flex-direction: row; align-items: center; gap: 8px; min-height: 36px; align-self: end; width: fit-content; }
.checkbox-filter input { width: 18px; height: 18px; min-height: 0; margin: 0; accent-color: var(--accent); }
.form-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
.form-footer .hint { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.form-footer .actions { flex-shrink: 0; }
.notice { padding: 10px 14px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.error { border-color: #eccbd0; background: #fff5f5; color: #942832; }
.error-text { color: #942832; font-size: 13px; overflow-wrap: anywhere; }
.results-heading { margin: 18px 0 0; }
#call-history-status { color: var(--muted); font-size: 12px; min-height: 18px; }
#action-status:empty, [role=status]:empty { display: none; }
#action-status { color: var(--accent); }
.call-list, .management-list { border: 1px solid var(--line); border-radius: 7px; overflow: hidden; background: white; }
.call-list:empty, .management-list:empty { border: 0; }
.history-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, .85fr) minmax(0, 1.1fr) minmax(0, .7fr) minmax(0, 1fr); gap: 8px 16px; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
.history-row:last-child, .management-card:last-child { border-bottom: 0; }
.history-row > div, .management-top > div { min-width: 0; overflow-wrap: anywhere; }
.caller-cell p { margin: 3px 0 0; }
.employee-cell, .time-cell, .type-cell, .line-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.cell-label { font-size: 10px; color: var(--muted); }
.badge { display: inline-block; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-weight: 700; background: #edf1f3; color: #4e626c; }
.badge.complete { color: #103F3A; background: #B9E7CF; }
.badge.pending { color: #815615; background: #fff3d9; }
.badge.failed { color: #962b34; background: #ffecef; }
.badge.deleted { color: #58636a; background: #edf0f2; }
.row-details { color: var(--muted); font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; width: fit-content; padding: 3px 0; }
.row-details p { margin: 4px 0; }
.history-delete { margin-top: 7px; font-size: 12px; }
.row-recordings { grid-column: 1 / -1; }
.recording-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; border-top: 1px solid #edf1f2; padding: 7px 0 2px; }
.recording-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.recording-name { overflow-wrap: anywhere; font-size: 12px; }
.recording-row > .row-details, .recording-row > .player-panel { grid-column: 1 / -1; }
.recording-row button { font-size: 12px; }
.empty-state { padding: 28px 18px; text-align: center; }
.empty-state p { color: var(--muted); max-width: 560px; margin: 6px auto; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 20px; margin: 16px 0 22px; font-size: 12px; color: var(--muted); }
.player-panel { margin-top: 6px; border-color: #a3cecb; background: #f9fdfc; width: 100%; min-width: 0; }
.player-panel h2 { font-size: 15px; overflow-wrap: anywhere; }
audio { width: 100%; margin: 4px 0; }
.tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
.tabs a { display: inline-flex; align-items: center; min-height: 42px; padding: 8px 16px; font-weight: 700; text-decoration: none; border-bottom: 3px solid transparent; }
.tabs a[aria-selected=true] { color: #075452; border-color: var(--accent); }
.directory-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-bottom: 12px; font-size: 12px; color: var(--muted); }
.directory-notice button { font-size: 12px; }
#employees-panel { display: grid; gap: 16px; }
.management-list { margin-top: 10px; }
.management-card { min-width: 0; border-bottom: 1px solid var(--line); padding: 10px 12px; overflow-wrap: anywhere; }
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
.invitation-result { padding: 16px; background: #edf7ee; border: 1px solid #B9E7CF; border-radius: 7px; margin-top: 14px; overflow-wrap: anywhere; }
.invitation-result p { font-size: 13px; }
.invitation-qr:empty { display: none; }
.invitation-qr svg { display: block; width: min(280px, 100%); height: auto; margin: 8px 0; border: 1px solid #B9E7CF; border-radius: 6px; background: #fff; }
#invitation-code { font: 17px ui-monospace, monospace; margin-top: 4px; }
.footer { display: flex; justify-content: space-between; gap: 12px; padding: 20px 0; font-size: 11px; color: var(--muted); }
dialog { width: min(500px, calc(100% - 28px)); max-height: calc(100% - 28px); overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; padding: 22px; color: inherit; box-shadow: 0 24px 80px #142b4540; }
dialog::backdrop { background: #162c3b88; }
dialog .actions { justify-content: flex-end; margin-top: 18px; }
.delete-name { padding: 10px; background: #f4f6f7; border-radius: 6px; overflow-wrap: anywhere; font-size: 13px; }
textarea { font: inherit; display: block; min-width: 0; width: 100%; min-height: 72px; border: 1px solid #beced3; border-radius: 6px; padding: 6px 8px; background: white; color: #1d3039; font-size: 14px; resize: vertical; }
textarea:focus { border-color: var(--accent); }
a.button.secondary { border-color: #c9d7db; background: white; color: #29424d; }
a.button.secondary:hover { background: #edf3f4; }
#customers-panel, #whatsapp-panel { display: grid; gap: 16px; }
#customers-browse { display: grid; gap: 0; }
#customers-status, #whatsapp-status, #chat-thread-status, #customer-messages-status, #customer-calls-status { color: var(--muted); font-size: 12px; }
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
.message-list { display: flex; flex-direction: column; gap: 8px; }
.message { max-width: min(560px, 88%); min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 7px 10px; background: white; overflow-wrap: anywhere; }
.message.in { align-self: flex-start; border-top-left-radius: 2px; }
.message.out { align-self: flex-end; border-top-right-radius: 2px; border-color: #B9E7CF; background: #edf7ee; }
.message-meta, .message-foot, .message-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 0; font-size: 11px; color: var(--muted); }
.message-tags { margin: 4px 0 0; }
.message-body { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-foot { margin-top: 4px; }
.chat-layout { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 16px; align-items: start; }
.chat-list { margin-top: 10px; }
button.chat-item { display: flex; flex-direction: column; align-items: stretch; gap: 2px; width: 100%; min-height: 0; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: white; color: inherit; font-weight: 400; text-align: left; }
button.chat-item:hover { background: #f4f8f5; }
button.chat-item[aria-current=true] { background: #edf7ee; box-shadow: inset 3px 0 0 var(--accent); }
button.chat-item:last-child { border-bottom: 0; }
.chat-top { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
.chat-top strong { min-width: 0; overflow-wrap: anywhere; }
.chat-top .hint { flex-shrink: 0; }
.chat-meta, .chat-count { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.chat-preview { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-thread { min-width: 0; }
.chat-back { display: none; }
.thread-scroll { max-height: 62vh; overflow-y: auto; padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: #f9fbf8; }
.thread-older { display: flex; justify-content: center; }
.thread-older:has(button[hidden]) { display: none; }
.thread-older button { margin-bottom: 8px; }
.thread-footer { margin: 10px 0 0; padding: 8px 10px; border: 1px dashed #c9d7db; border-radius: 6px; }
@media (max-width: 900px) {
  .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .history-row { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 12px; }
  .management-top { flex-wrap: wrap; }
  .management-top .actions { flex-shrink: 1; }
  .form-footer { align-items: flex-start; flex-direction: column; gap: 10px; }
  .chat-layout { grid-template-columns: minmax(0, 1fr); }
  .chat-layout[data-view=list] .chat-thread, .chat-layout[data-view=thread] #chat-list-section { display: none; }
  .chat-back { display: inline-flex; }
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
  .message { max-width: 94%; }
  .thread-scroll { max-height: 70vh; padding: 6px; }
  .choice-list .checkbox-filter { min-height: 42px; }
}
@media (prefers-reduced-motion: no-preference) { button, .button { transition: background-color .15s ease; } }
`;
