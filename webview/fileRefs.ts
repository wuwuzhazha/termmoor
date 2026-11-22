/**
 * File references in terminal output.
 *
 * Shells, compilers, and CLIs print paths as bare tokens (`src/net/socket.ts:38-45`),
 * MSVC/Keil/IAR/Clang parenthesized locations (`src/main.c(42,8)`), Python
 * tracebacks (`File "run_all_tests.py", line 84`), and `#Lx-Ly` anchors.
 * This module turns those spellings into a small, pure description that the
 * renderer can make clickable and the host can resolve against the workspace cwd.
 */

import { splitFileList, trimTrailingProse } from '../src/shared/fileList';

export interface FileRef {
  /**
   * Path exactly as written in the output, without any line suffix. It may name
   * a file or a directory; the host stats the target and decides.
   */
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
}

/** Extensions that are unambiguously source/config/document files. */
const KNOWN_EXTENSIONS = new Set(
  `
  ts tsx js jsx mjs cjs mts cts json json5 jsonc md mdx markdown rst adoc txt
  css scss sass less styl html htm xhtml vue svelte astro
  py pyi pyw rb rake go rs java kt kts scala groovy clj cljs cljc edn
  c h cc cpp cxx hpp hxx inl inc cs fs fsx vb php pl pm lua r jl swift m mm dart
  sh bash zsh fish ksh ps1 psm1 bat cmd
  sql graphql gql proto thrift
  yaml yml toml ini cfg conf properties env xml xsl xslt svg
  png jpg jpeg gif webp bmp ico avif pdf zip tar gz tgz bz2 xz 7z rar
  lock gradle cmake ninja meson mk make asm s sv svh vhd vhdl v
  ld icf s19 hex elf dbc arxml def idl
  sln vcxproj csproj uvprojx ewp a2l
  ex exs erl hrl hs lhs ml mli nim zig cr sol
  csv tsv log diff patch map wasm mod sum
  `
    .trim()
    .split(/\s+/)
);

/** Extensionless files that are still obviously files. */
const SPECIAL_FILES = new Set([
  'dockerfile',
  'makefile',
  'cmakelists.txt',
  'license',
  'licence',
  'notice',
  'readme',
  'changelog',
  'contributing',
  'authors',
  'codeowners',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.yarnrc',
  '.prettierrc',
  '.eslintrc',
  '.dockerignore',
  '.env',
  '.env.local',
  '.env.example',
  'gemfile',
  'rakefile',
  'procfile',
  'brewfile',
  'vagrantfile',
  'jenkinsfile'
]);

function trimDecoration(raw: string): string {
  let text = raw.trim();
  const pairs: Array<[string, string]> = [
    ['`', '`'],
    ['"', '"'],
    ["'", "'"],
    ['<', '>'],
    ['[', ']']
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= 2) {
      text = text.slice(1, -1).trim();
      break;
    }
  }
  // Only strip outer parentheses when the whole token is wrapped `(src/a.ts:10)`,
  // not when parentheses hold a trailing line suffix `src/a.c(10,4)`.
  if (text.startsWith('(') && text.endsWith(')') && text.length >= 2) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Strip sentence punctuation that often trails a printed path. */
function trimTrailingPunctuation(text: string): string {
  return text.replace(/[.,;:]+$/, '');
}

