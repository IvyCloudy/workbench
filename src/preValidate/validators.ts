/**
 * preValidate/validators.ts
 * -------------------------------------------------------------
 * 前置校验（Pre-Validate）· 纯校验器层
 * -------------------------------------------------------------
 * 本文件从 handlers/pushCore.stages.ts 抽出，专注"行级校验规则"，
 * 与推送流程解耦：
 *   · 定义 RowValidator 接口
 *   · 提供 3 个内置 tsId 层校验器（占位 / 空 / 格式）
 *   · 提供「待补充」字面量软拦截（B1 · warn 级）
 *   · 提供 runValidators / runValidatorsOnRowsPure 通用驱动
 *   · 提供 3 个便捷 collectXxx 单校验器入口
 *
 * 不做的事：
 *   · 不做埋点（TelemetryService）
 *   · 不做磁盘持久化（persistPushFailures）
 *   · 不感知 PushContext、PushCoreHooks
 * 推送编排相关请见 preValidate/stepPreValidate.ts。
 */

import {
    classifyFailure,
    failureFieldOf,
    type PushInterfaceField,
} from '../utils/pushFailureCategory';
import { isSampleTsId } from '../utils/fileIdentifier';
import { isTestAgentUuid, isTestFlowUuid } from '../utils/testcaseId';
import { TS_ID_COLUMN } from '../services/utils';
import type { PushFailureItem, RowLike, PushSubField } from '../handlers/pushCore.types';
import { B2_ERROR_VALIDATORS } from '../handlers/pushCore.enumTypeValidators';
import { getValidateFlag } from '../utils/caseEnumValues';

// =============================================================
// 行级小工具
// =============================================================

/** 从行对象读取标准化后的 tsId（trim + 空值兜底为 ''）。 */
export function readTsId(rec: RowLike | undefined | null): string {
    if (!rec) return '';
    const raw = rec[TS_ID_COLUMN];
    return raw == null ? '' : String(raw).trim();
}

// =============================================================
// 可扩展的行级预校验（RowValidator 数组）
// =============================================================

/** 单条行级预校验规则。返回失败明细或 null（通过）。 */
export interface RowValidator {
    /** 校验类型标识；用于埋点事件名与 aborted reason 归类 */
    kind: 'placeholder' | 'empty' | 'todoPlaceholder' | (string & {});
    /**
     * 严重级别：
     *   - 'error'：硬拦截，命中行从 payload 剔除、不参与后端推送（占位/空/格式非法）
     *   - 'warn' ：软拦截，命中项会入 failures 供后续弹窗与高亮展示，
     *              但**不进入 droppedIndex**，仍可推送（如「待补充」质量类问题）
     * 未显式声明的 validator 视为 'error'（向后兼容外部实现）。
     */
    severity?: 'error' | 'warn';
    /** 判定是否命中该失败；命中返回失败明细（不含 rowIndex，由调度器统一补上） */
    check(row: RowLike, tsId: string): Omit<PushFailureItem, 'rowIndex'> | null;
    /**
     * B4 · 多命中校验（可选）：同一行可产生多条 failure，用于 sub-td / 弹窗输入框级细粒度高亮。
     * 若实现，runValidators 会优先调用 checkMulti；返回空数组即通过。
     * 单个 failure 缺 stepIdx/subField 时，走回退整列高亮。
     */
    checkMulti?(row: RowLike, tsId: string): Array<Omit<PushFailureItem, 'rowIndex'>>;
}

/** 内置校验：占位 TESTCASE_ID（大写） */
const PLACEHOLDER_VALIDATOR: RowValidator = {
    kind: 'placeholder',
    severity: 'error',
    check(_row, tsId) {
        if (tsId.toUpperCase() === 'TESTCASE_ID') {
            return {
                tsId,
                reason: 'testcase_id 为占位值 TESTCASE_ID，请修改为真实的案例 ID 后再推送',
            };
        }
        return null;
    },
};

/** 内置校验：testcase_id 为空 */
const EMPTY_VALIDATOR: RowValidator = {
    kind: 'empty',
    severity: 'error',
    check(_row, tsId) {
        if (tsId === '') {
            return {
                tsId: '',
                reason: 'testcase_id 不能为空，请填写案例 ID 后再推送',
            };
        }
        return null;
    },
};

