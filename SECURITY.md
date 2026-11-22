# Security Policy

## Supported versions

TermMoor ships as a Windows x64 VSIX for VSCodium/VS Code `^1.106.0`. Only the
current version (`0.9.0`) is
supported. Other platform targets are out of scope, and so are modifications you
made to the tree before building.

## Reporting a vulnerability

Please report privately through GitHub Security Advisories on the TermMoor
repository (`wuwuzhazha/termmoor`). If private reporting is not available yet,
contact the maintainer directly first; do not open a public issue with exploit
details.

Include, where you can:

- TermMoor version and the VSIX file name (for example
  `termmoor-0.9.0-win32-x64.vsix`) or the commit you built from;
- host product and version (VSCodium or VS Code) and your Windows version;
- minimal reproduction steps and the observed versus expected behavior;
- the relevant setting values (`agentTerminal.terminal.*`).

Please keep the report minimal: no credentials, tokens, private source, or full
terminal transcripts. Redact paths and commands that identify you or your
employer.

## Scope

In scope, for the extension and its panel:

- handling of clicked file references, workspace-outside path confirmation, and
  the `http:` / `https:` / `mailto:` link allowlist;
- temporary context files: `mkdtemp` directory, `0700`/`0600` modes where the
  platform honors them, 24-hour startup sweep, dispose cleanup;
- shell-integration helper files written under `integration/` in that temporary
  directory;
- the local PTY boundary, including shell quoting of inserted code context;
- untrusted-workspace handling.

Out of scope:

- vulnerabilities in the CLI, shell, or tool you run inside a terminal tab — a
  terminal is a shell by design;
- anything requiring a modified VSIX or an untrusted extension host;
- platforms other than Windows x64, which this release does not package;
- reports about modified builds, unless the issue reproduces on the current
  unmodified source tree.

## Disclosure

Please allow time for a fix and a coordinated disclosure before publishing
details. Credit is given on request.
