export interface TerminalStrings {
  appName: string;
  newTerminal: string;
  closeTerminal: string;
  closeOtherTerminals: string;
  restart: string;
  hint: string;
  terminalStarting: string;
  terminalExited: string;
  copy: string;
  paste: string;
  clearTerminal: string;
  find: string;
  findPlaceholder: string;
  findNoResults: string;
  findPrev: string;
  findNext: string;
  close: string;
  jumpedCommandBlock: string;
  noCommandBlocks: string;
  contextAdded: string;
  contextQueued: string;
  longCommandDone: string;
  longCommandFailed: string;
  terminalBell: string;
  focusTerminal: string;
  errorPrefix: string;
  attentionNeeded: string;
}

export interface TerminalTabInfo {
  id: string;
  title: string;
  /** Active foreground program hint so tab icons match the running Agent/CLI. */
  processHint?: string;
  /** Live working directory reported by shell integration. */
  cwd?: string;
  running: boolean;
  exited: boolean;
  exitCode?: number | null;
  /** Unread completion or bell badge for background tabs. */
  attention?: 'done' | 'warn' | 'bell';
}

export interface TerminalState {
  cwd: string;
  tabs: TerminalTabInfo[];
  activeTabId: string;
  scrollback: number;
  strings: TerminalStrings;
  /** Monotonic snapshot id; the webview drops older snapshots. */
  seq: number;
}

export type HostToTerminal =
  | { type: 'init'; state: TerminalState }
  | { type: 'state'; state: TerminalState }
  | { type: 'terminal-data'; tabId: string; data: string }
  | { type: 'terminal-paste'; tabId: string; text: string }
  | { type: 'terminal-reset'; tabId: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'focus' };

export type TerminalToHost =
  | { type: 'ready' }
  | { type: 'terminal-input'; tabId: string; data: string }
  | { type: 'terminal-resize'; tabId: string; cols: number; rows: number }
  | { type: 'select-tab'; tabId: string; preserveFocus?: boolean }
  | { type: 'close-tab'; tabId: string }
  | { type: 'close-other-tabs'; tabId: string }
  | { type: 'reorder-tabs'; tabIds: string[] }
  | { type: 'new-session' }
  | { type: 'restart'; tabId?: string }
  | { type: 'open-path'; path: string; line?: number; column?: number }
  | { type: 'open-url'; url: string }
  | { type: 'command-started'; tabId: string; command: string }
  | { type: 'command-finished'; tabId: string; durationMs: number; exitCode?: number }
  | { type: 'cwd-change'; tabId: string; cwd: string }
  | { type: 'bell'; tabId: string }
  | { type: 'title-change'; tabId: string; title: string }
  | { type: 'paste-clipboard'; tabId?: string }
  | { type: 'copy'; text: string };
