/**
 * Embedded xterm.js terminal for the sidebar webview.
 *
 * The terminal fills whatever element the shell hands us and never falls back
 * to a bottom panel: if the host PTY cannot start, the shell reports that as a
 * message inside this same view.
 */
// esbuild bundles the package stylesheet; TypeScript has no CSS module typings.
// @ts-ignore
import '@xterm/xterm/css/xterm.css';
import { Terminal, type IBufferCell, type IBufferLine, type ILink, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { findFileRefs } from '../fileRefs';
import { CommandBlockTracker, findAdjacentPromptLine, parseOsc633Payload } from './commandBlocks';
import { findBufferMatches, stepMatchIndex, type BufferSearchMatch } from './search';
import { wheelScrollLines } from './wheel';

export interface TerminalSearchResult {
  /** 1-based active match position, or 0 when there are no matches. */
  index: number;
  total: number;
}

export interface TerminalHandle {
  write(data: string): void;
  reset(): void;
  focus(): void;
  fit(): void;
  getSelection(): string;
  /** Find `query` in the buffer and select/scroll to the active match. */
  find(query: string, step?: 0 | 1 | -1): TerminalSearchResult;
  clearSearch(): void;
  /** Paste clipboard-style text: bracketed when the TUI asks for it. */
  paste(text: string): void;
  dispose(): void;
}

export interface TerminalMountOptions {
  scrollback: number;
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onOpenPath?(path: string, line?: number, column?: number): void;
  /** Open a URL found by the links addon; the host validates the scheme. */
  onOpenUrl?(url: string): void;
  /** Clipboard write fallback when the async Clipboard API is unavailable. */
  onCopy?(text: string): void;
  /** Clipboard read fallback; the host replies with `terminal-paste`. */
  onPasteClipboard?(): void;
  onToggleSearch?(): void;
  onSwitchTab?(delta: -1 | 1): void;
  onPromptJumped?(info: { jumped: boolean; index?: number; total: number }): void;
  onCommandStarted?(command: string): void;
  onCommandFinished?(event: { durationMs: number; exitCode?: number }): void;
  onCwdChange?(cwd: string): void;
  onBell?(): void;
  onTitleChange?(title: string): void;
}

const HOST_CLASS = 'codium-terminal-host';
const SCREEN_CLASS = 'codium-terminal-screen';
const STYLE_ID = 'codium-terminal-styles';

const DARK_ANSI: Record<string, string> = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
};

const LIGHT_ANSI: Record<string, string> = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
};

