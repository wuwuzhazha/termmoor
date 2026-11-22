/**
 * Provider lifecycle regressions for the local-PTY-only TermMoor runtime.
 *
 * `vscode` is mocked, but the provider's own start/close/restart orchestration
 * runs unchanged. `TerminalService` is injected as a fake, so the tests observe
 * the exact shell starts, stops, writes, and confirmation dialogs the provider
 * would use in the extension host. No herdr-core client, daemon, or real PTY is
 * involved.
 */

import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import {
  FakeTerminalService,
  cleanupSharedHarness,
  createProviderHarness,
  deferred,
  waitFor,
  type ManagedTabLike,
  type ProviderHarness,
  type ProviderHarnessOptions
} from './helpers/providerHarness';

after(cleanupSharedHarness);

async function bootReady(options: ProviderHarnessOptions = {}): Promise<ProviderHarness> {
  const harness = await createProviderHarness(options);
  await harness.resolveView();
  await harness.send({ type: 'ready' });
  return harness;
}

/* ------------------------------------------------------- start coalescing */

test('concurrent start requests coalesce onto one local PTY', async () => {
  const gate = deferred<void>();
  const harness = await createProviderHarness();
  harness.queueServiceDefaults({ startGate: gate.promise });

  await harness.resolveView();
  const ready = harness.send({ type: 'ready' });
  await waitFor(() => harness.services[0]?.starts.length === 1, 'initial shell start');

  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab, 'the initial tab exists');
  const duplicate = harness.startTab(tab);
  const duplicateAgain = harness.startTab(tab);
  const select = harness.send({ type: 'select-tab', tabId: tab.id });

  gate.resolve();
  await Promise.all([ready, duplicate, duplicateAgain, select]);

  assert.equal(harness.services.length, 1, 'one tab owns one PTY');
  assert.equal(tab.service.starts.length, 1, 'exactly one shell was spawned');
  assert.equal(tab.running, true);
  harness.dispose();
});

test('a restart queued during an in-flight start spawns a fresh shell', async () => {
  const gate = deferred<void>();
  const harness = await createProviderHarness();
  harness.queueServiceDefaults({ startGate: gate.promise });

  await harness.resolveView();
  const ready = harness.send({ type: 'ready' });
  await waitFor(() => harness.services[0]?.starts.length === 1, 'initial shell start');

  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab);

  // Restart while the first shell is still starting: the modal must guard it.
  const restarting = harness.provider.restart(tab.id);
  await waitFor(() => harness.warnings.length === 1, 'restart confirmation');
  harness.resolveWarning(harness.lastWarning()!, 'Restart');

  gate.resolve();
  await Promise.all([ready, restarting]);

  assert.equal(tab.service.starts.length, 2, 'the superseded start is retried once');
  assert.ok(tab.service.stops >= 1, 'the superseded shell is stopped');
  assert.equal(harness.services.length, 1, 'the tab keeps its single PTY owner');
  assert.equal(tab.running, true);
  assert.equal(tab.starting, false);
  harness.dispose();
});

test('a start that resolves after its tab closed is stopped, not adopted', async () => {
  const harness = await bootReady();
  const gate = deferred<void>();
  harness.queueServiceDefaults({ startGate: gate.promise });

  const newSession = harness.provider.newSession();
  await waitFor(() => harness.tabs().size === 2, 'second tab');
  const closedId = harness.activeTabId();
  const closedTab = harness.tab(closedId);
  assert.ok(closedTab);
  await waitFor(() => closedTab.service.starts.length === 1, 'gated shell start');

  // Closing a tab that is still starting is guarded: it would interrupt work.
  const closing = harness.send({ type: 'close-tab', tabId: closedId });
  await waitFor(() => harness.warnings.length === 1, 'close confirmation');
  assert.match(harness.lastWarning()!.message, /still running work/);
  harness.resolveWarning(harness.lastWarning()!, 'Close');
  await closing;
  assert.equal(harness.tabs().has(closedId), false, 'the tab is gone before start finishes');

  gate.resolve();
  await newSession;

  assert.equal(closedTab.service.starts.length, 1, 'the delayed shell did start once');
  assert.equal(closedTab.running, false, 'it was never adopted by the closed tab');
  assert.ok(closedTab.service.stops >= 1, 'the abandoned shell was stopped');
  assert.equal(closedTab.service.disposals, 1, 'the closed tab service was disposed');
  harness.dispose();
});

