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
    kind: 'placeholder' | 'empty' | 'todoPlaceholder' | 'nameEmpty' | (string & {});
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

/**
 * 判断一个值（字符串 / 字符串数组）中是否存在「待补充」字面量。
 *
 * 性能优化（P2 · 2026-09-19）：
 *   · 早期版本对 `typeof === 'object'` 做 Object.keys 深度递归兜底，
 *     以便对"未知形态"数据也能扫到「待补充」。
 *   · 但 scanTodoPlaceholderFields 内的 CHECKS 已**穷举列出**所有关心的字段路径
 *     （steps[i].operation/data/ui_expected/api_expected/db_expected、
 *      preconditions[i]、description/案例描述、以及 CSV 列 步骤描述/预期结果/前置条件），
 *     每个字段都是 string 或 string[] 类型，永远不会走到"深度递归"分支。
 *   · 保留递归反而会在 steps[i] 对象中把 testcase_id/pre/post/remark 等无关字段
 *     全遍历一遍——大文件（1 万行 × 20 步 × 8 key）会产生 160w+ 次冗余 indexOf。
 *   · 因此本次退化为"仅处理 string / string[] 两种类型"，其它类型直接返回 false。
 */
function containsTodoPlaceholder(v: any): boolean {
    if (v == null) return false;
    if (typeof v === 'string') return v.indexOf(TODO_PLACEHOLDER_LITERAL) !== -1;
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
            const item = v[i];
            if (item == null) continue;
            if (typeof item === 'string') {
                if (item.indexOf(TODO_PLACEHOLDER_LITERAL) !== -1) return true;
            }
            // 非 string 元素（object / number / boolean 等）跳过：
            //   CHECKS 中的字段位置均为 string 或 string[]，不会出现嵌套对象数组。
        }
        return false;
    }
    // number / boolean / object 等类型不参与「待补充」判定：
    //   · 原始类型不可能含中文字面量；
    //   · object 类型场景已被 scanTodoPlaceholderFields 显式路径覆盖，
    //     深度递归属于冗余的历史兜底，被 P2 优化移除。
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
        // 步骤描述（operation / data）：YAML 走 steps[]；CSV 走「步骤描述」整列
        // label 与 CSV 现网列名保持一致（避免 hover 提示"步骤"与实际列名"步骤描述"不符）
        {
            label: '步骤描述',
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
        // 案例描述
        {
            label: '案例描述',
            locate: r => (containsTodoPlaceholder((r as any)['description']) || containsTodoPlaceholder((r as any)['案例描述'])) ? [{ label: '' }] : [],
            field: 'testCaseDes',
        },
    ];
    // 说明（2026-09-19 需求变更）：
    //   · 案例名称改走 NAME_EMPTY_VALIDATOR（error 级 · 非空校验），不再纳入本扫描；
    //   · 案例标签（tags）不再进行任何校验（需求确认移除 D6）。
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
            // 文案精简（2026-09-19）：去掉"；请完善后再推送"尾巴，行为指引已由弹窗组头/该轻拦截行为本身传达。
            reason: `案例内容含「待补充」，命中字段：${hitLabels.join('、')}`,
            field: primaryField,
        };
    },
    checkMulti(row, tsId) {
        const { hitLabels, hitCells } = scanTodoPlaceholderFields(row);
        if (hitLabels.length === 0 || hitCells.length === 0) return [];
        const reason = `案例内容含「待补充」，命中字段：${hitLabels.join('、')}`;
        // B5 · 字段级独立 reason：为每个 hit 生成"只讲自身位置"的 singleReason，
        //   供前端 hover 单元格时只显示该单元格自己的问题（而非行级合并 reason）。
        //   语义：无子路径 label → "案例内容含「待补充」（案例描述）"；
        //         有子路径 label → "案例内容含「待补充」（第 1 步·步骤名称）"。
        return hitCells.map(cell => {
            // 字段中文标签：与 CSV 现网列名严格对齐（步骤描述 / 预期结果 / 前置条件 / 案例描述），
            //   避免 hover 提示与用户在文件中看到的列名不一致；testCaseName 保留业务术语「案例名称」，
            //   与 NAME_EMPTY_VALIDATOR reason"案例名称未填写"及产品语境一致。
            const fieldLabel = ({
                description: '步骤描述',
                expected: '预期结果',
                preCondition: '前置条件',
                testCaseDes: '案例描述',
                testCaseName: '案例名称',
            } as Record<string, string>)[cell.field] || cell.field;
            const posLabel = cell.label && cell.label !== '' ? `${fieldLabel}·${cell.label}` : fieldLabel;
            return {
                tsId,
                reason,
                field: cell.field,
                stepIdx: cell.stepIdx,
                subField: cell.subField,
                singleReason: `案例内容含「待补充」（${posLabel}）`,
            } as any;
        });
    },
};

