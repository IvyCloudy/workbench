/**
 * ============================================================================
 *  test/stampRowIndex.test.ts
 *  pushCore.stampRowIndex 浅注入行为回归（第 9 轮检视 ν 修复）
 * ----------------------------------------------------------------------------
 *  修复背景：
 *    历史实现的 rebuildPushDataFromDisk 曾经会对 rows 做浅拷贝再调用
 *    stampRowIndex，导致 __rowIndex 被打到「拷贝行」而非原始行——
 *    后续 pushCore 走 pushIndexToRow 兜底路径拿不到正确的 rowIndex，
 *    行号错乱。第 9 轮的 ν 修复要求：**stampRowIndex 必须原地打标记、
 *    保持行引用不变**，让上下游共享同一行对象。
 *
 *  本测试的核心不变量：
 *    1) 输入 rows 数组的每一行引用 === 输出对应位置的行引用（浅注入）
 *    2) 每个 object 行都被打上 __rowIndex（由 resolveRowIndex(i) 决定）
 *    3) 若行已有 __rowIndex（例如上游已 stamp 过），保持不覆盖（幂等）
 *    4) 非对象行（null / 原始值 / undefined）安全跳过，不抛错
 *    5) 空数组安全通过（无副作用）
 *    6) resolveRowIndex 按数组下标 i 顺序调用（0,1,2...），值可为任意 number
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import { stampRowIndex } from '../handlers/pushCore';
import { ROW_INDEX_META } from '../utils/pushDataMapper';

describe('pushCore.stampRowIndex —— 浅注入行为（ν 修复）', () => {
    it('每个 object 行都被打上 __rowIndex', () => {
        const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
        const out = stampRowIndex(rows, (i) => i + 100);
        expect((out[0] as any)[ROW_INDEX_META]).toBe(100);
        expect((out[1] as any)[ROW_INDEX_META]).toBe(101);
        expect((out[2] as any)[ROW_INDEX_META]).toBe(102);
    });

    it('输出的每行引用 === 输入对应位置的行引用（核心回归点）', () => {
        // ν 修复的关键：不能产生新对象，否则 __rowIndex 会打在拷贝上而非原始 row
        const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
        const out = stampRowIndex(rows, (i) => i + 1);
        for (let i = 0; i < rows.length; i++) {
            expect(out[i]).toBe(rows[i]); // 严格引用相等（.toBe 走 Object.is）
        }
    });

    it('打标记后，原始 rows 数组的元素也带上 __rowIndex（原地写入）', () => {
        // 双向验证：既然引用相等，原始数组读到的 __rowIndex 应与输出一致
        const rows = [{ id: 'A' }, { id: 'B' }];
        stampRowIndex(rows, (i) => i * 10 + 1);
        expect((rows[0] as any)[ROW_INDEX_META]).toBe(1);
        expect((rows[1] as any)[ROW_INDEX_META]).toBe(11);
    });

    it('幂等：已带 __rowIndex 的行不覆盖', () => {
        // 上游可能先算好 __rowIndex（例如 pushIndexToRow 前置注入），
        // 后续再走 stampRowIndex 时不应破坏已有值。
        const preset = { id: 'X', [ROW_INDEX_META]: 999 };
        const fresh = { id: 'Y' };
        const rows = [preset, fresh];
        const out = stampRowIndex(rows as any[], (i) => i + 1);
        expect((out[0] as any)[ROW_INDEX_META]).toBe(999); // 保持不变
        expect((out[1] as any)[ROW_INDEX_META]).toBe(2);   // 新打标记
    });

    it('非对象行（null / 原始值）安全跳过，不抛错', () => {
        // 极端场景防御：即便 rows 里混进了 null / 字符串（异常数据），也不能 crash
        const rows: any[] = [null, 'abc', 123, { id: 'ok' }, undefined];
        const called: number[] = [];
        const resolve = (i: number) => { called.push(i); return i * 100; };

        expect(() => stampRowIndex(rows, resolve)).not.toThrow();
        const out = stampRowIndex(rows, resolve);

        // null / 原始值 / undefined 应保持原样通过（Array.map 会遍历所有下标）
        expect(out[0]).toBeNull();
        expect(out[1]).toBe('abc');
        expect(out[2]).toBe(123);
        expect((out[3] as any)[ROW_INDEX_META]).toBe(300); // 唯一被打标记的行
        expect(out[4]).toBeUndefined();
    });

    it('空数组安全通过', () => {
        const rows: any[] = [];
        const out = stampRowIndex(rows, () => 999);
        expect(out).toEqual([]);
        expect(out).not.toBe(rows); // map 会返回新数组（但内部元素引用不变）
    });

    it('resolveRowIndex 按数组下标 i 顺序调用', () => {
        const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
        const called: number[] = [];
        stampRowIndex(rows, (i) => { called.push(i); return i; });
        expect(called).toEqual([0, 1, 2, 3]);
    });

    it('resolveRowIndex 只对未打标记的 object 行调用（幂等场景）', () => {
        // 与 ν 修复相关：如果上游已 stamp，就不应该再算一次 rowIndex（省一次 O(1) 调用）
        const preset = { id: 'X', [ROW_INDEX_META]: 42 };
        const rows = [preset, { id: 'Y' }, preset];
        const called: number[] = [];
        stampRowIndex(rows as any[], (i) => { called.push(i); return i + 1; });
        // idx 0 和 idx 2 都是 preset（同引用，已带 __rowIndex），不调用
        // 只有 idx 1 是新对象 → 调用一次
        expect(called).toEqual([1]);
    });

    it('resolveRowIndex 返回值可以是任意 number（包括 0/负数），全部原样写入', () => {
        // stampRowIndex 不做值域校验，边界值都能透传
        const rows = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
        const out = stampRowIndex(rows, (i) => [0, -1, 999999][i]);
        expect((out[0] as any)[ROW_INDEX_META]).toBe(0);
        expect((out[1] as any)[ROW_INDEX_META]).toBe(-1);
        expect((out[2] as any)[ROW_INDEX_META]).toBe(999999);
    });

    it('数组本身不共享（返回新数组），但元素共享（浅拷贝语义）', () => {
        // 契约明确：Array.map 返回新数组，元素引用不变
        const rows = [{ a: 1 }];
        const out = stampRowIndex(rows, () => 1);
        expect(out).not.toBe(rows);   // 数组容器不同
        expect(out[0]).toBe(rows[0]); // 元素引用相同
    });
});
