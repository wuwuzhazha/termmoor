/**
 * Platform helpers and the single lazy entry point to the native PTY module.
 *
 * The native module is never imported at module scope: that would make a
 * broken install crash the whole extension host at activation time. Instead
 * `loadPty()` requires it on first use and throws an actionable error, which
 * the caller is expected to surface to the user. There is deliberately no
 * fallback implementation: the terminal either runs on a real pty or reports
 * why it cannot.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TerminalCommand } from '../shared/protocol';
import { buildCmdCommandLine } from '../shared/cmdline';

export type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch');
export type PtyProcess = ReturnType<PtyModule['spawn']>;

/** Lazily resolves the native pty module. Defaults to {@link loadPty}. */
export type PtyLoader = () => PtyModule;

/** Options passed through to `pty.spawn` (the subset TerminalService uses). */
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
  encoding?: string;
}

/**
 * Spawn seam for tests: receives exactly the arguments TerminalService would
 * hand to `pty.spawn`. Lets a fake pty run without the native module.
 */
export type PtyFactory = (
  file: string,
  args: string[] | string,
  options: PtySpawnOptions
) => PtyProcess;

const PTY_PACKAGE = '@homebridge/node-pty-prebuilt-multiarch';
/** Build output copy, so the VSIX never depends on a shipped node_modules tree. */
const BUNDLED_PTY = path.join(__dirname, 'pty', 'node-pty');

export const isWindows = process.platform === 'win32';

let cachedModule: PtyModule | null = null;
let cachedVersion: string | null = null;

/**
 * Require the native pty binding. Throws an Error whose message names the
 * package, the platform and the packaged prebuild directory, so the shell can
 * show it verbatim and the user can act on it.
 */
export function loadPty(): PtyModule {
  if (cachedModule) {
    return cachedModule;
  }
  if (fs.existsSync(path.join(BUNDLED_PTY, 'package.json'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require(BUNDLED_PTY) as PtyModule;
    return cachedModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require(PTY_PACKAGE) as PtyModule;
    return cachedModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const platform = `${process.platform}-${process.arch}`;
    throw new Error(
      `Unable to load the native PTY module "${PTY_PACKAGE}" (${platform}): ${detail}. ` +
        `Expected the packaged N-API prebuild at ${path.join(BUNDLED_PTY, 'prebuilds', platform)}. ` +
        `Run "npm run build" to refresh dist/pty, then reload the window.`
    );
  }
}

/** Version of the installed pty package, or `'unknown'`. Never throws. */
export function ptyVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  try {
    const manifestPath = fs.existsSync(path.join(BUNDLED_PTY, 'package.json'))
      ? path.join(BUNDLED_PTY, 'package.json')
      : `${PTY_PACKAGE}/package.json`;
    const manifest = require(manifestPath) as { version?: unknown };
    cachedVersion = typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export interface SpawnSpec {
  /** Executable passed to `pty.spawn`. */
  file: string;
  /** Array form, or a pre-built command line string when routed through cmd.exe. */
  args: string[] | string;
  /** True when the command is executed through `%ComSpec%` (`.cmd`/`.bat` shims). */
  viaCmdShell: boolean;
  /** The file from the TerminalCommand, before PATH resolution. */
  requestedFile: string;
}

const CMD_EXTENSION = /\.(cmd|bat)$/i;

/**
 * Resolve an extension-less executable name through PATH + PATHEXT.
 *
 * Windows' CreateProcess does not try PATHEXT (it only appends `.exe`), so a
 * command like `pi` or `claude` would fail even though the npm shims
 * (`pi.cmd`, `claude.cmd`) are on PATH. This mirrors what a shell would do.
 * If nothing is found the original value is returned, so the spawn error still
 * names the file that was requested.
 */
export function resolveWindowsExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || !file || path.extname(file)) {
    return file;
  }
  const hasSeparator = file.includes('/') || file.includes('\\');
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const directories = hasSeparator
    ? ['']
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const base = hasSeparator ? path.resolve(file) : file;

  for (const directory of directories) {
    for (const ext of exts) {
      const candidate = hasSeparator ? `${base}${ext}` : path.join(directory, `${file}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // try the next candidate
      }
    }
  }
  return file;
}

/**
 * Map a TerminalCommand to something ConPTY can actually execute.
 *
 * `.cmd` / `.bat` files are batch scripts, not PE images: ConPTY cannot start
 * them directly, so they are handed to `%ComSpec%` with `/d /s /c`.
 */
export function buildSpawnSpec(
  command: TerminalCommand,
  platform: NodeJS.Platform = process.platform
): SpawnSpec {
  const requestedFile = command.file;
  const args = Array.isArray(command.args) ? command.args.map(String) : [];
  const file = resolveWindowsExecutable(requestedFile, platform);

  if (platform === 'win32' && CMD_EXTENSION.test(file)) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return {
      file: comspec,
      args: buildCmdCommandLine(file, args),
      viaCmdShell: true,
      requestedFile
    };
  }

  return { file, args, viaCmdShell: false, requestedFile };
}

/** Clamp a terminal dimension to something node-pty and xterm both accept. */
export function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded < 2 ? 2 : rounded;
}
