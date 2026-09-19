/**
 * ============================================================================
 *  utils/pushUI.ts
 *  批量推送 UI 模块 — 进度面板 & 结果总结（同一面板无缝切换）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. createPushProgress — 进度面板（推送中实时更新，完成后自动切总结视图）
 *    2. showPushSummary    — 独立总结弹窗（保留用于外部场景）
 * ============================================================================
 */
import * as vscode from 'vscode';
import { PushFailure } from './message';

// ============================================
// 类型定义
// ============================================

/**
 * 总结弹窗可选文案配置
 * 用于让「推送结果」与「删除结果」等场景复用同一弹窗，只替换标题/副标题/操作词等文案。
 */
export interface SummaryUiOptions {
    /** VSCode 面板 tab 标题（默认 "推送结果"） */
    panelTitle?: string;
    /** 汇总栏主标题（默认 "推送完成"） */
    headerTitle?: string;
    /** 汇总栏文档标题（<title>，默认取 panelTitle） */
    documentTitle?: string;
    /** 是否在文件行下方展开失败明细（tsId · reason 列表），默认 false */
    showFailureDetails?: boolean;
}

/**
 * 进度面板可选文案配置（createPushProgress 入参）。
 * 用于让「推送」之外的场景（删除 / 导入 / 导出等）复用同一进度面板，
 * 仅需替换各阶段标题文案即可；总结视图部分字段直接复用 SummaryUiOptions。
 */
export interface PushProgressOptions extends SummaryUiOptions {
    /** 进度视图：VSCode 面板 tab 标题 & <title>（默认 "推送测试案例"） */
    panelTitle?: string;
    /** 进度视图主标题（推送中，默认 "正在推送测试案例..."） */
    progressTitle?: string;
    /** 进度视图主标题（已取消，默认 "已取消"） */
    progressCancelTitle?: string;
    /** 进度视图动作动词（副标题与取消说明使用，默认 "推送"） */
    progressVerb?: string;
}

/** 批量推送单文件结果 */
export interface PushFileResult {
    filePath: string;
    fileName: string;
    successCount: number;
    failCount: number;
    total: number;
    failures: PushFailure[];
    error?: string;
    /** 本次推送被识别为样例/模板占位而静默跳过的行数（不计入 success/fail），弹窗汇总用 */
    skipped?: number;
    /** 预校验（占位/空/格式）拦截的行数，与「接口实推失败」区分，供 batch.fileResult 对齐 .complete */
    preValidationFailCount?: number;
    /** 链路追踪 ID（与单文件 .complete 同源），供批量逐文件回传埋点 */
    traceId?: string;
    /** 本次推送耗时（ms），对齐单文件 .complete 的 costMs */
    costMs?: number;
    /** 整文件异常原因（对应 .aborted 的 reason 维度），批量下钻分析用 */
    reason?: string;
}

/** 进度项状态 */
interface PushProgressItem {
    fileName: string;
    status: 'pending' | 'pushing' | 'done' | 'error' | 'warning';
    text: string;
}

/** 批量前置校验结果（单文件） */
export interface ValidateGateFileEntry {
    filePath: string;
    fileName: string;
    /** 该文件的所有 failures（含 severity/rowIndex/tsId 等，格式同 05g 内部） */
    failures: Array<{
        tsId: string;
        reason: string;
        rowIndex?: number;
        severity?: 'error' | 'warn';
        field?: string;
        stepIdx?: number;
        subField?: string;
        hits?: Array<{ field?: string; stepIdx?: number; subField?: string; singleReason?: string }>;
    }>;
}

/** 进度面板阶段（用于切换标题文案） */
export type PushProgressPhase = 'validating' | 'pushing';

/** 进度面板控制接口 */
export interface PushProgressPanel {
    update(item: PushProgressItem): void;
    /**
     * 切换当前阶段（影响进度视图头部文案）：
     *   · validating → "正在校验测试案例..." / 完成 x / N
     *   · pushing    → "正在推送测试案例..." / 已完成 x / N（默认阶段）
     */
    setPhase(phase: PushProgressPhase): void;
    /**
     * 展示批量前置校验汇总视图（复用 05g 语义）：
     *   · 至少一个文件含 error → 只显示【关闭】，返回 'cancel'；
 *   · 全部纯 warn         → 显示【取消】+【忽略并继续】；
     *   · 全部无问题时不应调用此方法（上层直接进入推送即可）。
     * Promise 在用户点击按钮后 resolve；面板销毁按 'cancel' 兜底。
     */
    showValidateGate(entries: ValidateGateFileEntry[]): Promise<'continue' | 'cancel'>;
    /** 推送完成 → 面板切换到总结视图，Promise 在用户关闭后 resolve */
    done(results: PushFileResult[], onOpenFile?: (result: PushFileResult) => Promise<void>): Promise<void>;
    dispose(): void;
    cancelled: boolean;
}

// ============================================
// 工具函数
// ============================================

