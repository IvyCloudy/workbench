"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const vscode = __importStar(require("vscode"));
const utils_1 = require("./utils");
(0, vitest_1.describe)('utils.ts', () => {
    (0, vitest_1.describe)('getNonce', () => {
        (0, vitest_1.it)('应该生成 64 字符的 nonce', () => {
            const nonce = (0, utils_1.getNonce)();
            (0, vitest_1.expect)(nonce).toHaveLength(64);
        });
        (0, vitest_1.it)('应该只包含字母和数字', () => {
            const nonce = (0, utils_1.getNonce)();
            (0, vitest_1.expect)(nonce).toMatch(/^[A-Za-z0-9]+$/);
        });
        (0, vitest_1.it)('每次调用应该生成不同的 nonce', () => {
            const nonce1 = (0, utils_1.getNonce)();
            const nonce2 = (0, utils_1.getNonce)();
            (0, vitest_1.expect)(nonce1).not.toBe(nonce2);
        });
    });
    (0, vitest_1.describe)('escapeHtml', () => {
        (0, vitest_1.it)('应该转义 & 字符', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)('a & b')).toBe('a &amp; b');
        });
        (0, vitest_1.it)('应该转义 < 和 > 字符', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)('<div>')).toBe('&lt;div&gt;');
        });
        (0, vitest_1.it)('应该转义双引号', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)('say "hello"')).toBe('say &quot;hello&quot;');
        });
        (0, vitest_1.it)('应该转义单引号', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)("it's")).toBe("it&#39;s");
        });
        (0, vitest_1.it)('应该处理空字符串', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)('')).toBe('');
        });
        (0, vitest_1.it)('应该处理 null 和 undefined', () => {
            (0, vitest_1.expect)((0, utils_1.escapeHtml)(null)).toBe('');
            (0, vitest_1.expect)((0, utils_1.escapeHtml)(undefined)).toBe('');
        });
        (0, vitest_1.it)('应该正确处理复杂 HTML', () => {
            const html = '<script>alert("xss")</script>';
            const escaped = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
            (0, vitest_1.expect)((0, utils_1.escapeHtml)(html)).toBe(escaped);
        });
    });
    (0, vitest_1.describe)('isInQualifiedDir', () => {
        (0, vitest_1.it)('应该识别合格的 CSV 文件路径', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/testtask/测试案例/testcases.csv');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.CSV)).toBe(true);
        });
        (0, vitest_1.it)('应该拒绝不合法的文件路径', () => {
            const uri = vscode.Uri.file('/other/path/file.csv');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.CSV)).toBe(false);
        });
        (0, vitest_1.it)('应该识别英文目录名', () => {
            const uri = vscode.Uri.file('/workspace/testtask/task1/testcase/data.csv');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.CSV)).toBe(true);
        });
        (0, vitest_1.it)('应该识别 YAML 文件', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/task1/测试案例/config.yaml');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.YAML)).toBe(true);
        });
        (0, vitest_1.it)('应该识别 JSON 文件', () => {
            const uri = vscode.Uri.file('/workspace/测试任务/task1/测试案例/data.json');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.JSON)).toBe(true);
        });
        (0, vitest_1.it)('应该拒绝非 file 协议的 URI', () => {
            const uri = vscode.Uri.parse('http://example.com/file.csv');
            (0, vitest_1.expect)((0, utils_1.isInQualifiedDir)(uri, utils_1.FILE_PATTERNS.CSV)).toBe(false);
        });
    });
    (0, vitest_1.describe)('debounce', () => {
        (0, vitest_1.it)('应该延迟函数执行', async () => {
            let count = 0;
            const fn = () => { count++; };
            const debouncedFn = (0, utils_1.debounce)(fn, 100);
            debouncedFn();
            debouncedFn();
            debouncedFn();
            (0, vitest_1.expect)(count).toBe(0);
            await new Promise(resolve => setTimeout(resolve, 150));
            (0, vitest_1.expect)(count).toBe(1);
        });
        (0, vitest_1.it)('应该传递参数到原始函数', async () => {
            let result = 0;
            const fn = (a, b) => { result = a + b; };
            const debouncedFn = (0, utils_1.debounce)(fn, 50);
            debouncedFn(3, 5);
            await new Promise(resolve => setTimeout(resolve, 100));
            (0, vitest_1.expect)(result).toBe(8);
        });
    });
    (0, vitest_1.describe)('deepClone', () => {
        (0, vitest_1.it)('应该深拷贝数组', () => {
            const original = [1, [2, 3], { a: 4 }];
            const cloned = (0, utils_1.deepClone)(original);
            (0, vitest_1.expect)(cloned).toEqual(original);
            (0, vitest_1.expect)(cloned).not.toBe(original);
            (0, vitest_1.expect)(cloned[1]).not.toBe(original[1]);
        });
        (0, vitest_1.it)('应该深拷贝对象', () => {
            const original = { a: 1, b: { c: 2 } };
            const cloned = (0, utils_1.deepClone)(original);
            (0, vitest_1.expect)(cloned).toEqual(original);
            (0, vitest_1.expect)(cloned).not.toBe(original);
            (0, vitest_1.expect)(cloned.b).not.toBe(original.b);
        });
        (0, vitest_1.it)('应该处理原始类型', () => {
            (0, vitest_1.expect)((0, utils_1.deepClone)(42)).toBe(42);
            (0, vitest_1.expect)((0, utils_1.deepClone)('hello')).toBe('hello');
            (0, vitest_1.expect)((0, utils_1.deepClone)(true)).toBe(true);
            (0, vitest_1.expect)((0, utils_1.deepClone)(null)).toBe(null);
        });
    });
    (0, vitest_1.describe)('FILE_PATTERNS', () => {
        (0, vitest_1.it)('应该正确匹配 CSV 文件', () => {
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.CSV.test('data.csv')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.CSV.test('DATA.CSV')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.CSV.test('data.txt')).toBe(false);
        });
        (0, vitest_1.it)('应该正确匹配 YAML 文件', () => {
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.YAML.test('config.yaml')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.YAML.test('config.yml')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.YAML.test('config.json')).toBe(false);
        });
        (0, vitest_1.it)('应该正确匹配 JSON 文件', () => {
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.JSON.test('data.json')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.JSON.test('DATA.JSON')).toBe(true);
            (0, vitest_1.expect)(utils_1.FILE_PATTERNS.JSON.test('data.js')).toBe(false);
        });
    });
});
//# sourceMappingURL=utils.test.js.map