import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextService } from './context';
import { buildSendPayload, composeSendDraft } from './contextPayload';
import { splitLinkTarget } from './shared/linkTarget';
import type {
  HostToTerminal,
  TerminalState,
  TerminalTabInfo,
  TerminalToHost
} from './shared/terminalProtocol';
import { getStrings } from './shared/strings';
import {
  buildShellCommand,
  extractCommandProgram,
  normalizeProcessTitle
} from './terminal/shellIntegration';
import { reorderByIds } from './terminal/tabOrder';
import { TerminalService } from './terminal/TerminalService';
import {
  normalizeOpenPathOutcome,
  runningOrStartingTabs,
  type OpenPathOutcome
} from './terminal/reliability';

const VIEW_TYPE = 'agentTerminal.view';
const CONTEXT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONTEXT_TEMP_PREFIX = 'terminal-pro-ctx-';
const MAX_TABS = 12;
const PROCESS_POLL_MS = 1500;
const BELL_COOLDOWN_MS = 5000;
/**
 * Process names a PTY reports while a shell sits at its prompt. Anything else
 * means a foreground command is running inside the tab.
 */
const IDLE_SHELL_NAMES = new Set([
  'bash',
  'cmd',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'login',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'xonsh',
  'zsh'
]);

/** Settings surface read by {@link TerminalProvider.config}. */
interface RuntimeConfig {
  scrollback: number;
  shellIntegration: boolean;
  longRunningThresholdSeconds: number;
}

/**
 * Injectable seam used by the lifecycle tests. Production constructs the real
 * `TerminalService`; tests swap in a fake without changing any of the
 * provider's orchestration logic.
 */
export interface TerminalProviderDependencies {
  createService?: () => TerminalService;
}

interface ManagedTab {
  id: string;
  title: string;
  foregroundCommand?: string;
  xtermTitle?: string;
  processHint?: string;
  cwd: string;
  service: TerminalService;
  cols: number;
  rows: number;
  running: boolean;
  exited: boolean;
  exitCode: number | null;
  starting: boolean;
  startSequence: number;
  /** In-flight start/restart loop; duplicate requests coalesce onto it. */
  startPending?: Promise<void>;
  /** A restart arrived while the loop was running; run another attempt. */
  restartQueued?: boolean;
  restarting: number;
  /** Drafts queued until the shell is ready; never executed on arrival. */
  pendingPaste: string[];
  attention?: 'done' | 'warn' | 'bell';
  lastBellAt: number;
}

/**
 * Editor-symbiotic sidebar terminal.
 *
 * Owns one or more plain shell PTYs (tab bar stays hidden when there is only
 * one tab), turns the active editor selection/file into a shell-safe draft, and
 * routes terminal links back to the editor.
 */
