/**
 * 编辑器全链路复现：模拟前端 pushChanges 的选中行 + pushIndexToRow/rowIndexMap，
 * 并用真实 mock-server 语义（合法行接口成功 type:'1'）验证：
 *   1) 失败计数（预校验 8 + 接口 0）= 8，成功 3
 *   2) 每条失败的 rowIndex 必须精确映射到「被选中的全局行号」(pushIndexToRow)
 *   3) 含样例行时，过滤后行号映射仍正确（验证 filteredToOriginal 链路）
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

describe('parsePushResponse 不静默丢弃未知 type', () => {
    it('type 缺失/未知 的响应项计为失败，而不是凭空消失', async () => {
        const { parsePushResponse } = await import('../utils/pushResponse');
        const pushData = [
            { [TS_ID_COLUMN]: TC_ID },
            { [TS_ID_COLUMN]: MA_ID },
            { [TS_ID_COLUMN]: UUID_ID },
        ];
        const body = [
            { sourceId: TC_ID, data: '{}' },                       // type 缺失
            { sourceId: MA_ID, type: '0', data: '' },              // type 未知
            { sourceId: UUID_ID, type: '2', data: '缺少步骤描述' }, // type:'2'
        ];
        const res = parsePushResponse(body, pushData);
        console.log('[DROPPED] success=%d failures=%d', res.successMappings.length, res.failures.length);
        console.log('[DROPPED] reasons=', JSON.stringify(res.failures.map((f) => f.reason)));
        // 修复前：success=0, failures=1（仅 type:'2'），2 行凭空消失
        // 修复后：success=0, failures=3，全部计入
        expect(res.successMappings.length).toBe(0);
        expect(res.failures.length).toBe(3);
    });
});

describe('编辑器全链路：行号映射 / 接口成功计入', () => {
    beforeEach(() => {
        pushTestCase.mockReset();
        // 真实 mock-server 语义：合法行全部成功 type:'1'
        pushTestCase.mockImplementation(async (_c: any, data: any[]) => ({
            returnCode: 'SUC0000',
            errorMsg: '',
            body: data.map((r: any, i: number) => ({
                type: '1', sourceId: r[TS_ID_COLUMN], data: 'TT' + (1000 + i),
            })),
        }));
    });

    it('无样例行：8 预校验失败(行号正确) + 3 成功', async () => {
        // 前端选中 11 行（全局行号 1..11），pushIndexToRow = [1..11]
        const rows = [
            { [TS_ID_COLUMN]: 'TESTCASE_ID' },       // 1 占位
            { [TS_ID_COLUMN]: '' },                   // 2 空
            { [TS_ID_COLUMN]: 'TC12345' },            // 3 格式
            { [TS_ID_COLUMN]: 'MA12345' },            // 4 格式
            { [TS_ID_COLUMN]: '案例ID123' },          // 5 格式
            { [TS_ID_COLUMN]: '12345678-1234-1234-1234' }, // 6 格式
            { [TS_ID_COLUMN]: 'TC-abc-def' },         // 7 格式
            { [TS_ID_COLUMN]: 'test_case_x' },        // 8 格式
            { [TS_ID_COLUMN]: TC_ID },                // 9 合法
            { [TS_ID_COLUMN]: MA_ID },                // 10 合法
            { [TS_ID_COLUMN]: UUID_ID },              // 11 合法
        ];
        const pushIndexToRow = rows.map((_, i) => i + 1);
        const hooks = baseHooks();
        await runPush({
            extensionContext: {} as any,
            filePath: '/tmp/tt/测试任务/x/测试案例/push.csv',
            rows: rows as any,
            resolveRowIndex: (i: number) => pushIndexToRow[i] ?? i + 1,
            frontPushIndexToRow: pushIndexToRow,
            hooks: hooks as any,
            telemetryPrefix: 'editorPush',
        });

        const p = hooks.onComplete.mock.calls[0][0];
        console.log('[EDITOR] total=%d success=%d failures=%d', p.total, p.successCount, p.failures.length);
        console.log('[EDITOR] failures=', JSON.stringify(p.failures.map((f: any) => ({ r: f.rowIndex, ts: f.tsId, reason: f.reason }))));
        // 合法行接口成功 → 8 失败 + 3 成功
        expect(p.total).toBe(11);
        expect(p.successCount).toBe(3);
        expect(p.failures.length).toBe(8);
        // 行号必须精确等于 1..8
        p.failures.forEach((f: any, k: number) => expect(f.rowIndex).toBe(k + 1));
    });

    it('含样例行：过滤后接口成功行行号仍正确映射到全局行', async () => {
        // 全局行 1=样例, 2..9=预校验失败, 10..12=合法(被选中)
        const sampleRow = { [TS_ID_COLUMN]: '案例唯一标识，不可修改' };
        const rows = [
            sampleRow,                               // 1 样例(应被过滤)
            { [TS_ID_COLUMN]: 'TESTCASE_ID' },       // 2 占位
            { [TS_ID_COLUMN]: '' },                   // 3 空
            { [TS_ID_COLUMN]: 'TC12345' },            // 4 格式
            { [TS_ID_COLUMN]: 'MA12345' },            // 5 格式
            { [TS_ID_COLUMN]: '案例ID123' },          // 6 格式
            { [TS_ID_COLUMN]: '12345678-1234-1234-1234' }, // 7 格式
            { [TS_ID_COLUMN]: 'TC-abc-def' },         // 8 格式
            { [TS_ID_COLUMN]: 'test_case_x' },        // 9 格式
            { [TS_ID_COLUMN]: TC_ID },                // 10 合法
            { [TS_ID_COLUMN]: MA_ID },                // 11 合法
            { [TS_ID_COLUMN]: UUID_ID },              // 12 合法
        ];
        // 前端只选中了 8/9/10/11/12 这几行参与推送（样例+部分失败+合法）
        // 模拟：选中全局行 [1,2,3,10,11,12] -> payload 顺序
        const picked = [0, 1, 2, 9, 10, 11]; // 0-based 全局下标
        const payload = picked.map((gi) => rows[gi]);
        const pushIndexToRow = picked.map((gi) => gi + 1); // [1,2,3,10,11,12]
        const hooks = baseHooks();
        await runPush({
            extensionContext: {} as any,
            filePath: '/tmp/tt/测试任务/x/测试案例/push.csv',
            rows: payload as any,
            resolveRowIndex: (i: number) => pushIndexToRow[i] ?? i + 1,
            frontPushIndexToRow: pushIndexToRow,
            hooks: hooks as any,
            telemetryPrefix: 'editorPush',
        });
        const p = hooks.onComplete.mock.calls[0][0];
        console.log('[EDITOR-SAMPLE] total=%d success=%d failures=%d', p.total, p.successCount, p.failures.length);
        console.log('[EDITOR-SAMPLE] failures=', JSON.stringify(p.failures.map((f: any) => ({ r: f.rowIndex, ts: f.tsId }))));
        // payload 6 行：1 样例(过滤) + 2 预校验(行2,3) + 3 合法(行10,11,12)
        expect(p.total).toBe(6);
        expect(p.successCount).toBe(3);
        expect(p.failures.length).toBe(2);
        // 预校验失败的全局行号必须是 2 和 3（不是 1 和 2）
        const got = p.failures.map((f: any) => f.rowIndex).sort((a: number, b: number) => a - b);
        expect(got).toEqual([2, 3]);
    });
});
