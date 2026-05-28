/**
 * ============================================================================
 *  extension.ts
 *  插件入口（VS Code 激活/注销）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 在 activate() 中注册自定义编辑器、Webview 命令、右键推送命令、Tab 切换监听等。
 *    2. 决定哪些命令在哪些场景启用（通过 setContext 控制图标显隐）。
 *    3. 处理资源管理器右键「推送测试案例」入口（handleFilePush）。
 *  设计要点：
 *    - 自定义编辑器使用 retainContextWhenHidden=true，避免切 Tab 时 webview 被销毁。
 *    - 推送结果一律走 PushResultProvider.showPushResult()，与编辑器内推送行为一致。
 *    - testTaskNo / subTestTaskName 一律通过 services/utils.resolveTaskInfo() 解析，
 *      不在本文件做路径解析。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { TestCaseProvider } from './providers/TestCaseProvider';
import { UnifiedEditorProvider, FileTypeChecker } from './providers/UnifiedEditorProvider';
import { pushTestCase } from './services/http';
import { applyTestCaseNos, createParser, detectFileType, ensureTrackingColumns, parseFileToRows } from './parsers';
import { resolveTaskInfo } from './services/utils';
import { showPushResult } from './providers/PushResultProvider';

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

/**
 * 资源管理器右键「推送测试案例」入口。
 *
 * 流程：
 *   1. 校验文件是否在合规目录下（测试任务/<task>/测试案例/...）。
 *   2. resolveTaskInfo 解析 testTaskNo / subTestTaskName。
 *   3. parseFileToRows 解析为推送用二维数组（CSV/YAML/JSON 透明）。
 *   4. pushTestCase 调后端，按返回逐条分类（成功/失败）。
 *   5. 成功项按 tsId 回写 testCaseNo 到原文件。
 *   6. 通过 showPushResult 统一展示结果。
 *
 * 多文件选中时按数组依次处理；单个失败不影响后续。
 */
async function handleFilePush(targets: vscode.Uri[], context: vscode.ExtensionContext): Promise<void> {
    for (const target of targets) {
        const filePath = target.fsPath;

        const fileCheck = FileTypeChecker.isQualifiedFile(target);
        if (!fileCheck.qualified) {
            vscode.window.showWarningMessage(`文件不在允许的目录下: ${path.basename(filePath)}`);
            continue;
        }

        const r = resolveTaskInfo(filePath);
        if (!r.ok) {
            vscode.window.showWarningMessage(`${r.error}：${path.basename(filePath)}`);
            continue;
        }
        const taskInfo = r.info;

        const rows = await parseFileToRows(filePath);
        if (!rows || rows.length === 0) {
            vscode.window.showWarningMessage(`文件无数据: ${path.basename(filePath)}`);
            continue;
        }

        console.log(`[推送] 文件: ${filePath}, ${rows.length} 行`);
        const pushResult = await pushTestCase(context, rows, taskInfo, path.basename(filePath));
        if (pushResult.returnCode !== 'SUC0000') {
            vscode.window.showErrorMessage(`推送失败: ${pushResult.errorMsg || '未知错误'}`);
            continue;
        }

        // 解析后端逐条结果：type=1 成功，data=新 testCaseNo；type=2 失败，data=错误原因
        const body: any[] = Array.isArray(pushResult.body) ? pushResult.body : [];
        const successMappings: Array<{ tsId: string; testCaseNo: string }> = [];
        const failures: Array<{ tsId: string; reason: string }> = [];
        body.forEach(item => {
            if (!item) return;
            const t = String(item.type == null ? '' : item.type);
            const sid = String(item.sourceId == null ? '' : item.sourceId);
            const dataField = item.data == null ? '' : String(item.data);
            if (t === '1') successMappings.push({ tsId: sid, testCaseNo: dataField });
            else if (t === '2') failures.push({ tsId: sid, reason: dataField });
        });

        // 把成功项的 testCaseNo 回写到原文件（按 tsId 匹配）
        if (successMappings.length > 0) {
            try {
                const fileType = detectFileType(filePath);
                if (fileType) {
                    const parser = createParser(fileType);
                    const parsed = await parser.parse(filePath);
                    ensureTrackingColumns(parsed.tableData, parsed.sourceData);
                    applyTestCaseNos(parsed.tableData, parsed.sourceData, successMappings);
                    await parser.save(filePath, parsed.tableData, parsed.sourceData);
                }
            } catch (err: any) {
                console.error(`[推送] 回写 testCaseNo 失败: ${err?.message || err}`);
            }
        }

        const baseName = path.basename(filePath);

        // 失败明细按 tsId 反查为 "第 N 行"
        const tsIdToIndex = new Map<string, number>();
        rows.forEach((rec: any, i) => {
            const id = rec && rec.tsId != null ? String(rec.tsId) : '';
            if (id) tsIdToIndex.set(id, i);
        });
        const failureItems = failures.map(f => {
            const ri = tsIdToIndex.get(f.tsId);
            return {
                tsId: f.tsId,
                reason: f.reason,
                rowIndex: ri !== undefined ? ri + 1 : undefined,
            };
        });

        // 统一通过 webview 弹窗展示（与编辑器内推送一致）
        showPushResult(context, {
            fileName: baseName,
            successCount: successMappings.length,
            failures: failureItems,
            total: rows.length,
        });
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
    console.log('[Extension] 插件激活完成');
}

export function deactivate() {
    console.log('[Extension] 插件已停用');
}