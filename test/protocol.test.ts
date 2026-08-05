import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Link } from '../src/protocol/link.ts';
import { marlinChecksum } from '../src/protocol/checksum.ts';
import { parseLine } from '../src/protocol/parse.ts';
import { MarlinSim, type SimOptions } from '../src/sim/marlin-sim.ts';
import type { Transport } from '../src/transport/types.ts';
import { waitFor } from './support.ts';

class SimTransport extends EventEmitter implements Transport {
  readonly label = 'test://sim';
  private sim: MarlinSim;
  private corruptAt: Set<number>;
  private framedWrites = 0;

  constructor(corruptAt: number[] = [], options: SimOptions = {}) {
    super();
    this.corruptAt = new Set(corruptAt);
    this.sim = new MarlinSim(options);
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
    let payload = data;
    if (/\*\d+/.test(data)) {
      this.framedWrites++;
      if (this.corruptAt.has(this.framedWrites)) {
        payload = data.replace(/\*(\d+)/, (_m, cs: string) => `*${Number(cs) ^ 1}`);
      }
    }
    this.sim.write(payload);
  }
}

async function withLink(
  fn: (link: Link, events: { resends: number[]; lines: string[] }) => Promise<void>,
  corruptAt: number[] = [],
  options: SimOptions = {},
): Promise<void> {
  const transport = new SimTransport(corruptAt, options);
  await transport.open();
  const link = new Link(transport, { inactivityMs: 30_000 });
  const events = { resends: [] as number[], lines: [] as string[] };
  link.on('resend', (n: number) => events.resends.push(n));
  link.on('line', (l: string) => events.lines.push(l));
  await new Promise((r) => setTimeout(r, 250));
  try {
    await link.resync();
    await fn(link, events);
  } finally {
    link.close();
    await transport.close();
  }
}

test('checksum matches Marlin reference', () => {
  assert.equal(marlinChecksum('N1 M115'), 'N1 M115'.split('').reduce((a, c) => a ^ c.charCodeAt(0), 0));
  assert.equal(marlinChecksum(''), 0);
});

test('parses ok with buffer fields', () => {
  const p = parseLine('ok N42 P14 B3');
  assert.equal(p.kind, 'ok');
  assert.deepEqual(p, { kind: 'ok', lineNo: 42, plannerFree: 14, bufferFree: 3 });
});

test('parses ok carrying a temperature report', () => {
  const p = parseLine('ok T:198.42 /200.00 B:59.81 /60.00 @:96 B@:31');
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok' || !p.temps) throw new Error('expected temps');
  assert.equal(p.temps.hotend?.current, 198.42);
  assert.equal(p.temps.hotend?.target, 200);
  assert.equal(p.temps.hotend?.power, 96);
  assert.equal(p.temps.bed?.current, 59.81);
  assert.equal(p.temps.bed?.power, 31);
});

test('parses standalone auto-report temperature line', () => {
  const p = parseLine('T:21.37 /0.00 B:22.04 /0.00 @:0 B@:0');
  assert.equal(p.kind, 'temp');
});

test('parses multiple hotends and chamber temperature independently', () => {
  const p = parseLine('T0:201.5 /210 T1:184.2 /190 B:59.8 /60 C:35.4 /0 @0:90 @1:45 B@:30 C@:0');
  assert.equal(p.kind, 'temp');
  if (p.kind !== 'temp') throw new Error('expected temp report');
  assert.equal(p.temps.hotends.length, 2);
  assert.equal(p.temps.hotends[0]?.current, 201.5);
  assert.equal(p.temps.hotends[0]?.power, 90);
  assert.equal(p.temps.hotends[1]?.target, 190);
  assert.equal(p.temps.hotends[1]?.power, 45);
  assert.equal(p.temps.chamber?.current, 35.4);
});

test('parser survives deterministic fuzz input without throwing or returning an invalid kind', () => {
  const kinds = new Set([
    'ok', 'resend', 'busy', 'error', 'temp', 'position', 'endstops', 'cap', 'firmware', 'start', 'action', 'echo', 'other',
  ]);
  let seed = 0x3d7a11;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 5_000; sample++) {
    const length = next() % 240;
    let line = '';
    for (let i = 0; i < length; i++) line += String.fromCharCode(next() % 128);
    const parsed = parseLine(line);
    assert.ok(kinds.has(parsed.kind), `invalid kind for fuzz sample ${sample}`);
  }
});

