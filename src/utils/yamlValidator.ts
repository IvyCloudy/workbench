/**
 * ============================================================================
 *  utils/yamlValidator.ts
 *  YAML 格式校验器（编排层）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 读取 YAML 文本，遍历规则表逐行校验（详见 yamlRules.ts）。
 *    2. 结合 yaml 库的 parseAllDocuments 拿到精确的语法错误行号。
 *    3. 将 YamlIssue → vscode.Diagnostic，支持精准列/长度范围。
 *    4. 维护每文件的修复表（Map<line, Fix[]>），支持同一行叠加多条修复。
 *    5. 文档关闭时主动清理修复表，避免内存泄漏。
 * ============================================================================
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as YAML from 'yaml';
import * as vscode from 'vscode';
import { TelemetryService } from './telemetry';
import { createLogger } from './logger';
import type { YamlIssue } from './yamlTypes';
import { YAML_DIAGNOSTIC_SOURCE } from './yamlConstants';
import {
    YAML_RULES,
    YAML_FILE_RULES,
    buildLineCtx,
    generateFixForParseError,
    truncateYamlMessage,
    isQuotedBlockScalarLine,
} from './yamlRules';

// 类型再导出，保持外部导入路径兼容
export type { YamlIssue } from './yamlTypes';

const log = createLogger('YAML');

// ============================================
// 破坏性 fix 识别
// ============================================
//   parser 兜底策略产出的 fix 会把行**注释化**（保留原文供人工复查），
//   这类 fix 一旦被优先应用，会覆盖同一行的规则修复（如 R4 补空格），
//   导致"修复 error / 修复单行"变成"整行注释化"。
//   本 helper 与 handler 中的 isIndentMismatchFallback 保持一致，
//   用于在 issue 生成阶段就避免破坏性 fix 与非破坏性 fix 同行竞争。

const DESTRUCTIVE_FIX_PREFIXES = [
    '# [indent mismatch]',
    '# [duplicate key removed]',
    '# [unparseable]',
];

/**
 * 级联兜底 fix 前缀：这类 fix 的**根因通常不在本行**（例如上一行 R4 冗余
 * 造成整段级联报 "same column"），把它单独应用会误伤无辜行。
 *   - `# [indent mismatch]`：缩进列错位兜底
 *   - `# [unparseable]`：通用无法归类的 parse error 兜底
 * 与之相对，`# [duplicate key removed]` 虽然也是"注释化"，但根因就在本行
 * （用户显式写了重复 key），属于安全兜底 —— 不列入此清单。
 */
const CASCADE_FALLBACK_FIX_PREFIXES = [
    '# [indent mismatch]',
    '# [unparseable]',
];

/**
 * 判断一条 fix 是否为「破坏性 fix」——parser 兜底产出的注释化整行修复。
 * 覆盖三类：indent mismatch / duplicate key removed / unparseable。
 * 用于**诊断消息展示层**（如提示"该 fix 会注释化整行"）。
 */
export function isDestructiveFix(fix: string): boolean {
    const trimmed = fix.trimStart();
    return DESTRUCTIVE_FIX_PREFIXES.some(p => trimmed.startsWith(p));
}

/**
 * 判断一条 fix 是否为「级联兜底 fix」—— 仅 indent mismatch / unparseable。
 * 这两类 fix 的根因常在其他行，单独应用会误伤；因此：
 *   1) 单行 QuickFix 场景要降级为"⚠️ 破坏性"警示项（避免默认首选）；
 *   2) "修复选中范围 / 仅修复 error" 场景若剩下的都是这类 fix，直接中止。
 * duplicate key 不属于此类（根因就在本行，注释化即正确修复）。
 */
export function isCascadeFallbackFix(fix: string): boolean {
    const trimmed = fix.trimStart();
    return CASCADE_FALLBACK_FIX_PREFIXES.some(p => trimmed.startsWith(p));
}

// ============================================
// 内容缓存（LRU，避免相同内容重复校验）
// ============================================

/**
 * key = 内容 sha1 hex（40 字符），避免用完整内容做 key 造成内存冗余；
 *   假设 32 项 × 1MB 全命中场景下，key 集合从 32MB → 1.28KB。
 * value = 校验结果
 * 固定上限 32 项，超出删除首个（插入顺序 = LRU 逆序）。
 *
 * sha1 冲突概率极低（生日悖论下 2^80 次才有 50% 冲突），
 * 对文档校验缓存场景足够安全。
 */