/** 简单 HTML 转义 */
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 安全判断 webview panel 是否已销毁 */
function isPanelDisposed(panel: vscode.WebviewPanel): boolean {
    try {
        // 访问 webview 属性会触发异常当 panel 已 disposed
        void panel.webview;
        return false;
    } catch {
        return true;
    }
}

/** 总结视图统计计算（共享） */
function buildSummaryStats(results: PushFileResult[]) {
    const totalFiles = results.length;
    const totalSucc = results.reduce((s, r) => s + r.successCount, 0);
    const totalFail = results.reduce((s, r) => s + r.failCount, 0);
    const errorFiles = results.filter(r => r.error).length;
    const hasFailures = totalFail > 0 || errorFiles > 0;
    const statusColor = hasFailures ? '#dc3545' : '#28a745';
    const statusIcon = hasFailures ? '✕' : '✓';
    const statusBg = hasFailures
        ? 'linear-gradient(180deg,#fdecea,#fdf3f3)'
        : 'linear-gradient(180deg,#e6f4ea,#f3faf5)';
    return { totalFiles, totalSucc, totalFail, errorFiles, hasFailures, statusColor, statusIcon, statusBg };
}

/** 共享 CSS（进度 & 总结视图共用：文件列表 + 行布局 + 按钮 + 滚动条） */
function sharedCss(): string {
    return `
    :root{--bg:#fff;--bd:#e0e0e0;--text:#333;--text-secondary:#666;--font:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;overflow:hidden}
    body{font-family:var(--font);font-size:13px;color:var(--text);display:flex;flex-direction:column;background:var(--bg)}
    .file-list{flex:1;overflow-y:auto;padding:8px 0}
    .file-row{border-bottom:1px solid #f0f0f0;cursor:pointer;user-select:none;transition:background .15s}
    .file-row.file-error{background:#fff5f5}
    .file-row.file-warn{background:#fffcf5}
    .file-row.file-ok{background:#f9fff9}
    .file-row.row-active{background:#f0f7ff}
    .file-row:hover{background:#e8f0fe}
    .file-header{display:flex;align-items:center;padding:10px 20px;gap:8px}
    .file-icon{font-size:16px;font-weight:bold;width:20px;text-align:center;flex-shrink:0}
    .file-name-col{width:50%;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:#0078d4}
    .file-status-col{width:50%;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;color:var(--text-secondary)}
    .file-status-col.status-err{color:#dc3545}
    .file-status-col.status-warn{color:#f0a020}
    .btn{padding:6px 20px;border-radius:4px;font-size:13px;cursor:pointer;border:1px solid #ccc;background:#fff;color:var(--text);outline:none}
    .btn:hover{background:#f0f0f0}
    .btn-primary{color:#fff;border-color:var(--btnPrimary)}
    .btn-primary:hover{opacity:.9}
    ::-webkit-scrollbar{width:6px}
    ::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}`;
}

/** 统一文件行 HTML 构建（进度 & 总结共用） */
function buildUnifiedFileRow(params: {
    index: number;
    fileName: string;
    tooltip?: string;
    icon: string;
    iconColor: string;
    rowClass: string;
    statusHtml: string;
    statusTooltip: string;
    statusClass?: string;
    opacity?: number;
}): string {
    const tip = escapeHtml(params.tooltip || params.fileName);
    const style = params.opacity !== undefined ? ` style="opacity:${params.opacity}"` : '';
    return `
    <div class="file-row ${params.rowClass}" data-file-index="${params.index}" data-file-name="${escapeHtml(params.fileName)}"${style}>
        <div class="file-header">
            <span class="file-icon" style="color:${params.iconColor}">${params.icon}</span>
            <span class="file-name-col" title="${tip}">${escapeHtml(params.fileName)}</span>
            <span class="file-status-col ${params.statusClass || ''}" title="${escapeHtml(params.statusTooltip)}">${params.statusHtml}</span>
        </div>
    </div>`;
}

