/* =============================================================================
 * 05g-pre-validate-gate.js  —— 推送前置校验窗口（B5）
 * -----------------------------------------------------------------------------
 * 语义：
 *   1. 由扩展端在 stepPreValidate 之后、行剔除之前 postMessage 触发；
 *   2. 按行分组渲染 —— 一张卡片 = 一行案例，卡片内混排该行**所有**问题
 *      （error 在前、warn 在后），避免"一行拆多行"或"漏掉次要问题"；
 *   3. Q2=A：只要存在任一 error，仅显示「关闭」按钮，禁止继续；
 *   4. Q1=A：全部 warn 时，显示「取消」+「忽略并继续」两个按钮；
 *   5. 用户决策通过 postMessage({ type:'preValidateGateResponse', gateId, decision }) 回传，
 *      由扩展端 utils/preValidateGate.ts 结算 runPush 的阻塞点。
 *
 * 分组排序规则（_pvgGroupByRow）：
 *   · 有 error 的组优先靠前（用户先处理阻断项）；
 *   · 同类组内按 rowIndex 升序（阅读顺序 = 文件顺序）。
 *
 * 消息契约：
 *   ext → webview：{ type:'preValidateGate', gateId, fileName,
 *                    failures:[{tsId, reason, rowIndex?, severity, field?}] }
 *   webview → ext：{ type:'preValidateGateResponse', gateId, decision:'continue'|'cancel' }
 *
 * DOM 前置要求：index.html 中需存在 #preValidateGateModal 及以下子元素：
 *   #preValidateGateHeader / #preValidateGateIcon / #preValidateGateTitle
 *   #preValidateGateClose  / #preValidateGateSummary / #preValidateGateList
 *   #preValidateGateHint   / #preValidateGateCancelBtn / #preValidateGateContinueBtn
 * ========================================================================== */

/** 当前 pending 的 gateId（同一时刻只允许一个门控窗口）。 */
var _pvgCurrentGateId = null;

/**
 * 按 tsId + rowIndex 组合键分组，聚合同一行的多条问题。
 * 保序原则：
 *   · 组之间：先出现有 error 的组，同类组内按 rowIndex 升序；
 *   · 组内条目：先 error 后 warn，各自内部保持原推送顺序。
 * 分组键用 `rowIndex||tsId` 兜底，避免 rowIndex 缺失时同一 tsId 被拆散。
 */
function _pvgGroupByRow(failures) {
    var groups = [];
    var idx = Object.create(null);
    for (var i = 0; i < failures.length; i++) {
        var f = failures[i] || {};
        var key = (f.rowIndex != null && f.rowIndex > 0)
            ? ('r#' + f.rowIndex)
            : ('t#' + (f.tsId || 'unknown'));
        var g = idx[key];
        if (!g) {
            g = {
                key: key,
                rowIndex: (f.rowIndex != null && f.rowIndex > 0) ? f.rowIndex : null,
                tsId: f.tsId || '',
                errors: [],
                warns: [],
            };
            idx[key] = g;
            groups.push(g);
        }
        if (f.severity === 'warn') g.warns.push(f);
        else g.errors.push(f);
    }
    // 排序：有 error 的行优先，其次按 rowIndex 升序
    groups.sort(function (a, b) {
        var ae = a.errors.length > 0 ? 0 : 1;
        var be = b.errors.length > 0 ? 0 : 1;
        if (ae !== be) return ae - be;
        var ar = a.rowIndex == null ? Infinity : a.rowIndex;
        var br = b.rowIndex == null ? Infinity : b.rowIndex;
        return ar - br;
    });
    return groups;
}

/** 渲染单条问题的 reason 行（不含行号，行号在组头显示）。 */
function _pvgRenderReason(f, seq, kind) {
    var item = f || {};
    var seqCls = 'xs-pr-seq' + (kind === 'warn' ? ' is-warn' : ' is-error');
    var dotCls = 'xs-pr-dot is-' + (kind === 'warn' ? 'warn' : 'error');
    return '<div class="xs-pr-item xs-pr-item-inline">'
        +    '<span class="' + dotCls + '"></span>'
        +    '<span class="' + seqCls + '">' + seq + '.</span>'
        +    '<span class="xs-pr-reason">' + escapeHtml(String(item.reason || '')) + '</span>'
        + '</div>';
}

