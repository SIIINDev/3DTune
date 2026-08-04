import type { EventEmitter } from 'node:events';

export type PortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  likelyPrinter: boolean;
  note?: string;
};

export interface Transport extends EventEmitter {
  readonly label: string;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: string): void;
}
