export function marlinChecksum(payload: string): number {
  let cs = 0;
  for (let i = 0; i < payload.length; i++) cs ^= payload.charCodeAt(i) & 0xff;
  return cs & 0xff;
}

export function frame(gcode: string, lineNo: number | null): string {
  if (lineNo === null) return gcode;
  const payload = `N${lineNo} ${gcode}`;
  return `${payload}*${marlinChecksum(payload)}`;
}

export function stripComment(gcode: string): string {
  const idx = gcode.indexOf(';');
  return (idx === -1 ? gcode : gcode.slice(0, idx)).trim();
}