/**
 * 渲染一组（同一行/同一 tsId 的多条问题）。
 *   · 组头：行号/tsId + 徽章（🚫 error / ⚠ warn），点击行号可跳转；
 *   · 组头右侧：📋 复制案例 ID（优先 tsId，缺失兜底 fileName#L{rowIndex}）；
 *   · 组体：先 error 后 warn，条目连续编号 1..N。
 */
function _pvgRenderGroup(group, groupIndex, fileName) {
    var g = group || {};
    var errs = g.errors || [];
    var warns = g.warns || [];
    var totalInGroup = errs.length + warns.length;
    var hasErr = errs.length > 0;
    var hasWarn = warns.length > 0;

    var hasRow = (g.rowIndex != null && g.rowIndex > 0);
    var rowText = hasRow
        ? ('第 ' + g.rowIndex + ' 行')
        : ('testcase_id ' + (g.tsId ? String(g.tsId).slice(0, 8) + '…' : '(无)'));
    var rowCls = 'xs-pr-row' + (hasRow ? ' is-link' : '');
    var rowAttr = hasRow ? (' data-row="' + g.rowIndex + '" title="点击定位到该行"') : '';

    // 组头徽章：同行有 error 就用红色；否则用黄色
    var badgeCls = hasErr ? 'xs-pr-badge is-error' : 'xs-pr-badge is-warn';
    var badgeText = hasErr
        ? (hasWarn ? '阻断 · 含提醒' : '阻断')
        : '提醒';
    var badgeIcon = hasErr ? '🚫' : '⚠';

    // P2（2026-09-19）复制案例 ID：优先 tsId；缺失时兜底为 fileName#L{rowIndex}
    var copyText = g.tsId ? String(g.tsId) : '';
    if (!copyText && hasRow) {
        copyText = (fileName ? String(fileName) : '') + '#L' + g.rowIndex;
    }
    var copyBtnHtml = copyText
        ? ('<button type="button" class="xs-pr-copy-btn" data-copy="'
            + escapeHtml(copyText) + '" title="复制案例 ID：' + escapeHtml(copyText) + '">📋</button>')
        : '';

    var groupCls = 'xs-pr-group ' + (hasErr ? 'is-error' : 'is-warn');
    var html = '<div class="' + groupCls + '">'
        +   '<div class="xs-pr-group-head">'
        +     '<span class="xs-pr-group-index">#' + groupIndex + '</span>'
        +     '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
        +     '<span class="' + badgeCls + '">' + badgeIcon + ' ' + badgeText + '</span>'
        +     copyBtnHtml
        +     '<span class="xs-pr-group-count">共 ' + totalInGroup + ' 条问题</span>'
        +   '</div>'
        +   '<div class="xs-pr-group-body">';
    var seq = 1;
    for (var i = 0; i < errs.length; i++) html += _pvgRenderReason(errs[i], seq++, 'error');
    for (var j = 0; j < warns.length; j++) html += _pvgRenderReason(warns[j], seq++, 'warn');
    html += '</div></div>';
    return html;
}

/**
 * 展示前置校验窗口。
 * @param payload { gateId, fileName, failures }
 */
