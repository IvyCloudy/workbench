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
 *    - 推送结果统一复用 testcase 编辑器 webview 内的弹窗：右键推送时先确保文件以 testcase 编辑器打开，
 *      推送完成后直接向对应 webview postMessage('pushResult')，与编辑器内推送行为一致。
 *    - testTaskNo / subTestTaskName 一律通过 utils/taskInfo.getCurrentTaskInfo()
 *      获取（绑定文件中的真实后端值），未绑定一律拒绝推送。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { TestCaseProvider } from './providers/TestCaseProvider';
import { UnifiedEditorProvider, FileTypeChecker } from './providers/UnifiedEditorProvider';
import { BaseEditorProvider } from './providers/BaseEditorProvider';
import { registerBindTaskFeatures } from './providers/BindTaskProvider';
import { pushTestCase } from './services/http';
import { applyTestCaseNos, createParser, detectFileType, ensureTrackingColumns, parseFileToRows } from './parsers';
import { ensureBindingsFile } from './utils/taskInfoStore';
import { getCurrentTaskInfo } from './utils/commands';
import { showPushErrorModal, showPushResult, showModal } from './utils/message';
import { ensureHighlightFile } from './utils/highlightStore';
import { ensurePushFailureFile, mergeFailures } from './utils/pushFailureStore';
import { ensureSnapshotFile, savePushSnapshot, getDeletedSnapshotIds } from './utils/pushSnapshotStore';
import { TS_ID_COLUMN } from './services/utils';
import { ensureDeletedRowsFile, syncDeletedRows, refreshAndGetDeletedRows, getPendingDeletedRows, markDeletedRows } from './utils/deletedRowsStore';
import { initTelemetry, sendTelemetryEvent, sendTelemetryErrorEvent, sendTelemetryException } from './services/telemetry';
import { stackHead } from './services/utils';

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
 * 确保指定文件以 testcase 编辑器打开，返回其 webview panel。
 * - 已打开：调用 reveal() 切到该 tab。
 * - 未打开：openWith 拉起 testcase 编辑器，并等待 webview ready（收到 init 后）。
 */
