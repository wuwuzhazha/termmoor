# Changelog

## 0.9.0 — Panel-Only Surface

- **No TermMoor actions in the view title.** The custom overflow and duplicate
  New Terminal action are gone. The tab strip still has `+` and `×`.
- **Removed commands and their localized titles.** `agentTerminal.insertContext`,
  `addProblems`, `addGitDiff`, `openOutputInEditor`, `toggleDraft`,
  `addSelection`, `addFile`, `addFolder`, `addFileContent`,
  `addTerminalOutput`, `renameTab`, `restart`, `find`, and `closeSession` are no
  longer contributed, and their manifest strings are deleted from
  `package.nls.json` and `package.nls.zh-cn.json`. Nothing else took their
  place: the features themselves are removed, not just their menu entries.
- **Explorer and terminal attachments removed.** The `explorer/context` entries
  for file path, folder path, and file content, and the `terminal/context`
  entry for attaching integrated-terminal output, are gone.
- **Tab names are automatic.** Inline rename and reset-name actions are gone.
- **Kept on purpose.** `agentTerminal.sendToTerminal` (editor → CLI code
  context), its `Ctrl+Alt+Enter` / `Cmd+Alt+Enter` binding and editor context
  entry, clickable file references in terminal output, in-panel `Ctrl+F` /
  `Ctrl+Shift+F` search, the tab strip, the normal local PTY shell, and the
  three terminal settings. `Ctrl+F` is handled by the webview, so removing the
  find command changes nothing about search.
- **Nested directory links resolve in Explorer.** A short `integration/`
  citation can resolve to `Tests/integration`, preferring the source directory
  over a staging copy. Equal candidates prompt for a choice.
- **No data change.** The extension ID, publisher, engine range, dependencies,
  lockfile resolution, views container, webview view, and all three settings
  are unchanged apart from the `0.9.0` bump. Nothing is written to user state,
  and no removed setting is migrated.

## 0.8.0 — Local PTY Only

- **TermMoor is a local-PTY-only terminal again.** Every tab is one local
  pseudo-terminal running the host shell. TermMoor keeps no session runtime,
  restores no tabs, and owns no CLI history: conversation history, prompts,
  shell history, and resume stay with the CLI or shell you run.
- **Removed the optional persistent runtime path.** The
  `agentTerminal.runtime.backend`, `agentTerminal.herdr.binaryPath`, and
  `agentTerminal.herdr.closeTabAction` settings are gone, along with their
  localized manifest strings. So are the **Install herdr-core Persistent
  Backend**, **Attach to Running herdr Terminal…**, and **Switch Terminal
  Runtime Backend** commands and their view-title menu entries. No attach,
  adopt, reattach, recon, or session-list code path remains reachable from the
  extension.
- **Closing a tab stops its local shell.** The PTY ends with the tab, and
  closing the last tab respawns a fresh shell instead of leaving an empty view.
  A tab that is actively running work (or still starting) asks for confirmation
  before the process is terminated; an idle shell at its prompt closes with no
  confirmation prompt. Restart is always guarded while the tab is running.
- **Upgrade leaves external state untouched.** Replacing the VSIX writes no user
  state: an existing `hc`/`herdr-core` installation stays installed, the `hc`
  sessions earlier TermMoor versions started keep running and stay reachable by
  other tooling, and previously stored values for the removed settings remain in
  `settings.json` as unknown, inert settings. TermMoor no longer attaches to any
  of them. The three remaining terminal settings keep their previous names,
  defaults, and stored values.
- **Verifier and documentation follow the manifest.** `scripts/verify-vsix.mjs`
  no longer requires the removed herdr settings, and the README documents the
  local-PTY runtime model, the session lifecycle, and the upgrade path.
  Identity (`local.agent-terminal`, `displayName: TermMoor`), engine range,
  dependencies, and lockfile resolution are unchanged apart from the `0.8.0`
  bump.

## 0.7.0 — One Code-Context Command & A New Shortcut

