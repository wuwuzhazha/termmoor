/**
 * Shared, vscode-free contract for the context bridge and terminal service.
 * Keep this file dependency-free: it is bundled into both the Node extension
 * host and the browser webview.
 */

export interface Range {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface Attachment {
  kind: 'file' | 'folder' | 'selection' | 'image' | 'url';
  name: string;
  /** Stable identity for synthetic attachments that have no URI or range. */
  id?: string;
  /** `vscode.Uri.toString()` when the attachment maps to a file. */
  uri?: string;
  /** Workspace-relative path when available. */
  relPath?: string;
  range?: Range;
  /** Inline text (files, selections). Images use `data`. */
  text?: string;
  /** Base64 payload for images. */
  data?: string;
  mimeType?: string;
  languageId?: string;
  /** Number of characters, for compact chips. */
  size?: number;
  /** The source buffer has unsaved changes; inline text is authoritative. */
  dirty?: boolean;
  /** Text is a synthetic excerpt/diagnostic block, not the exact file range. */
  inline?: boolean;
}

export interface ContextItem {
  id: string;
  kind: 'file' | 'folder' | 'symbol' | 'selection' | 'diagnostic';
  label: string;
  description?: string;
  uri?: string;
  range?: Range;
  text?: string;
  size?: number;
}

export interface TerminalCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}
