import { spawn as spawnChildProcess } from 'node:child_process';
import type { TerminalCommand } from '../shared/protocol';
import {
  buildSpawnSpec,
  clampDimension,
  isWindows,
  loadPty,
  type PtyFactory,
  type PtyLoader,
  type PtyProcess,
  type SpawnSpec
} from './pty';

export interface TerminalServiceEvents {
  onData(data: string): void;
  onExit(code: number | null): void;
}

/**
 * Test seams. Production code constructs `new TerminalService()` and gets the
 * real lazy pty loader plus the default 2s stop timeout.
 */
export interface TerminalServiceOptions {
  /** Replaces the native pty module loader. Defaults to {@link loadPty}. */
  loadPty?: PtyLoader;
  /**
   * Bypasses the module entirely and spawns directly. Takes precedence over
   * `loadPty`; useful for fakes that never touch the native binding.
   */
  ptyFactory?: PtyFactory;
  /** How long `stop()` waits for an exit event. Defaults to 2000ms. */
  stopTimeoutMs?: number;
}

/** How long `stop()` waits for the pty to report exit before giving up. */
const STOP_TIMEOUT_MS = 2000;
/** Delay before the `taskkill /T /F` fallback runs on Windows. */
const TASKKILL_DELAY_MS = 800;

interface Disposable {
  dispose(): void;
}

/**
 * Host-side owner of a single embedded pseudo-terminal.
 *
 * One instance backs one webview. Data flows are plain UTF-8 strings in both
 * directions; the webview writes them straight into xterm.
 */
export class TerminalService {
  private events: TerminalServiceEvents | null = null;
  private proc: PtyProcess | null = null;
  private dataSubscription: Disposable | null = null;
  private exitSubscription: Disposable | null = null;
  private running = false;
  private disposed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<void> | null = null;
  private startSequence = 0;
  private exitWaiters: Array<(code: number | null) => void> = [];
  /** Last char of a data chunk when it is a lone high surrogate. */
  private pendingHighSurrogate = '';
  private readonly loadPty: PtyLoader;
  private readonly ptyFactory: PtyFactory | null;
  private readonly stopTimeoutMs: number;

