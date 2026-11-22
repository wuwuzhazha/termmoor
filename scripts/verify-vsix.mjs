import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Verifies the contents of a packaged VSIX.
 *
 * The package is intentionally a fixed allowlist: the extension bundle, the
 * node-pty runtime for one target, the two manifest-referenced icons, the
 * webview assets, the localized manifest strings, and the usual top-level
 * documentation/licence files. Anything from the development tree is a
 * packaging bug, not an acceptable extra.
 *
 * The public identity (`wuwuzhazha.termmoor`, repository
 * github.com/wuwuzhazha/termmoor) and the single supported target (win32-x64)
 * are enforced here as well, so a VSIX built from an older manifest or for a
 * different platform fails verification instead of being shipped.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const PTY_ROOT = 'extension/dist/pty/node-pty';

/** Windows x64 is the only target this repository builds and verifies. */
export const SUPPORTED_TARGETS = ['win32-x64'];

/** Default target used by the CLI when none is given or inferable. */
export const DEFAULT_TARGET = SUPPORTED_TARGETS[0];

/**
 * Private development identity that must never reach a published VSIX.
 * `agent-terminal` was the pre-release package name; the public package is
 * `termmoor` published by `wuwuzhazha`.
 */
export const FORBIDDEN_PACKAGE_NAMES = ['agent-terminal'];

export const PACKAGE_NAME = 'termmoor';
export const PUBLISHER = 'wuwuzhazha';
export const REPOSITORY_URL = 'https://github.com/wuwuzhazha/termmoor.git';

export const REQUIRED_FILES = [
  'extension/package.json',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/THIRD_PARTY_NOTICES.txt',
  'extension/changelog.md',
  'extension/package.nls.json',
  'extension/package.nls.zh-cn.json',
  'extension/dist/extension.js',
  `${PTY_ROOT}/package.json`,
  `${PTY_ROOT}/LICENSE`,
  `${PTY_ROOT}/lib/index.js`,
  'extension/media/icon.png',
  'extension/media/terminal.svg',
  'extension/media/webview/terminal.js',
  'extension/media/webview/terminal.css'
];

/** Settings documented in README.md; the packaged manifest must expose all of them. */
export const REQUIRED_SETTINGS = [
  'agentTerminal.terminal.scrollback',
  'agentTerminal.terminal.shellIntegration',
  'agentTerminal.terminal.longRunningThresholdSeconds'
];

const FORBIDDEN_PREFIXES = [
  'extension/src/',
  'extension/test/',
  'extension/scripts/',
  'extension/webview/',
  'extension/docs/',
  'extension/node_modules/',
  'extension/artifacts/',
  'extension/dist-test/',
  'extension/.github/',
  'extension/.vscode/',
  'extension/dist/pi-extension/'
];

const FORBIDDEN_BASENAMES = new Set([
  '.gitignore',
  '.vscodeignore',
  'package-lock.json',
  'tsconfig.json',
  'esbuild.mjs'
]);

