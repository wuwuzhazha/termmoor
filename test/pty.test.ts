import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCmdCommandLine } from '../src/shared/cmdline';
import type { TerminalCommand } from '../src/shared/protocol';
import { buildSpawnSpec, clampDimension } from '../src/terminal/pty';

function command(file: string, args: string[] = []): TerminalCommand {
  return { file, args, cwd: 'C:\\work' };
}

const COMSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';

test('.cmd files are handed to ComSpec on win32 and keep their args/requestedFile', () => {
  const file = 'C:\\Program Files\\agent\\agent.cmd';
  const args = ['--name', 'a b', '--path=C:\\Users\\me\\x.txt'];
  const spec = buildSpawnSpec(command(file, args), 'win32');

  assert.equal(spec.file, COMSpec);
  assert.equal(spec.viaCmdShell, true);
  assert.equal(spec.requestedFile, file);
  assert.equal(typeof spec.args, 'string');
  assert.equal(spec.args, buildCmdCommandLine(file, args));
});

test('.bat files also go through ComSpec', () => {
  const file = 'C:\\tools\\run.bat';
  const spec = buildSpawnSpec(command(file, []), 'win32');

  assert.equal(spec.file, COMSpec);
  assert.equal(spec.viaCmdShell, true);
  assert.equal(spec.requestedFile, file);
  assert.equal(spec.args, buildCmdCommandLine(file, []));
});

test('cmd quoting survives embedded quotes', () => {
  const file = 'C:\\tools\\a.cmd';
  const args = ['quote"inside', ''];
  const spec = buildSpawnSpec(command(file, args), 'win32');

  assert.equal(spec.args, buildCmdCommandLine(file, args));
  assert.ok((spec.args as string).includes('"quote""inside"'));
  assert.ok((spec.args as string).includes('""'));
});

test('non-Windows platforms keep the file and args untouched', () => {
  const file = 'C:\\tools\\agent.cmd';
  const args = ['--name', 'a b'];
  const spec = buildSpawnSpec(command(file, args), 'linux');

  assert.equal(spec.file, file);
  assert.deepEqual(spec.args, args);
  assert.equal(spec.viaCmdShell, false);
  assert.equal(spec.requestedFile, file);
});

test('the default platform matches the host platform', () => {
  const cmd = command('C:\\tools\\agent.cmd', ['--ui']);
  assert.deepEqual(buildSpawnSpec(cmd), buildSpawnSpec(cmd, process.platform));
});

test('clampDimension floors, rejects non-finite values and enforces the lower bound', () => {
  assert.equal(clampDimension(80, 24), 80);
  assert.equal(clampDimension(80.9, 24), 80);
  assert.equal(clampDimension(2, 80), 2);
  assert.equal(clampDimension(1.9, 80), 2);
  assert.equal(clampDimension(0, 24), 2);
  assert.equal(clampDimension(-7, 24), 2);
  assert.equal(clampDimension(NaN, 80), 80);
  assert.equal(clampDimension(Infinity, 24), 24);
  assert.equal(clampDimension(-Infinity, 24), 24);
  // Production has no upper bound; huge finite values are only floored.
  assert.equal(clampDimension(1_000_000.7, 80), 1_000_000);
});
