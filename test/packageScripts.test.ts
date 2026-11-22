import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  PACKAGE_NAME,
  PUBLISHER,
  REPOSITORY_URL,
  REQUIRED_FILES,
  REQUIRED_SETTINGS,
  SUPPORTED_TARGETS,
  parseCliArgs,
  readZipEntries,
  verifyEntries
} from '../scripts/verify-vsix.mjs';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const properties = Object.fromEntries(
    REQUIRED_SETTINGS.map((setting) => [setting, { type: 'string' }])
  );
  return {
    name: 'termmoor',
    version: '1.2.3',
    publisher: 'wuwuzhazha',
    repository: { type: 'git', url: 'https://github.com/wuwuzhazha/termmoor.git' },
    engines: { vscode: '^1.106.0' },
    main: './dist/extension.js',
    icon: 'media/icon.png',
    files: ['dist/**'],
    contributes: {
      viewsContainers: { secondarySidebar: [{ icon: 'media/terminal.svg' }] },
      configuration: { properties }
    },
    ...overrides
  };
}

function entriesWith(overrides: Record<string, string | null> = {}): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const required of REQUIRED_FILES) {
    if (required === 'extension/media/icon.png') {
      entries.set(required, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    } else if (required === 'extension/media/terminal.svg') {
      entries.set(required, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    } else {
      entries.set(required, Buffer.from('runtime'));
    }
  }
  entries.set('extension/package.json', Buffer.from(JSON.stringify(manifest())));
  entries.set(
    'extension/dist/pty/node-pty/prebuilds/win32-x64/conpty.node',
    Buffer.from('native')
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      entries.delete(name);
    } else {
      entries.set(name, Buffer.from(value));
    }
  }
  return entries;
}

test('the zip reader returns stored entries and nested paths', () => {
  const archive = makeStoredZip({
    'extension/package.json': '{"name":"a"}',
    'extension/dist/nested/file.js': 'console.log(1);'
  });
  const entries = readZipEntries(archive);
  assert.equal(entries.get('extension/package.json')?.toString(), '{"name":"a"}');
  assert.equal(entries.get('extension/dist/nested/file.js')?.toString(), 'console.log(1);');
});

test('a clean allowlisted VSIX passes verification', () => {
  const result = verifyEntries(entriesWith(), {
    target: 'win32-x64',
    expectedName: PACKAGE_NAME,
    expectedVersion: '1.2.3',
    expectedPublisher: PUBLISHER,
    expectedRepositoryUrl: REPOSITORY_URL
  });
  assert.ok(result.paths.includes('extension/dist/extension.js'));
  assert.equal(
    result.paths.filter((entry) =>
      entry.startsWith('extension/dist/pty/node-pty/prebuilds/')
    ).length,
    1,
    'the verified VSIX includes its target-specific PTY runtime'
  );
  assert.equal(result.manifest?.name, PACKAGE_NAME);
  assert.equal(result.manifest?.publisher, PUBLISHER);
});

test('only the win32-x64 target is accepted', () => {
  assert.deepEqual(SUPPORTED_TARGETS, ['win32-x64']);
  assert.throws(
    () => verifyEntries(entriesWith(), { target: 'linux-x64' }),
    /unsupported target linux-x64/
  );
  assert.throws(
    () => verifyEntries(entriesWith(), { target: 'win32-arm64' }),
    /unsupported target win32-arm64/
  );
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({
          'extension/dist/pty/node-pty/prebuilds/linux-x64/pty.node': 'native'
        }),
        { target: 'win32-x64' }
      ),
    /packaged PTY prebuild for unsupported platform: linux-x64/
  );
});

