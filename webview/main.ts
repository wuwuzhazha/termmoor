import './style.css';
import { tabIconSvg } from './tabIcon';
import { mountTerminal, type TerminalHandle } from './terminal/TerminalView';
import type {
  HostToTerminal,
  TerminalState,
  TerminalTabInfo,
  TerminalToHost
} from '../src/shared/terminalProtocol';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

const root = document.getElementById('root')!;
root.innerHTML = `
  <div class="app">
    <div class="tab-bar" id="tab-bar">
      <div class="tab-list" id="tab-list" role="tablist" aria-orientation="horizontal"></div>
      <button type="button" class="tab-add" id="tab-add" aria-label="New terminal">+</button>
    </div>
    <div class="search-row" id="search-bar" role="search" hidden>
      <input
        type="text"
        id="search-input"
        spellcheck="false"
        autocomplete="off"
        aria-label="Find in terminal"
      />
      <span class="search-count" id="search-count" aria-live="polite" aria-atomic="true">0/0</span>
      <button type="button" class="mini-btn" id="search-prev" aria-label="Previous match">↑</button>
      <button type="button" class="mini-btn" id="search-next" aria-label="Next match">↓</button>
      <button type="button" class="mini-btn" id="search-close" aria-label="Close search">×</button>
    </div>
    <div class="terminal-wrap" id="terminal-wrap">
      <div class="terminal-stack" id="terminal-stack"></div>
      <div class="exited" id="exited" hidden>
        <div id="exited-text" role="status" aria-live="polite"></div>
        <button type="button" id="exited-restart"></button>
      </div>
    </div>
    <footer class="hint" id="hint">
      <span class="hint-text" id="hint-text"></span>
    </footer>
    <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true" hidden></div>
    <div class="menu" id="menu" hidden></div>
  </div>
`;

const tabBarEl = document.getElementById('tab-bar') as HTMLElement;
const tabListEl = document.getElementById('tab-list') as HTMLElement;
const tabAddEl = document.getElementById('tab-add') as HTMLButtonElement;
const terminalWrap = document.getElementById('terminal-wrap') as HTMLElement;
const terminalStack = document.getElementById('terminal-stack') as HTMLElement;
const searchBarEl = document.getElementById('search-bar') as HTMLElement;
const searchInputEl = document.getElementById('search-input') as HTMLInputElement;
const searchCountEl = document.getElementById('search-count') as HTMLElement;
const searchPrevEl = document.getElementById('search-prev') as HTMLButtonElement;
const searchNextEl = document.getElementById('search-next') as HTMLButtonElement;
const searchCloseEl = document.getElementById('search-close') as HTMLButtonElement;
const exitedEl = document.getElementById('exited') as HTMLElement;
const exitedText = document.getElementById('exited-text') as HTMLElement;
const exitedRestart = document.getElementById('exited-restart') as HTMLButtonElement;
const hintEl = document.getElementById('hint-text') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const menuEl = document.getElementById('menu') as HTMLElement;

interface PaneInstance {
  id: string;
  el: HTMLElement;
  handle: TerminalHandle;
}

let state: TerminalState | undefined;
const panes = new Map<string, PaneInstance>();
const queuedDataByTab = new Map<string, string[]>();
let toastTimer = 0;
let lastSeq = -1;
/**
 * Owner of the tablist's single tab stop. It normally mirrors the active tab,
 * but follows roving keyboard focus while the user arrows through the strip so
 * a background state refresh cannot move the tab stop away.
 */
let rovingTabId: string | null = null;
let lastActiveTabId: string | null = null;
/** Set only for user-initiated switches that should hand focus to xterm. */
let pendingFocusTabId: string | null = null;
let draggingTab = false;
let suppressTabClickUntil = 0;
/**
 * An in-flight pointer reorder session. Unlike `draggingTab` it exists from the
 * very first `pointerdown`, so a background `renderTabBar` rebuild cannot
 * destroy the captured pill mid-drag.
 */
let pointerDragSession: {
  tabId: string;
  pointerId: number;
  startX: number;
  moved: boolean;
} | null = null;
let pointerDragListenerCleanup: (() => void) | null = null;

