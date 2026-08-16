/**
 * pointCaseDeleter 单元测试
 *
 * 覆盖：
 *   1. 入参校验：pointId / pointPath 均空 → 抛错；仅传 pointName → 抛错
 *   2. yaml / json / csv 三种格式命中删除
 *   3. 只传 pointId → 走 type=3；只传 pointPath → 走 type=2；两者都传 → 走 type=1
 *   4. 命中 0 条 → 不写盘，返回 deletedCount:0
 *   5. detailTables 主行/明细同步剔除
 *   6. asyncLock 串行化：同 key 并发执行严格保序
 *   7. 埋点：done 事件字段完整、error 事件字段完整
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

import { __test_only__, deleteCasesByPoint } from '../utils/pointCaseDeleter';
import { withFileLock, _clearAllLocks } from '../utils/asyncLock';

const { deleteCasesFromCaseFile } = __test_only__;

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
        await expect(deleteCasesByPoint('', { pointId: 'X' })).rejects.toThrow(/pointFilePath/);
    });

    it('point 为空 → 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', undefined as any)).rejects.toThrow();
    });

    it('pointId 与 pointPath 均为空 → 抛错', async () => {
        await expect(deleteCasesByPoint('/tmp/x.md', {})).rejects.toThrow(/至少一个非空/);
    });

    it('仅传 pointName（pointId/pointPath 均空）→ 抛错', async () => {
        await expect(
            deleteCasesByPoint('/tmp/x.md', { pointName: '登录测试' }),
        ).rejects.toThrow(/至少一个非空/);
    });

    it('pointId 与 pointPath 空白字符串 → 视为空，抛错', async () => {
        await expect(
            deleteCasesByPoint('/tmp/x.md', { pointId: '   ', pointPath: '\t' }),
        ).rejects.toThrow(/至少一个非空/);
    });
});

// ============================================================================
// 2) yaml 格式：完整删除 + 剩余行落盘
// ============================================================================
describe('pointCaseDeleter · yaml 格式', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    const YAML = `- testcase_id: TC001
  name: 登录成功
  parent_id: LGN-001
  path: 账户中心/登录
- testcase_id: TC002
  name: 登录失败-密码错
  parent_id: LGN-001
  path: 账户中心/登录
- testcase_id: TC003
  name: 订单创建
  parent_id: ORD-001
  path: 交易/订单
`;

    it('只传 pointId（无 pointPath）→ type=3', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFile(fp, { pointId: 'LGN-001', pointPath: '', pointName: '' });

        expect(res.deletedCount).toBe(2);
        expect(res.typeCount.type1).toBe(0);
        expect(res.typeCount.type2).toBe(0);
        expect(res.typeCount.type3).toBe(2);
        expect(res.remainingRecords).toBe(1);
        // 落盘校验：文件里只剩 TC003
        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).toContain('TC003');
        expect(disk).not.toContain('TC001');
        expect(disk).not.toContain('TC002');
    });

    it('只传 pointPath → type=2', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFile(fp, { pointId: '', pointPath: '账户中心/登录', pointName: '' });

        expect(res.deletedCount).toBe(2);
        expect(res.typeCount.type1).toBe(0);
        expect(res.typeCount.type2).toBe(2);
        expect(res.typeCount.type3).toBe(0);
    });

    it('pointId + pointPath 同时命中 → type=1', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const res = await deleteCasesFromCaseFile(fp, {
            pointId: 'LGN-001', pointPath: '账户中心/登录', pointName: '',
        });

        expect(res.deletedCount).toBe(2);
        expect(res.typeCount.type1).toBe(2);
        expect(res.typeCount.type2).toBe(0);
        expect(res.typeCount.type3).toBe(0);
    });

    it('命中 0 条 → 不写盘、不报错、返回 deletedCount:0', async () => {
        const fp = writeYaml(dir, 'cases.yaml', YAML);
        const mtimeBefore = fs.statSync(fp).mtimeMs;
        // 等一小会儿避免 mtime 精度问题
        await new Promise(r => setTimeout(r, 20));

        const res = await deleteCasesFromCaseFile(fp, {
            pointId: 'NOT_EXIST', pointPath: 'nowhere', pointName: '',
        });

        expect(res.deletedCount).toBe(0);
        expect(res.deletedCases).toEqual([]);
        expect(res.remainingRecords).toBe(3);
        // 文件未写
        expect(fs.statSync(fp).mtimeMs).toBe(mtimeBefore);
    });

    it('parent_id 尾号 -N 剥离 fallback：LGN-001-1 也应被 LGN-001 命中', async () => {
        const yaml = `- testcase_id: TC101
  name: 子案例
  parent_id: LGN-001-1
  path: 账户中心/登录
`;
        const fp = writeYaml(dir, 'cases.yaml', yaml);
        const res = await deleteCasesFromCaseFile(fp, { pointId: 'LGN-001', pointPath: '', pointName: '' });
        expect(res.deletedCount).toBe(1);
        expect(res.typeCount.type3).toBe(1);
    });
});

// ============================================================================
// 3) json 格式
// ============================================================================
describe('pointCaseDeleter · json 格式', () => {
    let dir: string;
    beforeEach(() => { dir = mkTmpDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('数组结构 + 只传 pointId：命中并删除', async () => {
        const fp = path.join(dir, 'cases.json');
        fs.writeFileSync(fp, JSON.stringify([
            { testcase_id: 'JS001', name: '案例1', parent_id: 'ORD-001', path: '交易/订单' },
            { testcase_id: 'JS002', name: '案例2', parent_id: 'ORD-001', path: '交易/订单' },
            { testcase_id: 'JS003', name: '案例3', parent_id: 'USR-001', path: '账户/资料' },
        ], null, 2), 'utf-8');

        const res = await deleteCasesFromCaseFile(fp, {
            pointId: 'ORD-001', pointPath: '', pointName: '',
        });
        expect(res.deletedCount).toBe(2);
        expect(res.remainingRecords).toBe(1);

        // 落盘校验：JsonFileParser.save 在只剩 1 条时会退化为单对象（既有行为），
        // 因此这里对结构不做强假设，只验证内容语义。
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

    it('csv 基础删除', async () => {
        const fp = path.join(dir, 'cases.csv');
        const csv = 'testcase_id,name,parent_id,path\n'
                  + 'CSV001,登录成功,LGN-001,账户中心/登录\n'
                  + 'CSV002,登录失败,LGN-001,账户中心/登录\n'
                  + 'CSV003,订单创建,ORD-001,交易/订单\n';
        fs.writeFileSync(fp, csv, 'utf-8');

        const res = await deleteCasesFromCaseFile(fp, {
            pointId: 'LGN-001', pointPath: '账户中心/登录', pointName: '',
        });
        expect(res.deletedCount).toBe(2);
        expect(res.typeCount.type1).toBe(2);

        // 落盘校验
        const disk = fs.readFileSync(fp, 'utf-8');
        expect(disk).toContain('CSV003');
        expect(disk).not.toContain('CSV001');
        expect(disk).not.toContain('CSV002');
    });
});

// ============================================================================
// 5) 内部匹配语义（matchType_ 单元覆盖）
// ============================================================================
describe('pointCaseDeleter · 匹配语义', () => {
    const { matchType_ } = __test_only__;

    it('parent_id + path 同时命中 → type=1', () => {
        const rec = { parent_id: 'A-001', path: '模块/功能' };
        expect(matchType_(rec, 'A-001', '模块/功能')).toBe(1);
    });

    it('仅 path 命中 → type=2', () => {
        const rec = { parent_id: 'X-999', path: '模块/功能' };
        expect(matchType_(rec, 'A-001', '模块/功能')).toBe(2);
    });

    it('仅 parent_id 命中 → type=3', () => {
        const rec = { parent_id: 'A-001', path: '别的/路径' };
        expect(matchType_(rec, 'A-001', '模块/功能')).toBe(3);
    });

    it('parent_id 数组场景', () => {
        const rec = { parent_id: ['X-999', 'A-001'], path: '' };
        expect(matchType_(rec, 'A-001', '')).toBe(3);
    });

    it('parent_id 逗号分隔字符串场景', () => {
        const rec = { parent_id: 'X-999,A-001', path: '' };
        expect(matchType_(rec, 'A-001', '')).toBe(3);
    });

    it('parent_id 尾号 -N 剥离命中', () => {
        const rec = { parent_id: 'A-001-3', path: '' };
        expect(matchType_(rec, 'A-001', '')).toBe(3);
    });

    it('path 归一化：反斜杠 / 首尾斜杠均等价', () => {
        const rec = { parent_id: '', path: '/模块\\功能/' };
        expect(matchType_(rec, '', '模块/功能')).toBe(2);
    });

    it('都不命中 → null', () => {
        const rec = { parent_id: 'X-999', path: '别的' };
        expect(matchType_(rec, 'A-001', '模块')).toBeNull();
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
// 8) 埋点字段：done / error
// ============================================================================
describe('pointCaseDeleter · 埋点', () => {
    const { emitDoneTelemetry, emitErrorTelemetry } = __test_only__;

    beforeEach(() => { telemetryEvents.length = 0; });

    it('emitDoneTelemetry 上报完整字段（任务+要点+案例+性能）', () => {
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
            { pointId: 'LGN-001', pointPath: '账户中心/登录/二次校验', pointName: '二次校验' },
        );

        expect(telemetryEvents).toHaveLength(1);
        const ev = telemetryEvents[0];
        expect(ev.kind).toBe('event');
        expect(ev.name).toBe('pointCaseDeleter.done');
        expect(ev.props).toMatchObject({
            testTaskNo: 'TT001',
            subTestTaskId: 'ST001',
            artifactId: 'ART-9',
            pointId: 'LGN-001',
            pointName: '二次校验',
            pointPath: '账户中心/登录/二次校验',
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
            { pointId: 'X', pointPath: '', pointName: '' },
        );

        expect(telemetryEvents[0].props.artifactId).toBe('orders.json');
        expect(telemetryEvents[0].props.fileExt).toBe('.json');
        expect(telemetryEvents[0].props.deletedCount).toBe('0');
    });

    it('pointPath 上报原文（不归一化）', () => {
        emitDoneTelemetry(
            {
                filePath: '/abs/dir/cases.csv',
                deletedCases: [], deletedCount: 0,
                typeCount: { type1: 0, type2: 0, type3: 0 },
                totalRecords: 0, remainingRecords: 0, costMs: 1,
            },
            { testTaskNo: '', subTestTaskId: '', artifactId: '' },
            // 故意传入带反斜杠/首尾斜杠的"脏"路径
            { pointId: '', pointPath: '/模块\\功能/', pointName: '功能' },
        );
        // 原样上报，不归一化
        expect(telemetryEvents[0].props.pointPath).toBe('/模块\\功能/');
    });

    it('emitErrorTelemetry 上报错误与上下文字段', () => {
        emitErrorTelemetry(
            new Error('boom'),
            { testTaskNo: 'TT001', subTestTaskId: 'ST001', artifactId: '' },
            { pointId: 'LGN-001', pointPath: '账户/登录', pointName: '登录' },
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
        expect(ev.props.pointId).toBe('LGN-001');
        expect(ev.props.pointPath).toBe('账户/登录');
        expect(ev.props.pointName).toBe('登录');
        expect(ev.props.fileExt).toBe('.yaml');
        // stackHead 字段存在
        expect(typeof ev.props.stackHead).toBe('string');
    });

    it('emitErrorTelemetry 在 casePath 为空时→artifactId/fileExt 为空串', () => {
        emitErrorTelemetry(
            new Error('validate failed'),
            { testTaskNo: '', subTestTaskId: '', artifactId: '' },
            { pointId: '', pointPath: '', pointName: '' },
            '',
        );
        expect(telemetryEvents[0].props.artifactId).toBe('');
        expect(telemetryEvents[0].props.fileExt).toBe('');
    });
});

// ============================================================================
// 7) asyncLock 串行化
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

        // 并发发起 3 个任务：延迟递减；若锁生效则输出应严格保序 1→2→3
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

        // A 延迟 30ms，B 延迟 5ms → 若不同 key 并发，则 B 先完成
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
        // 空 key 不加锁 → 2 应该在 1 之前完成
        expect(order[0]).toBe(2);
    });
});
