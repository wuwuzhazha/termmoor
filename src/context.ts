import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeSelection, type PayloadSelection } from './contextPayload';
import { classifyOpenTarget, isInside } from './security/pathPolicy';
import { looksLikeFileName } from './shared/fileList';
import {
  fileCitationFallbackName,
  hasParentTraversal,
  isWithinUriPath
} from './shared/openTargetPath';
import {
  matchesSuffix,
  pathDepth,
  RANK_GENERATED,
  workspaceDirectoryRank,
  workspaceRank
} from './shared/workspaceMatch';

const MAX_FILES = 5_000;
/**
 * Bounds for the on-demand directory scan that backs empty-folder citations.
 * The normal path derives directories from the file index; the scan only runs
 * when that index has no answer, so it must stay cheap.
 */
const MAX_DIRECTORY_SCAN = 1_200;
const MAX_DIRECTORY_SCAN_DEPTH = 6;
const DIRECTORY_SCAN_IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'media']);

/**
 * Editor capture handed to `buildSendPayload` by the one-gesture send command.
 * Paths are workspace-relative when possible and never `../` escapes.
 */
export interface EditorSendCapture {
  path: string;
  localPath?: string;
  languageId?: string;
  dirty: boolean;
  /** Non-empty selections with 1-based, inclusive line ranges. */
  selections: PayloadSelection[];
  /** Whole-buffer text; only read when there is no selection. */
  fileText?: string;
}

/**
 * Outcome of a terminal navigation request.
 *
 * `cancelled` means the user dismissed the outside-workspace confirmation or
 * the ambiguity quick pick; it is not a failure and must not be reported as
 * a missing file.
 */
export type OpenPathResult = 'opened' | 'cancelled' | 'missing';

export class ContextService {
  private fileCache: { at: number; files: vscode.Uri[] } | null = null;
  /**
   * Directories derived from the file index (every parent of an indexed file).
   * Deriving them costs one pass over an already-cached list, so a folder
   * citation never has to walk the tree itself.
   */
  private directoryCache: { at: number; dirs: vscode.Uri[] } | null = null;

  /**
   * Capture the editor state for the single-gesture "send to terminal"
   * command: every non-empty selection (multi-cursor included) with exact
   * 1-based inclusive lines, or the whole buffer when nothing is selected.
   *
   * This mirrors the old selection capture: while the terminal webview holds
   * focus `activeTextEditor` is undefined, so a visible editor that still
   * carries a selection wins.
   */
  captureSendTarget(editor = vscode.window.activeTextEditor): EditorSendCapture | undefined {
    const candidates = this.editorCandidates(editor);
    const source = editor ?? candidates.find((candidate) => this.hasCapturableSelection(candidate)) ?? candidates[0];
    if (!source) {
      return undefined;
    }
    const document = source.document;
    const selections = source.selections.flatMap((selection) => {
      if (selection.isEmpty) {
        return [];
      }
      const text = document.getText(selection);
      return text.trim() ? [{ ...normalizeSelection(selection.anchor, selection.active), text }] : [];
    });
    const uri = document.uri;
    const inWorkspace = vscode.workspace.getWorkspaceFolder(uri);
    const includeFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const citationPath = inWorkspace
      ? vscode.workspace.asRelativePath(uri, includeFolder).replace(/\\/g, '/')
      : uri.fsPath;
    const dirty = document.isDirty || uri.scheme !== 'file';
    return {
      path: citationPath,
      localPath: document.uri.scheme === 'file' ? document.uri.fsPath : undefined,
      languageId: document.languageId,
      dirty,
      selections,
      fileText: selections.length === 0 && dirty ? document.getText() : undefined
    };
  }

  /** Active editor first, then visible editors: the webview steals focus. */
  private editorCandidates(editor?: vscode.TextEditor): vscode.TextEditor[] {
    return editor
      ? [editor, ...vscode.window.visibleTextEditors]
      : [...vscode.window.visibleTextEditors];
  }

  private hasCapturableSelection(candidate: vscode.TextEditor): boolean {
    return candidate.selections.some(
      (selection) =>
        !selection.isEmpty && Boolean(candidate.document.getText(selection).trim())
    );
  }

