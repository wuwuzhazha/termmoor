/**
 * Minimal `vscode` seam for tests that need the real ContextService.
 *
 * The extension host module is not available to `node --test`, so the test
 * patches `Module._load` and installs this object before dynamically importing
 * `src/context`. Only the surface ContextService.openPath touches is modelled;
 * the filesystem itself stays real (temp files created by the test).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nodeModule = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

export interface OpenedDocument {
  path: string;
  line: number;
  column: number;
}

export interface RevealCall {
  command: string;
  path: string;
}

export interface VscodeMockState {
  roots: string[];
  opened: OpenedDocument[];
  revealed: RevealCall[];
  warnings: string[];
  quickPicks: string[];
  warningAnswer: string | undefined;
  quickPickAnswer: 'cancel' | 'first' | number;
}

export interface VscodeMock {
  state: VscodeMockState;
  vscode: Record<string, unknown>;
}

class MockPosition {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class MockRange {
  constructor(
    public readonly start: MockPosition,
    public readonly end: MockPosition
  ) {}
}

class MockUri {
  constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly fsPath: string
  ) {}

  static file(fsPath: string): MockUri {
    const absolute = path.resolve(fsPath);
    return new MockUri('file', absolute.replace(/\\/g, '/'), absolute);
  }

  static parse(value: string): MockUri {
    if (value.startsWith('file:')) {
      return MockUri.file(fileURLToPath(value));
    }
    return new MockUri('file', value, value);
  }

  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return MockUri.file(path.join(base.fsPath, ...segments));
  }

  toString(): string {
    return pathToFileURL(this.fsPath).toString();
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative) {
    return true;
  }
  if (path.isAbsolute(relative)) {
    return false;
  }
  return relative.split(/[\\/]+/)[0] !== '..';
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  walk(root);
  return files;
}

export function createVscodeMock(roots: string[]): VscodeMock {
  const state: VscodeMockState = {
    roots: [...roots],
    opened: [],
    revealed: [],
    warnings: [],
    quickPicks: [],
    warningAnswer: undefined,
    quickPickAnswer: 'first'
  };

  const folderFor = (candidate: string) =>
    state.roots.find((root) => isInside(root, candidate));

  const workspace = {
    get workspaceFolders() {
      return state.roots.map((root, index) => ({
        uri: MockUri.file(root),
        name: path.basename(root),
        index
      }));
    },
    getWorkspaceFolder(uri: MockUri) {
      const root = folderFor(uri.fsPath);
      if (!root) {
        return undefined;
      }
      return {
        uri: MockUri.file(root),
        name: path.basename(root),
        index: state.roots.indexOf(root)
      };
    },
    asRelativePath(uri: MockUri, includeWorkspaceFolder?: boolean) {
      const root = folderFor(uri.fsPath);
      if (!root) {
        return uri.fsPath;
      }
      const relative = path.relative(root, uri.fsPath).replace(/\\/g, '/');
      if (includeWorkspaceFolder && state.roots.length > 1) {
        return `${path.basename(root)}/${relative}`;
      }
      return relative;
    },
    async openTextDocument(uri: MockUri) {
      if (!fs.existsSync(uri.fsPath)) {
        throw new Error(`ENOENT: ${uri.fsPath}`);
      }
      const text = fs.readFileSync(uri.fsPath, 'utf8');
      return {
        uri,
        isDirty: false,
        languageId: 'plaintext',
        lineCount: text.split(/\r?\n/).length,
        getText(range?: MockRange) {
          if (!range) {
            return text;
          }
          return text
            .split(/\r?\n/)
            .slice(range.start.line, range.end.line + 1)
            .join('\n');
        }
      };
    },
    async findFiles() {
      return state.roots.flatMap((root) => walkFiles(root).map((file) => MockUri.file(file)));
    },
    fs: {
      async stat(uri: MockUri) {
        const stat = await fs.promises.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? 2 : 1,
          size: stat.size,
          ctime: stat.ctimeMs,
          mtime: stat.mtimeMs
        };
      },
      async readFile(uri: MockUri) {
        return await fs.promises.readFile(uri.fsPath);
      },
      async readDirectory(uri: MockUri) {
        const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1] as [string, number]);
      }
    }
  };

  const window = {
    activeTextEditor: undefined,
    visibleTextEditors: [] as unknown[],
    tabGroups: { all: [] as unknown[] },
    async showTextDocument(document: { uri: MockUri }, options?: { selection?: MockRange }) {
      state.opened.push({
        path: document.uri.fsPath,
        line: (options?.selection?.start.line ?? 0) + 1,
        column: (options?.selection?.start.character ?? 0) + 1
      });
      return { document };
    },
    async showWarningMessage(message: string) {
      state.warnings.push(message);
      return state.warningAnswer;
    },
    async showQuickPick(items: unknown, options?: { title?: string }) {
      const resolved = (await Promise.resolve(items)) as Array<{ label?: string }>;
      state.quickPicks.push(options?.title ?? '');
      const answer = state.quickPickAnswer;
      if (answer === 'cancel') {
        return undefined;
      }
      if (answer === 'first') {
        return resolved[0];
      }
      return resolved[answer];
    },
    async showInformationMessage() {
      return undefined;
    },
    createQuickPick() {
      throw new Error('createQuickPick is not modelled by the test seam');
    }
  };

  const commands = {
    async executeCommand(command: string, ...args: unknown[]) {
      const target = args[0];
      if (
        (command === 'revealInExplorer' || command === 'revealFileInOS') &&
        target instanceof MockUri
      ) {
        state.revealed.push({ command, path: target.fsPath });
      }
      return undefined;
    }
  };

  const symbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25
  };

  const vscode: Record<string, unknown> = {
    Uri: MockUri,
    Position: MockPosition,
    Range: MockRange,
    SymbolKind: symbolKind,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    workspace,
    window,
    commands,
    env: {
      language: 'en',
      clipboard: { readText: async () => '', writeText: async () => undefined }
    },
    l10n: { t: (value: string) => value },
    languages: { getDiagnostics: () => [] },
    TabInputText: class TabInputText {
      constructor(public readonly uri: MockUri) {}
    }
  };

  return { state, vscode };
}

/** Install a `vscode` module for subsequently evaluated (dynamic) imports. */
export function installVscodeMock(mock: VscodeMock): () => void {
  const original = nodeModule._load;
  nodeModule._load = function patchedLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ) {
    if (request === 'vscode') {
      return mock.vscode;
    }
    return original.call(this, request, parent, isMain);
  };
  return () => {
    nodeModule._load = original;
  };
}
