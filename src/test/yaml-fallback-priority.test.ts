/**
 * ============================================================================
 *  yaml-fallback-priority.test.ts
 *  验证："indent-mismatch 兜底注释化" 的延迟策略：
 *    · 当同一批 fix 里既有稳妥 fix（如 R4 加空格）又有兜底 fix（注释化）时，
 *      本轮应只应用"稳妥 fix"；只有当稳妥 fix 全部完成后，仍存在兜底 fix 时，
 *      兜底才生效。
 *    · 直接对应用户报的"选中范围修复后整段被注释"的 case。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';

// 与 yamlValidationHandler 中的 isIndentMismatchFallback 保持一致（仅 indent + unparseable）；
// 这里复刻一份用于纯逻辑测试，避免拉 vscode 依赖。
// 注：`# [duplicate key removed]` **不属于级联兜底**——根因就在本行，应作 safeFix 处理。
function isIndentMismatchFallback(fixedLine: string): boolean {
    const trimmed = fixedLine.trimStart();
    return trimmed.startsWith('# [indent mismatch]')
        || trimmed.startsWith('# [unparseable]');
}

// 复刻分组策略
function pickBatch(allFixes: Array<{ line: number; fixedLine: string }>) {
    const sortedAll = [...allFixes].sort((a, b) => a.line - b.line);
    const safe = sortedAll.filter(f => !isIndentMismatchFallback(f.fixedLine));
    const fallback = sortedAll.filter(f => isIndentMismatchFallback(f.fixedLine));
    return safe.length > 0 ? safe : fallback;
}

describe('YAML 修复：indent-mismatch 兜底延迟策略', () => {
    it('同时含 R4 冒号修复与 indent-mismatch 兜底时，本轮只应用 R4 修复', () => {
        const allFixes = [
            { line: 29, fixedLine: 'name: "hello"' },
            { line: 30, fixedLine: '  # [indent mismatch] desc: "my #note"' },
            { line: 31, fixedLine: '  # [indent mismatch] enabled: "yes"' },
            { line: 32, fixedLine: '  # [indent mismatch] disabled: "off"' },
            { line: 33, fixedLine: '  # [indent mismatch] ratio: NaN' },
            { line: 34, fixedLine: '  # [indent mismatch] fallback: null' },
        ];
        const batch = pickBatch(allFixes);
        expect(batch).toHaveLength(1);
        expect(batch[0].line).toBe(29);
        expect(batch[0].fixedLine).toBe('name: "hello"');
    });

    it('仅剩 indent-mismatch 兜底时才允许注释化', () => {
        const allFixes = [
            { line: 30, fixedLine: '  # [indent mismatch] a: b' },
            { line: 31, fixedLine: '  # [indent mismatch] c: d' },
        ];
        const batch = pickBatch(allFixes);
        expect(batch).toHaveLength(2);
        expect(batch.every(b => b.fixedLine.includes('# [indent mismatch]'))).toBe(true);
    });

    it('全为稳妥 fix 时按正常顺序应用', () => {
        const allFixes = [
            { line: 10, fixedLine: 'a: 1' },
            { line: 12, fixedLine: 'b: 2' },
        ];
        const batch = pickBatch(allFixes);
        expect(batch.map(b => b.line)).toEqual([10, 12]);
    });

    it('识别边界：仅当行以 # [indent mismatch] 开头才算兜底（前缀不能变体）', () => {
        expect(isIndentMismatchFallback('# [indent mismatch] x')).toBe(true);
        expect(isIndentMismatchFallback('   # [indent mismatch] x')).toBe(true);
        expect(isIndentMismatchFallback('# indent mismatch x')).toBe(false);
        expect(isIndentMismatchFallback('a: b # [indent mismatch]')).toBe(false); // 中间出现不算
    });

    it('选中多行中的 # [duplicate key removed] 应归为 safeFix（不当级联兜底）', () => {
        // 场景：用户选中了一段含重复 key 的行（根因就在本行），
        // 以前的实现会把它当作级联兜底 → safeFixes.length===0 → "选中范围"受限模式拒绝执行，
        // 导致重复 key 未被处理。修复后：duplicate 不属于级联兜底，属 safeFix，直接一轮修好。
        const allFixes = [
            { line: 10, fixedLine: '  # [duplicate key removed] a: 2' },
            { line: 11, fixedLine: '  # [duplicate key removed] a: 3' },
        ];
        const batch = pickBatch(allFixes);
        expect(batch).toHaveLength(2);
        expect(batch.every(b => b.fixedLine.startsWith('  # [duplicate key removed]'))).toBe(true);
        // duplicate key 不应被识别为级联兜底
        expect(batch.every(b => !isIndentMismatchFallback(b.fixedLine))).toBe(true);
    });

    it('duplicate key + indent-mismatch 同时存在时：仅 indent-mismatch 延后，duplicate 同轮执行', () => {
        const allFixes = [
            { line: 10, fixedLine: '  # [duplicate key removed] a: 2' },      // safe
            { line: 20, fixedLine: '  # [indent mismatch] x: 1' },              // fallback
            { line: 21, fixedLine: '  # [indent mismatch] y: 2' },              // fallback
            { line: 30, fixedLine: 'z: 3' },                                    // safe
        ];
        const batch = pickBatch(allFixes);
        // 本轮只应包含两条 safeFix（duplicate + 普通行），indent-mismatch 延后
        expect(batch.map(b => b.line)).toEqual([10, 30]);
    });
});
