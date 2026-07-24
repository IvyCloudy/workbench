/**
 * pushCore · 按来源拆批推送（端到端）
 * ----------------------------------------------------------------------------
 * 契约：
 *   1) testcase_id 满足 TC+32位uuid.hex 的行 → 一批（sourcePlatform=testAgent）；
 *      其余行（MA+hex / 标准 UUID）→ 另一批（sourcePlatform=testAgentMA）；
 *   2) 两批各自调用推送接口，批内 bodyIndex 重映射回全局行号；
 *   3) 两批结果合并后，onComplete 的 failures 按主表行号升序（弹窗按行顺序）。
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
        filterTemplateExampleRows: (filePath: string, rows: any[]) => rows,
    };
});

vi.mock('../services/http', () => ({
    pushTestCase: (...args: any[]) => pushTestCase(...args),
}));

const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TC_ID = `TC${HEX32}`;              // → testAgent
const MA_ID = `MA${HEX32}`;              // → testAgentMA
const UUID_ID = '123e4567-e89b-12d3-a456-426614174000'; // → testAgentMA

const baseHooks = () => ({
    onUnbound: vi.fn(),
    onNoData: vi.fn(),
    onOnlySampleRows: vi.fn(),
    onBackendError: vi.fn(),
    onComplete: vi.fn(),
    onProgress: vi.fn(),
});

const run = (rows: Array<Record<string, string>>) => {
    const hooks = baseHooks();
    return runPush({
        extensionContext: {} as any,
        filePath: '/tmp/tt/push.yaml',
        rows: rows as any,
        resolveRowIndex: (i: number) => i + 1,
        frontPushIndexToRow: rows.map((_, i) => i + 1),
        hooks: hooks as any,
        telemetryPrefix: 'push',
    }).then(() => hooks);
};

describe('pushCore 按来源拆批推送：TC+uuid.hex → testAgent，其余 → testAgentMA', () => {
    beforeEach(() => {
        pushTestCase.mockReset();
        // 后端把每行都判为失败（type=2），使 runPush 走全失败路径，避免成功回写触碰文件系统。
        pushTestCase.mockImplementation(async (_ctx: any, data: any[], _task: any, _artifact: any, source: string) => ({
            returnCode: 'SUC0000',
            body: data.map((r: any) => ({ type: '2', sourceId: r[TS_ID_COLUMN], data: `boom-${source}` })),
        }));
    });

    it('混合来源 → 恰好两批：testAgent 只含 TC 行，testAgentMA 含其余行', async () => {
        await run([
            { [TS_ID_COLUMN]: UUID_ID }, // 行1 → testAgentMA
            { [TS_ID_COLUMN]: TC_ID },   // 行2 → testAgent
            { [TS_ID_COLUMN]: MA_ID },   // 行3 → testAgentMA
        ]);
        expect(pushTestCase).toHaveBeenCalledTimes(2);
        const bySource: Record<string, string[]> = {};
        for (const call of pushTestCase.mock.calls) {
            const source = call[4];
            bySource[source] = call[1].map((r: any) => r[TS_ID_COLUMN]);
        }
        expect(bySource['testAgent']).toEqual([TC_ID]);
        expect(bySource['testAgentMA']).toEqual([UUID_ID, MA_ID]); // 保留原有相对顺序
    });

    it('单一来源 → 只发一批，不做多余接口调用', async () => {
        await run([{ [TS_ID_COLUMN]: MA_ID }, { [TS_ID_COLUMN]: UUID_ID }]);
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        expect(pushTestCase.mock.calls[0][4]).toBe('testAgentMA');

        pushTestCase.mockClear();
        await run([{ [TS_ID_COLUMN]: TC_ID }]);
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        expect(pushTestCase.mock.calls[0][4]).toBe('testAgent');
    });

    it('两批结果合并后按主表行号升序弹窗（跨批行号交错也保持行顺序）', async () => {
        const hooks = await run([
            { [TS_ID_COLUMN]: UUID_ID }, // 行1（MA 批第 1 条）
            { [TS_ID_COLUMN]: TC_ID },   // 行2（TC 批第 1 条）
            { [TS_ID_COLUMN]: MA_ID },   // 行3（MA 批第 2 条）
        ]);
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
        const { failures, total, successCount } = hooks.onComplete.mock.calls[0][0];
        expect(successCount).toBe(0);
        expect(total).toBe(3);
        // 按行顺序：1(UUID) → 2(TC) → 3(MA)，不是"批顺序"（TC 批先返回）
        expect(failures.map((f: any) => f.rowIndex)).toEqual([1, 2, 3]);
        expect(failures.map((f: any) => f.tsId)).toEqual([UUID_ID, TC_ID, MA_ID]);
        // 各行 reason 来自其所属批的 sourcePlatform
        expect(failures[0].reason).toBe('boom-testAgentMA');
        expect(failures[1].reason).toBe('boom-testAgent');
        expect(failures[2].reason).toBe('boom-testAgentMA');
    });

    it('任一批接口失败（returnCode 非 SUC0000）→ 失败行合并到 onComplete（不再 onBackendError 终止）', async () => {
        pushTestCase.mockImplementation(async (_ctx: any, data: any[], _t: any, _a: any, source: string) => {
            if (source === 'testAgent') return { returnCode: 'FAIL', errorMsg: 'tc-batch-down', body: null };
            return {
                returnCode: 'SUC0000',
                body: data.map((r: any) => ({ type: '2', sourceId: r[TS_ID_COLUMN], data: 'x' })),
            };
        });
        const hooks = await run([{ [TS_ID_COLUMN]: TC_ID }, { [TS_ID_COLUMN]: MA_ID }]);
        // 不再走 onBackendError 终止路径——统一合并到 onComplete 展示
        expect(hooks.onBackendError).not.toHaveBeenCalled();
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
        const { failures, total, successCount } = hooks.onComplete.mock.calls[0][0];
        expect(successCount).toBe(0);
        expect(total).toBe(2); // 原始总行数
        // TC 批失败（tc-batch-down）+ MA 批后端逐行失败（x），共 2 条
        expect(failures.length).toBe(2);
        // TC 行的 reason 来自接口错误信息
        expect(failures.find((f: any) => f.tsId === TC_ID)?.reason).toBe('tc-batch-down');
    });
});
