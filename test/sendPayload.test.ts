/**
 * Editor-to-terminal payload regressions.
 *
 * The pure half pins the payload decisions (citation + inline code vs. context
 * file) and the range maths for reversed, end-at-column-0 and multi-cursor
 * selections. The second half runs the real `ContextService` against a small
 * `vscode` seam so workspace-relative paths and capture wiring are covered.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { MAX_CONTENT_CHARS } from '../src/contextFormat';
import {
  buildSendPayload,
  composeSendDraft,
  formatLocation,
  MAX_INLINE_CHARS,
  normalizeSelection,
  type SendPayloadPlan
} from '../src/contextPayload';
import { createVscodeMock, installVscodeMock } from './helpers/vscodeMock';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-send-'));
const root = path.join(parent, 'workspace');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'My File.ts'), 'one\ntwo\nthree\nfour\n');
fs.writeFileSync(path.join(root, 'src', 'dirty.ts'), 'const a = 1;\nconst b = 2;\n');

const mock = createVscodeMock([root]);
installVscodeMock(mock);

after(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Range maths                                                         */
/* ------------------------------------------------------------------ */

test('normalizeSelection converts exclusive ends into 1-based lines', () => {
  // Selection from the middle of line 12 down to column 0 of line 14: the
  // last line the user sees is 13, and there is no end column.
  assert.deepEqual(normalizeSelection(pos(11, 4), pos(13, 0)), {
    startLine: 12,
    endLine: 13,
    startColumn: 5,
    endColumn: undefined
  });
  // Mid-line end includes that line and reports the exclusive 1-based column.
  assert.deepEqual(normalizeSelection(pos(11, 0), pos(13, 2)), {
    startLine: 12,
    endLine: 14,
    startColumn: 1,
    endColumn: 3
  });
  // A single-line selection stays on one line.
  assert.deepEqual(normalizeSelection(pos(4, 2), pos(4, 7)), {
    startLine: 5,
    endLine: 5,
    startColumn: 3,
    endColumn: 8
  });
});

test('a reversed (bottom-up) selection yields the same range as a forward one', () => {
  const forward = normalizeSelection(pos(11, 4), pos(13, 0));
  assert.deepEqual(normalizeSelection(pos(13, 0), pos(11, 4)), forward);
  const single = normalizeSelection(pos(4, 2), pos(4, 7));
  assert.deepEqual(normalizeSelection(pos(4, 7), pos(4, 2)), single);
});

test('formatLocation keeps the path and the exact line range on one line', () => {
  assert.equal(formatLocation('src/a.ts'), 'src/a.ts');
  assert.equal(formatLocation('src/a.ts', { startLine: 12, endLine: 12 }), 'src/a.ts:12-12');
  assert.equal(formatLocation('src/a.ts', { startLine: 12, endLine: 14 }), 'src/a.ts:12-14');
});

/* ------------------------------------------------------------------ */
/* Payload decisions                                                   */
/* ------------------------------------------------------------------ */

test('a small selection travels inline with its citation and language tag', () => {
  const plan = buildSendPayload({
    path: 'src/foo.ts',
    languageId: 'typescript',
    selections: [
      { startLine: 12, endLine: 12, startColumn: 5, endColumn: 14, text: 'const a = 1;' }
    ]
  });
  assert.equal(plan.citation, 'src/foo.ts:12-12');
  assert.equal(plan.inline, 'src/foo.ts:12-12\n```typescript\nconst a = 1;\n```');
  assert.equal(plan.contextFile, undefined);
  assert.equal(plan.truncated, false);
  assert.equal(composeSendDraft(plan), plan.inline);
});

test('multiple selections are captured in editor order with one citation each', () => {
  const plan = buildSendPayload({
    path: 'src/multi.ts',
    languageId: 'ts',
    selections: [
      { startLine: 3, endLine: 4, startColumn: 1, endColumn: undefined, text: 'a\nb' },
      { startLine: 10, endLine: 11, startColumn: 3, endColumn: 9, text: 'c\nd' }
    ]
  });
  assert.equal(plan.citation, 'src/multi.ts:3-4, src/multi.ts:10-11');
  assert.equal(
    composeSendDraft(plan),
    [
      'src/multi.ts:3-4',
      '```ts',
      'a',
      'b',
      '```',
      'src/multi.ts:10-11',
      '```ts',
      'c',
      'd',
      '```'
    ].join('\n')
  );
});

