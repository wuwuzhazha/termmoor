/**
 * Split a citation that names several files with slashes.
 *
 * Agents and humans write `XcpOnEth.c/XcpOnFr.c` to mean "XcpOnEth.c and
 * XcpOnFr.c" — a slash between two file names, not a directory separator. Taken
 * literally it becomes the path `XcpOnEth.c/XcpOnFr.c`, i.e. "XcpOnFr.c inside a
 * directory named XcpOnEth.c", which never exists on disk.
 *
 * The distinction cannot be made from the text alone: `src/net/socket.ts` is a
 * genuine path. The deciding fact is whether a leading segment already looks
 * like a complete file name (it ends in a source extension). A directory name
 * never carries an extension, so:
 *
 *   XcpOnEth.c/XcpOnFr.c  -> XcpOnEth.c | XcpOnFr.c   (list)
 *   src/net/socket.ts     -> unchanged                 (path)
 *   Xcp/XcpOnEth.c        -> unchanged                 (path)
 *
 * Segments must also satisfy {@link isPathish}. Prose around a citation stays
 * prose: in `里的隐藏静态缓冲：XcpOnEth.c` the Chinese label is separated from
 * the file name by a full-width colon and must never become part of it.
 *
 * Pure module: no `vscode` import, no filesystem access, unit-testable.
 */

/** Extensions treated as "a complete file name", not a directory. */
const FILE_EXTENSIONS = new Set([
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'hh', 'inl', 'inc',
  'cs', 'fs', 'vb', 'java', 'kt', 'kts', 'scala', 'groovy',
  'py', 'pyi', 'pyw', 'rb', 'go', 'rs', 'php', 'pl', 'pm', 'lua', 'r', 'jl',
  'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'ts', 'tsx',
  'vue', 'svelte', 'astro', 'html', 'htm', 'xhtml',
  'css', 'scss', 'sass', 'less', 'styl',
  'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'xml', 'xsl', 'xslt', 'svg', 'md', 'mdx', 'markdown', 'rst', 'adoc', 'txt',
  'sql', 'graphql', 'gql', 'proto', 'thrift',
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'bat', 'cmd',
  'swift', 'm', 'mm', 'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'ml', 'mli', 'nim', 'zig',
  's', 'asm', 'sv', 'svh', 'vhd', 'vhdl', 'v', 'ld', 'icf', 's19', 'hex', 'elf', 'dbc', 'arxml', 'def', 'idl',
  'sln', 'vcxproj', 'csproj', 'uvprojx', 'ewp', 'a2l',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'csv', 'tsv', 'log', 'diff', 'patch', 'map', 'wasm', 'mod', 'sum', 'lock'
]);

/** Minimum segments for a slash list; a single file keeps its path. */
const MIN_LIST_SEGMENTS = 2;

/**
 * Characters a path segment can consist of: ASCII letters/digits plus the few
 * punctuation marks that appear in real file names (`_`, `-`, `.`, `@`, `+`,
 * `~`, `$`, `%`, parentheses and spaces, which real Windows paths contain).
 *
 * Anything else — CJK prose, full-width punctuation (`：`, `。`), angle
 * brackets, quotes — means the segment is text, not a path.
 */
const PATHISH = /^[A-Za-z0-9_\-.,@+~$%() \\/]+$/;

/** Sentence punctuation that may trail a citation, full-width included. */
const TRAILING_PROSE = /[。，、；：！？）】」』”’…·]+$/;

function extensionOf(segment: string): string {
  // A citation suffix belongs to the file, not to its extension:
  // `XcpOnFr.c:42` is still a `.c` file.
  const bare = segment
    .replace(/#L\d+(?:-L?\d+)?(?:C\d+)?$/i, '')
    .replace(/\(\d+(?:\s*,\s*\d+)?(?:-\d+)?\)$/, '')
    .replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
  const dot = bare.lastIndexOf('.');
  if (dot <= 0 || dot === bare.length - 1) {
    return '';
  }
  return bare.slice(dot + 1).toLowerCase();
}

/** True when the segment is a plausible path segment (no prose characters). */
export function isPathish(segment: string): boolean {
  return PATHISH.test(stripCitationSuffix(segment));
}

/** True when the segment is a complete file name rather than a directory. */
export function looksLikeFileName(segment: string): boolean {
  const bare = stripCitationSuffix(segment);
  return PATHISH.test(bare) && FILE_EXTENSIONS.has(extensionOf(bare));
}

/**
 * Remove a trailing line/column citation (`:42`, `:42:8`, `(42,8)`, `#L42`).
 *
 * The suffix is separated by characters that a path segment cannot contain
 * (`:` and `#`), so it must be gone before the segment is validated.
 */
function stripCitationSuffix(segment: string): string {
  return segment
    .replace(/#L\d+(?:-L?\d+)?(?:C\d+)?$/i, '')
    .replace(/\(\d+(?:\s*,\s*\d+)?(?:-\d+)?\)$/, '')
    .replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
}

/**
 * Expand a slash-separated file list into its members.
 *
 * Returns an empty array when `text` is an ordinary single path, so callers can
 * fall through to normal handling. Only forward slashes are considered list
 * separators: a backslash is a Windows path separator and never a list.
 */
export function splitFileList(text: string): string[] {
  if (!text || !text.includes('/')) {
    return [];
  }
  const segments = text.split('/').filter((segment) => segment.length > 0);
  if (segments.length < MIN_LIST_SEGMENTS) {
    return [];
  }
  // Every segment must be a complete file name; one directory-looking segment
  // means this is a real path (`src/net/socket.ts`).
  if (!segments.every(looksLikeFileName)) {
    return [];
  }
  return segments;
}

/**
 * Detach trailing sentence punctuation from a candidate token.
 *
 * Returns the token plus the removed suffix so callers can keep the match range
 * exact while testing only the file name (`XcpOnFr.c。` -> `XcpOnFr.c` + `。`).
 */
export function trimTrailingProse(text: string): { token: string; trailing: string } {
  const match = TRAILING_PROSE.exec(text);
  if (!match) {
    return { token: text, trailing: '' };
  }
  return { token: text.slice(0, match.index), trailing: match[0] };
}