export function mountTerminal(container: HTMLElement, options: TerminalMountOptions): TerminalHandle {
  ensureStyles();

  const previousStyle = {
    height: container.style.height,
    width: container.style.width,
    minHeight: container.style.minHeight,
    minWidth: container.style.minWidth
  };
  container.classList.add(HOST_CLASS);
  container.style.height = '100%';
  container.style.width = '100%';
  container.style.minHeight = '0';
  container.style.minWidth = '0';

  const screen = document.createElement('div');
  screen.className = SCREEN_CLASS;
  container.appendChild(screen);

  const readVar = createVarReader(container);
  const theme = readTheme(readVar);
  const fontFamily = readFontFamily(readVar);
  const terminal = new Terminal({
    scrollback: normalizeScrollback(options.scrollback),
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily,
    fontSize: readFontSize(readVar),
    lineHeight: 1.1,
    letterSpacing: 0,
    theme,
    scrollOnUserInput: true,
    rightClickSelectsWord: false,
    smoothScrollDuration: 0,
    // The host PTY runs on Windows (PowerShell by default); ConPTY semantics
    // keep scrollback and resize behaviour consistent with VS Code.
    windowsPty: { backend: 'conpty' },
    // Agents and CLIs cite files as OSC 8 hyperlinks (`file:///E:/x/app.c#L42`).
    // xterm drops every non-HTTP OSC 8 link unless this is enabled, which made
    // clicking those citations do nothing at all.
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (event, text) => {
        event.preventDefault?.();
        if (/^(?:https?|mailto):/i.test(text)) {
          options.onOpenUrl?.(text);
          return;
        }
        options.onOpenPath?.(text);
      }
    }
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      // Webviews cannot `window.open`; hand the URL to the host, which
      // validates the scheme and calls `vscode.env.openExternal`.
      event.preventDefault?.();
      options.onOpenUrl?.(uri);
    })
  );

  terminal.open(screen);

  /**
   * Only an already-used terminal reclaims focus when the view becomes visible
   * again. A freshly mounted terminal (startup, background tab reveal, or a
   * background exit repaint) must never steal focus from the editor.
   */
  let everFocused = false;
  const onTextAreaFocus = (): void => {
    everFocused = true;
  };
  terminal.textarea?.addEventListener('focus', onTextAreaFocus);

  let disposed = false;
  let frame = 0;
  let lastCols = 0;
  let lastRows = 0;
  let shown = false;
  let pendingFocus = false;

  // Wheel scrolling:
  //  - Normal buffer: scroll xterm's scrollback directly.
  //  - Alternate buffer + mouse tracking (e.g. claude): let xterm forward mouse wheel sequences.
  //  - Alternate buffer without mouse tracking (e.g. pi, less): send PageUp/PageDown so wheel scrolls cleanly.
  terminal.attachCustomWheelEventHandler(() => {
    return terminal.buffer.active.type === 'alternate' && terminal.modes.mouseTrackingMode !== 'none';
  });
  let lastAltWheelAt = 0;
  screen.addEventListener(
    'wheel',
    (event) => {
      if (disposed || event.deltaY === 0) {
        return;
      }
      if (terminal.buffer.active.type === 'alternate') {
        if (terminal.modes.mouseTrackingMode !== 'none') {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastAltWheelAt < 50) {
          return;
        }
        lastAltWheelAt = now;
        const seq = event.deltaY < 0 ? '\x1b[5~' : '\x1b[6~';
        try {
          options.onData(seq);
        } catch {
          // ignore
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const lines = wheelScrollLines(event.deltaY, event.deltaMode, terminal.rows);
      if (lines !== 0) {
        terminal.scrollLines(lines);
      }
    },
    { passive: false }
  );

  // TUI replies print file paths as plain text (often with `:line` suffixes).
  // Register a link provider so those paths underline on hover and open in the
  // editor, matching the clickable citations in UI mode.
  const linkProviderDisposable = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      if (disposed || !options.onOpenPath) {
        callback(undefined);
        return;
      }
      const windowed = readWrappedWindow(terminal, bufferLineNumber - 1);
      const refs = windowed.text ? findFileRefs(windowed.text) : [];
      if (refs.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const item of refs) {
        const start = mapStringIndex(terminal, windowed.startLine, 0, item.start);
        const last = mapStringIndex(terminal, windowed.startLine, 0, item.end - 1);
        if (!start || !last) {
          continue;
        }
        const ref = item.ref;
        links.push({
          range: {
            start: { x: start.col + 1, y: start.line + 1 },
            end: { x: last.col + 1, y: last.line + 1 }
          },
          text: windowed.text.slice(item.start, item.end),
          decorations: { underline: true, pointerCursor: true },
          activate: (event: MouseEvent) => {
            event.preventDefault?.();
            options.onOpenPath?.(ref.path, ref.line, ref.column);
          }
        });
      }
      callback(links.length > 0 ? links : undefined);
    }
  });

  const dataDisposable = terminal.onData((data) => {
    if (disposed) {
      return;
    }
    try {
      options.onData(data);
    } catch {
      // The shell should never break the pty input path.
    }
  });

  // OSC 133 shell integration: track prompt boundaries and exact command output.
  const blockTracker = new CommandBlockTracker(() => {
    if (disposed) {
      return undefined;
    }
    try {
      return terminal.registerMarker(0);
    } catch {
      return undefined;
    }
  });
  let lastJumpLine: number | null = null;

  const osc133Disposable = terminal.parser.registerOscHandler(133, (data) => {
    if (disposed) {
      return false;
    }
    const completed = blockTracker.handleOsc133(data);
    if (completed) {
      options.onCommandFinished?.({
        durationMs: completed.durationMs,
        exitCode: completed.exitCode
      });
    }
    return true;
  });

  const osc633Disposable = terminal.parser.registerOscHandler(633, (data) => {
    if (disposed) {
      return false;
    }
    const ev = parseOsc633Payload(data);
    if (ev?.kind === 'command') {
      options.onCommandStarted?.(ev.command);
    } else if (ev?.kind === 'cwd') {
      options.onCwdChange?.(ev.cwd);
    }
    return true;
  });

  const bellDisposable = terminal.onBell(() => {
    if (!disposed) {
      options.onBell?.();
    }
  });

  const titleDisposable = terminal.onTitleChange((title) => {
    if (!disposed && title) {
      options.onTitleChange?.(title);
    }
  });

  // Search state per terminal tab.
  let lastSearchQuery = '';
  let searchMatches: BufferSearchMatch[] = [];
  let searchIndex = -1;

  function applySearchMatch(match: BufferSearchMatch): void {
    const startCell = mapStringIndex(terminal, match.line, 0, match.startOffset);
    const endCell = mapStringIndex(
      terminal,
      match.line,
      0,
      Math.max(match.startOffset, match.startOffset + match.length - 1)
    );
    const bufferLine = terminal.buffer.active.getLine(match.line);
    let cellSpan = match.length;
    if (startCell && endCell && startCell.line === endCell.line && bufferLine) {
      const cell = terminal.buffer.active.getNullCell();
      bufferLine.getCell(endCell.col, cell);
      const endWidth = Math.max(1, cell.getWidth());
      cellSpan = Math.max(1, endCell.col - startCell.col + endWidth);
    }
    if (startCell) {
      terminal.select(startCell.col, startCell.line, cellSpan);
    }
    const targetScroll = Math.max(0, match.line - Math.floor(terminal.rows / 3));
    terminal.scrollToLine(targetScroll);
  }

  function performJumpToPrompt(direction: -1 | 1): {
    jumped: boolean;
    index?: number;
    total: number;
  } {
    if (disposed || terminal.buffer.active.type === 'alternate') {
      return { jumped: false, total: 0 };
    }
    const prompts = blockTracker.promptLines();
    if (prompts.length === 0) {
      return { jumped: false, total: 0 };
    }
    const viewportY = terminal.buffer.active.viewportY;
    const ref =
      lastJumpLine !== null && Math.abs(lastJumpLine - viewportY) <= terminal.rows
        ? lastJumpLine
        : direction < 0
          ? viewportY + Math.min(2, terminal.rows - 1)
          : viewportY;
    const target = findAdjacentPromptLine(prompts, ref, direction);
    if (target === undefined) {
      return { jumped: false, total: prompts.length };
    }
    lastJumpLine = target;
    terminal.scrollToLine(Math.max(0, target));
    const idx = prompts.indexOf(target);
    return { jumped: true, index: idx >= 0 ? idx + 1 : undefined, total: prompts.length };
  }

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');

  /** `navigator.clipboard` can throw on access in locked-down webviews. */
  function clipboardApi(): Clipboard | undefined {
    try {
      return navigator.clipboard;
    } catch {
      return undefined;
    }
  }

  function writeClipboard(text: string): void {
    if (!text) {
      return;
    }
    const api = clipboardApi();
    if (api?.writeText) {
      try {
        void api.writeText(text).catch(() => options.onCopy?.(text));
        return;
      } catch {
        // Fall through to the host.
      }
    }
    options.onCopy?.(text);
  }

  function pasteText(text: string): void {
    if (disposed || !text) {
      return;
    }
    try {
      if (terminal.modes.bracketedPasteMode) {
        // xterm wraps the payload in `ESC[200~`/`ESC[201~` and normalizes
        // newlines, so the TUI receives it as text instead of a submit.
        terminal.paste(text);
      } else {
        // Without bracketed paste a raw newline is Enter for many shells/TUIs,
        // so flatten the draft onto one line.
        const singleLine = text.replace(/\r\n|[\r\n\t]/g, ' ');
        terminal.input(singleLine);
      }
    } catch {
      // Paste is best effort.
    }
  }

  function requestPaste(): void {
    const api = clipboardApi();
    if (api?.readText) {
      try {
        api.readText().then(
          (text) => {
            if (text) {
              pasteText(text);
            }
          },
          () => options.onPasteClipboard?.()
        );
        return;
      } catch {
        // Fall through to the host.
      }
    }
    options.onPasteClipboard?.();
  }

  terminal.attachCustomKeyEventHandler((event) => {
    if (disposed || event.type !== 'keydown') {
      return true;
    }
    const accel = isMac ? event.metaKey : event.ctrlKey;

    // Ctrl+PageUp / Ctrl+PageDown: switch terminal tabs
    if (event.ctrlKey && !event.shiftKey && !event.altKey) {
      if (event.key === 'PageUp') {
        event.preventDefault();
        options.onSwitchTab?.(-1);
        return false;
      }
      if (event.key === 'PageDown') {
        event.preventDefault();
        options.onSwitchTab?.(1);
        return false;
      }
    }

    // Ctrl/Cmd+Alt chords stay with the browser/host.
    if (!accel || event.altKey) {
      return true;
    }

    // Ctrl/Cmd+Up / Down: jump between OSC 133 command prompt blocks in normal buffer
    if (!event.shiftKey && terminal.buffer.active.type !== 'alternate') {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const res = performJumpToPrompt(-1);
        options.onPromptJumped?.(res);
        return false;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const res = performJumpToPrompt(1);
        options.onPromptJumped?.(res);
        return false;
      }
    }

    const key = event.key.toLowerCase();
    if (key === 'c') {
      if (event.shiftKey || terminal.hasSelection()) {
        event.preventDefault();
        writeClipboard(terminal.getSelection());
        return false;
      }
      return true;
    }
    if (key === 'v' && event.shiftKey) {
      event.preventDefault();
      requestPaste();
      return false;
    }
    // Search: Ctrl/Cmd+Shift+F anywhere, or Ctrl/Cmd+F in normal shell buffer
    // (leaving Ctrl+F intact for page-down inside alternate-screen vim/less).
    if (key === 'f' && (event.shiftKey || terminal.buffer.active.type !== 'alternate')) {
      event.preventDefault();
      event.stopPropagation();
      options.onToggleSearch?.();
      return false;
    }
    return true;
  });

  function reportSize(): void {
    if (terminal.cols === lastCols && terminal.rows === lastRows) {
      return;
    }
    lastCols = terminal.cols;
    lastRows = terminal.rows;
    const size = sanitizeSize(lastCols, lastRows);
    if (!size) {
      return;
    }
    try {
      options.onResize(size.cols, size.rows);
    } catch {
      // ignore listener failures
    }
  }

  function fitNow(): void {
    if (disposed || !isShown(container)) {
      return;
    }
    try {
      fitAddon.fit();
    } catch {
      // xterm throws while the renderer has no metrics yet; a later resize retries.
      return;
    }
    reportSize();
  }

  function scheduleFit(): void {
    if (disposed || frame !== 0) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) {
        return;
      }
      if (!isShown(container)) {
        shown = false;
        return;
      }
      fitNow();
      if (pendingFocus) {
        pendingFocus = false;
        try {
          terminal.focus();
        } catch {
          // focus is best effort
        }
      }
    });
  }

  function handleViewportChange(): void {
    if (disposed) {
      return;
    }
    const visible = isShown(container);
    if (visible && !shown) {
      // Hidden -> visible: layout is still stale in this tick, so fit (and
      // restore focus only for a terminal the user already focused).
      shown = true;
      pendingFocus = everFocused;
      scheduleFit();
      return;
    }
    if (!visible) {
      shown = false;
      return;
    }
    scheduleFit();
  }

  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => handleViewportChange())
      : null;
  resizeObserver?.observe(container);
  resizeObserver?.observe(screen);

  // IntersectionObserver catches display: none / detached-panel transitions.
  const intersectionObserver =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(() => handleViewportChange(), { threshold: 0 })
      : null;
  intersectionObserver?.observe(container);

  // The sidebar toggles style/class on ancestors (display, width) more often
  // than it resizes the container itself, so watch a few levels up as well.
  const mutationObserver =
    typeof MutationObserver !== 'undefined' ? new MutationObserver(() => handleViewportChange()) : null;
  if (mutationObserver) {
    let node: HTMLElement | null = container;
    for (let depth = 0; node && depth < 4; depth += 1) {
      mutationObserver.observe(node, {
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      });
      node = node.parentElement;
    }
  }

  const onWindowResize = (): void => handleViewportChange();
  window.addEventListener('resize', onWindowResize, { passive: true });
  const onVisibilityChange = (): void => handleViewportChange();
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => handleViewportChange()).catch(() => undefined);
  }

  // First layout pass.
  handleViewportChange();

  return {
    write(data: string): void {
      if (disposed || typeof data !== 'string' || data.length === 0) {
        return;
      }
      terminal.write(data);
    },
    reset(): void {
      if (disposed) {
        return;
      }
      blockTracker.reset();
      lastJumpLine = null;
      lastSearchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      terminal.reset();
      scheduleFit();
    },
    focus(): void {
      if (disposed) {
        return;
      }
      everFocused = true;
      try {
        terminal.focus();
      } catch {
        // ignore
      }
    },
    fit(): void {
      if (disposed) {
        return;
      }
      if (!isShown(container)) {
        handleViewportChange();
        return;
      }
      fitNow();
    },
    getSelection(): string {
      return disposed ? '' : terminal.getSelection();
    },
    find(query: string, step: 0 | 1 | -1 = 0): TerminalSearchResult {
      if (disposed || !query) {
        lastSearchQuery = '';
        searchMatches = [];
        searchIndex = -1;
        terminal.clearSelection();
        return { index: 0, total: 0 };
      }
      const buffer = terminal.buffer.active;
      if (step === 0 || query !== lastSearchQuery) {
        lastSearchQuery = query;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i += 1) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        }
        searchMatches = findBufferMatches(lines, query);
        // Default to the bottom-most match so recent terminal output is surfaced first.
        searchIndex = searchMatches.length > 0 ? searchMatches.length - 1 : -1;
      } else {
        searchIndex = stepMatchIndex(searchIndex, searchMatches.length, step);
      }
      if (searchIndex < 0 || searchMatches.length === 0) {
        terminal.clearSelection();
        return { index: 0, total: 0 };
      }
      applySearchMatch(searchMatches[searchIndex]);
      return { index: searchIndex + 1, total: searchMatches.length };
    },
    clearSearch(): void {
      if (disposed) {
        return;
      }
      lastSearchQuery = '';
      searchMatches = [];
      searchIndex = -1;
      terminal.clearSelection();
    },
    paste(text: string): void {
      pasteText(text);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      blockTracker.reset();
      osc133Disposable.dispose();
      osc633Disposable.dispose();
      bellDisposable.dispose();
      titleDisposable.dispose();
      linkProviderDisposable.dispose();
      dataDisposable.dispose();
      terminal.textarea?.removeEventListener('focus', onTextAreaFocus);
      terminal.dispose();
      screen.remove();
      container.classList.remove(HOST_CLASS);
      container.style.height = previousStyle.height;
      container.style.width = previousStyle.width;
      container.style.minHeight = previousStyle.minHeight;
      container.style.minWidth = previousStyle.minWidth;
    }
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Join a buffer line with its wrapped neighbours. TUI output in a narrow
 * sidebar wraps long paths; scanning the logical line keeps them clickable.
 */
