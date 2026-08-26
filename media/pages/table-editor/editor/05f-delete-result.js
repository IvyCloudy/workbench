/* =============================================================================
 * 05b-delete-result.js  —— 删除结果弹窗（与推送结果弹窗同款样式）
 * -----------------------------------------------------------------------------
 * 独立于 05a-push-result.js：只负责弹窗显示 + 行号联动跳转 + 复制失败明细，
 * 不修改任何推送相关状态（_pushFailedTsIds / _lastPushBatchTsIds / mods 高亮等），
 * 避免"删除结果弹窗"污染推送流程状态。
 *
 * 消息契约（扩展端 → webview）：
 *   { type: 'deleteResult',
 *     fileName: string,
 *     successCount: number,
 *     failures: [{ rowIndex?, tsId, reason }],
 *     total: number,
 *     error?: string,           // 流程级错误（如"接口不可达"），有此字段时按纯错误分支渲染
 *     deletedSuccess?: number,        // type=1 线上真实删除成功数
 *     deletedSourceMissing?: number } // type=3 sourceId 不存在、仍算删除成功数
 * ========================================================================== */

var __DR_MAX_INLINE = 200; // 列表最多渲染条数，超出折叠

function showDeleteResultModal(payload) {
    var modal = document.getElementById('deleteResultModal');
    if (!modal) return;
    var p = payload || {};
    var fileName = p.fileName || '';
    var errorMsg = p.error || '';
    var successCount = p.successCount || 0;
    var failures = Array.isArray(p.failures) ? p.failures : [];
    var total = (p.total != null) ? p.total : (successCount + failures.length);
    // type 分档：deletedSuccess=type=1（线上真实删除），deletedSourceMissing=type=3（线上不存在，仍算成功）
    var deletedSuccess = (p.deletedSuccess != null) ? Number(p.deletedSuccess) : successCount;
    var deletedSourceMissing = (p.deletedSourceMissing != null) ? Number(p.deletedSourceMissing) : 0;

    var header = document.getElementById('deleteResultHeader');
    var iconEl = document.getElementById('deleteResultIcon');
    var titleEl = document.getElementById('deleteResultTitle');
    var summaryEl = document.getElementById('deleteResultSummary');
    var listEl = document.getElementById('deleteResultList');
    var hintEl = document.getElementById('deleteResultHint');
    var copyBtn = document.getElementById('deleteResultCopyBtn');

    // 纯错误消息分支
    if (errorMsg) {
        if (header) header.className = 'xs-modal-header xs-pr-header is-error';
        if (iconEl) iconEl.textContent = '✕';
        if (titleEl) titleEl.textContent = '删除失败' + (fileName ? ('：' + fileName) : '');
        if (summaryEl) summaryEl.innerHTML = '';
        if (listEl) listEl.innerHTML = '<div class="xs-pr-empty">' + escapeHtml(errorMsg) + '</div>';
        if (hintEl) hintEl.textContent = '';
        if (copyBtn) copyBtn.style.display = 'none';
        bindDeleteResultModal();
        modal.classList.add('show');
        return;
    }

    var allFailed = (failures.length > 0 && successCount === 0);
    var allSuccess = (failures.length === 0);
    var status = allSuccess ? 'success' : (allFailed ? 'error' : 'warning');

    if (header) header.className = 'xs-modal-header xs-pr-header is-' + status;
    if (iconEl) iconEl.textContent = (status === 'success') ? '✓' : (status === 'error' ? '✕' : '!');
    if (titleEl) {
        var titleText = (status === 'success') ? '删除成功' : (status === 'error' ? '删除失败' : '删除部分成功');
        titleEl.textContent = titleText + (fileName ? ('：' + fileName) : '');
    }

    // 概要：总计 / 成功（真实删除）/ 线上不存在（仍算成功）/ 失败
    //   - deletedSuccess：type=1 线上真实删除成功
    //   - deletedSourceMissing：type=3 sourceId 不存在，但本地同样清理，仍计入成功总数
    //   - 不变量：deletedSuccess + deletedSourceMissing === successCount
    if (summaryEl) {
        var summaryHtml =
            '<span class="xs-pr-summary-item">总计 <span class="xs-pr-num">' + total + '</span></span>' +
            '<span class="xs-pr-summary-item">删除成功 <span class="xs-pr-num is-success">' + successCount + '</span></span>';
        if (deletedSourceMissing > 0) {
            // 当有"线上不存在"时，把成功拆成两档，便于用户区分"真删"与"本就无"
            summaryHtml =
                '<span class="xs-pr-summary-item">总计 <span class="xs-pr-num">' + total + '</span></span>' +
                '<span class="xs-pr-summary-item">成功(线上删除) <span class="xs-pr-num is-success">' + deletedSuccess + '</span></span>' +
                '<span class="xs-pr-summary-item">线上不存在 <span class="xs-pr-num is-missing">' + deletedSourceMissing + '</span></span>';
        }
        summaryHtml += '<span class="xs-pr-summary-item">失败 <span class="xs-pr-num is-failed">' + failures.length + '</span></span>';
        summaryEl.innerHTML = summaryHtml;
    }

    // 失败明细列表
    if (listEl) {
        if (failures.length === 0) {
            // 纯成功：若含"线上不存在"分档，文案显式区分
            if (deletedSourceMissing > 0) {
                listEl.innerHTML = '<div class="xs-pr-empty">共 ' + successCount + ' 条删除成功 🎉'
                    + '（其中 ' + deletedSuccess + ' 条线上真实删除，'
                    + deletedSourceMissing + ' 条线上本不存在已同步清理）</div>';
            } else {
                listEl.innerHTML = '<div class="xs-pr-empty">全部 ' + successCount + ' 条案例删除成功 🎉</div>';
            }
        } else {
            var renderCount = Math.min(failures.length, __DR_MAX_INLINE);
            var html = '';
            for (var i = 0; i < renderCount; i++) {
                var f = failures[i] || {};
                var hasRow = (f.rowIndex != null && f.rowIndex > 0);
                var hasTsId = !hasRow && !!f.tsId; // 无 rowIndex 但有 tsId 时，仍支持按 tsId 反查跳转
                var rowText = hasRow
                    ? ('第 ' + f.rowIndex + ' 行')
                    : (f.tsId ? String(f.tsId) : '(未知行)');
                var rowCls = 'xs-pr-row' + (hasRow || hasTsId ? ' is-link' : '');
                var rowAttr = '';
                if (hasRow) {
                    rowAttr = ' data-row="' + f.rowIndex + '" title="点击定位到该行"';
                } else if (hasTsId) {
                    rowAttr = ' data-tsid="' + escapeHtml(String(f.tsId)) + '" title="点击定位到该行"';
                }
                html += '<div class="xs-pr-item">'
                    +    '<span class="xs-pr-seq">' + (i + 1) + '.</span>'
                    +    '<span class="' + rowCls + '"' + rowAttr + '>' + escapeHtml(rowText) + '</span>'
                    +    '<span class="xs-pr-reason">' + escapeHtml(String(f.reason || '')) + '</span>'
                    + '</div>';
            }
            if (failures.length > __DR_MAX_INLINE) {
                html += '<div class="xs-pr-truncated">…另有 ' + (failures.length - __DR_MAX_INLINE) + ' 条失败未展示，请点击「复制失败明细」获取完整列表。</div>';
            }
            listEl.innerHTML = html;

            // 行号/testcase_id 点击 → 滚动定位（复用 05a 的 jumpToRowByDisplayIndex）
            var links = listEl.querySelectorAll('.xs-pr-row.is-link');
            for (var k = 0; k < links.length; k++) {
                links[k].addEventListener('click', function (ev) {
                    var el = ev.currentTarget;
                    var rn = parseInt(el.getAttribute('data-row'), 10);
                    if (!isNaN(rn) && rn > 0) {
                        _closeDeleteResultModal();
                        if (typeof jumpToRowByDisplayIndex === 'function') {
                            jumpToRowByDisplayIndex(rn);
                        }
                        return;
                    }
                    // 通过 tsId 反查 rowIndex（1-based）后再走同一跳转函数
                    var tsId = el.getAttribute('data-tsid') || '';
                    if (tsId) {
                        var rowIdx = _findRowIndexByTsId(tsId);
                        if (rowIdx > 0) {
                            _closeDeleteResultModal();
                            if (typeof jumpToRowByDisplayIndex === 'function') {
                                jumpToRowByDisplayIndex(rowIdx);
                            }
                        } else if (typeof showToast === 'function') {
                            showToast('该行已不在当前表格中（可能已被删除）', 'error');
                        }
                    }
                });
            }
        }
    }

    if (hintEl) hintEl.textContent = (failures.length > 0) ? '点击行号可定位到表格对应行；失败行仍保留在表格中（置灰+划线+失败原因）' : '';
    if (copyBtn) copyBtn.style.display = (failures.length > 0) ? '' : 'none';

    // 缓存全量明细文本，便于复制
    S._deleteResultDetailText = failures.map(function (f, i) {
        var rowPart = (f.rowIndex != null && f.rowIndex > 0) ? ('第 ' + f.rowIndex + ' 行') : (f.tsId ? String(f.tsId) : '(未知行)');
        return (i + 1) + '. ' + rowPart + '：' + (f.reason || '');
    }).join('\n');

    bindDeleteResultModal();
    modal.classList.add('show');
}