test('a large selection goes to a context file that repeats the citation', () => {
  const text = Array.from({ length: 900 }, (_, index) => `const value${index} = ${index};`).join(
    '\n'
  );
  const plan = buildSendPayload({
    path: 'src/big.ts',
    languageId: 'typescript',
    selections: [
      { startLine: 1, endLine: 900, startColumn: 1, endColumn: undefined, text }
    ]
  });
  assert.ok(text.length > MAX_INLINE_CHARS);
  assert.equal(plan.inline, '');
  assert.equal(plan.contextFile?.kind, 'selection');
  assert.equal(plan.contextFile?.ext, '.txt');
  assert.ok(plan.contextFile?.text.startsWith('src/big.ts:1-900\n```typescript\n'));
  assert.ok(plan.contextFile?.text.includes('const value899 = 899;'));
  const draft = composeSendDraft(plan, '/tmp/termmoor-ctx/selection-abc.txt');
  assert.equal(draft, "src/big.ts:1-900\n'/tmp/termmoor-ctx/selection-abc.txt'");
  assert.ok(!draft.includes('const value0'), 'the code is not pasted into the draft');
});

test('the inline budget is inclusive and only switches at the boundary', () => {
  const selection = {
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 4,
    text: 'abc'
  };
  const wide = buildSendPayload({ path: 'src/a.ts', selections: [selection] });
  const exact = buildSendPayload({
    path: 'src/a.ts',
    selections: [selection],
    inlineLimit: wide.inline.length
  });
  assert.equal(exact.inline, wide.inline);

  const over = buildSendPayload({
    path: 'src/a.ts',
    selections: [selection],
    inlineLimit: wide.inline.length - 1
  });
  assert.equal(over.inline, '');
  assert.equal(over.contextFile?.kind, 'selection');
  assert.ok(over.contextFile?.text.startsWith('src/a.ts:1-1\n```\nabc\n```'));
});

test('a clean whole file is a quoted path reference only', () => {
  const plan = buildSendPayload({ path: 'src/plain.ts', fileText: 'a\nb\n' });
  assert.deepEqual(plan, { citation: 'src/plain.ts', inline: '', truncated: false });
  assert.equal(composeSendDraft(plan), 'src/plain.ts');

  const spaced = buildSendPayload({ path: 'src/My Dir/plain.ts' });
  assert.equal(composeSendDraft(spaced), "'src/My Dir/plain.ts'");
});

test('an unsaved whole-file buffer travels through a context file', () => {
  const plan = buildSendPayload({
    path: 'src/dirty.ts',
    languageId: 'typescript',
    fileText: 'const a = 1;\nconst b = 2;\n',
    dirty: true
  });
  assert.equal(plan.inline, '');
  assert.equal(plan.citation, 'src/dirty.ts');
  assert.equal(plan.contextFile?.kind, 'file');
  assert.equal(
    plan.contextFile?.text,
    'src/dirty.ts:1-2\n```typescript\nconst a = 1;\nconst b = 2;\n```'
  );
  assert.equal(
    composeSendDraft(plan, '/tmp/termmoor-ctx/file-abc.txt'),
    "src/dirty.ts\n'/tmp/termmoor-ctx/file-abc.txt'"
  );
});

test('a failed context-file write degrades to the citation', () => {
  const plan = buildSendPayload({
    path: 'src/big.ts',
    selections: [{ startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, text: 'x'.repeat(MAX_INLINE_CHARS + 1) }]
  });
  assert.ok(plan.contextFile);
  assert.equal(composeSendDraft(plan), plan.citation);
});

test('blank selections and empty captures never produce an empty draft body', () => {
  const blank = buildSendPayload({
    path: 'src/a.ts',
    selections: [{ startLine: 5, endLine: 5, startColumn: 1, endColumn: 3, text: ' \n\t ' }]
  });
  assert.deepEqual(blank, { citation: 'src/a.ts', inline: '', truncated: false });
});