/** 案例唯一标识（testcase_id）合法格式：标准 UUID，或 TC/MA 前缀 + 32 位 uuid.hex */
const TESTCASE_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(TC|MA)[0-9a-f]{32})$/i;

/**
 * 综合校验 testcase_id 合法性，兼容两类 TC 前缀"掩码 uuid"场景：
 *   - 标准 UUID / TC|MA + 32 位 hex（TESTCASE_ID_PATTERN）
 *   - testagent 掩码 uuid（isTestAgentUuid）
 *   - testflow 掩码 uuid（isTestFlowUuid）
 * 掩码 uuid 的判定逻辑独立沉淀于 utils/testcaseId，便于其它模块复用。
 */
export function isTestcaseIdValid(tsId: string): boolean {
    return (
        TESTCASE_ID_PATTERN.test(tsId) ||
        isTestAgentUuid(tsId) ||
        isTestFlowUuid(tsId)
    );
}

/** 内置校验：testcase_id 值必须符合案例唯一标识规范（UUID / TC+uuid.hex / MA+uuid.hex / testagent / testflow） */
const FORMAT_VALIDATOR: RowValidator = {
    kind: 'invalidFormat',
    severity: 'error',
    check(_row, tsId) {
        if (!isTestcaseIdValid(tsId)) {
            return {
                tsId,
                reason: 'testcase_id的值不符合案例唯一标识规范',
            };
        }
        return null;
    },
};

// -----------------------------------------------------------------------------
// 「待补充」字面量软拦截（B1 —— 案例内容未写完的最高优先级校验）
// -----------------------------------------------------------------------------
// 需求：《案例推送前置校验-待补充拦截需求文档》2.3.1 / 2.3.2 / 2.4.2
//   - 采用"极简子串命中"规则：字段值中只要出现"待补充"三字（不要求前后带「」），
//     即视为命中；不做语义判断，仅做字符串包含判定；
//   - 命中即视为"未写完"，属质量类软拦截：进入 failures 参与弹窗/高亮展示，
//     但**不进 droppedIndex**，行仍会被推送（由上层"忽略并继续"策略决定）；
//   - 后端接口无法拦截该字面量（对后端而言是合法字符串），因此本校验优先级最高。
//
// 兼容双键名场景：YAML 用英文键（name/description/preconditions/steps.*），
// CSV 用中文列名（名称/案例描述/前置条件/步骤描述/预期结果）。stepPreValidate 阶段
// 早于 normalizePushData，所以 row 保持源文件的原始键名，validator 需两套键名都扫。
// -----------------------------------------------------------------------------

/** 「待补充」子串关键字：极简模式，出现即命中（覆盖 `「待补充」`、`【待补充】`、裸文本 `待补充` 等所有写法）。 */
const TODO_PLACEHOLDER_LITERAL = '待补充';

/** 判断一个任意值（字符串 / 数组 / 对象）中是否存在「待补充」字面量。 */
function containsTodoPlaceholder(v: any): boolean {
    if (v == null) return false;
    if (typeof v === 'string') return v.indexOf(TODO_PLACEHOLDER_LITERAL) !== -1;
    if (Array.isArray(v)) {
        for (const item of v) {
            if (containsTodoPlaceholder(item)) return true;
        }
        return false;
    }
    if (typeof v === 'object') {
        for (const key of Object.keys(v)) {
            if (containsTodoPlaceholder((v as any)[key])) return true;
        }
        return false;
    }
    // number/boolean 等原始类型不可能含中文字面量，直接跳过
    return false;
}

/**
 * B4 · 结构化命中位置：细粒度定位到某步某子字段（stepIdx/subField 缺失时表示整字段命中）。
 * label 用于 reason 展示；field 用于兜底列级高亮；stepIdx/subField 用于 sub-td / dv2 精确高亮。
 */
interface TodoHitCell {
    label: string;
    field: PushInterfaceField;
    stepIdx?: number;
    subField?: PushSubField;
}

