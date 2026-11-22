/**
 * Host-side helpers for opening a citation that the literal path policy could
 * not resolve.
 *
 * Terminal output is prose as often as it is a path list. A line such as
 * `STD/CAL Xcp_Std.c` glues a label onto a real file name; a lexical parser
 * cannot tell that apart from a genuine path with spaces (`My Dir/Xcp_Std.c`).
 * The host therefore keeps literal resolution authoritative and only falls
 * back to the last whitespace-delimited file name after the literal path and
 * the full workspace suffix both failed.
 *
 * Pure module: no `vscode` import, no filesystem access, unit-testable.
 */

import { looksLikeFileName } from './fileList';

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_SCHEME = /^file:/i;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TRAILING_PUNCTUATION = /[.,;:]+$/;
const WRAPPING_OPEN = /^[([{<`"']+/;
const WRAPPING_CLOSE = /[)\]}>`"']+$/;

/**
 * Extract the standalone file name at the end of an unresolved citation.
 *
 * Returns `undefined` unless `target` is a *relative* candidate that still
 * carries whitespace. Absolute paths, drive paths, UNC shares, `file:` URLs,
 * other schemes, home paths, and any `..` traversal are deliberately refused:
 * their basename must never be substituted for the path the user clicked.
 *
 * `STD/CAL Xcp_Std.c` -> `Xcp_Std.c`
 * `My Dir/Xcp_Std.c`  -> `Xcp_Std.c` (only reached after literal resolution)
 * `E:\\Xcp\\Xcp_Std.c` -> undefined
 * `../outside/Xcp_Std.c` -> undefined
 */
export function fileCitationFallbackName(target: string): string | undefined {
  if (typeof target !== 'string') {
    return undefined;
  }
  const cleaned = target
    .trim()
    .replace(/^[`"'<]+/, '')
    .replace(/[`"'>]+$/, '')
    .trim();
  if (!cleaned || CONTROL_CHARACTERS.test(cleaned)) {
    return undefined;
  }
  if (FILE_SCHEME.test(cleaned) || EXTERNAL_SCHEME.test(cleaned)) {
    return undefined;
  }
  if (WINDOWS_ABSOLUTE.test(cleaned) || /^[\\/]/.test(cleaned) || /^~/.test(cleaned)) {
    return undefined;
  }
  if (!/\s/.test(cleaned) || hasParentTraversal(cleaned)) {
    return undefined;
  }

  const tokens = cleaned.split(/\s+/);
  let name = tokens[tokens.length - 1] ?? '';
  name = name
    .replace(TRAILING_PUNCTUATION, '')
    .replace(WRAPPING_OPEN, '')
    .replace(WRAPPING_CLOSE, '')
    .trim();
  if (!name) {
    return undefined;
  }
  // The fallback is a file name, not a smaller path: separators, drive colons,
  // CLI flags, and characters a file name cannot contain all mean "not this".
  if (/[\\/:<>"|?*`#]/.test(name) || name.startsWith('-')) {
    return undefined;
  }
  return looksLikeFileName(name) ? name : undefined;
}

/** True when any path segment is a parent traversal (`..`). */
export function hasParentTraversal(target: string): boolean {
  if (typeof target !== 'string' || !target) {
    return false;
  }
  return target.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * Lexical containment for URI-style paths (remote workspaces).
 *
 * `vscode.Uri.joinPath` normalizes `.`/`..`, so callers must reject traversal
 * before joining too. This check is the second line of defence: a joined URI
 * must stay at or below its workspace root, and `/rooted` is not inside `/root`.
 */
export function isWithinUriPath(rootPath: string, candidatePath: string): boolean {
  const root = normalizeUriPath(rootPath);
  const candidate = normalizeUriPath(candidatePath);
  if (!root || !candidate) {
    return false;
  }
  if (root === candidate) {
    return true;
  }
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function normalizeUriPath(value: string): string {
  const raw = (value ?? '').replace(/\\/g, '/');
  const absolute = raw.startsWith('/');
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (absolute) {
    return `/${joined}`;
  }
  return joined;
}
