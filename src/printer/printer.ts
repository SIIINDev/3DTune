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
  type MachineLimitOverrides,
} from './limits.ts';
import { analyzeMesh, MeshCollector, type MeshAnalysis } from './mesh.ts';
import { presetById, stepById, type CommissioningStep, type FilamentPreset } from './commissioning.ts';

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
  leveling: { on: boolean; mesh: number[][] | null; analysis: MeshAnalysis | null };
  /* Live probing progress. total is null when the firmware reports no count — an indeterminate
     state is honest, an invented percentage is not. */
  probing: { active: boolean; done: number; total: number | null } | null;
  busy: string | null;
  halted: boolean;
  fan: number;
  queueDepth: number;
  eepromSaves: number;
  persistence: { dirty: boolean; verifiedAt: number | null; verified: boolean | null; mismatches: string[] };
  warnings: string[];
  limits: MachineLimits;
};

export type TempSample = { t: number; h: number; ht: number; b: number; bt: number };

export type SaveVerification = CommandResult & {
  verified: boolean;
  mismatches: string[];
  verifiedAt: number | null;
};

export type ConnectTarget =
  | { kind: 'serial'; path: string; baud: number }
  /* Transport is already an interface; injecting one lets the protocol layer be exercised against
     verbatim firmware output instead of only against our own simulator. */
  | { kind: 'injected'; transport: Transport; label?: string }
  | {
      kind: 'mock';
      chaos?: boolean;
      noBedPid?: boolean;
      sdPrintStatus?: 'idle' | 'printing' | 'unknown';
      corruptPrefixCount?: number;
      /** Override reported M115 capabilities, e.g. a firmware built without a probe. */
      caps?: Record<string, boolean>;
    };

export type SdPrintStatus = 'idle' | 'printing' | 'unknown';

export type CoolingDecision = {
  action: 'cooled' | 'left_on' | 'not_needed';
  sdPrintStatus: SdPrintStatus;
  reason: string;
};

const TEMP_HISTORY = 1800;
const LOG_HISTORY = 600;
const STATE_THROTTLE_MS = 120;
const HANDSHAKE_ATTEMPTS = 3;
const SETTING_CODES = new Set(['M92', 'M201', 'M203', 'M204', 'M205', 'M206', 'M301', 'M304', 'M420', 'M851', 'M900']);
const EDITABLE_SETTING_CODES = new Set(['M92', 'M201', 'M203', 'M204', 'M205', 'M206', 'M301', 'M304', 'M851', 'M900']);
/* Which leading letter carries a tool/hotend index on each M503 report line, per Marlin's own
   report_* implementations (M301 En under PID_PARAMS_PER_HOTEND, M92/M201/M203/M205 Tn under
   DISTINCT_E_FACTORS). Everything else has no index form. */
const INDEX_PARAM: Record<string, string> = {
  M301: 'E',
  M92: 'T',
  M201: 'T',
  M203: 'T',
  M205: 'T',
};

const SAFE_TERMINAL_COMMAND = /^(M20|M27|M105|M114|M115|M119|M503)(?:[ \t]+[^\r\n]*)?$/i;

/* Commissioning steps legitimately move axes and heat, so they cannot go through the terminal gate.
   They are still checked against this allowlist rather than trusted outright: the catalogue is code,
   and code gets edited. Notably absent is any E move — extrusion needs the cold-extrude guard, so it
   goes through jog()/extrudeForESteps() instead. */
const COMMISSIONING_COMMAND =
  /^(?:M105|M119|M503|M107|M84|G90|G91|M106(?:[ \t]+S\d{1,3})?|M280[ \t]+P0[ \t]+S\d{1,3}|M10[49][ \t]+S\d{1,3}|M140[ \t]+S\d{1,3}|G28(?:[ \t]+[XYZ])*|G1(?:[ \t]+[XYZF]-?\d+(?:\.\d+)?)+)$/i;

export type CommissioningRun = {
  stepId: string;
  commands: { command: string; ok: boolean; detail: string }[];
};

