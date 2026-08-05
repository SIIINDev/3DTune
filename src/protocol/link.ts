import { EventEmitter } from 'node:events';
import type { Transport } from '../transport/types.ts';
import { frame, stripComment } from './checksum.ts';
import { parseLine, type ParsedLine } from './parse.ts';

export type CommandResult = { ok: boolean; lines: string[]; error?: string };

export type LinkOptions = {
  useLineNumbers?: boolean;
  defaultTimeoutMs?: number;
  longTimeoutMs?: number;
  errorGraceMs?: number;
  maxResends?: number;
  inactivityMs?: number;
};

type Pending = {
  id: number;
  gcode: string;
  framed: string;
  lineNo: number | null;
  unnumbered: boolean;
  timeoutMs: number;
  resends: number;
  lines: string[];
  error?: string;
  errorTimer?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
  resolve: (r: CommandResult) => void;
  reject: (e: Error) => void;
};

const LONG_RUNNING = /^(G28|G29|G30|G33|G34|M48|M109|M190|M191|M303|M600|M701|M702|M420\s+[^S]|M999)\b/i;
const EMERGENCY = /^(M112|M108|M410|M876)\b/i;

const HISTORY_LIMIT = 64;

export class Link extends EventEmitter {
  private transport: Transport;
  private opts: Required<LinkOptions>;
  private rxBuffer = '';
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private history = new Map<number, string>();
  private nextLine = 1;
  private nextId = 1;
  private closed = false;
  private halted = false;
  private busyReason: string | null = null;
  private inactivityTimer?: NodeJS.Timeout;
  private pendingResend: number | null = null;
  private resendFallback?: NodeJS.Timeout;

  constructor(transport: Transport, options: LinkOptions = {}) {
    super();
    this.transport = transport;
    this.opts = {
      useLineNumbers: options.useLineNumbers ?? true,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 15_000,
      longTimeoutMs: options.longTimeoutMs ?? 20 * 60_000,
      errorGraceMs: options.errorGraceMs ?? 2_000,
      maxResends: options.maxResends ?? 5,
      inactivityMs: options.inactivityMs ?? 60_000,
    };

    this.transport.on('data', (chunk: string) => this.onData(chunk));
    this.transport.on('close', () => this.fail(new Error('transport closed')));
    this.transport.on('error', (err: Error) => this.fail(err));
  }

  get isHalted(): boolean {
    return this.halted;
  }

  get busy(): string | null {
    return this.busyReason;
  }

