import { EventEmitter } from 'node:events';
import { marlinChecksum } from '../protocol/checksum.ts';

export type SimOptions = {
  chaos?: boolean;
  caps?: Record<string, boolean>;
  firmwareName?: string;
  machine?: string;
  fastAutotune?: boolean;
  /** Zero-based index of a G30 that should fail silently, as a real probe sometimes does. */
  probeFailsAt?: number;
  noBedPid?: boolean;
  sdPrintStatus?: 'idle' | 'printing' | 'unknown';
};

type Heater = { current: number; target: number; power: number; ambient: number; rate: number; loss: number };

const DEFAULT_CAPS: Record<string, boolean> = {
  SERIAL_XON_XOFF: false,
  BINARY_FILE_TRANSFER: false,
  EEPROM: true,
  VOLUMETRIC: true,
  AUTOREPORT_POS: false,
  AUTOREPORT_TEMP: true,
  PROGRESS: false,
  PRINT_JOB: true,
  AUTOLEVEL: true,
  RUNOUT: false,
  Z_PROBE: true,
  LEVELING_DATA: true,
  BUILD_PERCENT: false,
  SOFTWARE_POWER: false,
  TOGGLE_LIGHTS: false,
  CASE_LIGHT_BRIGHTNESS: false,
  EMERGENCY_PARSER: false,
  HOST_ACTION_COMMANDS: false,
  PROMPT_SUPPORT: false,
  SDCARD: true,
  MULTI_VOLUME: false,
  REPEAT: false,
  SD_WRITE: true,
  AUTOREPORT_SD_STATUS: false,
  LONG_FILENAME: true,
  THERMAL_PROTECTION: true,
  MOTION_MODES: false,
  ARCS: true,
  BABYSTEPPING: true,
  CHAMBER_TEMPERATURE: false,
  COOLER_TEMPERATURE: false,
  MEATPACK: false,
  CONFIG_EXPORT: false,
};

const BLOCKING = /^(G28|G29|G30|M109|M190|M303|M400)\b/i;

export class MarlinSim extends EventEmitter {
  private opts: SimOptions;
  private caps: Record<string, boolean>;
  private rx = '';
  private expectedLine = 1;
  private lastGoodLine = 0;
  private halted = false;
  private tickTimer?: NodeJS.Timeout;
  private autoreportTimer?: NodeJS.Timeout;
  private busyTimer?: NodeJS.Timeout;
  private blocked = false;
  private probeCount = 0;
  private pendingQueue: string[] = [];

  private hotend: Heater = { current: 21.4, target: 0, power: 0, ambient: 21.4, rate: 4.0, loss: 0.055 };
  private bed: Heater = { current: 21.8, target: 0, power: 0, ambient: 21.8, rate: 0.95, loss: 0.02 };

  private pos = { x: 0, y: 0, z: 0, e: 0 };
  private homed = { x: false, y: false, z: false };
  private fan = 0;
  private levelingOn = false;
  private meshValid = false;
  private mesh: number[][] = [];
  private settings = new Map<string, Record<string, number>>();
  private savedState: string | null = null;
  private endstops: Record<string, string> = {
    x_min: 'open',
    y_min: 'open',
    z_min: 'open',
    z_probe: 'open',
  };

