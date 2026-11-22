/**
 * Pure OSC 133 (FinalTerm / VS Code shell integration) state tracker.
 *
 * Sequences emitted by the shell hooks:
 *  - `133;A`            Prompt start
 *  - `133;B`            Command input start (end of prompt)
 *  - `133;C`            Command execution / output start
 *  - `133;D` / `133;D;<code>` Command finished with optional exit code
 *
 * Line positions are tracked via caller-supplied marker handles so xterm buffer
 * trimming updates line numbers automatically without coupling this module to
 * browser globals.
 */

export interface LineAnchor {
  /** Current 0-based buffer line, or `-1` when trimmed out of scrollback. */
  readonly line: number;
  readonly isDisposed?: boolean;
  dispose(): void;
}

export interface CompletedCommandEvent {
  durationMs: number;
  exitCode?: number;
  outputStartLine: number;
  outputEndLine: number;
}

interface TrackedBlock {
  promptAnchor: LineAnchor;
  inputAnchor?: LineAnchor;
  outputAnchor?: LineAnchor;
  endAnchor?: LineAnchor;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
}

const MAX_TRACKED_BLOCKS = 200;

export function parseOsc133Payload(data: string): {
  kind: 'A' | 'B' | 'C' | 'D';
  exitCode?: number;
} | null {
  if (!data) {
    return null;
  }
  const parts = data.split(';');
  const kind = parts[0]?.trim().toUpperCase();
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') {
    return null;
  }
  if (kind === 'D' && parts[1] !== undefined && parts[1].trim() !== '') {
    const parsed = Number.parseInt(parts[1].trim(), 10);
    if (Number.isFinite(parsed)) {
      return { kind: 'D', exitCode: parsed };
    }
  }
  return { kind };
}

export type Osc633Event =
  | { kind: 'command'; command: string }
  | { kind: 'cwd'; cwd: string };

/**
 * Parse VS Code / Terminal Pro OSC 633 payloads:
 *  - `633;E;<commandLine>` -> foreground command started
 *  - `633;P;Cwd=<path>`    -> current working directory updated
 */
export function parseOsc633Payload(data: string): Osc633Event | null {
  if (!data) {
    return null;
  }
  const semi = data.indexOf(';');
  if (semi < 0) {
    return null;
  }
  const kind = data.slice(0, semi).trim().toUpperCase();
  const rest = data.slice(semi + 1);
  if (kind === 'E') {
    const cmd = rest.trim();
    return cmd ? { kind: 'command', command: cmd } : null;
  }
  if (kind === 'P') {
    const eq = rest.indexOf('=');
    if (eq > 0 && rest.slice(0, eq).trim().toLowerCase() === 'cwd') {
      const cwd = rest.slice(eq + 1).trim();
      return cwd ? { kind: 'cwd', cwd } : null;
    }
  }
  return null;
}

export class CommandBlockTracker {
  private readonly blocks: TrackedBlock[] = [];
  private active: TrackedBlock | null = null;

  constructor(
    private readonly createAnchor: () => LineAnchor | undefined,
    private readonly now: () => number = () => Date.now()
  ) {}

  handleOsc133(data: string): CompletedCommandEvent | null {
    const parsed = parseOsc133Payload(data);
    if (!parsed) {
      return null;
    }
    this.pruneDisposed();

    switch (parsed.kind) {
      case 'A': {
        const anchor = this.createAnchor();
        if (!anchor) {
          return null;
        }
        const block: TrackedBlock = { promptAnchor: anchor };
        this.blocks.push(block);
        this.active = block;
        while (this.blocks.length > MAX_TRACKED_BLOCKS) {
          const oldest = this.blocks.shift();
          this.disposeBlock(oldest);
        }
        return null;
      }
      case 'B': {
        if (this.active) {
          this.active.inputAnchor?.dispose();
          this.active.inputAnchor = this.createAnchor();
        }
        return null;
      }
      case 'C': {
        if (!this.active) {
          const fallback = this.createAnchor();
          if (!fallback) {
            return null;
          }
          this.active = { promptAnchor: fallback };
          this.blocks.push(this.active);
        }
        this.active.outputAnchor?.dispose();
        this.active.outputAnchor = this.createAnchor();
        this.active.startedAt = this.now();
        return null;
      }
      case 'D': {
        const current = this.active;
        if (!current) {
          return null;
        }
        current.endAnchor?.dispose();
        current.endAnchor = this.createAnchor();
        current.finishedAt = this.now();
        current.exitCode = parsed.exitCode;
        // Only emit a completion event when a command actually executed (`C` was seen).
        if (current.startedAt === undefined) {
          return null;
        }
        const durationMs = Math.max(0, current.finishedAt - current.startedAt);
        const startLine = this.outputStartLineOf(current);
        const endLine = current.endAnchor?.line ?? -1;
        return {
          durationMs,
          exitCode: parsed.exitCode,
          outputStartLine: startLine,
          outputEndLine: endLine
        };
      }
    }
  }

