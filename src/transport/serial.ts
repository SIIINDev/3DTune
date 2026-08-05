import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import type { PortInfo, Transport } from './types.ts';

const PRINTER_VIDS = new Set(['1a86', '0483', '2341', '10c4', '0403', '1d50', '303a']);

export async function listPorts(): Promise<PortInfo[]> {
  const raw = await SerialPort.list();
  return raw
    .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
    .map((p) => {
      const vid = p.vendorId?.toLowerCase();
      const looksLikeBridge = /wch|usbserial|usbmodem|ch340|ch910|cp210|ftdi|silicon labs/i.test(
        `${p.path} ${p.manufacturer ?? ''}`,
      );
      const info: PortInfo = {
        path: p.path,
        likelyPrinter: (vid !== undefined && PRINTER_VIDS.has(vid)) || looksLikeBridge,
      };
      if (p.manufacturer) info.manufacturer = p.manufacturer;
      if (p.serialNumber) info.serialNumber = p.serialNumber;
      if (p.vendorId) info.vendorId = p.vendorId;
      if (p.productId) info.productId = p.productId;
      if (process.platform === 'darwin' && p.path.startsWith('/dev/tty.')) {
        info.note = 'prefer the /dev/cu.* twin — opening /dev/tty.* asserts DTR and can reset the board';
      }
      return info;
    })
    .sort((a, b) => Number(b.likelyPrinter) - Number(a.likelyPrinter) || a.path.localeCompare(b.path));
}

export function normalizePortPath(path: string): string {
  if (process.platform === 'darwin' && path.startsWith('/dev/tty.')) {
    return path.replace('/dev/tty.', '/dev/cu.');
  }
  return path;
}

/* serialport surfaces the OS error nearly verbatim, which is accurate but not actionable. Each of
   these has a different fix, and getting it wrong wastes the user's time on the wrong theory. */
export function explainOpenFailure(path: string, raw: string): string {
  const text = raw.toLowerCase();
  const hint = (advice: string) => `cannot open ${path}: ${advice}`;

  if (text.includes('resource busy') || text.includes('ebusy') || text.includes('access is denied')) {
    return hint(
      'the port is already open in another program. Close the slicer, a serial terminal ' +
        '(screen/PuTTY), or another 3DTune instance, then try again',
    );
  }
  if (
    text.includes('no such file') ||
    text.includes('enoent') ||
    text.includes('cannot find') ||
    text.includes('not found') ||
    text.includes('no such device')
  ) {
    return hint(
      'no such device. Check the USB cable and the printer power, then re-run with --list-ports ' +
        'to see the current port name',
    );
  }
  if (text.includes('permission denied') || text.includes('eacces')) {
    return hint(
      process.platform === 'linux'
        ? 'permission denied. Add your user to the dialout group (sudo usermod -aG dialout $USER) and log back in'
        : 'permission denied. Grant the terminal access to the device, or check that no other user session holds it',
    );
  }
  if (text.includes('unknown error code') || text.includes('setting custom baud')) {
    return hint(`the driver rejected baud rate settings. Try --baud 115200, the KP5L default`);
  }
  return hint(raw);
}

export class SerialTransport extends EventEmitter implements Transport {
  readonly label: string;
  private path: string;
  private baud: number;
  private port: SerialPort | null = null;

  constructor(path: string, baud: number) {
    super();
    this.path = normalizePortPath(path);
    this.baud = baud;
    this.label = `${this.path} @ ${baud}`;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        { path: this.path, baudRate: this.baud, autoOpen: false },
      );
      port.on('data', (buf: Buffer) => this.emit('data', buf.toString('latin1')));
      port.on('error', (err: Error) => this.emit('error', err));
      port.on('close', () => this.emit('close'));
      port.open((err) => {
        if (err) {
          reject(new Error(explainOpenFailure(this.path, err.message)));
          return;
        }
        this.port = port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const port = this.port;
      this.port = null;
      if (!port || !port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
  }

  write(data: string): void {
    if (!this.port?.isOpen) throw new Error('serial port is not open');
    this.port.write(data, 'latin1');
  }
}
