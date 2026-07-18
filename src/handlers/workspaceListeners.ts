/**
 * ============================================================================
 *  workspaceListeners.ts
 *  注册工作区文件变化监听器（重命名、删除）
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { isCreatedByCommand, markAsCreatedByCommand, unmarkAsCreatedByCommand } from '../utils/fileIdentifier';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { removeHighlightFile } from '../utils/highlightStore';
import { removeFailureFile } from '../utils/pushFailureStore';
import { removeSnapshotFile } from '../utils/pushSnapshotStore';
import { removeDeletedRowsFile } from '../utils/deletedRowsStore';
import { removeMarkFile } from '../utils/markStore';
import {
    renamePathInBindings,
    removePathInBindings,
} from '../utils/pointCaseBindingStore';
import { TelemetryService } from '../utils/telemetry';

/** 若某文件的扩展名属于 point/case 绑定域，才有必要通知绑定库 */
function isBindingRelevant(fp: string): boolean {
    const ext = (fp.match(/\.[^./\\]+$/) || [''])[0].toLowerCase();
    return ['.md', '.xmind', '.csv', '.yaml', '.yml', '.json'].includes(ext);
}

/**
 * 注册所有工作区文件变化监听器
 * 返回所有监听器的 Disposable，供调用方统一订阅
 */
export function registerWorkspaceListeners(): vscode.Disposable[] {
    return [
        // 监听文件重命名，同步更新记录
        vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
                const oldPath = file.oldUri.fsPath;
                const newPath = file.newUri.fsPath;

                if (isCreatedByCommand(oldPath)) {
                    unmarkAsCreatedByCommand(oldPath);
                    markAsCreatedByCommand(newPath);
                }

                BaseEditorProvider.updatePanelMapKey(oldPath, newPath);

                // 同步 point ↔ case 绑定库（重命名或跨目录移动）
                if (isBindingRelevant(oldPath) || isBindingRelevant(newPath)) {
                    renamePathInBindings(oldPath, newPath)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.rename.synced', {
                                    ext: (path.extname(newPath) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.rename.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }
        }),

        // 监听文件删除，同步清理所有本地缓存记录
        vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
                const fp = file.fsPath;
                if (isCreatedByCommand(fp)) {
                    unmarkAsCreatedByCommand(fp);
                }
                // 清理各存储中该文件的缓存
                removeHighlightFile(fp).catch(() => {});
                removeFailureFile(fp).catch(() => {});
                removeSnapshotFile(fp).catch(() => {});
                removeDeletedRowsFile(fp).catch(() => {});
                removeMarkFile(fp).catch(() => {});

                // 同步 point ↔ case 绑定库（删除引用）
                if (isBindingRelevant(fp)) {
                    removePathInBindings(fp)
                        .then(changed => {
                            if (changed) {
                                TelemetryService.sendTelemetryEvent('pointCaseBindings.delete.synced', {
                                    ext: (path.extname(fp) || '').toLowerCase(),
                                });
                            }
                        })
                        .catch(err => {
                            TelemetryService.sendTelemetryErrorEvent('pointCaseBindings.delete.error', {
                                errorMessage: String(err?.message || err).slice(0, 500),
                            });
                        });
                }
            }
        }),
    ];
}
