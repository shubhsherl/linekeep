import { linekeepMark } from "../../admin-ui/brand";
import { formatSize, type AppRelease } from "./release";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** No script, fonts or images from elsewhere: it must open from a link on any phone. */
export const downloadPageSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const styles = `*{box-sizing:border-box}body{margin:0;padding:20px;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#17352f;background:#F7F8F4}main{max-width:520px;margin:6vh auto;padding:24px;background:#fff;border:1px solid #d9e0d6;border-radius:12px}h1{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:24px}.brand-mark{width:32px;height:32px;flex:none}h2{margin:24px 0 8px;font-size:17px}p{margin:8px 0}.muted{color:#5b6f69;font-size:14px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:16px 0;font-size:14px}dt{color:#5b6f69}dd{margin:0;min-width:0}code{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}.button{display:block;margin:20px 0 4px;padding:14px 18px;border-radius:8px;background:#103F3A;color:#fff;text-align:center;font-weight:600;text-decoration:none}.button:focus-visible{outline:3px solid #b56c11;outline-offset:3px}ol{margin:0;padding-left:22px}li{margin:6px 0}.note{margin-top:20px;padding:12px 14px;border-radius:8px;background:#eef4ee;font-size:14px}`;

export function downloadPage(release: AppRelease): string {
  const version = escapeHtml(release.versionName);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Download Linekeep for Android</title><style>${styles}</style></head><body><main>
<h1>${linekeepMark}Linekeep</h1>
<p class="muted">Android app for your team's call tracking.</p>
<dl><dt>Version</dt><dd>${version}</dd><dt>Size</dt><dd>${escapeHtml(formatSize(release.size))}</dd><dt>SHA-256</dt><dd><code>${escapeHtml(release.sha256)}</code></dd></dl>
<a class="button" href="/download/linekeep.apk" download="linekeep-${version}.apk">Download Linekeep ${version}</a>
<h2>Install it in four steps</h2>
<ol>
<li>Tap <strong>Download</strong>. If Android warns that this type of file can harm your device, choose <strong>Download anyway</strong>.</li>
<li>When asked, allow your browser to <strong>Install unknown apps</strong> (Settings &gt; Apps &gt; Special access &gt; Install unknown apps), then go back.</li>
<li>Open the downloaded file and tap <strong>Install</strong>.</li>
<li>Open Linekeep and follow the steps on the screen.</li>
</ol>
<p class="note">Your employer's administrator gives you the enrollment QR code or setup code separately. The app does nothing until you enroll with it.</p>
</main></body></html>`;
}