async function ensureOpenedInTestcaseEditor(uri: vscode.Uri): Promise<vscode.WebviewPanel | undefined> {
    const filePath = uri.fsPath;
    const existing = BaseEditorProvider.getPanel(filePath);
    if (existing) {
        try { existing.reveal(existing.viewColumn, false); } catch (_) { /* ignore */ }
        // 已打开场景 webview 一般已 ready，这里仍走 waitReady 以防刚 open 未完成
        try { await BaseEditorProvider.waitReady(filePath, 3000); } catch (_) { /* ignore */ }
        return existing;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
    try {
        await BaseEditorProvider.waitReady(filePath, 8000);
    } catch (e: any) {
        console.warn('[推送] 等待 webview 就绪超时:', e?.message || e);
    }
    return BaseEditorProvider.getPanel(filePath);
}

/**
 * 资源管理器右键「推送测试案例」入口（仅支持单文件场景）。
 *
 * 流程：
 *   1. 校验文件是否在合规目录下（测试任务/<task>/测试案例/...）。
 *   2. getCurrentTaskInfo 解析任务身份并校验是否已绑定。
 *   3. parseFileToRows 解析为推送用二维数组（CSV/YAML/JSON 透明）。
 *   4. 确保文件以 testcase 编辑器打开（未开则 openWith，已开则 reveal）。
 *   5. pushTestCase 调后端，按返回逐条分类（成功/失败）。
 *   6. 成功项按 testcase_id 回写 testCaseNo 到原文件。
 *   7. 向该 webview postMessage('pushResult')，由前端弹窗展示结果。
 *
 * 多文件场景暂不支持，后续再设计。
 */
async function handleFilePush(targets: vscode.Uri[], context: vscode.ExtensionContext): Promise<void> {
    if (!targets || targets.length === 0) return;
    const multiFile = targets.length > 1;
    const target = targets[0];
    const filePath = target.fsPath;
    const baseName = path.basename(filePath);

    // 先确保 webview 已打开，以便校验错误也能在页面居中弹窗展示
    let panel: vscode.WebviewPanel | undefined;
    try {
        panel = await ensureOpenedInTestcaseEditor(target);
    } catch (_) {
        // webview 打开失败，继续走校验兜底
    }

    // 多文件警告复用已有 webview，避免创建独立标签页
    if (multiFile) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'multiFile', ext: '' });
        showModal(panel, 'warning', '多文件推送', '暂不支持多文件推送，请逐个推送。将仅处理首个文件。');
    }

    const fileCheck = FileTypeChecker.isQualifiedFile(target);
    if (!fileCheck.qualified) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'dirNotQualified', ext: '' });
        showPushErrorModal(panel, baseName, `文件不在合规目录下\n\n请将文件放入 测试任务/<任务文件夹>/测试案例/ 目录结构中。\n当前文件：${baseName}`);
        return;
    }

    // 任务信息统一由 getCurrentTaskInfo 提供：未绑定一律拒绝推送
    const currentTask = await getCurrentTaskInfo(filePath);
    if (!currentTask.bind) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'unbound', ext: '' });
        showPushErrorModal(panel, baseName, '未绑定任务，无法推送。请在测试任务插件绑定后再试。');
        return;
    }
    const fileExt = path.extname(filePath).toLowerCase();
    const pushStart = Date.now();

    const taskInfo = {
        testTaskNo: currentTask.taskInfo.testTaskNo || '',
        subTestTaskName: currentTask.taskInfo.subTestTaskName || '',
    };

    const rows = await parseFileToRows(filePath);
    if (!rows || rows.length === 0) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'noData', ext: fileExt });
        showPushErrorModal(panel, baseName, `文件无数据\n\n${baseName} 中未检测到有效的测试案例数据，请检查文件内容。`);
        return;
    }

    // 若之前 ensureOpenedInTestcaseEditor 失败，此处再次尝试打开
    if (!panel) {
        try {
            panel = await ensureOpenedInTestcaseEditor(target);
        } catch (_) { /* ignore */ }
    }


    console.log(`[推送] 文件: ${filePath}, ${rows.length} 行`);
    sendTelemetryEvent('explorerPush.start', { ext: fileExt, totalRows: String(rows.length) });
    const pushResult = await pushTestCase(context, rows, taskInfo, path.basename(filePath));
    if (pushResult.returnCode !== 'SUC0000') {
        showPushErrorModal(panel, baseName, `后端返回失败: ${pushResult.errorMsg || '未知错误'}`);
        vscode.window.showErrorMessage(`推送失败: ${pushResult.errorMsg || '未知错误'}`);
        sendTelemetryErrorEvent('explorerPush.failed', {
            ext: fileExt,
            returnCode: pushResult.returnCode || '',
            totalRows: String(rows.length),
            costMs: String(Date.now() - pushStart),
        });
        return;
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

    // 把成功项的 testCaseNo 回写到原文件（按 testcase_id 匹配）
    if (successMappings.length > 0) {
        try {
            const fileType = detectFileType(filePath);
            if (fileType) {
                const parser = createParser(fileType);
                const parsed = await parser.parse(filePath);
                ensureTrackingColumns(parsed.tableData, parsed.sourceData);
                applyTestCaseNos(parsed.tableData, parsed.sourceData, successMappings);
                await parser.save(filePath, parsed.tableData, parsed.sourceData);
                const pushedTsIds = new Set(successMappings.map(m => m.tsId));
                await savePushSnapshot(filePath, parsed.tableData, pushedTsIds);
            }
        } catch (err: any) {
            console.error(`[推送] 回写 testCaseNo 失败: ${err?.message || err}`);
            sendTelemetryException('explorerPush.writeBackFailed', { ext: fileExt, errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
        }
    }

    // 失败明细按 testcase_id 反查为 "第 N 行"
    const tsIdToIndex = new Map<string, number>();
    rows.forEach((rec: any, i) => {
        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
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

    showPushResult(panel, baseName, successMappings.length, failureItems, rows.length);

    // 持久化推送失败标记：以 testcase_id（行稳定唯一标识）为 key，跨 webview/vscode 重启依然保持
    try {
        const batchTsIds: string[] = [];
        for (const rec of rows) {
            const id = rec && (rec as any)[TS_ID_COLUMN] != null ? String((rec as any)[TS_ID_COLUMN]) : '';
            if (id) batchTsIds.push(id);
        }
        const failuresMap: { [tsId: string]: string } = {};
        failures.forEach(f => {
            if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
                failuresMap[String(f.tsId)] = String(f.reason || '');
            }
        });
        const successTsIds: string[] = successMappings
            .map(s => s && s.tsId)
            .filter((t: any) => t !== undefined && t !== null && t !== '')
            .map((t: any) => String(t));
        await mergeFailures(filePath, batchTsIds, failuresMap, successTsIds);
    } catch (err: any) {
        console.error('[推送] 持久化失败标记失败:', err?.message || err);
    }
    // 埋点：推送结果汇总
    sendTelemetryEvent('explorerPush.complete', {
        ext: fileExt,
        pushResult: failures.length === 0 ? 'allSuccess' : (successMappings.length === 0 ? 'allFail' : 'partial'),
        totalRows: String(rows.length),
        successRows: String(successMappings.length),
        failedRows: String(failures.length),
        costMs: String(Date.now() - pushStart),
    });

    // 统一通过对应 webview 弹窗展示（与编辑器内推送一致）
    if (panel) {
        panel.webview.postMessage({
            type: 'pushResult',
            fileName: baseName,
            successCount: successMappings.length,
            failures: failureItems,
            total: rows.length,
        });
    } else {
        // 极端兵头：webview 未能拉起，退回原生提示
        const succ = successMappings.length;
        const fail = failures.length;
        sendTelemetryEvent('explorerPush.noPanelFallback', { succ: String(succ), fail: String(fail), ext: fileExt });
        if (fail === 0) {
            vscode.window.showInformationMessage(`推送成功：${baseName}，共 ${succ} 条。`);
        } else if (succ === 0) {
            vscode.window.showErrorMessage(`推送失败：${baseName}，共 ${fail} 条。`);
        } else {
            vscode.window.showWarningMessage(`推送部分成功：${baseName}，成功 ${succ}/失败 ${fail}。`);
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
                sendTelemetryEvent('command.executed', { command: 'testcaseViewer.openWithEditor' });
                await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
            }
        }),
        vscode.commands.registerCommand('testcaseViewer.openWithText', async () => {
            const uri = getActiveFileUri();
            if (uri && extPattern.test(uri.fsPath)) {
                sendTelemetryEvent('command.executed', { command: 'testcaseViewer.openWithText' });
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        })
    ];
}

// ============================================
// 激活
// ============================================

export async function activate(context: vscode.ExtensionContext) {
    const _activateStart = Date.now();
    console.log('[Extension] 插件激活中...');

    // 埋点初始化（必须尽早，且尊重用户 telemetry 设置）
    initTelemetry(context).catch(err => {
        console.warn('[Extension] 初始化埋点失败（已忽略）:', err?.message || err);
    });

    // 全局未捕获异常上报（兜底）
    process.on('unhandledRejection', (reason: any) => {
        try { sendTelemetryException('extension.unhandledRejection', { errorMessage: String(reason?.message || String(reason)).slice(0, 500), stackHead: stackHead(reason) }); } catch (_) { /* ignore */ }
    });

    // 初始化测试任务绑定文件（不存在则创建空模板，并打印路径便于用户定位）
    await ensureBindingsFile(context).catch(err => {
        console.error('[Extension] 初始化绑定文件失败:', err?.message || err);
        sendTelemetryException('bindings.initFailed', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
    });

    // 初始化高亮存储文件（用于持久化推送后 testCaseNo 单元格的高亮标识）
    await ensureHighlightFile(context).catch(err => {
        console.error('[Extension] 初始化高亮存储文件失败:', err?.message || err);
        sendTelemetryException('highlight.initFailed', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
    });

    // 初始化推送失败存储文件（以 testcase_id 为 key 持久化失败高亮）
    await ensurePushFailureFile(context).catch(err => {
        console.error('[Extension] 初始化推送失败存储文件失败:', err?.message || err);
        sendTelemetryException('pushFailure.initFailed', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
    });

    // 初始化推送快照存储文件（每次推送后记录基线，后续差异比对用）
    await ensureSnapshotFile(context).catch(err => {
        console.error('[Extension] 初始化快照存储文件失败:', err?.message || err);
        sendTelemetryException('snapshot.initFailed', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
    });

    // 初始化已删除行追踪存储文件（管理待同步的删除行记录）
    await ensureDeletedRowsFile(context).catch(err => {
        console.error('[Extension] 初始化删除行存储文件失败:', err?.message || err);
        sendTelemetryException('deletedRows.initFailed', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
    });

    // 注册绑定任务相关功能（装饰器 + TreeView + revealBoundTask 命令 + 监听）
    const bindTaskDisposables = registerBindTaskFeatures(context);

    const tableBrowserProvider = new TableBrowserProvider(context.extensionUri, context);
    const testCaseProvider = new TestCaseProvider(context.extensionUri, context);
    const unifiedEditorProvider = new UnifiedEditorProvider(context.extensionUri, context);

    context.subscriptions.push(
        ...bindTaskDisposables,

        // 自定义编辑器
        //  1. retainContextWhenHidden=true：切换 Tab 时不销毁 webview
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
        vscode.commands.registerCommand('tableBrowser.open', () => {
            sendTelemetryEvent('command.executed', { command: 'tableBrowser.open' });
            return tableBrowserProvider.show();
        }),
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (uri && isTestCaseFile(uri)) {
                sendTelemetryEvent('command.executed', { command: 'testcaseViewer.viewOnline' });
                await testCaseProvider.showWebview(uri);
            }
        }),

        // 编辑器切换命令
        ...registerEditorCommands(context, /\.(csv|ya?ml|json)$/i),

        // 推送命令
        vscode.commands.registerCommand(
            'testcaseViewer.pushTestCaseFromExplorer',
            async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                sendTelemetryEvent('command.executed', { command: 'testcaseViewer.pushTestCaseFromExplorer' });
                try {
                    await handleFilePush(targets, context);
                } catch (err: any) {
                    const baseName = targets[0] ? path.basename(targets[0].fsPath) : '';
                    const panel = targets[0] ? BaseEditorProvider.getPanel(targets[0].fsPath) : undefined;
                    sendTelemetryException('explorerPush.commandError', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
                    showPushErrorModal(panel, baseName, `推送失败: ${err.message || err}`);
                }
            }
        ),

        // 已删除行同步命令（将已删除行同步到线上并清除本地快照）
        vscode.commands.registerCommand(
            'workbench.syncDeletedRows',
            async () => {
                const uri = getActiveFileUri();
                if (!uri || !isTestCaseFile(uri)) {
                    sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'notTestCaseFile' });
                    vscode.window.showInformationMessage('请先打开测试案例文件再执行同步');
                    return;
                }
                try {
                    const fileType = detectFileType(uri.fsPath);
                    if (!fileType) {
                        sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'unsupportedFileType' });
                        vscode.window.showErrorMessage('不支持的文件类型');
                        return;
                    }
                    const parser = createParser(fileType);
                    const parsed = await parser.parse(uri.fsPath);
                    const deletedRows = refreshAndGetDeletedRows(uri.fsPath, parsed.tableData);
                    if (deletedRows.length === 0) {
                        sendTelemetryEvent('syncDeletedRows.noPending', {});
                        vscode.window.showInformationMessage('当前文件无待同步的已删除行');
                        return;
                    }
                    const result = await syncDeletedRows(uri.fsPath);
                    if (result.failed.length > 0) {
                        vscode.window.showInformationMessage(
                            `删除行同步提示\n\n${result.failed.map(f => `${f.tsId}: ${f.reason}`).join('\n')}`,
                            { modal: true }
                        );
                    }
                    if (result.synced.length > 0) {
                        vscode.window.showInformationMessage(`已同步 ${result.synced.length} 行删除记录`);
                    }
                    sendTelemetryEvent('syncDeletedRows.complete', {
                        syncedTotal: String(result.synced.length),
                        failedRows: String(result.failed.length),
                    });
                } catch (err: any) {
                    console.error('[syncDeletedRows] 失败:', err?.message || err);
                    vscode.window.showErrorMessage(`删除行同步失败: ${err?.message || err}`);
                    sendTelemetryException('syncDeletedRows.error', { errorMessage: String(err?.message || String(err)).slice(0, 500), stackHead: stackHead(err) });
                }
            }
        ),

        // 监听标签页激活变化，更新图标显示
        vscode.window.tabGroups.onDidChangeTabs(() => updateShowIcon()),
    );

    updateShowIcon();
    console.log('[Extension] 插件激活完成');
    sendTelemetryEvent('extension.activate.done', { activateMs: String(Date.now() - _activateStart) });
}

export function deactivate() {
    console.log('[Extension] 插件已停用');
}