/**
 * ============================================================================
 *  utils/messageExtras.ts
 *  message.ts 在提交 19683713 及之后新增的「删除确认 / 删除结果 / API 错误」
 *  相关能力。
 * ----------------------------------------------------------------------------
 *  迁出目的：让 message.ts 仅保留基础弹窗入口（showModal / showToast /
 *  showPushErrorModal / showPushResult / showDeleteResult / showSaveResult /
 *  showPushDone / buildStandaloneModalHtml），本文件承载后续迭代新增的
 *  业务方法，便于独立维护与测试。
 *
 *  依赖方向：
 *    - 本文件使用 message.ts 的基础方法 showModal / showToast（运行时调用）。
 *    - message.ts 使用本文件的辅助函数（escapeHtml_ / baseModalCss_ /
 *      formatFailures_ / showResultErrorModal_ / showResultModalFallback_）。
 *    两者形成受控的循环引用，但均为"函数声明 + 运行期调用"，模块顶层不执行
 *    调用，ESM 下函数绑定可安全前向引用。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { showModal, showToast } from './message';
import type { MsgType, PushFailure } from './message';

// 删除确认弹窗固定使用 warning 配色（取值与 message.ts 内 MODAL_COLOR / MODAL_HEADER_BG 的 warning 项一致）
const MODAL_COLOR_WARNING = '#f0a020';
const MODAL_HEADER_BG_WARNING = 'linear-gradient(180deg,#fef3e0,#fff8ec)';

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

/** 需要用户确认的案例条目（来自删除确认接口 type=2） */
export interface DeleteConfirmItem {
    sourceId: string;
    testcaseNo: string;
    testCaseName: string;
    /** 是否存在执行关联 */
    hasExec: boolean;
    /** 是否存在缺陷关联 */
    hasBug: boolean;
}

/**
 * 构建「删除案例确认」独立 webview 弹窗 HTML。
 *
 * 布局与表编辑器内删除确认保持一致：
 *   第 1 段：谨慎操作：删除「文件」将同步删除 TMS 平台上的 N 条案例，
 *            并同步删除其执行和缺陷关联关系。如需继续操作，请忽略本提示（Y：存在，N：不存在）：
 *   第 2 段：表格（编号 / 名称 / 执行 / 缺陷），true→Y，false→N
 *   第 3 段：删除不可恢复，是否确认删除
 */
