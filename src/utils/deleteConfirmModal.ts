/**
 * ============================================================================
 *  utils/deleteConfirmModal.ts
 *  「单文件删除案例」确认弹窗（含关联表格版 + 无关联表格简化版）
 * ----------------------------------------------------------------------------
 *  由 messageExtras.ts 拆分而来。承载单文件（N=1）删除路径的两个确认弹窗：
 *    · showDeleteConfirmModal        —— 含 type=2 执行/缺陷关联表格
 *    · showDeleteConfirmSimpleModal  —— 无关联案例的简洁版（首段直陈影响面）
 *
 *  两者视觉规格完全一致（warning 配色 / 铺满 panel / 15px header / 20px body /
 *  10px footer），交互与结算保证相同：
 *    - 用户点「确定删除」→ true；点「取消」/ ESC / 关闭 Tab / token 取消 → false。
 *
 *  批量（N≥2）路径的确认弹窗位于 batchDeleteConfirmModal.ts，不在此文件。
 * ============================================================================
 */
import * as vscode from 'vscode';
import {
    MODAL_COLOR_WARNING,
    MODAL_HEADER_BG_WARNING,
    escapeHtml_,
    baseModalCss_,
} from './modalShared';

/** 需要用户确认的案例条目（来自删除确认接口 type=2） */
export interface DeleteConfirmItem {
    sourceId: string;
    testCaseNo: string;
    testCaseName: string;
    /** 是否存在执行关联：'Y' 存在 / 'N' 不存在 */
    hasExec: string;
    /** 是否存在缺陷关联：'Y' 存在 / 'N' 不存在 */
    hasBug: string;
}

/**
 * 构建「删除案例确认」独立 webview 弹窗 HTML。
 *
 * 布局与表编辑器内删除确认保持一致：
 *   第 1 段：谨慎操作：删除「文件」将同步删除 TMS 平台上的 N 条案例，
 *            并同步删除其执行和缺陷关联关系。如需继续操作，请忽略本提示（Y：存在，N：不存在）：
 *   第 2 段：表格（编号 / 名称 / 执行 / 缺陷），Y=存在 / N=不存在
 *   第 3 段：删除不可恢复，是否确认删除
 */
