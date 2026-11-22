import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyVsix } from './verify-vsix.mjs';

/**
 * Packages a deliberate runtime allowlist from a private temporary staging
 * directory. Nothing from the development tree (src, test, scripts, docs,
 * node_modules, build logs) is ever copied into the stage.
 *
 * Guards before packaging:
 *  - the manifest must carry the public identity (termmoor / wuwuzhazha /
 *    github.com/wuwuzhazha/termmoor) and no publishing automation;
 *  - the target must be win32-x64, the only supported target;
 *  - dist must already exist and be newer than every src/webview source file;
 *  - the requested target must have a matching PTY prebuild;
 *  - every runtime file in the allowlist must exist.
 *
 * The VSIX is always named `<name>-<version>-<target>.vsix` (for example
 * `termmoor-0.9.0-win32-x64.vsix`) and is never published from here.
 *
 * After packaging the VSIX is verified again by scripts/verify-vsix.mjs, so a
 * successful local/CI package always contains the runtime, icons and manifest
 * and never a development file.
 */
const root = process.cwd();

/**
 * Public identity. The VSIX filename, the manifest assertions and the verifier
 * all derive from these constants so the published artifact can never drift
 * back to the private development identity.
 */
const PACKAGE_NAME = 'termmoor';
const PUBLISHER = 'wuwuzhazha';
const REPOSITORY_URL = 'https://github.com/wuwuzhazha/termmoor.git';

/** Windows x64 is the only target this repository builds and verifies. */
const SUPPORTED_TARGETS = ['win32-x64'];

const target = readTarget();
const version = readVersion();
const name = `${PACKAGE_NAME}-${version}-${target}.vsix`;
const output = path.join(root, name);

const extensionBundle = path.join(root, 'dist', 'extension.js');
const webviewBundle = path.join(root, 'media', 'webview', 'terminal.js');
const ptyRoot = 'dist/pty/node-pty';

/**
 * Top-level files and webview assets. Keep this list explicit: adding a file
 * to the build tree must not silently add it to the shipped VSIX.
 */
const FIXED_RUNTIME_FILES = [
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'CHANGELOG.md',
  'package.nls.json',
  'package.nls.zh-cn.json',
  'media/icon.png',
  'media/terminal.svg',
  'media/webview/terminal.js',
  'media/webview/terminal.css',
  'dist/extension.js'
];

/** The package.json "files" allowlist written into the staged manifest. */
const STAGED_MANIFEST_FILES = [
  'dist/extension.js',
  `${ptyRoot}/package.json`,
  `${ptyRoot}/LICENSE`,
  `${ptyRoot}/lib/**`,
  `${ptyRoot}/prebuilds/${target}/**`,
  'media/icon.png',
  'media/terminal.svg',
  'media/webview/terminal.js',
  'media/webview/terminal.css',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'CHANGELOG.md',
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json'
];

// 1. Public identity: refuse to build a VSIX that still advertises the private
// development identity, an unsupported target, or automated publishing.
const manifest = readManifest();
assertPublicIdentity(manifest);

// 2. dist freshness: packaging a stale bundle is never what we want.
const newestSource = newestFile(['src', 'webview'], ['.ts', '.css']);
for (const bundle of [extensionBundle, webviewBundle]) {
  if (!fs.existsSync(bundle)) {
    fail(`[package] missing ${path.relative(root, bundle)}. Run "npm run build" first.`);
  }
  if (newestSource && newestSource.mtimeMs > fs.statSync(bundle).mtimeMs) {
    fail(
      `[package] ${path.relative(root, bundle)} is older than ${path.relative(root, newestSource.file)}.\n` +
        `Run "npm run build" before packaging.`
    );
  }
}

// 3. The PTY prebuild must exist for the requested target, otherwise we would
// ship a VSIX labelled for a platform it cannot run on.
const prebuildDir = path.join(root, ptyRoot, 'prebuilds', target);
if (!fs.existsSync(prebuildDir)) {
  fail(
    `[package] no PTY prebuild for target "${target}" at ` +
      `${ptyRoot}/prebuilds/${target}.\n` +
      `Build on Windows x64; this repository only ships ${SUPPORTED_TARGETS.join(', ')}. ` +
      `Refusing to produce a mislabelled VSIX.`
  );
}

// A stale prebuild for another platform would either be shipped by accident or
// silently drop the target's native module.
const stalePrebuilds = fs
  .readdirSync(path.join(root, ptyRoot, 'prebuilds'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== target)
  .map((entry) => entry.name);
if (stalePrebuilds.length > 0) {
  fail(
    `[package] ${ptyRoot}/prebuilds contains unsupported platform(s): ` +
      `${stalePrebuilds.join(', ')}. Run "npm run build" to prune them.`
  );
}

// 4. Build the complete runtime allowlist before anything is staged.
const runtimeFiles = [...FIXED_RUNTIME_FILES, ...collectPtyRuntime(target)];
for (const file of runtimeFiles) {
  const source = path.join(root, file);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    fail(`[package] required runtime file ${file} is missing.`);
  }
}

