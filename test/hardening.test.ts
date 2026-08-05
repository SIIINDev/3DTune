import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deadmanMs, type AppConfig } from '../src/config.ts';
import { explainOpenFailure, normalizePortPath } from '../src/transport/serial.ts';
import { Printer } from '../src/printer/printer.ts';
import { Link } from '../src/protocol/link.ts';
import { DEADMAN_DEFAULT_MS, startServer, type ServerHandle } from '../src/server/server.ts';
import { MarlinSim } from '../src/sim/marlin-sim.ts';
import type { Transport } from '../src/transport/types.ts';

/* The owner chose a 30-minute dead-man window. It is a safety decision, not a tunable default,
   so it gets asserted rather than left to drift with a future edit. */
test('the dead-man window matches the recorded owner decision of 30 minutes', () => {
  assert.equal(DEADMAN_DEFAULT_MS, 30 * 60_000);
});

test('deadmanMinutes config is parsed, and only sane values win', () => {
  const base: AppConfig = { token: 'x'.repeat(22), port: 8420 };
  assert.equal(deadmanMs(base), undefined, 'absent means "use the recorded default"');
  assert.equal(deadmanMs({ ...base, deadmanMinutes: 45 }), 45 * 60_000);
  assert.equal(deadmanMs({ ...base, deadmanMinutes: 0 }), 0, 'zero must be honoured as "disabled"');
  assert.equal(deadmanMs({ ...base, deadmanMinutes: -5 }), undefined, 'negative falls back to the default');
  assert.equal(deadmanMs({ ...base, deadmanMinutes: Number.NaN }), undefined);
  assert.equal(deadmanMs({ ...base, deadmanMinutes: Number.POSITIVE_INFINITY }), undefined);
});

/* T2: the earlier corruption test flipped a checksum, which Marlin answers with Resend.
   The nastier case is a mangled N prefix: the line stops looking numbered, so Marlin executes
   it unnumbered and silently answers ok. Nothing asks for a resend, so the reply data is simply
   lost. The handshake retry is the only mitigation and it must actually hold. */
class PrefixCorruptingTransport extends EventEmitter implements Transport {
  readonly label = 'test://prefix-corrupt';
  private sim: MarlinSim;
  private budget: number;
  corrupted = 0;

  constructor(corruptFirstN: number) {
    super();
    this.budget = corruptFirstN;
    this.sim = new MarlinSim();
    this.sim.on('out', (line: string) => this.emit('data', `${line}\n`));
  }

  open(): Promise<void> {
    this.sim.start();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.sim.stop();
    return Promise.resolve();
  }

  write(data: string): void {
    if (this.budget > 0 && /^N\d+ /.test(data)) {
      this.budget--;
      this.corrupted++;
      this.sim.write(data.replace(/^N/, 'X'));
      return;
    }
    this.sim.write(data);
  }
}

test('a mangled N prefix loses the reply silently, and the handshake retry recovers it', async () => {
  const transport = new PrefixCorruptingTransport(1);
  await transport.open();
  const link = new Link(transport, { inactivityMs: 30_000 });
  const lines: string[] = [];
  link.on('line', (l: string) => lines.push(l));
  await new Promise((r) => setTimeout(r, 250));

  try {
    await link.resync();

    const first = await link.send('M115');
    assert.equal(transport.corrupted, 1, 'the prefix must have been mangled exactly once');
    assert.equal(first.ok, true, 'Marlin answers ok even though it executed garbage');
    assert.ok(
      !first.lines.some((l) => /FIRMWARE_NAME/.test(l)),
      'this is the silent-loss case: ok arrives with no firmware payload',
    );
    assert.ok(
      first.lines.some((l) => /Unknown command/i.test(l)),
      'the mangled line should surface as an unknown command rather than vanish entirely',
    );

    const retry = await link.send('M115');
    assert.ok(
      retry.lines.some((l) => /FIRMWARE_NAME/.test(l)),
      'a plain retry must succeed — the link must not be wedged by the mangled line',
    );
  } finally {
    link.close();
    await transport.close();
  }
});

