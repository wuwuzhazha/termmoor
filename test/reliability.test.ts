import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  normalizeOpenPathOutcome,
  runningOrStartingTabs
} from '../src/terminal/reliability';

test('normalizeOpenPathOutcome separates cancelled from missing', () => {
  assert.equal(normalizeOpenPathOutcome('opened'), 'opened');
  assert.equal(normalizeOpenPathOutcome(true), 'opened');
  assert.equal(normalizeOpenPathOutcome('cancelled'), 'cancelled');
  assert.equal(normalizeOpenPathOutcome('missing'), 'missing');
  // Legacy boolean + anything unexpected is a genuine miss, never a cancel.
  assert.equal(normalizeOpenPathOutcome(false), 'missing');
  assert.equal(normalizeOpenPathOutcome(undefined), 'missing');
  assert.equal(normalizeOpenPathOutcome(null), 'missing');
});

test('runningOrStartingTabs finds active work only', () => {
  const tabs = [
    { id: 'a', running: false, starting: false },
    { id: 'b', running: true },
    { id: 'c', running: false, starting: true },
    { id: 'd', running: false }
  ];

  assert.deepEqual(
    runningOrStartingTabs(tabs).map((tab) => tab.id),
    ['b', 'c']
  );
  assert.deepEqual(runningOrStartingTabs([]), []);
});
