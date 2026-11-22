import * as vscode from 'vscode';

export interface TerminalCapture {
  command: string;
  output: string;
  truncated: boolean;
}

/**
 * Captures the output of the most recent shell-integration command per
 * terminal. VS Code exposes output as a one-shot async iterable on the start
 * event, so it must be consumed immediately or the data is lost.
 */
export class TerminalOutputTracker implements vscode.Disposable {
  private readonly captures = new WeakMap<vscode.Terminal, TerminalCapture>();
  private readonly active = new Map<vscode.TerminalShellExecution, TerminalCapture>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly maxChars = 200_000) {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => this.start(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.active.delete(event.execution);
      })
    );
  }

  capture(terminal: vscode.Terminal | undefined): TerminalCapture | undefined {
    if (!terminal) {
      return undefined;
    }
    const capture = this.captures.get(terminal);
    return capture && capture.output.trim() ? capture : undefined;
  }

  private start(event: vscode.TerminalShellExecutionStartEvent): void {
    const capture: TerminalCapture = {
      command: event.execution.commandLine.value,
      output: '',
      truncated: false
    };
    this.active.set(event.execution, capture);
    this.captures.set(event.terminal, capture);
    void this.read(event.execution, capture);
  }

  private async read(
    execution: vscode.TerminalShellExecution,
    capture: TerminalCapture
  ): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        if (capture.truncated) {
          continue;
        }
        const remaining = this.maxChars - capture.output.length;
        if (remaining <= 0) {
          capture.truncated = true;
          continue;
        }
        capture.output += chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
        if (chunk.length > remaining) {
          capture.truncated = true;
        }
      }
    } catch {
      // The output stream can be torn down when the terminal closes.
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.active.clear();
  }
}
