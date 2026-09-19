/**
 * ============================================================================
 *  00c-highlight-model-snap.js —— HighlightModel · 快照 / 恢复 / payload 消费
 * ----------------------------------------------------------------------------
 *  由 00-highlight-util.js 拆分而来（2026-09-19，方案 C · C6）。
 *
 *  承担范围：
 *    · _clonePushFailures / _cloneMarkRects / _invalidateUserMarksCache（本模块内敛）
 *    · snapshotForUndo / restoreFromSnapshot（撤销栈快照集成）
 *    · applyPushFailuresPayload（消费扩展端下发的 pushFailures 字典）
 *    · applyUserMarksPayload（消费扩展端下发的 userMarks 数组）
 *
 *  加载顺序：必须在 00a、00b 之后。
 *  依赖：window.HighlightModel 已由 00a/00b 装配。本文件通过 Object.assign 追加成员。
 *       其中 applyPushFailuresPayload 会调 window.HighlightModel.resolveFieldColumnIndex
 *       （由 00a 提供）。
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * 「浅克隆推送失败四件套」——供快照采集使用。
     * P7 沼用 _clonePushFailures 名称，B3 之后额外搭上 severity。
     */
    function _clonePushFailures(S) {
        return {
            ids: S._pushFailedTsIds ? Array.from(S._pushFailedTsIds) : [],
            reasons: S._pushFailedReasons ? Array.from(S._pushFailedReasons) : [],   // [[k,v],...]
            time: S._pushFailedTime ? Array.from(S._pushFailedTime) : [],            // [[k,ts],...]
            severity: S._pushFailedSeverity ? Array.from(S._pushFailedSeverity) : [], // [[k,'error'|'warn'],...]
            fields: S._pushFailedFields ? Array.from(S._pushFailedFields) : [],       // [[k, ['description','expected']],...]
            fieldSeverities: S._pushFailedFieldSeverity ? Array.from(S._pushFailedFieldSeverity) : [], // [[k, ['error','warn']],...]
            // B4 · 字段细粒度定位数组（与 fields 平行）
            fieldCells: S._pushFailedFieldCells ? Array.from(S._pushFailedFieldCells) : [],            // [[k, [{stepIdx,subField},...]],...]
            // B5 · 字段级独立 reason 数组（与 fields 平行）
            fieldReasons: S._pushFailedFieldReasons ? Array.from(S._pushFailedFieldReasons) : []       // [[k, ['reason1','reason2',...]],...]
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
     * 「统一失效 _userMarks 的缓存索引」——本文件与 00b 各自持一份（15 行代码），
     * 避免跨文件闭包依赖。逻辑必须与 00b 中的 _invalidateUserMarksCache 严格一致。
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
     */
    function restoreFromSnapshot(S, snap) {
        if (!snap) snap = {};

        // 1) 恢复推送失败五件套（B3：含 severity + fields）
        var pf = snap.pushFailures;
        if (pf && (pf.ids || pf.reasons || pf.time)) {
            S._pushFailedTsIds = new Set(pf.ids || []);
            S._pushFailedReasons = new Map(pf.reasons || []);
            S._pushFailedTime = new Map(pf.time || []);
            // severity 旧快照可能没有，则默认空 Map（渲染时兜底为 'error'）
            S._pushFailedSeverity = new Map(pf.severity || []);
            // fields 旧快照可能没有，则默认空 Map（渲染时兜底染 tsId 列）
            S._pushFailedFields = new Map(pf.fields || []);
            // fieldSeverities：旧快照可能无，则默认空 Map（渲染时 getFieldSeverityOfColumn 回退行级 severity）
            S._pushFailedFieldSeverity = new Map(pf.fieldSeverities || []);
            // B4 · fieldCells：旧快照无时默认空 Map（前端渲染回退到整列高亮）
            S._pushFailedFieldCells = new Map(pf.fieldCells || []);
            // B5 · fieldReasons：旧快照无时默认空 Map（前端 hover 回退到行级 reason）
            S._pushFailedFieldReasons = new Map(pf.fieldReasons || []);
        } else {
            // 旧快照不含 pushFailures：保持「全清空」旧行为，避免索引错位污染
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            S._pushFailedTime = new Map();
            S._pushFailedSeverity = new Map();
            S._pushFailedFields = new Map();
            S._pushFailedFieldSeverity = new Map();
            S._pushFailedFieldCells = new Map();
            S._pushFailedFieldReasons = new Map();
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
     */
    function applyPushFailuresPayload(S, payload) {
        // resolveFieldColumnIndex 来自 00a（已挂到 HighlightModel）
        var resolveFieldColumnIndex = window.HighlightModel.resolveFieldColumnIndex;

        // B3 · 字段级"失败恢复"检测：进入前先快照旧的 (tsId -> Set<field>) 映射，
        //   函数末尾对比新旧，找出"旧 fail 现 not-fail"的 (tsId, field) 对，
        //   把它们对应的 mods / detail keys / modsTime 清掉——防止用户改回合法值后
        //   modified 淡黄底还残留在单元格上（.xs-editable.modified{background:#fffbe6}）。
        var _oldFieldMap = new Map();
        if (S._pushFailedFields && typeof S._pushFailedFields.forEach === 'function') {
            S._pushFailedFields.forEach(function (arr, tsId) {
                if (Array.isArray(arr) && arr.length > 0) {
                    _oldFieldMap.set(String(tsId), new Set(arr));
                }
            });
        }
        if (payload && typeof payload === 'object') {
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            if (!S._pushFailedTime) S._pushFailedTime = new Map();
            else S._pushFailedTime.clear();
            // B3：severity Map 同步重建
            if (!S._pushFailedSeverity) S._pushFailedSeverity = new Map();
            else S._pushFailedSeverity.clear();
            // B3 · 单元格级：fields Map 同步重建
            if (!S._pushFailedFields) S._pushFailedFields = new Map();
            else S._pushFailedFields.clear();
            // B3 · 字段级 severity：与 fields 一一对应的数组 Map
            if (!S._pushFailedFieldSeverity) S._pushFailedFieldSeverity = new Map();
            else S._pushFailedFieldSeverity.clear();
            // B4 · 字段细粒度定位：与 fields 一一对应的 Array<{stepIdx,subField}> Map
            if (!S._pushFailedFieldCells) S._pushFailedFieldCells = new Map();
            else S._pushFailedFieldCells.clear();
            // B5 · 字段级独立 reason：与 fields 一一对应的 string[] Map
            if (!S._pushFailedFieldReasons) S._pushFailedFieldReasons = new Map();
            else S._pushFailedFieldReasons.clear();
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
                    // B3：severity 只收严格的 'warn'/'error'，其余不写（渲染时兜底 'error'）
                    if (pv.severity === 'warn' || pv.severity === 'error') {
                        S._pushFailedSeverity.set(kStr, pv.severity);
                    }
                    // B3/B4 · 单元格级：fields 数组优先（同 tsId 多字段一次全染色）；
                    //   B4 新语义：同一 field 允许多次出现（同行多步命中），以
                    //   (field, stepIdx, subField) 三元组去重，
                    //   并把每一项对应的细粒度定位保存到 _pushFailedFieldCells。
                    //   兼容旧 field 单值：包成 [field] 数组，fieldCells 为 [{}]。
                    if (Array.isArray(pv.fields) && pv.fields.length > 0) {
                        var _srcSev = Array.isArray(pv.fieldSeverities) ? pv.fieldSeverities : [];
                        var _srcCells = Array.isArray(pv.fieldCells) ? pv.fieldCells : [];
                        var _srcReasons = Array.isArray(pv.fieldReasons) ? pv.fieldReasons : [];
                        var _rowSevFallback = (pv.severity === 'warn' || pv.severity === 'error') ? pv.severity : 'error';
                        var _rowReasonFallback = pv.reason ? String(pv.reason) : '';
                        var _fArr = [];
                        var _fSevArr = [];
                        var _fCellArr = [];
                        var _fReasonArr = [];
                        // 已入项的三元组集合，用于 (field, stepIdx, subField) 去重
                        var _seenTriples = Object.create(null);
                        for (var _fi = 0; _fi < pv.fields.length; _fi++) {
                            var _fv = pv.fields[_fi];
                            if (typeof _fv !== 'string' || !_fv) continue;
                            // 解析细粒度定位：不合法元素归一为 {}
                            var _cRaw = _srcCells[_fi];
                            var _stepIdx = (_cRaw && typeof _cRaw === 'object' && typeof _cRaw.stepIdx === 'number' && isFinite(_cRaw.stepIdx) && _cRaw.stepIdx >= 0)
                                ? _cRaw.stepIdx : undefined;
                            var _subField = (_cRaw && typeof _cRaw === 'object' && typeof _cRaw.subField === 'string' && _cRaw.subField)
                                ? _cRaw.subField : undefined;
                            // 三元组去重键：使用 '|' 分隔并加显式 '?' 表示 undefined，避免 stepIdx=0 与 undefined 混淆
                            var _tripleKey = _fv + '|' + (typeof _stepIdx === 'number' ? _stepIdx : '?') + '|' + (_subField || '?');
                            // 解析 severity
                            var _sevRaw = _srcSev[_fi];
                            var _sev = (_sevRaw === 'error' || _sevRaw === 'warn') ? _sevRaw : _rowSevFallback;
                            // B5 · 解析字段级 reason：优先取 fieldReasons[i]，否则回退行级 reason
                            var _rRaw = _srcReasons[_fi];
                            var _fReason = (typeof _rRaw === 'string' && _rRaw) ? _rRaw : _rowReasonFallback;
                            if (_seenTriples[_tripleKey] !== undefined) {
                                // 已存在相同三元组：只做 error 压 warn 提升，reason 若新入非空则覆盖（以新为准）
                                var _existIdx = _seenTriples[_tripleKey];
                                if (_sev === 'error') _fSevArr[_existIdx] = 'error';
                                if (_fReason) _fReasonArr[_existIdx] = _fReason;
                                continue;
                            }
                            _seenTriples[_tripleKey] = _fArr.length;
                            _fArr.push(_fv);
                            _fSevArr.push(_sev);
                            _fCellArr.push({ stepIdx: _stepIdx, subField: _subField });
                            _fReasonArr.push(_fReason);
                        }
                        if (_fArr.length > 0) {
                            S._pushFailedFields.set(kStr, _fArr);
                            S._pushFailedFieldSeverity.set(kStr, _fSevArr);
                            S._pushFailedFieldCells.set(kStr, _fCellArr);
                            S._pushFailedFieldReasons.set(kStr, _fReasonArr);
                        }
                    } else if (pv.field && typeof pv.field === 'string') {
                        S._pushFailedFields.set(kStr, [pv.field]);
                        var _rowSevFallback2 = (pv.severity === 'warn' || pv.severity === 'error') ? pv.severity : 'error';
                        S._pushFailedFieldSeverity.set(kStr, [_rowSevFallback2]);
                        S._pushFailedFieldCells.set(kStr, [{}]);
                        // B5 · 旧格式单 field：fieldReasons 也用行级 reason
                        S._pushFailedFieldReasons.set(kStr, [pv.reason ? String(pv.reason) : '']);
                    }
                } else if (typeof pv === 'string') {
                    // 兼容旧格式：纯字符串 reason，timestamp 视为 0
                    if (pv) S._pushFailedReasons.set(kStr, String(pv));
                    S._pushFailedTime.set(kStr, 0);
                    // 旧格式无 severity → 默认 error，不写
                }
            }
        } else {
            S._pushFailedTsIds = new Set();
            S._pushFailedReasons = new Map();
            if (S._pushFailedTime) S._pushFailedTime.clear(); else S._pushFailedTime = new Map();
            if (S._pushFailedSeverity) S._pushFailedSeverity.clear(); else S._pushFailedSeverity = new Map();
            if (S._pushFailedFields) S._pushFailedFields.clear(); else S._pushFailedFields = new Map();
            if (S._pushFailedFieldSeverity) S._pushFailedFieldSeverity.clear(); else S._pushFailedFieldSeverity = new Map();
            if (S._pushFailedFieldCells) S._pushFailedFieldCells.clear(); else S._pushFailedFieldCells = new Map();
            if (S._pushFailedFieldReasons) S._pushFailedFieldReasons.clear(); else S._pushFailedFieldReasons = new Map();
            if (S._failedOnly) S._failedOnly = false;
        }
        // B3 · 字段级"失败恢复"清理：对每个旧失败字段，若在新 payload 中已不在失败集合，
        //   说明用户已把非法值改回合法值。此时把该字段对应单元格的 mods / detail keys /
        //   modsTime 一起清掉，让 .modified 淡黄底同步消失，避免"改好了但还是黄的"错觉。
        try {
            if (_oldFieldMap.size > 0 && S && S.data && Array.isArray(S.data.headers) && Array.isArray(S.data.rows)) {
                var _headers = S.data.headers;
                var _rows = S.data.rows;
                var _tsCol = _headers.indexOf('testcase_id');
                if (_tsCol >= 0) {
                    // 构建 tsId -> ri 反查（一次遍历 O(n)），
                    //   同一 tsId 出现多次时以第一次为准（正常场景 tsId 唯一）。
                    var _tsToRi = new Map();
                    for (var _ri = 0; _ri < _rows.length; _ri++) {
                        var _rw = _rows[_ri];
                        if (!_rw) continue;
                        var _tid = _rw[_tsCol];
                        if (_tid !== undefined && _tid !== null && _tid !== '') {
                            var _tidStr = String(_tid);
                            if (!_tsToRi.has(_tidStr)) _tsToRi.set(_tidStr, _ri);
                        }
                    }
                    _oldFieldMap.forEach(function (oldFields, tsId) {
                        var newFields = S._pushFailedFields.get(tsId);
                        var newSet = (Array.isArray(newFields) && newFields.length > 0) ? new Set(newFields) : null;
                        var ri = _tsToRi.get(tsId);
                        if (ri === undefined) return;
                        oldFields.forEach(function (fName) {
                            if (newSet && newSet.has(fName)) return; // 仍然失败，跳过
                            var ci = resolveFieldColumnIndex(fName, _headers);
                            if (ci < 0) return; // 字段无法映射到列（如 testTaskNo）
                            var key = ri + ',' + ci;
                            if (S.mods && typeof S.mods.delete === 'function') S.mods.delete(key);
                            if (S._detailModCellKeys && typeof S._detailModCellKeys.delete === 'function') S._detailModCellKeys.delete(key);
                            if (S._modsTime && Object.prototype.hasOwnProperty.call(S._modsTime, key)) {
                                delete S._modsTime[key];
                            }
                        });
                    });
                }
            }
        } catch (_e) { /* 清理失败不应阻塞主流程 */ }
    }

    /**
     * 「消费扩展端下发的 userMarks payload」——P7 抽取自 01-core.js
     *  full-data 处理中的 userMarks 覆盖分支。
     *
     * 不承担：
     *   · 「是否跳过覆盖」的判定（消息控制流：_markGuardUntil / reason=saveHighlight
     *     / reason=pushSuccess），由 01-core 保留决策后再调用本函数。
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

    // 追加成员（Object.assign 保留 00a/00b 已挂载的字段码查询接口 + 写路径）
    Object.assign(window.HighlightModel, {
        snapshotForUndo: snapshotForUndo,
        restoreFromSnapshot: restoreFromSnapshot,
        applyPushFailuresPayload: applyPushFailuresPayload,
        applyUserMarksPayload: applyUserMarksPayload,
    });
})();
