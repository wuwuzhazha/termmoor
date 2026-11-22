/**
 * Editor-to-terminal payload decisions for the "send selection to TermMoor"
 * gesture (pure, no `vscode` import, no side effects).
 *
 * The gesture inserts a *draft* only: nothing is executed and the draft never
 * ends with a line break (xterm's `insert()` submits on a raw newline, so a
 * trailing newline would break the "never runs" promise).
 *
 * Payload rules:
 * - A capture always leads with a citation line (`rel/path.ts:12-14`, one entry
 *   per selection) so the source location stays visible in the draft itself.
 * - Small captures travel inline as fenced code: any CLI, including a plain
 *   shell, receives the selected code without being able to read the file.
 * - Large captures (and unsaved whole-file buffers) travel through the
 *   provider's existing context-file mechanism, because a 200k-character paste
 *   would flood the PTY. The context file repeats the citation header, so the
 *   location stays visible there too.
 * - A clean whole file stays a quoted path reference: every CLI can open it and
 *   the draft stays pasteable.
 */

import { capText, selectionEndLine } from './contextFormat';
import { quoteForShell } from './shellQuote';

/**
 * Captured code above this size is written to a context file instead of being
 * pasted into the terminal. Well under `MAX_CONTENT_CHARS`, because a 200k
 * character draft is unusable in a shell and slow over the PTY.
 */
export const MAX_INLINE_CHARS = 12_000;

/** A position as VS Code reports it: 0-based line and character. */
export interface EditorPosition {
  line: number;
  character: number;
}

/** A selection range normalised to 1-based, inclusive display lines. */
export interface NormalizedSelection {
  startLine: number;
  endLine: number;
  /** 1-based; omitted when the selection ends at column 0 of a later line. */
  startColumn?: number;
  endColumn?: number;
}

export interface PayloadSelection extends NormalizedSelection {
  text: string;
}

export interface SendPayloadInput {
  /** Workspace-relative path, or an absolute path outside every workspace root. */
  path: string;
  languageId?: string;
  /** Non-empty selections. An empty list means "the whole file". */
  selections?: PayloadSelection[];
  /** Whole-file text; only read when there is no selection. */
  fileText?: string;
  /** The buffer has unsaved changes, so the file on disk is stale. */
  dirty?: boolean;
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to `MAX_INLINE_CHARS`. */
  inlineLimit?: number;
}

export interface ContextFileRequest {
  /** Which `writeContextFile` bucket the provider should use. */
  kind: 'selection' | 'file';
  text: string;
  ext: string;
}

export interface SendPayloadPlan {
  /** Citation for the draft, quoted where a shell needs it. */
  citation: string;
  /** Fully assembled inline draft, or `''` when the code travels in a file. */
  inline: string;
  /** Content the provider must write with its context-file helper. */
  contextFile?: ContextFileRequest;
  /** The captured text was clipped at `MAX_CONTENT_CHARS`. */
  truncated: boolean;
}

