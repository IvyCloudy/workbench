/**
 * pushPreValidate · 「待补充」字面量软拦截（B1）
 * ----------------------------------------------------------------------------
 * 覆盖：《案例推送前置校验-待补充拦截需求文档》验收要点 1、2、5、7、10。
 *
 * 校验矩阵：
 *   - 极简子串命中（档位 1）：只要出现"待补充"三字即命中，不要求前后带「」或其它括号
 *   - 双键名兼容：YAML 英文键 + CSV 中文列名，都能扫到
 *   - 多字段扫描：name、description、preconditions、steps 数组、预期结果
 *   - severity=warn：命中 failures 但不进 droppedIndex（Y 方案：软拦截不阻断推送）
 *   - 与硬拦截共存：占位、空、格式非法优先，同行不会既报 error 又报 warn
 *   - category、field 打通：category='todo.placeholder'，field 按命中类型回带
 *   - 样例占位行豁免（isSampleTsId 提前跳过）
 */
import { describe, it, expect, vi } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import { stepPreValidate } from '../handlers/pushCore';
import { persistPushFailures } from '../utils/pushFailureStore';

vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));

vi.mock('../utils/pushFailureStore', () => ({
    persistPushFailures: vi.fn(async () => {}),
}));

/** 合法 testcase_id，用于隔离出「只测『待补充』」的场景（不被格式非法/占位/空拦截误伤）。 */
const VALID_TSID_1 = '123e4567-e89b-12d3-a456-426614174000';
const VALID_TSID_2 = '223e4567-e89b-12d3-a456-426614174000';

const makeCtx = (traceId = 't-todo'): any => ({
    telemetryPrefix: 'push',
    fileExt: '.yaml',
    traceId,
    opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
});

describe('B1「待补充」软拦截 · 字面量识别边界', () => {
    it('裸文本"待补充"也命中（极简子串规则：无需前后带「」）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, name: '登录用例', description: '这里有待补充但没引号' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].severity).toBe('warn');
        expect(res.failures[0].category).toBe('todo.placeholder');
        expect(res.failures[0].field).toBe('testCaseDes');
    });

    it('全角「待补充」命中（在案例描述中）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, name: '登录用例', description: '这里是「待补充」' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].severity).toBe('warn');
        expect(res.failures[0].category).toBe('todo.placeholder');
        expect(res.failures[0].field).toBe('testCaseDes');
    });

    it('半角/方括号变体（[待补充]、"待补充"）同样命中（子串包含即可）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, description: '["待补充"]' },
            { [TS_ID_COLUMN]: VALID_TSID_2, description: '[待补充]' },
        ]);
        expect(res.failures).toHaveLength(2);
        expect(res.failures.every(f => f.severity === 'warn')).toBe(true);
    });

    it('YAML 多行文本（operation 块里独立一行"待补充"）命中 —— 回归用户实际 case', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, steps: [{ operation: '步骤名称1\n待补充' }] },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].severity).toBe('warn');
        expect(res.failures[0].field).toBe('description');
    });
});

describe('B1「待补充」软拦截 · YAML 字段扫描', () => {
    it('name 字段命中 → field=testCaseName', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, name: '功能A「待补充」', steps: [{ operation: 'ok' }] },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('testCaseName');
    });

    it('preconditions（YAML 数组）中任一项含「待补充」→ field=preCondition', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, preconditions: ['已登录', '前置：「待补充」'] },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('preCondition');
    });

    it('steps[].operation 含「待补充」→ field=description（步骤描述）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, steps: [{ operation: '点击「待补充」按钮', data: 'x' }] },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('description');
    });

    it('steps[].data 含「待补充」也应命中 description', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, steps: [{ operation: 'ok', data: 'val=「待补充」' }] },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('description');
    });

    it('steps[].ui_expected / api_expected / db_expected 任一含「待补充」→ field=expected', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, steps: [{ operation: 'ok', ui_expected: '页面「待补充」' }] },
            { [TS_ID_COLUMN]: VALID_TSID_2, steps: [{ operation: 'ok', db_expected: ['t=1', 'row=「待补充」'] }] },
        ]);
        expect(res.failures).toHaveLength(2);
        expect(res.failures.every(f => f.field === 'expected')).toBe(true);
    });
});

