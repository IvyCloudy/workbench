import * as vscode from 'vscode';
import * as path from 'path';
import { detectFileType, createParser } from '../parsers';
import { syncDeletedRows, refreshAndGetDeletedRows } from '../utils/deletedRowsStore';
import { showToast } from '../utils/message';
import { reportDeleteResult, buildDeleteFailures, postDeleteRowsResult } from '../utils/deleteFeedback';
import { TelemetryService } from '../utils/telemetry';
import { getActiveFileUri, isTestCaseFile, telemetryErrProps, syncDeletedResultTelemetryProps } from '../utils/extensionHelpers';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';

/**
 * 已删除行同步命令处理。
 * 检测当前激活的测试案例文件，比对并同步已删除行的记录，并把结果回传前端，
 * 由表格内行状态展示删除结果（成功行消失 / 失败行置灰+划线保留并标记原因），
 * 不再使用独立弹窗。
 */
export async function handleSyncDeletedRows(): Promise<void> {
    const uri = getActiveFileUri();
    if (!uri || !isTestCaseFile(uri)) {
        TelemetryService.sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'notTestCaseFile' });
        showToast(undefined, 'info', '请先打开测试案例文件再执行同步');
        return;
    }
    try {
        const fileType = detectFileType(uri.fsPath);
        if (!fileType) {
            TelemetryService.sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'unsupportedFileType' });
            showToast(undefined, 'error', '不支持的文件类型');
            return;
        }
        const parser = createParser(fileType);
        const parsed = await parser.parse(uri.fsPath);
        const deletedRows = refreshAndGetDeletedRows(uri.fsPath, parsed.tableData);
        if (deletedRows.length === 0) {
            TelemetryService.sendTelemetryEvent('syncDeletedRows.noPending', {});
            showToast(undefined, 'info', '当前文件无待同步的已删除行');
            return;
        }
        const result = await syncDeletedRows(uri.fsPath);

        // 不再使用独立弹窗反馈删除结果（结果应在表格内行展示）。
        // 把成功/失败的 tsId 回传前端，前端据此真正删除成功的行（接口失败的行保留不丢，
        // 并在表格内以置灰+划线 + 失败原因标记）。
        const panel = BaseEditorProvider.getPanel(uri.fsPath);
        if (panel) {
            postDeleteRowsResult(panel, result);
            // P1-A1：与编辑器内右键删除对齐，也弹一个删除结果 modal 展示明细
            // （之前只在表格内标记行状态，用户容易忽略失败原因）
            const failures = buildDeleteFailures(result)
                .sort((a, b) => String(a.tsId).localeCompare(String(b.tsId)));
            reportDeleteResult({
                panel,
                fileName: path.basename(uri.fsPath),
                successCount: result.synced.length,
                failures,
                total: result.synced.length + result.failed.length,
                error: undefined,
                deletedSuccess: result.deletedSuccess.length,
                deletedSourceMissing: result.deletedSourceMissing.length,
            });
        } else {
            // 无面板（文件未打开）时，退化为 toast 提示，避免静默无反馈
            const msg = `已同步删除 ${result.synced.length} 行` +
                (result.failed.length > 0 ? `，${result.failed.length} 行失败` : '') +
                (result.deletedSourceMissing.length > 0
                    ? `（其中 ${result.deletedSourceMissing.length} 行 sourceId 不存在）` : '');
            showToast(undefined, result.failed.length > 0 ? 'warning' : 'info', msg);
        }
        TelemetryService.sendTelemetryEvent('syncDeletedRows.complete', {
            // 已删除案例 testcase_id 明细 + 文件路径（与全场景埋点字段命名保持一致，统一由 syncDeletedResultTelemetryProps 构造）
            ...syncDeletedResultTelemetryProps(result, uri.fsPath),
        });
    } catch (err: any) {
        console.error('[syncDeletedRows] 失败:', err?.message || err);
        showToast(undefined, 'error', `删除行同步失败: ${err?.message || err}`);
        TelemetryService.sendTelemetryErrorEvent('syncDeletedRows.error', telemetryErrProps(err));
    }
}
