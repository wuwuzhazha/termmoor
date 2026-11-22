import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { splitLinkTarget } from '../src/shared/linkTarget';

test('plain paths pass through untouched', () => {
  assert.deepEqual(splitLinkTarget('src/app.c'), { path: 'src/app.c' });
  assert.deepEqual(splitLinkTarget(String.raw`E:\Xcp\src\app.c`), {
    path: String.raw`E:\Xcp\src\app.c`
  });
});

test('colon suffixes are stripped and parsed', () => {
  assert.deepEqual(splitLinkTarget('src/app.c:42'), { path: 'src/app.c', line: 42 });
  assert.deepEqual(splitLinkTarget('src/app.c:42:8'), { path: 'src/app.c', line: 42, column: 8 });
  assert.deepEqual(splitLinkTarget(String.raw`E:\Xcp\main.c:42:8`), {
    path: String.raw`E:\Xcp\main.c`,
    line: 42,
    column: 8
  });
});

test('a bare drive letter is not a citation suffix', () => {
  assert.deepEqual(splitLinkTarget(String.raw`E:\Xcp\main.c`), {
    path: String.raw`E:\Xcp\main.c`
  });
  assert.deepEqual(splitLinkTarget('E:'), { path: 'E:' });
});

test('parenthesized compiler locations are parsed', () => {
  assert.deepEqual(splitLinkTarget('src/main.c(42,8)'), {
    path: 'src/main.c',
    line: 42,
    column: 8
  });
  assert.deepEqual(splitLinkTarget('src/main.c(42)'), { path: 'src/main.c', line: 42 });
});

test('OSC 8 fragments are stripped from file URLs', () => {
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/main.c#L42'), {
    path: 'file:///E:/Xcp/main.c',
    line: 42
  });
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/main.c#L42-L45'), {
    path: 'file:///E:/Xcp/main.c',
    line: 42
  });
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/main.c#L42C8'), {
    path: 'file:///E:/Xcp/main.c',
    line: 42,
    column: 8
  });
});

test('wrapping quotes from citations are removed', () => {
  assert.deepEqual(splitLinkTarget(`'${String.raw`E:\Xcp\main.c`}:42'`), {
    path: String.raw`E:\Xcp\main.c`,
    line: 42
  });
});

test('invalid line numbers are dropped while the path survives', () => {
  assert.deepEqual(splitLinkTarget('src/app.c:0'), { path: 'src/app.c' });
  assert.deepEqual(splitLinkTarget(''), { path: '' });
});

test('VS Code file scheme is rewritten to a plain path', () => {
  assert.deepEqual(splitLinkTarget('vscode://file/E:/Xcp/docs/a.md'), {
    path: 'E:/Xcp/docs/a.md'
  });
  assert.deepEqual(splitLinkTarget('vscode://file/E:/Xcp/docs/a.md:42'), {
    path: 'E:/Xcp/docs/a.md',
    line: 42
  });
  assert.deepEqual(splitLinkTarget('vscode-insiders://file/e%3A/Xcp/a.md'), {
    path: 'e:/Xcp/a.md'
  });
});

test('percent-encoded targets are decoded, including an escaped suffix', () => {
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/docs/a.md%23L42'), {
    path: 'file:///E:/Xcp/docs/a.md',
    line: 42
  });
  assert.deepEqual(splitLinkTarget('file:///E%3A%5CXcp%5Ca.md'), {
    path: String.raw`file:///E:\Xcp\a.md`
  });
  // Malformed escapes stay verbatim instead of throwing.
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/100%zz.md'), {
    path: 'file:///E:/Xcp/100%zz.md'
  });
});

test('invisible formatting characters are removed', () => {
  const target = String.raw`E:\Xcp\a.md`;
  assert.deepEqual(splitLinkTarget(`\u200b${target}`), { path: target });
  assert.deepEqual(splitLinkTarget(`\ufeff${target}`), { path: target });
});

test('a drive path that gained a leading slash is repaired', () => {
  // `file://` URIs stay intact: the host path policy parses them itself.
  assert.deepEqual(splitLinkTarget('file:///E:/Xcp/a.md'), { path: 'file:///E:/Xcp/a.md' });
  assert.deepEqual(splitLinkTarget('/E:/Xcp/a.md'), { path: 'E:/Xcp/a.md' });
});