describe('B1「待补充」软拦截 · CSV 中文列名扫描', () => {
    it('CSV 「名称」列命中 → field=testCaseName', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, '名称': '登录「待补充」', '步骤描述': '步骤1:\nok' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('testCaseName');
    });

    it('CSV 「步骤描述」列命中 → field=description', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, '名称': 'ok', '步骤描述': '步骤1:\n点击「待补充」按钮' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('description');
    });

    it('CSV 「预期结果」列命中 → field=expected', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, '预期结果': '【UI检查】\n页面「待补充」' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].field).toBe('expected');
    });

    it('CSV 「前置条件」/「案例描述」列命中 → 对应 field', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, '前置条件': '「待补充」' },
            { [TS_ID_COLUMN]: VALID_TSID_2, '案例描述': '整体「待补充」' },
        ]);
        expect(res.failures).toHaveLength(2);
        const fields = res.failures.map(f => f.field).sort();
        expect(fields).toEqual(['preCondition', 'testCaseDes']);
    });
});

describe('B1「待补充」软拦截 · 同行多字段命中', () => {
    it('同一行「名称」+「步骤描述」都命中 → 一条 warn，reason 列出所有命中字段', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, name: '「待补充」', steps: [{ operation: '「待补充」' }] },
        ]);
        expect(res.failures).toHaveLength(1); // 同行合并为一条
        expect(res.failures[0].reason).toContain('步骤');
        expect(res.failures[0].reason).toContain('案例名称');
        // primaryField 取"步骤操作"（CHECKS 顺序里排在案例名称前）
        expect(res.failures[0].field).toBe('description');
    });
});

describe('B1「待补充」软拦截 · Y 方案：warn 不进 droppedIndex', () => {
    it('单条「待补充」命中：failures 记录，但 droppedIndex 为空（行仍进推送）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, description: '「待补充」' },
        ]);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].severity).toBe('warn');
        expect(res.droppedIndex.size).toBe(0); // ← Y 方案关键：软拦截不剔除
    });

    it('多行混合：只有「待补充」的行不剔除，格式非法的行剔除', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, description: '「待补充」' }, // warn，不剔除
            { [TS_ID_COLUMN]: 'bad-id', description: '正常' },           // error（格式非法），剔除
            { [TS_ID_COLUMN]: VALID_TSID_2, description: '正常' },       // 完全通过
        ]);
        const warnCount = res.failures.filter(f => f.severity === 'warn').length;
        const errorCount = res.failures.filter(f => f.severity === 'error').length;
        expect(warnCount).toBe(1);
        expect(errorCount).toBe(1);
        expect(res.droppedIndex.has(0)).toBe(false); // warn 行保留
        expect(res.droppedIndex.has(1)).toBe(true);  // error 行剔除
        expect(res.droppedIndex.has(2)).toBe(false); // 通过行保留
    });
});

describe('B1「待补充」软拦截 · 与硬拦截互斥', () => {
    it('同一行 tsId 格式非法 + 内容含「待补充」→ 仅报 error（不叠加 warn）', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: 'bad-id', description: '「待补充」' },
        ]);
        // runValidators 内 error 命中即 break，不会再跑 todoPlaceholder
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].severity).toBe('error');
        expect(res.failures[0].category).toBe('sourceId.format');
    });

    it('样例占位行（isSampleTsId）豁免所有 validator，包括「待补充」', async () => {
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: '案例唯一标识，不可修改', description: '「待补充」' },
        ]);
        expect(res.failures).toHaveLength(0);
        expect(res.droppedIndex.size).toBe(0);
    });
});

describe('B1「待补充」软拦截 · 高亮持久化 & 埋点契约', () => {
    it('「待补充」命中也参与 persistPushFailures 高亮持久化（供编辑器黄色底色）', async () => {
        (persistPushFailures as any).mockClear();
        const ctx = makeCtx();
        await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, description: '「待补充」' },
        ]);
        expect(persistPushFailures).toHaveBeenCalledTimes(1);
        const persisted = (persistPushFailures as any).mock.calls[0][2];
        expect(persisted).toHaveLength(1);
        expect(persisted[0].category).toBe('todo.placeholder');
        expect(persisted[0].field).toBe('testCaseDes');
    });

    it('全部行通过（无任何 validator 命中）→ 不触发 persistPushFailures', async () => {
        (persistPushFailures as any).mockClear();
        const ctx = makeCtx();
        const res = await stepPreValidate(ctx, [
            { [TS_ID_COLUMN]: VALID_TSID_1, description: '正常内容' },
        ]);
        expect(res.failures).toHaveLength(0);
        expect(persistPushFailures).not.toHaveBeenCalled();
    });
});
