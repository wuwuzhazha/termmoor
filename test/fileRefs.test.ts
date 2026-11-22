import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findFileRefs, parseFileRef } from '../webview/fileRefs';

test('Chinese file names parse and scan', () => {
  const ref = parseFileRef('src/模块/网络服务.ts');
  assert.equal(ref?.path, 'src/模块/网络服务.ts');
  assert.equal(ref?.line, undefined);

  const refs = findFileRefs('详见 src/模块/网络服务.ts 的实现');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['src/模块/网络服务.ts']
  );
});

test('Chinese path with a line range keeps the range', () => {
  const ref = parseFileRef('src/模块/网络服务.ts:38-45');
  assert.equal(ref?.path, 'src/模块/网络服务.ts');
  assert.equal(ref?.line, 38);
  assert.equal(ref?.endLine, 45);

  const refs = findFileRefs('错误位于 src/模块/网络服务.ts:38-45 中');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref.line, 38);
  assert.equal(refs[0].ref.endLine, 45);
  assert.equal(refs[0].end - refs[0].start, 'src/模块/网络服务.ts:38-45'.length);
});

test('paths with spaces stay clickable', () => {
  const drive = parseFileRef('C:\\Program Files\\My App\\src\\main.ts:12');
  assert.equal(drive?.path, 'C:\\Program Files\\My App\\src\\main.ts');
  assert.equal(drive?.line, 12);

  const relative = findFileRefs('see src/My Folder/说明 文档.md:3 now');
  assert.deepEqual(
    relative.map((match) => match.ref.path),
    ['src/My Folder/说明 文档.md']
  );
  assert.equal(relative[0].ref.line, 3);
});

test('prose words are not glued onto a path', () => {
  const refs = findFileRefs('open src/a.ts and b.ts now');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['src/a.ts', 'b.ts']
  );

  const chinese = findFileRefs('详见 src/模块/网络服务.ts 的实现');
  assert.equal(chinese.length, 1);
  assert.equal(chinese[0].ref.path, 'src/模块/网络服务.ts');
});

test('UNC paths parse with Chinese folders', () => {
  const ref = parseFileRef('\\\\server\\share\\项目\\main.ts:12');
  assert.equal(ref?.path, '\\\\server\\share\\项目\\main.ts');
  assert.equal(ref?.line, 12);

  const refs = findFileRefs('copy \\\\server\\My Share\\项目\\main.ts over');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['\\\\server\\My Share\\项目\\main.ts']
  );
});

test('URLs never become file references', () => {
  assert.equal(parseFileRef('https://example.com/src/a.ts'), null);
  assert.equal(parseFileRef('mailto:dev@example.com'), null);
  assert.deepEqual(findFileRefs('see https://example.com/src/a.ts and http://x/b.md'), []);
  assert.deepEqual(findFileRefs('visit https://example.com/项目/说明.md'), []);
  assert.deepEqual(findFileRefs('visit https://example.com/a.ts/b.ts'), []);
});

test('README and dotfiles still match', () => {
  assert.equal(parseFileRef('README')?.path, 'README');
  assert.equal(parseFileRef('.env')?.path, '.env');
  const refs = findFileRefs('see README and .env for setup');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['README', '.env']
  );
});

test('line, range, and hash suffixes do not regress', () => {
  const line = parseFileRef('src/net/socket.ts:38');
  assert.equal(line?.line, 38);

  const range = parseFileRef('src/net/socket.ts:38-45');
  assert.equal(range?.line, 38);
  assert.equal(range?.endLine, 45);

  const column = parseFileRef('src/net/socket.ts:38:5');
  assert.equal(column?.line, 38);
  assert.equal(column?.column, 5);

  const hash = parseFileRef('src/net/socket.ts#L38-L45');
  assert.equal(hash?.line, 38);
  assert.equal(hash?.endLine, 45);

  const scanned = findFileRefs('Open src/net/socket.ts:38-45 then run --config.ts');
  assert.deepEqual(
    scanned.map((match) => match.ref.path),
    ['src/net/socket.ts']
  );
});

