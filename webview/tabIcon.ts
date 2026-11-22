/**
 * Lightweight inline SVG icons for terminal tabs based on the active process
 * or agent name (`pi`, `claude`, `codex`, `opencode`, `python`, `node`, `git`, `shell`).
 */

const ICON_SVG: Record<string, string> = {
  pi: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M6 4.5v7.5M10.5 4.5v6.2c0 1 .6 1.3 1.5 1.3"/></svg>',
  claude:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 1.5l1.4 3.8 3.9.4-3 2.5.9 3.9L8 10l-3.2 2.1.9-3.9-3-2.5 3.9-.4z"/></svg>',
  codex:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5L2.5 8l3 3.5M10.5 4.5L13.5 8l-3 3.5M9 3.5l-2 9"/></svg>',
  opencode:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5.5 6.5L7.5 8 5.5 9.5M8.5 9.5h2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  python:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5.5 4.5c0-1.1.9-2 2.5-2s2.5.9 2.5 2v2.2H5.5c-1.4 0-2.5.9-2.5 2.3s1.1 2.3 2.5 2.3h1"/><path d="M10.5 11.5c0 1.1-.9 2-2.5 2s-2.5-.9-2.5-2V9.3h5c1.4 0 2.5-.9 2.5-2.3s-1.1-2.3-2.5-2.3h-1"/></svg>',
  node:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M8 2l5 2.9v6.2L8 14l-5-2.9V4.9z"/><path d="M8 5.5v5"/></svg>',
  shell:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5L7 8l-3.5 3.5M8 11.5h4.5"/></svg>'
};

function matchKind(candidate: string | undefined): keyof typeof ICON_SVG | undefined {
  if (!candidate) {
    return undefined;
  }
  const lower = candidate.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }
  if (lower === 'pi' || lower.startsWith('pi ') || lower.startsWith('π')) {
    return 'pi';
  }
  if (lower.includes('claude')) {
    return 'claude';
  }
  if (lower.includes('codex')) {
    return 'codex';
  }
  if (lower.includes('opencode')) {
    return 'opencode';
  }
  if (lower.includes('python') || lower === 'py' || lower.startsWith('pytest') || lower === 'uv') {
    return 'python';
  }
  if (lower === 'node' || lower === 'npm' || lower === 'pnpm' || lower === 'bun') {
    return 'node';
  }
  return undefined;
}

export function tabIconKind(title: string, processHint?: string): keyof typeof ICON_SVG {
  return matchKind(processHint) ?? matchKind(title) ?? 'shell';
}

export function tabIconSvg(title: string, processHint?: string): string {
  return ICON_SVG[tabIconKind(title, processHint)];
}
