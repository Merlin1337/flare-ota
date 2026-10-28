import qrcode from "qrcode-generator";

/** Renders a QR code with half-block characters (two modules per line), scannable from a terminal. */
export function terminalQr(text: string): string {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const margin = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  const lines: string[] = [];
  for (let r = -margin; r < size + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < size + margin; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      // Light modules are drawn, dark ones left blank, so it scans on dark terminals.
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
