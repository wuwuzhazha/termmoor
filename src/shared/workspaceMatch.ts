/**
 * Ranking helpers for resolving a file citation that has no literal match.
 *
 * An agent prints `Xcp.h` and the workspace holds two of them: the real source
 * at `Xcp/Xcp.h` and a copy inside a build tree at
 * `.tmp/release-check-0.2.0/xcp-slave-0.2.0/Xcp/Xcp.h`. Refusing both because
 * "the name is ambiguous" is wrong — the copy is generated, and the shallow
 * source path is what the citation means.
 *
 * Pure module: no `vscode` import, no filesystem access, unit-testable.
 */

/** Directory names whose contents are generated, vendored, or transient. */
const GENERATED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.tmp',
  'tmp',
  '.cache',
  'dist',
  'out',
  'build',
  'target',
  'bin',
  'obj',
  'release',
  'debug',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'vendor'
]);

/** Higher is more likely to be the file a citation means. */
export const RANK_SOURCE = 3;
export const RANK_NEUTRAL = 2;
export const RANK_GENERATED = 1;

/**
 * True when `relative` ends with `suffix` on a path-segment boundary.
 *
 * `Xcp.h` matches `Xcp/Xcp.h` and `Xcp.h`, never `MyXcp.h` or `Xcp.h.bak`.
 */
export function matchesSuffix(relative: string, suffix: string): boolean {
  const rel = normalize(relative);
  const want = normalize(suffix);
  if (!rel || !want) {
    return false;
  }
  if (rel === want) {
    return true;
  }
  return rel.endsWith(`/${want}`);
}

/**
 * Score one workspace-relative path.
 *
 * Any path that lives under a generated directory is demoted, so a source tree
 * always outranks a build copy of the same file.
 */
export function workspaceRank(relative: string): number {
  const segments = normalize(relative).split('/').filter(Boolean);
  if (segments.length === 0) {
    return RANK_NEUTRAL;
  }
  // The final segment is the file itself; only its directories rank the path.
  return rankSegments(segments.slice(0, -1));
}

/**
 * Score one workspace-relative directory.
 *
 * Identical to {@link workspaceRank} except that the last segment *is* a
 * directory, so `build` is demoted while `Xcp/build.c` is not.
 */
export function workspaceDirectoryRank(relative: string): number {
  const segments = normalize(relative).split('/').filter(Boolean);
  if (segments.length === 0) {
    return RANK_NEUTRAL;
  }
  return rankSegments(segments);
}

function rankSegments(directories: readonly string[]): number {
  const generated = directories.some((segment) => GENERATED_DIRECTORIES.has(segment));
  return generated ? RANK_GENERATED : RANK_SOURCE;
}

/** Depth of a workspace-relative path, used to prefer the shallowest match. */
export function pathDepth(relative: string): number {
  return normalize(relative).split('/').filter(Boolean).length;
}

function normalize(value: string): string {
  return (value ?? '').replace(/\\/g, '/').toLowerCase();
}