function post(message: TerminalToHost): void {
  vscode.postMessage(message);
}

function tabButtonId(tabId: string): string {
  return `tab-${tabId}`;
}

function tabPanelId(tabId: string): string {
  return `tabpanel-${tabId}`;
}

function findPill(tabId: string): HTMLElement | null {
  const pills = tabListEl.querySelectorAll<HTMLElement>('.tab-pill');
  for (const pill of Array.from(pills)) {
    if (pill.dataset.tabId === tabId) {
      return pill;
    }
  }
  return null;
}

/** True when nothing owns focus (startup, or the focused node was removed). */
function focusIsIdle(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    !active.isConnected
  );
}

/**
 * Restore focus only when no explicit control claimed it. Actions that open an
 * input (search row, host QuickPick) keep their own focus.
 */
function restoreFocusIfIdle(target: HTMLElement | null): void {
  if (!focusIsIdle()) {
    return;
  }
  if (target?.isConnected) {
    target.focus();
    return;
  }
  activePane()?.handle.focus();
}

function activePane(): PaneInstance | undefined {
  if (!state) {
    return undefined;
  }
  return panes.get(state.activeTabId) ?? panes.values().next().value;
}

function activeTabMeta(): TerminalTabInfo | undefined {
  if (!state) {
    return undefined;
  }
  return state.tabs.find((tab) => tab.id === state!.activeTabId) ?? state.tabs[0];
}

function ensurePane(tabId: string, scrollback: number): PaneInstance {
  const existing = panes.get(tabId);
  if (existing) {
    return existing;
  }
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.dataset.tabId = tabId;
  // Each pane is the tabpanel paired with its role="tab" button in the strip.
  // `tabIndex = -1` keeps xterm's textarea as the only typing target.
  paneEl.setAttribute('role', 'tabpanel');
  paneEl.tabIndex = -1;
  paneEl.id = tabPanelId(tabId);
  terminalStack.appendChild(paneEl);

  const handle = mountTerminal(paneEl, {
    scrollback,
    onData: (data) => post({ type: 'terminal-input', tabId, data }),
    onResize: (cols, rows) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
        return;
      }
      const safeCols = Math.floor(cols);
      const safeRows = Math.floor(rows);
      if (safeCols < 20 || safeCols > 500 || safeRows < 5 || safeRows > 300) {
        return;
      }
      post({ type: 'terminal-resize', tabId, cols: safeCols, rows: safeRows });
    },
    onOpenPath: (path, line, column) => post({ type: 'open-path', path, line, column }),
    onOpenUrl: (url) => post({ type: 'open-url', url }),
    onCopy: (text) => post({ type: 'copy', text }),
    onPasteClipboard: () => post({ type: 'paste-clipboard' }),
    onToggleSearch: () => toggleSearch(true),
    onSwitchTab: (delta) => cycleTab(delta),
    onPromptJumped: (info) => {
      const strings = state?.strings;
      if (!info.jumped) {
        showToast(strings?.noCommandBlocks ?? 'No recorded command blocks yet.', 'info');
      } else if (info.index !== undefined) {
        showToast(
          `${strings?.jumpedCommandBlock ?? 'Command'} ${info.index}/${info.total}`,
          'info'
        );
      }
    },
    onCommandStarted: (command) => post({ type: 'command-started', tabId, command }),
    onCommandFinished: (ev) =>
      post({
        type: 'command-finished',
        tabId,
        durationMs: ev.durationMs,
        exitCode: ev.exitCode
      }),
    onCwdChange: (cwd) => post({ type: 'cwd-change', tabId, cwd }),
    onBell: () => post({ type: 'bell', tabId }),
    onTitleChange: (title) => post({ type: 'title-change', tabId, title })
  });

  const queued = queuedDataByTab.get(tabId);
  if (queued) {
    for (const chunk of queued) {
      handle.write(chunk);
    }
    queuedDataByTab.delete(tabId);
  }

  const created: PaneInstance = { id: tabId, el: paneEl, handle };
  panes.set(tabId, created);
  return created;
}

