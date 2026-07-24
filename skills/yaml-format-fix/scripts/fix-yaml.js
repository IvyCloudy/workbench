#!/usr/bin/env node
/**
 * ============================================================================
 *  scripts/fix-yaml.js  (Node.js edition)
 *  YAML 格式修复 CLI —— 与 VS Code 扩展 (utils/yamlRules.ts + yamlValidator.ts)
 *  行为完全一致的独立命令行版本
 *
 *  设计原则：
 *    ①【纯确定性】不依赖 LLM 推理；所有规则/修复算法 1:1 移植自插件源码
 *    ②【日志完整】--verbose 打印每条规则命中详情、apply 前后行文本、跳过原因
 *    ③【零外部依赖 · 可选优化】默认仅需 Node.js；若已安装 yaml 库
 *       (`npm i yaml`)，则启用 P1~P4 parser 级兜底修复
 *
 *  规则覆盖（12 条，与插件完全对齐）：
 *    - 逐行规则 -
 *      R1  Tab 缩进           → 每个 \\t → 2 空格 (stopOnHit)
 *      R2  行内 Tab           → 未在引号内 & 非行末的 \\t → 单空格
 *      R3  行末空格            → rstrip
 *      R4  冒号后缺空格        → 插入单空格 (让位 R5/R7 时不产 fix)
 *      R5  歧义值(布尔/null)   → 加引号
 *      R6  值中 # 号           → 整个值加引号 (含注释文本)
 *      R7  YAML 保留字符       → 加引号
 *      R8  '-' 后缺空格        → 插入单空格
 *    - 文件级规则 -
 *      F1  重复 key            → 后续同名行改成 `# [duplicate key removed] ...`
 *    - Parser 兜底 -
 *      P1  嵌套 map 报错       → 序列/键值对整个值加引号
 *      P2  缺闭合引号           → 补上对应引号
 *      P3  same column         → 注释化该行
 *      P4  duplicate key       → 注释化该行
 *
 *  用法：
 *    node scripts/fix-yaml.js <file>              修复并写回
 *    node scripts/fix-yaml.js <file> --dry-run    仅预览
 *    node scripts/fix-yaml.js <file> --json       机器可读输出
 *    node scripts/fix-yaml.js <file> --verbose    打印详细日志
 * ============================================================================
 */

'use strict';

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

