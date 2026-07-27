/**
 * linkerDiagnosticHandler · 中文表头 CSV 兼容验证
 * ----------------------------------------------------------------------------
 * 场景：examples/case_example.csv 那类中文表头 CSV
 *   首行示例：testcase_id,名称,路径,案例描述,执行方式,案例类型,优先级,前置条件,步骤描述,预期结果
 * 期望：linkAndAggregateCases 能通过「路径 → path」映射兜底命中 type=2。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkAndAggregateCases } from '../handlers/linkerDiagnosticHandler';
import { clearLinkerCache, type PointItem } from '../utils/pointCaseLinker';

const TMP_DIR = path.join(os.tmpdir(), 'tc-linker-cn-csv-' + Date.now());
const CSV_FILE = path.join(TMP_DIR, 'cn_case.csv');

const POINT_PATH = '登录模块/账号密码登录';

const pointList: PointItem[] = [
    { pointId: 'LGN-001', pointName: '账号登录', pointPath: POINT_PATH },
    { pointId: 'LGN-002', pointName: '密码错误', pointPath: POINT_PATH },
];

// 中文表头 CSV：两条数据，路径与 pointList 一致 → 期望 type=2 命中
const csvContent = [
    'testcase_id,名称,路径,案例描述,执行方式,案例类型,优先级,前置条件,步骤描述,预期结果',
    'TC001,登录成功,登录模块/账号密码登录,验证正常登录,手工,功能点类,高,已注册,步骤1: 输入账号,登录成功',
    'TC002,密码错误提示,登录模块/账号密码登录,验证错误提示,手工,功能点类,中,已注册,步骤1: 输入错误密码,提示错误',
].join('\n');

describe('linkerDiagnosticHandler · 中文表头 CSV 兼容', () => {
    beforeAll(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(CSV_FILE, csvContent, 'utf-8');
        clearLinkerCache();
    });

    afterAll(() => {
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    it('中文表头 CSV：应通过路径兜底匹配（type=2），data 非空', async () => {
        const envelope = await linkAndAggregateCases(pointList, CSV_FILE);

        expect(envelope.errorMsg).toBe('');
        expect(envelope.total).toBe(2);
        expect(envelope.stats?.totalRecords).toBe(2);
        // 中文 CSV 无 parent_id → 只能命中 type=2
        expect(envelope.stats?.typeCount.type2).toBe(2);
        expect(envelope.stats?.typeCount.type1).toBe(0);
        expect(envelope.stats?.typeCount.type3).toBe(0);

        // 数据结构：pointKey → 案例数组，caseName 取「名称」列
        const keys = Object.keys(envelope.data);
        expect(keys.length).toBeGreaterThan(0);
        const firstCases = envelope.data[keys[0]];
        expect(firstCases.length).toBeGreaterThan(0);
        expect(firstCases[0].caseName).not.toBe('');
        expect(['TC001', 'TC002']).toContain(firstCases[0].testcase_id);
    });

    it('英文表头 CSV：保持默认字段名行为不变（回归验证）', async () => {
        const enCsv = path.join(TMP_DIR, 'en_case.csv');
        const enContent = [
            'testcase_id,name,path,parent_id',
            'TC101,英文登录,登录模块/账号密码登录,LGN-001',
        ].join('\n');
        fs.writeFileSync(enCsv, enContent, 'utf-8');

        const envelope = await linkAndAggregateCases(pointList, enCsv);
        expect(envelope.errorMsg).toBe('');
        expect(envelope.total).toBe(1);
        // 有 parent_id 且 path 相等 → type=1
        expect(envelope.stats?.typeCount.type1).toBe(1);
    });
});
