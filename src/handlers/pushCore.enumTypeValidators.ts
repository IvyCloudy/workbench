/**
 * pushCore.enumTypeValidators.ts —— 案例内容合法性校验器（B2 · 强制阻断）
 * -----------------------------------------------------------------------------
 * 需求来源：《案例推送前置校验-待补充拦截需求文档》2.3.3 / 2.3.4 / 2.4.2
 *
 * 交付两类"失败类"（severity='error'）校验器，命中即从 payload 剔除：
 *   1. ENUM_VALIDATOR         —— 枚举字段取值合法性
 *      · 案例类型   type       ↔ csv「案例类型」  ：功能点类 / 流程类 / 界面类 / …
 *      · 执行方式   test_type  ↔ csv「执行方式」  ：手工 / 自动化
 *      · 优先级     priority   ↔ csv「优先级」    ：高 / 中 / 低
 *      · 关键标识   key_flag   ↔ csv「关键标识」  ：是 / 否 / 0 / 1
 *   2. PLAN_EXEC_NUM_VALIDATOR —— 数据类型字段（计划执行次数 plan_exec_num）
 *      · 必须为非负整数（含 0）；空 / 文本 / 负数 / 小数 均判为不合法
 *
 * 设计决策：
 *   · 双键名兼容：YAML 用英文键、CSV 用中文列名，两套都要扫（stepPreValidate 早于
 *     normalizePushData，row 仍保持源文件原始键名）。
 *   · 空值容忍：需求 2.3.3 明确"字段为空视为不合法"，因此空串/undefined/null 也命中；
 *     但需支持"未填写该字段的旧文件推送"这类兼容性场景 —— 由 requireEnums 开关控制，
 *     当前默认 requireEnums=true，与需求 2.3.3 一致。
 *   · 命中即 break：这两个 validator 都是 error 级，与已有的 tsId 硬拦截行为一致；
 *     与 warn 级「待补充」互斥（同一行仅暴露最严重的问题），跨行仍可共存。
 *   · reason 文案模板：`案例{字段中文名}取值不合法：{当前值}，应为 {合法集合/类型}`，
 *     与"待补充"文案风格保持一致，便于前端 05g 列表统一渲染。
 *
 * 允许取值集合（当前 B2 版本落地值 —— 需求文档中以 "…" 标注为"待系统枚举确认"，
 * 这里采用与用户对齐后的默认值，后续可通过配置替换）：
 *   TYPE_VALUES / TEST_TYPE_VALUES / PRIORITY_VALUES / KEY_FLAG_VALUES
 * 未来如需按团队/项目动态化，可将 ENUM_VALIDATOR 拆为工厂函数接收配置，
 * 但需保留"命中即 break、severity=error"的核心语义。
 */

// 2026-09-19 解耦：改为直接引用 preValidate 与 pushCore.types，
// 避免与迁移后的 pushCore.stages(barrel) 形成循环依赖（本文件被 preValidate/validators.ts 引用）。
import type { RowLike } from './pushCore.types';
import type { RowValidator } from '../preValidate/validators';
import type { PushInterfaceField } from '../utils/pushFailureCategory';

/** 案例类型（`type` / 「案例类型」）合法取值 —— 与 TMS 系统枚举对齐。 */
export const TYPE_VALUES: readonly string[] = [
    '功能点类', '流程类', '界面类', '性能类', '接口类', '兼容性类', '易用性类', '安全类', '其他',
];

/** 执行方式（`test_type` / 「执行方式」）合法取值。 */
export const TEST_TYPE_VALUES: readonly string[] = ['手工', '自动化'];

/** 优先级（`priority` / 「优先级」）合法取值。 */
export const PRIORITY_VALUES: readonly string[] = ['高', '中', '低'];

/** 关键标识（`key_flag` / 「关键标识」）合法取值（兼容中文与 0/1 双写法）。 */
export const KEY_FLAG_VALUES: readonly string[] = ['是', '否', '0', '1'];

/** 单个枚举字段的校验规则条目。 */
interface EnumFieldRule {
    /** YAML 键名（英文），如 `type` / `test_type` / `priority` / `key_flag` */
    yamlKey: string;
    /** CSV 列名（中文），与 headerLabels.json 对齐 */
    csvKey: string;
    /** 中文字段名，用于 reason 文案 */
    label: string;
    /** 合法取值集合（大小写敏感 + 去除首尾空格后比较） */
    allowed: readonly string[];
    /** 归一化到的接口字段码（用于埋点下钻 & 前端字段级高亮） */
    field: PushInterfaceField;
}

/** 4 项枚举字段规则表 —— 顺序即 reason 拼装顺序（同行多字段命中时按此顺序汇总）。 */
const ENUM_RULES: readonly EnumFieldRule[] = [
    { yamlKey: 'type',       csvKey: '案例类型',   label: '案例类型',   allowed: TYPE_VALUES,       field: 'type'    },
    { yamlKey: 'test_type',  csvKey: '执行方式',   label: '执行方式',   allowed: TEST_TYPE_VALUES,  field: 'testType'},
    { yamlKey: 'priority',   csvKey: '优先级',     label: '优先级',     allowed: PRIORITY_VALUES,   field: 'priority'},
    { yamlKey: 'key_flag',   csvKey: '关键标识',   label: '关键标识',   allowed: KEY_FLAG_VALUES,   field: 'keyFlag' },
];

