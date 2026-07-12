/**
 * ============================================================================
 *  yaml-fix-severity-filter.test.ts
 *  验证「按 error/warning 分级过滤 fix」的核心策略
 * ----------------------------------------------------------------------------
 *  测试目的：
 *    Fix All 命令新增了 severityFilter 参数（'error' | 'warning' | undefined），
 *    该过滤发生在"取 fix 列表 + 按 lineToSeverity 判定"这两步之间。
 *    此处以**独立复刻**（不 import handler，避免 VS Code 依赖）的方式验证：
 *      · severityFilter=undefined  → 保留所有 fix
 *      · severityFilter='error'    → 只保留 error 严重级对应的 fix
 *      · severityFilter='warning'  → 只保留 warning 严重级对应的 fix
 *      · 同一行同时命中 error + warning → 按最严重级（error）归类
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';

// 复刻 vscode.DiagnosticSeverity 常量（Error=0, Warning=1, Information=2, Hint=3）
const Sev = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

interface Fix { line: number; fixedLine: string; }
interface Diag { line: number; severity: number; }

// 与 runYamlFixLoop 内 buildLineSeverity + matchesSeverity 逻辑一致的复刻
function buildLineSeverity(diags: Diag[]): Map<number, number> {
    const m = new Map<number, number>();
    for (const d of diags) {
        const prev = m.get(d.line);
        // 同行取更严重（数值上更小的）
        if (prev === undefined || d.severity < prev) m.set(d.line, d.severity);
    }
    return m;
}

function matchesSeverity(
    line: number,
    sevMap: Map<number, number>,
    filter?: 'error' | 'warning',
): boolean {
    if (!filter) return true;
    const s = sevMap.get(line);
    if (s === undefined) return false;
    if (filter === 'error') return s === Sev.Error;
    return s === Sev.Warning;
}

function filterFixes(
    fixes: Fix[],
    diags: Diag[],
    filter?: 'error' | 'warning',
): Fix[] {
    const sevMap = buildLineSeverity(diags);
    const diagLines = new Set(sevMap.keys());
    return fixes.filter(f => diagLines.has(f.line) && matchesSeverity(f.line, sevMap, filter));
}

describe('YAML Fix All - severity filter', () => {
    const fixes: Fix[] = [
        { line: 1, fixedLine: 'k: "v"' },   // error
        { line: 2, fixedLine: 'k: "true"' },// warning (ambiguous)
        { line: 3, fixedLine: '  a: b' },   // error
        { line: 5, fixedLine: 'k: "#note"' },// warning
    ];
    const diags: Diag[] = [
        { line: 1, severity: Sev.Error },
        { line: 2, severity: Sev.Warning },
        { line: 3, severity: Sev.Error },
        { line: 5, severity: Sev.Warning },
    ];

    it('未指定 severityFilter → 保留全部（4 条）', () => {
        expect(filterFixes(fixes, diags).map(f => f.line)).toEqual([1, 2, 3, 5]);
    });

    it("severityFilter='error' → 只保留 error 对应行", () => {
        expect(filterFixes(fixes, diags, 'error').map(f => f.line)).toEqual([1, 3]);
    });

    it("severityFilter='warning' → 只保留 warning 对应行", () => {
        expect(filterFixes(fixes, diags, 'warning').map(f => f.line)).toEqual([2, 5]);
    });

    it('同行 error + warning 共存 → 归类为 error（更严重优先）', () => {
        const mixDiags: Diag[] = [
            { line: 10, severity: Sev.Warning },
            { line: 10, severity: Sev.Error },       // 后到，但更严重
            { line: 11, severity: Sev.Warning },
        ];
        const mixFixes: Fix[] = [
            { line: 10, fixedLine: 'x' },
            { line: 11, fixedLine: 'y' },
        ];
        expect(filterFixes(mixFixes, mixDiags, 'error').map(f => f.line)).toEqual([10]);
        expect(filterFixes(mixFixes, mixDiags, 'warning').map(f => f.line)).toEqual([11]);
    });

    it('fix 命中的行在 diagnostics 中不存在 → 被丢弃（防止 diagnostic 已过期时误 fix）', () => {
        const staleFixes: Fix[] = [
            { line: 1, fixedLine: 'x' },
            { line: 99, fixedLine: 'stale' },  // 无对应 diag
        ];
        expect(filterFixes(staleFixes, diags).map(f => f.line)).toEqual([1]);
    });
});
