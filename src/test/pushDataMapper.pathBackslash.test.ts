/**
 * pushDataMapper · 推送案例路径分隔符兼容
 * ----------------------------------------------------------------------------
 * 验证：推送案例时，案例 path（YAML 分支）/ 路径（中文 CSV 分支）若以反斜杠 \ 分割，
 *   统一改为正斜杠 /（同时兼容全角 ／、间隔点 ·、首尾 \），与关联匹配侧规则一致。
 */
import { describe, it, expect } from 'vitest';
import { mapRowToCaseItem } from '../utils/pushDataMapper';

describe('pushDataMapper · 推送案例路径反斜杠转正斜杠', () => {
    it('YAML 分支：path 用 \\ 分割 → testCasePath 用 / 分割且结尾带 /', () => {
        const row = {
            testcase_id: 'TC-001',
            name: '账号登录',
            description: '验证账号登录基本流程',
            path: '账户中心\\登录模块\\账号登录',
            test_type: '自动化',
            steps: [{ operation: '点击登录', data: ['输入账号'], ui_expected: ['进入首页'] }],
            preconditions: ['已注册'],
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.testCasePath).toBe('账户中心/登录模块/账号登录/');
    });

    it('中文 CSV 分支：路径 用 \\ 分割 → testCasePath 用 / 分割且结尾带 /', () => {
        const row = {
            testcase_id: 'TC-002',
            名称: '账号登录',
            案例描述: '验证账号登录基本流程',
            路径: '账户中心\\登录模块\\账号登录',
            执行方式: '自动化',
            步骤描述: '步骤1:\n点击登录',
            预期结果: '步骤1:\n进入首页',
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.testCasePath).toBe('账户中心/登录模块/账号登录/');
    });

    it('混合写法：首尾 \\、全角 ／、间隔点 · → 统一归一化为 / 分隔', () => {
        const row = {
            testcase_id: 'TC-003',
            name: '混合',
            description: '路径分隔符兼容用例',
            path: '\\账户中心／登录模块·账号登录\\',
            test_type: '自动化',
            steps: [{ operation: '操作', ui_expected: ['ok'] }],
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.testCasePath).toBe('账户中心/登录模块/账号登录/');
    });

    it('已是标准 / 写法 → 保持不变（仅补结尾 /）', () => {
        const row = {
            testcase_id: 'TC-004',
            name: '标准',
            description: '标准路径写法用例',
            path: '账户中心/登录模块/账号登录',
            test_type: '自动化',
            steps: [{ operation: '操作', ui_expected: ['ok'] }],
        };
        const item = mapRowToCaseItem(row as any);
        expect(item.testCasePath).toBe('账户中心/登录模块/账号登录/');
    });
});
