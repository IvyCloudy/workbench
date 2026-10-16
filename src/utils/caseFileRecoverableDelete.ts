/**
 * ============================================================================
 *  utils/caseFileRecoverableDelete.ts
 *  案例文件「可恢复删除」工具（实现需求文档 F4）
 * ----------------------------------------------------------------------------
 *  职责：用于"通过测试要点删除、案例文件被清空后整体删除"等需要主动删掉案例文件的
 *  场景，使其与"资源管理器直接删除案例文件"在可恢复性上**完全一致**——文件进回收站、
 *  可找回，不再"静默永久丢失"。
 *
 *  做法（仅走回收站，不做额外 tmp 备份）：
 *    1) 复用 VS Code 原生 Move to Trash：`vscode.workspace.fs.delete(uri, { useTrash: true })`
 *       —— 与"资源管理器直接删除案例文件"走的是同一条 OS 回收站路径，用户可从回收站找回；
 *    2) 删除期间通过抑制开关（见 caseDeleteGuard.ts 的 suppressDeleteForPath /
 *       isDeleteSuppressed）抑制 workspaceListeners 的删除拦截
 *       （onWillDeleteFiles / onDidDeleteFiles 对受抑制路径提前跳过），避免插件把文件
 *       备份→还原→弹确认框，保持"通过要点删除"的静默清理语义；
 *    3) 若回收站不可用（无 vscode 环境 / trash 调用失败），降级为 fs.promises.unlink
 *       （此时与"直接删除 trash 失败时"行为一致：直接物理丢失，无额外 tmp 备份）。
 *
 *  设计要点：
 *    - 核心恢复能力来自"回收站"（与直接删除一致），无独立 tmp 备份；
 *    - 抑制开关在独立中性模块 caseDeleteGuard.ts（路径级 Set，零业务依赖），供本工具与
 *      workspaceListeners 共用，避免循环依赖 / 依赖倒置；
 *    - 纯逻辑无副作用风险：任意异常都被吞掉并记录埋点，绝不阻断调用方主流程；
 *    - 仅在 caseFileRecoverableDelete 内直接 import vscode（其他调用方无需感知）。
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TelemetryService } from './telemetry';
import { suppressDeleteForPath } from './caseDeleteGuard';

export interface RecoverableDeleteResult {
    /** 是否成功通过回收站删除（false=降级为物理 unlink） */
    usedTrash: boolean;
    /** 删除后文件是否确实不存在（true=已删成功） */
    deleted: boolean;
    /** 删除失败原因（删除成功为空串） */
    error?: string;
}

/**
 * 把案例文件移到回收站（复用 VS Code 原生 Move to Trash）；trash 不可用时降级物理删除。
 *
 * @param casePath 案例文件绝对路径
 * @returns 是否走回收站 / 是否删除成功 / 失败原因
 */
export async function deleteCaseFileRecoverable(casePath: string): Promise<RecoverableDeleteResult> {
    let usedTrash = false;
    let error: string | undefined;
    const guard = suppressDeleteForPath(casePath);
    try {
        if (typeof vscode?.workspace?.fs?.delete === 'function') {
            await vscode.workspace.fs.delete(vscode.Uri.file(casePath), { useTrash: true });
            usedTrash = true;
        } else {
            // 无 vscode / 无 trash 能力：降级物理删除
            await fs.promises.unlink(casePath);
        }
    } catch (err: any) {
        // trash 失败 → 降级 unlink
        usedTrash = false;
        try {
            await fs.promises.unlink(casePath);
        } catch (err2: any) {
            if ((err2 as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                error = err2?.message || String(err2);
                TelemetryService.sendTelemetryErrorEvent('caseFileRecoverableDelete.unlinkFailed', {
                    filePath: path.basename(casePath),
                    errorMessage: String(err2?.message || err2).slice(0, 500),
                });
            }
        }
    } finally {
        guard.release();
    }

    const deleted = !fs.existsSync(casePath);
    return {
        usedTrash,
        deleted,
        error: deleted ? undefined : (error ?? '删除后文件仍存在'),
    };
}
