/**
 * ============================================================================
 *  utils/deleteResultModal.ts
 *  「删除结果」+「后端 API 错误」的统一提示入口
 * ----------------------------------------------------------------------------
 *  由 messageExtras.ts 拆分而来。承载两块能力：
 *    · showApiError       —— 后端非成功返回码 → 场景前缀 + returnCode/errorMsg 统一 toast
 *    · showDeleteResult   —— 删除成功/部分/失败结果（带 deletedSuccess /
 *                            deletedSourceMissing 两个维度）
 *
 *  两者共同点：目标 panel 存在时走 postMessage；panel 不可用时走独立 webview
 *  兜底（showModal + showResultErrorModal_ / showResultModalFallback_）。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { showToast } from './message';
import type { MsgType, PushFailure } from './message';
import {
    formatFailures_,
    showResultErrorModal_,
    showResultModalFallback_,
} from './modalShared';

/**
 * 统一展示「后端接口返回非成功返回码」的错误提示。
 *
 * 规则：
 *   - errorMsg 非空 → 直接透出业务文案（这是后端给用户的真实语义）。
 *   - errorMsg 为空 → 兜底文案带上 returnCode，避免用户看到裸错误。
 *
 * @param panel       目标 webview（有则走内置 toast，无则独立 modal 兜底）
 * @param msgType     提示类型，默认 'error'
 * @param scenePrefix 场景前缀，如「删除前校验未通过」「案例删除失败」等
 * @param returnCode  接口返回码（如 'SUC0000' / '2005' / ...）
 * @param errorMsg    接口返回的业务错误信息
 */
export function showApiError(
    panel: vscode.WebviewPanel | undefined,
    scenePrefix: string,
    returnCode: string,
    errorMsg: string,
    msgType: MsgType = 'error',
): void {
    const _rc = String(returnCode || '').trim();
    const _msg = String(errorMsg || '').trim();
    const detail = _msg
        ? _msg
        : (scenePrefix.indexOf(_rc) >= 0 || !_rc
            ? '操作失败，请稍后重试或联系管理员'
            : `返回码 ${_rc}，请稍后重试或联系管理员`);
    showToast(panel, msgType, `${scenePrefix}：${detail}`);
}

// ============================================
// 删除结果弹窗 (showDeleteResult)
// ============================================

/**
 * 删除结果弹窗（成功 / 部分成功 / 全部失败）。
 *
 * 与 showPushResult 同款签名，但消息类型为 'deleteResult'，
 * 前端 05f-delete-result.js 会渲染专属删除文案（"删除成功/删除失败/删除部分成功"），
 * 且不会污染推送高亮状态。
 *
 * - panel 可用 → postMessage({ type:'deleteResult', fileName, successCount, failures, total, error })
 * - panel 不可用 → 独立 webview 模态框展示结果摘要（复用 showModal）
 */
export function showDeleteResult(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    successCount: number,
    failures: PushFailure[],
    total: number,
    error?: string,
    /** type=1 线上删除成功数（与 successCount 中"真实存在并删除"的部分对应） */
    deletedSuccess?: number,
    /** type=3 sourceId 不存在仍算删除成功的数（汇总口径上需与 type=1 区分） */
    deletedSourceMissing?: number,
): void {
    const _deletedSuccess = typeof deletedSuccess === 'number' ? deletedSuccess : successCount;
    const _deletedSourceMissing = typeof deletedSourceMissing === 'number' ? deletedSourceMissing : 0;
    if (panel) {
        panel.webview.postMessage({
            type: 'deleteResult', fileName, successCount, failures, total, error,
            deletedSuccess: _deletedSuccess,
            deletedSourceMissing: _deletedSourceMissing,
        });
        return;
    }
    if (error) {
        showResultErrorModal_({
            verb: '删除', title: '删除结果', fileName, error, total, allText: '全部未删除',
        });
        return;
    }
    const failCount = failures.length;
    // 无面板兜底文案：标注"其中 N 条线上本不存在"
    const _missingHint = _deletedSourceMissing > 0 ? `（其中 ${_deletedSourceMissing} 条线上本不存在，已同步清理）` : '';
    showResultModalFallback_({
        title: '删除结果',
        successCount,
        failures,
        texts: {
            noResult: `删除未产生结果：${fileName}\n请检查文件后重试。`,
            allSuccess: `删除成功：${fileName}\n共 ${successCount} 条全部删除成功。${_missingHint}`,
            allFail: `删除失败：${fileName}\n共 ${failCount} 条全部失败。\n\n` + formatFailures_(failures),
            partial: `删除部分成功：${fileName}\n成功 ${successCount} / 失败 ${failCount} / 共 ${total} 条。${_missingHint}\n\n`
                + `失败明细：\n` + formatFailures_(failures),
        },
    });
}
