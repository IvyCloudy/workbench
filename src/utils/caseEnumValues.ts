/**
 * ============================================================================
 *  utils/caseEnumValues.ts
 *  推送/校验用「枚举字段」合法取值清单加载工具
 * ----------------------------------------------------------------------------
 *  管理的枚举字段：
 *    - caseType  ← YAML `type`      / CSV「案例类型」
 *    - testType  ← YAML `test_type` / CSV「执行方式」
 *    - priority  ← YAML `priority`  / CSV「优先级」
 *    - keyFlag   ← YAML `key_flag`  / CSV「关键案例」
 *
 *  取值来源（高 → 低）：
 *    1. VSCode 配置系统 `testcaseViewer.enum.<field>`
 *       —— 由 package.json 的 default 字段提供枚举清单；
 *       —— 用户若在 settings.json 覆盖同名 key，VSCode 会自动合并（本模块不额外处理，
 *          属于 VSCode 平台的天然行为，不作为对外承诺的配置扩展点）。
 *    2. 代码硬编码兜底（HARD_FALLBACK）：仅在 VSCode 环境异常/配置全丢失时使用。
 *
 *  设计原则：
 *    - 枚举清单唯一维护点为 package.json 的 default，后端调整清单时改动一次即可；
 *    - getEnumValues 每次调用都重新读取配置，无需缓存，保证配置变更实时生效；
 *    - 空值判定不在本文件承担（由调用方决定"空值"是抛错还是走默认值），
 *      isValidEnumValue 对空值返回 false（更严格），调用方按需处理。
 * ============================================================================
 */
import * as vscode from 'vscode';

/** 支持的枚举字段名（与 package.json 中 testcaseViewer.enum.* 一一对应） */
export type EnumField = 'caseType' | 'testType' | 'priority' | 'keyFlag';

const CONFIG_PREFIX = 'testcaseViewer.enum';

/** 代码级硬编码兜底（仅在 VSCode 环境异常/配置全丢失时使用，保证最小可用）。
 * caseType 与 package.json 的 default（13 项）对齐，避免"兜底集合过窄"导致误判。 */
const HARD_FALLBACK: Record<EnumField, string[]> = {
    caseType: ['流程类', '功能点类', '报表统计类', '界面类', '报文接口类', '批处理类', '其他', '算法类', '可用性检查类', '数据仓库类', '安全类', '性能类', 'AI类'],
    testType: ['手工', 'UI自动化', '接口自动化', '自动化'],
    priority: ['高', '中', '低'],
    keyFlag:  ['是', '否'],
};

/**
 * 读取指定枚举字段的合法取值清单。
 * 每次调用都会重新读配置，保证 package.json 或运行期配置更新后立即生效。
 */
export function getEnumValues(field: EnumField): string[] {
    try {
        const cfg = vscode.workspace.getConfiguration().get<string[]>(`${CONFIG_PREFIX}.${field}`);
        if (Array.isArray(cfg) && cfg.length) {
            const clean = cfg.filter((x) => typeof x === 'string' && x.trim() !== '');
            if (clean.length) return clean;
        }
    } catch { /* ignore：VSCode 环境异常时走硬兜底 */ }
    return HARD_FALLBACK[field];
}

/**
 * 判断某个取值是否命中指定字段的清单（严格匹配，不做别名归一化）。
 * - 空值/仅空白 → 返回 false（视为不合法，交由调用方决定是否抛错/走默认值）
 * - 非字符串 → 转字符串后判定
 */
export function isValidEnumValue(field: EnumField, v: any): boolean {
    if (v == null) return false;
    const s = String(v).trim();
    if (s === '') return false;
    return getEnumValues(field).indexOf(s) !== -1;
}

/**
 * 「执行方式 / test_type」口语化输入 → 标准值 的别名归一化映射（校验侧单一来源）。
 * 允许用户用更口语/简短的词表达执行方式；校验侧（pushCore.enumTypeValidators）
 * 复用本来源，与推送侧（pushDataMapper 的等价 TEST_TYPE_ALIASES）保持语义一致：
 *   - '接口'     → '接口自动化'
 *   - '界面'     → 'UI自动化'
 * 不在表中的输入原样返回（交给后续白名单校验决定是否合法）。
 */
export const TEST_TYPE_ALIASES: Record<string, string> = {
    '接口': '接口自动化',
    '界面': 'UI自动化',
};

/**
 * 将口语化输入归一化为标准执行方式值；命中别名表则翻译，否则原样返回。
 * 含大小写忽略匹配（覆盖 'UI' / 'API' 等混入大小写的情况）。
 */
export function normalizeTestTypeInput(raw: any): string {
    const v = (raw == null ? '' : String(raw)).trim();
    if (v === '') return v;
    if (Object.prototype.hasOwnProperty.call(TEST_TYPE_ALIASES, v)) return TEST_TYPE_ALIASES[v];
    const lower = v.toLowerCase();
    for (const key of Object.keys(TEST_TYPE_ALIASES)) {
        if (key.toLowerCase() === lower) return TEST_TYPE_ALIASES[key];
    }
    return v;
}