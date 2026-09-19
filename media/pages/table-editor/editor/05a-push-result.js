/* =============================================================================
 * 05a-push-result.js  —— 推送结果弹窗
 * -----------------------------------------------------------------------------
 * 由原 05-modals.js 拆分而来：
 *   showPushResultModal / closePushResultModal / bindPushResultModal
 *   - 失败行高亮联动主表（tsId 等列变红）、点击行号跳转、复制失败明细
 *   - jumpToRowByDisplayIndex：按显示行号滚动到目标行
 *
 * 2026-09-19 拆分：失败集合的数据管理层（初始化 / 增量合并 / 4 层兜底反查行号）
 * 已抽至 05h-push-failures-store.js（window.PushFailuresStore），本文件专注 UI 编排。
 * ========================================================================== */

// ==================== 推送结果弹窗 ====================
// 展示推送结果（成功 / 部分成功 / 全部失败 / 含软拦截警告）
// payload: { fileName, successCount, failures:[{rowIndex, tsId, reason, severity?}], total, skipped }
//   skipped：本次推送内"样例/模板占位行"被静默过滤的行数，不计入 success/fail。
//   仅 skipped > 0 时弹窗会额外展示"跳过 N"与"其中 N 行样例数据已跳过"文案，避免总计/成功/失败三数字相加不等于总计的视觉失调。
//   severity：'error'（缺省）=硬拦截失败；'warn'=软拦截命中（如「待补充」），行已被后端接收，仅事后知情。
//   前端按 severity 将 failures 拆成两栏（红色 error / 黄色 warn），并在头部状态、汇总维度与失败标记联动中分别处理。
var __PR_MAX_INLINE = 200; // 列表最多渲染条数，超出折叠

/**
 * 渲染一条失败/警告明细行。
 * @param f      PushFailure 项 { tsId, reason, rowIndex?, severity? }
 * @param seq    显示序号（在本段列表内的 1-based 序号）
 * @param kind   'error' | 'warn'，控制序号徽标样式（红/黄）
 * @return {string} HTML 片段
 */
function _renderFailureItem(f, seq, kind) {
    var item = f || {};
    var hasRow = (item.rowIndex != null && item.rowIndex > 0);
    var rowText = hasRow ? ('第 ' + item.rowIndex + ' 行') : ('testcase_id ' + (item.tsId ? String(item.tsId).slice(0, 8) + '…' : '(无)'));
    var rowCls = 'xs-pr-row' + (hasRow ? ' is-link' : '');
    var rowAttr = hasRow ? (' data-row="' + item.rowIndex + '" title="点击定位到该行"') : '';
    var seqCls = 'xs-pr-seq' + (kind === 'warn' ? ' is-warn' : '');
    return '<div class="xs-pr-item">'
        +    '<span class="' + seqCls + '">' + seq + '.</span>'
        +    '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
        +    '<span class="xs-pr-reason">' + escapeHtml(String(item.reason || '')) + '</span>'
        + '</div>';
}

