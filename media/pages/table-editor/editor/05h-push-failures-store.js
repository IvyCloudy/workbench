/* =============================================================================
 * 05h-push-failures-store.js  —— 推送失败集合 · 前端 Store
 * -----------------------------------------------------------------------------
 * 从 05a-push-result.js 抽出（2026-09-19 拆分）。
 *
 * 职责（纯数据管理，不涉及 DOM）：
 *   1. initPushFailedMaps(S)        —— 懒初始化 7 个 Map/Set
 *   2. mergePushFailures(S, ...)    —— 增量合并本次推送的 failures：
 *        · 清除本批成功 tsId 的失败标记
 *        · 清除扩展端 successTsIds 兜底列表
 *        · 写入/更新 error+warn 到 tsId/reason/time/severity/fields/fieldSeverity/fieldCells
 *        · fieldCells 按 (field, stepIdx, subField) 三元组去重，同三元组 error 压 warn
 *   3. resolvePushRowIndices(...)   —— 4 层兜底反查参与本批推送的行号：
 *        _lastPushBatchRowIndices → _lastPushBatchTsIds 匹配 testcase_id 列
 *        → failures.rowIndex 转换 → failures.tsId 匹配 testcase_id 列
 *
 * 挂载方式：window.PushFailuresStore（前端 script 顺序加载，无 module 系统）。
 * 依赖顺序：必须在 05a-push-result.js 之前加载（05h < 05a 字母序天然满足）。
 * ========================================================================== */

