import { describe, it, expect, beforeEach } from 'vitest';
import { JsonFileParser } from '../parsers/json-parser';
import { ensureTrackingColumns } from '../parsers';

/**
 * 回归测试：JSON 案例文件「顶层形态保持」
 *   - 顶层为数组（多条 / 单条）→ 回写仍为数组
 *   - 顶层为单个对象（单条）→ 回写仍为单个对象，不被误判为数组、也不丢失数据
 * 背景：避免「用案例编辑器打开、添加 testcase_id 后，数组被误写成单个字典 / 单对象被误写成数组」。
 */
describe('json-parser 顶层形态保持（添加 testcase_id 后）', () => {
    let parser: JsonFileParser;
    const fs = require('fs');
    let originalReadFile: any;
    let originalWriteFile: any;

    beforeEach(() => {
        parser = new JsonFileParser();
        originalReadFile = fs.promises.readFile;
        originalWriteFile = fs.promises.writeFile;
    });

    function mockFileContent(content: string) {
        fs.promises.readFile = async () => content;
    }
    function captureWrite(): { value: string } {
        const captured = { value: '' };
        fs.promises.writeFile = async (_p: string, content: string) => { captured.value = content; };
        return captured;
    }
    function restore() {
        fs.promises.readFile = originalReadFile;
        fs.promises.writeFile = originalWriteFile;
    }

    async function roundtrip(content: string) {
        mockFileContent(content);
        const result = await parser.parse('/mock/file.json');
        const ensured = ensureTrackingColumns(result.tableData, result.sourceData);
        const captured = captureWrite();
        await parser.save('/mock/file.json', ensured.tableData, result.sourceData);
        restore();
        return JSON.parse(captured.value);
    }

    it('顶层数组（多条）→ 仍为数组', async () => {
        const out = await roundtrip(JSON.stringify([{ name: 'a' }, { name: 'b' }], null, 2));
        expect(Array.isArray(out)).toBe(true);
        expect(out).toHaveLength(2);
        expect(out[0]).toHaveProperty('testcase_id');
    });

    it('顶层数组（仅 1 条）→ 仍为数组（不变成单个字典）', async () => {
        const out = await roundtrip(JSON.stringify([{ name: 'case1', age: 10 }], null, 2));
        expect(Array.isArray(out)).toBe(true);
        expect(out).toHaveLength(1);
        expect(out[0]).toHaveProperty('testcase_id');
        expect(out[0]).toHaveProperty('name', 'case1');
    });

    it('顶层单对象（单条）→ 仍为单对象（不被包成数组 / 不丢失字段）', async () => {
        const out = await roundtrip(JSON.stringify({ name: 'case1', age: 10 }, null, 2));
        expect(Array.isArray(out)).toBe(false);
        expect(typeof out).toBe('object');
        expect(out).toHaveProperty('testcase_id');
        expect(out).toHaveProperty('name', 'case1');
        expect(out).toHaveProperty('age', 10);
    });

    it('顶层单对象且含嵌套结构 → 仍为单对象并保留嵌套', async () => {
        const out = await roundtrip(JSON.stringify({ name: 'case1', steps: [{ op: 'click' }] }, null, 2));
        expect(Array.isArray(out)).toBe(false);
        expect(out).toHaveProperty('testcase_id');
        expect(out.steps).toEqual([{ op: 'click' }]);
    });

    it('单对象文件解析后非空白（可编辑）', async () => {
        mockFileContent(JSON.stringify({ name: 'case1' }, null, 2));
        const result = await parser.parse('/mock/file.json');
        restore();
        expect(result.tableData.headers.length).toBeGreaterThan(0);
        expect(result.tableData.rows.length).toBe(1);
        expect(Array.isArray(result.sourceData)).toBe(false);
    });
});
