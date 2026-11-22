import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  buildShellCommand,
  extractCommandProgram,
  normalizeProcessTitle
} from '../src/terminal/shellIntegration';
import { reorderByIds } from '../src/terminal/tabOrder';
import { findFileRefs, parseFileRef } from '../webview/fileRefs';
import { tabIconKind } from '../webview/tabIcon';
import {
  CommandBlockTracker,
  findAdjacentPromptLine,
  parseOsc133Payload,
  parseOsc633Payload,
  type LineAnchor
} from '../webview/terminal/commandBlocks';
import { findBufferMatches, stepMatchIndex } from '../webview/terminal/search';

/* ------------------------------------------------------------------ */
/* Compiler parenthesized & Python traceback file references          */
/* ------------------------------------------------------------------ */

test('MSVC/Clang/Keil parenthesized diagnostics parse line and column', () => {
  const msvc = parseFileRef('E:\\Xcp\\Tests\\test_main.c(108,4)');
  assert.deepEqual(msvc, {
    path: 'E:\\Xcp\\Tests\\test_main.c',
    line: 108,
    column: 4,
    endLine: undefined
  });

  const lineOnly = parseFileRef('src/driver/can.c(42)');
  assert.deepEqual(lineOnly, {
    path: 'src/driver/can.c',
    line: 42,
    column: undefined,
    endLine: undefined
  });

  const scanned = findFileRefs('error C2065: E:\\Xcp\\Tests\\test_main.c(108, 4): undeclared');
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].ref.path, 'E:\\Xcp\\Tests\\test_main.c');
  assert.equal(scanned[0].ref.line, 108);
  assert.equal(scanned[0].ref.column, 4);
});

test('Python traceback lines jump to the cited line without duplicate inner matches', () => {
  const line = '  File "E:\\Xcp\\Tests\\run_all_tests.py", line 84, in main';
  const matches = findFileRefs(line);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref.path, 'E:\\Xcp\\Tests\\run_all_tests.py');
  assert.equal(matches[0].ref.line, 84);
});

/* ------------------------------------------------------------------ */
/* Buffer search engine                                                */
/* ------------------------------------------------------------------ */

test('findBufferMatches locates case-insensitive hits and multiple occurrences per row', () => {
  const lines = ['PS E:\\Xcp> build', 'Error: foo failed; FOO retry', 'done'];
  const hits = findBufferMatches(lines, 'foo');
  assert.deepEqual(hits, [
    { line: 1, startOffset: 7, length: 3 },
    { line: 1, startOffset: 19, length: 3 }
  ]);
  assert.deepEqual(findBufferMatches(lines, ''), []);
});

test('stepMatchIndex wraps cleanly in both directions', () => {
  assert.equal(stepMatchIndex(-1, 0, 1), -1);
  assert.equal(stepMatchIndex(0, 3, -1), 2);
  assert.equal(stepMatchIndex(2, 3, 1), 0);
  assert.equal(stepMatchIndex(1, 3, 1), 2);
});

/* ------------------------------------------------------------------ */
/* OSC 133 & OSC 633 shell integration parsing                         */
/* ------------------------------------------------------------------ */

class FakeAnchor implements LineAnchor {
  isDisposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.isDisposed = true;
  }
}

test('CommandBlockTracker records prompt lines, exact output range, and duration', () => {
  let currentLine = 0;
  let nowMs = 1_000;
  const tracker = new CommandBlockTracker(
    () => new FakeAnchor(currentLine),
    () => nowMs
  );

  // Prompt 1
  assert.equal(tracker.handleOsc133('A'), null);
  assert.equal(tracker.handleOsc133('B'), null);
  // User runs command on line 0; output flows across lines 1..3
  assert.equal(tracker.handleOsc133('C'), null);
  currentLine = 4;
  nowMs = 13_500;
  const done = tracker.handleOsc133('D;2');
  assert.ok(done);
  assert.equal(done.durationMs, 12_500);
  assert.equal(done.exitCode, 2);
  assert.equal(done.outputStartLine, 1);
  assert.equal(done.outputEndLine, 4);

  // Next prompt at line 4 without executing yet
  assert.equal(tracker.handleOsc133('A'), null);
  assert.equal(tracker.handleOsc133('B'), null);
  assert.deepEqual(tracker.promptLines(), [0, 4]);
  assert.deepEqual(tracker.lastOutputRange(5), { startLine: 1, endLineExclusive: 4 });

  // Empty Enter (`D` without `C`) must not fire a completion event
  assert.equal(tracker.handleOsc133('D;0'), null);
});

test('findAdjacentPromptLine navigates up and down across recorded prompts', () => {
  const prompts = [2, 15, 42];
  assert.equal(findAdjacentPromptLine(prompts, 45, -1), 42);
  assert.equal(findAdjacentPromptLine(prompts, 42, -1), 15);
  assert.equal(findAdjacentPromptLine(prompts, 2, -1), 2);
  assert.equal(findAdjacentPromptLine(prompts, 2, 1), 15);
  assert.equal(findAdjacentPromptLine(prompts, 42, 1), 42);
  assert.equal(findAdjacentPromptLine([], 10, -1), undefined);
});

test('parseOsc133Payload handles exit codes and ignores unknown commands', () => {
  assert.deepEqual(parseOsc133Payload('A'), { kind: 'A' });
  assert.deepEqual(parseOsc133Payload('D;0'), { kind: 'D', exitCode: 0 });
  assert.deepEqual(parseOsc133Payload('D;127'), { kind: 'D', exitCode: 127 });
  assert.equal(parseOsc133Payload('Z;1'), null);
});

