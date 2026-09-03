/**
 * ============================================================================
 *  utils/message.ts
 *  Webview ↔ 扩展端 消息通信公共工具 — 插件唯一弹窗入口
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 封装所有 webview postMessage，统一弹窗入口。
 *    2. panel 可用 → webview 内嵌模态框；
 *       panel 不可用 → 创建独立 webview 面板渲染同款样式，关闭自动销毁。
 *    3. 覆盖：通用模态框 / 轻量 Toast / 推送结果 / 保存结果 / 连接错误。
 *
 *  注：19683713 及之后新增的「删除确认 / 删除结果 / API 错误」相关方法
 *  （showApiError / showDeleteConfirmModal / DeleteConfirmItem 及其内部辅助）
 *  已迁至 ./messageExtras，本文件仅保留基础弹窗入口。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { escapeHtml_, baseModalCss_, formatFailures_, showResultErrorModal_, showResultModalFallback_ } from './messageExtras';

// ============================================
// 类型定义
// ============================================

/** 通用弹窗 / Toast 类型 */
export type MsgType = 'success' | 'error' | 'warning' | 'info';

/** 推送失败条目 */
export interface PushFailure {
    tsId: string;
    reason: string;
    rowIndex?: number;
}

// ============================================
// 内部工具
// ============================================

const MODAL_ICON: Record<MsgType, string> = {
    success: '✓',
    error:   '✕',
    warning: '!',
    info:    'i',
};

const MODAL_COLOR: Record<MsgType, string> = {
    success: '#28a745',
    error:   '#dc3545',
    warning: '#f0a020',
    info:    '#0078d4',
};

const MODAL_HEADER_BG: Record<MsgType, string> = {
    success: 'linear-gradient(180deg,#e6f4ea,#f3faf5)',
    error:   'linear-gradient(180deg,#fdecea,#fdf3f3)',
    warning: 'linear-gradient(180deg,#fef3e0,#fff8ec)',
    info:    'linear-gradient(180deg,#e8f0fe,#f3f8ff)',
};

/**
 * 构建独立 webview 模态框 HTML。
 * 样式与现有 table-editor.css 的 xs-modal-* 体系一致。
 */
function buildStandaloneModalHtml(
    modalType: MsgType,
    title: string,
    message: string,
): string {
    const color = MODAL_COLOR[modalType];
    const headerBg = MODAL_HEADER_BG[modalType];
    const icon = MODAL_ICON[modalType];
    const safeMsg = escapeHtml_(message);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
${baseModalCss_(headerBg, color, 'width:420px;max-width:90vw;')}
    .xs-modal-body{flex:1;padding:20px 16px;min-height:60px;font-size:13px;color:#444;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word}
</style>
</head>
<body>
<div class="xs-modal-overlay" id="overlay">
    <div class="xs-modal-dialog">
        <div class="xs-modal-header">
            <span class="xs-pr-icon">${icon}</span>
            <span class="xs-modal-title">${title}</span>
            <button class="xs-modal-close" id="closeBtn" title="关闭">✕</button>
        </div>
        <div class="xs-modal-body">${safeMsg}</div>
        <div class="xs-modal-footer">
            <button class="xs-btn xs-btn-p" id="okBtn">确定</button>
        </div>
    </div>
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        function close(){ vscode.postMessage({type:'closeStandaloneModal'}); }
        document.getElementById('closeBtn').onclick = close;
        document.getElementById('okBtn').onclick = close;
        document.getElementById('overlay').addEventListener('click',function(e){ if(e.target===this) close(); });
        document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
        document.getElementById('okBtn').focus();
    })();
