import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { wheelScrollLines } from '../webview/terminal/wheel';

test('pixel wheel deltas map to a few lines and keep the direction', () => {
  assert.equal(wheelScrollLines(-100, 0, 30), -3);
  assert.equal(wheelScrollLines(100, 0, 30), 3);
  assert.equal(wheelScrollLines(-4, 0, 30), -1);
  assert.equal(wheelScrollLines(0, 0, 30), 0);
});

test('line and page wheel deltas use their own units', () => {
  assert.equal(wheelScrollLines(-2, 1, 30), -2);
  assert.equal(wheelScrollLines(1, 1, 30), 1);
  assert.equal(wheelScrollLines(-1, 2, 30), -30);
  assert.equal(wheelScrollLines(2, 2, 30), 60);
});
