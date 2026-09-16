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
import { showDeleteResult } from './messageExtras';
import { showApiError, showDeleteConfirmModal } from './messageExtras';
import { showModal } from './message';
import type { MsgType, PushFailure } from './message';
import type { DeleteConfirmItem } from './messageExtras';
import type { SyncDeletedResult } from './deletedRowsStore';

export type { DeleteConfirmItem, PushFailure };

/**
 * 从同步删除结果构造「删除失败明细」列表（供 reportDeleteResult 弹窗渲染）。
 *
 * 统一各调用点（编辑器内删除 / 同步已删除行 / 案例文件删除）对
 * `result.failed → PushFailure[]` 的转换口径，避免重复手写 map + 兜底文案。
 *
 * @param result          syncDeletedRows 的返回结果
 * @param fallbackReason  单条失败原因缺失时的兜底文案
 */
export function buildDeleteFailures(
    result: SyncDeletedResult,
    fallbackReason = '线上删除失败',
): PushFailure[] {
    return result.failed.map(f => ({ tsId: f.tsId, reason: f.reason || fallbackReason }));
}

/**
 * 统一把「删除同步结果」回传案例编辑器面板（渲染成功行删除 + 失败行高亮/置灰 + # 列 tooltip）。
 *
 * 收敛编辑器内删除、同步已删除行、案例文件删除三处重复的
 * `postMessage({type:'deleteRowsResult'})` 拼接逻辑（P1 去重），
 * 避免 synced / failed / reasons / deletedSuccess / deletedSourceMissing 字段口径漂移。
 *
 * @param panel 目标 webview 面板；未打开（undefined）时静默跳过，由调用方自行降级（toast/modal）
 * @param input 删除同步结果（可直接传 syncDeletedRows 的返回；或从 PushFailure[] 组装）
 */
export interface PostDeleteRowsResultInput {
    /** 成功删除（type=1 + type=3）的 tsId 列表 */
    synced: ReadonlyArray<string>;
    /** 失败明细（tsId + 原因） */
    failed: ReadonlyArray<{ tsId: string; reason?: string }>;
    /** 线上真实删除成功的 tsId（type=1） */
    deletedSuccess: ReadonlyArray<string>;
    /** 线上本不存在、已同步清理的 tsId（type=3） */
    deletedSourceMissing: ReadonlyArray<string>;
}

export function postDeleteRowsResult(
    panel: vscode.WebviewPanel | undefined,
    input: PostDeleteRowsResultInput,
): void {
    if (!panel) return;
    const failed = input.failed.map(f => ({ tsId: String(f.tsId), reason: String(f.reason || '') }));
    const reasons: Array<[string, string]> = failed.map(f => [f.tsId, f.reason]);
    try {
        panel.webview.postMessage({
            type: 'deleteRowsResult',
            synced: input.synced.map(String),
            failed: failed.map(f => f.tsId),
            reasons,
            deletedSuccess: input.deletedSuccess.map(String),
            deletedSourceMissing: input.deletedSourceMissing.map(String),
        });
    } catch (_) { /* ignore */ }
}

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
 * 线上预检（删除确认接口）失败并**阻断删除**时的弹窗。
 *
 * 与 notifyPrecheckFailure 的区别：
 *   - notifyPrecheckFailure 走 showToast（有 panel 时是页面内轻提示、2 秒自动消失），
 *     用于「仅提示、不阻断删除」的降级场景。
 *   - 本函数始终弹**独立 webview 模态框**（标题「提示」，带「确定」按钮），
 *     用于「校验失败即中止删除」的场景，确保用户看到的是模态提示，且删除确实未执行。
 *
 * @param params.scenePrefix 场景前缀，如「删除前校验未通过」/「删除前校验异常」
 * @param params.returnCode  接口返回码（网络/异常场景可为空）
 * @param params.errorMsg    接口返回的业务错误信息或异常信息
 * @param params.msgType     提示类型，默认 'warning'
 */
export function notifyPrecheckBlocked(params: {
    scenePrefix: string;
    returnCode?: string;
    errorMsg: string;
    msgType?: MsgType;
}): void {
    const _rc = String(params.returnCode || '').trim();
    const _msg = String(params.errorMsg || '').trim();
    const detail = _msg
        ? _msg
        : (_rc ? `返回码 ${_rc}，请稍后重试或联系管理员` : '操作失败，请稍后重试或联系管理员');
    showModal('default', params.msgType ?? 'warning', '提示', `${params.scenePrefix}：${detail}`);
}

/**
 * 删除案例前的确认弹窗（含执行/缺陷关联表格）。
 *
 * @returns true=用户确认删除；false=取消 / 关闭 / token 取消
 */
export async function confirmCaseFileDeleteWithDetails(
    params: {
        filePath: string;
        fileName: string;
        caseCount: number;
        items: DeleteConfirmItem[];
    },
    token?: vscode.CancellationToken,
): Promise<boolean> {
    return showDeleteConfirmModal(
        {
            filePath: params.filePath,
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
