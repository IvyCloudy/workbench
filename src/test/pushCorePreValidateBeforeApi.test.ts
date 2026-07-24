/**
 * pushCore · 预校验拦截保证（端到端）
 * ----------------------------------------------------------------------------
 * 核心契约：testcase_id 的全部预校验（占位 / 空 / 案例唯一标识格式）都必须发生在
 * 调用推送接口（pushTestCase）之前，与"样例数据 / 占位符校验"共用同一道闸门。
 * 本文件用真实 runPush 流程 + mock 掉真实接口，证明：
 *   1) 整份文件全是非法格式时，pushTestCase 绝不被调用；
 *   2) 混合同一份文件（非法格式 + 合法）时，到达接口的 payload 只包含合法行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import { runPush } from '../handlers/pushCore';
import { TelemetryService } from '../utils/telemetry';

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

// 样例过滤对测试 tsId 不生效（非样例），让其原样返回，避免触碰 vscode.workspace。
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

const INVALID = 'TC_EXPECTED_OBJECT_001'; // 非法格式（不满足 UUID / TC+hex / MA+hex）
const VALID = '123e4567-e89b-12d3-a456-426614174000';

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
        hooks: hooks as any,
        telemetryPrefix: 'push',
    }).then(() => hooks);
};

describe('pushCore 预校验拦截保证：非法格式行在调用推送接口前被拦截', () => {
    beforeEach(() => {
        // 默认返回失败码，使 runPush 在 stepInvokeBackend 后尽早返回，避免触碰回写/文件解析。
        pushTestCase.mockResolvedValue({ returnCode: 'FAIL', errorMsg: 'boom', body: null });
        (TelemetryService.sendTelemetryEvent as any).mockClear();
    });

    it('整份文件全是非法格式 → pushTestCase 绝不被调用，失败进 onComplete', async () => {
        const hooks = await run([{ [TS_ID_COLUMN]: INVALID }]);
        expect(pushTestCase).not.toHaveBeenCalled();
        expect(hooks.onComplete).toHaveBeenCalledTimes(1);
        const failures = hooks.onComplete.mock.calls[0][0].failures;
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toContain('案例唯一标识规范');
        expect(failures[0].category).toBe('fieldInvalid');
        expect(failures[0].field).toBe('sourceId');

        // 全剔除的 .aborted 事件 reason 应精确归类为格式非法，而非误报 emptyTestcaseIdOnly
        const abortedCalls = (TelemetryService.sendTelemetryEvent as any).mock.calls.filter(
            (c: any[]) => String(c[0]).includes('.aborted'),
        );
        expect(abortedCalls.length).toBeGreaterThan(0);
        expect(abortedCalls[0][1].reason).toBe('invalidFormatOnly');
    });

    it('混合文件（非法格式 + 合法）→ 到达接口的 payload 只含合法行', async () => {
        await run([
            { [TS_ID_COLUMN]: INVALID },
            { [TS_ID_COLUMN]: VALID },
        ]);
        expect(pushTestCase).toHaveBeenCalledTimes(1);
        const payload = JSON.stringify(pushTestCase.mock.calls[0][1]);
        // 非法格式值不应出现在发给后端的任何数据里
        expect(payload).not.toContain(INVALID);
        expect(payload).toContain(VALID);
    });
});