test('the fenced block grows past backtick runs inside the code', () => {
  const plan = buildSendPayload({
    path: 'src/fence.md',
    selections: [{ startLine: 1, endLine: 3, startColumn: 1, endColumn: 2, text: 'a\n```\nb' }]
  });
  assert.equal(plan.inline, 'src/fence.md:1-3\n````\na\n```\nb\n````');
});

/* ------------------------------------------------------------------ */
/* Draft and path safety                                               */
/* ------------------------------------------------------------------ */

test('captured text is clipped at the shared limit and flagged', () => {
  const plan = buildSendPayload({
    path: 'src/huge.ts',
    selections: [
      {
        startLine: 1,
        endLine: 1,
        startColumn: 1,
        endColumn: 2,
        text: 'x'.repeat(MAX_CONTENT_CHARS + 100)
      }
    ]
  });
  assert.equal(plan.truncated, true);
  assert.ok(plan.contextFile?.text.endsWith('\n… (truncated)'));
  assert.ok((plan.contextFile?.text.length ?? 0) <= MAX_CONTENT_CHARS + '\n… (truncated)'.length);
});

test('captured control bytes cannot drive the shell', () => {
  const plan = buildSendPayload({
    path: 'src/log.txt',
    selections: [
      {
        startLine: 1,
        endLine: 2,
        startColumn: 1,
        endColumn: 2,
        text: '\u001b[31mred\u001b[0m\u0003\u0000tail\ttab'
      }
    ]
  });
  const draft = composeSendDraft(plan);
  assert.ok(!draft.includes('\u001b'), 'no ESC (terminal escape injection)');
  assert.ok(!draft.includes('\u0003'), 'no Ctrl-C (would interrupt the shell)');
  assert.ok(!draft.includes('\u0000'), 'no NUL');
  assert.ok(draft.includes('[31mred[0m'), 'the removed ESC leaves inert text');
  assert.ok(draft.includes('tail\ttab'), 'tabs survive');
});

test('the draft never ends with a newline that could submit the line', () => {
  const plans: SendPayloadPlan[] = [
    buildSendPayload({
      path: 'src/a.ts',
      selections: [{ startLine: 1, endLine: 2, startColumn: 1, endColumn: 1, text: 'a\r\nb\n\n' }]
    }),
    buildSendPayload({ path: 'src/a.ts', fileText: 'a\nb\n', dirty: true }),
    buildSendPayload({ path: 'src/a.ts' })
  ];
  for (const plan of plans) {
    for (const draft of [composeSendDraft(plan), composeSendDraft(plan, '/tmp/ctx/a.txt')]) {
      assert.ok(!draft.endsWith('\n'), `draft ends with a newline: ${JSON.stringify(draft)}`);
      assert.ok(!draft.includes('\r'), `draft contains a carriage return: ${JSON.stringify(draft)}`);
    }
  }
});

test('paths are quoted only when a shell would split or expand them', () => {
  const spaced = buildSendPayload({ path: 'src/My Dir/a.ts' });
  assert.equal(spaced.citation, "'src/My Dir/a.ts'");

  const apostrophe = buildSendPayload({ path: "C:\\tmp\\it's.ts", platform: 'win32' });
  assert.equal(apostrophe.citation, "'C:\\tmp\\it''s.ts'");

  const posix = buildSendPayload({ path: "C:\\tmp\\it's.ts", platform: 'linux' });
  assert.equal(posix.citation, "'C:\\tmp\\it'\\''s.ts'");

  // A newline in a path would otherwise become a second draft line.
  const injected = buildSendPayload({ path: 'src/a\nb.ts' });
  assert.equal(injected.citation, "'src/a b.ts'");
});

/* ------------------------------------------------------------------ */
/* ContextService wiring                                               */
/* ------------------------------------------------------------------ */

type ContextModule = typeof import('../src/context');
type EditorLike = NonNullable<
  Parameters<InstanceType<ContextModule['ContextService']>['captureSendTarget']>[0]
>;

let contextModule: ContextModule | undefined;
async function loadContext(): Promise<ContextModule> {
  if (!contextModule) {
    contextModule = await import('../src/context');
  }
  return contextModule;
}

interface FakePosition {
  line: number;
  character: number;
}

function pos(line: number, character: number): FakePosition {
  return { line, character };
}

