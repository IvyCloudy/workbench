import * as vscode from 'vscode';
import { TestCaseWebviewProvider } from './providers/TestCaseProvider';
import { WorkbenchProvider } from './providers/WorkbenchProvider';

function getActiveFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return;
    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    return;
}

function isTestCaseFile(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && /testcases?\.csv$/i.test(uri.fsPath);
}

function updateShowIcon(): void {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}

export function activate(context: vscode.ExtensionContext) {
    const testcaseProvider = new TestCaseWebviewProvider(context.extensionUri, context);

    const workbenchProvider = new WorkbenchProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateShowIcon),
        vscode.window.tabGroups.onDidChangeTabs(updateShowIcon)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (!uri) return;
            await testcaseProvider.showWebview(uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('workbench.open', () => {
            workbenchProvider.show();
        })
    );

    updateShowIcon();

    try {
        workbenchProvider.show();
    } catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }
}
