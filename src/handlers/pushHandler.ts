import * as vscode from 'vscode';
import * as path from 'path';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { pushTestCase } from '../services/http';
import { parsePushResponse, PushSuccessMapping, PushResponseFailure } from '../utils/pushResponse';
import { applyTestCaseNos, createParser, detectFileType, ensureTrackingColumns, parseFileToRows } from '../parsers';
import { getCurrentTaskInfo } from '../utils/commands';
import { showPushErrorModal, showModal, showPushResult } from '../utils/message';
import { isCreatedByCommand, filterTemplateExampleRows, getTemplateExampleTsIds, TEMPLATE_EXAMPLE_TS_ID } from '../utils/fileIdentifier';
import { persistPushFailures } from '../utils/pushFailureStore';
import { savePushSnapshot } from '../utils/pushSnapshotStore';
import { normalizePushData } from '../utils/headerLabels';
import { TS_ID_COLUMN } from '../services/utils';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';

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
        sendTelemetryEvent('explorerPush.aborted', { reason: 'multiFile', ext: '' });
        showModal(panel, 'warning', '多文件推送', '暂不支持多文件推送，请逐个推送。将仅处理首个文件。');
    }

    const fileCheck = FileTypeChecker.isQualifiedFile(target);
    if (!fileCheck.qualified) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'dirNotQualified', ext: '' });
        showPushErrorModal(panel, baseName, `文件不在合规目录下\n\n请将文件放入 测试任务/<任务文件夹>/测试案例/ 目录结构中。\n当前文件：${baseName}`);
        return;
    }

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
        subTestTaskId: currentTask.taskInfo.subTestTaskId || '',
    };

    let rows = await parseFileToRows(filePath);
    if (!rows || rows.length === 0) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'noData', ext: fileExt });
        showPushErrorModal(panel, baseName, `文件无数据\n\n${baseName} 中未检测到有效的测试案例数据，请检查文件内容。`);
        return;
    }

    const beforeFilterLen = rows.length;
    rows = filterTemplateExampleRows(filePath, rows);
    if (rows.length === 0) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'onlyTemplateExample', ext: fileExt });
        showPushErrorModal(panel, baseName,
            `${baseName} 仅包含模板示例数据，请先填写真实的测试案例后再推送。\n\n提示：请修改首行的"案例唯一标识，不可修改"等占位字段为真实数据。`);
        return;
    }
    if (rows.length !== beforeFilterLen) {
        sendTelemetryEvent('explorerPush.skipTemplateExample', { ext: fileExt, skipped: String(beforeFilterLen - rows.length) });
    }

    if (!panel) {
        try {
            panel = await ensureOpenedInTestcaseEditor(target);
        } catch (_) { /* ignore */ }
    }

    console.log(`[推送] 文件: ${filePath}, ${rows.length} 行`);
    sendTelemetryEvent('explorerPush.start', { ext: fileExt, totalRows: String(rows.length) });
    const pushData = normalizePushData(rows);
    const pushSource = isCreatedByCommand(filePath) ? 'testAgentMa' : 'testAgent';
    const pushResult = await pushTestCase(context, pushData, taskInfo, path.basename(filePath), pushSource);
    if (pushResult.returnCode !== 'SUC0000') {
        showPushErrorModal(panel, baseName, `后端返回失败: ${pushResult.errorMsg || '未知错误'}`);
        sendTelemetryErrorEvent('explorerPush.failed', {
            ext: fileExt,
            returnCode: pushResult.returnCode || '',
            totalRows: String(rows.length),
            costMs: String(Date.now() - pushStart),
        });
        return;
    }

    const { successMappings, failures } = parsePushResponse(pushResult.body);

    const leakedSuccess = successMappings.filter(m => m && String(m.tsId).trim() === TEMPLATE_EXAMPLE_TS_ID).length;
    const leakedFailure = failures.filter(f => f && String(f.tsId).trim() === TEMPLATE_EXAMPLE_TS_ID).length;
    if (leakedSuccess > 0 || leakedFailure > 0) {
        sendTelemetryErrorEvent('explorerPush.templateExampleLeaked', {
            ext: fileExt,
            leakedSuccess: String(leakedSuccess),
            leakedFailure: String(leakedFailure),
        });
    }

    if (successMappings.length > 0) {
        try {
            const fileType = detectFileType(filePath);
            if (fileType) {
                const parser = createParser(fileType);
                const parsed = await parser.parse(filePath);
                ensureTrackingColumns(parsed.tableData, parsed.sourceData);
                applyTestCaseNos(parsed.tableData, parsed.sourceData, successMappings);
                const pushedTsIds = new Set(successMappings.map(m => m.tsId));
                getTemplateExampleTsIds(filePath, parsed.tableData).forEach(id => pushedTsIds.add(id));
                await savePushSnapshot(filePath, parsed.tableData, pushedTsIds);
                await parser.save(filePath, parsed.tableData, parsed.sourceData);
            }
        } catch (err: any) {
            console.error(`[推送] 回写 testCaseNo 失败: ${err?.message || err}`);
            sendTelemetryErrorEvent('explorerPush.writeBackFailed', { ext: fileExt, ...telemetryErrProps(err) });
        }
    }

    const tsIdToIndex = new Map<string, number>();
    rows.forEach((rec: any, i) => {
        const id = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]) : '';
        if (id) tsIdToIndex.set(id, i);
    });
    const failureItems = failures.map(f => {
        const ri = tsIdToIndex.get(f.tsId);
        return { tsId: f.tsId, reason: f.reason, rowIndex: ri !== undefined ? ri + 1 : undefined };
    });

    showPushResult(panel, baseName, successMappings.length, failureItems, rows.length);

    try {
        await persistPushFailures(filePath, rows, failures, successMappings);
    } catch (err: any) {
        console.error('[推送] 持久化失败标记失败:', err?.message || err);
    }

    sendTelemetryEvent('explorerPush.complete', {
        ext: fileExt,
        pushResult: failures.length === 0 ? 'allSuccess' : (successMappings.length === 0 ? 'allFail' : 'partial'),
        totalRows: String(rows.length),
        successRows: String(successMappings.length),
        failedRows: String(failures.length),
        costMs: String(Date.now() - pushStart),
    });

    if (!panel) {
        sendTelemetryEvent('explorerPush.noPanelFallback', {
            succ: String(successMappings.length),
            fail: String(failures.length),
            ext: fileExt,
        });
    }
}
