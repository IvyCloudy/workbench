/**
 * caseEnumValues · 枚举字段合法取值清单读取
 * ----------------------------------------------------------------------------
 * 覆盖点：
 *  1) getEnumValues 在 VSCode 配置返回 undefined 时回退到 HARD_FALLBACK；
 *  2) isValidEnumValue 对空值、命中值、未命中值的判定语义；
 *  3) 通过覆盖 vscode.workspace.getConfiguration 模拟 package.json default 生效；
 *  4) 空数组/含空白项 → 视为未配置或过滤后使用。
 *
 * 注：本文件与 test/setup.ts 中 vscode 全局 mock 协同：默认 getConfiguration().get(key)
 *      不传 defaultValue 时返回 undefined，触发 caseEnumValues.ts 内的 HARD_FALLBACK。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { getEnumValues, isValidEnumValue } from '../utils/caseEnumValues';

describe('caseEnumValues · getEnumValues 兜底行为', () => {
    it('无 VSCode 配置返回值 → 回退 HARD_FALLBACK（caseType 至少含"功能点类"）', () => {
        const v = getEnumValues('caseType');
        expect(v).toContain('功能点类');
        expect(v.length).toBeGreaterThan(0);
    });

    it('无 VSCode 配置返回值 → priority 回退 ["高","中","低"]', () => {
        expect(getEnumValues('priority')).toEqual(['高', '中', '低']);
    });

    it('无 VSCode 配置返回值 → keyFlag 回退 ["是","否"]', () => {
        expect(getEnumValues('keyFlag')).toEqual(['是', '否']);
    });

    it('无 VSCode 配置返回值 → testType 回退 ["手工","UI自动化","接口自动化","自动化"]', () => {
        expect(getEnumValues('testType')).toEqual(['手工', 'UI自动化', '接口自动化', '自动化']);
    });
});

describe('caseEnumValues · isValidEnumValue', () => {
    it('空值/null/仅空白 → false（不视为合法）', () => {
        expect(isValidEnumValue('priority', '')).toBe(false);
        expect(isValidEnumValue('priority', null)).toBe(false);
        expect(isValidEnumValue('priority', undefined)).toBe(false);
        expect(isValidEnumValue('priority', '   ')).toBe(false);
    });

    it('命中兜底清单 → true', () => {
        expect(isValidEnumValue('priority', '高')).toBe(true);
        expect(isValidEnumValue('keyFlag', '是')).toBe(true);
        expect(isValidEnumValue('caseType', '功能点类')).toBe(true);
        expect(isValidEnumValue('testType', '手工')).toBe(true);
    });

    it('未命中 → false（严格匹配，不做别名归一化）', () => {
        expect(isValidEnumValue('priority', 'P0')).toBe(false);
        expect(isValidEnumValue('keyFlag', 'Y')).toBe(false);
        expect(isValidEnumValue('keyFlag', 'true')).toBe(false);
        expect(isValidEnumValue('caseType', '不存在的类型')).toBe(false);
    });

    it('非字符串输入 → 转字符串后判定', () => {
        expect(isValidEnumValue('priority', 123)).toBe(false);
        expect(isValidEnumValue('keyFlag', true)).toBe(false);
    });
});

describe('caseEnumValues · VSCode 配置系统读取（对应 package.json default）', () => {
    let origGetConfig: any;

    beforeEach(() => {
        origGetConfig = (vscode as any).workspace.getConfiguration;
    });

    afterEach(() => {
        (vscode as any).workspace.getConfiguration = origGetConfig;
    });

    it('VSCode 配置返回非空数组 → 直接使用（模拟 package.json default 生效）', () => {
        (vscode as any).workspace.getConfiguration = () => ({
            get: (key: string) => {
                if (key === 'testcaseViewer.enum.caseType') return ['自定义类型A', '自定义类型B'];
                return undefined;
            },
        });
        expect(getEnumValues('caseType')).toEqual(['自定义类型A', '自定义类型B']);
        // 其他未覆盖字段仍回退兜底
        expect(getEnumValues('priority')).toEqual(['高', '中', '低']);
    });

    it('VSCode 配置返回空数组 → 视为无效配置，回退兜底', () => {
        (vscode as any).workspace.getConfiguration = () => ({
            get: (key: string) => {
                if (key === 'testcaseViewer.enum.priority') return [];
                return undefined;
            },
        });
        expect(getEnumValues('priority')).toEqual(['高', '中', '低']);
    });

    it('VSCode 配置含空字符串项 → 过滤后仍能生效', () => {
        (vscode as any).workspace.getConfiguration = () => ({
            get: (key: string) => {
                if (key === 'testcaseViewer.enum.testType') return ['手工', '', '  ', 'X'];
                return undefined;
            },
        });
        expect(getEnumValues('testType')).toEqual(['手工', 'X']);
    });
});