function showPreValidateGateModal(payload) {
    var modal = document.getElementById('preValidateGateModal');
    if (!modal) {
        // 无 DOM 兜底：直接回复 continue，避免推送流程悬挂（60s 后扩展端也会超时兜底）。
        try {
            if (payload && payload.gateId && S.vscode) {
                S.vscode.postMessage({ type: 'preValidateGateResponse', gateId: payload.gateId, decision: 'continue' });
            }
        } catch (_) { /* ignore */ }
        return;
    }
    var p = payload || {};
    _pvgCurrentGateId = p.gateId || null;

    var failures = Array.isArray(p.failures) ? p.failures : [];
    var errorFailures = [];
    var warnFailures = [];
    failures.forEach(function (f) {
        if (f && f.severity === 'warn') warnFailures.push(f);
        else errorFailures.push(f);
    });
    var errorCount = errorFailures.length;
    var warnCount = warnFailures.length;
    var hasError = errorCount > 0;

    // 按行分组：同一行的多个问题聚合到一张卡片里，避免"一行拆多行"造成的重复浏览。
    // 这也是"多问题暴露"体验的核心 —— 用户一眼看到"这行到底哪里错、缺、待补"。
    var groups = _pvgGroupByRow(failures);
    var errorRowCount = 0;
    var warnOnlyRowCount = 0;
    for (var gi = 0; gi < groups.length; gi++) {
        if (groups[gi].errors.length > 0) errorRowCount++;
        else if (groups[gi].warns.length > 0) warnOnlyRowCount++;
    }

    var header = document.getElementById('preValidateGateHeader');
    var iconEl = document.getElementById('preValidateGateIcon');
    var titleEl = document.getElementById('preValidateGateTitle');
    var summaryEl = document.getElementById('preValidateGateSummary');
    var listEl = document.getElementById('preValidateGateList');
    var hintEl = document.getElementById('preValidateGateHint');
    var cancelBtn = document.getElementById('preValidateGateCancelBtn');
    var continueBtn = document.getElementById('preValidateGateContinueBtn');

    // 头部：有 error 用红色（is-error），无 error 只有 warn 用黄色（is-warning）
    var status = hasError ? 'error' : 'warning';
    if (header) header.className = 'xs-modal-header xs-pr-header is-' + status;
    if (iconEl) iconEl.textContent = hasError ? '🚫' : '⚠';
    if (titleEl) {
        var fn = p.fileName ? ('：' + p.fileName) : '';
        titleEl.textContent = (hasError ? '推送已阻止' : '推送前检查') + fn;
    }

    // 概要区：既展示"影响行数"（更贴用户心智：多少行需要处理），
    // 也保留"问题条数"（便于用户对总规模有感知）。
    if (summaryEl) {
        var htmlS = '<span class="xs-pr-summary-item">影响行数 <span class="xs-pr-num">' + groups.length + '</span></span>';
        if (errorRowCount > 0) {
            htmlS += '<span class="xs-pr-summary-item">阻断 <span class="xs-pr-num is-failed">' + errorRowCount + '</span> 行</span>';
        }
        if (warnOnlyRowCount > 0) {
            htmlS += '<span class="xs-pr-summary-item">仅提醒 <span class="xs-pr-num is-warn">' + warnOnlyRowCount + '</span> 行</span>';
        }
        htmlS += '<span class="xs-pr-summary-item xs-pr-summary-sub">'
              +    '共 <span class="xs-pr-num">' + (errorCount + warnCount) + '</span> 条问题'
              +    (errorCount > 0 ? '（失败 ' + errorCount + '' : '')
              +    (errorCount > 0 && warnCount > 0 ? ' / ' : '')
              +    (warnCount > 0 ? '待完善 ' + warnCount : '')
              +    (errorCount > 0 || warnCount > 0 ? '）' : '')
              +  '</span>';
        summaryEl.innerHTML = htmlS;
    }

    // 列表：按行分组渲染，每组一张卡片，卡片内先 error 后 warn。
    // 组之间的排序：有 error 的组优先靠前（用户先处理阻断），组内条目连续编号。
    if (listEl) {
        var html = '';
        if (groups.length === 0) {
            html = '<div class="xs-pr-empty">未检测到问题</div>';
        } else {
            for (var g = 0; g < groups.length; g++) {
                html += _pvgRenderGroup(groups[g], g + 1, p.fileName);
            }
        }
        listEl.innerHTML = html;

        // 行号点击 → 关闭窗口并跳转（复用 05a 的 jumpToRowByDisplayIndex）
        var links = listEl.querySelectorAll('.xs-pr-row.is-link');
        for (var k = 0; k < links.length; k++) {
            links[k].addEventListener('click', function (ev) {
                var rn = parseInt(ev.currentTarget.getAttribute('data-row'), 10);
                if (!isNaN(rn) && rn > 0) {
                    // 关闭窗口（视为 cancel）并跳转，让用户直接看到问题行
                    _respondPreValidateGate('cancel');
                    if (typeof jumpToRowByDisplayIndex === 'function') {
                        jumpToRowByDisplayIndex(rn);
                    }
                }
            });
        }

        // P2（2026-09-19）复制案例 ID：优先 clipboard API，并补一个轻提示
        var copyBtns = listEl.querySelectorAll('.xs-pr-copy-btn');
        for (var ci = 0; ci < copyBtns.length; ci++) {
            copyBtns[ci].addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                var btn = ev.currentTarget;
                var text = btn.getAttribute('data-copy') || '';
                if (!text) return;
                _pvgCopyToClipboard(text).then(function (ok) {
                    if (typeof showToast === 'function') {
                        showToast(ok ? ('已复制：' + text) : ('复制失败，请手动选中：' + text), ok ? 'success' : 'warn');
                    }
                });
            });
        }
    }

    // 底部提示 + 按钮显隐（Q2=A：有 error 时隐藏「忽略并继续」）
    if (hintEl) {
        if (hasError && warnCount > 0) {
            hintEl.textContent = '请先修复"阻断"类问题；"提醒"类可修复后一并推送';
        } else if (hasError) {
            hintEl.textContent = '请修复上述阻断问题后重新推送';
        } else {
            hintEl.textContent = '点击"忽略并继续"将推送包含"待补充"的案例，可稍后完善';
        }
    }
    if (cancelBtn) cancelBtn.textContent = hasError ? '关闭' : '取消';
    if (continueBtn) continueBtn.style.display = hasError ? 'none' : '';

    _bindPreValidateGateModal();
    modal.classList.add('show');
}