function buildDeleteConfirmHtml(
    filePath: string,
    fileName: string,
    caseCount: number,
    items: DeleteConfirmItem[],
): string {
    const color = MODAL_COLOR_WARNING;
    const headerBg = MODAL_HEADER_BG_WARNING;

    const rowsHtml = items.map((it, idx) => {
        const exec = String(it.hasExec).trim().toUpperCase() === 'Y' ? 'Y' : 'N';
        const bug = String(it.hasBug).trim().toUpperCase() === 'Y' ? 'Y' : 'N';
        return `<tr>`
            + `<td class="xs-dc-td xs-dc-idx">${idx + 1}</td>`
            + `<td class="xs-dc-td xs-dc-no">${escapeHtml_(it.testCaseNo)}</td>`
            + `<td class="xs-dc-td xs-dc-name">${escapeHtml_(it.testCaseName)}</td>`
            + `<td class="xs-dc-td xs-dc-flag" data-flag="${exec}">${exec}</td>`
            + `<td class="xs-dc-td xs-dc-flag" data-flag="${bug}">${bug}</td>`
            + `</tr>`;
    }).join('');

    // 导语：聚焦「影响面」，文件路径独立成行展示；用户视线路径为「路径 → 影响面 → 表格 → footer 提示」
    const lead = `谨慎操作：删除本文件将同步删除 TMS 平台上的 `
        + `<span class="xs-dc-count">${caseCount}</span> 条案例，`
        + `以及这些案例的执行记录和缺陷关联。`;
    // 表格上方独立 hint：说明表格的含义与 Y/N 语义
    const tblHint = items.length > 0
        ? `以下 <b>${items.length}</b> 条案例存在执行/缺陷关联（下表「执行」「缺陷」列，Y=存在，N=不存在）：`
        : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>删除案例</title>
<style>
${baseModalCss_(headerBg, color, '')}
    /* ------------------------------------------------------------------ *
     * 去弹窗化覆盖（本页专用）：与「批量删除案例」保持一致，直接铺满整个
     * webview panel，不再呈现「浮在遮罩上的居中卡片」。baseModalCss_ 的
     * dialogExtra 故意传空串——本页对 .xs-modal-dialog 的宽高会被下方
     * 规则以 !important 全量覆盖为 100%。header 视觉规格同步对齐 pushUI。
     * ------------------------------------------------------------------ */
    html,body{margin:0;padding:0;height:100%;background:var(--bg,#fff)}
    .xs-modal-overlay{position:static;display:flex;flex-direction:column;background:transparent;align-items:stretch;justify-content:flex-start;height:100vh;min-height:100vh}
    .xs-modal-dialog{width:100% !important;min-width:0 !important;max-width:none !important;height:100vh !important;max-height:100vh !important;border-radius:0;box-shadow:none;flex:1 1 auto}
    .xs-modal-header{padding:16px 20px}
    .xs-pr-icon{width:28px;height:28px;font-size:16px}
    .xs-modal-title{font-size:15px}
    .xs-modal-body{flex:1;padding:16px 20px;min-height:60px;overflow:auto}
    .xs-dc-file-path{font-size:12px;color:#888;margin-bottom:6px;word-break:break-all;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace}
    .xs-dc-lead{font-size:13px;line-height:1.7;color:#333;margin:0 0 8px}
    .xs-dc-tbl-hint{font-size:13px;color:#333;line-height:1.7;margin:0 0 6px}
    .xs-dc-tbl-hint b{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
    .xs-dc-table-wrap{max-height:320px;overflow:auto;border:1px solid #e3e3e3;border-radius:3px}
    .xs-dc-table{width:100%;border-collapse:collapse;font-size:12px}
    .xs-dc-table th{position:sticky;top:0;background:#fafafa;font-weight:600;color:#555;text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3;white-space:nowrap}
    .xs-dc-table th.xs-dc-th-c{text-align:center}
    .xs-dc-table td{padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#333;word-break:break-all}
    .xs-dc-table tbody tr:last-child td{border-bottom:none}
    .xs-dc-table tbody tr:nth-child(even){background:#fcfcfc}
    .xs-dc-idx{width:8%;color:#999;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
    .xs-dc-no{width:28%;color:#666;white-space:nowrap}
    .xs-dc-name{width:40%}
    .xs-dc-phase{width:12%;color:#666}
    .xs-dc-table td.xs-dc-flag{width:12%;text-align:center;font-weight:600;color:#c0392b}
    .xs-dc-table td.xs-dc-flag[data-flag="N"]{color:#999;font-weight:400}
    .xs-dc-count{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
    /* footer 左侧提示：与批量版对齐（xs-modal-footer 由 baseModalCss_ 提供 flex 布局） */
    .xs-dc-footer-hint{flex:1;font-size:12px;color:#888;line-height:1.6}
</style>
</head>
<body>
<div class="xs-modal-overlay" id="overlay">
    <div class="xs-modal-dialog">
        <div class="xs-modal-header">
            <span class="xs-pr-icon">!</span>
            <span class="xs-modal-title">删除案例（同步删除 TMS 平台 ${caseCount} 条案例）</span>
        </div>
        <div class="xs-modal-body">
            <div class="xs-dc-file-path" title="${escapeHtml_(filePath)}">${escapeHtml_(filePath)}</div>
            <div class="xs-dc-lead">${lead}</div>
            ${tblHint ? `<div class="xs-dc-tbl-hint">${tblHint}</div>` : ''}
            <div class="xs-dc-table-wrap">
                <table class="xs-dc-table">
<thead><tr><th class="xs-dc-th-c xs-dc-th-idx" title="序号">#</th><th>编号</th><th>名称</th><th class="xs-dc-th-c">执行</th><th class="xs-dc-th-c">缺陷</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </div>
        <div class="xs-modal-footer">
            <div class="xs-dc-footer-hint">删除不可恢复</div>
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
        // 删除是高风险操作：用户如需取消，请明确点击「取消」按钮 / 关闭 Tab / 按 ESC。
        document.addEventListener('keydown',function(e){
            if(e.key==='Escape'){ e.preventDefault(); done(false); }
            else if(e.key==='Enter'){ e.preventDefault(); done(true); }
        });
        // 默认聚焦「取消」按钮，防止用户下意识按 Enter/Space 直接触发不可恢复的删除。
        document.getElementById('cancelBtn').focus();
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
    opts: { filePath: string; fileName: string; caseCount: number; items: DeleteConfirmItem[] },
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
            opts.filePath, opts.fileName, opts.caseCount, Array.isArray(opts.items) ? opts.items : [],
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
 * 构建「删除案例确认」**无关联表格**版独立 webview 弹窗 HTML。
 *
 * 与 buildDeleteConfirmHtml 的区别：
 *   - 无 type=2 关联明细（删除确认接口未返回需二次确认的案例）时用本函数；
 *   - 文案用首段直接说明"会同步删除 N 条案例"（不带"Y/N 说明"），保持简洁。
 *
 * 样式与 baseModalCss_ 完全一致（warning 配色 / 420px 宽 / 12px 16px header / 20px 16px body / 10px 16px footer），
 * 与「案例编辑器内删除」弹窗视觉完全统一。
 */
function buildDeleteConfirmSimpleHtml(filePath: string, fileName: string, caseCount: number): string {
    const color = MODAL_COLOR_WARNING;
    const headerBg = MODAL_HEADER_BG_WARNING;
    const lead = `谨慎操作：删除文件「${escapeHtml_(fileName)}」将同步删除 TMS 平台上的 `
        + `<span class="xs-dc-count">${caseCount}</span> 条案例，以及这些案例的执行记录和缺陷关联，此操作不可恢复。是否确定删除？`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>删除案例</title>
<style>
${baseModalCss_(headerBg, color, '')}
    /* ------------------------------------------------------------------ *
     * 去弹窗化覆盖（本页专用）：与「批量删除案例」/「删除结果」等页保持一致，
     * 直接铺满整个 webview panel。dialogExtra 传空串；.xs-modal-dialog 的宽高
     * 由下方规则以 !important 全量覆盖为 100%。header 规格同步对齐 pushUI。
     * ------------------------------------------------------------------ */
    html,body{margin:0;padding:0;height:100%;background:var(--bg,#fff)}
    .xs-modal-overlay{position:static;display:flex;flex-direction:column;background:transparent;align-items:stretch;justify-content:flex-start;height:100vh;min-height:100vh}
    .xs-modal-dialog{width:100% !important;min-width:0 !important;max-width:none !important;height:100vh !important;max-height:100vh !important;border-radius:0;box-shadow:none;flex:1 1 auto}
    .xs-modal-header{padding:16px 20px}
    .xs-pr-icon{width:28px;height:28px;font-size:16px}
    .xs-modal-title{font-size:15px}
    .xs-modal-body{flex:1;padding:20px;min-height:60px;font-size:13px;color:#444;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;overflow:auto}
    .xs-dc-file-path{font-size:12px;color:#888;margin-bottom:10px;word-break:break-all;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;white-space:normal}
    .xs-dc-count{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
</style>
</head>
<body>
<div class="xs-modal-overlay" id="overlay">
    <div class="xs-modal-dialog">
        <div class="xs-modal-header">
            <span class="xs-pr-icon">!</span>
            <span class="xs-modal-title">删除案例</span>
        </div>
        <div class="xs-modal-body"><div class="xs-dc-file-path" title="${escapeHtml_(filePath)}">${escapeHtml_(filePath)}</div>${lead}</div>
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
        // 删除是高风险操作：用户如需取消，请明确点击「取消」按钮 / 关闭 Tab / 按 ESC。
        document.addEventListener('keydown',function(e){
            if(e.key==='Escape'){ e.preventDefault(); done(false); }
            else if(e.key==='Enter'){ e.preventDefault(); done(true); }
        });
        // 默认聚焦「取消」按钮，防止用户下意识按 Enter/Space 直接触发不可恢复的删除。
        document.getElementById('cancelBtn').focus();
    })();
</script>
</body>
</html>`;
}

/**
 * 展示「删除案例确认」**无关联表格**版弹窗，阻塞等待用户选择。
 *
 * 与 showDeleteConfirmModal 的区别：
 *   - 本函数不渲染 type=2 关联表格，用于「删除确认接口未返回需二次确认的案例」的场景。
 *   - 文案更简洁（首段直接说明会同步删除 N 条案例，不可恢复），不需要 Y/N 表格说明。
 *
 * 视觉/行为与 showDeleteConfirmModal 一致：warning 配色、独立 webview 模态框、
 * 用户点「确定删除」/「取消」/「✕」/遮罩/ESC/Cancel 进度条均可结算。
 *
 * 替代了之前使用 vscode.window.showWarningMessage（VSCode 原生 modal）的方案，
 * 现在案例文件删除的弹窗样式与「案例编辑器内删除」完全一致。
 *
 * @returns true=用户确认删除；false=取消 / 关闭 / token 取消
 */
export function showDeleteConfirmSimpleModal(
    opts: { filePath: string; fileName: string; caseCount: number },
    token?: vscode.CancellationToken,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'deleteConfirmSimpleModal',
            '删除案例',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: false },
        );
        panel.webview.html = buildDeleteConfirmSimpleHtml(opts.filePath, opts.fileName, opts.caseCount);

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
        if (token) {
            token.onCancellationRequested(() => finish(false));
            if (token.isCancellationRequested) finish(false);
        }
    });
}