test('explicit folder paths link while bare words stay plain', () => {
  const samples: Array<[string, string]> = [
    ['Open Xcp/ now', 'Xcp/'],
    ['Open Xcp\\ now', 'Xcp\\'],
    ['see Xcp/docs for details', 'Xcp/docs'],
    ['see Xcp\\docs now', 'Xcp\\docs'],
    ['see 项目/文档 now', '项目/文档'],
    ['cd ./docs', './docs'],
    ['see E:/Xcp now', 'E:/Xcp'],
    ['see E:\\Xcp\\Tests now', 'E:\\Xcp\\Tests'],
    ['copy \\\\server\\share\\docs now', '\\\\server\\share\\docs'],
    ['list /usr/local/share now', '/usr/local/share'],
    ['open Xcp/My Docs/ now', 'Xcp/My Docs/'],
    ['open E:/Program Files/Xcp now', 'E:/Program Files/Xcp']
  ];
  for (const [line, expected] of samples) {
    assert.deepEqual(
      findFileRefs(line).map((match) => match.ref.path),
      [expected],
      line
    );
  }

  assert.deepEqual(findFileRefs('see Xcp now and Xcp.h too').map((match) => match.ref.path), [
    'Xcp.h'
  ]);
});

test('folder links stop at narration and punctuation', () => {
  const punct = findFileRefs('see Xcp/docs. now');
  assert.deepEqual(
    punct.map((match) => match.ref.path),
    ['Xcp/docs']
  );
  assert.equal(punct[0].end - punct[0].start, 'Xcp/docs'.length);

  const narrated = findFileRefs('see Xcp/ and E:/Xcp and ./docs and \\\\server\\share\\docs');
  assert.deepEqual(
    narrated.map((match) => match.ref.path),
    ['Xcp/', 'E:/Xcp', './docs', '\\\\server\\share\\docs']
  );

  assert.deepEqual(findFileRefs('visit https://example.com/docs/ now'), []);
  assert.deepEqual(findFileRefs('run --out=dist/ now'), []);
  assert.deepEqual(
    findFileRefs('either and/or or Xcp/docs').map((match) => match.ref.path),
    ['Xcp/docs']
  );
});

test('a file link wins over an overlapping folder candidate', () => {
  const refs = findFileRefs('see Xcp/docs/readme.md:12 now');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['Xcp/docs/readme.md']
  );
  assert.equal(refs[0].ref.line, 12);
});

test('slash-list members keep their line:column suffix after CJK prose', () => {
  const line = '里的隐藏静态缓冲：XcpOnEth.c/XcpOnFr.c:42:8';
  const refs = findFileRefs(line);
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['XcpOnEth.c', 'XcpOnFr.c']
  );

  const first = 'XcpOnEth.c';
  const second = 'XcpOnFr.c:42:8';
  assert.deepEqual(
    refs.map((match) => line.slice(match.start, match.end)),
    [first, second]
  );
  assert.equal(refs[0].start, line.indexOf(first));
  assert.equal(refs[0].end, line.indexOf(first) + first.length);
  assert.equal(refs[1].start, line.indexOf(second));
  assert.equal(refs[1].end, line.indexOf(second) + second.length);
  assert.equal(refs[1].ref.line, 42);
  assert.equal(refs[1].ref.column, 8);

  const punctuation = findFileRefs('XcpOnEth.c/XcpOnFr.c.');
  assert.deepEqual(
    punctuation.map((match) => 'XcpOnEth.c/XcpOnFr.c.'.slice(match.start, match.end)),
    ['XcpOnEth.c', 'XcpOnFr.c']
  );
});

test('wrapped slash lists keep every member separable and undecorated', () => {
  const samples: Array<[string, string[]]> = [
    ['(XcpOnEth.c/XcpOnFr.c)', ['XcpOnEth.c', 'XcpOnFr.c']],
    ['see (XcpOnEth.c/XcpOnFr.c:42:8) now', ['XcpOnEth.c', 'XcpOnFr.c:42:8']],
    ['see (XcpOnEth.c/XcpOnFr.c(42,8)) now', ['XcpOnEth.c', 'XcpOnFr.c(42,8)']],
    ['see XcpOnEth.c/XcpOnFr.c) now', ['XcpOnEth.c', 'XcpOnFr.c']],
    ['see (XcpOnEth.c/XcpOnFr.c now', ['XcpOnEth.c', 'XcpOnFr.c']],
    ['see (XcpOnEth.c/XcpOnFr.c)。 now', ['XcpOnEth.c', 'XcpOnFr.c']]
  ];
  for (const [line, expectedTokens] of samples) {
    const refs = findFileRefs(line);
    assert.deepEqual(
      refs.map((match) => line.slice(match.start, match.end)),
      expectedTokens,
      line
    );
    // No wrapper character leaks into a path: the host can only resolve these.
    for (const match of refs) {
      assert.doesNotMatch(match.ref.path, /[()]/, `${line} -> ${match.ref.path}`);
    }
  }

  const suffixed = findFileRefs('see (XcpOnEth.c/XcpOnFr.c:42:8) now');
  assert.equal(suffixed[1].ref.line, 42);
  assert.equal(suffixed[1].ref.column, 8);
});

