/**
 * ============================================================================
 *  utils/deleteFeedback.ts
 *  「案例删除」反馈链路的统一调用入口
 * ----------------------------------------------------------------------------
 *  背景：19683713 → 48dc35b8 期间 utils/message.ts 新增了三块能力：
 *      1. showApiError           —— 后端非成功返回码的统一提示
 *      2. showDeleteConfirmModal —— 含「执行/缺陷关联」表格的删除确认弹窗
 *      3. showDeleteResult       —— 新增 deletedSuccess / deletedSourceMissing 维度
 *  本文件把这三块能力按「删除链路」的语义封装成 3 个高层入口：
 *      notifyPrecheckFailure / confirmCaseFileDeleteWithDetails / reportDeleteResult
 *  业务侧只依赖本文件，不再直接感知 message.ts 的参数细节与顺序。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { showDeleteResult } from './message';
import { showApiError, showDeleteConfirmModal } from './messageExtras';
import type { MsgType, PushFailure } from './message';
import type { DeleteConfirmItem } from './messageExtras';

export type { DeleteConfirmItem, PushFailure };

/**
 * 线上预检（删除确认接口）返回非成功码时的降级提示。
 *
 * 只做提示、不阻断删除：调用方在提示后继续走原生 modal 确认。
 *
 * @param params.panel 目标 webview；不传则走独立 modal 兜底
 */
export function notifyPrecheckFailure(params: {
    /** 目标 webview（有则走内置 toast，无则独立 modal 兜底） */
    panel?: vscode.WebviewPanel | undefined;
    /** 场景前缀，如「删除前校验未通过，已跳过确认步骤」 */
    scenePrefix: string;
    /** 接口返回码（如 'SUC0000' / '2005'） */
    returnCode: string;
    /** 接口返回的业务错误信息 */
    errorMsg: string;
    /** 提示类型，默认 'error'（预检降级场景建议 'warning'） */
    msgType?: MsgType;
}): void {
    showApiError(
        params.panel ?? undefined,
        params.scenePrefix,
        params.returnCode || '',
        params.errorMsg || '',
        params.msgType ?? 'error',
    );
}

/**
 * 删除案例前的确认弹窗（含执行/缺陷关联表格）。
 *
 * @returns true=用户确认删除；false=取消 / 关闭 / token 取消
 */
export async function confirmCaseFileDeleteWithDetails(
    params: {
        fileName: string;
        caseCount: number;
        items: DeleteConfirmItem[];
    },
    token?: vscode.CancellationToken,
): Promise<boolean> {
    return showDeleteConfirmModal(
        {
            fileName: params.fileName,
            caseCount: params.caseCount,
            items: Array.isArray(params.items) ? params.items : [],
        },
        token,
    );
}

/**
 * 删除结果反馈（成功 / 部分成功 / 全部失败）。
 *
 * deletedSuccess / deletedSourceMissing 是本区间新增的两个口径：
 *   - deletedSuccess：type=1 线上真实删除成功数
 *   - deletedSourceMissing：type=3 线上本不存在、已同步清理的数
 */
export function reportDeleteResult(params: {
    panel: vscode.WebviewPanel | undefined;
    fileName: string;
    successCount: number;
    failures: PushFailure[];
    total: number;
    error?: string;
    deletedSuccess?: number;
    deletedSourceMissing?: number;
}): void {
    showDeleteResult(
        params.panel,
        params.fileName,
        params.successCount,
        params.failures,
        params.total,
        params.error,
        params.deletedSuccess,
        params.deletedSourceMissing,
    );
}
