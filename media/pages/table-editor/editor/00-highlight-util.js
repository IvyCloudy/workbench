/**
 * ============================================================================
 *  00-highlight-util.js
 *  高亮相关的公共纯函数集合（P1 + P3 抽取，与 docs/specs/高亮逻辑说明.md 对齐）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. parseHighlightedCells(raw)：把扩展端下发的 highlightedCells payload
 *       统一转成前端内存态 { colIdx, rowSet, cells } | null。
 *       原本在 01-core.js（2 处）与 05a-push-result.js（1 处）几乎相同的
 *       构造代码全部收敛到这里。
 *    2. resolveHighlight(ctx)：给定 (ri, ci, S 中的高亮字段快照)，返回
 *       该单元格最终应有的高亮 { bestClass, bestMkInfo, failOverridden,
 *       clearModified }。
 *       原本在 02a-render.js 中 _buildRowHtml / updateCellHighlight 两处
 *       重复 60 行的时间戳竞争逻辑全部改调此函数，保证行为始终一致。
 *  依赖：
 *    · 大多数函数为纯函数（parseHighlightedCells / resolveHighlight 等），
 *      少数带副作用（setHighlightedCells 读 Date.now() 并写入 S；clearByPushBatch
 *      直接改写 S.mods 等集合）—— 副作用范围限定在传入的 S 内，不触碰 DOM 也不
 *      读取全局 S，方便测试与替换。
 *    · 加载顺序：位于所有其他 editor/*.js 之前，通过 window.HighlightUtil 暴露。
 *  修改约束：
 *    · resolveHighlight 的分支顺序 / 时间戳竞争规则必须与
 *      docs/specs/高亮逻辑说明.md 第 2 节保持一致，任何调整都要同步文档。
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * 统一解析 highlightedCells payload（来自扩展端消息 m/p.highlightedCells）
     * @param {any} raw   扩展端 payload，形如 { colIdx, rowIndices, cells?:[[r,c],...] }
     * @returns {{colIdx:number, rowSet:Set<number>, cells:Set<string>|null}|null}
     *          有效 payload 返回内存态；无效 / 空 payload 返回 null（由调用方决定是否清 _highlightedTime）
     *
     * ⚠ 格式契约：扩展端 payload.cells 是 Array<[row, col]>；
     *   消费方（02a-render.js / _getModifiedRowSet）统一读的是 "row:col" 字符串。
     *   本函数负责序列化，避免历史 bug：Set.has('row:col') 永远为 false。
     */
    function parseHighlightedCells(raw) {
        if (!raw || raw.colIdx == null || !Array.isArray(raw.rowIndices)) {
            return null;
        }
        var hl = {
            colIdx: raw.colIdx,
            rowSet: new Set(raw.rowIndices),
            cells: null
        };
        if (raw.cells && Array.isArray(raw.cells)) {
            hl.cells = new Set();
            for (var i = 0; i < raw.cells.length; i++) {
                var c = raw.cells[i];
                if (Array.isArray(c) && c.length >= 2) {
                    hl.cells.add(c[0] + ':' + c[1]);
                }
            }
        }
        return hl;
    }

    /**
     * 统一的时间戳竞争决策（唯一真源）
     *
     * @param {Object} ctx  上下文，所有字段调用方从 S 组装：
     *   {
     *     ri, ci,                        // 目标坐标
     *     modTime,                       // 该 cell 的修改时间（S._modsTime[ri+','+ci]），无为 0
     *     highlightedCells,              // S._highlightedCells（Set 版）
     *     highlightedTime,               // S._highlightedTime
     *     addedRowSet,                   // S._addedRowSet
     *     addedRowTime,                  // S._addedRowTime
     *     userMarkInfo,                  // isUserMarked(ri,ci) 的返回，{ bgColor, fontColor, timestamp } | null
     *     rowFailTime,                   // 已按 tsId 解析出的失败时间；命中但缺时间时兜底为 1；未命中为 0
     *   }
     * @returns {{
     *     bestClass: string,             // 不带前导空格。空串表示无颜色类
     *     bestMkInfo: Object|null,       // 命中 user-marked 时返回其 { bgColor, fontColor }
     *     failOverridden: boolean,       // 需要挂 xs-td-overrides-fail
     *     clearModified: boolean,        // 需要清除 modified 类（新增行胜出或失败完全胜出时）
     * }}
     */
    function resolveHighlight(ctx) {
        var bestTime = 0;
        var bestClass = '';
        var bestMkInfo = null;
        var clearModified = false;
        var failOverridden = false;

        // 1) 推送变更高亮（行级橙 + 单元格级黄）
        //    同一次推送内，单元格级（黄）优先于行级（橙），保留"内层套外层"语义
        //    若该 cell 的修改时间晚于推送时间（推送后又改了），则放弃 pushUpdCls，
        //    让 modified 黄底独立显示，直观提示"改动已产生但尚未再次推送"
        var pushUpdCls = '';
        var hl = ctx.highlightedCells;
        if (hl) {
            if (hl.cells && hl.cells.has(ctx.ri + ':' + ctx.ci)) {
                pushUpdCls = 'xs-td-push-updated';
            } else if (hl.rowSet && hl.rowSet.has(ctx.ri)
                && (hl.colIdx === -1 || hl.colIdx === ctx.ci)) {
                pushUpdCls = 'xs-td-push-updated-row';
            }
        }
        if (pushUpdCls) {
            var t1 = ctx.highlightedTime || 0;
            // 修改时间胜出：跳过 pushUpdCls，保留 modified 独立生效
            if (ctx.modTime > t1) {
                pushUpdCls = '';
            } else if (t1 >= bestTime) {
                bestTime = t1;
                bestClass = pushUpdCls;
                bestMkInfo = null;
            }
        }

        // 2) 新增行高亮
        if (ctx.addedRowSet && ctx.addedRowSet.has(ctx.ri)) {
            var t2 = ctx.addedRowTime || 0;
            if (t2 >= bestTime) {
                bestTime = t2;
                bestClass = 'xs-td-push-added';
                bestMkInfo = null;
                // 新增行胜出：清除 modified（避免绿底上叠加黄底）
                clearModified = true;
            }
        }

        // 3) 用户手动标记高亮
        var mkInfo = ctx.userMarkInfo;
        if (mkInfo) {
            var t3 = mkInfo.timestamp || 0;
            if (t3 >= bestTime) {
                bestTime = t3;
                bestClass = 'xs-td-user-marked';
                bestMkInfo = mkInfo;
                // 注：历史上第一处（_buildRowHtml）曾有 `modCls = (bestClass === ' xs-td-push-added') ? '' : modCls`
                //     的语句，等价于恒等赋值（bestClass 刚被赋 user-marked，条件永假），故此处不做处理。
                //     第二处（updateCellHighlight）本就没这一行；保持第二处的行为为准。
            }
        }

        // 4) 推送失败高亮（行级失败时间）
        //    - 若失败时间 >= 其他高亮时间：失败色覆盖（清除 user-marked 内联色，加 xs-td-push-failed）
        //    - 否则：标记为 xs-td-overrides-fail，让 CSS 保留原高亮色（避免被 tr.xs-tr-push-failed 红底吞掉）
        //    - 若修改时间晚于失败时间，保留 modified 并追加 xs-td-overrides-fail，让 CSS 释放 modified 黄底
        var rowFailTime = ctx.rowFailTime || 0;
        if (rowFailTime > 0) {
            if (rowFailTime >= bestTime) {
                if (ctx.modTime > rowFailTime) {
                    // 失败后又改了：保留 modified 叠加，仅把失败当作"被覆盖"标记
                    failOverridden = true;
                } else {
                    bestTime = rowFailTime;
                    bestClass = 'xs-td-push-failed';
                    bestMkInfo = null;
                    clearModified = true;
                }
            } else {
                // 其他高亮时间更新 → 让其覆盖失败色
                failOverridden = true;
            }
        }

        return {
            bestClass: bestClass,
            bestMkInfo: bestMkInfo,
            failOverridden: failOverridden,
            clearModified: clearModified,
        };
    }

    window.HighlightUtil = {
        parseHighlightedCells: parseHighlightedCells,
        resolveHighlight: resolveHighlight,
    };

    // ============================================================================
    //  HighlightModel —— 高亮状态门面（P2 + P5）
    // ----------------------------------------------------------------------------
    //  背景：高亮相关字段散落在 S 上，各处直接 S._xxx = ... 修改，容易漏掉
    //        「_highlightedCells / _highlightedTime」这类必须成对更新的字段。
    //        本门面统一封装读写路径，并把 03d-row-ops.js 里散落的多个"行偏移"
    //        逻辑合并到 shiftRowIndex 中。
    //
    //  语义保持：内部仍然直接操作 S 上的老字段名（S._highlightedCells 等），
    //          调用方可以逐步替换为门面方法，也可以继续沿用老字段读取。
    //          零迁移成本，可回滚。
    //
    //  修改约束：写路径必须**成对**维护时间戳；行偏移必须覆盖所有含行索引的
    //          高亮集合，与 docs/specs/高亮逻辑说明.md 保持一致。
    // ============================================================================

    /**
     * 设置推送更新高亮（成功推送 / 保存 diff 后由扩展端下发）
     * @param {Object} S               editor 全局状态
     * @param {Object|null} hl         parseHighlightedCells 的结果，或 null 表示清除
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
     * @param {Object} S
     * @param {Array<number>} rowIndices  新增行索引数组
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
     * @param {Object} S
     * @param {number} rowIdx
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
     * @param {Object} S                editor 全局状态
     * @param {'insert'|'delete'|'deleteBatch'} op  操作类型
     * @param {number|number[]} at      insert: 插入位置; delete: 被删行; deleteBatch: 降序数组
     *
     * 覆盖集合（key 中含行索引）：
     *   - S.mods                (Set, key='row,col')
     *   - S._modsTime           (Object, key='row,col')
     *   - S._detailModCellKeys  (Set, key='row,col')
     *   - S._highlightedCells.cells   (Set, key='row:col')
     *   - S._highlightedCells.rowSet  (Set, key=row)
     *   - S._addedRowSet        (Set, key=row)  ← P5 新增
     *
     * 注：rowHeights / _rowExpanded / S.sel 是"行布局/选择"字段而非高亮字段，
     *     暂不并入本函数（避免语义扩散），仍由 03d 内联处理。
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
     *
     * 背景：历史上 02b-bind.js 的 searchReset 会主动清空 S.mods / S._detailModCellKeys，
     *   注释里给出的两条理由都已过时：
     *     1) "避免 force 推送被 hasUserChanges 拦截" —— reload 帧扩展端用
     *        pusher.push(true,'reload',true) 发送，force=true，本就绕过
     *        01-core.js 的 hasUserChanges 拦截，无需前端提前 clear。
     *     2) "刷新后磁盘 = 内存，旧撤销点不再有意义" —— 这只是 history/future 的
     *        语义，与 mods（修改高亮标记）无关。
     *   而 01-core.js 已把 'reload' 列入 _selfReboundReasons，本意就是 reload
     *   回帧默认保留 mods。前端若提前 clear 会造成：
     *     · 失败行的「改单元格黄 + 整行橙」时间戳竞争完全失效，退化为纯红底
     *     · 展开态子表编辑 + 未推送 + 点刷新 → modified 三角消失
     *
     * 策略约定：
     *   · 保留（不清）：S.mods、S._detailModCellKeys、S._modsTime
     *                  → 让扩展端 reload 帧走 _selfReboundReasons 分支自然恢复
     *   · 保留（不清）：S._highlightedCells、S._addedRowSet（含时间戳）
     *                  → 由扩展端 diff 精确刷新，前端无需预清
     *   · 主动清空：S._history、S._future（撤销栈）
     *                  → reload 后数据结构可能变，旧撤销点里的行索引可能失效
     *
     * 若未来出现新的高亮字段，请在此处而非各按钮回调里做统一决策。
     *
     * @param {Object}  S               editor 全局状态
     * @param {Object}  [opts]
     * @param {Function}[opts.clearHistory]  可选：清空撤销栈的函数引用；不传则跳过
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
     *
     * 触发条件：扩展端 full-data 帧携带 `clearAllMods=true`，通常由资源管理器右键
     *   「推送到远端」等"整文件一次性提交"入口发起。语义上：既然整文件已经原子推送
     *   完成，前端所有"未推送修改标记"都失去了参考价值，需要归零。
     *
     * 与 resetForReload 的区别：
     *   · resetForReload = 用户主动 refresh，保留 mods 让高亮延续
     *   · resetForFullPush = 后端说"整文件都推走了"，前端把 mods 全清
     *
     * 清空字段：
     *   · S.mods、S._detailModCellKeys        — 修改标记归零
     *   · S._history、S._future                — 旧撤销点已无意义
     *   · S._lastPushBatchTsIds/RowIndices     — 批次上下文归零
     *   · S._addedRowSet、S._addedInfos        — 新增行标记归零
     *
     * 保留字段：
     *   · S._modsTime                          — 时间戳字典，只在渲染时随 mods 一起被读，
     *                                           mods 已清则读不到，无需强清（避免下次编辑
     *                                           同坐标时的历史时间戳"复活"是极小概率场景，
     *                                           如需强清可后续补入）
     *   · S._pushFailedTsIds 等失败集合         — 由 pushResult / pushFailures 精确管理
     *   · S._highlightedCells                  — 由扩展端本帧的 highlightedCells 字段覆盖
     *
     * @param {Object} S   editor 全局状态
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
     * 「clearAllHighlights 消息」场景下的全清策略（唯一真源）。
     *
     * 触发条件：扩展端发送 `{ type: 'clearAllHighlights' }` 消息，通常由
     *   src/handlers/clearHighlightHandler.ts 命令入口调用，语义是"用户主动/命令
     *   显式清除所有高亮痕迹（含用户手动标记）"。
     *
     * 与其他策略的对比：
     *   · resetForReload         = 只清撤销栈，保留高亮
     *   · resetForFullPush       = 清 mods + 撤销栈，保留失败/用户标记
     *   · resetAllHighlights     = 清所有高亮源（含 userMarks），最激进
     *
     * 清空字段（重要：请与 docs/specs/高亮逻辑说明.md 的九类高亮一一对应保持）：
     *   · 推送后更新：S._highlightedCells / _highlightedTime
     *   · 推送失败：  S._pushFailedTsIds / _pushFailedReasons / _pushFailedTime
     *   · 批次上下文：S._lastPushBatchTsIds / _lastPushBatchRowIndices
     *   · 新增行：    S._addedRowSet / _addedInfos
     *   · 删除行：    S._deletedInfos
     *   · 用户标记：  S._userMarks（rects / cellMap / rowMap / rowSet / cellTime / rowTime）
     *   · 明细修改：  S._detailModCellKeys
     *
     * 不清空：
     *   · S.mods —— 修改小三角与"未推送修改"语义强绑定，clearAllHighlights 不宜清
     *             （若确需清，请后续增加显式 opts.clearMods=true）
     *
     * 关联 UI toggle（_failedOnly / _modifiedOnly / _addedOnly / _deletedOnly /
     * _markedOnly）由调用方另行复位，本函数只负责状态字段的清空。
     *
     * @param {Object} S   editor 全局状态
     */
    function resetAllHighlights(S) {
        setHighlightedCells(S, null);
        S._pushFailedTsIds = new Set();
        S._pushFailedReasons = new Map();
        S._pushFailedTime = new Map();
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
     *
     * 触发条件：01-core.js 的 full-data 处理中检测到 `_lastHeadSig` 变化。
     *   语义：列结构变了 → 所有按行索引 / tsId / cell 维护的高亮索引都可能穿透到
     *   新文件（尤其是切换文件场景），必须清空。
     *
     * 清空字段：
     *   · S._pushFailedTsIds / _pushFailedReasons / _pushFailedTime  — 失败索引归零
     *   · S._lastPushBatchTsIds                                       — 批次归零
     *   · S._highlightedCells / _highlightedTime                      — 推送后更新归零
     *
     * 不清空：
     *   · S.mods / S._detailModCellKeys —— 由外层 _selfReboundReasons 决策，本函数只
     *                                     处理"列变化"这一维度
     *   · S._addedRowSet                —— 由外层 addedInfos 字段处理
     *
     * 附加 UI 复位（本函数直接处理，语义完整）：
     *   · S._failedOnly / _modifiedOnly — 失败集合清空后这两个筛选也失去意义
     *
     * @param {Object} S   editor 全局状态
     */
    function resetOnColumnChange(S) {
        S._pushFailedTsIds = new Set();
        S._pushFailedReasons = new Map();
        S._pushFailedTime = new Map();
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
     *        （这是 05a 的业务语义：谁成功谁失败）；
     *      · S._highlightedCells 的下发消费（应由调用方另行 setHighlightedCells）；
     *      · "从哪几个渠道兜底反查行号"——由 05a 组装最终 rowIndices 后传入。
     *
     * @param {Object} S                 editor 全局状态
     * @param {Object} opts
     * @param {number[]|null} opts.rowIndices  本批推送涉及的 0-based 行索引；null/空数组表示
     *                                         "只清 tsId 批次缓存，不做行级清理"（前置校验
     *                                         无有效批次时的兜底路径）。
     * @param {boolean} [opts.clearBatchTsIds=true]  是否顺带清空 S._lastPushBatchTsIds。
     *                                               默认 true（一次推送结果消费完毕）。
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
            //    注意：patchCell / _buildRowHtml 里都会通过 _hasMod 门控 _modTime，
            //          _hasMod=false 时 _modTime=0 —— 因此本 bug 的影响面主要是：
            //          （a）历史遗留代码路径 / undo 恢复 / 明细弹窗子表 detailMod 依赖
            //               _modsTime 的边路场景；
            //          （b）后续若有直接读 _modsTime 参与竞争的代码（未来防御）。
            //    此清理与 S.mods / _detailModCellKeys 同步，确保状态一致性。
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

    /**
     * 「浅克隆推送失败三件套」——供快照采集使用。
     * 与 _clonePushFailures 语义等价，但归门面所有，避免多处内联复制。
     */
    function _clonePushFailures(S) {
        return {
            ids: S._pushFailedTsIds ? Array.from(S._pushFailedTsIds) : [],
            reasons: S._pushFailedReasons ? Array.from(S._pushFailedReasons) : [],   // [[k,v],...]
            time: S._pushFailedTime ? Array.from(S._pushFailedTime) : []             // [[k,ts],...]
        };
    }

    /**
     * 「浅克隆标记 rects」——供快照采集使用。
     * rects 元素只含 r1/r2/c1/c2/bgColor/fontColor/timestamp 等基本字段，单层拷贝即可。
     * 字段兜底：bgColor/fontColor 空时置 null，timestamp 空时置 0（与旧版严格等价）。
     */
    function _cloneMarkRects(rects) {
        if (!Array.isArray(rects)) return [];
        var out = new Array(rects.length);
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i] || {};
            out[i] = {
                r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2,
                bgColor: r.bgColor || null,
                fontColor: r.fontColor || null,
                timestamp: (r.timestamp != null) ? r.timestamp : 0
            };
        }
        return out;
    }

    /**
     * 「统一失效 _userMarks 的缓存索引」——为 lazy 重建让路。
     *
     * _userMarks.cellMap / rowMap / rowSet / cellTime / rowTime 是渲染时按需重建的
     * 缓存字段。任何一次「rects 被替换」的场景（快照恢复、消息覆盖、undo/redo）
     * 都必须把这五个字段置 null，否则 isUserMarked/_isRowMarked 会读到过期数据。
     *
     * 该函数在 P7 之前散落在 4 处（restoreSnapshot / restoreUserMarks / full-data
     * userMarks 分支 / resetAllHighlights），P7 起统一由本函数承担。
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
     * 「为撤销栈采集高亮相关字段」——P7 抽取自 01-core.js 的 snapshot()。
     *
     * 承担范围：只克隆本函数关心的 2 个字段：
     *   · userMarks     ——  rects 数组浅克隆
     *   · pushFailures  ——  { ids, reasons, time } 三件套浅克隆
     *
     * 不承担：
     *   · rows / mods / addedRowSet / highlightedTime / addedRowTime / detailTables
     *     这些是撤销栈自身的业务（列结构 / 编辑历史），不属于「高亮语义」。
     *
     * @param {Object} S      editor 全局状态
     * @returns {Object}      { userMarks: Array, pushFailures: Object }
     */
    function snapshotForUndo(S) {
        return {
            userMarks: _cloneMarkRects((S._userMarks && S._userMarks.rects) || []),
            pushFailures: _clonePushFailures(S),
        };
    }

    /**
     * 「从撤销栈快照恢复高亮相关字段」——P7 抽取自 01-core.js 的
     *  _restorePushFailures + _restoreUserMarks（不含发消息 & 保护期两个副作用）。
     *
     * 承担范围：
     *   1) 恢复 _pushFailedTsIds / _pushFailedReasons / _pushFailedTime；
     *      旧快照（不含 pushFailures 字段）走「全清空」兜底，避免索引错位污染；
     *      顺带按语义联动 _failedOnly / _modifiedOnly。
     *   2) 恢复 _userMarks.rects，并失效缓存索引。
     *
     * 不承担：
     *   · S._deletedInfos 的复位（属于删除幽灵行的独立业务，01-core 自行清空）；
     *   · 发送 setMarkRects 消息（写盘副作用，由 01-core 保留决策）；
     *   · S._markGuardUntil 保护期设置（消息竞态防护，由 01-core 保留决策）。
     *
     * @param {Object} S       editor 全局状态
     * @param {Object} snap    撤销栈快照对象（可能是旧格式）
     */
    function restoreFromSnapshot(S, snap) {
        if (!snap) snap = {};

        // 1) 恢复推送失败三件套
        var pf = snap.pushFailures;
        if (pf && (pf.ids || pf.reasons || pf.time)) {
            S._pushFailedTsIds = new Set(pf.ids || []);
            S._pushFailedReasons = new Map(pf.reasons || []);
            S._pushFailedTime = new Map(pf.time || []);
        } else {
            // 旧快照不含 pushFailures：保持「全清空」旧行为，避免索引错位污染
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            S._pushFailedTime = new Map();
        }
        // 失败集合清空 → UI 筛选联动复位
        if (S._failedOnly && (!S._pushFailedTsIds || S._pushFailedTsIds.size === 0)) S._failedOnly = false;
        if (S._modifiedOnly) S._modifiedOnly = false;

        // 2) 恢复用户标记 rects（缓存索引置 null，等 render 时 lazy 重建）
        if (!S._userMarks) {
            S._userMarks = { rects: [], cellMap: null, rowMap: null, rowSet: null, cellTime: null, rowTime: null };
        }
        var _restoredMarks = Array.isArray(snap.userMarks) ? _cloneMarkRects(snap.userMarks) : [];
        S._userMarks.rects = _restoredMarks;
        _invalidateUserMarksCache(S);

        return { restoredMarks: _restoredMarks };
    }

    /**
     * 「消费扩展端下发的 pushFailures payload」——P7 抽取自 01-core.js
     *  full-data 处理中的 pushFailures 分支。
     *
     * payload 有 3 种形态（历史兼容）：
     *   1) 对象字典 { tsId: { reason, timestamp } }   —— 新格式
     *   2) 对象字典 { tsId: "reason string" }         —— 旧格式，timestamp 视为 0
     *   3) null / 非对象                              —— 全清空
     *
     * 承担范围：
     *   · 重建 _pushFailedTsIds / _pushFailedReasons / _pushFailedTime；
     *   · payload 为空时联动 _failedOnly=false（UI 筛选自动关闭）。
     *
     * 不承担：
     *   · _lastPushBatchTsIds 的清理（那是 05a 的批次业务）；
     *   · _highlightedCells 的更新（各字段独立消费）。
     *
     * @param {Object} S         editor 全局状态
     * @param {*}      payload   扩展端下发的 m.pushFailures
     */
    function applyPushFailuresPayload(S, payload) {
        if (payload && typeof payload === 'object') {
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            if (!S._pushFailedTime) S._pushFailedTime = new Map();
            else S._pushFailedTime.clear();
            for (var k in payload) {
                if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
                var kStr = String(k);
                if (!kStr) continue;
                S._pushFailedTsIds.add(kStr);
                var pv = payload[k];
                if (pv && typeof pv === 'object') {
                    if (pv.reason) S._pushFailedReasons.set(kStr, String(pv.reason));
                    var pts = (typeof pv.timestamp === 'number' && isFinite(pv.timestamp)) ? pv.timestamp : 0;
                    S._pushFailedTime.set(kStr, pts);
                } else if (typeof pv === 'string') {
                    // 兼容旧格式：纯字符串 reason，timestamp 视为 0
                    if (pv) S._pushFailedReasons.set(kStr, String(pv));
                    S._pushFailedTime.set(kStr, 0);
                }
            }
        } else {
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            if (S._pushFailedTime) S._pushFailedTime.clear(); else S._pushFailedTime = new Map();
            if (S._failedOnly) S._failedOnly = false;
        }
    }

    /**
     * 「消费扩展端下发的 userMarks payload」——P7 抽取自 01-core.js
     *  full-data 处理中的 userMarks 覆盖分支。
     *
     * 承担范围：
     *   · 替换 _userMarks.rects（数组则直接采用，非数组视为清空）；
     *   · 失效缓存索引（cellMap/rowMap/rowSet/cellTime/rowTime）。
     *
     * 不承担：
     *   · 「是否跳过覆盖」的判定（消息控制流：_markGuardUntil / reason=saveHighlight
     *     / reason=pushSuccess），由 01-core 保留决策后再调用本函数。
     *
     * @param {Object} S          editor 全局状态
     * @param {*}      rectsArr   扩展端下发的 m.userMarks
     */
    function applyUserMarksPayload(S, rectsArr) {
        if (!S._userMarks) {
            S._userMarks = { rects: [], cellMap: null, rowMap: null, rowSet: null, cellTime: null, rowTime: null };
        }
        if (rectsArr && Array.isArray(rectsArr)) {
            S._userMarks.rects = rectsArr;
        } else {
            S._userMarks.rects = [];
        }
        _invalidateUserMarksCache(S);
    }

    window.HighlightModel = {
        setHighlightedCells: setHighlightedCells,
        setAddedRows: setAddedRows,
        addAddedRow: addAddedRow,
        shiftRowIndex: shiftRowIndex,
        resetForReload: resetForReload,
        resetForFullPush: resetForFullPush,
        resetAllHighlights: resetAllHighlights,
        resetOnColumnChange: resetOnColumnChange,
        clearByPushBatch: clearByPushBatch,
        snapshotForUndo: snapshotForUndo,
        restoreFromSnapshot: restoreFromSnapshot,
        applyPushFailuresPayload: applyPushFailuresPayload,
        applyUserMarksPayload: applyUserMarksPayload,
    };
})();
