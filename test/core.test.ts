import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { stripTerminalControl, terminalAttachment } from '../src/shared/attachments';
import { buildCmdCommandLine, quoteForCmd } from '../src/shared/cmdline';
import { getStrings } from '../src/shared/strings';
import { findFileRefs, parseFileRef } from '../webview/fileRefs';

test('English and Chinese expose the same string keys', () => {
  assert.deepEqual(Object.keys(getStrings('en')).sort(), Object.keys(getStrings('zh')).sort());
});

test('file references parse paths and line ranges', () => {
  const plain = parseFileRef('src/net/socket.ts');
  assert.equal(plain?.path, 'src/net/socket.ts');
  assert.equal(plain?.line, undefined);

  const line = parseFileRef('src/net/socket.ts:38');
  assert.equal(line?.path, 'src/net/socket.ts');
  assert.equal(line?.line, 38);

  const range = parseFileRef('src/net/socket.ts:38-45');
  assert.equal(range?.path, 'src/net/socket.ts');
  assert.equal(range?.line, 38);
  assert.equal(range?.endLine, 45);

  const windows = parseFileRef('C:\\work\\app\\src\\main.ts:12:4');
  assert.equal(windows?.path, 'C:\\work\\app\\src\\main.ts');
  assert.equal(windows?.line, 12);
  assert.equal(windows?.column, 4);
});

test('free-text scanning skips URLs', () => {
  const refs = findFileRefs(
    'Open src/net/socket.ts:38-45 and https://example.com/a.ts then run --config=app.json'
  );
  const paths = refs.map((match) => match.ref.path);
  assert.ok(paths.includes('src/net/socket.ts'));
  assert.ok(!paths.some((item) => item.includes('example.com')));
});

test('terminal attachments strip control sequences and clip output', () => {
  const attachment = terminalAttachment('\x1b[31mred\x1b[0m\r\nnext', 'Terminal output', 5);
  assert.equal(attachment?.text, 'red\nn\n… (truncated)');
  assert.equal(stripTerminalControl('\x1b[31mred\x1b[0m'), 'red');
});

test('cmd quoting survives spaces, quotes, and metacharacters', () => {
  assert.equal(quoteForCmd(''), '""');
  assert.equal(quoteForCmd('npm'), 'npm');
  assert.equal(quoteForCmd('C:\\Program Files\\a.cmd'), '"C:\\Program Files\\a.cmd"');
  assert.equal(quoteForCmd('a"b'), '"a""b"');
  assert.equal(
    buildCmdCommandLine('C:\\a b\\cli.cmd', ['--flag', 'x"y']),
    '/d /s /c ""C:\\a b\\cli.cmd" --flag "x""y""'
  );
});
