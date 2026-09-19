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
 *      · 关键案例   key_flag   ↔ csv「关键案例」  ：是 / 否 / 0 / 1
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
 * 允许取值集合（2026-09-19 P0 修复）：
 *   · 运行时通过 utils/caseEnumValues.getEnumValues(field) 动态读取，
 *     与推送映射层 pushDataMapper 共用同一份配置源（package.json "testcaseViewer.enum.*"）；
 *   · 为保持向后兼容（老测试直接引用了 TYPE_VALUES / KEY_FLAG_VALUES 等常量），
 *     仍保留同名 export，但值改为 getEnumValues 的"当前快照"（首次读取时求值）；
 * 未来如需按团队/项目动态化，直接在 settings.json 覆盖 testcaseViewer.enum.* 即可。
 */

// 2026-09-19 解耦：改为直接引用 preValidate 与 pushCore.types，
// 避免与迁移后的 pushCore.stages(barrel) 形成循环依赖（本文件被 preValidate/validators.ts 引用）。
import type { RowLike } from './pushCore.types';
import type { RowValidator } from '../preValidate/validators';
import type { PushInterfaceField } from '../utils/pushFailureCategory';
import { getEnumValues } from '../utils/caseEnumValues';

/**
 * 从配置中拉取「关键案例」合法取值（严格按 testcaseViewer.enum.keyFlag 为准，默认仅「是/否」）。
 * 2026-09-19：根据需求调整，移除旧 CSV 的 0/1 兵岭，keyFlag 完全以配置清单为准。
 * 单独抽出方法便于测试注入 & 与 pushDataMapper 行为一致。
 */
function readKeyFlagValues(): readonly string[] {
    return getEnumValues('keyFlag');
}

/**
 * 案例类型（`type` / 「案例类型」）合法取值 —— @deprecated 请优先使用 getEnumValues('caseType')。
 * 保留 export 是为了向后兼容既有单测（如 pushCoreEnumTypeValidators.test.ts）。
 * 首次求值 = 模块加载时的 VSCode 配置快照；运行期以 getEnumValues 为准。
 */
export const TYPE_VALUES: readonly string[] = getEnumValues('caseType');

/** 执行方式（`test_type` / 「执行方式」）合法取值 —— @deprecated 请优先使用 getEnumValues('testType')。 */
export const TEST_TYPE_VALUES: readonly string[] = getEnumValues('testType');

/** 优先级（`priority` / 「优先级」）合法取值 —— @deprecated 请优先使用 getEnumValues('priority')。 */
export const PRIORITY_VALUES: readonly string[] = getEnumValues('priority');

/** 关键案例（`key_flag` / 「关键案例」）合法取值—— @deprecated 请优先使用 readKeyFlagValues()。 */
export const KEY_FLAG_VALUES: readonly string[] = readKeyFlagValues();

/** 单个枚举字段的校验规则条目。 */
interface EnumFieldRule {
    /** YAML 键名（英文），如 `type` / `test_type` / `priority` / `key_flag` */
    yamlKey: string;
    /** CSV 列名（中文），主用列名（与 package.json headerLabels 及现网 CSV 模板对齐） */
    csvKey: string;
    /** CSV 兼容列名（可选，保留扩展点，当前无差异） */
    csvKeyAlt?: string;
    /** 中文字段名，用于 reason 文案 */
    label: string;
    /** 合法取值集合读取器（运行时读取，保证 settings.json 变更实时生效） */
    readAllowed: () => readonly string[];
    /** 归一化到的接口字段码（用于埋点下钻 & 前端字段级高亮） */
    field: PushInterfaceField;
}

/**
 * 4 项枚举字段规则表 —— 顺序即 reason 拼装顺序（同行多字段命中时按此顺序汇总）。
 * P0 修复（2026-09-19）：allowed 改为 readAllowed 惰性求值，与 pushDataMapper 共用同一份配置源。
 * 注意：4 个中文列名与 package.json 的 headerLabels 及 media/pages/table-editor 现网列头保持严格一致；
 *       其中 keyFlag 的中文名以代码/CSV 现实为准 = 「关键案例」（需求文档的「关键标识」为历史草稿用词）。
 */
const ENUM_RULES: readonly EnumFieldRule[] = [
    { yamlKey: 'type',       csvKey: '案例类型',   label: '案例类型',   readAllowed: () => getEnumValues('caseType'),  field: 'type'    },
    { yamlKey: 'test_type',  csvKey: '执行方式',   label: '执行方式',   readAllowed: () => getEnumValues('testType'),  field: 'testType'},
    { yamlKey: 'priority',   csvKey: '优先级',     label: '优先级',     readAllowed: () => getEnumValues('priority'),  field: 'priority'},
    { yamlKey: 'key_flag',   csvKey: '关键案例',   label: '关键案例',   readAllowed: readKeyFlagValues,                field: 'keyFlag' },
];

/**
 * 从行对象读取"某枚举字段"的原始值（YAML 键优先，CSV 主列名兜底，兼容旧列名 csvKeyAlt）。
 * 值经过 trim；空值/undefined/null 返回空串（由调用方决定是否算命中）。
 */
