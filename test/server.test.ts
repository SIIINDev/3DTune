import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Printer } from '../src/printer/printer.ts';
import { startServer } from '../src/server/server.ts';

const TOKEN = 'test-token-abcdefghijklmnop';
const printer = new Printer();
let server: { close: () => Promise<void>; port: () => number };
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
  await new Promise((r) => setTimeout(r, 250));
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

function connect(token = TOKEN, label = 'test'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
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

test('safety errors travel to the client with their code', async () => {
  const client = await connect();
  await client.hello;
  await assert.rejects(() => client.rpc('setHotend', { value: 400 }), /over_max/);
  await assert.rejects(() => client.rpc('babystep', { delta: 5 }), /bad_value/);
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
