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
 *   · 空值容忍：需求 2.3.3 明确"字段为空视为不合法"，因此空串/undefined/null 也命中。
 *   · 分级（两档字段：type / key_flag）：按"该列在文件中是否存在"分两档 ——
 *       列缺失（文件级无该列）→ warn 软提示、不阻断（由 missingColumns 报文件级 warn，行级跳过）；
 *       列存在 → 严格校验：缺失 / 空值 / 取值非法 一律 error 硬拦截、剔除该行。
 *     test_type / priority 始终为 error 级硬拦截（命中行从 payload 剔除）；
 *     以上 CSV（中文列名）与 YAML（英文键）同原则，type / key_flag 一致。
 *   · reason 文案模板：`案例{字段中文名}取值不合法：{当前值}，应为 {合法集合/类型}}`，
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
    /** 中文字段名，用于 reason 文案 */
    label: string;
    /** 合法取值集合读取器（运行时读取，保证 settings.json 变更实时生效） */
    readAllowed: () => readonly string[];
    /** 归一化到的接口字段码（用于埋点下钻 & 前端字段级高亮） */
    field: PushInterfaceField;
    /**
     * 命中该字段时的严重级（非空取值命中时）：默认 'error'（硬拦截剔除该行）。
     * type（案例类型）置 'error'，但其空值是否降级由 emptySeverity 与
     * "type 列是否存在"共同决定（runValidators 注入 typeColPresent，列存在时空值强制 error）。
     */
    severity?: 'error' | 'warn';
    /**
     * 字段存在但值为空串（CSV 单元格留空 / 字段为空）时的严重级。
     *   · 默认缺省：沿用 severity（多数字段空值即非法 → error）。
     *   · type（案例类型）/ key_flag（关键案例）置 'warn'：仅当该列在"整个文件中缺失"时生效；
     *     若列存在（colPresent[field]=true），空值会被强制升为 error（严格校验，与 type 同原则）。
     */
    emptySeverity?: 'error' | 'warn';
}

/**
 * 4 项枚举字段规则表 —— 顺序即 reason 拼装顺序（同行多字段命中时按此顺序汇总）。
 * P0 修复（2026-09-19）：allowed 改为 readAllowed 惰性求值，与 pushDataMapper 共用同一份配置源。
 * 注意：4 个中文列名与 package.json 的 headerLabels 及 media/pages/table-editor 现网列头保持严格一致；
 *       其中 keyFlag 的中文名以代码/CSV 现实为准 = 「关键案例」（需求文档的「关键标识」为历史草稿用词）。
 */
const ENUM_RULES: readonly EnumFieldRule[] = [
    { yamlKey: 'type',       csvKey: '案例类型', label: '案例类型', readAllowed: () => getEnumValues('caseType'), field: 'type',    severity: 'error', emptySeverity: 'warn' },
    { yamlKey: 'test_type',  csvKey: '执行方式', label: '执行方式', readAllowed: () => getEnumValues('testType'), field: 'testType'},
    { yamlKey: 'priority',   csvKey: '优先级',   label: '优先级',   readAllowed: () => getEnumValues('priority'), field: 'priority'},
    { yamlKey: 'key_flag',   csvKey: '关键案例', label: '关键案例', readAllowed: readKeyFlagValues,               field: 'keyFlag' },
];

/**
 * 从行对象读取"某枚举字段"的原始值（YAML 键优先，CSV 主列名兜底）。
 * 值经过 trim；空值/undefined/null 返回空串（由调用方决定是否算命中）。
 */
function readEnumRaw(row: RowLike, rule: EnumFieldRule): string {
    // 候选键优先级：YAML 英文键 > CSV 主列名（规范键，线上无遗留变体表头文件，不再兼容别名列）
    const keys: (string | undefined)[] = [
        rule.yamlKey,
        rule.csvKey,
    ];
    let lastDefined: any = undefined;
    for (const k of keys) {
        if (k == null) continue;
        const v = (row as any)?.[k];
        if (v !== undefined) {
            lastDefined = v;
            if (v !== null && v !== '') return String(v).trim();
        }
    }
    if (lastDefined === undefined || lastDefined === null) return '';
    return String(lastDefined).trim();
}

