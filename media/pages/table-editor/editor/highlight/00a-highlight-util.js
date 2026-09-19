/**
 * ============================================================================
 *  00a-highlight-util.js —— 高亮工具 · 字段码映射 + 竞争决策
 * ----------------------------------------------------------------------------
 *  由 00-highlight-util.js 拆分而来（2026-09-19，方案 C · C6）。
 *
 *  职责（纯函数为主）：
 *    · FIELD_TO_HEADER_KEYS / FIELD_SUB_TO_XSE_SECTION 常量
 *    · resolveFieldColumnIndex / getFailedColumnsOfRow / getFieldSeverityOfColumn
 *    · getFailedStepCellsOfRow / isRowColFullyGranular（B4 细粒度）
 *    · parseHighlightedCells（extension payload → 内存态）
 *    · resolveHighlight（时间戳竞争唯一真源，与 docs/specs/高亮逻辑说明.md 第 2 节对齐）
 *
 *  命名空间：window.HighlightUtil / window.HighlightModel（本文件预先建立占位对象，
 *          后续 00b / 00c 依次 Object.assign 追加成员）。
 *  加载顺序：必须在所有其他 editor/*.js 之前，且 00a → 00b → 00c 严格递增。
 * ============================================================================
 */
(function () {
    'use strict';

    /**
     * B3 · 单元格级高亮 —— PushInterfaceField 英文码 → 表格列头候选名列表。
     * ----------------------------------------------------------------------------
     * 用于把「后端/校验器识别出的失败字段码」映射到当前表格 headers 中的具体列索引，
     * 从而只对命中字段所在的单元格染色（而不是整行红/黄底）。
     *
     * 命中规则：
     *   1. 优先精确匹配（headers 数组 indexOf 命中即取）；
     *   2. YAML 场景下 headers 为英文短名（如 description / expected / steps），
     *      CSV 场景下 headers 为中文列头（如「操作步骤」「预期结果」），
     *      两者候选名并列，任一命中即用；
     *   3. description / expected 在 YAML 中并入 `steps` 复合列（一整列被 CSS clamp 呈现，
     *      无法拆到具体子列）—— 故失败落点整个 steps 列。CSV 场景下拆开命中。
     *
     * 未定义或未命中的字段码 → 返回 []，由渲染层兜底染色 testcase_id 列（
     * 视觉锚点，让用户知道「哪一行有问题」而不是整行都亮）。
     */
    var FIELD_TO_HEADER_KEYS = {
        // 接口级公共参数（一次错=整批失败）—— 表格中无对应列，命中时兜底 tsId 列
        testTaskNo: [],
        subTestTaskId: [],
        artifactId: [],
        sourcePlatform: [],
        designer: [],
        // caseList[] 行级字段
        sourceId:      ['testcase_id', '案例来源Id', '案例来源ID', 'sourceId'],
        testCasePath:  ['path', '案例路径', '路径', 'testCasePath'],
        testCaseName:  ['name', '案例名称', '名称', 'testCaseName'],
        testCaseDes:   ['description', '案例描述', 'testCaseDes'], // 注：description 也可能落到 steps 列，见 note
        description:   ['steps', '步骤描述', '操作步骤', 'description'],
        expected:      ['steps', '预期结果', 'expected'],
        priority:      ['priority', '优先级'],
        type:          ['type', '案例类型'],
        preCondition:  ['preconditions', '前置条件', 'preCondition'],
        keyFlag:       ['key_flag', '关键案例', 'keyFlag'],
        projectDes:    ['project_des', '项目说明', 'projectDes'],
        planExecNum:   ['plan_exec_num', '计划执行次数', 'planExecNum'],
        testType:      ['test_type', '执行方式', 'testType'],
        // 冗门资源/扩展字段码 —— 表格中通常无独立列，命中时兜底 tsId 列
        caseInfo: [],
        testPoint: [],
        stepSeq:  ['steps', '步骤描述', '操作步骤', 'description'],
        caseLib: [],
        tag: [],
        module: [],
        env: [],
        owner: [],
    };

    /**
     * B4 · subField (PushSubField) → 展开态子表格 sub-td 的 xse-td-* section，
     *   同时也是弹窗 dv2 中输入框的 data-field 名。
     *   未命中时前端回退到整列高亮。
     */
    var FIELD_SUB_TO_XSE_SECTION = {
        operation:    'desc',       // 步骤名称 → .xse-td-desc
        data:         'data',       // 数据     → .xse-td-data
        ui_expected:  'expected',   // UI检查   → .xse-td-expected（预期结果列整体）
        api_expected: 'expected',   // 接口调用 → .xse-td-expected
        db_expected:  'expected',   // 数据检查 → .xse-td-expected
        // preCondition 不属于 steps sub-td（前置条件是主表单独一列），不列入映射
    };

    /**
     * 把 PushInterfaceField 英文码解析为当前 headers 中的列索引。
     * @param {string} field    英文字段码（如 'description' / 'testCaseName'）
     * @param {string[]} headers 当前表格 headers 数组
     * @returns {number}         列索引；-1 表示未命中
     */
    function resolveFieldColumnIndex(field, headers) {
        if (!field || !Array.isArray(headers) || headers.length === 0) return -1;
        var keys = FIELD_TO_HEADER_KEYS[field];
        if (!keys || keys.length === 0) return -1;
        for (var i = 0; i < keys.length; i++) {
            var idx = headers.indexOf(keys[i]);
            if (idx >= 0) return idx;
        }
        return -1;
    }

    /**
     * B4 · 查询某行需要精确高亮的「子单元格集合」（展开态 sub-td / 弹窗 dv2 输入框）。
     *
     * 返回数组每项：
     *   {
     *     stepIdx: number,               // 0-based 步骤下标
     *     subField: string,              // 'operation' | 'data' | 'ui_expected' | 'api_expected' | 'db_expected' | 'preCondition'
     *     section: string | undefined,   // 展开态子表格 section（'desc' / 'data' / 'expected'）；preCondition 等无展开态对应时为 undefined
     *     severity: 'error' | 'warn',    // 当前 cell 的 severity（error 压 warn）
     *     field: string,                 // 对应的 PushInterfaceField 英文码（消费方可根据需要回查列）
     *   }
     *
     * 只返回同时含有 stepIdx 与 subField 的 hit（即"能定位到具体 sub-td"的那些）；
     * 无细粒度定位的 field 仍由 getFailedColumnsOfRow / getFieldSeverityOfColumn 走整列高亮。
     */
    function getFailedStepCellsOfRow(S, tsId) {
        var out = [];
        if (!tsId || !S) return out;
        var idStr = String(tsId);
        if (!S._pushFailedTsIds || !S._pushFailedTsIds.has(idStr)) return out;
        var fieldsArr = (S._pushFailedFields && S._pushFailedFields.get(idStr)) || [];
        var sevArr = (S._pushFailedFieldSeverity && S._pushFailedFieldSeverity.get(idStr)) || [];
        var cellsArr = (S._pushFailedFieldCells && S._pushFailedFieldCells.get(idStr)) || [];
        if (!Array.isArray(fieldsArr) || fieldsArr.length === 0) return out;
        // 同 (stepIdx, subField) 去重：多个 field 映射到同一 sub-td 时 error 压 warn
        var seen = {};
        for (var i = 0; i < fieldsArr.length; i++) {
            var c = cellsArr[i];
            if (!c || typeof c !== 'object') continue;
            if (typeof c.stepIdx !== 'number' || !c.subField) continue;
            var sev = (sevArr[i] === 'warn' || sevArr[i] === 'error') ? sevArr[i] : 'error';
            var key = c.stepIdx + '|' + c.subField;
            if (seen[key]) {
                if (sev === 'error') seen[key].severity = 'error';
                continue;
            }
            var section = FIELD_SUB_TO_XSE_SECTION[c.subField];
            var item = {
                stepIdx: c.stepIdx,
                subField: c.subField,
                section: section,
                severity: sev,
                field: fieldsArr[i],
            };
            seen[key] = item;
            out.push(item);
        }
        return out;
    }

    /**
     * B4 · 判断某行"某列的所有失败字段"是否全部具备细粒度定位（stepIdx + subField）。
     *
     * 使用场景：展开态下，外层 `<td>`（steps 复合列）是否应"让位"给内层 sub-td——
     *   若该行该列所有失败字段都能精准定位到 sub-td，则外层不再铺满黄底，
     *   让内层 sub-td 独立呈现细粒度高亮；否则（如 stepSeq 之类无步骤下标的字段命中）
     *   仍由外层整格染色以保证不漏。
     */
    function isRowColFullyGranular(S, tsId, colIdx, headers) {
        if (!tsId || !S || colIdx < 0) return false;
        var idStr = String(tsId);
        if (!S._pushFailedTsIds || !S._pushFailedTsIds.has(idStr)) return false;
        var fieldsArr = (S._pushFailedFields && S._pushFailedFields.get(idStr)) || [];
        var cellsArr = (S._pushFailedFieldCells && S._pushFailedFieldCells.get(idStr)) || [];
        if (!Array.isArray(fieldsArr) || fieldsArr.length === 0) return false;
        var hitAny = false;
        for (var i = 0; i < fieldsArr.length; i++) {
            var col = resolveFieldColumnIndex(fieldsArr[i], headers);
            if (col !== colIdx) continue;
            hitAny = true;
            var c = cellsArr[i];
            if (!c || typeof c !== 'object'
                || typeof c.stepIdx !== 'number' || c.stepIdx < 0
                || typeof c.subField !== 'string' || !c.subField) {
                return false; // 任一命中该列的字段缺细粒度定位 → 保守回退到整列染色
            }
        }
        return hitAny;
    }

    /**
     * 计算某行需要染色的列索引集合（B3 · 单元格级失败高亮的核心查询接口）。
     */
    function getFailedColumnsOfRow(S, tsId, headers) {
        var out = new Set();
        if (!tsId || !S || !S._pushFailedTsIds || !S._pushFailedTsIds.has(String(tsId))) return out;
        var fieldsArr = (S._pushFailedFields && S._pushFailedFields.get(String(tsId))) || [];
        if (Array.isArray(fieldsArr) && fieldsArr.length > 0) {
            for (var i = 0; i < fieldsArr.length; i++) {
                var col = resolveFieldColumnIndex(fieldsArr[i], headers);
                if (col >= 0) out.add(col);
            }
        }
        return out;
    }

    /**
     * B5 · 单元格级失败 reason 查询（hover tooltip 专用）。
     *
     * 输入：行 tsId + 列 colIdx + headers（+ 可选 stepIdx/subField 用于 sub-td 级细粒度查询）
     * 返回：该单元格自己命中的字段的 reason 字符串（处于 _pushFailedFieldReasons）；
     *       未命中字段时返回 ''（由调用方自行判断是否需要展示）。
     *
     * 多命中优先级：
     *   1) 若传入 stepIdx/subField，优先匹配相同三元组的那一条（最精确）；
     *   2) 否则仅按 (field 归属于 colIdx) 匹配，同列多个命中按顸命中拼接，不重复（O(n)，n 为该行 fields 长度，实际 ≤ 10）；
     *   3) 字段发现不到对应的 reason 时回退到 _pushFailedReasons（行级合并 reason，旧盘兼容）。
     */
    function getFieldReasonOfCell(S, tsId, colIdx, headers, stepIdx, subField) {
        if (!tsId || !S || colIdx < 0) return '';
        var idStr = String(tsId);
        if (!S._pushFailedTsIds || !S._pushFailedTsIds.has(idStr)) return '';
        var fieldsArr = (S._pushFailedFields && S._pushFailedFields.get(idStr)) || [];
        var reasonsArr = (S._pushFailedFieldReasons && S._pushFailedFieldReasons.get(idStr)) || [];
        var cellsArr = (S._pushFailedFieldCells && S._pushFailedFieldCells.get(idStr)) || [];
        if (!Array.isArray(fieldsArr) || fieldsArr.length === 0) {
            // 字段级盘为空（旧盘/推送失败无字段信息）→ 回退行级 reason
            var _rowFallback = S._pushFailedReasons && S._pushFailedReasons.get(idStr);
            return _rowFallback ? String(_rowFallback) : '';
        }
        // 优先匹配三元组（stepIdx/subField 均传入且存在于 cellsArr 中）
        var reqStepIdx = (typeof stepIdx === 'number' && isFinite(stepIdx) && stepIdx >= 0) ? stepIdx : undefined;
        var reqSubField = (typeof subField === 'string' && subField) ? subField : undefined;
        if (reqStepIdx !== undefined || reqSubField !== undefined) {
            for (var i = 0; i < fieldsArr.length; i++) {
                var col = resolveFieldColumnIndex(fieldsArr[i], headers);
                if (col !== colIdx) continue;
                var c = cellsArr[i] || {};
                var cStep = (typeof c.stepIdx === 'number' && c.stepIdx >= 0) ? c.stepIdx : undefined;
                var cSub = (typeof c.subField === 'string' && c.subField) ? c.subField : undefined;
                if (cStep === reqStepIdx && cSub === reqSubField) {
                    return reasonsArr[i] ? String(reasonsArr[i]) : '';
                }
            }
        }
        // 列级匹配：同列多个命中拼接去重
        var parts = [];
        var seen = Object.create(null);
        for (var j = 0; j < fieldsArr.length; j++) {
            var col2 = resolveFieldColumnIndex(fieldsArr[j], headers);
            if (col2 !== colIdx) continue;
            var r = reasonsArr[j];
            if (!r) continue;
            var rs = String(r);
            if (seen[rs]) continue;
            seen[rs] = true;
            parts.push(rs);
        }
        if (parts.length > 0) return parts.join('；');
        // 本行本列无 field 命中（行仅由其它列命中——例如本列是 testcase_id，但失败字段在其它列）→ 返回 ''
        return '';
    }

    /**
     * 查询某行→某列对应失败字段的 severity（B3 · 字段级独立染色）。
     */
    function getFieldSeverityOfColumn(S, tsId, colIdx, headers) {
        if (!tsId || !S) return 'error';
        var idStr = String(tsId);
        var fieldsArr = (S._pushFailedFields && S._pushFailedFields.get(idStr)) || [];
        var sevArr = (S._pushFailedFieldSeverity && S._pushFailedFieldSeverity.get(idStr)) || [];
        var hitSev = null;
        if (Array.isArray(fieldsArr) && fieldsArr.length > 0) {
            for (var i = 0; i < fieldsArr.length; i++) {
                var col = resolveFieldColumnIndex(fieldsArr[i], headers);
                if (col === colIdx) {
                    var s = sevArr[i];
                    if (s === 'error') { hitSev = 'error'; break; } // error 瞬时结束
                    if (s === 'warn') hitSev = hitSev || 'warn';
                }
            }
        }
        if (hitSev) return hitSev;
        // 回退行级 severity（兼容旧盘/旧快照，字段级缺失时不会就此失色）
        var rowSev = S._pushFailedSeverity && S._pushFailedSeverity.get(idStr);
        return (rowSev === 'warn') ? 'warn' : 'error';
    }

    /**
     * 统一解析 highlightedCells payload（来自扩展端消息 m/p.highlightedCells）
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
     * 详细语义与 docs/specs/高亮逻辑说明.md 第 2 节保持一致。
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

        // 4) 推送失败高亮（行级失败时间）—— 已改为"仅字段级红底"
        //    新策略：整行铺红取消，红色只由 xs-td-failed-cell(-warn) 精准命中的字段承担。
        //    本分支不再把 bestClass 置为 'xs-td-push-failed'，也不再 clearModified，
        //    以免"失败行的非命中字段被整体染红 / 修改黄底被清掉"。
        //    仍保留 failOverridden 标记，兼容外层可能残留的行级 CSS（tr.xs-tr-push-failed）。
        var rowFailTime = ctx.rowFailTime || 0;
        if (rowFailTime > 0) {
            failOverridden = true;
        }

        return {
            bestClass: bestClass,
            bestMkInfo: bestMkInfo,
            failOverridden: failOverridden,
            clearModified: clearModified,
        };
    }

    // 建立命名空间（首次装配）
    window.HighlightUtil = {
        parseHighlightedCells: parseHighlightedCells,
        resolveHighlight: resolveHighlight,
    };
    window.HighlightModel = {
        // 字段码查询接口（B3 · 单元格级失败染色的公共接口）
        getFailedColumnsOfRow: getFailedColumnsOfRow,
        getFieldSeverityOfColumn: getFieldSeverityOfColumn,
        resolveFieldColumnIndex: resolveFieldColumnIndex,
        // B4 · 字段细粒度定位
        getFailedStepCellsOfRow: getFailedStepCellsOfRow,
        isRowColFullyGranular: isRowColFullyGranular,
        // B5 · 单元格级 reason 查询 (hover tooltip 专用)
        getFieldReasonOfCell: getFieldReasonOfCell,
        // 其余 setters / reset / snapshot 由 00b / 00c 追加
    };
})();