function readWrappedWindow(
  terminal: Terminal,
  lineIndex: number
): { text: string; startLine: number } {
  const buffer = terminal.buffer.active;
  const base = buffer.getLine(lineIndex);
  if (!base) {
    return { text: '', startLine: lineIndex };
  }
  const parts: string[] = [];
  let start = lineIndex;
  let current = base;
  while (current.isWrapped && parts.length < 64) {
    const previous = buffer.getLine(start - 1);
    if (!previous) {
      break;
    }
    start -= 1;
    current = previous;
    parts.unshift(previous.translateToString(true));
  }
  parts.push(base.translateToString(true));
  let end = lineIndex;
  let next = buffer.getLine(end + 1);
  while (next?.isWrapped && parts.length < 64) {
    parts.push(next.translateToString(true));
    end += 1;
    next = buffer.getLine(end + 1);
  }
  return { text: parts.join(''), startLine: start };
}

/** Number of cells that contain the right-trimmed text of a line. */
function textCellLimit(line: IBufferLine, textLength: number, cell: IBufferCell): number {
  if (textLength <= 0) {
    return 0;
  }
  let chars = 0;
  let cells = 0;
  while (cells < line.length && chars < textLength) {
    line.getCell(cells, cell);
    if (cell.getWidth()) {
      chars += cell.getChars().length || 1;
    }
    cells += 1;
  }
  return cells;
}

