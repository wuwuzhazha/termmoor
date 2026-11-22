import * as vscode from 'vscode';
import { TerminalProvider } from './TerminalProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TerminalProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('agentTerminal.view', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('agentTerminal.focus', () => provider.show());
  register('agentTerminal.openSidebar', () => provider.show());
  register('agentTerminal.newSession', () => provider.newSession());
  register('agentTerminal.sendToTerminal', () => provider.sendSelectionOrFile());
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