/**
 * 从行对象读取"某枚举字段"的原始值（YAML 键优先，CSV 中文列名兜底）。
 * 值经过 trim；空值/undefined/null 返回空串（由调用方决定是否算命中）。
 */
function readEnumRaw(row: RowLike, rule: EnumFieldRule): string {
    const y = (row as any)?.[rule.yamlKey];
    const c = (row as any)?.[rule.csvKey];
    const raw = (y !== undefined && y !== null && y !== '') ? y : c;
    if (raw === undefined || raw === null) return '';
    return String(raw).trim();
}

/**
 * 判断行对象是否"完全没有"某枚举字段（YAML 键 & CSV 列都 undefined）。
 * 用于兼容旧模板文件 —— 若源文件根本没这个字段，跳过校验避免误伤；
 * 而"字段存在但值为空串（`type: ""`）"仍会判为不合法，符合需求 2.3.3 语义。
 */
function isEnumFieldAbsent(row: RowLike, rule: EnumFieldRule): boolean {
    const y = (row as any)?.[rule.yamlKey];
    const c = (row as any)?.[rule.csvKey];
    return y === undefined && c === undefined;
}

/** 判断字符串值是否落在 allowed 集合内（严格相等，不做同义词/别名归一化）。 */
function isAllowedEnum(val: string, allowed: readonly string[]): boolean {
    if (val === '') return false; // 值为空串（如 `type: ""`）判定为不合法（需求 2.3.3）
    return allowed.indexOf(val) !== -1;
}

/**
 * 枚举字段校验器（B2 · error 级）。
 *
 * 兼容策略（字段缺省时跳过）：
 *   - 若某枚举字段在源文件中"完全没有"（YAML 键 & CSV 列都 undefined）→ 跳过该字段，
 *     避免对未使用该字段的旧模板文件误伤；这不违背需求 2.3.3，因为该条款
 *     针对的是"字段被填写但值不合法"的场景。
 *   - 若字段存在但值为空串（`type: ""` / CSV 列存在但值为空）→ 判为不合法。
 *
 * 同行多字段命中时汇总为一条（reason 列出所有不合法字段与建议取值），
 * field 取"第一个命中的字段"（对应埋点主字段维度）。
 */
export const ENUM_VALIDATOR: RowValidator = {
    kind: 'enumInvalid',
    severity: 'error',
    check(row, tsId) {
        const hits: string[] = [];
        let primaryField: PushInterfaceField | undefined;
        for (const rule of ENUM_RULES) {
            if (isEnumFieldAbsent(row, rule)) continue; // 完全缺省 → 跳过（兼容旧文件）
            const val = readEnumRaw(row, rule);
            if (!isAllowedEnum(val, rule.allowed)) {
                if (!primaryField) primaryField = rule.field;
                const shown = val === '' ? '空' : `"${val}"`;
                hits.push(`${rule.label}=${shown}（应为 ${rule.allowed.join('/')})`);
            }
        }
        if (hits.length === 0) return null;
        return {
            tsId,
            reason: `案例存在枚举字段取值不合法，将导致推送校验失败：${hits.join('；')}`,
            field: primaryField,
        };
    },
};

// -----------------------------------------------------------------------------
// 计划执行次数（plan_exec_num）—— 数据类型校验（B2 · error 级）
// -----------------------------------------------------------------------------

/** 判断值是否为"非负整数"。允许类型：number（非小数 & ≥0）/ 字符串数字。 */
function isNonNegativeInteger(v: any): boolean {
    if (typeof v === 'number') {
        return Number.isFinite(v) && Number.isInteger(v) && v >= 0;
    }
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return false;
        // 只允许纯数字字符（去除首尾空白后）；避免 Number("1e2")=100、Number(" 1 ")=1 等隐式转换
        if (!/^\d+$/.test(s)) return false;
        const n = Number(s);
        return Number.isFinite(n) && n >= 0;
    }
    return false;
}

/**
 * 计划执行次数校验器（B2 · error 级）。
 * 允许缺省：若该字段在源文件中根本不存在（undefined），则跳过校验，避免误伤未使用该字段的旧文件。
 * 出现即校验：只要字段存在（含空串），就必须是非负整数。
 */
export const PLAN_EXEC_NUM_VALIDATOR: RowValidator = {
    kind: 'planExecNumInvalid',
    severity: 'error',
    check(row, tsId) {
        const y = (row as any)?.['plan_exec_num'];
        const c = (row as any)?.['计划执行次数'];
        const rawExists = (y !== undefined && y !== null) || (c !== undefined && c !== null);
        if (!rawExists) return null; // 字段完全缺省 → 跳过校验（不当作错误）
        const v = (y !== undefined && y !== null) ? y : c;
        if (isNonNegativeInteger(v)) return null;
        const shown = (v === '' || v === undefined || v === null) ? '空' : `"${String(v)}"`;
        return {
            tsId,
            reason: `案例的计划执行次数取值不合法，将导致推送校验失败：${shown}（应为非负整数）`,
            field: 'planExecNum',
        };
    },
};

/** 一次性导出 B2 全部 error 级校验器（枚举 + 类型），供 stages.ts 顺序注册。 */
export const B2_ERROR_VALIDATORS: readonly RowValidator[] = [
    ENUM_VALIDATOR,
    PLAN_EXEC_NUM_VALIDATOR,
];