/** Map a string offset in a windowed line back to a buffer cell. */
function mapStringIndex(
  terminal: Terminal,
  startLine: number,
  startColumn: number,
  offset: number
): { line: number; col: number } | null {
  if (offset < 0) {
    return null;
  }
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let line = startLine;
  let col = startColumn;
  let remaining = offset;
  while (remaining >= 0) {
    const bufferLine = buffer.getLine(line);
    if (!bufferLine) {
      return null;
    }
    // Only count cells that survive right-trimming; otherwise trailing blank
    // cells on a wrapped line would shift the offset onto the wrong row. Wide
    // characters occupy two cells but one string unit, so walk the cells until
    // the trimmed text length is covered instead of using the cell count.
    const lineText = bufferLine.translateToString(true);
    const limit = textCellLimit(bufferLine, lineText.length, cell);
    for (let x = col; x < limit; x += 1) {
      bufferLine.getCell(x, cell);
      if (cell.getWidth()) {
        remaining -= cell.getChars().length || 1;
        if (remaining < 0) {
          return { line, col: x };
        }
      }
    }
    line += 1;
    col = 0;
  }
  return null;
}

function normalizeScrollback(value: number): number {
  if (!Number.isFinite(value)) {
    return 1000;
  }
  return Math.max(0, Math.floor(value));
}

