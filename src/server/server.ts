import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Printer } from '../printer/printer.ts';
import { SafetyError } from '../printer/limits.ts';
import { listPorts } from '../transport/serial.ts';

export type ServerOptions = {
  printer: Printer;
  token: string;
  host: string;
  port: number;
  webRoot: string;
  mock: boolean;
  chaos: boolean;
};

type Client = { id: number; ws: WebSocket; label: string; ip: string; heatTokens: number };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const HEAT_BUCKET_MAX = 8;

function assetVersion(webRoot: string): string {
  let newest = 0;
  for (const entry of readdirSync(webRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    newest = Math.max(newest, statSync(join(webRoot, entry.name)).mtimeMs);
  }
  return Math.floor(newest).toString(36);
}

export function startServer(opts: ServerOptions): { close: () => Promise<void>; port: () => number } {
  const { printer, token, webRoot } = opts;
  const clients = new Map<number, Client>();
  let nextClientId = 1;

  const http = createServer((req, res) => handleHttp(req, res, webRoot, opts.mock, opts.chaos));
  const wss = new WebSocketServer({ noServer: true });

  setInterval(() => {
    for (const c of clients.values()) c.heatTokens = Math.min(HEAT_BUCKET_MAX, c.heatTokens + 1);
  }, 5_000).unref();

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'), token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });

  function onConnection(ws: WebSocket, req: IncomingMessage): void {
    const id = nextClientId++;
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    const client: Client = { id, ws, label: `device-${id}`, ip, heatTokens: HEAT_BUCKET_MAX };
    clients.set(id, client);

    send(ws, {
      t: 'hello',
      clientId: id,
      state: printer.snapshot(),
      tempHistory: printer.tempHistory,
      log: printer.log,
      env: { mock: opts.mock, chaos: opts.chaos },
      clients: clientList(),
    });
    broadcastClients();

    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      void handleMessage(client, msg);
    });

    ws.on('close', () => {
      clients.delete(id);
      broadcastClients();
    });
  }

  async function handleMessage(client: Client, msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;

    if (m['t'] === 'hello') {
      const label = String(m['label'] ?? '').slice(0, 32);
      if (label) client.label = label;
      broadcastClients();
      return;
    }

    if (m['t'] !== 'rpc') return;
    const id = m['id'];
    const method = String(m['method'] ?? '');
    const params = (m['params'] ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatch(client, method, params);
      if (method !== 'listPorts') printer.flushState();
      send(client.ws, { t: 'reply', id, ok: true, result });
    } catch (err) {
      const code = err instanceof SafetyError ? err.code : 'error';
      send(client.ws, {
        t: 'reply',
        id,
        ok: false,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function dispatch(client: Client, method: string, p: Record<string, unknown>): Promise<unknown> {
    const audit = (extra = '') => broadcast({ t: 'audit', client: client.label, ip: client.ip, method, extra });

    switch (method) {
      case 'listPorts':
        return listPorts();

      case 'connect': {
        audit();
        const kind = String(p['kind'] ?? (opts.mock ? 'mock' : 'serial'));
        if (kind === 'mock') {
          await printer.connect({ kind: 'mock', chaos: Boolean(p['chaos'] ?? opts.chaos) });
        } else {
          await printer.connect({
            kind: 'serial',
            path: String(p['path'] ?? ''),
            baud: Number(p['baud'] ?? 115200),
          });
        }
        return printer.snapshot();
      }

      case 'disconnect':
        audit();
        await printer.disconnect();
        return printer.snapshot();

      case 'gcode': {
        const cmd = String(p['command'] ?? '');
        audit(cmd);
        return printer.gcode(cmd);
      }

      case 'estop':
        audit();
        printer.estop();
        return { ok: true };

      case 'setHotend': {
        const value = Number(p['value']);
        spendHeatToken(client);
        audit(`${value}C`);
        await printer.setHotendTarget(value, Boolean(p['confirmed']));
        return { ok: true };
      }

      case 'setBed': {
        const value = Number(p['value']);
        spendHeatToken(client);
        audit(`${value}C`);
        await printer.setBedTarget(value);
        return { ok: true };
      }

      case 'setFan':
        await printer.setFan(Number(p['value']));
        return { ok: true };

      case 'jog':
        await printer.jog(
          String(p['axis'] ?? 'X').toUpperCase() as 'X' | 'Y' | 'Z' | 'E',
          Number(p['distance']),
          p['feedrate'] === undefined ? undefined : Number(p['feedrate']),
        );
        return { ok: true };

      case 'home':
        audit(String(p['axes'] ?? 'all'));
        await printer.home(String(p['axes'] ?? ''));
        return { ok: true };

      case 'motorsOff':
        await printer.motorsOff();
        return { ok: true };

      case 'readSettings':
        await printer.refreshSettings();
        return printer.snapshot().settings;

      case 'applySettings': {
        const commands = (Array.isArray(p['commands']) ? p['commands'] : []).map(String);
        audit(commands.join(' | '));
        return printer.applySettings(commands);
      }

      case 'save':
        audit();
        spendHeatToken(client);
        return printer.saveToEeprom();

      case 'readEndstops':
        await printer.readEndstops();
        return { ok: true };

      case 'babystep': {
        const delta = Number(p['delta']);
        audit(`Z${delta > 0 ? '+' : ''}${delta}`);
        await printer.babystepZ(delta);
        return { ok: true };
      }

      case 'probeOffset': {
        const offset: { x?: number; y?: number; z?: number } = {};
        if (p['x'] !== undefined) offset.x = Number(p['x']);
        if (p['y'] !== undefined) offset.y = Number(p['y']);
        if (p['z'] !== undefined) offset.z = Number(p['z']);
        audit(JSON.stringify(offset));
        return printer.setProbeOffset(offset);
      }

      case 'pidAutotune': {
        const target = String(p['target'] ?? 'hotend') === 'bed' ? 'bed' : 'hotend';
        const temp = Number(p['temp'] ?? 200);
        audit(`${target} ${temp}C`);
        spendHeatToken(client);
        return printer.pidAutotune({
          target,
          temp,
          cycles: Number(p['cycles'] ?? 8),
          apply: Boolean(p['apply']),
        });
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  function spendHeatToken(client: Client): void {
    if (client.heatTokens <= 0) {
      throw new SafetyError('rate_limited', 'too many heater/EEPROM commands — slow down');
    }
    client.heatTokens--;
  }

  function clientList(): { id: number; label: string; ip: string }[] {
    return [...clients.values()].map((c) => ({ id: c.id, label: c.label, ip: c.ip }));
  }

  function broadcastClients(): void {
    broadcast({ t: 'clients', clients: clientList() });
  }

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const c of clients.values()) {
      if (c.ws.readyState === 1) c.ws.send(data);
    }
  }

  printer.on('state', (state) => broadcast({ t: 'state', state }));
  printer.on('temp', (sample) => broadcast({ t: 'temp', sample }));
  printer.on('log', (entry) => broadcast({ t: 'log', entry }));
  printer.on('event', (event) => broadcast({ t: 'event', event }));

  http.listen(opts.port, opts.host);

  return {
    port: () => {
      const addr = http.address();
      return addr !== null && typeof addr === 'object' ? addr.port : opts.port;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients.values()) c.ws.close();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

function tokenOk(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
  mock: boolean,
  chaos: boolean,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ name: '3DTune', version: '0.1.0', mock, chaos, needsToken: true }));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = join(webRoot, normalize(rel));
  if (!target.startsWith(webRoot) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  if (rel === 'index.html') {
    const html = readFileSync(target, 'utf8').replaceAll('__V__', assetVersion(webRoot));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  createReadStream(target).pipe(res);
}
