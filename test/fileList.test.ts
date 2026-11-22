import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isPathish, looksLikeFileName, splitFileList, trimTrailingProse } from '../src/shared/fileList';

test('a slash between two complete file names is a list, not a directory', () => {
  assert.deepEqual(splitFileList('XcpOnEth.c/XcpOnFr.c'), ['XcpOnEth.c', 'XcpOnFr.c']);
  assert.deepEqual(splitFileList('a.md/b.md/c.md'), ['a.md', 'b.md', 'c.md']);
});

test('genuine paths are never split', () => {
  assert.deepEqual(splitFileList('src/net/socket.ts'), []);
  assert.deepEqual(splitFileList('Xcp/XcpOnEth.c'), []);
  assert.deepEqual(splitFileList('docs/a.md/docs/b.md'), []);
  assert.deepEqual(splitFileList('node_modules/pkg/index.js'), []);
});

test('a single file name is not a list', () => {
  assert.deepEqual(splitFileList('XcpOnEth.c'), []);
  assert.deepEqual(splitFileList(''), []);
});

test('backslash paths are never treated as lists', () => {
  assert.deepEqual(splitFileList(String.raw`Xcp\XcpOnEth.c`), []);
});

test('citation suffixes do not hide the extension', () => {
  assert.equal(looksLikeFileName('XcpOnFr.c:42'), true);
  assert.equal(looksLikeFileName('XcpOnFr.c(42,8)'), true);
  assert.equal(looksLikeFileName('XcpOnFr.c#L42'), true);
  assert.deepEqual(splitFileList('XcpOnEth.c/XcpOnFr.c:42'), ['XcpOnEth.c', 'XcpOnFr.c:42']);
});

test('line:column suffixes survive member validation', () => {
  assert.equal(looksLikeFileName('XcpOnFr.c:42:8'), true);
  assert.deepEqual(splitFileList('XcpOnEth.c/XcpOnFr.c:42:8'), [
    'XcpOnEth.c',
    'XcpOnFr.c:42:8'
  ]);
});

test('directory-looking segments are rejected', () => {
  assert.equal(looksLikeFileName('src'), false);
  assert.equal(looksLikeFileName('Xcp'), false);
  assert.equal(looksLikeFileName('.git'), false);
});

test('a trailing slash does not create an empty member', () => {
  assert.deepEqual(splitFileList('XcpOnEth.c/XcpOnFr.c/'), ['XcpOnEth.c', 'XcpOnFr.c']);
});

test('CJK prose is never absorbed into a file name', () => {
  assert.equal(isPathish('里的隐藏静态缓冲：XcpOnEth.c'), false);
  assert.equal(looksLikeFileName('里的隐藏静态缓冲：XcpOnEth.c'), false);
  assert.deepEqual(splitFileList('里的隐藏静态缓冲：XcpOnEth.c'), []);
});

test('full-width punctuation is stripped from a citation', () => {
  assert.deepEqual(trimTrailingProse('XcpOnFr.c。'), { token: 'XcpOnFr.c', trailing: '。' });
  assert.deepEqual(trimTrailingProse('XcpOnFr.c）'), { token: 'XcpOnFr.c', trailing: '）' });
  assert.deepEqual(trimTrailingProse('XcpOnFr.c'), { token: 'XcpOnFr.c', trailing: '' });
});

test('a Windows path with spaces stays pathish', () => {
  assert.equal(isPathish('Program Files/app.c'), true);
  assert.equal(isPathish('Xcp/a b.c'), true);
});