/**
 * 判断行对象是否"完全没有"某枚举字段（YAML 键 & CSV 主/旧列名都 undefined）。
 * 用于兼容旧模板文件 —— 若源文件根本没这个字段，跳过校验避免误伤；
 * 而"字段存在但值为空串（`type: ""`）"仍会判为不合法，符合需求 2.3.3 语义。
 */
function isEnumFieldAbsent(row: RowLike, rule: EnumFieldRule): boolean {
    const keys: (string | undefined)[] = [
        rule.yamlKey,
        rule.csvKey,
    ];
    return keys.every(k => k == null || (row as any)?.[k] === undefined);
}

/** 判断字符串值是否落在 allowed 集合内（严格相等，不做同义词/别名归一化）。 */
function isAllowedEnum(val: string, allowed: readonly string[]): boolean {
    if (val === '') return false; // 值为空串（如 `type: ""`）判定为不合法（需求 2.3.3）
    return allowed.indexOf(val) !== -1;
}

/**
 * 枚举字段校验器（B2 · 按字段分级：error 硬拦截 / warn 软提示）。
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
 *
 * @param colPresent 各"两档字段"（type / key_flag）在文件中是否存在的标志表（key=接口字段码）。
 *        某字段列存在（colPresent[field]===true）→ 严格校验：缺失 / 空串 / 取值非法 一律 error；
 *        字段列缺失（colPresent[field] 缺省/false）→ 完全缺省的行跳过、空值按 emptySeverity 降级，
 *        不阻断推送（与 missingColumns 的"文件级列缺失 warn"呼应，避免重复弹窗）。
 *        test_type / priority 不受此标志影响，始终按各自 severity 处理。
 */
function scanEnumFields(row: RowLike, colPresent: Record<string, boolean>): { hitLabels: string[]; hitFields: PushInterfaceField[]; hitSeverities: Array<'error' | 'warn'> } {
    const hitLabels: string[] = [];
    const hitFields: PushInterfaceField[] = [];
    const hitSeverities: Array<'error' | 'warn'> = [];
    for (const rule of ENUM_RULES) {
        const allowed = rule.readAllowed();
        const isAbsent = isEnumFieldAbsent(row, rule);
        // 两档分级字段（type / key_flag）：列存在即严格 —— 缺失 / 空 / 非法 全部 error。
        if ((rule.field === 'type' || rule.field === 'keyFlag') && colPresent[rule.field]) {
            const val = readEnumRaw(row, rule);
            if (isAbsent || !isAllowedEnum(val, allowed)) {
                const shown = isAbsent ? '缺失' : (val === '' ? '空' : `"${val}"`);
                hitLabels.push(`${rule.label}=${shown}（应为 ${allowed.join('/')})`);
                hitFields.push(rule.field);
                hitSeverities.push('error');
            }
            continue;
        }
        // 其余字段 / type·keyFlag 列缺失场景：
        //   · test_type / priority：始终按各自 severity（error，命中即剔除该行，无默认值）；
        //   · type / keyFlag 在"列缺失"档下（规范列文件级缺失）：
        //       - 空值 → 推送时按默认值兜底，完全跳过（不新增告警/失败，保护已有成功推送零回归）；
        //       - 非空非法 → 仅 warn 提示、不阻断推送（让问题可见，但不影响原有推送结果）。
        if (isAbsent) continue;
        const val = readEnumRaw(row, rule);
        if (!isAllowedEnum(val, allowed)) {
            const isTwoTier = rule.field === 'type' || rule.field === 'keyFlag';
            // 两档字段别名列的空值：走默认值，完全跳过（保持已有推送行为）
            if (isTwoTier && val === '') continue;
            const shown = val === '' ? '空' : `"${val}"`;
            hitLabels.push(`${rule.label}=${shown}（应为 ${allowed.join('/')})`);
            hitFields.push(rule.field);
            // 两档字段别名列非法 → warn（非阻断）；test_type / priority → error（阻断，无默认值）
            const sev = isTwoTier ? 'warn' : (rule.severity ?? 'error');
            hitSeverities.push(sev);
        }
    }
    return { hitLabels, hitFields, hitSeverities };
}