/** 总结视图单文件行 HTML */
function buildFileRow(index: number, r: PushFileResult, opts?: SummaryUiOptions): string {
    const isError = !!r.error;
    const icon = isError ? '✕' : (r.failCount > 0 ? '⚠' : '✓');
    const rowColor = isError ? '#dc3545' : (r.failCount > 0 ? '#f0a020' : '#28a745');
    const rowClass = [
        isError ? 'file-error' : '',
        !isError && r.failCount > 0 ? 'file-warn' : '',
        !isError && r.failCount === 0 && r.successCount > 0 ? 'file-ok' : '',
    ].filter(Boolean).join(' ');

    const statusHtml = isError
        ? escapeHtml(r.error!.length > 80 ? r.error!.slice(0, 80) + '…' : r.error!)
        : `成功 ${r.successCount} / 失败 ${r.failCount} / 共 ${r.total} 条`;
    const statusTooltip = isError
        ? r.error!
        : `成功 ${r.successCount} / 失败 ${r.failCount} / 共 ${r.total} 条`;
    const statusClass = isError ? 'status-err' : (r.failCount > 0 ? 'status-warn' : '');

    const mainRow = buildUnifiedFileRow({
        index,
        fileName: r.fileName || r.filePath,
        tooltip: r.filePath,
        icon,
        iconColor: rowColor,
        rowClass,
        statusHtml,
        statusTooltip,
        statusClass,
    });

    // 可选：在文件行下方展开失败明细（tsId · reason 列表）
    // 用于「删除结果」等需要罗列失败行原因的场景；推送结果弹窗保持默认关闭。
    if (opts?.showFailureDetails && r.failures && r.failures.length > 0) {
        const items = r.failures.map(f => {
            const tsId = escapeHtml(String(f.tsId || '(无 testcase_id)'));
            const reason = escapeHtml(String(f.reason || '未知原因'));
            return `<li><span class="fail-tsid" title="${tsId}">${tsId}</span><span class="fail-reason" title="${reason}">${reason}</span></li>`;
        }).join('');
        return mainRow + `<div class="fail-detail-wrap"><ul class="fail-detail-list">${items}</ul></div>`;
    }
    return mainRow;
}

/** 总结视图完整 HTML */
function buildSummaryHtml(results: PushFileResult[], opts?: SummaryUiOptions): string {
    const stats = buildSummaryStats(results);
    const fileRowsHtml = results.map((r, i) => buildFileRow(i, r, opts)).join('');
    const btnColor = stats.statusColor;
    const _docTitle = escapeHtml(opts?.documentTitle || opts?.panelTitle || '推送结果');
    const _headerTitle = escapeHtml(opts?.headerTitle || '推送完成');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_docTitle}</title>