test('a view dispose during start leaves no running pty and reopening starts fresh', async () => {
  const gate = deferred<void>();
  const harness = await createProviderHarness();
  harness.queueServiceDefaults({ startGate: gate.promise });

  await harness.resolveView();
  const ready = harness.send({ type: 'ready' });
  await waitFor(() => harness.services[0]?.starts.length === 1, 'gated shell start');
  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab);

  harness.disposeView();
  gate.resolve();
  await ready;

  assert.equal(tab.running, false, 'the stale attempt never marked the tab running');
  assert.equal(tab.service.running, false, 'the spawned shell was stopped');
  assert.equal(tab.service.starts.length, 1);

  // Reopening the sidebar spawns one fresh local shell in the same tab.
  await harness.resolveView();
  await harness.send({ type: 'ready' });
  assert.equal(harness.tabs().size, 1);
  assert.equal(tab.running, true);
  assert.equal(tab.service.starts.length, 2, 'a new shell replaced the stopped one');
  harness.dispose();
});

/* ------------------------------------------------------------- stale ids */

test('stale input, clipboard, and restart never retarget the active tab', async () => {
  const harness = await bootReady();
  const firstId = harness.activeTabId();
  const firstTab = harness.tab(firstId);
  assert.ok(firstTab);

  await harness.provider.newSession();
  const secondId = harness.activeTabId();
  assert.notEqual(secondId, firstId);

  // Idle shells close without a modal.
  await harness.send({ type: 'close-tab', tabId: secondId });
  assert.equal(harness.tabs().has(secondId), false);
  assert.equal(harness.warnings.length, 0, 'an idle shell needs no confirmation');

  firstTab.service.writes.length = 0;
  await harness.send({ type: 'terminal-input', tabId: secondId, data: 'echo stale' });
  assert.deepEqual(firstTab.service.writes, []);

  harness.setClipboard('echo clipboard payload');
  await harness.send({ type: 'paste-clipboard', tabId: secondId });
  assert.equal(
    harness.messagesOfType('terminal-paste').length,
    0,
    'clipboard text must not land in the surviving tab'
  );

  // The same clipboard does reach a live, explicitly addressed tab.
  await harness.send({ type: 'paste-clipboard', tabId: firstId });
  const pastes = harness.messagesOfType('terminal-paste');
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].tabId, firstId);
  assert.equal(pastes[0].text, 'echo clipboard payload');

  const startsBefore = firstTab.service.starts.length;
  await harness.provider.restart(secondId);
  assert.equal(firstTab.service.starts.length, startsBefore);
  harness.dispose();
});

/* --------------------------------------------------- identity rechecks */

test('restart rechecks the tab identity after its confirmation dialog', async () => {
  const harness = await bootReady();
  const original = harness.tab(harness.activeTabId());
  assert.ok(original);
  const startsBefore = original.service.starts.length;
  const stopsBefore = original.service.stops;

  const restarting = harness.provider.restart(original.id);
  await waitFor(() => harness.warnings.length === 1, 'restart confirmation');

  // The tab vanished and a different object with the same id was created while
  // the modal was open. Confirming must not restart either of them.
  const replacementService = new FakeTerminalService();
  const replacement = {
    ...original,
    service: replacementService
  } as ManagedTabLike;
  harness.tabs().set(original.id, replacement);

  harness.resolveWarning(harness.lastWarning()!, 'Restart');
  await restarting;

  assert.equal(original.service.starts.length, startsBefore);
  assert.equal(original.service.stops, stopsBefore);
  assert.equal(replacementService.starts.length, 0);
  harness.dispose();
});

