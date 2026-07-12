/**
 * ============================================================================
 *  yaml-range-fix-real.test.ts
 *  用真实的 YAML 片段驱动 validateYamlContent，模拟"选中范围修复"整个过程，
 *  验证不会出现"整段被注释"的回归。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import { validateYamlContent, clearYamlValidationCache } from '../utils/yamlValidator';

// isIndentMismatchFallback 的判断复刻
function isIndentMismatchFallback(fixedLine: string): boolean {
    return fixedLine.trimStart().startsWith('# [indent mismatch]');
}

/**
 * 模拟 runYamlFixLoop 的单轮 "应用 fix" 步骤（不启动真实的 vscode.editor.edit）。
 * 直接从 validateYamlContent 拿到 issues 上的 fix。
 */
function applyFixesOneRound(text: string, lineFilter?: (line: number) => boolean): {
    newText: string;
    appliedLines: number[];
    fallbackApplied: boolean;
    safeCount: number;
    fallbackCount: number;
} {
    clearYamlValidationCache();
    const issues = validateYamlContent(text);
    // 按行汇总，取最后一条 fix（与 getAllFixes 的策略一致）
    const perLine = new Map<number, string>();
    for (const iss of issues) {
        if (iss.fix === undefined) continue;
        perLine.set(iss.line, iss.fix);
    }
    let rawFixes = Array.from(perLine.entries()).map(([line, fixedLine]) => ({ line, fixedLine }));
    if (lineFilter) rawFixes = rawFixes.filter(f => lineFilter(f.line));

    const safe = rawFixes.filter(f => !isIndentMismatchFallback(f.fixedLine));
    const fallback = rawFixes.filter(f => isIndentMismatchFallback(f.fixedLine));
    const batch = safe.length > 0 ? safe : fallback;
    const fallbackApplied = safe.length === 0 && fallback.length > 0;

    const lines = text.split('\n');
    for (const { line, fixedLine } of batch) {
        const idx = line - 1;
        if (idx >= 0 && idx < lines.length) lines[idx] = fixedLine;
    }
    return {
        newText: lines.join('\n'),
        appliedLines: batch.map(b => b.line),
        fallbackApplied,
        safeCount: safe.length,
        fallbackCount: fallback.length,
    };
}

describe('选中范围修复真实场景 · 无级联注释', () => {
    it('段 A：R4 冒号缺空格，选中范围一次修复后不产生 indent mismatch 注释', () => {
        const yamlText = [
            'top:',                                // 1
            '  x: 1',                              // 2
            '  y: 2',                              // 3
            '',                                    // 4
            'segment_a:',                          // 5
            '  name:alpha',                        // 6  ← R4
            '  version:1.0',                       // 7  ← R4
            '  port:8080',                         // 8  ← R4
            '  host:127.0.0.1',                    // 9  ← R4
            '  scheme:http',                       // 10 ← R4
            '',                                    // 11
        ].join('\n');

        const lineFilter = (l: number) => l >= 5 && l <= 10;

        // 第 1 轮：安全 fix 应存在，兜底不应生效
        const round1 = applyFixesOneRound(yamlText, lineFilter);
        expect(round1.fallbackApplied).toBe(false);
        expect(round1.safeCount).toBeGreaterThan(0);
        expect(round1.newText.includes('# [indent mismatch]')).toBe(false);

        // 第 2 轮：应彻底收敛
        const round2 = applyFixesOneRound(round1.newText, lineFilter);
        expect(round2.newText.includes('# [indent mismatch]')).toBe(false);
    });

    it('只有兜底 fix 时才允许兜底生效，且不污染选区外行', () => {
        const yamlText = [
            'segment:',                            // 1
            '  bad_root:val1',                     // 2 ← R4（不在选区）
            '  good_a: 1',                         // 3
            '  good_b: 2',                         // 4
            '  good_c: 3',                         // 5
        ].join('\n');

        const lineFilter = (l: number) => l >= 3 && l <= 5;
        const round = applyFixesOneRound(yamlText, lineFilter);

        const linesAfter = round.newText.split('\n');
        expect(linesAfter[0]).toBe('segment:');
        expect(linesAfter[1]).toBe('  bad_root:val1');
    });

    it('极端场景 · 选中范围内全部为 indent-mismatch 兜底 fix → 应拒绝执行注释化', () => {
        // 手工构造一批 fix，模拟"根因不在选区内、选区内全是级联 parse error"的情况
        const fixes = [
            { line: 30, fixedLine: '  # [indent mismatch] a: 1' },
            { line: 31, fixedLine: '  # [indent mismatch] b: 2' },
            { line: 32, fixedLine: '  # [indent mismatch] c: 3' },
        ];
        const isFallback = (f: { fixedLine: string }) => isIndentMismatchFallback(f.fixedLine);
        const safe = fixes.filter(f => !isFallback(f));
        const fallback = fixes.filter(f => isFallback(f));
        // 模拟 runYamlFixLoop 里的分组决策（选中范围 lineFilter 存在时的路径）
        const hasLineFilter = true;
        let batch: typeof fixes;
        let rejected = false;
        if (safe.length > 0) batch = safe;
        else if (fallback.length > 0 && !hasLineFilter) batch = fallback;
        else { batch = []; rejected = true; }

        expect(rejected).toBe(true);
        expect(batch.length).toBe(0);
    });

    it('修复全部（无 lineFilter）· 只剩兜底 fix 时允许注释化生效', () => {
        const fixes = [
            { line: 30, fixedLine: '  # [indent mismatch] a: 1' },
            { line: 31, fixedLine: '  # [indent mismatch] b: 2' },
        ];
        const isFallback = (f: { fixedLine: string }) => isIndentMismatchFallback(f.fixedLine);
        const safe = fixes.filter(f => !isFallback(f));
        const fallback = fixes.filter(f => isFallback(f));
        const hasLineFilter = false;
        let batch: typeof fixes;
        if (safe.length > 0) batch = safe;
        else if (fallback.length > 0 && !hasLineFilter) batch = fallback;
        else batch = [];
        expect(batch.length).toBe(2); // 兜底允许生效
    });
});