function syncTabs(current: TerminalState): void {
  const validIds = new Set(current.tabs.map((t) => t.id));
  if (pendingFocusTabId && !validIds.has(pendingFocusTabId)) {
    pendingFocusTabId = null;
  }
  for (const [id, inst] of panes.entries()) {
    if (!validIds.has(id)) {
      inst.handle.dispose();
      inst.el.remove();
      panes.delete(id);
      queuedDataByTab.delete(id);
    }
  }

  for (const tab of current.tabs) {
    const pane = ensurePane(tab.id, current.scrollback);
    const isActive = tab.id === current.activeTabId;
    const wasHidden = pane.el.hidden;
    pane.el.hidden = !isActive;
    pane.el.setAttribute('aria-labelledby', tabButtonId(tab.id));
    pane.el.setAttribute('aria-label', tab.title);
    if (isActive && wasHidden) {
      // Keep the existing scrollback/rendered output visible: only refit the
      // newly revealed pane, and hand it focus when the switch was explicitly
      // user-initiated. Startup renders and background exits never autofocus.
      pane.handle.fit();
      if (pendingFocusTabId === tab.id) {
        pendingFocusTabId = null;
        pane.handle.focus();
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tab bar: pointer drag-to-reorder and tab context menu               */
/* ------------------------------------------------------------------ */

interface TabBarFocusTarget {
  kind: 'tab' | 'close' | 'add';
  tabId?: string;
}

/**
 * Snapshot of the focused control inside the strip. `renderTabBar` rebuilds its
 * HTML on every state/status refresh, so keyboard focus has to be put back on
 * the same control afterwards instead of silently falling back to `<body>`.
 */
function captureTabBarFocus(): TabBarFocusTarget | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !tabBarEl.contains(active)) {
    return null;
  }
  if (active === tabAddEl) {
    return { kind: 'add' };
  }
  const pill = active.closest<HTMLElement>('.tab-pill');
  const tabId = pill?.dataset.tabId;
  if (!pill || !tabId) {
    return null;
  }
  return { kind: active.classList.contains('tab-close') ? 'close' : 'tab', tabId };
}

function restoreTabBarFocus(target: TabBarFocusTarget | null, current: TerminalState): void {
  if (!target) {
    return;
  }
  if (target.kind === 'add') {
    tabAddEl.focus({ preventScroll: true });
    return;
  }
  const tabId = target.tabId ?? '';
  const stillThere = current.tabs.some((tab) => tab.id === tabId);
  // A closed tab hands keyboard focus to the newly active tab (VS Code parity).
  const focusTabId = stillThere ? tabId : current.activeTabId;
  const pill = findPill(focusTabId);
  if (!pill) {
    return;
  }
  const closeBtn =
    target.kind === 'close' && stillThere && focusTabId === current.activeTabId
      ? pill.querySelector<HTMLButtonElement>('.tab-close')
      : null;
  (closeBtn ?? pill.querySelector<HTMLButtonElement>('.tab-label'))?.focus({
    preventScroll: true
  });
}

function renderTabBar(current: TerminalState): void {
  if (draggingTab || pointerDragSession) {
    return;
  }

  const capturedFocus = captureTabBarFocus();

  // The compact add button stays visible even with a single terminal, so the
  // strip is only hidden when there is genuinely nothing to show.
  tabBarEl.hidden = current.tabs.length === 0;
  tabListEl.setAttribute('aria-label', current.strings.appName);
  tabAddEl.title = current.strings.newTerminal;
  tabAddEl.setAttribute('aria-label', current.strings.newTerminal);
  tabListEl.innerHTML = '';

  if (current.activeTabId !== lastActiveTabId) {
    lastActiveTabId = current.activeTabId;
    rovingTabId = current.activeTabId;
  }
  // Exactly one tab stop: the current tab, or the tab the user is arrowing
  // through until the host confirms the new active tab.
  const rovingId =
    rovingTabId && current.tabs.some((tab) => tab.id === rovingTabId)
      ? rovingTabId
      : current.activeTabId;
  rovingTabId = rovingId;

  current.tabs.forEach((tab, idx) => {
    const isActive = tab.id === current.activeTabId;
    const pill = document.createElement('div');
    pill.className = `tab-pill${isActive ? ' active' : ''}${tab.exited ? ' exited-tab' : ''}`;
    pill.dataset.tabId = tab.id;
    pill.setAttribute('role', 'presentation');

    const tooltipLines = [`${idx + 1}. ${tab.title}`];
    if (tab.cwd) {
      tooltipLines.push(tab.cwd);
    }
    pill.title = tooltipLines.join('\n');

    // The primary tab control: a real button, so it is focusable, announced as
    // a tab, and the strip's only tab stop for the current tab.
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.id = tabButtonId(tab.id);
    tabBtn.className = 'tab-label';
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', String(isActive));
    tabBtn.setAttribute('aria-controls', tabPanelId(tab.id));
    tabBtn.tabIndex = tab.id === rovingId ? 0 : -1;
    tabBtn.title = pill.title;
    tabBtn.setAttribute(
      'aria-label',
      [`${idx + 1}. ${tab.title}`, tab.exited ? current.strings.terminalExited : '', tab.attention ? current.strings.attentionNeeded : ''].filter(Boolean).join(', ')
    );
    tabBtn.addEventListener('click', (ev) => {
      if (Date.now() < suppressTabClickUntil) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      selectTabFromUi(tab.id);
    });

    const numBadge = document.createElement('span');
    numBadge.className = 'tab-num';
    numBadge.setAttribute('aria-hidden', 'true');
    numBadge.textContent = String(idx + 1);
    tabBtn.appendChild(numBadge);

    if (tab.attention) {
      const dot = document.createElement('span');
      dot.className = `tab-dot ${tab.attention}`;
      dot.setAttribute('aria-hidden', 'true');
      tabBtn.appendChild(dot);
    }

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tab-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.innerHTML = tabIconSvg(tab.title, tab.processHint);
    tabBtn.appendChild(iconWrap);

    const textSpan = document.createElement('span');
    textSpan.className = 'tab-title-text';
    textSpan.textContent = tab.title;
    tabBtn.appendChild(textSpan);

    // Sibling of the tab button, never a nested control: the tab stays a single
    // focus stop, and Delete on the tab posts the same close request.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.tabIndex = -1;
    closeBtn.title = current.strings.closeTerminal;
    closeBtn.setAttribute('aria-label', `${current.strings.closeTerminal}: ${tab.title}`);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'close-tab', tabId: tab.id });
    });

    // Middle-click to close tab
    pill.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        ev.stopPropagation();
        post({ type: 'close-tab', tabId: tab.id });
      }
    });

    // Right-click tab context menu (Escape returns focus to the tab button)
    pill.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openTabContextMenu(tab, ev.clientX, ev.clientY, tabBtn);
    });

    // Pointer-capture drag-to-reorder (avoids VS Code webview HTML5 drag lock)
    attachTabPointerReorder(pill, current);

    pill.appendChild(tabBtn);
    pill.appendChild(closeBtn);
    tabListEl.appendChild(pill);
  });

  restoreTabBarFocus(capturedFocus, current);
}

