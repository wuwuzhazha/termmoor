/**
 * Pure text helpers shared by the context bridge and its tests.
 *
 * This module has no `vscode` import and no side effects, so it can be bundled
 * into `node --test` without an extension host.
 */

/** Upper bound for file/terminal content written to a context file (characters). */
export const MAX_CONTENT_CHARS = 200_000;

/**
 * VS Code selection ends are exclusive. An end at column 0 of the next line
 * means the selection stops before that line, so the last included line is
 * `endLine` itself rather than `endLine + 1` (both arguments are 0-based).
 */
export function selectionEndLine(
  startLine: number,
  endLine: number,
  endCharacter: number
): number {
  if (endCharacter === 0 && endLine > startLine) {
    return endLine;
  }
  return endLine + 1;
}

/** Clip inline content and say so instead of silently shortening it. */
export function capText(
  text: string,
  limit = MAX_CONTENT_CHARS
): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit)}\n… (truncated)`, truncated: true };
}

/** Decode file bytes, refusing anything that looks binary (a NUL byte). */
export function decodeText(bytes: Uint8Array): { text: string; binary: boolean } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.includes(0)) {
    return { text: '', binary: true };
  }
  return { text: buffer.toString('utf8'), binary: false };
}
