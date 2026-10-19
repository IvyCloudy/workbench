/**
 * F5 内容门控回归测试
 * ----------------------------------------------------------------------------
 * 关键回归点：文件「先前是案例（含 testcase_id）」，用户用 TextEditor 删除 testcase_id
 * 字段并保存后，案例编辑器在「重新解析磁盘」时应判定为不再含 testcase_id，从而停止把
 * 该字段自动补全/落盘。这里用真实 parser 解析「删除后的文件」，验证 containsTestCaseId
 * 返回 false（之前曾因只拦截 externalChange、漏掉 visible/reload 路径导致字段被加回）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonFileParser } from '../parsers/json-parser';
import { YamlFileParser } from '../parsers/yaml-parser';
import { CsvFileParser } from '../parsers/csv-parser';
import { containsTestCaseId } from '../parsers';

function tmpFile(ext: string, content: string) {
    const f = path.join(os.tmpdir(), 'f5_gate_' + Date.now() + '_' + Math.random().toString(36).slice(2) + ext);
    fs.writeFileSync(f, content);
    return f;
}

describe('F5 内容门控 · 删除 testcase_id 后解析应判为非案例', () => {
    it('JSON 数组删除 testcase_id 键 → false', async () => {
        const f = tmpFile('.json', JSON.stringify([{ name: '用例1', steps: 's1' }], null, 2));
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(false);
    });

    it('JSON 单对象删除 testcase_id 键 → false', async () => {
        const f = tmpFile('.json', JSON.stringify({ name: '用例1', steps: 's1' }, null, 2));
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(false);
    });

    it('YAML 删除 testcase_id 键 → false', async () => {
        const f = tmpFile('.yaml', '- name: 用例1\n  steps: s1\n');
        const parsed = await new YamlFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'yaml')).toBe(false);
    });

    it('CSV 删除 testcase_id 表头列 → false', async () => {
        const f = tmpFile('.csv', 'name,steps\n用例1,s1\n');
        const parsed = await new CsvFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'csv')).toBe(false);
    });
});

describe('F5 内容门控 · 含 testcase_id 应判为案例（不误伤）', () => {
    it('JSON 数组含 testcase_id → true', async () => {
        const f = tmpFile('.json', JSON.stringify([{ testcase_id: 't1', name: '用例1' }], null, 2));
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(true);
    });

    it('CSV 含 testcase_id 表头 → true', async () => {
        const f = tmpFile('.csv', 'testcase_id,name\nx1,用例1\n');
        const parsed = await new CsvFileParser().parse(f);
        fs.unlinkSync(f);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'csv')).toBe(true);
    });
});
