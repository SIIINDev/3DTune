import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Printer } from '../src/printer/printer.ts';
import { startServer, type ServerHandle } from '../src/server/server.ts';

const TOKEN = 'test-token-abcdefghijklmnop';
const printer = new Printer();
let server: ServerHandle;
let port = 0;

before(async () => {
  server = startServer({
    printer,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
    webRoot: join(import.meta.dirname, '..', 'web'),
    mock: true,
    chaos: false,
  });
  await server.ready;
  port = server.port();
  await printer.connect({ kind: 'mock' });
});

after(async () => {
  await printer.disconnect();
  await server.close();
});

type Client = {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  hello: Promise<Record<string, unknown>>;
  close: () => void;
};

function connect(token = TOKEN, label = 'test', targetPort = port): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws?token=${encodeURIComponent(token)}`);
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let resolveHello: (v: Record<string, unknown>) => void = () => {};
    const hello = new Promise<Record<string, unknown>>((r) => {
      resolveHello = r;
    });

    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = (ev) => {
      for (const [, w] of waiting) w.reject(new Error('closed'));
      waiting.clear();
      reject(new Error(`closed:${ev.code}`));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg['t'] === 'hello') resolveHello(msg);
      if (msg['t'] === 'reply') {
        const w = waiting.get(Number(msg['id']));
        if (!w) return;
        waiting.delete(Number(msg['id']));
        if (msg['ok']) w.resolve(msg['result']);
        else w.reject(new Error(`${String(msg['code'])}: ${String(msg['error'])}`));
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', label }));
      resolve({
        hello,
        rpc: (method, params = {}) =>
          new Promise((res, rej) => {
            const id = nextId++;
            waiting.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ t: 'rpc', id, method, params }));
          }),
        close: () => ws.close(),
      });
    };
  });
}

test('static assets are served with cache-busting and no-store', async () => {
  const html = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('cache-control') ?? '', /no-store/);
  const body = await html.text();
  assert.match(body, /style\.css\?v=[a-z0-9]+/, 'asset links must carry a version');
  assert.doesNotMatch(body, /__V__/, 'the version placeholder must be substituted');
});

test('a second server reports an occupied port without crashing', async () => {
  const duplicate = startServer({
    printer,
    token: TOKEN,
    host: '127.0.0.1',
    port,
    webRoot: join(import.meta.dirname, '..', 'web'),
    mock: true,
    chaos: false,
  });
  await assert.rejects(() => duplicate.ready, /already in use/);
  await duplicate.close();
});

test('path traversal outside the web root is refused', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/../package.json`);
  assert.notEqual(res.status, 200);
});

test('the public info endpoint leaks no token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/info`);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['needsToken'], true);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
});

test('websocket without a token is rejected', async () => {
  await assert.rejects(() => connect(''), /closed|ws error/);
});

test('websocket with a wrong token is rejected', async () => {
  await assert.rejects(() => connect('not-the-token-aaaaaaaaaaaa'), /closed|ws error/);
});

test('a valid token gets state, history and the client roster', async () => {
  const client = await connect(TOKEN, 'мак');
  const hello = await client.hello;
  const state = hello['state'] as Record<string, unknown>;
  assert.ok(state, 'hello must carry a state snapshot');
  assert.ok(Array.isArray(hello['log']));
  assert.ok(Array.isArray(hello['clients']));
  client.close();
});

test('unknown rpc methods are rejected', async () => {
  const client = await connect();
  await client.hello;
  await assert.rejects(() => client.rpc('definitelyNotAMethod'), /unknown method/);
  client.close();
});

test('malformed RPC shape is rejected without destabilising the server', async () => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(TOKEN)}`);
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'rpc', id: 99, method: 42, params: [] }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (msg['t'] !== 'reply' || msg['id'] !== 99) return;
      assert.equal(msg['ok'], false);
      assert.equal(msg['code'], 'invalid_request');
      ws.close();
      resolve();
    };
  });
});

test('oversized WebSocket messages are closed with 1009', async () => {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(TOKEN)}`);
    ws.onerror = () => undefined;
    ws.onopen = () => ws.send('x'.repeat(65 * 1024));
    ws.onclose = (event) => {
      try {
        assert.equal(event.code, 1009);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
  });
});

test('safety errors travel to the client with their code', async () => {
  const client = await connect();
  await client.hello;
  await assert.rejects(() => client.rpc('setHotend', { value: 400 }), /over_max/);
  await assert.rejects(() => client.rpc('babystep', { delta: 5 }), /bad_value/);
  await assert.rejects(() => client.rpc('gcode', { command: 'M104 S250' }), /unsafe_gcode/);
  client.close();
});

test('E-steps calibration is validated and applied through RPC', async () => {
  const client = await connect();
  await client.hello;
  await assert.rejects(
    () => client.rpc('calibrateESteps', { requested: 100, measured: 10 }),
    /implausible_measurement/,
  );
  const result = (await client.rpc('calibrateESteps', {
    requested: 100,
    measured: 96,
  })) as { next: number };
  assert.equal(result.next, 800);
  assert.equal(printer.snapshot().settings['M92']?.['E'], 800);
  client.close();
});

test('M500 RPC reloads and verifies settings stored in the printer', async () => {
  const client = await connect();
  await client.hello;
  const result = (await client.rpc('save')) as { verified: boolean; mismatches: string[] };
  assert.equal(result.verified, true, result.mismatches.join('; '));
  assert.deepEqual(result.mismatches, []);
  assert.equal(printer.snapshot().persistence.dirty, false);
  assert.equal(printer.snapshot().persistence.verified, true);
  client.close();
});

