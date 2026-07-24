/**
 * ============================================================================
 *  pushCore-telemetry-contract.test.ts
 *  推送结果埋点字段合约测试（失败分类维度 + 接口字段聚焦维度）
 * ----------------------------------------------------------------------------
 *  测试目的：
 *    保证「失败分类」维度（failCategoryBreakdown / topFailCategory）与
 *    「接口字段聚焦」维度（failFieldBreakdown / topFailField）确实存在于
 *    pushCore.ts 的各推送结局埋点中，防止未来重构漏改字段名导致大盘看板缺列。
 *
 *  实现方式：
 *    与 yaml-telemetry-contract.test.ts 一致——读取源码文本、断言字段名出现。
 *    属于"轻量守卫"，只检查字符串出现，不模拟真实调用。
 *    注意：.complete / .aborted 事件用对象简写（failCategoryBreakdown, / topFailCategory,）
 *    或显式赋值（failFieldBreakdown: / topFailField:），故以"子串出现次数"断言。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pushCore.ts'), 'utf8');

// 源码中事件名为模板字符串 `${ctx.telemetryPrefix}.xxx`，按字面量定位
const EVENT_COMPLETE = "${ctx.telemetryPrefix}.complete";
const EVENT_FAILED = "${ctx.telemetryPrefix}.failed";

describe('pushCore 失败分类 + 字段聚焦埋点字段合约', () => {
    it('源码中存在 failCategoryBreakdown 维度字段（≥4 处：3 个 .aborted + .complete）', () => {
        const n = SRC.split('failCategoryBreakdown').length - 1;
        expect(n).toBeGreaterThanOrEqual(4);
    });

    it('源码中存在 topFailCategory 维度字段（≥5 处：3 个 .aborted + .complete + .failed）', () => {
        const n = SRC.split('topFailCategory').length - 1;
        expect(n).toBeGreaterThanOrEqual(5);
    });

    it('源码中存在 failFieldBreakdown 维度字段（≥4 处：3 个 .aborted + .complete）', () => {
        const n = SRC.split('failFieldBreakdown').length - 1;
        expect(n).toBeGreaterThanOrEqual(4);
    });

    it('源码中存在 topFailField 维度字段（≥5 处：3 个 .aborted + .complete + .failed）', () => {
        const n = SRC.split('topFailField').length - 1;
        expect(n).toBeGreaterThanOrEqual(5);
    });

    it('失败分类维度由 aggregateFailures + summarizeCategoryBreakdown 生成', () => {
        expect(SRC).toContain('aggregateFailures(');
        expect(SRC).toContain('summarizeCategoryBreakdown(');
        // .complete 结论事件必须同时携带两个分类维度
        const idx = SRC.indexOf(EVENT_COMPLETE);
        expect(idx).toBeGreaterThan(0);
        const block = SRC.substring(idx, idx + 900);
        expect(block).toContain('failCategoryBreakdown');
        expect(block).toContain('topFailCategory');
    });

    it('字段聚焦维度由 aggregateByField + summarizeFieldBreakdown 生成', () => {
        expect(SRC).toContain('aggregateByField(');
        expect(SRC).toContain('summarizeFieldBreakdown(');
        const idx = SRC.indexOf(EVENT_COMPLETE);
        expect(idx).toBeGreaterThan(0);
        const block = SRC.substring(idx, idx + 900);
        expect(block).toContain('failFieldBreakdown');
        expect(block).toContain('topFailField');
    });

    it('批量后端拒绝 .failed 事件也带 topFailField', () => {
        const idx = SRC.indexOf(EVENT_FAILED);
        expect(idx).toBeGreaterThan(0);
        const block = SRC.substring(idx, idx + 600);
        expect(block).toContain('topFailCategory');
        expect(block).toContain('topFailField');
    });

    it('.aborted 短路径（全剔除 / 纯样例 / 样例+预校验）均带分类 + 字段维度', () => {
        // 源码首个 .aborted 是 unbound 分支（无分类维度），故按各分支唯一 reason 标记定位
        const markers = [
            "reason: pickAllDroppedReason(pre.byKind),",          // 预校验全剔除
            "reason: 'onlyTemplateExampleAndPreValidationFailed',", // 样例 + 预校验
            "reason: 'onlyTemplateExample',",                     // 纯样例
        ];
        for (const m of markers) {
            const idx = SRC.indexOf(m);
            expect(idx, `未找到分支标记: ${m}`).toBeGreaterThan(0);
            const block = SRC.substring(idx, idx + 500);
            expect(block, `分支 ${m} 缺少 failCategoryBreakdown`).toContain('failCategoryBreakdown');
            expect(block, `分支 ${m} 缺少 topFailCategory`).toContain('topFailCategory');
            expect(block, `分支 ${m} 缺少 failFieldBreakdown`).toContain('failFieldBreakdown');
            expect(block, `分支 ${m} 缺少 topFailField`).toContain('topFailField');
        }
    });
});