test('a real file name with its own parentheses is not stripped as a wrapper', () => {
  const refs = findFileRefs('see (draft).c/XcpOnFr.c and XcpOnEth.c/helper(2).c now');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['(draft).c', 'XcpOnFr.c', 'XcpOnEth.c', 'helper(2).c']
  );
});

test('the reported STD/CAL ambiguity stays one full candidate', () => {
  const line = 'STD/CAL Xcp_Std.c';
  const refs = findFileRefs(line);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].ref, {
    path: 'STD/CAL Xcp_Std.c',
    line: undefined,
    column: undefined,
    endLine: undefined
  });
  assert.equal(refs[0].start, 0);
  assert.equal(refs[0].end, line.length);
  assert.equal(line.slice(refs[0].start, refs[0].end), 'STD/CAL Xcp_Std.c');
});

test('engineering project files are recognized', () => {
  for (const path of [
    'build/App.sln',
    'src/App.vcxproj',
    'src/App.csproj',
    'firmware/App.uvprojx',
    'firmware/App.ewp',
    'calibration/Xcp.a2l'
  ]) {
    assert.equal(parseFileRef(path)?.path, path, path);
  }

  const refs = findFileRefs('open App.sln and App.vcxproj now');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['App.sln', 'App.vcxproj']
  );
});

test('engineering project files still split out of slash lists', () => {
  const refs = findFileRefs('App.sln/App.vcxproj:12:3');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['App.sln', 'App.vcxproj']
  );
  assert.equal(refs[1].ref.line, 12);
  assert.equal(refs[1].ref.column, 3);
});

test('numeric ratios and dates are not directory links', () => {
  for (const line of [
    'ratio 16/9 here',
    'date 2024/01/15 now',
    'scale 1.5/2.5 and 50/50',
    'time 12/31/2026 in the log'
  ]) {
    assert.deepEqual(findFileRefs(line), [], line);
  }

  // A real file keeps its numeric parent directories clickable as one file.
  const report = findFileRefs('see 2024/01/15/report.md now');
  assert.deepEqual(
    report.map((match) => match.ref.path),
    ['2024/01/15/report.md']
  );

  // Named directories keep working.
  assert.deepEqual(
    findFileRefs('see Xcp/docs now').map((match) => match.ref.path),
    ['Xcp/docs']
  );
});

test('quoted spaced directories keep their leading segment', () => {
  const samples: Array<[string, string]> = [
    ['cd "My Docs/Sub Folder" now', 'My Docs/Sub Folder'],
    ['cd "My Docs/Sub Folder/" now', 'My Docs/Sub Folder/'],
    ['see "C:/Program Files/My App" now', 'C:/Program Files/My App'],
    ['copy "\\\\server\\My Share\\项目" now', '\\\\server\\My Share\\项目'],
    ['see "项目 文档/说明" now', '项目 文档/说明']
  ];
  for (const [line, expected] of samples) {
    assert.deepEqual(
      findFileRefs(line).map((match) => match.ref.path),
      [expected],
      line
    );
  }
});

test('quoted spaced files keep their leading segment and suffix', () => {
  const refs = findFileRefs('see "My Docs/说明 文档.md:12:3" now');
  assert.deepEqual(
    refs.map((match) => match.ref.path),
    ['My Docs/说明 文档.md']
  );
  assert.equal(refs[0].ref.line, 12);
  assert.equal(refs[0].ref.column, 3);
  assert.equal(refs[0].end - refs[0].start, 'My Docs/说明 文档.md:12:3'.length);

  const drive = findFileRefs('open "C:/Program Files/My App/main.c(42,8)" now');
  assert.deepEqual(
    drive.map((match) => match.ref.path),
    ['C:/Program Files/My App/main.c']
  );
  assert.equal(drive[0].ref.line, 42);
  assert.equal(drive[0].ref.column, 8);
});

test('quotes do not disable the unquoted narration policy', () => {
  // Unquoted text still stops at a connective word.
  assert.deepEqual(
    findFileRefs('see Xcp/My Docs and more now').map((match) => match.ref.path),
    ['Xcp/My Docs']
  );
  // Quotes make the whole path explicit, including a directory named `and`.
  assert.deepEqual(
    findFileRefs('see "Xcp/My Docs and more" now').map((match) => match.ref.path),
    ['Xcp/My Docs and more']
  );
});

test('quoted URLs and prose are still not paths', () => {
  assert.deepEqual(findFileRefs('visit "https://example.com/docs" now'), []);
  assert.deepEqual(findFileRefs('say "hello world" now'), []);
  assert.deepEqual(findFileRefs('see "README" and "Makefile" now').map((match) => match.ref.path), [
    'README',
    'Makefile'
  ]);
});
