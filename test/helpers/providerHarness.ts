/**
 * Test harness for `TerminalProvider` lifecycle tests.
 *
 * The provider normally talks to the real extension host and `node-pty`. This
 * harness installs a mutable `vscode` module once, then constructs the provider
 * with injected fake `TerminalService` instances so every start, stop, close,
 * and restart decision is observable without spawning a process.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVscodeMock, installVscodeMock, type VscodeMock } from './vscodeMock';
import type { TerminalProvider } from '../../src/TerminalProvider';
import type {
  TerminalService,
  TerminalServiceEvents
} from '../../src/terminal/TerminalService';
import type { TerminalCommand } from '../../src/shared/protocol';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(
  condition: () => boolean,
  label = 'condition',
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * In-memory `TerminalService` with controllable start latency and observable
 * calls. `processName` stands in for the foreground process node-pty reports
 * on POSIX; tests may set it to a shell name (idle) or a running command.
 */
export class FakeTerminalService {
  readonly starts: TerminalCommand[] = [];
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  stops = 0;
  disposals = 0;
  running = false;
  startError?: Error;
  startGate?: Promise<void>;
  events?: TerminalServiceEvents;
  private foregroundProcess: string | undefined;

  attach(events: TerminalServiceEvents): void {
    this.events = events;
  }