function buildDeleteConfirmHtml(
    fileName: string,
    caseCount: number,
    items: DeleteConfirmItem[],
): string {
    const color = MODAL_COLOR_WARNING;
    const headerBg = MODAL_HEADER_BG_WARNING;

    const rowsHtml = items.map(it => {
        const exec = it.hasExec ? 'Y' : 'N';
        const bug = it.hasBug ? 'Y' : 'N';
        return `<tr>`
            + `<td class="xs-dc-td xs-dc-no">${escapeHtml_(it.testcaseNo || it.sourceId)}</td>`
            + `<td class="xs-dc-td xs-dc-name">${escapeHtml_(it.testCaseName)}</td>`
            + `<td class="xs-dc-td xs-dc-flag" data-flag="${exec}">${exec}</td>`
            + `<td class="xs-dc-td xs-dc-flag" data-flag="${bug}">${bug}</td>`
            + `</tr>`;
    }).join('');

    const lead = `谨慎操作：删除文件「${escapeHtml_(fileName)}」会同步删除 TMS 平台上的 ${caseCount} 条案例，`
        + `并同步删除其执行和缺陷关联关系。如需继续操作，请忽略本提示（Y：存在，N：不存在）：`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>删除案例</title>
<style>
${baseModalCss_(headerBg, color, 'width:620px;max-width:92vw;max-height:88vh;')}
    .xs-modal-body{flex:1;padding:16px;min-height:60px;overflow:auto}
    .xs-dc-lead{font-size:13px;line-height:1.7;color:#333;margin:0 0 8px}
    .xs-dc-tail{font-size:13px;line-height:1.7;color:#333;margin:10px 0 0}
    .xs-dc-table-wrap{max-height:300px;overflow:auto;border:1px solid #e3e3e3;border-radius:3px}
    .xs-dc-table{width:100%;border-collapse:collapse;font-size:12px}
    .xs-dc-table th{position:sticky;top:0;background:#fafafa;font-weight:600;color:#555;text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3;white-space:nowrap}
    .xs-dc-table td{padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#333;word-break:break-all}
    .xs-dc-table tbody tr:last-child td{border-bottom:none}
    .xs-dc-table tbody tr:nth-child(even){background:#fcfcfc}
    .xs-dc-no{width:34%;color:#666}
    .xs-dc-name{width:44%}
    .xs-dc-table td.xs-dc-flag{width:11%;text-align:center;font-weight:600;color:#c0392b}
    .xs-dc-table td.xs-dc-flag[data-flag="N"]{color:#999;font-weight:400}
</style>
</head>
<body>
<div class="xs-modal-overlay" id="overlay">
    <div class="xs-modal-dialog">
        <div class="xs-modal-header">
            <span class="xs-pr-icon">!</span>
            <span class="xs-modal-title">删除案例</span>
            <button class="xs-modal-close" id="closeBtn" title="关闭">✕</button>
        </div>
        <div class="xs-modal-body">
            <div class="xs-dc-lead">${lead}</div>
            <div class="xs-dc-table-wrap">
                <table class="xs-dc-table">
                    <thead><tr><th>编号</th><th>名称</th><th>执行</th><th>缺陷</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
            <div class="xs-dc-tail">删除不可恢复，是否确认删除</div>
        </div>
        <div class="xs-modal-footer">
            <button class="xs-btn" id="cancelBtn">取消</button>
            <button class="xs-btn xs-btn-p" id="okBtn">确定删除</button>
        </div>
    </div>
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        var settled = false;
        function done(v){ if(settled) return; settled = true; vscode.postMessage({type:'deleteConfirmResult', confirmed:v}); }
        document.getElementById('okBtn').onclick = function(){ done(true); };
        document.getElementById('cancelBtn').onclick = function(){ done(false); };
        document.getElementById('closeBtn').onclick = function(){ done(false); };
        document.getElementById('overlay').addEventListener('click',function(e){ if(e.target===this) done(false); });
        document.addEventListener('keydown',function(e){
            if(e.key==='Escape'){ e.preventDefault(); done(false); }
            else if(e.key==='Enter'){ e.preventDefault(); done(true); }
        });
        document.getElementById('okBtn').focus();
    })();
</script>
</body>
</html>`;
}

/**
 * 展示「删除案例确认」弹窗（含执行/缺陷关联表格），阻塞等待用户选择。
 *
 * 与 confirmCaseFileDelete（VSCode 原生 modal）的区别：
 *   - 原生 modal 只能渲染纯文本，无法展示表格；本函数用独立 webview 承载表格。
 *   - 独立 webview 由本函数自己创建，**不依赖案例编辑器 panel**
 *     （文件删除场景下 panel 可能不存在或已被销毁）。
 *
 * 结算保证（避免 waitUntil 永久挂起）：
 *   - 用户点「确定删除」→ true；点「取消」/「✕」/遮罩/ESC → false
 *   - 面板被销毁（onDidDispose）→ false
 *   - CancellationToken 被取消（用户在 VSCode 进度条点 Cancel）→ 关闭面板并 false
 *
 * @returns true=用户确认删除；false=取消 / 关闭 / token 取消
 */
export function showDeleteConfirmModal(
    opts: { fileName: string; caseCount: number; items: DeleteConfirmItem[] },
    token?: vscode.CancellationToken,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'deleteConfirmModal',
            '删除案例',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: false },
        );
        panel.webview.html = buildDeleteConfirmHtml(
            opts.fileName, opts.caseCount, Array.isArray(opts.items) ? opts.items : [],
        );

        let settled = false;
        const finish = (v: boolean) => {
            if (settled) return;
            settled = true;
            try { panel.dispose(); } catch { /* ignore */ }
            resolve(v);
        };

        panel.webview.onDidReceiveMessage(msg => {
            if (msg?.type === 'deleteConfirmResult') finish(!!msg.confirmed);
        });
        panel.onDidDispose(() => finish(false));
        // 用户在 VSCode 进度条点 Cancel → 立即结算，避免 waitUntil 挂起
        if (token) {
            token.onCancellationRequested(() => finish(false));
            if (token.isCancellationRequested) finish(false);
        }
    });
}

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
