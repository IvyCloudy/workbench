import * as vscode from 'vscode';
import { TestCaseWebviewProvider } from './providers/TestCaseProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new TestCaseWebviewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            const isMatch = editor && editor.document.uri.scheme === 'file' &&
                /testcases?\.csv$/i.test(editor.document.uri.fsPath);
            vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!isMatch);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await provider.showWebview(editor.document.uri);
        })
    );

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const isMatch = editor.document.uri.scheme === 'file' &&
            /testcases?\.csv$/i.test(editor.document.uri.fsPath);
        vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!isMatch);
    }
}