/** User-initiated activation: focus the terminal once the host confirms it. */
function selectTabFromUi(tabId: string): void {
  rovingTabId = tabId;
  if (state && state.activeTabId === tabId) {
    activePane()?.handle.focus();
    return;
  }
  pendingFocusTabId = tabId;
  post({ type: 'select-tab', tabId });
}

/**
 * Roving tablist navigation. Selection follows focus (automatic activation),
 * but focus stays in the strip so the user can keep arrowing.
 */
tabListEl.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('.tab-label');
  if (!button || !tabListEl.contains(button)) {
    return;
  }
  const buttons = Array.from(tabListEl.querySelectorAll<HTMLButtonElement>('.tab-label'));
  const index = buttons.indexOf(button);
  if (index < 0) {
    return;
  }

  if (event.key === 'Delete') {
    event.preventDefault();
    event.stopPropagation();
    const tabId = button.closest<HTMLElement>('.tab-pill')?.dataset.tabId;
    if (tabId) {
      post({ type: 'close-tab', tabId });
    }
    return;
  }

  let nextIndex = -1;
  if (event.key === 'ArrowRight') {
    nextIndex = (index + 1) % buttons.length;
  } else if (event.key === 'ArrowLeft') {
    nextIndex = (index - 1 + buttons.length) % buttons.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = buttons.length - 1;
  }
  if (nextIndex < 0 || nextIndex >= buttons.length) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const next = buttons[nextIndex];
  const nextId = next.closest<HTMLElement>('.tab-pill')?.dataset.tabId;
  if (!nextId) {
    return;
  }
  buttons.forEach((btn, i) => {
    btn.tabIndex = i === nextIndex ? 0 : -1;
  });
  rovingTabId = nextId;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (!state || state.activeTabId !== nextId) {
        post({ type: 'select-tab', tabId: nextId, preserveFocus: true });
  }
});

