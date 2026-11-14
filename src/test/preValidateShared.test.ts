/**
 * 前置校验共享模块的直接单测（P2）+ 前后端伪 tsId 契约（P3）
 * ----------------------------------------------------------------------------
 * · validationSource：合规目录判定、CSV / YAML / JSON 三种 sourceData 组装、parse 异常上抛；
 * · normalizeSeverity：severity 缺省兜底；
 * · 05g 前端伪 tsId 与后端唯一来源同值，防止跨语言字面量漂移。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createParser } from '../parsers';
import { resolveTargetType, loadValidationSource } from '../preValidate/validationSource';
import { normalizeSeverity } from '../utils/pushFailure/severity';
import { FILE_LEVEL_TSID } from '../utils/failureTsIds';

vi.mock('../parsers', () => ({
    detectFileType: vi.fn(() => 'csv'),
    createParser: vi.fn(),
}));

const parse = vi.fn();
beforeEach(() => {
    parse.mockReset();
    vi.mocked(createParser).mockReturnValue({ parse } as any);
});

describe('validationSource · resolveTargetType', () => {
    it('合规目录下的 yaml / yml / csv / json 返回对应类型', () => {
        expect(resolveTargetType('测试任务/T1/测试案例/a.yaml')).toBe('yaml');
        expect(resolveTargetType('测试任务/T1/测试案例/a.yml')).toBe('yaml');
        expect(resolveTargetType('测试任务/T1/测试案例/a.CSV')).toBe('csv');
        expect(resolveTargetType('测试任务/T1/测试案例/a.json')).toBe('json');
    });

    it('不合规目录 / 不支持扩展名 → null', () => {
        expect(resolveTargetType('其他目录/T1/测试案例/a.csv')).toBeNull();
        expect(resolveTargetType('测试任务/T1/测试案例/a.txt')).toBeNull();
    });
});

describe('validationSource · loadValidationSource', () => {
    it('CSV：按 headers + rows 组装 RowLike[]（sourceData 恒空）', async () => {
        parse.mockResolvedValue({
            tableData: { headers: ['testcase_id', '路径'], rows: [['TS-1', 'A/B/']] },
            sourceData: null,
        });
        const src = await loadValidationSource('/x/a.csv', 'csv');
        expect(src.parsedHeaders).toEqual(['testcase_id', '路径']);
        expect(src.sourceRows).toEqual([{ testcase_id: 'TS-1', 路径: 'A/B/' }]);
    });

    it('YAML / JSON：sourceData 为数组 / 单对象 / 空值', async () => {
        const rec = { testcase_id: 'TS-1', path: 'A/B/' };
        parse.mockResolvedValue({ sourceData: [rec] });
        expect((await loadValidationSource('/x/a.yaml', 'yaml')).sourceRows).toEqual([rec]);
        parse.mockResolvedValue({ sourceData: rec });
        expect((await loadValidationSource('/x/a.json', 'json')).sourceRows).toEqual([rec]);
        parse.mockResolvedValue({ sourceData: null });
        expect((await loadValidationSource('/x/a.yaml', 'yaml')).sourceRows).toEqual([]);
    });

    it('parsed 为空时返回空行而不抛错（可选链兜底）', async () => {
        parse.mockResolvedValue(null);
        const src = await loadValidationSource('/x/a.yaml', 'yaml');
        expect(src.parsed).toBeNull();
        expect(src.sourceRows).toEqual([]);
    });

    it('parse 抛错时原样上抛，由调用方决定降级', async () => {
        parse.mockRejectedValue(new Error('parse failed'));
        await expect(loadValidationSource('/x/a.csv', 'csv')).rejects.toThrow('parse failed');
    });
});

describe('normalizeSeverity', () => {
    it('warn 保持 warn，其余（error / 缺省 / 非法值）一律 error', () => {
        expect(normalizeSeverity('warn')).toBe('warn');
        expect(normalizeSeverity('error')).toBe('error');
        expect(normalizeSeverity(undefined)).toBe('error');
        expect(normalizeSeverity(null)).toBe('error');
        expect(normalizeSeverity('info')).toBe('error');
    });
});

describe('前后端伪 tsId 契约', () => {
    it('05g 前端常量与后端唯一来源同值', () => {
        const js = fs.readFileSync(
            path.join(process.cwd(), 'media/pages/table-editor/editor/05g-pre-validate-gate.js'),
            'utf8',
        );
        expect(js).toContain(`var PVG_FILE_LEVEL_TSID = '${FILE_LEVEL_TSID}';`);
    });
});
