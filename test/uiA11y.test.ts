import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * UI/accessibility contract tests for the TermMoor webview shell.
 *
 * The webview entrypoint owns the DOM and cannot be imported in a Node test
 * (it calls `acquireVsCodeApi`, mounts xterm, and imports CSS), so these tests
 * pin the interaction structure directly against the source. Each assertion
 * maps to a user-visible acceptance check documented in the PR notes.
 */

// scripts/test.mjs recreates dist-test, but a worker may add another test
// bundle there. Resolve the repository from this test's source path.
const root = path.resolve(__dirname, '..');
const mainTs = fs.readFileSync(path.join(root, 'webview', 'main.ts'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'webview', 'style.css'), 'utf8');
const terminalTs = fs.readFileSync(
  path.join(root, 'webview', 'terminal', 'TerminalView.ts'),
  'utf8'
);

/** Returns the source of `function name(...) { ... }` by brace matching. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `function ${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function cssBlock(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
    styleCss
  );
  assert.ok(match, `CSS block ${selector} not found`);
  return match[1];
}

test('tablist is named and owns the tab strip; add button is a sibling', () => {
  assert.match(mainTs, /role="tablist"/, 'tablist role is declared');
  assert.match(mainTs, /aria-orientation="horizontal"/, 'tablist orientation is declared');
  assert.match(
    mainTs,
    /tabListEl\.setAttribute\('aria-label', current\.strings\.appName\)/,
    'tablist receives an accessible name on every render'
  );
  // The add button must live outside the tablist but inside the strip.
  assert.match(mainTs, /<div class="tab-list" id="tab-list" role="tablist"/);
  assert.match(mainTs, /<button type="button" class="tab-add" id="tab-add"/);
  const tabBarBlock = mainTs.slice(
    mainTs.indexOf('<div class="tab-bar" id="tab-bar">'),
    mainTs.indexOf('<div class="search-row"')
  );
  assert.ok(
    tabBarBlock.indexOf('id="tab-list"') < tabBarBlock.indexOf('id="tab-add"'),
    'add button is a sibling after the tablist'
  );
  assert.match(
    mainTs,
    /tabAddEl\.setAttribute\('aria-label', current\.strings\.newTerminal\)/,
    'add button is labelled'
  );
});

test('primary tab is a focusable button with roving tabindex and a paired tabpanel', () => {
  assert.match(mainTs, /const tabBtn = document\.createElement\('button'\)/);
  assert.match(mainTs, /tabBtn\.setAttribute\('role', 'tab'\)/);
  assert.match(mainTs, /tabBtn\.setAttribute\('aria-selected', String\(isActive\)\)/);
  assert.match(mainTs, /tabBtn\.setAttribute\('aria-controls', tabPanelId\(tab\.id\)\)/);
  // Exactly one tab stop: only the current/roving tab is tabbable.
  assert.match(mainTs, /tabBtn\.tabIndex = tab\.id === rovingId \? 0 : -1/);

  // Every terminal pane is the labelled tabpanel for its tab button.
  assert.match(mainTs, /paneEl\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(mainTs, /paneEl\.id = tabPanelId\(tabId\)/);
  assert.match(mainTs, /pane\.el\.setAttribute\('aria-labelledby', tabButtonId\(tab\.id\)\)/);
  assert.match(mainTs, /pane\.el\.setAttribute\('aria-label', tab\.title\)/);
  assert.match(mainTs, /tabBtn\.id = tabButtonId\(tab\.id\)/);
});

test('close control is a sibling button and dispatches the host close request', () => {
  // Siblings, never nested inside the tab button.
  assert.match(mainTs, /pill\.appendChild\(tabBtn\);\s*pill\.appendChild\(closeBtn\);/);
  assert.doesNotMatch(mainTs, /tabBtn\.appendChild\(closeBtn\)/);
  assert.match(mainTs, /closeBtn\.tabIndex = -1/);
  assert.match(
    mainTs,
    /closeBtn\.setAttribute\('aria-label', `\$\{current\.strings\.closeTerminal\}: \$\{tab\.title\}`\)/
  );
  const closeClick = /closeBtn\.addEventListener\('click',[\s\S]{0,200}?post\(\{ type: 'close-tab', tabId: tab\.id \}\)/;
  assert.match(mainTs, closeClick, 'close button posts close-tab');
  // Keyboard close (Delete) reuses the same host request; the worker owns
  // process confirmation, so the webview must not add a dialog.
  assert.match(mainTs, /event\.key === 'Delete'[\s\S]{0,400}?post\(\{ type: 'close-tab', tabId \}\)/);
  assert.doesNotMatch(mainTs, /window\.confirm|showInformationMessage/);
});

test('tab strip keyboard navigation: arrows, Home/End, and Ctrl+1-9', () => {
  assert.match(mainTs, /event\.key === 'ArrowRight'/, 'ArrowRight moves between tabs');
  assert.match(mainTs, /event\.key === 'ArrowLeft'/, 'ArrowLeft moves between tabs');
  assert.match(mainTs, /event\.key === 'Home'/, 'Home jumps to the first tab');
  assert.match(mainTs, /event\.key === 'End'/, 'End jumps to the last tab');
  assert.ok(mainTs.includes("&& /^[1-9]$/.test(event.key)"), 'Ctrl+1-9 still switches tabs');
  assert.match(mainTs, /selectTabFromUi\(targetTab\.id\)/, 'Ctrl+1-9 switches to the addressed tab');

  // Arrow navigation must keep focus in the strip (no terminal autofocus) and
  // keep a single tab stop while it moves.
  const navBlock = mainTs.slice(
    mainTs.indexOf("tabListEl.addEventListener('keydown'"),
    mainTs.indexOf("tabAddEl.addEventListener('click'")
  );
  assert.match(navBlock, /buttons\.forEach\(\(btn, i\) => \{\s*btn\.tabIndex = i === nextIndex \? 0 : -1;/);
  assert.match(navBlock, /next\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(navBlock, /handle\.focus\(\)/);
});

test('tab bar rebuilds restore natural focus and never autofocus on startup/background exit', () => {
  assert.match(mainTs, /function captureTabBarFocus\(\)/);
  assert.match(mainTs, /function restoreTabBarFocus\(/);
  assert.match(mainTs, /const capturedFocus = captureTabBarFocus\(\)/);
  assert.match(mainTs, /restoreTabBarFocus\(capturedFocus, current\)/);
  // Focus follows the surviving neighbour when the focused tab is closed.
  assert.match(mainTs, /const focusTabId = stillThere \? tabId : current\.activeTabId/);

  // The only autofocus in syncTabs is behind an explicit user-intent flag.
  const syncBody = functionBody(mainTs, 'syncTabs');
  assert.match(syncBody, /if \(pendingFocusTabId === tab\.id\) \{/);
  assert.doesNotMatch(
    syncBody,
    /pane\.handle\.focus\(\);\s*\}\s*else/s,
    'no unconditional pane focus'
  );

  // TerminalView only reclaims focus for a terminal that was already used.
  assert.match(terminalTs, /pendingFocus = everFocused;/);
  assert.doesNotMatch(terminalTs, /pendingFocus = true;/);
});

test('search UI is an in-flow compact row that cannot overlap terminal output', () => {
  assert.match(mainTs, /<div class="search-row" id="search-bar" role="search"/);
  assert.doesNotMatch(mainTs, /class="search-bar"/, 'floating overlay is gone');
  // Rendered between the tab strip and the terminal, not inside it.
  assert.ok(
    mainTs.indexOf('id="search-bar"') > mainTs.indexOf('id="tab-bar"'),
    'search row follows the tab strip'
  );
  assert.ok(
    mainTs.indexOf('id="search-bar"') < mainTs.indexOf('id="terminal-wrap"'),
    'search row precedes the terminal'
  );
  const searchRow = cssBlock('.search-row');
  assert.doesNotMatch(searchRow, /position:\s*absolute/);
  assert.match(searchRow, /flex:\s*0 0 auto/);
  // Opening/closing the row re-fits the terminal.
  assert.match(mainTs, /searchBarEl\.hidden = false;[\s\S]{0,600}?handle\.fit\(\)/);
  assert.match(mainTs, /searchBarEl\.hidden = true;[\s\S]{0,300}?handle\.fit\(\)/);
});

test('icon controls are labelled and the status toast is a polite live region', () => {
  for (const control of ['search-prev', 'search-next', 'search-close']) {
    const tag = new RegExp(`<button[^>]*id="${control}"[^>]*aria-label="[^"]+"`);
    assert.match(mainTs, tag, `${control} has a static label`);
  }
  assert.match(mainTs, /searchPrevEl\.setAttribute\('aria-label', strings\.findPrev\)/);
  assert.match(mainTs, /searchNextEl\.setAttribute\('aria-label', strings\.findNext\)/);
  assert.match(mainTs, /searchCloseEl\.setAttribute\('aria-label', strings\.close\)/);
  assert.match(mainTs, /searchInputEl\.setAttribute\('aria-label', strings\.find\)/);

  assert.match(
    mainTs,
    /<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true" hidden>/,
    'toast is announced politely'
  );
  assert.match(
    styleCss,
    /\[role='tab'\]:focus-visible/,
    'shared focus ring covers the tab button'
  );
  assert.match(styleCss, /outline: 1px solid var\(--vscode-focusBorder/, 'theme focus token used');
});

test('menu focus never steals from an explicitly focused control', () => {
  assert.match(mainTs, /function focusIsIdle\(\)/);
  assert.match(mainTs, /function restoreFocusIfIdle\(target: HTMLElement \| null\)/);
  const hideBody = functionBody(mainTs, 'hideMenu');
  assert.match(hideBody, /const focusWasInMenu = menuEl\.contains\(document\.activeElement\)/);
  assert.match(hideBody, /if \(!restoreFocus \|\| !focusWasInMenu\)/);
  // Menu activation restores the anchor only when nothing else claimed focus.
  assert.match(
    mainTs,
    /hideMenu\(\);\s*item\.run\(\);[\s\S]{0,200}?restoreFocusIfIdle\(target\)/
  );
  assert.match(mainTs, /openTabContextMenu\(tab, ev\.clientX, ev\.clientY, tabBtn\)/);
});

test('existing interactions stay wired: reorder, typing, tab switching', () => {
  assert.match(mainTs, /attachTabPointerReorder\(pill, current\)/);
  assert.match(mainTs, /post\(\{ type: 'reorder-tabs', tabIds: domIds \}\)/);
  assert.match(mainTs, /onData: \(data\) => post\(\{ type: 'terminal-input', tabId, data \}\)/);
  assert.match(mainTs, /function selectTabFromUi\(tabId: string\)/);
  assert.match(mainTs, /post\(\{ type: 'select-tab', tabId \}\)/);
  // The single-tab case keeps the add button visible.
  assert.doesNotMatch(
    mainTs,
    /current\.tabs\.length <= 1 && !editingTabId/,
    'strip is no longer hidden for a single tab'
  );
});

test('supplemental overflow actions stay out of the webview shell', () => {
  // Removed view/title overflow actions: workspace context, open output in
  // editor, multiline draft, and rename.
  assert.doesNotMatch(mainTs, /id="draft-drawer"/, 'no multiline draft drawer');
  assert.doesNotMatch(mainTs, /tab-rename-input/, 'no inline tab rename input');
  assert.doesNotMatch(mainTs, /'pick-workspace-context'/, 'no workspace context picker');
  assert.doesNotMatch(mainTs, /'open-in-editor'/, 'no open-output-in-editor action');
  assert.doesNotMatch(mainTs, /'insert-into-editor'/, 'no insert-into-editor action');
  assert.doesNotMatch(mainTs, /'insert-text'/, 'no terminal-selection-as-file insert');
  assert.doesNotMatch(mainTs, /'terminal-insert'/, 'no raw terminal-insert path');

  // Core plumbing is still wired: close, clipboard, find, and reorder.
  assert.match(mainTs, /post\(\{ type: 'close-tab', tabId: tab\.id \}\)/);
  assert.match(mainTs, /post\(\{ type: 'paste-clipboard' \}\)/);
  assert.match(mainTs, /post\(\{ type: 'copy', text \}\)/);
  assert.match(mainTs, /toggleSearch\(true\)/);
  assert.match(mainTs, /post\(\{ type: 'reorder-tabs', tabIds: domIds \}\)/);
});
