import { EventEmitter } from 'node:events';
import { MarlinSim, type SimOptions } from '../sim/marlin-sim.ts';
import type { Transport } from './types.ts';

export class MockTransport extends EventEmitter implements Transport {
  readonly label = 'mock://marlin-sim';
  private sim: MarlinSim;
  private open_ = false;

  constructor(options: SimOptions = {}) {
    super();
    this.sim = new MarlinSim(options);
    this.sim.on('out', (line: string) => {
      if (this.open_) this.emit('data', `${line}\n`);
    });
  }

  open(): Promise<void> {
    this.open_ = true;
    this.sim.start();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.open_ = false;
    this.sim.stop();
    this.emit('close');
    return Promise.resolve();
  }

  write(data: string): void {
    if (!this.open_) throw new Error('mock transport is not open');
    this.sim.write(data);
  }
}
