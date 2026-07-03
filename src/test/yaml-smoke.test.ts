import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFileParser } from '../parsers/yaml-parser';

const parser = new YamlFileParser();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-smoke-'));

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function loadSaveReload(name: string, raw: string, mutate?: (parsed: any) => void) {
    const file = path.join(tmpDir, name + '.yaml');
    fs.writeFileSync(file, raw, 'utf-8');
    const parsed = await parser.parse(file);
    if (mutate) mutate(parsed);
    await parser.save(file, parsed.tableData, parsed.sourceData);
    return { written: fs.readFileSync(file, 'utf-8'), parsed };
}

describe('YAML 合并冒烟回归', () => {
    it('Case1: 顶层裸数组形态保持', async () => {
        const raw =
            '- testcase_id: TC001\n  testCaseNo: ""\n  path: /api/login\n  method: GET\n' +
            '- testcase_id: TC002\n  testCaseNo: ""\n  path: /api/logout\n  method: POST\n';
        const { written } = await loadSaveReload('top-array', raw);
        expect(written.startsWith('- ') || /^\s*-\s/.test(written)).toBe(true);
        expect(written).toContain('/api/login');
        expect(written).toContain('/api/logout');
        expect(written).toContain('TC001');
        expect(written).toContain('TC002');
    });

    it('Case2: cases 顶层对象解析后保存为数组形态（设计行为），且行内容不丢失', async () => {
        const raw =
            'cases:\n' +
            '  - testcase_id: TC001\n    testCaseNo: ""\n    path: /api/a\n' +
            '  - testcase_id: TC002\n    testCaseNo: ""\n    path: /api/b\n';
        const { written } = await loadSaveReload('cases-wrap', raw);
        // 注意：parser 当前设计是把 cases: 包裹拆开作为顶层数组（与裸数组形态统一处理）
        // 关键不变量：所有行内容、所有列都不丢
        expect(written).toContain('TC001');
        expect(written).toContain('TC002');
        expect(written).toContain('/api/a');
        expect(written).toContain('/api/b');
    });

    it('Case3: testCaseNo 推送回写不丢列', async () => {
        const raw =
            '- testcase_id: TC100\n  testCaseNo: ""\n  path: /api/x\n  method: POST\n  request_body: \'{"a":1}\'\n';
        const { written } = await loadSaveReload('writeback', raw, (parsed) => {
            const idx = parsed.tableData.headers.indexOf('testCaseNo');
            if (idx >= 0) parsed.tableData.rows[0][idx] = 'NEW123';
        });
        expect(written).toContain('NEW123');
        expect(written).toContain('/api/x');
        expect(written).toContain('POST');
        // request_body 应保留 a:1 信息（不论用单引/双引/裸值）
        expect(/a['"]?\s*[:=]\s*1/.test(written)).toBe(true);
    });

    it('Case4: 多行块标量内容保留', async () => {
        const raw =
            '- testcase_id: TC200\n  testCaseNo: ""\n  request_body: |\n    line1\n    line2\n    line3\n  path: /api/y\n';
        const { written } = await loadSaveReload('block-scalar', raw);
        expect(/line1[\s\S]*line2[\s\S]*line3/.test(written)).toBe(true);
        expect(written).toContain('/api/y');
    });

    it('Case5: ctrl+v 粘贴到空 path 单元格不丢列', async () => {
        const raw =
            '- testcase_id: TC300\n  testCaseNo: ""\n  path: ""\n  method: GET\n';
        const { written } = await loadSaveReload('paste-path', raw, (parsed) => {
            const idx = parsed.tableData.headers.indexOf('path');
            if (idx >= 0) parsed.tableData.rows[0][idx] = '/api/pasted';
        });
        expect(written).toContain('/api/pasted');
        expect(written).toContain('TC300');
        expect(written).toContain('GET');
    });
});
