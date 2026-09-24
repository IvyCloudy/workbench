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
 *   · 文件级问题（tsId='__FILE_LEVEL__'）置顶；
 *   · 其余行级组严格按 rowIndex 升序（阅读顺序 = 文件顺序），不再让"有 error"跨越行号顺序，
 *     避免出现"第 10 行 → 第 14 行 → 第 11 行"这种反直觉跳序；
 *   · 同一行内的 error/warn 排序仍是"先 error 后 warn"，只影响组内条目 seq。
 *
 * 消息契约：
 *   ext → webview：{ type:'preValidateGate', gateId, fileName, allowContinue,
 *                    failures:[{tsId, reason, rowIndex?, severity, field?}] }
 *   · allowContinue=true（推送门控）：warn 级可显示「忽略并继续」；
 *   · allowContinue=false（打开文件 / 格式校验按钮）：纯查看问题，无"继续"动作，只显示「关闭」。
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
    // 排序（§2.3.5）：
    //   1) 文件级问题（tsId='__FILE_LEVEL__'）永远排在第 1 位 ——
    //      结构性错误优先于行级校验展示，避免"缺列"这类必修问题被淹没在行级失败列表中；
    //   2) 其余行级组严格按 rowIndex 升序（阅读顺序 = 文件顺序）——
    //      即便某行只有 warn、后一行有 error，也保持文件自然顺序，避免出现
    //      "第 10 行 → 第 14 行 → 第 11 行"这种反直觉跳序。
    //   · 同一行内的 error/warn 顺序仍在 _pvgRenderGroup 中保持"先 error 后 warn"，
    //     只影响组内条目 seq，不影响组之间排序。
    //   · 无 rowIndex 的兜底组（罕见：如 tsId 分组但缺行号）按 Infinity 落尾。
    groups.sort(function (a, b) {
        var af = a.tsId === '__FILE_LEVEL__' ? 0 : 1;
        var bf = b.tsId === '__FILE_LEVEL__' ? 0 : 1;
        if (af !== bf) return af - bf;
        var ar = a.rowIndex == null ? Infinity : a.rowIndex;
        var br = b.rowIndex == null ? Infinity : b.rowIndex;
        return ar - br;
    });
    return groups;
}

/**
 * R2（2026-09-19）· 把一条 failure 按 hits[] 展开为 N 条"可渲染项"（每条只讲一个字段）。
 *   · 触发条件：f.hits 是数组且长度 ≥ 2 且至少存在一条 hit 带 singleReason；
 *   · 展开后每条项目继承 severity/tsId/rowIndex，reason 改用 hit.singleReason；
 *   · 单 hit 或无 hits 的场景保持原对象不动，与旧口径完全一致。
 * 目的：让弹窗"每一项各占一条 bullet"，行号仅在卡片头显示一次。
 */
