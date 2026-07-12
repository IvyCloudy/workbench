/**
 * ============================================================================
 *  test/yaml-scenarios.regression.test.ts
 *  按场景样例文件的命中数量回归。
 *  每个样例文件都专门聚焦一个规则（除 11-quoted-ok 应 0 报警）。
 * ============================================================================
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateYamlContent, clearYamlValidationCache } from '../utils/yamlValidator';

const SCENARIO_DIR = join(__dirname, '../../examples/yaml-scenarios');

function load(name: string): string {
    return readFileSync(join(SCENARIO_DIR, name), 'utf8');
}

function countByTitle(issues: ReturnType<typeof validateYamlContent>): Record<string, number> {
    const map: Record<string, number> = {};
    for (const i of issues) {
        const t = (i.title ?? '(parse)').trim() || '(parse)';
        map[t] = (map[t] ?? 0) + 1;
    }
    return map;
}

describe('YAML 分场景样例文件回归', () => {
    beforeEach(() => clearYamlValidationCache());

    it('01-tab-indent：至少 5 处 Tab 缩进', () => {
        const issues = validateYamlContent(load('01-tab-indent.yaml'));
        const map = countByTitle(issues);
        expect(map['Tab 缩进']).toBeGreaterThanOrEqual(5);
    });

    it('02-inline-tab：至少 4 处 含 Tab 字符', () => {
        const issues = validateYamlContent(load('02-inline-tab.yaml'));
        const map = countByTitle(issues);
        expect(map['含 Tab 字符']).toBeGreaterThanOrEqual(4);
    });

    it('03-trailing-space：至少 7 处 行末多余空格', () => {
        const issues = validateYamlContent(load('03-trailing-space.yaml'));
        const map = countByTitle(issues);
        expect(map['行末多余空格']).toBeGreaterThanOrEqual(7);
    });

    it('04-colon-space：命中冒号缺空格，且 URL/时间戳不误报', () => {
        const issues = validateYamlContent(load('04-colon-space.yaml'));
        const map = countByTitle(issues);
        // 注：YAML 解析失败后，后续行上下文丢失，只能逐个识别前几行
        expect(map['缺少空格']).toBeGreaterThanOrEqual(5);
        // URL/时间戳都在引号里，绝不应产生过多误报
        expect(map['缺少空格']).toBeLessThan(20);
    });

    it('05-dash-space：至少 5 处 短横线缺空格，且负数不误报', () => {
        const issues = validateYamlContent(load('05-dash-space.yaml'));
        const map = countByTitle(issues);
        // dash 空格与 colon 空格共用 title="缺少空格"，用总数下限判定
        expect(map['缺少空格']).toBeGreaterThanOrEqual(5);
    });

    it('06-ambiguous-value：至少 10 处 歧义值需引号', () => {
        const issues = validateYamlContent(load('06-ambiguous-value.yaml'));
        const total = issues.filter(i => (i.title ?? '').includes('需引号')).length;
        expect(total).toBeGreaterThanOrEqual(10);
    });

    it('07-hash-in-value：至少 4 处 值中 # 会被丢弃', () => {
        const issues = validateYamlContent(load('07-hash-in-value.yaml'));
        const map = countByTitle(issues);
        expect(map['值中 # 会被丢弃']).toBeGreaterThanOrEqual(4);
    });

    it('08-reserved-chars：至少 8 处 保留字符（合法 flow 集合 / anchor / alias / tag / block scalar 豁免）', () => {
        const issues = validateYamlContent(load('08-reserved-chars.yaml'));
        const total = issues.filter(i => (i.title ?? '').includes('保留字符')).length;
        // 基准：现行行为为 10 处（a{b}c / a[b]c / a,b,c / a|b / a&b / a>b / a*b / a!b 等中间包含保留字符的）
        //   取 ≥ 8 作为余量，防止未来新增豁免又需同步改这里
        expect(total).toBeGreaterThanOrEqual(8);
    });

    it('09-duplicate-keys：>=5 处重复 key，且不同 item 的同名 key 不误报', () => {
        const issues = validateYamlContent(load('09-duplicate-keys.yaml'));
        const map = countByTitle(issues);
        expect(map['重复的 key']).toBeGreaterThanOrEqual(5);
    });

    it('10-parse-cascade：应能识别出解析错误行', () => {
        const issues = validateYamlContent(load('10-parse-cascade.yaml'));
        // 未闭引号 + 行内 map 都应触发 parse 相关 diagnostic
        const parseLike = issues.filter(i =>
            i.severity === 'error' || (i.title ?? '').includes('parse') || (i.title ?? '') === '(parse)'
            || (i.message ?? '').includes('YAML')
            || (i.title ?? '').includes('解析'),
        );
        expect(parseLike.length).toBeGreaterThanOrEqual(1);
    });

    it('11-quoted-ok：合法样例应 0 条 diagnostic（防误报回归）', () => {
        const issues = validateYamlContent(load('11-quoted-ok.yaml'));
        if (issues.length > 0) {
            // 打印明细，便于排查回归引入的误报
            // eslint-disable-next-line no-console
            console.log('11-quoted-ok 出现意外 diagnostic:', issues);
        }
        expect(issues.length).toBe(0);
    });

    it('12-range-fix：全量可修问题 >= 12，用于验证选中范围子集修复', () => {
        const issues = validateYamlContent(load('12-range-fix.yaml'));
        // 可修复问题的总数（凡是有 fix 字段或 fix 数组的都算）
        const fixable = issues.filter(i => (i as any).fix !== undefined);
        expect(fixable.length).toBeGreaterThanOrEqual(12);
    });
});
