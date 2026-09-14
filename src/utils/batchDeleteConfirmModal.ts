/**
 * ============================================================================
 *  utils/batchDeleteConfirmModal.ts
 *  「批量删除案例·聚合确认」独立 webview 弹窗
 * ----------------------------------------------------------------------------
 *  由 messageExtras.ts 拆分而来。仅承载 N≥2 的多文件批量删除路径：
 *    · BatchDeleteFileEntry            —— 每个文件的展示条目类型（含 hardDeleteOnly / localRowCount）
 *    · buildBatchDeleteConfirmHtml     —— 纵向 Tab + 风险卡片 + 强制查看 + 倒计时按钮的聚合确认 HTML
 *    · showBatchDeleteConfirmModal     —— 展示面板并等待用户结算的 Promise 入口
 *
 *  单文件（N=1）路径不走本模块，请见 deleteConfirmModal.ts。
 * ============================================================================
 */
import * as vscode from 'vscode';
import {
    MODAL_COLOR_WARNING,
    MODAL_HEADER_BG_WARNING,
    escapeHtml_,
    baseModalCss_,
} from './modalShared';
import type { DeleteConfirmItem } from './deleteConfirmModal';

/**
 * 批量聚合确认弹窗中，单个文件的展示条目。
 *
 * 通过 `precheckError` 是否为空来区分两类文件：
 *   - precheckError 为空 → 预检通过，用户确认后会被删除；items 为 type=2 需要提示的关联案例
 *   - precheckError 非空 → 预检失败，用户即便点「确定删除」也会被跳过，本文件将保留原状
 */
export interface BatchDeleteFileEntry {
    /** 文件绝对路径（用于回调时定位） */
    filePath: string;
    /** 文件名（展示用） */
    fileName: string;
    /**
     * 该文件下需线上删除的案例数（type=1+type=2 合计，即真正会调用 TMS 删除接口的行数）。
     * hardDeleteOnly=true 时该字段应为 0（因为该文件不涉及线上删除）。
     */
    caseCount: number;
    /** 该文件下 type=2 需要用户二次确认的关联案例明细（仅预检通过时有值） */
    items: DeleteConfirmItem[];
    /** 预检失败时的原因（非空表示该文件被跳过、不会删除） */
    precheckError?: string;
    /**
     * 是否仅本地删除（无 testcase_id 列 / 空文件 / 全部本地未推送）。
     * true 时不调用 TMS，仅删除本地文件；pane 内展示为「仅本地删除」，
     * header 汇总的「同步删除 TMS 平台 N 条案例」也不会将其计入。
     */
    hardDeleteOnly?: boolean;
    /** 本地行数（仅 hardDeleteOnly=true 时使用，用于 pane 内提示删除影响范围）。 */
    localRowCount?: number;
}

/**
 * 构建「批量删除案例·聚合确认」独立 webview 弹窗 HTML。
 *
 * 布局（自适应）：
 *   - 单文件（N=1）走 buildDeleteConfirmHtml / buildDeleteConfirmSimpleHtml，此函数不被触达。
 *   - 多文件（N≥2）走本函数，采用「纵向 Tab」布局（左栏 Tab 列表 + 右侧内容）：
 *     · 顶部：全局风险汇总卡片（重点关注的关联案例数 / 预检失败文件数）；
 *     · 左栏（160px）：纵向 Tab 列表，每个文件一行，携带图标 / 名称 / 关联案例徽章 / 未读圆点；
 *     · 右栏内容区（flex:1）：一次只显示当前 Tab 对应文件的详情（案例总数 + type=2 关联案例表 / 预检失败原因）；
 *     · 底部：查看进度提示 + 倒计时确定按钮 + 拖拽 handle。
 *   - 弹窗允许用户从右下角手动拖拽调整宽度（720~1080px）和高度（400px~88vh）。
 *
 * 三重防误删约束：
 *   ① 风险置顶卡片：全局呈现"关联案例数 / 预检失败文件数"，避免用户漏看关键信息；
 *   ② 强制查看：所有可删除的 Tab 都被切换过（点击/键盘）才会启用确定按钮；
 *   ③ 倒计时按钮：满足强制查看后仍需等待 3 秒，防止下意识点确定。
 *
 * 交互：
 *   - 点击 Tab / ↑↓ 键 / Home / End 切换；切换后当前 Tab 自动标记为「已查看」；
 *   - 预检失败的 Tab 也需要查看（用户必须知道哪些文件将保留、原因是什么），但不阻碍确定按钮启用；
 *   - 右下角拖拽 handle：鼠标按下拖拽调整弹窗尺寸；
 *   - 用户点「确定删除」→ true；点「取消」/关闭/遮罩/ESC → false。
 */