test('the public package identity is enforced', () => {
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({
          'extension/package.json': JSON.stringify(manifest({ name: 'agent-terminal' }))
        })
      ),
    /development package name/
  );
  assert.throws(
    () =>
      verifyEntries(entriesWith(), {
        expectedPublisher: 'local',
        expectedRepositoryUrl: REPOSITORY_URL
      }),
    /manifest publisher is "wuwuzhazha", expected "local"/
  );
  assert.throws(
    () =>
      verifyEntries(entriesWith(), {
        expectedRepositoryUrl: 'https://github.com/someone/else.git'
      }),
    /manifest repository is/
  );
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({
          'extension/package.json': JSON.stringify(manifest({ publisher: undefined }))
        })
      ),
    /manifest is missing publisher/
  );
  // A trailing `.git` or slash is not a different repository.
  assert.doesNotThrow(() =>
    verifyEntries(entriesWith(), {
      expectedRepositoryUrl: 'https://github.com/wuwuzhazha/termmoor'
    })
  );
});

test('development paths and source maps are rejected', () => {
  assert.throws(
    () => verifyEntries(entriesWith({ 'extension/src/extension.ts': 'source' })),
    /development path packaged/
  );
  assert.throws(
    () => verifyEntries(entriesWith({ 'extension/dist/extension.js.map': '{}' })),
    /development file packaged/
  );
  assert.throws(
    () => verifyEntries(entriesWith({ 'extension/package-lock.json': '{}' })),
    /development file packaged/
  );
});

test('the PTY runtime, icon and manifest-reference checks are enforced', () => {
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({ 'extension/dist/pty/node-pty/prebuilds/win32-x64/conpty.node': null }),
        { target: 'win32-x64' }
      ),
    /missing PTY prebuild/
  );
  assert.throws(() => verifyEntries(entriesWith({ 'extension/media/icon.png': null })), /missing required file/);
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({ 'extension/package.json': JSON.stringify(manifest({ icon: 'missing.png' })) })
      ),
    /manifest icon does not exist/
  );
});

test('every documented setting must remain in the packaged manifest', () => {
  const broken = manifest();
  const contributes = broken.contributes as {
    configuration: { properties: Record<string, unknown> };
  };
  delete contributes.configuration.properties['agentTerminal.terminal.longRunningThresholdSeconds'];
  assert.throws(
    () => verifyEntries(entriesWith({ 'extension/package.json': JSON.stringify(broken) })),
    /manifest is missing setting: agentTerminal\.terminal\.longRunningThresholdSeconds/
  );
});

test('the manifest advertises the public package identity and no publishing automation', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
  ) as {
    name: string;
    publisher: string;
    displayName: string;
    version: string;
    repository?: { type?: string; url?: string };
    homepage?: string;
    bugs?: { url?: string };
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.publisher, PUBLISHER);
  assert.equal(pkg.displayName, 'TermMoor');
  assert.equal(pkg.version, '0.9.0', 'the first public release is 0.9.0');
  assert.equal(pkg.repository?.type, 'git');
  assert.equal(pkg.repository?.url, REPOSITORY_URL);
  assert.equal(pkg.homepage, 'https://github.com/wuwuzhazha/termmoor#readme');
  assert.equal(pkg.bugs?.url, 'https://github.com/wuwuzhazha/termmoor/issues');
  assert.notEqual(pkg.private, true, 'a private manifest cannot be published');

  // Dependencies are intentionally unchanged by the rename.
  assert.equal(pkg.dependencies, undefined, 'the extension ships no runtime dependencies');
  assert.deepEqual(pkg.devDependencies, {
    '@homebridge/node-pty-prebuilt-multiarch': '^0.15.0',
    '@types/node': '^22.10.0',
    '@types/vscode': '^1.106.0',
    '@vscode/vsce': '^3.2.0',
    '@xterm/addon-fit': '^0.10.0',
    '@xterm/addon-web-links': '^0.11.0',
    '@xterm/xterm': '^5.5.0',
    esbuild: '^0.25.0',
    typescript: '^5.7.0'
  });

  // Nothing in the repository may publish on its own: packaging is build-only.
  assert.equal(
    Object.values(pkg.scripts).some((command) =>
      /\b(vsce\s+publish|vsce\s+login|npm\s+publish|ovsx\s+publish)\b/.test(command)
    ),
    false,
    'a script performs an automated publish'
  );
  assert.equal(pkg.scripts.publish, undefined);
  assert.match(pkg.scripts.package, /node scripts\/package\.mjs/);
  assert.match(pkg.scripts['verify:vsix'], /verify-vsix\.mjs/);
});

