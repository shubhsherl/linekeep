import qrcode from "qrcode-generator";

/**
 * Setup payload scanned by the Android app: `linekeep://enroll?server=<https origin>&code=<code>`.
 * The server origin is the one the admin is using, so a scan also tells the phone where to enroll.
 */
export function enrollmentUri(origin: string, invitationCode: string): string {
  return `linekeep://enroll?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(invitationCode)}`;
}

/** Self-contained SVG: presentation attributes only (the admin CSP forbids inline style). */
export function qrSvg(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let path = "";
  for (let row = 0; row < count; row++) {
    let column = 0;
    while (column < count) {
      if (!code.isDark(row, column)) { column++; continue; }
      const start = column;
      while (column < count && code.isDark(row, column)) column++;
      path += `M${start + quiet} ${row + quiet}h${column - start}v1h-${column - start}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Setup QR code"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}

export function enrollmentQr(origin: string, invitationCode: string) {
  const uri = enrollmentUri(origin, invitationCode);
  return { enrollmentUri: uri, qrSvg: qrSvg(uri) };
}
