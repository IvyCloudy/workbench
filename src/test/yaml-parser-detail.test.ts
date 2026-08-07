/**
 * ============================================================================
 *  test/yaml-parser-detail.test.ts
 *  YAML 明细表提取回归（第 9 轮检视 λ 修复）
 * ----------------------------------------------------------------------------
 *  背景：
 *    yaml-parser.extractDetailTables 历史实现里维护了 hasArray/hasObject 两个
 *    状态字段但从未消费（死状态），实际提取逻辑落在 buildDetailTable 里独立扫描。
 *    第 9 轮把外层收集简化为 Set<string>，需要用真实 YAML 文件反复往返来证明：
 *      1) 对象数组明细字段（steps: [{...}, {...}]）能识别并展开
 *      2) 嵌套对象明细字段（config: {...}）也能识别
 *      3) 顶层标量列不会被误识为明细
 *      4) 多明细字段并存时全部提取
 *      5) 部分行明细为空 / 缺失字段的容忍
 *      6) save→reload 后明细字段结构不丢
 *  说明：为避免测试环境加载 vscode，仅走 parser 纯逻辑路径。
 * ============================================================================
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YamlFileParser } from '../parsers/yaml-parser';

const parser = new YamlFileParser();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-parser-detail-'));

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function loadFromRaw(name: string, raw: string) {
    const file = path.join(tmpDir, name + '.yaml');
    fs.writeFileSync(file, raw, 'utf-8');
    const parsed = await parser.parse(file);
    return { file, parsed };
}

describe('yaml-parser 明细表提取（λ 简化回归）', () => {
    it('对象数组明细字段：steps 被识别并展开为 detailTable', async () => {
        const raw =
            '- testcase_id: TC001\n' +
            '  name: 用例A\n' +
            '  steps:\n' +
            '    - action: click\n' +
            '      target: btn1\n' +
            '    - action: input\n' +
            '      target: box1\n' +
            '- testcase_id: TC002\n' +
            '  name: 用例B\n' +
            '  steps:\n' +
            '    - action: navigate\n' +
            '      target: /home\n';
        const { parsed } = await loadFromRaw('array-detail', raw);
        const tables = parsed.tableData.detailTables || [];

        // 主表 headers 应包含标量字段 + 明细字段
        expect(parsed.tableData.headers).toContain('testcase_id');
        expect(parsed.tableData.headers).toContain('name');
        expect(parsed.tableData.headers).toContain('steps');

        // 明细表：应有 steps，且 headers 是子对象字段的并集
        const stepsTable = tables.find(t => t.field === 'steps');
        expect(stepsTable).toBeDefined();
        expect(stepsTable!.headers).toContain('action');
        expect(stepsTable!.headers).toContain('target');

        // rowGroups：TC001 有 2 条子行、TC002 有 1 条子行
        expect(stepsTable!.rowGroups.length).toBe(2);
        expect(stepsTable!.rowGroups[0].length).toBe(2);
        expect(stepsTable!.rowGroups[1].length).toBe(1);

        // rawRowTypes：两行都应为 'array'
        expect(stepsTable!.rawRowTypes).toEqual(['array', 'array']);
    });

    it('嵌套对象明细字段：config 被识别为 object 类型明细', async () => {
        const raw =
            '- testcase_id: TC010\n' +
            '  config:\n' +
            '    timeout: 30\n' +
            '    retry: 3\n' +
            '- testcase_id: TC011\n' +
            '  config:\n' +
            '    timeout: 60\n' +
            '    retry: 1\n';
        const { parsed } = await loadFromRaw('obj-detail', raw);
        const tables = parsed.tableData.detailTables || [];
        const cfg = tables.find(t => t.field === 'config');
        expect(cfg).toBeDefined();
        expect(cfg!.headers).toEqual(expect.arrayContaining(['timeout', 'retry']));
        expect(cfg!.rawRowTypes).toEqual(['object', 'object']);
        // 对象类型：每行子表只有一条子记录
        expect(cfg!.rowGroups[0].length).toBe(1);
        expect(cfg!.rowGroups[1].length).toBe(1);
    });

    it('顶层标量列不会被误识为明细', async () => {
        const raw =
            '- testcase_id: TC020\n' +
            '  name: 简单\n' +
            '  age: 30\n' +
            '  enabled: true\n';
        const { parsed } = await loadFromRaw('scalar-only', raw);
        const tables = parsed.tableData.detailTables || [];
        // 无任何嵌套字段 → detailTables 应为 undefined 或空数组
        expect(tables.length).toBe(0);
    });

    it('多个明细字段并存：steps + config 都要被提取', async () => {
        const raw =
            '- testcase_id: TC030\n' +
            '  name: 混合\n' +
            '  steps:\n' +
            '    - action: click\n' +
            '  config:\n' +
            '    timeout: 30\n';
        const { parsed } = await loadFromRaw('multi-detail', raw);
        const tables = parsed.tableData.detailTables || [];
        const fields = tables.map(t => t.field).sort();
        expect(fields).toEqual(['config', 'steps']);
    });

    it('部分行明细为空 / 缺失：容忍并给出 rawRowTypes=none', async () => {
        const raw =
            '- testcase_id: TC040\n' +
            '  steps:\n' +
            '    - action: click\n' +
            '- testcase_id: TC041\n' +   // 该行无 steps 字段
            '  name: 无步骤\n';
        const { parsed } = await loadFromRaw('partial-detail', raw);
        const tables = parsed.tableData.detailTables || [];
        const stepsTable = tables.find(t => t.field === 'steps');
        expect(stepsTable).toBeDefined();
        expect(stepsTable!.rawRowTypes!.length).toBe(2);
        // 第一行有 steps 数组，第二行没有
        expect(stepsTable!.rawRowTypes![0]).toBe('array');
        expect(stepsTable!.rawRowTypes![1]).toBe('none');
        expect(stepsTable!.rowGroups[1]).toEqual([]);
    });

    it('save→reload 后明细字段结构不丢（λ 简化后仍要保证等价往返）', async () => {
        const raw =
            '- testcase_id: TC050\n' +
            '  steps:\n' +
            '    - action: click\n' +
            '      target: btn1\n' +
            '    - action: input\n' +
            '      target: box1\n';
        const { file, parsed } = await loadFromRaw('roundtrip', raw);
        await parser.save(file, parsed.tableData, parsed.sourceData);
        const reloaded = await parser.parse(file);
        const reTables = reloaded.tableData.detailTables || [];
        const steps = reTables.find(t => t.field === 'steps');
        expect(steps).toBeDefined();
        expect(steps!.rowGroups[0].length).toBe(2);
        expect(steps!.headers).toEqual(expect.arrayContaining(['action', 'target']));
    });

    it('对象数组字段中包含空数组的行 —— 不会破坏识别（λ 简化点：只关心字段名 Set）', async () => {
        const raw =
            '- testcase_id: TC060\n' +
            '  steps: []\n' +
            '- testcase_id: TC061\n' +
            '  steps:\n' +
            '    - action: click\n';
        const { parsed } = await loadFromRaw('empty-array-row', raw);
        const tables = parsed.tableData.detailTables || [];
        const steps = tables.find(t => t.field === 'steps');
        // 至少有一行是非空对象数组时，steps 应被识别为明细
        expect(steps).toBeDefined();
        expect(steps!.headers).toContain('action');
    });
});

describe('yaml-parser 删除最后一条步骤后保存（隐藏 bug 回归）', () => {
    it('前端删除最后一条步骤后保存，reload 不应恢复旧步骤', async () => {
        const raw =
            '- testcase_id: TC070\n' +
            '  name: 用例\n' +
            '  steps:\n' +
            '    - action: click\n' +
            '      target: btn1\n' +
            '    - action: input\n' +
            '      target: box1\n';
        const { file, parsed } = await loadFromRaw('del-last-step', raw);

        // 模拟前端展开态内联删除最后一条步骤后的内存状态：
        //   主表 steps 列变空字符串（_buildStepCombined([]) 的返回值），
        //   rowGroups[0] 与 rawRowGroups[0] 都被同步清空为 []（前端 _syncSubSteps 负责）。
        const stepsCol = parsed.tableData.headers.indexOf('steps');
        expect(stepsCol).toBeGreaterThanOrEqual(0);
        parsed.tableData.rows[0][stepsCol] = '';
        const dt = (parsed.tableData.detailTables || []).find(t => t.field === 'steps');
        expect(dt).toBeDefined();
        dt!.rowGroups[0] = [];
        if (dt!.rawRowGroups) dt!.rawRowGroups[0] = [];

        // 保存 + 重新解析，等价于"保存后点重置 / 重新打开文件"
        await parser.save(file, parsed.tableData, parsed.sourceData);
        const reloaded = await parser.parse(file);
        const reTables = reloaded.tableData.detailTables || [];
        const steps = reTables.find(t => t.field === 'steps');

        // 关键断言：步骤确实被清空，旧步骤（click/input）不能恢复
        expect(steps).toBeDefined();
        expect((steps!.rawRowGroups && steps!.rawRowGroups[0]) || []).toEqual([]);
        expect((steps!.rowGroups && steps!.rowGroups[0]) || []).toEqual([]);
        // 主表 steps 列应为空（[] 占位或空串）
        const reStepsCol = reloaded.tableData.headers.indexOf('steps');
        const cell = reloaded.tableData.rows[0][reStepsCol];
        expect(cell === '' || cell === '[]' || (Array.isArray(cell) && cell.length === 0)).toBe(true);
    });
});