test('parses resend, busy, fatal and resend-triggering errors', () => {
  assert.deepEqual(parseLine('Resend: 17'), { kind: 'resend', lineNo: 17 });
  assert.deepEqual(parseLine('rs 17'), { kind: 'resend', lineNo: 17 });
  assert.deepEqual(parseLine('echo:busy: processing'), { kind: 'busy', reason: 'processing' });

  const fatal = parseLine('Error:Printer halted. kill() called!');
  assert.equal(fatal.kind, 'error');
  if (fatal.kind !== 'error') throw new Error('expected error');
  assert.equal(fatal.fatal, true);

  const cksum = parseLine('Error:checksum mismatch, Last Line: 5');
  if (cksum.kind !== 'error') throw new Error('expected error');
  assert.equal(cksum.fatal, false);
  assert.equal(cksum.expectsResend, true);
});

test('parses position, endstop and capability lines', () => {
  const pos = parseLine('X:12.50 Y:-3.00 Z:0.20 E:4.10 Count X:2000 Y:-480 Z:160');
  assert.deepEqual(pos, { kind: 'position', x: 12.5, y: -3, z: 0.2, e: 4.1 });
  assert.deepEqual(parseLine('z_probe: TRIGGERED'), { kind: 'endstops', states: { z_probe: 'triggered' } });
  assert.deepEqual(parseLine('Cap:EMERGENCY_PARSER:0'), {
    kind: 'cap',
    name: 'EMERGENCY_PARSER',
    enabled: false,
  });
});

test('handshake against simulator reports firmware, caps and settings', async () => {
  await withLink(async (link) => {
    const caps: Record<string, boolean> = {};
    let firmware: string | null = null;
    link.on('cap', (name: string, on: boolean) => {
      caps[name] = on;
    });
    link.on('firmware', (f: Record<string, string>) => {
      firmware = f['FIRMWARE_NAME'] ?? null;
    });

    const m115 = await link.send('M115');
    assert.equal(m115.ok, true);
    assert.match(String(firmware), /Marlin/);
    assert.equal(caps['EEPROM'], true);
    assert.equal(caps['EMERGENCY_PARSER'], false);

    const m503 = await link.send('M503');
    assert.equal(m503.ok, true);
    assert.ok(m503.lines.some((l) => /M92 X160/.test(l)), 'M503 should include M92');
    assert.ok(m503.lines.some((l) => /M851 X27/.test(l)), 'M503 should include M851');
  });
});

test('recovers from a corrupted line via Resend and still returns the reply', async () => {
  await withLink(
    async (link, events) => {
      let firmware: string | null = null;
      link.on('firmware', (f: Record<string, string>) => {
        firmware = f['FIRMWARE_NAME'] ?? null;
      });

      const res = await link.send('M115');
      assert.equal(res.ok, true, 'command must still succeed after a resend');
      assert.ok(events.resends.length >= 1, 'a Resend must have been observed');
      assert.match(String(firmware), /Marlin/, 'reply data must survive the resend');
      assert.ok(
        events.lines.some((l) => /checksum mismatch/i.test(l)),
        'simulator must have reported a checksum mismatch',
      );
    },
    [1],
  );
});

test('sequential commands stay in order and all complete under repeated corruption', async () => {
  await withLink(
    async (link) => {
      const results = [];
      for (let i = 0; i < 30; i++) results.push(await link.send('M105'));
      assert.equal(results.filter((r) => r.ok).length, 30);
    },
    [2, 5, 9, 14, 20, 27],
  );
});

test('M112 halts the link and rejects further commands', async () => {
  await withLink(async (link) => {
    let halted = '';
    link.on('halted', (text: string) => {
      halted = text;
    });
    await link.send('M115');
    link.sendRaw('M112');
    // Without EMERGENCY_PARSER the simulator delays the kill, so wait for the event, not a duration.
    await waitFor(() => halted !== '', 'the printer to report that it halted');
    assert.match(halted, /halted/i);
    assert.equal(link.isHalted, true);
    await assert.rejects(() => link.send('M105'), /halted/i);
  });
});

test('busy keepalive does not time out a long command', async () => {
  await withLink(async (link) => {
    const busySeen: (string | null)[] = [];
    link.on('busy', (reason: string | null) => busySeen.push(reason));
    const res = await link.send('G28', { timeoutMs: 12_000 });
    assert.equal(res.ok, true);
    assert.ok(busySeen.includes('processing'), 'should have seen a busy keepalive');
  });
});

test('unknown command surfaces as a non-fatal error result', async () => {
  await withLink(async (link) => {
    const res = await link.send('M9999');
    assert.equal(res.ok, true);
    assert.ok(res.lines.some((l) => /Unknown command/i.test(l)));
  });
});