// ─── yaml 库（可选；用于 P1~P4 parser 级错误捕获）──────────────────────────
let YAML = null;
try {
    // 优先从当前工作目录寻找（脚本在项目内运行时能找到）
    YAML = require('yaml');
} catch (_) {
    try {
        // 兜底：从脚本目录向上寻找
        const nodeModulesPath = path.resolve(__dirname, '..', 'node_modules', 'yaml');
        YAML = require(nodeModulesPath);
    } catch (_) {
        YAML = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 常量表（1:1 复刻 utils/yamlConstants.ts）
// ═══════════════════════════════════════════════════════════════════════════
const RESERVED_CHARS_PATTERN = /[\[\]{},&*!>|]/;

/**
 * R7 豁免正则：值起始位置是合法 YAML 指示符时，不应加引号。
 *  - BLOCK_SCALAR: 块标量头 `|` / `>` / `|-` / `|+` / `>+` / `>-` / `|2` 等，后可跟注释
 *  - ALIAS:        别名 `*name`，后可跟注释（不允许内联值）
 *  - ANCHOR:       锚点 `&name`，后可跟空白+内联值（合法 YAML）
 *  - TAG:          标签 `!name` / `!!type` / `!<uri>`，后可跟空白+内联值
 *  - FLOW_SEQ:     内联序列 `[...]`（必须闭合），后可跟注释
 *  - FLOW_MAP:     内联映射 `{...}`（必须闭合），后可跟注释
 */
const YAML_INDICATOR_PATTERNS = [
    /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/,
    /^\*[A-Za-z_][A-Za-z0-9_\-]*\s*(?:#.*)?$/,
    /^&[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$/,       // anchor + inline 值（非指示符起始）
    /^!<[^>]+>(?:\s+[^!&*|>].*)?$/,                        // verbatim tag + inline
    /^!!?[A-Za-z_][A-Za-z0-9_\-]*(?:\s+[^!&*|>].*)?$/,     // tag + inline
    /^\[.*\]\s*(?:#.*)?$/,
    /^\{.*\}\s*(?:#.*)?$/,
];

/** 判定 trim 后的值是否是纯 YAML 指示符（应豁免 R7 保留字符检查） */
function isYamlIndicatorValue(rawValue) {
    for (const re of YAML_INDICATOR_PATTERNS) if (re.test(rawValue)) return true;
    return false;
}

const RESERVED_CHAR_DESCRIPTIONS = {
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

const BOOLEAN_KEYWORDS = new Set([
    'true', 'false', 'TRUE', 'FALSE', 'True', 'False',
    'yes', 'no', 'YES', 'NO', 'Yes', 'No',
    'on', 'off', 'ON', 'OFF', 'On', 'Off',
]);
const NULL_KEYWORDS = new Set(['null', 'NULL', 'Null', '~']);
const NUMERIC_SPECIAL_KEYWORDS = new Set(['.inf', '.nan', '.INF', '.NAN', 'Infinity', '-Infinity']);
const AMBIGUOUS_TYPE_LABEL = { boolean: '布尔值', null: '空值 null', numeric: '特殊数值' };

const QUOTE_STRIP_LEADING = /^['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]\s*/u;
const QUOTE_STRIP_TRAILING = /\s*['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]$/u;

function getAmbiguousType(value) {
    if (BOOLEAN_KEYWORDS.has(value)) return 'boolean';
    if (NULL_KEYWORDS.has(value)) return 'null';
    if (NUMERIC_SPECIAL_KEYWORDS.has(value)) return 'numeric';
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 日志器（--verbose 打开详情；始终打印摘要）
// ═══════════════════════════════════════════════════════════════════════════
function createLogger(verbose) {
    const stamp = () => new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
    return {
        info: (...args) => console.log(`[${stamp()}] [INFO ]`, ...args),
        warn: (...args) => console.warn(`[${stamp()}] [WARN ]`, ...args),
        error: (...args) => console.error(`[${stamp()}] [ERROR]`, ...args),
        debug: (...args) => { if (verbose) console.log(`[${stamp()}] [DEBUG]`, ...args); },
        rule: (ruleId, lineNum, line, msg) => {
            if (!verbose) return;
            console.log(`[${stamp()}] [RULE ] ${ruleId} L${lineNum} ${msg}`);
            console.log(`[${stamp()}] [RULE ]         BEFORE: ${JSON.stringify(line)}`);
        },
        ruleAfter: (ruleId, lineNum, fixed) => {
            if (!verbose) return;
            console.log(`[${stamp()}] [RULE ] ${ruleId} L${lineNum} ${fixed !== undefined ? 'AFTER : ' + JSON.stringify(fixed) : '(no auto-fix)'}`);
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 引号/冒号定位辅助（1:1 复刻 yamlRules.ts::findYamlChar / findYamlColon）
// ═══════════════════════════════════════════════════════════════════════════
function findYamlChar(line, chars) {
    let inSingle = false, inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (!inDouble && c === "'") { inSingle = !inSingle; continue; }
        if (!inSingle && c === '"') { inDouble = !inDouble; continue; }
        if (!inSingle && !inDouble && chars.includes(c)) return i;
    }
    return -1;
}

function findYamlColon(line) {
    let inSingle = false, inDouble = false, flowDepth = 0;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (!inDouble && c === "'") { inSingle = !inSingle; continue; }
        if (!inSingle && c === '"') { inDouble = !inDouble; continue; }
        if (inSingle || inDouble) continue;
        // 跟踪 flow 集合深度：{ / [ 入栈，} / ] 出栈
        if (c === '{' || c === '[') { flowDepth++; continue; }
        if (c === '}' || c === ']') { if (flowDepth > 0) flowDepth--; continue; }
        if (flowDepth > 0) continue; // flow 内部的冒号归 YAML 解析器管辖
        if (c !== ':') continue;
        if (line[i + 1] === '/' && line[i + 2] === '/') continue; // :// URL
        if (line[i + 1] === ':' || line[i - 1] === ':') continue; // ::
        return i;
    }
    return -1;
}

function stripQuotes(value) {
    const l = value.replace(QUOTE_STRIP_LEADING, '');
    if (l.length === value.length) return value;
    const r = l.replace(QUOTE_STRIP_TRAILING, '');
    if (r.length === l.length) return value;
    return r;
}

function wrapValueWithQuote(value) {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && hasSingle) return '"' + value.replace(/"/g, '\\"') + '"';
    if (hasDouble) return "'" + value + "'";
    return '"' + value + '"';
}

function replaceValueByColon(line, colonIdx, wrapped) {
    let valStart = colonIdx + 1;
    const needSpace = valStart < line.length && line[valStart] !== ' ';
    while (valStart < line.length && line[valStart] === ' ') valStart++;
    let valEnd = line.length;
    while (valEnd > valStart && /[\s\u00A0\r]/.test(line[valEnd - 1])) valEnd--;
    const tail = line.substring(valEnd);
    const prefix = line.substring(0, valStart) + (needSpace ? ' ' : '');
    return prefix + wrapped + tail;
}

function buildLineCtx(line) {
    const colonIdx = findYamlColon(line);
    const hashIdx = findYamlChar(line, '#');
    const ctx = { colonIdx, hashIdx };
    if (colonIdx > 0) {
        ctx.keyText = line.substring(0, colonIdx);
        ctx.valueText = line.substring(colonIdx + 1);
    }
    return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// 逐行规则（R1~R8）
// ═══════════════════════════════════════════════════════════════════════════
function ruleTabIndent(line, lineNum) {
    const m = line.match(/^(\t+)/);
    if (!m) return null;
    return {
        id: 'R1', line: lineNum, column: 1, length: m[1].length,
        title: 'Tab 缩进',
        message: `第 ${lineNum} 行：使用了 Tab 缩进，YAML 规范不允许用 Tab 进行缩进，请改用空格`,
        severity: 'error',
        fix: line.replace(/^\t+/, (tabs) => '  '.repeat(tabs.length)),
    };
}

function ruleInlineTab(line, lineNum) {
    const idx = line.indexOf('\t');
    if (idx <= 0) return null;
    const trimmed = line.trimEnd();
    const trailingStart = trimmed.length;
    let inSingle = false, inDouble = false;
    let hasReplaceable = false, firstReportIdx = -1;
    let out = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (!inDouble && c === "'") { inSingle = !inSingle; out += c; continue; }
        if (!inSingle && c === '"') { inDouble = !inDouble; out += c; continue; }
        if (c === '\t' && !inSingle && !inDouble && i > 0 && i < trailingStart) {
            hasReplaceable = true;
            if (firstReportIdx < 0) firstReportIdx = i;
            out += ' ';
            continue;
        }
        out += c;
    }
    if (firstReportIdx < 0) return null;
    const fixed = hasReplaceable ? out : undefined;
    return {
        id: 'R2', line: lineNum, column: firstReportIdx + 1, length: 1,
        title: '含 Tab 字符',
        message: `第 ${lineNum} 行：字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误`,
        severity: 'warning',
        fix: fixed,
    };
}

function ruleTrailingSpace(line, lineNum) {
    if (line.length === 0) return null;
    const trimmed = line.trimEnd();
    if (trimmed === line) return null;
    return {
        id: 'R3', line: lineNum, column: trimmed.length + 1, length: line.length - trimmed.length,
        title: '行末多余空格',
        message: `第 ${lineNum} 行：末尾有多余空格，可能导致缩进层级判断错误`,
        severity: 'warning',
        fix: trimmed,
    };
}

function ruleColonSpace(line, lineNum, ctx) {
    if (ctx.colonIdx <= 0) return null;
    const colonIdx = ctx.colonIdx;
    const afterColon = line[colonIdx + 1];
    if (afterColon === undefined || afterColon === ' ' || afterColon === '\r') return null;
    if (afterColon === '\t') return null;
    const valuePart = line.substring(colonIdx + 1).trim();
    if (valuePart.length === 0) return null;
    if (/^["']/.test(valuePart) || /^\d/.test(valuePart)) return null;
    if (getAmbiguousType(valuePart)) return null;
    if (RESERVED_CHARS_PATTERN.test(valuePart)) return null;
    return {
        id: 'R4', line: lineNum, column: colonIdx + 1, length: 1,
        title: '缺少空格',
        message: `第 ${lineNum} 行：冒号后缺少空格，字段 "${(ctx.keyText || '').trim()}" 的值未被正确识别`,
        severity: 'warning',
        fix: line.substring(0, colonIdx + 1) + ' ' + line.substring(colonIdx + 1),
    };
}

function ruleAmbiguousValue(line, lineNum, ctx) {
    if (ctx.colonIdx <= 0 || !ctx.valueText) return null;
    // 让位 R6
    const hashInValRaw = findYamlChar(ctx.valueText, '#');
    if (hashInValRaw > 0 && ctx.valueText[hashInValRaw - 1] === ' ' &&
        ctx.valueText.substring(hashInValRaw + 1).trim().length > 0) return null;

    let rawValueRaw = ctx.valueText;
    const hashInVal = findYamlChar(rawValueRaw, '#');
    if (hashInVal > 0 && rawValueRaw[hashInVal - 1] === ' ') {
        rawValueRaw = rawValueRaw.substring(0, hashInVal);
    }
    const rawValue = rawValueRaw.trim();
    if (rawValue.length === 0) return null;
    const unquoted = stripQuotes(rawValue);
    if (unquoted !== rawValue) return null;
    const type = getAmbiguousType(rawValue);
    if (!type) return null;
    return {
        id: 'R5', line: lineNum, column: ctx.colonIdx + 2, length: rawValue.length,
        title: `${AMBIGUOUS_TYPE_LABEL[type]} 需引号`,
        message: `第 ${lineNum} 行：值 "${rawValue}" 会被 YAML 解析为${AMBIGUOUS_TYPE_LABEL[type]}，如需字符串请加引号`,
        severity: 'warning',
        fix: replaceValueByColon(line, ctx.colonIdx, wrapValueWithQuote(rawValue)),
    };
}

function ruleHashInValue(line, lineNum, ctx) {
    if (ctx.colonIdx <= 0 || ctx.hashIdx <= ctx.colonIdx) return null;
    const hashIdx = ctx.hashIdx;
    const valueSection = line.substring(ctx.colonIdx + 1, hashIdx);
    if (valueSection.trim().length === 0) return null;
    if (line[hashIdx - 1] !== ' ') return null;
    const afterHash = line.substring(hashIdx + 1).trim();
    if (afterHash.length === 0) return null;
    // 豁免：# 前的值段本身是合法 YAML 指示符（flow 集合 / block scalar / anchor / alias / tag），
    //   此时 `#note` 就是合法的行内注释，包引号反而破坏语义。
    if (isYamlIndicatorValue(valueSection.trim())) return null;
    const rawValue = line.substring(ctx.colonIdx + 1).trim();
    return {
        id: 'R6', line: lineNum, column: hashIdx + 1, length: line.length - hashIdx,
        title: '值中 # 会被丢弃',
        message: `第 ${lineNum} 行：值中包含 "#"，"${afterHash}" 会被 YAML 当作注释丢弃，如需保留请用引号包裹整个值`,
        severity: 'warning',
        fix: line.substring(0, ctx.colonIdx + 1) + ' ' + wrapValueWithQuote(rawValue),
    };
}

function ruleReservedChar(line, lineNum, ctx) {
    if (ctx.colonIdx <= 0 || !ctx.valueText) return null;
    const hashInValRaw = findYamlChar(ctx.valueText, '#');
    if (hashInValRaw > 0 && ctx.valueText[hashInValRaw - 1] === ' ' &&
        ctx.valueText.substring(hashInValRaw + 1).trim().length > 0) return null;
    let rawValueRaw = ctx.valueText;
    const hashInVal = findYamlChar(rawValueRaw, '#');
    if (hashInVal > 0 && rawValueRaw[hashInVal - 1] === ' ') {
        rawValueRaw = rawValueRaw.substring(0, hashInVal);
    }
    const rawValue = rawValueRaw.trim();
    if (rawValue.length === 0) return null;
    const unquoted = stripQuotes(rawValue);
    if (unquoted !== rawValue) return null;
    // R7 豁免：值起始位置是合法 YAML 指示符（块标量 / 锚点 / 别名 / 标签）
    if (isYamlIndicatorValue(rawValue)) return null;
    const m = rawValue.match(RESERVED_CHARS_PATTERN);
    if (!m) return null;
    const reservedChar = m[0];
    const desc = RESERVED_CHAR_DESCRIPTIONS[reservedChar] || '';
    const charPos = line.indexOf(reservedChar, ctx.colonIdx + 1);
    return {
        id: 'R7', line: lineNum, column: (charPos < 0 ? ctx.colonIdx + 2 : charPos + 1), length: 1,
        title: `保留字符 "${reservedChar}"`,
        message: `第 ${lineNum} 行：值中包含 YAML 保留字符 "${reservedChar}"${desc ? `（${desc}）` : ''}，如需字符串请用引号包裹`,
        severity: 'warning',
        fix: replaceValueByColon(line, ctx.colonIdx, wrapValueWithQuote(rawValue)),
    };
}

/**
 * R9: 块标量头被引号包裹（如 `key: "|"` / `key: ">"` / `key: "|-"`）。
 *   Yaml 中 `|`/`>` 是块标量（多行文本）指示符；一旦被引号包裹，它就退化成普通字符串，
 *   其后更深缩进的续行会被解析器当作非法映射项，进而被 parser 兜底注释化，造成数据丢失。
 *   修复：去掉引号，使块标量头生效，续行恢复为合法的多行内容。
 */
function ruleQuotedBlockScalar(line, lineNum, ctx) {
    if (ctx.colonIdx <= 0 || !ctx.valueText) return null;
    const valueText = ctx.valueText;
    const trimmed = valueText.trim();
    if (trimmed.length === 0) return null;
    const m = trimmed.match(/^(['"])([|>][+-]?\d*[+-]?)\1(\s*(?:#.*)?)?$/);
    if (!m) return null;
    const head = m[2];
    const tail = m[3] || '';
    const fixed = line.substring(0, ctx.colonIdx + 1) + valueText.replace(trimmed, head + tail);
    return {
        id: 'R9', line: lineNum, column: ctx.colonIdx + 2, length: trimmed.length,
        title: '块标量头被引号包裹',
        message: `第 ${lineNum} 行：块标量指示符 "${head}" 被引号包裹，YAML 不会将其识别为多行文本，后续缩进行会被误注释。已去掉引号使其生效`,
        severity: 'warning',
        fix: fixed,
    };
}

/** 判断整行是否为"引号包裹的块标量头"（如 `key: "|"`）。供 parser 兜底层做级联抑制。 */
function isQuotedBlockScalarLine(line) {
    const idx = line.indexOf(':');
    if (idx <= 0) return false;
    const valueText = line.substring(idx + 1);
    const trimmed = valueText.trim();
    if (trimmed.length === 0) return false;
    return /^(['"])([|>][+-]?\d*[+-]?)\1(\s*(?:#.*)?)?$/.test(trimmed);
}

function ruleDashSpace(line, lineNum) {
    const m = line.match(/^(\s*)-([^\s-])/);
    if (!m) return null;
    const dashCol = m[1].length;
    return {
        id: 'R8', line: lineNum, column: dashCol + 2, length: 1,
        title: '缺少空格',
        message: `第 ${lineNum} 行：序列符号 "-" 后缺少空格，YAML 无法识别为列表项`,
        severity: 'warning',
        fix: line.substring(0, dashCol + 1) + ' ' + line.substring(dashCol + 1),
    };
}

const RULES = [
    { rule: ruleTabIndent, stopOnHit: true },
    { rule: ruleInlineTab },
    { rule: ruleTrailingSpace },
    { rule: ruleColonSpace },
    { rule: ruleDashSpace },
    { rule: ruleAmbiguousValue },
    { rule: ruleHashInValue },
    { rule: ruleReservedChar },
    { rule: ruleQuotedBlockScalar },
];

// ═══════════════════════════════════════════════════════════════════════════
// 文件级规则 F1：重复 key（跨行状态机；1:1 复刻 duplicateKeyRule）
// ═══════════════════════════════════════════════════════════════════════════
function ruleDuplicateKey(lines) {
    const issues = [];
    const stack = [{ indent: -1, keys: new Map(), isSeqItem: false }];
    const popDeeperThan = (t) => { while (stack.length > 1 && stack[stack.length - 1].indent > t) stack.pop(); };
    const popForNewDash = (dashCol) => {
        popDeeperThan(dashCol);
        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            if (top.isSeqItem && top.indent > dashCol) { stack.pop(); continue; }
            break;
        }
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('...')) continue;
        if (line.startsWith('\t')) continue;
        const indent = line.length - line.trimStart().length;

        if (trimmed === '-' || trimmed.startsWith('- ')) {
            const dashCol = indent;
            popForNewDash(dashCol);
            const afterDashStart = dashCol + 2;
            if (afterDashStart > line.length) continue;
            const afterDashText = line.substring(afterDashStart);
            const colonInRest = findYamlColon(afterDashText);
            if (trimmed === '-') continue;
            if (colonInRest > 0) {
                const itemIndent = afterDashStart;
                const key = afterDashText.substring(0, colonInRest).trim();
                const itemScope = { indent: itemIndent, keys: new Map(), isSeqItem: true };
                stack.push(itemScope);
                if (key && !key.startsWith('- ')) itemScope.keys.set(key, lineNum);
                const afterColonAbs = afterDashStart + colonInRest + 1;
                const afterColonText = line.substring(afterColonAbs).trim();
                if (afterColonText === '' || afterColonText.startsWith('#')) {
                    stack.push({ indent: itemIndent, keys: new Map(), isSeqItem: false });
                }
            }
            continue;
        }

        const colonIdx = findYamlColon(line);
        if (colonIdx <= 0) continue;
        const key = line.substring(indent, colonIdx).trim();
        if (!key) continue;
        popDeeperThan(indent);
        let scope = stack[stack.length - 1];
        if (scope.indent !== indent) {
            const newScope = { indent, keys: new Map(), isSeqItem: false };
            stack.push(newScope);
            scope = newScope;
        }
        if (scope.keys.has(key)) {
            const firstLine = scope.keys.get(key);
            const indentStr = line.substring(0, indent);
            const rest = line.substring(indent);
            issues.push({
                id: 'F1', line: lineNum, column: indent + 1, length: key.length,
                title: '重复的 key',
                message: `第 ${lineNum} 行：key "${key}" 与第 ${firstLine} 行重复，后者会覆盖前者`,
                severity: 'warning',
                fix: `${indentStr}# [duplicate key removed] ${rest}`,
            });
        } else {
            scope.keys.set(key, lineNum);
        }
        const afterColon = line.substring(colonIdx + 1).trim();
        if (afterColon === '' || afterColon.startsWith('#')) {
            stack.push({ indent, keys: new Map(), isSeqItem: false });
        }
    }
    return issues;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser 兜底修复（P1~P4；仅在 yaml 库可用时启用）
// ═══════════════════════════════════════════════════════════════════════════
function generateFixForParseError(lineText, _col, errMsg) {
    if (!lineText) return undefined;
    const lower = String(errMsg || '').toLowerCase();
    const isNestedMap = lower.includes('nested map') || lower.includes('compact map') || lower.includes('not allowed');
    const isMissingQuote = lower.includes('missing closing') && lower.includes('quote');
    const isDuplicateKey = lower.includes('map keys must be unique') || (lower.includes('duplicate') && lower.includes('key'));
    const isSameColumn = lower.includes('same column') || lower.includes('must start at');

    if (isDuplicateKey) {
        const indent = lineText.length - lineText.trimStart().length;
        if (lineText.trimStart().startsWith('#')) return undefined;
        return `${lineText.substring(0, indent)}# [duplicate key removed] ${lineText.substring(indent)}`;
    }
    if (isSameColumn) {
        const indent = lineText.length - lineText.trimStart().length;
        if (lineText.trimStart().startsWith('#')) return undefined;
        return `${lineText.substring(0, indent)}# [indent mismatch] ${lineText.substring(indent)}`;
    }
    if (isNestedMap) {
        const seqMatch = lineText.match(/^(\s*-\s+)(.+)$/);
        if (seqMatch) {
            const prefix = seqMatch[1];
            const value = seqMatch[2].replace(/[\s\u00A0]+$/, '');
            return prefix + wrapValueWithQuote(value);
        }
        const firstColon = findYamlColon(lineText) >= 0 ? findYamlColon(lineText) : lineText.indexOf(':');
        if (firstColon > 0 && firstColon < lineText.length - 1) {
            let valStart = firstColon + 1;
            while (valStart < lineText.length && lineText[valStart] === ' ') valStart++;
            if (valStart < lineText.length) {
                const keyPart = lineText.substring(0, valStart);
                const value = lineText.substring(valStart).replace(/[\s\u00A0]+$/, '');
                return keyPart + wrapValueWithQuote(value);
            }
        }
        return undefined;
    }
    if (isMissingQuote) {
        const singles = lineText.split("'").length - 1;
        const doubles = (lineText.match(/"/g) || []).length;
        if (singles % 2 !== 0) return lineText + "'";
        if (doubles % 2 !== 0) return lineText + '"';
    }
    return undefined;
}

function truncateYamlMessage(msg) {
    const idx = String(msg || '').indexOf('\n');
    if (idx > 0) {
        const desc = msg.substring(0, idx).trim();
        const source = msg.substring(idx + 1).trim();
        return desc + (source.length > 80 ? ' | ' + source.substring(0, 80) + '…' : ' | ' + source);
    }
    return msg;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主校验函数（对齐 validateYamlContent）
// ═══════════════════════════════════════════════════════════════════════════
function validate(content, logger) {
    const issues = [];
    const lines = content.split('\n');

    // BOM
    if (content.charCodeAt(0) === 0xfeff) {
        const firstLine = lines[0] ?? '';
        const fixed = firstLine.charCodeAt(0) === 0xfeff ? firstLine.slice(1) : firstLine;
        logger.rule('BOM', 1, firstLine, 'file starts with U+FEFF');
        issues.push({
            id: 'BOM', line: 1, column: 1, length: 1,
            title: 'BOM 头',
            message: '文件开头包含 BOM (Byte Order Mark)，可能导致解析异常',
            severity: 'warning',
            fix: fixed,
        });
        logger.ruleAfter('BOM', 1, fixed);
    }

    // 逐行规则
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const ctx = buildLineCtx(line);
        for (const entry of RULES) {
            const issue = entry.rule(line, lineNum, ctx);
            if (!issue) continue;
            if (issue.fix !== undefined && issue.fix === line) continue;
            logger.rule(issue.id, lineNum, line, issue.title);
            logger.ruleAfter(issue.id, lineNum, issue.fix);
            issues.push(issue);
            if (entry.stopOnHit) break;
        }
    }

    // 文件级规则（F1 重复 key）
    try {
        const dup = ruleDuplicateKey(lines);
        for (const iss of dup) {
            logger.rule(iss.id, iss.line, lines[iss.line - 1] ?? '', iss.title);
            logger.ruleAfter(iss.id, iss.line, iss.fix);
        }
        issues.push(...dup);
    } catch (e) {
        logger.warn('duplicate-key rule crashed:', e && e.message ? e.message : e);
    }

    // Parser 兜底
    if (YAML) {
        try {
            const docs = YAML.parseAllDocuments(content);
            for (const doc of docs) {
                for (const err of (doc.errors || [])) {
                    const errLine = err?.linePos?.[0]?.line || 1;
                    const errCol = err?.linePos?.[0]?.col || 1;
                    if (issues.some(iss => iss.line === errLine && iss.severity === 'error')) continue;
                    const lineText = (errLine > 0 && errLine <= lines.length) ? lines[errLine - 1] : '';
                    let fix = generateFixForParseError(lineText, errCol, err.message);
                    if (fix !== undefined && fix === lineText) fix = undefined;
                    // 级联抑制：报错行上一行是「引号包裹块标量头」时，根因在上一行（R9 去引号），
                    // 不注释当前行，避免后续多行内容被误注释丢失。
                    if (fix !== undefined && /^\s*#/.test(fix) && errLine > 1 && isQuotedBlockScalarLine(lines[errLine - 2] || '')) {
                        fix = undefined;
                    }
                    logger.rule('P*', errLine, lineText, `parse error: ${err.message}`);
                    logger.ruleAfter('P*', errLine, fix);
                    issues.push({
                        id: 'P*', line: errLine, column: errCol, length: 1,
                        title: 'YAML 解析错误',
                        message: `YAML 解析错误 (第 ${errLine} 行): ${truncateYamlMessage(err.message)}`,
                        severity: 'error', fix,
                    });
                }
                for (const warn of (doc.warnings || [])) {
                    const wLine = warn?.linePos?.[0]?.line || 1;
                    if (issues.some(iss => iss.line === wLine && iss.message.includes(warn.message))) continue;
                    issues.push({
                        id: 'W*', line: wLine, column: warn?.linePos?.[0]?.col || 1, length: 1,
                        title: 'YAML 解析警告',
                        message: `YAML 解析警告 (第 ${wLine} 行): ${truncateYamlMessage(warn.message)}`,
                        severity: 'warning',
                    });
                }
            }
        } catch (_) {
            try {
                YAML.parse(content);
            } catch (parseErr) {
                const errLine = parseErr?.linePos?.[0]?.line || 1;
                const errCol = parseErr?.linePos?.[0]?.col || 1;
                if (!issues.some(iss => iss.line === errLine && iss.severity === 'error')) {
                    const lineText = (errLine > 0 && errLine <= lines.length) ? lines[errLine - 1] : '';
                    let fix = generateFixForParseError(lineText, errCol, parseErr.message);
                    if (fix !== undefined && fix === lineText) fix = undefined;
                    // 级联抑制：报错行上一行是「引号包裹块标量头」时，根因在上一行（R9 去引号），
                    // 不注释当前行，避免后续多行内容被误注释丢失。
                    if (fix !== undefined && /^\s*#/.test(fix) && errLine > 1 && isQuotedBlockScalarLine(lines[errLine - 2] || '')) {
                        fix = undefined;
                    }
                    logger.rule('P*', errLine, lineText, `parse-fallback error: ${parseErr.message}`);
                    logger.ruleAfter('P*', errLine, fix);
                    issues.push({
                        id: 'P*', line: errLine, column: errCol, length: 1,
                        title: 'YAML 格式错误',
                        message: `YAML 格式错误 (第 ${errLine} 行): ${truncateYamlMessage(parseErr.message)}`,
                        severity: 'error', fix,
                    });
                }
            }
        }
    } else {
        logger.warn('yaml 库不可用；已跳过 P1~P4 parser 级兜底修复。请在项目根目录安装：npm i yaml');
    }
    return issues;
}

// ═══════════════════════════════════════════════════════════════════════════
// 批量 apply：按行号降序、同一行取最后一条 fix（与 getAllFixes 一致）
// ═══════════════════════════════════════════════════════════════════════════
function applyFixes(content, issues, logger) {
    const lineFixes = new Map(); // line -> fixText[]
    for (const iss of issues) {
        if (iss.fix === undefined) continue;
        const arr = lineFixes.get(iss.line);
        if (arr) arr.push(iss.fix);
        else lineFixes.set(iss.line, [iss.fix]);
    }
    if (lineFixes.size === 0) return { newContent: content, applied: 0, skipped: 0 };

    const lines = content.split('\n');
    let applied = 0, skipped = 0;
    // 降序，避免行号漂移（这里其实按整行替换所以顺序无关，但保持与插件一致）
    const ordered = Array.from(lineFixes.entries()).sort((a, b) => b[0] - a[0]);
    for (const [lineNum, arr] of ordered) {
        const idx = lineNum - 1;
        if (idx < 0 || idx >= lines.length) { skipped++; continue; }
        const finalFix = arr[arr.length - 1];
        if (lines[idx] === finalFix) { skipped++; continue; }
        logger.debug(`APPLY L${lineNum}: ${JSON.stringify(lines[idx])} → ${JSON.stringify(finalFix)} (${arr.length} fix candidate${arr.length > 1 ? 's' : ''}, kept last)`);
        lines[idx] = finalFix;
        applied++;
    }
    return { newContent: lines.join('\n'), applied, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI 主入口
// ═══════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
    const opts = { file: null, dryRun: false, json: false, verbose: false, help: false };
    for (const a of argv.slice(2)) {
        if (a === '--dry-run' || a === '-n') opts.dryRun = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--verbose' || a === '-v') opts.verbose = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (!opts.file) opts.file = a;
    }
    return opts;
}

function printHelp() {
    console.log(`Usage: node scripts/fix-yaml.js <file> [--dry-run] [--json] [--verbose]

Options:
  --dry-run, -n   Do not modify the file; print what would be changed
  --json          Machine-readable JSON output
  --verbose, -v   Print each rule hit with BEFORE/AFTER line text
  --help, -h      Show this help
`);
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help || !opts.file) { printHelp(); process.exit(opts.help ? 0 : 1); }
    const filePath = path.resolve(opts.file);
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(2);
    }
    const logger = createLogger(opts.verbose);
    logger.info(`Reading ${filePath}`);
    const original = fs.readFileSync(filePath, 'utf-8');
    logger.info(`Size: ${original.length} bytes, ${original.split('\n').length} lines`);
    logger.info(`YAML parser: ${YAML ? 'available (P1~P4 enabled)' : 'NOT AVAILABLE (line-rules only)'}`);

    const issues = validate(original, logger);
    const { newContent, applied, skipped } = applyFixes(original, issues, logger);

    // 修复后再跑一次校验，得到剩余问题
    const remaining = validate(newContent, { info(){}, warn(){}, error(){}, debug(){}, rule(){}, ruleAfter(){} });

    if (opts.json) {
        const out = {
            file: filePath,
            dryRun: opts.dryRun,
            totalIssues: issues.length,
            errorCount: issues.filter(i => i.severity === 'error').length,
            warningCount: issues.filter(i => i.severity === 'warning').length,
            appliedLines: applied,
            skippedLines: skipped,
            remainingIssues: remaining.length,
            yamlLibAvailable: !!YAML,
            issues: issues.map(i => ({
                id: i.id, line: i.line, column: i.column,
                severity: i.severity, title: i.title, message: i.message,
                hasFix: i.fix !== undefined,
            })),
        };
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
        console.log(`\n───────────── 检测结果 ─────────────`);
        console.log(`文件            ： ${filePath}`);
        console.log(`总问题数        ： ${issues.length}  (error=${issues.filter(i => i.severity === 'error').length}, warning=${issues.filter(i => i.severity === 'warning').length})`);
        console.log(`可自动修复      ： ${issues.filter(i => i.fix !== undefined).length}`);
        console.log(`YAML 库         ： ${YAML ? '已加载（parser 兜底启用）' : '不可用（仅逐行规则）'}`);
        console.log(`───────────────────────────────────`);
        if (issues.length > 0) {
            console.log(`\n问题详单：`);
            for (const iss of issues) {
                const sev = iss.severity === 'error' ? '⛔' : '⚠️ ';
                const fixMark = iss.fix !== undefined ? '✅' : '  ';
                console.log(`  ${sev} ${fixMark} [${iss.id}] L${iss.line}:${iss.column}  ${iss.title}  ${iss.message}`);
            }
        }
        console.log(`\n───────────── 修复结果 ─────────────`);
        console.log(`应用修复行数    ： ${applied}`);
        console.log(`跳过行数        ： ${skipped}   (已一致 / 越界)`);
        console.log(`修复后剩余问题  ： ${remaining.length}`);
        console.log(`───────────────────────────────────`);
    }

    if (opts.dryRun) {
        logger.info('DRY-RUN 模式：未写回文件。');
    } else if (applied > 0) {
        fs.writeFileSync(filePath, newContent, 'utf-8');
        logger.info(`✅ 已写回文件（${applied} 行更新）`);
    } else {
        logger.info('无需修改（未发现可修复问题）。');
    }
    // 退出码：仍有 error 级问题 → 2；否则 0
    const errAfter = remaining.filter(i => i.severity === 'error').length;
    process.exit(errAfter > 0 ? 2 : 0);
}

if (require.main === module) {
    try { main(); }
    catch (e) { console.error('FATAL:', e && e.stack ? e.stack : e); process.exit(1); }
}

module.exports = { validate, applyFixes };
