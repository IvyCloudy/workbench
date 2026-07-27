/**
 * ============================================================================
 *  test/pointCaseLinker.test.ts
 *  单测：pointCaseLinker 关联匹配公共方法
 * ----------------------------------------------------------------------------
 *  覆盖：
 *    1) 基本单文件匹配（type=1/2/3）
 *    2) parent_id 支持数组 / 逗号分号分隔
 *    3) parent_id 尾号 -N 剥离
 *    4) path 归一化（分隔符/首尾斜杠/连续空白）
 *    5) 一对多（同点多案例）+ 同 point 内 testcase_id 去重
 *    6) 多对多（一个 case 命中同一 point 的多个来源 → 合并为 type=1）
 *    7) Q14 前提：同一 case 命中多个不同 point → 保留最强 type + multiHitCases
 *    8) 空入参 / filePath 为空 / pointList 空
 *    9) 批量入口 linkPointsToCasesBatch
 *   10) 重复 pointId 触发 duplicatePointIds
 * ============================================================================
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock parsers.parseFileToRows —— 直接返回测试数据
const mockRecordsByPath: Record<string, any[]> = {};
vi.mock('../parsers', () => ({
    parseFileToRows: vi.fn(async (fp: string) => mockRecordsByPath[fp] || []),
}));

// mock vscode 供 logger / telemetry 依赖
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: () => false }),
    },
    env: { isTelemetryEnabled: false, machineId: 'test', language: 'zh-cn' },
    version: '1.85.0',
}));

// mock telemetry 避免真实网络
const telemetryEvents: Array<{ name: string; props?: any }> = [];
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn((name: string, props?: any) => telemetryEvents.push({ name, props })),
        sendTelemetryErrorEvent: vi.fn((name: string, props?: any) => telemetryEvents.push({ name, props })),
    },
}));

// mock fs.statSync 用来让缓存能命中（返回稳定 mtimeMs / size）
vi.mock('fs', async (importOriginal) => {
    const orig = await importOriginal<typeof import('fs')>();
    return {
        ...orig,
        statSync: vi.fn((fp: string) => ({
            mtimeMs: 100,
            size: 100,
            isFile: () => true,
        })),
    };
});

async function importLinker() {
    return await import('../utils/pointCaseLinker');
}

const POINTS = [
    { pointId: 'LGN-001', pointName: '账号密码登录', pointPath: '账户中心/登录模块' },
    { pointId: 'LGN-002', pointName: '密码错误拦截', pointPath: '账户中心/登录模块' },
    { pointId: 'ORD-001', pointName: '创建订单', pointPath: '交易中心/订单模块' },
    { pointId: 'ORD-005', pointName: '订单查询', pointPath: '交易中心/订单模块' },
];

describe('pointCaseLinker', () => {
    beforeEach(async () => {
        // 清缓存
        const linker = await importLinker();
        linker.clearLinkerCache();
        // 清 mock 数据
        for (const k of Object.keys(mockRecordsByPath)) delete mockRecordsByPath[k];
        telemetryEvents.length = 0;
    });

    // ==========================================
    // 1. 基本 type 分档
    // ==========================================
    it('基本匹配：type=1（parent_id + path 双命中）', async () => {
        const fp = '/mock/case1.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-100',
                parent_id: 'LGN-001',
                path: '账户中心/登录模块',
                name: '账号密码登录_成功',
                preconditions: ['用户已注册'],
                expected: '登录成功',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(r.byPoint['LGN-001_账号密码登录'][0].type).toBe(1);
        expect(r.byCase['C-100']).toEqual({ pointKey: 'LGN-001_账号密码登录', type: 1 });
        expect(r.stats.matchedByType).toEqual({ type1: 1, type2: 0, type3: 0 });
        expect(r.stats.orphanRecords).toBe(0);
    });

    it('基本匹配：type=3（仅 parent_id 命中，path 不等）', async () => {
        const fp = '/mock/case2.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-101',
                parent_id: 'LGN-001',
                path: '错误路径/xxx',
                name: 'x',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['LGN-001_账号密码登录'][0].type).toBe(3);
        expect(r.stats.matchedByType.type3).toBe(1);
    });

    it('基本匹配：type=3（仅 parent_id 命中，path 缺失）', async () => {
        const fp = '/mock/case2b.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'C-102', parent_id: 'LGN-001', name: 'x' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['LGN-001_账号密码登录'][0].type).toBe(3);
    });

    it('基本匹配：type=2（仅 path 命中）', async () => {
        const fp = '/mock/case3.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-103',
                parent_id: 'UNKNOWN-999',
                path: '账户中心/登录模块',
                name: 'path only',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        // path 命中 → 有两个 point 都在该 path 下（LGN-001 / LGN-002）
        // 取第一个（Map 迭代顺序即插入顺序）
        const totalType2 = r.stats.matchedByType.type2;
        expect(totalType2).toBe(1);
        expect(r.stats.matchedByType.type1).toBe(0);
        expect(r.stats.matchedByType.type3).toBe(0);
    });

    it('孤儿记录：parent_id 和 path 都匹配不上', async () => {
        const fp = '/mock/orphan.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-999',
                parent_id: 'UNKNOWN-X',
                path: '未知模块/未知',
                name: 'orphan',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.stats.orphanRecords).toBe(1);
        expect(r.stats.matchedRecords).toBe(0);
        expect(Object.keys(r.byPoint)).toHaveLength(0);
    });

    // ==========================================
    // 2. parent_id 各种形态
    // ==========================================
    it('parent_id 数组：多归属拆分', async () => {
        const fp = '/mock/arr.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-A1',
                parent_id: ['LGN-001', 'ORD-001'],  // 命中不同 point → Q14 保留最强 type 的第一个
                path: '账户中心/登录模块',   // LGN-001 是 type=1，ORD-001 是 type=3（path 不匹配）
                name: 'multi',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        // 只归到 LGN-001（type=1 > type=3）
        expect(r.byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(r.byPoint['LGN-001_账号密码登录'][0].type).toBe(1);
        expect(r.byPoint['ORD-001_创建订单']).toBeUndefined();
        expect(r.stats.multiHitCases).toContain('C-A1');
    });

    it('parent_id 分隔字符串：LGN-001,ORD-001', async () => {
        const fp = '/mock/comma.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-CS1',
                parent_id: 'LGN-001;ORD-001',
                path: '账户中心/登录模块',
                name: 'comma',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byCase['C-CS1'].pointKey).toBe('LGN-001_账号密码登录');
    });

    it('parent_id 尾号剥离：LGN-001-1 → LGN-001', async () => {
        const fp = '/mock/tail.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-T1',
                parent_id: 'LGN-001-1',
                path: '账户中心/登录模块',
                name: 'tail-1',
            },
            {
                testcase_id: 'C-T2',
                parent_id: 'LGN-002-12',
                path: '账户中心/登录模块',
                name: 'tail-12',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(r.byPoint['LGN-002_密码错误拦截']).toHaveLength(1);
        expect(r.stats.strippedParentIds).toBe(2);
    });

    it('parent_id 尾号剥离关闭时：LGN-001-1 无法命中', async () => {
        const fp = '/mock/tail-off.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'C-TX', parent_id: 'LGN-001-1', path: '账户中心/登录模块', name: 'x' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS, { stripParentIdTailIndex: false });
        // parent_id 无命中 → path 命中 → type=2
        expect(r.stats.matchedByType.type2).toBe(1);
        expect(r.stats.strippedParentIds).toBe(0);
    });

    // ==========================================
    // 3. path 归一化
    // ==========================================
    it('path 归一化：分隔符/首尾斜杠/连续空白 均视为相等', async () => {
        const fp = '/mock/npath.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'C-N1', parent_id: 'LGN-001', path: '账户中心 / 登录模块 ', name: 'x' },
            { testcase_id: 'C-N2', parent_id: 'LGN-001', path: '账户中心\\登录模块', name: 'x' },
            { testcase_id: 'C-N3', parent_id: 'LGN-001', path: '/账户中心/登录模块/', name: 'x' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        // 三条应该都是 type=1
        expect(r.stats.matchedByType.type1).toBe(3);
    });

    // ==========================================
    // 4. 一对多 + 同 point 内 testcase_id 去重
    // ==========================================
    it('一对多：同一 point 下多个 case', async () => {
        const fp = '/mock/o2m.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'C-1', parent_id: 'ORD-005', path: '交易中心/订单模块', name: 'query-by-no' },
            { testcase_id: 'C-2', parent_id: 'ORD-005', path: '交易中心/订单模块', name: 'query-by-time' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['ORD-005_订单查询']).toHaveLength(2);
    });

    it('同 point 内 testcase_id 相同 → 去重', async () => {
        const fp = '/mock/dup.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'DUP', parent_id: 'LGN-001', path: '账户中心/登录模块', name: 'a' },
            { testcase_id: 'DUP', parent_id: 'LGN-001', path: '账户中心/登录模块', name: 'b' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        expect(r.byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(r.stats.matchedRecords).toBe(1);
    });

    // ==========================================
    // 5. Q14 前提被破坏：跨 point 多命中
    // ==========================================
    it('multiHit：case 命中多个不同 point 只留最强', async () => {
        const fp = '/mock/multi.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-MULTI',
                parent_id: ['ORD-001'],   // ORD-001 是 type=3（因 path 不匹配 交易中心/订单模块）
                path: '账户中心/登录模块',  // path 命中 LGN-001/LGN-002 → type=2
                name: 'multi-hit',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        // ORD-001 因 path 不同 → 是 type=3；path 命中 LGN-001/LGN-002 → type=2
        // Q14 取最强 type=2（path 命中）→ 只归到 LGN-001
        expect(r.byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(r.byPoint['LGN-001_账号密码登录'][0].type).toBe(2);
        expect(r.stats.multiHitCases).toContain('C-MULTI');
    });

    // ==========================================
    // 6. 空入参
    // ==========================================
    it('空 pointList → 返回空结果', async () => {
        const fp = '/mock/empty.yaml';
        mockRecordsByPath[fp] = [{ testcase_id: 'X', parent_id: 'LGN-001' }];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, []);
        expect(r.stats.totalRecords).toBe(0);
        expect(Object.keys(r.byPoint)).toHaveLength(0);
    });

    it('filePath 为空 → 抛错', async () => {
        const { linkPointsToCases } = await importLinker();
        await expect(linkPointsToCases('', POINTS)).rejects.toThrow(/filePath/);
    });

    // ==========================================
    // 7. caseDetail 拼接
    // ==========================================
    it('caseDetail：【前置条件】+【预期结果】拼接（数组用换行连接）', async () => {
        const fp = '/mock/detail.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-D',
                parent_id: 'LGN-001',
                path: '账户中心/登录模块',
                name: 'x',
                preconditions: ['A', 'B'],
                expected: 'C',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        const caseItem = r.byPoint['LGN-001_账号密码登录'][0];
        expect(caseItem.caseDetail).toContain('【前置条件】');
        expect(caseItem.caseDetail).toContain('A');
        expect(caseItem.caseDetail).toContain('B');
        expect(caseItem.caseDetail).toContain('【预期结果】');
        expect(caseItem.caseDetail).toContain('C');
    });

    it('caseDetail：含 steps 时拼接【步骤描述】+按步骤【预期结果】，每行 <p> 包裹', async () => {
        const fp = '/mock/detail-steps.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-STEP',
                parent_id: 'LGN-001',
                path: '账户中心/登录模块',
                name: 'x',
                preconditions: ['环境就绪'],
                steps: [
                    {
                        id: 1,
                        operation: '执行主流程',
                        data: ['p1'],
                        ui_expected: ['UI成功态'],
                        api_expected: ['接口200'],
                        db_expected: ['状态done'],
                    },
                    {
                        id: 2,
                        operation: '验证结果',
                        ui_expected: ['结果正确'],
                        api_expected: [],
                        db_expected: [],
                    },
                ],
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        const d = r.byPoint['LGN-001_账号密码登录'][0].caseDetail;
        // 分段标题
        expect(d).toContain('<p>【前置条件】</p>');
        expect(d).toContain('<p>环境就绪</p>');
        expect(d).toContain('<p>【步骤描述】</p>');
        expect(d).toContain('<p>步骤1:执行主流程</p>');
        expect(d).toContain('<p>步骤2:验证结果</p>');
        expect(d).toContain('<p>【预期结果】</p>');
        expect(d).toContain('<p>步骤1:</p>');
        // 【xx检查】与内容分行
        expect(d).toContain('<p>【UI检查】</p>');
        expect(d).toContain('<p>UI成功态</p>');
        expect(d).toContain('<p>【接口调用】</p>');
        expect(d).toContain('<p>接口200</p>');
        expect(d).toContain('<p>【数据检查】</p>');
        expect(d).toContain('<p>状态done</p>');
        expect(d).toContain('<p>步骤2:</p>');
        expect(d).toContain('<p>【UI检查】</p>');
        expect(d).toContain('<p>结果正确</p>');
        // 顺序：步骤描述 在 预期结果 之前
        expect(d.indexOf('【步骤描述】')).toBeLessThan(d.indexOf('【预期结果】'));
    });

    it('caseDetail：前置条件为空时仍输出标题并补一个空行 <p></p>', async () => {
        const fp = '/mock/detail-empty-pre.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-EMPTY-PRE',
                parent_id: 'LGN-001',
                path: '账户中心/登录模块',
                name: 'x',
                steps: [
                    {
                        id: 1,
                        operation: '执行主流程',
                        ui_expected: ['UI成功态'],
                    },
                ],
            },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, POINTS);
        const d = r.byPoint['LGN-001_账号密码登录'][0].caseDetail;
        // 标题存在
        expect(d).toContain('<p>【前置条件】</p>');
        // 标题后紧跟一个空行 <p></p>，再是【步骤描述】
        const idxTitle = d.indexOf('<p>【前置条件】</p>');
        const idxStep = d.indexOf('<p>【步骤描述】</p>');
        const between = d.slice(idxTitle, idxStep);
        expect(between).toContain('<p></p>');
    });

    it('caseDetail：中文 CSV 列名（前置条件/预期结果）正确读取，多行文本每行 <p>', async () => {
        const fp = '/mock/cn-csv.yaml';
        mockRecordsByPath[fp] = [
            {
                testcase_id: 'C-CN',
                parent_id: 'LGN-001',
                path: '账户中心/登录模块',
                name: 'x',
                前置条件: ['前置A'],
                // 已转换的成品文本（含【UI检查】等标签），无 steps / 无 ui_expected
                预期结果: '步骤1:\n【UI检查】\nUI检查点\n步骤3:\n【接口调用】\n接口检查点',
            },
        ];
        const { linkPointsToCases } = await importLinker();
        // 模拟 detectCsvHeaderOptions 映射后的中文字段名
        const r = await linkPointsToCases(fp, POINTS, {
            preconditionFields: ['前置条件'],
            expectedFields: ['预期结果'],
        });
        const d = r.byPoint['LGN-001_账号密码登录'][0].caseDetail;
        expect(d).toContain('<p>【前置条件】</p>');
        expect(d).toContain('<p>前置A</p>');
        expect(d).toContain('<p>【预期结果】</p>');
        // 多行成品文本按行 <p> 包裹，不再按 ui_expected 等拆分
        expect(d).toContain('<p>步骤1:</p>');
        expect(d).toContain('<p>【UI检查】</p>');
        expect(d).toContain('<p>UI检查点</p>');
        expect(d).toContain('<p>步骤3:</p>');
        expect(d).toContain('<p>【接口调用】</p>');
        expect(d).toContain('<p>接口检查点</p>');
        // 不应出现把字段名当字符遍历的脏数据
        expect(d).not.toContain('<p>预</p>');
        expect(d).not.toContain('<p>期</p>');
    });

    // ==========================================
    // 8. 批量入口
    // ==========================================
    it('linkPointsToCasesBatch：多文件并发匹配', async () => {
        const fpA = '/mock/batch-a.yaml';
        const fpB = '/mock/batch-b.json';
        mockRecordsByPath[fpA] = [
            { testcase_id: 'A1', parent_id: 'LGN-001', path: '账户中心/登录模块', name: 'a1' },
        ];
        mockRecordsByPath[fpB] = [
            { testcase_id: 'B1', parent_id: 'ORD-001', path: '交易中心/订单模块', name: 'b1' },
            { testcase_id: 'B2', parent_id: 'ORD-005', path: '交易中心/订单模块', name: 'b2' },
        ];
        const { linkPointsToCasesBatch } = await importLinker();
        const map = await linkPointsToCasesBatch([fpA, fpB], POINTS, { concurrency: 2 });
        expect(map[fpA].byPoint['LGN-001_账号密码登录']).toHaveLength(1);
        expect(map[fpB].byPoint['ORD-001_创建订单']).toHaveLength(1);
        expect(map[fpB].byPoint['ORD-005_订单查询']).toHaveLength(1);
    });

    // ==========================================
    // 9. 重复 pointId
    // ==========================================
    it('pointList 内重复 pointId → 记入 duplicatePointIds', async () => {
        const dupPoints = [
            ...POINTS,
            { pointId: 'LGN-001', pointName: '重复项', pointPath: '别的模块' },
        ];
        const fp = '/mock/dup-pt.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'X', parent_id: 'LGN-001', path: '账户中心/登录模块', name: 'x' },
        ];
        const { linkPointsToCases } = await importLinker();
        const r = await linkPointsToCases(fp, dupPoints);
        expect(r.stats.duplicatePointIds).toContain('LGN-001');
    });

    // ==========================================
    // 10. 缓存命中
    // ==========================================
    it('缓存命中：连续两次调用只解析一次', async () => {
        const fp = '/mock/cache.yaml';
        mockRecordsByPath[fp] = [
            { testcase_id: 'X', parent_id: 'LGN-001', path: '账户中心/登录模块', name: 'x' },
        ];
        const parsers = await import('../parsers');
        const spy = parsers.parseFileToRows as unknown as ReturnType<typeof vi.fn>;
        spy.mockClear();
        const { linkPointsToCases } = await importLinker();
        await linkPointsToCases(fp, POINTS);
        await linkPointsToCases(fp, POINTS);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});