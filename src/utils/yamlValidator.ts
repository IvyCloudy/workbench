/**
 * ============================================================================
 *  utils/yamlValidator.ts
 *  YAML 格式校验器
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 在用户打开 YAML 文件、展示案例编辑器之前，对文件内容逐行校验。
 *    2. 检测常见格式问题：Tab 缩进、行末空格、冒号后缺空格、特殊未引号值等。
 *    3. 结合 yaml 库的 parseDocument 获取精确的解析错误行号。
 *    4. 返回 Issue 列表供调用方弹窗展示。
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import * as vscode from 'vscode';
import { TelemetryService } from './telemetry';

// ============================================
// 类型定义
// ============================================

export interface YamlIssue {
    /** 1-based 行号 */
    line: number;
    /** 1-based 列号（近似） */
    column: number;
    /** 问题描述（已包含行号） */
    message: string;
    /** error = 可能导致解析失败，warning = 潜在格式问题 */
    severity: 'error' | 'warning';
    /** 建议修复后的整行内容（可选），用于弹窗展示"修改后的值" */
    fix?: string;
}

// ============================================
// YAML 格式保留字符（不加引号会被解析为特殊语法结构）
// ============================================

/**
 * 在未引号 YAML 值中存在风险的保留字符。
 * 这些字符会触发 YAML 特殊语法（映射、序列、锚点、标签等），
 * 如果期望的是字符串值，必须用引号包裹。
 */
const RESERVED_CHARS_PATTERN = /[\[\]{},&*!>|]/;

