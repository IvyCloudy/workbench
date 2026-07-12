/**
 * ============================================================================
 *  utils/yamlConstants.ts
 *  YAML 校验/修复相关的常量集中定义
 * ----------------------------------------------------------------------------
 *  职责：集中定义 YAML 校验的字符集、命令 ID、Diagnostic source，避免各模块
 *        散落 magic string。
 * ============================================================================
 */

// ============================================
// Diagnostic source（VS Code 波浪线来源标签）
// ============================================

export const YAML_DIAGNOSTIC_SOURCE = 'YAML 格式';

// ============================================
// 命令 ID（testcaseViewer 命名空间，避免与 VS Code 内置 workbench.* 冲突）
// ============================================

export const YAML_CMD_REPORT_FIX = 'testcaseViewer.yaml.reportFix';
export const YAML_CMD_FIX_ALL = 'testcaseViewer.yaml.fixAll';
/** 仅修复 error 级别 */
export const YAML_CMD_FIX_ALL_ERRORS = 'testcaseViewer.yaml.fixAllErrors';
/** 仅修复 warning 级别 */
export const YAML_CMD_FIX_ALL_WARNINGS = 'testcaseViewer.yaml.fixAllWarnings';
/** 修复用户当前选中范围内的可修复问题（多行选中修复） */
export const YAML_CMD_FIX_RANGE = 'testcaseViewer.yaml.fixRange';
/**
 * 智能选择器：右键 / 状态栏 / 命令面板入口
 * ------------------------------------------------------------
 * 根据当前编辑器上下文（是否跨行选中、诊断严重级分布）动态弹出 QuickPick，
 * 用户可选：修复选中范围 / 修复全部 / 仅 error / 仅 warning。
 * 避免用户必须先找到灯泡才能触发批量修复。
 */
export const YAML_CMD_FIX_PICK = 'testcaseViewer.yaml.fixPick';

// ============================================
// 防抖与缓存参数
// ============================================

/** 文件超过该字节数视为大文件，防抖时长翻倍 */
export const YAML_LARGE_FILE_THRESHOLD = 200 * 1024;
/** 普通文件的防抖时长（毫秒） */
export const YAML_DEBOUNCE_MS = 500;
/** 大文件的防抖时长（毫秒） */
export const YAML_DEBOUNCE_MS_LARGE = 1200;
/** 修复完毕后 fixingUris 尾巴保留时长，抑制批量 edit 触发的 onDidChangeTextDocument */
export const YAML_FIX_COOLDOWN_MS = 600;

// ============================================
// YAML 保留字符（不加引号会被解析为特殊语法结构）
// ============================================

/** 未引号 YAML 值中存在风险的保留字符（正则片段） */
export const RESERVED_CHARS_PATTERN = /[\[\]{},&*!>|]/;

/**
 * YAML 指示符豁免正则集合：值起始位置是**合法** YAML 指示符时，不应触发 R7 加引号。
 *
 * 涵盖 6 类：
 *   1. BLOCK_SCALAR: 块标量头 `|` / `>` / `|-` / `|+` / `>+` / `>-` / `|2` 等，后可跟注释
 *   2. ALIAS:        别名 `*name`，后可跟注释（后跟内联值在 YAML 中非法，不豁免）
 *   3. ANCHOR:       锚点 `&name`，后可跟空白 + 内联值（e.g. `&a foo`，且 foo 首字符不得为指示符）
 *   4. TAG:          标签 `!name` / `!!type` / `!<uri>`，后可跟空白 + 内联值（同上）
 *   5. FLOW_SEQ:     内联序列 `[...]`（**必须闭合**），后可跟注释
 *   6. FLOW_MAP:     内联映射 `{...}`（**必须闭合**），后可跟注释
 *
 * ⚠️ tag/anchor 的 inline 值必须是"普通标量"：首字符禁止为块标量头 `|` `>`
 *    或指示符 `!` `&` `*`。这样能识别"拼接非法指示符"的极端错误：
 *      `!tag &anchor *alias >fold |lit`  → 不豁免（正确触发 R7 报错）
 *      `!tag hello`                       → 豁免（合法）
 *
 * 与 skill/yaml-format-fix/scripts/{fix-yaml.js, fix_yaml.py} 中的 YAML_INDICATOR_PATTERNS
 * 保持行为一致，避免"skill 脚本静默但插件报错"的用户认知割裂。
 */