// -----------------------------------------------------------------------------
// 案例名称非空校验（D4 · 2026-09-19 error 级硬拦截）
// -----------------------------------------------------------------------------
// 需求变更：案例名称（name / 「名称」）由"文本『待补充』匹配"升级为"非空校验"，
// 属推送必备条件之一（空名称将导致 TMS 拒绝）。
//   · 兼容策略（对齐 ENUM_VALIDATOR）：字段完全缺省（YAML 键 & CSV 列都 undefined）
//     → 跳过校验，避免误伤未使用该字段的旧模板；
//   · 字段存在但为空串 / 仅空白字符 → 判为 error 级不合法，行从 payload 剔除。
// -----------------------------------------------------------------------------
const NAME_EMPTY_VALIDATOR: RowValidator = {
    kind: 'nameEmpty',
    severity: 'error',
    check(row, tsId) {
        const y = (row as any)?.['name'];
        const c = (row as any)?.['名称'];
        // 字段完全缺省（yaml 键 & csv 列都 undefined）→ 跳过校验
        if (y === undefined && c === undefined) return null;
        const raw = (y !== undefined && y !== null) ? y : c;
        const s = raw == null ? '' : String(raw).trim();
        if (s !== '') return null;
        return {
            tsId,
            // 文案精简（2026-09-19）：去掉"，将导致推送校验失败：请补充后再推送"尾巴，保留事实描述即可。
            reason: '案例名称未填写',
            field: 'testCaseName',
        };
    },
};

/** 内置校验器序列（按需扩展；语义即"按顺序对每行跑一遍所有校验"）。 */
export const DEFAULT_VALIDATORS: RowValidator[] = [
    PLACEHOLDER_VALIDATOR,
    EMPTY_VALIDATOR,
    FORMAT_VALIDATOR,
    ...B2_ERROR_VALIDATORS,       // B2：枚举取值 + 计划执行次数类型（error 级）
    NAME_EMPTY_VALIDATOR,         // D4：案例名称非空（error 级）
    TODO_PLACEHOLDER_VALIDATOR,   // B1：「待补充」字面量（warn 级，排在末尾）
];

// -----------------------------------------------------------------------------
// D5 · 案例唯一性：同文件内 (name, path) 组合重复校验（2026-09-19 新增 · error 级硬拦截）
// -----------------------------------------------------------------------------
// 需求：同一份案例文件中，若两条案例的 (案例名称, 案例路径) 完全相同，则均视为
// 重复案例，均标记为 error，只标红 `name`/`名称` 单元格；`path`/「路径」列不标红。
//
// 与其它 validator 的差异：本校验属于"跨行聚合"，无法在 RowValidator 单行签名内
// 完成，因此提取为独立的 batch 扫描函数，在 runValidators 主循环外先算出"重复行集"，
// 再在主循环中对命中行插入一条 failure。
//
// 归一化规则（与 NAME_EMPTY_VALIDATOR 对齐）：
//   · name  : yaml `name`  → csv 「名称」（trim 后比较，大小写敏感）
//   · path  : yaml `path`  → csv 「路径」（trim 后比较，大小写敏感）
//   · 缺省与空值不参与去重（避免误判：多条"名称都为空"被强报"重复"，
//     空名称由 NAME_EMPTY_VALIDATOR 单独处理）
// -----------------------------------------------------------------------------
function _readNameFieldRaw(row: RowLike): string {
    const y = (row as any)?.['name'];
    const c = (row as any)?.['名称'];
    const raw = (y !== undefined && y !== null) ? y : c;
    return raw == null ? '' : String(raw).trim();
}
function _readPathFieldRaw(row: RowLike): string {
    const y = (row as any)?.['path'];
    const c = (row as any)?.['路径'];
    const raw = (y !== undefined && y !== null) ? y : c;
    return raw == null ? '' : String(raw).trim();
}

