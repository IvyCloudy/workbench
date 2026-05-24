import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    getNonce,
    escapeHtml,
    buildErrorHtml,
    isInQualifiedDir,
    debounce,
    deepClone,
    FILE_PATTERNS
} from '../services/utils';

describe('services/utils', () => {
    describe('getNonce', () => {
        it('应该生成 64 字符的 nonce', () => {
            const nonce = getNonce();
            expect(nonce).toHaveLength(64);
        });

        it('应该只包含字母和数字', () => {
            expect(getNonce()).toMatch(/^[A-Za-z0-9]+$/);
        });

        it('每次调用应该生成不同的 nonce', () => {
            expect(getNonce()).not.toBe(getNonce());
        });

        it('支持自定义长度', () => {
            expect(getNonce(16)).toHaveLength(16);
        });
    });

    describe('escapeHtml', () => {
        it('转义 & 字符', () => {
            expect(escapeHtml('a & b')).toBe('a &amp; b');
        });

        it('转义 < 和 >', () => {
            expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
        });

        it('转义双引号', () => {
            expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
        });

        it('转义单引号', () => {
            expect(escapeHtml("it's")).toBe("it&#39;s");
        });

        it('处理空字符串与 null/undefined', () => {
            expect(escapeHtml('')).toBe('');
            expect(escapeHtml(null as any)).toBe('');
            expect(escapeHtml(undefined as any)).toBe('');
        });

        it('防 XSS', () => {
            const html = '<script>alert("xss")</script>';
            expect(escapeHtml(html)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        });
    });

    describe('buildErrorHtml', () => {
        it('返回包含消息的 HTML', () => {
            const html = buildErrorHtml('文件不合格');
            expect(html).toContain('文件不合格');
            expect(html).toContain('<!DOCTYPE html>');
        });

        it('支持自定义标题', () => {
            const html = buildErrorHtml('msg', '提示');
            expect(html).toContain('提示');
        });

        it('对消息进行转义', () => {
            const html = buildErrorHtml('<script>alert(1)</script>');
            expect(html).not.toContain('<script>alert(1)</script>');
            expect(html).toContain('&lt;script&gt;');
        });
    });

    describe('isInQualifiedDir', () => {
        it('识别合格的 CSV 文件路径（中文）', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/任务1/测试案例/cases.csv');
            expect(isInQualifiedDir(uri.fsPath, FILE_PATTERNS.CSV)).toBe(true);
        });

        it('识别合格的英文目录', () => {
            const uri = vscode.Uri.file('/workspace/testtask/task1/testcase/data.csv');
            expect(isInQualifiedDir(uri.fsPath, FILE_PATTERNS.CSV)).toBe(true);
        });

        it('拒绝不合法路径', () => {
            const uri = vscode.Uri.file('/other/path/file.csv');
            expect(isInQualifiedDir(uri.fsPath, FILE_PATTERNS.CSV)).toBe(false);
        });

        it('识别 YAML 文件', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/t/测试案例/c.yaml');
            expect(isInQualifiedDir(uri.fsPath, FILE_PATTERNS.YAML)).toBe(true);
        });

        it('识别 JSON 文件', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/t/测试案例/d.json');
            expect(isInQualifiedDir(uri.fsPath, FILE_PATTERNS.JSON)).toBe(true);
        });
    });

    describe('debounce', () => {
        it('应该延迟函数执行', async () => {
            let count = 0;
            const fn = () => { count++; };
            const debounced = debounce(fn, 100);

            debounced(); debounced(); debounced();
            expect(count).toBe(0);

            await new Promise(r => setTimeout(r, 150));
            expect(count).toBe(1);
        });

        it('应该传递参数到原始函数', async () => {
            let result = 0;
            const fn = (a: number, b: number) => { result = a + b; };
            const debounced = debounce(fn, 50);

            debounced(3, 5);
            await new Promise(r => setTimeout(r, 100));
            expect(result).toBe(8);
        });
    });

    describe('deepClone', () => {
        it('深拷贝数组', () => {
            const original = [1, [2, 3], { a: 4 }];
            const cloned = deepClone(original);

            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
            expect(cloned[1]).not.toBe(original[1]);
        });

        it('深拷贝对象', () => {
            const original = { a: 1, b: { c: 2 } };
            const cloned = deepClone(original);

            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
            expect(cloned.b).not.toBe(original.b);
        });

        it('处理原始类型', () => {
            expect(deepClone(42)).toBe(42);
            expect(deepClone('hello')).toBe('hello');
            expect(deepClone(true)).toBe(true);
            expect(deepClone(null)).toBe(null);
        });
    });

    describe('FILE_PATTERNS', () => {
        it('匹配 CSV', () => {
            expect(FILE_PATTERNS.CSV.test('data.csv')).toBe(true);
            expect(FILE_PATTERNS.CSV.test('DATA.CSV')).toBe(true);
            expect(FILE_PATTERNS.CSV.test('data.txt')).toBe(false);
        });

        it('匹配 YAML', () => {
            expect(FILE_PATTERNS.YAML.test('c.yaml')).toBe(true);
            expect(FILE_PATTERNS.YAML.test('c.yml')).toBe(true);
            expect(FILE_PATTERNS.YAML.test('c.json')).toBe(false);
        });

        it('匹配 JSON', () => {
            expect(FILE_PATTERNS.JSON.test('d.json')).toBe(true);
            expect(FILE_PATTERNS.JSON.test('D.JSON')).toBe(true);
            expect(FILE_PATTERNS.JSON.test('d.js')).toBe(false);
        });
    });
});