tabAddEl.addEventListener('click', () => post({ type: 'new-session' }));

/**
 * Cancels an in-flight pointer reorder without committing a reorder. Used when
 * the window loses focus mid-drag so the captured pill cannot stay "grabbed".
 */
function cancelPointerDrag(): void {
  if (!pointerDragSession) {
    return;
  }
  const cleanup = pointerDragListenerCleanup;
  pointerDragListenerCleanup = null;
  pointerDragSession = null;
  draggingTab = false;
  cleanup?.();
  tabBarEl.classList.remove('reordering');
  tabListEl
    .querySelectorAll<HTMLElement>('.tab-pill.dragging')
    .forEach((el) => el.classList.remove('dragging'));
}

function attachTabPointerReorder(pill: HTMLElement, current: TerminalState): void {
  if (current.tabs.length <= 1) {
    return;
  }
  pill.addEventListener('pointerdown', (downEvent) => {
    if (downEvent.button !== 0 || pointerDragSession) {
      return;
    }
    const target = downEvent.target as HTMLElement | null;
    if (target?.closest('.tab-close') || target?.closest('input')) {
      return;
    }
    const tabId = pill.dataset.tabId ?? '';
    if (!tabId) {
      return;
    }

    const pointerId = downEvent.pointerId;
    const session = { tabId, pointerId, startX: downEvent.clientX, moved: false };
    pointerDragSession = session;

    /**
     * Live state refreshes rebuild the tab bar (`innerHTML = ''`), so the pill
     * captured on pointerdown may be gone. Always re-resolve it by tab id.
     */
    const resolvePill = (): HTMLElement | null => findPill(session.tabId);

    const onMove = (moveEvent: PointerEvent): void => {
      if (!pointerDragSession || pointerDragSession.pointerId !== pointerId) {
        return;
      }
      const pillNow = resolvePill();
      if (!pillNow) {
        return;
      }
      const dx = moveEvent.clientX - session.startX;
      if (!session.moved) {
        if (Math.abs(dx) < 5) {
          return;
        }
        session.moved = true;
        draggingTab = true;
        pillNow.classList.add('dragging');
        tabBarEl.classList.add('reordering');
        try {
          pillNow.setPointerCapture(pointerId);
        } catch {
          // ignore if pointer already released
        }
      }

      moveEvent.preventDefault();
      const pills = Array.from(tabListEl.querySelectorAll<HTMLElement>('.tab-pill'));
      const currentIndex = pills.indexOf(pillNow);
      if (currentIndex < 0) {
        return;
      }
      if (currentIndex > 0) {
        const prev = pills[currentIndex - 1];
        const prevRect = prev.getBoundingClientRect();
        if (moveEvent.clientX < prevRect.left + prevRect.width * 0.55) {
          tabListEl.insertBefore(pillNow, prev);
          return;
        }
      }
      if (currentIndex < pills.length - 1) {
        const next = pills[currentIndex + 1];
        const nextRect = next.getBoundingClientRect();
        if (moveEvent.clientX > nextRect.left + nextRect.width * 0.45) {
          tabListEl.insertBefore(next, pillNow);
        }
      }
    };

    const finishDrag = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      const wasMoved = session.moved;
      pointerDragSession = null;
      pointerDragListenerCleanup = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);

      const pillNow = resolvePill();
      try {
        if (pillNow?.hasPointerCapture(pointerId)) {
          pillNow.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
      pillNow?.classList.remove('dragging');
      tabBarEl.classList.remove('reordering');
      draggingTab = false;

      if (!wasMoved) {
        return;
      }
      suppressTabClickUntil = Date.now() + 260;

      const domIds = Array.from(tabListEl.querySelectorAll<HTMLElement>('.tab-pill'))
        .map((el) => el.dataset.tabId ?? '')
        .filter(Boolean);
      if (state && domIds.length === state.tabs.length) {
        const prevIds = state.tabs.map((t) => t.id);
        const changed = domIds.some((id, i) => id !== prevIds[i]);
        if (changed) {
          const byId = new Map(state.tabs.map((t) => [t.id, t]));
          state.tabs = domIds.map((id) => byId.get(id)!).filter(Boolean);
          post({ type: 'reorder-tabs', tabIds: domIds });
        }
        renderTabBar(state);
      }
    };

    pointerDragListenerCleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  });
}