test('the printer handshake tolerates a mangled prefix on its first M115', async () => {
  const printer = new Printer();
  await printer.connect({ kind: 'mock', corruptPrefixCount: 1 });
  try {
    const snap = printer.snapshot();
    assert.equal(snap.connection.status, 'connected');
    assert.ok(
      snap.connection.firmware !== null || snap.connection.capsReported,
      'the retry loop must recover firmware info after a silently-lost M115',
    );
    assert.ok(Object.keys(snap.settings).length > 0, 'settings must survive the same failure mode');
  } finally {
    await printer.disconnect();
  }
});

/* T6: two clients editing the same setting. The printer is the single source of truth, so the
   last write must win everywhere and both clients must converge on the same value — no client
   may keep a stale number that it believes it wrote. */
test('two clients writing the same setting converge on one value from the printer', async () => {
  const printer = new Printer();
  const server: ServerHandle = startServer({
    printer,
    token: 'concurrency-token-abcdefgh',
    host: '127.0.0.1',
    port: 0,
    webRoot: join(import.meta.dirname, '..', 'web'),
    mock: true,
    chaos: false,
    deadmanMs: 0,
  });
  await server.ready;
  await printer.connect({ kind: 'mock' });

  const port = server.port();
  const open = (label: string) =>
    new Promise<{
      rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      states: Record<string, unknown>[];
      close: () => void;
    }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=concurrency-token-abcdefgh`);
      const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
      const states: Record<string, unknown>[] = [];
      let id = 1;
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg['t'] === 'state' || msg['t'] === 'hello') states.push(msg['state'] as Record<string, unknown>);
        if (msg['t'] === 'reply') {
          const w = waiting.get(Number(msg['id']));
          if (!w) return;
          waiting.delete(Number(msg['id']));
          if (msg['ok']) w.res(msg['result']);
          else w.rej(new Error(String(msg['error'])));
        }
      };
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', label }));
        resolve({
          states,
          rpc: (method, params = {}) =>
            new Promise((res, rej) => {
              const rid = id++;
              waiting.set(rid, { res, rej });
              ws.send(JSON.stringify({ t: 'rpc', id: rid, method, params }));
            }),
          close: () => ws.close(),
        });
      };
    });

  try {
    const a = await open('пк');
    const b = await open('телефон');
    await new Promise((r) => setTimeout(r, 120));

    await Promise.all([
      a.rpc('applySettings', { commands: ['M92 E731'] }),
      b.rpc('applySettings', { commands: ['M92 E732'] }),
    ]);
    await new Promise((r) => setTimeout(r, 200));

    const truth = printer.snapshot().settings['M92']?.['E'];
    assert.ok(truth === 731 || truth === 732, `one of the two writes must win, got ${String(truth)}`);

    const lastOf = (states: Record<string, unknown>[]) => {
      const settings = states.at(-1)?.['settings'] as Record<string, Record<string, number>> | undefined;
      return settings?.['M92']?.['E'];
    };
    assert.equal(lastOf(a.states), truth, 'client A must end up on the printer value, not its own');
    assert.equal(lastOf(b.states), truth, 'client B must end up on the printer value, not its own');

    a.close();
    b.close();
  } finally {
    await printer.disconnect();
    await server.close();
  }
});

/* R9: a long session is mostly repeated connect/disconnect. Anything that registers a timer or a
   listener per connect and forgets to clear it shows up here as unbounded growth. */
test('repeated connect and disconnect cycles do not accumulate timers or listeners', async () => {
  const printer = new Printer();
  const countListeners = () =>
    printer.eventNames().reduce((total, name) => total + printer.listenerCount(name), 0);

  await printer.connect({ kind: 'mock' });
  await printer.disconnect();
  const baselineListeners = countListeners();
  const baselineHandles = process.getActiveResourcesInfo().length;

  for (let i = 0; i < 6; i++) {
    await printer.connect({ kind: 'mock' });
    await printer.disconnect();
  }
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(
    countListeners(),
    baselineListeners,
    'each connect must not leave listeners behind on the Printer',
  );
  const grown = process.getActiveResourcesInfo().length - baselineHandles;
  assert.ok(grown <= 2, `active handles grew by ${grown} over 6 connect cycles`);
});

/* R2: the OS message for a busy port is accurate and useless. Each failure has a different fix,
   so each has to name it. */
test('serial open failures are translated into the actual fix', () => {
  const busy = explainOpenFailure('/dev/cu.usbserial-1420', 'Error: Resource busy, cannot open /dev/cu.usbserial-1420');
  assert.match(busy, /already open in another program/);
  assert.match(busy, /slicer|terminal|3DTune/);

  assert.match(
    explainOpenFailure('COM7', 'File not found'),
    /no such device/,
    'Windows phrases a missing device differently and must still be recognised',
  );
  assert.match(explainOpenFailure('/dev/ttyUSB0', 'Permission denied, cannot open /dev/ttyUSB0'), /permission denied/i);
  assert.match(explainOpenFailure('COM3', 'Access is denied.'), /already open in another program/);

  const unknown = explainOpenFailure('/dev/cu.x', 'something nobody has seen before');
  assert.match(unknown, /something nobody has seen before/, 'an unrecognised cause must not be swallowed');
  assert.ok(unknown.startsWith('cannot open /dev/cu.x:'), 'the port must always be named');
});

test('macOS tty paths are redirected to their cu twin', () => {
  const redirected = normalizePortPath('/dev/tty.usbserial-1420');
  if (process.platform === 'darwin') {
    assert.equal(redirected, '/dev/cu.usbserial-1420', 'opening tty.* asserts DTR and can reset the board');
  } else {
    assert.equal(redirected, '/dev/tty.usbserial-1420', 'the rewrite is macOS-specific');
  }
});

test('a nonexistent serial port fails with an actionable message and leaves no link', async () => {
  const printer = new Printer();
  await assert.rejects(
    () => printer.connect({ kind: 'serial', path: '/dev/definitely-not-a-printer-3dtune', baud: 115200 }),
    /no such device|cannot open/,
  );
  const snap = printer.snapshot();
  assert.notEqual(snap.connection.status, 'connected');
  assert.ok(snap.connection.error, 'the failure reason must reach the UI state');
});

/* U5: an icon-only control with no aria-label is the regression that keeps coming back, because it
   looks fine on screen. Checked statically so it fails in CI rather than under a screen reader. */
test('every button in the markup has an accessible name', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert.ok(buttons.length > 30, `expected the real markup, found ${buttons.length} buttons`);

  const nameless: string[] = [];
  for (const button of buttons) {
    if (/aria-label\s*=\s*"[^"]+"/.test(button)) continue;
    const inner = button.replace(/^<button\b[^>]*>/, '').replace(/<\/button>$/, '');
    // A span marked aria-hidden contributes nothing to the accessible name.
    const spoken = inner
      .replace(/<span[^>]*aria-hidden\s*=\s*"true"[^>]*>[\s\S]*?<\/span>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (spoken.length === 0) nameless.push(button.slice(0, 90));
  }
  assert.deepEqual(nameless, [], 'these buttons would be announced as an unlabelled button');
});

test('groups of bare-number buttons carry a group label that gives them meaning', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  // Rows whose buttons are only digits/signs are meaningless alone: 185, 0.1, −0.05.
  const groups = html.match(/<(?:div|span)\b[^>]*class="[^"]*(?:seg|row)[^"]*"[^>]*>[\s\S]*?<\/(?:div|span)>/g) ?? [];
  const offenders: string[] = [];
  for (const group of groups) {
    const labels = group.match(/<button\b[^>]*>([\s\S]*?)<\/button>/g) ?? [];
    if (labels.length < 2) continue;
    const allNumeric = labels.every((b) => {
      const text = b.replace(/<[^>]+>/g, '').trim();
      return /^[−+\-]?\d+(?:[.,]\d+)?$/.test(text);
    });
    if (allNumeric && !/aria-label\s*=\s*"[^"]+"/.test(group.split('>')[0] + '>')) {
      offenders.push(group.slice(0, 80));
    }
  }
  assert.deepEqual(offenders, [], 'a row of bare numbers needs role=group with an aria-label');
});
