import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TerminalCommand } from '../src/shared/protocol';
import { TerminalService } from '../src/terminal/TerminalService';
import { createFakePtyFactory, type FakePty } from './helpers/fake-pty';

const COMMAND: TerminalCommand = { file: 'fake-agent', args: ['--ui'], cwd: 'C:\\work' };

interface Harness {
  service: TerminalService;
  procs: FakePty[];
  last(): FakePty;
  data: string[];
  exits: Array<number | null>;
}

function setup(options: { stopTimeoutMs?: number; exitOnKill?: boolean } = {}): Harness {
  const fake = createFakePtyFactory({ exitOnKill: options.exitOnKill });
  const service = new TerminalService({
    ptyFactory: fake.factory,
    stopTimeoutMs: options.stopTimeoutMs
  });
  const data: string[] = [];
  const exits: Array<number | null> = [];
  service.attach({
    onData: (chunk) => data.push(chunk),
    onExit: (code) => exits.push(code)
  });
  return { service, procs: fake.procs, last: fake.last, data, exits };
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('the default constructor still works and does not touch the native pty', async () => {
  const service = new TerminalService();
  assert.equal(service.isRunning, false);
  await service.stop();
  assert.equal(service.isRunning, false);
  service.dispose();
});

test('concurrent start() during a running pty spawns exactly one replacement', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  assert.equal(harness.procs.length, 1);
  const first = harness.last();

  await Promise.all([
    harness.service.start(COMMAND, 90, 30),
    harness.service.start(COMMAND, 100, 40)
  ]);

  assert.equal(harness.procs.length, 2, 'only one replacement pty may be spawned');
  assert.equal(first.killed, true);
  assert.equal(harness.service.isRunning, true);
  // The newest start won the race.
  assert.equal(harness.last().cols, 100);
  assert.equal(harness.last().rows, 40);
});

test('data and exit from the replaced pty are ignored', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const first = harness.last();
  await harness.service.start(COMMAND, 90, 30);
  const current = harness.last();
  const exitCount = harness.exits.length;

  first.emitData('stale');
  first.emitExit(1);

  assert.deepEqual(harness.data, []);
  assert.equal(harness.exits.length, exitCount);
  assert.equal(harness.service.isRunning, true);

  harness.service.write('hello');
  assert.deepEqual(current.written, ['hello']);
});

test('a late exit from the old pty does not affect the new pty', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const first = harness.last();
  await harness.service.start(COMMAND, 80, 24);

  first.emitExit(0);
  assert.equal(harness.service.isRunning, true);

  harness.last().emitData('alive');
  assert.deepEqual(harness.data, ['alive']);
});

test('stop() resolves through the exit path', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const proc = harness.last();

  await harness.service.stop();

  assert.equal(proc.killed, true);
  assert.equal(harness.service.isRunning, false);
  assert.deepEqual(harness.exits, [0]);
});

test('stop() resolves through the timeout path and releases the pty', async () => {
  const harness = setup({ stopTimeoutMs: 20, exitOnKill: false });
  await harness.service.start(COMMAND, 80, 24);
  const proc = harness.last();

  await harness.service.stop();

  assert.equal(proc.killed, true);
  assert.equal(harness.service.isRunning, false);
  assert.deepEqual(harness.exits, [], 'no exit event was ever reported');

  // The timed-out pty must be released: writes go nowhere and a second stop
  // is a no-op instead of waiting for another timeout.
  harness.service.write('after timeout');
  assert.deepEqual(proc.written, []);
  await harness.service.stop();
  assert.equal(harness.service.isRunning, false);
});

test('start() after a stop timeout ignores the stale pty', async () => {
  const harness = setup({ stopTimeoutMs: 20, exitOnKill: false });
  await harness.service.start(COMMAND, 80, 24);
  const stale = harness.last();
  await harness.service.stop();

  await harness.service.start(COMMAND, 90, 30);
  assert.equal(harness.procs.length, 2);
  assert.equal(harness.service.isRunning, true);

  const exitCount = harness.exits.length;
  stale.emitData('late');
  stale.emitExit(2);

  assert.deepEqual(harness.data, []);
  assert.equal(harness.exits.length, exitCount);
  assert.equal(harness.service.isRunning, true);
});

test('split surrogate pairs are buffered across chunks', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const proc = harness.last();
  const emoji = '\u{1F600}';
  const high = emoji[0];
  const low = emoji[1];

  proc.emitData(`before${high}`);
  assert.deepEqual(harness.data, ['before']);
  assert.equal(hasLoneSurrogate(harness.data.join('')), false);

  proc.emitData(`${low}after`);
  assert.deepEqual(harness.data, ['before', `${emoji}after`]);
  assert.equal(harness.data.join(''), `before${emoji}after`);
  assert.equal(hasLoneSurrogate(harness.data.join('')), false);

  // A chunk that is only a high surrogate is buffered, not emitted.
  proc.emitData(high);
  assert.deepEqual(harness.data, ['before', `${emoji}after`]);
  proc.emitData(low);
  assert.deepEqual(harness.data, ['before', `${emoji}after`, emoji]);
});

test('resize() clamps dimensions and tolerates an exited pty', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const proc = harness.last();

  harness.service.resize(100.9, 30.9);
  assert.deepEqual(proc.resizes, [[100, 30]]);

  harness.service.resize(0, 1.9);
  assert.deepEqual(proc.resizes, [
    [100, 30],
    [2, 2]
  ]);

  // Unchanged dimensions are not forwarded.
  harness.service.resize(2, 2);
  assert.equal(proc.resizes.length, 2);

  // A pty that has already exited throws from resize(); that is swallowed.
  proc.resizeThrows = true;
  assert.doesNotThrow(() => harness.service.resize(120, 40));
  assert.equal(proc.resizes.length, 2);

  proc.emitExit(0);
  assert.equal(harness.service.isRunning, false);
  assert.doesNotThrow(() => harness.service.resize(140, 50));
  assert.equal(proc.resizes.length, 2);
});

test('a failed start leaves running=false and no proc behind', async () => {
  const fake = createFakePtyFactory();
  let shouldFail = false;
  const service = new TerminalService({
    ptyFactory: (file, args, options) => {
      if (shouldFail) {
        throw new Error('spawn boom');
      }
      return fake.factory(file, args, options);
    }
  });
  service.attach({ onData: () => undefined, onExit: () => undefined });

  await service.start(COMMAND, 80, 24);
  const first = fake.last();

  shouldFail = true;
  await assert.rejects(service.start(COMMAND, 80, 24), /Failed to start terminal process/);
  await assert.rejects(service.start(COMMAND, 80, 24), /spawn boom/);

  assert.equal(service.isRunning, false);
  service.write('ignored');
  assert.deepEqual(first.written, []);
  await service.stop();
  assert.equal(service.isRunning, false);
});

test('processName filters out Windows node-pty xterm-256color placeholder', async () => {
  const harness = setup();
  await harness.service.start(COMMAND, 80, 24);
  const proc = harness.last() as unknown as { process: string };
  proc.process = 'xterm-256color';
  assert.equal(harness.service.processName, undefined);
  proc.process = 'pi';
  assert.equal(harness.service.processName, 'pi');
});
