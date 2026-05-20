import * as vscode from 'vscode';
import { WorkbenchProvider } from './providers/WorkbenchProvider';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { CsvEditorProvider, isQualifiedCsvFile } from './providers/CsvDocumentProvider';
import { YamlEditorProvider, isQualifiedYamlFile } from './providers/YamlDocumentProvider';
import { JsonEditorProvider, isQualifiedJsonFile } from './providers/JsonDocumentProvider';

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
// 记录用户主动用 TextEditor 打开的文件路径
// 一旦用户主动用 TextEditor 打开，当前会话中不再自动切换回插件
const userOpenedAsTextFiles = new Set<string>();

export function markUserOpenedAsText(fsPath: string): void {
    userOpenedAsTextFiles.add(fsPath);
}

export function isUserOpenedAsText(uri: vscode.Uri): boolean {
    return userOpenedAsTextFiles.has(uri.fsPath);
}

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

async function openWithYamlEditor(uri: vscode.Uri): Promise<void> {
    const fsPath = uri.fsPath;
    if (processingFiles.has(fsPath)) return;
    processingFiles.add(fsPath);

    try {
        // 关闭当前编辑器
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 100));

        // 用自定义编辑器打开
        await vscode.commands.executeCommand('vscode.openWith', uri, 'yamlEditor.testCase');
    } catch (e) {
        console.error('[YAML拦截] 切换编辑器失败:', e);
    } finally {
        processingFiles.delete(fsPath);
    }
}

async function openWithJsonEditor(uri: vscode.Uri): Promise<void> {
    const fsPath = uri.fsPath;
    if (processingFiles.has(fsPath)) return;
    processingFiles.add(fsPath);

    try {
        // 关闭当前编辑器
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 100));

        // 用自定义编辑器打开
        await vscode.commands.executeCommand('vscode.openWith', uri, 'jsonEditor.testCase');
    } catch (e) {
        console.error('[JSON拦截] 切换编辑器失败:', e);
    } finally {
        processingFiles.delete(fsPath);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const workbenchProvider = new WorkbenchProvider(context.extensionUri, context);
    const tableBrowserProvider = new TableBrowserProvider(context.extensionUri, context);
    const csvEditorProvider = new CsvEditorProvider(context.extensionUri, context);
    const yamlEditorProvider = new YamlEditorProvider(context.extensionUri, context);
    const jsonEditorProvider = new JsonEditorProvider(context.extensionUri, context);

    // 注册自定义编辑器
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('csvEditor.testCase', csvEditorProvider),
        vscode.window.registerCustomEditorProvider('yamlEditor.testCase', yamlEditorProvider),
        vscode.window.registerCustomEditorProvider('jsonEditor.testCase', jsonEditorProvider)
    );

    // 监听标签页变化
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (e) => {
            // 标签关闭时清除标记，再次打开时恢复自动切换
            for (const tab of e.closed) {
                const input = tab.input;
                let uri: vscode.Uri | undefined;
                if (input instanceof vscode.TabInputText) uri = input.uri;
                else if (input instanceof vscode.TabInputCustom) uri = input.uri;
                if (uri) {
                    if (/\.csv$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                    if (/\.ya?ml$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                    if (/\.json$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                }
            }
            for (const tab of e.opened) {
                const input = tab.input;
                let uri: vscode.Uri | undefined;
                if (input instanceof vscode.TabInputText) {
                    uri = input.uri;
                } else if (input instanceof vscode.TabInputCustom) {
                    uri = input.uri;
                }
                if (uri) {
                    if (isQualifiedCsvFile(uri)) {
                        // 如果用户主动用 TextEditor 打开，不切换
                        if (isUserOpenedAsText(uri)) {
                            console.log('[CSV拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[CSV拦截] 标签页打开CSV:', uri.fsPath);
                        await openWithCsvEditor(uri);
                    } else if (isQualifiedYamlFile(uri)) {
                        if (isUserOpenedAsText(uri)) {
                            console.log('[YAML拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[YAML拦截] 标签页打开YAML:', uri.fsPath);
                        await openWithYamlEditor(uri);
                    } else if (isQualifiedJsonFile(uri)) {
                        if (isUserOpenedAsText(uri)) {
                            console.log('[JSON拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[JSON拦截] 标签页打开JSON:', uri.fsPath);
                        await openWithJsonEditor(uri);
                    }
                }
            }
        })
    );

    // 监听活动编辑器变化
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                const uri = editor.document.uri;
                console.log('[编辑器拦截] 活动编辑器变化:', uri.fsPath);
                // 如果用户主动用 TextEditor 打开，不切换
                if (isUserOpenedAsText(uri)) {
                    console.log('[编辑器拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                    updateShowIcon();
                    return;
                }
                if (isQualifiedCsvFile(uri)) {
                    await openWithCsvEditor(uri);
                } else if (isQualifiedYamlFile(uri)) {
                    await openWithYamlEditor(uri);
                } else if (isQualifiedJsonFile(uri)) {
                    await openWithJsonEditor(uri);
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
        vscode.commands.registerCommand('tableBrowser.open', () => tableBrowserProvider.show()),
        vscode.commands.registerCommand('csvEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.csv$/i.test(uri.fsPath)) {
                await openWithCsvEditor(uri);
            }
        }),
        vscode.commands.registerCommand('csvEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.csv$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('csvEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('yamlEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.ya?ml$/i.test(uri.fsPath)) {
                await openWithYamlEditor(uri);
            }
        }),
        vscode.commands.registerCommand('yamlEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.ya?ml$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('yamlEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('jsonEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.json$/i.test(uri.fsPath)) {
                await openWithJsonEditor(uri);
            }
        }),
        vscode.commands.registerCommand('jsonEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.json$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('jsonEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
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
