/**
 * pointCaseDeleter 单元测试
 *
 * 覆盖（对齐后端「删除测试案例」结果契约）：
 *   1. 入参校验：type 非法 / type=1|3 却缺 path → 抛错
 *   2. yaml / json / csv 三种格式命中删除（精确 / 前缀匹配）
 *   3. 仅 type ∈ {1,3} 触发删除；type=2/4 不删
 *   4. pcoTotal>0 或 pointTotal>1 → 前缀匹配；pcoTotal=0 且 pointTotal=1 → 精确匹配
 *   5. 命中 0 条 → 不写盘，返回 deletedCount:0
 *   6. detailTables 主行/明细同步剔除
 *   7. 埋点：done 事件字段完整（新契约字段）、error 事件字段完整
 *
 * 说明：为绕开 vscode.workspace 依赖，绝大多数用例走 __test_only__ 内部入口
 *      deleteCasesFromCaseFile（跳过 pointFilePath → casePath 的绑定查询）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- Mock TelemetryService：在引入 pointCaseDeleter 之前完成 mock ----
const telemetryEvents: Array<{ kind: 'event' | 'error'; name: string; props: any }> = [];
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'event', name, props })),
        sendTelemetryErrorEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'error', name, props })),
    },
}));

import { __test_only__, deleteCasesByPoint, deleteCasesByPoints } from '../utils/pointCaseDeleter';
import { withFileLock, _clearAllLocks } from '../utils/asyncLock';

// ---- Mock getCaseOfPoint：让公共方法可绕开真实绑定查询 ----
vi.mock('../utils/pointCaseBindingStore', () => ({
    getCaseOfPoint: vi.fn(),
    removePathInBindings: vi.fn().mockResolvedValue(true),
}));
import { getCaseOfPoint, removePathInBindings } from '../utils/pointCaseBindingStore';

const { deleteCasesFromCaseFile, deleteCasesFromCaseFileMulti, pathHit_ } = __test_only__;

// ============================================================================
// 临时目录辅助
// ============================================================================
function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pcDeleter-'));
}

function writeYaml(dir: string, name: string, content: string): string {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, content, 'utf-8');
    return fp;
}

// ============================================================================
// 1) 入参校验
// ============================================================================
describe('pointCaseDeleter · 入参校验', () => {
    it('pointFilePath 为空 → 抛错', async () => {
        await expect(deleteCasesByPoint('', { type: 1, path: 'x' })).rejects.toThrow(/pointFilePath/);
    });

    it('point 为空 → 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', undefined as any)).rejects.toThrow();
    });

    it('type 非法（非 1/2/3/4）→ 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', { type: 9, path: 'x' }))
            .rejects.toThrow(/type 必须为/);
    });

    it('type=1 却缺 path → 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', { type: 1 }))
            .rejects.toThrow(/必须携带非空 path/);
    });

    it('type=3 却缺 path → 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', { type: 3 }))
            .rejects.toThrow(/必须携带非空 path/);
    });

    it('type=2 / type=4 不触发删除，无需 path（不抛错）', async () => {
        const dir = mkTmpDir();
        const fp = writeYaml(dir, 'cases.yaml', `- testcase_id: TC001\n  name: a\n  path: 模块/功能\n`);
        // 直接走内部入口验证：type=2/4 不应删除任何行
        const res = await deleteCasesFromCaseFile(fp, { type: 2, path: '', data: '失败原因' });
        expect(res.deletedCount).toBe(0);
        const res4 = await deleteCasesFromCaseFile(fp, { type: 4, path: '', data: '含CMBT' });
        expect(res4.deletedCount).toBe(0);
    });
});

// ============================================================================
// 2) yaml 格式：精确 / 前缀匹配
// ============================================================================
describe('pointCaseDeleter · yaml 格式', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const YAML = `- testcase_id: TC001
  name: 登录成功
  path: 账户中心/登录/二次校验
- testcase_id: TC002
  name: 登录失败-密码错
  path: 账户中心/登录/二次校验
- testcase_id: TC003
  name: 登录验证码
  path: 账户中心/登录/三次校验
- testcase_id: TC004
  name: 订单创建
  path: 交易/订单/创建
- testcase_id: TC005
  name: 订单支付
  path: 交易/订单/支付
`;

    it('pcoTotal>0（功能条目路径）→ 前缀匹配删除其下所有案例', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        // pcoTotal>0 且 path=账户中心/登录 → 命中 TC001/TC002/TC003（前缀）
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '账户中心/登录', pcoTotal: 2, pointTotal: 3,
        });
        expect(res.deletedCount).toBe(3);
        expect(res.typeCount.type2).toBe(3); // 前缀匹配
        expect(res.remainingRecords).toBe(2);
        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).toContain('TC004');
        expect(disk).toContain('TC005');
        expect(disk).not.toContain('TC001');
    });

    it('pointTotal>1（测试点路径）→ 前缀匹配删除该测试点下所有案例', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        // pointTotal>1 且 path=交易/订单 → 命中 TC004/TC005
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '交易/订单', pcoTotal: 0, pointTotal: 2,
        });
        expect(res.deletedCount).toBe(2);
        expect(res.remainingRecords).toBe(3);
        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).not.toContain('TC004');
        expect(disk).not.toContain('TC005');
    });

    it('pcoTotal=0 且 pointTotal=1（单案例路径）→ 精确匹配只删一条', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '账户中心/登录/二次校验', pcoTotal: 0, pointTotal: 1,
        });
        expect(res.deletedCount).toBe(2); // 二次校验下两条案例
        expect(res.typeCount.type1).toBe(2); // 精确匹配
        expect(res.remainingRecords).toBe(3);
    });

    it('精确匹配不会被前缀误伤：path=交易/订单 精确时只删 path 完全相等的', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        // pcoTotal=0 & pointTotal=1 → 精确匹配，'交易/订单' 无完全相等项 → 0 条
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '交易/订单', pcoTotal: 0, pointTotal: 1,
        });
        expect(res.deletedCount).toBe(0);
        expect(res.remainingRecords).toBe(5);
    });

    it('type=3 同样触发删除（路径不存在语义下仍按 path 规则删本地）', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFile(fp, {
            type: 3, path: '账户中心/登录', pcoTotal: 2, pointTotal: 3,
        });
        expect(res.deletedCount).toBe(3);
    });

    it('命中 0 条 → 不写盘、不报错、返回 deletedCount:0', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const mtimeBefore = fs.statSync(fp).mtimeMs;
        await new Promise(r => setTimeout(r, 20));
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '不存在/路径', pcoTotal: 0, pointTotal: 1,
        });
        expect(res.deletedCount).toBe(0);
        expect(res.remainingRecords).toBe(5);
        expect(fs.statSync(fp).mtimeMs).toBe(mtimeBefore);
    });
});

// ============================================================================
// 3) json 格式
// ============================================================================
describe('pointCaseDeleter · json 格式', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('数组结构 + 前缀匹配：删除 path 包含目标的所有案例', async () => {
        const fp = path.join(dir, 'cases.json');
        fs.writeFileSync(fp, JSON.stringify([
            { testcase_id: 'JS001', name: '案例1', path: '交易/订单/创建' },
            { testcase_id: 'JS002', name: '案例2', path: '交易/订单/支付' },
            { testcase_id: 'JS003', name: '案例3', path: '账户/资料' },
        ], null, 2), 'utf-8');

        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '交易/订单', pcoTotal: 1, pointTotal: 2,
        });
        expect(res.deletedCount).toBe(2);
        expect(res.remainingRecords).toBe(1);

        const disk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        const remaining = Array.isArray(disk) ? disk : [disk];
        expect(remaining.length).toBe(1);
        expect(remaining[0].testcase_id).toBe('JS003');
    });
});

// ============================================================================
// 4) csv 格式
// ============================================================================
describe('pointCaseDeleter · csv 格式', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('csv 基础删除（精确匹配）', async () => {
        const fp = path.join(dir, 'cases.csv');
        const csv = 'testcase_id,name,path\n'
                  + 'CSV001,登录成功,账户中心/登录/二次校验\n'
                  + 'CSV002,登录失败,账户中心/登录/三次校验\n'
                  + 'CSV003,订单创建,交易/订单/创建\n';
        fs.writeFileSync(fp, csv, 'utf-8');

        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '账户中心/登录/二次校验', pcoTotal: 0, pointTotal: 1,
        });
        expect(res.deletedCount).toBe(1);
        expect(res.typeCount.type1).toBe(1);

        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).toContain('CSV002');
        expect(disk).toContain('CSV003');
        expect(disk).not.toContain('CSV001');
    });

    it('csv 前缀匹配（功能条目）', async () => {
        const fp = path.join(dir, 'cases.csv');
        const csv = 'testcase_id,name,path\n'
                  + 'CSV001,登录成功,账户中心/登录/二次校验\n'
                  + 'CSV002,登录失败,账户中心/登录/三次校验\n'
                  + 'CSV003,订单创建,交易/订单/创建\n';
        fs.writeFileSync(fp, csv, 'utf-8');

        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '账户中心/登录', pcoTotal: 1, pointTotal: 2,
        });
        expect(res.deletedCount).toBe(2);
        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).not.toContain('CSV001');
        expect(disk).not.toContain('CSV002');
        expect(disk).toContain('CSV003');
    });
});

// ============================================================================
// 5) 内部匹配语义（pathHit_ 单元覆盖）
// ============================================================================
describe('pointCaseDeleter · 匹配语义 (pathHit_)', () => {
    it('精确匹配：完全相等才命中', () => {
        expect(pathHit_('模块/功能', '模块/功能', 'exact')).toBe(true);
        expect(pathHit_('模块/功能/子', '模块/功能', 'exact')).toBe(false);
        expect(pathHit_('模块/功能X', '模块/功能', 'exact')).toBe(false);
    });

    it('前缀匹配：以目标+'/' 开头或相等都命中', () => {
        expect(pathHit_('模块/功能', '模块/功能', 'prefix')).toBe(true);
        expect(pathHit_('模块/功能/子', '模块/功能', 'prefix')).toBe(true);
        expect(pathHit_('模块/功能X', '模块/功能', 'prefix')).toBe(false); // 不是子路径
        expect(pathHit_('模块', '模块/功能', 'prefix')).toBe(false);
    });

    it('空目标 path 永不命中', () => {
        expect(pathHit_('模块/功能', '', 'exact')).toBe(false);
        expect(pathHit_('模块/功能', '', 'prefix')).toBe(false);
    });
});

// ============================================================================
// 6) applyRemoveByIndices：detailTables 主行/明细同步剔除
// ============================================================================
describe('pointCaseDeleter · applyRemoveByIndices', () => {
    const { applyRemoveByIndices } = __test_only__;

    it('rows / sourceData / detailTables 全部按主行索引同步剔除', () => {
        const tableData: any = {
            headers: ['testcase_id', 'name'],
            rows: [
                ['T1', 'n1'],
                ['T2', 'n2'],
                ['T3', 'n3'],
            ],
            detailTables: [{
                field: 'steps',
                fieldDisplay: '步骤',
                headers: ['id', 'op'],
                rowGroups: [[['1', 'a']], [['1', 'b']], [['1', 'c']]],
                rawRowGroups: [[[1, 'a']], [[1, 'b']], [[1, 'c']]],
                rawRowTypes: ['array', 'array', 'array'],
            }],
        };
        const sourceData: any[] = [
            { testcase_id: 'T1' }, { testcase_id: 'T2' }, { testcase_id: 'T3' },
        ];

        applyRemoveByIndices(tableData, sourceData, new Set([0, 2]));

        expect(tableData.rows).toEqual([['T2', 'n2']]);
        expect(sourceData).toEqual([{ testcase_id: 'T2' }]);
        expect(tableData.detailTables[0].rowGroups).toEqual([[['1', 'b']]]);
        expect(tableData.detailTables[0].rawRowGroups).toEqual([[[1, 'b']]]);
        expect(tableData.detailTables[0].rawRowTypes).toEqual(['array']);
    });
});

// ============================================================================
// 7) 多要点（points）删除场景
// ============================================================================
describe('pointCaseDeleter · 多要点删除', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); telemetryEvents.length = 0; });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const YAML = `- testcase_id: TC001
  name: 登录成功
  path: 账户中心/登录/二次校验
- testcase_id: TC002
  name: 登录失败-密码错
  path: 账户中心/登录/三次校验
- testcase_id: TC003
  name: 订单创建
  path: 交易/订单/创建
- testcase_id: TC004
  name: 订单支付
  path: 交易/订单/支付
- testcase_id: TC005
  name: 注册校验
  path: 账户中心/注册/校验
`;

    it('传入 2 个结果项（不同路径）→ 并集删除，去重后计数正确', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFileMulti(fp, [
            { type: 1, path: '账户中心/登录', pcoTotal: 1, pointTotal: 2 },
            { type: 1, path: '交易/订单', pcoTotal: 1, pointTotal: 2 },
        ]);

        // 账户中心/登录 → 2 条, 交易/订单 → 2 条，互不重叠
        expect(res.deletedCount).toBe(4);
        expect(res.deletedCases.map(c => c.testcaseId).sort()).toEqual(
            ['TC001', 'TC002', 'TC003', 'TC004'],
        );
        expect(res.remainingRecords).toBe(1); // 仅剩 TC005
        expect(res.perPoint[0].deletedCount).toBe(2);
        expect(res.perPoint[1].deletedCount).toBe(2);
    });

    it('两个结果项命中同一行 → 不重复删除（去重）', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFileMulti(fp, [
            { type: 1, path: '账户中心/登录', pcoTotal: 1, pointTotal: 2 },
            { type: 1, path: '账户中心/登录/二次校验', pcoTotal: 0, pointTotal: 1 },
        ]);
        // 并集：账户中心/登录 2 条（含二次校验），第二要点不再新增
        expect(res.deletedCount).toBe(2);
        expect(res.remainingRecords).toBe(3);
    });

    it('type=2/4 结果项参与但不触发删除', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFileMulti(fp, [
            { type: 2, path: '', data: '失败原因' },
            { type: 4, path: '', data: '含CMBT不允许删除' },
        ]);
        expect(res.deletedCount).toBe(0);
        expect(res.typeCount.type3).toBe(2); // 两类 no-op 计入 type3
        expect(res.remainingRecords).toBe(5);
    });

    it('公共方法 deleteCasesByPoints 触发埋点：逐要点 done ×N + 聚合 done.aggregate', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        vi.mocked(getCaseOfPoint).mockReturnValue(fp);

        await deleteCasesByPoints('/tmp/point.md', {
            points: [
                { type: 1, path: '账户中心/登录', pcoTotal: 1, pointTotal: 2 },
                { type: 1, path: '交易/订单', pcoTotal: 1, pointTotal: 2 },
            ],
        });

        // 共 3 条 done：2 条逐要点 + 1 条聚合
        const doneEvents = telemetryEvents.filter(e => e.kind === 'event');
        expect(doneEvents).toHaveLength(3);

        const agg = doneEvents.find(e => e.name === 'pointCaseDeleter.done.aggregate')!;
        expect(agg).toBeDefined();
        // 聚合：全局去重 deletedCount = 4（登录2 + 订单2）
        expect(agg.props.deletedCount).toBe('4');
        expect(agg.props.pointCount).toBe('2');
        expect(agg.props.pointPath).toBe('账户中心/登录|交易/订单');
        expect(agg.props.pcoTotal).toBe('1|1');
        expect(agg.props.pointTotal).toBe('2|2');
        expect(agg.props.remainingRecords).toBe('1');

        const perPointDone = doneEvents.filter(e => e.name === 'pointCaseDeleter.done');
        expect(perPointDone).toHaveLength(2);
        const sum = perPointDone.reduce((s, e) => s + Number(e.props.deletedCount), 0);
        expect(sum).toBe(4);
        // 逐要点 done 携带新契约字段
        expect(perPointDone[0].props.type).toBe('1');
        expect(perPointDone[0].props.pointPath).toBe('账户中心/登录');
    });
});

// ============================================================================
// 8) deleteCasesByPoints 公共方法 · 入参校验
// ============================================================================
describe('deleteCasesByPoints · 公共方法入参校验', () => {
    it('points 为空数组 → 抛错', async () => {
        await expect(
            deleteCasesByPoints('/tmp/x.md', { points: [] }),
        ).rejects.toThrow(/points 不能为空数组/);
    });

    it('单个结果项 type 非法 → 抛错', async () => {
        await expect(
            deleteCasesByPoints('/tmp/x.md', { points: [{ type: 7, path: 'x' }] }),
        ).rejects.toThrow(/type 必须为/);
    });

    it('type=1 缺 path → 抛错', async () => {
        await expect(
            deleteCasesByPoints('/tmp/x.md', { points: [{ type: 1 }] }),
        ).rejects.toThrow(/必须携带非空 path/);
    });
});

// ============================================================================
// 9) 埋点字段：done / error（新契约）
// ============================================================================
describe('pointCaseDeleter · 埋点', () => {
    const { emitDoneTelemetry, emitErrorTelemetry } = __test_only__;

    beforeEach(() => { telemetryEvents.length = 0; });

    it('emitDoneTelemetry 上报完整字段（含新契约维度）', () => {
        emitDoneTelemetry(
            {
                filePath: '/abs/dir/cases.yaml',
                deletedCases: [{ testcaseId: 'TC1', caseName: 'n1' }],
                deletedCount: 1,
                typeCount: { type1: 1, type2: 0, type3: 0 },
                totalRecords: 3,
                remainingRecords: 2,
                costMs: 42,
            },
            { testTaskNo: 'TT001', subTestTaskId: 'ST001', artifactId: 'ART-9' },
            { type: 1, data: '', path: '账户中心/登录/二次校验', pcoTotal: 0, pointTotal: 1, caseTotal: 1 },
        );

        expect(telemetryEvents).toHaveLength(1);
        const ev = telemetryEvents[0];
        expect(ev.kind).toBe('event');
        expect(ev.name).toBe('pointCaseDeleter.done');
        expect(ev.props).toMatchObject({
            testTaskNo: 'TT001',
            subTestTaskId: 'ST001',
            artifactId: 'ART-9',
            type: '1',
            pointPath: '账户中心/登录/二次校验',
            pcoTotal: '0',
            pointTotal: '1',
            caseTotal: '1',
            fileExt: '.yaml',
            deletedCount: '1',
            totalRecords: '3',
            remainingRecords: '2',
            type1: '1',
            type2: '0',
            type3: '0',
            costMs: '42',
        });
    });

    it('artifactId 缺省时→以案例文件 basename 兜底', () => {
        emitDoneTelemetry(
            {
                filePath: '/abs/dir/orders.json',
                deletedCases: [],
                deletedCount: 0,
                typeCount: { type1: 0, type2: 0, type3: 0 },
                totalRecords: 5,
                remainingRecords: 5,
                costMs: 3,
            },
            { testTaskNo: '', subTestTaskId: '', artifactId: '' },
            { type: 1, data: '', path: 'x', pcoTotal: 0, pointTotal: 1, caseTotal: 0 },
        );

        expect(telemetryEvents[0].props.artifactId).toBe('orders.json');
        expect(telemetryEvents[0].props.fileExt).toBe('.json');
        expect(telemetryEvents[0].props.deletedCount).toBe('0');
    });

    it('emitErrorTelemetry 上报错误与上下文字段', () => {
        emitErrorTelemetry(
            new Error('boom'),
            { testTaskNo: 'TT001', subTestTaskId: 'ST001', artifactId: '' },
            { type: 1, data: '', path: '账户/登录', pcoTotal: 0, pointTotal: 1, caseTotal: 0 } as any,
            '/abs/dir/cases.yaml',
        );

        expect(telemetryEvents).toHaveLength(1);
        const ev = telemetryEvents[0];
        expect(ev.kind).toBe('error');
        expect(ev.name).toBe('pointCaseDeleter.error');
        expect(ev.props.errorMessage).toBe('boom');
        expect(ev.props.testTaskNo).toBe('TT001');
        expect(ev.props.subTestTaskId).toBe('ST001');
        expect(ev.props.artifactId).toBe('cases.yaml');  // basename 兜底
        expect(ev.props.fileExt).toBe('.yaml');
        // stackHead 字段存在
        expect(typeof ev.props.stackHead).toBe('string');
    });
});

// ============================================================================
// 9.5) 案例文件清空后整体删除 + 绑定清理
// ============================================================================
describe('pointCaseDeleter · 案例文件清空', () => {
    beforeEach(() => {
        (getCaseOfPoint as any).mockReset();
        (removePathInBindings as any).mockReset();
        (removePathInBindings as any).mockResolvedValue(true);
    });

    it('全部案例被删除后：案例文件从磁盘删除 + 清理绑定关系 + caseFileDeleted=true', async () => {
        const dir = mkTmpDir();
        const fp = writeYaml(dir, 'cases.yaml', `- testcase_id: TC001\n  name: 唯一案例\n  path: 模块/功能/要点\n`);
        expect(fs.existsSync(fp)).toBe(true);

        // 精确匹配删除这一条案例 → 剩余行数 0
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '模块/功能/要点', pcoTotal: 0, pointTotal: 1, caseTotal: 1,
        });

        // 1) 结果标记案例文件已删除
        expect(res.caseFileDeleted).toBe(true);
        expect(res.deletedCount).toBe(1);
        expect(res.remainingRecords).toBe(0);
        // 2) 文件确实从磁盘消失
        expect(fs.existsSync(fp)).toBe(false);
        // 3) 绑定清理被调用
        expect(removePathInBindings).toHaveBeenCalledTimes(1);
        expect(removePathInBindings).toHaveBeenCalledWith(fp);
    });

    it('部分删除（仍有剩余案例）→ 不删除文件、不清理绑定、caseFileDeleted=false', async () => {
        const dir = mkTmpDir();
        const fp = writeYaml(dir, 'cases.yaml',
            `- testcase_id: TC001\n  name: 案例A\n  path: 模块/功能/要点A\n` +
            `- testcase_id: TC002\n  name: 案例B\n  path: 模块/功能/要点B\n`);
        expect(fs.existsSync(fp)).toBe(true);

        // 前缀匹配删除 要点A 下案例（仅 TC001）
        const res = await deleteCasesFromCaseFile(fp, {
            type: 1, path: '模块/功能/要点A', pcoTotal: 0, pointTotal: 1, caseTotal: 1,
        });

        expect(res.caseFileDeleted).toBe(false);
        expect(res.deletedCount).toBe(1);
        expect(res.remainingRecords).toBe(1);
        expect(fs.existsSync(fp)).toBe(true);
        expect(removePathInBindings).not.toHaveBeenCalled();
    });

    it('多要点并集删除后恰好清空 → 同样整文件删除并清理绑定', async () => {
        const dir = mkTmpDir();
        const fp = writeYaml(dir, 'cases.yaml',
            `- testcase_id: TC001\n  name: 案例A\n  path: 模块/功能/要点A\n` +
            `- testcase_id: TC002\n  name: 案例B\n  path: 模块/功能/要点B\n`);
        expect(fs.existsSync(fp)).toBe(true);

        const res = await deleteCasesFromCaseFileMulti(fp, [
            { type: 1, path: '模块/功能/要点A', pcoTotal: 0, pointTotal: 1, caseTotal: 1 },
            { type: 1, path: '模块/功能/要点B', pcoTotal: 0, pointTotal: 1, caseTotal: 1 },
        ]);

        expect(res.caseFileDeleted).toBe(true);
        expect(res.deletedCount).toBe(2);
        expect(res.remainingRecords).toBe(0);
        expect(fs.existsSync(fp)).toBe(false);
        expect(removePathInBindings).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// 10) asyncLock 串行化
// ============================================================================
describe('asyncLock · withFileLock', () => {
    beforeEach(() => { _clearAllLocks(); });

    it('同 key 并发执行严格串行、保序', async () => {
        const order: number[] = [];
        const task = (id: number, delay: number) =>
            withFileLock('/tmp/lock.txt', async () => {
                await new Promise(r => setTimeout(r, delay));
                order.push(id);
            });

        await Promise.all([task(1, 30), task(2, 10), task(3, 5)]);
        expect(order).toEqual([1, 2, 3]);
    });

    it('不同 key 完全并发', async () => {
        const order: string[] = [];
        const task = (key: string, id: string, delay: number) =>
            withFileLock(key, async () => {
                await new Promise(r => setTimeout(r, delay));
                order.push(id);
            });

        await Promise.all([task('A', 'A1', 30), task('B', 'B1', 5)]);
        expect(order[0]).toBe('B1');
    });

    it('临界区抛错不污染队列，后续任务继续执行', async () => {
        const order: string[] = [];
        const failing = withFileLock('/tmp/err.txt', async () => {
            order.push('fail-start');
            throw new Error('boom');
        }).catch(() => order.push('fail-caught'));
        const ok = withFileLock('/tmp/err.txt', async () => {
            order.push('ok');
        });
        await Promise.all([failing, ok]);
        expect(order).toContain('ok');
        expect(order).toContain('fail-caught');
    });

    it('空 key 直接放行，不进入排队', async () => {
        const order: number[] = [];
        await Promise.all([
            withFileLock('', async () => { await new Promise(r => setTimeout(r, 20)); order.push(1); }),
            withFileLock('', async () => { order.push(2); }),
        ]);
        expect(order[0]).toBe(2);
    });
});