const FORBIDDEN_SUFFIXES = ['.map', '.ts', '.tsx', '.mts', '.cts', '.tsbuildinfo'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads every file from a ZIP archive (VSIX is a ZIP) without external
 * dependencies. Only the stored and deflate methods are needed; VSIX writers
 * do not use anything else. ZIP64 archives are rejected explicitly.
 */
export function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  if (buffer.length < 22) {
    throw new Error('Not a ZIP archive: file is too small.');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (buffer.readUInt16LE(eocd + 10) === 0xffff || buffer.readUInt32LE(eocd + 16) === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by the VSIX verifier.');
  }

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    ensureRange(buffer, offset, 46, 'central directory header');
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Invalid ZIP central directory entry at offset ${offset}.`);
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);

    ensureRange(buffer, offset + 46, nameLength, 'central directory file name');
    const name = buffer.toString(
      flags & 0x800 ? 'utf8' : 'latin1',
      offset + 46,
      offset + 46 + nameLength
    );

    ensureRange(buffer, localOffset, 30, `local header for ${name}`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Invalid ZIP local header for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    ensureRange(buffer, dataStart, compressedSize, `compressed data for ${name}`);

    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }

    if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
      throw new Error(`ZIP size mismatch for ${name}.`);
    }
    if (!name.endsWith('/')) {
      entries.set(name, data);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Checks a already-extracted entry map. Exported separately so the rules can
 * be unit-tested without building a real VSIX.
 */
export function verifyEntries(entries, options = {}) {
  if (!(entries instanceof Map)) {
    throw new TypeError('verifyEntries expects a Map<string, Buffer>.');
  }

  const paths = [...entries.keys()].filter((name) => !name.endsWith('/')).sort();
  const errors = [];

  for (const required of REQUIRED_FILES) {
    if (!entries.has(required)) {
      errors.push(`missing required file: ${required}`);
    }
  }

  const icon = entries.get('extension/media/icon.png');
  if (icon && !icon.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    errors.push('extension/media/icon.png is not a PNG file');
  }
  const viewIcon = entries.get('extension/media/terminal.svg');
  if (viewIcon && !/<svg(\s|>)/i.test(viewIcon.toString('utf8'))) {
    errors.push('extension/media/terminal.svg is not an SVG file');
  }

  for (const file of paths) {
    const lower = file.toLowerCase();
    if (FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      errors.push(`development path packaged: ${file}`);
      continue;
    }
    if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
      errors.push(`development file packaged: ${file}`);
      continue;
    }
    const basename = path.posix.basename(lower);
    if (FORBIDDEN_BASENAMES.has(basename)) {
      errors.push(`development file packaged: ${file}`);
      continue;
    }
    if (lower.endsWith('.vsix')) {
      errors.push(`nested VSIX packaged: ${file}`);
    }
  }

  const prebuildPrefix = `${PTY_ROOT}/prebuilds/`;
  const prebuilds = paths.filter((file) => file.startsWith(prebuildPrefix));
  if (prebuilds.length === 0) {
    errors.push(`missing packaged PTY prebuilds under ${prebuildPrefix}`);
  }
  if (options.target) {
    if (!SUPPORTED_TARGETS.includes(options.target)) {
      errors.push(
        `unsupported target ${options.target}: only ${SUPPORTED_TARGETS.join(', ')} is built and verified`
      );
    }
    const targetPrefix = `${prebuildPrefix}${options.target}/`;
    if (!paths.some((file) => file.startsWith(targetPrefix))) {
      errors.push(`missing PTY prebuild for target ${options.target}`);
    }
  }

  const prebuildPlatforms = new Set(
    prebuilds.map((file) => file.slice(prebuildPrefix.length).split('/')[0])
  );
  for (const platform of prebuildPlatforms) {
    if (!SUPPORTED_TARGETS.includes(platform)) {
      errors.push(`packaged PTY prebuild for unsupported platform: ${platform}`);
    }
  }

  let manifest;
  const manifestEntry = entries.get('extension/package.json');
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.toString('utf8'));
    } catch (error) {
      errors.push(`extension/package.json is not valid JSON: ${error.message}`);
    }
  }

  if (manifest) {
    if (typeof manifest.name === 'string' && FORBIDDEN_PACKAGE_NAMES.includes(manifest.name)) {
      errors.push(`manifest still uses the development package name: ${manifest.name}`);
    }
    if (typeof manifest.publisher !== 'string' || manifest.publisher.length === 0) {
      errors.push('manifest is missing publisher');
    }
    if (options.expectedName && manifest.name !== options.expectedName) {
      errors.push(`manifest name is ${JSON.stringify(manifest.name)}, expected ${options.expectedName}`);
    }
    if (options.expectedVersion && manifest.version !== options.expectedVersion) {
      errors.push(
        `manifest version is ${JSON.stringify(manifest.version)}, expected ${options.expectedVersion}`
      );
    }
    if (options.expectedPublisher && manifest.publisher !== options.expectedPublisher) {
      errors.push(
        `manifest publisher is ${JSON.stringify(manifest.publisher)}, ` +
          `expected ${JSON.stringify(options.expectedPublisher)}`
      );
    }
    if (options.expectedRepositoryUrl) {
      const actualRepository = normalizeRepositoryUrl(
        typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
      );
      if (actualRepository !== normalizeRepositoryUrl(options.expectedRepositoryUrl)) {
        errors.push(
          `manifest repository is ${JSON.stringify(actualRepository)}, ` +
            `expected ${JSON.stringify(normalizeRepositoryUrl(options.expectedRepositoryUrl))}`
        );
      }
    }
    if (!manifest.engines || typeof manifest.engines.vscode !== 'string') {
      errors.push('manifest is missing engines.vscode');
    }
    if (typeof manifest.main !== 'string') {
      errors.push('manifest is missing main');
    } else {
      const mainEntry = extensionPath(manifest.main);
      if (!entries.has(mainEntry)) {
        errors.push(`manifest main does not exist in the VSIX: ${manifest.main}`);
      }
    }
    if (typeof manifest.icon !== 'string') {
      errors.push('manifest is missing icon');
    } else {
      const iconEntry = extensionPath(manifest.icon);
      if (!entries.has(iconEntry)) {
        errors.push(`manifest icon does not exist in the VSIX: ${manifest.icon}`);
      }
    }
    const sidebarIcon =
      manifest.contributes?.viewsContainers?.secondarySidebar?.[0]?.icon;
    if (typeof sidebarIcon !== 'string' || !entries.has(extensionPath(sidebarIcon))) {
      errors.push('view container icon is missing from the VSIX');
    }

    const properties = manifest.contributes?.configuration?.properties;
    if (!properties || typeof properties !== 'object') {
      errors.push('manifest is missing contributes.configuration.properties');
    } else {
      for (const setting of REQUIRED_SETTINGS) {
        if (!Object.prototype.hasOwnProperty.call(properties, setting)) {
          errors.push(`manifest is missing setting: ${setting}`);
        }
      }
    }

    if (manifest.devDependencies) {
      errors.push('packaged manifest still advertises devDependencies');
    }
    if (manifest.scripts) {
      errors.push('packaged manifest still advertises scripts');
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      errors.push('packaged manifest must keep a non-empty files allowlist');
    }
  }

  if (errors.length > 0) {
    const error = new Error(`VSIX verification failed:\n- ${errors.join('\n- ')}`);
    error.errors = errors;
    throw error;
  }

  return { paths, manifest };
}

export function verifyVsix(vsixPath, options = {}) {
  const absolute = path.resolve(vsixPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`VSIX not found: ${absolute}`);
  }
  const entries = readZipEntries(fs.readFileSync(absolute));
  return verifyEntries(entries, options);
}

/** Finds the newest `termmoor-*.vsix` in a directory. */
export function findLatestVsix(directory = process.cwd()) {
  const candidates = fs
    .readdirSync(directory)
    .filter((name) => /^termmoor-.*\.vsix$/i.test(name))
    .map((name) => {
      const full = path.join(directory, name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.full;
}

/** Parses `--target win32-x64` / `--target=win32-x64` and a positional VSIX. */
export function parseCliArgs(argv) {
  let target;
  let file;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      target = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (!arg.startsWith('--')) {
      file = arg;
    }
  }
  return { target, file };
}

function extensionPath(relative) {
  const normalized = String(relative).replace(/\\/g, '/').replace(/^\.\//, '');
  return `extension/${normalized}`;
}

/** Repository URLs compare equal with or without a trailing `.git` or slash. */
function normalizeRepositoryUrl(url) {
  if (typeof url !== 'string') {
    return undefined;
  }
  return url.trim().replace(/\/$/, '').replace(/\.git$/i, '');
}

function findEndOfCentralDirectory(buffer) {
  const first = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Not a ZIP archive: end of central directory not found.');
}

function ensureRange(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Truncated ZIP archive while reading ${label}.`);
  }
}