/**
 * 扫描一行数据，同时产出：
 *  - hitLabels：与旧 API 完全兼容的 reason 展示字符串数组
 *  - hitCells ：结构化命中数组，供 B4 sub-td / dv2 精确高亮消费
 *  - primaryField：同行多字段命中时保留旧口径，用于兜底 field
 */
function scanTodoPlaceholderFields(row: RowLike): { hitLabels: string[]; primaryField: PushInterfaceField | undefined; hitCells: TodoHitCell[] } {
    type LocateHit = { label: string; stepIdx?: number; subField?: PushSubField };
    const CHECKS: Array<{
        label: string;
        locate: (r: RowLike) => LocateHit[];
        field: PushInterfaceField;
    }> = [
        // 步骤（operation / data）：YAML 走 steps[]；CSV 走「步骤描述」整列
        {
            label: '步骤',
            locate: r => {
                const hits: LocateHit[] = [];
                const steps = (r as any)['steps'];
                if (Array.isArray(steps)) {
                    steps.forEach((s: any, idx: number) => {
                        if (s && typeof s === 'object') {
                            if (containsTodoPlaceholder(s.operation)) hits.push({ label: `第${idx + 1}步·步骤名称`, stepIdx: idx, subField: 'operation' });
                            if (containsTodoPlaceholder(s.data)) hits.push({ label: `第${idx + 1}步·数据`, stepIdx: idx, subField: 'data' });
                        }
                    });
                }
                if (containsTodoPlaceholder((r as any)['步骤描述'])) hits.push({ label: '' });
                return hits;
            },
            field: 'description',
        },
        // 预期结果（ui_expected / api_expected / db_expected）：YAML 走 steps[]；CSV 走「预期结果」整列
        {
            label: '预期结果',
            locate: r => {
                const hits: LocateHit[] = [];
                const steps = (r as any)['steps'];
                if (Array.isArray(steps)) {
                    steps.forEach((s: any, idx: number) => {
                        if (s && typeof s === 'object') {
                            if (containsTodoPlaceholder(s.ui_expected)) hits.push({ label: `第${idx + 1}步·UI检查`, stepIdx: idx, subField: 'ui_expected' });
                            if (containsTodoPlaceholder(s.api_expected)) hits.push({ label: `第${idx + 1}步·接口调用`, stepIdx: idx, subField: 'api_expected' });
                            if (containsTodoPlaceholder(s.db_expected)) hits.push({ label: `第${idx + 1}步·数据检查`, stepIdx: idx, subField: 'db_expected' });
                        }
                    });
                }
                if (containsTodoPlaceholder((r as any)['预期结果'])) hits.push({ label: '' });
                return hits;
            },
            field: 'expected',
        },
        // 前置条件：YAML 走 preconditions 数组（带下标）；CSV 走「前置条件」整列
        {
            label: '前置条件',
            locate: r => {
                const hits: LocateHit[] = [];
                const pre = (r as any)['preconditions'];
                if (Array.isArray(pre)) {
                    pre.forEach((item: any, idx: number) => {
                        if (containsTodoPlaceholder(item)) hits.push({ label: `第${idx + 1}条`, stepIdx: idx, subField: 'preCondition' });
                    });
                } else if (containsTodoPlaceholder(pre)) {
                    hits.push({ label: '' });
                }
                if (containsTodoPlaceholder((r as any)['前置条件'])) hits.push({ label: '' });
                return hits;
            },
            field: 'preCondition',
        },
        // 案例名称
        {
            label: '案例名称',
            locate: r => (containsTodoPlaceholder((r as any)['name']) || containsTodoPlaceholder((r as any)['名称'])) ? [{ label: '' }] : [],
            field: 'testCaseName',
        },
        // 案例描述
        {
            label: '案例描述',
            locate: r => (containsTodoPlaceholder((r as any)['description']) || containsTodoPlaceholder((r as any)['案例描述'])) ? [{ label: '' }] : [],
            field: 'testCaseDes',
        },
    ];
    // P4（2026-09-19）：可选字段「案例标签」—— 默认关闭（需求文档 §2.3.1），
    // 由配置 testcaseViewer.validate.checkTags 控制；开启后同样走「待补充」字面量匹配。
    if (getValidateFlag('checkTags')) {
        CHECKS.push({
            label: '案例标签',
            locate: r => (containsTodoPlaceholder((r as any)['tags']) || containsTodoPlaceholder((r as any)['案例标签'])) ? [{ label: '' }] : [],
            field: 'testCaseName', // 没有专用接口字段，先挂 testCaseName 作兵岭归类（前端仅用于列级兵岭高亮）
        });
    }
    const hitLabels: string[] = [];
    const hitCells: TodoHitCell[] = [];
    let primaryField: PushInterfaceField | undefined;
    for (const c of CHECKS) {
        const subHits = c.locate(row);
        if (subHits.length === 0) continue;
        if (!primaryField) primaryField = c.field;
        // 拼装展示：有具体子路径 → "标签(子路径)"；无（CSV/整字段命中）→ "标签"。
        const uniqLabels = Array.from(new Set(subHits.map(h => h.label)));
        const hasCoarse = uniqLabels.some(x => x === '');
        const fineOnly = uniqLabels.filter(x => x !== '');
        if (hasCoarse && fineOnly.length === 0) {
            hitLabels.push(c.label);
        } else {
            hitLabels.push(`${c.label}(${fineOnly.join('、')})`);
        }
        for (const h of subHits) {
            const seen = hitCells.find(x => x.field === c.field && x.stepIdx === h.stepIdx && x.subField === h.subField);
            if (seen) continue;
            hitCells.push({ label: h.label, field: c.field, stepIdx: h.stepIdx, subField: h.subField });
        }
    }
    return { hitLabels, primaryField, hitCells };
}