export type EStepsCalibration = {
  previous: number;
  requested: number;
  measured: number;
  next: number;
};

export function calculateESteps(previous: number, requested: number, measured: number): EStepsCalibration {
  if (!Number.isFinite(previous) || previous <= 0) {
    throw new SafetyError('esteps_unavailable', 'current M92 E value is unavailable');
  }
  if (!Number.isFinite(requested) || requested < 20 || requested > 200) {
    throw new SafetyError('bad_value', 'requested extrusion must be between 20 and 200 mm');
  }
  if (!Number.isFinite(measured) || measured <= 0 || measured > 300) {
    throw new SafetyError('bad_value', 'measured extrusion must be greater than 0 and at most 300 mm');
  }

  const correction = requested / measured;
  if (correction < 0.5 || correction > 2) {
    throw new SafetyError(
      'implausible_measurement',
      'measurement would change E-steps by more than 2× — check the marks and entered distance',
    );
  }

  const next = Number((previous * correction).toFixed(3));
  if (next < 50 || next > 5_000) {
    throw new SafetyError('implausible_esteps', `calculated M92 E${next} is outside the plausible range`);
  }
  return { previous, requested, measured, next };
}

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
  private meshCollector = new MeshCollector();
  private probing: { active: boolean; done: number; total: number | null } | null = null;
  private fan = 0;
  private eepromSaves = 0;
  private lastSaveAt = 0;
  private persistedSettings: Record<string, Record<string, number>> | null = null;
  private persistedMesh: number[][] | null = null;
  private persistedLevelingOn = false;
  private saveVerification: { at: number; verified: boolean; mismatches: string[] } | null = null;
  private lastTarget: ConnectTarget | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private recoveringReset = false;

  tempHistory: TempSample[] = [];
  log: { t: number; dir: 'rx' | 'tx' | 'sys'; text: string }[] = [];

  constructor(limitOverrides?: MachineLimitOverrides) {
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
      probing: this.probing ? { ...this.probing } : null,
      leveling: {
        on: this.levelingOn,
        mesh: this.mesh,
        analysis: analyzeMesh(this.mesh, this.limits.bedSize.x, this.limits.bedSize.y, this.limits.bedScrews),
      },
      busy: this.link?.busy ?? null,
      halted: this.link?.isHalted ?? false,
      fan: this.fan,
      queueDepth: this.link?.queueDepth ?? 0,
      eepromSaves: this.eepromSaves,
      persistence: {
        dirty: this.persistenceDirty(),
        verifiedAt: this.saveVerification?.at ?? null,
        verified: this.saveVerification?.verified ?? null,
        mismatches: [...(this.saveVerification?.mismatches ?? [])],
      },
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
    this.clearReconnect();
    this.manualDisconnect = false;
    this.lastTarget = structuredClone(target);
    this.resetVolatile();
    this.status = 'connecting';
    this.connError = null;
    this.emitState();

    const transport: Transport =
      target.kind === 'injected'
        ? target.transport
        : target.kind === 'mock'
        ? new MockTransport({
            chaos: target.chaos ?? false,
            noBedPid: target.noBedPid ?? false,
            sdPrintStatus: target.sdPrintStatus ?? 'idle',
            corruptPrefixCount: target.corruptPrefixCount ?? 0,
            ...(target.caps ? { caps: target.caps } : {}),
          })
        : new SerialTransport(target.path, target.baud);

    this.transport = transport;
    this.label = (target.kind === 'injected' ? target.label : undefined) ?? transport.label;

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
      this.reconnectAttempt = 0;
      this.emitState();
    } catch (err) {
      this.connError = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.emitState();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.lastTarget = null;
    this.clearReconnect();
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
    if (this.caps['AUTOLEVEL'] !== false) await link.send('M420 V1');
    this.persistedSettings = structuredClone(this.settings);
    this.persistedMesh = structuredClone(this.mesh);
    this.persistedLevelingOn = this.levelingOn;
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
      this.trackProbing(raw);
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
      if (this.status === 'connected') void this.recoverAfterReset(link);
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
      this.scheduleReconnect();
    });
  }

  private captureMesh(raw: string): void {
    const line = raw.trim();

    const leveling = /Bed Leveling (ON|OFF)/i.exec(line);
    if (leveling) {
      this.levelingOn = (leveling[1] ?? '').toUpperCase() === 'ON';
      this.emitState();
    }

    const completed = this.meshCollector.push(raw);
    if (completed) {
      this.mesh = completed;
      this.emitState();
    }
  }

  /* Marlin announces grid progress as "Probing point N/M." — the trailing period is real. Some
     builds and leveling systems announce nothing at all, which is why total stays nullable. */
  private trackProbing(raw: string): void {
    const line = raw.replace(/^echo\s*:\s?/i, '').trim();
    const point = /Probing point\s+(\d+)\s*\/\s*(\d+)/i.exec(line);
    if (point) {
      this.probing = { active: true, done: Number(point[1]), total: Number(point[2]) };
      this.emitState();
      return;
    }
    if (/Probing point/i.test(line)) {
      this.probing = { active: true, done: (this.probing?.done ?? 0) + 1, total: this.probing?.total ?? null };
      this.emitState();
    }
  }

  private beginProbing(): void {
    this.probing = { active: true, done: 0, total: null };
    this.emitState();
  }

  private endProbing(): void {
    if (this.probing) {
      this.probing = { ...this.probing, active: false };
      this.emitState();
    }
  }

  private requireLink(): Link {
    if (!this.link || (this.status !== 'connected' && this.status !== 'connecting')) {
      throw new Error('printer is not connected');
    }
    return this.link;
  }

  gcode(command: string): Promise<CommandResult> {
    const clean = command.trim();
    if (!SAFE_TERMINAL_COMMAND.test(clean)) {
      throw new SafetyError(
        'unsafe_gcode',
        'эта команда запрещена в сыром терминале — используй соответствующий безопасный контрол 3DTune',
      );
    }
    return this.requireLink().send(clean);
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

  async readSdPrintStatus(): Promise<SdPrintStatus> {
    const result = await this.requireLink().send('M27', { timeoutMs: 5_000 });
    if (!result.ok) return 'unknown';
    for (const line of result.lines) {
      if (/\bnot\s+(?:sd\s+)?printing\b/i.test(line)) return 'idle';
      if (/\bsd\s+printing\s+byte\b/i.test(line) || /\bprinting\s+from\s+sd\b/i.test(line)) {
        return 'printing';
      }
    }
    return 'unknown';
  }

  /**
   * Turn heaters off only when Marlin explicitly confirms that no SD print is running.
   * An unavailable or unfamiliar M27 response is deliberately treated as unsafe to interrupt.
   */
  async coolIfIdle(reason: string): Promise<CoolingDecision> {
    if (this.hotend.target <= 0 && this.bed.target <= 0) {
      return { action: 'not_needed', sdPrintStatus: 'unknown', reason };
    }

    let sdPrintStatus: SdPrintStatus = 'unknown';
    try {
      sdPrintStatus = await this.readSdPrintStatus();
    } catch (err) {
      this.sys(`HEATERS LEFT ON (${reason}): cannot read SD print status: ${errorText(err)}`);
      return { action: 'left_on', sdPrintStatus, reason };
    }

    if (sdPrintStatus !== 'idle') {
      this.sys(`HEATERS LEFT ON (${reason}): SD print status is ${sdPrintStatus}`);
      return { action: 'left_on', sdPrintStatus, reason };
    }

    const link = this.requireLink();
    const hotend = this.hotend.target > 0 ? await link.send('M104 S0', { timeoutMs: 5_000 }) : { ok: true };
    if (hotend.ok) this.hotend.target = 0;
    const bed = this.bed.target > 0 ? await link.send('M140 S0', { timeoutMs: 5_000 }) : { ok: true };
    if (bed.ok) this.bed.target = 0;
    this.emitState();

    if (!hotend.ok || !bed.ok) {
      this.sys(`HEATER SHUTDOWN INCOMPLETE (${reason}): check the printer and cut power if necessary`);
      return { action: 'left_on', sdPrintStatus, reason };
    }

    this.sys(`heaters cooled (${reason}); M27 confirmed that no SD print is running`);
    return { action: 'cooled', sdPrintStatus, reason };
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

  async extrudeForESteps(distance: number, feedrate = 120): Promise<void> {
    if (!Number.isFinite(distance) || distance < 20 || distance > 200) {
      throw new SafetyError('bad_value', 'E-steps calibration extrusion must be between 20 and 200 mm');
    }
    if (!Number.isFinite(feedrate) || feedrate < 30 || feedrate > 300) {
      throw new SafetyError('bad_value', 'E-steps calibration feedrate must be between 30 and 300 mm/min');
    }
    await this.jog('E', distance, feedrate);
  }

  async calibrateESteps(requested: number, measured: number): Promise<EStepsCalibration> {
    const previous = this.settings['M92']?.['E'];
    const calibration = calculateESteps(previous ?? Number.NaN, requested, measured);
    await this.requireLink().send(`M92 E${calibration.next}`);
    await this.refreshSettings();
    return calibration;
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
      const code = m?.[1] ?? '';
      if (!m || !SETTING_CODES.has(code)) continue;

      let body = (m[2] ?? '').toUpperCase();

      /* Marlin prefixes some report lines with a tool/hotend INDEX, not a value:
           M301 E0 P22.20 I1.08 D114.00   (PID_PARAMS_PER_HOTEND)
           M92  T0 E93.00                 (DISTINCT_E_FACTORS)
         Treated as a field it becomes a bogus editable input whose edit would send
         "M301 E<value>" and change the wrong thing. Keep the first index only. */
      const indexed = new RegExp(`^${INDEX_PARAM[code] ?? '(?!)'}(\\d+)\\s+`).exec(body);
      if (indexed) {
        if (Number(indexed[1]) !== 0) continue;
        body = body.slice(indexed[0].length);
      }

      const params: Record<string, number> = {};
      const re = /([A-Z])(-?\d*\.?\d+)/g;
      let p: RegExpExecArray | null;
      while ((p = re.exec(body)) !== null) {
        if (p[1]) params[p[1]] = Number(p[2]);
      }
      if (Object.keys(params).length > 0) parsed[code] = params;
    }
    if (Object.keys(parsed).length > 0) this.settings = parsed;
    const m420 = parsed['M420'];
    if (m420 && m420['S'] !== undefined) this.levelingOn = m420['S'] === 1;
    this.emitState();
  }

  async applySettings(commands: string[]): Promise<CommandResult[]> {
    const link = this.requireLink();
    const validated = commands.map((cmd) => {
      const clean = cmd.trim().toUpperCase();
      const match = /^(M\d+)[ \t]+((?:[A-Z]-?(?:\d+(?:\.\d*)?|\.\d+)[ \t]*)+)$/.exec(clean);
      if (!match || !EDITABLE_SETTING_CODES.has(match[1] ?? '')) {
        throw new SafetyError('unsafe_setting', `setting command is not allowed: ${cmd}`);
      }
      return clean;
    });
    const results: CommandResult[] = [];
    for (const cmd of validated) results.push(await link.send(cmd));
    await this.refreshSettings();
    return results;
  }

  async probeAction(action: 'deploy' | 'stow' | 'selftest'): Promise<CommandResult> {
    const angle = action === 'deploy' ? 10 : action === 'stow' ? 90 : 120;
    return this.requireLink().send(`M280 P0 S${angle}`);
  }

  async runBedLeveling(confirmed: boolean): Promise<CommandResult> {
    if (!confirmed) {
      throw new SafetyError('needs_confirm', 'G29 moves all axes and requires explicit confirmation');
    }
    if (!this.homed.x || !this.homed.y || !this.homed.z) await this.home('');
    this.beginProbing();
    try {
      return await this.requireLink().send('G29');
    } finally {
      this.endProbing();
    }
  }

  /* One guided pass: probe the bed, switch compensation on, persist it, and read it back.
     "Setting the offsets per point" IS the mesh — Marlin stores the grid and applies it, so there is
     nothing separate to write. What this cannot do is fix the bed: compensation hides warp in
     software, the screws are the only physical remedy, which is why the screw advice comes back with
     the report. */
  async autoConfigureBed(confirmed: boolean): Promise<{
    steps: { name: string; ok: boolean; detail: string }[];
    saved: SaveVerification | null;
    analysis: MeshAnalysis | null;
    levelingOn: boolean;
  }> {
    if (!confirmed) {
      throw new SafetyError(
        'needs_confirm',
        'полная конфигурация стола гоняет все оси и пишет в EEPROM — нужно явное подтверждение',
      );
    }
    if (this.caps['Z_PROBE'] === false) {
      throw new SafetyError('no_probe', 'прошивка не сообщает о поддержке зонда — G29 недоступен');
    }

    const steps: { name: string; ok: boolean; detail: string }[] = [];
    const record = (name: string, result: CommandResult) => {
      steps.push({ name, ok: result.ok, detail: result.error ?? 'ok' });
      return result.ok;
    };

    this.sys('bed auto-configuration started');
    try {
      await this.home('');
      steps.push({ name: 'G28', ok: true, detail: 'все оси в нуле' });
    } catch (err) {
      steps.push({ name: 'G28', ok: false, detail: err instanceof Error ? err.message : String(err) });
      return { steps, saved: null, analysis: null, levelingOn: this.levelingOn };
    }
    this.beginProbing();
    let probeResult: CommandResult;
    try {
      probeResult = await this.requireLink().send('G29');
    } finally {
      this.endProbing();
    }
    if (!record('G29', probeResult)) {
      return { steps, saved: null, analysis: null, levelingOn: this.levelingOn };
    }
    if (this.mesh === null) {
      steps.push({ name: 'mesh', ok: false, detail: 'G29 прошёл, но сетку прочитать не удалось' });
      return { steps, saved: null, analysis: null, levelingOn: this.levelingOn };
    }
    steps.push({ name: 'mesh', ok: true, detail: `${this.mesh.length}×${this.mesh[0]?.length ?? 0} точек` });

    record('M420 S1', await this.setLeveling(true));

    let saved: SaveVerification | null = null;
    try {
      saved = await this.saveToEeprom();
      steps.push({
        name: 'M500',
        ok: saved.verified,
        detail: saved.verified ? 'записано и перечитано' : saved.mismatches.join('; ') || 'проверка не сошлась',
      });
    } catch (err) {
      steps.push({ name: 'M500', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    const snapshot = this.snapshot();
    this.sys(`bed auto-configuration finished: ${steps.filter((step) => step.ok).length}/${steps.length} шагов ok`);
    return { steps, saved, analysis: snapshot.leveling.analysis, levelingOn: this.levelingOn };
  }

  /* Runs a step from the server-side catalogue. The client sends an id, never G-code: a button that
     accepted arbitrary commands would bypass every clamp in limits.ts. */
  async runCommissioningStep(id: string, confirmed: boolean): Promise<CommissioningRun> {
    const step: CommissioningStep | undefined = stepById(id);
    if (!step) throw new SafetyError('unknown_step', `неизвестный шаг настройки: ${id}`);
    if (!step.gcode || step.gcode.length === 0) {
      throw new SafetyError('no_commands', `шаг «${step.title}» выполняется руками, команд для него нет`);
    }
    if (step.needsConfirm && !confirmed) {
      throw new SafetyError(
        'needs_confirm',
        step.hazard === 'heat'
          ? `шаг «${step.title}» включает нагрев — нужно явное подтверждение`
          : `шаг «${step.title}» двигает оси — нужно явное подтверждение`,
      );
    }
    if (step.requiresProbe && this.caps['Z_PROBE'] === false) {
      throw new SafetyError('no_probe', 'прошивка не сообщает о поддержке зонда — шаг недоступен');
    }

    const link = this.requireLink();
    const run: CommissioningRun = { stepId: id, commands: [] };

    for (const raw of step.gcode) {
      const command = raw.trim();
      if (!COMMISSIONING_COMMAND.test(command)) {
        throw new SafetyError('unsafe_step_command', `команда шага не прошла проверку: ${command}`);
      }
      // Clamp the catalogue's own temperatures too, so an edit here cannot outrun the safety layer.
      const hotend = /^M10[49][ \t]+S(\d{1,3})$/i.exec(command);
      if (hotend) checkHotendTarget(Number(hotend[1]), this.limits, true);
      const bed = /^M140[ \t]+S(\d{1,3})$/i.exec(command);
      if (bed) checkBedTarget(Number(bed[1]), this.limits);

      const result = await link.send(command);
      run.commands.push({ command, ok: result.ok, detail: result.error ?? 'ok' });
      if (!result.ok) break;
    }

    this.sys(`commissioning step ${id}: ${run.commands.filter((c) => c.ok).length}/${run.commands.length} команд ok`);
    if (step.gcode.some((c) => /^M10[49]|^M140/i.test(c.trim()))) await this.refreshSettings().catch(() => undefined);
    this.emitState();
    return run;
  }

  async applyFilamentPreset(id: string, firstLayer: boolean): Promise<FilamentPreset> {
    const preset = presetById(id);
    if (!preset) throw new SafetyError('unknown_preset', `неизвестный пресет пластика: ${id}`);
    const hotend = firstLayer ? preset.firstLayerHotend : preset.hotend;
    const bed = firstLayer ? preset.firstLayerBed : preset.bed;
    // Deliberately routed through the clamped setters rather than raw M104/M140.
    await this.setHotendTarget(hotend, true);
    await this.setBedTarget(bed);
    await this.setFan(Math.round((Math.min(100, Math.max(0, preset.fan)) / 100) * 255));
    this.sys(`filament preset ${preset.name}: сопло ${hotend}C, стол ${bed}C, обдув ${preset.fan}%`);
    return preset;
  }

  async setLeveling(on: boolean): Promise<CommandResult> {
    const result = await this.requireLink().send(`M420 S${on ? 1 : 0}`);
    await this.refreshSettings();
    return result;
  }

  async saveToEeprom(): Promise<SaveVerification> {
    const now = Date.now();
    if (now - this.lastSaveAt < this.limits.eepromSaveMinIntervalMs) {
      throw new SafetyError(
        'save_rate_limited',
        `flash-emulated EEPROM has a limited erase budget — wait ${Math.ceil(
          (this.limits.eepromSaveMinIntervalMs - (now - this.lastSaveAt)) / 1000,
        )}s before saving again`,
      );
    }
    const link = this.requireLink();

    // M503/M420 make the comparison include changes made through raw G-code or another client.
    await this.refreshSettings();
    this.mesh = null;
    this.meshCollector.reset();
    if (this.caps['AUTOLEVEL'] !== false) await link.send('M420 V1', { timeoutMs: 20_000 });
    const expectedSettings = structuredClone(this.settings);
    const expectedMesh = structuredClone(this.mesh);
    const expectedLevelingOn = this.levelingOn;
    const preflightMismatches =
      expectedLevelingOn && expectedMesh === null ? ['active bed mesh could not be read before M500'] : [];

    this.lastSaveAt = Date.now();
    const res = await link.send('M500', { timeoutMs: 15_000 });
    if (!res.ok) {
      return { ...res, verified: false, mismatches: ['M500 failed'], verifiedAt: null };
    }

    this.eepromSaves++;
    const reload = await link.send('M501', { timeoutMs: 15_000 });
    const mismatches: string[] = [...preflightMismatches];
    if (!reload.ok) mismatches.push('M501 failed');

    await this.refreshSettings();
    // Clear the cached mesh first so M420 V1 must repopulate it from the state loaded by M501.
    this.mesh = null;
    this.meshCollector.reset();
    if (this.caps['AUTOLEVEL'] !== false) await link.send('M420 V1', { timeoutMs: 20_000 });

    mismatches.push(...settingMismatches(expectedSettings, this.settings));
    if (expectedLevelingOn !== this.levelingOn) {
      mismatches.push(`M420 S expected ${expectedLevelingOn ? 1 : 0}, got ${this.levelingOn ? 1 : 0}`);
    }
    if (!meshesEqual(expectedMesh, this.mesh)) mismatches.push('bed mesh changed after M501');

    const verifiedAt = Date.now();
    const verified = mismatches.length === 0;
    this.saveVerification = { at: verifiedAt, verified, mismatches };
    if (verified) {
      this.persistedSettings = structuredClone(this.settings);
      this.persistedMesh = structuredClone(this.mesh);
      this.persistedLevelingOn = this.levelingOn;
    }
    this.emitState();
    return { ...res, verified, mismatches, verifiedAt };
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

  async simulateTransportLoss(): Promise<void> {
    if (!(this.transport instanceof MockTransport)) throw new Error('transport loss simulation is mock-only');
    await this.transport.close();
  }

  simulateBoardReset(): void {
    if (!(this.transport instanceof MockTransport)) throw new Error('board reset simulation is mock-only');
    this.transport.simulateBoardReset();
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.lastTarget === null || this.reconnectTimer) return;
    const target = structuredClone(this.lastTarget);
    const delayMs = Math.min(8_000, 400 * 2 ** this.reconnectAttempt++);
    this.sys(`reconnect scheduled in ${delayMs} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.link = null;
      this.transport = null;
      void this.connect(target).catch((err) => {
        this.sys(`reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async recoverAfterReset(link: Link): Promise<void> {
    if (this.recoveringReset || this.link !== link) return;
    this.recoveringReset = true;
    this.status = 'connecting';
    this.emitState();
    try {
      await link.resync();
      await this.handshake(link);
      this.status = 'connected';
      this.connError = null;
      this.sys('state restored after board reset');
    } catch (err) {
      this.status = 'error';
      this.connError = err instanceof Error ? err.message : String(err);
      this.sys(`state restore after reset failed: ${this.connError}`);
    } finally {
      this.recoveringReset = false;
      this.emitState();
    }
  }

  private resetVolatile(): void {
    this.caps = {};
    this.capsReported = false;
    this.firmware = null;
    this.machine = null;
    this.settings = {};
    this.endstops = {};
    this.mesh = null;
    this.meshCollector.reset();
    this.homed = { x: false, y: false, z: false };
    this.tempHistory = [];
    this.persistedSettings = null;
    this.persistedMesh = null;
    this.persistedLevelingOn = false;
    this.saveVerification = null;
    this.recoveringReset = false;
  }

  private persistenceDirty(): boolean {
    if (this.persistedSettings === null) return false;
    return (
      settingMismatches(this.persistedSettings, this.settings).length > 0 ||
      this.persistedLevelingOn !== this.levelingOn ||
      !meshesEqual(this.persistedMesh, this.mesh)
    );
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function settingMismatches(
  expected: Record<string, Record<string, number>>,
  actual: Record<string, Record<string, number>>,
): string[] {
  const mismatches: string[] = [];
  const codes = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const code of codes) {
    const expectedParams = expected[code] ?? {};
    const actualParams = actual[code] ?? {};
    const fields = new Set([...Object.keys(expectedParams), ...Object.keys(actualParams)]);
    for (const field of fields) {
      const wanted = expectedParams[field];
      const got = actualParams[field];
      if (wanted === undefined || got === undefined || Math.abs(wanted - got) > 0.0005) {
        mismatches.push(`${code} ${field} expected ${wanted ?? 'missing'}, got ${got ?? 'missing'}`);
      }
    }
  }
  return mismatches;
}

function meshesEqual(expected: number[][] | null, actual: number[][] | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  return (
    expected.length === actual.length &&
    expected.every(
      (row, rowIndex) =>
        row.length === actual[rowIndex]?.length &&
        row.every((value, columnIndex) => Math.abs(value - (actual[rowIndex]?.[columnIndex] ?? Number.NaN)) <= 0.0005),
    )
  );
}