/**
 * 扫描整批行，返回"命中重复(name, path)组"的行索引集合。
 *   · 输入索引 = rows 数组的原始 index i（与 runValidators 主循环 for i 对齐）
 *   · 名称或路径为空的行**不参与**重复判定（避免与 NAME_EMPTY_VALIDATOR 语义冲突）
 *   · 同一 (name, path) 组内所有行均被标红（并非仅"第二次出现"）
 */
function scanDuplicateNameRows(rows: RowLike[]): Set<number> {
    const dup = new Set<number>();
    if (!Array.isArray(rows) || rows.length < 2) return dup;
    // 桶：key = `${name}\u0001${path}` → 索引数组
    const bucket: Record<string, number[]> = Object.create(null);
    for (let i = 0; i < rows.length; i++) {
        const rec = rows[i];
        if (!rec) continue;
        // 样例行不参与（与 runValidators 主循环 isSampleTsId 跳过口径一致）
        const tsId = readTsId(rec);
        if (isSampleTsId(tsId)) continue;
        const name = _readNameFieldRaw(rec);
        const path = _readPathFieldRaw(rec);
        // 名称或路径任一为空 → 跳过（不参与重复判定）
        if (name === '' || path === '') continue;
        // 使用不可见字符 \u0001 作分隔符，避免 name 里含 '|' 等常见字符导致的键冲突
        const key = `${name}\u0001${path}`;
        (bucket[key] || (bucket[key] = [])).push(i);
    }
    for (const key of Object.keys(bucket)) {
        const arr = bucket[key];
        if (arr.length >= 2) {
            for (const i of arr) dup.add(i);
        }
    }
    return dup;
}

/**
 * empty / placeholder 两类保留"命中即 break"：
 *  · empty      —— testcase_id 完全为空，会退化成 `__EMPTY_TSID_ROW_i__` 伪 ID，
 *                   再叠加一堆字段级 failure 只会让弹窗噪音爆炸；
 *  · placeholder —— 值恰好是占位串 `TESTCASE_ID`，逻辑上是"未填写"的一种特化标签，
 *                   实际也会命中 invalidFormat，若不 break 会同一行叠 2 条 tsId 层 reason。
 *
 * 变更（2026-09-19，需求方案 B）：invalidFormat 不再纳入硬 break —
 * 用户诉求为"打开文件即能一次性看见所有问题（枚举非法 / 待补充 / 名称空 …）"，
 * 而非"先修 testcase_id、再回来看其它问题"的两轮体验；测试案例中 400 行 uuid 格式
 * 全部非法却导致「待补充」被吞掉的场景即由此产生，改后同一行会同时暴露 tsId 格式
 * 与其它字段级问题，用户可一次性修完。
 */
const TSID_HARD_KINDS = new Set<string>(['empty', 'placeholder']);