  async start(command: TerminalCommand, cols: number, rows: number): Promise<void> {
    this.starts.push(command);
    if (this.startGate) {
      await this.startGate;
    }
    if (this.startError) {
      throw this.startError;
    }
    this.running = true;
    this.resizes.push([cols, rows]);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  dispose(): void {
    this.disposals += 1;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get processName(): string | undefined {
    return this.foregroundProcess;
  }

  /** Simulates the foreground process the PTY reports (`bash` = idle prompt). */
  setProcessName(name: string | undefined): void {
    this.foregroundProcess = name;
  }

  emitData(data: string): void {
    this.events?.onData(data);
  }

  emitExit(code: number | null): void {
    this.running = false;
    this.events?.onExit(code);
  }
}

export interface WarningRequest {
  message: string;
  options: unknown;
  confirm?: string;
  answer: string | undefined;
  promise: Promise<string | undefined>;
  resolve(answer: string | undefined): void;
}

export interface MockEditorPosition {
  line: number;
  character: number;
}

export interface MockEditorSelection {
  anchor: MockEditorPosition;
  active: MockEditorPosition;
}

export interface MockEditorOptions {
  path: string;
  text: string;
  languageId?: string;
  dirty?: boolean;
  /** Raw 0-based anchor/active pairs, exactly as VS Code reports a selection. */
  selections?: Array<{ anchor: [number, number]; active: [number, number] }>;
}

export interface MockEditor {
  document: {
    uri: unknown;
    isDirty: boolean;
    languageId: string;
    getText(range?: unknown): string;
  };
  selections: MockEditorSelection[];
  selection: MockEditorSelection;
}

export interface ManagedTabLike {
  id: string;
  title: string;
  userRenamed: boolean;
  cwd: string;
  running: boolean;
  starting: boolean;
  exited: boolean;
  foregroundCommand?: string;
  service: FakeTerminalService;
}

export interface FakeServiceDefaults {
  /** Resolves before the fake start() reports a running pty. */
  startGate?: Promise<void>;
  /** Rejects from start() to exercise the start-failure path. */
  startError?: Error;
  /** Foreground process name the fake PTY reports. */
  processName?: string;
}

export interface ProviderHarnessOptions {
  /** Extra configuration values seeded per test. */
  config?: Record<string, unknown>;
  workspaceState?: Record<string, unknown>;
  /** Applied to every fake service unless a one-shot default is queued. */
  serviceDefaults?: FakeServiceDefaults;
}

export interface ProviderHarness {
  root: string;
  provider: TerminalProvider;
  services: FakeTerminalService[];
  posts: any[];
  warnings: WarningRequest[];
  configValues: Record<string, unknown>;
  configReads: string[];
  workspaceState: Map<string, unknown>;
  workspaceStateReads: string[];
  workspaceStateWrites: Array<{ key: string; value: unknown }>;
  setConfig(key: string, value: unknown): void;
  /** Applies these defaults to the next fake service the provider creates. */
  queueServiceDefaults(defaults: FakeServiceDefaults): void;
  setWarningAnswer(answer: string | undefined): void;
  setClipboard(text: string): void;
  /** Install (or clear) the active editor the provider should capture. */
  setActiveEditor(editor: MockEditor | undefined): void;
  setVisibleEditors(editors: MockEditor[]): void;
  createEditor(options: MockEditorOptions): MockEditor;
  /**
   * Simulate the view stealing focus: `show()` runs this hook, which is how a
   * test proves the capture happened before the reveal.
   */
  onViewFocus(callback: (() => void) | undefined): void;
  resolveWarning(request: WarningRequest, answer: string | undefined): void;
  lastWarning(): WarningRequest | undefined;
  resolveView(): Promise<void>;
  /** Simulates the view being disposed (e.g. the sidebar being closed). */
  disposeView(): void;
  send(message: unknown): Promise<void>;
  startTab(tab: ManagedTabLike): Promise<void>;
  tabs(): Map<string, ManagedTabLike>;
  tab(id: string): ManagedTabLike | undefined;
  activeTabId(): string;
  lastState(): any;
  messagesOfType(type: string): any[];
  dispose(): void;
}

/**
 * One `vscode` module instance is shared by every provider in the process:
 * dynamic `import()` caches the module, so a second mock object would not be
 * observed by the already-evaluated provider. Harness instances reset only the
 * mutable state around that shared module.
 */
interface SharedContext {
  root: string;
  mock: VscodeMock;
  Provider: typeof TerminalProvider;
  uninstall: () => void;
}

let shared: SharedContext | undefined;
let sharedRoot: string | undefined;
/** Set per harness; the shared mock's focus command consults it. */
let focusHook: (() => void) | undefined;

async function ensureShared(): Promise<SharedContext> {
  if (shared) {
    return shared;
  }
  sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termmoor-provider-'));
  const mock = createVscodeMock([sharedRoot]);
  // Wrap the shared command dispatcher once: focusing the view must be able to
  // mutate the active editor so tests can detect a capture taken too late.
  const commands = mock.vscode.commands as {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
  const executeCommand = commands.executeCommand.bind(commands);
  commands.executeCommand = async (command: string, ...args: unknown[]) => {
    if (typeof command === 'string' && command.endsWith('.focus') && focusHook) {
      focusHook();
    }
    return await executeCommand(command, ...args);
  };
  const uninstall = installVscodeMock(mock);
  const module = await import('../../src/TerminalProvider');
  shared = { root: sharedRoot, mock, Provider: module.TerminalProvider, uninstall };
  return shared;
}

export function cleanupSharedHarness(): void {
  if (shared) {
    shared.uninstall();
    shared = undefined;
  }
  if (sharedRoot) {
    fs.rmSync(sharedRoot, { recursive: true, force: true });
    sharedRoot = undefined;
  }
}

function createMemento(initial: Record<string, unknown>): {
  data: Map<string, unknown>;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    data,
    reads,
    writes,
    get<T>(key: string, fallback?: T): T | undefined {
      reads.push(key);
      return (data.has(key) ? data.get(key) : fallback) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      writes.push({ key, value });
      data.set(key, value);
    }
  };
}

export async function createProviderHarness(
  options: ProviderHarnessOptions = {}
): Promise<ProviderHarness> {
  const context = await ensureShared();
  const { mock, root, Provider } = context;

  // Reset mutable mock state between tests.
  mock.state.opened.length = 0;
  mock.state.revealed.length = 0;
  mock.state.warnings.length = 0;
  mock.state.quickPicks.length = 0;
  mock.state.warningAnswer = undefined;
  mock.state.quickPickAnswer = 'first';
  focusHook = undefined;

  const services: FakeTerminalService[] = [];
  const queuedServiceDefaults: FakeServiceDefaults[] = [];

  const configValues: Record<string, unknown> = {
    'terminal.scrollback': 5000,
    'terminal.shellIntegration': false,
    'terminal.longRunningThresholdSeconds': 10,
    ...(options.config ?? {})
  };

  const workspaceState = createMemento(options.workspaceState ?? {});
  const globalState = createMemento({});

  const configReads: string[] = [];
  const workspace = mock.vscode.workspace as any;
  workspace.getConfiguration = () => ({
    get<T>(key: string, fallback?: T): T {
      configReads.push(key);
      const value = configValues[key];
      return (value === undefined ? fallback : value) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      configValues[key] = value;
    }
  });

  const posts: any[] = [];
  const warnings: WarningRequest[] = [];
  let autoWarningAnswer: string | undefined;

  const window = mock.vscode.window as any;
  window.state = { focused: true };
  window.activeTerminal = undefined;
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  window.tabGroups = { all: [] };
  window.showWarningMessage = (
    message: string,
    warningOptions?: unknown,
    confirm?: string
  ): Promise<string | undefined> => {
    const gate = deferred<string | undefined>();
    const request: WarningRequest = {
      message,
      options: warningOptions,
      confirm,
      answer: undefined,
      promise: gate.promise,
      resolve: (answer) => {
        request.answer = answer;
        gate.resolve(answer);
      }
    };
    warnings.push(request);
    if (autoWarningAnswer !== undefined) {
      request.resolve(autoWarningAnswer);
    }
    return gate.promise;
  };
  window.showInformationMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  window.showInputBox = async () => undefined;
  window.onDidStartTerminalShellExecution = () => ({ dispose: () => undefined });
  window.onDidEndTerminalShellExecution = () => ({ dispose: () => undefined });
  window.showQuickPick = async (items: unknown) => {
    const resolved = (await Promise.resolve(items)) as Array<{ id?: string; action?: string }>;
    return resolved[0];
  };

  const env = mock.vscode.env as any;
  let clipboardText = '';
  env.language = 'en';
  env.clipboard = {
    readText: async () => clipboardText,
    writeText: async (text: string) => {
      clipboardText = text;
    }
  };
  env.openExternal = async () => true;

  (mock.vscode as any).ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  (mock.vscode as any).ViewColumn = { One: 1, Two: 2, Three: 3 };

  const viewDisposers: Array<() => void> = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (message: unknown) => {
        posts.push(message);
        return true;
      },
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        view.receive = handler;
        return { dispose: () => undefined };
      }
    },
    receive: (_message: unknown): void => undefined,
    onDidChangeVisibility: (_handler: () => void) => ({ dispose: () => undefined }),
    onDidDispose: (handler: () => void) => {
      viewDisposers.push(handler);
      return { dispose: () => undefined };
    }
  };

  const extensionContext = {
    extensionUri: (mock.vscode.Uri as any).file(root),
    subscriptions: [],
    globalState,
    workspaceState,
    extensionPath: root
  };

  const provider = new Provider(extensionContext as any, {
    createService: () => {
      const service = new FakeTerminalService();
      const defaults = queuedServiceDefaults.shift() ?? options.serviceDefaults;
      if (defaults?.startGate) {
        service.startGate = defaults.startGate;
      }
      if (defaults?.startError) {
        service.startError = defaults.startError;
      }
      if (defaults?.processName) {
        service.setProcessName(defaults.processName);
      }
      services.push(service);
      return service as unknown as TerminalService;
    }
  });

  const harness: ProviderHarness = {
    root,
    provider,
    services,
    posts,
    warnings,
    configValues,
    configReads,
    workspaceState: workspaceState.data,
    workspaceStateReads: workspaceState.reads,
    workspaceStateWrites: workspaceState.writes,
    setConfig(key, value) {
      configValues[key] = value;
    },
    queueServiceDefaults(defaults) {
      queuedServiceDefaults.push(defaults);
    },
    setWarningAnswer(answer) {
      autoWarningAnswer = answer;
      for (const request of warnings) {
        if (request.answer === undefined) {
          request.resolve(answer);
        }
      }
    },
    setClipboard(text) {
      clipboardText = text;
    },
    setActiveEditor(editor) {
      window.activeTextEditor = editor;
    },
    setVisibleEditors(editors) {
      window.visibleTextEditors = editors;
    },
    createEditor(options) {
      const uri = (mock.vscode.Uri as any).file(options.path);
      const text = options.text;
      const lines = text.split('\n');
      const offsetOf = (position: MockEditorPosition): number => {
        let offset = 0;
        for (let line = 0; line < position.line; line += 1) {
          offset += (lines[line]?.length ?? 0) + 1;
        }
        return offset + Math.min(position.character, lines[position.line]?.length ?? 0);
      };
      const document = {
        uri,
        isDirty: options.dirty ?? false,
        languageId: options.languageId ?? 'plaintext',
        getText(range?: unknown): string {
          if (!range) {
            return text;
          }
          const value = range as {
            start?: MockEditorPosition;
            end?: MockEditorPosition;
            anchor?: MockEditorPosition;
            active?: MockEditorPosition;
          };
          const start = value.start ?? value.anchor;
          const end = value.end ?? value.active;
          if (!start || !end) {
            return text;
          }
          const left = offsetOf(start);
          const right = offsetOf(end);
          return text.slice(Math.min(left, right), Math.max(left, right));
        }
      };
      const selections = (options.selections ?? []).map(({ anchor, active }) => {
        const from = { line: anchor[0], character: anchor[1] };
        const to = { line: active[0], character: active[1] };
        return {
          anchor: from,
          active: to,
          isEmpty: from.line === to.line && from.character === to.character,
          start: from,
          end: to
        };
      });
      return {
        document,
        selections,
        selection: selections[0] ?? {
          anchor: { line: 0, character: 0 },
          active: { line: 0, character: 0 },
          isEmpty: true,
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        }
      } as MockEditor;
    },
    onViewFocus(callback) {
      focusHook = callback;
    },
    resolveWarning(request, answer) {
      request.resolve(answer);
    },
    lastWarning() {
      return warnings[warnings.length - 1];
    },
    async resolveView() {
      await provider.resolveWebviewView(view as any);
    },
    disposeView() {
      for (const dispose of viewDisposers) {
        dispose();
      }
    },
    async send(message) {
      await (
        provider as unknown as { onMessage(value: unknown): Promise<void> }
      ).onMessage(message);
    },
    async startTab(tab) {
      await (
        provider as unknown as { startTab(value: unknown): Promise<void> }
      ).startTab(tab);
    },
    tabs() {
      return (provider as unknown as { tabs: Map<string, ManagedTabLike> }).tabs;
    },
    tab(id) {
      return (provider as unknown as { tabs: Map<string, ManagedTabLike> }).tabs.get(id);
    },
    activeTabId() {
      return (provider as unknown as { activeTabId: string }).activeTabId;
    },
    lastState() {
      for (let index = posts.length - 1; index >= 0; index -= 1) {
        const message = posts[index];
        if (message?.type === 'state' || message?.type === 'init') {
          return message.state;
        }
      }
      return undefined;
    },
    messagesOfType(type) {
      return posts.filter((message) => message?.type === type);
    },
    dispose() {
      provider.dispose();
    }
  };

  return harness;
}
