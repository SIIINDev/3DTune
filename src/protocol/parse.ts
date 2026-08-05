export type HeaterReading = { current: number; target: number; power?: number };

export type ParsedLine =
  | { kind: 'ok'; lineNo?: number; plannerFree?: number; bufferFree?: number; temps?: TempReport }
  | { kind: 'resend'; lineNo: number }
  | { kind: 'busy'; reason: string }
  | { kind: 'error'; text: string; fatal: boolean; expectsResend: boolean }
  | { kind: 'temp'; temps: TempReport }
  | { kind: 'position'; x: number; y: number; z: number; e: number }
  /* Single-point probe result from G30. Marlin prints nothing at all when the probe fails, so the
     absence of this line is itself the error signal — never treat a missing value as zero. */
  | { kind: 'probePoint'; x: number; y: number; z: number }
  | { kind: 'endstops'; states: Record<string, string> }
  | { kind: 'cap'; name: string; enabled: boolean }
  | { kind: 'firmware'; fields: Record<string, string> }
  | { kind: 'start' }
  | { kind: 'action'; action: string }
  | { kind: 'echo'; text: string }
  | { kind: 'other'; text: string };

export type TempReport = {
  hotend?: HeaterReading;
  hotends: HeaterReading[];
  bed?: HeaterReading;
  chamber?: HeaterReading;
};

const RE_OK = /^ok\b/i;
const RE_OK_FIELDS = /\bN(-?\d+)|\bP(\d+)|\bB(\d+)/g;
const RE_RESEND = /^(?:Resend|rs)\s*:?\s*(\d+)/i;
const RE_BUSY = /^(?:echo\s*:\s*)?busy\s*:\s*(.*)$/i;
const RE_ERROR = /^(?:Error|!!)\s*:?\s*(.*)$/i;
const RE_TEMP_TOKEN = /(T\d?|B|C|P|R|A):\s*(-?[\d.]+)\s*(?:\/\s*(-?[\d.]+))?/g;
const RE_POWER = /(?:@(\d?)|B@|C@)\s*:\s*(-?\d+)/g;
const RE_POSITION = /^X:\s*(-?[\d.]+)\s+Y:\s*(-?[\d.]+)\s+Z:\s*(-?[\d.]+)\s+E:\s*(-?[\d.]+)/;
// Marlin: SString(F("Bed X:"), x, F(" Y:"), y, F(" Z:"), z) — no space after the colons.
const RE_PROBE_POINT = /^Bed\s+X:\s*(-?[\d.]+)\s+Y:\s*(-?[\d.]+)\s+Z:\s*(-?[\d.]+)/i;
const RE_ENDSTOP = /([a-z0-9_ ]+):\s*(TRIGGERED|open)/gi;
const RE_CAP = /^Cap\s*:\s*([A-Z0-9_]+)\s*:\s*([01])/i;
const RE_ACTION = /^\/\/\s*action\s*:\s*(.+)$/i;

const FATAL_ERROR = /(printer halted|kill\(\) called|thermal runaway|heating failed|MINTEMP|MAXTEMP|too many errors)/i;
const RESEND_ERROR = /(line number is not last line number|checksum mismatch|no checksum with line number|no line number with checksum|format error)/i;