const VALIDATION_CACHE_MAX = 32;
const VALIDATION_CACHE_CONTENT_MAX = 1 * 1024 * 1024; // 1MB
const validationCache = new Map<string, YamlIssue[]>();

function hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex');
}

function cachePut(content: string, issues: YamlIssue[], preHash?: string): void {
    if (content.length > VALIDATION_CACHE_CONTENT_MAX) return;
    const key = preHash ?? hashContent(content);
    if (validationCache.has(key)) {
        validationCache.delete(key); // 提到末尾（重新插入）
    } else if (validationCache.size >= VALIDATION_CACHE_MAX) {
        const firstKey = validationCache.keys().next().value;
        if (firstKey !== undefined) validationCache.delete(firstKey);
    }
    validationCache.set(key, issues);
}

export function clearYamlValidationCache(): void {
    validationCache.clear();
}

// ============================================
// 核心：字符串内容校验
// ============================================

/**
 * 校验 YAML 字符串内容的格式。
 * @param content YAML 文件原文
 * @returns 格式问题列表（可能同一行有多条）
 */
export function validateYamlContent(content: string): YamlIssue[] {
    // ── 缓存快速路径：相同内容直接返回缓存的 issue 列表 ──
    // 大文件不参与缓存（也不做 hash 计算，避免额外 CPU 消耗）
    const cacheable = content.length <= VALIDATION_CACHE_CONTENT_MAX;
    const cacheKey = cacheable ? hashContent(content) : '';
    if (cacheable) {
        const cached = validationCache.get(cacheKey);
        if (cached) return cached;
    }

    const issues: YamlIssue[] = [];
    const lines = content.split('\n');

    // ── 1. 文件级检查：BOM 头 ──
    if (content.charCodeAt(0) === 0xfeff) {
        // fix：把第一行首字符的 U+FEFF 剥掉（此处已经通过 split('\n') 拿到 lines[0]，其首字符仍是 U+FEFF）
        const firstLine = lines[0] ?? '';
        const fixed = firstLine.charCodeAt(0) === 0xfeff ? firstLine.slice(1) : firstLine;
        issues.push({
            line: 1, column: 1, length: 1,
            title: 'BOM 头',
            message: '文件开头包含 BOM (Byte Order Mark)，可能导致解析异常',
            severity: 'warning',
            fix: fixed,
        });
    }

    // ── 2. 逐行遍历规则表 ──
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;

        const ctx = buildLineCtx(line);
        for (const entry of YAML_RULES) {
            const issue = entry.rule(line, lineNum, ctx);
            if (!issue) continue;
            // 值等价过滤：若给出了 fix 但结果与原行一致（如已加引号、无实际变化），
            // 说明值本身已符合规范，不再上报，避免误报。
            if (issue.fix !== undefined && issue.fix === line) continue;
            issues.push(issue);
            if (entry.stopOnHit) break;
        }
    }

    // ── 2b. 文件级规则（重复 key 等） ──
    for (const fileRule of YAML_FILE_RULES) {
        try {
            const extra = fileRule(lines);
            if (extra.length > 0) issues.push(...extra);
        } catch (err: any) {
            log.warn('文件级规则执行异常:', err?.message || err);
        }
    }

    // ── 3. yaml 库解析错误捕获 ──
    try {
        const docs = YAML.parseAllDocuments(content);
        for (const doc of docs) {
            const errors = (doc as any).errors || [];
            const warnings = (doc as any).warnings || [];

            for (const err of errors) {
                const errLine = err?.linePos?.[0]?.line || 1;
                const errCol = err?.linePos?.[0]?.col || 1;
                const alreadyReported = issues.some(
                    (iss) => iss.line === errLine && iss.severity === 'error',
                );
                if (alreadyReported) continue;
                const lineText = (errLine > 0 && errLine <= lines.length) ? lines[errLine - 1] : '';
                let fix = generateFixForParseError(lineText, errCol, err.message);
                // fix 与原行一致则无效，只保留错误本体
                if (fix !== undefined && fix === lineText) fix = undefined;
                // ── 关键：若同一行已经有规则给出的**非破坏性** fix，就不再叠加破坏性兜底 ──
                //   场景：`name:hello`（R4 缺空格）会让 YAML parser 把该行或后续行报为
                //     "same column" / "must start at" → 兜底 fix = "# [indent mismatch] xxx"
                //     若直接叠加，parser 兜底会**覆盖** R4 的 `name: hello` 修复，导致
                //     "修复 error"、"修复单行"（用户点 error 那条 QuickFix）都变成整行注释化。
                //   策略：同行已有 fix 时，本 error 只报警不给 fix；等下一轮规则 fix 应用后
                //     重新校验，parse 错误大概率自动消失；实在消不掉时，用户可用"修复全部"
                //     进入 handler 的"稳妥 fix 优先 + 兜底延后"多轮策略。
                if (fix !== undefined && isDestructiveFix(fix)) {
                    const hasSafeFixSameLine = issues.some(
                        (iss) => iss.line === errLine && iss.fix !== undefined && !isDestructiveFix(iss.fix),
                    );
                    // 级联抑制：报错行的上一行是「引号包裹块标量头」（R9 会去引号修复），
                    // 则根因在上一行，不应注释化当前行，避免后续多行内容被误注释丢失。
                    const prevIsQuotedBlockScalar = errLine > 1 && isQuotedBlockScalarLine(lines[errLine - 2] ?? '');
                    if (hasSafeFixSameLine || prevIsQuotedBlockScalar) fix = undefined;
                }
                issues.push({
                    line: errLine, column: errCol, length: 1,
                    title: 'YAML 解析错误',
                    message: `YAML 解析错误 (第 ${errLine} 行): ${truncateYamlMessage(err.message)}`,
                    severity: 'error',
                    fix,
                });
            }

            for (const warn of warnings) {
                const wLine = warn?.linePos?.[0]?.line || 1;
                const alreadyReported = issues.some(
                    (iss) => iss.line === wLine && iss.message.includes(warn.message),
                );
                if (alreadyReported) continue;
                issues.push({
                    line: wLine, column: warn?.linePos?.[0]?.col || 1, length: 1,
                    title: 'YAML 解析警告',
                    message: `YAML 解析警告 (第 ${wLine} 行): ${truncateYamlMessage(warn.message)}`,
                    severity: 'warning',
                });
            }
        }
    } catch {
        // parseAllDocuments 失败，尝试用 parse 拿错误行号
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
                let fix = generateFixForParseError(lineText, errCol, parseErr.message);
                if (fix !== undefined && fix === lineText) fix = undefined;
                // 同上：同行已有非破坏性 fix 时，parser 兜底不再叠加破坏性 fix
                if (fix !== undefined && isDestructiveFix(fix)) {
                    const hasSafeFixSameLine = issues.some(
                        (iss) => iss.line === errLine && iss.fix !== undefined && !isDestructiveFix(iss.fix),
                    );
                    // 级联抑制：报错行的上一行是「引号包裹块标量头」（R9 会去引号修复），
                    // 则根因在上一行，不应注释化当前行，避免后续多行内容被误注释丢失。
                    const prevIsQuotedBlockScalar = errLine > 1 && isQuotedBlockScalarLine(lines[errLine - 2] ?? '');
                    if (hasSafeFixSameLine || prevIsQuotedBlockScalar) fix = undefined;
                }
                issues.push({
                    line: errLine, column: errCol, length: 1,
                    title: 'YAML 格式错误',
                    message: `YAML 格式错误 (第 ${errLine} 行): ${truncateYamlMessage(parseErr.message)}`,
                    severity: 'error',
                    fix,
                });
            }
        }
    }

    cachePut(content, issues, cacheable ? cacheKey : undefined);
    return issues;
}

