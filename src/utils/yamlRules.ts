/**
 * ============================================================================
 *  utils/yamlRules.ts
 *  YAML 逐行校验规则表
 * ----------------------------------------------------------------------------
 *  职责：
 *    - 将「校验规则」组织为独立纯函数（YamlRule），每条规则关注单一问题。
 *    - 主校验循环遍历 RULES 数组，可并列命中多条（支持同行多修复）。
 *  规则输入：
 *    - line       ：当前行原文（不含换行符）
 *    - lineNum    ：1-based 行号
 *    - ctx        ：一次性预计算的辅助信息（如冒号位置、kv 匹配），减少重复正则
 *  规则输出：
 *    - null       ：本行未命中该规则
 *    - YamlIssue  ：命中，返回一个可上报的 issue（可含 fix）
 * ============================================================================
 */
import type { YamlIssue } from './yamlTypes';
import {
    RESERVED_CHARS_PATTERN,
    RESERVED_CHAR_DESCRIPTIONS,
    getAmbiguousType,
    AMBIGUOUS_TYPE_LABEL,
    QUOTE_STRIP_LEADING,
    QUOTE_STRIP_TRAILING,
    isYamlIndicatorValue,
} from './yamlConstants';

// ============================================
// 上下文（每行入循环前一次性预计算）
// ============================================

export interface LineCtx {
    /** 首个「YAML 结构冒号」的索引（-1 表示无）。已跳过引号内冒号。 */
    colonIdx: number;
    /** 首个「YAML 结构 #」的索引（-1 表示无）。已跳过引号内 #。 */
    hashIdx: number;
    /** 冒号前的 key 段（不含冒号本身），无冒号时为 undefined */
    keyText?: string;
    /** 冒号后到行末（未 trim），无冒号时为 undefined */
    valueText?: string;
}

// ============================================
// 引号 / 冒号 定位辅助
// ============================================

/**
 * 找到未被引号包裹的首个匹配字符位置。
 * 支持成对单引号 / 双引号，遇到反斜杠视为普通字符（不处理转义）。
 * @param line 原始行
 * @param chars 需要定位的字符集合（如 ':' / '#'）
 * @returns 首个未被引号包裹的目标字符索引；未找到返回 -1。
 */
export function findYamlChar(line: string, chars: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (!inDouble && c === "'") {
            inSingle = !inSingle;
            continue;
        }
        if (!inSingle && c === '"') {
            inDouble = !inDouble;
            continue;
        }
        if (!inSingle && !inDouble && chars.includes(c)) {
            return i;
        }
    }
    return -1;
}

/**
 * 找出未被引号包裹的首个「YAML 结构冒号」。
 * 排除：URL（://）、时间戳中 `::` 之类的非分隔冒号。
 */
export function findYamlColon(line: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (!inDouble && c === "'") { inSingle = !inSingle; continue; }
        if (!inSingle && c === '"') { inDouble = !inDouble; continue; }
        if (inSingle || inDouble) continue;
        if (c !== ':') continue;
        // 排除 ://（URL 协议）
        if (line.substring(i - 2, i) === 'ht' /* 大概率 http/https */ ||
            (line[i + 1] === '/' && line[i + 2] === '/')) {
            // 只跳过 :// 场景
            if (line[i + 1] === '/' && line[i + 2] === '/') continue;
        }
        // 排除 :: （时间戳、C++ 命名空间等）
        if (line[i + 1] === ':' || line[i - 1] === ':') continue;
        return i;
    }
    return -1;
}

/** 剥离值两端的成对引号（含中日文引号），只在真正首尾成对时才剥离。 */
function stripQuotes(value: string): string {
    const l = value.replace(QUOTE_STRIP_LEADING, '');
    if (l.length === value.length) return value; // 首字符不是引号，未剥离
    const r = l.replace(QUOTE_STRIP_TRAILING, '');
    if (r.length === l.length) return value; // 尾部无对应引号，回退不剥离
    return r;
}

/**
 * 选择合适的外层引号包裹值：
 *   - 值里有 " 且有 ' → 用 " 并转义内部 "
 *   - 值里有 "         → 用 '
 *   - 其他             → 用 "
 */
function wrapValueWithQuote(value: string): string {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && hasSingle) return '"' + value.replace(/"/g, '\\"') + '"';
    if (hasDouble) return "'" + value + "'";
    return '"' + value + '"';
}

