/**
 * ============================================================================
 *  utils/modalShared.ts
 *  「独立 webview 弹窗」通用工具集（HTML 转义 / 基础样式 / 结果类兜底文案）
 * ----------------------------------------------------------------------------
 *  由 messageExtras.ts 拆分而来（原始 barrel 保留在 messageExtras.ts 中做
 *  re-export，外部无需改动 import 路径）。
 *
 *  职责边界：
 *    - 仅提供「HTML 转义 / 通用样式 / 结果类模态框兜底」等最底层复用能力，
 *      不包含任何"删除确认/结果"业务语义；业务语义分别落在：
 *        · deleteConfirmModal.ts        —— 单文件删除确认
 *        · batchDeleteConfirmModal.ts   —— 多文件批量删除确认
 *        · deleteResultModal.ts         —— 删除结果 + API 错误提示
 *
 *  依赖方向：
 *    - message.ts 使用本文件的 escapeHtml_ / baseModalCss_ /
 *      formatFailures_ / showResultErrorModal_ / showResultModalFallback_。
 *    - 本文件使用 message.ts 的 showModal（运行时调用，不在模块顶层执行）。
 *    两者形成受控循环引用，ESM 下函数绑定可安全前向引用（与拆分前一致）。
 * ============================================================================
 */
import { showModal } from './message';
import type { MsgType, PushFailure } from './message';

// 删除确认弹窗固定使用 warning 配色（取值与 message.ts 内 MODAL_COLOR / MODAL_HEADER_BG 的 warning 项一致）
export const MODAL_COLOR_WARNING = '#f0a020';
export const MODAL_HEADER_BG_WARNING = 'linear-gradient(180deg,#fef3e0,#fff8ec)';

/** HTML 转义，避免案例名称等字段破坏结构 / 注入脚本 */
export function escapeHtml_(s: unknown): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 独立 webview 弹窗的公共样式（xs-modal-* 体系，与 table-editor.css 一致）。
 * 通用模态框与删除确认弹窗共用，避免两套 CSS 各自维护、改一处漏一处。
 *
 * @param headerBg    头部渐变背景（按消息类型取色）
 * @param color       主题色（图标 / 主按钮）
 * @param dialogExtra 对话框尺寸差异（宽度 / 最大高度等）
 */
export function baseModalCss_(headerBg: string, color: string, dialogExtra: string): string {
    return `    :root{--bg:#fff;--bd:#e0e0e0}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;overflow:hidden}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;color:#333}
    .xs-modal-overlay{display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);align-items:center;justify-content:center;z-index:2000}
    .xs-modal-dialog{background:var(--bg);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.2);${dialogExtra}display:flex;flex-direction:column;overflow:hidden}
    .xs-modal-header{display:flex;align-items:center;padding:12px 16px;background:${headerBg};border-bottom:1px solid var(--bd);gap:10px;flex-shrink:0}
    .xs-pr-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;font-size:14px;font-weight:bold;color:#fff;background:${color};flex-shrink:0}
    .xs-modal-title{font-size:14px;font-weight:600;flex:1;color:#333}
    .xs-modal-close{cursor:pointer;font-size:16px;color:#666;padding:4px 10px;border-radius:3px;line-height:1;border:none;background:transparent}
    .xs-modal-close:hover{background:#e0e0e0;color:#333}
    .xs-modal-footer{display:flex;align-items:center;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--bd);gap:8px;flex-shrink:0}
    .xs-btn{padding:6px 20px;border-radius:3px;font-size:13px;cursor:pointer;border:1px solid #ccc;background:#fff;color:#333;outline:none}
    .xs-btn:hover{background:#f0f0f0}
    .xs-btn-p{background:${color};color:#fff;border-color:${color}}
    .xs-btn-p:hover{opacity:.9}`;
}

/** 失败明细列表（推送结果 / 删除结果共用） */
export function formatFailures_(failures: PushFailure[]): string {
    return (failures || []).map(f => `• ${f.tsId}: ${f.reason}`).join('\n');
}

/**
 * 「结果类」弹窗在无 panel 时的流程级错误分支（推送 / 删除共用）。
 *
 * @param verb    动作名，如 '推送' / '删除'
 * @param allText 「共 N 条」的补充，如 '全部未推送' / '全部未删除'
 */
export function showResultErrorModal_(params: {
    verb: string;
    title: string;
    fileName: string;
    error: string;
    total: number;
    allText: string;
}): void {
    showModal('default', 'error', params.title,
        `${params.verb}失败：${params.fileName}\n\n${params.error}`
        + (params.total > 0 ? `\n\n共 ${params.total} 条，${params.allText}。` : ''));
}

/**
 * 「结果类」弹窗在无 panel 时的兜底展示（推送 / 删除共用）。
 *
 * 两者的四分支（无结果 / 全部成功 / 全部失败 / 部分成功）判定与弹窗类型完全一致，
 * 仅文案不同，故在此统一判定；文案由调用方按业务语义提供。
 */
export function showResultModalFallback_(params: {
    title: string;
    successCount: number;
    failures: PushFailure[];
    texts: {
        /** 0 成功 0 失败 */
        noResult: string;
        /** 全部成功 */
        allSuccess: string;
        /** 全部失败（已含失败明细） */
        allFail: string;
        /** 部分成功（已含失败明细） */
        partial: string;
    };
}): void {
    const failCount = params.failures.length;
    let modalType: MsgType;
    let message: string;
    if (failCount === 0 && params.successCount === 0) {
        modalType = 'warning';
        message = params.texts.noResult;
    } else if (failCount === 0) {
        modalType = 'success';
        message = params.texts.allSuccess;
    } else if (params.successCount === 0) {
        modalType = 'error';
        message = params.texts.allFail;
    } else {
        modalType = 'warning';
        message = params.texts.partial;
    }
    showModal('default', modalType, params.title, message);
}