/** 每个保留字符的说明 */
const RESERVED_CHAR_DESCRIPTIONS: Record<string, string> = {
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

/**
 * 在未引号的值中查找首个有风险的保留字符
 */
function findFirstReservedChar(value: string): string | null {
    const match = value.match(RESERVED_CHARS_PATTERN);
    return match ? match[0] : null;
}

// ============================================
// YAML 布尔值歧义词（不加引号会被解析为布尔值）
// ============================================

const BOOLEAN_AMBIGUOUS = new Set([
    'true', 'false', 'TRUE', 'FALSE', 'True', 'False',
    'yes', 'no', 'YES', 'NO', 'Yes', 'No',
    'on', 'off', 'ON', 'OFF', 'On', 'Off',
    'null', 'NULL', 'Null', '~',
    '.inf', '.nan', '.INF', '.NAN', 'Infinity', '-Infinity',
]);

// ============================================
// 工具函数
// ============================================

/**
 * 截断 YAML 库错误消息中的源码片段。
 * 库错误通常格式为："错误描述 at line N, column M:\n<源码行内容>"
 * 源码行可能很长导致 VS Code 展示不全，这里保留错误描述 + 截断后的源码行（≤80 字符）。
 */
function truncateYamlMessage(msg: string): string {
    const idx = msg.indexOf('\n');
    if (idx > 0) {
        const desc = msg.substring(0, idx).trim();
        const source = msg.substring(idx + 1).trim();
        const maxLen = 80;
        return desc + (source.length > maxLen ? ' | ' + source.substring(0, maxLen) + '…' : ' | ' + source);
    }
    return msg;
}

/**
 * 对 YAML 解析错误尝试生成修复方案。
 * 目前支持：
 *   - 嵌套映射（nested mappings）→ 引号包裹含 {key:value} 的未引号值
 *   - 缺闭合引号（missing closing quote）→ 补上对应的闭合引号
 */
function generateFixForParseError(lineText: string, col: number, errMsg: string): string | undefined {
    if (!lineText) { return undefined; }
    const lower = errMsg.toLowerCase();

    const isNestedMap = lower.includes('nested map') || lower.includes('compact map') || lower.includes('not allowed');
    const isMissingQuote = lower.includes('missing closing') && lower.includes('quote');

    if (isNestedMap) {
        // 1. 序列项格式：`  - value_with_{}` — 优先匹配（比 key:value 更精确）
        const seqMatch = lineText.match(/^(\s*-\s+)(.+)$/);
        if (seqMatch) {
            const prefix = seqMatch[1];
            let value = seqMatch[2].replace(/[\s\u00A0]+$/, ''); // 去尾部特殊空格（\r 等），避免引号错行
            const hasDouble = value.includes('"');
            const hasSingle = value.includes("'");
            let wrapped: string;
            if (hasDouble && hasSingle) {
                wrapped = '"' + value.replace(/"/g, '\\"') + '"';
            } else if (hasDouble) {
                wrapped = "'" + value + "'";
            } else {
                wrapped = '"' + value + '"';
            }
            return prefix + wrapped;
        }
        // 2. key: value 格式 — 用第一个冒号作为分隔
        const firstColon = lineText.indexOf(':');
        if (firstColon > 0 && firstColon < lineText.length - 1) {
            let valStart = firstColon + 1;
            while (valStart < lineText.length && lineText[valStart] === ' ') {
                valStart++;
            }
            if (valStart < lineText.length) {
                const keyPart = lineText.substring(0, valStart);
                let value = lineText.substring(valStart).replace(/[\s\u00A0]+$/, '');
                const hasDouble = value.includes('"');
                const hasSingle = value.includes("'");
                let wrapped: string;
                if (hasDouble && hasSingle) {
                    wrapped = '"' + value.replace(/"/g, '\\"') + '"';
                } else if (hasDouble) {
                    wrapped = "'" + value + "'";
                } else {
                    wrapped = '"' + value + '"';
                }
                return keyPart + wrapped;
            }
        }
        return undefined;
    }

    if (isMissingQuote) {
        // 缺闭合引号：尝试找到未配对的引号并补上
        const singles = lineText.split("'").length - 1;
        const doubles = (lineText.match(/"/g) || []).length;
        if (singles % 2 !== 0) {
            // 单引号不成对 → 补一个单引号
            return lineText + "'";
        }
        if (doubles % 2 !== 0) {
            // 双引号不成对 → 补一个双引号
            return lineText + '"';
        }
    }

    return undefined;
}

/**
 * 读取文件内容并逐行校验 YAML 格式。
 * @param filePath YAML 文件绝对路径
 * @returns 格式问题列表；为空数组表示一切正常
 */
export async function validateYamlFile(filePath: string): Promise<YamlIssue[]> {
    let content: string;
    try {
        content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
        // 读文件失败不在本校验范围，交由调用方处理
        return [];
    }
    return validateYamlContent(content);
}

/**
 * 校验 YAML 字符串内容的格式。
 * @param content YAML 文件原文
 * @returns 格式问题列表
 */
export function validateYamlContent(content: string): YamlIssue[] {
    const issues: YamlIssue[] = [];
    const lines = content.split('\n');

    // ── 1. 文件级检查：BOM 头 ──
    if (content.charCodeAt(0) === 0xfeff) {
        issues.push({
            line: 1, column: 1,
            message: '文件开头包含 BOM (Byte Order Mark)，可能导致解析异常',
            severity: 'warning',
        });
    }

    // ── 2. 逐行检查 ──
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // 跳过空行和纯注释行
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue;
        }

        // 2a. Tab 缩进（致命错误，YAML 规范严格禁止）
        const leadingTabMatch = line.match(/^(\t+)/);
        if (leadingTabMatch) {
            // 建议将每个 Tab 替换为 4 个空格
            const fixed = line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
            issues.push({
                line: lineNum, column: 1,
                message: `第 ${lineNum} 行：使用了 Tab 缩进，YAML 规范不允许用 Tab 进行缩进，请改用空格`,
                severity: 'error',
                fix: fixed,
            });
            // Tab 缩进是致命问题，该行不再做其他检查
            continue;
        }

        // 2b. 任意位置的 Tab 字符（非首行 Tab 缩进）
        const tabIdx = line.indexOf('\t');
        if (tabIdx > 0) {
            issues.push({
                line: lineNum, column: tabIdx + 1,
                message: `第 ${lineNum} 行：字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误`,
                severity: 'warning',
            });
        }

        // 2c. 行末空格（可能导致缩进层级判断错误）
        if (line !== line.trimEnd() && line.length > 0) {
            issues.push({
                line: lineNum, column: line.trimEnd().length + 1,
                message: `第 ${lineNum} 行：末尾有多余空格，可能导致缩进层级判断错误`,
                severity: 'warning',
                fix: line.trimEnd(),
            });
        }

        // 2d. 冒号后缺少空格（key:value 而不是 key: value）
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const beforeColon = line.substring(0, colonIdx);
            const afterColon = line[colonIdx + 1];
            // 排除：URL（含 ://）、时间（含 ::）、引号包裹的值
            if (
                afterColon !== undefined &&
                afterColon !== ' ' &&
                afterColon !== '\r' &&
                !beforeColon.endsWith('://') &&          // URL
                !line.includes('::')                       // 不是时间/内联块
            ) {
                const valuePart = line.substring(colonIdx + 1).trim();
                if (valuePart.length > 0 && !/^["']/.test(valuePart) && !/^\d/.test(valuePart)) {
                    // 冒号后紧跟非数字、非引号字符，大概率格式不规范
                    // 建议修复：在冒号后插入一个空格
                    const fixed = line.substring(0, colonIdx + 1) + ' ' + line.substring(colonIdx + 1);
                    issues.push({
                        line: lineNum, column: colonIdx + 1,
                        message: `第 ${lineNum} 行：冒号后缺少空格，字段 "${beforeColon.trim()}" 的值未被正确识别`,
                        severity: 'warning',
                        fix: fixed,
                    });
                }
            }
        }

        // 2e. 检查未加引号的布尔歧义值
        // 匹配模式： key: value (value 是布尔歧义词)
        const kvMatch = line.match(/^\s*[^#:]+:\s*(.+?)(?:\s*#.*)?$/);
        if (kvMatch) {
            const rawValue = kvMatch[1].trim();
            const unquotedValue = rawValue.replace(/^['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]\s*/u, '').replace(/\s*['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]$/u, '');
            if (rawValue === unquotedValue && BOOLEAN_AMBIGUOUS.has(unquotedValue)) {
                // 建议修复：将值用双引号包裹；优先保留原值中的单引号使用双引号
                const quote = rawValue.includes('"') ? "'" : '"';
                const fixed = line.replace(rawValue, `${quote}${rawValue}${quote}`);
                issues.push({
                    line: lineNum, column: line.indexOf(':') + 2,
                    message: `第 ${lineNum} 行：值 "${unquotedValue}" 会被 YAML 解析为特殊类型，如需字符串请加引号`,
                    severity: 'warning',
                    fix: fixed,
                });
            }
        }

        // 2f. 检查 # 号出现在值中（YAML 会把 # 后内容当注释丢弃）
        // 例：requirement: 需求编号 #12345 → 解析后只保留 "需求编号 "
        //
        // 检测规则：行中有 #，且 # 在冒号之后的非注释位置（不是纯注释行开头），
        // 并且 # 前面有空格（说明 YAML 会将其后的内容当作注释截断），
        // 且 # 不在引号内（加引号的值中 # 是安全的）。
        const hashIdx = line.indexOf('#');
        if (hashIdx > 0) {
            const colonIdx2 = line.indexOf(':');
            // # 出现在冒号之后 => 可能把值截断
            if (colonIdx2 > 0 && hashIdx > colonIdx2) {
                const valueSection = line.substring(colonIdx2 + 1, hashIdx);
                const betweenColonAndHash = valueSection.trim();
                // 值部分不为空且 # 前面是空格，说明后面的内容会被当注释丢弃
                if (betweenColonAndHash.length > 0 && line[hashIdx - 1] === ' ') {
                    // 排除 # 在引号内的安全情况：冒号到 # 之间有未闭合的引号
                    const hasOpenDoubleQuote = valueSection.includes('"') && !valueSection.substring(valueSection.indexOf('"') + 1).includes('"');
                    const hasOpenSingleQuote = valueSection.includes("'") && !valueSection.substring(valueSection.indexOf("'") + 1).includes("'");
                    if (hasOpenDoubleQuote || hasOpenSingleQuote) {
                        // # 在引号内，安全，不报警
                    } else {
                        const afterHash = line.substring(hashIdx + 1).trim();
                        if (afterHash.length > 0) {
                            // 建议修复：用双引号包裹冒号后的整个值
                            const keyPart = line.substring(0, colonIdx2 + 1);
                            const valuePart = line.substring(colonIdx2 + 1);
                            const quote = valuePart.includes('"') ? "'" : '"';
                            const fixed = `${keyPart} ${quote}${valuePart.trim()}${quote}`;
                            issues.push({
                                line: lineNum, column: hashIdx + 1,
                                message: `第 ${lineNum} 行：值中包含 "#"，"${afterHash}" 会被 YAML 当作注释丢弃，如需保留请用引号包裹整个值`,
                                severity: 'warning',
                                fix: fixed,
                            });
                        }
                    }
                }
            }
        }
        // 2g. 检查未引号值中的 YAML 保留字符
        // 像 { } [ ] , & * ! > | 等字符在未引号值中会被解析为特殊语法
        const reservedKvMatch = line.match(/^\s*([^#:]+):\s*(.+?)(?:\s*#.*)?$/);
        if (reservedKvMatch) {
            const rawValue = reservedKvMatch[2].trim();
            // 排除空值与已引号包裹的值（兼顾 ASCII 和 Unicode 引号）
            const unquotedReserved = rawValue
                .replace(/^['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]\s*/u, '')
                .replace(/\s*['"\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02]$/u, '');
            if (rawValue.length > 0 && unquotedReserved === rawValue) {
                const reservedChar = findFirstReservedChar(rawValue);
                if (reservedChar) {
                    const desc = RESERVED_CHAR_DESCRIPTIONS[reservedChar] || '';
                    const quote = rawValue.includes('"') ? "'" : '"';
                    const fixed = line.replace(rawValue, `${quote}${rawValue}${quote}`);
                    const charPos = line.indexOf(reservedChar);
                    issues.push({
                        line: lineNum, column: charPos + 1,
                        message: `第 ${lineNum} 行：值中包含 YAML 保留字符 "${reservedChar}"${desc ? `（${desc}）` : ''}，如需字符串请用引号包裹`,
                        severity: 'warning',
                        fix: fixed,
                    });
                }
            }
        }
    }

    // ── 3. 使用 yaml 库尝试解析，捕获精确的语法错误 ──
    // 使用 parseAllDocuments 以支持多文档 YAML（--- 分隔），避免误报 "multiple documents" 错误。
    try {
        const docs = YAML.parseAllDocuments(content);
        for (const doc of docs) {
            const errors = (doc as any).errors || [];
            const warnings = (doc as any).warnings || [];

            for (const err of errors) {
                const errLine = err?.linePos?.[0]?.line || 1;
                const errCol = err?.linePos?.[0]?.col || 1;
                // 避免和上面逐行检查的 Tab 缩进错误重复
                const alreadyReported = issues.some(
                    (iss) => iss.line === errLine && iss.severity === 'error',
                );
                if (!alreadyReported) {
                    const lineText = (errLine > 0 && errLine <= lines.length) ? lines[errLine - 1] : '';
                    const fix = generateFixForParseError(lineText, errCol, err.message);
                    issues.push({
                        line: errLine,
                        column: errCol,
                        message: `YAML 解析错误 (第 ${errLine} 行): ${truncateYamlMessage(err.message)}`,
                        severity: 'error',
                        fix,
                    });
                }
            }

            for (const warn of warnings) {
                const wLine = warn?.linePos?.[0]?.line || 1;
                const alreadyReported = issues.some(
                    (iss) => iss.line === wLine && iss.message.includes(warn.message),
                );
                if (!alreadyReported) {
                    issues.push({
                        line: wLine,
                        column: warn?.linePos?.[0]?.col || 1,
                        message: `YAML 解析警告 (第 ${wLine} 行): ${truncateYamlMessage(warn.message)}`,
                        severity: 'warning',
                });
            }
        }
        }
    } catch {
        // parseAllDocuments / parseDocument 失败，尝试用 parse 获取错误信息
        try {
            YAML.parse(content);
        } catch (parseErr: any) {
            const errLine = parseErr?.linePos?.[0]?.line || 1;
            const errCol = parseErr?.linePos?.[0]?.col || 1;
            const alreadyReported = issues.some(
                (iss) => iss.line === errLine && iss.severity === 'error',
            );
            if (!alreadyReported) {
                const lineText = (errLine > 0 && errLine <= lines.length) ? lines[errLine - 1] : '';
                const fix = generateFixForParseError(lineText, errCol, parseErr.message);
                issues.push({
                    line: errLine,
                    column: errCol,
                    message: `YAML 格式错误 (第 ${errLine} 行): ${truncateYamlMessage(parseErr.message)}`,
                    severity: 'error',
                    fix,
                });
            }
        }

    }

    return issues;
}

// ============================================
// VS Code Diagnostics 发布（在 YAML 文件内展示波浪线）
// ============================================

/** YAML 校验结果的 DiagnosticCollection（全局单例） */
let yamlDiagnosticsCollection: vscode.DiagnosticCollection | undefined;

/**
 * 修复数据存储：key = uri.toString(), value = Map<行号, fix字符串>
 * 每行只有一个 fix，因为 validateYamlFile 中 Tab 缩进行会 continue 跳过后续检查。
 */
const fixDataStore = new Map<string, Map<number, string>>();

/**
 * 获取或创建 YAML 校验 DiagnosticCollection。
 * 需在 activate 中调用 init 后使用。
 */
export function getYamlDiagnosticsCollection(): vscode.DiagnosticCollection {
    if (!yamlDiagnosticsCollection) {
        yamlDiagnosticsCollection = vscode.languages.createDiagnosticCollection('yamlFormat');
    }
    return yamlDiagnosticsCollection;
}

/**
 * 在 activate 时注册并绑定到 context.subscriptions。
 */
export function initYamlDiagnostics(context: vscode.ExtensionContext): void {
    yamlDiagnosticsCollection = vscode.languages.createDiagnosticCollection('yamlFormat');
    context.subscriptions.push(yamlDiagnosticsCollection);
}

/**
 * 将 YamlIssue 列表转为 VS Code Diagnostic 列表，并发布到目标文件。
 */
export function publishYamlDiagnostics(uri: vscode.Uri, issues: YamlIssue[]): void {
    const collection = getYamlDiagnosticsCollection();
    const uriKey = uri.toString();
    console.log('[YAML-Validator] publishYamlDiagnostics', {
        uri: uriKey,
        fsPath: uri.fsPath,
        issueCount: issues.length,
        issuesWithFix: issues.filter(i => i.fix !== undefined).length,
    });
    if (issues.length === 0) {
        collection.delete(uri);
        fixDataStore.delete(uriKey);
        console.log('[YAML-Validator] fixDataStore 已清除 (无问题), key=', uriKey);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = issues.map(toDiagnostic);
    collection.set(uri, diagnostics);

    // ── 上报检测问题个数 ──
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.length - errorCount;
    try {
        TelemetryService.sendTelemetryEvent('yaml.validation.issues', {
            total: String(issues.length),
            errorCount: String(errorCount),
            warningCount: String(warningCount),
            ext: path.extname(uri.fsPath).toLowerCase().replace('.', '') || 'unknown',
        });
    } catch (_) { /* ignore */ }

    // 存储修复数据供 CodeActionProvider 使用
    const lineFixes = new Map<number, string>();
    for (const issue of issues) {
        if (issue.fix !== undefined) {
            lineFixes.set(issue.line, issue.fix);
        }
    }
    console.log('[YAML-Validator] 写入 fixDataStore: key=', uriKey, 'fixCount=', lineFixes.size, 'fixLines=', Array.from(lineFixes.keys()));
    fixDataStore.set(uriKey, lineFixes);

    // 打印当前 fixDataStore 所有 key
    console.log('[YAML-Validator] fixDataStore 当前所有 keys:', Array.from(fixDataStore.keys()));
}

/**
 * 获取指定文件的指定行的修复方案。
 * @param uri 文件 URI
 * @param line 1-based 行号
 * @returns 修复后的整行内容，或 undefined
 */
export function getFixForLine(uri: vscode.Uri, line: number): string | undefined {
    const lineFixes = fixDataStore.get(uri.toString());
    return lineFixes?.get(line);
}

/**
 * 获取指定文件的所有修复方案。
 * @returns 按行号升序排列的修复列表
 */
export function getAllFixes(uri: vscode.Uri): Array<{ line: number; fixedLine: string }> {
    const uriKey = uri.toString();
    const lineFixes = fixDataStore.get(uriKey);
    console.log('[YAML-Validator] getAllFixes: uriKey=', uriKey, 'hasData=', !!lineFixes, 'size=', lineFixes?.size ?? 0);
    if (!lineFixes) {
        console.log('[YAML-Validator] fixDataStore 当前所有 keys:', Array.from(fixDataStore.keys()));
        return [];
    }
    const result = Array.from(lineFixes.entries())
        .map(([line, fixedLine]) => ({ line, fixedLine }))
        .sort((a, b) => a.line - b.line);
    console.log('[YAML-Validator] getAllFixes 返回:', result.length, '条记录');
    return result;
}

/**
 * 将单个 YamlIssue 转为 vscode.Diagnostic。
 * 范围为问题所在整行（0 到行尾），确保波浪线覆盖整行。
 */
function toDiagnostic(issue: YamlIssue): vscode.Diagnostic {
    const lineIndex = issue.line - 1; // VS Code 使用 0-based 行号
    const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
    const severity = issue.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

    const diagnostic = new vscode.Diagnostic(range, issue.message, severity);
    diagnostic.source = 'YAML 格式';

    return diagnostic;
}

// ============================================
// 一键修复：将 fix 建议写入文件
// ============================================

/**
 * 将包含 fix 字段的 Issue 批量应用到本地文件。
 * 按行号降序写入以避免行偏移。
 * @param filePath 待修复的 YAML 文件路径
 * @param issues 含 fix 的校验结果
 * @returns 实际修复的行数
 */
export async function applyYamlFixes(filePath: string, issues: YamlIssue[]): Promise<number> {
    const fixes = issues
        .filter(i => i.fix !== undefined)
        .sort((a, b) => b.line - a.line);

    if (fixes.length === 0) { return 0; }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const fix of fixes) {
        const idx = fix.line - 1;
        if (idx >= 0 && idx < lines.length) {
            lines[idx] = fix.fix!;
        }
    }
    await fs.promises.writeFile(filePath, lines.join('\n'), 'utf-8');
    return fixes.length;
}