/** 关闭 modal 并向扩展端回传用户决策；重复调用安全（gateId 已消费则忽略）。 */
function _respondPreValidateGate(decision) {
    var modal = document.getElementById('preValidateGateModal');
    if (modal) modal.classList.remove('show');
    var gateId = _pvgCurrentGateId;
    _pvgCurrentGateId = null;
    if (!gateId) return;
    try {
        if (S.vscode) {
            S.vscode.postMessage({
                type: 'preValidateGateResponse',
                gateId: gateId,
                decision: decision === 'continue' ? 'continue' : 'cancel',
            });
        }
    } catch (_) { /* ignore */ }
    // 用户"忽略并继续" → 后端将真正走接口推送，此刻补弹一次「推送中…」toast。
    // 这条 toast 原本由 pushChanges/pushFromContextMenu 抢跑弹出，为消除"取消后闪现"
    // 已改为 500ms 延迟 + preValidateGate 消息到达即清除；因此需要在 continue 分支
    // 显式补弹，保证正常路径的用户仍有即时反馈。
    if (decision === 'continue' && typeof showToast === 'function') {
        showToast('推送中，请耐心等待…', 'info');
    }
    // 用户取消 → 主流程会走 onComplete，前端 pushBtn loading 会由 pushResult 消息解锁；
    // 这里额外兜底：立刻放开 _pushing 避免"取消后按钮长时间灰"的假死观感。
    if (decision === 'cancel') {
        S._pushing = false;
        if (typeof updatePushBtn === 'function') updatePushBtn();
    }
}

function _bindPreValidateGateModal() {
    if (S._pvgBound) return;
    S._pvgBound = true;
    var close = document.getElementById('preValidateGateClose');
    var cancelBtn = document.getElementById('preValidateGateCancelBtn');
    var continueBtn = document.getElementById('preValidateGateContinueBtn');
    if (close) close.addEventListener('click', function () { _respondPreValidateGate('cancel'); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { _respondPreValidateGate('cancel'); });
    if (continueBtn) continueBtn.addEventListener('click', function () { _respondPreValidateGate('continue'); });
    // ESC 关闭 = cancel
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            var m = document.getElementById('preValidateGateModal');
            if (m && m.classList.contains('show')) {
                ev.preventDefault();
                _respondPreValidateGate('cancel');
            }
        }
    });
}

/**
 * P2（2026-09-19）复制文本到剪贴板：优先 navigator.clipboard API；
 * 若不可用（VSCode Webview 可能未授权）降级到 document.execCommand('copy') 兜底。
 * 返回 Promise<boolean>——成功 true / 失败 false，由调用方给出 toast。
 */
function _pvgCopyToClipboard(text) {
    return new Promise(function (resolve) {
        if (!text) { resolve(false); return; }
        try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(
                    function () { resolve(true); },
                    function () { resolve(_pvgFallbackCopy(text)); }
                );
                return;
            }
        } catch (_) { /* ignore：降级 */ }
        resolve(_pvgFallbackCopy(text));
    });
}

/** execCommand 兜底：创建离屏 textarea + select + copy。 */
function _pvgFallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (_) { return false; }
}
