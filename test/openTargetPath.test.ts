import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { classifyOpenTarget } from '../src/security/pathPolicy';
import {
  fileCitationFallbackName,
  hasParentTraversal,
  isWithinUriPath
} from '../src/shared/openTargetPath';

test('a prose label glued to a file name yields the last file citation', () => {
  // Regression: the screenshot citation `STD/CAL Xcp_Std.c` failed to open even
  // though the workspace contains `Xcp/Xcp_Std.c`.
  assert.equal(fileCitationFallbackName('STD/CAL Xcp_Std.c'), 'Xcp_Std.c');
  assert.equal(fileCitationFallbackName('see src/a.ts and b.ts'), 'b.ts');
});

test('a real path with spaces resolves literally before any basename fallback', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-open-target-'));
  const root = path.join(parent, 'workspace');
  const spacedDir = path.join(root, 'My Dir');
  const spacedFile = path.join(spacedDir, 'Xcp_Std.c');
  fs.mkdirSync(spacedDir, { recursive: true });
  fs.writeFileSync(spacedFile, 'int main(void);\n');
  try {
    const literal = classifyOpenTarget('My Dir/Xcp_Std.c', root, [root]);
    assert.equal(literal.kind, 'workspace');
    assert.equal(literal.path, path.resolve(spacedFile));

    // A real path's last whitespace token still contains a separator, so the
    // fallback helper refuses it; the literal resolution above stays the only
    // way this path can open.
    assert.equal(fileCitationFallbackName('My Dir/Xcp_Std.c'), undefined);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('directories classify for relative, absolute, and file-URI targets', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-open-dir-'));
  const root = path.join(parent, 'workspace');
  const emptyDir = path.join(root, 'empty folder');
  const outsideDir = path.join(parent, 'outside');
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  try {
    const relative = classifyOpenTarget('empty folder', root, [root]);
    assert.equal(relative.kind, 'workspace');
    assert.equal(relative.path, path.resolve(emptyDir));

    const absolute = classifyOpenTarget(emptyDir, root, [root]);
    assert.equal(absolute.kind, 'workspace');
    assert.equal(absolute.path, path.resolve(emptyDir));

    const fromUri = classifyOpenTarget(pathToFileURL(emptyDir).toString(), root, [root]);
    assert.equal(fromUri.kind, 'workspace');
    assert.equal(fromUri.path, path.resolve(emptyDir));

    assert.equal(classifyOpenTarget(outsideDir, root, [root]).kind, 'outside');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('the basename fallback never degrades absolute, URI, UNC, or traversal targets', () => {
  assert.equal(fileCitationFallbackName(String.raw`E:\Xcp\Xcp_Std.c`), undefined);
  assert.equal(fileCitationFallbackName('E:/Xcp/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName('file:///E:/Xcp/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName('https://example.com/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName(String.raw`\\server\share\Xcp_Std.c`), undefined);
  assert.equal(fileCitationFallbackName('/home/dev/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName('~/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName('../outside/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName(String.raw`STD\..\Xcp_Std.c`), undefined);
  // No whitespace: normal workspace suffix resolution already had its chance.
  assert.equal(fileCitationFallbackName('Xcp/Xcp_Std.c'), undefined);
  // The last token must itself be a file name, not another path.
  assert.equal(fileCitationFallbackName('label src/Xcp_Std.c'), undefined);
  assert.equal(fileCitationFallbackName('label --config.ts'), undefined);
});

test('parent traversal is detected on both separators', () => {
  assert.equal(hasParentTraversal('../secret/Xcp.c'), true);
  assert.equal(hasParentTraversal(String.raw`..\secret\Xcp.c`), true);
  assert.equal(hasParentTraversal('src/../Xcp.c'), true);
  assert.equal(hasParentTraversal('src/Xcp.c'), false);
  assert.equal(hasParentTraversal('..hidden/Xcp.c'), false);
});

test('remote URI containment rejects sibling and escaped roots', () => {
  assert.equal(isWithinUriPath('/workspace', '/workspace/Xcp/Xcp.c'), true);
  assert.equal(isWithinUriPath('/workspace/', '/workspace/Xcp/Xcp.c'), true);
  assert.equal(isWithinUriPath('/workspace', '/workspace'), true);
  assert.equal(isWithinUriPath('/workspace', '/workspace-other/Xcp.c'), false);
  assert.equal(isWithinUriPath('/workspace', '/other/Xcp.c'), false);
  assert.equal(isWithinUriPath('/workspace', '/workspace/../other/Xcp.c'), false);
});