// Smooth horizontal wheel scroll on the tab strip + double-click blank space to add tab
tabBarEl.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY !== 0 && tabListEl.scrollWidth > tabListEl.clientWidth) {
      event.preventDefault();
      tabListEl.scrollLeft += event.deltaY;
    }
  },
  { passive: false }
);

tabBarEl.addEventListener('dblclick', (event) => {
  if (event.target === tabBarEl || event.target === tabListEl) {
    post({ type: 'new-session' });
  }
});

function openTabContextMenu(
  tab: TerminalTabInfo,
  x: number,
  y: number,
  anchor?: HTMLElement
): void {
  const strings = state?.strings;
  const totalTabs = state?.tabs.length ?? 1;

  const items: MenuItem[] = [
    {
      label: strings?.newTerminal ?? 'New terminal',
      run: () => post({ type: 'new-session' })
    },
    {
      label: strings?.restart ?? 'Restart',
      run: () => post({ type: 'restart', tabId: tab.id })
    }
  ];

  items.push({
    label: strings?.closeTerminal ?? 'Close terminal',
    separator: true,
    run: () => post({ type: 'close-tab', tabId: tab.id })
  });

  items.push({
    label: strings?.closeOtherTerminals ?? 'Close other terminals',
    enabled: totalTabs > 1,
    run: () => post({ type: 'close-other-tabs', tabId: tab.id })
  });

  showMenu(items, x, y, 'left', anchor);
}

function cycleTab(delta: -1 | 1): void {
  if (!state || state.tabs.length <= 1) {
    return;
  }
  const idx = state.tabs.findIndex((t) => t.id === state!.activeTabId);
  const next = state.tabs[(Math.max(0, idx) + delta + state.tabs.length) % state.tabs.length];
  if (next) {
    selectTabFromUi(next.id);
  }
}

function render(): void {
  const current = state;
  if (!current) {
    return;
  }
  const strings = current.strings;
  hintEl.textContent = strings.hint;
  hintEl.title = strings.hint;

  searchBarEl.setAttribute('aria-label', strings.find);
  searchInputEl.placeholder = strings.findPlaceholder;
  searchInputEl.setAttribute('aria-label', strings.find);
  searchPrevEl.title = strings.findPrev;
  searchPrevEl.setAttribute('aria-label', strings.findPrev);
  searchNextEl.title = strings.findNext;
  searchNextEl.setAttribute('aria-label', strings.findNext);
  searchCloseEl.title = strings.close;
  searchCloseEl.setAttribute('aria-label', strings.close);

  syncTabs(current);
  renderTabBar(current);
  exitOverlay();
}

function exitOverlay(): void {
  const current = state;
  const tab = activeTabMeta();
  if (!current || !tab) {
    return;
  }
  // Starting keeps any already-emitted output interactive and readable. Only
  // the completed state gets a blocking overlay with an explicit restart.
  exitedEl.hidden = !tab.exited;
  exitedText.textContent = current.strings.terminalExited;
  hintEl.textContent = !tab.running && !tab.exited
    ? current.strings.terminalStarting
    : current.strings.hint;
  exitedRestart.hidden = !tab.exited;
  exitedRestart.textContent = current.strings.restart;
}

