/**
 * pushDataMapper · 中文 CSV 分支「无步骤号」兼容回退
 * ----------------------------------------------------------------------------
 * 验证：
 *  1) 步骤描述不含「步骤N:」但非空 → 整段作为步骤 1；
 *  2) 预期结果不含「步骤N:」但含【UI检查】/【接口调用】/【数据检查】标签且非空
 *     → 整段作为步骤 1 的预期；
 *  3) 描述有步骤号、预期无步骤号但含标签 → 预期仅对齐步骤 1，其余步骤填空；
 *  4) 描述无步骤号、预期无步骤号但含标签 → 两者都回退为单步骤，一一对齐。
 */
import { describe, it, expect } from 'vitest';
import { mapRowToCaseItem } from '../utils/pushDataMapper';

describe('pushDataMapper · 中文 CSV 分支无步骤号回退', () => {
    it('步骤描述无「步骤N:」但非空 → 整段视为步骤1；预期同规则', () => {
        const row = {
            testcase_id: 'TC-fallback-001',
            名称: '单步骤·无步骤号',
            案例描述: '验证登录基本流程',
            路径: '账户中心/登录模块',
            步骤描述: '打开登录页并输入合法账号密码后点击登录',
            预期结果: '【UI检查】\n登录成功进入首页\n【接口调用】\n登录接口返回 200',
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.description).toHaveLength(1);
        expect(item.description[0]).toContain('打开登录页');
        expect(item.expected).toHaveLength(1);
        expect(item.expected[0]).toContain('【UI检查】');
        expect(item.expected[0]).toContain('【接口调用】');
    });

    it('描述有步骤号（多步）+ 预期无步骤号但含标签 → 预期仅对齐步骤1，其余步骤填空', () => {
        const row = {
            testcase_id: 'TC-fallback-002',
            名称: '多步骤·预期整段',
            案例描述: '验证多步骤下预期整段兜底到步骤1',
            路径: '账户中心/登录模块',
            步骤描述: '步骤1:\n打开登录页\n步骤2:\n输入账号密码\n步骤3:\n点击登录按钮',
            预期结果: '【UI检查】\n流程完成\n【数据检查】\n落表 status=done',
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.description).toHaveLength(3);
        expect(item.expected).toHaveLength(3);
        expect(item.expected[0]).toContain('【UI检查】');
        expect(item.expected[1]).toBe('');
        expect(item.expected[2]).toBe('');
    });

    it('预期结果无「步骤N:」且不含检查标签 → 视为整体缺失预期，抛 missingExpected', () => {
        const row = {
            testcase_id: 'TC-fallback-003',
            名称: '预期无步骤号无标签',
            案例描述: '验证预期结果为纯文本时的报错',
            路径: '账户中心/登录模块',
            步骤描述: '步骤1:\n点击登录',
            预期结果: '登录成功',
        };
        expect(() => mapRowToCaseItem(row as any)).toThrow(/缺少「预期结果」/);
    });

    it('步骤描述与预期结果都无步骤号（描述非空 + 预期含标签）→ 均回退为单步骤对齐', () => {
        const row = {
            testcase_id: 'TC-fallback-004',
            名称: '双回退',
            案例描述: '验证描述预期均无步骤号时的回退',
            路径: '账户中心/登录模块',
            步骤描述: '打开登录页\n输入账号密码\n点击登录',
            预期结果: '【UI检查】\n进入首页',
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.description).toHaveLength(1);
        expect(item.description[0]).toContain('打开登录页');
        expect(item.description[0]).toContain('<br>');
        expect(item.expected).toHaveLength(1);
        expect(item.expected[0]).toContain('【UI检查】');
    });
});