export function parseLine(raw: string): ParsedLine {
  const text = raw.trim();
  if (text === '') return { kind: 'other', text };

  if (text === 'start' || /^start\b/i.test(text)) return { kind: 'start' };

  const resend = RE_RESEND.exec(text);
  if (resend) return { kind: 'resend', lineNo: Number(resend[1]) };

  const busy = RE_BUSY.exec(text);
  if (busy) return { kind: 'busy', reason: (busy[1] ?? '').trim() };

  const action = RE_ACTION.exec(text);
  if (action) return { kind: 'action', action: (action[1] ?? '').trim() };

  const err = RE_ERROR.exec(text);
  if (err) {
    const body = (err[1] ?? '').trim();
    return {
      kind: 'error',
      text: body,
      fatal: FATAL_ERROR.test(body),
      expectsResend: RESEND_ERROR.test(body),
    };
  }

  const cap = RE_CAP.exec(text);
  if (cap) return { kind: 'cap', name: (cap[1] ?? '').toUpperCase(), enabled: cap[2] === '1' };

  if (/^FIRMWARE_NAME\s*:/i.test(text)) return { kind: 'firmware', fields: parseFirmware(text) };

  if (RE_OK.test(text)) {
    const rest = text.slice(2);
    const fields = readOkFields(rest);
    const temps = parseTemps(rest);
    return { kind: 'ok', ...fields, ...(temps ? { temps } : {}) };
  }

  const probePoint = RE_PROBE_POINT.exec(text);
  if (probePoint) {
    return {
      kind: 'probePoint',
      x: Number(probePoint[1]),
      y: Number(probePoint[2]),
      z: Number(probePoint[3]),
    };
  }

  const pos = RE_POSITION.exec(text);
  if (pos) {
    return {
      kind: 'position',
      x: Number(pos[1]),
      y: Number(pos[2]),
      z: Number(pos[3]),
      e: Number(pos[4]),
    };
  }

  if (/^[a-z0-9_ ]+:\s*(TRIGGERED|open)\s*$/i.test(text) || /_(min|max)\s*:\s*(TRIGGERED|open)/i.test(text)) {
    return { kind: 'endstops', states: parseEndstops(text) };
  }

  const temps = parseTemps(text);
  if (temps) return { kind: 'temp', temps };

  if (/^echo\s*:/i.test(text)) {
    return { kind: 'echo', text: text.replace(/^echo\s*:\s?/i, '') };
  }

  return { kind: 'other', text };
}

function readOkFields(rest: string): { lineNo?: number; plannerFree?: number; bufferFree?: number } {
  const out: { lineNo?: number; plannerFree?: number; bufferFree?: number } = {};
  RE_OK_FIELDS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_OK_FIELDS.exec(rest)) !== null) {
    if (m[1] !== undefined) out.lineNo = Number(m[1]);
    else if (m[2] !== undefined) out.plannerFree = Number(m[2]);
    else if (m[3] !== undefined) out.bufferFree = Number(m[3]);
  }
  return out;
}

function parseFirmware(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /([A-Z_0-9]+)\s*:\s*(.*?)(?=\s+[A-Z_0-9]+\s*:|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) fields[m[1]] = (m[2] ?? '').trim();
  }
  return fields;
}

function parseEndstops(text: string): Record<string, string> {
  const states: Record<string, string> = {};
  RE_ENDSTOP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENDSTOP.exec(text)) !== null) {
    const name = (m[1] ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (name) states[name] = (m[2] ?? '').toLowerCase();
  }
  return states;
}

export function parseTemps(text: string): TempReport | null {
  if (!/(^|\s)(T\d?|B):\s*-?[\d.]/.test(text)) return null;

  const hotends: HeaterReading[] = [];
  let bed: HeaterReading | undefined;
  let chamber: HeaterReading | undefined;

  RE_TEMP_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TEMP_TOKEN.exec(text)) !== null) {
    const tag = m[1] ?? '';
    const current = Number(m[2]);
    const target = m[3] !== undefined ? Number(m[3]) : 0;
    if (!Number.isFinite(current)) continue;
    const reading: HeaterReading = { current, target };

    if (tag === 'B') bed = reading;
    else if (tag === 'C') chamber = reading;
    else if (tag === 'T') hotends[0] = reading;
    else if (/^T\d$/.test(tag)) hotends[Number(tag.slice(1))] = reading;
  }

  if (hotends.length === 0 && !bed && !chamber) return null;

  RE_POWER.lastIndex = 0;
  while ((m = RE_POWER.exec(text)) !== null) {
    const value = Number(m[2]);
    if (m[0].startsWith('B@')) {
      if (bed) bed.power = value;
    } else if (m[0].startsWith('C@')) {
      if (chamber) chamber.power = value;
    } else {
      const idx = m[1] ? Number(m[1]) : 0;
      const h = hotends[idx];
      if (h) h.power = value;
    }
  }

  const report: TempReport = { hotends: hotends.filter(Boolean) };
  if (hotends[0]) report.hotend = hotends[0];
  if (bed) report.bed = bed;
  if (chamber) report.chamber = chamber;
  return report;
}
