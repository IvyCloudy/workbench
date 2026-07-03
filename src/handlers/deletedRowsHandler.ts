import * as vscode from 'vscode';
import { detectFileType, createParser } from '../parsers';
import { syncDeletedRows, refreshAndGetDeletedRows } from '../utils/deletedRowsStore';
import { showToast, showModal } from '../utils/message';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { getActiveFileUri, isTestCaseFile, telemetryErrProps } from '../utils/extensionHelpers';

/**
 * 已删除行同步命令处理。
 * 检测当前激活的测试案例文件，比对并同步已删除行的记录。
 */
export async function handleSyncDeletedRows(): Promise<void> {
    const uri = getActiveFileUri();
    if (!uri || !isTestCaseFile(uri)) {
        sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'notTestCaseFile' });
        showToast(undefined, 'info', '请先打开测试案例文件再执行同步');
        return;
    }
    try {
        const fileType = detectFileType(uri.fsPath);
        if (!fileType) {
            sendTelemetryEvent('syncDeletedRows.aborted', { reason: 'unsupportedFileType' });
            showToast(undefined, 'error', '不支持的文件类型');
            return;
        }
        const parser = createParser(fileType);
        const parsed = await parser.parse(uri.fsPath);
        const deletedRows = refreshAndGetDeletedRows(uri.fsPath, parsed.tableData);
        if (deletedRows.length === 0) {
            sendTelemetryEvent('syncDeletedRows.noPending', {});
            showToast(undefined, 'info', '当前文件无待同步的已删除行');
            return;
        }
        const result = await syncDeletedRows(uri.fsPath);
        if (result.failed.length > 0) {
            showModal('default', 'warning', '删除行同步提示',
                result.failed.map(f => `${f.tsId}: ${f.reason}`).join('\n'));
        }
        if (result.synced.length > 0) {
            showToast(undefined, 'success', `已同步 ${result.synced.length} 行删除记录`);
        }
        sendTelemetryEvent('syncDeletedRows.complete', {
            syncedTotal: String(result.synced.length),
            failedRows: String(result.failed.length),
        });
    } catch (err: any) {
        console.error('[syncDeletedRows] 失败:', err?.message || err);
        showToast(undefined, 'error', `删除行同步失败: ${err?.message || err}`);
        sendTelemetryErrorEvent('syncDeletedRows.error', telemetryErrProps(err));
    }
}