/** Monospace stack that also covers Chinese glyphs on Windows. */
const FALLBACK_FONT_FAMILY =
  '"Cascadia Mono", Consolas, "Microsoft YaHei UI", "Courier New", monospace';

function readFontFamily(readVar: VarReader): string {
  const configured = readVar(['--vscode-editor-font-family']);
  if (!configured) {
    return FALLBACK_FONT_FAMILY;
  }
  return `${configured}, "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`;
}

function readFontSize(readVar: VarReader): number {
  const raw = readVar(['--vscode-editor-font-size']);
  const value = raw ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    return 12;
  }
  return Math.min(32, Math.max(8, Math.round(value)));
}

/** Reject NaN/infinity and absurd sizes before they reach the pty. */
function sanitizeSize(cols: number, rows: number): { cols: number; rows: number } | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null;
  }
  const safeCols = Math.floor(cols);
  const safeRows = Math.floor(rows);
  if (safeCols < 20 || safeCols > 500 || safeRows < 5 || safeRows > 300) {
    return null;
  }
  return { cols: safeCols, rows: safeRows };
}

function isShown(container: HTMLElement): boolean {
  if (!container.isConnected) {
    return false;
  }
  const style = window.getComputedStyle(container);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  if (container.clientWidth <= 0 || container.clientHeight <= 0) {
    return false;
  }
  return container.getClientRects().length > 0;
}