(function () {
    'use strict';

    /**
     * 懒初始化推送失败相关的 Map/Set 集合。
     * 幂等：已存在的集合不覆盖，避免误清历史数据。
     */
    function initPushFailedMaps(S) {
        if (!S) return;
        if (!S._pushFailedTsIds) S._pushFailedTsIds = new Set();
        if (!S._pushFailedReasons) S._pushFailedReasons = new Map();
        if (!S._pushFailedTime) S._pushFailedTime = new Map();
        if (!S._pushFailedSeverity) S._pushFailedSeverity = new Map();
        // B3 · 单元格级：_pushFailedFields Map tsId -> string[] ，同一行可能多字段失败
        if (!S._pushFailedFields) S._pushFailedFields = new Map();
        // B3 · 字段级 severity：与 _pushFailedFields 一一对应的数组 Map。
        //   例如同行 error+warn 共存时，两个列可以独立取色。
        if (!S._pushFailedFieldSeverity) S._pushFailedFieldSeverity = new Map();
        // B4 · 字段细粒度定位：与 _pushFailedFields 一一对应的
        //   Array<{stepIdx?, subField?}> Map。用于展开态子表格 sub-td 与弹窗 dv2 输入框高亮。
        if (!S._pushFailedFieldCells) S._pushFailedFieldCells = new Map();
        // B5 · 字段级独立 reason：与 _pushFailedFields 一一对应的 string[] Map。
        //   用于 hover 单元格时只显示该单元格自己的问题（而非行级合并 reason）。
        if (!S._pushFailedFieldReasons) S._pushFailedFieldReasons = new Map();
    }

    /**
     * 从失败集合中彻底移除某个 tsId（清除所有 7 个 Map/Set 中的对应项）。
     * 内部辅助。
     */
    function _purgeTsId(S, key) {
        var cleared = 0;
        if (S._pushFailedTsIds.delete(key)) cleared++;
        S._pushFailedReasons.delete(key);
        if (S._pushFailedTime) S._pushFailedTime.delete(key);
        if (S._pushFailedSeverity) S._pushFailedSeverity.delete(key);
        if (S._pushFailedFields) S._pushFailedFields.delete(key);
        if (S._pushFailedFieldSeverity) S._pushFailedFieldSeverity.delete(key);
        if (S._pushFailedFieldCells) S._pushFailedFieldCells.delete(key);
        if (S._pushFailedFieldReasons) S._pushFailedFieldReasons.delete(key);
        return cleared;
    }

    /**
     * 把 failure 项按 hits[] 展开为若干个位置对象。
     * 单值形态（无 hits）也统一走这里，返回单元素数组。
     */
    function _positionsOf(f) {
        if (f && f.hits && f.hits.length > 0) {
            return f.hits.map(function (h) {
                return {
                    field: (h && h.field) || f.field,
                    stepIdx: h && h.stepIdx,
                    subField: h && h.subField,
                    // B5 · 位置级独立 reason：优先取 hit.singleReason（checkMulti 同行多字段时提供细粒度原因）
                    singleReason: h && typeof h.singleReason === 'string' ? h.singleReason : undefined,
                };
            });
        }
        return [{ field: f && f.field, stepIdx: f && f.stepIdx, subField: f && f.subField, singleReason: f && f.singleReason }];
    }

    /**
     * 增量合并本次推送结果到失败集合。
     * @param {*} S           表格视图 state
     * @param {*} payload     完整推送结果 payload（读取 failures / successTsIds）
     * @param {Set|null} batchSet  本批参与的 tsId 集合（缺失则不清除历史）
     * @return {{nowFailedSet: Set, clearedCount: number, failNow: number, oldFailTimeSnap: string[]|null}}
     *         nowFailedSet   本次失败 tsId 集合（供上层日志用）
     *         clearedCount   本次清除的失败 tsId 数量（含 successTsIds 兜底）
     *         failNow        本次写入时间戳（诊断双发用）
     *         oldFailTimeSnap 旧 _pushFailedTime 快照（诊断日志用）
     */
    function mergePushFailures(S, payload, batchSet) {
        initPushFailedMaps(S);
        var failures = (payload && Array.isArray(payload.failures)) ? payload.failures : [];

        // 收集本次失败 tsId（error + warn 全都进入）
        var nowFailedSet = new Set();
        failures.forEach(function (f) {
            if (f && f.tsId !== undefined && f.tsId !== null && f.tsId !== '') {
                nowFailedSet.add(String(f.tsId));
            }
        });

        // ---- 1. 清除本批已成功的 tsId ----
        var clearedCount = 0;
        if (batchSet && typeof batchSet.forEach === 'function') {
            batchSet.forEach(function (ts) {
                if (!nowFailedSet.has(ts)) clearedCount += _purgeTsId(S, ts);
            });
        }

        // ---- 2. 兜底：扩展端 successTsIds ----
        var succArr = (payload && Array.isArray(payload.successTsIds)) ? payload.successTsIds : [];
        succArr.forEach(function (t) {
            if (t === undefined || t === null || t === '') return;
            clearedCount += _purgeTsId(S, String(t));
        });

        // 快照旧的 _pushFailedTime，便于诊断"时间戳被重刷"（双发 bug 现象）
        var oldFailTimeSnap = null;
        if (S._pushFailedTime && S._pushFailedTime.size > 0) {
            oldFailTimeSnap = [];
            S._pushFailedTime.forEach(function (v, k) { oldFailTimeSnap.push(k + '=' + v); });
        }

        // ---- 3. 写入/更新本次失败 tsId 与原因 ----
        // B3：error/warn 全部写入 _pushFailedTsIds；行级 severity 取行内最严重（error 压 warn）
        // B3 · 字段级：同步将 f.field 写入 _pushFailedFields（同 tsId 多个字段时合并去重）
        // B4 · checkMulti 聚合形态：同一 failure 可能携带 hits[]（多位置），按位展开
        // 三元组 (field, stepIdx, subField) 去重，同三元组多次命中 error 压 warn
        var failNow = Date.now();
        failures.forEach(function (f) {
            if (!f || f.tsId === undefined || f.tsId === null || f.tsId === '') return;
            var key = String(f.tsId);
            S._pushFailedTsIds.add(key);
            if (f.reason) S._pushFailedReasons.set(key, String(f.reason));
            else S._pushFailedReasons.delete(key); // 无原因则清掉旧原因，避免误导
            if (S._pushFailedTime) S._pushFailedTime.set(key, failNow);
            var sev = (f.severity === 'warn') ? 'warn' : 'error';
            // 行级 severity：error 压 warn（同行多条 failure 时只保留最严重）
            var prevRowSev = S._pushFailedSeverity.get(key);
            if (prevRowSev === 'error' || sev === 'error') S._pushFailedSeverity.set(key, 'error');
            else S._pushFailedSeverity.set(key, sev);

            var positions = _positionsOf(f);
            var _fReason = String(f.reason || '');
            for (var pi = 0; pi < positions.length; pi++) {
                var p = positions[pi];
                if (!p.field || typeof p.field !== 'string') continue;
                var existed = S._pushFailedFields.get(key) || [];
                var existedSev = S._pushFailedFieldSeverity.get(key) || [];
                var existedCells = S._pushFailedFieldCells.get(key) || [];
                var existedReasons = S._pushFailedFieldReasons.get(key) || [];
                // 兜底对齐长度（防御旧快照：fields 有但 fieldSeverities/fieldCells/fieldReasons 缺）
                while (existedSev.length < existed.length) existedSev.push('error');
                while (existedCells.length < existed.length) existedCells.push({});
                while (existedReasons.length < existed.length) existedReasons.push(_fReason);
                // B5 · 单位置独立 reason：优先取 p.singleReason（checkMulti 同行多字段时为每个位置提供细粒度原因），
                //   否则回退到 f.reason（单字段命中时 f.reason 就是该位置字段自己的原因）。
                var pReason = (p && typeof p.singleReason === 'string' && p.singleReason) ? p.singleReason : _fReason;
                // 解析本次命中的细粒度定位
                var inStepIdx = (typeof p.stepIdx === 'number' && isFinite(p.stepIdx) && p.stepIdx >= 0) ? p.stepIdx : undefined;
                var inSubField = (typeof p.subField === 'string' && p.subField) ? p.subField : undefined;
                // 在 existed 中查找同三元组（field 同名 && stepIdx 同 && subField 同）
                var fi = -1;
                for (var m = 0; m < existed.length; m++) {
                    if (existed[m] !== p.field) continue;
                    var c = existedCells[m] || {};
                    if ((c.stepIdx === undefined ? undefined : c.stepIdx) === inStepIdx
                        && (c.subField || undefined) === inSubField) { fi = m; break; }
                }
                if (fi < 0) {
                    existed.push(p.field);
                    existedSev.push(sev);
                    existedCells.push({ stepIdx: inStepIdx, subField: inSubField });
                    existedReasons.push(pReason);
                } else {
                    // 同三元组重复命中：error 压 warn；reason 若新入非空则覆盖（以新为准）。
                    if (sev === 'error') existedSev[fi] = 'error';
                    if (pReason) existedReasons[fi] = pReason;
                }
                S._pushFailedFields.set(key, existed);
                S._pushFailedFieldSeverity.set(key, existedSev);
                S._pushFailedFieldCells.set(key, existedCells);
                S._pushFailedFieldReasons.set(key, existedReasons);
            }
        });

        return { nowFailedSet: nowFailedSet, clearedCount: clearedCount, failNow: failNow, oldFailTimeSnap: oldFailTimeSnap };
    }

    /**
     * 4 层兜底反查本批推送涉及的行号（0-based）。
     * 供 HighlightModel.clearByPushBatch 使用（清除黄色 modified 标记）。
     */
    function resolvePushRowIndices(S, payload, batchSet, failures) {
        // 兜底 1：_lastPushBatchRowIndices（pushChanges / pushFromContextMenu 缓存）
        var pushRowIndices = S._lastPushBatchRowIndices;

        // 兜底 2：从 _lastPushBatchTsIds 反推
        if ((!pushRowIndices || pushRowIndices.length === 0) && batchSet && batchSet.size > 0) {
            var tsColFallback = (S.data && S.data.headers) ? S.data.headers.indexOf('testcase_id') : -1;
            if (tsColFallback >= 0) {
                pushRowIndices = [];
                var rows2 = (S.data.rows && S.data.rows.length) || 0;
                for (var ri2 = 0; ri2 < rows2; ri2++) {
                    var tid2 = (S.data.rows[ri2] || [])[tsColFallback];
                    if (tid2 !== undefined && tid2 !== null && tid2 !== '' && batchSet.has(String(tid2))) {
                        pushRowIndices.push(ri2);
                    }
                }
            }
        }

        // 兜底 3：从 failures 中的 rowIndex（1-based）转换
        if (!pushRowIndices || pushRowIndices.length === 0) {
            pushRowIndices = [];
            failures.forEach(function (f) {
                if (f && f.rowIndex != null && f.rowIndex > 0) pushRowIndices.push(f.rowIndex - 1);
            });
            var uniq = {};
            pushRowIndices = pushRowIndices.filter(function (v) {
                var s = String(v);
                if (uniq[s]) return false;
                uniq[s] = true;
                return true;
            });
        }

        // 兜底 4：用失败项 tsId 逐行匹配 testcase_id 列
        if ((!pushRowIndices || pushRowIndices.length === 0) && failures.length > 0) {
            var tsCol4 = (S.data && S.data.headers) ? S.data.headers.indexOf('testcase_id') : -1;
            if (tsCol4 >= 0) {
                var failedTsSet = {};
                failures.forEach(function (f) {
                    if (f && f.tsId != null && f.tsId !== '') failedTsSet[String(f.tsId)] = true;
                });
                if (Object.keys(failedTsSet).length > 0) {
                    pushRowIndices = [];
                    var rows4 = (S.data.rows && S.data.rows.length) || 0;
                    for (var ri4 = 0; ri4 < rows4; ri4++) {
                        var tid4 = String((S.data.rows[ri4] || [])[tsCol4] || '');
                        if (tid4 && failedTsSet[tid4]) pushRowIndices.push(ri4);
                    }
                }
            }
        }

        return pushRowIndices;
    }

    // 暴露到 window，供 05a-push-result.js 使用
    window.PushFailuresStore = {
        initPushFailedMaps: initPushFailedMaps,
        mergePushFailures: mergePushFailures,
        resolvePushRowIndices: resolvePushRowIndices,
    };
})();
