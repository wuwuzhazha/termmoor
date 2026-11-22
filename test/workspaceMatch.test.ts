import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  matchesSuffix,
  pathDepth,
  RANK_GENERATED,
  RANK_SOURCE,
  workspaceRank
} from '../src/shared/workspaceMatch';

test('a bare file name matches on a path-segment boundary only', () => {
  assert.equal(matchesSuffix('Xcp/Xcp.h', 'Xcp.h'), true);
  assert.equal(matchesSuffix('Xcp.h', 'Xcp.h'), true);
  assert.equal(matchesSuffix('MyXcp.h', 'Xcp.h'), false);
  assert.equal(matchesSuffix('Xcp.h.bak', 'Xcp.h'), false);
  assert.equal(matchesSuffix('a/Xcp.h', 'xcp.h'), true, 'comparison is case-insensitive');
});

test('multi-segment suffixes must match completely', () => {
  assert.equal(matchesSuffix('src/net/socket.ts', 'net/socket.ts'), true);
  assert.equal(matchesSuffix('src/net/socket.ts', 'socket.ts'), true);
  assert.equal(matchesSuffix('src/net/socket.ts', 'src/socket.ts'), false);
});

test('generated trees are demoted below source trees', () => {
  assert.equal(workspaceRank('Xcp/Xcp.h'), RANK_SOURCE);
  assert.equal(workspaceRank('.tmp/release-check/Xcp/Xcp.h'), RANK_GENERATED);
  assert.equal(workspaceRank('node_modules/pkg/x.h'), RANK_GENERATED);
  assert.equal(workspaceRank('dist/x.h'), RANK_GENERATED);
});

test('a generated directory name in the file name itself does not demote', () => {
  // The final segment is the file, so `build/x.h` is generated but `x/build.h`
  // is not.
  assert.equal(workspaceRank('src/build.h'), RANK_SOURCE);
  assert.equal(workspaceRank('build/x.h'), RANK_GENERATED);
});

test('backslashes and casing are normalized', () => {
  assert.equal(workspaceRank('Xcp\\Xcp.h'), RANK_SOURCE);
  assert.equal(matchesSuffix('Xcp\\Xcp.h', 'Xcp.h'), true);
});

test('pathDepth counts real segments', () => {
  assert.equal(pathDepth('Xcp.h'), 1);
  assert.equal(pathDepth('Xcp/Xcp.h'), 2);
  assert.equal(pathDepth('a//b/x.h'), 3);
});