const SHELL_UNSAFE = /[\s"'`$&|<>;()*?!^%#\\]/;
const LANGUAGE_TOKEN = /^[A-Za-z0-9_+#.-]{1,20}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
/**
 * C0 controls other than tab and newline. `insert()` types the captured text
 * into the PTY, so a raw ESC (terminal escape injection) or Ctrl-C (interrupt)
 * must never reach the shell through a selection.
 */
const CAPTURE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Order a raw anchor/active pair and convert it to the 1-based line range a
 * citation must show.
 *
 * VS Code selections can be built backwards (anchor below active) and end
 * exclusively at column 0 of the following line; both must collapse to the
 * lines the user actually sees, otherwise the citation points one line too far.
 */
export function normalizeSelection(
  anchor: EditorPosition,
  active: EditorPosition
): NormalizedSelection {
  const reversed =
    active.line < anchor.line ||
    (active.line === anchor.line && active.character < anchor.character);
  const start = reversed ? active : anchor;
  const end = reversed ? anchor : active;
  return {
    startLine: start.line + 1,
    endLine: selectionEndLine(start.line, end.line, end.character),
    startColumn: start.character + 1,
    // An end at column 0 is exclusive: the last line is complete, so there is
    // no meaningful end column (0 + 1 would wrongly claim column 1).
    endColumn: end.character === 0 ? undefined : end.character + 1
  };
}

/** `rel/path.ts:12-14` (or a bare path) as one shell-visible line. */
export function formatLocation(
  filePath: string,
  range?: { startLine: number; endLine: number }
): string {
  const clean = oneLine(filePath);
  if (!range) {
    return clean;
  }
  return `${clean}:${range.startLine}-${range.endLine}`;
}

/** Decide between an inline draft and a context file. Pure. */
export function buildSendPayload(input: SendPayloadInput): SendPayloadPlan {
  const platform = input.platform ?? process.platform;
  const filePath = oneLine(input.path);
  const inlineLimit = input.inlineLimit ?? MAX_INLINE_CHARS;
  const selections = (input.selections ?? []).filter((item) => item.text.trim().length > 0);

  if (selections.length > 0) {
    const render = (cite: (selection: PayloadSelection) => string): string =>
      selections
        .map((selection) => `${cite(selection)}\n${fenced(selection.text, input.languageId)}`)
        .join('\n');
    const draftCitation = (selection: PayloadSelection): string =>
      quoteToken(formatLocation(filePath, selection), platform);
    const citation = selections.map(draftCitation).join(', ');
    const inline = render(draftCitation);
    if (inline.length <= inlineLimit) {
      return { citation, inline, truncated: false };
    }
    // Context files are read by a CLI, not pasted into a shell: no quoting
    // inside the file, and the header repeats the same 1-based line ranges.
    const capped = capText(render((selection) => formatLocation(filePath, selection)));
    return {
      citation,
      inline: '',
      contextFile: { kind: 'selection', text: capped.text, ext: '.txt' },
      truncated: capped.truncated
    };
  }

  const fileText = normalizeNewlines(input.fileText ?? '');
  if (input.dirty && fileText.trim()) {
    const body = stripTrailingNewlines(fileText);
    const header = formatLocation(filePath, { startLine: 1, endLine: lineCount(body) });
    const capped = capText(`${header}\n${fenced(body, input.languageId)}`);
    return {
      citation: quoteToken(filePath, platform),
      inline: '',
      contextFile: { kind: 'file', text: capped.text, ext: '.txt' },
      truncated: capped.truncated
    };
  }

  return { citation: quoteToken(filePath, platform), inline: '', truncated: false };
}

/**
 * Assemble the draft the provider inserts. Pass the path returned by
 * `writeContextFile` when the plan carries a `contextFile`; a failed write
 * degrades to the citation instead of silently dropping the gesture.
 */
export function composeSendDraft(
  plan: SendPayloadPlan,
  contextFilePath?: string,
  platform: NodeJS.Platform = process.platform
): string {
  let draft: string;
  if (plan.inline) {
    draft = plan.inline;
  } else if (plan.contextFile && contextFilePath) {
    draft = `${plan.citation}\n${quoteForShell(oneLine(contextFilePath), platform)}`;
  } else {
    draft = plan.citation;
  }
  // `insert()` only turns newlines *between* lines into paste-safe input, so a
  // trailing newline would be typed raw and submit the line.
  return stripTrailingNewlines(normalizeNewlines(draft));
}

/** Fence a snippet with a backtick run longer than anything inside it. */
function fenced(text: string, languageId?: string): string {
  const body = stripTrailingNewlines(sanitizeCapture(text));
  const language = languageId && LANGUAGE_TOKEN.test(languageId) ? languageId : '';
  const longest = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

/** Quote only when the token would otherwise be split or expanded by a shell. */
function quoteToken(value: string, platform: NodeJS.Platform): string {
  return SHELL_UNSAFE.test(value) ? quoteForShell(value, platform) : value;
}

/** Collapse control characters so a citation or path stays on one line. */
function oneLine(value: string): string {
  return String(value ?? '').replace(CONTROL_CHARS, ' ').trim();
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** Keep tabs and newlines, drop every other C0 control byte. */
function sanitizeCapture(value: string): string {
  return normalizeNewlines(value).replace(CAPTURE_CONTROLS, '');
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, '');
}

function lineCount(value: string): number {
  return value.split('\n').length;
}