  /**
   * Workspace-relative display path, or `undefined` for anything outside every
   * root. Outside paths must never be dressed up as `../../x`.
   */
  private relativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(uri, true) || folder.name;
    return rel.replace(/\\/g, '/');
  }

  /** Path used in a context line plus whether it escapes the workspace. */
  private describeUri(uri: vscode.Uri): { path: string; inside: boolean } {
    const rel = this.relativePath(uri);
    if (rel !== undefined) {
      return { path: rel, inside: true };
    }
    return { path: uri.fsPath, inside: false };
  }

  async open(uriString: string, line?: number, column?: number): Promise<void> {
    const uri = vscode.Uri.parse(uriString);
    const document = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(position, position),
      preview: true
    });
  }

  /**
   * Open a path cited in terminal output. Relative paths are resolved
   * against the working directory first, then the workspace roots. Containment is
   * decided by `classifyOpenTarget` so a path outside the workspace is never
   * opened without an explicit confirmation.
   */
  async openPath(
    target: string,
    line?: number,
    column?: number,
    cwd?: string
  ): Promise<OpenPathResult> {
    const roots = this.workspaceRootPaths();
    const classification = classifyOpenTarget(target, cwd, roots);
    if (classification.kind !== 'invalid' && classification.path) {
      // A trailing separator names a folder explicitly, so a literal path that
      // resolves to an ordinary file must fall through instead of opening it.
      if (!isExplicitFolderCitation(target) || (await isDirectoryPath(classification.path))) {
        if (classification.kind === 'outside' && !(await this.confirmOpenOutside())) {
          return 'cancelled';
        }
        await this.openLocalPath(classification.path, classification.kind, line, column);
        return 'opened';
      }
    }

    // Literal resolution failed; try the full citation as a workspace suffix.
    // Files are tried first and folders second, so file navigation is
    // unchanged; an explicit folder is only ever searched as a folder.
    const citation = await this.resolveWorkspaceCitation(target);
    if (citation.uris.length === 1) {
      await this.openWorkspaceTarget(citation.uris[0], citation.folder, line, column);
      return 'opened';
    }
    if (citation.uris.length > 1) {
      return await this.openPickedWorkspaceCandidate(
        citation.uris,
        line,
        column,
        citation.folder
      );
    }

    // A prose label may be glued to the real file name (`STD/CAL Xcp_Std.c`).
    // Only an unresolved relative candidate reaches this branch; the helper
    // refuses absolute, URI, UNC, home, and traversal targets. An explicit
    // folder citation must never collapse into a file of the same name.
    const fallbackName = isExplicitFolderCitation(target)
      ? undefined
      : fileCitationFallbackName(target);
    if (fallbackName) {
      const exact = await this.exactWorkspaceBasePath(fallbackName, cwd, roots);
      if (exact) {
        await this.openLocalPath(exact, 'workspace', line, column);
        return 'opened';
      }
      const fallbackCandidates = await this.resolveWorkspaceCandidates(fallbackName);
      if (fallbackCandidates.length === 1) {
        await this.open(fallbackCandidates[0].toString(), line, column);
        return 'opened';
      }
      if (fallbackCandidates.length > 1) {
        return await this.openPickedWorkspaceCandidate(fallbackCandidates, line, column);
      }
    }

    return (await this.openRemotePath(target, line, column)) ? 'opened' : 'missing';
  }

  private async confirmOpenOutside(): Promise<boolean> {
    const confirmed = await vscode.window.showWarningMessage(
      'Open outside the workspace?',
      'Open'
    );
    return confirmed === 'Open';
  }

  /** Open a local path, revealing directories instead of loading text. */
  private async openLocalPath(
    target: string,
    kind: 'workspace' | 'outside',
    line?: number,
    column?: number
  ): Promise<void> {
    if (await isDirectoryPath(target)) {
      const uri = vscode.Uri.file(target);
      await vscode.commands.executeCommand(
        kind === 'outside' ? 'revealFileInOS' : 'revealInExplorer',
        uri
      );
      return;
    }
    await this.open(vscode.Uri.file(target).toString(), line, column);
  }

  private async openPickedWorkspaceCandidate(
    candidates: vscode.Uri[],
    line?: number,
    column?: number,
    folder = false
  ): Promise<OpenPathResult> {
    const picked = await this.pickWorkspaceCandidate(candidates, folder);
    if (!picked) {
      return 'cancelled';
    }
    await this.openWorkspaceTarget(picked, folder, line, column);
    return 'opened';
  }

  /** Reveal a resolved folder instead of loading it as text. */
  private async openWorkspaceTarget(
    uri: vscode.Uri,
    folder: boolean,
    line?: number,
    column?: number
  ): Promise<void> {
    if (folder) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    await this.open(uri.toString(), line, column);
  }

  private workspaceRootPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
  }

  /**
   * Resolve a citation that has no literal match. Files are tried first and
   * folders second, except for an explicit folder citation
   * (`Tests/integration/`), which is searched only as a folder so it can never
   * collapse into a file. Both kinds rank generated trees below source trees
   * and ask the user only when the remaining candidates are genuinely equal.
   */
  private async resolveWorkspaceCitation(
    target: string
  ): Promise<{ uris: vscode.Uri[]; folder: boolean }> {
    if (isExplicitFolderCitation(target)) {
      return {
        uris: await this.resolveWorkspaceFolderCandidates(target),
        folder: true
      };
    }
    const files = await this.resolveWorkspaceCandidates(target);
    if (files.length > 0) {
      return { uris: files, folder: false };
    }
    const folders = await this.resolveWorkspaceFolderCandidates(target);
    return { uris: folders, folder: folders.length > 0 };
  }

  /** Keep the best-ranked, shallowest candidates; a real tie stays a tie. */
  private narrowCandidates(
    entries: Array<{ uri: vscode.Uri; rank: number; depth: number }>
  ): vscode.Uri[] {
    if (entries.length === 0) {
      return [];
    }
    const best = Math.max(...entries.map((entry) => entry.rank));
    const top = entries.filter((entry) => entry.rank === best);
    const shallowest = Math.min(...top.map((entry) => entry.depth));
    return top.filter((entry) => entry.depth === shallowest).map((entry) => entry.uri);
  }

  /**
   * Check the exact basename at the cwd and each root before consulting the
   * workspace-wide basename index. `classifyOpenTarget` supplies the same
   * lexical + realpath containment used by literal targets, so a cwd outside
   * the workspace can never turn into an unconfirmed outside open.
   */
  private async exactWorkspaceBasePath(
    name: string,
    cwd: string | undefined,
    roots: readonly string[]
  ): Promise<string | undefined> {
    const bases: string[] = [];
    if (typeof cwd === 'string' && cwd.trim()) {
      bases.push(path.resolve(cwd));
    }
    for (const root of roots) {
      bases.push(path.resolve(root));
    }
    const seen = new Set<string>();
    for (const base of bases) {
      const key = process.platform === 'win32' ? base.toLowerCase() : base;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const absolute = path.resolve(base, name);
      const classification = classifyOpenTarget(absolute, undefined, roots);
      if (classification.kind === 'workspace' && classification.path) {
        return classification.path;
      }
    }
    return undefined;
  }

  /**
   * Resolve a citation whose literal path does not exist.
   *
   * Agents print bare file names (`Xcp.h`) or paths relative to a directory the
   * shell has since left, so the literal resolution fails even though the file
   * is in the workspace. Candidates are ranked rather than rejected outright:
   * generated/build trees (`node_modules`, `.tmp`, `dist`, …) are demoted and a
   * shallower path wins, because a citation almost always points at the source
   * file rather than at a copy inside a build artefact. Only genuinely equal
   * candidates are handed back for the user to choose between.
   */
  private async resolveWorkspaceCandidates(target: string): Promise<vscode.Uri[]> {
    const suffix = citationSuffix(target);
    if (!suffix) {
      return [];
    }

    const files = await this.workspaceFiles();
    const matches: Array<{ uri: vscode.Uri; rank: number; depth: number }> = [];
    for (const uri of files) {
      const rel = this.relativePath(uri);
      // A bare file name must not match through a directory boundary, so
      // `Xcp.h` matches `Xcp/Xcp.h` but never `Xcp.h.bak`.
      if (!rel || !matchesSuffix(rel.toLowerCase(), suffix)) {
        continue;
      }
      matches.push({ uri, rank: workspaceRank(rel), depth: pathDepth(rel) });
    }
    // Several equally plausible files: prefer the shallowest, then let the
    // caller ask instead of silently opening an arbitrary one.
    return this.narrowCandidates(matches);
  }

  /**
   * Resolve a citation that names a folder (`Tests/integration`,
   * `Tests/integration/`) but has no literal match under the cwd or a root.
   *
   * Folders are derived from the file index instead of walking the tree, so a
   * folder link costs one cached pass. Directories whose files were excluded
   * from the index (workspace excludes) and directories outside every root
   * therefore never become candidates. A bounded scan backs the two cases the
   * index cannot answer: an empty folder, and a citation whose only indexed
   * match is generated (the source may sit beyond the file-index cap).
   */
  private async resolveWorkspaceFolderCandidates(target: string): Promise<vscode.Uri[]> {
    const suffix = citationSuffix(target);
    if (!suffix) {
      return [];
    }
    const segments = suffix.split('/');
    // A lone bare word is a file name, not a folder hint; folder citations
    // always carry a separator (`Tests/integration`) or a trailing slash.
    if (segments.length < 2 && !isExplicitFolderCitation(target)) {
      return [];
    }

    const derived = await this.workspaceDirectories();
    let candidates = this.rankFolderCandidates(derived, suffix);
    const onlyGenerated = candidates.every((uri) => {
      const rel = this.relativePath(uri);
      return !rel || workspaceDirectoryRank(rel) === RANK_GENERATED;
    });
    // The scan is the expensive part, so it is reserved for citations that can
    // plausibly name a folder: a trailing separator, a separator plus a last
    // segment without a file extension. `nope/missing.ts` therefore stays a
    // plain miss instead of walking the tree.
    const folderShaped =
      isExplicitFolderCitation(target) ||
      !looksLikeFileName(segments[segments.length - 1]);
    if (folderShaped && (candidates.length === 0 || onlyGenerated)) {
      const scanned = await this.scanWorkspaceDirectories();
      if (scanned.length > 0) {
        const merged = this.dedupeDirectories([...derived, ...scanned]);
        const rescanned = this.rankFolderCandidates(merged, suffix);
        if (rescanned.length > 0) {
          candidates = rescanned;
        }
      }
    }
    return candidates;
  }

  private rankFolderCandidates(dirs: readonly vscode.Uri[], suffix: string): vscode.Uri[] {
    const matches: Array<{ uri: vscode.Uri; rank: number; depth: number }> = [];
    const roots = this.workspaceRootPaths();
    for (const uri of dirs) {
      const rel = this.relativePath(uri);
      if (!rel || !matchesSuffix(rel.toLowerCase(), suffix)) {
        continue;
      }
      // The index can contain stale entries or parents under a symlink.
      if (classifyOpenTarget(uri.fsPath, undefined, roots).kind !== 'workspace') {
        continue;
      }
      matches.push({ uri, rank: workspaceDirectoryRank(rel), depth: pathDepth(rel) });
    }
    return this.narrowCandidates(matches);
  }

  /** Every parent directory of an indexed file, excluding the roots themselves. */
  private async workspaceDirectories(): Promise<vscode.Uri[]> {
    if (this.directoryCache && Date.now() - this.directoryCache.at < 15_000) {
      return this.directoryCache.dirs;
    }
    const roots = this.workspaceRootPaths();
    const dirs: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const file of await this.workspaceFiles()) {
      if (file.scheme !== 'file') {
        continue;
      }
      let dir = path.dirname(file.fsPath);
      while (roots.some((root) => isInside(root, dir))) {
        // Roots are already literal candidates; a suffix search does not need
        // them, and their relative path is the folder name, not a directory.
        if (roots.some((root) => samePathKey(root, dir))) {
          break;
        }
        const key = pathKey(dir);
        if (seen.has(key)) {
          // All ancestors of a seen directory were collected with it.
          break;
        }
        seen.add(key);
        const uri = vscode.Uri.file(dir);
        if (this.relativePath(uri)) {
          dirs.push(uri);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
    }
    this.directoryCache = { at: Date.now(), dirs };
    return dirs;
  }

  /**
   * Bounded directory walk used only when the derived index has no answer.
   * Bounded by count and depth so an unresolved link stays cheap.
   */
  private async scanWorkspaceDirectories(): Promise<vscode.Uri[]> {
    const dirs: vscode.Uri[] = [];
    let budget = MAX_DIRECTORY_SCAN;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (budget <= 0 || depth >= MAX_DIRECTORY_SCAN_DEPTH) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (budget <= 0) {
          return;
        }
        if (!entry.isDirectory() || DIRECTORY_SCAN_IGNORED.has(entry.name)) {
          continue;
        }
        budget -= 1;
        const child = path.join(dir, entry.name);
        dirs.push(vscode.Uri.file(child));
        await walk(child, depth + 1);
      }
    };
    for (const root of this.workspaceRootPaths()) {
      if (budget <= 0) {
        break;
      }
      await walk(root, 0);
    }
    return dirs;
  }

  private dedupeDirectories(dirs: readonly vscode.Uri[]): vscode.Uri[] {
    const seen = new Set<string>();
    const result: vscode.Uri[] = [];
    for (const uri of dirs) {
      const key = pathKey(uri.fsPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(uri);
    }
    return result;
  }

  /** Ask which of several equally plausible workspace candidates to open. */
  private async pickWorkspaceCandidate(
    candidates: vscode.Uri[],
    folder = false
  ): Promise<vscode.Uri | undefined> {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    const suffix = folder ? (zh ? '（文件夹）' : ' (folder)') : '';
    const items = candidates.map((uri) => ({
      label: `${this.relativePath(uri) ?? uri.fsPath}${suffix}`,
      uri
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: folder
        ? (zh ? '打开哪一个文件夹？' : 'Which folder did you mean?')
        : (zh ? '打开哪一个文件？' : 'Which file did you mean?'),
      placeHolder: folder
        ? (zh ? '多个文件夹与引用匹配' : 'Several workspace folders match this reference')
        : (zh ? '多个文件与引用匹配' : 'Several workspace files match this reference')
    });
    return picked?.uri;
  }

  /**
   * Remote workspaces keep a non-`file` URI scheme, which the fs-path policy
   * cannot classify. Join segments onto those roots as a fallback only.
   */
  private async openRemotePath(
    target: string,
    line?: number,
    column?: number
  ): Promise<boolean> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme !== 'file'
    );
    if (folders.length === 0) {
      return false;
    }
    const cleaned = target.trim().replace(/^[`"'<]+|[`"'>]+$/g, '');
    if (!cleaned || path.isAbsolute(cleaned) || /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
      return false;
    }
    // `joinPath` would happily normalise a `..` escape back out of the root.
    if (hasParentTraversal(cleaned)) {
      return false;
    }
    const segments = cleaned.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
    if (segments.length === 0) {
      return false;
    }
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, ...segments);
      if (!isWithinUriPath(folder.uri.path, uri.path)) {
        continue;
      }
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return true;
      }
      if ((stat.type & vscode.FileType.File) !== 0) {
        if (isExplicitFolderCitation(target)) {
          continue;
        }
        await this.open(uri.toString(), line, column);
        return true;
      }
    }
    return false;
  }

  private async workspaceFiles(): Promise<vscode.Uri[]> {
    if (this.fileCache && Date.now() - this.fileCache.at < 15_000) {
      return this.fileCache.files;
    }
    let files: vscode.Uri[] = [];
    if (vscode.workspace.workspaceFolders?.length) {
      files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,out,media/webview}/**',
        MAX_FILES
      );
    }
    this.fileCache = { at: Date.now(), files };
    return files;
  }

  invalidate(): void {
    this.fileCache = null;
    this.directoryCache = null;
  }
}

/**
 * Normalize a citation into the workspace-relative suffix it should match.
 *
 * Returns `undefined` for empty input, URLs, absolute drive paths, and any
 * parent traversal: none of those are workspace-relative hints, and a `..`
 * segment could otherwise be matched against a relative path by accident.
 */
function citationSuffix(target: string): string | undefined {
  const cleaned = target.trim().replace(/^[`"'<]+/, '').replace(/[`"'>]+$/, '');
  if (!cleaned) {
    return undefined;
  }
  // A leftover scheme or an absolute drive path is not a workspace hint.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    return undefined;
  }
  const segments = cleaned.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    return undefined;
  }
  return segments.join('/').toLowerCase();
}

/**
 * True when the citation unambiguously names a folder, i.e. it ends in a path
 * separator (`Tests/integration/`). Such a target must never be collapsed into
 * a file of the same name by the prose-label fallback.
 */
function isExplicitFolderCitation(target: string): boolean {
  const cleaned = target.trim().replace(/^[`"'<]+/, '').replace(/[`"'>]+$/, '').trim();
  return /[\\/]$/.test(cleaned);
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePathKey(left: string, right: string): boolean {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right));
}

async function isDirectoryPath(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
