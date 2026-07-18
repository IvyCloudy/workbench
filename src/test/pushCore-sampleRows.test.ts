/**
 * ============================================================================
 *  test/pushCore-sampleRows.test.ts
 *  extractSampleRows 映射构造回归（第 9 轮检视 ζ 修复）
 * ----------------------------------------------------------------------------
 *  修复背景：
 *    历史实现依赖 `src[i] === filtered[cursor]` 引用比对来构造
 *    filteredToOriginal 映射。一旦 filterTemplateExampleRows 走浅拷贝分支
 *    （spread / map），引用断裂 → 映射错乱 → 后端 bodyIndex 映射错行。
 *
 *    第 9 轮改为「按 tsId 语义」构造映射，与 filterTemplateExampleRows 的
 *    过滤条件保持一致。本测试用于证明：
 *      1) 无样例行 → identity 映射（长度 = src.length）
 *      2) 有样例行 → 跳过样例位置，非样例行的原始下标依次保留
 *      3) 首行为样例 / 尾行为样例 / 中间连续多行样例 均正确
 *      4) 全部为样例 → filtered=[] 但 sampleFailures 全量记录
 *      5) resolveRowIndex 回调按原始下标（i）传入，而非过滤后下标
 *      6) filteredToOriginal 长度必须严格 == filtered.length
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import { extractSampleRows } from '../handlers/pushCore';

// 与 fileIdentifier.ts 中一致（避免测试内直接 import 导致重复）
const SAMPLE_LONG = '案例唯一标识，不可修改';
const SAMPLE_SHORT = '案例唯一标识';

/** 构造一条推送 row（对象形态，带 testcase_id 字段） */
function row(tsId: string, extra: Record<string, any> = {}) {
    return { testcase_id: tsId, ...extra };
}

