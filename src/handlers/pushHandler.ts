import * as vscode from 'vscode';
import * as path from 'path';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { pushTestCase } from '../services/http';
import { parsePushResponse, PushSuccessMapping, PushResponseFailure } from '../utils/pushResponse';
import { applyTestCaseNos, createParser, detectFileType, ensureTrackingColumns, parseFileToRows } from '../parsers';
import { getCurrentTaskInfo } from '../utils/commands';
import { showPushErrorModal, showModal, showPushResult } from '../utils/message';
import { isCreatedByCommand, filterTemplateExampleRows, getTemplateExampleTsIds, TEMPLATE_EXAMPLE_TS_ID, isSampleTsId } from '../utils/fileIdentifier';
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

    // 校验：testcase_id 为占位值 TESTCASE_ID 时不允许推送
    // 注意：此校验必须在 filterTemplateExampleRows 之前执行，
    // 这样 i+1 才是文件中的原始行号，与主表显示行号一致，弹窗行号跳转才准确。
    // 说明：中文样例占位（'案例唯一标识，不可修改' / '案例唯一标识'）不走此分支，
    //      由下方 filterTemplateExampleRows 静默过滤；只有全部行都是样例时才提示"为样例数据"。
    const placeholderTestcaseIds = rows
        .map((rec: any, i: number) => {
            const tsId = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]).trim() : '';
            return tsId.toUpperCase() === 'TESTCASE_ID' ? { rowIndex: i + 1, value: tsId } : null;
        })
        .filter(Boolean) as Array<{ rowIndex: number; value: string }>;
    if (placeholderTestcaseIds.length > 0) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'placeholderTestcaseId', ext: fileExt, count: String(placeholderTestcaseIds.length) });
        // 构造失败列表：使用 showPushResult 以启用弹窗中"第 N 行"可点击跳转到主表对应行
        const placeholderFailures = placeholderTestcaseIds.map(item => ({
            tsId: item.value,
            reason: 'testcase_id 为占位值 TESTCASE_ID，请修改为真实的案例 ID 后再推送',
            rowIndex: item.rowIndex,
        }));
        showPushResult(panel, baseName, 0, placeholderFailures, placeholderTestcaseIds.length);
        // 持久化失败标记：以 testcase_id 为 key 写盘，确保关闭弹窗/重开文件后失败行仍保持红色高亮
        // 说明：所有占位行 tsId 均为字面量 'TESTCASE_ID'（大小写归一），前端按 tsId 匹配即可命中所有该值的行
        try {
            await persistPushFailures(filePath, rows, placeholderFailures, []);
        } catch (err: any) {
            console.error('[推送] 持久化占位失败标记失败:', err?.message || err);
        }
        return;
    }

    // 静默过滤中文样例占位行（'案例唯一标识，不可修改' / '案例唯一标识'）：
    // 无论文件是否通过插件命令创建，这些行都不参与推送；
    // 若过滤后仍剩余业务数据，正常推送；若全部行都是样例，则提示"为样例数据"，
    // 并按具体行号列出（弹窗中"第 N 行"可点击跳转到主表对应行）。
    const beforeFilterLen = rows.length;
    // 先按原始下标（i+1）收集样例行号，再执行过滤，保证行号与主表原始行号一致
    const sampleRowIndices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
        const rec: any = rows[i];
        const tsId = rec && rec[TS_ID_COLUMN] != null ? String(rec[TS_ID_COLUMN]).trim() : '';
        if (isSampleTsId(tsId)) sampleRowIndices.push(i + 1);
    }
    rows = filterTemplateExampleRows(filePath, rows);
    if (rows.length === 0) {
        sendTelemetryEvent('explorerPush.aborted', { reason: 'onlyTemplateExample', ext: fileExt, count: String(sampleRowIndices.length) });
        // 构造失败列表：每个样例行独立展示，前端弹窗支持"第 N 行"点击跳转到主表对应行
        const sampleFailures = sampleRowIndices.map(rowIndex => ({
            tsId: TEMPLATE_EXAMPLE_TS_ID,
            reason: '为样例数据，不允许推送。请修改"案例唯一标识，不可修改"等占位字段为真实数据后再试',
            rowIndex,
        }));
        showPushResult(panel, baseName, 0, sampleFailures, sampleRowIndices.length);
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
    const pushSource = isCreatedByCommand(filePath) ? 'testAgentMA' : 'testAgent';
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

    const leakedSuccess = successMappings.filter(m => m && isSampleTsId(m.tsId)).length;
    const leakedFailure = failures.filter(f => f && isSampleTsId(f.tsId)).length;
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