test('close rechecks the tab identity after its confirmation dialog', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  const targetId = harness.activeTabId();
  const target = harness.tab(targetId);
  assert.ok(target);
  const stopsBefore = target.service.stops;

  // A foreground command is what makes this close ask for confirmation.
  await harness.send({ type: 'command-started', tabId: targetId, command: 'npm run build' });

  const closing = harness.send({ type: 'close-tab', tabId: targetId });
  await waitFor(() => harness.warnings.length === 1, 'close confirmation');

  const replacementService = new FakeTerminalService();
  const replacement = {
    ...target,
    service: replacementService
  } as ManagedTabLike;
  harness.tabs().set(targetId, replacement);
  harness.resolveWarning(harness.lastWarning()!, 'Close');
  await closing;

  assert.equal(harness.tabs().get(targetId), replacement);
  assert.equal(harness.tabs().size, 2);
  assert.equal(target.service.disposals, 0);
  assert.equal(target.service.stops, stopsBefore);
  harness.dispose();
});

/* ------------------------------------------------------ close contract */

test('an idle shell closes without a confirmation', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  const [targetId] = [...harness.tabs().keys()];
  const target = harness.tab(targetId);
  assert.ok(target);
  assert.equal(target.running, true);
  target.service.setProcessName('bash');

  await harness.send({ type: 'close-tab', tabId: targetId });

  assert.equal(harness.warnings.length, 0, 'an idle prompt has no work to lose');
  assert.equal(harness.tabs().has(targetId), false);
  assert.equal(target.service.disposals, 1);
  assert.equal(target.service.running, false);
  harness.dispose();
});

test('closing a tab with a foreground command asks before terminating it', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  const [targetId] = [...harness.tabs().keys()];
  const target = harness.tab(targetId);
  assert.ok(target);

  await harness.send({
    type: 'command-started',
    tabId: targetId,
    command: 'npm run build --watch'
  });

  const closing = harness.send({ type: 'close-tab', tabId: targetId });
  await waitFor(() => harness.warnings.length === 1, 'close confirmation');
  const warning = harness.lastWarning()!;
  assert.match(warning.message, /still running work/);
  assert.match(warning.message, /terminate/);
  assert.equal(warning.confirm, 'Close');

  // Declining keeps the shell and its foreground command alive.
  harness.resolveWarning(warning, undefined);
  await closing;
  assert.equal(harness.tabs().has(targetId), true);
  assert.equal(target.service.running, true);
  assert.equal(target.service.disposals, 0);

  // Confirming closes it.
  const confirmed = harness.send({ type: 'close-tab', tabId: targetId });
  await waitFor(() => harness.warnings.length === 2, 'second close confirmation');
  harness.resolveWarning(harness.lastWarning()!, 'Close');
  await confirmed;
  assert.equal(harness.tabs().has(targetId), false);
  assert.equal(target.service.disposals, 1);
  harness.dispose();
});

test('a non-shell foreground process triggers the close confirmation', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  const [targetId] = [...harness.tabs().keys()];
  const target = harness.tab(targetId);
  assert.ok(target);

  // POSIX PTYs report the foreground program; `vim` is not an idle shell.
  target.service.setProcessName('/usr/bin/vim');
  const closing = harness.send({ type: 'close-tab', tabId: targetId });
  await waitFor(() => harness.warnings.length === 1, 'foreground process confirmation');
  assert.match(harness.lastWarning()!.message, /still running work/);
  harness.resolveWarning(harness.lastWarning()!, undefined);
  await closing;
  assert.equal(harness.tabs().has(targetId), true);

  // Back at the prompt, the same tab closes silently.
  target.service.setProcessName('bash');
  await harness.send({ type: 'close-tab', tabId: targetId });
  assert.equal(harness.warnings.length, 1, 'no prompt for an idle shell');
  assert.equal(harness.tabs().has(targetId), false);
  harness.dispose();
});