test('parseOsc633Payload extracts executed commands and live working directories', () => {
  assert.deepEqual(parseOsc633Payload('E;pi --resume'), {
    kind: 'command',
    command: 'pi --resume'
  });
  assert.deepEqual(parseOsc633Payload('P;Cwd=E:\\Xcp\\Tests'), {
    kind: 'cwd',
    cwd: 'E:\\Xcp\\Tests'
  });
  assert.equal(parseOsc633Payload('E;   '), null);
  assert.equal(parseOsc633Payload('P;IsWindows=True'), null);
});

/* ------------------------------------------------------------------ */
/* Shell integration builder, command extraction & title normalization */
/* ------------------------------------------------------------------ */

test('buildShellCommand injects ExecutionPolicy-safe PowerShell hooks with OSC 133 & 633', () => {
  const winIntegrated = buildShellCommand({
    cwd: 'E:\\Xcp',
    enableIntegration: true,
    platform: 'win32'
  });
  assert.equal(winIntegrated.file, 'powershell.exe');
  assert.ok(winIntegrated.args.includes('-NoExit'));
  assert.ok(winIntegrated.env?.__TP_INIT?.includes('133;D'));
  assert.ok(winIntegrated.env?.__TP_INIT?.includes('633;E;'));
  assert.ok(winIntegrated.env?.__TP_INIT?.includes('633;P;Cwd='));

  const winPlain = buildShellCommand({
    cwd: 'E:\\Xcp',
    enableIntegration: false,
    platform: 'win32'
  });
  assert.deepEqual(winPlain, { file: 'powershell.exe', args: ['-NoLogo'], cwd: 'E:\\Xcp' });
});

test('buildShellCommand writes temporary bash/zsh integration files on POSIX', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-shell-test-'));
  try {
    const bashCmd = buildShellCommand({
      cwd: '/work',
      enableIntegration: true,
      integrationDir: tmp,
      platform: 'linux',
      env: { SHELL: '/bin/bash' }
    });
    assert.equal(bashCmd.file, '/bin/bash');
    assert.equal(bashCmd.args[0], '--rcfile');
    assert.ok(fs.existsSync(bashCmd.args[1]));

    const zshCmd = buildShellCommand({
      cwd: '/work',
      enableIntegration: true,
      integrationDir: tmp,
      platform: 'darwin',
      env: { SHELL: '/bin/zsh', ZDOTDIR: '/Users/dev' }
    });
    assert.equal(zshCmd.file, '/bin/zsh');
    assert.equal(zshCmd.env?.__TP_ORIG_ZDOTDIR, '/Users/dev');
    assert.ok(zshCmd.env?.ZDOTDIR && fs.existsSync(path.join(zshCmd.env.ZDOTDIR, '.zshrc')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('normalizeProcessTitle ignores xterm-256color and maps TUI titles cleanly', () => {
  assert.equal(normalizeProcessTitle('xterm-256color', 'pwsh'), 'pwsh');
  assert.equal(normalizeProcessTitle('Windows PowerShell', 'pwsh'), 'pwsh');
  assert.equal(normalizeProcessTitle('管理员: Windows PowerShell', 'pwsh'), 'pwsh');
  assert.equal(normalizeProcessTitle('π - E:\\Xcp', 'pwsh'), 'pi');
  assert.equal(normalizeProcessTitle('Claude Code - project', 'pwsh'), 'claude');
  assert.equal(
    normalizeProcessTitle('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    'pwsh'
  );
  assert.equal(normalizeProcessTitle('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'), 'claude');
  assert.equal(normalizeProcessTitle('/usr/local/bin/pi'), 'pi');
  assert.equal(normalizeProcessTitle('if ($env:__TP_INIT) { ... }', 'pwsh'), 'pwsh');
});

test('extractCommandProgram unwraps call operators, env vars, and npx wrappers', () => {
  assert.equal(extractCommandProgram('pi'), 'pi');
  assert.equal(extractCommandProgram('& "C:\\Tools\\pi.cmd" --resume'), 'pi');
  assert.equal(extractCommandProgram('npx --yes @anthropic-ai/claude'), 'claude');
  assert.equal(extractCommandProgram('FOO=1 python -m pytest'), 'python');
  assert.equal(extractCommandProgram('$env:DEBUG="1" codex --help'), 'codex');
  assert.equal(extractCommandProgram('   '), undefined);
});

test('tabIconKind preserves Agent/CLI icon via processHint even when tab is custom-renamed', () => {
  assert.equal(tabIconKind('架构讨论会话', 'pi'), 'pi');
  assert.equal(tabIconKind('代码审查', 'claude'), 'claude');
  assert.equal(tabIconKind('测试套件', 'python'), 'python');
  assert.equal(tabIconKind('构建脚本', 'npm'), 'node');
  assert.equal(tabIconKind('普通终端', 'pwsh'), 'shell');
});

/* ------------------------------------------------------------------ */
/* Live tab drag-reorder                                               */
/* ------------------------------------------------------------------ */

test('reorderByIds permutes tabs safely while preserving omitted tabs', () => {
  const tabs = [{ id: 'tab-1' }, { id: 'tab-2' }, { id: 'tab-3' }];
  assert.deepEqual(
    reorderByIds(tabs, ['tab-3', 'tab-1', 'tab-2']).map((t) => t.id),
    ['tab-3', 'tab-1', 'tab-2']
  );
  assert.deepEqual(
    reorderByIds(tabs, ['tab-2', 'unknown', 'tab-2']).map((t) => t.id),
    ['tab-2', 'tab-1', 'tab-3']
  );
});

test('package.nls.json and package.nls.zh-cn.json expose identical localization keys', () => {
  const root = path.resolve(__dirname, '..');
  const enNls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const zhNls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  assert.deepEqual(Object.keys(enNls).sort(), Object.keys(zhNls).sort());
});