type VarReader = (names: string[]) => string | undefined;

/**
 * Reads VS Code theme variables once per mount. `getComputedStyle` forces a
 * style recalc, so the terminal theme (20+ lookups) shares one pair of
 * computed-style snapshots.
 */
function createVarReader(element: HTMLElement): VarReader {
  const local = window.getComputedStyle(element);
  const root = window.getComputedStyle(document.documentElement);
  return (names) => {
    for (const name of names) {
      const localValue = local.getPropertyValue(name).trim();
      if (localValue) {
        return localValue;
      }
      const rootValue = root.getPropertyValue(name).trim();
      if (rootValue) {
        return rootValue;
      }
    }
    return undefined;
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string | undefined): Rgb | null {
  if (!value) {
    return null;
  }
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const r = parseInt(digits[0] + digits[0], 16);
      const g = parseInt(digits[1] + digits[1], 16);
      const b = parseInt(digits[2] + digits[2], 16);
      const a = digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = parseInt(digits.slice(0, 2), 16);
      const g = parseInt(digits.slice(2, 4), 16);
      const b = parseInt(digits.slice(4, 6), 16);
      const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: parts.length > 3 ? parts[3] : 1
      };
    }
  }
  return null;
}

/** WCAG relative luminance, used only to decide which fallback palette fits. */
function isDarkColor(value: string | undefined): boolean {
  const rgb = parseColor(value);
  if (!rgb) {
    return true;
  }
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  return luminance < 0.5;
}