test('the lockfile mirrors the public package identity', () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8')
  ) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string }>;
  };
  assert.equal(lock.name, PACKAGE_NAME);
  assert.equal(lock.version, '0.9.0');
  assert.equal(lock.packages['']?.name, PACKAGE_NAME);
  assert.equal(lock.packages['']?.version, '0.9.0');
  assert.doesNotMatch(JSON.stringify(lock), /agent-terminal/);
});

test('CI is read-only, Windows x64 only, and never publishes', () => {
  const ci = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'ci.yml'),
    'utf8'
  );

  // Least privilege: the workflow may read the repository and nothing else.
  assert.match(ci, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(ci, /contents: write|id-token: write|packages: write/);
  assert.doesNotMatch(ci, /vsce\s+publish|npm\s+publish|ovsx\s+publish|vsce\s+login/);
  assert.match(ci, /persist-credentials: false/);

  // Packaging runs on the only supported host/target and ships the new name.
  assert.match(ci, /runs-on: windows-latest/);
  assert.match(ci, /--target win32-x64/);
  assert.match(ci, /path: termmoor-\*\.vsix/);
  assert.doesNotMatch(ci, /agent-terminal/);
});

test('generated output, logs and secrets stay untracked', () => {
  const ignore = fs
    .readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());

  for (const rule of [
    'node_modules/',
    'dist/',
    'dist-test/',
    'artifacts/',
    '*.vsix',
    'media/webview/*.js',
    '*.log',
    '.env',
    '.npmrc'
  ]) {
    assert.ok(ignore.includes(rule), `missing ignore rule ${rule}`);
  }
});

test('the manifest advertises no herdr runtime, settings, or commands', () => {
  // TermMoor is a local-PTY-only extension: any leftover herdr surface would
  // reintroduce a backend the code no longer implements.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
  ) as {
    contributes: {
      commands: Array<{ command: string }>;
      configuration: { properties: Record<string, unknown> };
      views?: { agentTerminal?: Array<{ id: string }> };
    };
  };

  assert.doesNotMatch(JSON.stringify(pkg), /herdr/i, 'the manifest still mentions herdr');

  const commands = pkg.contributes.commands.map((entry) => entry.command);
  for (const removed of [
    'agentTerminal.installHerdr',
    'agentTerminal.attachHerdrTerminal',
    'agentTerminal.switchBackend'
  ]) {
    assert.equal(commands.includes(removed), false, `stale command ${removed}`);
  }

  const settings = Object.keys(pkg.contributes.configuration.properties);
  assert.equal(
    settings.some((key) => /runtime\.backend|herdr/i.test(key)),
    false,
    'a runtime backend setting is still advertised'
  );
  for (const required of REQUIRED_SETTINGS) {
    assert.ok(settings.includes(required), `missing documented setting ${required}`);
  }
});

test('the manifest must not advertise development-only fields', () => {
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({
          'extension/package.json': JSON.stringify(
            manifest({ devDependencies: { typescript: '^5.7.0' } })
          )
        })
      ),
    /devDependencies/
  );
  assert.throws(
    () =>
      verifyEntries(
        entriesWith({
          'extension/package.json': JSON.stringify(manifest({ scripts: { test: 'node test' } }))
        })
      ),
    /scripts/
  );
});

test('CLI arguments separate the target from the VSIX path', () => {
  assert.deepEqual(parseCliArgs(['--target', 'win32-x64', 'a.vsix']), {
    target: 'win32-x64',
    file: 'a.vsix'
  });
  assert.deepEqual(parseCliArgs(['--target=win32-x64', 'b.vsix']), {
    target: 'win32-x64',
    file: 'b.vsix'
  });
});

/** Builds a minimal ZIP with stored entries, enough for the verifier's reader. */
function makeStoredZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(value, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