// 5. Stage only those files in a unique private directory. Using the OS temp
// directory avoids stale artifacts/stage leftovers and parallel-run collisions.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termmoor-package-'));
try {
  for (const file of runtimeFiles) {
    const destination = path.join(stage, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }

  // 6. Strip dev-only metadata so the VSIX manifest only advertises what ships.
  delete manifest.devDependencies;
  delete manifest.scripts;
  manifest.files = STAGED_MANIFEST_FILES;
  if (!fs.existsSync(path.join(stage, 'media', 'icon.png'))) {
    throw new Error('[package] media/icon.png is required by the manifest but was not staged.');
  }
  manifest.icon = 'media/icon.png';
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  verifyStage(stage, [...runtimeFiles, 'package.json']);

  // 7. Package with the locally installed vsce. The explicit CLI path avoids
  // npx resolving/fetching anything and keeps the stage outside the repo.
  // There is deliberately no publish step: publishing stays a manual, explicit
  // action performed outside this script and outside CI.
  const vsceCli = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  if (!fs.existsSync(vsceCli)) {
    throw new Error('[package] @vscode/vsce is not installed. Run "npm ci" first.');
  }

  const result = spawnSync(
    process.execPath,
    [
      vsceCli,
      'package',
      '--no-dependencies',
      '--target',
      target,
      '--out',
      name
    ],
    { cwd: stage, stdio: 'inherit' }
  );

  if (result.error) {
    throw new Error(`[package] could not run vsce: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`[package] vsce failed with exit code ${result.status ?? 'unknown'}.`);
  }

  const produced = path.join(stage, name);
  if (!fs.existsSync(produced)) {
    throw new Error(`[package] vsce reported success but ${name} was not produced.`);
  }

  // 8. Verify the staged VSIX before copying it into the repository root.
  try {
    const verified = verifyVsix(produced, {
      target,
      expectedName: PACKAGE_NAME,
      expectedVersion: version,
      expectedPublisher: PUBLISHER,
      expectedRepositoryUrl: REPOSITORY_URL
    });
    console.log(
      `[package] verified ${verified.paths.length} VSIX file(s), ` +
      `${verified.paths.filter((entry) => entry.startsWith(`extension/${ptyRoot}/prebuilds/`)).length} PTY runtime file(s)`
    );
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  fs.copyFileSync(produced, output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`\nVSIX: ${output}`);
console.log(`Size: ${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB`);

function collectPtyRuntime(forTarget) {
  const files = [`${ptyRoot}/package.json`, `${ptyRoot}/LICENSE`];
  files.push(...walk(`${ptyRoot}/lib`).filter((file) => file.endsWith('.js')));
  for (const file of walk(`${ptyRoot}/prebuilds/${forTarget}`)) {
    files.push(file);
  }
  return [...new Set(files)].sort();
}

function verifyStage(stage, expectedFiles) {
  const expected = new Set(expectedFiles.map(normalizeRelative));
  const actual = walk(stage).map((file) => normalizeRelative(path.relative(stage, file)));
  const unexpected = actual.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !actual.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`[package] staging contained unexpected file(s): ${unexpected.join(', ')}`);
  }
  if (missing.length > 0) {
    throw new Error(`[package] staging is missing file(s): ${missing.join(', ')}`);
  }
}

function walk(relativeOrAbsolute) {
  const base = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(root, relativeOrAbsolute);
  if (!fs.existsSync(base)) {
    return [];
  }
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files.push(
          path.isAbsolute(relativeOrAbsolute)
            ? full
            : normalizeRelative(path.relative(root, full))
        );
      }
    }
  };
  visit(base);
  return files.sort();
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

function readVersion() {
  return readManifest().version;
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/**
 * Fails fast when the manifest still carries a development identity, a target
 * this repository does not support, or publishing automation.
 */
function assertPublicIdentity(manifest) {
  if (manifest.name !== PACKAGE_NAME) {
    fail(`[package] manifest name is ${JSON.stringify(manifest.name)}, expected ${PACKAGE_NAME}.`);
  }
  if (manifest.publisher !== PUBLISHER) {
    fail(
      `[package] manifest publisher is ${JSON.stringify(manifest.publisher)}, ` +
        `expected ${PUBLISHER}.`
    );
  }
  if (manifest.version !== version) {
    fail('[package] manifest version changed while packaging; re-run the build.');
  }
  if (manifest.repository?.url !== REPOSITORY_URL) {
    fail(
      `[package] manifest repository.url is ${JSON.stringify(manifest.repository?.url)}, ` +
        `expected ${REPOSITORY_URL}. vsce needs it to rewrite README links.`
    );
  }
  if (manifest.displayName !== 'TermMoor') {
    fail(`[package] manifest displayName is ${JSON.stringify(manifest.displayName)}.`);
  }
  const publishingScript = Object.entries(manifest.scripts ?? {}).find(([, command]) =>
    /\b(vsce\s+publish|vsce\s+login|npm\s+publish|ovsx\s+publish)\b/.test(String(command))
  );
  if (publishingScript) {
    fail(
      `[package] script "${publishingScript[0]}" performs a publish; ` +
        'packaging must stay offline and publishing stays a manual step.'
    );
  }
}

function readTarget() {
  const argv = process.argv.slice(2);
  let requested = process.env.TARGET || SUPPORTED_TARGETS[0];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      if (!argv[i + 1]) fail('[package] --target requires a value, e.g. --target win32-x64');
      requested = argv[i + 1];
      break;
    }
    if (arg.startsWith('--target=')) {
      requested = arg.slice('--target='.length);
      break;
    }
  }
  if (!SUPPORTED_TARGETS.includes(requested)) {
    fail(
      `[package] unsupported target "${requested}". This repository only builds and ` +
        `verifies ${SUPPORTED_TARGETS.join(', ')}.`
    );
  }
  return requested;
}

function newestFile(roots, extensions) {
  let newest = null;
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        const mtimeMs = fs.statSync(full).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { file: full, mtimeMs };
        }
      }
    }
  };
  for (const dir of roots) visit(path.join(root, dir));
  return newest;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