function readEnumRaw(row: RowLike, rule: EnumFieldRule): string {
    const y = (row as any)?.[rule.yamlKey];
    const c = (row as any)?.[rule.csvKey];
    const cAlt = rule.csvKeyAlt ? (row as any)?.[rule.csvKeyAlt] : undefined;
    // 优先级：YAML 英文键 > CSV 主列名 > CSV 兼容旧列名
    let raw: any;
    if (y !== undefined && y !== null && y !== '') raw = y;
    else if (c !== undefined && c !== null && c !== '') raw = c;
    else if (cAlt !== undefined && cAlt !== null && cAlt !== '') raw = cAlt;
    else raw = (y !== undefined ? y : (c !== undefined ? c : cAlt));
    if (raw === undefined || raw === null) return '';
    return String(raw).trim();
}

/**
 * 判断行对象是否"完全没有"某枚举字段（YAML 键 & CSV 主/旧列名都 undefined）。
 * 用于兼容旧模板文件 —— 若源文件根本没这个字段，跳过校验避免误伤；
 * 而"字段存在但值为空串（`type: ""`）"仍会判为不合法，符合需求 2.3.3 语义。
 */
function isEnumFieldAbsent(row: RowLike, rule: EnumFieldRule): boolean {
    const y = (row as any)?.[rule.yamlKey];
    const c = (row as any)?.[rule.csvKey];
    const cAlt = rule.csvKeyAlt ? (row as any)?.[rule.csvKeyAlt] : undefined;
    return y === undefined && c === undefined && cAlt === undefined;
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
/**
 * 内部：扫描一行的全部枚举字段，返回命中明细。
 * 与 check / checkMulti 共用，保证两条通路的判定逻辑严格一致。
 *   · hitLabels ：用于 reason 汇总话术（保持"命中即列全部"的旧口径）
 *   · hitFields ：每个命中字段的 PushInterfaceField，供 checkMulti 展开为多条 hit
 */
function scanEnumFields(row: RowLike): { hitLabels: string[]; hitFields: PushInterfaceField[] } {
    const hitLabels: string[] = [];
    const hitFields: PushInterfaceField[] = [];
    for (const rule of ENUM_RULES) {
        if (isEnumFieldAbsent(row, rule)) continue; // 完全缺省 → 跳过（兼容旧文件）
        const val = readEnumRaw(row, rule);
        const allowed = rule.readAllowed();
        if (!isAllowedEnum(val, allowed)) {
            const shown = val === '' ? '空' : `"${val}"`;
            hitLabels.push(`${rule.label}=${shown}（应为 ${allowed.join('/')})`);
            hitFields.push(rule.field);
        }
    }
    return { hitLabels, hitFields };
}

export const ENUM_VALIDATOR: RowValidator = {
    kind: 'enumInvalid',
    severity: 'error',
    check(row, tsId) {
        const { hitLabels, hitFields } = scanEnumFields(row);
        if (hitLabels.length === 0) return null;
        return {
            tsId,
            // 文案精简（2026-09-19）：去掉"案例存在枚举字段取值不合法，将导致推送校验失败："冗余前缀，
            // 严重级与行为指引已由 05g 弹窗组头承载，bullet 只保留"字段错在哪"的事实。
            reason: hitLabels.join('；'),
            field: hitFields[0], // 兼容单值口径：primaryField = 第一个命中字段
        };
    },
    /**
     * B4 升级（2026-09-19 修复）：同行多个枚举字段命中时，为每个字段各产出一条 hit，
     * 交由 runValidators 汇总为一条 failure + hits 数组，让前端能对每一列独立标红。
     *
     * 修复现象：CSV 表格中 `type` 和 `test_type` 同时非法时，此前仅取 primaryField='type'
     *   导致只有「案例类型」列标红，「执行方式」列被吞掉。checkMulti 覆盖后两列均标红。
     *
     * 2026-09-19 · R2 增强："每一项各占一条 bullet" —— 除了 field 定位外，
     *   还为每个 hit 附一条**只讲自身字段**的独立 reason（如「执行方式=... 应为 ...」），
     *   前端 05g 弹窗按 hits[i].reason 逐条渲染 bullet，行号只在卡片头显示一次。
     *   顶层 failure.reason 仍保留完整汇总句（用于埋点/落盘等旧口径消费方）。
     */
    checkMulti(row, tsId) {
        const { hitLabels, hitFields } = scanEnumFields(row);
        if (hitLabels.length === 0) return [];
        // 文案精简（2026-09-19）：所有 reason / singleReason 去掉"案例存在枚举字段取值不合法，将导致推送校验失败："冗余前缀。
        // 汇总句仅保留字段级 label 用分号拼接（供顶层 failure.reason / 埋点消费）；单条 hit 只讲自身字段。
        const summary = hitLabels.join('；');
        return hitFields.map((field, i) => ({
            tsId,
            reason: i === 0 ? summary : hitLabels[i],
            field,
            // singleReason：与 reason 语义解耦 —— 无论 i 是否为 0，都提供一条"只讲自己"的话术，
            // 前端渲染 bullet 时优先取 singleReason，保证第一条 bullet 也不会显示成汇总句。
            singleReason: hitLabels[i],
        }));
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
            // 文案精简（2026-09-19）：去掉"案例的计划执行次数取值不合法，将导致推送校验失败："冗余前缀，
            // 与枚举校验器保持一致，只保留"字段=值（应为...）"事实描述。
            reason: `计划执行次数=${shown}（应为非负整数）`,
            field: 'planExecNum',
        };
    },
};

/** 一次性导出 B2 全部 error 级校验器（枚举 + 类型），供 stages.ts 顺序注册。 */
export const B2_ERROR_VALIDATORS: readonly RowValidator[] = [
    ENUM_VALIDATOR,
    PLAN_EXEC_NUM_VALIDATOR,
];
