/**
 * ============================================================================
 *  00b-highlight-model-write.js —— HighlightModel · 写路径（setters + reset）
 * ----------------------------------------------------------------------------
 *  由 00-highlight-util.js 拆分而来（2026-09-19，方案 C · C6）。
 *
 *  承担范围：
 *    · 写路径基础：setHighlightedCells / setAddedRows / addAddedRow / shiftRowIndex
 *    · 5 种重置策略：resetForReload / resetForFullPush / resetAllHighlights /
 *                    resetOnColumnChange / clearByPushBatch
 *
 *  加载顺序：必须在 00a 之后、00c 之前。
 *  依赖：window.HighlightModel 已由 00a 初始化，本文件通过 Object.assign 追加成员。
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * 设置推送更新高亮（成功推送 / 保存 diff 后由扩展端下发）
     */
    function setHighlightedCells(S, hl) {
        if (hl) {
            S._highlightedCells = hl;
            // ⚠ 必须同步刷新 _highlightedTime，否则后续 render 时新推送的高亮会被历史修改时间
            //   (_modsTime > _highlightedTime) 判为"陈旧的推送"→ 放弃 pushUpdCls
            S._highlightedTime = Date.now();
        } else {
            S._highlightedCells = null;
            S._highlightedTime = 0;
        }
    }

    /**
     * 设置新增行集合（成功推送后由扩展端下发）
     */
    function setAddedRows(S, rowIndices) {
        if (!S._addedRowSet) S._addedRowSet = new Set();
        S._addedRowSet.clear();
        S._addedRowTime = Date.now();
        if (Array.isArray(rowIndices) && rowIndices.length > 0) {
            for (var i = 0; i < rowIndices.length; i++) S._addedRowSet.add(rowIndices[i]);
        }
    }

    /**
     * 追加一个新增行索引（用于插入/复制行）
     */
    function addAddedRow(S, rowIdx) {
        if (!S._addedRowSet) S._addedRowSet = new Set();
        S._addedRowSet.add(rowIdx);
        S._addedRowTime = Date.now();
    }

    /**
     * 统一处理"行索引依赖的高亮/修改集合"随行操作的移位。
     * 从 03d-row-ops.js 抽取，并合并原本散落在插入/删除函数中的 _addedRowSet 偏移。
     *
     * 覆盖集合（key 中含行索引）：
     *   - S.mods                (Set, key='row,col')
     *   - S._modsTime           (Object, key='row,col')
     *   - S._detailModCellKeys  (Set, key='row,col')
     *   - S._highlightedCells.cells   (Set, key='row:col')
     *   - S._highlightedCells.rowSet  (Set, key=row)
     *   - S._addedRowSet        (Set, key=row)  ← P5 新增
     */
    function shiftRowIndex(S, op, at) {
        function _shiftKey(key, sep, shiftFn) {
            var p = key.indexOf(sep);
            if (p < 0) return null;
            var r = parseInt(key.substring(0, p), 10);
            if (isNaN(r)) return null;
            var nr = shiftFn(r);
            if (nr < 0) return null; // -1 表示丢弃（被删行本身）
            return nr + sep + key.substring(p + 1);
        }
        function _reshapeSet(setRef, sep, shiftFn) {
            if (!setRef || !setRef.size) return;
            var next = new Set();
            setRef.forEach(function (k) {
                var nk = _shiftKey(k, sep, shiftFn);
                if (nk !== null) next.add(nk);
            });
            setRef.clear();
            next.forEach(function (k) { setRef.add(k); });
        }
        function _reshapeObj(objRef, sep, shiftFn) {
            if (!objRef) return;
            var keys = Object.keys(objRef);
            if (!keys.length) return;
            var next = {};
            keys.forEach(function (k) {
                var nk = _shiftKey(k, sep, shiftFn);
                if (nk !== null) next[nk] = objRef[k];
            });
            // 原地清空后回填，避免调用方持有旧引用失效
            keys.forEach(function (k) { delete objRef[k]; });
            Object.keys(next).forEach(function (k) { objRef[k] = next[k]; });
        }
        function _reshapeRowSet(setRef, shiftFn) {
            if (!setRef || !setRef.size) return;
            var next = new Set();
            setRef.forEach(function (r) {
                var nr = shiftFn(r);
                if (nr >= 0) next.add(nr);
            });
            setRef.clear();
            next.forEach(function (r) { setRef.add(r); });
        }

        var shiftFn;
        if (op === 'insert') {
            var atI = at;
            shiftFn = function (r) { return r >= atI ? r + 1 : r; };
        } else if (op === 'delete') {
            var atD = at;
            shiftFn = function (r) { if (r === atD) return -1; return r > atD ? r - 1 : r; };
        } else if (op === 'deleteBatch') {
            // at 为降序数组（例如 [5,3,1]）；转成升序做 <=r 计数
            var sortedAsc = at.slice().sort(function (a, b) { return a - b; });
            shiftFn = function (r) {
                if (sortedAsc.indexOf(r) >= 0) return -1;
                var s = 0;
                for (var i = 0; i < sortedAsc.length; i++) { if (sortedAsc[i] < r) s++; }
                return r - s;
            };
        } else {
            return;
        }

        // key='row,col' 的集合
        _reshapeSet(S.mods, ',', shiftFn);
        _reshapeSet(S._detailModCellKeys, ',', shiftFn);
        _reshapeObj(S._modsTime, ',', shiftFn);
        // _highlightedCells 若不存在则直接跳过
        if (S._highlightedCells) {
            _reshapeSet(S._highlightedCells.cells, ':', shiftFn);
            _reshapeRowSet(S._highlightedCells.rowSet, shiftFn);
        }
        // _addedRowSet：P5 合入统一偏移，原本散落在 insertRow/deleteRow/deleteSelectedRows/
        // copyRowInline/copySelectedRows 里手写的偏移逻辑全部退休
        if (S._addedRowSet) {
            _reshapeRowSet(S._addedRowSet, shiftFn);
        }
    }

    /**
     * 「用户点刷新按钮 / 主动 reload from webview」场景下的状态重置策略（唯一真源）。
     * 详细语义见拆分前的 00-highlight-util.js（此处注释省略以保持文件精简）。
     */
    function resetForReload(S, opts) {
        // 目前只需清撤销栈；未来新增字段决策也集中放到这里
        if (opts && typeof opts.clearHistory === 'function') {
            opts.clearHistory();
        }
        // 显式列出"保留"字段，防止后来者误加清空：
        //   S.mods                — 保留
        //   S._detailModCellKeys  — 保留
        //   S._modsTime           — 保留
        //   S._highlightedCells   — 保留（扩展端 diff 会覆盖）
        //   S._highlightedTime    — 保留
        //   S._addedRowSet        — 保留（扩展端 diff 会覆盖）
        //   S._addedRowTime       — 保留
        //   S._pushFailedTsIds    — 保留（由 pushResult 精确管理）
    }

    /**
     * 「整文件一次性推送」场景下的强清策略（唯一真源）。
     * 与 resetForReload 的区别：
     *   · resetForReload = 用户主动 refresh，保留 mods 让高亮延续
     *   · resetForFullPush = 后端说"整文件都推走了"，前端把 mods 全清
     */
    function resetForFullPush(S) {
        if (S.mods && S.mods.size > 0) S.mods.clear();
        if (S._detailModCellKeys && S._detailModCellKeys.size > 0) S._detailModCellKeys.clear();
        if (Array.isArray(S._history)) S._history.length = 0;
        if (Array.isArray(S._future)) S._future.length = 0;
        if (S._lastPushBatchTsIds instanceof Set) S._lastPushBatchTsIds.clear();
        S._lastPushBatchRowIndices = null;
        if (S._addedRowSet && S._addedRowSet.size > 0) S._addedRowSet.clear();
        S._addedInfos = [];
    }

    /**
     * 「统一失效 _userMarks 的缓存索引」——本文件与 00c 各自持一份（15 行代码），
     * 避免跨文件闭包依赖。逻辑必须与 00c 中的 _invalidateUserMarksCache 严格一致。
     */
    function _invalidateUserMarksCache(S) {
        if (!S._userMarks) return;
        S._userMarks.cellMap = null;
        S._userMarks.rowMap = null;
        S._userMarks.rowSet = null;
        S._userMarks.cellTime = null;
        S._userMarks.rowTime = null;
    }

    /**
     * 「clearAllHighlights 消息」场景下的全清策略（唯一真源）。
     * 详见拆分前 00-highlight-util.js 中的详尽注释。
     */
    function resetAllHighlights(S) {
        setHighlightedCells(S, null);
        S._pushFailedTsIds = new Set();
        S._pushFailedReasons = new Map();
        S._pushFailedTime = new Map();
        S._pushFailedSeverity = new Map();
        S._pushFailedFields = new Map();
        S._pushFailedFieldSeverity = new Map();
        S._pushFailedFieldCells = new Map();
        // 与 _lastPushBatchTsIds 成对清空，避免 pushDone/pushResult/pushError 兜底
        // 逻辑读到过期批次行号，误清与本次无关的 mods/detailMods/addedRowSet。
        S._lastPushBatchTsIds = new Set();
        S._lastPushBatchRowIndices = null;
        S._addedRowSet = new Set();
        S._addedInfos = [];
        S._deletedInfos = [];
        if (S._userMarks) {
            S._userMarks.rects = [];
            // 缓存索引失效收敛到 _invalidateUserMarksCache（P7）
            _invalidateUserMarksCache(S);
        }
        if (S._detailModCellKeys) S._detailModCellKeys.clear();
    }

    /**
     * 「列结构变化」场景下的重置策略（唯一真源）。
     * 触发条件：01-core.js 的 full-data 处理中检测到 `_lastHeadSig` 变化。
     */
    function resetOnColumnChange(S) {
        S._pushFailedTsIds = new Set();
        S._pushFailedReasons = new Map();
        S._pushFailedTime = new Map();
        S._pushFailedSeverity = new Map();
        S._pushFailedFields = new Map();
        S._pushFailedFieldSeverity = new Map();
        S._pushFailedFieldCells = new Map();
        S._lastPushBatchTsIds = new Set();
        S._failedOnly = false;
        S._modifiedOnly = false;
        setHighlightedCells(S, null);
    }

    /**
     * 「推送批次结束后按行号精确清理修改/新增高亮」——P6 抽取自 05a-push-result.js。
     *
     * 触发时机：
     *   1. showPushResultModal 处理正常结果（部分成功 / 全部失败）时；
     *   2. showPushResultModal 处理"前置校验失败纯错误消息"时。
     *
     * 语义边界：
     *   ✔ 本门面负责：按行号清 S.mods / S._detailModCellKeys / S._addedRowSet，
     *      并清空批次缓存 S._lastPushBatchTsIds / _lastPushBatchRowIndices。
     *   ✘ 本门面不负责：
     *      · S._pushFailedTsIds / _pushFailedReasons / _pushFailedTime 的合并
     *      · S._highlightedCells 的下发消费
     *      · "从哪几个渠道兜底反查行号"——由 05a 组装最终 rowIndices 后传入。
     */
    function clearByPushBatch(S, opts) {
        var o = opts || {};
        var rowIndices = o.rowIndices;
        var clearBatchTsIds = (o.clearBatchTsIds !== false);

        if (rowIndices && rowIndices.length > 0) {
            // 构建行号索引表，O(1) 判定
            var rowSetLookup = {};
            for (var i = 0; i < rowIndices.length; i++) rowSetLookup[rowIndices[i]] = true;

            // 1) 清 S.mods 中命中本批行的坐标
            if (S.mods && S.mods.size > 0) {
                var modsToDelete = [];
                S.mods.forEach(function (key) {
                    var commaIdx = key.indexOf(',');
                    if (commaIdx > -1 && rowSetLookup[parseInt(key.substring(0, commaIdx), 10)]) {
                        modsToDelete.push(key);
                    }
                });
                for (var m = 0; m < modsToDelete.length; m++) S.mods.delete(modsToDelete[m]);
            }

            // 2) 清 _detailModCellKeys 中命中本批行的坐标（明细弹窗修改标记）
            if (S._detailModCellKeys && S._detailModCellKeys.size > 0) {
                var detailToDelete = [];
                S._detailModCellKeys.forEach(function (key) {
                    var commaIdx = key.indexOf(',');
                    if (commaIdx > -1 && rowSetLookup[parseInt(key.substring(0, commaIdx), 10)]) {
                        detailToDelete.push(key);
                    }
                });
                for (var d = 0; d < detailToDelete.length; d++) S._detailModCellKeys.delete(detailToDelete[d]);
            }

            // 3) 清 _addedRowSet 中命中本批行（推送成功后不再是"新增行"）
            if (S._addedRowSet && S._addedRowSet.size > 0) {
                for (var k = 0; k < rowIndices.length; k++) S._addedRowSet.delete(rowIndices[k]);
            }

            // 4) 清 _modsTime 中命中本批行的坐标（Bug 3 修复，2026-07-26）
            //    历史上此处仅清 S.mods 未同步清 _modsTime → 遗留的时间戳在 resolveHighlight
            //    分支 4 触发 "ctx.modTime > rowFailTime" 判定 → 单元格被打上
            //    xs-td-overrides-fail 并保留 modified 类 → 命中 CSS
            //    tr.xs-tr-push-failed td.xs-td-overrides-fail.modified 淡黄底覆盖规则，
            //    使推送失败行呈现"错乱的黄底"而非应有的失败淡红底。
            if (S._modsTime) {
                var mtToDelete = [];
                for (var mtKey in S._modsTime) {
                    if (Object.prototype.hasOwnProperty.call(S._modsTime, mtKey)) {
                        var mtComma = mtKey.indexOf(',');
                        if (mtComma > -1 && rowSetLookup[parseInt(mtKey.substring(0, mtComma), 10)]) {
                            mtToDelete.push(mtKey);
                        }
                    }
                }
                for (var mti = 0; mti < mtToDelete.length; mti++) delete S._modsTime[mtToDelete[mti]];
            }

            // 5) 清行级批次缓存
            S._lastPushBatchRowIndices = null;
        }

        // 6) 清 tsId 批次缓存（默认清，调用方可显式关闭以延迟到后续阶段）
        if (clearBatchTsIds) {
            S._lastPushBatchTsIds = null;
        }
    }

    // 追加成员（Object.assign 保留 00a 已挂载的字段码查询接口）
    Object.assign(window.HighlightModel, {
        setHighlightedCells: setHighlightedCells,
        setAddedRows: setAddedRows,
        addAddedRow: addAddedRow,
        shiftRowIndex: shiftRowIndex,
        resetForReload: resetForReload,
        resetForFullPush: resetForFullPush,
        resetAllHighlights: resetAllHighlights,
        resetOnColumnChange: resetOnColumnChange,
        clearByPushBatch: clearByPushBatch,
    });
})();
