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
          reject(new Error(`cannot open ${this.path}: ${err.message}`));
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
