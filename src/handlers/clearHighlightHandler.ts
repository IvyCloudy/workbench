/**
 * ============================================================================
 *  clearHighlightHandler.ts
 *  清理文件高亮及相关缓存（失败标记、快照、删除行追踪、手动标记）
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { TelemetryService } from '../utils/telemetry';
import { getActiveFileUri } from '../utils/extensionHelpers';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { cleanupCaseFileTraces } from '../utils/caseFileCleanup';

/**
 * 清理指定文件的所有高亮及缓存
 * @param uri 可选，要清理的文件 URI。若不传，则使用当前激活的文件
 */
export async function handleClearHighlight(uri?: vscode.Uri): Promise<void> {
    TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.clearHighlight' });

    const targetUri = uri || getActiveFileUri();
    if (!targetUri) {
        vscode.window.showInformationMessage('请先打开或选中一个测试案例文件');
        return;
    }

    const fp = targetUri.fsPath;
    const baseName = path.basename(fp);

    try {
        // 统一清理全部追踪态存储（含高亮、失败标记、快照、删除行、标记、绑定）；
        // 与「通过要点删除清空案例文件」「文件系统删除案例文件」共用同一清理清单。
        await cleanupCaseFileTraces(fp);

        // 通知前端刷新，清除内存中的高亮状态
        const panel = BaseEditorProvider.getPanel(fp);
        if (panel) {
            panel.webview.postMessage({ type: 'clearAllHighlights' });
        }

        vscode.window.showInformationMessage(`已清理所有缓存: ${baseName}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`清理缓存失败: ${err.message || err}`);
    }
}
