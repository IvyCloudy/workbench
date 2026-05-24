import { describe, it, expect, beforeEach } from 'vitest';
import { CsvFileParser } from '../parsers/csv-parser';

describe('parsers/csv-parser', () => {
    let parser: CsvFileParser;
    let originalReadFile: any;
    let originalWriteFile: any;
    const fs = require('fs');

    beforeEach(() => {
        parser = new CsvFileParser();
        originalReadFile = fs.promises.readFile;
        originalWriteFile = fs.promises.writeFile;
    });

    function mockFileContent(content: string) {
        fs.promises.readFile = async () => content;
    }

    function captureWrite(): { value: string } {
        const captured = { value: '' };
        fs.promises.writeFile = async (_p: string, content: string) => {
            captured.value = content;
        };
        return captured;
    }

    function restore() {
        fs.promises.readFile = originalReadFile;
        fs.promises.writeFile = originalWriteFile;
    }

    describe('parse', () => {
        it('应该解析简单的 CSV 内容', async () => {
            mockFileContent('name,age,city\nAlice,30,Beijing\nBob,25,Shanghai');
            const result = await parser.parse('/mock/file.csv');
            restore();

            expect(result.tableData.headers).toEqual(['name', 'age', 'city']);
            expect(result.tableData.rows).toHaveLength(2);
            expect(result.tableData.rows[0]).toEqual(['Alice', '30', 'Beijing']);
            expect(result.tableData.rows[1]).toEqual(['Bob', '25', 'Shanghai']);
        });

        it('应该处理空内容', async () => {
            mockFileContent('');
            const result = await parser.parse('/mock/empty.csv');
            restore();

            expect(result.tableData.headers).toEqual([]);
            expect(result.tableData.rows).toEqual([]);
        });

        it('应该处理只有表头的 CSV', async () => {
            mockFileContent('name,age,city');
            const result = await parser.parse('/mock/headers-only.csv');
            restore();

            expect(result.tableData.headers).toEqual(['name', 'age', 'city']);
            expect(result.tableData.rows).toEqual([]);
        });

        it('应该处理引号包裹的字段（含逗号）', async () => {
            mockFileContent('name,description\nTest,"包含,逗号的文本"');
            const result = await parser.parse('/mock/quoted.csv');
            restore();

            expect(result.tableData.rows[0][1]).toBe('包含,逗号的文本');
        });

        it('应该自动识别分号分隔符', async () => {
            mockFileContent('name;age;city\nAlice;30;Beijing');
            const result = await parser.parse('/mock/semi.csv');
            restore();

            expect(result.tableData.headers).toEqual(['name', 'age', 'city']);
            expect(result.tableData.rows[0]).toEqual(['Alice', '30', 'Beijing']);
        });
    });

    describe('save', () => {
        it('应该写出基础 CSV', async () => {
            const captured = captureWrite();
            await parser.save('/mock/out.csv', {
                headers: ['name', 'age'],
                rows: [['Alice', '30'], ['Bob', '25']]
            });
            restore();

            expect(captured.value).toContain('name,age');
            expect(captured.value).toContain('Alice,30');
            expect(captured.value).toContain('Bob,25');
        });

        it('应该转义包含逗号的字段', async () => {
            const captured = captureWrite();
            await parser.save('/mock/out.csv', {
                headers: ['name', 'desc'],
                rows: [['Test', '包含,逗号的文本']]
            });
            restore();

            expect(captured.value).toContain('"包含,逗号的文本"');
        });

        it('应该转义包含双引号的字段', async () => {
            const captured = captureWrite();
            await parser.save('/mock/out.csv', {
                headers: ['name', 'quote'],
                rows: [['Test', 'say "hi"']]
            });
            restore();

            expect(captured.value).toContain('"say ""hi"""');
        });
    });
});