function readTheme(readVar: VarReader): ITheme {
  const background =
    readVar(['--vscode-terminal-background', '--vscode-panel-background', '--vscode-editor-background']) ??
    '#1e1e1e';
  const foreground = readVar(['--vscode-terminal-foreground', '--vscode-editor-foreground']) ?? '#cccccc';
  const palette = isDarkColor(background) ? DARK_ANSI : LIGHT_ANSI;
  const pick = (fallback: string, ...names: string[]): string => readVar(names) ?? fallback;

  return {
    background,
    foreground,
    cursor: pick(foreground, '--vscode-terminalCursor-foreground', '--vscode-editorCursor-foreground'),
    cursorAccent: background,
    selectionBackground: pick(
      isDarkColor(background) ? '#264f78' : '#add6ff',
      '--vscode-terminal-selectionBackground',
      '--vscode-editor-selectionBackground'
    ),
    selectionForeground: readVar(['--vscode-terminal-selectionForeground']),
    selectionInactiveBackground: readVar(['--vscode-terminal-inactiveSelectionBackground']),
    black: pick(palette.black, '--vscode-terminal-ansiBlack'),
    red: pick(palette.red, '--vscode-terminal-ansiRed'),
    green: pick(palette.green, '--vscode-terminal-ansiGreen'),
    yellow: pick(palette.yellow, '--vscode-terminal-ansiYellow'),
    blue: pick(palette.blue, '--vscode-terminal-ansiBlue'),
    magenta: pick(palette.magenta, '--vscode-terminal-ansiMagenta'),
    cyan: pick(palette.cyan, '--vscode-terminal-ansiCyan'),
    white: pick(palette.white, '--vscode-terminal-ansiWhite'),
    brightBlack: pick(palette.brightBlack, '--vscode-terminal-ansiBrightBlack'),
    brightRed: pick(palette.brightRed, '--vscode-terminal-ansiBrightRed'),
    brightGreen: pick(palette.brightGreen, '--vscode-terminal-ansiBrightGreen'),
    brightYellow: pick(palette.brightYellow, '--vscode-terminal-ansiBrightYellow'),
    brightBlue: pick(palette.brightBlue, '--vscode-terminal-ansiBrightBlue'),
    brightMagenta: pick(palette.brightMagenta, '--vscode-terminal-ansiBrightMagenta'),
    brightCyan: pick(palette.brightCyan, '--vscode-terminal-ansiBrightCyan'),
    brightWhite: pick(palette.brightWhite, '--vscode-terminal-ansiBrightWhite')
  };
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${HOST_CLASS} {
  display: block;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.${SCREEN_CLASS} {
  position: relative;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.${SCREEN_CLASS} .xterm {
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
}

.${SCREEN_CLASS} .xterm .xterm-viewport {
  /* Keep xterm's own scrolling but never show scrollbar chrome. */
  overflow-y: scroll !important;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.${SCREEN_CLASS} .xterm .xterm-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.${SCREEN_CLASS} .xterm .xterm-screen {
  overflow: hidden;
}
`;
  document.head.appendChild(style);
}