/**
 * 读取文件内容并逐行校验 YAML 格式。
 */
export async function validateYamlFile(filePath: string): Promise<YamlIssue[]> {
    let content: string;
    try {
        content = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
        return [];
    }
    return validateYamlContent(content);
}

// ============================================
// VS Code Diagnostics & 修复表
// ============================================

let yamlDiagnosticsCollection: vscode.DiagnosticCollection | undefined;

/**
 * 修复数据存储：key = uri.toString(), value = Map<行号, fix字符串[]>
 * 允许同一行叠加多条修复（会按顺序 apply）。
 */
const fixDataStore = new Map<string, Map<number, string[]>>();

export function getYamlDiagnosticsCollection(): vscode.DiagnosticCollection {
    if (!yamlDiagnosticsCollection) {
        yamlDiagnosticsCollection = vscode.languages.createDiagnosticCollection('yamlFormat');
    }
    return yamlDiagnosticsCollection;
}

/**
 * 在 activate 时注册；若已存在则 dispose 旧实例（防止重复创建）。
 */
export function initYamlDiagnostics(context: vscode.ExtensionContext): void {
    if (yamlDiagnosticsCollection) {
        yamlDiagnosticsCollection.dispose();
    }
    yamlDiagnosticsCollection = vscode.languages.createDiagnosticCollection('yamlFormat');
    context.subscriptions.push(yamlDiagnosticsCollection);
}

