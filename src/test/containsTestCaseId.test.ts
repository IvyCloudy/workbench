/**
 * parsers/index · containsTestCaseId（F5 打开门控关键字段判定）
 * ----------------------------------------------------------------------------
 * 覆盖点：
 *   1) CSV：headers 含 testcase_id → true；不含 → false；
 *   2) YAML/JSON：header 命中字面量 → true；
 *   3) YAML/JSON：header 因路径展开未命中时，兜底检查 sourceData 顶层记录含 testcase_id 键；
 *   4) YAML/JSON：sourceData 完全不含 → false。
 *
 * 纯函数、无 IO、无 vscode 依赖，直接构造入参即可。
 */
import { describe, it, expect } from 'vitest';
import { containsTestCaseId } from '../parsers';

describe('containsTestCaseId · CSV', () => {
    it('headers 含 testcase_id → true', () => {
        expect(containsTestCaseId(['testcase_id', '名称', '步骤描述'], undefined, 'csv')).toBe(true);
    });
    it('headers 不含 testcase_id → false', () => {
        expect(containsTestCaseId(['名称', '步骤描述', '预期结果'], undefined, 'csv')).toBe(false);
    });
    it('空 headers → false', () => {
        expect(containsTestCaseId([], undefined, 'csv')).toBe(false);
    });
});

describe('containsTestCaseId · YAML/JSON 通过 headers 命中', () => {
    it('headers 含字面量 testcase_id → true', () => {
        expect(containsTestCaseId(['testcase_id', 'name'], undefined, 'json')).toBe(true);
        expect(containsTestCaseId(['testcase_id', 'name'], undefined, 'yaml')).toBe(true);
    });
});

describe('containsTestCaseId · YAML/JSON 兜底 sourceData', () => {
    it('顶层数组记录含 testcase_id 键 → true', () => {
        const source = [{ testcase_id: 'abc', name: 'x' }, { testcase_id: 'def', name: 'y' }];
        expect(containsTestCaseId(['name'], source, 'json')).toBe(true);
        expect(containsTestCaseId(['name'], source, 'yaml')).toBe(true);
    });
    it('顶层单对象含 testcase_id 键 → true', () => {
        const source = { testcase_id: 'abc', name: 'x' };
        expect(containsTestCaseId(['name'], source, 'json')).toBe(true);
    });
    it('记录完全不含 testcase_id 键 → false', () => {
        const source = [{ name: 'x', steps: 's' }];
        expect(containsTestCaseId(['name'], source, 'json')).toBe(false);
        expect(containsTestCaseId(['name'], source, 'yaml')).toBe(false);
    });
    it('sourceData 为 null/空 → false', () => {
        expect(containsTestCaseId(['name'], null, 'json')).toBe(false);
        expect(containsTestCaseId(['name'], undefined, 'yaml')).toBe(false);
    });
});
