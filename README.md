# TermMoor

TermMoor is a Windows x64 sidecar terminal for VSCodium/VS Code that moves code
references between your editor and the CLI you run yourself, without managing
agents, sessions, prompts, or a workspace.

> Windows x64 builds are distributed through [GitHub Releases](https://github.com/wuwuzhazha/termmoor/releases). Open VSX is not yet available.

## What it does

Every tab is one local pseudo-terminal running your host shell
(`powershell.exe` on Windows). You type `pi`, `claude`, `gdb`, `pytest`, or
anything else; TermMoor only improves the two directions of a code reference:

- **Editor → CLI:** `Ctrl+Alt+Enter` (or the editor context menu) puts a code
  citation — and the selected code or a file path — into the CLI's input line.
- **CLI → editor:** file references printed by the CLI become clickable and open
  the cited source.

TermMoor contributes no agent runtime, no session persistence, and no other
editor commands.

## Platform support and limits

| Item | Value |
| --- | --- |
| Packaged target | **`win32-x64` only** |
| Host | VSCodium or VS Code `^1.106.0` |
| Shell | Host shell in a local PTY (`powershell.exe` on Windows) |
| Runtime | Local PTY only; no remote, daemon, attach, or detach mode |
| Session restore | None: no tab list, order, or working directory is saved |

- **Windows x64 only for now.** The packaged native PTY runtime contains a
  `win32-x64` prebuild and nothing else. Do not install this VSIX on Linux,
  macOS, Windows arm64, or any other target; the packaging script accepts
  `win32-x64` only and refuses a VSIX it cannot label correctly.
- **Local terminals only.** TermMoor does not forward remote, WSL, SSH, or
  container shells, and it does not integrate with the editor's terminal.
- **No persistence.** Reloading the window or restarting the extension host
  leaves no tabs behind; the next open starts one fresh shell in the workspace
  root. Conversation history, prompts, and resume stay owned by the CLI.
- **Closing a tab stops its shell**, with a confirmation while work is running.
- **Untrusted workspaces are refused** (`untrustedWorkspaces.supported: false`).
- **Up to 12 tabs** per workspace; tab names follow the foreground process.

## Quick start

Build once, install once, then use the two shortcuts.

```powershell
npm ci
npm run package     # writes .\termmoor-0.9.0-win32-x64.vsix
codium --install-extension .\termmoor-0.9.0-win32-x64.vsix
# or: code --install-extension .\termmoor-0.9.0-win32-x64.vsix
```

Reload the window when prompted, then open **TermMoor** in the secondary side
bar.

1. **Send code to the CLI.** With the caret in a file (selection or not) press
   `Ctrl+Alt+Enter`, or right-click and choose **Insert Code Context into
   TermMoor**. A selection inserts the selected code plus a citation such as
   `src/net/socket.c:42-58`; with no selection you get the file reference. Text
   is inserted without pressing Enter, so nothing is submitted for you.
2. **Open code from the CLI.** Click a reference in terminal output:
   `path:line:col`, `path:start-end`, `#Lx-Ly`, MSVC/Clang `file.c(42,8)`,
   Python `File "x.py", line 84`, Windows and UNC paths, OSC 8 `file://` links,
   and bare file names resolved against the workspace.

Inside the panel: `Ctrl+F` / `Ctrl+Shift+F` search, `Ctrl+Up` / `Ctrl+Down`
jump between prompts, `Ctrl+1`…`Ctrl+9` switch tabs, `+` opens a terminal and
`×` closes it. Links outside the workspace ask for confirmation first, and
external links are limited to `http:`, `https:`, and `mailto:`.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `agentTerminal.terminal.scrollback` | `5000` | Scrollback lines kept by the panel terminal. |
| `agentTerminal.terminal.shellIntegration` | `true` | OSC 133/633 hooks for prompt boundaries, working directory, prompt jumps, and completion alerts. |
| `agentTerminal.terminal.longRunningThresholdSeconds` | `10` | Notify when an unfocused command finishes after this many seconds; `0` disables. |

These are the only settings TermMoor contributes.

## Package identity and migration

| | Identity |
| --- | --- |
| Public package (this tree) | `wuwuzhazha.termmoor`, version `0.9.0` |
| VSIX file name | `termmoor-<version>-win32-x64.vsix` |
| Pre-release local builds | `local.agent-terminal` |

Earlier local builds used the development identity `local.agent-terminal`.
An extension ID is the identity the host uses, so migration is a switch, not an
upgrade:

- `wuwuzhazha.termmoor` does **not** upgrade `local.agent-terminal`. The host
  sees two separate extensions, and installing the new one does not remove the
  old one.
- Settings carry over unchanged, because the keys stay `agentTerminal.*`.
- Do not keep both enabled at once: they register the same view, commands, and
  keybinding, so the panel and shortcuts would be ambiguous.
- Removing or replacing the old extension **stops its running terminals**. Do
  not migrate inside a session you are working in — finish or save that work,
  install the new ID in that window or profile, then uninstall or disable the
  old one.

## Security

- Paths outside the workspace require confirmation before they open.
- External URLs are limited to `http:`, `https:`, and `mailto:`.
- Untrusted workspaces are refused.
- Temporary context files live in a per-process `mkdtemp` directory with
  `0700`/`0600` modes where the platform honors them, are swept on startup
  after 24 hours, and are removed on dispose. Shell-integration helper files go
  under `integration/` inside that directory, never into your workspace.

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not
open a public issue with exploit details, and do not send credentials, tokens,
or full terminal transcripts.

## Development

Requires Node.js 22+ and npm (the lockfile is v3). Run everything from this
directory, not from an enclosing workspace root.

```powershell
npm ci             # exact dependency versions from package-lock.json
npm run build      # tsc --noEmit, then esbuild
npm test           # bundles test/*.test.ts and runs node --test
npm run package    # build + identity/freshness/prebuild guards + staged allowlist VSIX
npm run verify:vsix   # verifies the newest win32-x64 VSIX
# or name one explicitly:
node scripts/verify-vsix.mjs .\termmoor-0.9.0-win32-x64.vsix
```

These are the gates: a change is ready when build, tests, packaging, and the
independent VSIX verification all pass. Packaging also asserts the public
identity in the staged manifest. CI (`.github/workflows/ci.yml`) runs the same
steps on `windows-latest` with Node 22, uploads the VSIX as a build artifact,
and never publishes, releases, or installs the extension.

No GUI test suite drives the editor-to-CLI hand-off, the tab strip, or in-panel
search. Those flows are verified manually; unit tests cover context formatting,
shell quoting, command wiring independent of keybindings, and link resolution.

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Release history lives in
[CHANGELOG.md](CHANGELOG.md). A Chinese version of this page ships in the
repository as `README.zh-CN.md`. License: [MIT](LICENSE).
