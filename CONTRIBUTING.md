# Contributing

TermMoor is a Windows x64 sidecar terminal for the code-reference hand-off
between VSCodium/VS Code and a CLI you run yourself. Keep changes inside that
scope: no agent runtime, no session persistence, no prompt management, and no
new editor-side commands. The only editor command is
`agentTerminal.sendToTerminal` (`Ctrl+Alt+Enter` / `Cmd+Alt+Enter` on macOS).

## Environment

- Node.js 22+ and npm (the lockfile is v3).
- Windows x64. The packaged PTY runtime contains a `win32-x64` prebuild only, so
  the extension cannot run on other targets.
- Run commands from this directory, not from an enclosing workspace root.

## Gates

A change is ready when install, build, tests, packaging, and independent VSIX
verification all pass. CI (`.github/workflows/ci.yml`) runs the same steps on
`windows-latest` with Node 22, packaging and verifying with `--target
win32-x64`.

```powershell
npm ci
npm run build
npm test
npm run package
npm run verify:vsix   # newest win32-x64 VSIX
# or name one explicitly:
node scripts/verify-vsix.mjs .\termmoor-0.9.0-win32-x64.vsix
```

- Nothing is published, released, or uploaded to an extension registry. CI only
  uploads the VSIX as a workflow artifact.
- Do not commit `*.vsix`, `dist/`, `dist-test/`, `node_modules/`, or
  `artifacts/`.
- `npm run package` checks the manifest identity (`termmoor`, publisher
  `wuwuzhazha`, the public repository URL), dist freshness, and the PTY
  prebuild, stages an explicit runtime allowlist into a temporary directory,
  then verifies the VSIX. Do not bypass the verifier, rename the package, or
  assemble a VSIX by hand.

## Tests

`npm test` bundles every `test/*.test.ts` and runs `node --test`. Add unit
coverage for behavior you change. Panel interactions (tab strip, in-panel
search, editor-to-CLI insertion) are not covered by a GUI suite yet; list what
you verified manually in the pull request, including host and Windows versions.

## Pull requests

- One concern per pull request; describe the motivation, the behavior change,
  and how you verified it.
- Update `README.md` and `README.zh-CN.md` plus `CHANGELOG.md` for user-visible
  changes.
- Do not include credentials, tokens, private paths, or full terminal
  transcripts.
- Do not change the license, the publisher identity, or the version unless that
  is the purpose of the pull request.

## Issues

Use the issue templates and provide a minimal reproduction on a VSIX you built
from this tree. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead.
