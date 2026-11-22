import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TerminalCommand } from '../shared/protocol';

const POWERSHELL_INTEGRATION_SCRIPT = `
$global:__tpOrigPrompt = $function:prompt
$global:__tpCmdRun = $false
function global:prompt {
  $__tpOk = $?
  $__tpCode = if (-not $__tpOk) { if ($global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 1 } } else { 0 }
  $__tpEsc = [char]27
  $__tpBel = [char]7
  $__tpCwd = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
  $__tpCwdSeq = if ($__tpCwd) { "\${__tpEsc}]633;P;Cwd=\${__tpCwd}\${__tpBel}" } else { "" }
  $__tpBody = if ($global:__tpOrigPrompt) { & $global:__tpOrigPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
  if ($global:__tpCmdRun) {
    $global:__tpCmdRun = $false
    "\${__tpEsc}]133;D;\${__tpCode}\${__tpBel}\${__tpCwdSeq}\${__tpEsc}]133;A\${__tpBel}\${__tpBody}\${__tpEsc}]133;B\${__tpBel}"
  } else {
    "\${__tpCwdSeq}\${__tpEsc}]133;A\${__tpBel}\${__tpBody}\${__tpEsc}]133;B\${__tpBel}"
  }
}
if (Test-Path Function:\\PSConsoleHostReadLine) {
  $global:__tpOrigRead = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $__tpLine = & $global:__tpOrigRead
    if ($__tpLine -and $__tpLine.Trim().Length -gt 0) {
      $global:__tpCmdRun = $true
      $__tpClean = ($__tpLine -replace '[\\x00-\\x1f\\x7f;]', ' ').Trim()
      if ($__tpClean.Length -gt 120) { $__tpClean = $__tpClean.Substring(0, 120) }
      [Console]::Write("$([char]27)]633;E;$__tpClean$([char]7)$([char]27)]133;C$([char]7)")
    }
    $__tpLine
  }
}
`.trim();

const BASH_INTEGRATION_SCRIPT = `
if [ -f /etc/profile ]; then . /etc/profile; fi
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
__tp_cmd_run=0
__tp_preexec() {
  __tp_cmd_run=1
  local clean="\${BASH_COMMAND//[;\\r\\n]/ }"
  printf '\\033]633;E;%s\\007\\033]133;C\\007' "\${clean:0:120}"
}
__tp_precmd() {
  local code=$?
  if [ "$__tp_cmd_run" = "1" ]; then
    __tp_cmd_run=0
    printf '\\033]133;D;%s\\007' "$code"
  fi
  printf '\\033]633;P;Cwd=%s\\007\\033]133;A\\007' "$PWD"
}
PS0='$(__tp_preexec)'
if [[ -z "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND="__tp_precmd"
else
  PROMPT_COMMAND="__tp_precmd;$PROMPT_COMMAND"
fi
PS1="\${PS1}\\[\\033]133;B\\007\\]"
`.trim();

const ZSH_INTEGRATION_SCRIPT = `
if [[ -n "$__TP_ORIG_ZDOTDIR" ]]; then
  ZDOTDIR="$__TP_ORIG_ZDOTDIR"
  unset __TP_ORIG_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]]; then
  source "\${ZDOTDIR:-$HOME}/.zshrc"
fi
autoload -Uz add-zsh-hook
typeset -g __tp_cmd_run=0
__tp_precmd() {
  local code=$?
  if (( __tp_cmd_run )); then
    __tp_cmd_run=0
    builtin print -n "\\e]133;D;\${code}\\a"
  fi
  builtin print -n "\\e]633;P;Cwd=\${PWD}\\a\\e]133;A\\a"
}
__tp_line_init() {
  builtin print -n "\\e]133;B\\a"
}
__tp_preexec() {
  __tp_cmd_run=1
  local clean="\${1//[;\\r\\n]/ }"
  builtin print -n "\\e]633;E;\${clean[1,120]}\\a\\e]133;C\\a"
}
add-zsh-hook precmd __tp_precmd
add-zsh-hook preexec __tp_preexec
zle -N zle-line-init __tp_line_init
`.trim();