test('restart keeps the active-command guard and can be declined', async () => {
  const harness = await bootReady();
  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab);
  await harness.send({ type: 'command-started', tabId: tab.id, command: 'npm test' });
  const startsBefore = tab.service.starts.length;

  const restarting = harness.provider.restart(tab.id);
  await waitFor(() => harness.warnings.length === 1, 'restart confirmation');
  const warning = harness.lastWarning()!;
  assert.match(warning.message, /Restarting will terminate/);
  assert.equal(warning.confirm, 'Restart');

  harness.resolveWarning(warning, undefined);
  await restarting;
  assert.equal(tab.service.starts.length, startsBefore, 'a declined restart does nothing');
  assert.equal(tab.running, true);

  const confirmed = harness.provider.restart(tab.id);
  await waitFor(() => harness.warnings.length === 2, 'second restart confirmation');
  harness.resolveWarning(harness.lastWarning()!, 'Restart');
  await confirmed;
  assert.equal(tab.service.starts.length, startsBefore + 1, 'a confirmed restart is fresh');
  assert.equal(tab.running, true);
  harness.dispose();
});

/* ------------------------------------------------------ close-others */

test('close-others closes idle tabs silently', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  await harness.provider.newSession();
  const ids = [...harness.tabs().keys()];
  assert.equal(ids.length, 3);
  const [keepId, ...closingIds] = ids;
  const closing = closingIds.map((id) => harness.tab(id)!);

  await harness.send({ type: 'close-other-tabs', tabId: keepId });

  assert.equal(harness.warnings.length, 0, 'idle tabs close without a modal');
  assert.equal(harness.tabs().size, 1);
  assert.equal(harness.tabs().has(keepId), true);
  for (const tab of closing) {
    assert.equal(tab.service.disposals, 1);
    assert.equal(tab.service.running, false);
  }
  harness.dispose();
});

test('close-others only closes the exact tabs that were confirmed', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  await harness.provider.newSession();
  const ids = [...harness.tabs().keys()];
  assert.equal(ids.length, 3);
  const [keepId, activeId, idleId] = ids;
  const active = harness.tab(activeId);
  assert.ok(active);

  await harness.send({ type: 'command-started', tabId: activeId, command: 'npm run dev' });

  const closing = harness.send({ type: 'close-other-tabs', tabId: keepId });
  await waitFor(() => harness.warnings.length === 1, 'close-others confirmation');
  assert.match(harness.lastWarning()!.message, /1 other terminal still running work/);
  assert.equal(harness.lastWarning()!.confirm, 'Close Others');

  // One confirmed tab is replaced while the modal is open.
  const replacementService = new FakeTerminalService();
  const replacement = {
    ...active,
    service: replacementService
  } as ManagedTabLike;
  harness.tabs().set(activeId, replacement);

  // A brand-new tab opened during the modal was never part of the confirmation.
  const created = (
    harness.provider as unknown as { createTab(): { id: string } }
  ).createTab();
  assert.equal(harness.tabs().size, 4);

  harness.resolveWarning(harness.lastWarning()!, 'Close Others');
  await closing;

  assert.equal(harness.tabs().get(activeId), replacement);
  assert.equal(harness.tabs().has(created.id), true);
  assert.equal(harness.tabs().has(idleId), false);
  assert.equal(harness.tabs().has(keepId), true);
  assert.equal(active.service.disposals, 0);
  assert.equal(replacementService.disposals, 0);
  assert.equal(harness.tabs().size, 3);
  harness.dispose();
});

/* ---------------------------------------------------- startup & disposal */

