import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { quoteForShell } from '../src/shellQuote';

test('PowerShell quoting escapes single quotes by doubling them', () => {
  assert.equal(quoteForShell('C:\\work\\app.ts', 'win32'), "'C:\\work\\app.ts'");
  assert.equal(quoteForShell("it's here", 'win32'), "'it''s here'");
});

test('POSIX quoting closes and reopens around a single quote', () => {
  assert.equal(quoteForShell('/work/app.ts', 'linux'), "'/work/app.ts'");
  assert.equal(quoteForShell("it's here", 'linux'), "'it'\\''s here'");
  assert.equal(quoteForShell('a b; rm -rf x', 'darwin'), "'a b; rm -rf x'");
});

test('newlines collapse so an inserted path cannot submit a command', () => {
  assert.equal(quoteForShell('one\ntwo\r\nthree', 'win32'), "'one two three'");
  assert.equal(quoteForShell('one\ntwo', 'linux'), "'one two'");
});

test('non-string values become an empty quoted token', () => {
  assert.equal(quoteForShell(undefined as unknown as string, 'linux'), "''");
  assert.equal(quoteForShell(null as unknown as string, 'win32'), "''");
});