export class TerminalProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly tabs = new Map<string, ManagedTab>();
  private activeTabId = '';
  private nextTabNumber = 1;
  private defaultCols = 100;
  private defaultRows = 30;
  private readonly context = new ContextService();
  private webviewReady = false;
  private disposed = false;
  /** Bumped on every view dispose; stale in-flight starts must not spawn. */
  private viewGeneration = 0;
  /** Monotonic snapshot id sent with every state/init message. */
  private stateSeq = 0;
  private readonly processPollTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly dependencies: TerminalProviderDependencies = {}
  ) {
    sweepContextDirsOnce();
    this.processPollTimer = setInterval(() => this.refreshProcessTitles(), PROCESS_POLL_MS);
    (this.processPollTimer as { unref?: () => void }).unref?.();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionContext.extensionUri]
    };
    view.webview.html = this.html(view.webview);
    const sub = view.webview.onDidReceiveMessage((message: TerminalToHost) => {
      void this.onMessage(message);
    });
    const visSub = view.onDidChangeVisibility(() => {
      if (view.visible) {
        const active = this.activeTab();
        if (active?.attention) {
          active.attention = undefined;
          this.postState();
        }
      }
    });
    view.onDidDispose(() => {
      sub.dispose();
      visSub.dispose();
      this.viewGeneration += 1;
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
      }
      for (const tab of this.tabs.values()) {
        tab.running = false;
        void this.stopTab(tab);
      }
    });
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.agentTerminal');
    await vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
  }

  async newSession(): Promise<void> {
    await this.show();
    if (this.tabs.size === 0) {
      const tab = this.ensureInitialTab();
      await this.startTab(tab);
      return;
    }
    if (this.tabs.size >= MAX_TABS) {
      this.post({
        type: 'toast',
        level: 'warn',
        message: `Maximum of ${MAX_TABS} terminal tabs reached.`
      });
      return;
    }
    const inheritedCwd = this.activeTab()?.cwd ?? this.workspaceCwd();
    const tab = this.createTab({ cwd: inheritedCwd });
    this.activeTabId = tab.id;
    this.postState();
    await this.startTab(tab);
    this.post({ type: 'focus' });
  }

  async sendSelectionOrFile(): Promise<void> {
    // Snapshot before revealing the view: revealing it can change the active editor.
    const capture = this.context.captureSendTarget();
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    if (!capture) {
      void vscode.window.showInformationMessage(zh ? '请先打开要引用的文件。' : 'Open a file to insert code context.');
      return;
    }
    const tab = this.ensureInitialTab();
    const isReference = capture.selections.length === 0 && !capture.dirty;
    const sourcePath =
      isReference && capture.localPath
        ? path.relative(tab.cwd, capture.localPath)
        : capture.path;
    const plan = buildSendPayload({ ...capture, path: sourcePath });
    const file = plan.contextFile
      ? this.writeContextFile(plan.contextFile.kind, plan.contextFile.text, plan.contextFile.ext)
      : undefined;
    if (plan.contextFile && !file) {
      void vscode.window.showWarningMessage(zh ? '无法创建代码上下文附件。' : 'Could not create the code context attachment.');
      return;
    }
    if (plan.truncated) {
      void vscode.window.showWarningMessage(zh ? '代码上下文附件过长，已截断。' : 'The code context attachment was truncated.');
    }
    await this.show();
    if (this.tabs.get(tab.id) === tab) {
      this.queuePaste(composeSendDraft(plan, file), tab);
    }
  }

  async restart(targetTabId?: string): Promise<void> {
    // A stale explicit id must never silently restart a different (active) tab.
    const tab =
      typeof targetTabId === 'string' && targetTabId.length > 0
        ? this.tabs.get(targetTabId)
        : this.ensureInitialTab();
    if (!tab) {
      return;
    }
    if (!(await this.confirmDestructiveTabs('restart', [tab]))) {
      return;
    }
    // The modal is async: only restart the very tab that was confirmed.
    if (this.tabs.get(tab.id) !== tab) {
      return;
    }
    tab.restartQueued = true;
    if (tab.startPending) {
      // Supersede the attempt in flight; the loop creates a fresh shell next.
      tab.startSequence += 1;
    }
    await this.startTab(tab);
  }

  /* ------------------------------------------------------------------ */
  /* Multi-tab shell lifecycle                                            */
  /* ------------------------------------------------------------------ */

  private ensureInitialTab(): ManagedTab {
    const current = this.activeTab();
    if (current) {
      return current;
    }
    const first = this.tabs.values().next().value as ManagedTab | undefined;
    if (first) {
      this.activeTabId = first.id;
      return first;
    }
    const created = this.createTab();
    this.activeTabId = created.id;
    return created;
  }

  private activeTab(): ManagedTab | undefined {
    return this.tabs.get(this.activeTabId);
  }

  /**
   * Explicit ids are authoritative: a stale tab id resolves to nothing instead
   * of silently falling through to whatever tab happens to be active.
   */
  private resolveMessageTab(tabId: string | undefined): ManagedTab | undefined {
    if (typeof tabId === 'string' && tabId.length > 0) {
      return this.tabs.get(tabId);
    }
    return this.activeTab();
  }

  private defaultShellTitle(): string {
    return process.platform === 'win32' ? 'pwsh' : 'shell';
  }

  private createTab(init?: { cwd?: string }): ManagedTab {
    const id = `tab-${this.nextTabNumber++}`;
    const shellTitle = this.defaultShellTitle();
    const service = this.dependencies.createService?.() ?? new TerminalService();
    const tab: ManagedTab = {
      id,
      title: shellTitle,
      processHint: shellTitle,
      cwd: init?.cwd ?? this.workspaceCwd(),
      service,
      cols: this.defaultCols,
      rows: this.defaultRows,
      running: false,
      exited: false,
      exitCode: null,
      starting: false,
      startSequence: 0,
      restarting: 0,
      pendingPaste: [],
      lastBellAt: 0
    };

    service.attach({
      onData: (data) => {
        this.post({ type: 'terminal-data', tabId: tab.id, data });
      },
      onExit: (code) => {
        tab.running = false;
        tab.exitCode = code;
        tab.foregroundCommand = undefined;
        if (tab.restarting > 0) {
          return;
        }
        tab.exited = true;
        this.postState();
      }
    });

    this.tabs.set(id, tab);
    return tab;
  }

  private applyReorderTabs(tabIds: string[]): void {
    if (!Array.isArray(tabIds) || this.tabs.size <= 1) {
      return;
    }
    const reordered = reorderByIds([...this.tabs.values()], tabIds);
    this.tabs.clear();
    for (const tab of reordered) {
      this.tabs.set(tab.id, tab);
    }
    this.postState();
  }

  private async closeOtherTabs(keepTabId: string): Promise<void> {
    const keep = this.tabs.get(keepTabId);
    if (!keep || this.tabs.size <= 1) {
      return;
    }
    const confirmed = [...this.tabs.values()].filter((t) => t.id !== keepTabId);
    if (!(await this.confirmDestructiveTabs('close-others', confirmed))) {
      return;
    }
    // Recheck identity after the modal: never close a tab the user did not
    // confirm, nor a keep-tab that vanished while the modal was open.
    if (this.tabs.get(keep.id) !== keep) {
      return;
    }
    const toClose = confirmed.filter((tab) => this.tabs.get(tab.id) === tab);
    for (const tab of toClose) {
      this.tabs.delete(tab.id);
      tab.startSequence += 1;
      await this.stopTab(tab);
      tab.service.dispose();
    }
    this.activeTabId = keep.id;
    keep.attention = undefined;
    this.postState();
    this.post({ type: 'focus' });
  }

  private async selectTab(tabId: string, options?: { preserveFocus?: boolean }): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.activeTabId = tab.id;
    tab.attention = undefined;
    this.postState();
    if (!tab.running && !tab.starting && !tab.exited && this.webviewReady) {
      await this.startTab(tab);
    }
    if (!options?.preserveFocus) {
      this.post({ type: 'focus' });
    }
  }

  /**
   * True while a tab would lose real work if it were closed: a foreground
   * command is running in the shell, or a start/restart is still in flight.
   * A shell idling at its prompt reports no foreground command and is treated
   * as safe to close without a prompt.
   */
  private hasActiveWork(tab: ManagedTab): boolean {
    if (tab.starting) {
      return true;
    }
    if (!tab.running) {
      return false;
    }
    // 1. OSC 133/633 `C` … `D` tells us a command is running.
    if (tab.foregroundCommand) {
      return true;
    }
    // 2. POSIX PTYs report the foreground process; a shell name is a prompt.
    return !isIdleShellProcess(tab.service.processName);
  }

  /**
   * One modal guards every destructive user action that would interrupt work.
   * A declined confirmation returns `false` before anything is stopped.
   *
   * Closing only ever affects the local PTY, and an idle shell has nothing to
   * lose, so it closes without a prompt. Restarting always replaces the shell
   * and stays guarded while the tab is running or starting.
   */
  private async confirmDestructiveTabs(
    action: 'close' | 'close-others' | 'restart',
    tabs: readonly ManagedTab[]
  ): Promise<boolean> {
    const interrupting =
      action === 'restart'
        ? runningOrStartingTabs(tabs)
        : tabs.filter((tab) => this.hasActiveWork(tab));
    if (interrupting.length === 0) {
      return true;
    }
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    let message: string;
    let confirm: string;
    if (action === 'close') {
      const title = interrupting[0].title;
      message = zh
        ? `终端“${title}”仍在执行任务，关闭会终止其中的进程。`
        : `“${title}” is still running work. Closing it will terminate its process.`;
      confirm = zh ? '关闭' : 'Close';
    } else if (action === 'close-others') {
      message = zh
        ? `${interrupting.length} 个其他终端仍在执行任务，关闭会终止其中的进程。`
        : `${interrupting.length} other terminal${interrupting.length === 1 ? '' : 's'} still running work. Closing them will terminate their processes.`;
      confirm = zh ? '关闭其他终端' : 'Close Others';
    } else {
      const title = interrupting[0].title;
      message = zh
        ? `终端“${title}”仍在运行，重启会终止当前进程并启动新的 shell。`
        : `“${title}” is still running. Restarting will terminate the current process and start a new shell.`;
      confirm = zh ? '重启' : 'Restart';
    }
    const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirm);
    return picked === confirm;
  }

  private async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    if (!(await this.confirmDestructiveTabs('close', [tab]))) {
      return;
    }
    if (this.tabs.get(tabId) !== tab) {
      return;
    }
    if (this.tabs.size <= 1) {
      // Keep one shell alive so the sidebar never turns into an empty void.
      tab.attention = undefined;
      await this.startTab(tab);
      return;
    }

    const orderedIds = [...this.tabs.keys()];
    const index = orderedIds.indexOf(tabId);
    this.tabs.delete(tabId);
    tab.startSequence += 1;
    await this.stopTab(tab);
    tab.service.dispose();

    if (this.activeTabId === tabId) {
      const nextId = orderedIds[Math.max(0, index - 1)] ?? orderedIds[index + 1] ?? '';
      this.activeTabId = this.tabs.has(nextId) ? nextId : ([...this.tabs.keys()][0] ?? '');
      const next = this.activeTab();
      if (next) {
        next.attention = undefined;
      }
    }
    this.postState();
    this.post({ type: 'focus' });
  }

  /**
   * Coalesces every start/restart request for a tab onto one serialized loop.
   * Overlapping callers (webview ready, select, insert, restart) share the
   * in-flight promise instead of racing two shells onto one tab.
   */
  private startTab(tab: ManagedTab): Promise<void> {
    if (this.disposed || this.tabs.get(tab.id) !== tab) {
      return Promise.resolve();
    }
    if (tab.startPending) {
      return tab.startPending;
    }
    const pending = this.runStartRequests(tab).finally(() => {
      if (tab.startPending === pending) {
        tab.startPending = undefined;
      }
      // A restart that arrived in the tiny window between the loop's last
      // check and its resolution must still get its attempt.
      if (tab.restartQueued && !this.disposed && this.tabs.get(tab.id) === tab) {
        void this.startTab(tab).catch(() => undefined);
      }
    });
    tab.startPending = pending;
    return pending;
  }

  private async runStartRequests(tab: ManagedTab): Promise<void> {
    while (!this.disposed && this.tabs.get(tab.id) === tab) {
      // A restart only means "run another attempt": `runStartAttempt` always
      // stops the previous pty before spawning, so every attempt produces a
      // genuinely fresh shell.
      tab.restartQueued = false;
      await this.runStartAttempt(tab);
      if (!tab.restartQueued) {
        return;
      }
    }
  }

  private isStartCurrent(tab: ManagedTab, sequence: number): boolean {
    return !this.disposed && sequence === tab.startSequence && this.tabs.get(tab.id) === tab;
  }

  private async runStartAttempt(tab: ManagedTab): Promise<void> {
    const sequence = ++tab.startSequence;
    const generation = this.viewGeneration;
    tab.running = false;
    tab.exited = false;
    tab.exitCode = null;
    tab.foregroundCommand = undefined;
    await this.stopTab(tab);
    if (!this.isStartCurrent(tab, sequence)) {
      return;
    }
    this.post({ type: 'terminal-reset', tabId: tab.id });
    this.postState();
    if (!this.view || !this.webviewReady) {
      return;
    }
    tab.starting = true;
    try {
      const cfg = this.config();
      const targetCwd = resolveExistingDirectory(tab.cwd) ?? this.workspaceCwd();
      tab.cwd = targetCwd;
      const command = buildShellCommand({
        cwd: targetCwd,
        enableIntegration: cfg.shellIntegration,
        integrationDir: ensureContextDir()
      });
      await tab.service.start(command, tab.cols || 100, tab.rows || 30);
      if (!this.isStartCurrent(tab, sequence)) {
        // A newer start/restart, a close, or a dispose superseded this attempt:
        // the shell it spawned must not keep running behind a dead tab.
        await this.stopTab(tab);
        return;
      }
      if (generation !== this.viewGeneration) {
        // The view went away mid-start: release the shell process. The next
        // attach starts a fresh one.
        await this.stopTab(tab);
        return;
      }
      tab.running = true;
      tab.exited = false;
      this.syncTabProcessTitle(tab);
      if (tab.cols > 0 && tab.rows > 0) {
        tab.service.resize(tab.cols, tab.rows);
      }
      this.postState();
      this.flushPendingPaste(tab);
    } catch (error) {
      tab.running = false;
      tab.exited = true;
      this.toastError(error);
      this.postState();
    } finally {
      if (sequence === tab.startSequence) {
        tab.starting = false;
      }
    }
  }

  private async stopTab(tab: ManagedTab): Promise<void> {
    tab.restarting += 1;
    try {
      await tab.service.stop();
    } finally {
      tab.restarting -= 1;
    }
  }

  private refreshProcessTitles(): void {
    if (this.disposed || !this.webviewReady) {
      return;
    }
    let changed = false;
    for (const tab of this.tabs.values()) {
      if (tab.running && this.syncTabProcessTitle(tab)) {
        changed = true;
      }
    }
    if (changed) {
      this.postState();
    }
  }

  private computeAutoTitle(tab: ManagedTab): string {
    // 1. OSC 633;E reports the command the user actually typed.
    if (tab.foregroundCommand) {
      const cmdTitle = normalizeProcessTitle(tab.foregroundCommand, '');
      if (cmdTitle) {
        return cmdTitle;
      }
    }
    // 2. The foreground process reported by the local PTY (POSIX only).
    const ptyProc = tab.service.processName;
    if (ptyProc) {
      const procTitle = normalizeProcessTitle(ptyProc, '');
      if (procTitle) {
        return procTitle;
      }
    }
    // 3. Window title from the shell/TUI itself.
    if (tab.xtermTitle) {
      const winTitle = normalizeProcessTitle(tab.xtermTitle, '');
      if (winTitle) {
        return winTitle;
      }
    }
    return this.defaultShellTitle();
  }

  private syncTabProcessTitle(tab: ManagedTab): boolean {
    const autoTitle = this.computeAutoTitle(tab);
    let changed = false;
    if (autoTitle !== tab.processHint) {
      tab.processHint = autoTitle;
      changed = true;
    }
    if (autoTitle !== tab.title) {
      tab.title = autoTitle;
      changed = true;
    }
    return changed;
  }

  private flushPendingPaste(tab: ManagedTab): void {
    if (!tab.running || !tab.pendingPaste.length) {
      return;
    }
    for (const text of tab.pendingPaste.splice(0)) {
      this.post({ type: 'terminal-paste', tabId: tab.id, text });
    }
    this.post({ type: 'toast', level: 'info', message: this.strings().contextAdded });
    if (this.activeTabId === tab.id) {
      this.post({ type: 'focus' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Notifications (long-running commands & TUI bell)                    */
  /* ------------------------------------------------------------------ */

  private handleCommandStarted(tabId: string, commandLine: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const prog = extractCommandProgram(commandLine);
    if (!prog) {
      return;
    }
    tab.foregroundCommand = prog;
    if (this.syncTabProcessTitle(tab)) {
      this.postState();
    }
  }

  private handleCommandFinished(tabId: string, durationMs: number, exitCode?: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const finishedTitle = tab.title;
    tab.foregroundCommand = undefined;
    // Also clear transient TUI window title when returning to prompt
    tab.xtermTitle = undefined;
    const titleChanged = this.syncTabProcessTitle(tab);

    const thresholdSec = this.config().longRunningThresholdSeconds;
    const shouldCheckNotify = thresholdSec > 0 && durationMs >= thresholdSec * 1000;
    const watching = Boolean(
      this.view?.visible && vscode.window.state.focused && tabId === this.activeTabId
    );

    if (!shouldCheckNotify || watching) {
      if (titleChanged) {
        this.postState();
      }
      return;
    }

    const failed = typeof exitCode === 'number' && exitCode !== 0;
    if (tabId !== this.activeTabId || !this.view?.visible) {
      tab.attention = failed ? 'warn' : 'done';
    }
    this.postState();

    const secs = `${(durationMs / 1000).toFixed(1)}s`;
    const strings = this.strings();
    const label = failed
      ? `${strings.longCommandFailed} (${finishedTitle}, exit ${exitCode}, ${secs})`
      : `${strings.longCommandDone} (${finishedTitle}, ${secs})`;
    const notify = failed
      ? vscode.window.showWarningMessage(label, strings.focusTerminal)
      : vscode.window.showInformationMessage(label, strings.focusTerminal);
    void notify.then((action) => {
      if (action === strings.focusTerminal) {
        void this.show().then(() => this.selectTab(tab.id));
      }
    });
  }

  private handleCwdChange(tabId: string, rawCwd: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const valid = resolveExistingDirectory(rawCwd);
    if (valid && valid !== tab.cwd) {
      tab.cwd = valid;
      this.postState();
    }
  }

  private handleBell(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const now = Date.now();
    if (now - tab.lastBellAt < BELL_COOLDOWN_MS) {
      return;
    }
    tab.lastBellAt = now;

    const watching = Boolean(
      this.view?.visible && vscode.window.state.focused && tabId === this.activeTabId
    );
    if (watching) {
      return;
    }
    if (tabId !== this.activeTabId || !this.view?.visible) {
      tab.attention = 'bell';
      this.postState();
    }
    const strings = this.strings();
    void vscode.window
      .showInformationMessage(`${strings.terminalBell} (${tab.title})`, strings.focusTerminal)
      .then((action) => {
        if (action === strings.focusTerminal) {
          void this.show().then(() => this.selectTab(tab.id));
        }
      });
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */

  private async onMessage(message: TerminalToHost): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        this.ensureInitialTab();
        this.postState('init');
        for (const tab of this.tabs.values()) {
          if (!tab.running && !tab.starting) {
            await this.startTab(tab);
          }
        }
        return;
      }
      case 'terminal-input': {
        // A stale explicit id must never redirect keystrokes into the active tab.
        this.resolveMessageTab(message.tabId)?.service.write(message.data);
        return;
      }
      case 'terminal-resize': {
        const cols = Math.max(20, message.cols);
        const rows = Math.max(5, message.rows);
        this.defaultCols = cols;
        this.defaultRows = rows;
        const tab = this.tabs.get(message.tabId);
        if (tab) {
          tab.cols = cols;
          tab.rows = rows;
          if (tab.running) {
            tab.service.resize(cols, rows);
          }
        }
        return;
      }
      case 'select-tab':
        await this.selectTab(message.tabId, { preserveFocus: message.preserveFocus === true });
        return;
      case 'close-tab':
        await this.closeTab(message.tabId);
        return;
      case 'close-other-tabs':
        await this.closeOtherTabs(message.tabId);
        return;
      case 'reorder-tabs':
        this.applyReorderTabs(message.tabIds);
        return;
      case 'new-session':
        await this.newSession();
        return;
      case 'restart':
        await this.restart(message.tabId);
        return;
      case 'open-path':
        await this.openPathTarget(message.path, message.line, message.column);
        return;
      case 'open-url':
        await this.openExternalUrl(message.url);
        return;
      case 'command-started':
        this.handleCommandStarted(message.tabId, message.command);
        return;
      case 'command-finished':
        this.handleCommandFinished(message.tabId, message.durationMs, message.exitCode);
        return;
      case 'cwd-change':
        this.handleCwdChange(message.tabId, message.cwd);
        return;
      case 'bell':
        this.handleBell(message.tabId);
        return;
      case 'title-change': {
        const tab = this.tabs.get(message.tabId);
        if (tab) {
          tab.xtermTitle = message.title;
          if (this.syncTabProcessTitle(tab)) {
            this.postState();
          }
        }
        return;
      }
      case 'paste-clipboard': {
        const text = await vscode.env.clipboard.readText();
        const tab = this.resolveMessageTab(message.tabId);
        if (text && tab) {
          this.post({ type: 'terminal-paste', tabId: tab.id, text });
        }
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        return;
    }
  }

  /**
   * Open a link target clicked in the terminal (OSC 8 hyperlink or plain-text
   * citation). Citation suffixes (`#L42`, `:42:8`, `(42,8)`) are stripped
   * here, and a failure is reported instead of silently doing nothing.
   */
  private async openPathTarget(
    raw: string,
    line?: number,
    column?: number
  ): Promise<void> {
    const target = splitLinkTarget(raw);
    if (!target.path) {
      return;
    }
    const cwd = this.activeTab()?.cwd ?? this.workspaceCwd();
    let outcome: OpenPathOutcome;
    try {
      outcome = normalizeOpenPathOutcome(
        await this.context.openPath(
          target.path,
          line ?? target.line,
          column ?? target.column,
          cwd
        )
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: 'toast', level: 'warn', message: `${target.path}: ${detail}` });
      return;
    }
    if (outcome !== 'missing') {
      // A cancelled outside-workspace confirmation is a deliberate choice, not
      // a failure, so it must not raise a toast.
      return;
    }
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    this.post({
      type: 'toast',
      level: 'warn',
      message: zh
        ? `无法打开 ${target.path}（文件不存在或不在工作区）`
        : `Could not open ${target.path} (missing file or outside the workspace)`
    });
  }

  private async openExternalUrl(raw: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return;
    }
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    } catch {
      // The OS has no handler for the scheme; keep the terminal responsive.
    }
  }

  private post(message: HostToTerminal): void {
    const view = this.view;
    if (!view) {
      return;
    }
    void Promise.resolve(view.webview.postMessage(message)).then(undefined, () => undefined);
  }

  private postState(kind: 'state' | 'init' = 'state'): void {
    this.stateSeq += 1;
    this.post({ type: kind, state: this.buildState(this.stateSeq) });
  }

  private buildState(seq: number): TerminalState {
    const cfg = this.config();
    const tabList: TerminalTabInfo[] = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title,
      processHint: tab.processHint,
      cwd: tab.cwd,
      running: tab.running,
      exited: tab.exited,
      exitCode: tab.exitCode,
      attention: tab.attention
    }));
    return {
      cwd: this.activeTab()?.cwd ?? this.workspaceCwd(),
      tabs: tabList,
      activeTabId: this.activeTabId,
      scrollback: cfg.scrollback,
      strings: this.strings(),
      seq
    };
  }

  private strings() {
    return getStrings(vscode.env.language);
  }

  private config(): RuntimeConfig {
    const config = vscode.workspace.getConfiguration('agentTerminal');
    return {
      scrollback: config.get<number>('terminal.scrollback', 5000),
      shellIntegration: config.get<boolean>('terminal.shellIntegration', true),
      longRunningThresholdSeconds: config.get<number>('terminal.longRunningThresholdSeconds', 10)
    };
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Queue a draft for the shell; it is pasted, never submitted. */
  private queuePaste(text: string, tab = this.ensureInitialTab()): void {
    if (!text) {
      return;
    }
    if (tab.pendingPaste.length > 0) {
      tab.pendingPaste[tab.pendingPaste.length - 1] += `\n${text}`;
    } else {
      tab.pendingPaste.push(text);
    }
    if (tab.running && this.webviewReady) {
      this.flushPendingPaste(tab);
      return;
    }
    this.post({ type: 'toast', level: 'info', message: this.strings().contextQueued });
    void this.show();
    if (this.webviewReady && !tab.starting && !tab.running) {
      void this.startTab(tab);
    }
  }

  private writeContextFile(
    kind: 'selection' | 'file',
    text: string,
    ext = '.txt'
  ): string | undefined {
    const dir = ensureContextDir();
    if (!dir) {
      return undefined;
    }
    try {
      const name = `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}${ext}`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Windows may ignore POSIX modes; mkdtemp is still user-private.
      }
      return file;
    } catch {
      return undefined;
    }
  }

  private toastError(error: unknown): void {
    this.post({
      type: 'toast',
      level: 'error',
      message: `${this.strings().errorPrefix}: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'webview', 'terminal.js')
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'webview', 'terminal.css')
    );
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`
    ].join('; ');
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${style}" />
    <title>TermMoor</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this.viewGeneration += 1;
    clearInterval(this.processPollTimer);
    for (const tab of this.tabs.values()) {
      tab.service.dispose();
    }
    this.tabs.clear();
    removeContextDir();
  }
}