export function runValidators(
    rows: RowLike[],
    resolveRowIndex: (i: number) => number,
    validators: RowValidator[] = DEFAULT_VALIDATORS,
): { failuresByKind: Record<string, PushFailureItem[]>; droppedIndex: Set<number> } {
    const failuresByKind: Record<string, PushFailureItem[]> = {};
    const droppedIndex = new Set<number>();
    if (!Array.isArray(rows)) return { failuresByKind, droppedIndex };

    // D5 · 批级扫描：先算出"命中 (name, path) 重复"的行索引集合（i 与主循环 for i 对齐）。
    //   跨行判定必须在整批粒度做，因此从单行 validator 剥离，改由 runValidators 统一注入 failure。
    //   仅在 DEFAULT_VALIDATORS 走全量模式（含此 kind）时执行；测试/工具函数指定单 validator 时跳过。
    const enableDuplicateCheck = validators === DEFAULT_VALIDATORS
        || validators.some(v => v && v.kind === 'duplicateName');
    const duplicateRowSet = enableDuplicateCheck ? scanDuplicateNameRows(rows) : new Set<number>();

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
            const validatorSeverity: 'error' | 'warn' = v.severity === 'warn' ? 'warn' : 'error';
            // 支持命中项级 severity 覆盖（如 ENUM_VALIDATOR 的 type 字段为 warn 级）：
            //   check/checkMulti 返回的 hit 若显式带 severity 则优先，否则回退 validator 级别。
            const hitSeverity = (h: Omit<PushFailureItem, 'rowIndex'>): 'error' | 'warn' =>
                h.severity ?? validatorSeverity;
            const usedMulti = typeof v.checkMulti === 'function' && hits.length > 1;
            if (usedMulti) {
                const primary = hits[0];
                // 合并条目取最严重级：任一命中为 error → 整条 error（该行剔除）
                const severity: 'error' | 'warn' = hits.some(h => hitSeverity(h) === 'error') ? 'error' : 'warn';
                const item: PushFailureItem = {
                    tsId: v.kind === 'empty' ? `__EMPTY_TSID_ROW_${rowIndex}__` : primary.tsId,
                    reason: primary.reason,
                    rowIndex,
                    category: classifyFailure({ reason: primary.reason, validatorKind: v.kind }),
                    field: primary.field ?? failureFieldOf({ reason: primary.reason, validatorKind: v.kind }),
                    severity,
                    stepIdx: primary.stepIdx,
                    subField: primary.subField,
                    hits: hits.map(h => ({ field: h.field, stepIdx: h.stepIdx, subField: h.subField, singleReason: (h as any).singleReason })),
                };
                (failuresByKind[v.kind] ||= []).push(item);
                if (severity === 'error') {
                    droppedIndex.add(i);
                    if (TSID_HARD_KINDS.has(v.kind)) {
                        tsIdHardHit = true;
                    }
                }
            } else {
                for (const hit of hits) {
                    const severity = hitSeverity(hit);
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
                    if (severity === 'error') {
                        droppedIndex.add(i);
                        if (TSID_HARD_KINDS.has(v.kind)) {
                            tsIdHardHit = true;
                        }
                    }
                }
            }
        }

        // D5 · 案例唯一性 failure 注入：本行命中"重复 (name, path)"组时，追加一条 error 级 failure。
        //   与其它 validator 相同：走 field='testCaseName' 精确定位 → 前端仅红 name/名称 列。
        //   若 tsId 层已硬拦截（empty/placeholder），本轮已 break 退出上面 for v，
        //   此处仍走独立分支：即使 tsId 是伪 ID，重复也应展现（用户可通过复制"文件路径+行号"定位）。
        if (duplicateRowSet.has(i)) {
            const rowIndex = resolveRowIndex(i);
            const nameVal = _readNameFieldRaw(rec);
            const reasonText = `重复案例名称：同文件内已存在相同 (名称, 路径) 的案例「${nameVal}」`;
            const item: PushFailureItem = {
                tsId: tsId === '' ? `__EMPTY_TSID_ROW_${rowIndex}__` : tsId,
                reason: reasonText,
                rowIndex,
                category: classifyFailure({ reason: reasonText, validatorKind: 'duplicateName' }),
                field: 'testCaseName',
                severity: 'error',
            };
            (failuresByKind['duplicateName'] ||= []).push(item);
            droppedIndex.add(i);
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
        // §2.3.5：结构性错误优先展示（编辑期与推送期同口径）
        ...(failuresByKind['missingColumn'] || []),
        ...(failuresByKind['placeholder'] || []),
        ...(failuresByKind['empty'] || []),
        ...(failuresByKind['invalidFormat'] || []),
        ...(failuresByKind['enumInvalid'] || []),
        ...(failuresByKind['planExecNumInvalid'] || []),
        ...(failuresByKind['nameEmpty'] || []),
        // D5 · 案例唯一性 error 与其它 error 级同层展示（排在同类 error 尾部）
        ...(failuresByKind['duplicateName'] || []),
        ...(failuresByKind['todoPlaceholder'] || []),
    ];
}