/**
 * 用 substring 精确定位值起点做替换，避免 line.replace(rawValue,...) 的误匹配。
 * 说明：若 `冒号后紧跟非空格`（例如 `k:yes` / `k:{a}`），则在拼接时补一个空格，
 *       让 fix 结果一步到位（同时满足 R4「冒号后空格」+ 加引号），避免与 R4 产生 fix 冲突。
 */
function replaceValueByColon(line: string, colonIdx: number, wrapped: string): string {
    let valStart = colonIdx + 1;
    const needSpace = valStart < line.length && line[valStart] !== ' ';
    while (valStart < line.length && line[valStart] === ' ') valStart++;
    // 保留原始尾部空白（可能被其它规则单独处理）
    let valEnd = line.length;
    while (valEnd > valStart && /[\s\u00A0\r]/.test(line[valEnd - 1])) valEnd--;
    const tail = line.substring(valEnd);
    const prefix = line.substring(0, valStart) + (needSpace ? ' ' : '');
    return prefix + wrapped + tail;
}

// ============================================
// 上下文构造
// ============================================

export function buildLineCtx(line: string): LineCtx {
    const colonIdx = findYamlColon(line);
    const hashIdx = findYamlChar(line, '#');
    const ctx: LineCtx = { colonIdx, hashIdx };
    if (colonIdx > 0) {
        ctx.keyText = line.substring(0, colonIdx);
        ctx.valueText = line.substring(colonIdx + 1);
    }
    return ctx;
}

// ============================================
// 规则类型
// ============================================

export type YamlRule = (line: string, lineNum: number, ctx: LineCtx) => YamlIssue | null;

/** 特殊规则：命中后终止对该行的后续规则（如 Tab 缩进直接跳过） */
export interface YamlRuleWithStop {
    rule: YamlRule;
    stopOnHit?: boolean;
    /** 简短标题（用于 Quick Fix 菜单） */
    title: string;
}

// ============================================
// 具体规则
// ============================================

/** R1: Tab 缩进 —— 致命错误，命中后终止该行其他规则
 *  策略：将行首每个 `\t` 替换为 2 个空格（YAML 主流规范推荐 2 空格缩进），
 *  兼容"父/兄弟 map key 使用 2 空格"的常见情况，避免修完后仍触发缩进不齐错误。
 */
const tabIndentRule: YamlRule = (line, lineNum) => {
    const m = line.match(/^(\t+)/);
    if (!m) return null;
    const fixed = line.replace(/^\t+/, (tabs) => '  '.repeat(tabs.length));
    return {
        line: lineNum, column: 1, length: m[1].length,
        title: 'Tab 缩进',
        message: `第 ${lineNum} 行：使用了 Tab 缩进，YAML 规范不允许用 Tab 进行缩进，请改用空格`,
        severity: 'error',
        fix: fixed,
    };
};

/** R2: 非首列 Tab 字符 —— 未被引号包裹的替换为空格，被包裹的保留
 *  优化：位于"行末连续空白区间"内的 Tab 交给 R3（trailingSpaceRule）统一处理，
 *  避免同一个 Tab 同时被 R2 + R3 报两条诊断而让用户困惑。
 */
const inlineTabRule: YamlRule = (line, lineNum) => {
    const idx = line.indexOf('\t');
    if (idx <= 0) return null;
    // 行末连续空白（空格 / Tab）起点：>= trailingStart 的位置全部归 R3
    const trimmed = line.trimEnd();
    const trailingStart = trimmed.length;
    // 逐字符扫描：跟踪引号状态；只替换"不在引号内、不在行首缩进、也不在行末空白区间"的 Tab
    let inSingle = false;
    let inDouble = false;
    let hasReplaceable = false;
    let firstReportIdx = -1;
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
    // 若没有任何"非行末空白区间"的 Tab 需要处理，直接返回 null，避免与 R3 重复诊断
    if (firstReportIdx < 0) return null;
    const fixed = hasReplaceable ? out : undefined;
    return {
        line: lineNum, column: firstReportIdx + 1, length: 1,
        title: '含 Tab 字符',
        message: `第 ${lineNum} 行：字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误`,
        severity: 'warning',
        ...(fixed !== undefined ? { fix: fixed } : {}),
    };
};

