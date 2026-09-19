/**
 * pushCore · 前置校验门控（B5）
 * ----------------------------------------------------------------------------
 * 契约：
 *   1) 有 warn/error 时触发 preValidateGate hook；
 *   2) hook 返回 'cancel' → 主流程短路走 onComplete（failures 全传、success=0），
 *      不调用后端接口；
 *   3) hook 返回 'continue' → 沿用现有语义：error 剔除、warn 进接口；
 *   4) hook 未实现 → 与老版一致，不阻塞。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import { runPush } from '../handlers/pushCore';

const { pushTestCase } = vi.hoisted(() => ({
    pushTestCase: vi.fn(),
}));

vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));

vi.mock('../utils/commands', () => ({
    getCurrentTaskInfo: vi.fn(async () => ({
        bind: true,
        taskInfo: { testTaskNo: 'TT001', subTestTaskId: 'ST001' },
    })),
}));

vi.mock('../utils/fileIdentifier', async (importActual) => {
    const actual = await importActual<typeof import('../utils/fileIdentifier')>();
    return {
        ...actual,
        filterTemplateExampleRows: (_filePath: string, rows: any[]) => rows,
    };
});

vi.mock('../utils/pushFailureStore', () => ({
    persistPushFailures: vi.fn(async () => {}),
}));

vi.mock('../services/http', () => ({
    pushTestCase: (...args: any[]) => pushTestCase(...args),
}));

const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TC_ID = `TC${HEX32}`;

const okRow = () => ({
    [TS_ID_COLUMN]: TC_ID,
    description: '正常案例',
    steps: [{ operation: '点击', ui_expected: ['成功'] }],
    test_type: '手工',
    type: '功能点类',
    priority: '低',
});

const todoRow = () => ({
    // 「待补充」软拦截命中 → severity=warn
    [TS_ID_COLUMN]: 'TC' + '1'.repeat(32),
    description: '未完成',
    steps: [{ operation: '待补充', ui_expected: ['ok'] }],
    test_type: '手工',
    type: '功能点类',
    priority: '低',
});

const invalidRow = () => ({
    // testcase_id 为占位 → severity=error（硬拦截）
    [TS_ID_COLUMN]: 'TESTCASE_ID',
    description: '占位',
    steps: [{ operation: '点击', ui_expected: ['ok'] }],
    test_type: '手工',
    type: '功能点类',
    priority: '低',
});

const baseHooks = () => ({
    onUnbound: vi.fn(),
    onNoData: vi.fn(),
    onOnlySampleRows: vi.fn(),
    onBackendError: vi.fn(),
    onComplete: vi.fn(),
    onProgress: vi.fn(),
});

const runWithGate = async (rows: any[], gate?: ReturnType<typeof vi.fn>) => {
    const hooks: any = baseHooks();
    if (gate) hooks.preValidateGate = gate;
    await runPush({
        extensionContext: {} as any,
        filePath: '/tmp/tt/case.yaml',
        rows,
        resolveRowIndex: (i: number) => i + 1,
        frontPushIndexToRow: rows.map((_, i) => i + 1),
        hooks: hooks as any,
        telemetryPrefix: 'push',
    });
    return hooks;
};

describe('pushCore · 前置校验门控（preValidateGate）', () => {
    beforeEach(() => {
        pushTestCase.mockReset();
        pushTestCase.mockImplementation(async (_c: any, data: any[], _t: any, _f: any, source: string) => ({
            returnCode: 'SUC0000',
            body: data.map((r: any) => ({ type: '1', sourceId: r[TS_ID_COLUMN], data: `pushed-${source}` })),
        }));
    });

    it('无 warn/error → 不调用 gate hook，正常推送', async () => {
        const gate = vi.fn(async () => 'continue' as const);
        const hooks = await runWithGate([okRow()], gate);
        expect(gate).not.toHaveBeenCalled();
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
    });

    it('仅 warn 且 gate 返回 continue → warn 项进接口调用', async () => {
        const gate = vi.fn(async () => 'continue' as const);
        const hooks = await runWithGate([todoRow()], gate);
        expect(gate).toHaveBeenCalledTimes(1);
        // gate 收到的 failures 包含 warn 项
        const gateArgs = gate.mock.calls[0][0] as any[];
        expect(gateArgs.length).toBe(1);
        expect(gateArgs[0].severity).toBe('warn');
        // warn 项不剔除 → 后端接口被调用
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        const pushedRows = pushTestCase.mock.calls[0][1] as any[];
        expect(pushedRows.length).toBe(1);
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
    });

    it('仅 warn 且 gate 返回 cancel → 静默关闭：不调后端 & 不弹推送结果窗口', async () => {
        const gate = vi.fn(async () => 'cancel' as const);
        const hooks = await runWithGate([todoRow(), okRow()], gate);
        expect(gate).toHaveBeenCalledTimes(1);
        expect(pushTestCase).not.toHaveBeenCalled();
        // 关键契约：cancel 后不能触发 onComplete，否则会重新弹推送结果弹窗
        expect(hooks.onComplete).not.toHaveBeenCalled();
    });

    it('有 error → gate 被调用；返回 cancel 后静默关闭（不弹完成态）', async () => {
        const gate = vi.fn(async () => 'cancel' as const);
        const hooks = await runWithGate([invalidRow(), okRow()], gate);
        expect(gate).toHaveBeenCalledTimes(1);
        // cancel → 不调后端，也不发完成态弹窗
        expect(pushTestCase).not.toHaveBeenCalled();
        expect(hooks.onComplete).not.toHaveBeenCalled();
    });

    it('未实现 gate hook → 与老版行为一致（warn 项进接口，不阻塞）', async () => {
        const hooks = await runWithGate([todoRow()]);
        // 未设置 gate hook
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
    });

    it('gate hook 抛错 → 按 continue 兜底，不阻塞主流程', async () => {
        const gate = vi.fn(async () => { throw new Error('webview 崩溃'); });
        const hooks = await runWithGate([todoRow()], gate);
        expect(gate).toHaveBeenCalledTimes(1);
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
    });

    it('gate 返回非法值（如"maybe"）→ 归一化为 continue，主流程继续', async () => {
        const gate = vi.fn(async () => 'maybe' as any);
        await runWithGate([todoRow()], gate);
        expect(pushTestCase).toHaveBeenCalledTimes(1);
    });
});
