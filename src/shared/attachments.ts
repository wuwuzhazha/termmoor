import type { Attachment } from './protocol';

export const MAX_TERMINAL_ATTACHMENT_CHARS = 200_000;

/**
 * `Attachment` lives in the shared protocol; the extra field is structural and
 * additive, so callers that only know the base type keep working.
 */
export type TerminalAttachment = Attachment & { truncated?: boolean };

/** Stable identity for one attachment; ranges distinguish selections in one file. */
export function attachmentKey(attachment: Attachment): string {
  const range = attachment.range
    ? [
        attachment.range.startLine,
        attachment.range.startColumn ?? 0,
        attachment.range.endLine,
        attachment.range.endColumn ?? 0
      ].join(':')
    : '';
  return [attachment.kind, attachment.uri ?? attachment.id ?? attachment.name, range].join('|');
}

/**
 * Terminal output has no file URI or editor range. Use a stable content key so
 * two different outputs can be attached together while re-adding the same
 * output stays idempotent.
 */
export function terminalAttachment(
  text: string,
  name = 'Terminal output',
  limit = MAX_TERMINAL_ATTACHMENT_CHARS
): TerminalAttachment | undefined {
  const clean = stripTerminalControl(text);
  const normalized = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  if (!normalized.trim()) {
    return undefined;
  }
  const truncated = normalized.length > limit;
  const clipped = truncated ? `${normalized.slice(0, limit)}\n… (truncated)` : normalized;
  return {
    kind: 'selection',
    name,
    id: `terminal:${clipped.length}:${hashText(clipped)}`,
    text: clipped,
    size: clipped.length,
    inline: true,
    truncated: truncated || undefined
  };
}

/** Removes ANSI/OSC terminal control sequences and shell-integration markers. */
export function stripTerminalControl(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\x08/g, '');
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Adds attachments in order, dropping duplicates, and caps the composer list. */
export function addUniqueAttachments(
  current: Attachment[],
  added: Attachment[],
  limit = MAX_ATTACHMENTS
): Attachment[] {
  return addUniqueAttachmentsResult(current, added, limit).items;
}

export const MAX_ATTACHMENTS = 16;

export interface AddAttachmentsResult {
  items: Attachment[];
  /** New attachments that were ignored because the composer list was full. */
  dropped: number;
}

/** Same as `addUniqueAttachments`, but reports how many items were dropped. */
export function addUniqueAttachmentsResult(
  current: Attachment[],
  added: Attachment[],
  limit = MAX_ATTACHMENTS
): AddAttachmentsResult {
  const next = [...current];
  const seen = new Set(next.map(attachmentKey));
  let dropped = 0;
  for (const attachment of added) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) {
      continue;
    }
    if (next.length >= limit) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    next.push(attachment);
  }
  return { items: next, dropped };
}