describe('pushCore.extractSampleRows —— filteredToOriginal 映射（ζ 修复）', () => {
    it('无样例行：identity 映射', () => {
        const rows = [row('TC001'), row('TC002'), row('TC003')];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(3);
        expect(result.filteredToOriginal).toEqual([0, 1, 2]);
        expect(result.sampleFailures).toEqual([]);
        expect(result.skipped).toBe(0);
    });

    it('首行为样例：filteredToOriginal 从 1 开始', () => {
        const rows = [row(SAMPLE_LONG), row('TC001'), row('TC002')];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(2);
        expect(result.filteredToOriginal).toEqual([1, 2]);
        expect(result.sampleFailures).toHaveLength(1);
        expect(result.sampleFailures[0].rowIndex).toBe(1); // 原始下标 0 → resolveRowIndex 返回 1
        expect(result.skipped).toBe(1);
    });

    it('尾行为样例：filteredToOriginal 不含最后一个原始下标', () => {
        const rows = [row('TC001'), row('TC002'), row(SAMPLE_LONG)];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(2);
        expect(result.filteredToOriginal).toEqual([0, 1]);
        expect(result.sampleFailures).toHaveLength(1);
        expect(result.sampleFailures[0].rowIndex).toBe(3);
    });

    it('中间连续多行样例：filteredToOriginal 精确跳过样例位置', () => {
        const rows = [
            row('TC001'),          // idx 0 → 保留
            row(SAMPLE_LONG),      // idx 1 → 过滤
            row(SAMPLE_SHORT),     // idx 2 → 过滤
            row('TC002'),          // idx 3 → 保留
            row(SAMPLE_LONG),      // idx 4 → 过滤
            row('TC003'),          // idx 5 → 保留
        ];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(3);
        expect(result.filteredToOriginal).toEqual([0, 3, 5]);
        expect(result.sampleFailures.map(f => f.rowIndex)).toEqual([2, 3, 5]);
        expect(result.skipped).toBe(3);
    });

    it('全部为样例：filtered 为空、sampleFailures 全量、映射为空数组', () => {
        const rows = [row(SAMPLE_LONG), row(SAMPLE_SHORT), row(SAMPLE_LONG)];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(0);
        expect(result.filteredToOriginal).toEqual([]);
        expect(result.sampleFailures).toHaveLength(3);
        expect(result.skipped).toBe(3);
    });

    it('resolveRowIndex 拿到的是原始下标 i（而非过滤后下标）', () => {
        const rows = [
            row('TC001'),      // idx 0
            row(SAMPLE_LONG),  // idx 1 —— sampleFailure.rowIndex 应通过 resolveRowIndex(1) 得到
            row('TC002'),      // idx 2
        ];
        const seen: number[] = [];
        const resolveRowIndex = (i: number) => {
            seen.push(i);
            return i * 100 + 1; // 用一个可辨别的映射来验证传参
        };
        const result = extractSampleRows('/mock/file.yaml', rows, resolveRowIndex);
        expect(seen).toEqual([1]); // 只对样例行调用
        expect(result.sampleFailures[0].rowIndex).toBe(101); // 1 * 100 + 1
    });

    it('resolveRowIndex 返回 0/负数 → sampleFailures 不记录该项', () => {
        // 契约：resolveRowIndex 返回 <=0 表示无法解析对应行号（可能是行已被删除等），
        //       此时不应把 rowIndex 写入 failure 集合，否则前端跳转会跳到"第 0 行"
        const rows = [row(SAMPLE_LONG), row('TC001'), row(SAMPLE_LONG)];
        const result = extractSampleRows('/mock/file.yaml', rows, () => 0);
        expect(result.sampleFailures).toEqual([]);
        expect(result.filtered).toHaveLength(1); // 过滤仍照常执行
        expect(result.filteredToOriginal).toEqual([1]);
    });

    it('filteredToOriginal 长度必须严格 == filtered.length（兜底断言）', () => {
        // 无论输入怎样，这两者长度必须一致；否则 payload 与主表行号会错位
        const cases = [
            [row('TC001'), row('TC002')],
            [row(SAMPLE_LONG), row('TC001')],
            [row('TC001'), row(SAMPLE_LONG), row('TC002'), row(SAMPLE_LONG)],
            [row(SAMPLE_LONG), row(SAMPLE_SHORT)],
            [],
        ];
        for (const rows of cases) {
            const r = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
            expect(r.filteredToOriginal.length).toBe(r.filtered.length);
        }
    });

    it('非空输入下每个 filteredToOriginal[i] 必须是原始 src 中的合法下标', () => {
        // 保证映射不越界、不为负
        const rows = [row('TC001'), row(SAMPLE_LONG), row('TC002')];
        const r = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        for (const idx of r.filteredToOriginal) {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(rows.length);
        }
    });

    it('样例行的 tsId 支持"长/短"两种占位（'
        + SAMPLE_LONG + ' / ' + SAMPLE_SHORT + '）', () => {
        const rows = [row(SAMPLE_LONG), row(SAMPLE_SHORT), row('TC001')];
        const result = extractSampleRows('/mock/file.yaml', rows, (i) => i + 1);
        expect(result.filtered).toHaveLength(1);
        expect(result.filteredToOriginal).toEqual([2]);
        expect(result.sampleFailures).toHaveLength(2);
    });

    it('回归：即使传入 rows 是共享引用的浅拷贝数组，映射也不受影响（ζ 关键场景）', () => {
        // 模拟"filterTemplateExampleRows 走浅拷贝"路径 —— 此时若还依赖引用比对必然出错。
        // 现在的实现按 tsId 语义匹配，与引用无关。
        const src = [row('TC001'), row(SAMPLE_LONG), row('TC002')];
        // extractSampleRows 内部会调用 filterTemplateExampleRows，其实现是 rows.filter(...)
        // 已经会产生新数组引用；此测试通过"确保结果与预期一致"来间接证明映射与引用解耦。
        const r = extractSampleRows('/mock/file.yaml', src, (i) => i + 1);
        expect(r.filtered.length).toBe(2);
        expect(r.filteredToOriginal).toEqual([0, 2]);
        // filtered 应指向"内容等价的行对象"（filter 返回原引用，不做深拷贝）
        expect(r.filtered[0]).toBe(src[0]);
        expect(r.filtered[1]).toBe(src[2]);
    });
});
