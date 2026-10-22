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
import { containsTestCaseId, ensureTrackingColumns } from '../parsers';

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

describe('F5 内容门控 · 空/全空白 JSON 不应误判为案例', () => {
    it('空 JSON 文件解析为空白表且不含 testcase_id → 打开门控应重定向到文本编辑器', async () => {
        const f = tmpFile('.json', '');
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        // 关键：空文件不含 testcase_id，解析器返回空表 → containsTestCaseId 返回 false → 非案例文件，
        // 进案例编辑器但功能受限（而非被"解析失败保守按案例处理"误判为完整案例打开）。
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(false);
    });

    it('全空白 JSON 文件同样解析为空白表', async () => {
        const f = tmpFile('.json', '   \n\t  \n');
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(false);
    });
});

describe('F5 内容门控 · 空/全空白 YAML 不误判为案例', () => {
    it('空 YAML 文件解析为空白表且不含 testcase_id', async () => {
        const f = tmpFile('.yaml', '');
        const parsed = await new YamlFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'yaml')).toBe(false);
    });

    it('全空白 YAML 文件同样解析为空白表', async () => {
        const f = tmpFile('.yml', '   \n# 仅注释\n  \n');
        const parsed = await new YamlFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'yaml')).toBe(false);
    });
});

describe('F5 内容门控 · 空/全空白 CSV 不误判为案例', () => {
    it('空 CSV 文件解析为空白表且不含 testcase_id', async () => {
        const f = tmpFile('.csv', '');
        const parsed = await new CsvFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'csv')).toBe(false);
    });

    it('全空白 CSV 文件同样解析为空白表', async () => {
        const f = tmpFile('.csv', '   \n\t  \n');
        const parsed = await new CsvFileParser().parse(f);
        fs.unlinkSync(f);
        expect(parsed.tableData.headers).toEqual([]);
        expect(parsed.tableData.rows).toEqual([]);
        expect(containsTestCaseId(parsed.tableData.headers, parsed.sourceData, 'csv')).toBe(false);
    });
});

describe('打开门控决策 · 默认无 testcase_id 重定向文本编辑器（F5 默认行为）', () => {
    // 与 BaseEditorProvider.checkTestCaseIdField 同款决策：仅依据 "内容是否含 testcase_id" 判断，
    // 不再对「非空缺主键列」的文件放行（该能力改由用户显式「用案例编辑器打开」命令触发，见下方标记消费）。
    function gateDecision(headers: string[] | undefined, sourceData: any, type: any) {
        return containsTestCaseId(headers, sourceData, type);
    }

    it('非空且无 testcase_id → 默认重定向到文本编辑器（不经案例编辑器）', async () => {
        const f = tmpFile('.csv', 'name,steps\n用例1,s1\n');
        const parsed = await new CsvFileParser().parse(f);
        fs.unlinkSync(f);
        expect(gateDecision(parsed.tableData.headers, parsed.sourceData, 'csv')).toBe(false);
    });

    it('非空 JSON 单对象无 testcase_id → 默认重定向到文本编辑器', async () => {
        const f = tmpFile('.json', JSON.stringify({ name: '用例1', steps: 's1' }));
        const parsed = await new JsonFileParser().parse(f);
        fs.unlinkSync(f);
        expect(gateDecision(parsed.tableData.headers, parsed.sourceData, 'json')).toBe(false);
    });

    it('空文件 / 全空白（解析为空白表）→ 重定向到文本编辑器', () => {
        expect(gateDecision([], null, 'json')).toBe(false);
        expect(gateDecision([], null, 'json')).toBe(false);
    });

    it('含 testcase_id → 放行（用案例编辑器打开）', () => {
        expect(gateDecision(['testcase_id', 'name'], null, 'csv')).toBe(true);
    });
});

describe('ensureTrackingColumns · addIfMissing 选项（F8：打开/保存不新增列）', () => {
    it('默认(未传 addIfMissing) 缺 testcase_id 时新增列并补 uuid', () => {
        const td = { headers: ['name', 'steps'], rows: [['a', 's1'], ['b', 's2']] };
        const e = ensureTrackingColumns(td, []);
        expect(td.headers[0]).toBe('testcase_id');
        expect(td.rows[0][0]).not.toBe('');
        expect(typeof td.rows[0][0]).toBe('string');
        expect(e.generated).toBe(true);
    });

    it('addIfMissing:false 且缺 testcase_id → 不新增列、不改数据（按原样打开）', () => {
        const td = { headers: ['name', 'steps'], rows: [['a', 's1']] };
        const e = ensureTrackingColumns(td, [], { addIfMissing: false });
        expect(td.headers).toEqual(['name', 'steps']);
        expect(td.rows).toEqual([['a', 's1']]);
        expect(e.generated).toBe(false);
    });

    it('addIfMissing:false 且已存在 testcase_id 列 → 仅补齐空单元格，保留已有值', () => {
        const td = { headers: ['testcase_id', 'name'], rows: [['', 'a'], ['id-2', 'b']] };
        const e = ensureTrackingColumns(
            td,
            [{ testcase_id: '', name: 'a' }, { testcase_id: 'id-2', name: 'b' }],
            { addIfMissing: false }
        );
        expect(td.headers).toEqual(['testcase_id', 'name']);
        expect(td.rows[0][0]).not.toBe('');      // 空单元格被补全
        expect(typeof td.rows[0][0]).toBe('string');
        expect(td.rows[1][0]).toBe('id-2');      // 已有值保留
        expect(e.generated).toBe(true);
    });
});
