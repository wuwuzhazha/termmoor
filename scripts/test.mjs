import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Windows npm scripts do not expand globs, so this script discovers every
 * test/*.test.ts, bundles each one to dist-test with the esbuild JS API, and
 * hands the explicit file list to `node --test`.
 */
const root = process.cwd();
const testDir = path.join(root, 'test');
const outDir = path.join(root, 'dist-test');

if (!fs.existsSync(testDir)) {
  console.error('[test] test directory not found');
  process.exit(1);
}

const entries = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (entries.length === 0) {
  console.error('[test] no test/*.test.ts files found');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const outputs = [];
for (const entry of entries) {
  const outfile = path.join(outDir, entry.replace(/\.ts$/, '.js'));
  await esbuild.build({
    entryPoints: [path.join(testDir, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    external: ['vscode', '@homebridge/node-pty-prebuilt-multiarch'],
    logLevel: 'warning'
  });
  outputs.push(outfile);
}

console.log(`[test] running ${outputs.length} file(s): ${entries.join(', ')}`);

const result = spawnSync(process.execPath, ['--test', ...outputs], {
  cwd: root,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