</script>
</body>
</html>`;
}

// ============================================
// 1. 通用模态框 (showModal)
// ============================================

/**
 * 通用弹窗提示（页面居中模态框）。
 *
 * @param panel  目标 webview；传 'default' 表示无 webview，使用独立模态框面板。
 *
 * - panel 可用 → postMessage({ type:'showModal', modalType, title, message })
 *   → 前端监听 'showModal' 渲染同款模态框。
 * - panel = 'default' → 创建独立 webview 面板渲染同款样式，关闭时自动销毁。
 */
export function showModal(
    panel: 'default',
    modalType: MsgType,
    title: string,
    message: string,
    fileName?: string,
): void;
export function showModal(
    panel: vscode.WebviewPanel | undefined,
    modalType: MsgType,
    title: string,
    message: string,
    fileName?: string,
): void;
export function showModal(
    panel: vscode.WebviewPanel | undefined | 'default',
    modalType: MsgType,
    title: string,
    message: string,
    fileName?: string,
): void {
    if (panel && panel !== 'default') {
        panel.webview.postMessage({ type: 'showModal', modalType, title, message, fileName });
    } else {
        const modalPanel = vscode.window.createWebviewPanel(
            'standaloneModal',
            title,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: false,
            },
        );
        modalPanel.webview.html = buildStandaloneModalHtml(modalType, title, message);
        modalPanel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'closeStandaloneModal') {
                modalPanel.dispose();
            }
        });
    }
}

// ============================================
// 2. 轻量 Toast (showToast)
// ============================================

/**
 * 轻量级 Toast 提示（底部短暂弹出，2 秒自动消失）。
 *
 * - panel 可用 → postMessage({ type:'showToast', toastType, message })
 * - panel 不可用 → 独立 webview 模态框兜底
 */
export function showToast(
    panel: vscode.WebviewPanel | undefined,
    toastType: MsgType,
    message: string,
): void {
    if (panel) {
        panel.webview.postMessage({ type: 'showToast', toastType, message });
    } else {
        showModal('default', toastType, '提示', message);
    }
}

// ============================================
// 3. 推送错误弹窗 (showPushErrorModal)
// ============================================

/**
 * 推送错误弹窗（兼容现有 pushResult 消息类型，前端已有渲染逻辑）。
 *
 * - panel 可用 → postMessage({ type:'pushResult', fileName, error })
 * - panel 不可用 → 独立 webview 错误模态框
 */
export function showPushErrorModal(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    errorText: string,
): void {
    if (panel) {
        panel.webview.postMessage({ type: 'pushResult', fileName, error: errorText });
    } else {
        showModal('default', 'error', fileName, errorText);
    }
}

// ============================================
// 4. 推送结果弹窗 (showPushResult)
// ============================================

/**
 * 推送结果弹窗（成功 / 部分成功 / 全部失败）。
 *
 * @param error   推送流程级错误（如 YAML 语法错误、文件不在合规目录等），
 *                前端 showPushResultModal 会以红色错误分支渲染，不会误判为"成功"。
 * @param skipped 本次被识别为样例/模板占位而静默跳过的行数（不计入 successCount/failures）。
 *                默认 0；仅当 > 0 时前端弹窗会显示"跳过 N"这一维度以及"其中 N 行样例数据已跳过"提示。
 *                有它才能解释"total 13 = success 12 + fail 0 + skipped 1"这种视觉对不上的情形。
 *
 * - panel 可用 → postMessage({ type:'pushResult', fileName, successCount, failures, total, skipped, error })
 * - panel 不可用 → 独立 webview 模态框展示结果摘要
 */
export function showPushResult(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    successCount: number,
    failures: PushFailure[],
    total: number,
    error?: string,
    skipped: number = 0,
): void {
    if (panel) {
        panel.webview.postMessage({ type: 'pushResult', fileName, successCount, failures, total, skipped, error });
    } else {
        // 独立模态框：如果有 error（流程级错误），直接展示错误，不走 successCount/failures 逻辑
        if (error) {
            showResultErrorModal_({
                verb: '推送', title: '推送结果', fileName, error, total, allText: '全部未推送',
            });
            return;
        }
        const failCount = failures.length;
        const skipHint = skipped > 0 ? `（其中 ${skipped} 行样例数据已跳过）` : '';
        showResultModalFallback_({
            title: '推送结果',
            successCount,
            failures,
            texts: {
                noResult: `推送未产生结果：${fileName}\n请检查文件后重试。`,
                allSuccess: `推送成功：${fileName}\n共 ${successCount} 条全部成功${skipHint}。`,
                allFail: `推送失败：${fileName}\n共 ${failCount} 条全部失败${skipHint}。\n\n` + formatFailures_(failures),
                partial: `推送部分成功：${fileName}\n成功 ${successCount} / 失败 ${failCount} / 共 ${total} 条${skipHint}。\n\n`
                    + `失败明细：\n` + formatFailures_(failures),
            },
        });
    }
}

// ============================================
// 5. 保存结果提示 (showSaveResult)
// ============================================

/**
 * 保存结果提示。
 *
 * - 成功：postMessage({ type:'saved' }) — 前端清除修改集并重渲染
 * - 失败：postMessage({ type:'saveError', message }) — 前端 toast 提示
 * - 无 panel → 独立 webview 模态框
 */
export function showSaveResult(
    panel: vscode.WebviewPanel | undefined,
    success: boolean,
    errorMessage?: string,
): void {
    if (panel) {
        panel.webview.postMessage(
            success ? { type: 'saved' } : { type: 'saveError', message: errorMessage || '保存失败' }
        );
    } else {
        if (success) {
            showModal('default', 'success', '保存结果', '保存成功');
        } else {
            showModal('default', 'error', '保存失败', errorMessage || '操作失败，请重试。');
        }
    }
}

// ============================================
// 6. 推送完成通知 (showPushDone)
// ============================================

/**
 * 推送流程完成通知（用于解锁前端的推送按钮 loading 状态）。
 */
export function showPushDone(panel: vscode.WebviewPanel | undefined): void {
    if (panel) {
        panel.webview.postMessage({ type: 'pushDone' });
    }
}