- **One command carries code from the editor into the CLI.**
  `agentTerminal.sendToTerminal` is now **Insert Code Context into TermMoor** /
  **将代码上下文填入 TermMoor**, bound to `Ctrl+Alt+Enter` (`Cmd+Alt+Enter` on
  macOS) and shown in the editor context menu. It appears for editor text with
  or without a selection and inserts a reference into the CLI draft: file name
  plus selected line range when there is a selection, the file itself
  otherwise, and a private temp file path when the buffer is unsaved.
- **`Ctrl+Shift+L` is no longer bound.** That chord overrides the editor's
  select-all-occurrences command, so TermMoor stops claiming it. Existing users
  should switch to `Ctrl+Alt+Enter`.
- **The editor context menu has one entry instead of three.** The editor-only
  **Insert Selection / File / File Content into Terminal** entries duplicated
  the same hand-off and are removed from `editor/context`. Their command IDs
  (`agentTerminal.addSelection`, `addFile`, `addFileContent`) remain registered
  for the Command Palette, and the Explorer context menu still offers path,
  folder, and file-content insertion. No command, view, configuration, or
  storage ID changed.
- **Insertion never submits the command.** The reference is written as text in
  the draft; Enter is never sent automatically, and the app running in the
  terminal keeps its own history. herdr-core remains optional; the manifest
  version, dependencies, and lockfile resolution are unchanged other than the
  `0.7.0` bump.
- **README restructured around the two directions** (editor → CLI references,
  CLI → editor navigation) with a compatibility section, and the in-panel hint
  now names `Ctrl+Alt+Enter`. No GUI test run is claimed for these flows.

## 0.6.6 — Transient Tabs, No Automatic Restore