/**
 * 内置校验：「待补充」字面量软拦截。
 *
 * B4 升级：同行多字段命中时产出多条 failure（每次带 stepIdx/subField），供前端精细高亮。
 */
const TODO_PLACEHOLDER_VALIDATOR: RowValidator = {
    kind: 'todoPlaceholder',
    severity: 'warn',
    check(row, tsId) {
        const { hitLabels, primaryField } = scanTodoPlaceholderFields(row);
        if (hitLabels.length === 0) return null;
        return {
            tsId,
            reason: `案例内容含「待补充」，命中字段：${hitLabels.join('、')}；请完善后再推送`,
            field: primaryField,
        };
    },
    checkMulti(row, tsId) {
        const { hitLabels, hitCells } = scanTodoPlaceholderFields(row);
        if (hitLabels.length === 0 || hitCells.length === 0) return [];
        const reason = `案例内容含「待补充」，命中字段：${hitLabels.join('、')}；请完善后再推送`;
        return hitCells.map(cell => ({
            tsId,
            reason,
            field: cell.field,
            stepIdx: cell.stepIdx,
            subField: cell.subField,
        }));
    },
};

/** 内置校验器序列（按需扩展；语义即"按顺序对每行跑一遍所有校验"）。 */
export const DEFAULT_VALIDATORS: RowValidator[] = [
    PLACEHOLDER_VALIDATOR,
    EMPTY_VALIDATOR,
    FORMAT_VALIDATOR,
    ...B2_ERROR_VALIDATORS,       // B2：枚举取值 + 计划执行次数类型（error 级）
    TODO_PLACEHOLDER_VALIDATOR,   // B1：「待补充」字面量（warn 级，排在末尾）
];

/**
 * placeholder / empty / invalidFormat 三类是 **tsId 层面的必要条件**（tsId 不可用），
 * 若 tsId 都非法，后续基于 tsId 的字段级失败（enumInvalid 等）意义不大 —— 因此对这 3 类，
 * 仍保留"命中即 break"的旧行为，避免"tsId 缺失/非法"的行同时又刷出一堆字段级问题的噪音。
 */
const TSID_HARD_KINDS = new Set<string>(['placeholder', 'empty', 'invalidFormat']);

