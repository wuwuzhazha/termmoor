/**
 * Workspace containment policy for paths the webview asks the host to open
 * (`open-path`) and for file citations resolved by the host.
 *
 * Pure module: no `vscode` import, no side effects, safe to bundle into the
 * extension host or unit-test with `node --test`.
 *
 * Contract:
 *  - `classifyOpenTarget` returns
 *      { kind: 'workspace', path }  path is inside one of the workspace roots
 *      { kind: 'outside', path }    path exists but is outside every root;
 *                                   the caller must ask the user again
 *      { kind: 'invalid' }          empty, malformed, or nonexistent path
 *  - containment is decided with `path.resolve` + `path.relative`, never with
 *    raw string `startsWith`, so `C:\foo` does not match `C:\foobar`.
 *  - Windows path comparison is case-insensitive, mixed `/` and `\` work, and
 *    UNC roots are handled by the platform `path` implementation.
 *  - `file://` URLs are parsed with `fileURLToPath` (percent-decoding and
 *    Windows drive letters / UNC hosts included).
 *  - a leading `~` expands to the current user's home directory.
 *  - symlinks/junctions are re-checked with `realpathSync` so a link inside
 *    the workspace that points outside is reported as `outside`.
 *
 * The returned `path` is the resolved *lexical* absolute path (what the user
 * typed, normalized), not the realpath, so callers can show it back verbatim.
 */

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OpenTargetKind = 'workspace' | 'outside' | 'invalid';

export interface OpenTargetClassification {
  kind: OpenTargetKind;
  /** Absolute, normalized path. Omitted when kind is 'invalid'. */
  path?: string;
}

const IS_WINDOWS = process.platform === 'win32';
const FILE_URL = /^file:/i;
// `http://`, `https://`, `vscode://`, ... are not files. A bare `C:` drive is
// excluded because it has no `//`.
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SEPARATORS = /[\\/]+/;

/**
 * Classify a user-supplied path.
 *
 * @param target raw path or `file://` URL (may be quoted/wrapped in a citation)
 * @param cwd    working directory used to resolve relative paths first
 * @param roots  workspace folder paths; relative fallbacks and containment
 */
export function classifyOpenTarget(
  target: string,
  cwd: string | undefined,
  roots: readonly string[]
): OpenTargetClassification {
  if (typeof target !== 'string') {
    return { kind: 'invalid' };
  }

  const cleaned = sanitizeTarget(target);
  if (!cleaned || CONTROL_CHARACTERS.test(cleaned)) {
    return { kind: 'invalid' };
  }

  let candidate: string;
  if (FILE_URL.test(cleaned)) {
    const fromUrl = parseFileUrl(cleaned);
    if (!fromUrl || !path.isAbsolute(fromUrl)) {
      return { kind: 'invalid' };
    }
    candidate = fromUrl;
  } else if (EXTERNAL_SCHEME.test(cleaned)) {
    // http(s)/vscode/etc. are handled by other openers, not by this policy.
    return { kind: 'invalid' };
  } else {
    candidate = expandHome(cleaned);
    // A `C:\...` / `\\server\share` path cannot be resolved on a POSIX host;
    // resolving it as a relative path would silently point somewhere else.
    if (!IS_WINDOWS && WINDOWS_ABSOLUTE.test(candidate)) {
      return { kind: 'invalid' };
    }
  }

  const workspaceRoots = normalizeRoots(roots);
  const candidates = candidatePaths(candidate, cwd, workspaceRoots);
  for (const absolute of candidates) {
    if (!isExistingPath(absolute)) {
      continue;
    }
    return { kind: classifyContainment(absolute, workspaceRoots), path: absolute };
  }
  return { kind: 'invalid' };
}

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Both arguments are resolved first, so `.`/`..` and mixed separators are
 * handled. On Windows the comparison is case-insensitive. A sibling such as
 * `C:\foobar` is NOT inside `C:\foo`.
 */
export function isInside(root: string, candidate: string): boolean {
  if (typeof root !== 'string' || typeof candidate !== 'string') {
    return false;
  }
  if (!root.trim() || !candidate.trim()) {
    return false;
  }
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  if (pathKey(rootPath) === pathKey(candidatePath)) {
    return true;
  }
  const relative = path.relative(rootPath, candidatePath);
  if (!relative) {
    return true;
  }
  // `path.relative` returns an absolute path when the paths are on different
  // Windows drives or different UNC shares.
  if (path.isAbsolute(relative)) {
    return false;
  }
  return relative.split(SEPARATORS)[0] !== '..';
}

function sanitizeTarget(value: string): string {
  let result = value.trim();
  // Citations are commonly wrapped in backticks, quotes or angle brackets.
  result = result.replace(/^[`"'<]+/, '').replace(/[`"'>]+$/, '');
  return result.trim();
}

function expandHome(value: string): string {
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(homedir(), value.slice(2));
  }
  // `~user` is not expanded; it is treated as a literal relative name.
  return value;
}

function parseFileUrl(value: string): string | undefined {
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function normalizeRoots(roots: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots ?? []) {
    if (typeof root !== 'string' || !root.trim()) {
      continue;
    }
    const absolute = path.resolve(root);
    const key = pathKey(absolute);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(absolute);
  }
  return result;
}

function candidatePaths(candidate: string, cwd: string | undefined, roots: string[]): string[] {
  if (path.isAbsolute(candidate)) {
    return [path.resolve(candidate)];
  }
  const bases: string[] = [];
  if (typeof cwd === 'string' && cwd.trim()) {
    bases.push(path.resolve(cwd));
  }
  for (const root of roots) {
    bases.push(root);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const absolute = path.resolve(base, candidate);
    const key = pathKey(absolute);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(absolute);
  }
  return result;
}

function classifyContainment(candidate: string, roots: string[]): OpenTargetKind {
  if (roots.length === 0) {
    return 'outside';
  }
  const realCandidate = realPath(candidate);
  if (realCandidate === undefined) {
    // realpath can fail (permissions, exotic filesystems); fall back to the
    // lexical check rather than refusing to classify an existing file.
    return roots.some((root) => isInside(root, candidate)) ? 'workspace' : 'outside';
  }
  const insideRealRoot = roots.some((root) => isInside(realPath(root) ?? root, realCandidate));
  return insideRealRoot ? 'workspace' : 'outside';
}

function isExistingPath(value: string): boolean {
  try {
    statSync(value);
    return true;
  } catch {
    return false;
  }
}

function realPath(value: string): string | undefined {
  try {
    return realpathSync.native(value);
  } catch {
    // fall through to the JS implementation
  }
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function pathKey(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
}
