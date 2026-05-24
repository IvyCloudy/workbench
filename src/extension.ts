import * as vscode from 'vscode';
import * as path from 'path';
import { WorkbenchProvider } from './providers/WorkbenchProvider';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { TestCaseProvider } from './providers/TestCaseProvider';
import { UnifiedEditorProvider, FileTypeChecker } from './providers/UnifiedEditorProvider';
import { pushTestCase } from './services/http';
import { parseFileToRows } from './parsers';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

// ============================================
// 工具方法
// ============================================

function getActiveFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return undefined;

    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.original;
    return undefined;
}

function isTestCaseFile(uri: vscode.Uri): boolean {
    return FileTypeChecker.isQualifiedFile(uri).qualified;
}

function updateShowIcon(): void {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}

// ============================================
// 文件推送处理
// ============================================

async function handleFilePush(targets: vscode.Uri[], context: vscode.ExtensionContext): Promise<void> {
    for (const target of targets) {
        const filePath = target.fsPath;

        const fileCheck = FileTypeChecker.isQualifiedFile(target);
        if (!fileCheck.qualified) {
            vscode.window.showWarningMessage(`文件不在允许的目录下: ${path.basename(filePath)}`);
            continue;
        }

        const rows = await parseFileToRows(filePath);
        if (!rows || rows.length === 0) {
            vscode.window.showWarningMessage(`文件无数据: ${path.basename(filePath)}`);
            continue;
        }

        console.log(`[推送] 文件: ${filePath}, ${rows.length} 行:\n`, JSON.stringify(rows, null, 2));
        const pushResult = await pushTestCase(context, rows);
        if (pushResult.returnCode === 'SUC0000') {
            vscode.window.showInformationMessage(`推送成功: ${path.basename(filePath)} (${rows.length} 行)`);
        } else {
            vscode.window.showErrorMessage(`推送失败: ${pushResult.errorMsg || '未知错误'}`);
        }
    }
}

// ============================================
// 编辑器命令注册
// ============================================

function registerEditorCommands(
    context: vscode.ExtensionContext,
    extPattern: RegExp
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('testcaseViewer.openWithEditor', async () => {
            const uri = getActiveFileUri();
            if (uri && extPattern.test(uri.fsPath) && isTestCaseFile(uri)) {
                await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
            }
        }),
        vscode.commands.registerCommand('testcaseViewer.openWithText', async () => {
            const uri = getActiveFileUri();
            if (uri && extPattern.test(uri.fsPath)) {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        })
    ];
}

// ============================================
// 激活
// ============================================

export function activate(context: vscode.ExtensionContext) {
    console.log('[Extension] 插件激活中...');

    const workbenchProvider = new WorkbenchProvider(context.extensionUri, context);
    const tableBrowserProvider = new TableBrowserProvider(context.extensionUri, context);
    const testCaseProvider = new TestCaseProvider(context.extensionUri, context);
    const unifiedEditorProvider = new UnifiedEditorProvider(context.extensionUri, context);

    context.subscriptions.push(
        // 自定义编辑器
        // 关键参数：
        //  1. retainContextWhenHidden=true：切换 Tab 时不销毁 webview，避免 webview 频繁销毁/重建造成 "页面互相覆盖" 视觉错觉
        //  2. supportsMultipleEditorsPerDocument=true：允许同一文档在多个 tab group 中独立打开
        vscode.window.registerCustomEditorProvider(
            TESTCASE_EDITOR_VIEWTYPE,
            unifiedEditorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: true,
            }
        ),

        // 全局命令
        vscode.commands.registerCommand('workbench.open', () => workbenchProvider.show()),
        vscode.commands.registerCommand('tableBrowser.open', () => tableBrowserProvider.show()),
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (uri && isTestCaseFile(uri)) {
                await testCaseProvider.showWebview(uri);
            }
        }),

        // 编辑器切换命令
        ...registerEditorCommands(context, /\.(csv|ya?ml|json)$/i),

        // 推送命令
        vscode.commands.registerCommand(
            'testcaseViewer.pushTestCaseFromExplorer',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                try {
                    const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                    await handleFilePush(targets, context);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`推送失败: ${err.message || err}`);
                }
            }
        ),

        // 监听标签页激活变化，更新图标显示
        vscode.window.tabGroups.onDidChangeTabs(() => updateShowIcon())
    );

    updateShowIcon();

    try {
        workbenchProvider.show();
    } catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }

    console.log('[Extension] 插件激活完成');
}

export function deactivate() {
    console.log('[Extension] 插件已停用');
}