test('heater commands are rate limited per client', async () => {
  const client = await connect();
  await client.hello;
  let rejected = 0;
  for (let i = 0; i < 12; i++) {
    try {
      await client.rpc('setHotend', { value: 0 });
    } catch (err) {
      if (/rate_limited/.test(String(err))) rejected++;
    }
  }
  assert.ok(rejected > 0, 'a burst of heater commands must hit the limiter');
  client.close();
});

test('a second client sees the same state and appears in the roster', async () => {
  const a = await connect(TOKEN, 'пк');
  await a.hello;
  const b = await connect(TOKEN, 'телефон');
  const helloB = await b.hello;
  const roster = helloB['clients'] as { label: string }[];
  assert.ok(roster.length >= 2, JSON.stringify(roster));
  assert.ok(roster.some((c) => c.label === 'пк'));
  a.close();
  b.close();
});

test('dead-man timer cools a confirmed-idle printer after the last client leaves', async () => {
  const guardedPrinter = new Printer();
  const safetyEvents: string[] = [];
  const guardedServer = startServer({
    printer: guardedPrinter,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
    webRoot: join(import.meta.dirname, '..', 'web'),
    mock: true,
    chaos: false,
    deadmanMs: 50,
    onSafetyEvent: (message) => safetyEvents.push(message),
  });
  await guardedServer.ready;
  await guardedPrinter.connect({ kind: 'mock', sdPrintStatus: 'idle' });

  try {
    const client = await connect(TOKEN, 'deadman-test', guardedServer.port());
    await client.hello;
    await guardedPrinter.setHotendTarget(200);
    client.close();

    const deadline = Date.now() + 1_500;
    while (guardedPrinter.snapshot().temps.hotend.target !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(guardedPrinter.snapshot().temps.hotend.target, 0);
    assert.ok(safetyEvents.some((message) => /turned off/.test(message)), safetyEvents.join('; '));
  } finally {
    await guardedPrinter.disconnect();
    await guardedServer.close();
  }
});

/* Pairing hands out the access token to an unauthenticated caller, so its limits are the security
   boundary: six digits alone would fall to a script in seconds. */
async function pair(port: number, code: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('a pairing code is six digits and reported as open without being leaked', async () => {
  const client = await connect();
  await client.hello;
  const created = (await client.rpc('createPairingCode')) as { code: string; expiresInSec: number; urls: unknown[] };
  assert.match(created.code, /^\d{6}$/);
  assert.ok(created.expiresInSec > 0 && created.expiresInSec <= 600);
  assert.ok(Array.isArray(created.urls));

  const info = (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()) as Record<string, unknown>;
  assert.equal(info['pairingOpen'], true, 'the UI needs to know a code is live');
  assert.doesNotMatch(JSON.stringify(info), new RegExp(created.code), 'the code itself must never be served');
  client.close();
});

test('a correct code yields the token exactly once', async () => {
  const client = await connect();
  await client.hello;
  const { code } = (await client.rpc('createPairingCode')) as { code: string };

  const first = await pair(port, code);
  assert.equal(first.status, 200);
  assert.equal(first.body['token'], TOKEN, 'pairing must hand over the real access token');

  const second = await pair(port, code);
  assert.equal(second.status, 403, 'a used code must not work twice');
  client.close();
});

test('malformed codes are rejected before any attempt is spent', async () => {
  const client = await connect();
  await client.hello;
  await client.rpc('createPairingCode');
  for (const bad of ['12345', '1234567', 'abcdef', '', '12 34 56']) {
    const res = await pair(port, bad);
    assert.equal(res.status, 400, `"${bad}" must be rejected as malformed`);
  }
  // The real code still works, proving the malformed ones did not burn attempts.
  const { code } = (await client.rpc('createPairingCode')) as { code: string };
  assert.equal((await pair(port, code)).status, 200);
  client.close();
});

test('wrong codes burn attempts and then cancel the code entirely', async () => {
  const client = await connect();
  await client.hello;
  const { code } = (await client.rpc('createPairingCode')) as { code: string };
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  const reasons: string[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await pair(port, wrong);
    assert.equal(res.status, 403);
    reasons.push(String(res.body['error']));
  }
  assert.ok(
    reasons.some((r) => /отменён/.test(r)),
    `the code must be cancelled after repeated failures, saw: ${reasons.join(' | ')}`,
  );
  // Even the right code is dead now — the window closed rather than staying open to guessing.
  assert.equal((await pair(port, code)).status, 403);
  client.close();
});

test('pairing is refused when no code has been issued', async () => {
  const res = await pair(port, '000000');
  assert.equal(res.status, 403);
  assert.match(String(res.body['error']), /код не запрошен|неверный код|слишком много/);
});

test('the start G-code analyzer answers over RPC and refuses a whole sliced file', async () => {
  const client = await connect();
  await client.hello;

  const result = (await client.rpc('analyzeStartGcode', {
    text: 'M140 S80\nM190 S80\nG28\nM109 S240\nM500',
    presetId: 'pla',
  })) as { findings: { code: string; severity: string }[]; material: { id: string } | null };
  assert.equal(result.material?.id, 'petg');
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes('material_mismatch'));
  assert.ok(codes.includes('writes_eeprom'));

  /* Between the analyzer's cap and the socket's 64 KB maxPayload: the server must answer with an
     explanation rather than the frame being dropped. Bigger than that and the client-side check
     in web/app.js is what stops it, before anything is sent. */
  const oversized = 'G1 X1 Y1\n'.repeat(4_600);
  assert.ok(oversized.length > 32 * 1024 && oversized.length < 60 * 1024);
  await assert.rejects(client.rpc('analyzeStartGcode', { text: oversized }), /too_long/);
  client.close();
});
