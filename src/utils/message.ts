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
 * ============================================================================
 */
import * as vscode from 'vscode';

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
    const safeMsg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
    :root{--bg:#fff;--bd:#e0e0e0}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;overflow:hidden}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;color:#333}
    .xs-modal-overlay{display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);align-items:center;justify-content:center;z-index:2000}
    .xs-modal-dialog{background:var(--bg);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.2);width:420px;max-width:90vw;display:flex;flex-direction:column;overflow:hidden}
    .xs-modal-header{display:flex;align-items:center;padding:12px 16px;background:${headerBg};border-bottom:1px solid var(--bd);gap:10px;flex-shrink:0}
    .xs-pr-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;font-size:14px;font-weight:bold;color:#fff;background:${color};flex-shrink:0}
    .xs-modal-title{font-size:14px;font-weight:600;flex:1;color:#333}
    .xs-modal-close{cursor:pointer;font-size:16px;color:#666;padding:4px 10px;border-radius:3px;line-height:1;border:none;background:transparent}
    .xs-modal-close:hover{background:#e0e0e0;color:#333}
    .xs-modal-body{flex:1;padding:20px 16px;min-height:60px;font-size:13px;color:#444;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word}
    .xs-modal-footer{display:flex;align-items:center;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--bd);gap:8px;flex-shrink:0}
    .xs-btn{padding:6px 20px;border-radius:3px;font-size:13px;cursor:pointer;border:1px solid #ccc;background:#fff;color:#333;outline:none}
    .xs-btn:hover{background:#f0f0f0}
    .xs-btn-p{background:${color};color:#fff;border-color:${color}}
    .xs-btn-p:hover{opacity:.9}
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
 * - panel 可用 → postMessage({ type:'pushResult', fileName, successCount, failures, total })
 * - panel 不可用 → 独立 webview 模态框展示结果摘要
 */
export function showPushResult(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    successCount: number,
    failures: PushFailure[],
    total: number,
): void {
    if (panel) {
        panel.webview.postMessage({ type: 'pushResult', fileName, successCount, failures, total });
    } else {
        const failCount = failures.length;
        if (failCount === 0) {
            showModal('default', 'success', '推送结果', `推送成功：${fileName}\n共 ${successCount} 条全部成功。`);
        } else if (successCount === 0) {
            showModal('default', 'error', '推送结果',
                `推送失败：${fileName}\n共 ${failCount} 条全部失败。\n\n` +
                failures.map(f => `• ${f.tsId}: ${f.reason}`).join('\n'));
        } else {
            showModal('default', 'warning', '推送结果',
                `推送部分成功：${fileName}\n成功 ${successCount} / 失败 ${failCount} / 共 ${total} 条。\n\n` +
                `失败明细：\n` + failures.map(f => `• ${f.tsId}: ${f.reason}`).join('\n'));
        }
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