  get queueDepth(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  async resync(): Promise<void> {
    this.history.clear();
    this.clearResend();
    this.nextLine = 1;
    this.halted = false;
    if (this.opts.useLineNumbers) {
      await this.send('M110 N0', { unnumbered: true, timeoutMs: 5_000 });
    }
  }

  send(gcode: string, opts: { unnumbered?: boolean; timeoutMs?: number } = {}): Promise<CommandResult> {
    const clean = stripComment(gcode);
    if (clean === '') return Promise.resolve({ ok: true, lines: [] });

    if (EMERGENCY.test(clean)) {
      this.sendRaw(clean);
      return Promise.resolve({ ok: true, lines: [] });
    }

    if (this.closed) return Promise.reject(new Error('link closed'));
    if (this.halted) return Promise.reject(new Error('printer halted — power cycle required'));

    const timeoutMs =
      opts.timeoutMs ?? (LONG_RUNNING.test(clean) ? this.opts.longTimeoutMs : this.opts.defaultTimeoutMs);

    return new Promise<CommandResult>((resolve, reject) => {
      const pending: Pending = {
        id: this.nextId++,
        gcode: clean,
        framed: '',
        lineNo: null,
        unnumbered: opts.unnumbered === true || /^M110\b/i.test(clean),
        timeoutMs,
        resends: 0,
        lines: [],
        resolve,
        reject,
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  sendRaw(gcode: string): void {
    const clean = stripComment(gcode);
    if (clean === '') return;
    this.transport.write(`${clean}\n`);
    this.emit('sent', clean);
  }

  close(): void {
    this.closed = true;
    this.clearInactivity();
    this.clearResend();
    const err = new Error('link closed');
    if (this.inFlight) {
      this.clearTimers(this.inFlight);
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    for (const p of this.queue.splice(0)) p.reject(err);
  }

  private pump(): void {
    if (this.inFlight || this.closed || this.halted) return;
    const next = this.queue.shift();
    if (!next) return;

    next.lineNo = this.opts.useLineNumbers && !next.unnumbered ? this.nextLine++ : null;
    next.framed = frame(next.gcode, next.lineNo);
    if (next.lineNo !== null) {
      this.history.set(next.lineNo, next.framed);
      if (this.history.size > HISTORY_LIMIT) {
        const oldest = this.history.keys().next();
        if (!oldest.done) this.history.delete(oldest.value);
      }
    }

    this.inFlight = next;
    this.transmit(next);
  }

  private transmit(p: Pending): void {
    this.clearTimers(p);
    // The timer must exist before the write: a synchronous transport can deliver the whole reply
    // inside write(), completing the command before a later-assigned timer could ever be cleared.
    p.timer = setTimeout(() => this.onTimeout(p), p.timeoutMs);
    try {
      this.transport.write(`${p.framed}\n`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.clearTimers(p);
      if (this.inFlight === p) this.inFlight = null;
      p.resolve({ ok: false, lines: p.lines, error: `write failed: ${error.message}` });
      this.fail(error);
      return;
    }
    this.emit('sent', p.framed);
  }

  private onTimeout(p: Pending): void {
    if (this.inFlight !== p) return;
    this.inFlight = null;
    this.clearTimers(p);
    p.resolve({ ok: false, lines: p.lines, error: `timeout after ${p.timeoutMs} ms: ${p.gcode}` });
    this.emit('timeout', p.gcode);
    this.pump();
  }

  private onData(chunk: string): void {
    this.touchInactivity();
    this.rxBuffer += chunk;
    let idx: number;
    while ((idx = this.rxBuffer.search(/\r?\n/)) !== -1) {
      const raw = this.rxBuffer.slice(0, idx);
      this.rxBuffer = this.rxBuffer.slice(idx + (this.rxBuffer[idx] === '\r' ? 2 : 1));
      if (raw.trim() !== '') this.onLine(raw);
    }
  }

  private onLine(raw: string): void {
    this.emit('line', raw);
    const parsed = parseLine(raw);
    this.emit('parsed', parsed);

    if (this.inFlight?.timer) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.timer = setTimeout(() => this.onTimeout(this.inFlight!), this.inFlight.timeoutMs);
    }

    switch (parsed.kind) {
      case 'ok':
        if (parsed.temps) this.emit('temp', parsed.temps);
        this.setBusy(null);
        if (this.pendingResend !== null) this.performResend();
        else this.completeInFlight();
        return;

      case 'resend':
        this.onResend(parsed.lineNo);
        return;

      case 'busy':
        this.setBusy(parsed.reason || 'processing');
        return;

      case 'error':
        this.onError(parsed, raw);
        return;

      case 'temp':
        this.emit('temp', parsed.temps);
        break;

      case 'position':
        this.emit('position', parsed);
        break;

      case 'endstops':
        this.emit('endstops', parsed.states);
        break;

      case 'cap':
        this.emit('cap', parsed.name, parsed.enabled);
        break;

      case 'firmware':
        this.emit('firmware', parsed.fields);
        break;

      case 'start':
        this.emit('reset');
        break;

      case 'action':
        this.emit('action', parsed.action);
        break;
    }

    if (this.inFlight) this.inFlight.lines.push(raw);
  }

  private onError(parsed: Extract<ParsedLine, { kind: 'error' }>, raw: string): void {
    this.emit('printerError', parsed.text, parsed.fatal);

    if (parsed.fatal) {
      this.halted = true;
      const err = new Error(`printer halted: ${parsed.text}`);
      if (this.inFlight) {
        this.clearTimers(this.inFlight);
        this.inFlight.reject(err);
        this.inFlight = null;
      }
      for (const p of this.queue.splice(0)) p.reject(err);
      this.emit('halted', parsed.text);
      return;
    }

    if (parsed.expectsResend) return;

    const p = this.inFlight;
    if (!p) return;
    p.lines.push(raw);
    p.error = parsed.text;
    if (!p.errorTimer) {
      p.errorTimer = setTimeout(() => {
        if (this.inFlight === p) {
          this.inFlight = null;
          this.clearTimers(p);
          p.resolve({ ok: false, lines: p.lines, error: p.error });
          this.pump();
        }
      }, this.opts.errorGraceMs);
    }
  }

  private onResend(lineNo: number): void {
    const p = this.inFlight;
    if (!p) {
      const cached = this.history.get(lineNo);
      if (cached) {
        this.transport.write(`${cached}\n`);
        this.emit('sent', cached);
      }
      this.nextLine = Math.max(this.nextLine, lineNo + 1);
      return;
    }

    p.resends++;
    if (p.resends > this.opts.maxResends) {
      this.inFlight = null;
      this.clearTimers(p);
      p.resolve({ ok: false, lines: p.lines, error: `resend limit exceeded for ${p.gcode}` });
      this.emit('resendGaveUp', p.gcode);
      this.pump();
      return;
    }

    this.pendingResend = lineNo;
    this.emit('resend', lineNo, p.resends);

    if (this.resendFallback) clearTimeout(this.resendFallback);
    this.resendFallback = setTimeout(() => {
      if (this.pendingResend !== null) this.performResend();
    }, 500);
  }

  private performResend(): void {
    const lineNo = this.pendingResend;
    this.pendingResend = null;
    if (this.resendFallback) clearTimeout(this.resendFallback);
    this.resendFallback = undefined;

    const p = this.inFlight;
    if (p === null || lineNo === null) return;

    p.lineNo = lineNo;
    p.framed = frame(p.gcode, lineNo);
    this.history.set(lineNo, p.framed);
    this.nextLine = lineNo + 1;
    this.transmit(p);
  }

  private completeInFlight(): void {
    const p = this.inFlight;
    if (!p) return;
    this.inFlight = null;
    this.clearResend();
    this.clearTimers(p);
    p.resolve({ ok: p.error === undefined, lines: p.lines, ...(p.error ? { error: p.error } : {}) });
    this.pump();
  }

  private setBusy(reason: string | null): void {
    if (this.busyReason === reason) return;
    this.busyReason = reason;
    this.emit('busy', reason);
  }

  private clearResend(): void {
    this.pendingResend = null;
    if (this.resendFallback) clearTimeout(this.resendFallback);
    this.resendFallback = undefined;
  }

  private clearTimers(p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.errorTimer) clearTimeout(p.errorTimer);
    p.timer = undefined;
    p.errorTimer = undefined;
  }

  private touchInactivity(): void {
    this.clearInactivity();
    if (this.closed) return;
    this.inactivityTimer = setTimeout(() => {
      this.emit('stale', this.opts.inactivityMs);
    }, this.opts.inactivityMs);
  }

  private clearInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = undefined;
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.clearInactivity();
    this.clearResend();
    if (this.inFlight) {
      this.clearTimers(this.inFlight);
      this.inFlight.reject(err);
      this.inFlight = null;
    }
    for (const p of this.queue.splice(0)) p.reject(err);
    this.emit('closed', err);
  }
}