function _closeDeleteResultModal() {
    var modal = document.getElementById('deleteResultModal');
    if (modal) modal.classList.remove('show');
}

function bindDeleteResultModal() {
    if (S._deleteResultBound) return;
    S._deleteResultBound = true;
    var close = document.getElementById('deleteResultClose');
    var ok = document.getElementById('deleteResultOkBtn');
    var copy = document.getElementById('deleteResultCopyBtn');
    if (close) close.addEventListener('click', _closeDeleteResultModal);
    if (ok) ok.addEventListener('click', _closeDeleteResultModal);
    if (copy) copy.addEventListener('click', function () {
        var text = S._deleteResultDetailText || '';
        if (!text) { if (typeof showToast === 'function') showToast('无失败明细可复制', 'error'); return; }
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () { if (typeof showToast === 'function') showToast('失败明细已复制', 'success'); },
                function () { _drFallbackCopy(text); }
            );
        } else {
            _drFallbackCopy(text);
        }
    });
    // ESC 关闭
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
            var m = document.getElementById('deleteResultModal');
            if (m && m.classList.contains('show')) {
                ev.preventDefault();
                _closeDeleteResultModal();
            }
        }
    });
}

function _drFallbackCopy(text) {
    try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (typeof showToast === 'function') showToast('失败明细已复制', 'success');
    } catch (_) {
        if (typeof showToast === 'function') showToast('复制失败', 'error');
    }
}

/**
 * 通过 testcase_id 反查其在当前表格中的显示行号（1-based，与 jumpToRowByDisplayIndex 契约一致）。
 * 未找到返回 -1。
 */
function _findRowIndexByTsId(tsId) {
    try {
        if (!tsId || !S || !S.data) return -1;
        var headers = S.data.headers || [];
        var rows = S.data.rows || [];
        var tsIdIdx = headers.indexOf('testcase_id');
        if (tsIdIdx < 0) return -1;
        var target = String(tsId);
        for (var i = 0; i < rows.length; i++) {
            var v = rows[i] ? rows[i][tsIdIdx] : null;
            if (v != null && String(v) === target) return i + 1; // 转 1-based
        }
    } catch (_) { /* ignore */ }
    return -1;
}
