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
 * 2026-09-19：caseType 与 package.json 的 default（11 项）对齐，避免"兜底集合过窄"导致误判。 */
const HARD_FALLBACK: Record<EnumField, string[]> = {
    caseType: ['功能点类', '流程类', '界面类', '批处理类', '数据仓库类', '报表统计类', '算法类', '安全类', '可用性检查类', '报文接口类', '其他'],
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

// ============================================================================
//  校验开关读取（2026-09-19 P4）
// ----------------------------------------------------------------------------
//  为避免 preValidate/validators.ts 直接 import vscode（保持"纯 CPU 可单测"边界），
//  统一把"读取 testcaseViewer.validate.* 布尔开关"的能力放在本模块暴露。
// ============================================================================

/** 支持的布尔型校验开关名（与 package.json 中 testcaseViewer.validate.* 一一对应） */
export type ValidateFlag = 'checkTags';

const VALIDATE_FLAG_PREFIX = 'testcaseViewer.validate';

/** 布尔开关的硬编码兜底（配置全丢失时使用；与 package.json default 保持一致） */
const VALIDATE_FLAG_FALLBACK: Record<ValidateFlag, boolean> = {
    checkTags: false,
};

/**
 * 读取指定校验开关的当前布尔值。
 * 每次调用都会重新读配置，保证 settings.json 变更立即生效。
 */
export function getValidateFlag(flag: ValidateFlag): boolean {
    try {
        const cfg = vscode.workspace.getConfiguration().get<boolean>(`${VALIDATE_FLAG_PREFIX}.${flag}`);
        if (typeof cfg === 'boolean') return cfg;
    } catch { /* ignore：VSCode 环境异常时走硬兜底 */ }
    return VALIDATE_FLAG_FALLBACK[flag];
}