function showPushResultModal(payload) {
    console.log('[推送诊断][webview] showPushResultModal 渲染 | failures.length=' + (payload && payload.failures ? payload.failures.length : 0) + ' successCount=' + (payload ? payload.successCount || 0 : 0) + ' total=' + (payload && payload.total != null ? payload.total : '?') + ' skipped=' + (payload && payload.skipped != null ? payload.skipped : 0));
    var modal = document.getElementById('pushResultModal');
    if (!modal) return;
    var p = payload || {};
    var fileName = p.fileName || '';
    var errorMsg = p.error || '';   // 纯错误消息（前置校验失败等场景，无 failures）
    var successCount = p.successCount || 0;
    var failures = Array.isArray(p.failures) ? p.failures : [];
    var skipped = (p.skipped != null && p.skipped > 0) ? Number(p.skipped) : 0;

    // B4：按 severity 拆分 —— 老数据缺省视为 error 保持向后兼容
    var errorFailures = [];
    var warnFailures = [];
    failures.forEach(function (f) {
        if (f && f.severity === 'warn') warnFailures.push(f);
        else errorFailures.push(f);
    });
    var errorCount = errorFailures.length;
    var warnCount = warnFailures.length;

    var total = (p.total != null) ? p.total : (successCount + errorCount + skipped);

    var header = document.getElementById('pushResultHeader');
    var iconEl = document.getElementById('pushResultIcon');
    var titleEl = document.getElementById('pushResultTitle');
    var summaryEl = document.getElementById('pushResultSummary');
    var listEl = document.getElementById('pushResultList');
    var hintEl = document.getElementById('pushResultHint');
    var copyBtn = document.getElementById('pushResultCopyBtn');

    // 纯错误消息分支（前置校验失败，无推送数据）
    if (errorMsg) {
        if (header) header.className = 'xs-modal-header xs-pr-header is-error';
        if (iconEl) iconEl.textContent = '✕';
        if (titleEl) titleEl.textContent = '推送失败' + (fileName ? ('：' + fileName) : '');
        if (summaryEl) summaryEl.innerHTML = '';
        if (listEl) listEl.innerHTML = '<div class="xs-pr-empty">' + escapeHtml(errorMsg) + '</div>';
        if (hintEl) hintEl.textContent = '';
        if (copyBtn) copyBtn.style.display = 'none';
        // 前置校验失败也属于"推送完成"，清理本批修改高亮避免残留
        HighlightModel.clearByPushBatch(S, {
            rowIndices: (S._lastPushBatchRowIndices && S._lastPushBatchRowIndices.length > 0)
                ? S._lastPushBatchRowIndices.slice()
                : null,
        });
        try { renderTable(); } catch (_) {}
        bindPushResultModal();
        modal.classList.add('show');
        return;
    }

    var allFailed = (errorCount > 0 && successCount === 0);
    var allSuccessNoWarn = (errorCount === 0 && warnCount === 0);
    // 状态判定优先级：
    //   1. 有 error（硬拦截）→ 部分成功 / 全部失败（红色调）
    //   2. 无 error 但有 warn（软拦截命中，行已推送）→ warning（黄色调，标题仍显示成功但带提示）
    //   3. 全绿 → success
    var status;
    if (errorCount > 0) {
        status = allFailed ? 'error' : 'warning';
    } else if (warnCount > 0) {
        status = 'warning';
    } else {
        status = 'success';
    }

    // 头部状态
    if (header) header.className = 'xs-modal-header xs-pr-header is-' + status;
    if (iconEl) iconEl.textContent = (status === 'success') ? '✓' : (status === 'error' ? '✕' : '!');
    if (titleEl) {
        // 无 error 且有 warn 时视为"推送成功（含提示）"——行已被后端接收
        var titleText;
        if (status === 'success') {
            titleText = '推送成功';
        } else if (status === 'error') {
            titleText = '推送失败';
        } else if (errorCount === 0 && warnCount > 0) {
            titleText = '推送成功（含 ' + warnCount + ' 条待完善提示）';
        } else {
            titleText = '推送部分成功';
        }
        titleEl.textContent = titleText + (fileName ? ('：' + fileName) : '');
    }

    // 概要：总计 / 成功 / 失败 / 警告 / 跳过（后二者按 > 0 条件显示）
    if (summaryEl) {
        var summaryHtml =
            '<span class="xs-pr-summary-item">总计 <span class="xs-pr-num">' + total + '</span></span>' +
            '<span class="xs-pr-summary-item">成功 <span class="xs-pr-num is-success">' + successCount + '</span></span>' +
            '<span class="xs-pr-summary-item">失败 <span class="xs-pr-num is-failed">' + errorCount + '</span></span>';
        if (warnCount > 0) {
            // 软拦截命中：行已推送，作为独立维度显示。与"失败"不同色以避免用户误解为需修正才能推送。
            summaryHtml += '<span class="xs-pr-summary-item">警告 <span class="xs-pr-num is-warn">' + warnCount + '</span></span>';
        }
        if (skipped > 0) {
            summaryHtml += '<span class="xs-pr-summary-item">跳过 <span class="xs-pr-num">' + skipped + '</span></span>';
        }
        summaryEl.innerHTML = summaryHtml;
    }

    // 失败明细列表：按 severity 分栏（error 红色 → warn 黄色），空则显示成功文案
    if (listEl) {
        if (errorCount === 0 && warnCount === 0) {
            // 纯成功（可能伴随 skipped）—— 文案要照应 skipped，否则多出的行数会让用户困惑。
            var succCount = successCount;
            var successText = '全部 ' + succCount + ' 条推送成功 🎉';
            if (skipped > 0) {
                successText += '（已跳过 ' + skipped + ' 行样例数据）';
            }
            listEl.innerHTML = '<div class="xs-pr-empty">' + successText + '</div>';
        } else {
            var html = '';
            // ---- 硬拦截失败区（红色）----
            if (errorCount > 0) {
                var errRender = Math.min(errorCount, __PR_MAX_INLINE);
                html += '<div class="xs-pr-section is-error">'
                    +   '<div class="xs-pr-section-title">'
                    +     '<span class="xs-pr-badge is-error">失败</span>'
                    +     '<span class="xs-pr-section-desc">共 ' + errorCount + ' 条硬拦截失败（需修正后重新推送）</span>'
                    +   '</div>';
                for (var i = 0; i < errRender; i++) {
                    html += _renderFailureItem(errorFailures[i], i + 1, 'error');
                }
                if (errorCount > __PR_MAX_INLINE) {
                    html += '<div class="xs-pr-truncated">…另有 ' + (errorCount - __PR_MAX_INLINE) + ' 条失败未展示，请点击「复制明细」获取完整列表。</div>';
                }
                html += '</div>';
            }
            // ---- 软拦截命中区（黄色，行已推送）----
            if (warnCount > 0) {
                var warnRender = Math.min(warnCount, __PR_MAX_INLINE);
                html += '<div class="xs-pr-section is-warn">'
                    +   '<div class="xs-pr-section-title">'
                    +     '<span class="xs-pr-badge is-warn">待完善</span>'
                    +     '<span class="xs-pr-section-desc">共 ' + warnCount + ' 条软拦截命中（行已推送成功，建议尽快完善）</span>'
                    +   '</div>';
                for (var j = 0; j < warnRender; j++) {
                    html += _renderFailureItem(warnFailures[j], j + 1, 'warn');
                }
                if (warnCount > __PR_MAX_INLINE) {
                    html += '<div class="xs-pr-truncated">…另有 ' + (warnCount - __PR_MAX_INLINE) + ' 条提示未展示，请点击「复制明细」获取完整列表。</div>';
                }
                html += '</div>';
            }
            listEl.innerHTML = html;

            // 绑定行号点击 → 滚动并高亮主表对应行（error/warn 均可跳转）
            var links = listEl.querySelectorAll('.xs-pr-row.is-link');
            for (var k = 0; k < links.length; k++) {
                links[k].addEventListener('click', function (ev) {
                    var rn = parseInt(ev.currentTarget.getAttribute('data-row'), 10);
                    if (!isNaN(rn) && rn > 0) jumpToRowByDisplayIndex(rn);
                });
            }
        }
    }

    // hint 与复制按钮：只要有任一类失败即显示
    var hasAny = (errorCount + warnCount) > 0;
    if (hintEl) {
        if (errorCount > 0 && warnCount > 0) {
            hintEl.textContent = '红色为硬拦截失败（需修正），黄色为软拦截提示（已推送）；点击行号可定位表格对应行';
        } else if (errorCount > 0) {
            hintEl.textContent = '点击行号可定位到表格对应行；失败行已在表格中高亮标记';
        } else if (warnCount > 0) {
            hintEl.textContent = '行已推送成功；点击行号可定位到表格对应行并尽快完善';
        } else {
            hintEl.textContent = '';
        }
    }
    if (copyBtn) copyBtn.style.display = hasAny ? '' : 'none';

    // 按 tsId 标记失败行，重绘表格以高亮展示。
    // 累积合并策略（不再整体覆盖）：
    //   1) 保留所有未参与本批推送的历史失败行（仍高亮、仍带原因）
    //   2) 本批中已成功的 tsId（= 本批 tsId 集合 − 本次失败 tsId 集合）从失败集合中移除
    //   3) 本批中失败的 tsId 写入/更新到失败集合，并刷新原因
    // ★ B3（P1 决策，2026-09-18）：warn 项也进入 _pushFailedTsIds 但标 severity='warn'，
    //   由 02a-render.js 按 severity 打黄行（xs-tr-push-warn）而非红行。
    //   这样"推送刚完成 → 关闭重开 → 编辑期"始终一致的黄色视觉。
    //   历史 warn 不进集合的做法会导致"推送成功那一瞬间黄色消失，接下来编辑期又出现"的诡异跳变。
    //
    // 具体数据合并逻辑已抽至 05h-push-failures-store.js（window.PushFailuresStore），
    // 本文件只做 UI 编排与消息透传。
    var batchSet = (S._lastPushBatchTsIds instanceof Set) ? S._lastPushBatchTsIds : null;
    var _mergeResult = window.PushFailuresStore.mergePushFailures(S, p, batchSet);
    var nowFailedSet = _mergeResult.nowFailedSet;
    var clearedCount = _mergeResult.clearedCount;

    // 诊断日志：若同一 tsId 出现在旧快照且时间戳被更新，说明存在重刷（配合 01-core.js 双发检测）
    if (_mergeResult.oldFailTimeSnap && _mergeResult.oldFailTimeSnap.length > 0) {
        console.log('[推送诊断][webview] pushResult 合并 | _failNow=' + _mergeResult.failNow
            + ' | 旧 _pushFailedTime=[' + _mergeResult.oldFailTimeSnap.join(', ') + ']'
            + ' | 本次写入 tsIds=' + Array.from(nowFailedSet).join(','));
    }

    if (typeof dbg === 'function') {
        dbg('📨 pushResult merge: batch=' + (batchSet ? batchSet.size : 'null')
            + ' nowFailed=' + nowFailedSet.size
            + ' cleared=' + clearedCount
            + ' totalFailedAfter=' + S._pushFailedTsIds.size
            + ' failedOnly=' + !!S._failedOnly);
    }

    // 清除本批推送行的 S.mods 修改高亮（推送完成 = 修改已提交）
    // 失败行由 S._pushFailedTsIds 提供红色高亮，不再需要黄色 modified 标记
    // 05a 自身负责"从哪几个渠道兜底反查行号"，门面只接收最终 rowIndices。
    // 4 层兜底反查逻辑已抽至 05h-push-failures-store.js（window.PushFailuresStore）。
    var pushRowIndices = window.PushFailuresStore.resolvePushRowIndices(S, p, batchSet, failures);
    // 交由门面统一收敛清理动作：S.mods / _detailModCellKeys / _addedRowSet /
    // _lastPushBatchRowIndices / _lastPushBatchTsIds（一次推送结果消费完毕）
    HighlightModel.clearByPushBatch(S, {
        rowIndices: (pushRowIndices && pushRowIndices.length > 0) ? pushRowIndices : null,
    });

    // 推送后回写的 testCaseNo 单元格高亮信息（同时清除旧高亮，确保弹窗显示最新结果）
    // 说明：p.highlightedCells 未传时保留已有高亮；传空/无效时按 null 清除。
    var _hlC = HighlightUtil.parseHighlightedCells(p.highlightedCells);
    if (_hlC) {
        // ⚠ setHighlightedCells 内部会同步刷新 _highlightedTime，否则后续 render 时新推送的高亮会被历史修改时间
        //   (_modsTime > _highlightedTime) 判为"陈旧的推送"→ 放弃 pushUpdCls，
        //   导致「推送成功后重新推送成功」的黄底不显示（对偶于「推送成功后修改」的 modified 显示逻辑）
        HighlightModel.setHighlightedCells(S, _hlC);
    } else if ('highlightedCells' in p) {
        // 扩展端明确传了空的 highlightedCells，表示无高亮
        HighlightModel.setHighlightedCells(S, null);
    }

    try { renderTable(); } catch (_) { /* ignore */ }

    // 缓存全量明细文本，便于复制（按 error / warn 分节，方便用户区分）
    var _fmtItem = function (f, i) {
        var rowPart = (f.rowIndex != null && f.rowIndex > 0) ? ('第 ' + f.rowIndex + ' 行') : ('testcase_id ' + (f.tsId || '(无)'));
        return (i + 1) + '. ' + rowPart + '：' + (f.reason || '');
    };
    var _detailParts = [];
    if (errorCount > 0) {
        _detailParts.push('【硬拦截失败（需修正后重新推送）】');
        _detailParts.push(errorFailures.map(_fmtItem).join('\n'));
    }
    if (warnCount > 0) {
        if (_detailParts.length > 0) _detailParts.push('');
        _detailParts.push('【软拦截命中（行已推送，建议尽快完善）】');
        _detailParts.push(warnFailures.map(_fmtItem).join('\n'));
    }
    S._pushResultDetailText = _detailParts.join('\n');

    bindPushResultModal();
    modal.classList.add('show');
}

