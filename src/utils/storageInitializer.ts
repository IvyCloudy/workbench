/**
 * ============================================================================
 *  storageInitializer.ts
 *  统一管理系统存储的初始化和孤儿记录清理
 * ============================================================================
 */

import * as vscode from 'vscode';
import { TelemetryService } from './telemetry';
import { telemetryErrProps } from './extensionHelpers';
import { cleanupRecords } from './fileIdentifier';
import { ensureBindingsFile } from './taskInfoStore';
import { ensureAllWorkspaceStores as ensurePointCaseBindings } from './pointCaseBindingStore';
import { ensureHighlightFile, cleanupOrphanedHighlights } from './highlightStore';
import { ensurePushFailureFile, cleanupOrphanedFailures } from './pushFailureStore';
import { ensureSnapshotFile, cleanupOrphanedSnapshots } from './pushSnapshotStore';
import { ensureDeletedRowsFile, cleanupOrphanedDeletedRows } from './deletedRowsStore';
import { ensureMarkFile, cleanupOrphanedMarks } from './markStore';

// ============================================
// 存储初始化
// ============================================

interface StorageInitTask {
    label: string;
    eventName: string;
    fn: () => Promise<void>;
}

/**
 * 初始化所有存储文件
 */
export async function initializeStorages(context: vscode.ExtensionContext): Promise<void> {
    const tasks: StorageInitTask[] = [
        { label: '绑定文件',     eventName: 'bindings',     fn: () => ensureBindingsFile(context).then(() => {}) },
        { label: '高亮存储',     eventName: 'highlight',    fn: () => ensureHighlightFile(context).then(() => {}) },
        { label: '推送失败存储', eventName: 'pushFailure',  fn: () => ensurePushFailureFile(context).then(() => {}) },
        { label: '快照存储',     eventName: 'snapshot',     fn: () => ensureSnapshotFile(context).then(() => {}) },
        { label: '删除行存储',   eventName: 'deletedRows',  fn: () => ensureDeletedRowsFile(context).then(() => {}) },
    ];

    for (const task of tasks) {
        await task.fn().catch(err => {
            console.error(`[Storage] 初始化${task.label}失败:`, err?.message || err);
            TelemetryService.sendTelemetryErrorEvent(`${task.eventName}.initFailed`, telemetryErrProps(err));
        });
    }

    // markStore 单独处理
    await ensureMarkFile(context).catch(err => {
        console.error('[Storage] 初始化标记存储文件失败:', err?.message || err);
    });

    // 工作区级：测试要点↔测试案例 绑定文件（每个 workspace 独立）
    await ensurePointCaseBindings().catch(err => {
        console.error('[Storage] 初始化 point-case-bindings 失败:', err?.message || err);
    });
}

// ============================================
// 孤儿记录清理
// ============================================

/**
 * 清理各存储中已不存在的文件的孤儿记录
 * 在插件激活时兜底调用，也供外部按需调用
 */
export async function cleanupOrphanedRecords(): Promise<void> {
    // 先清理 fileIdentifier 中的孤儿记录
    try {
        cleanupRecords();
    } catch (err: any) {
        console.error('[Storage] 清理 fileIdentifier 孤儿记录失败:', err?.message || err);
    }

    // 并行清理各存储的孤儿记录
    const results = await Promise.allSettled([
        cleanupOrphanedHighlights(),
        cleanupOrphanedFailures(),
        cleanupOrphanedSnapshots(),
        cleanupOrphanedDeletedRows(),
        cleanupOrphanedMarks(),
    ]);

    results.forEach((result, index) => {
        const names = ['highlight', 'pushFailure', 'snapshot', 'deletedRows', 'mark'];
        if (result.status === 'rejected') {
            console.error(`[Storage] 清理 ${names[index]} 孤儿记录失败:`, result.reason);
        }
    });
}