/* ------------------------------------------------------------------ */
/* Private context temp directory & directory helpers                  */
/* ------------------------------------------------------------------ */

let contextDir: string | undefined;
let contextDirSwept = false;

function resolveExistingDirectory(candidate: string | undefined): string | undefined {
  if (!candidate || !candidate.trim()) {
    return undefined;
  }
  try {
    const resolved = path.resolve(candidate.trim());
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function ensureContextDir(): string | undefined {
  if (contextDir) {
    return contextDir;
  }
  try {
    sweepContextDirsOnce();
    contextDir = fs.mkdtempSync(path.join(os.tmpdir(), CONTEXT_TEMP_PREFIX));
    try {
      fs.chmodSync(contextDir, 0o700);
    } catch {
      // Windows may not support POSIX modes; mkdtemp is still user-private.
    }
    return contextDir;
  } catch {
    return undefined;
  }
}

function sweepContextDirsOnce(): void {
  if (contextDirSwept) {
    return;
  }
  contextDirSwept = true;
  cleanupStaleContextDirs();
}

function cleanupStaleContextDirs(): void {
  const cutoff = Date.now() - CONTEXT_TEMP_MAX_AGE_MS;
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(CONTEXT_TEMP_PREFIX)) {
      continue;
    }
    const dir = path.join(os.tmpdir(), name);
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // A live host may be writing there; leave it alone.
    }
  }
}

function removeContextDir(): void {
  const dir = contextDir;
  contextDir = undefined;
  if (!dir) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort; the stale sweep catches leftovers on the next start.
  }
}

/**
 * True when a PTY-reported process name is a shell sitting at its prompt.
 * Missing names (Windows never reports one) count as idle: only the OSC
 * integration can tell us about work there.
 */
function isIdleShellProcess(name: string | undefined): boolean {
  if (!name || !name.trim()) {
    return true;
  }
  const base = path
    .basename(name.trim())
    .replace(/^[-\s]+/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
  return IDLE_SHELL_NAMES.has(base);
}
