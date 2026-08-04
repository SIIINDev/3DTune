import { EventEmitter } from 'node:events';
import { Link, type CommandResult } from '../protocol/link.ts';
import type { TempReport } from '../protocol/parse.ts';
import { MockTransport } from '../transport/mock.ts';
import { SerialTransport } from '../transport/serial.ts';
import type { Transport } from '../transport/types.ts';
import {
  SafetyError,
  resolveLimits,
  checkBedTarget,
  checkExtrude,
  checkHotendTarget,
  checkJog,
  type MachineLimits,
} from './limits.ts';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type HeaterState = { current: number; target: number; power: number };

export type PrinterStateSnapshot = {
  connection: {
    status: ConnectionStatus;
    label: string | null;
    firmware: string | null;
    machine: string | null;
    caps: Record<string, boolean>;
    capsReported: boolean;
    error: string | null;
  };
  temps: { hotend: HeaterState; bed: HeaterState };
  position: { x: number; y: number; z: number; e: number };
  homed: { x: boolean; y: boolean; z: boolean };
  endstops: Record<string, string>;
  settings: Record<string, Record<string, number>>;
  leveling: { on: boolean; mesh: number[][] | null };
  busy: string | null;
  halted: boolean;
  fan: number;
  queueDepth: number;
  eepromSaves: number;
  warnings: string[];
  limits: MachineLimits;
};

export type TempSample = { t: number; h: number; ht: number; b: number; bt: number };

export type ConnectTarget =
  | { kind: 'serial'; path: string; baud: number }
  | { kind: 'mock'; chaos?: boolean; noBedPid?: boolean };

const TEMP_HISTORY = 1800;
const LOG_HISTORY = 600;
const STATE_THROTTLE_MS = 120;
const HANDSHAKE_ATTEMPTS = 3;
const SETTING_CODES = new Set(['M92', 'M201', 'M203', 'M204', 'M205', 'M206', 'M301', 'M304', 'M420', 'M851', 'M900']);

export class Printer extends EventEmitter {
  readonly limits: MachineLimits;
  private transport: Transport | null = null;
  private link: Link | null = null;
  private status: ConnectionStatus = 'disconnected';
  private label: string | null = null;
  private firmware: string | null = null;
  private machine: string | null = null;
  private caps: Record<string, boolean> = {};
  private capsReported = false;
  private connError: string | null = null;

  private hotend: HeaterState = { current: 0, target: 0, power: 0 };
  private bed: HeaterState = { current: 0, target: 0, power: 0 };
  private position = { x: 0, y: 0, z: 0, e: 0 };
  private homed = { x: false, y: false, z: false };
  private endstops: Record<string, string> = {};
  private settings: Record<string, Record<string, number>> = {};
  private levelingOn = false;
  private mesh: number[][] | null = null;
  private meshCapture: number[][] | null = null;
  private fan = 0;
  private eepromSaves = 0;
  private lastSaveAt = 0;

  tempHistory: TempSample[] = [];
  log: { t: number; dir: 'rx' | 'tx' | 'sys'; text: string }[] = [];

  constructor(limitOverrides?: Partial<MachineLimits>) {
    super();
    this.limits = resolveLimits(limitOverrides);
  }

  snapshot(): PrinterStateSnapshot {
    return {
      connection: {
        status: this.status,
        label: this.label,
        firmware: this.firmware,
        machine: this.machine,
        caps: this.caps,
        capsReported: this.capsReported,
        error: this.connError,
      },
      temps: { hotend: { ...this.hotend }, bed: { ...this.bed } },
      position: { ...this.position },
      homed: { ...this.homed },
      endstops: { ...this.endstops },
      settings: structuredClone(this.settings),
      leveling: { on: this.levelingOn, mesh: this.mesh },
      busy: this.link?.busy ?? null,
      halted: this.link?.isHalted ?? false,
      fan: this.fan,
      queueDepth: this.link?.queueDepth ?? 0,
      eepromSaves: this.eepromSaves,
      warnings: this.warnings(),
      limits: this.limits,
    };
  }

  private warnings(): string[] {
    const out: string[] = [];
    if (this.status !== 'connected') return out;
    if (!this.capsReported) {
      out.push(
        'firmware did not report Cap: lines (EXTENDED_CAPABILITIES_REPORT off) — feature detection unavailable',
      );
    }
    if (this.caps['EEPROM'] === false) {
      out.push('EEPROM is disabled in firmware — M500 will not persist anything');
    }
    if (this.caps['EMERGENCY_PARSER'] === false) {
      out.push('EMERGENCY_PARSER is off — M112 queues behind buffered moves, STOP may be delayed');
    }
    if (this.settings['M304'] === undefined) {
      out.push('no M304 in M503 — bed runs bang-bang, bed PID needs a firmware rebuild');
    }
    if (this.caps['Z_PROBE'] === false) {
      out.push('no Z probe in firmware — 3D Touch features require a rebuild');
    }
    return out;
  }

