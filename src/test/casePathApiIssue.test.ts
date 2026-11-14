/**
 * 案例路径合法性校验（非空 path 调接口判定，结果按行还原成失败项）
 * ----------------------------------------------------------------------------
 * 空值由 validators.PATH_EMPTY_VALIDATOR 逐行拦截；接口异常 / 未回显时无法判定，跳过不拦截。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTcoPath } from '../services/http';
import { findBindingByPath } from '../utils/taskInfoStore';
import { collectPathFailuresForFile, evaluateTcoPath } from '../utils/casePathValidator';

vi.mock('../services/http', () => ({ queryTcoPath: vi.fn() }));
vi.mock('../utils/taskInfoStore', () => ({ findBindingByPath: vi.fn() }));

const BOUND = { taskInfo: { testTaskNo: 'T1', subTestTaskId: 'S1' } } as any;
const item = (tcoPath: string, over: Record<string, any> = {}) => ({
    tcoPath, tcoType: 2, caseTotal: 0, pointTotal: 1, type: 1, data: [], ...over,
});
const rowsOf = (paths: string[]) => paths.map((p, i) => ({ testcase_id: `TS-${i + 1}`, path: p }));
const SAMPLE_TSID = '案例唯一标识，不可修改';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findBindingByPath).mockReturnValue(BOUND);
});

describe('接口判定规则', () => {
    it('三类非法路径给出对应文案，合法 / 未知类型放行', () => {
        expect(evaluateTcoPath(item('A/B/', { tcoType: 1 })))
            .toBe('路径为功能条目，无测试要点，请核对路径');
        expect(evaluateTcoPath(item('A/B/', { tcoType: 2, pointTotal: 2 })))
            .toBe('路径为非末级测试要点，请核对路径');
        expect(evaluateTcoPath(item('A/B/', { tcoType: 2, pointTotal: 0, type: 3 })))
            .toBe('路径上的测试要点不存在，请核对路径');
        expect(evaluateTcoPath(item('A/B/'))).toBeNull();
        expect(evaluateTcoPath(item('A/B/', { tcoType: 9 }))).toBeNull();
    });
});

describe('按行还原失败项', () => {
    it('命中非法规则 → tsId/rowIndex/field/reason 与其它行级校验同构', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const out = await collectPathFailuresForFile('/x/a.csv', rowsOf(['A/B/']) as any);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            tsId: 'TS-1',
            rowIndex: 1,
            field: 'testCasePath',
            columnName: '案例路径',
            severity: 'error',
            category: 'casePath',
            reason: '路径问题：路径为功能条目，无测试要点，请核对路径',
        });
    });

    it('同一非法路径被多行引用 → 每行一条，rowIndex 逐行定位', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 }), item('A/C/')]);
        const out = await collectPathFailuresForFile(
            '/x/a.csv', rowsOf(['A/B/', 'A/B/', 'A/C/']) as any,
        );
        expect(out.map(f => [f.tsId, f.rowIndex])).toEqual([['TS-1', 1], ['TS-2', 2]]);
    });

    it('合法路径 → 不产出任何项', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/')]);
        expect(await collectPathFailuresForFile('/x/a.csv', rowsOf(['A/B/']) as any)).toEqual([]);
    });

    it('中文规范表头「路径」同样能读到', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const out = await collectPathFailuresForFile(
            '/x/a.csv', [{ testcase_id: 'TS-1', 路径: 'A/B/' }] as any,
        );
        expect(out).toHaveLength(1);
        expect(out[0].tsId).toBe('TS-1');
    });

    it('空路径交给 PATH_EMPTY_VALIDATOR，本函数不查接口', async () => {
        const out = await collectPathFailuresForFile('/x/a.csv', rowsOf(['']) as any);
        expect(out).toEqual([]);
        expect(queryTcoPath).not.toHaveBeenCalled();
    });

    it('未绑定任务 → 跳过整项校验', async () => {
        vi.mocked(findBindingByPath).mockReturnValue(null as any);
        const out = await collectPathFailuresForFile('/x/a.csv', rowsOf(['A/B/']) as any);
        expect(out).toEqual([]);
        expect(queryTcoPath).not.toHaveBeenCalled();
    });

    it('样例行跳过且保留原始行号', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const rows = [
            { testcase_id: SAMPLE_TSID, path: 'A/B/' },
            { testcase_id: 'TS-2', path: 'A/B/' },
        ];
        const out = await collectPathFailuresForFile('/x/a.csv', rows as any);
        expect(out.map(f => [f.tsId, f.rowIndex])).toEqual([['TS-2', 2]]);
    });

    it('复用调用方的 resolveRowIndex 与 droppedIndex', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const dropped = new Set<number>();
        const out = await collectPathFailuresForFile(
            '/x/a.csv', rowsOf(['A/B/']) as any, i => i + 10, dropped,
        );
        expect(out[0].rowIndex).toBe(10);
        expect([...dropped]).toEqual([0]);
    });
});

describe('接口异常降级', () => {
    it('抛异常 → 静默跳过，不产出失败项、不剔除行', async () => {
        vi.mocked(queryTcoPath).mockRejectedValue(new Error('ECONNREFUSED'));
        const dropped = new Set<number>();
        const out = await collectPathFailuresForFile(
            '/x/a.csv', rowsOf(['A/B/']) as any, undefined, dropped,
        );
        expect(out).toEqual([]);
        expect(dropped.size).toBe(0);
    });

    it('未回显部分路径 → 只判定已回显的，不产出提示', async () => {
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const out = await collectPathFailuresForFile(
            '/x/a.csv', rowsOf(['A/B/', 'A/C/']) as any,
        );
        expect(out).toHaveLength(1);
        expect(out[0].tsId).toBe('TS-1');
    });
});

/**
 * 编辑期按需查询：路径单元格没改就不打接口，但已有结论仍要重新产出失败项，
 * 否则编辑期覆盖式写盘会把打开时判出的路径红格清掉。
 * 每个用例用独立 filePath，避免模块级结论缓存跨用例串扰。
 */