export interface BuildShellOptions {
  cwd: string;
  enableIntegration?: boolean;
  integrationDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function buildShellCommand(options: BuildShellOptions): TerminalCommand {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.env ?? process.env;
  const integrate = options.enableIntegration !== false;

  if (platform === 'win32') {
    if (!integrate) {
      return { file: 'powershell.exe', args: ['-NoLogo'], cwd: options.cwd };
    }
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoExit',
        '-Command',
        'if ($env:__TP_INIT) { . ([ScriptBlock]::Create($env:__TP_INIT)); Remove-Item Env:__TP_INIT -ErrorAction SilentlyContinue }'
      ],
      env: { __TP_INIT: POWERSHELL_INTEGRATION_SCRIPT },
      cwd: options.cwd
    };
  }

  const shell = hostEnv.SHELL || '/bin/bash';
  const base = path.basename(shell).toLowerCase();

  if (integrate && options.integrationDir) {
    if (base === 'bash') {
      try {
        const rcFile = path.join(options.integrationDir, 'tp-bashrc.sh');
        fs.writeFileSync(rcFile, BASH_INTEGRATION_SCRIPT, { encoding: 'utf8', mode: 0o600 });
        return { file: shell, args: ['--rcfile', rcFile], cwd: options.cwd };
      } catch {
        // Fall back to plain login shell.
      }
    }
    if (base === 'zsh') {
      try {
        const zdot = path.join(options.integrationDir, 'zsh');
        fs.mkdirSync(zdot, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(zdot, '.zshrc'), ZSH_INTEGRATION_SCRIPT, {
          encoding: 'utf8',
          mode: 0o600
        });
        const env: Record<string, string> = { ZDOTDIR: zdot };
        if (hostEnv.ZDOTDIR) {
          env.__TP_ORIG_ZDOTDIR = hostEnv.ZDOTDIR;
        }
        return { file: shell, args: ['-i'], env, cwd: options.cwd };
      } catch {
        // Fall back to plain login shell.
      }
    }
  }

  return { file: shell, args: ['-l'], cwd: options.cwd };
}

const IGNORED_TITLES = new Set([
  'xterm-256color',
  'xterm',
  'select',
  'windows powershell',
  'administrator: windows powershell',
  '管理员: windows powershell'
]);

const WRAPPER_COMMANDS = new Set(['sudo', 'env', 'npx', 'bunx', 'pnpx', 'time', 'nice']);

/**
 * Extract the foreground program name from an executed shell command line
 * (e.g. `& "C:\tools\pi.cmd" --resume` -> `pi`, `npx claude` -> `claude`).
 */
export function extractCommandProgram(commandLine: string | undefined): string | undefined {
  const raw = String(commandLine ?? '').trim();
  if (!raw) {
    return undefined;
  }
  // Strip PowerShell call operators (`&`, `.`) at the beginning
  const cleaned = raw.replace(/^[&.][\s]+/, '').trim();
  const tokens = cleaned.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];

  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, '').trim();
    if (!token) {
      continue;
    }
    // Skip POSIX env assignments like `FOO=bar` or PowerShell `$env:FOO=...`
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || /^\$env:/i.test(token)) {
      continue;
    }
    // Skip flags like `--yes` passed to `npx --yes claude`
    if (token.startsWith('-')) {
      continue;
    }
    const base = (token.split(/[\\/]/).pop() ?? token)
      .replace(/\.(exe|cmd|bat|ps1|sh|mjs|cjs|js|py)$/i, '')
      .trim();
    if (!base) {
      continue;
    }
    if (WRAPPER_COMMANDS.has(base.toLowerCase())) {
      continue;
    }
    return normalizeProcessTitle(base, '');
  }
  return undefined;
}

/**
 * Clean a raw process path or xterm title into a short tab label
 * (e.g. `C:\Windows\...\powershell.exe` -> `pwsh`, `π - E:\Xcp` -> `pi`).
 */
export function normalizeProcessTitle(raw: string | undefined, fallback = 'shell'): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.includes('__TP_INIT') || trimmed.startsWith('Select ')) {
    return fallback;
  }
  const lowerTrimmed = trimmed.toLowerCase();
  if (IGNORED_TITLES.has(lowerTrimmed)) {
    return fallback;
  }
  // Detect well-known TUI window titles (`π - ...`, `Claude Code ...`)
  if (trimmed.startsWith('π') || /^pi(\s|$|-|·)/i.test(trimmed)) {
    return 'pi';
  }
  if (/claude/i.test(trimmed)) {
    return 'claude';
  }
  if (/codex/i.test(trimmed)) {
    return 'codex';
  }
  if (/opencode/i.test(trimmed)) {
    return 'opencode';
  }

  // Strip Windows console prefix like `管理员: ` or `Administrator: `
  const withoutAdmin = trimmed.replace(/^(?:Administrator|管理员)\s*:\s*/i, '').trim();
  if (IGNORED_TITLES.has(withoutAdmin.toLowerCase())) {
    return fallback;
  }

  const token = withoutAdmin.split(/[\\/]/).pop()?.trim() ?? withoutAdmin;
  const stripped = token.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').trim();
  if (!stripped || IGNORED_TITLES.has(stripped.toLowerCase())) {
    return fallback;
  }
  const lower = stripped.toLowerCase();
  if (lower === 'powershell' || lower === 'windowspowershell') {
    return 'pwsh';
  }
  return stripped.length > 18 ? `${stripped.slice(0, 17)}…` : stripped;
}
