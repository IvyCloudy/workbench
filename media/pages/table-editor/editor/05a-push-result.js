/* =============================================================================
 * 05a-push-result.js  —— 推送结果弹窗
 * -----------------------------------------------------------------------------
 * 由原 05-modals.js 拆分而来：
 *   showPushResultModal / closePushResultModal / bindPushResultModal
 *   - 失败行高亮联动主表（tsId 等列变红）、点击行号跳转、复制失败明细
 *   - jumpToRowByDisplayIndex：按显示行号滚动到目标行
 * ========================================================================== */

// ==================== 推送结果弹窗 ====================
// 展示推送结果（成功 / 部分成功 / 全部失败）
// payload: { fileName, successCount, failures:[{rowIndex, tsId, reason}], total }
var __PR_MAX_INLINE = 200; // 列表最多渲染条数，超出折叠
function showPushResultModal(payload) {
    var modal = document.getElementById('pushResultModal');
    if (!modal) return;
    var p = payload || {};
    var fileName = p.fileName || '';
    var errorMsg = p.error || '';   // 纯错误消息（前置校验失败等场景，无 failures）
    var successCount = p.successCount || 0;
    var failures = Array.isArray(p.failures) ? p.failures : [];
    var total = (p.total != null) ? p.total : (successCount + failures.length);

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
        if (S._lastPushBatchRowIndices && S._lastPushBatchRowIndices.length > 0) {
            var errModsToDelete = [];
            S.mods.forEach(function (key) {
                var commaIdx = key.indexOf(',');
                if (commaIdx > -1 && S._lastPushBatchRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                    errModsToDelete.push(key);
                }
            });
            errModsToDelete.forEach(function (k) { S.mods.delete(k); });
            if (S._detailModCellKeys && S._detailModCellKeys.size > 0) {
                var errDetailToDelete = [];
                S._detailModCellKeys.forEach(function (key) {
                    var commaIdx = key.indexOf(',');
                    if (commaIdx > -1 && S._lastPushBatchRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                        errDetailToDelete.push(key);
                    }
                });
                errDetailToDelete.forEach(function (k) { S._detailModCellKeys.delete(k); });
            }
            S._lastPushBatchRowIndices = null;
        }
        S._lastPushBatchTsIds = null;
        try { renderTable(); } catch (_) {}
        bindPushResultModal();
        modal.classList.add('show');
        return;
    }

    var allFailed = (failures.length > 0 && successCount === 0);
    var allSuccess = (failures.length === 0);
    var status = allSuccess ? 'success' : (allFailed ? 'error' : 'warning');

    // 头部状态
    if (header) header.className = 'xs-modal-header xs-pr-header is-' + status;
    if (iconEl) iconEl.textContent = (status === 'success') ? '✓' : (status === 'error' ? '✕' : '!');
    if (titleEl) {
        var titleText = (status === 'success') ? '推送成功' : (status === 'error' ? '推送失败' : '推送部分成功');
        titleEl.textContent = titleText + (fileName ? ('：' + fileName) : '');
    }

    // 概要：成功 / 失败 / 总计
    if (summaryEl) {
        summaryEl.innerHTML =
            '<span class="xs-pr-summary-item">总计 <span class="xs-pr-num">' + total + '</span></span>' +
            '<span class="xs-pr-summary-item">成功 <span class="xs-pr-num is-success">' + successCount + '</span></span>' +
            '<span class="xs-pr-summary-item">失败 <span class="xs-pr-num is-failed">' + failures.length + '</span></span>';
    }

    // 失败明细列表
    if (listEl) {
        if (failures.length === 0) {
            listEl.innerHTML = '<div class="xs-pr-empty">全部 ' + total + ' 条推送成功 🎉</div>';
        } else {
            var renderCount = Math.min(failures.length, __PR_MAX_INLINE);
            var html = '';
            for (var i = 0; i < renderCount; i++) {
                var f = failures[i] || {};
                var hasRow = (f.rowIndex != null && f.rowIndex > 0);
                var rowText = hasRow ? ('第 ' + f.rowIndex + ' 行') : ('testcase_id ' + (f.tsId ? String(f.tsId).slice(0, 8) + '…' : '(无)'));
                var rowCls = 'xs-pr-row' + (hasRow ? ' is-link' : '');
                var rowAttr = hasRow ? (' data-row="' + f.rowIndex + '" title="点击定位到该行"') : '';
                html += '<div class="xs-pr-item">'
                    +    '<span class="xs-pr-seq">' + (i + 1) + '.</span>'
                    +    '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
                    +    '<span class="xs-pr-reason">' + escapeHtml(String(f.reason || '')) + '</span>'
                    + '</div>';
            }
            if (failures.length > __PR_MAX_INLINE) {
                html += '<div class="xs-pr-truncated">…另有 ' + (failures.length - __PR_MAX_INLINE) + ' 条失败未展示，请点击「复制失败明细」获取完整列表。</div>';
            }
            listEl.innerHTML = html;

            // 绑定行号点击 -> 滚动并高亮主表对应行
            var links = listEl.querySelectorAll('.xs-pr-row.is-link');
            for (var k = 0; k < links.length; k++) {
                links[k].addEventListener('click', function (ev) {
                    var rn = parseInt(ev.currentTarget.getAttribute('data-row'), 10);
                    if (!isNaN(rn) && rn > 0) jumpToRowByDisplayIndex(rn);
                });
            }
        }
    }

    if (hintEl) hintEl.textContent = (failures.length > 0) ? '点击行号可定位到表格对应行；失败行已在表格中高亮标记' : '';
    if (copyBtn) copyBtn.style.display = (failures.length > 0) ? '' : 'none';

    // 按 tsId 标记失败行，重绘表格以高亮展示。
    // 累积合并策略（不再整体覆盖）：
    //   1) 保留所有未参与本批推送的历史失败行（仍高亮、仍带原因）
    //   2) 本批中已成功的 tsId（= 本批 tsId 集合 − 本次失败 tsId 集合）从失败集合中移除
    //   3) 本批中失败的 tsId 写入/更新到失败集合，并刷新原因
    if (!S._pushFailedTsIds) S._pushFailedTsIds = new Set();
    if (!S._pushFailedReasons) S._pushFailedReasons = new Map();
    if (!S._pushFailedTime) S._pushFailedTime = new Map();

    // 收集本次失败 tsId
    var nowFailedSet = new Set();
    failures.forEach(function (f) {
        if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
            nowFailedSet.add(String(f.tsId));
        }
    });

    // 本批参与的 tsId（pushChanges 时缓存）。若缺失则退化为：本次失败 tsId 集合，
    // 即此次结果不会清除任何历史标记，只会追加本次失败。
    var batchSet = (S._lastPushBatchTsIds instanceof Set) ? S._lastPushBatchTsIds : null;
    var clearedCount = 0;
    if (batchSet) {
        // 计算本批中已成功的 tsId（本批 − 本次失败），并从失败集合中清除
        batchSet.forEach(function (ts) {
            if (!nowFailedSet.has(ts)) {
                if (S._pushFailedTsIds.delete(ts)) clearedCount++;
                S._pushFailedReasons.delete(ts);
                if (S._pushFailedTime) S._pushFailedTime.delete(ts);
            }
        });
    }
    // 兼容：若扩展端额外回传 successTsIds（明确成功列表），同样清除其失败标记，
    // 兜底"本批缓存丢失"或"本批 ts 与扩展端口径不一致"等异常情形
    var succArr = Array.isArray(p.successTsIds) ? p.successTsIds : [];
    succArr.forEach(function (t) {
        if (t === undefined || t === null || t === '') return;
        var k = String(t);
        if (S._pushFailedTsIds.delete(k)) clearedCount++;
        S._pushFailedReasons.delete(k);
        if (S._pushFailedTime) S._pushFailedTime.delete(k);
    });

    // 写入/更新本次失败 tsId 与原因，并打上当前时间戳供后续渲染按时间优先级比较
    var _failNow = Date.now();
    failures.forEach(function (f) {
        if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
            var key = String(f.tsId);
            S._pushFailedTsIds.add(key);
            if (f.reason) S._pushFailedReasons.set(key, String(f.reason));
            else S._pushFailedReasons.delete(key); // 无原因则清掉旧原因，避免误导
            if (S._pushFailedTime) S._pushFailedTime.set(key, _failNow);
        }
    });

    if (typeof dbg === 'function') {
        dbg('📨 pushResult merge: batch=' + (batchSet ? batchSet.size : 'null')
            + ' nowFailed=' + nowFailedSet.size
            + ' cleared=' + clearedCount
            + ' totalFailedAfter=' + S._pushFailedTsIds.size
            + ' failedOnly=' + !!S._failedOnly);
    }

    // 一次推送结果消费完毕，清空本批缓存
    S._lastPushBatchTsIds = null;

    // 清除本批推送行的 S.mods 修改高亮（推送完成 = 修改已提交）
    // 失败行由 S._pushFailedTsIds 提供红色高亮，不再需要黄色 modified 标记
    // 兜底 1：_lastPushBatchRowIndices（pushChanges / pushFromContextMenu 缓存）
    var pushRowIndices = S._lastPushBatchRowIndices;
    // 兜底 2：若行索引缺失，从 _lastPushBatchTsIds 反推
    if ((!pushRowIndices || pushRowIndices.length === 0) && batchSet && batchSet.size > 0) {
        var tsColFallback = (S.data && S.data.headers ? S.data.headers.indexOf('testcase_id') : -1);
        if (tsColFallback >= 0) {
            pushRowIndices = [];
            for (var ri2 = 0; ri2 < (S.data.rows && S.data.rows.length || 0); ri2++) {
                var tid2 = (S.data.rows[ri2] || [])[tsColFallback];
                if (tid2 !== undefined && tid2 !== null && tid2 !== '' && batchSet.has(String(tid2))) {
                    pushRowIndices.push(ri2);
                }
            }
        }
    }
    // 兜底 3：若仍无行索引，从 failures 中的 rowIndex（1-based）转换
    if (!pushRowIndices || pushRowIndices.length === 0) {
        pushRowIndices = [];
        failures.forEach(function (f) {
            if (f && f.rowIndex != null && f.rowIndex > 0) {
                pushRowIndices.push(f.rowIndex - 1);
            }
        });
        // 去重
        var uniq = {};
        pushRowIndices = pushRowIndices.filter(function (v) {
            var s = String(v);
            if (uniq[s]) return false;
            uniq[s] = true;
            return true;
        });
    }
    // 兜底 4：若仍无行索引，用失败项 tsId 逐行匹配 testcase_id 列
    if ((!pushRowIndices || pushRowIndices.length === 0) && failures.length > 0) {
        var tsCol4 = S.data && S.data.headers ? S.data.headers.indexOf('testcase_id') : -1;
        if (tsCol4 >= 0) {
            var failedTsSet = {};
            failures.forEach(function (f) {
                if (f && f.tsId != null && f.tsId !== '') failedTsSet[String(f.tsId)] = true;
            });
            if (Object.keys(failedTsSet).length > 0) {
                pushRowIndices = [];
                for (var ri4 = 0; ri4 < (S.data.rows && S.data.rows.length || 0); ri4++) {
                    var tid4 = String((S.data.rows[ri4] || [])[tsCol4] ?? '');
                    if (tid4 && failedTsSet[tid4]) pushRowIndices.push(ri4);
                }
            }
        }
    }
    if (pushRowIndices && pushRowIndices.length > 0) {
        var modsToDelete = [];
        S.mods.forEach(function (key) {
            var commaIdx = key.indexOf(',');
            if (commaIdx > -1 && pushRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                modsToDelete.push(key);
            }
        });
        modsToDelete.forEach(function (k) { S.mods.delete(k); });
        // 同步清除 _detailModCellKeys 中对应批次行的条目，否则明细弹窗修改的高亮仍会残留
        if (S._detailModCellKeys && S._detailModCellKeys.size > 0) {
            var detailToDelete = [];
            S._detailModCellKeys.forEach(function (key) {
                var commaIdx = key.indexOf(',');
                if (commaIdx > -1 && pushRowIndices.indexOf(parseInt(key.substring(0, commaIdx), 10)) !== -1) {
                    detailToDelete.push(key);
                }
            });
            detailToDelete.forEach(function (k) { S._detailModCellKeys.delete(k); });
        }
        // 清除已推送行的新增高亮（推送成功后不再是"新增行"）
        if (S._addedRowSet && S._addedRowSet.size > 0) {
            pushRowIndices.forEach(function (ri) { S._addedRowSet.delete(ri); });
        }
        S._lastPushBatchRowIndices = null;
    }

    // 推送后回写的 testCaseNo 单元格高亮信息（同时清除旧高亮，确保弹窗显示最新结果）
    if (p.highlightedCells && p.highlightedCells.colIdx != null && Array.isArray(p.highlightedCells.rowIndices)) {
        var hl = {
            colIdx: p.highlightedCells.colIdx,
            rowSet: new Set(p.highlightedCells.rowIndices)
        };
        if (p.highlightedCells.cells && Array.isArray(p.highlightedCells.cells)) {
            hl.cells = new Set(p.highlightedCells.cells);
        }
        S._highlightedCells = hl;
    } else if ('highlightedCells' in p) {
        // 扩展端明确传了空的 highlightedCells，表示无高亮
        S._highlightedCells = null;
    }

    try { renderTable(); } catch (_) { /* ignore */ }

    // 缓存全量明细文本，便于复制
    S._pushResultDetailText = failures.map(function (f, i) {
        var rowPart = (f.rowIndex != null && f.rowIndex > 0) ? ('第 ' + f.rowIndex + ' 行') : ('testcase_id ' + (f.tsId || '(无)'));
        return (i + 1) + '. ' + rowPart + '：' + (f.reason || '');
    }).join('\n');

    bindPushResultModal();
    modal.classList.add('show');
}

function closePushResultModal() {
    var modal = document.getElementById('pushResultModal');
    if (modal) modal.classList.remove('show');
    // 弹窗关闭后请求扩展端重新推送最新高亮结果（含服务器回写的 testCaseNo 等字段）
    if (S.vscode) {
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
        if (!text) { showToast('无失败明细可复制', 'error'); return; }
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { showToast('失败明细已复制', 'success'); },
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
        showToast('失败明细已复制', 'success');
    } catch (_) {
        showToast('复制失败', 'error');
    }
}

// 关闭推送结果弹窗后，按"显示行号"（用户视觉上从 1 开始的物理行号）滚动并高亮主表
function jumpToRowByDisplayIndex(rowIndex) {
    closePushResultModal();
    var r = rowIndex - 1; // 转成 0-based 索引
    if (r < 0 || r >= (S.data && S.data.rows ? S.data.rows.length : 0)) {
        showToast('该行已不在当前表格中（可能已被筛选或删除）', 'error');
        return;
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
        if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
}