function closePushResultModal() {
    _dismissPushResultModal(true);
}

// 仅隐藏弹窗，不触发 reload；用于跳转行号场景（reload 会覆盖 S.data 并清空 S.sel，破坏跳转）
function _dismissPushResultModal(triggerReload) {
    var modal = document.getElementById('pushResultModal');
    if (modal) modal.classList.remove('show');
    if (triggerReload && S.vscode) {
        // 弹窗关闭后请求扩展端重新推送最新高亮结果（含服务器回写的 testCaseNo 等字段）
        S.vscode.postMessage({ type: 'reload' });
    }
}

function bindPushResultModal() {
    if (S._pushResultBound) return;
    S._pushResultBound = true;
    var modal = document.getElementById('pushResultModal');
    var close = document.getElementById('pushResultClose');
    var ok = document.getElementById('pushResultOkBtn');
    var copy = document.getElementById('pushResultCopyBtn');
    if (close) close.addEventListener('click', closePushResultModal);
    if (ok) ok.addEventListener('click', closePushResultModal);
    if (copy) copy.addEventListener('click', function () {
        var text = S._pushResultDetailText || '';
        if (!text) { showToast('无明细可复制', 'error'); return; }
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { showToast('明细已复制', 'success'); },
                function () { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
    });
    // ESC 关闭
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            var m = document.getElementById('pushResultModal');
            if (m && m.classList.contains('show')) {
                ev.preventDefault();
                closePushResultModal();
            }
        }
    });
}

function fallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('明细已复制', 'success');
    } catch (_) {
        showToast('复制失败', 'error');
    }
}

// 关闭推送结果弹窗后，按"显示行号"（用户视觉上从 1 开始的物理行号）滚动并高亮主表
// 注意：本函数走 _dismissPushResultModal(false) 而非 closePushResultModal()，
// 避免触发 reload 消息导致 S.data 重建、S.sel 被清空、跳转失败的连锁反应。
function jumpToRowByDisplayIndex(rowIndex) {
    _dismissPushResultModal(false);
    var r = rowIndex - 1; // 转成 0-based 索引
    var totalRows = (S.data && S.data.rows ? S.data.rows.length : 0);
    if (r < 0 || r >= totalRows) {
        showToast('该行已不在当前表格中（可能已被删除）', 'error');
        return;
    }
    // 视图态检测：目标行若不在 _viewRows 中（被筛选/搜索/仅看X隐藏），自动退出筛选
    // 否则 querySelector('tr[data-row=r]') 找不到目标行 → 用户看不到任何反馈（静默失败）
    var _vr = S._viewRows;
    var _inView = !_vr || _vr.length === 0 || _vr.length === totalRows || _vr.indexOf(r) !== -1;
    if (!_inView) {
        // 依次尝试关闭所有可能隐藏该行的过滤开关，尽量保留列筛选/搜索等精细过滤
        var _cleared = [];
        if (S._failedOnly) { S._failedOnly = false; _cleared.push('仅看推送失败'); }
        if (S._modifiedOnly) { S._modifiedOnly = false; _cleared.push('仅看修改'); }
        if (S._addedOnly) { S._addedOnly = false; _cleared.push('仅看新增'); }
        if (S._deletedOnly) { S._deletedOnly = false; _cleared.push('仅看删除'); }
        if (S._markedOnly) { S._markedOnly = false; _cleared.push('仅看标记'); }
        if (_cleared.length > 0 && typeof showToast === 'function') {
            showToast('已退出「' + _cleared.join('、') + '」以定位目标行', 'info');
        }
    }
    // 选中该行并滚动到可见
    S.sel = new Set([r]);
    renderTable();
    setTimeout(function () {
        // 虚拟滚动模式下，目标行可能未渲染：先滚入视口触发渲染
        if (S._virtualOn && typeof ensureRowVisible === 'function') {
            ensureRowVisible(r);
        }
        var tr = document.querySelector('tr[data-row="' + r + '"]');
        if (tr && tr.scrollIntoView) {
            tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (!_inView) {
            // 兜底：清筛选后仍找不到 DOM 节点（可能列筛选/搜索仍在生效）
            showToast('目标行被列筛选/搜索隐藏，请手动清除筛选后重试', 'info');
        }
    }, 50);
}