function showToast(message: string, level: 'info' | 'warn' | 'error'): void {
  toastEl.textContent = message;
  toastEl.className = `toast ${level}`;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

/* ------------------------------------------------------------------ */
/* Search bar                                                          */
/* ------------------------------------------------------------------ */

function runSearch(step: 0 | 1 | -1): void {
  const pane = activePane();
  if (!pane) {
    return;
  }
  const query = searchInputEl.value;
  if (!query) {
    pane.handle.clearSearch();
    searchCountEl.textContent = state?.strings.findNoResults ?? '0/0';
    return;
  }
  const result = pane.handle.find(query, step);
  searchCountEl.textContent = result.total > 0 ? `${result.index}/${result.total}` : '0/0';
}

function toggleSearch(forceOpen?: boolean): void {
  const open = forceOpen ?? searchBarEl.hidden;
  if (!open) {
    if (searchBarEl.hidden) {
      return;
    }
    searchBarEl.hidden = true;
    activePane()?.handle.clearSearch();
    // The search row is in the layout flow: refit once it collapses.
    activePane()?.handle.fit();
    activePane()?.handle.focus();
    return;
  }
  if (!searchBarEl.hidden) {
    searchInputEl.focus();
    searchInputEl.select();
    return;
  }
  searchBarEl.hidden = false;
  const sel = activePane()?.handle.getSelection().trim() ?? '';
  if (sel && !sel.includes('\n') && sel.length <= 80) {
    searchInputEl.value = sel;
  }
  activePane()?.handle.fit();
  searchInputEl.focus();
  searchInputEl.select();
  if (searchInputEl.value) {
    runSearch(0);
  }
}

searchInputEl.addEventListener('input', () => runSearch(0));
searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    toggleSearch(false);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runSearch(event.shiftKey ? -1 : 1);
  }
});
searchPrevEl.addEventListener('click', () => {
  runSearch(-1);
  searchInputEl.focus();
});
searchNextEl.addEventListener('click', () => {
  runSearch(1);
  searchInputEl.focus();
});
searchCloseEl.addEventListener('click', () => toggleSearch(false));

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * Hides the menu. Focus is only handed back to the anchor when the menu itself
 * still owned it, so an explicit click/control that took focus keeps it.
 */
function hideMenu(restoreFocus = false): void {
  const anchor = menuAnchor;
  const focusWasInMenu = menuEl.contains(document.activeElement);
  menuAnchor = null;
  menuEl.hidden = true;
  menuEl.innerHTML = '';
  if (!restoreFocus || !focusWasInMenu) {
    return;
  }
  if (anchor?.isConnected) {
    anchor.focus();
    return;
  }
  activePane()?.handle.focus();
}

interface MenuItem {
  label: string;
  checked?: boolean;
  separator?: boolean;
  enabled?: boolean;
  run(): void;
}

let menuAnchor: HTMLElement | null = null;

function menuButtons(): HTMLButtonElement[] {
  return Array.from(
    menuEl.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
  );
}

