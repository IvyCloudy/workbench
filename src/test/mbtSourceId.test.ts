/**
 * MBT 案例（CMBT_AITEST 平台）专项回归
 * ----------------------------------------------------------------------------
 * 契约：
 *   1) testcase_id 严格大写 MBT + 32 位小写字母数字 → 校验放行；其余大小写/字符组合不放行；
 *   2) 推送 sourceId 去掉 MBT 前缀，本地 testcase_id 保持原值（YAML / CSV 两分支）；
 *   3) 接口回显去前缀 sourceId → 按 bodyIndex 反查归一化回本地 MBT tsId，
 *      保证 testCaseNo 回写 / 失败盘 / 行号定位链路 tsId 一致；
 *   4) 删除与删除确认请求（sourceIds）同样去 MBT 前缀，本地追踪仍用完整 ID。
 */
import { describe, it, expect } from 'vitest';
import { isMbtTestcaseId, isValidTestcaseId, normalizeSourceId } from '../utils/testcaseId';
import { isTestcaseIdValid } from '../preValidate/validators';
import { mapRowToCaseItem } from '../utils/pushDataMapper';
import { parsePushResponse } from '../utils/pushResponse';
import { TS_ID_COLUMN } from '../services/utils';

const MBT_ID = 'MBT58a41215a4be69bb3ca921687afa02f6';
const RAW = MBT_ID.slice(3);

describe('MBT testcase_id 格式校验（严格大写 MBT + 32 位小写字母数字）', () => {
    it('合法 MBT ID 在两个校验入口均放行', () => {
        expect(isMbtTestcaseId(MBT_ID)).toBe(true);
        expect(isValidTestcaseId(MBT_ID)).toBe(true);
        expect(isTestcaseIdValid(MBT_ID)).toBe(true);
        expect(isMbtTestcaseId('  ' + MBT_ID + '  ')).toBe(true);
    });

    it('前缀大小写、后缀大小写、长度、非法字符均不通过', () => {
        expect(isMbtTestcaseId(MBT_ID.toLowerCase())).toBe(false);   // mbt 小写前缀
        expect(isMbtTestcaseId('MBT' + RAW.toUpperCase())).toBe(false); // 后缀大写
        expect(isMbtTestcaseId('MBT' + RAW.slice(0, 31))).toBe(false);  // 31 位
        expect(isMbtTestcaseId('MBT' + RAW + '0')).toBe(false);         // 33 位
        expect(isMbtTestcaseId('MBT' + 'G'.repeat(32))).toBe(false);    // 大写字符
        expect(isMbtTestcaseId('MBT' + '-'.repeat(32))).toBe(false);    // 非法字符
    });
});

describe('MBT 推送 sourceId 去前缀（本地值不变）', () => {
    const minimal = {
        description: '推送测试',
        test_type: '手工',
        type: '功能点类',
        path: '/账户中心/登录',
        steps: [{ operation: '执行', ui_expected: ['ok'] }],
    };

    it('YAML 分支：sourceId 去 MBT，行对象 testcase_id 保持原值', () => {
        const row = { ...minimal, testcase_id: MBT_ID, name: 'MBT案例' };
        const item = mapRowToCaseItem(row as any);
        expect(item.sourceId).toBe(RAW);
        expect(row.testcase_id).toBe(MBT_ID);
    });

    it('中文 CSV 分支：sourceId 去 MBT', () => {
        const row = {
            testcase_id: MBT_ID,
            名称: 'MBT案例',
            案例描述: '推送测试',
            路径: '/账户中心/登录',
            执行方式: '手工',
            案例类型: '功能点类',
            步骤描述: '步骤1:\n执行',
            预期结果: '步骤1:\nok',
        };
        expect(mapRowToCaseItem(row as any).sourceId).toBe(RAW);
    });

    it('非 MBT 案例 sourceId 原样（幂等）', () => {
        const row = { ...minimal, testcase_id: 'TCa1b2c3d4e5f60718293a4b5c6d7e8f90', name: '普通案例' };
        expect(mapRowToCaseItem(row as any).sourceId).toBe(row.testcase_id);
        expect(normalizeSourceId(row.testcase_id)).toBe(row.testcase_id);
    });
});

describe('删除 / 删除确认请求的 sourceIds 去前缀', () => {
    it('ID 列表归一化：MBT 行去前缀，其它行原样（覆盖删除与删除确认的调用入参）', () => {
        const other = 'TCa1b2c3d4e5f60718293a4b5c6d7e8f90';
        expect([MBT_ID, other].map(normalizeSourceId)).toEqual([RAW, other]);
        expect(normalizeSourceId('  ' + MBT_ID + '  ')).toBe(RAW);
        expect(normalizeSourceId('  ' + other + '  ')).toBe(other);
    });
});

describe('MBT 推送响应反查归一化', () => {
    const pushData = [
        { [TS_ID_COLUMN]: MBT_ID, name: 'A' },
        { [TS_ID_COLUMN]: 'TCa1b2c3d4e5f60718293a4b5c6d7e8f90', name: 'B' },
    ];

    it('成功回显去前缀 sourceId → successMappings.tsId 还原为本地 MBT 值', () => {
        const res = parsePushResponse(
            [
                { type: '1', sourceId: RAW, data: 'TC-001' },
                { type: '1', sourceId: 'TCa1b2c3d4e5f60718293a4b5c6d7e8f90', data: 'TC-002' },
            ],
            pushData,
        );
        expect(res.successMappings.map(m => m.tsId)).toEqual([
            MBT_ID,
            'TCa1b2c3d4e5f60718293a4b5c6d7e8f90',
        ]);
    });

    it('失败回显去前缀 sourceId → failures.tsId 还原为本地 MBT 值', () => {
        const res = parsePushResponse(
            [{ type: '2', sourceId: RAW, data: '路径不合法' }],
            pushData,
        );
        expect(res.failures[0].tsId).toBe(MBT_ID);
    });

    it('未回显 sourceId → bodyIndex 兜底仍取本地 MBT 值', () => {
        const res = parsePushResponse([{ type: '2', data: '失败' }], pushData);
        expect(res.failures[0].tsId).toBe(MBT_ID);
    });
});
