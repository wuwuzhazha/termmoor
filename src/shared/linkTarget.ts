/**
 * Normalize a link target emitted by a terminal into a path plus optional
 * 1-based line/column.
 *
 * Three very different sources reach this helper:
 *  - OSC 8 hyperlinks written by agents/CLIs, which may use VS Code's own
 *    `vscode://file/...` scheme instead of `file://` (`vscode://file/E:/x/app.c:42`);
 *  - percent-encoded URIs, where the citation suffix itself is escaped
 *    (`file:///E:/x/app.c%23L42`);
 *  - plain text citations matched by the webview link provider (`src/app.c:42:8`,
 *    `src/app.c(42,8)`, `src/app.c#L42-L45`).
 *
 * Everything is reduced to a path the host's containment policy understands.
 * Leaving `vscode://file/`, a `%23L42` fragment, or a zero-width space in the
 * string makes `stat`/`fileURLToPath` fail, which surfaced as "file not found"
 * for files that plainly exist in the workspace.
 *
 * Pure module: no `vscode` import, no side effects, unit-testable.
 */

export interface LinkTarget {
  /** Path (or `file://` URL) with any citation suffix removed. */
  path: string;
  /** 1-based line number when the citation carried one. */
  line?: number;
  /** 1-based column number when the citation carried one. */
  column?: number;
}

const HASH_SUFFIX = /#L(\d+)(?:-L?(\d+))?(?:C(\d+))?$/i;
const PAREN_SUFFIX = /\((\d+)(?:\s*,\s*(\d+))?\)$/;
const COLON_SUFFIX = /:(\d+)(?::(\d+))?$/;

/** Zero-width spaces, bidi marks and other invisible formatting characters. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** `vscode://file/…` and `vscode-insiders://file/…` are file links in disguise. */
const VSCODE_FILE_SCHEME = /^vscode(?:-insiders)?:\/\/file[/\\]*/i;
/** A drive-rooted path that gained a leading slash from the URI form. */
const LEADING_SLASH_DRIVE = /^\/([A-Za-z]:[\\/])/;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * Split `raw` into a path and its line/column suffix.
 *
 * A bare drive letter (`E:`) is never treated as a suffix, so `E:\x` stays
 * intact. Wrapping quotes/angle brackets from citations are stripped first.
 */
export function splitLinkTarget(raw: string): LinkTarget {
  let text = normalizeTarget(raw);
  if (!text) {
    return { path: '' };
  }

  const direct = splitSuffix(text);
  if (direct) {
    return direct;
  }

  // A percent-encoded URI can hide the suffix itself (`%23L42`); decode and
  // retry so the citation still resolves to the right line.
  if (PERCENT_ESCAPE.test(text)) {
    const decoded = decodeTolerant(text);
    if (decoded !== text) {
      const fromDecoded = splitSuffix(decoded);
      if (fromDecoded) {
        return fromDecoded;
      }
      return { path: decoded };
    }
  }

  return { path: text };
}

/** Strip decorations and rewrite URI-only spellings into plain paths. */
function normalizeTarget(raw: string): string {
  let text = typeof raw === 'string' ? raw : '';
  text = text.replace(INVISIBLE, '').trim();
  text = text.replace(/^[`"'<]+/, '').replace(/[`"'>]+$/, '').trim();
  if (!text) {
    return '';
  }

  if (VSCODE_FILE_SCHEME.test(text)) {
    text = text.replace(VSCODE_FILE_SCHEME, '');
    // `vscode://file/E:/x` keeps the drive; the URI form may also be escaped.
    if (PERCENT_ESCAPE.test(text)) {
      text = decodeTolerant(text);
    }
  } else if (PERCENT_ESCAPE.test(text)) {
    // Decode first so an escaped separator (`%5C`) or suffix (`%23L42`) is
    // recognized; decoding an already-normal URI is harmless.
    const decoded = decodeTolerant(text);
    if (decoded !== text) {
      text = decoded;
    }
  }

  const driveRooted = LEADING_SLASH_DRIVE.exec(text);
  if (driveRooted) {
    text = text.slice(1);
  }
  return text;
}

function decodeTolerant(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape (`100%`, `%zz`) must never break the link.
    return value;
  }
}

function splitSuffix(text: string): LinkTarget | undefined {
  const hash = HASH_SUFFIX.exec(text);
  if (hash) {
    return makeTarget(
      text.slice(0, hash.index),
      toPositive(hash[1]),
      hash[3] ? toPositive(hash[3]) : undefined
    );
  }

  const paren = PAREN_SUFFIX.exec(text);
  if (paren) {
    const path = text.slice(0, paren.index);
    if (path) {
      return makeTarget(path, toPositive(paren[1]), paren[2] ? toPositive(paren[2]) : undefined);
    }
  }

  const colon = COLON_SUFFIX.exec(text);
  if (colon) {
    const path = text.slice(0, colon.index);
    // `E:` / `c:` are drives, not citations.
    if (path && !/^[A-Za-z]$/.test(path)) {
      return makeTarget(path, toPositive(colon[1]), colon[2] ? toPositive(colon[2]) : undefined);
    }
  }

  return undefined;
}

function toPositive(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Build a target without `undefined` keys so callers can compare structurally. */
function makeTarget(path: string, line?: number, column?: number): LinkTarget {
  const target: LinkTarget = { path };
  if (line !== undefined) {
    target.line = line;
  }
  if (column !== undefined) {
    target.column = column;
  }
  return target;
}