function buildBatchDeleteConfirmHtml(entries: BatchDeleteFileEntry[]): string {
    const color = MODAL_COLOR_WARNING;
    const headerBg = MODAL_HEADER_BG_WARNING;

    const ok = entries.filter(e => !e.precheckError);
    const failed = entries.filter(e => !!e.precheckError);
    // 「需同步 TMS」= 预检通过 且 非 hardDeleteOnly 的文件
    const needTms = ok.filter(e => !e.hardDeleteOnly);
    // 「仅本地删除」= 预检通过 且 hardDeleteOnly 的文件
    const hardOnly = ok.filter(e => !!e.hardDeleteOnly);
    // 累加口径：只统计 needTms 的 caseCount（真正会调 TMS 的行数），
    // hardDeleteOnly 的本地行数（localRowCount）不计入 header 的「同步删除 TMS X 条案例」。
    const totalCases = needTms.reduce((sum, e) => sum + (e.caseCount || 0), 0);
    // 有执行/缺陷关联的案例总数（跨全部预检通过的文件汇总）
    const totalLinkedCases = ok.reduce((sum, e) => sum + (Array.isArray(e.items) ? e.items.length : 0), 0);
    // 涉及到关联案例的文件数
    const filesWithLinked = ok.filter(e => Array.isArray(e.items) && e.items.length > 0).length;
    const fileCount = entries.length;
    const okCount = ok.length;
    const failedCount = failed.length;
    const needTmsCount = needTms.length;
    const hardOnlyCount = hardOnly.length;

    // 倒计时秒数（可调）；okCount=0 时按钮直接 disabled，不进入倒计时
    const COUNTDOWN_SECS = 3;

    // Tab 数据：按 entries 原顺序展示（预检失败 / 有关联案例 / 无关联案例不做排序）
    const tabsHtml = entries.map((e, idx) => {
        const isFail = !!e.precheckError;
        const linkedCount = isFail ? 0 : (Array.isArray(e.items) ? e.items.length : 0);
        const icon = isFail ? '⊘' : (linkedCount > 0 ? '⚠' : '📄');
        const cls = isFail ? 'xs-bd-tab xs-bd-tab-fail' : (linkedCount > 0 ? 'xs-bd-tab xs-bd-tab-warn' : 'xs-bd-tab');
        const badge = linkedCount > 0 ? `<span class="xs-bd-tab-badge">${linkedCount}</span>` : '';
        return `<button type="button" class="${cls}" role="tab" data-idx="${idx}" aria-selected="${idx === 0 ? 'true' : 'false'}" tabindex="${idx === 0 ? '0' : '-1'}" title="${escapeHtml_(e.filePath || e.fileName)}">`
            + `<span class="xs-bd-tab-icon">${icon}</span>`
            + `<span class="xs-bd-tab-name">${escapeHtml_(e.fileName)}</span>`
            + badge
            + `<span class="xs-bd-tab-dot" aria-hidden="true"></span>`
            + `</button>`;
    }).join('');

    // Tab 内容面板
    const panesHtml = entries.map((e, idx) => {
        if (e.precheckError) {
            return `<div class="xs-bd-pane${idx === 0 ? ' xs-bd-pane-active' : ''}" role="tabpanel" data-idx="${idx}">
                <div class="xs-bd-file-path" title="${escapeHtml_(e.filePath || e.fileName)}">${escapeHtml_(e.filePath || e.fileName)}</div>
                <div class="xs-bd-fail">
                    <div class="xs-bd-fail-head">
<span class="xs-bd-fail-tag">预检失败，该文件不会被删除</span>
                    </div>
                    <div class="xs-bd-fail-reason">原因：${escapeHtml_(e.precheckError || '未知')}</div>
                    <div class="xs-bd-fail-note">该文件不会被删除，其它文件仍会按计划处理，不影响本次批量操作。</div>
                </div>
            </div>`;
        }
        const items = Array.isArray(e.items) ? e.items : [];
        // 注意：这里的循环变量必须与外层 `entries.map((e, idx))` 的 `idx` 区分开，
        // 否则会形成变量遮蔽（虽然功能上巧合正确，但极易在维护时误改）。故命名为 rowIdx。
        const rowsHtml = items.map((it, rowIdx) => {
            const exec = String(it.hasExec).trim().toUpperCase() === 'Y' ? 'Y' : 'N';
            const bug = String(it.hasBug).trim().toUpperCase() === 'Y' ? 'Y' : 'N';
            const platform = it.sourceType || '';
            return `<tr>`
                + `<td class="xs-dc-td xs-dc-idx">${rowIdx + 1}</td>`
                + `<td class="xs-dc-td xs-dc-no">${escapeHtml_(it.testCaseNo)}</td>`
                + `<td class="xs-dc-td xs-dc-name">${escapeHtml_(it.testCaseName)}</td>`
                + `<td class="xs-dc-td xs-dc-flag" data-flag="${exec}">${exec}</td>`
                + `<td class="xs-dc-td xs-dc-flag" data-flag="${bug}">${bug}</td>`
                + `<td class="xs-dc-td xs-dc-platform" title="${escapeHtml_(platform)}">${escapeHtml_(platform)}</td>`
                + `</tr>`;
        }).join('');
        const table = items.length > 0
            ? `<div class="xs-bd-tbl-hint">以下 <b>${items.length}</b> 条案例存在执行/缺陷关联（下表「执行」「缺陷」列，Y=存在，N=不存在）：</div>
               <div class="xs-bd-tbl-wrap">
                   <table class="xs-dc-table">
<thead><tr><th class="xs-dc-th-c xs-dc-th-idx" title="序号">#</th><th>编号</th><th>名称</th><th class="xs-dc-th-c">执行</th><th class="xs-dc-th-c">缺陷</th><th>来源</th></tr></thead>
                       <tbody>${rowsHtml}</tbody>
                   </table>
               </div>`
            : `<div class="xs-bd-empty">该文件下无需二次确认的执行/缺陷关联案例。</div>`;
        // pane meta 文案：区分「同步 TMS」与「仅本地删除」两种语义，避免将本地行数当线上行数展示。
        const paneMeta = e.hardDeleteOnly
            ? `<div class="xs-bd-pane-meta">仅删除本地文件（共 <b class="xs-bd-count">${e.localRowCount || 0}</b> 行），不涉及 TMS 平台。</div>`
            : `<div class="xs-bd-pane-meta">删除本文件将同步删除 TMS 平台上的 <b class="xs-bd-count">${e.caseCount}</b> 条案例，以及这些案例的执行记录和缺陷关联。</div>`;
        return `<div class="xs-bd-pane${idx === 0 ? ' xs-bd-pane-active' : ''}" role="tabpanel" data-idx="${idx}">
            <div class="xs-bd-file-path" title="${escapeHtml_(e.filePath || e.fileName)}">${escapeHtml_(e.filePath || e.fileName)}</div>
            ${paneMeta}
            ${table}
        </div>`;
    }).join('');

    // 顶部风险汇总卡片
    const riskLines: string[] = [];
    if (totalLinkedCases > 0) {
        riskLines.push(`共 <b>${filesWithLinked}</b> 个文件的 <b>${totalLinkedCases}</b> 条案例存在执行/缺陷关联，删除后关联将一并解除`);
    }
    // 风险卡片：新增「仅本地删除」提示（hardDeleteOnly>0 时展示）
    if (hardOnlyCount > 0) {
        riskLines.push(`<b>${hardOnlyCount}</b> 个文件仅删除本地（无 TMS 同步）`);
    }
    if (failedCount > 0) {
        riskLines.push(`<b>${failedCount}</b> 个文件预检失败，将被跳过、不会删除`);
    }
    const riskCard = riskLines.length > 0
        ? `<div class="xs-bd-risk${(totalLinkedCases >= 5 || filesWithLinked >= 5 || failedCount >= 3) ? ' xs-bd-risk-strong' : ''}">
             <div class="xs-bd-risk-title">⚠ 谨慎操作</div>
             <ul class="xs-bd-risk-list">${riskLines.map(t => `<li>${t}</li>`).join('')}</ul>
           </div>`
        : '';

    // header 标题分段组装，按「文件总数 / 需同步 TMS / 仅本地 / 跳过」逐项拼接，
    // 避免将本地行数误当 TMS 删除行数一同展示。
    const headerParts: string[] = [];
    if (needTmsCount > 0) headerParts.push(`${needTmsCount} 需同步 TMS·${totalCases} 案例`);
    if (hardOnlyCount > 0) headerParts.push(`${hardOnlyCount} 仅本地`);
    if (failedCount > 0) headerParts.push(`${failedCount} 跳过`);
    const headerSuffix = headerParts.length > 0 ? `（${headerParts.join(' / ')}）` : '';
    const headerTitleHtml = `删除案例 — 共 ${fileCount} 个文件${headerSuffix}`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>批量删除案例</title>
<style>
${baseModalCss_(headerBg, color, '')}
    /* ------------------------------------------------------------------ *
     * 去弹窗化覆盖（本页专用）：与「批量删除结果」汇总面板一致，直接铺
     * 满整个 webview panel，不再呈现"浮在遮罩上的居中卡片"。
     * 因此上方 baseModalCss_ 的 dialogExtra 故意传空串——本页对 .xs-modal-dialog
     * 的宽高会被下方规则以 !important 全量覆盖为 100%，再传任何尺寸约束都是无效字面量。
     * 只覆盖 overlay/dialog 的定位与外观，保留 header/body/footer 的
     * 内部布局与滚动逻辑；HTML 结构与 JS 交互（强制查看 + 倒计时 +
     * postMessage）完全不变。
     * ------------------------------------------------------------------ */
    html,body{margin:0;padding:0;height:100%;background:var(--bg,#fff)}
    .xs-modal-overlay{position:static;display:flex;flex-direction:column;background:transparent;align-items:stretch;justify-content:flex-start;height:100vh;min-height:100vh}
    .xs-modal-dialog{width:100% !important;min-width:0 !important;max-width:none !important;height:100vh !important;max-height:100vh !important;border-radius:0;box-shadow:none;flex:1 1 auto}
    /* ---------------------------------------------------------------- *
     * Header 视觉规格对齐 pushUI.ts 的 .summary-bar（不复用 CSS，仅规格一致）
     *   · padding：16px 20px（同 .summary-bar）
     *   · 图标尺寸：28×28，font-size 16px（同 .summary-icon）
     *   · 标题字号：15px（同 .summary-title）
     * 保留 warning 语义配色（橙色感叹图标 + 浅米黄底），因为本页是"确认页"
     * 而非"结果页"，不能切换到绿色/红色的结果语义。pushUI 若调整规格，人类
     * 维护者应同步这三条。
     * ---------------------------------------------------------------- */
    .xs-modal-header{padding:16px 20px}
    .xs-pr-icon{width:28px;height:28px;font-size:16px}
    .xs-modal-title{font-size:15px}
    /* 覆盖 baseModalCss_ 中的 body 内边距/滚动约束，让主体走自定义 flex 布局 */
    .xs-modal-body{flex:1;padding:0;min-height:60px;overflow:hidden;display:flex;flex-direction:column;gap:0}
    /* 顶部风险卡片区 */
    .xs-bd-top{padding:12px 16px 8px;flex-shrink:0}
    .xs-bd-count{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
    /* 风险置顶卡片 */
    .xs-bd-risk{border:1px solid #ffd591;background:#fffbe6;border-radius:4px;padding:8px 12px}
    .xs-bd-risk-strong{border-color:#ff7875;background:#fff1f0}
    .xs-bd-risk-title{font-size:13px;font-weight:600;color:#d4380d;margin-bottom:4px}
    .xs-bd-risk-list{margin:0;padding-left:20px;font-size:12px;color:#555;line-height:1.8}
    .xs-bd-risk-list b{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
    /* 主体：左栏 Tab + 右栏内容 */
    .xs-bd-main{flex:1;display:flex;flex-direction:row;min-height:200px;overflow:hidden;border-top:1px solid #e8e8e8}
    /* 左栏纵向 Tab 列表 */
    .xs-bd-tabs{width:160px;flex-shrink:0;overflow-y:auto;overflow-x:hidden;background:#fafafa;border-right:1px solid #e8e8e8;padding:6px 0;box-sizing:border-box}
    .xs-bd-tabs::-webkit-scrollbar{width:6px}
    .xs-bd-tabs::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}
    /* 单个 Tab（整行按钮） */
    .xs-bd-tab{position:relative;display:flex;align-items:center;gap:6px;width:100%;padding:8px 10px 8px 14px;font-size:12px;color:#555;background:transparent;border:none;border-left:3px solid transparent;cursor:pointer;text-align:left;outline:none;box-sizing:border-box;transition:color .15s,background .15s,border-color .15s}
    .xs-bd-tab:hover{background:#f0f0f0;color:#333}
    .xs-bd-tab[aria-selected="true"]{color:${color};background:#fff;border-left-color:${color};font-weight:600}
    .xs-bd-tab-icon{font-size:13px;flex-shrink:0}
    .xs-bd-tab-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .xs-bd-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;font-size:10px;font-weight:700;color:#fff;background:#f5222d;border-radius:8px;box-sizing:border-box;flex-shrink:0}
    .xs-bd-tab-warn{color:#d46b08}
    .xs-bd-tab-fail{color:#cf1322}
    /* 未查看小圆点 */
    .xs-bd-tab-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#1890ff;flex-shrink:0}
    .xs-bd-tab.xs-bd-seen .xs-bd-tab-dot{display:none}
    /* 右栏内容面板：整体走 flex 纵向布局，让激活 pane 铺满、表格随窗口拉伸 */
    .xs-bd-panes{flex:1;display:flex;flex-direction:column;overflow:auto;padding:12px 14px;background:#fff;min-width:0;min-height:0}
    .xs-bd-pane{display:none}
    /* 激活 pane 占满 panes 剩余高度，内部再走 flex 纵向布局供表格拉伸 */
    .xs-bd-pane-active{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
    .xs-bd-file-path{font-size:12px;color:#888;margin-bottom:6px;word-break:break-all;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;flex-shrink:0}
    .xs-bd-pane-meta{font-size:13px;color:#333;line-height:1.7;margin-bottom:8px;flex-shrink:0}
    .xs-bd-tbl-hint{font-size:13px;color:#333;line-height:1.7;margin-bottom:6px;flex-shrink:0}
    .xs-bd-tbl-hint b{color:#d4380d;font-weight:700;font-size:15px;padding:0 2px}
    /* 表格容器随可用高度拉伸（去掉硬编码 max-height:320px），内部滚动由本容器承担 */
    .xs-bd-tbl-wrap{border:1px solid #e3e3e3;border-radius:3px;overflow:auto;flex:1 1 auto;min-height:160px}
    .xs-bd-empty{font-size:12px;color:#999;padding:10px 0}
    .xs-dc-table{width:100%;border-collapse:collapse;font-size:12px}
    .xs-dc-table th{position:sticky;top:0;background:#fafafa;font-weight:600;color:#555;text-align:left;padding:6px 8px;border-bottom:1px solid #e3e3e3;white-space:nowrap;z-index:1}
    .xs-dc-table th.xs-dc-th-c{text-align:center}
    .xs-dc-table td{padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#333;word-break:break-all}
    .xs-dc-table tbody tr:last-child td{border-bottom:none}
    .xs-dc-table tbody tr:nth-child(even){background:#fcfcfc}
    .xs-dc-no{width:27%;color:#666;white-space:nowrap}
    .xs-dc-name{width:35%}
    .xs-dc-table td.xs-dc-flag{width:10%;text-align:center;font-weight:600;color:#c0392b}
    .xs-dc-table td.xs-dc-flag[data-flag="N"]{color:#999;font-weight:400}
    .xs-dc-table td.xs-dc-platform{width:13%;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    /* 预检失败面板 */
    .xs-bd-fail{border:1px solid #ffccc7;background:#fff2f0;border-radius:4px;padding:10px 12px}
    .xs-bd-fail-head{display:flex;align-items:center;gap:10px;font-size:13px}
    .xs-bd-fail-tag{font-size:12px;color:#cf1322;background:#fff1f0;border:1px solid #ffa39e;border-radius:2px;padding:2px 8px;flex-shrink:0}
    .xs-bd-fail-reason{margin-top:6px;font-size:12px;color:#a8071a;line-height:1.6;word-break:break-all}
    .xs-bd-fail-note{margin-top:6px;font-size:12px;color:#8c8c8c;line-height:1.6}
    /* 底部提示 */
    .xs-bd-footer-hint{flex:1;font-size:12px;color:#888;line-height:1.6}
    .xs-bd-footer-hint b{color:#d46b08}
    .xs-btn[disabled]{opacity:.5;cursor:not-allowed;pointer-events:auto}
    .xs-btn[disabled]:hover{background:${color};color:#fff}
</style>
</head>
<body>
<div class="xs-modal-overlay" id="overlay">
    <div class="xs-modal-dialog">
        <div class="xs-modal-header">
            <span class="xs-pr-icon">!</span>
            <span class="xs-modal-title">${headerTitleHtml}</span>
        </div>
        <div class="xs-modal-body">
            <div class="xs-bd-top">
                ${riskCard}
            </div>
            <div class="xs-bd-main">
                <div class="xs-bd-tabs" role="tablist" aria-label="待确认文件列表" aria-orientation="vertical">${tabsHtml}</div>
                <div class="xs-bd-panes" id="panes">${panesHtml}</div>
            </div>
        </div>
        <div class="xs-modal-footer">
            <div class="xs-bd-footer-hint" id="hint">请点击左侧列表逐个查看后再确认删除（不可恢复）。</div>
            <button class="xs-btn" id="cancelBtn">取消</button>
            <button class="xs-btn xs-btn-p" id="okBtn" disabled${okCount === 0 ? ' data-nook="1" title="没有可删除的文件"' : ''}>确定删除</button>
        </div>
    </div>
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        var settled = false;
        var okBtn = document.getElementById('okBtn');
        var cancelBtn = document.getElementById('cancelBtn');
        var hint = document.getElementById('hint');
        var tabs = Array.prototype.slice.call(document.querySelectorAll('.xs-bd-tab'));
        var panes = Array.prototype.slice.call(document.querySelectorAll('.xs-bd-pane'));
        var noOk = okBtn.getAttribute('data-nook') === '1';
        var totalTabs = tabs.length;
        var seen = new Array(totalTabs).fill(false);
        var countdownSecs = ${COUNTDOWN_SECS};
        var countdownTimer = null;
        var remainSecs = countdownSecs;
        var canFinalize = false; // 是否已完成全部查看 & 倒计时结束
        // ----- 状态更新 -----
        function markSeen(idx){
            if(idx<0||idx>=totalTabs) return;
            if(seen[idx]) return;
            seen[idx] = true;
            tabs[idx].classList.add('xs-bd-seen');
            refreshFooter();
        }
        function countUnseen(){
            var n = 0;
            for(var i=0;i<totalTabs;i++){ if(!seen[i]) n++; }
            return n;
        }
        function refreshFooter(){
            if(noOk){
                hint.innerHTML = '所有文件均预检失败无法删除，请点击「取消」关闭。';
                okBtn.disabled = true;
                return;
            }
            var unseen = countUnseen();
            if(unseen > 0){
                hint.innerHTML = '还有 <b>' + unseen + '</b> 个文件未查看，请点击左侧列表逐个查看后再确认。';
                okBtn.disabled = true;
                okBtn.textContent = '确定删除';
                if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; }
                canFinalize = false;
                return;
            }
            // 全部查看完毕 → 启动倒计时
            if(!countdownTimer && !canFinalize){
                remainSecs = countdownSecs;
                okBtn.disabled = true;
                okBtn.textContent = '确定删除（' + remainSecs + 's）';
                hint.innerHTML = '已全部查看，倒计时结束后可点击「确定删除」（不可恢复）。';
                countdownTimer = setInterval(function(){
                    remainSecs--;
                    if(remainSecs <= 0){
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                        canFinalize = true;
                        okBtn.disabled = false;
                        okBtn.textContent = '确定删除';
                        hint.innerHTML = '删除不可恢复，请确认后点击「确定删除」。';
                        try{ okBtn.focus(); }catch(e){}
                    } else {
                        okBtn.textContent = '确定删除（' + remainSecs + 's）';
                    }
                }, 1000);
            }
        }
        // ----- Tab 切换 -----
        function activate(idx){
            if(idx<0||idx>=totalTabs) return;
            for(var i=0;i<totalTabs;i++){
                var selected = (i===idx);
                tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
                tabs[i].setAttribute('tabindex', selected ? '0' : '-1');
                if(selected) panes[i].classList.add('xs-bd-pane-active');
                else panes[i].classList.remove('xs-bd-pane-active');
            }
            markSeen(idx);
            try{ tabs[idx].focus(); tabs[idx].scrollIntoView({block:'nearest',inline:'nearest'}); }catch(e){}
        }
        tabs.forEach(function(tab, i){
            tab.addEventListener('click', function(){ activate(i); });
        });
        // 键盘导航（纵向 Tab：主用 ↑↓，兼容 ←→）
        document.querySelector('.xs-bd-tabs').addEventListener('keydown', function(e){
            var current = tabs.findIndex(function(t){ return t.getAttribute('aria-selected')==='true'; });
            if(current < 0) current = 0;
            var next = -1;
            if(e.key==='ArrowDown' || e.key==='ArrowRight'){ next = (current+1)%totalTabs; }
            else if(e.key==='ArrowUp' || e.key==='ArrowLeft'){ next = (current-1+totalTabs)%totalTabs; }
            else if(e.key==='Home'){ next = 0; }
            else if(e.key==='End'){ next = totalTabs-1; }
            if(next>=0){ e.preventDefault(); activate(next); }
        });
        // 初始默认聚焦第一个 Tab（决策3=A：顺序自然）
        markSeen(0);
        refreshFooter();
        // ----- 结算 -----
        function done(v){
            if(settled) return;
            if(v && !canFinalize) return; // 未完成审阅或倒计时未结束
            settled = true;
            if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; }
            vscode.postMessage({type:'deleteConfirmResult', confirmed:v});
        }
        okBtn.onclick = function(){ done(true); };
        cancelBtn.onclick = function(){ done(false); };
        // 批量删除是高风险操作：用户如需取消，请明确点击「取消」按钮 / 关闭 Tab / 按 ESC。
        document.addEventListener('keydown',function(e){
            // 只在焦点不在 Tab 栏时响应全局 Enter/Esc（避免与左右键切换冲突）
            if(e.key==='Escape'){ e.preventDefault(); done(false); }
            else if(e.key==='Enter'){
                var tag = (e.target && e.target.tagName) || '';
                if(tag === 'BUTTON' && e.target.classList.contains('xs-bd-tab')) return;
                if(canFinalize){ e.preventDefault(); done(true); }
            }
        });
        // 页面加载后先聚焦"取消"按钮（因为确定按钮此时必然 disabled）
        try{ cancelBtn.focus(); }catch(e){}
    })();
</script>
</body>
</html>`;
}

/**
 * 展示「批量删除案例·聚合确认」面板（编辑器活动列的 Webview Panel），
 * 返回 Promise 等待用户选择。
 *
 * 语义：
 *   - true：用户点「确定删除」→ 调用方对所有 precheckError 为空的 entries 执行删除；
 *     precheckError 非空的 entries 保留原状（面板中已明确标注）。
 *   - false：用户点「取消」/关闭按钮 / 按 ESC / 关闭 Tab → 调用方对**全部** entries 保留原状。
 *
 * 结算保证（避免流程挂起）：
 *   - 用户交互结算：postMessage / ✕ 关闭按钮 / ESC
 *   - 面板被销毁（onDidDispose，含用户关闭 Tab）→ false
 *   - CancellationToken 被取消 → 关闭面板并 false
 *
 * @returns true=用户确认；false=取消/关闭
 */
export function showBatchDeleteConfirmModal(
    entries: BatchDeleteFileEntry[],
    token?: vscode.CancellationToken,
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let panel: vscode.WebviewPanel;
        try {
            panel = vscode.window.createWebviewPanel(
                'batchDeleteConfirmModal',
                '批量删除案例',
                // 与「批量删除结果」汇总面板保持一致：落在当前编辑器活动列（Tab 区），
                // 不再作为浮动 modal / 固定第一列面板呈现。
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: false },
            );
        } catch (err: any) {
            console.error('[showBatchDeleteConfirmModal] panel 创建失败:', err?.message || err);
            resolve(false);
            return;
        }

        try {
            panel.webview.html = buildBatchDeleteConfirmHtml(entries);
        } catch (err: any) {
            console.error('[showBatchDeleteConfirmModal] html 构建失败:', err?.message || err);
            try { panel.dispose(); } catch { /* ignore */ }
            resolve(false);
            return;
        }

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
        panel.onDidDispose(() => {
            finish(false);
        });
        if (token) {
            token.onCancellationRequested(() => {
                finish(false);
            });
            if (token.isCancellationRequested) finish(false);
        }
    });
}
