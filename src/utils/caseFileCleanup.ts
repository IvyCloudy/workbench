/**
 * ============================================================================
 *  utils/caseFileCleanup.ts
 *  案例文件被整体删除/废弃时，统一清理其全部「追踪态」存储 + 绑定关系
 * ----------------------------------------------------------------------------
 *  职责：
 *    当某个测试案例文件不再存在（被删除、或被「通过要点删除」清空后整体删除）
 *    时，集中清理与之相关的所有临时态存储，避免出现"幽灵高亮 / 孤儿快照 /
 *    残留绑定"等问题。
 *
 *  包含清理项：
 *    - clearHighlight（高亮，等价于 removeHighlightFile）
 *    - removeFailureFile（推送失败标记）
 *    - removeSnapshotFile（推送快照基线）
 *    - removeDeletedRowsFile（已删除行追踪）
 *    - removeMarkFile（手动标记）
 *    - removePathInBindings（point↔case 双向绑定引用）
 *
 *  设计要点：
 *    - 各子项彼此独立，任一失败不影响其余，全部以 allSettled 兜底。
 *    - 纯工具模块（仅依赖各 store 的导出），不引入 vscode 命令 / UI，
 *      因此「通过要点删除」路径（单测友好）与「文件系统删除」路径均可复用。
 *    - 与 workspaceListeners.handleDidDeleteCaseFile、clearHighlightHandler
 *      里内联的清理清单完全一致，集中于此避免三处散落、易漏改。
 * ============================================================================
 */
import * as path from 'path';
import { TelemetryService } from './telemetry';
import { clearHighlight } from './highlightStore';
import { removeFailureFile } from './pushFailureStore';
import { removeSnapshotFile } from './pushSnapshotStore';
import { removeDeletedRowsFile } from './deletedRowsStore';
import { removeMarkFile } from './markStore';
import { removePathInBindings } from './pointCaseBindingStore';

/**
 * 清理某个案例文件关联的全部追踪态存储 + 绑定关系。
 * 全部以 Promise.allSettled 执行，失败被记录但不抛出（不阻断主流程）。
 *
 * @param filePath 案例文件绝对路径
 * @returns 各子项 settle 结果（一般无需消费；仅用于调试/测试断言）
 */
export async function cleanupCaseFileTraces(
    filePath: string,
): Promise<PromiseSettledResult<void>[]> {
    if (!filePath) return [];
    const tasks: Promise<void>[] = [
        clearHighlight(filePath),
        removeFailureFile(filePath),
        removeSnapshotFile(filePath),
        removeDeletedRowsFile(filePath),
        removeMarkFile(filePath),
        (async () => { await removePathInBindings(filePath); })(),
    ];
    const results = await Promise.allSettled(tasks);
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length > 0) {
        TelemetryService.sendTelemetryErrorEvent('caseFileCleanup.partialFailure', {
            filePath: path.basename(filePath),
            failedCount: String(failed.length),
            firstError: String(failed[0]?.reason?.message || failed[0]?.reason || '').slice(0, 500),
        });
    }
    return results;
}
