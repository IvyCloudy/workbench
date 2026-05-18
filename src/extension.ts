import * as vscode from 'vscode';
import { WorkbenchProvider } from './providers/WorkbenchProvider';
import { CsvBrowserProvider } from './providers/CsvBrowserProvider';
import { CsvEditorProvider } from './providers/CsvEditorProvider';
import { isQualifiedCsvFile } from './providers/CsvDocumentProvider';

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

const processingFiles = new Set<string>();

async function openWithCsvEditor(uri: vscode.Uri): Promise<void> {
    const fsPath = uri.fsPath;
    if (processingFiles.has(fsPath)) return;
    processingFiles.add(fsPath);

    try {
        // 关闭当前编辑器
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 100));

        // 用自定义编辑器打开
        await vscode.commands.executeCommand('vscode.openWith', uri, 'csvEditor.testCase');
    } catch (e) {
        console.error('[CSV拦截] 切换编辑器失败:', e);
    } finally {
        processingFiles.delete(fsPath);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const workbenchProvider = new WorkbenchProvider(context.extensionUri, context);
    const csvBrowserProvider = new CsvBrowserProvider(context.extensionUri, context);
    const csvEditorProvider = new CsvEditorProvider(context.extensionUri);

    // 注册自定义CSV编辑器
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('csvEditor.testCase', csvEditorProvider)
    );

    // 监听标签页打开
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (e) => {
            for (const tab of e.opened) {
                const input = tab.input;
                let uri: vscode.Uri | undefined;
                if (input instanceof vscode.TabInputText) {
                    uri = input.uri;
                } else if (input instanceof vscode.TabInputCustom) {
                    uri = input.uri;
                }
                if (uri && isQualifiedCsvFile(uri)) {
                    console.log('[CSV拦截] 标签页打开CSV:', uri.fsPath);
                    await openWithCsvEditor(uri);
                }
            }
        })
    );

    // 监听活动编辑器变化
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                const uri = editor.document.uri;
                console.log('[CSV拦截] 活动编辑器变化:', uri.fsPath);
                if (isQualifiedCsvFile(uri)) {
                    await openWithCsvEditor(uri);
                }
            }
            updateShowIcon();
        })
    );

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(updateShowIcon),
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (uri) {
                const { TestCaseWebviewProvider } = await import('./providers/TestCaseProvider');
                const testcaseProvider = new TestCaseWebviewProvider(context.extensionUri, context);
                await testcaseProvider.showWebview(uri);
            }
        }),
        vscode.commands.registerCommand('workbench.open', () => workbenchProvider.show()),
        vscode.commands.registerCommand('csvBrowser.open', () => csvBrowserProvider.show()),
        vscode.commands.registerCommand('csvEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.csv$/i.test(uri.fsPath)) {
                await openWithCsvEditor(uri);
            }
        })
    );

    updateShowIcon();

    // 插件激活时显示工作台
    try {
        workbenchProvider.show();
    } catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }
}
