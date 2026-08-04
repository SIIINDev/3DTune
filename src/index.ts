import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, loadConfig, saveConfig } from './config.ts';
import { Printer } from './printer/printer.ts';
import { startServer } from './server/server.ts';
import { listPorts } from './transport/serial.ts';

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
    }
  }
  return args;
}

function usage(): void {
  process.stdout.write(`3DTune host

  node src/index.ts [options]

  --mock              run against the built-in Marlin simulator (no printer needed)
  --chaos             simulator injects line noise to exercise the Resend path
  --serial <path>     connect to a serial port on startup (e.g. /dev/cu.usbserial-1420, COM3)
  --baud <n>          serial baud rate (default 115200)
  --host <addr>       bind address (default 127.0.0.1; use 0.0.0.0 to expose on the LAN)
  --port <n>          http port (default 8420, persisted in config)
  --list-ports        print detected serial ports and exit
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

  const config = loadConfig();
  if (args.port > 0 && args.port !== config.port) {
    config.port = args.port;
    saveConfig(config);
  }

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const printer = new Printer(config.limits);

  const server = startServer({
    printer,
    token: config.token,
    host: args.host,
    port: config.port,
    webRoot,
    mock: args.mock,
    chaos: args.chaos,
  });

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
  process.stdout.write(`  token stored in ${CONFIG_PATH}\n\n`);

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

  const shutdown = async () => {
    process.stdout.write('\nshutting down\n');
    await printer.disconnect().catch(() => undefined);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

await main();