describe('编辑期按需查询（incremental）', () => {
    const inc = { incremental: true };

    it('改其它列但 path 未变 → 不查接口，仍产出原有非法项（高亮保持）', async () => {
        const fp = '/x/inc-1.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        expect(await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any)).toHaveLength(1);
        vi.mocked(queryTcoPath).mockClear();

        const rows = [{ testcase_id: 'TS-1', name: '改了名称', path: 'A/B/' }];
        const out = await collectPathFailuresForFile(fp, rows as any, undefined, undefined, inc);
        expect(queryTcoPath).not.toHaveBeenCalled();
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            tsId: 'TS-1', field: 'testCasePath', category: 'casePath', severity: 'error',
        });
    });

    it('路径单元格改成新值 → 只查这个新 path，按行重新判定', async () => {
        const fp = '/x/inc-2.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/'), item('A/C/')]);
        await collectPathFailuresForFile(fp, rowsOf(['A/B/', 'A/C/']) as any);
        vi.mocked(queryTcoPath).mockClear();
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/D/', { tcoType: 2, pointTotal: 2 })]);

        const out = await collectPathFailuresForFile(
            fp, rowsOf(['A/B/', 'A/D/']) as any, undefined, undefined, inc,
        );
        expect(queryTcoPath).toHaveBeenCalledTimes(1);
        expect(vi.mocked(queryTcoPath).mock.calls[0][1]).toEqual(['A/D/']);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            tsId: 'TS-2', rowIndex: 2,
            reason: '路径问题：路径为非末级测试要点，请核对路径',
        });
    });

    it('默认（打开 / 格式校验 / 推送前）全量查询，不受缓存影响', async () => {
        const fp = '/x/inc-3.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/')]);
        expect(await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any)).toEqual([]);
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const out = await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any);
        expect(queryTcoPath).toHaveBeenCalledTimes(2);
        expect(out).toHaveLength(1);
    });

    it('接口异常未能判定 → 不缓存，下一次增量仍会重试', async () => {
        const fp = '/x/inc-4.csv';
        vi.mocked(queryTcoPath)
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce([item('A/B/', { tcoType: 1 })]);
        expect(await collectPathFailuresForFile(
            fp, rowsOf(['A/B/']) as any, undefined, undefined, inc,
        )).toEqual([]);
        const out = await collectPathFailuresForFile(
            fp, rowsOf(['A/B/']) as any, undefined, undefined, inc,
        );
        expect(queryTcoPath).toHaveBeenCalledTimes(2);
        expect(out).toHaveLength(1);
    });

    it('未回显路径不缓存 → 下一次增量继续重试该路径', async () => {
        const fp = '/x/inc-5.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([]);
        await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any, undefined, undefined, inc);
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        const out = await collectPathFailuresForFile(
            fp, rowsOf(['A/B/']) as any, undefined, undefined, inc,
        );
        expect(queryTcoPath).toHaveBeenCalledTimes(2);
        expect(out).toHaveLength(1);
    });

    it('换绑测试任务 → 旧结论整体失效，增量也重新全量查询', async () => {
        const fp = '/x/inc-6.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/')]);
        await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any);
        vi.mocked(findBindingByPath).mockReturnValue(
            { taskInfo: { testTaskNo: 'T2', subTestTaskId: 'S1' } } as any,
        );
        vi.mocked(queryTcoPath).mockClear();
        await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any, undefined, undefined, inc);
        expect(queryTcoPath).toHaveBeenCalledTimes(1);
        expect(vi.mocked(queryTcoPath).mock.calls[0][1]).toEqual(['A/B/']);
    });

    it('路径被清空不残留旧结论；重新填写时重新判定', async () => {
        const fp = '/x/inc-7.csv';
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/', { tcoType: 1 })]);
        await collectPathFailuresForFile(fp, rowsOf(['A/B/']) as any);
        vi.mocked(queryTcoPath).mockClear();
        expect(await collectPathFailuresForFile(
            fp, rowsOf(['']) as any, undefined, undefined, inc,
        )).toEqual([]);
        expect(queryTcoPath).not.toHaveBeenCalled();
        vi.mocked(queryTcoPath).mockResolvedValue([item('A/B/')]);
        const out = await collectPathFailuresForFile(
            fp, rowsOf(['A/B/']) as any, undefined, undefined, inc,
        );
        expect(queryTcoPath).toHaveBeenCalledTimes(1);
        expect(out).toEqual([]);
    });
});
