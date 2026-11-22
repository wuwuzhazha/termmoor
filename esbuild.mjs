import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {esbuild.BuildOptions[]} */
const configs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', '@homebridge/node-pty-prebuilt-multiarch'],
    sourcemap: dev,
    minify: !dev,
    logLevel: 'info'
  },
  {
    entryPoints: ['webview/main.ts'],
    bundle: true,
    outfile: 'media/webview/terminal.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: dev,
    minify: !dev,
    external: ['*.ttf'],
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl'
    },
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
    logLevel: 'info'
  }
];

fs.mkdirSync('dist', { recursive: true });
fs.mkdirSync(path.join('media', 'webview'), { recursive: true });

// Terminal Pro ships no on-disk agent assets; drop the copy left by older builds.
fs.rmSync(path.join('dist', 'pi-extension'), { recursive: true, force: true });

// Ship the native PTY package as a build artifact. The VSIX cannot rely on a
// node_modules tree (vsce drops it), so the extension requires dist/pty.
const ptyRoot = path.join('node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');
const ptyDest = path.join('dist', 'pty', 'node-pty');
if (fs.existsSync(ptyRoot)) {
  // Snapshot before copying: a partially failed copy could otherwise make the
  // stale dist copy look current.
  const installedVersion = readPtyVersion(ptyRoot);
  const existingVersion = readPtyVersion(ptyDest);
  try {
    fs.rmSync(ptyDest, { recursive: true, force: true });
    fs.mkdirSync(ptyDest, { recursive: true });
    for (const entry of ['package.json', 'LICENSE', 'lib', 'prebuilds']) {
      const source = path.join(ptyRoot, entry);
      if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(ptyDest, entry), { recursive: true });
      }
    }
    const prebuilds = path.join(ptyDest, 'prebuilds');
    const keep = `${process.platform}-${process.arch}`;
    if (fs.existsSync(prebuilds)) {
      for (const name of fs.readdirSync(prebuilds)) {
        if (name !== keep) {
          fs.rmSync(path.join(prebuilds, name), { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    const locked = error && (error.code === 'EPERM' || error.code === 'EBUSY');
    if (locked) {
      if (installedVersion && existingVersion && installedVersion === existingVersion) {
        console.warn(
          `[esbuild] dist/pty is locked; keeping the existing copy (v${existingVersion} matches installed v${installedVersion})`
        );
      } else {
        throw new Error(
          `[esbuild] dist/pty is locked and cannot be rebuilt: installed version is ${installedVersion ?? 'unknown'}, ` +
            `existing dist copy is ${existingVersion ?? 'unknown'}. Close the VSCodium/extension host process that holds ` +
            `dist/pty open, then re-run the build.`,
          { cause: error }
        );
      }
    } else {
      throw error;
    }
  }
}

function readPtyVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('[esbuild] watching...');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