/**
 * 主动清理指定 URI 的修复数据（文档关闭 / 删除 / 重命名时调用）。
 */
export function clearYamlFix(uri: vscode.Uri): void {
    const key = uri.toString();
    fixDataStore.delete(key);
    yamlDiagnosticsCollection?.delete(uri);
    log.debug('clearYamlFix:', key);
}

/**
 * 发布 Diagnostics，并同步更新修复表。
 */
export function publishYamlDiagnostics(uri: vscode.Uri, issues: YamlIssue[]): void {
    const collection = getYamlDiagnosticsCollection();
    const uriKey = uri.toString();
    log.debug('publishYamlDiagnostics', {
        uri: uriKey,
        issueCount: issues.length,
        issuesWithFix: issues.filter(i => i.fix !== undefined).length,
    });
    if (issues.length === 0) {
        collection.delete(uri);
        fixDataStore.delete(uriKey);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = issues.map(toDiagnostic);
    collection.set(uri, diagnostics);

    // ── 遥测：检测问题个数 ──
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

    // ── 修复表：同一行支持叠加多条 fix ──
    const lineFixes = new Map<number, string[]>();
    for (const issue of issues) {
        if (issue.fix === undefined) continue;
        const arr = lineFixes.get(issue.line);
        if (arr) arr.push(issue.fix);
        else lineFixes.set(issue.line, [issue.fix]);
    }
    fixDataStore.set(uriKey, lineFixes);
    log.debug('fixDataStore updated:', {
        uriKey,
        lineCount: lineFixes.size,
        totalFixes: Array.from(lineFixes.values()).reduce((s, a) => s + a.length, 0),
    });
}

/**
 * 获取指定文件某一行的**全部**修复方案（供叠加应用使用）。
 */
export function getFixesForLine(uri: vscode.Uri, line: number): string[] {
    return fixDataStore.get(uri.toString())?.get(line) ?? [];
}

/**
 * 获取指定文件所有可修复行的最终修复结果（同一行按顺序叠加）。
 * 注意：叠加规则很难保证全部无冲突，这里采用"以最后一条为最终结果"策略，因为
 *   后一条 fix 通常基于对同一行更精细的规则命中。
 * 更精细的合并（如引号+行末空格串行 apply）可放到后续版本。
 */
export function getAllFixes(uri: vscode.Uri): Array<{ line: number; fixedLine: string }> {
    const uriKey = uri.toString();
    const lineFixes = fixDataStore.get(uriKey);
    if (!lineFixes) return [];
    return Array.from(lineFixes.entries())
        .map(([line, arr]) => ({ line, fixedLine: arr[arr.length - 1] }))
        .sort((a, b) => a.line - b.line);
}

/**
 * 将 YamlIssue 转为 vscode.Diagnostic，使用精准的列 / 长度范围。
 */
function toDiagnostic(issue: YamlIssue): vscode.Diagnostic {
    const lineIndex = issue.line - 1;
    const startCol = Math.max(0, (issue.column ?? 1) - 1);
    const len = Math.max(1, issue.length ?? 1);
    const range = new vscode.Range(lineIndex, startCol, lineIndex, startCol + len);
    const severity = issue.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, issue.message, severity);
    diagnostic.source = YAML_DIAGNOSTIC_SOURCE;
    return diagnostic;
}

// ============================================
// 批量修复：将 fix 建议写入文件（供命令行/无编辑器场景使用）
// ============================================

/**
 * 将包含 fix 字段的 Issue 批量应用到本地文件（按行号降序写入避免行偏移）。
 * @returns 实际修复的行数
 */
export async function applyYamlFixes(filePath: string, issues: YamlIssue[]): Promise<number> {
    const fixes = issues
        .filter(i => i.fix !== undefined)
        .sort((a, b) => b.line - a.line);
    if (fixes.length === 0) return 0;

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