  constructor(options: SimOptions = {}) {
    super();
    this.opts = options;
    this.caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) };
    this.resetSettings();
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(0.2), 200);
    setTimeout(() => {
      this.out('start');
      this.out('echo: External Reset');
      this.out(`echo:${this.firmwareVersion()}`);
      this.out(`echo: Last Updated: 2026-01-01 | Author: ${this.opts.machine ?? 'Kingroon KP5L'}`);
      this.out('echo:Compiled: Jan  1 2026');
      this.out('echo: Free Memory: 12345  PlannerBufferBytes: 1584');
      this.out('echo:EEPROM version mismatch (EEPROM=? Marlin=V87)');
      this.out('echo:Hardcoded Default Settings Loaded');
    }, 120);
  }

  resetBoard(): void {
    this.hotend.target = 0;
    this.bed.target = 0;
    this.pos = { x: 0, y: 0, z: 0, e: 0 };
    this.homed = { x: false, y: false, z: false };
    this.out('start');
    this.out('echo: External Reset');
    this.out(`echo:${this.firmwareVersion()}`);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.autoreportTimer) clearInterval(this.autoreportTimer);
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.tickTimer = undefined;
    this.autoreportTimer = undefined;
    this.busyTimer = undefined;
  }

  write(data: string): void {
    this.rx += data;
    let idx: number;
    while ((idx = this.rx.search(/\r?\n/)) !== -1) {
      const line = this.rx.slice(0, idx);
      this.rx = this.rx.slice(idx + (this.rx[idx] === '\r' ? 2 : 1));
      this.receive(line);
    }
  }

  private out(line: string): void {
    this.emit('out', line);
  }

  private receive(rawLine: string): void {
    let line = rawLine.trim();
    if (line === '') return;

    if (/^(M112|M108|M410|M876)\b/i.test(line)) {
      this.handleEmergency(line);
      return;
    }

    if (this.opts.chaos && Math.random() < 0.07) {
      line = corrupt(line);
    }

    const numbered = /^N(-?\d+)\s+(.*?)(?:\*(\d+))?$/.exec(line);
    if (numbered) {
      const lineNo = Number(numbered[1]);
      const body = (numbered[2] ?? '').trim();
      const cs = numbered[3];

      if (cs !== undefined) {
        const expected = marlinChecksum(`N${lineNo} ${body}`);
        if (Number(cs) !== expected) {
          this.out(`Error:checksum mismatch, Last Line: ${this.lastGoodLine}`);
          this.out(`Resend: ${this.lastGoodLine + 1}`);
          this.out('ok');
          return;
        }
      }

      if (/^M110\b/i.test(body)) {
        const n = /N(-?\d+)/i.exec(body);
        this.lastGoodLine = n ? Number(n[1]) : 0;
        this.expectedLine = this.lastGoodLine + 1;
        this.out('ok');
        return;
      }

      if (lineNo !== this.expectedLine) {
        this.out(`Error:Line Number is not Last Line Number+1, Last Line: ${this.lastGoodLine}`);
        this.out(`Resend: ${this.lastGoodLine + 1}`);
        this.out('ok');
        return;
      }

      this.lastGoodLine = lineNo;
      this.expectedLine = lineNo + 1;
      this.enqueue(body);
      return;
    }

    if (/^M110\b/i.test(line)) {
      const n = /N(-?\d+)/i.exec(line);
      this.lastGoodLine = n ? Number(n[1]) : 0;
      this.expectedLine = this.lastGoodLine + 1;
      this.out('ok');
      return;
    }

    this.enqueue(line.replace(/\*\d+$/, '').trim());
  }

  private enqueue(cmd: string): void {
    if (this.halted) return;
    if (this.blocked) {
      this.pendingQueue.push(cmd);
      return;
    }
    this.execute(cmd);
  }

  private drain(): void {
    while (!this.blocked && this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift();
      if (next !== undefined) this.execute(next);
    }
  }

  private execute(cmd: string): void {
    const upper = cmd.toUpperCase();
    const code = /^([GMT]\d+(?:\.\d+)?)/.exec(upper)?.[1] ?? '';
    const args = readArgs(cmd);

    if (BLOCKING.test(cmd)) this.beginBlocking();

    switch (code) {
      case 'M115':
        this.reportFirmware();
        break;

      case 'M503':
        this.reportSettings();
        break;

      case 'M105':
        this.out(`ok ${this.tempLine()}`);
        return;

      case 'M27':
        if (this.opts.sdPrintStatus === 'printing') this.out('SD printing byte 128/1024');
        else if (this.opts.sdPrintStatus === 'unknown') this.out('echo:SD status unavailable');
        else this.out('Not SD printing');
        break;

      case 'M155': {
        const s = args['S'] ?? 0;
        if (this.autoreportTimer) clearInterval(this.autoreportTimer);
        this.autoreportTimer = undefined;
        if (s > 0) {
          this.autoreportTimer = setInterval(() => this.out(this.tempLine()), s * 1000);
        }
        break;
      }

      case 'M114':
        this.out(
          `X:${f(this.pos.x)} Y:${f(this.pos.y)} Z:${f(this.pos.z)} E:${f(this.pos.e)} ` +
            `Count X:${Math.round(this.pos.x * 160)} Y:${Math.round(this.pos.y * 160)} Z:${Math.round(this.pos.z * 800)}`,
        );
        break;

      case 'M119':
        this.out('Reporting endstop status');
        for (const [name, state] of Object.entries(this.endstops)) this.out(`${name}: ${state}`);
        break;

      case 'M104':
        this.hotend.target = args['S'] ?? 0;
        break;

      case 'M140':
        this.bed.target = args['S'] ?? 0;
        break;

      case 'M109':
        this.hotend.target = args['S'] ?? args['R'] ?? 0;
        this.waitForHeater(this.hotend, () => this.finishBlocking());
        return;

      case 'M190':
        this.bed.target = args['S'] ?? args['R'] ?? 0;
        this.waitForHeater(this.bed, () => this.finishBlocking());
        return;

      case 'M106':
        this.fan = args['S'] ?? 255;
        break;

      case 'M107':
        this.fan = 0;
        break;

      case 'M84':
      case 'M18':
        break;

      case 'M280': {
        const s = args['S'] ?? 0;
        if (s <= 20) this.endstops['z_probe'] = 'open';
        break;
      }

      case 'G28':
        this.doHome(upper);
        return;

      case 'G29':
        this.doProbe();
        return;

      case 'G30': {
        // Marlin's exact wording, no space after the colons, three decimals on Z.
        const px = args['X'] ?? this.pos.x;
        const py = args['Y'] ?? this.pos.y;
        const z = Number((Math.sin(px / 90) * 0.06 + Math.cos(py / 110) * 0.05 - 0.02).toFixed(3));
        setTimeout(() => {
          if (this.opts.probeFailsAt !== undefined && this.opts.probeFailsAt === this.probeCount) {
            // A failed probe prints nothing at all — that silence is what the host must cope with.
            this.probeCount++;
            this.finishBlocking();
            return;
          }
          this.probeCount++;
          this.out(`Bed X:${px.toFixed(2)} Y:${py.toFixed(2)} Z:${z.toFixed(3)}`);
          this.finishBlocking();
        }, 220);
        return;
      }

      case 'G0':
      case 'G1':
        if (args['X'] !== undefined) this.pos.x = args['X'];
        if (args['Y'] !== undefined) this.pos.y = args['Y'];
        if (args['Z'] !== undefined) this.pos.z = args['Z'];
        if (args['E'] !== undefined) this.pos.e = args['E'];
        break;

      case 'G90':
      case 'G91':
      case 'G21':
        break;

      case 'G92':
        if (args['X'] !== undefined) this.pos.x = args['X'];
        if (args['Y'] !== undefined) this.pos.y = args['Y'];
        if (args['Z'] !== undefined) this.pos.z = args['Z'];
        if (args['E'] !== undefined) this.pos.e = args['E'];
        break;

      case 'M303':
        this.doAutotune(args);
        return;

      case 'M420':
        if (args['S'] !== undefined) this.levelingOn = args['S'] === 1 && this.meshValid;
        if (upper.includes('V')) this.printMesh();
        this.out(`echo:Bed Leveling ${this.levelingOn ? 'ON' : 'OFF'}`);
        break;

      case 'M421':
        if (args['I'] !== undefined && args['J'] !== undefined && args['Z'] !== undefined) {
          const row = this.mesh[args['J']];
          if (row) row[args['I']] = args['Z'];
        }
        break;

      case 'M290':
        if (args['Z'] !== undefined) this.pos.z += args['Z'];
        break;

      case 'M500':
        this.savedState = JSON.stringify({
          settings: [...this.settings],
          mesh: this.mesh,
          meshValid: this.meshValid,
          levelingOn: this.levelingOn,
        });
        this.out('echo:Settings Stored (656 bytes; crc 41276)');
        break;

      case 'M501': {
        if (this.savedState) {
          const saved = JSON.parse(this.savedState) as {
            settings: [string, Record<string, number>][];
            mesh: number[][];
            meshValid: boolean;
            levelingOn: boolean;
          };
          this.settings = new Map(saved.settings);
          this.mesh = saved.mesh;
          this.meshValid = saved.meshValid;
          this.levelingOn = saved.levelingOn;
        }
        this.out('echo:Stored settings retrieved');
        break;
      }

      case 'M502':
        this.resetSettings();
        this.out('echo:Hardcoded Default Settings Loaded');
        break;

      case 'M92':
      case 'M201':
      case 'M203':
      case 'M204':
      case 'M205':
      case 'M206':
      case 'M301':
      case 'M304':
      case 'M851':
      case 'M900':
        this.applySetting(code, args);
        break;

      case 'M117':
        break;

      default:
        this.out(`echo:Unknown command: "${cmd}"`);
        break;
    }

    if (this.blocked) this.finishBlocking();
    else this.out('ok');
  }

  private handleEmergency(line: string): void {
    if (/^M112\b/i.test(line)) {
      this.halted = true;
      this.hotend.target = 0;
      this.bed.target = 0;
      if (this.caps['EMERGENCY_PARSER']) {
        this.out('Error:Printer halted. kill() called!');
      } else {
        setTimeout(() => this.out('Error:Printer halted. kill() called!'), 1800);
      }
      return;
    }
    this.out('ok');
  }

  private beginBlocking(): void {
    this.blocked = true;
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.busyTimer = setInterval(() => this.out('echo:busy: processing'), 2000);
  }

  private finishBlocking(): void {
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.busyTimer = undefined;
    this.blocked = false;
    this.out('ok');
    this.drain();
  }

  private waitForHeater(h: Heater, done: () => void): void {
    const check = setInterval(() => {
      if (h.target === 0 || Math.abs(h.current - h.target) < 1.5) {
        clearInterval(check);
        done();
      }
    }, 250);
  }

  private doHome(upper: string): void {
    const all = !/[XYZ]/.test(upper.replace('G28', ''));
    const ms = all ? 3200 : 1400;
    setTimeout(() => {
      if (all || upper.includes('X')) {
        this.pos.x = 0;
        this.homed.x = true;
      }
      if (all || upper.includes('Y')) {
        this.pos.y = 0;
        this.homed.y = true;
      }
      if (all || upper.includes('Z')) {
        this.pos.z = 0;
        this.homed.z = true;
      }
      this.finishBlocking();
    }, ms);
  }

  private doProbe(): void {
    const n = 4;
    this.mesh = [];
    let i = 0;
    const step = setInterval(() => {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        row.push(Number((Math.sin(i * 0.9) * 0.09 + Math.cos(j * 1.1) * 0.06 - 0.02).toFixed(3)));
      }
      this.mesh.push(row);
      // Real Marlin phrasing, trailing period included, so the host parser is tested against it.
      this.out(`echo:Probing point ${i * n + n}/${n * n}.`);
      i++;
      if (i >= n) {
        clearInterval(step);
        this.meshValid = true;
        this.levelingOn = true;
        this.printMesh();
        this.out('echo:Bed Leveling ON');
        this.finishBlocking();
      }
    }, this.opts.fastAutotune === false ? 900 : 250);
  }

  private printMesh(): void {
    if (!this.meshValid) {
      this.out('echo:Mesh is invalid, run G29 first');
      return;
    }
    this.out('Bilinear Leveling Grid:');
    this.out('      0      1      2      3');
    this.mesh.forEach((row, j) => {
      this.out(` ${j}  ${row.map((v) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3))).join(' ')}`);
    });
  }

  private doAutotune(args: Record<string, number>): void {
    const target = args['S'] ?? 200;
    const cycles = Math.max(3, args['C'] ?? 5);
    const apply = args['U'] === 1;
    const isBed = (args['E'] ?? 0) === -1;
    const heater = isBed ? this.bed : this.hotend;
    const stepMs = this.opts.fastAutotune === false ? 8000 : 700;

    heater.target = target;
    this.out('PID Autotune start');

    let cycle = 0;
    const timer = setInterval(() => {
      cycle++;
      const min = target - 1.2 - Math.random() * 0.6;
      const max = target + 1.2 + Math.random() * 0.6;
      this.out(`bias: ${(60 + cycle).toFixed(0)} d: ${(60 + cycle).toFixed(0)} min: ${min.toFixed(2)} max: ${max.toFixed(2)}`);
      if (cycle >= cycles) {
        clearInterval(timer);
        const ku = 20 + Math.random() * 4;
        const tu = 30 + Math.random() * 8;
        const kp = 0.6 * ku;
        const ki = (1.2 * ku) / tu;
        const kd = 0.075 * ku * tu;
        this.out(`Ku: ${ku.toFixed(2)} Tu: ${tu.toFixed(2)}`);
        this.out('Classic PID');
        this.out(`Kp: ${kp.toFixed(2)} Ki: ${ki.toFixed(2)} Kd: ${kd.toFixed(2)}`);
        if (apply) {
          this.settings.set(isBed ? 'M304' : 'M301', { P: kp, I: ki, D: kd });
          this.out('echo:PID values applied');
        }
        this.out('PID Autotune finished! Put the last Kp, Ki and Kd constants from below into Configuration.h');
        heater.target = 0;
        this.finishBlocking();
      }
    }, stepMs);
  }

  private applySetting(code: string, args: Record<string, number>): void {
    const cur = this.settings.get(code) ?? {};
    this.settings.set(code, { ...cur, ...args });
  }

  private resetSettings(): void {
    this.settings = new Map<string, Record<string, number>>([
      ['M92', { X: 160, Y: 160, Z: 800, E: 768 }],
      ['M203', { X: 300, Y: 300, Z: 6, E: 100 }],
      ['M201', { X: 1000, Y: 1000, Z: 100, E: 1000 }],
      ['M204', { P: 1000, R: 1000, T: 1000 }],
      ['M205', { B: 20000, S: 0, T: 0, X: 10, Y: 10, Z: 0.4, E: 3 }],
      ['M206', { X: 0, Y: 0, Z: 0 }],
      ['M301', { P: 24, I: 0.88, D: 80 }],
      ['M304', { P: 10, I: 0.023, D: 305.4 }],
      ['M851', { X: 27, Y: -6, Z: 0 }],
      ['M900', { K: 0.22 }],
    ]);
  }

  private firmwareVersion(): string {
    return this.opts.firmwareName ?? 'Marlin 2.1.2.5 (3DTune Sim)';
  }

  private reportFirmware(): void {
    this.out(
      `FIRMWARE_NAME:${this.firmwareVersion()} SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin ` +
        `PROTOCOL_VERSION:1.0 MACHINE_TYPE:${this.opts.machine ?? 'Kingroon KP5L'} ` +
        'EXTRUDER_COUNT:1 UUID:cede2a2f-41a2-4748-9b12-c55c62f367ff',
    );
    for (const [name, on] of Object.entries(this.caps)) {
      this.out(`Cap:${name}:${on ? 1 : 0}`);
    }
  }

  private reportSettings(): void {
    const g = (code: string) => this.settings.get(code) ?? {};
    const fmt = (code: string, keys: string[], digits = 2) =>
      `echo:  ${code} ${keys
        .filter((k) => g(code)[k] !== undefined)
        .map((k) => `${k}${(g(code)[k] as number).toFixed(digits)}`)
        .join(' ')}`;

    this.out('echo:  G21 ; Units in mm (mm)');
    this.out('echo:; Steps per unit:');
    this.out(fmt('M92', ['X', 'Y', 'Z', 'E']));
    this.out('echo:; Maximum feedrates (units/s):');
    this.out(fmt('M203', ['X', 'Y', 'Z', 'E']));
    this.out('echo:; Maximum Acceleration (units/s2):');
    this.out(fmt('M201', ['X', 'Y', 'Z', 'E']));
    this.out('echo:; Acceleration (units/s2): P<print> R<retract> T<travel>');
    this.out(fmt('M204', ['P', 'R', 'T']));
    this.out('echo:; Advanced: B<min_segment_time_us> S<min_feedrate> T<min_travel_feedrate> J<junc_dev>');
    this.out(fmt('M205', ['B', 'S', 'T', 'X', 'Y', 'Z', 'E']));
    this.out('echo:; Home offset:');
    this.out(fmt('M206', ['X', 'Y', 'Z']));
    this.out('echo:; Auto Bed Leveling:');
    this.out(`echo:  M420 S${this.levelingOn ? 1 : 0} Z0.00`);
    this.out('echo:; Hotend PID:');
    this.out(fmt('M301', ['P', 'I', 'D']));
    if (!this.opts.noBedPid) {
      this.out('echo:; Bed PID:');
      this.out(fmt('M304', ['P', 'I', 'D'], 3));
    }
    this.out('echo:; Z-Probe Offset (mm):');
    this.out(fmt('M851', ['X', 'Y', 'Z']));
    this.out('echo:; Linear Advance:');
    this.out(fmt('M900', ['K'], 3));
  }

  private tempLine(): string {
    return (
      `T:${f(this.hotend.current)} /${f(this.hotend.target)} ` +
      `B:${f(this.bed.current)} /${f(this.bed.target)} ` +
      `@:${Math.round(this.hotend.power * 127)} B@:${Math.round(this.bed.power * 127)}`
    );
  }

  private tick(dt: number): void {
    for (const h of [this.hotend, this.bed]) {
      h.power = h.target > 0 ? clamp((h.target - h.current) * 0.4, 0, 1) : 0;
      const delta = (h.power * h.rate - (h.current - h.ambient) * h.loss) * dt;
      h.current = Math.max(h.ambient - 0.5, h.current + delta + (Math.random() - 0.5) * 0.06);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function f(v: number): string {
  return v.toFixed(2);
}

function readArgs(cmd: string): Record<string, number> {
  const args: Record<string, number> = {};
  const re = /([A-Z])(-?\d*\.?\d+)/g;
  const body = cmd.replace(/^[GMT]\d+(?:\.\d+)?/i, '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body.toUpperCase())) !== null) {
    if (m[1]) args[m[1]] = Number(m[2]);
  }
  return args;
}

function corrupt(line: string): string {
  if (line.length < 4) return line;
  const i = 2 + Math.floor(Math.random() * (line.length - 3));
  const ch = line.charCodeAt(i);
  return line.slice(0, i) + String.fromCharCode(ch === 0x7e ? 0x21 : ch + 1) + line.slice(i + 1);
}