function isFileLike(path: string): boolean {
  if (!path || /[\\/]$/.test(path)) {
    return false;
  }
  if (path.startsWith('-')) {
    // CLI flags such as --config.ts are not files.
    return false;
  }
  if (/[<>"|?*`#]/.test(path) || /[\r\n\t]/.test(path)) {
    return false;
  }
  if (path !== path.trim()) {
    return false;
  }
  // Spaces are legal in Windows paths ("C:\Program Files\app\main.ts") and in
  // Chinese file names ("项目 计划.md"), but a bare "word word.ts" is prose.
  // Only trust whitespace when the candidate actually contains a separator.
  if (/[ \t]/.test(path) && !/[\\/]/.test(path)) {
    return false;
  }
  if (path.includes('…') || path.includes('...')) {
    return false;
  }
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const rest = drive ? path.slice(2) : path;
  // A remaining colon is a protocol, a stream name or prose, not a path.
  if (rest.includes(':')) {
    return false;
  }
  const segments = rest.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  const base = segments[segments.length - 1];
  const lower = base.toLowerCase();
  if (SPECIAL_FILES.has(lower)) {
    return true;
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return false;
  }
  return KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Parse a path plus optional line/column/range suffix:
 *   src/net/socket.ts
 *   src/net/socket.ts:38
 *   src/net/socket.ts:38:5
 *   src/net/socket.ts:38-45
 *   src/net/socket.ts#L38-L45
 *   src/main.c(42,8)
 *   C:\work\app\src\net\socket.ts:38
 * Returns null for URLs, identifiers, versions and ordinary prose.
 */
export function parseFileRef(raw: string): FileRef | null {
  if (!raw) {
    return null;
  }
  let text = trimDecoration(raw);
  if (!text || /^(https?|mailto|data):/i.test(text) || text.includes('://')) {
    return null;
  }
  text = text.replace(/[.,;]+$/, '');

  let line: number | undefined;
  let column: number | undefined;
  let endLine: number | undefined;

  const pyTrace = /^File\s+["']([^"']+)["']\s*,\s*line\s+(\d+)$/i.exec(text);
  if (pyTrace) {
    text = pyTrace[1];
    line = Number(pyTrace[2]);
  } else {
    const hash = /#L(\d+)(?:-L?(\d+))?(?:C(\d+))?$/i.exec(text);
    if (hash) {
      line = Number(hash[1]);
      endLine = hash[2] ? Number(hash[2]) : undefined;
      column = hash[3] ? Number(hash[3]) : undefined;
      text = text.slice(0, hash.index);
    } else {
      const paren = /\((\d+)(?:\s*,\s*(\d+))?(?:-(\d+))?\)$/.exec(text);
      if (paren) {
        line = Number(paren[1]);
        column = paren[2] ? Number(paren[2]) : undefined;
        endLine = paren[3] ? Number(paren[3]) : undefined;
        text = text.slice(0, paren.index);
      } else {
        const colon = /:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/.exec(text);
        if (colon) {
          line = Number(colon[1]);
          column = colon[2] ? Number(colon[2]) : undefined;
          endLine = colon[3] ? Number(colon[3]) : undefined;
          text = text.slice(0, colon.index);
        }
      }
    }
  }

  const path = trimTrailingPunctuation(text.trim());
  if (!isFileLike(path)) {
    return null;
  }
  if (line !== undefined && (!Number.isSafeInteger(line) || line <= 0)) {
    return null;
  }
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < (line ?? 0))) {
    return null;
  }
  if (column !== undefined && (!Number.isSafeInteger(column) || column <= 0)) {
    return null;
  }
  return { path, line, column, endLine };
}

/**
 * Find the source file of a fenced code block.
 */