  constructor(options: TerminalServiceOptions = {}) {
    this.loadPty = options.loadPty ?? loadPty;
    this.ptyFactory = options.ptyFactory ?? null;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  attach(events: TerminalServiceEvents): void {
    this.events = events;
  }

  /**
   * Replace any running pty and start `command`.
   * Rejects with an actionable error when the pty module or the process
   * cannot be started. There is no fallback: the user sees the failure.
   */
  async start(command: TerminalCommand, cols: number, rows: number): Promise<void> {
    if (this.disposed) {
      throw new Error('TerminalService has been disposed.');
    }

    const sequence = ++this.startSequence;
    if (this.proc) {
      await this.stop();
    }
    if (sequence !== this.startSequence) {
      // A newer start() call won the race and is responsible for the terminal.
      return;
    }

    // Load failures throw here, before anything else is touched.
    const spawn = this.resolveSpawn();
    const spec = buildSpawnSpec(command);
    const cwd = command.cwd?.trim() ? command.cwd : process.cwd();
    const clampedCols = clampDimension(cols, 80);
    const clampedRows = clampDimension(rows, 24);
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...(command.env ?? {}) })) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    if (!env.TERM) {
      // node-pty only injects TERM from `name` on POSIX; Windows TUIs (and
      // Node CLI agents) still read it to decide whether to emit color.
      env.TERM = 'xterm-256color';
    }

    let proc: PtyProcess;
    try {
      proc = spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: clampedCols,
        rows: clampedRows,
        cwd,
        env,
        // Windows always decodes as UTF-8 (and warns if `encoding` is set).
        ...(isWindows ? {} : { encoding: 'utf8' })
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to start terminal process ${describeSpec(spec)} in "${cwd}": ${detail}`
      );
    }

    this.proc = proc;
    this.running = true;
    this.pendingHighSurrogate = '';

    this.dataSubscription = proc.onData((chunk: string) => this.handleData(proc, chunk));
    this.exitSubscription = proc.onExit(({ exitCode }: { exitCode: number }) =>
      this.handleExit(proc, typeof exitCode === 'number' ? exitCode : null)
    );
  }

  write(data: string): void {
    const proc = this.proc;
    if (!proc || typeof data !== 'string' || data.length === 0) {
      return;
    }
    try {
      proc.write(data);
    } catch {
      // The pty can disappear between the write and the event loop turn; the
      // exit event (or the next start) owns the user-visible state.
    }
  }

  resize(cols: number, rows: number): void {
    const proc = this.proc;
    if (!proc) {
      return;
    }
    const clampedCols = clampDimension(cols, proc.cols || 80);
    const clampedRows = clampDimension(rows, proc.rows || 24);
    if (clampedCols === proc.cols && clampedRows === proc.rows) {
      return;
    }
    try {
      proc.resize(clampedCols, clampedRows);
    } catch {
      // node-pty queues resizes until the process is ready and throws if it
      // has already exited; neither is worth failing the webview over.
    }
  }

  /**
   * Kill the pty (and its process tree on Windows) and resolve once it has
   * exited or the safety timeout expired.
   */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.running = false;
      return;
    }

    if (!this.stopPromise) {
      const promise = new Promise<void>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          this.exitWaiters = this.exitWaiters.filter((waiter) => waiter !== settle);
          resolve();
        };
        const timeout = setTimeout(settle, this.stopTimeoutMs);
        this.exitWaiters.push(settle);
      });
      this.stopPromise = promise;
      void promise.then(() => {
        this.stopPromise = null;
      });
      this.terminate(proc);
    }

    await this.stopPromise;
    this.running = false;

    // The safety timeout resolved without an exit event: the pty is still
    // attached. Release it, otherwise the next start() waits for another full
    // timeout and the stale process can still push data/exit into the UI.
    if (this.proc === proc) {
      this.detachProc();
    }
  }

  get isRunning(): boolean {
    return this.running && this.proc !== null;
  }

  /** Active foreground process name reported by node-pty, if available. */
  get processName(): string | undefined {
    try {
      const name = (this.proc as { process?: string } | null)?.process?.trim();
      if (!name) {
        return undefined;
      }
      // On Windows, node-pty's `WindowsTerminal.process` returns `opt.name`
      // (`xterm-256color`) instead of the foreground child process.
      const lower = name.toLowerCase();
      if (lower === 'xterm-256color' || lower === 'xterm') {
        return undefined;
      }
      return name;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearKillTimer();
    const proc = this.proc;
    this.proc = null;
    this.running = false;
    this.pendingHighSurrogate = '';
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      if (isWindows && proc.pid) {
        this.killWindowsTree(proc.pid);
      }
    }
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) {
      waiter(null);
    }
    this.events = null;
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve the spawn function once per start. Loading stays outside the
   * spawn try/catch so a broken install keeps its actionable error instead of
   * being wrapped as a process-start failure.
   */
  private resolveSpawn(): PtyFactory {
    const factory = this.ptyFactory;
    if (factory) {
      return factory;
    }
    const pty = this.loadPty();
    return (file, args, options) => pty.spawn(file, args, options);
  }

  /** Drop the current pty without killing it (used after a stop timeout). */
  private detachProc(): void {
    this.proc = null;
    this.running = false;
    this.pendingHighSurrogate = '';
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;
  }

  private handleData(proc: PtyProcess, chunk: string): void {
    if (proc !== this.proc || typeof chunk !== 'string' || chunk.length === 0) {
      return;
    }

    // Guard against a surrogate pair split across two chunks: emitting half a
    // pair would make xterm render a replacement glyph and can also break
    // JSON round-tripping through postMessage.
    let text = this.pendingHighSurrogate + chunk;
    this.pendingHighSurrogate = '';
    const lastCode = text.charCodeAt(text.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (!text) {
      return;
    }

    try {
      this.events?.onData(text);
    } catch {
      // A throwing listener must not take down the pty data pump.
    }
  }

  private handleExit(proc: PtyProcess, code: number | null): void {
    if (proc !== this.proc) {
      return;
    }
    this.clearKillTimer();
    this.proc = null;
    this.running = false;
    this.pendingHighSurrogate = '';
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;

    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) {
      waiter(code);
    }

    try {
      this.events?.onExit(code);
    } catch {
      // The webview may already be gone.
    }
  }

  private terminate(proc: PtyProcess): void {
    try {
      proc.kill();
    } catch {
      // The process may have exited on its own already.
    }
    if (!isWindows) {
      return;
    }

    // ConPTY's kill() only terminates the shell. Anything the shell spawned
    // (an agent CLI, its child processes) survives, so force-kill the tree if
    // the pty has not reported exit shortly after.
    const pid = proc.pid;
    if (!pid) {
      return;
    }
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.proc !== proc) {
        return;
      }
      this.killWindowsTree(pid);
    }, TASKKILL_DELAY_MS);
    (this.killTimer as { unref?: () => void }).unref?.();
  }

  private killWindowsTree(pid: number): void {
    try {
      const killer = spawnChildProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.on('error', () => undefined);
    } catch {
      // taskkill missing is not fatal; kill() was already attempted.
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

function describeSpec(spec: SpawnSpec): string {
  const rendered =
    typeof spec.args === 'string'
      ? `${spec.file} ${spec.args}`
      : [spec.file, ...spec.args].join(' ');
  if (spec.viaCmdShell) {
    return `"${spec.requestedFile}" (via cmd.exe: ${rendered})`;
  }
  return rendered === spec.requestedFile ? `"${spec.requestedFile}"` : `"${rendered}"`;
}