function makeEditor(options: {
  filePath: string;
  text: string;
  dirty?: boolean;
  languageId?: string;
  selections: Array<[FakePosition, FakePosition]>;
}): EditorLike {
  const lines = options.text.split('\n');
  const offset = (position: FakePosition): number => {
    let total = 0;
    for (let index = 0; index < position.line; index += 1) {
      total += lines[index].length + 1;
    }
    return total + position.character;
  };
  const uri = (mock.vscode.Uri as { file(value: string): unknown }).file(options.filePath);
  const document = {
    uri,
    languageId: options.languageId ?? 'typescript',
    isDirty: options.dirty ?? false,
    getText(range?: { start: FakePosition; end: FakePosition }) {
      return range ? options.text.slice(offset(range.start), offset(range.end)) : options.text;
    }
  };
  const selections = options.selections.map(([anchor, active]) => {
    // Real `vscode.Selection` extends `Range`, so `start`/`end` are ordered
    // even when the user dragged upwards (`anchor` below `active`).
    const backwards =
      active.line < anchor.line ||
      (active.line === anchor.line && active.character < anchor.character);
    return {
      anchor,
      active,
      start: backwards ? active : anchor,
      end: backwards ? anchor : active,
      isEmpty: anchor.line === active.line && anchor.character === active.character
    };
  });
  return {
    document,
    selection: selections[0],
    selections
  } as unknown as EditorLike;
}

test('captureSendTarget keeps workspace-relative paths and every selection', async () => {
  const { ContextService } = await loadContext();
  const service = new ContextService();
  const editor = makeEditor({
    filePath: path.join(root, 'src', 'My File.ts'),
    text: 'one\ntwo\nthree\nfour\n',
    selections: [
      [pos(0, 0), pos(1, 0)],
      [pos(3, 2), pos(2, 1)]
    ]
  });

  const capture = service.captureSendTarget(editor);
  assert.ok(capture);
  assert.equal(capture.path, 'src/My File.ts');
  assert.equal(capture.dirty, false);
  assert.deepEqual(capture.selections, [
    { startLine: 1, endLine: 1, startColumn: 1, endColumn: undefined, text: 'one\n' },
    { startLine: 3, endLine: 4, startColumn: 2, endColumn: 3, text: 'hree\nfo' }
  ]);
  assert.equal(capture.fileText, undefined);

  const draft = composeSendDraft(buildSendPayload(capture));
  assert.equal(
    draft,
    [
      "'src/My File.ts:1-1'",
      '```typescript',
      'one',
      '```',
      "'src/My File.ts:3-4'",
      '```typescript',
      'hree',
      'fo',
      '```'
    ].join('\n')
  );
});

test('captureSendTarget reads the whole buffer only when nothing is selected', async () => {
  const { ContextService } = await loadContext();
  const service = new ContextService();

  const dirty = makeEditor({
    filePath: path.join(root, 'src', 'dirty.ts'),
    text: 'const a = 1;\nconst b = 2;\n',
    dirty: true,
    selections: [[pos(1, 4), pos(1, 4)]]
  });
  const dirtyCapture = service.captureSendTarget(dirty);
  assert.ok(dirtyCapture);
  assert.deepEqual(dirtyCapture.selections, []);
  assert.equal(dirtyCapture.fileText, 'const a = 1;\nconst b = 2;\n');
  const plan = buildSendPayload(dirtyCapture);
  assert.equal(plan.contextFile?.kind, 'file');
  assert.equal(plan.contextFile?.text, 'src/dirty.ts:1-2\n```typescript\nconst a = 1;\nconst b = 2;\n```');

  const clean = makeEditor({
    filePath: path.join(root, 'src', 'My File.ts'),
    text: 'one\ntwo\nthree\nfour\n',
    selections: [[pos(0, 0), pos(0, 0)]]
  });
  const cleanCapture = service.captureSendTarget(clean);
  assert.ok(cleanCapture);
  assert.deepEqual(cleanCapture.selections, []);
  assert.equal(buildSendPayload(cleanCapture).contextFile, undefined);
  assert.equal(composeSendDraft(buildSendPayload(cleanCapture)), "'src/My File.ts'");
});

test('captureSendTarget returns nothing when no editor is available', async () => {
  const { ContextService } = await loadContext();
  const service = new ContextService();
  assert.equal(service.captureSendTarget(undefined), undefined);
});
