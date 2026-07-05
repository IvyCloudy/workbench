/**
 * ============================================================================
 *  extension.ts
 *  插件入口（VS Code 激活/注销）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 在 activate() 中注册自定义编辑器、Webview 命令、右键推送命令、Tab 切换监听等。
 *    2. 决定哪些命令在哪些场景启用（通过 setContext 控制图标显隐）。
 *
 *  较大处理逻辑已拆分至：
 *    - handlers/pushHandler.ts       文件推送
 *    - handlers/fileCreator.ts       文件创建（测试案例 / 测试要点）
 *    - handlers/editorCommands.ts    编辑器切换命令
 *    - handlers/workspaceListeners.ts 工作区文件变化监听（重命名、删除）
 *    - handlers/deletedRowsHandler.ts 已删除行同步
 *    - utils/storageInitializer.ts   存储初始化与孤儿记录清理
 *    - utils/extensionHelpers.ts     公共工具函数
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { TestCaseProvider } from './providers/TestCaseProvider';
import { UnifiedEditorProvider } from './providers/UnifiedEditorProvider';
import { registerBindTaskFeatures } from './providers/BindTaskProvider';
import { showPushErrorModal, showToast } from './utils/message';
import { BaseEditorProvider } from './providers/BaseEditorProvider';
import { TelemetryService } from './utils/telemetry';
import { getActiveFileUri, isTestCaseFile, updateShowIcon, telemetryErrProps } from './utils/extensionHelpers';
import { registerEditorCommands } from './handlers/editorCommands';
import { handleFilePush } from './handlers/pushHandler';
import { handleCreateNewTestCase, handleCreateNewTestPoint } from './handlers/fileCreator';
import { handleSyncDeletedRows } from './handlers/deletedRowsHandler';
import { registerWorkspaceListeners } from './handlers/workspaceListeners';
import { handleClearHighlight } from './handlers/clearHighlightHandler';
import { initializeStorages, cleanupOrphanedRecords } from './utils/storageInitializer';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

export async function activate(context: vscode.ExtensionContext) {
    const _activateStart = Date.now();
    console.log('[Extension] 插件激活中...');

    // 埋点初始化（必须尽早，且尊重用户 telemetry 设置）
    TelemetryService.init(context).catch(err => {
        console.warn('[Extension] 初始化埋点失败（已忽略）:', err?.message || err);
    });

    // 全局未捕获异常上报（兜底）
    process.on('unhandledRejection', (reason: any) => {
        try { TelemetryService.sendTelemetryErrorEvent('extension.unhandledRejection', telemetryErrProps(reason)); } catch (_) { /* ignore */ }
    });

    // 初始化各存储文件 + 清理孤儿记录
    await initializeStorages(context);
    try {
        await cleanupOrphanedRecords();
    } catch (err: any) {
        console.error('[Extension] 清理已删除文件记录失败:', err?.message || err);
    }

    // 注册核心功能
    const bindTaskDisposables = registerBindTaskFeatures(context);
    const tableBrowserProvider = new TableBrowserProvider(context.extensionUri, context);
    const testCaseProvider = new TestCaseProvider(context.extensionUri, context);
    const unifiedEditorProvider = new UnifiedEditorProvider(context.extensionUri, context);

    // 工作区监听器
    const workspaceListeners = registerWorkspaceListeners();

    // Tab 切换监听
    const tabChangeListener = vscode.window.tabGroups.onDidChangeTabs(() => updateShowIcon());

    context.subscriptions.push(
        ...bindTaskDisposables,
        ...workspaceListeners,
        tabChangeListener,

        // ---- 自定义编辑器 ----
        vscode.window.registerCustomEditorProvider(
            TESTCASE_EDITOR_VIEWTYPE,
            unifiedEditorProvider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: true,
            }
        ),

        // ---- 全局命令 ----
        vscode.commands.registerCommand('tableBrowser.open', () => {
            TelemetryService.sendTelemetryEvent('command.executed', { command: 'tableBrowser.open' });
            try {
                return tableBrowserProvider.show();
            } catch (err: any) {
                TelemetryService.sendTelemetryErrorEvent('command.tableBrowser.open.error', telemetryErrProps(err));
                throw err;
            }
        }),

        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (!uri) {
                TelemetryService.sendTelemetryEvent('command.aborted', { command: 'testcaseViewer.viewOnline', reason: 'noActiveFile' });
                return;
            }
            if (!isTestCaseFile(uri)) {
                TelemetryService.sendTelemetryEvent('command.aborted', { command: 'testcaseViewer.viewOnline', reason: 'notTestCaseFile' });
                return;
            }
            TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.viewOnline' });
            try {
                await testCaseProvider.showWebview(uri);
            } catch (err: any) {
                TelemetryService.sendTelemetryErrorEvent('command.viewOnline.error', telemetryErrProps(err));
                throw err;
            }
        }),

        // ---- 编辑器切换命令 ----
        ...registerEditorCommands(context, /\.(csv|ya?ml|json)$/i),

        // ---- 推送命令 ----
        vscode.commands.registerCommand(
            'testcaseViewer.pushTestCaseFromExplorer',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.pushTestCaseFromExplorer' });
                try {
                    await handleFilePush(targets, context);
                } catch (err: any) {
                    const baseName = targets[0] ? path.basename(targets[0].fsPath) : '';
                    const panel = targets[0] ? BaseEditorProvider.getPanel(targets[0].fsPath) : undefined;
                    TelemetryService.sendTelemetryErrorEvent('explorerPush.commandError', telemetryErrProps(err));
                    showPushErrorModal(panel, baseName, `推送失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 新增测试案例（右键子菜单 - CSV） ----
        vscode.commands.registerCommand(
            'testcaseViewer.createNewTestCaseCsv',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.createNewTestCaseCsv' });
                try {
                    await handleCreateNewTestCase(targets, context, '.csv');
                } catch (err: any) {
                    showToast(undefined, 'error', `创建测试案例失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 新增测试案例（右键子菜单 - YAML） ----
        vscode.commands.registerCommand(
            'testcaseViewer.createNewTestCaseYaml',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.createNewTestCaseYaml' });
                try {
                    await handleCreateNewTestCase(targets, context, '.yaml');
                } catch (err: any) {
                    showToast(undefined, 'error', `创建测试案例失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 新增测试案例（命令面板入口） ----
        vscode.commands.registerCommand(
            'testcaseViewer.createNewTestCase',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.createNewTestCase' });
                try {
                    await handleCreateNewTestCase(targets, context);
                } catch (err: any) {
                    TelemetryService.sendTelemetryErrorEvent('createNewTestCase.commandError', telemetryErrProps(err));
                    showToast(undefined, 'error', `创建测试案例失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 清理文件高亮（含失败标记、快照、删除行追踪、手动标记） ----
        vscode.commands.registerCommand(
            'testcaseViewer.clearHighlight',
            async (uri: vscode.Uri) => {
                await handleClearHighlight(uri);
            }
        ),

        // ---- 快速创建测试案例（命令面板） ----
        vscode.commands.registerCommand(
            'testcaseViewer.createNewTestCaseQuick',
            async () => {
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.createNewTestCaseQuick' });

                const activeUri = getActiveFileUri();
                let targetUri: vscode.Uri | undefined;

                if (activeUri) {
                    if (activeUri.fsPath.includes('测试案例')) {
                        const stats = await fs.promises.stat(activeUri.fsPath);
                        if (stats.isFile()) {
                            targetUri = vscode.Uri.file(path.dirname(activeUri.fsPath));
                        } else {
                            targetUri = activeUri;
                        }
                    }
                }

                if (!targetUri) {
                    showToast(undefined, 'warning', '请在测试案例目录下使用此命令，或在资源管理器中右键点击测试案例文件夹');
                    return;
                }

                try {
                    await handleCreateNewTestCase([targetUri], context);
                } catch (err: any) {
                    TelemetryService.sendTelemetryErrorEvent('createNewTestCaseQuick.commandError', telemetryErrProps(err));
                    showToast(undefined, 'error', `创建测试案例失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 新增测试要点 ----
        vscode.commands.registerCommand(
            'testcaseViewer.createNewTestPoint',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.createNewTestPoint' });
                try {
                    await handleCreateNewTestPoint(targets, context);
                } catch (err: any) {
                    showToast(undefined, 'error', `创建测试要点失败: ${err.message || err}`);
                }
            }
        ),

        // ---- 已删除行同步 ----
        vscode.commands.registerCommand(
            'workbench.syncDeletedRows',
            async () => {
                await handleSyncDeletedRows();
            }
        ),
    );

    updateShowIcon();
    console.log('[Extension] 插件激活完成');
    TelemetryService.sendTelemetryEvent('extension.activate.done', { activateMs: String(Date.now() - _activateStart) });
}

export function deactivate() {
    console.log('[Extension] 插件已停用');
    try { TelemetryService.sendTelemetryEvent('extension.deactivate', {}); } catch (_) { /* ignore */ }
}