function readExpectedManifest(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function inferTargetFromName(file) {
  const match = /-(win32|linux|darwin)-(x64|arm64|armhf|ia32)\.vsix$/i.exec(file);
  return match ? `${match[1]}-${match[2]}`.toLowerCase() : undefined;
}

async function main() {
  const { target, file } = parseCliArgs(process.argv.slice(2));
  const vsix = file ? path.resolve(file) : findLatestVsix();
  if (!vsix) {
    console.error('[verify-vsix] no termmoor-*.vsix found. Pass a VSIX path.');
    process.exit(1);
  }

  const expected = readExpectedManifest(process.cwd());
  let result;
  try {
    result = verifyVsix(vsix, {
      target: target ?? inferTargetFromName(vsix) ?? DEFAULT_TARGET,
      expectedName: expected?.name ?? PACKAGE_NAME,
      expectedVersion: expected?.version,
      expectedPublisher: expected?.publisher ?? PUBLISHER,
      expectedRepositoryUrl:
        typeof expected?.repository === 'string' ? expected.repository : expected?.repository?.url
    });
  } catch (error) {
    console.error(`[verify-vsix] ${error.message}`);
    process.exit(1);
  }

  const relative = path.relative(process.cwd(), vsix) || vsix;
  const prebuilds = result.paths.filter((entry) =>
    entry.startsWith(`${PTY_ROOT}/prebuilds/`)
  ).length;
  console.log(
    `[verify-vsix] OK ${relative}: ${result.paths.length} files, ` +
      `${prebuilds} PTY runtime file(s), manifest ` +
      `${result.manifest?.publisher}.${result.manifest?.name}@${result.manifest?.version}`
  );
}

const invokedDirectly = Boolean(process.argv[1]) && /(^|[\\/])verify-vsix\.mjs$/i.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[verify-vsix] ${error.message}`);
    process.exit(1);
  });
}
