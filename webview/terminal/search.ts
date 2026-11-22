/**
 * Dependency-free buffer search engine for Terminal Pro.
 */

export interface BufferSearchMatch {
  /** 0-based buffer line index. */
  line: number;
  /** UTF-16 start offset within `lines[line]`. */
  startOffset: number;
  /** UTF-16 length of the matched substring. */
  length: number;
}

const MAX_SEARCH_MATCHES = 2_000;

/**
 * Find case-insensitive substring matches across terminal buffer lines.
 */
export function findBufferMatches(
  lines: readonly string[],
  query: string,
  limit = MAX_SEARCH_MATCHES
): BufferSearchMatch[] {
  if (!query) {
    return [];
  }
  const needle = query.toLowerCase();
  const needleLen = needle.length;
  if (needleLen === 0) {
    return [];
  }

  const matches: BufferSearchMatch[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex];
    if (!raw || raw.length < needleLen) {
      continue;
    }
    const hay = raw.toLowerCase();
    let from = 0;
    while (from <= hay.length - needleLen) {
      const hit = hay.indexOf(needle, from);
      if (hit < 0) {
        break;
      }
      matches.push({
        line: lineIndex,
        startOffset: hit,
        length: needleLen
      });
      if (matches.length >= limit) {
        return matches;
      }
      from = hit + Math.max(1, needleLen);
    }
  }
  return matches;
}

/**
 * Advance or rewind the active match index, wrapping around at the ends.
 * Returns `-1` when `total <= 0`.
 */
export function stepMatchIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) {
    return -1;
  }
  if (current < 0 || current >= total) {
    return delta > 0 ? 0 : total - 1;
  }
  return (current + delta + total) % total;
}
