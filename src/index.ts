import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, deadmanMs, loadConfig, rotateToken, saveConfig } from './config.ts';
import { Printer } from './printer/printer.ts';
import { startServer } from './server/server.ts';
import { listPorts } from './transport/serial.ts';
import { formatDoctor, runDoctor } from './doctor.ts';

type Args = {
  mock: boolean;
  chaos: boolean;
  host: string;
  port: number;
  serialPath?: string;
  baud: number;
  autoconnect: boolean;
  listPorts: boolean;
  help: boolean;
  rotateToken: boolean;
  doctor: boolean;
  open: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mock: false,
    chaos: false,
    host: '127.0.0.1',
    port: 0,
    baud: 115200,
    autoconnect: false,
    listPorts: false,
    help: false,
    rotateToken: false,
    doctor: false,
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mock':
        args.mock = true;
        args.autoconnect = true;
        break;
      case '--chaos':
        args.chaos = true;
        break;
      case '--host':
        args.host = next() ?? '127.0.0.1';
        break;
      case '--port':
        args.port = Number(next() ?? 0);
        break;
      case '--serial':
        args.serialPath = next();
        args.autoconnect = true;
        break;
      case '--baud':
        args.baud = Number(next() ?? 115200);
        break;
      case '--list-ports':
        args.listPorts = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--rotate-token':
        args.rotateToken = true;
        break;
      case '--doctor':
        args.doctor = true;
        break;
      case '--open':
        args.open = true;
        break;
    }
  }
  return args;
}

function usage(): void {
  process.stdout.write(`3DTune host

  node bin/3dtune.mjs [options]

  --mock              run against the built-in Marlin simulator (no printer needed)
  --chaos             simulator injects line noise to exercise the Resend path
  --serial <path>     connect to a serial port on startup (e.g. /dev/cu.usbserial-1420, COM3)
  --baud <n>          serial baud rate (default 115200)
  --host <addr>       bind address (default 127.0.0.1; use 0.0.0.0 to expose on the LAN)
  --port <n>          http port (default 8420, persisted in config)
  --list-ports        print detected serial ports and exit
  --doctor            check everything a first run needs, then exit
  --open              open the browser at the local URL once the server is up
  --rotate-token      generate a new access token and invalidate existing browser sessions
  --help              this text
`);
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  if (args.doctor) {
    const configured = (() => {
      try {
        return loadConfig().port;
      } catch {
        return 8420;
      }
    })();
    const checks = await runDoctor(args.port > 0 ? args.port : configured);
    process.stdout.write(formatDoctor(checks));
    process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0;
    return;
  }

  if (args.listPorts) {
    const ports = await listPorts();
    if (ports.length === 0) {
      process.stdout.write('no serial ports found\n');
    }
    for (const p of ports) {
      process.stdout.write(
        `${p.likelyPrinter ? '*' : ' '} ${p.path}` +
          `${p.manufacturer ? `  (${p.manufacturer})` : ''}` +
          `${p.note ? `\n    note: ${p.note}` : ''}\n`,
      );
    }
    return;
  }

  let config = loadConfig();
  if (args.rotateToken) {
    config = rotateToken(config);
    process.stdout.write('access token rotated; old browser links are now invalid\n');
  }
  if (args.port > 0 && args.port !== config.port) {
    config.port = args.port;
    saveConfig(config);
  }

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const printer = new Printer({ ...config.limits, bedScrews: config.bedScrews });

  const server = startServer({
    printer,
    token: config.token,
    host: args.host,
    port: config.port,
    webRoot,
    mock: args.mock,
    chaos: args.chaos,
    deadmanMs: deadmanMs(config),
    onSafetyEvent: (message) => process.stderr.write(`${message}\n`),
  });
  try {
    await server.ready;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    await server.close();
    process.exitCode = 1;
    return;
  }

  const localUrl = `http://127.0.0.1:${config.port}/#t=${config.token}`;
  process.stdout.write(`\n3DTune host listening on ${args.host}:${config.port}\n`);
  process.stdout.write(`  local:  ${localUrl}\n`);

  if (args.host === '0.0.0.0') {
    for (const addr of lanAddresses()) {
      process.stdout.write(`  LAN:    http://${addr}:${config.port}/#t=${config.token}\n`);
    }
    process.stdout.write(
      '\n  ! Exposed on the local network. Heater control is reachable by anyone holding the token.\n' +
        '  ! Do NOT port-forward this to the internet. Use a VPN if you need remote access.\n' +
        '  ! The token travels over plain HTTP inside your LAN.\n',
    );
  } else {
    process.stdout.write('  (loopback only — pass --host 0.0.0.0 to reach it from other devices)\n');
  }
  const effectiveDeadman = deadmanMs(config) ?? 30 * 60_000;
  process.stdout.write(
    effectiveDeadman > 0
      // Rounding a sub-minute timer to "1 min" understates how soon the heaters get turned off.
      ? `  idle policy: after ${
          effectiveDeadman < 60_000
            ? `${Math.round(effectiveDeadman / 1000)} s`
            : `${Math.round(effectiveDeadman / 60_000)} min`
        } with no client, M27 decides whether to cool\n`
      : '  idle policy: dead-man timer disabled by config — heaters are never turned off automatically\n',
  );
  process.stdout.write(`  token stored in ${CONFIG_PATH}\n\n`);

  if (args.open) {
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', localUrl]] : process.platform === 'darwin' ? ['open', [localUrl]] : ['xdg-open', [localUrl]];
    try {
      const { spawn } = await import('node:child_process');
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      process.stdout.write('  (не удалось открыть браузер автоматически — открой ссылку выше вручную)\n');
    }
  }

  if (args.autoconnect) {
    try {
      if (args.mock) {
        await printer.connect({ kind: 'mock', chaos: args.chaos });
        process.stdout.write('connected to built-in Marlin simulator\n');
      } else if (args.serialPath) {
        await printer.connect({ kind: 'serial', path: args.serialPath, baud: args.baud });
        process.stdout.write(`connected to ${args.serialPath} @ ${args.baud}\n`);
      }
      const snap = printer.snapshot();
      process.stdout.write(`  firmware: ${snap.connection.firmware ?? 'unknown'}\n`);
      process.stdout.write(`  machine:  ${snap.connection.machine ?? 'unknown'}\n`);
      for (const w of snap.warnings) process.stdout.write(`  warning:  ${w}\n`);
      process.stdout.write(
        `  limits:   hotend <= ${snap.limits.hotendMax}C, bed <= ${snap.limits.bedMax}C ` +
          '(host-side assumption — see docs/PHASE0_DISCOVERY.md)\n',
      );
      process.stdout.write('\n');
    } catch (err) {
      process.stderr.write(`connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\nshutting down\n');
    const decision = await printer.coolIfIdle('server shutdown').catch((err) => {
      process.stderr.write(
        `WARNING: could not verify/cool heaters before shutdown: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    });
    if (decision?.action === 'cooled') {
      process.stdout.write('idle printer confirmed; heaters turned off\n');
    } else if (decision?.action === 'left_on') {
      process.stderr.write(
        `WARNING: heaters left on; SD print status is ${decision.sdPrintStatus}. Check the printer manually.\n`,
      );
    }
    await printer.disconnect().catch(() => undefined);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

await main();
