/**
 * Navigation regressions against the real ContextService.
 *
 * The host module is normally imported inside the extension host, so this test
 * installs a small `vscode` seam and then dynamically imports `src/context`.
 * Targets are real files in a temp workspace: the path policy, realpath checks,
 * directory stat, and line/column mapping all run for real.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { findFileRefs } from '../webview/fileRefs';
import { splitLinkTarget } from '../src/shared/linkTarget';
import { createVscodeMock, installVscodeMock } from './helpers/vscodeMock';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-nav-'));
const root = path.join(parent, 'workspace');
const outside = path.join(parent, 'outside');

const spacedFile = path.join(root, 'My Dir', '说明 文档.md');
const spacedFolder = path.join(root, 'My Docs', 'Sub Folder');
const screenshotFile = path.join(root, 'Xcp', 'Xcp_Std.c');
const ambiguousA = path.join(root, 'a', 'Xcp.c');
const ambiguousB = path.join(root, 'b', 'Xcp.c');
const ethSource = path.join(root, 'src', 'xcp', 'XcpOnEth.c');
const frSource = path.join(root, 'src', 'xcp', 'XcpOnFr.c');
const ethGenerated = path.join(root, 'build', 'XcpOnEth.c');
const outsideFile = path.join(outside, 'secret.txt');
// Mirrors the reported layout: a real `Tests/integration` next to a staging
// copy under `.tmp/release-check-*/xcp-slave-*/Tests/integration`.
const integrationSource = path.join(root, 'Tests', 'integration');
const integrationStaging = path.join(
  root,
  '.tmp',
  'release-check-0.2.0',
  'xcp-slave-0.2.0',
  'Tests',
  'integration'
);
const integrationSourceFile = path.join(integrationSource, 'run_all.py');
const integrationStagingFile = path.join(integrationStaging, 'run_all.py');
const guideA = path.join(root, 'pkgA', 'docs', 'guide');
const guideB = path.join(root, 'pkgB', 'docs', 'guide');
const emptyFolder = path.join(root, 'empty', 'space');
const orphanFile = path.join(root, 'orphan.md');
/** A cwd that is inside the workspace but holds none of the folder citations. */
const searchCwd = path.join(root, 'src');

fs.mkdirSync(path.dirname(spacedFile), { recursive: true });
fs.mkdirSync(spacedFolder, { recursive: true });
fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
fs.mkdirSync(path.dirname(ambiguousA), { recursive: true });
fs.mkdirSync(path.dirname(ambiguousB), { recursive: true });
fs.mkdirSync(path.dirname(ethSource), { recursive: true });
fs.mkdirSync(path.dirname(ethGenerated), { recursive: true });
fs.mkdirSync(integrationSource, { recursive: true });
fs.mkdirSync(integrationStaging, { recursive: true });
fs.mkdirSync(guideA, { recursive: true });
fs.mkdirSync(guideB, { recursive: true });
// An empty folder has no files, so it cannot appear in the file index.
fs.mkdirSync(emptyFolder, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(spacedFile, 'line one\nline two\nline three\n');
fs.writeFileSync(screenshotFile, 'int Xcp_Std(void);\n');
fs.writeFileSync(ambiguousA, 'int a;\n');
fs.writeFileSync(ambiguousB, 'int b;\n');
fs.writeFileSync(ethSource, 'void XcpOnEth(void);\n');
fs.writeFileSync(frSource, 'void XcpOnFr(void);\n');
fs.writeFileSync(ethGenerated, 'void XcpOnEth(void);\n');
fs.writeFileSync(integrationSourceFile, 'print("source")\n');
fs.writeFileSync(integrationStagingFile, 'print("staging")\n');
fs.writeFileSync(path.join(guideA, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(guideB, 'b.txt'), 'b\n');
fs.writeFileSync(orphanFile, 'orphan\n');
fs.writeFileSync(outsideFile, 'outside\n');

const mock = createVscodeMock([root]);
installVscodeMock(mock);

after(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

type ContextModule = typeof import('../src/context');

let contextModule: ContextModule | undefined;
async function loadContext(): Promise<ContextModule> {
  if (!contextModule) {
    contextModule = await import('../src/context');
  }
  return contextModule;
}

function resetState(): void {
  mock.state.opened.length = 0;
  mock.state.revealed.length = 0;
  mock.state.warnings.length = 0;
  mock.state.quickPicks.length = 0;
  mock.state.warningAnswer = undefined;
  mock.state.quickPickAnswer = 'first';
}

test('openPath opens an exact spaced file at line and column', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('My Dir/说明 文档.md', 12, 3, root);

  assert.equal(result, 'opened');
  assert.deepEqual(mock.state.opened, [{ path: spacedFile, line: 12, column: 3 }]);
});

test('openPath reveals a quoted spaced folder instead of loading it', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const refs = findFileRefs('cd "My Docs/Sub Folder" now');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref.path, 'My Docs/Sub Folder');

  const result = await service.openPath(refs[0].ref.path, 1, 1, root);

  assert.equal(result, 'opened');
  assert.deepEqual(mock.state.revealed, [
    { command: 'revealInExplorer', path: spacedFolder }
  ]);
  assert.equal(mock.state.opened.length, 0);
});

test('an outside target is cancelled when the confirmation is dismissed', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.warningAnswer = undefined;

  const result = await service.openPath('../outside/secret.txt', 2, 4, root);

  assert.equal(result, 'cancelled');
  assert.equal(mock.state.warnings.length, 1);
  assert.equal(mock.state.opened.length, 0);
});

test('an outside target opens after the confirmation', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.warningAnswer = 'Open';

  const result = await service.openPath('../outside/secret.txt', 2, 4, root);

  assert.equal(result, 'opened');
  assert.deepEqual(mock.state.opened, [{ path: outsideFile, line: 2, column: 4 }]);
});

test('an ambiguous citation is cancelled when the quick pick is dismissed', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.quickPickAnswer = 'cancel';

  const result = await service.openPath('Xcp.c', 1, 1, root);

  assert.equal(result, 'cancelled');
  assert.equal(mock.state.quickPicks.length, 1);
  assert.equal(mock.state.opened.length, 0);
});

test('an ambiguous citation opens the chosen candidate', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.quickPickAnswer = 'first';

  const result = await service.openPath('Xcp.c', 5, 2, root);

  assert.equal(result, 'opened');
  assert.equal(mock.state.opened.length, 1);
  assert.ok([ambiguousA, ambiguousB].includes(mock.state.opened[0].path));
  assert.equal(mock.state.opened[0].line, 5);
  assert.equal(mock.state.opened[0].column, 2);
});

test('an ambiguous citation never silently jumps to the first same-name source', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  // Equal rank and equal depth: only the user can decide, so choosing the
  // second entry must open exactly that file instead of the first match.
  mock.state.quickPickAnswer = 1;

  const result = await service.openPath('Xcp.c', 3, 4, root);

  assert.equal(result, 'opened');
  assert.equal(mock.state.quickPicks.length, 1);
  assert.deepEqual(mock.state.opened, [{ path: ambiguousB, line: 3, column: 4 }]);
});

test('a generated copy of the same name never wins over the source', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('XcpOnEth.c', 7, 3, root);

  assert.equal(result, 'opened');
  assert.equal(mock.state.quickPicks.length, 0);
  assert.deepEqual(mock.state.opened, [{ path: ethSource, line: 7, column: 3 }]);
});

/**
 * Mirror the click path: the webview parses citations and calls
 * `open-path` with the ref's path/line/column, the host normalizes that path
 * through `splitLinkTarget`, then ContextService resolves it against the cwd.
 */
async function activateCitation(
  service: InstanceType<ContextModule['ContextService']>,
  text: string,
  cwd: string
): Promise<Array<{ token: string; outcome: string }>> {
  const results: Array<{ token: string; outcome: string }> = [];
  for (const match of findFileRefs(text)) {
    const target = splitLinkTarget(match.ref.path);
    const outcome = await service.openPath(
      target.path,
      match.ref.line ?? target.line,
      match.ref.column ?? target.column,
      cwd
    );
    results.push({ token: text.slice(match.start, match.end), outcome });
  }
  return results;
}

test('inline adjacent citations open as two separate files through the click pipeline', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  // Native-terminal A/B: the literal one-path reading of this token does not
  // exist on disk, so the adjacent citation can only work when it is split.
  assert.equal(fs.existsSync(path.join(root, 'XcpOnEth.c', 'XcpOnFr.c')), false);

  const results = await activateCitation(
    service,
    'see (XcpOnEth.c/XcpOnFr.c:42:8) now',
    root
  );

  assert.deepEqual(
    results.map((entry) => entry.token),
    ['XcpOnEth.c', 'XcpOnFr.c:42:8']
  );
  assert.deepEqual(
    results.map((entry) => entry.outcome),
    ['opened', 'opened']
  );
  assert.deepEqual(mock.state.opened, [
    { path: ethSource, line: 1, column: 1 },
    { path: frSource, line: 42, column: 8 }
  ]);
});

test('line:column survives both members of an unwrapped adjacent citation', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const results = await activateCitation(
    service,
    'XcpOnEth.c:12:3/XcpOnFr.c:34:8',
    root
  );

  assert.deepEqual(
    results.map((entry) => entry.outcome),
    ['opened', 'opened']
  );
  assert.deepEqual(mock.state.opened, [
    { path: ethSource, line: 12, column: 3 },
    { path: frSource, line: 34, column: 8 }
  ]);
});

test('a screenshot-style label falls back to the real file with line and column', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('STD/CAL Xcp_Std.c', 42, 8, root);

  assert.equal(result, 'opened');
  assert.deepEqual(mock.state.opened, [{ path: screenshotFile, line: 42, column: 8 }]);
});

test('a folder citation resolves the source folder, not the staging copy', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  // The link is relative to a cwd that holds neither copy, exactly like a
  // terminal that stayed in `src/` while the agent printed `integration/`.
  assert.equal(fs.existsSync(path.join(searchCwd, 'integration')), false);

  const results = await activateCitation(service, 'cd integration/', searchCwd);

  assert.deepEqual(results.map((entry) => entry.outcome), ['opened']);
  assert.equal(mock.state.quickPicks.length, 0, 'the staging copy is not a real tie');
  assert.equal(mock.state.opened.length, 0);
  assert.deepEqual(mock.state.revealed, [
    { command: 'revealInExplorer', path: integrationSource }
  ]);
});

test('a multi-segment folder citation resolves the source folder', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('Tests/integration', 1, 1, searchCwd);

  assert.equal(result, 'opened');
  assert.equal(mock.state.quickPicks.length, 0);
  assert.deepEqual(mock.state.revealed, [
    { command: 'revealInExplorer', path: integrationSource }
  ]);
});

test('a real folder tie is confirmed instead of opening the first match', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.quickPickAnswer = 1;

  const result = await service.openPath('docs/guide/', 1, 1, searchCwd);

  assert.equal(result, 'opened');
  assert.equal(mock.state.quickPicks.length, 1);
  assert.deepEqual(mock.state.revealed, [{ command: 'revealInExplorer', path: guideB }]);
});

test('a dismissed folder tie opens nothing', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();
  mock.state.quickPickAnswer = 'cancel';

  const result = await service.openPath('docs/guide/', 1, 1, searchCwd);

  assert.equal(result, 'cancelled');
  assert.equal(mock.state.quickPicks.length, 1);
  assert.equal(mock.state.revealed.length, 0);
  assert.equal(mock.state.opened.length, 0);
});

test('an empty folder is still reachable from a folder citation', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('space/', 1, 1, searchCwd);

  assert.equal(result, 'opened');
  assert.deepEqual(mock.state.revealed, [{ command: 'revealInExplorer', path: emptyFolder }]);
});

test('an explicit folder citation never falls back to a file name', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  // `orphan.md` exists at the root, but the citation names a folder.
  assert.equal(fs.existsSync(orphanFile), true);
  const result = await service.openPath('missing orphan.md/', 1, 1, searchCwd);

  assert.equal(result, 'missing');
  assert.equal(mock.state.opened.length, 0);
  assert.equal(mock.state.revealed.length, 0);
});

test('an unresolvable target reports missing', async () => {
  resetState();
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const result = await service.openPath('nope/missing.ts', 1, 1, root);

  assert.equal(result, 'missing');
  assert.equal(mock.state.opened.length, 0);
  assert.equal(mock.state.warnings.length, 0);
});