export const YAML_INDICATOR_PATTERNS: RegExp[] = [
    /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/,                       // block scalar header
    /^\*[A-Za-z_][A-Za-z0-9_\-]*\s*(?:#.*)?$/,              // alias
    /^&[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$/,        // anchor + optional inline value（非指示符起始）
    /^!<[^>]+>(?:\s+[^!&*|>].*)?$/,                         // verbatim tag `!<tag:...>` + optional inline
    /^!!?[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$/,      // tag `!type` / `!!str` + optional inline
    /^\[.*\]\s*(?:#.*)?$/,                                  // flow sequence（必须闭合）
    /^\{.*\}\s*(?:#.*)?$/,                                  // flow mapping（必须闭合）
];

/**
 * 判断 `rawValue`（**已 trim**）是否为合法 YAML 指示符起始的值。
 * 命中任一 YAML_INDICATOR_PATTERNS 即视为合法，R7 与相关规则应豁免。
 */
export function isYamlIndicatorValue(rawValue: string): boolean {
    for (const re of YAML_INDICATOR_PATTERNS) {
        if (re.test(rawValue)) return true;
    }
    return false;
}

/** 每个保留字符的说明 */
export const RESERVED_CHAR_DESCRIPTIONS: Record<string, string> = {
    '{': '开花括号通常用于内联映射 (flow mapping)',
    '}': '闭花括号通常用于内联映射结束',
    '[': '开方括号通常用于内联序列 (flow sequence)',
    ']': '闭方括号通常用于内联序列结束',
    ',': '逗号通常用于分隔内联集合项',
    '&': '& 符号用于定义 YAML 锚点 (anchor)',
    '*': '* 符号用于引用 YAML 别名 (alias)',
    '!': '! 符号用于声明 YAML 标签 (tag)',
    '>': '> 符号用于折叠块标量 (block scalar)',
    '|': '| 符号用于保留换行的块标量 (literal block scalar)',
};

// ============================================
// YAML 歧义关键字（不加引号会被解析为特殊类型）
// ============================================

/** 会被解析为布尔值的关键字 */
export const BOOLEAN_KEYWORDS = new Set([
    'true', 'false', 'TRUE', 'FALSE', 'True', 'False',
    'yes', 'no', 'YES', 'NO', 'Yes', 'No',
    'on', 'off', 'ON', 'OFF', 'On', 'Off',
]);

/** 会被解析为 null 的关键字 */
export const NULL_KEYWORDS = new Set([
    'null', 'NULL', 'Null', '~',
]);

/** 会被解析为特殊数值的关键字（无穷/NaN） */
export const NUMERIC_SPECIAL_KEYWORDS = new Set([
    '.inf', '.nan', '.INF', '.NAN', 'Infinity', '-Infinity',
]);

/**
 * 判断某关键字属于哪种歧义类型；若不是歧义关键字则返回 null。
 */
export type AmbiguousType = 'boolean' | 'null' | 'numeric';
export function getAmbiguousType(value: string): AmbiguousType | null {
    if (BOOLEAN_KEYWORDS.has(value)) return 'boolean';
    if (NULL_KEYWORDS.has(value)) return 'null';
    if (NUMERIC_SPECIAL_KEYWORDS.has(value)) return 'numeric';
    return null;
}

/** 展示给用户的中文说明 */
export const AMBIGUOUS_TYPE_LABEL: Record<AmbiguousType, string> = {
    boolean: '布尔值',
    null: '空值 null',
    numeric: '特殊数值',
};

// ============================================
// 引号字符集（支持中文/日文引号）
// ============================================

/** 用于剥离已包裹在引号内的值时的字符集 */
export const QUOTE_STRIP_LEADING = /^['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]\s*/u;
export const QUOTE_STRIP_TRAILING = /\s*['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]$/u;