<style>
    ${sharedCss()}
    .summary-bar{display:flex;align-items:center;padding:16px 20px;background:${stats.statusBg};border-bottom:1px solid var(--bd);gap:12px;flex-shrink:0}
    .summary-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:16px;font-weight:bold;color:#fff;background:${stats.statusColor};flex-shrink:0}
    .summary-title{font-size:15px;font-weight:600;flex:1}
    .summary-stats{font-size:13px;color:var(--text-secondary);white-space:nowrap}
    .summary-stats .s-ok{color:#28a745;font-weight:600}
    .summary-stats .s-err{color:#dc3545;font-weight:600}
    .fail-detail-wrap{background:#fff8f8;border-bottom:1px solid #f0dcdc;padding:6px 20px 10px 48px}
    .fail-detail-list{list-style:none;margin:0;padding:0;font-size:12px}
    .fail-detail-list li{display:flex;align-items:center;gap:12px;padding:3px 0;border-bottom:1px dashed #f2e2e2}
    .fail-detail-list li:last-child{border-bottom:none}
    .fail-detail-list .fail-tsid{flex-shrink:0;font-family:'SF Mono','Menlo','Consolas',monospace;color:#666;min-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fail-detail-list .fail-reason{flex:1;color:#dc3545;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btn-primary{background:${btnColor}}
    .search-wrap{flex-shrink:0;padding:10px 20px;border-bottom:1px solid var(--bd);background:#fafbfc;display:flex;align-items:center;gap:8px}
    .search-input-wrap{position:relative;width:50%}
    .search-input{width:100%;border:1px solid #d0d0d0;border-radius:4px;padding:6px 28px 6px 8px;font-size:12px;outline:none;color:var(--text);background:#fff;transition:border-color .15s}
    .search-input:focus{border-color:#0078d4}
    .search-input::placeholder{color:#bbb}
    .search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:14px;color:#999;padding:2px 6px;border:none;background:transparent;line-height:1;display:none}
    .search-clear:hover{color:#333}
    .search-clear.visible{display:block}
    .search-count{font-size:12px;color:var(--text-secondary);white-space:nowrap;flex-shrink:0}
    .file-row.hidden{display:none}
    .search-empty{text-align:center;padding:40px 20px;color:#999;font-size:13px;display:none}
    .search-empty.visible{display:block}
    .footer-bar{display:flex;align-items:center;justify-content:flex-end;padding:10px 20px;border-top:1px solid var(--bd);gap:8px;flex-shrink:0}
</style>
</head>
<body>
<div class="summary-bar">
    <span class="summary-icon">${stats.statusIcon}</span>
    <span class="summary-title">${_headerTitle}</span>
    <span class="summary-stats">
        <span class="s-ok">${stats.totalSucc} 成功</span>
        ${stats.totalFail > 0 ? ` / <span class="s-err">${stats.totalFail} 失败</span>` : ''}
        &nbsp;·&nbsp;共 ${stats.totalFiles} 个文件
    </span>
</div>
<div class="search-wrap">
    <div class="search-input-wrap">
        <input class="search-input" id="searchInput" type="text" placeholder="搜索文件名称或路径..." autofocus />
        <button class="search-clear" id="searchClear" title="清除">✕</button>
    </div>
    <span class="search-count" id="searchCount"></span>
</div>
<div class="file-list">${fileRowsHtml}</div>
<div class="search-empty" id="searchEmpty">未找到匹配的文件</div>
<div class="footer-bar">
    <button class="btn btn-primary" id="closeBtn">关闭</button>
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        var searchInput = document.getElementById('searchInput');
        var searchClear = document.getElementById('searchClear');
        var searchCount = document.getElementById('searchCount');
        var searchEmpty = document.getElementById('searchEmpty');
        var fileRows = document.querySelectorAll('.file-row');
        var totalFiles = fileRows.length;

        function doFilter() {
            var kw = searchInput.value.trim().toLowerCase();
            var visible = 0;
            fileRows.forEach(function(row) {
                var name = row.querySelector('.file-name-col');
                var text = name ? (name.textContent || name.innerText || '').toLowerCase() : '';
                var tip = (name && name.getAttribute('title')) ? name.getAttribute('title').toLowerCase() : '';
                var match = !kw || text.indexOf(kw) !== -1 || tip.indexOf(kw) !== -1;
                row.classList.toggle('hidden', !match);
                if (match) visible++;
            });
            searchCount.textContent = kw ? (visible + ' / ' + totalFiles + ' 个文件') : '';
            searchEmpty.classList.toggle('visible', kw !== '' && visible === 0);
            searchClear.classList.toggle('visible', kw !== '');
        }

        searchInput.addEventListener('input', doFilter);
        searchClear.addEventListener('click', function() {
            searchInput.value = '';
            doFilter();
            searchInput.focus();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                if (document.activeElement === searchInput) {
                    searchInput.value = '';
                    doFilter();
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        });
        document.getElementById('closeBtn').addEventListener('click', function(){ vscode.postMessage({type:'closePushSummary'}); });
        document.addEventListener('keydown',function(e){ if(e.key==='Escape' && document.activeElement !== searchInput) vscode.postMessage({type:'closePushSummary'}); });
        document.querySelector('.file-list').addEventListener('click', function(e) {
            var row = e.target.closest('.file-row');
            if (!row) return;
            var idx = parseInt(row.getAttribute('data-file-index'), 10);
            if (!isNaN(idx)) { vscode.postMessage({type:'pushSummaryOpenFile', index: idx}); }
        });
        setTimeout(function(){ searchInput.focus(); searchInput.select(); }, 100);
    })();
</script>
</body>
</html>`;
}

// ============================================
// 1. 合并面板：createPushProgress
// ============================================

/** 活跃的推送面板引用（复用，避免多面板） */
let _activeProgressPanel: vscode.WebviewPanel | null = null;
/** 当前消息监听 disposable（复用时需解除旧监听） */
let _activeMsgDisposable: vscode.Disposable | null = null;

/**
 * 创建推送面板（进度视图 + 总结视图，同一面板无缝切换）。
 *
 * - 推送阶段：实时展示进度条 + 单文件状态
 * - 完成后调用 done(results, onOpenFile) → 自动切换到总结视图（可点击文件名）
 * - 用户点击文件名 → 回调 onOpenFile 打开文件 + 展示推送结果弹窗
 * - 用户点击「关闭」或按 Esc → 面板销毁，Promise resolve
 * - 面板复用：若已有非 disposed 面板，原地刷新内容，不创建新 Tab
 * - options：可扩展各阶段标题（panelTitle / progressTitle / progressVerb 等），
 *   便于「删除 / 导入」等场景复用同一进度面板，总结视图部分字段复用 SummaryUiOptions
 */
export function createPushProgress(totalFiles: number, options?: PushProgressOptions): PushProgressPanel {
    const items: PushProgressItem[] = [];
    let _cancelled = false;
    let _done = false;
    let _summaryResults: PushFileResult[] = [];
    let _onOpenFile: ((result: PushFileResult) => Promise<void>) | undefined;
    // 当前阶段：validating（前置校验中）→ pushing（真正推送中）
    let _phase: PushProgressPhase = 'pushing';
    // 校验汇总视图的 pending resolver（用户点【取消】/【忽略并继续】时结算）
    let _validateGateResolver: ((decision: 'continue' | 'cancel') => void) | null = null;

    for (let i = 0; i < totalFiles; i++) {
        items.push({ fileName: '', status: 'pending', text: '' });
    }

    // workspace 根路径（用于进度视图中由相对路径构造绝对路径）
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // ──────────────── 进度视图 HTML ────────────────────────────────
    function buildProgressHtml(): string {
        const completed = items.filter(it => it.status === 'done' || it.status === 'error' || it.status === 'warning').length;
        const pct = totalFiles > 0 ? Math.round((completed / totalFiles) * 100) : 0;

        const barColor = _cancelled ? '#f0a020' : '#0078d4';
        const _progressTitle = _phase === 'validating'
            ? '正在校验测试案例...'
            : (options?.progressTitle || '正在推送测试案例...');
        const _progressCancelTitle = options?.progressCancelTitle || '已取消';
        const _verb = _phase === 'validating' ? '校验' : (options?.progressVerb || '推送');
        const headerTitle = _cancelled ? _progressCancelTitle : _progressTitle;
        const headerSub = _cancelled
            ? `${_verb}过程被取消`
            : `本次共${_verb} ${totalFiles} 个文件 · 已完成 ${completed} / ${totalFiles}`;

        const fileRows = items.map((item, i) => {
            const statusIcon = item.status === 'done' ? '✓'
                : item.status === 'error' ? '✕'
                : item.status === 'warning' ? '⚠'
                : item.status === 'pushing' ? '⏳'
                : '○';
            const statusColor = item.status === 'done' ? '#28a745'
                : item.status === 'error' ? '#dc3545'
                : item.status === 'warning' ? '#f0a020'
                : item.status === 'pushing' ? '#0078d4'
                : '#ccc';
            const rowClass = item.status === 'pushing' ? 'row-active' : '';
            const statusClass = item.status === 'error' ? 'status-err' : (item.status === 'warning' ? 'status-warn' : '');
            const fileName = item.fileName || '准备中...';
            return buildUnifiedFileRow({
                index: i,
                fileName,
                tooltip: item.fileName || undefined,
                icon: statusIcon,
                iconColor: statusColor,
                rowClass,
                statusHtml: escapeHtml(item.text),
                statusTooltip: item.text,
                statusClass,
                opacity: item.status === 'pending' ? 0.45 : 1,
            });
        }).join('');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options?.panelTitle || '推送测试案例')}</title>
<style>
    ${sharedCss()}
    .header{flex-shrink:0;padding:16px 20px 12px;border-bottom:1px solid var(--bd);background:#fafbfc}
    .header-title{font-size:15px;font-weight:600;margin-bottom:4px}
    .header-sub{font-size:12px;color:var(--text-secondary)}
    .bar-wrap{flex-shrink:0;height:4px;background:#e8e8e8}
    .bar-fill{height:100%;background:${barColor};transition:width .3s ease;border-radius:0 2px 2px 0}
    .btn-primary{background:${barColor}}
    .footer{flex-shrink:0;display:flex;align-items:center;justify-content:flex-end;padding:10px 20px;border-top:1px solid var(--bd);gap:8px}
</style>
</head>
<body>
<div class="header">
    <div class="header-title">${headerTitle}</div>
    <div class="header-sub">${headerSub}</div>
</div>
<div class="bar-wrap"><div class="bar-fill" style="width:${pct}%"></div></div>
<div class="file-list">${fileRows}</div>
<div class="footer">
    ${!_cancelled ? '<button class="btn" id="cancelBtn">取消推送</button>' : ''}
    <button class="btn ${_cancelled ? 'btn-primary' : ''}" id="closeBtn">关闭</button>
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        var wsRoot = ${JSON.stringify(workspaceRoot)};
        document.getElementById('closeBtn').onclick = function(){ vscode.postMessage({type:'closePushProgress'}); };
        var cancelBtn = document.getElementById('cancelBtn');
        if (cancelBtn) { cancelBtn.onclick = function(){ vscode.postMessage({type:'cancelPushProgress'}); }; }
        document.addEventListener('keydown',function(e){ if(e.key==='Escape') vscode.postMessage({type:'closePushProgress'}); });
        document.querySelector('.file-list').addEventListener('click', function(e) {
            var row = e.target.closest('.file-row');
            if (!row) return;
            var name = row.getAttribute('data-file-name');
            if (name && wsRoot) {
                var fp = wsRoot + (wsRoot.endsWith('/')||wsRoot.endsWith('\\\\')?'':'/') + name;
                vscode.postMessage({type:'progressOpenFile', filePath: fp});
            }
        });
    })();
</script>
</body>
</html>`;
    }

    // ──────────────── 前置校验汇总视图 HTML（05g 复用）────────────────────
    // 与 media/pages/table-editor/editor/05g-pre-validate-gate.js 语义完全一致：
    //   · 分组：一张卡片 = 一行案例（或一个文件级问题），错误在前警告在后
    //   · 文件维度：外层按文件分区（章节标题带图标 + 问题条数），文件内按 rowIndex 升序
    //   · Q2=A：整批只要有 error → 只显示【关闭】按钮，禁止继续；
    //   · Q3=保留：全部 warn → 显示【取消】+【忽略并继续】
    //
    // 该视图专用于批量推送前的"整批统一校验"，与推送中/推送后视图共用一个 webview 面板，
    // 独立的样式作用域（.xs-vg-*）避免污染总结视图（.file-row 系列）。
    function buildValidateGateHtml(entries: ValidateGateFileEntry[]): string {
        // 汇总统计（跨文件）
        let totalErr = 0, totalWarn = 0, errFileCount = 0, warnOnlyFileCount = 0;
        for (const en of entries) {
            const eCnt = en.failures.filter(f => (f.severity || 'error') !== 'warn').length;
            const wCnt = en.failures.length - eCnt;
            totalErr += eCnt;
            totalWarn += wCnt;
            if (eCnt > 0) errFileCount++;
            else if (wCnt > 0) warnOnlyFileCount++;
        }
        const hasError = totalErr > 0;
        const status = hasError ? 'error' : 'warning';
        const headerBg = hasError
            ? 'linear-gradient(180deg,#fdecea,#fdf3f3)'
            : 'linear-gradient(180deg,#fef3e0,#fff8ec)';
        const headerBd = hasError ? '#f1c4c2' : '#f5d6a4';
        const iconBg = hasError ? '#e5484d' : '#f0a020';
        const iconChar = hasError ? '🚫' : '⚠';
        const titleSuffix = hasError ? '（阻断）' : '（提醒）';

        // 按文件构建单行（仅文件级汇总；不展开每行明细 → 明细通过点击文件名跳转到编辑器时由 05g 弹窗承载）
        const fileRowsHtml = entries.map((en, fi) => {
            const failures = en.failures || [];
            if (failures.length === 0) return '';
            const eCnt = failures.filter(f => (f.severity || 'error') !== 'warn').length;
            const wCnt = failures.length - eCnt;
            const isErr = eCnt > 0;
            const icon = isErr ? '✕' : '⚠';
            const iconColor = isErr ? '#dc3545' : '#f0a020';
            const rowCls = isErr ? 'file-error' : 'file-warn';
            const statusClass = isErr ? 'status-err' : 'status-warn';

            const parts: string[] = [];
            if (eCnt > 0) parts.push(`<span class="s-err">${eCnt} 阻断</span>`);
            if (wCnt > 0) parts.push(`<span class="s-warn">${wCnt} 提醒</span>`);
            const statusHtml = parts.join(' / ') + ` · 共 ${failures.length} 条问题`;
            const statusTooltip = `${isErr ? '阻断' : '提醒'} · 共 ${failures.length} 条问题（点击文件名查看明细）`;

            return `
    <div class="file-row ${rowCls}" data-file-index="${fi}" data-file-path="${escapeHtml(en.filePath)}" title="点击打开：${escapeHtml(en.filePath)}">
        <div class="file-header">
            <span class="file-icon" style="color:${iconColor}">${icon}</span>
            <span class="file-name-col" title="${escapeHtml(en.filePath)}">${escapeHtml(en.fileName)}</span>
            <span class="file-status-col ${statusClass}" title="${escapeHtml(statusTooltip)}">${statusHtml}</span>
        </div>
    </div>`;
        }).join('');

        // 底部按钮：Q2=A + Q3=保留
        const cancelText = hasError ? '关闭' : '取消';
        const continueBtnHtml = hasError
            ? ''
            : `<button class="btn btn-primary" id="vgContinueBtn">忽略并继续</button>`;
        const hintText = hasError
            ? (totalWarn > 0 ? '请先修复"阻断"类问题；"提醒"类可修复后一并推送' : '请修复上述阻断问题后重新推送')
            : '点击"忽略并继续"将推送包含"待补充"的案例，可稍后完善';

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml('案例格式校验')}</title>
<style>
    ${sharedCss()}
    .vg-header{display:flex;align-items:center;padding:14px 20px;background:${headerBg};border-bottom:1px solid ${headerBd};gap:12px;flex-shrink:0}
    .vg-header-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:15px;color:#fff;background:${iconBg};flex-shrink:0}
    .vg-header-title{font-size:15px;font-weight:600;flex:1}
    .vg-header-stats{font-size:12px;color:#555}
    .vg-header-stats .s-err{color:#dc3545;font-weight:600}
    .vg-header-stats .s-warn{color:#f0a020;font-weight:600}
    .file-status-col .s-err{color:#dc3545;font-weight:600}
    .file-status-col .s-warn{color:#f0a020;font-weight:600}
    .vg-footer{display:flex;align-items:center;padding:10px 20px;border-top:1px solid var(--bd);gap:8px;flex-shrink:0;background:#fafafa}
    .vg-hint{flex:1;font-size:12px;color:#888}
    .btn-primary{background:${iconBg};color:#fff;border-color:${iconBg}}
</style>
</head>
<body>
<div class="vg-header">
    <span class="vg-header-icon">${iconChar}</span>
        <span class="vg-header-title">案例格式校验${titleSuffix}</span>
    <span class="vg-header-stats">
        涉及 ${entries.length} 个文件
        ${errFileCount > 0 ? ` · <span class="s-err">${errFileCount}</span> 阻断` : ''}
        ${warnOnlyFileCount > 0 ? ` · <span class="s-warn">${warnOnlyFileCount}</span> 仅提醒` : ''}
        &nbsp;·&nbsp; 共 <b>${totalErr + totalWarn}</b> 条问题
    </span>
</div>
<div class="file-list">${fileRowsHtml}</div>
<div class="vg-footer">
    <span class="vg-hint">${escapeHtml(hintText)}</span>
    <button class="btn" id="vgCancelBtn">${cancelText}</button>
    ${continueBtnHtml}
</div>
<script>
    (function(){
        var vscode = acquireVsCodeApi();
        document.getElementById('vgCancelBtn').onclick = function(){ vscode.postMessage({type:'validateGateResponse', decision:'cancel'}); };
        var cb = document.getElementById('vgContinueBtn');
        if (cb) cb.onclick = function(){ vscode.postMessage({type:'validateGateResponse', decision:'continue'}); };
        // 文件行点击 → 在编辑器中打开（复用面板已有的 progressOpenFile 消息），
        // 打开后由案例编辑器自动触发校验并弹出明细弹窗（05g），无需在本视图内展示明细。
        document.querySelector('.file-list').addEventListener('click', function(e){
            var row = e.target.closest('.file-row');
            if (!row) return;
            var fp = row.getAttribute('data-file-path') || '';
            if (fp) vscode.postMessage({ type: 'progressOpenFile', filePath: fp });
        });
        document.addEventListener('keydown',function(e){ if(e.key==='Escape') vscode.postMessage({type:'validateGateResponse', decision:'cancel'}); });
    })();
</script>
</body>
</html>`;
    }

    // ──────────────── 创建/复用面板 ────────────────────────────────
    let modalPanel: vscode.WebviewPanel;
        if (_activeProgressPanel && !isPanelDisposed(_activeProgressPanel)) {
            // 复用已有面板：解除旧消息监听（含旧闭包），原地切换回进度视图
            if (_activeMsgDisposable) {
                _activeMsgDisposable.dispose();
                _activeMsgDisposable = null;
            }
            modalPanel = _activeProgressPanel;
            modalPanel.reveal(vscode.ViewColumn.Active);
        } else {
            modalPanel = vscode.window.createWebviewPanel(
                'pushProgress',
                options?.panelTitle || '推送测试案例',
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: false },
            );
            _activeProgressPanel = modalPanel;
        }
    modalPanel.webview.html = buildProgressHtml();

    // 统一消息处理（进度阶段 + 校验汇总阶段 + 总结阶段），捕获 Disposable 用于复用时解除
    _activeMsgDisposable = modalPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'closePushProgress') {
            if (!_done) _cancelled = true;
            modalPanel.dispose();
        } else if (msg.type === 'cancelPushProgress') {
            _cancelled = true;
            modalPanel.webview.html = buildProgressHtml();
        } else if (msg.type === 'progressOpenFile') {
            const fp = typeof msg.filePath === 'string' ? msg.filePath : '';
            if (fp) {
                try {
                    // 强制以案例编辑器（CustomEditor）打开：保证 BaseEditorProvider.panelMap
                    // 中一定存在对应 webview 面板，后续 postFileLevelPreValidateGate 才能
                    // 拿到面板并弹出 05g 明细。若走 'vscode.open' 让系统决策，某些 csv/json
                    // 场景可能落到 TextEditor，导致 panelMap 未注册而 no-op。
                    await vscode.commands.executeCommand(
                        'vscode.openWith',
                        vscode.Uri.file(fp),
                        'testcaseViewer.unifiedEditor',
                        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
                    );
                } catch (e) {
                    // openWith 失败兜底：仍尝试 vscode.open（用户至少能看到文件）
                    try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fp)); } catch (_) { /* ignore */ }
                }
                // 主动触发一次"打开时校验" —— 修复：文件已打开时 VS Code 不再抛
                // onDidOpenTextDocument，导致 registerEditValidation 里的弹窗链路不会执行；
                // 这里显式调用 immediate+promptOnMissing 强制刷一次 05g 明细弹窗。
                try {
                    const mod = await import('../preValidate/editValidationHandler');
                    if (mod && typeof mod.requestEditValidation === 'function') {
                        mod.requestEditValidation(fp, { immediate: true, promptOnMissing: true });
                    }
                } catch (e) { /* ignore */ }
            }
        } else if (msg.type === 'validateGateResponse') {
            // 前置校验汇总视图 → 用户按钮决策
            const decision = msg.decision === 'continue' ? 'continue' : 'cancel';
            if (_validateGateResolver) {
                const r = _validateGateResolver;
                _validateGateResolver = null;
                r(decision);
            }
            // 决策后不主动切视图 —— 上层调用方拿到 decision 后：
            //   · continue → setPhase('pushing') + 更新 items 即可切回进度视图
            //   · cancel   → dispose() 关闭面板
        } else if (msg.type === 'closePushSummary') {
            modalPanel.dispose();
        } else if (msg.type === 'pushSummaryOpenFile') {
            const idx = typeof msg.index === 'number' ? msg.index : -1;
            if (idx >= 0 && idx < _summaryResults.length && _onOpenFile) {
                try { await _onOpenFile(_summaryResults[idx]); } catch (e) { /* ignore */ }
            }
        }
    });

    modalPanel.onDidDispose(() => {
        if (_activeProgressPanel === modalPanel) {
            _activeProgressPanel = null;
        }
        if (!_done) _cancelled = true;
        // 面板销毁 → 若还有 pending 的校验决策，兜底 cancel
        if (_validateGateResolver) {
            const r = _validateGateResolver;
            _validateGateResolver = null;
            r('cancel');
        }
    });

    // ──────────────── 返回控制接口 ────────────────────────────────
    return {
        get cancelled() { return _cancelled; },
        setPhase(phase: PushProgressPhase) {
            _phase = phase;
            if (!isPanelDisposed(modalPanel)) {
                // 切回进度视图时，同步将 tab 标题恢复为面板默认值（避免在推送阶段仍显示“案例格式校验”）
                try { modalPanel.title = options?.panelTitle || '推送测试案例'; } catch (_) { /* ignore */ }
                modalPanel.webview.html = buildProgressHtml();
            }
        },
        showValidateGate(entries: ValidateGateFileEntry[]): Promise<'continue' | 'cancel'> {
            return new Promise<'continue' | 'cancel'>((resolve) => {
                if (isPanelDisposed(modalPanel)) {
                    resolve('cancel');
                    return;
                }
                // 若之前已有 pending gate（异常情况），先按 cancel 结算，避免 resolver 泄漏
                if (_validateGateResolver) {
                    const prev = _validateGateResolver;
                    _validateGateResolver = null;
                    try { prev('cancel'); } catch (_) { /* ignore */ }
                }
                _validateGateResolver = resolve;
                // 将 tab 标题临时切为“案例格式校验”，用户决策后恢复为面板默认标题（“推送测试案例”）
                try { modalPanel.title = '案例格式校验'; } catch (_) { /* ignore */ }
                modalPanel.webview.html = buildValidateGateHtml(entries);
            });
        },
        update(item: PushProgressItem) {
            let targetIdx = -1;
            // 优先按文件名精确匹配（避免依赖状态顺序导致的错位）
            if (item.fileName) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].fileName === item.fileName) {
                        targetIdx = i;
                        break;
                    }
                }
            }
            // 回退：找第一个 pending/pushing 位置（首次调用 fileName 可能为空）
            if (targetIdx < 0) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].status === 'pending' || items[i].status === 'pushing') {
                        targetIdx = i;
                        break;
                    }
                }
            }
            if (targetIdx >= 0) {
                items[targetIdx] = item;
                if (!isPanelDisposed(modalPanel)) {
                    modalPanel.webview.html = buildProgressHtml();
                }
            }
        },
        done(results: PushFileResult[], onOpenFile?: (result: PushFileResult) => Promise<void>): Promise<void> {
            _done = true;
            _summaryResults = results;
            _onOpenFile = onOpenFile;
            // 即使取消也展示总结视图，让用户看到已完成的推送结果
            if (!isPanelDisposed(modalPanel)) {
                modalPanel.webview.html = buildSummaryHtml(results, options);
            }

            return new Promise(resolve => {
                const disposable = modalPanel.onDidDispose(() => {
                    disposable.dispose();
                    resolve();
                });
            });
        },
        dispose() {
            _cancelled = true;
            modalPanel.dispose();
        },
    };
}

// ============================================
// 2. 独立总结弹窗 (showPushSummary)
// ============================================

/** 当前总结面板引用（复用） */
let _summaryPanel: vscode.WebviewPanel | null = null;
let _summaryResults: PushFileResult[] = [];

/**
 * 批量推送结果总结弹窗（复用已有面板）。
 * 注意：多文件推送场景推荐使用 createPushProgress + done() 一体化方案，
 * 此函数保留用于需要独立总结面板的外部场景。
 */
export function showPushSummary(
    results: PushFileResult[],
    onOpenFile?: (result: PushFileResult) => Promise<void>,
    options?: SummaryUiOptions,
): void {
    _summaryResults = results;

    const _panelTitle = options?.panelTitle || '推送结果';

    function renderPanel() {
        if (_summaryPanel) {
            try {
                _summaryPanel.webview.html = buildSummaryHtml(results, options);
                try { _summaryPanel.title = _panelTitle; } catch (_) { /* ignore */ }
                _summaryPanel.reveal(vscode.ViewColumn.Active);
                return;
            } catch {
                _summaryPanel = null;
            }
        }

        _summaryPanel = vscode.window.createWebviewPanel(
            'pushSummary',
            _panelTitle,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: false },
        );
        _summaryPanel.webview.html = buildSummaryHtml(results, options);

        _summaryPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'closePushSummary') {
                _summaryPanel?.dispose();
                _summaryPanel = null;
            } else if (msg.type === 'pushSummaryOpenFile') {
                const idx = typeof msg.index === 'number' ? msg.index : -1;
                if (idx >= 0 && idx < _summaryResults.length && onOpenFile) {
                    try { await onOpenFile(_summaryResults[idx]); } catch (e) { /* ignore */ }
                }
            }
        });

        _summaryPanel.onDidDispose(() => {
            _summaryPanel = null;
        });
    }

    renderPanel();
}