/** R3: 行末空格 */
const trailingSpaceRule: YamlRule = (line, lineNum) => {
    if (line.length === 0) return null;
    const trimmed = line.trimEnd();
    if (trimmed === line) return null;
    return {
        line: lineNum, column: trimmed.length + 1, length: line.length - trimmed.length,
        title: '行末多余空格',
        message: `第 ${lineNum} 行：末尾有多余空格，可能导致缩进层级判断错误`,
        severity: 'warning',
        fix: trimmed,
    };
};

/** R4: 冒号后缺少空格
 *  去重优化（避免 fix 冲突）：
 *   - `key:\tvalue`  → 交给 R2（Tab→空格 后即满足）
 *   - `key:<歧义值>` (yes/null/…) → 交给 R5，R5 一步生成带空格的引号 fix
 *   - `key:<含保留字符>` (`{`/`[`/`&`/`*`/`!`/`>`/`|`/`,`) → 交给 R7，同理
 *  避免同一位置两条 fix 各修一半（一条补空格但值仍不安全；另一条加引号但无空格）。
 */
const colonSpaceRule: YamlRule = (line, lineNum, ctx) => {
    if (ctx.colonIdx <= 0) return null;
    const colonIdx = ctx.colonIdx;
    const afterColon = line[colonIdx + 1];
    if (afterColon === undefined || afterColon === ' ' || afterColon === '\r') return null;
    // Tab 场景交给 R2 处理（Tab→空格 后即满足"冒号后空格"）
    if (afterColon === '\t') return null;
    // 后续字符是数字或引号，视为合法（YAML 支持 key:123 但为规范起见其实也可提示；这里保持旧行为）
    const valuePart = line.substring(colonIdx + 1).trim();
    if (valuePart.length === 0) return null;
    if (/^["']/.test(valuePart) || /^\d/.test(valuePart)) return null;
    // 让位 R5：值本身是歧义值（yes/null/on/…），R5 会生成一步到位的 `k: "yes"` fix
    if (getAmbiguousType(valuePart)) return null;
    // 让位 R7：值包含 YAML 保留字符 且 不是合法 YAML 指示符（如 `[]`/`{}`/`|`/`*a`）
    //   —— 若是合法指示符，R7 会豁免不报，此时 R4 应照常补空格（否则用户看不到任何警告）。
    if (RESERVED_CHARS_PATTERN.test(valuePart) && !isYamlIndicatorValue(valuePart)) return null;
    const fixed = line.substring(0, colonIdx + 1) + ' ' + line.substring(colonIdx + 1);
    return {
        line: lineNum, column: colonIdx + 1, length: 1,
        title: '缺少空格',
        message: `第 ${lineNum} 行：冒号后缺少空格，字段 "${ctx.keyText?.trim()}" 的值未被正确识别`,
        severity: 'warning',
        fix: fixed,
    };
};

/** R5: 布尔/null/特殊数值 未加引号
 *  去重优化：若值段还包含 `<空格>#` 型行内注释（会触发 R6），
 *  则本行让位 R6 独占——R6 的 fix 会把「值 + 注释」整体加引号，覆盖 R5 的意图，
 *  否则两条 fix 会冲突（R5 只保留 `"yes"` 丢注释；R6 保留 `"yes #note"`）。
 */
const ambiguousValueRule: YamlRule = (line, lineNum, ctx) => {
    if (ctx.colonIdx <= 0 || !ctx.valueText) return null;
    // 让位 R6：仅当**紧贴的 ` #`**（gap == 1）时才让位——此时 R6 会真正触发。
    // gap >= 2 是**合法对齐尾注释**（R6 会豁免不报），此时 R5 应正常处理歧义值 + 保留尾注释。
    const hashInValRaw = findYamlChar(ctx.valueText, '#');
    if (hashInValRaw > 0 && ctx.valueText[hashInValRaw - 1] === ' ' &&
        ctx.valueText.substring(hashInValRaw + 1).trim().length > 0) {
        // 计算值 trim 后到 # 之间的空白 gap（在 valueText 内）
        const valTrimLen = ctx.valueText.substring(0, hashInValRaw).replace(/\s+$/, '').length;
        const gapInVal = hashInValRaw - valTrimLen;
        if (gapInVal < 2) {
            return null; // 让位 R6
        }
        // gap >= 2 视为合法对齐尾注释，R5 继续处理，但仅对 # 之前的值段做 R5 判定
    }
    // 去掉行内注释
    let rawValueRaw = ctx.valueText;
    // 只有当 # 前有空格时才认作注释
    const hashInVal = findYamlChar(rawValueRaw, '#');
    if (hashInVal > 0 && rawValueRaw[hashInVal - 1] === ' ') {
        rawValueRaw = rawValueRaw.substring(0, hashInVal);
    }
    const rawValue = rawValueRaw.trim();
    if (rawValue.length === 0) return null;
    // 剥离引号后若发生变化说明已加引号，安全
    const unquoted = stripQuotes(rawValue);
    if (unquoted !== rawValue) return null;
    const type = getAmbiguousType(rawValue);
    if (!type) return null;
    const wrapped = wrapValueWithQuote(rawValue);
    const fixed = replaceValueByColon(line, ctx.colonIdx, wrapped);
    return {
        line: lineNum, column: ctx.colonIdx + 2, length: rawValue.length,
        title: `${AMBIGUOUS_TYPE_LABEL[type]} 需引号`,
        message: `第 ${lineNum} 行：值 "${rawValue}" 会被 YAML 解析为${AMBIGUOUS_TYPE_LABEL[type]}，如需字符串请加引号`,
        severity: 'warning',
        fix: fixed,
    };
};

/** R6: 值中出现 # 号（会被 YAML 当注释丢弃） */
const hashInValueRule: YamlRule = (line, lineNum, ctx) => {
    if (ctx.colonIdx <= 0 || ctx.hashIdx <= ctx.colonIdx) return null;
    const hashIdx = ctx.hashIdx;
    // 值段：从 : 后到 # 前
    const valueSection = line.substring(ctx.colonIdx + 1, hashIdx);
    if (valueSection.trim().length === 0) return null;
    // # 前必须是空格才会被 YAML 当作注释
    if (line[hashIdx - 1] !== ' ') return null;
    const afterHash = line.substring(hashIdx + 1).trim();
    if (afterHash.length === 0) return null;
    // ── 关键豁免：区分「值中 #」与「合法对齐尾注释」 ──
    //   R6 的核心场景是 `desc: my #note`：值 `my` 紧接一个空格 + `#note`，
    //   YAML 会把 `#note` 当注释丢弃 → 需要包引号保留。
    //   但形如 `enabled: yes                  # 歧义布尔` 是**对齐尾注释**：
    //     - 值 `yes` trim 后，后面有 >=2 个连续空格才到 `#`
    //     - `#` 之后是"独立于值的说明性文字"（用户明确用大量空格与值分隔）
    //   此时 `#` 本就是合法的 YAML 行内注释，硬包引号会：
    //     ① 把整段注释文本吞进字符串（图 3 那种"只加左引号"病态观感）
    //     ② 改变值的实际类型（把独立注释变成值的一部分）
    //   因此，只要值 trim 后到 `#` 之间 ≥ 2 个连续空格，就认作"合法对齐注释"，R6 豁免。
    const valueTrimEnd = valueSection.replace(/\s+$/, '').length + ctx.colonIdx + 1;
    // 从值末尾字符（不含尾空白）到 hashIdx 之间的空白字符数
    const gap = hashIdx - valueTrimEnd;
    if (gap >= 2) return null;
    // 豁免：# 前的值段本身是合法 YAML 指示符（闭合的 flow 集合 / 块标量 / anchor / alias / tag）
    //   —— 此时 `#note` 就是合法的行内注释（YAML 规范允许），
    //      再包引号反而破坏了 flow / block scalar 语义。
    //   （与 R7 的豁免逻辑共用同一套指示符判定）
    const valueBeforeHash = valueSection.trim();
    if (isYamlIndicatorValue(valueBeforeHash)) return null;
    // ── R6 fix：只包裹「值 + 紧贴的 #伪注释文本段」，不吞后面的对齐尾注释 ──
    //   例：`desc: my #note                # 真正注释`
    //        └─────┬─────┘└──────┬──────┘
    //         要包裹的段        保留的合法尾注释
    //   算法：
    //     1. 从 hashIdx 起找到"#伪注释段"的结束：往后扫描非空白，直到遇到"多空格+#"或行末。
    //     2. 包裹段 = 值段 trim 后 + 单空格 + `#伪注释文本` 之间的原文（保留内部单空格）。
    //     3. 尾部保留 `<对齐空格><真正注释>` 原样拼回去。
    //   若行中只有一个 #（即 `key: my #note` 无尾注释），wrapEnd 就到行末，行为等价于原来。
    let wrapEnd = line.length;
    // 从 hashIdx+1 起扫描，遇到 `<空格><空格>#` 或 `<空格>#` 后无非空字符时停下
    for (let i = hashIdx + 1; i < line.length; i++) {
        // 命中"多空格 + #"：即当前 i 位置是空格，且往后找非空白得到 #
        if (line[i] === ' ' || line[i] === '\t') {
            let j = i;
            while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
            // 只有当"空白 gap >= 2"且下一个字符是 # 时才认作"对齐尾注释"分界
            if (j - i >= 2 && line[j] === '#') {
                wrapEnd = i; // 包裹段到 i 为止（不含对齐空格）
                break;
            }
            // 否则继续（单空格视为 #伪注释段的一部分）
            i = j - 1;
        }
    }
    const wrapContent = line.substring(ctx.colonIdx + 1, wrapEnd).trim();
    const wrapped = wrapValueWithQuote(wrapContent);
    const tail = line.substring(wrapEnd); // 对齐空格 + 尾注释（若有）
    const fixed = line.substring(0, ctx.colonIdx + 1) + ' ' + wrapped + tail;
    return {
        line: lineNum, column: hashIdx + 1, length: line.length - hashIdx,
        title: '值中 # 会被丢弃',
        message: `第 ${lineNum} 行：值中包含 "#"，"${afterHash}" 会被 YAML 当作注释丢弃，如需保留请用引号包裹整个值`,
        severity: 'warning',
        fix: fixed,
    };
};

/** R7: 值中出现 YAML 保留字符
 *  去重优化：若值段还包含 `<空格>#` 型行内注释（会触发 R6），
 *  则本行让位 R6 独占——R6 的 fix 会把「值 + 注释」整段包裹到引号中，同时消解保留字符风险。
 */
const reservedCharRule: YamlRule = (line, lineNum, ctx) => {
    if (ctx.colonIdx <= 0 || !ctx.valueText) return null;
    // 让位 R6：仅当**紧贴的 ` #`**（gap == 1）时才让位——此时 R6 会真正触发。
    // gap >= 2 是**合法对齐尾注释**（R6 会豁免不报），此时 R7 应正常处理保留字符 + 保留尾注释。
    const hashInValRaw = findYamlChar(ctx.valueText, '#');
    if (hashInValRaw > 0 && ctx.valueText[hashInValRaw - 1] === ' ' &&
        ctx.valueText.substring(hashInValRaw + 1).trim().length > 0) {
        const valTrimLen = ctx.valueText.substring(0, hashInValRaw).replace(/\s+$/, '').length;
        const gapInVal = hashInValRaw - valTrimLen;
        if (gapInVal < 2) {
            return null; // 让位 R6
        }
        // gap >= 2 视为合法对齐尾注释，R7 继续处理（对 # 之前的值段做保留字符判定）
    }
    let rawValueRaw = ctx.valueText;
    const hashInVal = findYamlChar(rawValueRaw, '#');
    if (hashInVal > 0 && rawValueRaw[hashInVal - 1] === ' ') {
        rawValueRaw = rawValueRaw.substring(0, hashInVal);
    }
    const rawValue = rawValueRaw.trim();
    if (rawValue.length === 0) return null;
    const unquoted = stripQuotes(rawValue);
    if (unquoted !== rawValue) return null;
    // 豁免：值起始位置是合法 YAML 指示符（block scalar / alias / anchor / tag / 闭合的 flow 集合）
    //   —— 这些是一等语法元素，不是"字符串里含保留字符"，加引号反而破坏语义。
    //   与 skill/yaml-format-fix 中的 isYamlIndicatorValue 行为一致。
    if (isYamlIndicatorValue(rawValue)) return null;
    const m = rawValue.match(RESERVED_CHARS_PATTERN);
    if (!m) return null;
    const reservedChar = m[0];
    const desc = RESERVED_CHAR_DESCRIPTIONS[reservedChar] || '';
    const wrapped = wrapValueWithQuote(rawValue);
    const fixed = replaceValueByColon(line, ctx.colonIdx, wrapped);
    const charPos = line.indexOf(reservedChar, ctx.colonIdx + 1);
    return {
        line: lineNum, column: (charPos < 0 ? ctx.colonIdx + 2 : charPos + 1), length: 1,
        title: `保留字符 "${reservedChar}"`,
        message: `第 ${lineNum} 行：值中包含 YAML 保留字符 "${reservedChar}"${desc ? `（${desc}）` : ''}，如需字符串请用引号包裹`,
        severity: 'warning',
        fix: fixed,
    };
};

/** R8: 序列项 `-` 后缺少空格（如 `-value` 或 `-{}`；行首才作 sequence 语义） */
const dashSpaceRule: YamlRule = (line, lineNum) => {
    // 匹配：任意缩进 + '-' + 非空白非破折号字符
    // 排除：'- '（合法序列）、'---'/'--'（文档分隔符/注释）
    const m = line.match(/^(\s*)-([^\s-])/);
    if (!m) return null;
    const indent = m[1];
    const dashCol = indent.length; // 0-based
    // 首个非空白字符必须是 '-'，且后面紧接一个非空白非'-'的可打印字符
    const rest = line.substring(dashCol + 1); // '-' 之后
    // 修复：在 '-' 后插入一个空格
    const fixed = line.substring(0, dashCol + 1) + ' ' + rest;
    return {
        line: lineNum, column: dashCol + 2, length: 1,
        title: '缺少空格',
        message: `第 ${lineNum} 行：序列符号 "-" 后缺少空格，YAML 无法识别为列表项`,
        severity: 'warning',
        fix: fixed,
    };
};

// ============================================
// 规则表（顺序决定命中优先级；同行会遍历全部规则，各自生成 issue）
// ============================================

export interface YamlRuleEntry {
    rule: YamlRule;
    /** 命中后是否终止该行其它规则检查 */
    stopOnHit?: boolean;
}

export const YAML_RULES: YamlRuleEntry[] = [
    { rule: tabIndentRule, stopOnHit: true }, // Tab 缩进是致命，命中即停
    { rule: inlineTabRule },
    { rule: trailingSpaceRule },
    { rule: colonSpaceRule },
    { rule: dashSpaceRule },
    { rule: ambiguousValueRule },
    { rule: hashInValueRule },
    { rule: reservedCharRule },
];

// ============================================
// 文件级规则（跨行状态：重复 key / 缩进层级）
// ============================================

export type YamlFileRule = (lines: string[]) => YamlIssue[];

/**
 * F1: 同一映射作用域内的重复 key。
 *
 * 作用域模型：
 *   - 每个「map 作用域」维护一个 key -> firstLineNum 的 Map。
 *   - 栈中作用域以缩进列 (indent) 为分层依据；遇到更浅或同层时弹栈。
 *   - 特殊：sequence 的每个 `- ` item 都是一个**独立的 map 作用域**，
 *     即便多个 item 缩进相同也各自独立（用 seqId 区分同缩进不同 item）。
 *
 * 关键行处理：
 *   1) `- key: value` 或 `- key:` （sequence 中的 map item 首行）
 *      · dashCol = 前导空格数；itemIndent = dashCol + 2（'- ' 后的列）
 *      · 先按 dashCol 弹出所有 indent >= dashCol 的旧作用域
 *      · 压入一个"seq item"作用域，indent = itemIndent，seqId 递增
 *      · 把 key 记入该新作用域
 *   2) `- value` （纯值型序列项，非 map）
 *      · 仅推进作用域边界：弹出 indent >= dashCol 的作用域
 *      · 不建立 map 作用域（等到后续 map key 出现时再建）
 *   3) 普通 `key: value` / `key:`
 *      · 弹出 indent >= 当前 indent 的作用域
 *      · 把 key 记入栈顶作用域
 *      · 若是 `key:`（空值/注释），压入新的子作用域（indent = 当前 indent）
 */
const duplicateKeyRule: YamlFileRule = (lines) => {
    const issues: YamlIssue[] = [];
    // 栈元素：indent 为该作用域下 key 的列位置；isSeqItem 表示"由序列 item 开启"，
    // 这类作用域即便同缩进也不能被其他兄弟共用（每个 '-' 独立）。
    interface Scope {
        indent: number;
        keys: Map<string, number>;
        isSeqItem: boolean;
    }
    const stack: Scope[] = [
        { indent: -1, keys: new Map(), isSeqItem: false },
    ];

    /** 弹出所有 indent > target 的作用域（普通弹栈）。 */
    const popDeeperThan = (target: number) => {
        while (stack.length > 1 && stack[stack.length - 1].indent > target) {
            stack.pop();
        }
    };
    /** 遇到新的 '-' 时使用：先弹到 dashCol 之下，再弹掉同缩进的旧 seq item 作用域（每个 '-' 独立）。 */
    const popForNewDash = (dashCol: number) => {
        popDeeperThan(dashCol);
        // 弹掉挂在 dashCol 上的旧 seq item + 其"子作用域"（子作用域 indent = dashCol + 2 但会因 popDeeperThan 先弹掉）
        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            // seq item 作用域的 indent 是 dashCol + 2；此时应弹
            if (top.isSeqItem && top.indent > dashCol) { stack.pop(); continue; }
            break;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('...')) continue;
        // 跳过 tab 缩进行（另有规则处理）
        if (line.startsWith('\t')) continue;

        // 计算前导空格数
        const indent = line.length - line.trimStart().length;

        // -------- Case A: sequence item ('- ' 开头) --------
        if (trimmed === '-' || trimmed.startsWith('- ')) {
            const dashCol = indent;
            // 新的 '-' 到来：弹到 dashCol 之下，并干掉挂在 dashCol 上的旧 seq item 作用域
            popForNewDash(dashCol);

            // 拿到 '- ' 后的内容（可能是 map 首键 / 纯值 / 空）
            // 用 findYamlColon 判定是不是 map 首键
            const afterDashStart = dashCol + 2; // 跳过 '- '
            if (afterDashStart > line.length) continue;
            const afterDashText = line.substring(afterDashStart);
            const colonInRest = findYamlColon(afterDashText);

            if (trimmed === '-') {
                // 空的 '-'：只推进作用域边界，不建 map 作用域
                continue;
            }

            if (colonInRest > 0) {
                // '- key: value' 或 '- key:'  → 新建一个 item 作用域，itemIndent = dashCol + 2
                const itemIndent = afterDashStart;
                const key = afterDashText.substring(0, colonInRest).trim();
                const itemScope: Scope = { indent: itemIndent, keys: new Map(), isSeqItem: true };
                stack.push(itemScope);
                if (key && !key.startsWith('- ')) {
                    itemScope.keys.set(key, lineNum);
                }
                // 若值为空/仅注释，说明这是 key 的子结构入口，压入更深子作用域
                const afterColonAbs = afterDashStart + colonInRest + 1;
                const afterColonText = line.substring(afterColonAbs).trim();
                if (afterColonText === '' || afterColonText.startsWith('#')) {
                    stack.push({ indent: itemIndent, keys: new Map(), isSeqItem: false });
                }
            } else {
                // '- value'：纯值型序列项，作用域已弹到 dashCol 之下，不再建立 map 作用域
                continue;
            }
            continue;
        }

        // -------- Case B: 普通 map key --------
        const colonIdx = findYamlColon(line);
        if (colonIdx <= 0) continue;
        const key = line.substring(indent, colonIdx).trim();
        if (!key) continue;

        popDeeperThan(indent);
        // 若栈顶作用域 indent 不等于当前 indent，说明这是首个属于 (indent) 层的键
        // 若栈顶更浅（indent 更小），需要新建一个 (indent) 层的普通作用域
        let scope = stack[stack.length - 1];
        if (scope.indent !== indent) {
            const newScope: Scope = { indent, keys: new Map(), isSeqItem: false };
            stack.push(newScope);
            scope = newScope;
        }
        if (scope.keys.has(key)) {
            const firstLine = scope.keys.get(key)!;
            // 修复策略：把重复行改成注释，保留原内容以便用户复查，同时避免 YAML parse error
            const indentStr = line.substring(0, indent);
            const rest = line.substring(indent);
            const fixed = `${indentStr}# [duplicate key removed] ${rest}`;
            issues.push({
                line: lineNum, column: indent + 1, length: key.length,
                title: '重复的 key',
                message: `第 ${lineNum} 行：key "${key}" 与第 ${firstLine} 行重复，后者会覆盖前者`,
                severity: 'warning',
                fix: fixed,
            });
        } else {
            scope.keys.set(key, lineNum);
        }
        // 若当前行是 key: （值为空，可能开启子作用域），压入新作用域
        const afterColon = line.substring(colonIdx + 1).trim();
        if (afterColon === '' || afterColon.startsWith('#')) {
            stack.push({ indent, keys: new Map(), isSeqItem: false });
        }
    }
    return issues;
};

export const YAML_FILE_RULES: YamlFileRule[] = [
    duplicateKeyRule,
];

// ============================================
// 解析错误场景的修复策略（供 parse 错误使用）
// ============================================

/**
 * 对 YAML 解析错误尝试生成修复方案。
 * 目前支持：
 *   - 嵌套映射 → 引号包裹含 {key:value} 的未引号值
 *   - 缺闭合引号 → 补上对应的闭合引号
 *   - 重复 key → 注释化该行
 *   - 缩进不齐 (same column) → 注释化该行
 */
export function generateFixForParseError(lineText: string, _col: number, errMsg: string): string | undefined {
    if (!lineText) return undefined;
    const lower = errMsg.toLowerCase();
    const isNestedMap = lower.includes('nested map') || lower.includes('compact map') || lower.includes('not allowed');
    const isMissingQuote = lower.includes('missing closing') && lower.includes('quote');
    const isDuplicateKey = lower.includes('map keys must be unique') || lower.includes('duplicate') && lower.includes('key');
    const isSameColumn = lower.includes('same column') || lower.includes('must start at');

    if (isDuplicateKey) {
        // 注释掉整行（保留原内容供人工复查），避免 YAML parser 继续报错
        const indent = lineText.length - lineText.trimStart().length;
        if (lineText.trimStart().startsWith('#')) return undefined; // 已是注释
        const indentStr = lineText.substring(0, indent);
        const rest = lineText.substring(indent);
        return `${indentStr}# [duplicate key removed] ${rest}`;
    }

    if (isSameColumn) {
        // 缩进不齐导致的 mapping items 列错位：兜底策略是注释化该行，
        // 用户可复查后再手工调整缩进。保留原内容不丢失。
        const indent = lineText.length - lineText.trimStart().length;
        if (lineText.trimStart().startsWith('#')) return undefined; // 已是注释
        const indentStr = lineText.substring(0, indent);
        const rest = lineText.substring(indent);
        return `${indentStr}# [indent mismatch] ${rest}`;
    }

    if (isNestedMap) {
        // 序列项优先： "  - value_with_{}"
        const seqMatch = lineText.match(/^(\s*-\s+)(.+)$/);
        if (seqMatch) {
            const prefix = seqMatch[1];
            const value = seqMatch[2].replace(/[\s\u00A0]+$/, '');
            return prefix + wrapValueWithQuote(value);
        }
        // key: value
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

    // ── 通用兜底：未匹配到任何具体分支的 parse error ──
    //   例：`!tag &anchor *alias >fold |lit` 这类"多指示符拼接"的极端错误值，
    //   任何规则都无法自动构造合法值。此时统一注释化，把不可解析行剔除
    //   ，避免污染整份文档的解析。
    //   注意：这是**破坏性 fix**，与 `isIndentMismatchFallback` 一样，
    //   在 handleFixAll 中会被延迟到最后一轮生效。
    if (!lineText.trimStart().startsWith('#')) {
        const indent = lineText.length - lineText.trimStart().length;
        const indentStr = lineText.substring(0, indent);
        const rest = lineText.substring(indent);
        return `${indentStr}# [unparseable] ${rest}`;
    }
    return undefined;
}

// ============================================
// 截断 YAML 库错误消息
// ============================================

export function truncateYamlMessage(msg: string): string {
    const idx = msg.indexOf('\n');
    if (idx > 0) {
        const desc = msg.substring(0, idx).trim();
        const source = msg.substring(idx + 1).trim();
        const maxLen = 80;
        return desc + (source.length > maxLen ? ' | ' + source.substring(0, maxLen) + '…' : ' | ' + source);
    }
    return msg;
}
