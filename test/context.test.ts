import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  capText,
  decodeText,
  MAX_CONTENT_CHARS,
  selectionEndLine
} from '../src/contextFormat';
import { classifyOpenTarget, isInside } from '../src/security/pathPolicy';
import {
  addUniqueAttachments,
  attachmentKey,
  MAX_TERMINAL_ATTACHMENT_CHARS,
  terminalAttachment
} from '../src/shared/attachments';
import type { Attachment } from '../src/shared/protocol';

test('selectionEndLine treats the end position as exclusive', () => {
  // End at column 0 of line 2 means lines 0-1 are selected: display 2.
  assert.equal(selectionEndLine(0, 2, 0), 2);
  // End mid-line means the end line is included: display endLine + 1.
  assert.equal(selectionEndLine(0, 2, 4), 3);
  // A single-line selection.
  assert.equal(selectionEndLine(4, 4, 7), 5);
});

test('capText truncates with a marker and reports it', () => {
  assert.deepEqual(capText('short', 10), { text: 'short', truncated: false });
  assert.deepEqual(capText('abcdefghij', 4), { text: 'abcd\n… (truncated)', truncated: true });
  assert.equal(MAX_CONTENT_CHARS, 200_000);
  const capped = capText('x'.repeat(MAX_CONTENT_CHARS + 1));
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.endsWith('… (truncated)'));
});

test('decodeText marks NUL bytes as binary', () => {
  assert.deepEqual(decodeText(Buffer.from('hello', 'utf8')), { text: 'hello', binary: false });
  assert.deepEqual(decodeText(new Uint8Array([0x61, 0x00, 0x62])), { text: '', binary: true });
  assert.deepEqual(decodeText(Buffer.from('中文', 'utf8')), { text: '中文', binary: false });
});

test('terminal attachments clip at the shared limit and flag truncation', () => {
  assert.equal(MAX_TERMINAL_ATTACHMENT_CHARS, 200_000);
  const clipped = terminalAttachment('abcdef', 'Terminal output', 4);
  assert.equal(clipped?.text, 'abcd\n… (truncated)');
  assert.equal(clipped?.truncated, true);

  const whole = terminalAttachment('abcdef', 'Terminal output', 10);
  assert.equal(whole?.text, 'abcdef');
  assert.equal(whole?.truncated, undefined);
  assert.equal(terminalAttachment('   ', 'Terminal output'), undefined);
});

test('attachment identity keeps ranges apart and dedupes exact repeats', () => {
  const first: Attachment = {
    kind: 'selection',
    name: 'a.ts:1-2',
    uri: 'file:///a.ts',
    range: { startLine: 1, endLine: 2 },
    text: 'one'
  };
  const second: Attachment = { ...first, range: { startLine: 5, endLine: 6 }, text: 'two' };
  assert.notEqual(attachmentKey(first), attachmentKey(second));
  assert.deepEqual(addUniqueAttachments([first], [first, second]).map((item) => item.text), [
    'one',
    'two'
  ]);
});

test('open targets are classified against every workspace root', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-ctx-test-'));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const insideFile = path.join(root, 'note.txt');
  const outsideFile = path.join(outside, 'note.txt');
  fs.writeFileSync(insideFile, 'inside');
  fs.writeFileSync(outsideFile, 'outside');
  try {
    const inside = classifyOpenTarget('note.txt', root, [root]);
    assert.equal(inside.kind, 'workspace');
    assert.equal(inside.path, path.resolve(insideFile));

    assert.equal(classifyOpenTarget(outsideFile, root, [root]).kind, 'outside');
    assert.equal(classifyOpenTarget('../outside/note.txt', root, [root]).kind, 'outside');
    assert.equal(classifyOpenTarget(path.join(root, 'missing.txt'), root, [root]).kind, 'invalid');
    assert.equal(classifyOpenTarget('', root, [root]).kind, 'invalid');
    assert.equal(classifyOpenTarget('https://example.com/a.ts', root, [root]).kind, 'invalid');

    assert.equal(isInside(root, insideFile), true);
    assert.equal(isInside(root, outsideFile), false);
    assert.equal(isInside(root, `${root}-sibling`), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