function showMenu(
  items: MenuItem[],
  x: number,
  y: number,
  align: 'left' | 'right' = 'left',
  anchor?: HTMLElement
): void {
  menuEl.innerHTML = '';
  menuEl.setAttribute('role', 'menu');
  menuAnchor = anchor ?? null;
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.textContent = `${item.checked ? '✓ ' : ''}${item.label}`;
    button.disabled = item.enabled === false;
    if (item.separator) {
      button.classList.add('sep');
    }
    button.addEventListener('click', () => {
      const target = menuAnchor;
      hideMenu();
      item.run();
      // Do not steal focus from a control the action just opened (search row,
      // host QuickPick, ...).
      restoreFocusIfIdle(target);
    });
    menuEl.appendChild(button);
  }
  menuEl.hidden = false;
  const rect = menuEl.getBoundingClientRect();
  const left = align === 'right' ? x - rect.width : x;
  menuEl.style.left = `${Math.max(8, Math.min(left, window.innerWidth - rect.width - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menuButtons()[0]?.focus();
}

menuEl.addEventListener('keydown', (event) => {
  const items = menuButtons();
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideMenu(true);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(current + delta + items.length) % items.length];
    next?.focus();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    hideMenu(true);
  }
});

async function copyText(text: string): Promise<void> {
  if (!text) {
    return;
  }
  try {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }
  } catch {
    // Clipboard permission denied: fall back to the host clipboard.
  }
  post({ type: 'copy', text });
}

async function pasteFromClipboard(): Promise<void> {
  let text: string | undefined;
  try {
    const clipboard = navigator.clipboard;
    if (clipboard?.readText) {
      text = await clipboard.readText();
    }
  } catch {
    text = undefined;
  }
  if (typeof text === 'string') {
    if (text) {
      activePane()?.handle.paste(text);
    }
    return;
  }
  post({ type: 'paste-clipboard' });
}

function openMenu(x: number, y: number): void {
  const strings = state?.strings;
  const pane = activePane();
  const selection = pane?.handle.getSelection().trim() ?? '';

  const items: MenuItem[] = [
    {
      label: strings?.copy ?? 'Copy',
      enabled: Boolean(selection),
      run: () => {
        void copyText(selection);
        pane?.handle.focus();
      }
    },
    {
      label: strings?.paste ?? 'Paste',
      run: () => {
        void pasteFromClipboard();
        pane?.handle.focus();
      }
    },
    {
      label: strings?.find ?? 'Find in terminal',
      separator: true,
      run: () => toggleSearch(true)
    },
    {
      label: strings?.clearTerminal ?? 'Clear terminal',
      run: () => {
        pane?.handle.reset();
        pane?.handle.focus();
      }
    }
  ];
  showMenu(items, x, y);
}

/* ------------------------------------------------------------------ */
/* Host message dispatch                                               */
/* ------------------------------------------------------------------ */

function acceptState(next: TerminalState, kind: 'init' | 'state'): boolean {
  if (kind === 'init') {
    lastSeq = Number.isFinite(next.seq) ? next.seq : -1;
    return true;
  }
  if (Number.isFinite(next.seq) && next.seq <= lastSeq) {
    return false;
  }
  if (Number.isFinite(next.seq)) {
    lastSeq = next.seq;
  }
  return true;
}

window.addEventListener('message', (event: MessageEvent<HostToTerminal>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
    case 'state':
      if (!acceptState(message.state, message.type)) {
        return;
      }
      state = message.state;
      render();
      return;
    case 'terminal-data': {
      const pane = panes.get(message.tabId);
      if (pane) {
        pane.handle.write(message.data);
      } else {
        let queue = queuedDataByTab.get(message.tabId);
        if (!queue) {
          queue = [];
          queuedDataByTab.set(message.tabId, queue);
        }
        if (queue.length > 256) {
          queue.shift();
        }
        queue.push(message.data);
      }
      return;
    }
    case 'terminal-paste':
      panes.get(message.tabId)?.handle.paste(message.text);
      return;
    case 'terminal-reset':
      panes.get(message.tabId)?.handle.reset();
      return;
    case 'toast':
      showToast(message.message, message.level);
      return;
    case 'focus':
      activePane()?.handle.focus();
      return;
  }
});

exitedRestart.addEventListener('click', () =>
  post({ type: 'restart', tabId: state?.activeTabId })
);

terminalWrap.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
});

window.addEventListener('click', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target as Node)) {
    hideMenu();
  }
});

window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape' && !menuEl.hidden) {
      event.preventDefault();
      event.stopPropagation();
      hideMenu(true);
      return;
    }
    const accel = event.ctrlKey || event.metaKey;
    // Ctrl/Cmd+1..9 jumps straight to a tab by position.
    if (accel && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (!typing && menuEl.hidden && state && state.tabs.length > 0) {
        const targetTab = state.tabs[Number(event.key) - 1];
        if (targetTab) {
          event.preventDefault();
          event.stopPropagation();
          selectTabFromUi(targetTab.id);
          return;
        }
      }
    }
    // Capture Ctrl/Cmd+F before it can bubble to the VS Code host find widget.
    if (accel && !event.altKey && event.key.toLowerCase() === 'f') {
      if (event.shiftKey || searchBarEl.hidden === false) {
        event.preventDefault();
        event.stopPropagation();
        toggleSearch(true);
        return;
      }
    }
  },
  { capture: true }
);

window.addEventListener('blur', () => {
  hideMenu();
  cancelPointerDrag();
});

post({ type: 'ready' });
