import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
  getNonce,
  escapeHtml,
  isInQualifiedDir,
  debounce,
  deepClone,
  FILE_PATTERNS
} from './utils';

describe('utils.ts', () => {
  describe('getNonce', () => {
    it('应该生成 64 字符的 nonce', () => {
      const nonce = getNonce();
      expect(nonce).toHaveLength(64);
    });

    it('应该只包含字母和数字', () => {
      const nonce = getNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('每次调用应该生成不同的 nonce', () => {
      const nonce1 = getNonce();
      const nonce2 = getNonce();
      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe('escapeHtml', () => {
    it('应该转义 & 字符', () => {
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('应该转义 < 和 > 字符', () => {
      expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
    });

    it('应该转义双引号', () => {
      expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('应该转义单引号', () => {
      expect(escapeHtml("it's")).toBe("it&#39;s");
    });

    it('应该处理空字符串', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('应该处理 null 和 undefined', () => {
      expect(escapeHtml(null as any)).toBe('');
      expect(escapeHtml(undefined as any)).toBe('');
    });

    it('应该正确处理复杂 HTML', () => {
      const html = '<script>alert("xss")</script>';
      const escaped = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
      expect(escapeHtml(html)).toBe(escaped);
    });
  });

  describe('isInQualifiedDir', () => {
    it('应该识别合格的 CSV 文件路径', () => {
      const uri = vscode.Uri.file('/workspace/测试任务/testtask/测试案例/testcases.csv');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.CSV)).toBe(true);
    });

    it('应该拒绝不合法的文件路径', () => {
      const uri = vscode.Uri.file('/other/path/file.csv');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.CSV)).toBe(false);
    });

    it('应该识别英文目录名', () => {
      const uri = vscode.Uri.file('/workspace/testtask/task1/testcase/data.csv');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.CSV)).toBe(true);
    });

    it('应该识别 YAML 文件', () => {
      const uri = vscode.Uri.file('/workspace/测试任务/task1/测试案例/config.yaml');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.YAML)).toBe(true);
    });

    it('应该识别 JSON 文件', () => {
      const uri = vscode.Uri.file('/workspace/测试任务/task1/测试案例/data.json');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.JSON)).toBe(true);
    });

    it('应该拒绝非 file 协议的 URI', () => {
      const uri = vscode.Uri.parse('http://example.com/file.csv');
      expect(isInQualifiedDir(uri, FILE_PATTERNS.CSV)).toBe(false);
    });
  });

  describe('debounce', () => {
    it('应该延迟函数执行', async () => {
      let count = 0;
      const fn = () => { count++; };
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(count).toBe(0);

      await new Promise(resolve => setTimeout(resolve, 150));
      expect(count).toBe(1);
    });

    it('应该传递参数到原始函数', async () => {
      let result = 0;
      const fn = (a: number, b: number) => { result = a + b; };
      const debouncedFn = debounce(fn, 50);

      debouncedFn(3, 5);

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(result).toBe(8);
    });
  });

  describe('deepClone', () => {
    it('应该深拷贝数组', () => {
      const original = [1, [2, 3], { a: 4 }];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[1]).not.toBe(original[1]);
    });

    it('应该深拷贝对象', () => {
      const original = { a: 1, b: { c: 2 } };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect((cloned as any).b).not.toBe((original as any).b);
    });

    it('应该处理原始类型', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone(true)).toBe(true);
      expect(deepClone(null)).toBe(null);
    });
  });

  describe('FILE_PATTERNS', () => {
    it('应该正确匹配 CSV 文件', () => {
      expect(FILE_PATTERNS.CSV.test('data.csv')).toBe(true);
      expect(FILE_PATTERNS.CSV.test('DATA.CSV')).toBe(true);
      expect(FILE_PATTERNS.CSV.test('data.txt')).toBe(false);
    });

    it('应该正确匹配 YAML 文件', () => {
      expect(FILE_PATTERNS.YAML.test('config.yaml')).toBe(true);
      expect(FILE_PATTERNS.YAML.test('config.yml')).toBe(true);
      expect(FILE_PATTERNS.YAML.test('config.json')).toBe(false);
    });

    it('应该正确匹配 JSON 文件', () => {
      expect(FILE_PATTERNS.JSON.test('data.json')).toBe(true);
      expect(FILE_PATTERNS.JSON.test('DATA.JSON')).toBe(true);
      expect(FILE_PATTERNS.JSON.test('data.js')).toBe(false);
    });
  });
});
