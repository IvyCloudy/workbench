/**
 * 复现用户场景：8 行预校验失败 + 3 行合法（接口返回业务失败）。
 * 期望 onComplete: total=11, successCount=0, failures=11（8 预校验 + 3 接口）。
 * 用于确定核心 runPush 逻辑是否正确（若通过 → 问题在运行时/前端）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import { runPush } from '../handlers/pushCore';

const { pushTestCase } = vi.hoisted(() => ({ pushTestCase: vi.fn() }));

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
    return { ...actual, filterTemplateExampleRows: (_fp: string, rows: any[]) => rows };
});
vi.mock('../services/http', () => ({ pushTestCase: (...args: any[]) => pushTestCase(...args) }));
vi.mock('../utils/pushFailureStore', () => ({ persistPushFailures: vi.fn(async () => {}) }));

const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TC_ID = `TC${HEX32}`;
const MA_ID = `MA${HEX32}`;
const UUID_ID = '123e4567-e89b-12d3-a456-426614174000';

const baseHooks = () => ({
    onUnbound: vi.fn(), onNoData: vi.fn(), onOnlySampleRows: vi.fn(),
    onBackendError: vi.fn(), onUnexpectedError: vi.fn(), onComplete: vi.fn(),
    onProgress: vi.fn(), markSelfSave: vi.fn(), afterWriteBack: vi.fn(),
    onWriteBackFailed: vi.fn(),
});

describe('复现：8 预校验失败 + 3 合法接口失败', () => {
    beforeEach(() => {
        pushTestCase.mockReset();
        // 合法行送接口 → 后端业务失败（缺少步骤描述）
        pushTestCase.mockImplementation(async (_c: any, data: any[], _t: any, _a: any, _s: string) => ({
            returnCode: 'SUC0000',
            body: data.map((r: any) => ({
                type: '2', sourceId: r[TS_ID_COLUMN],
                data: `案例【${r[TS_ID_COLUMN]}】缺少「步骤描述」内容`,
            })),
        }));
    });

    it('total=11, success=0, failures=11', async () => {
        const rows = [
            { [TS_ID_COLUMN]: 'TESTCASE_ID' },       // 1 占位
            { [TS_ID_COLUMN]: '' },                   // 2 空
            { [TS_ID_COLUMN]: 'TC12345' },            // 3 格式
            { [TS_ID_COLUMN]: 'MA12345' },            // 4 格式
            { [TS_ID_COLUMN]: '案例ID123' },          // 5 格式
            { [TS_ID_COLUMN]: '12345678-1234-1234-1234' }, // 6 格式
            { [TS_ID_COLUMN]: 'TC-abc-def' },         // 7 格式
            { [TS_ID_COLUMN]: 'test_case_x' },        // 8 格式
            { [TS_ID_COLUMN]: TC_ID },                // 9 合法 testAgent
            { [TS_ID_COLUMN]: MA_ID },                // 10 合法 testAgentMA
            { [TS_ID_COLUMN]: UUID_ID },              // 11 合法 testAgentMA
        ];
        const hooks = baseHooks();
        await runPush({
            extensionContext: {} as any,
            filePath: '/tmp/tt/测试任务/x/测试案例/push.csv',
            rows: rows as any,
            resolveRowIndex: (i: number) => i + 1,
            frontPushIndexToRow: rows.map((_, i) => i + 1),
            hooks: hooks as any,
            telemetryPrefix: 'editorPush',
        });

        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
        const payload = hooks.onComplete.mock.calls[0][0];
        console.log('[REPRO] onComplete payload:', JSON.stringify({
            total: payload.total,
            successCount: payload.successCount,
            failuresLen: payload.failures.length,
            failures: payload.failures.map((f: any) => ({ r: f.rowIndex, ts: f.tsId, reason: f.reason })),
        }, null, 2));
        expect(payload.total).toBe(11);
        expect(payload.successCount).toBe(0);
        expect(payload.failures.length).toBe(11);
    });
});