function _pvgExpandFailureByHits(f) {
    if (!f || !Array.isArray(f.hits) || f.hits.length < 2) return [f];
    var hasSingle = false;
    for (var i = 0; i < f.hits.length; i++) {
        if (f.hits[i] && f.hits[i].singleReason) { hasSingle = true; break; }
    }
    if (!hasSingle) return [f];
    var out = [];
    for (var k = 0; k < f.hits.length; k++) {
        var h = f.hits[k] || {};
        var reason = h.singleReason || f.reason || '';
        out.push({
            tsId: f.tsId,
            reason: reason,
            rowIndex: f.rowIndex,
            severity: f.severity,
            field: h.field != null ? h.field : f.field,
            stepIdx: h.stepIdx,
            subField: h.subField,
        });
    }
    return out;
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
 *   · 组头右侧：分类计数「阻断 X · 提醒 Y」（与顶部 summary 口径一致），
 *     去掉了此前的 📋 复制案例 ID 图标（用户反馈可读性优先，不再摆放次要操作）；
 *   · 组体：先 error 后 warn，条目连续编号 1..N。
 */
function _pvgRenderGroup(group, groupIndex, fileName) {
    var g = group || {};
    var errs = g.errors || [];
    var warns = g.warns || [];
    var hasErr = errs.length > 0;
    var hasWarn = warns.length > 0;

    var hasRow = (g.rowIndex != null && g.rowIndex > 0);
    // §2.3.5 · 文件级问题（缺必备列/字段）：tsId 使用固定伪值 '__FILE_LEVEL__'，
    //   此时不显示"testcase_id 前8位"，也不提供复制按钮/跳转，避免误导用户以为某一行有问题。
    var isFileLevel = (g.tsId === '__FILE_LEVEL__');
    var rowText;
    if (isFileLevel) {
        rowText = '📁 文件级问题（缺必备列/字段）';
    } else if (hasRow) {
        rowText = '第 ' + g.rowIndex + ' 行';
    } else {
        rowText = 'testcase_id ' + (g.tsId ? String(g.tsId).slice(0, 8) + '…' : '(无)');
    }
    var rowCls = 'xs-pr-row' + (hasRow && !isFileLevel ? ' is-link' : '');
    var rowAttr = (hasRow && !isFileLevel) ? (' data-row="' + g.rowIndex + '" title="点击定位到该行"') : '';

    // 组头徽章：同行有 error 就用红色；否则用黄色
    var badgeCls = hasErr ? 'xs-pr-badge is-error' : 'xs-pr-badge is-warn';
    var badgeText = hasErr
        ? (hasWarn ? '阻断 · 含提醒' : '阻断')
        : '提醒';
    var badgeIcon = hasErr ? '🚫' : '⚠';

    // 2026-09-19 · 卡片头右侧「分类计数」——与顶部概要区口径一致：
    //   · 顶部：影响行数 X · 阻断 A 行 · 仅提醒 B 行 · 共 N 条问题（失败 E / 待完善 W）
    //   · 卡片：按 error/warn 分类显示，让每行的问题构成一眼可辨
    //     - 同时含 error + warn：显示「阻断 E · 提醒 W」
    //     - 仅 error：显示「阻断 E」
    //     - 仅 warn ：显示「提醒 W」
    //   之前使用的📋复制案例 ID 按钮已按需求移除（多数用户不需要复制 tsId，
    //   反而占用视觉空间；如需复制可通过行号点击跳转后在编辑器内查看）。
    var _countParts = [];
    if (errs.length > 0) _countParts.push('阻断 <span class="xs-pr-num is-failed">' + errs.length + '</span>');
    if (warns.length > 0) _countParts.push('提醒 <span class="xs-pr-num is-warn">' + warns.length + '</span>');
    var _countHtml = _countParts.join(' · ');

    var groupCls = 'xs-pr-group ' + (hasErr ? 'is-error' : 'is-warn');
    var html = '<div class="' + groupCls + '">'
        +   '<div class="xs-pr-group-head">'
        +     '<span class="xs-pr-group-index">#' + groupIndex + '</span>'
        +     '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
        +     '<span class="' + badgeCls + '">' + badgeIcon + ' ' + badgeText + '</span>'
        +     '<span class="xs-pr-group-count">' + _countHtml + '</span>'
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
                // 纯校验弹窗（allowContinue=false）无"继续"语义，兜底按 cancel 处理
                var _fallbackDecision = (payload.allowContinue === false) ? 'cancel' : 'continue';
                S.vscode.postMessage({ type: 'preValidateGateResponse', gateId: payload.gateId, decision: _fallbackDecision });
            }
        } catch (_) { /* ignore */ }
        return;
    }
    var p = payload || {};
    _pvgCurrentGateId = p.gateId || null;

    var rawFailures = Array.isArray(p.failures) ? p.failures : [];
    // R2（2026-09-19）：同一行多字段命中时，先按 hits[].singleReason 展开为多条
    // "每一项各一条"的可渲染项；单命中场景不变。后续分组/计数均基于展开后的数组。
    var failures = [];
    for (var _fi = 0; _fi < rawFailures.length; _fi++) {
        var _expanded = _pvgExpandFailureByHits(rawFailures[_fi]);
        for (var _ei = 0; _ei < _expanded.length; _ei++) failures.push(_expanded[_ei]);
    }
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
        // 2026-09-19（P4）标题统一为「案例格式校验」——覆盖
        //   · 打开文件时（编辑期弹窗）
        //   · 推送前置拦截（stepPreValidate）
        //   · 批量推送总结点入后（P3 复用 05g）
        // 后缀根据严重级给出状态提示，帮助用户第一眼判断是否可继续。
        var titleSuffix = hasError ? '（阻断）' : '（提醒）';
        titleEl.textContent = '案例格式校验' + titleSuffix + fn;
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
    // 组之间排序：文件级问题置顶，其余严格按 rowIndex 升序（与文件行号一致），
    // 避免 error 组跨越行号插到 warn 组前面造成阅读跳序。组内条目连续编号。
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

        // 卡片右上角复制案例 ID 图标（📋）已按需求移除，此处不再需要绑定点击事件；
        // _pvgCopyToClipboard / _pvgFallbackCopy 保留在下方，供其它入口（若将来需要）复用。
    }

    // 底部提示 + 按钮显隐
    //  · 有 error 时：隐藏「忽略并继续」（Q2=A），仅"关闭"
    //  · 纯校验弹窗（打开文件 / 格式校验按钮，allowContinue=false）：不是推送流程，
    //    没有"继续"动作可触发，"忽略并继续"语义不成立 → 同样只显示"关闭"
    var allowContinue = payload && payload.allowContinue !== false;
    if (hintEl) {
        if (!allowContinue) {
            hintEl.textContent = hasError
                ? '请先修复上述阻断问题后保存（重新打开或点击「格式校验」复查）'
                : '可关闭后继续编辑；修复后再次点击「格式校验」复查';
        } else if (hasError && warnCount > 0) {
            hintEl.textContent = '请先修复"阻断"类问题；"提醒"类可修复后一并推送';
        } else if (hasError) {
            hintEl.textContent = '请修复上述阻断问题后重新推送';
        } else {
            hintEl.textContent = '点击"忽略并继续"将推送包含"待补充"的案例，可稍后完善';
        }
    }
    if (cancelBtn) cancelBtn.textContent = (hasError || !allowContinue) ? '关闭' : '取消';
    if (continueBtn) continueBtn.style.display = (hasError || !allowContinue) ? 'none' : '';

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