export function parseCodeFenceSource(lang: string | undefined, code: string): FileRef | null {
  const info = (lang ?? '').trim();
  if (info) {
    const candidates: string[] = [];
    const title = /(?:title|file)\s*=\s*["']?([^"'\s]+)["']?/i.exec(info);
    if (title?.[1]) {
      candidates.push(title[1]);
    }
    const parts = info.split(/\s+/);
    if (parts.length > 1) {
      candidates.push(parts.slice(1).join(' ').replace(/^["']|["']$/g, ''));
      candidates.push(...parts.slice(1));
    }
    const colon = /^[\w+-]+:(.+)$/.exec(parts[0] ?? '');
    if (colon?.[1]) {
      candidates.push(colon[1]);
    }
    candidates.push(info);
    for (const candidate of candidates) {
      const ref = parseFileRef(candidate);
      if (ref) {
        return ref;
      }
    }
  }

  const first = code.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  if (!first) {
    return null;
  }
  const comment = /^(?:\/\/|#|--|;|\/\*|\*|<!--)\s*(?:file:\s*)?(.+?)(?:\s*\*\/|\s*-->)?$/.exec(
    first.trim()
  );
  if (!comment?.[1]) {
    return null;
  }
  return parseFileRef(comment[1]);
}

export function formatFileRefRange(ref: FileRef): string {
  if (!ref.line) {
    return '';
  }
  const end = ref.endLine && ref.endLine !== ref.line ? `-${ref.endLine}` : '';
  const column = ref.column ? `:${ref.column}` : '';
  return `:${ref.line}${column}${end}`;
}

export interface FileRefMatch {
  /** Start offset in the scanned text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  ref: FileRef;
}

const PATH_CHAR = String.raw`[\p{L}\p{N}_.@+~\-]`;
const PATH_CHUNK = String.raw`${PATH_CHAR}+`;
const PATH_SEGMENT = String.raw`${PATH_CHUNK}(?:[ \t]${PATH_CHUNK}){0,8}`;
const PATH_ANCHOR = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\\\\|\/{1,2}|\.{1,2}[\\/])`;
const PATH_PREFIX = String.raw`(?:${PATH_ANCHOR}(?:${PATH_SEGMENT}[\\/])*|${PATH_CHUNK}[\\/](?:${PATH_SEGMENT}[\\/])*)`;
const SUFFIX_PATTERN = String.raw`(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:-L?\d+)?(?:C\d+)?|\(\d+(?:\s*,\s*\d+)?(?:-\d+)?\))`;

/**
 * Explicit directory spellings. The host stats the target and decides whether
 * it is a file or a directory, so these carry no type flag. Only shapes that
 * are unmistakably paths are considered: a trailing separator (`Xcp/`),
 * several segments (`Xcp/docs`), a dot-relative path (`./docs`), or an
 * absolute/drive/UNC/home anchor (`E:/Xcp`, `\\server\share`, `/usr/local`).
 *
 * A segment may contain spaces (`E:/Program Files/Xcp`, `Xcp/My Docs/`); the
 * prose cut in {@link truncateDirectoryProse} later stops a candidate before
 * narration such as `and`, `for`, or `is` so the link does not swallow it.
 */
const DIRECTORY_SEGMENT = String.raw`${PATH_CHUNK}(?:[ \t]${PATH_CHUNK}){0,8}`;
const DIRECTORY_ANCHOR = PATH_ANCHOR;
// A path that ends in a separator is complete only when the next character is
// not another path chunk; otherwise a prefix like `Xcp/` would win over
// `Xcp/docs/readme`.
const DIRECTORY_ANCHORED_TRAILING = String.raw`${DIRECTORY_ANCHOR}(?:${DIRECTORY_SEGMENT}[\\/])+(?![\p{L}\p{N}_.@+~\-])`;
const DIRECTORY_ANCHORED = String.raw`${DIRECTORY_ANCHOR}(?:${DIRECTORY_SEGMENT}[\\/])*${DIRECTORY_SEGMENT}[\\/]?`;
const DIRECTORY_TRAILING = String.raw`${PATH_CHUNK}(?:[\\/]${DIRECTORY_SEGMENT})*[\\/](?![\p{L}\p{N}_.@+~\-])`;
const DIRECTORY_MULTI = String.raw`${PATH_CHUNK}(?:[\\/]${DIRECTORY_SEGMENT})+[\\/]?`;
const DIRECTORY_CANDIDATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+~\-\\/])` +
    String.raw`(?:${DIRECTORY_ANCHORED_TRAILING}|${DIRECTORY_ANCHORED}|${DIRECTORY_TRAILING}|${DIRECTORY_MULTI})`,
  'gu'
);

/**
 * Words that mark the end of a path and the start of narration. They are only
 * checked inside a space-containing segment, so a directory literally named
 * `for` or `file` (one chunk, no spaces) is untouched.
 */
const DIRECTORY_PROSE_WORDS = new Set([
  'and',
  'or',
  'then',
  'with',
  'without',
  'to',
  'for',
  'from',
  'in',
  'on',
  'at',
  'of',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'see',
  'now',
  'here',
  'there',
  'this',
  'that',
  'these',
  'those',
  'by',
  'as',
  'if',
  'else',
  'but',
  'not',
  'yes',
  'no',
  'run',
  'use',
  'using',
  'visit',
  'open',
  'shows',
  'contains',
  'includes'
]);

/**
 * Cut a directory candidate where narration begins. A space alone is not a
 * boundary (`My Docs` is one directory), but a connective word is
 * (`E:/Xcp and ./docs` is two citations).
 */
function truncateDirectoryProse(path: string): string {
  let segmentStart = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index < path.length && !/[\\/]/.test(path[index])) {
      continue;
    }
    const segment = path.slice(segmentStart, index);
    if (/[ \t]/.test(segment)) {
      const chunks = segment.split(/([ \t]+)/);
      let offset = segmentStart;
      for (let chunk = 0; chunk < chunks.length; chunk += 2) {
        if (
          chunk > 0 &&
          DIRECTORY_PROSE_WORDS.has(chunks[chunk].toLowerCase())
        ) {
          return path.slice(0, offset).replace(/[ \t]+$/, '');
        }
        offset += chunks[chunk].length + (chunks[chunk + 1]?.length ?? 0);
      }
    }
    segmentStart = index + 1;
  }
  return path;
}

/** Common prose pairs that happen to use a slash; they are not paths. */
const PROSE_SLASH_PAIRS = new Set([
  'and/or',
  'yes/no',
  'on/off',
  'input/output',
  'read/write',
  'true/false',
  'either/or',
  'client/server',
  'tcp/ip',
  'n/a',
  'i/o'
]);

const FILE_REF_CANDIDATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+~\-\\/])` +
    String.raw`(?:${PATH_PREFIX})?` +
    String.raw`(?:${PATH_SEGMENT}\.[A-Za-z0-9]{1,12}|README|LICENSE|LICENCE|Dockerfile|Makefile|CMakeLists\.txt|CHANGELOG|CONTRIBUTING|Gemfile|Rakefile|Procfile|Vagrantfile|Jenkinsfile|\.gitignore|\.gitattributes|\.editorconfig|\.env)` +
    String.raw`${SUFFIX_PATTERN}?`,
  'giu'
);

/**
 * A run of path-like segments joined by single slashes.
 *
 * The character class is deliberately ASCII-only: CJK prose and full-width
 * punctuation (`：`, `。`) must never be absorbed into a file name, otherwise
 * `里的隐藏静态缓冲：XcpOnEth.c` becomes one "path".
 *
 * The member's citation suffix is part of the run so `XcpOnFr.c:42:8` stays a
 * clickable member that opens at line 42, column 8, exactly like a lone path.
 */
const FILE_LIST_MEMBER = String.raw`[A-Za-z0-9_\-.,@+~$%()\\]+${SUFFIX_PATTERN}?`;
const FILE_LIST_CANDIDATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+~\-\\/])` + String.raw`${FILE_LIST_MEMBER}(?:/${FILE_LIST_MEMBER})+`,
  'gu'
);

const PYTHON_TRACEBACK_RE = /File\s+"([^"\r\n]+)"\s*,\s*line\s+(\d+)/gi;

/**
 * A quoted path. Quotes make the boundaries explicit, so the prose cut used
 * for bare tokens must not run inside them: `"My Docs/Sub Folder"` is one
 * directory even though `My` and `Docs` look like separate chunks.
 */
const QUOTED_SPAN_RE = /(["'`])([^"'`\r\n]+)\1/g;

const DIRECTORY_SEGMENT_RE = new RegExp(String.raw`^${PATH_CHUNK}(?:[ \t]${PATH_CHUNK})*$`, 'u');
const DIRECTORY_EXPLICIT_RE = new RegExp(String.raw`^(?:${DIRECTORY_ANCHOR})`);
const NUMERIC_SEGMENT_RE = /^\d+(?:[.,]\d+)?$/;

/**
 * Validate a directory candidate without touching the filesystem. The host
 * stats the target later, so this only rejects prose, options, URLs and other
 * shapes that cannot be a path.
 */
function isDirectoryLikePath(path: string): boolean {
  if (!path || path.startsWith('-')) {
    return false;
  }
  if (/[<>"|?*`#]/.test(path) || /[\r\n\t]/.test(path)) {
    return false;
  }
  if (path !== path.trim()) {
    return false;
  }
  if (path.includes('…') || path.includes('...')) {
    return false;
  }
  if (!/[\\/]/.test(path)) {
    return false;
  }
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const rest = drive ? path.slice(2) : path;
  if (rest.includes(':')) {
    return false;
  }
  const segments = rest.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  // Ratios (`16/9`), dates (`2024/01/15`), and similar numeric prose look
  // exactly like a multi-segment relative path. A real directory is named,
  // not purely numeric, so refuse the whole candidate.
  const named = segments.filter((segment) => segment !== '.' && segment !== '..');
  if (named.length > 0 && named.every((segment) => NUMERIC_SEGMENT_RE.test(segment))) {
    return false;
  }
  const explicit =
    /[\\/]$/.test(path) || DIRECTORY_EXPLICIT_RE.test(path) || segments.length >= 2;
  if (!explicit) {
    return false;
  }
  if (
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !/[\\/]$/.test(path) &&
    segments.length === 2 &&
    PROSE_SLASH_PAIRS.has(segments.join('/').toLowerCase())
  ) {
    return false;
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      continue;
    }
    if (!DIRECTORY_SEGMENT_RE.test(segment)) {
      return false;
    }
  }
  return true;
}

/**
 * Ways a slash list token can be read, most literal first.
 *
 * A CLI often wraps the citation it prints: `(XcpOnEth.c/XcpOnFr.c)`. The
 * member character class deliberately allows parentheses because a real file
 * name may contain them (`helper(2).c`), so the wrapper has to be recognized
 * structurally: a pair around the whole token, an unpaired opener whose closer
 * sits outside the matched citation, or one trailing closer that belongs to the
 * surrounding sentence (`see XcpOnEth.c/XcpOnFr.c)`).
 *
 * `leading` is how many characters were removed from the start, so the caller
 * can keep each member's match range exact.
 */
const LIST_WRAPPER_OPENERS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '<': '>',
  '{': '}'
};
const LIST_WRAPPER_CLOSERS = new Set(Object.values(LIST_WRAPPER_OPENERS));

function listInterpretations(token: string): Array<{ text: string; leading: number }> {
  const readings: Array<{ text: string; leading: number }> = [{ text: token, leading: 0 }];
  if (token.length < 2) {
    return readings;
  }
  const close = token[token.length - 1];
  if (LIST_WRAPPER_OPENERS[token[0]] === close) {
    readings.push({ text: token.slice(1, -1), leading: 1 });
  }
  if (LIST_WRAPPER_OPENERS[token[0]]) {
    // The wrapper's closer can sit outside the matched citation when the last
    // member carries a suffix (`(XcpOnEth.c/XcpOnFr.c:42:8)`).
    readings.push({ text: token.slice(1), leading: 1 });
  }
  if (LIST_WRAPPER_CLOSERS.has(close)) {
    readings.push({ text: token.slice(0, -1), leading: 0 });
  }
  return readings;
}

/** True when every `(` in `part` has its own `)` (no wrapper decoration). */
function hasBalancedParentheses(part: string): boolean {
  let depth = 0;
  for (const character of part) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Split a slash list only when every member is a complete, undecorated file
 * name.
 *
 * A partial split would replace the whole citation with one member carrying
 * decoration (the bug behind `(XcpOnEth.c/XcpOnFr.c)` becoming the literal
 * path `(XcpOnEth.c`). If no reading is clean, the caller falls through to the
 * general single-file matcher instead.
 */
function splitListCitation(token: string): { parts: string[]; leading: number } | null {
  for (const reading of listInterpretations(token)) {
    const parts = splitFileList(reading.text);
    if (parts.length < 2) {
      continue;
    }
    if (!parts.every(hasBalancedParentheses)) {
      continue;
    }
    return { parts, leading: reading.leading };
  }
  return null;
}

function truncateAtProse(candidate: string): string {
  if (!/[ \t]/.test(candidate)) {
    return candidate;
  }
  const spaces = /[ \t]+/g;
  let match: RegExpExecArray | null;
  const completedEnd = new RegExp(String.raw`\.[A-Za-z0-9]{1,12}${SUFFIX_PATTERN}?$`);
  while ((match = spaces.exec(candidate))) {
    const head = candidate.slice(0, match.index);
    if (completedEnd.test(head)) {
      return head;
    }
  }
  return candidate;
}

/**
 * Scan free text (a terminal line, compiler diagnostic, traceback) for file
 * references. URLs and option-like tokens are skipped.
 */
export function findFileRefs(text: string): FileRefMatch[] {
  if (!text) {
    return [];
  }
  const matches: FileRefMatch[] = [];

  // 1. Python traceback citations (`File "path.py", line 42`) take priority over
  // bare inner-path matches so clicking jumps straight to the cited line.
  PYTHON_TRACEBACK_RE.lastIndex = 0;
  let pyMatch: RegExpExecArray | null;
  while ((pyMatch = PYTHON_TRACEBACK_RE.exec(text))) {
    const ref = parseFileRef(pyMatch[0]);
    if (ref) {
      matches.push({
        start: pyMatch.index,
        end: pyMatch.index + pyMatch[0].length,
        ref
      });
    }
  }

  const overlapsExisting = (start: number, end: number): boolean =>
    matches.some((existing) => start < existing.end && end > existing.start);

  // 2. Quoted paths. Quotes delimit the citation, so a leading segment may
  // contain spaces without being mistaken for narration. Unquoted text keeps
  // the stricter prose cutoff below.
  QUOTED_SPAN_RE.lastIndex = 0;
  let quoted: RegExpExecArray | null;
  while ((quoted = QUOTED_SPAN_RE.exec(text))) {
    const value = quoted[2].trim();
    if (!value) {
      continue;
    }
    const leading = quoted[2].length - quoted[2].trimStart().length;
    const start = quoted.index + 1 + leading;
    const end = start + value.length;
    if (overlapsExisting(start, end)) {
      continue;
    }
    // A quoted slash list is still a list of files, not one long path.
    if (splitFileList(value).length >= 2) {
      continue;
    }
    const fileRef = parseFileRef(value);
    if (fileRef) {
      matches.push({ start, end, ref: fileRef });
      continue;
    }
    if (!isDirectoryLikePath(value)) {
      continue;
    }
    matches.push({ start, end, ref: { path: value } });
  }

  // 3. Slash-separated file lists (`XcpOnEth.c/XcpOnFr.c`). Agents write these
  // to mean two files; taken literally the slash reads as a directory.
  FILE_LIST_CANDIDATE.lastIndex = 0;
  let listMatch: RegExpExecArray | null;
  while ((listMatch = FILE_LIST_CANDIDATE.exec(text))) {
    let tokenStart = listMatch.index;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const tokenPrefix = text.slice(tokenStart, listMatch.index);
    if (
      tokenPrefix.includes('://') ||
      /^[a-z][a-z0-9+.-]*:/i.test(tokenPrefix)
    ) {
      continue;
    }
    // Sentence punctuation may have been captured by the run; split only the
    // file names so `XcpOnFr.c。` still resolves to `XcpOnFr.c`.
    const { token: proseToken } = trimTrailingProse(listMatch[0]);
    const token = proseToken.replace(/[.,;]+$/, '');
    const citation = splitListCitation(token);
    if (!citation) {
      continue;
    }
    let offset = listMatch.index + citation.leading;
    for (const part of citation.parts) {
      const ref = parseFileRef(part);
      if (!ref) {
        continue;
      }
      matches.push({ start: offset, end: offset + part.length, ref });
      offset += part.length + 1;
    }
  }

  // 4. General path + line/range/paren citations.
  FILE_REF_CANDIDATE.lastIndex = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = FILE_REF_CANDIDATE.exec(text))) {
    const start = candidate.index;
    const candidateText = candidate[0];
    const raw = truncateAtProse(candidateText);
    if (raw.length < candidateText.length) {
      FILE_REF_CANDIDATE.lastIndex = start + raw.length;
    }
    if (overlapsExisting(start, start + raw.length)) {
      continue;
    }
    if (start > 0 && /[\p{L}\p{N}_.\-\\/]/u.test(text[start - 1])) {
      continue;
    }
    let tokenStart = start;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const tokenPrefix = text.slice(tokenStart, start);
    if (tokenPrefix.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(tokenPrefix)) {
      continue;
    }
    const ref = parseFileRef(raw);
    if (!ref) {
      const space = raw.search(/[ \t]/);
      if (space > 0) {
        FILE_REF_CANDIDATE.lastIndex = start + space + 1;
      }
      continue;
    }
    const after = text[start + raw.length];
    if (after && /[\p{L}\p{N}_]/u.test(after)) {
      continue;
    }
    matches.push({ start, end: start + raw.length, ref });
  }

  // 5. Explicit directory citations. The host decides from the filesystem
  // whether the target is a file or a folder, so these only need a clear path
  // shape. Running after the file pass means an overlapping file link always
  // wins; `STD/CAL Xcp_Std.c` therefore stays the full ambiguous file
  // candidate rather than becoming a folder plus a file.
  DIRECTORY_CANDIDATE.lastIndex = 0;
  let directory: RegExpExecArray | null;
  while ((directory = DIRECTORY_CANDIDATE.exec(text))) {
    const start = directory.index;
    const candidatePath = trimTrailingPunctuation(directory[0]);
    if (!candidatePath) {
      continue;
    }
    const path = trimTrailingPunctuation(truncateDirectoryProse(candidatePath));
    if (!path) {
      continue;
    }
    if (path.length < directory[0].length) {
      // Let the next iteration find citations that followed the narration.
      DIRECTORY_CANDIDATE.lastIndex = start + path.length;
    }
    const end = start + path.length;
    if (overlapsExisting(start, end)) {
      continue;
    }
    if (start > 0 && /[\p{L}\p{N}_.\-\\/]/u.test(text[start - 1])) {
      continue;
    }
    let tokenStart = start;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const tokenPrefix = text.slice(tokenStart, start);
    // A quoted URL starts its directory-looking run at `//`; strip the
    // opening quote before checking for a scheme.
    const unquotedPrefix = tokenPrefix.replace(/^[`"'<]+/, '');
    if (
      text[tokenStart] === '-' ||
      tokenPrefix.includes('://') ||
      /^[a-z][a-z0-9+.-]*:/i.test(unquotedPrefix)
    ) {
      continue;
    }
    const after = text[end];
    if (after && /[\p{L}\p{N}_]/u.test(after)) {
      continue;
    }
    if (!isDirectoryLikePath(path)) {
      continue;
    }
    matches.push({ start, end, ref: { path } });
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}
