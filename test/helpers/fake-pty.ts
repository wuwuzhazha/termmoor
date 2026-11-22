/**
 * In-memory pty used by the TerminalService tests. It implements only the
 * surface TerminalService touches, so tests never load the native module or
 * spawn a real process.
 */

import type { PtyFactory, PtyProcess, PtySpawnOptions } from '../../src/terminal/pty';

export interface FakeExitEvent {
  exitCode: number;
  signal?: number;
}

type DataListener = (data: string) => void;
type ExitListener = (event: FakeExitEvent) => void;

export interface FakeSpawnRecord {
  file: string;
  args: string[] | string;
  options: PtySpawnOptions;
}

export interface FakePtyOptions {
  cols: number;
  rows: number;
  /**
   * Emulate a real pty: `kill()` reports exit on the next microtask. Set to
   * false to exercise the TerminalService stop-timeout path.
   */
  exitOnKill?: boolean;
  /** 0 keeps `taskkill` out of the picture on Windows. */
  pid?: number;
}

export class FakePty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process = 'fake-pty';
  handleFlowControl = false;
  readonly written: Array<string | Buffer> = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  resizeThrows = false;

  private readonly exitOnKill: boolean;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(options: FakePtyOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.exitOnKill = options.exitOnKill ?? true;
    this.pid = options.pid ?? 0;
  }

  readonly onData = (listener: DataListener): { dispose(): void } => {
    this.dataListeners.add(listener);
    return { dispose: () => void this.dataListeners.delete(listener) };
  };

  readonly onExit = (listener: ExitListener): { dispose(): void } => {
    this.exitListeners.add(listener);
    return { dispose: () => void this.exitListeners.delete(listener) };
  };

  write(data: string | Buffer): void {
    this.written.push(data);
  }

  resize(columns: number, rows: number): void {
    if (this.resizeThrows) {
      throw new Error('pty has already exited');
    }
    this.cols = columns;
    this.rows = rows;
    this.resizes.push([columns, rows]);
  }

  kill(): void {
    this.killed = true;
    if (this.exitOnKill) {
      queueMicrotask(() => this.emitExit(0));
    }
  }

  pause(): void {
    /* no-op */
  }

  resume(): void {
    /* no-op */
  }

  clear(): void {
    /* no-op */
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) {
      listener(data);
    }
  }

  emitExit(exitCode = 0): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode });
    }
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

export interface FakePtyHarness {
  factory: PtyFactory;
  /** Every pty the factory produced, in spawn order. */
  procs: FakePty[];
  /** The exact arguments TerminalService handed to spawn. */
  spawns: FakeSpawnRecord[];
  last(): FakePty;
}

export function createFakePtyFactory(
  defaults: Pick<FakePtyOptions, 'exitOnKill' | 'pid'> = {}
): FakePtyHarness {
  const procs: FakePty[] = [];
  const spawns: FakeSpawnRecord[] = [];

  const factory: PtyFactory = (file, args, options) => {
    const proc = new FakePty({
      cols: options.cols,
      rows: options.rows,
      exitOnKill: defaults.exitOnKill,
      pid: defaults.pid
    });
    procs.push(proc);
    spawns.push({ file, args, options });
    return proc as unknown as PtyProcess;
  };

  return {
    factory,
    procs,
    spawns,
    last: () => procs[procs.length - 1]
  };
}

/** Let queued microtasks (fake kill -> exit) run. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