test('a new provider starts one fresh local shell and ignores legacy state', async () => {
  const legacySnapshot = {
    version: 1,
    activeIndex: 0,
    tabs: [
      { title: 'pi', processHint: 'pi', cwd: 'E:\\Legacy', persistentAddress: 'local/legacy-1' }
    ]
  };
  const harness = await createProviderHarness({
    config: { 'runtime.backend': 'herdr', 'herdr.closeTabAction': 'kill' },
    workspaceState: { tpTabsState: legacySnapshot }
  });

  await harness.resolveView();
  await harness.send({ type: 'ready' });

  const tabs = [...harness.tabs().values()];
  assert.equal(tabs.length, 1, 'exactly one fresh workspace shell');
  const [fresh] = tabs;
  assert.equal(fresh.cwd, harness.root);
  assert.equal(fresh.service.starts.length, 1, 'one local PTY was spawned');
  assert.equal(harness.services.length, 1);

  // Removed runtime settings are inert, and the legacy tab snapshot is never
  // read or rewritten now that TermMoor owns only local PTYs.
  assert.equal(harness.configReads.includes('runtime.backend'), false);
  assert.equal(harness.configReads.includes('herdr.closeTabAction'), false);
  assert.equal(harness.workspaceStateReads.includes('tpTabsState'), false);
  assert.equal(
    harness.workspaceStateWrites.some((entry) => entry.key === 'tpTabsState'),
    false
  );
  assert.deepEqual(harness.workspaceState.get('tpTabsState'), legacySnapshot);
  harness.dispose();
});

test('dispose stops every local PTY', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  assert.equal(harness.services.length, 2);
  assert.ok(harness.services.every((service) => service.running));

  harness.dispose();

  for (const service of harness.services) {
    assert.equal(service.disposals, 1);
    assert.equal(service.running, false);
  }
  assert.equal(harness.tabs().size, 0);
});

/* ------------------------------------------- editor -> CLI regression */

test('sendSelectionOrFile pastes the selected code into the active local shell', async () => {
  const harness = await bootReady();
  await harness.provider.newSession();
  const targetId = harness.activeTabId();
  const target = harness.tab(targetId);
  assert.ok(target);
  const [otherId] = [...harness.tabs().keys()];
  const other = harness.tab(otherId);
  assert.ok(other);
  assert.notEqual(other.id, target.id);

  const editor = harness.createEditor({
    path: `${harness.root}/src/app.ts`,
    text: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    languageId: 'typescript',
    selections: [{ anchor: [1, 0], active: [2, 13] }]
  });
  harness.setActiveEditor(editor);
  harness.setVisibleEditors([editor]);

  const startsBefore = harness.services.reduce((sum, service) => sum + service.starts.length, 0);
  const targetWritesBefore = target.service.writes.length;
  const otherWritesBefore = other.service.writes.length;

  await harness.provider.sendSelectionOrFile();

  const pastes = harness.messagesOfType('terminal-paste');
  assert.equal(pastes.length, 1, 'exactly one draft reaches the webview');
  assert.equal(pastes[0].tabId, targetId, 'the draft targets the active tab only');
  assert.equal(pastes[0].execute, undefined, 'the draft is never submitted');
  const draft: string = pastes[0].text;
  assert.match(draft, /src\/app\.ts:2-3/, 'the citation carries the exact selected lines');
  assert.ok(draft.includes('```typescript'), 'the snippet stays inline for a plain shell');
  assert.ok(draft.includes('const b = 2;\nconst c = 3;'), 'the selected code travels verbatim');
  assert.equal(draft.includes('const a = 1;'), false, 'unselected code stays out of the draft');
  assert.equal(draft.endsWith('\n'), false, 'no trailing newline could run the draft');

  assert.equal(harness.messagesOfType('terminal-insert').length, 0);
  assert.equal(harness.messagesOfType('terminal-input').length, 0);
  assert.equal(target.service.writes.length, targetWritesBefore, 'nothing is typed into the PTY');
  assert.equal(other.service.writes.length, otherWritesBefore);
  assert.equal(
    harness.services.reduce((sum, service) => sum + service.starts.length, 0),
    startsBefore,
    'no extra shell is started'
  );
  harness.dispose();
});

