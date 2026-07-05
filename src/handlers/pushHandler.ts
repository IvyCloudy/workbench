import * as vscode from 'vscode';
import * as path from 'path';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { parseFileToRows } from '../parsers';
import { showPushErrorModal, showModal, showPushResult } from '../utils/message';
import { TelemetryService } from '../utils/telemetry';
import { runPush, buildRowIndexMappings } from './pushCore';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

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
 * 本函数只保留右键场景独有的准入检查：
 *   - 多文件警告
 *   - 目录合规校验
 *   - 文件解析与空数据兜底
 * 其余通用推送流程（占位/样例校验、后端调用、成功回写、失败汇总、埋点）
 * 全部下沉到 handlers/pushCore.ts 的 runPush，与「编辑器内推送」共用。
 */
export async function handleFilePush(targets: vscode.Uri[], context: vscode.ExtensionContext): Promise<void> {
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

    if (multiFile) {
        TelemetryService.sendTelemetryEvent('explorerPush.aborted', { reason: 'multiFile', ext: '' });
        showModal(panel, 'warning', '多文件推送', '暂不支持多文件推送，请逐个推送。将仅处理首个文件。');
    }

    const fileCheck = FileTypeChecker.isQualifiedFile(target);
    if (!fileCheck.qualified) {
        TelemetryService.sendTelemetryEvent('explorerPush.aborted', { reason: 'dirNotQualified', ext: '' });
        showPushErrorModal(panel, baseName, `文件不在合规目录下\n\n请将文件放入 测试任务/<任务文件夹>/测试案例/ 目录结构中。\n当前文件：${baseName}`);
        return;
    }

    const rows = await parseFileToRows(filePath);

    // 与前端 04-push-find.js 中 rowIndexMap/pushIndexToRow 的构造完全对齐 ——
    // 让右键推送和编辑器推送在 buildFailureItems 中走同一路径，避免因样例行过滤
    // 导致的第 3 级降级行号错位（"弹窗第 N 行"与"表格红色高亮行"差 1 行的 bug）。
    const { rowIndexMap, pushIndexToRow } = buildRowIndexMappings(rows || []);

    // 委托给公共核心：所有 UI 反馈通过 hooks 定制为「独立 webview / 当前 panel 内嵌」两种展示形态之一。
    // 这里 panel 若不为 undefined 即在编辑器面板内嵌显示；若为 undefined 则由 message.ts 内部创建独立 webview 弹窗。
    await runPush({
        extensionContext: context,
        filePath,
        rows: rows || [],
        // 右键推送 = 整表原始下标；行号解析直接 i+1
        resolveRowIndex: (i: number) => i + 1,
        // 与编辑器推送共用行号映射；不再依赖 buildFailureItems 第 3 级降级（会因样例过滤错位）
        frontRowIndexMap: rowIndexMap,
        frontPushIndexToRow: pushIndexToRow,
        telemetryPrefix: 'explorerPush',
        hooks: {
            // 已打开的 webview 存在时，写盘前后打自保存时间戳，避免 fsWatcher 自反弹覆盖高亮基线。
            // 未打开 panel 时 markPanelSelfSave 内部会 no-op。
            markSelfSave: () => BaseEditorProvider.markPanelSelfSave(filePath),
            // 成功回写 testCaseNo 后：清空已打开 webview 的旧高亮基线，并重走 pushSuccess 差异比对，
            // 让新增行成功后不再显示黄色，未成功/编辑过的行仍能正确显示黄色修改高亮。
            afterWriteBack: async ({ hasFailure }) => {
                await BaseEditorProvider.postExplorerPushRefresh(filePath, hasFailure);
            },
            // 全部推送失败：核心已更新快照基线为当前文件内容；同样清空高亮 + 走 pushSuccess 差异比对，
            // 使残留的黄色/绿色高亮清除，仅保留 pushFailures 红色标识。
            onAllFailedSnapshot: async () => {
                await BaseEditorProvider.postExplorerPushRefresh(filePath, true);
            },
            onUnbound: () => {
                showPushErrorModal(panel, baseName, '未绑定任务，无法推送。请在测试任务插件绑定后再试。');
            },
            onNoData: () => {
                showPushErrorModal(panel, baseName, `文件无数据\n\n${baseName} 中未检测到有效的测试案例数据，请检查文件内容。`);
            },
            onPlaceholderTestcaseId: (failures) => {
                // 使用 showPushResult 以启用弹窗中"第 N 行"可点击跳转到主表对应行
                showPushResult(panel, baseName, 0, failures, failures.length);
            },
            onEmptyTestcaseId: (failures) => {
                // testcase_id 为空的行：与占位校验共享展示形态；showPushResult 内部会按 reason 显示"testcase_id 不能为空"
                showPushResult(panel, baseName, 0, failures, failures.length);
            },
            onOnlySampleRows: (failures) => {
                // 每个样例行独立展示，前端弹窗支持"第 N 行"点击跳转到主表对应行
                showPushResult(panel, baseName, 0, failures, failures.length);
            },
            onTaskInfoFailed: (errorMsg) => {
                // 网络抖动/后端 5xx 等 taskInfo 拉取异常兜底：明确告知用户中断原因
                showPushErrorModal(panel, baseName, errorMsg);
            },
            onBackendError: (errorMsg) => {
                showPushErrorModal(panel, baseName, `后端返回失败: ${errorMsg}`);
            },
            onUnexpectedError: (errorMsg) => {
                // runPush 顶层未处理异常兜底：确保用户能看到失败原因
                showPushErrorModal(panel, baseName, errorMsg);
            },
            onWriteBackFailed: (errorMsg) => {
                // 后端已经推送成功，但 testCaseNo 未能写回本地文件；追加一个警告弹窗，
                // 提示用户手动刷新或注意下次重复推送风险。
                showModal(panel, 'warning', '案例编号回写失败',
                    `${baseName}\n\n后端推送已成功，但案例编号未能写回本地文件。请稍后手动刷新或重新打开文件。\n\n错误信息：${errorMsg}`);
            },
            onComplete: ({ successCount, failures, total }) => {
                showPushResult(panel, baseName, successCount, failures, total);
                if (!panel) {
                    TelemetryService.sendTelemetryEvent('explorerPush.noPanelFallback', {
                        succ: String(successCount),
                        fail: String(failures.length),
                        ext: path.extname(filePath).toLowerCase(),
                    });
                }
            },
        },
    });
}