  async connect(target: ConnectTarget): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      throw new Error('already connected — disconnect first');
    }
    this.resetVolatile();
    this.status = 'connecting';
    this.connError = null;
    this.emitState();

    const transport: Transport =
      target.kind === 'mock'
        ? new MockTransport({ chaos: target.chaos ?? false, noBedPid: target.noBedPid ?? false })
        : new SerialTransport(target.path, target.baud);

    this.transport = transport;
    this.label = transport.label;

    try {
      await transport.open();
    } catch (err) {
      this.status = 'error';
      this.connError = err instanceof Error ? err.message : String(err);
      this.transport = null;
      this.emitState();
      throw err;
    }

    const link = new Link(transport);
    this.link = link;
    this.wireLink(link);

    this.sys(`opened ${transport.label}`);
    await delay(target.kind === 'mock' ? 350 : 1200);

    try {
      await link.resync();
      await this.handshake(link);
      this.status = 'connected';
      this.emitState();
    } catch (err) {
      this.connError = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.emitState();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.link?.close();
    await this.transport?.close();
    this.link = null;
    this.transport = null;
    this.status = 'disconnected';
    this.label = null;
    this.sys('disconnected');
    this.emitState();
  }

  private async handshake(link: Link): Promise<void> {
    for (let attempt = 1; attempt <= HANDSHAKE_ATTEMPTS; attempt++) {
      await link.send('M115', { timeoutMs: 8_000 });
      if (this.firmware !== null || this.capsReported) break;
      this.sys(`M115 returned no firmware info (attempt ${attempt}/${HANDSHAKE_ATTEMPTS})`);
    }

    for (let attempt = 1; attempt <= HANDSHAKE_ATTEMPTS; attempt++) {
      await this.refreshSettings();
      if (Object.keys(this.settings).length > 0) break;
      this.sys(`M503 returned no settings (attempt ${attempt}/${HANDSHAKE_ATTEMPTS})`);
    }

    if (this.caps['AUTOREPORT_TEMP'] !== false) {
      await link.send('M155 S1');
    } else {
      this.startTempPolling();
    }
    await link.send('M114');
    await link.send('M119');
  }

  private tempPoll?: NodeJS.Timeout;

  private startTempPolling(): void {
    if (this.tempPoll) clearInterval(this.tempPoll);
    this.tempPoll = setInterval(() => {
      if (this.status === 'connected' && this.link && !this.link.busy) {
        void this.link.send('M105').catch(() => undefined);
      }
    }, 2000);
  }

  private wireLink(link: Link): void {
    link.on('line', (raw: string) => {
      this.pushLog('rx', raw);
      this.captureMesh(raw);
    });
    link.on('sent', (raw: string) => this.pushLog('tx', raw));

    link.on('temp', (report: TempReport) => {
      if (report.hotend) {
        this.hotend = {
          current: report.hotend.current,
          target: report.hotend.target,
          power: (report.hotend.power ?? 0) / 127,
        };
      }
      if (report.bed) {
        this.bed = {
          current: report.bed.current,
          target: report.bed.target,
          power: (report.bed.power ?? 0) / 127,
        };
      }
      const sample: TempSample = {
        t: Date.now(),
        h: this.hotend.current,
        ht: this.hotend.target,
        b: this.bed.current,
        bt: this.bed.target,
      };
      this.tempHistory.push(sample);
      if (this.tempHistory.length > TEMP_HISTORY) this.tempHistory.shift();
      this.emit('temp', sample);
      this.emitState();
    });

    link.on('position', (p: { x: number; y: number; z: number; e: number }) => {
      this.position = { x: p.x, y: p.y, z: p.z, e: p.e };
      this.emitState();
    });

    link.on('endstops', (states: Record<string, string>) => {
      this.endstops = { ...this.endstops, ...states };
      this.emitState();
    });

    link.on('cap', (name: string, enabled: boolean) => {
      this.caps[name] = enabled;
      this.capsReported = true;
      this.emitState();
    });

    link.on('firmware', (fields: Record<string, string>) => {
      this.firmware = fields['FIRMWARE_NAME'] ?? null;
      this.machine = fields['MACHINE_TYPE'] ?? null;
      this.emitState();
    });

    link.on('busy', () => this.emitState());
    link.on('reset', () => {
      this.sys('printer sent boot banner — board reset detected');
      this.homed = { x: false, y: false, z: false };
      this.emit('event', { type: 'reset' });
    });
    link.on('action', (action: string) => this.emit('event', { type: 'action', action }));
    link.on('printerError', (text: string, fatal: boolean) => {
      this.sys(`printer error${fatal ? ' (fatal)' : ''}: ${text}`);
      this.emit('event', { type: 'printerError', text, fatal });
    });
    link.on('halted', (text: string) => {
      this.sys(`HALTED: ${text} — power cycle the printer`);
      this.emitState();
    });
    link.on('resend', (lineNo: number, attempt: number) => {
      this.sys(`resend line ${lineNo} (attempt ${attempt})`);
    });
    link.on('timeout', (gcode: string) => this.sys(`timeout waiting for ok after ${gcode}`));
    link.on('stale', (ms: number) => this.sys(`no data from printer for ${ms} ms`));
    link.on('closed', (err: Error) => {
      if (this.tempPoll) clearInterval(this.tempPoll);
      this.status = this.status === 'disconnected' ? 'disconnected' : 'error';
      this.connError = err.message;
      this.sys(`link closed: ${err.message}`);
      this.emitState();
    });
  }

  private captureMesh(raw: string): void {
    const line = raw.trim();

    const leveling = /Bed Leveling (ON|OFF)/i.exec(line);
    if (leveling) {
      this.levelingOn = (leveling[1] ?? '').toUpperCase() === 'ON';
      this.emitState();
    }

    if (/Leveling Grid|Mesh Bed Level data/i.test(line)) {
      this.meshCapture = [];
      return;
    }
    if (this.meshCapture === null) return;

    const rowMatch = /^(\d+)\s+(.+)$/.exec(line);
    if (rowMatch) {
      const tokens = (rowMatch[2] ?? '').trim().split(/\s+/);
      const isDataRow = tokens.length > 0 && tokens.every((t) => /^[+-]?\d*\.\d+$/.test(t));
      if (isDataRow) this.meshCapture.push(tokens.map(Number));
      return;
    }

    if (this.meshCapture.length > 0) {
      this.mesh = this.meshCapture;
      this.emitState();
    }
    this.meshCapture = null;
  }

  private requireLink(): Link {
    if (!this.link || (this.status !== 'connected' && this.status !== 'connecting')) {
      throw new Error('printer is not connected');
    }
    return this.link;
  }

  gcode(command: string): Promise<CommandResult> {
    return this.requireLink().send(command);
  }

  estop(): void {
    if (!this.link) {
      this.sys('M112 not sent — no link to the printer; cut the power manually');
      throw new Error('нет связи с принтером — M112 не отправлен, выключи питание вручную');
    }
    this.link.sendRaw('M112');
    this.sys('M112 sent');
    if (this.caps['EMERGENCY_PARSER'] === false) {
      this.sys('warning: EMERGENCY_PARSER is off in firmware — stop may be delayed');
    }
  }

  async setHotendTarget(value: number, confirmed = false): Promise<void> {
    checkHotendTarget(value, this.limits, confirmed);
    await this.requireLink().send(`M104 S${value}`);
    this.hotend.target = value;
    this.emitState();
  }

  async setBedTarget(value: number): Promise<void> {
    checkBedTarget(value, this.limits);
    await this.requireLink().send(`M140 S${value}`);
    this.bed.target = value;
    this.emitState();
  }

  async setFan(value: number): Promise<void> {
    const pwm = Math.round(Math.min(255, Math.max(0, value)));
    await this.requireLink().send(pwm === 0 ? 'M107' : `M106 S${pwm}`);
    this.fan = pwm;
    this.emitState();
  }

  async jog(axis: 'X' | 'Y' | 'Z' | 'E', distance: number, feedrate?: number): Promise<void> {
    checkJog(axis, distance, this.homed);
    if (axis === 'E') checkExtrude(this.hotend.current, this.limits);
    const f = feedrate ?? (axis === 'Z' ? 400 : axis === 'E' ? 180 : 3000);
    const link = this.requireLink();
    await link.send('G91');
    await link.send(`G1 ${axis}${distance} F${f}`);
    await link.send('G90');
    await link.send('M114');
  }

  async home(axes: string): Promise<void> {
    const arg = axes.trim().toUpperCase().replace(/[^XYZ]/g, '');
    await this.requireLink().send(arg === '' ? 'G28' : `G28 ${arg.split('').join(' ')}`);
    if (arg === '') this.homed = { x: true, y: true, z: true };
    else for (const a of arg) this.homed[a.toLowerCase() as 'x' | 'y' | 'z'] = true;
    await this.requireLink().send('M114');
    this.emitState();
  }

  async motorsOff(): Promise<void> {
    await this.requireLink().send('M84');
    this.homed = { x: false, y: false, z: false };
    this.emitState();
  }

  async refreshSettings(): Promise<void> {
    const res = await this.requireLink().send('M503', { timeoutMs: 20_000 });
    const parsed: Record<string, Record<string, number>> = {};
    for (const raw of res.lines) {
      const line = raw.replace(/^echo\s*:\s?/i, '').trim();
      const m = /^(M\d+)\s+(.*)$/.exec(line);
      if (!m || !SETTING_CODES.has(m[1] ?? '')) continue;
      const params: Record<string, number> = {};
      const re = /([A-Z])(-?\d*\.?\d+)/g;
      let p: RegExpExecArray | null;
      while ((p = re.exec((m[2] ?? '').toUpperCase())) !== null) {
        if (p[1]) params[p[1]] = Number(p[2]);
      }
      if (Object.keys(params).length > 0) parsed[m[1] as string] = params;
    }
    if (Object.keys(parsed).length > 0) this.settings = parsed;
    const m420 = parsed['M420'];
    if (m420 && m420['S'] !== undefined) this.levelingOn = m420['S'] === 1;
    this.emitState();
  }

  async applySettings(commands: string[]): Promise<CommandResult[]> {
    const link = this.requireLink();
    const results: CommandResult[] = [];
    for (const cmd of commands) {
      results.push(await link.send(cmd));
    }
    await this.refreshSettings();
    return results;
  }

  async saveToEeprom(): Promise<CommandResult> {
    const now = Date.now();
    if (now - this.lastSaveAt < this.limits.eepromSaveMinIntervalMs) {
      throw new SafetyError(
        'save_rate_limited',
        `flash-emulated EEPROM has a limited erase budget — wait ${Math.ceil(
          (this.limits.eepromSaveMinIntervalMs - (now - this.lastSaveAt)) / 1000,
        )}s before saving again`,
      );
    }
    this.lastSaveAt = now;
    const res = await this.requireLink().send('M500', { timeoutMs: 15_000 });
    if (res.ok) {
      this.eepromSaves++;
      this.emitState();
    }
    return res;
  }

  async babystepZ(delta: number): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 0.2) {
      throw new SafetyError('bad_value', 'babystep is limited to a non-zero step of at most 0.2 mm');
    }
    await this.requireLink().send(`M290 Z${delta}`);
  }

  async setProbeOffset(offset: { x?: number; y?: number; z?: number }): Promise<CommandResult> {
    const parts: string[] = [];
    for (const [axis, value] of [
      ['X', offset.x],
      ['Y', offset.y],
      ['Z', offset.z],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || Math.abs(value) > 100) {
        throw new SafetyError('bad_value', `probe offset ${axis} is out of range`);
      }
      parts.push(`${axis}${value}`);
    }
    if (parts.length === 0) throw new SafetyError('bad_value', 'no probe offset values given');
    const res = await this.requireLink().send(`M851 ${parts.join(' ')}`);
    await this.refreshSettings();
    return res;
  }

  async readEndstops(): Promise<void> {
    await this.requireLink().send('M119');
  }

  async pidAutotune(opts: { target: 'hotend' | 'bed'; temp: number; cycles: number; apply: boolean }): Promise<CommandResult> {
    if (opts.target === 'hotend') checkHotendTarget(opts.temp, this.limits, true);
    else checkBedTarget(opts.temp, this.limits);
    if (opts.target === 'bed' && this.settings['M304'] === undefined) {
      throw new SafetyError('bed_bangbang', 'bed PID is unavailable: firmware has PIDTEMPBED disabled');
    }
    const e = opts.target === 'bed' ? '-1' : '0';
    const cycles = Math.min(15, Math.max(3, Math.round(opts.cycles)));
    const cmd = `M303 E${e} S${opts.temp} C${cycles}${opts.apply ? ' U1' : ''}`;
    this.sys(`starting PID autotune: ${cmd}`);
    return this.requireLink().send(cmd, { timeoutMs: 30 * 60_000 });
  }

  private resetVolatile(): void {
    this.caps = {};
    this.capsReported = false;
    this.firmware = null;
    this.machine = null;
    this.settings = {};
    this.endstops = {};
    this.mesh = null;
    this.meshCapture = null;
    this.homed = { x: false, y: false, z: false };
    this.tempHistory = [];
  }

  private pushLog(dir: 'rx' | 'tx' | 'sys', text: string): void {
    const entry = { t: Date.now(), dir, text };
    this.log.push(entry);
    if (this.log.length > LOG_HISTORY) this.log.shift();
    this.emit('log', entry);
  }

  private sys(text: string): void {
    this.pushLog('sys', text);
  }

  private stateTimer?: NodeJS.Timeout;
  private lastStateAt = 0;

  flushState(): void {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
    }
    this.lastStateAt = Date.now();
    this.emit('state', this.snapshot());
  }

  private emitState(): void {
    if (this.stateTimer) return;
    const since = Date.now() - this.lastStateAt;
    if (since >= STATE_THROTTLE_MS) {
      this.lastStateAt = Date.now();
      this.emit('state', this.snapshot());
      return;
    }
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.lastStateAt = Date.now();
      this.emit('state', this.snapshot());
    }, STATE_THROTTLE_MS - since);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