/**
 * 构造枚举校验器。colPresent 由 runValidators 依据"整个文件是否含两档字段列"注入，
 * 从而实现"列缺失→warn、列存在→严格 error"的两档分级（type / key_flag，CSV / YAML 同原则）。
 */
export function makeEnumValidator(colPresent: Record<string, boolean>): RowValidator {
    return {
        kind: 'enumInvalid',
        severity: 'error',
        check(row, tsId) {
            const { hitLabels, hitFields, hitSeverities } = scanEnumFields(row, colPresent);
            if (hitLabels.length === 0) return null;
            return {
                tsId,
                // 文案精简（2026-09-19）：去掉"案例存在枚举字段取值不合法，将导致推送校验失败："冗余前缀，
                // 严重级与行为指引已由 05g 弹窗组头承载，bullet 只保留"字段错在哪"的事实。
                reason: hitLabels.join('；'),
                field: hitFields[0], // 兼容单值口径：primaryField = 第一个命中字段
                // 按字段分级：全部命中均为 warn（如仅 type 空值）→ 整条 warn 软拦截；含任一 error 则保持 error
                severity: hitSeverities.some(s => s === 'error') ? 'error' : 'warn',
            };
        },
        /**
         * B4 升级（2026-09-19 修复）：同行多个枚举字段命中时，为每个字段各产出一条 hit，
         * 交由 runValidators 汇总为一条 failure + hits 数组，让前端能对每一列独立标红。
         *
         * 2026-09-19 · R2 增强：为每个 hit 附一条"只讲自身字段"的独立 reason（singleReason），
         *   前端 05g 弹窗按 hits[i].reason 逐条渲染 bullet，行号只在卡片头显示一次。
         */
        checkMulti(row, tsId) {
            const { hitLabels, hitFields, hitSeverities } = scanEnumFields(row, colPresent);
            if (hitLabels.length === 0) return [];
            // 汇总句仅保留字段级 label 用分号拼接（供顶层 failure.reason / 埋点消费）；单条 hit 只讲自身字段。
            const summary = hitLabels.join('；');
            return hitFields.map((field, i) => ({
                tsId,
                reason: i === 0 ? summary : hitLabels[i],
                field,
                severity: hitSeverities[i],
                // singleReason：与 reason 语义解耦 —— 无论 i 是否为 0，都提供一条"只讲自己"的话术，
                // 前端渲染 bullet 时优先取 singleReason，保证第一条 bullet 也不会显示成汇总句。
                singleReason: hitLabels[i],
            }));
        },
    };
}

/**
 * 整个文件中 type（案例类型）列是否"存在"。
 *   · YAML：任一行含 `type` 键（值可空，只要键存在即视为列存在）；
 *   · CSV ：任一行含「案例类型」列（parser 已把中文列名作为行对象 key）。
 * 该判定只依赖行对象本身，无需 headers，便于 runValidators 在推送期 / 编辑期复用同一口径。
 *
 * 注意：此处只认规范键（type / 案例类型）。线上无遗留变体表头文件，仅以规范键判定列存在性。
 */
export function isTypeColumnPresent(rows: readonly RowLike[]): boolean {
    for (const r of rows) {
        if (r && typeof r === 'object') {
            if ((r as any)['type'] !== undefined || (r as any)['案例类型'] !== undefined) return true;
        }
    }
    return false;
}

/**
 * 整个文件中 key_flag（关键案例）列是否"存在"。判定口径同 isTypeColumnPresent：
 *   · YAML：任一行含 `key_flag` 键；
 *   · CSV ：任一行含「关键案例」列。
 */
export function isKeyFlagColumnPresent(rows: readonly RowLike[]): boolean {
    for (const r of rows) {
        if (r && typeof r === 'object') {
            if ((r as any)['key_flag'] !== undefined || (r as any)['关键案例'] !== undefined) return true;
        }
    }
    return false;
}

/**
 * 默认导出（colPresent 空表的宽容口径）—— 供单测直接调用 ENUM_VALIDATOR.check 时
 * 保持"列缺失→跳过、空值→warn"的旧语义；真正的推/编辑期分级由 runValidators 注入。
 */
export const ENUM_VALIDATOR: RowValidator = makeEnumValidator({});

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
