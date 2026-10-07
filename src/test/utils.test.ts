import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    getNonce,
    escapeHtml,
    buildErrorHtml,
    isInQualifiedDir,
    isInTempFolder,
    explainUnqualified,
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
        // 入参为「相对打开的工作区文件夹」的路径：第1层=测试任务, 第2层=任务名(任意), 第3层=测试案例
        it('识别合格的 CSV 文件路径', () => {
            expect(isInQualifiedDir('测试任务/TT001_登录/测试案例/cases.csv', FILE_PATTERNS.CSV)).toBe(true);
        });

        it('第1层不是「测试任务」时不识别（英文目录）', () => {
            expect(isInQualifiedDir('testtask/TT_test/测试案例/data.csv', FILE_PATTERNS.CSV)).toBe(false);
        });

        it('拒绝不合法路径', () => {
            expect(isInQualifiedDir('other/path/file.csv', FILE_PATTERNS.CSV)).toBe(false);
        });

        it('识别 YAML 文件', () => {
            expect(isInQualifiedDir('测试任务/TT_cases/测试案例/c.yaml', FILE_PATTERNS.YAML)).toBe(true);
        });

        it('识别 JSON 文件', () => {
            expect(isInQualifiedDir('测试任务/TT_data/测试案例/d.json', FILE_PATTERNS.JSON)).toBe(true);
        });

        it('识别 测试案例/ 子目录下的 CSV 文件', () => {
            expect(isInQualifiedDir('测试任务/TT001_登录/测试案例/模块A/cases.csv', FILE_PATTERNS.CSV)).toBe(true);
        });

        it('识别深层子目录下的 YAML 文件', () => {
            expect(isInQualifiedDir('测试任务/TT_test/测试案例/a/b/c/data.yaml', FILE_PATTERNS.YAML)).toBe(true);
        });

        it('识别子目录下的 JSON 文件', () => {
            expect(isInQualifiedDir('测试任务/TT002_异常/测试案例/错误处理/edge.json', FILE_PATTERNS.JSON)).toBe(true);
        });

        it('第3层不是「测试案例」时不识别（缺测试案例目录）', () => {
            expect(isInQualifiedDir('测试任务/TT002_异常/其他目录/cases.csv', FILE_PATTERNS.CSV)).toBe(false);
        });

        it('第3层不是「测试案例」时不识别（测试任务后直接是文件）', () => {
            expect(isInQualifiedDir('测试任务/TT_test/cases.csv', FILE_PATTERNS.CSV)).toBe(false);
        });

        it('允许不含下划线的任务目录名', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/cases.csv', FILE_PATTERNS.CSV)).toBe(true);
        });

        it('允许纯中文任务目录名', () => {
            expect(isInQualifiedDir('测试任务/登录模块/测试案例/cases.csv', FILE_PATTERNS.CSV)).toBe(true);
        });

        it('允许纯中文任务目录名的子目录', () => {
            expect(isInQualifiedDir('测试任务/登录模块/测试案例/子目录/data.yaml', FILE_PATTERNS.YAML)).toBe(true);
        });

        it('「临时文件」文件夹内的文件不识别为案例', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/临时文件/data.json', FILE_PATTERNS.JSON)).toBe(false);
        });

        it('名为「临时文件夹」的文件夹不触发排除（仅精确匹配「临时文件」）', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/临时文件夹/cases.csv', FILE_PATTERNS.CSV)).toBe(true);
        });

        it('目录名后缀含「临时」（非精确）不触发排除', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/草稿_临时/edge.yaml', FILE_PATTERNS.YAML)).toBe(true);
        });

        it('非临时目录中的同名文件不受影响', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/正式数据/data.json', FILE_PATTERNS.JSON)).toBe(true);
        });

        // —— 工作区相对路径下，第1层必须是「测试任务」——
        it('父目录恰叫「测试任务」时相对路径第1层仍是测试任务，正常识别（复现场景）', () => {
            // 绝对：/Users/liujia/yyy/测试任务/C001_测试/测试任务/TT001测试任务1/测试案例/关联样例_login.yaml
            // 相对工作区 C001_测试 的路径：
            expect(isInQualifiedDir('测试任务/TT001测试任务1/测试案例/关联样例_login.yaml', FILE_PATTERNS.YAML)).toBe(true);
        });

        it('用户反例：第2层是「测试任务」导致第3层变成任务名而非测试案例 → 不识别', () => {
            // 测试任务/测试任务/TT005_测试任务5/测试案例/深层/嵌套/case.yaml
            // 第1层=测试任务 ✓, 第2层=测试任务, 第3层=TT005_测试任务5(≠测试案例) → 无效
            expect(isInQualifiedDir('测试任务/测试任务/TT005_测试任务5/测试案例/深层/嵌套/case.yaml', FILE_PATTERNS.YAML)).toBe(false);
        });

        it('嵌套同名「测试任务」出现在第2层且第3层非测试案例时不误判', () => {
            // 测试任务/外层/测试任务/A/其他目录/x.csv → 第3层=测试任务(≠测试案例) → 无效
            expect(isInQualifiedDir('测试任务/外层/测试任务/A/其他目录/x.csv', FILE_PATTERNS.CSV)).toBe(false);
        });

        it('工作区相对路径使用正斜杠分隔时仍可正确切分（Windows 兼容）', () => {
            expect(isInQualifiedDir('测试任务/TT001/测试案例/sub/a.csv', FILE_PATTERNS.CSV)).toBe(true);
        });
    });

    describe('isInTempFolder', () => {
        it('目录段精确等于「临时文件」判定为临时文件夹', () => {
            expect(isInTempFolder('/a/测试案例/临时文件/x.json')).toBe(true);
            expect(isInTempFolder('/a/测试任务/T/测试案例/临时文件/data.json')).toBe(true);
        });

        it('「临时文件夹」「草稿_临时」等近似名称不误判', () => {
            expect(isInTempFolder('/a/测试案例/临时文件夹/x.json')).toBe(false);
            expect(isInTempFolder('/a/测试案例/草稿_临时/x.yaml')).toBe(false);
        });

        it('仅文件名含「临时文件」不误判', () => {
            expect(isInTempFolder('/a/测试案例/临时文件.json')).toBe(false);
        });

        it('普通目录与空路径返回 false', () => {
            expect(isInTempFolder('/a/测试案例/正式数据/x.json')).toBe(false);
            expect(isInTempFolder('')).toBe(false);
        });
    });

    describe('explainUnqualified', () => {
        // 入参为「相对打开的工作区文件夹」的路径：第1层=测试任务, 第2层=任务名, 第3层=测试案例
        it('嵌套同名「测试任务」时指出第 3 层错误并提示重复嵌套', () => {
            const msg = explainUnqualified(
                '测试任务/测试任务/TT005_测试任务5/测试案例/testcases.json',
                'JSON'
            );
            expect(msg).toContain('无法用「测试案例编辑器」打开');
            expect(msg).toContain('第 3 层应为「测试案例」');
            expect(msg).toContain('TT005_测试任务5');
            expect(msg).toContain('多个「测试任务」');
            expect(msg).toContain('当前文件相对工作区的路径');
        });

        it('第 1 层非「测试任务」时指出第 1 层错误', () => {
            const msg = explainUnqualified('其他目录/任务/测试案例/a.csv', 'CSV');
            expect(msg).toContain('第 1 层应为「测试任务」');
            expect(msg).toContain('其他目录');
        });

        it('层级不足时提示层级不足', () => {
            const msg = explainUnqualified('测试任务/TT1/x.json', 'JSON');
            expect(msg).toContain('路径层级不足');
        });

        it('合格路径不触发任何「应为」问题定位', () => {
            const msg = explainUnqualified('测试任务/TT1/测试案例/x.yaml', 'YAML');
            expect(msg).not.toContain('第 1 层应为');
            expect(msg).not.toContain('第 3 层应为');
            expect(msg).not.toContain('路径层级不足');
            expect(msg).not.toContain('多个「测试任务」');
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