- **Removed the `agentTerminal.terminal.restoreTabs` setting** and its localized manifest string. TermMoor no longer writes or restores a per-workspace tab snapshot, so no option advertises one.
- **One fresh terminal after a restart.** After a window reload or extension-host restart, opening TermMoor starts one new shell in the workspace root. Custom names, tab order, working directories, and previous output are not carried over.
- **Live herdr-core sessions are never adopted automatically.** Tabs belong to the window that created them; old `hc` terminals are left untouched and reattached manually with **Attach to Running herdr Terminal…**. CLI-level resume (for example Pi's own session resume) remains a manual step and is never started for you.
- **Hide and dispose are described as they behave.** With `retainContextWhenHidden`, collapsing the sidebar keeps the webview and its shells running; disposing the view stops the local PTY processes.
- **Packaging checks and README follow the manifest.** `scripts/verify-vsix.mjs` no longer requires the removed setting, and the stale auto-hiding tab strip wording is replaced with the strip's actual behavior.

## 0.6.5 — Session Safety & Build Verification

- **Closing a persistent terminal defaults to detach.** The local viewer stops, while the herdr-core process remains available to reattach. Explicit `kill` remains available in settings; running work is confirmed before close or restart.
- **Verified package runtime counts now include the VSIX `extension/` prefix**, and a regression test checks the target-specific PTY binary is counted.
- **Improved keyboard access and stale-message handling**, kept terminal output visible while starting, and fixed scrollback `0` handling.

## 0.6.4 — TermMoor Branding

- **Renamed the user-facing extension from Terminal Pro to TermMoor** across the extension manifest, localized command and setting titles, webview UI strings, and README. Extension, command, view, configuration, and storage IDs are unchanged.

## 0.6.3 — Citations With Prose Labels & Folder Reveal

- **Labeled file citations resolve.** A citation with attached prose (e.g. `See XcpOnEth.c`) is tried as an exact path first, then by the final standalone filename candidate inside the workspace.
- **Directory citations reveal in Explorer.** An explicit directory citation now opens the workspace folder in the Explorer instead of failing.
- **Slash-separated citations keep their suffixes**, so `XcpOnFr.c:42:8` still opens at line 42, column 8.

## 0.6.2 — Citations No Longer Swallow Surrounding Prose

- **Fixed "无法打开 里的隐藏静态缓冲：XcpOnEth.c".** The slash-list matcher accepted every non-space character, so a Chinese label separated by a full-width colon was swallowed into the file name and the resulting path never existed. List segments are now validated against a path-only character class (ASCII letters/digits plus real filename punctuation), so CJK prose and full-width punctuation are rejected.
- **Sentence punctuation no longer breaks or joins a citation.** A trailing `。`/`，`/`）` is stripped before the list is split, so `XcpOnEth.c/XcpOnFr.c。` still yields two links.
- **Line-numbered members survive the check.** `XcpOnFr.c:42` is validated after the citation suffix is removed, so it stays a clickable member opening at line 42.

## 0.6.1 — Slash-Separated File Lists

- **Fixed `XcpOnEth.c/XcpOnFr.c` being treated as one path.** A slash between two complete file names is how agents list several files, but it was parsed as `XcpOnFr.c` inside a directory named `XcpOnEth.c` — a path that never exists. Each member is now a separate clickable link.
- **Genuine paths are untouched.** Splitting only happens when *every* segment carries a source-file extension, so `src/net/socket.ts` and `docs/a.md/docs/b.md` keep their original meaning. Backslash paths are never split.
- **Citation suffixes survive the split**, so `XcpOnFr.c:42` in a list still opens at line 42.

## 0.6.0 — Citations Resolve to the Source File

- **Fixed a bare file name reporting "file not found" when the file exists.** `Xcp.h` failed because the workspace also holds a copy inside `.tmp/release-check-0.2.0/…`, and the previous "ambiguous, refuse" rule treated a build artefact as a real competitor. Workspace matches are now ranked: source trees outrank generated/build trees (`node_modules`, `.tmp`, `dist`, `out`, `build`, `target`, …), and within the best rank the shallowest path wins, so the citation opens `Xcp/Xcp.h`.
- **True ties ask instead of failing.** Only files that are equal on both rank and depth produce a QuickPick ("Which file did you mean?"); anything else resolves silently.
- **Bare names no longer match across a boundary.** `Xcp.h` matches `Xcp/Xcp.h` but never `MyXcp.h` or `Xcp.h.bak`.

## 0.5.9 — "File Not Found" for Files That Exist

- **Fixed `vscode://file/…` links (and `vscode-insiders://`) being rejected.** Agents commonly cite files with VS Code's own scheme; the containment policy treats unknown schemes as external URLs, so every such click reported a missing file. The scheme is now rewritten to a plain path before resolution, including the percent-encoded form (`vscode://file/e%3A/…`).
- **Fixed percent-encoded citations.** `file:///E%3A%5CXcp%5Ca.md` and an escaped suffix (`…a.md%23L42`) were passed through undecoded and failed to resolve; targets are now decoded tolerantly (malformed escapes stay verbatim) and the suffix is parsed afterwards.
- **Fixed invisible characters breaking the path.** Zero-width spaces and BOMs copied out of agent output made a valid path unmatchable; they are stripped during normalization.
- **Bare file names now resolve inside the workspace.** A citation like `architecture.md` (or a path relative to a directory the shell has since left) previously failed outright. It is now matched against the workspace index by trailing segments and opened only when the match is unambiguous, so a wrong file is never opened.

## 0.5.8 — Clickable File Links Actually Open

- **Fixed clicking a file citation doing nothing.** Agents and CLIs emit citations as OSC 8 hyperlinks (`file:///E:/x/app.c#L42`); xterm only builds a link for http(s) unless non-HTTP protocols are explicitly allowed, so those citations were never clickable. A `linkHandler` with `allowNonHttpProtocols` now routes every OSC 8 link through the host: http(s)/mailto to the browser, everything else to the file opener.
- **Fixed line-numbered citations not jumping to the line.** The `#L42` fragment (and plain-text `:42:8` / `(42,8)` suffixes) stayed inside the path, so the file was never resolved. `splitLinkTarget` now strips the suffix before the path policy runs and forwards the 1-based line/column to the editor.
- **Failures are no longer silent.** A citation that cannot be resolved (missing file, outside the workspace, unreadable) now shows a toast naming the path instead of doing nothing.

## 0.5.7 — Drag-to-Insert Removed

- **Removed the drag-to-insert channel entirely** (webview drop overlay, `drop-uris` / `drop-text` messages, path decoding helpers, one-time drag coach tip, and the `Shift`+drop editor relay from 0.5.3/0.5.4). Path insertion stays on the keyboard and context-menu channels: `Ctrl+Shift+L`, **Insert File / Folder / File Content into Terminal**, and `Ctrl+Alt+I`.
- **Why**: VS Code calls `_startBlockingIframeDragEvents()` for the duration of any drag and sets `pointer-events: none` on every webview iframe, so no webview can be a drop target. The only in-panel native drop surface is a tree view, which cannot blend into the panel without becoming a dedicated strip.

## 0.5.6 — Removed the Panel Drop Strip

- **Removed the dedicated drop zone above the terminal.** A strip whose only purpose was accepting file drops is not a defensible design for a terminal panel, so it is gone; the panel is a single clean terminal view again.
- **Root cause, verified in the VSCodium workbench bundle**: during any drag the host runs `_startBlockingIframeDragEvents()` and sets `pointer-events: none` on every webview iframe, so no webview (sidebar or editor) can ever be a drop target. The only in-panel drop surface is a native tree view, which cannot be made small enough to blend into the chrome.

## 0.5.5 — Direct Panel Drop Zone

- **Drag files straight onto the Terminal Pro panel.** A compact native drop zone now sits at the top of the Terminal Pro view container: drag files or folders from the Explorer (VS Code built-in or the OS file manager) onto it and their shell-quoted paths are inserted into the active terminal tab. The host dispatches native tree drops itself, so no editor and no modifier key are involved.
- **Removed the editor-drop relay** (`DocumentDropEditProvider`) and the `agentTerminal.drop.intoEditor` setting; drops no longer need to be routed through an editor.

## 0.5.3 — Drop Files onto Any Editor

- **Shift+drop a file onto ANY editor now sends its quoted path to the active Terminal Pro tab.** The drop is handled through VS Code's native `DocumentDropEditProvider` pipeline (registered for `file` / `untitled` documents) and returns a no-op edit, so the document stays unchanged while the shell-quoted path is inserted into the terminal. The old sidebar webview drop target never receives drags in current VS Code/VSCodium builds, so its hint was removed and the one-time coach tip now points at the editor drop channel.
- **New setting `agentTerminal.drop.intoEditor`** (`always` / `off`, default `always`): set to `off` to restore VS Code's default drop-into-editor behavior.
- **Fixed dropped files inserting `file://` URIs instead of paths.** Explorer drops arrive as percent-encoded URIs, so a shell received `file:///e%3A/Xcp/docs/architecture.md`. They are now decoded into real filesystem paths (`E:\Xcp\docs\architecture.md`, `/home/user/a b.txt`, `\\server\share\x.txt`) before quoting and dedupe; malformed escapes are kept verbatim.

## 0.5.2 — Agent Icon Identity & Drag Coach

- **Real CLI identity in tab icons**: tabs now identify the actual agent (`pi`, `claude`, `codex`, `opencode`, `gemini`, `qwen`, `aider`, `cursor-agent`, …) from the herdr foreground command line instead of showing a generic `node` icon for every Node-based CLI. Directory segments (`@anthropic-ai/claude-code`, `.pi`, `.opencode`, …) take priority, with the executable basename as a fallback, and restored tabs are seeded on reconciliation so the correct icon appears immediately.
- **One-time drag coach**: a single informational tip explains that VSCodium requires holding Shift when dropping files into webview views, plus the drag-free alternatives (`Ctrl+Shift+L` and right-click “Insert workspace context”). It is shown once per install and remembered in global state.
- **Agent-declared OSC 7501 identity/status**: tabs also read the agent's own OSC 7501 record (`{app, state}`, e.g. `{app: "pi", state: "idle"}`) so the status glyphs (`◐`/`●`/`✕`/`✓`) and Agent icons light up under `hc attach`.

## 0.5.1 — Tab Reliability & herdr-UI Pill Design

- **Fixed stale tab titles after window reload**: idle shells no longer inherit the OSC window title left over from the previous session (`node`, `claude`, …) — the window title is only trusted while an agent is actively `working`/`blocked`, and reattached tabs are reset to the shell default until live `hc` data arrives. `hc attach` viewer title noise (`hc`, `herdr-core`, `hc.exe`) is filtered out of the automatic tab name.
- **Fixed tab drag-to-reorder dying mid-drag**: a pointer session now starts at `pointerdown` (not after the 5px threshold) and the dragged pill is re-resolved by tab id on every move, so the frequent live-state tab bar rebuilds in herdr mode no longer destroy the drag.
- **herdr-UI-style tab pills**: shortcut number badges plus `Ctrl+1-9` direct tab switching, status glyphs (`◐` busy, `●` waiting, `✕` error, `✓` done), a status-reactive border on the active pill, and a close ✕ that is only revealed on hover.

## 0.5.0 — Herdr-Core Persistence & Guided Onboarding

- **herdr-core Persistent Runtime (`hc`)**:
  - Optional `agentTerminal.runtime.backend` (`auto` / `herdr` / `pty`) plus `agentTerminal.herdr.binaryPath` and `agentTerminal.herdr.closeTabAction` (`kill` / `detach`). `auto` uses `herdr-core` whenever `hc` is found, and every other path falls back to the built-in PTY backend unchanged.
  - Tabs started in `herdr` mode are launched through `hc terminal.run` with `keep`, `no_parent` and `outlive_parent`, so the session survives closing or reloading VSCodium. Closing a tab or hiding the sidebar only stops the local `hc attach` viewer — the persistent terminal is never killed on IDE close, and reopening reattaches with `--history`.
  - Per-workspace reconciliation on startup: restored tabs are matched against live `hc` terminals by `tp.ws` label hash and `tp.tab` label, orphaned workspace terminals are adopted (up to 12 tabs), and stale addresses are cleared so the next start creates a fresh `hc` terminal.
  - Live `hc` events drive tab state: agent status (`idle` / `working` / `done` / `blocked` / `error`), working directory, foreground process hints, `blocked` attention badges for background tabs, and finished-terminal exit codes.
  - `Restart` on a persistent tab kills and removes the old `hc` terminal first, so it genuinely starts a fresh shell. Tab close honors `herdr.closeTabAction`: `kill` ends the `hc` terminal, `detach` keeps it alive and only drops its auto-restore label (re-attach any time via the attach flow). Renaming a tab syncs the `tp.title` label.
- **Guided Onboarding & Three New Commands**:
  - `Install herdr-core Persistent Backend`: modal confirmation showing the exact official install command, then runs the installer in a dedicated visible tab and re-probes `hc` on a clean exit — showing `herdr-core vX.Y.Z 已就绪，持久化终端已激活！` and switching new/restarted tabs over automatically.
  - `Attach to Running herdr Terminal…`: QuickPick over all live `hc` terminals (local and SSH machines) with `[address] title`, `cwd`, machine, status and already-attached markers; already-open tabs are switched to, unattached terminals become new persistent tabs, and a `$(remote) New terminal on <machine>…` entry launches a fresh shell on any connected machine.
  - `Switch Terminal Runtime Backend (Auto / herdr / PTY)`: writes the choice globally and immediately re-probes `hc`, reconciles workspace terminals and refreshes state.
- **Runtime Banner & State**:
  - The webview banner now reports `runtime.mode`, `herdrAvailable`, `herdrVersion` and `installPromptVisible`, with dismiss state persisted in global state.
  - Tab info exposes `persistentAddress`, `machine` and `agentStatus` for badges and the attach/detach context menu.
- **OpenRPC Audit Fix**:
  - `HerdrClient` now speaks the exact singular method names reported by `hc schema` (`terminal.list`, `terminal.get`, `terminal.run`, `terminal.kill`, `terminal.rm`, `terminal.keep`, `terminal.label`, `machine.list`) instead of the previous plural guesses.
- **Robustness**:
  - An in-flight request rejects immediately when the `hc connect` stream exits, and the next request transparently opens a fresh transport.
  - `persistentAddress` is persisted per workspace tab (trimmed, capped at 64 chars) and ignored when empty.

## 0.4.0 — Workspace Tab Persistence, Rename, Drag Reorder & Drop Upgrade

- **Workspace Tab Restoration (`agentTerminal.terminal.restoreTabs`, default `true`)**:
  - Automatically restores all open terminal tabs, order, custom tab names, icon hints, and per-tab working directories per workspace on startup. Toggleable in settings to start with a single empty terminal instead.
- **Accurate Foreground Agent / CLI Tab Naming & Icons**:
  - Fixed Windows `node-pty` reporting `xterm-256color` as `proc.process`; extended shell hooks with `OSC 633;E;<cmd>` and `OSC 633;P;Cwd=<cwd>` so running `pi`, `claude`, `codex`, `opencode`, `python`, or `node` immediately updates the tab title and SVG icon, and reverts cleanly on exit.
- **Inline Tab Rename & Pointer Drag-to-Reorder**:
  - Double-click any tab (or right-click tab / press `F2` / run `Rename Active Terminal Tab`) to rename inline; submit empty text or use `Reset automatic tab name` to restore live process naming while keeping the active Agent icon.
  - Smooth pointer-capture horizontal drag-to-reorder across tabs (bypasses VS Code's HTML5 iframe drag lock), plus middle-click close and `Close other terminals`.
- **Full Drag & Drop MIME Coverage + `Ctrl+Shift+L` Quick Send**:
  - Supports `ResourceURLs` (Explorer folder & multi-item drags), `CodeEditors` (editor tabs), `CodeFiles`, `application/vnd.code.uri-list`, native files, and selected editor text (`text/plain` -> safe temp file for multiline selections) with window-capture listeners and an animated drop card + green confirmation ring.
  - Added `Ctrl+Shift+L` (`Send Selection or Active File to Terminal Pro`) for instant zero-mouse editor-to-terminal transfer, and live per-tab `cwd` resolution when clicking relative file paths.

## 0.3.0 — Symbiotic Sidecar Release

Implements the three-tier Editor-Symbiotic Terminal architecture while keeping
zero built-in agent lock-in:

- **Tier 1 (Bidirectional Pipeline)**:
  - Drag & drop files/folders/tabs into the terminal to insert shell-quoted
    paths (hold `Shift` to write file content to a temp file and insert its path).
  - `Ctrl+Alt+I` Workspace Context QuickPick for active selection, active file,
    **Workspace Problems (Diagnostics)**, **Git Diff** (`.diff` temp file),
    open editors, and workspace symbols.
  - Compiler & traceback link recognition for MSVC/Keil/Clang `file.c(line,col)`
    and Python `File "...", line N`.
  - `Ctrl+Shift+O` and context menu actions to open terminal selections or the
    last command's soft-wrap-joined output in a wide editor tab, or insert
    selections at the active editor cursor.
- **Tier 2 (Narrow-Sidebar Ergonomics)**:
  - ExecutionPolicy-safe PowerShell and Bash/Zsh **OSC 133 shell integration**
    with `Ctrl+Up` / `Ctrl+Down` prompt jumping and exact last-command output
    extraction.
  - Floating `Ctrl+F` / `Ctrl+Shift+F` terminal buffer search bar with match
    counter and wide-glyph-aware selection highlighting.
- **Tier 3 (Non-Intrusive TUI Escort)**:
  - **Auto-hiding multi-tab strip** (zero header UI when 1 tab is open; compact
    process-aware pills like `1:pwsh`, `2:claude` when multiple tabs exist,
    switched via `Ctrl+PageUp` / `Ctrl+PageDown`).
  - Background / unfocused completion notifications and unread tab dots for
    long-running commands (`>= 10s`) and terminal `BEL` signals.
  - On-demand **Multiline Draft Composer** (`Ctrl+Shift+Space`): `Enter` adds
    newlines safely, `Ctrl+Enter` inserts into the terminal, `Ctrl+Shift+Enter`
    inserts and executes.

## 0.2.2

- **Mouse wheel scrolling** now uses an explicit handler for the normal buffer,
  so it keeps working even when the webview/iframe does not deliver wheel
  events to xterm's viewport listener. Alternate-screen apps (vim, less, agent
  TUIs) still use xterm's native mouse/arrow handling.

## 0.2.1

- **Removed the in-webview header** (title, New, Restart). The terminal now
  starts at the top of the view; New and Restart live in the view title toolbar.
- **Neutral restart icon**: the view title action now uses `$(refresh)` instead
  of the green debug-restart glyph.

## 0.2.0 — Terminal Pro

Terminal Pro is now a terminal-only sidebar. The agent manager, engine
registry, session store, permission gate, and TUI handoff are removed. The
extension starts a plain shell and enhances it; it does not detect or launch
agents.

- **No agent integration**: the header is title + New + Restart. There is no
  engine picker, session list, permission gate, or handoff. Type `pi`,
  `claude`, or any command yourself.
- **Shell-first**: the sidebar starts `powershell.exe -NoLogo` on Windows and
  `$SHELL -l` elsewhere, in the workspace root.
- **Shell-safe insertion**: files and folders insert as single-quoted paths.
  PowerShell escapes `'` as `''`; POSIX shells use `'\''`. Newlines collapse so
  an inserted path cannot submit a command.
- **Selections and output**: clean selections insert `path:start-end`; dirty
  buffers, file content, and terminal output go to a private temp file and
  insert that path. Nothing is prefixed with `Context:` and no Enter is sent.
- **Preserved**: clickable file references (paths, ranges, Windows/UNC, CJK,
  wrapped rows), terminal copy/paste, `open-url` scheme allowlist,
  outside-workspace confirmation, and monotonic state ordering.
- **Settings reduced** to `agentTerminal.terminal.scrollback`.
- **Packaging** no longer copies the PI extension into `dist/`.

## 0.1.2

Integration release: session lifecycle, security defaults, and the build gates
are now wired end to end.

- **P0 start ordering**: an unavailable engine no longer kills the running pty.
  A start is prepared first; the current shell/session is replaced only after a
  usable command exists.
- **Session strategies**: PI handoff, Claude preassigned `--session-id` /
  `--resume`, OpenCode `ses_` / `--session`, and Codex `resume <id>` are
  documented and used consistently. ACP stays UI-only and is hidden from the
  terminal picker.
- **Session pruning**: `maxSessions` is enforced on activation and after each
  successful save; stale sessions and `last-session` entries are cleaned up.
- **No probe process**: terminal preparation no longer starts a throwaway
  adapter process. A cached engine probe validates the executable before the
  current pty is replaced.
- **Codex id backfill**: a new Codex TUI session polls its rollout files for up
  to 20 seconds and stores the discovered thread id, matched by start time and
  cwd. No id is invented on timeout.
- **Resume safety**: restoring a session with no native id now asks before
  starting a new one instead of silently discarding the restore.
- **MCP allowlist**: MCP tools go through the permission gate and require
  approval by default.
- **Path policy**: opening a path outside the workspace asks for confirmation;
  `file:`/`command:`/custom URL schemes stay blocked.
- **Chinese paths**: CJK text and wrapped rows before a path still produce one
  clickable reference.
- **Paste and shortcuts**: multi-line paste no longer submits accidentally;
  copy/paste shortcuts work in the TUI.
- **State ordering**: `state.seq` lets the webview drop out-of-order snapshots;
  the obsolete `terminal-state` message was removed.
- **PTY timeout fix**: stopping a pty that never reports exit no longer hangs
  the next start.
- **Context safety**: context is refused in a shell, queued for an agent, and
  written to private temp files with JSON-quoted paths.
- **Gates**: `npm run build` typechecks first, `npm test` runs every bundled
  test, and `npm run package` refuses stale output or a mismatched PTY
  prebuild.

## 0.1.1

- Shell-first startup: a regular shell terminal is ready immediately, with the
  agent engine selected per session instead of blocking the view on engine I/O.
- PI session handoff: resuming a PI session now hands the existing session id to
  the new process so conversation history and permission settings survive a
  restart.
- Overlay fix: the webview overlay no longer stays on top of the terminal or
  swallows pointer input after focus changes.
- Build and packaging gates: typecheck runs before bundling, the test glob is
  expanded by a Node script, and packaging refuses to ship stale `dist` output
  or a PTY prebuild that does not match the requested target.

## 0.1.0

- Initial release: agent-aware terminal sidebar with clickable file references
  and one-keystroke context injection for local agent TUIs.