test('sendSelectionOrFile snapshots the selection before the view steals focus', async () => {
  const harness = await bootReady();
  const selected = harness.createEditor({
    path: `${harness.root}/src/selected.ts`,
    text: 'alpha\nbeta\ngamma\n',
    languageId: 'typescript',
    selections: [{ anchor: [0, 0], active: [1, 4] }]
  });
  const focused = harness.createEditor({
    path: `${harness.root}/src/focused.ts`,
    text: 'one\ntwo\nthree\n',
    languageId: 'typescript',
    selections: [{ anchor: [0, 0], active: [2, 5] }]
  });
  harness.setActiveEditor(selected);
  harness.setVisibleEditors([selected]);

  let focusCalls = 0;
  harness.onViewFocus(() => {
    focusCalls += 1;
    // Revealing the sidebar is what changes the active editor in the host.
    harness.setActiveEditor(focused);
    harness.setVisibleEditors([focused]);
  });

  await harness.provider.sendSelectionOrFile();

  assert.ok(focusCalls >= 1, 'show() really focused the view');
  const pastes = harness.messagesOfType('terminal-paste');
  assert.equal(pastes.length, 1);
  const draft: string = pastes[0].text;
  assert.match(draft, /src\/selected\.ts:1-2/, 'the pre-focus selection wins');
  assert.ok(draft.includes('alpha\nbeta'));
  assert.equal(draft.includes('focused.ts'), false);
  assert.equal(draft.includes('one\ntwo'), false);
  harness.dispose();
});

test('sendSelectionOrFile turns a clean whole file into a relative path reference', async () => {
  const harness = await bootReady();
  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab);
  const editor = harness.createEditor({
    path: `${harness.root}/todo.txt`,
    text: 'first\nsecond\n',
    languageId: 'plaintext',
    selections: [{ anchor: [0, 0], active: [0, 0] }]
  });
  harness.setActiveEditor(editor);
  harness.setVisibleEditors([editor]);

  const startsBefore = tab.service.starts.length;
  const writesBefore = tab.service.writes.length;

  await harness.provider.sendSelectionOrFile();

  const pastes = harness.messagesOfType('terminal-paste');
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0].tabId, tab.id);
  assert.equal(pastes[0].execute, undefined);
  assert.equal(pastes[0].text, 'todo.txt', 'a clean file stays a relative path reference');
  assert.equal(String(pastes[0].text).includes('\n'), false);
  assert.equal(harness.messagesOfType('terminal-insert').length, 0);
  assert.equal(harness.messagesOfType('terminal-input').length, 0);
  assert.equal(tab.service.writes.length, writesBefore, 'nothing is typed into the PTY');
  assert.equal(tab.service.starts.length, startsBefore);
  harness.dispose();
});

/* ------------------------------------------------ removed side actions */

test('removed supplemental webview messages are inert', async () => {
  const harness = await bootReady();
  const tab = harness.tab(harness.activeTabId());
  assert.ok(tab);
  const titleBefore = tab.title;
  const postsBefore = harness.posts.length;

  for (const message of [
    { type: 'rename-tab', tabId: tab.id, title: 'renamed' },
    { type: 'pick-workspace-context' },
    { type: 'open-in-editor', text: 'output' },
    { type: 'insert-into-editor', text: 'output' },
    { type: 'insert-text', text: 'output' },
    { type: 'toggle-draft' }
  ]) {
    // The host no longer has a handler for these: they must not write to the
    // shell, rename a tab, open an editor, or post extra webview state.
    await harness.send(message);
  }

  assert.equal(tab.title, titleBefore, 'a tab cannot be renamed from the webview');
  assert.deepEqual(tab.service.writes, [], 'nothing reaches the PTY');
  assert.equal(harness.posts.length, postsBefore, 'no state or toast is emitted');
  harness.dispose();
});