  /** Sorted, deduplicated 0-based prompt lines still present in scrollback. */
  promptLines(): number[] {
    this.pruneDisposed();
    const lines: number[] = [];
    for (const block of this.blocks) {
      const line = block.promptAnchor.line;
      if (line >= 0 && (lines.length === 0 || lines[lines.length - 1] !== line)) {
        lines.push(line);
      }
    }
    return lines.sort((a, b) => a - b);
  }

  /**
   * Line range `[startLine, endLineExclusive)` of the most recent executed
   * command's output, or `null` if no command output has been recorded yet.
   */
  lastOutputRange(currentCursorLine: number): { startLine: number; endLineExclusive: number } | null {
    this.pruneDisposed();
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (!block.outputAnchor && block.startedAt === undefined) {
        continue;
      }
      const start = this.outputStartLineOf(block);
      if (start < 0) {
        continue;
      }
      const end =
        block.endAnchor && block.endAnchor.line >= 0
          ? block.endAnchor.line
          : currentCursorLine;
      if (end >= start) {
        return { startLine: start, endLineExclusive: end };
      }
    }
    return null;
  }

  reset(): void {
    for (const block of this.blocks) {
      this.disposeBlock(block);
    }
    this.blocks.length = 0;
    this.active = null;
  }

  private outputStartLineOf(block: TrackedBlock): number {
    if (block.outputAnchor && block.outputAnchor.line >= 0) {
      // `133;C` is written right after the user presses Enter on the prompt
      // line; if it sits on the same row as the prompt/input, step to the next
      // row so the prompt text itself is excluded from the captured output.
      const promptLine = block.inputAnchor?.line ?? block.promptAnchor.line;
      const raw = block.outputAnchor.line;
      return raw === promptLine ? raw + 1 : raw;
    }
    const base = block.inputAnchor?.line ?? block.promptAnchor.line;
    return base >= 0 ? base + 1 : -1;
  }

  private pruneDisposed(): void {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const anchor = this.blocks[i].promptAnchor;
      if (anchor.isDisposed || anchor.line < 0) {
        const [removed] = this.blocks.splice(i, 1);
        if (removed === this.active) {
          this.active = null;
        }
        this.disposeBlock(removed);
      }
    }
  }

  private disposeBlock(block: TrackedBlock | undefined): void {
    if (!block) {
      return;
    }
    block.promptAnchor.dispose();
    block.inputAnchor?.dispose();
    block.outputAnchor?.dispose();
    block.endAnchor?.dispose();
  }
}

/**
 * Pick the target prompt line when jumping up (`-1`) or down (`1`) from
 * `referenceLine`.
 */
export function findAdjacentPromptLine(
  promptLines: readonly number[],
  referenceLine: number,
  direction: -1 | 1
): number | undefined {
  if (promptLines.length === 0) {
    return undefined;
  }
  if (direction < 0) {
    for (let i = promptLines.length - 1; i >= 0; i -= 1) {
      if (promptLines[i] < referenceLine) {
        return promptLines[i];
      }
    }
    return promptLines[0];
  }
  for (let i = 0; i < promptLines.length; i += 1) {
    if (promptLines[i] > referenceLine) {
      return promptLines[i];
    }
  }
  return promptLines[promptLines.length - 1];
}
