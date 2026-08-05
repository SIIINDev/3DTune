import { EventEmitter } from 'node:events';
import { MarlinSim, type SimOptions } from '../sim/marlin-sim.ts';
import type { Transport } from './types.ts';

export type MockOptions = SimOptions & {
  /* Mangle the leading N of the first N framed lines. Marlin then treats the line as unnumbered,
     executes it and answers ok, so the reply payload is lost with no Resend to recover it. */
  corruptPrefixCount?: number;
};

export class MockTransport extends EventEmitter implements Transport {
  readonly label = 'mock://marlin-sim';
  private sim: MarlinSim;
  private open_ = false;
  private prefixBudget: number;

  constructor(options: MockOptions = {}) {
    super();
    this.prefixBudget = options.corruptPrefixCount ?? 0;
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
    if (this.prefixBudget > 0 && /^N\d+ /.test(data)) {
      this.prefixBudget--;
      this.sim.write(data.replace(/^N/, 'X'));
      return;
    }
    this.sim.write(data);
  }

  simulateBoardReset(): void {
    if (!this.open_) throw new Error('mock transport is not open');
    this.sim.resetBoard();
  }
}
