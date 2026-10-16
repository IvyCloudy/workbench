/**
 * ============================================================================
 *  utils/caseDeleteGuard.ts
 *  工作区删除拦截「抑制开关」（极小的路径级共享状态；中性模块、零业务依赖，
 *  故意不依赖 pointCaseDeleter / workspaceListeners，避免循环依赖与依赖倒置）。
 * ----------------------------------------------------------------------------
 *  为什么需要它：
 *    通过要点删除把案例文件清空后，caseFileRecoverableDelete 会用"可恢复删除"把文件
 *    移到回收站（vscode.workspace.fs.delete({ useTrash: true })，与"资源管理器直接删除
 *    案例文件"完全一致）。但该 API 会触发 workspaceListeners 的 onWillDeleteFiles /
 *    onDidDeleteFiles，若不加抑制，插件会把文件备份→还原→弹确认框，破坏"通过要点删除"
 *    的静默清理语义。
 *
 *  用法：
 *    const guard = suppressDeleteForPath(casePath);
 *    try { await vscode.workspace.fs.delete(uri, { useTrash: true }); }
 *    finally { guard.release(); }
 *    workspaceListeners 的两个删除处理器据此对受抑制路径提前跳过，绑定清理仍由
 *    pointCaseDeleter 自己负责。
 *
 *  归一化说明（关键）：
 *    匹配键用 vscode.Uri.file(filePath).fsPath，而非 path.resolve。原因：VS Code 文件事件
 *    里 event.files[].fsPath 同样由 Uri 规范化得到（盘符大小写、分隔符等），用同一套
 *    规范化能保证"本工具 set 的键"与"事件里报上来的 fsPath"在符号链接 / 大小写差异下
 *    仍一致，否则可能抑制失效（文件被还原 + 弹框）。path.resolve 不解析符号链接，
 *    在 /var↔/private/var 等场景下会失配。
 * ============================================================================
 */
import * as vscode from 'vscode';

const suppressedPaths = new Set<string>();

/** 路径归一化：与 VS Code 事件 event.files[].fsPath 同构，避免符号链接 / 大小写差异导致抑制失效。 */
function normalizePath(filePath: string): string {
    return vscode.Uri.file(filePath).fsPath;
}

/** 在删除某路径期间抑制工作区删除拦截；返回 release 用于 finally 释放。 */
export function suppressDeleteForPath(filePath: string): { release: () => void } {
    const key = normalizePath(filePath);
    suppressedPaths.add(key);
    return {
        release: () => {
            suppressedPaths.delete(key);
        },
    };
}

/** 工作区删除拦截处理器据此跳过被抑制的路径（精确匹配，已做 Uri.fsPath 归一化）。 */
export function isDeleteSuppressed(filePath: string): boolean {
    return suppressedPaths.has(normalizePath(filePath));
}