export function runValidators(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
    validators: RowValidator[] = DEFAULT_VALIDATORS,
): { failuresByKind: Record<string, PushFailureItem[]>; droppedIndex: Set<number> } {
    const failuresByKind: Record<string, PushFailureItem[]> = {};
    const droppedIndex = new Set<number>();
    if (!Array.isArray(rows)) return { failuresByKind, droppedIndex };

    for (let i = 0; i < rows.length; i++) {
        const rec = rows[i];
        const tsId = readTsId(rec);
        if (isSampleTsId(tsId)) continue;
        let tsIdHardHit = false;
        for (const v of validators) {
            if (tsIdHardHit) break;
            const hits: Array<Omit<PushFailureItem, 'rowIndex'>> = [];
            if (typeof v.checkMulti === 'function') {
                const arr = v.checkMulti(rec, tsId);
                if (Array.isArray(arr) && arr.length > 0) hits.push(...arr);
            } else {
                const single = v.check(rec, tsId);
                if (single) hits.push(single);
            }
            if (hits.length === 0) continue;

            const rowIndex = resolveRowIndex(i);
            const severity: 'error' | 'warn' = v.severity === 'warn' ? 'warn' : 'error';
            const usedMulti = typeof v.checkMulti === 'function' && hits.length > 1;
            if (usedMulti) {
                const primary = hits[0];
                const item: PushFailureItem = {
                    tsId: v.kind === 'empty' ? `__EMPTY_TSID_ROW_${rowIndex}__` : primary.tsId,
                    reason: primary.reason,
                    rowIndex,
                    category: classifyFailure({ reason: primary.reason, validatorKind: v.kind }),
                    field: primary.field ?? failureFieldOf({ reason: primary.reason, validatorKind: v.kind }),
                    severity,
                    stepIdx: primary.stepIdx,
                    subField: primary.subField,
                    hits: hits.map(h => ({ field: h.field, stepIdx: h.stepIdx, subField: h.subField })),
                };
                (failuresByKind[v.kind] ||= []).push(item);
            } else {
                for (const hit of hits) {
                    const item: PushFailureItem = {
                        tsId: v.kind === 'empty' ? `__EMPTY_TSID_ROW_${rowIndex}__` : hit.tsId,
                        reason: hit.reason,
                        rowIndex,
                        category: classifyFailure({ reason: hit.reason, validatorKind: v.kind }),
                        field: hit.field ?? failureFieldOf({ reason: hit.reason, validatorKind: v.kind }),
                        severity,
                        stepIdx: hit.stepIdx,
                        subField: hit.subField,
                    };
                    (failuresByKind[v.kind] ||= []).push(item);
                }
            }

            if (severity === 'error') {
                droppedIndex.add(i);
                if (TSID_HARD_KINDS.has(v.kind)) {
                    tsIdHardHit = true;
                }
            }
        }
    }
    return { failuresByKind, droppedIndex };
}

export function collectPlaceholderTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [PLACEHOLDER_VALIDATOR]).failuresByKind['placeholder'] || [];
}

export function collectEmptyTestcaseIdFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [EMPTY_VALIDATOR]).failuresByKind['empty'] || [];
}

export function collectInvalidFormatFailures(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
): PushFailureItem[] {
    return runValidators(rows, resolveRowIndex, [FORMAT_VALIDATOR]).failuresByKind['invalidFormat'] || [];
}

// =============================================================
// B3 · 编辑期主动校验入口（纯函数版本）
// =============================================================
/**
 * 纯校验函数：对一批行跑一遍 DEFAULT_VALIDATORS，返回扁平化 failures（含 severity）。
 * - 与 stepPreValidate 的差异：无埋点、无落盘、无阶段化字段（不返回 droppedIndex），
 *   只做「行 → 失败清单」的纯映射；供编辑期 handler 与推送时共用同一套规则。
 * - 排序与 stepPreValidate 一致：error 级在前，warn 级在后。
 */
export function runValidatorsOnRowsPure(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
    validators: RowValidator[] = DEFAULT_VALIDATORS,
): PushFailureItem[] {
    const { failuresByKind } = runValidators(rows, resolveRowIndex, validators);
    return [
        ...(failuresByKind['placeholder'] || []),
        ...(failuresByKind['empty'] || []),
        ...(failuresByKind['invalidFormat'] || []),
        ...(failuresByKind['enumInvalid'] || []),
        ...(failuresByKind['planExecNumInvalid'] || []),
        ...(failuresByKind['todoPlaceholder'] || []),
    ];
}
