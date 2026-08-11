/**
 * pushPreValidate · 推送前 testcase_id 校验
 * ----------------------------------------------------------------------------
 * 覆盖三类预校验：占位 TESTCASE_ID / 空值 / 案例唯一标识格式规范。
 * 格式合法值：标准 UUID、TC+uuid.hex、MA+uuid.hex。
 */
import { describe, it, expect, vi } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import {
    collectPlaceholderTestcaseIdFailures,
    collectEmptyTestcaseIdFailures,
    collectInvalidFormatFailures,
    stepPreValidate,
} from '../handlers/pushCore';
import { isTestAgentUuid, isTestFlowUuid, isValidTestcaseId } from '../utils/testcaseId';
import { persistPushFailures } from '../utils/pushFailureStore';

vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));

vi.mock('../utils/pushFailureStore', () => ({
    persistPushFailures: vi.fn(async () => {}),
}));

const row = (id: string) => ({ [TS_ID_COLUMN]: id });
const idx = (i: number) => i + 1; // 1-based 行号
const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('pushPreValidate · testcase_id 格式校验 (FORMAT_VALIDATOR)', () => {
    it('合法值放行：标准 UUID', () => {
        expect(collectInvalidFormatFailures([row('123e4567-e89b-12d3-a456-426614174000')], idx)).toHaveLength(0);
    });

    it('合法值放行：TC + uuid.hex（32 位十六进制）', () => {
        expect(collectInvalidFormatFailures([row(`TC${HEX32}`)], idx)).toHaveLength(0);
    });

    it('合法值放行：MA + uuid.hex（32 位十六进制）', () => {
        expect(collectInvalidFormatFailures([row(`MA${HEX32}`)], idx)).toHaveLength(0);
    });

    it('大小写不敏感：tc/ma 前缀 + 大写 hex 也合法', () => {
        expect(collectInvalidFormatFailures([row(`tc${HEX32.toUpperCase()}`)], idx)).toHaveLength(0);
    });

    it('非法格式命中：记 reason + category + field', () => {
        const f = collectInvalidFormatFailures([row('abc123')], idx);
        expect(f).toHaveLength(1);
        expect(f[0].reason).toBe('testcase_id的值不符合案例唯一标识规范');
        expect(f[0].category).toBe('sourceId.format');
        expect(f[0].field).toBe('sourceId');
    });

    it('占位值/空值在单独跑格式校验时也会被判定为格式非法', () => {
        expect(collectInvalidFormatFailures([row('TESTCASE_ID')], idx)).toHaveLength(1);
        expect(collectInvalidFormatFailures([row('')], idx)).toHaveLength(1);
    });

    it('完整预校验序列中占位/空优先于格式校验（互不重复计数）', () => {
        expect(collectPlaceholderTestcaseIdFailures([row('TESTCASE_ID')], idx)).toHaveLength(1);
        expect(collectEmptyTestcaseIdFailures([row('')], idx)).toHaveLength(1);
    });

    it('stepPreValidate 把格式非法的 testcase_id 纳入失败列表并剔除该行（回归）', async () => {
        const ctx = {
            telemetryPrefix: 'push',
            fileExt: '.yaml',
            traceId: 't1',
            opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
        } as any;
        const res = await stepPreValidate(ctx, [
            row('TC_EXPECTED_OBJECT_001'),               // 格式非法 → 应被拦下
            row('123e4567-e89b-12d3-a456-426614174000'), // 合法 UUID → 不拦
        ]);
        const invalid = res.failures.find(f => f.reason.includes('案例唯一标识规范'));
        expect(invalid).toBeDefined();
        expect(invalid!.category).toBe('sourceId.format');
        expect(invalid!.field).toBe('sourceId');
        expect(res.failures).toHaveLength(1);      // 只有格式非法那条进失败列表
        expect(res.droppedIndex.has(0)).toBe(true); // 该行被剔除，不会真正推送
    });

    it('stepPreValidate 把格式非法失败持久化为红色高亮（带真实 tsId）', async () => {
        persistPushFailures.mockClear();
        const ctx = {
            telemetryPrefix: 'push',
            fileExt: '.yaml',
            traceId: 't2',
            opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
        } as any;
        await stepPreValidate(ctx, [row('TC_EXPECTED_OBJECT_001'), row('123e4567-e89b-12d3-a456-426614174000')]);
        expect(persistPushFailures).toHaveBeenCalledTimes(1);
        const failures = persistPushFailures.mock.calls[0][2]; // (filePath, rows, failures, successMappings)
        const hit = failures.find((f: any) => f.tsId === 'TC_EXPECTED_OBJECT_001');
        expect(hit).toBeDefined();
        expect(hit.category).toBe('sourceId.format');
        expect(hit.field).toBe('sourceId');
    });

    it('stepPreValidate 占位 + 格式混合时合并为一次持久化（空 tsId 无 key 跳过）', async () => {
        persistPushFailures.mockClear();
        const ctx = {
            telemetryPrefix: 'push',
            fileExt: '.yaml',
            traceId: 't3',
            opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
        } as any;
        await stepPreValidate(ctx, [row('TESTCASE_ID'), row('TC_EXPECTED_OBJECT_001'), row('')]);
        expect(persistPushFailures).toHaveBeenCalledTimes(1);
        const failures = persistPushFailures.mock.calls[0][2];
        const tsIds = failures.map((f: any) => f.tsId);
        expect(tsIds).toContain('TESTCASE_ID');          // 占位 → 持久化
        expect(tsIds).toContain('TC_EXPECTED_OBJECT_001'); // 格式 → 持久化
        expect(tsIds.some((t: string) => t.startsWith('__EMPTY_TSID_ROW_'))).toBe(false); // 空 → 跳过
    });

    it('中文样例占位行不参与预校验（已在样例过滤识别，不应被误判为格式非法）', async () => {
        const ctx = {
            telemetryPrefix: 'push',
            fileExt: '.yaml',
            traceId: 't4',
            opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
        } as any;
        const res = await stepPreValidate(ctx, [
            row('案例唯一标识，不可修改'), // 中文样例 → 应跳过，不进失败、不剔除
            row('案例唯一标识'),          // 中文样例短版 → 同上
            row('TC_EXPECTED_OBJECT_001'), // 格式非法 → 应被拦下
        ]);
        const invalid = res.failures.find(f => f.reason.includes('案例唯一标识规范'));
        expect(invalid).toBeDefined();
        expect(res.failures).toHaveLength(1); // 仅格式非法那条，两条样例行被跳过
        expect(res.droppedIndex.has(0)).toBe(false); // 样例行保留，交由 step 3 过滤
        expect(res.droppedIndex.has(1)).toBe(false);
        expect(res.droppedIndex.has(2)).toBe(true);  // 格式非法行剔除
    });
});

describe('pushPreValidate · testagent / testflow 掩码 uuid 兼容校验', () => {
    // 以真实示例为准：除 TC 与 0 外即为掩码字母，掩码位为 3/7/10/14/17/21/24/28/31
    const AGENT_ID = 'TC00t000e00s000t00a000g00e000n00t0';
    // 掩码位为 3/7/10/14/17/21/24/28（testflow 仅 8 字母，末两位为 hex）
    const FLOW_ID = 'TC00t000e00s000t00f000l00o000w0000';

    it('isTestAgentUuid 命中场景一掩码 uuid', () => {
        expect(isTestAgentUuid(AGENT_ID)).toBe(true);
        expect(isTestFlowUuid(AGENT_ID)).toBe(false);
    });

    it('isTestFlowUuid 命中场景二掩码 uuid', () => {
        expect(isTestFlowUuid(FLOW_ID)).toBe(true);
        expect(isTestAgentUuid(FLOW_ID)).toBe(false);
    });

    it('位数错位 / 字母串不匹配 → 两类掩码均判非法', () => {
        // 把 testagent 第 31 位的 t 改成 0，不再满足场景一
        expect(isTestAgentUuid('TC00t000e00s000t00a000g00e000n0000')).toBe(false);
        // 把 testflow 第 17 位的 f 改成 a，错位 → 非法
        expect(isTestFlowUuid('TC00t000e00s000t00a000l00o000w0000')).toBe(false);
        // 掩码位出现非预期字母（如第 7 位非 e）
        expect(isTestFlowUuid('TC00t000x00s000t00f000l00o000w0000')).toBe(false);
    });

    it('isValidTestcaseId 同时兼容标准 UUID / TC|MA+hex / 两类掩码', () => {
        expect(isValidTestcaseId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
        expect(isValidTestcaseId(`TC${HEX32}`)).toBe(true);
        expect(isValidTestcaseId(`MA${HEX32}`)).toBe(true);
        expect(isValidTestcaseId(AGENT_ID)).toBe(true);
        expect(isValidTestcaseId(FLOW_ID)).toBe(true);
        expect(isValidTestcaseId('garbage')).toBe(false);
    });

    it('FORMAT_VALIDATOR 放行 testagent / testflow 掩码 uuid（不判非法格式）', () => {
        expect(collectInvalidFormatFailures([row(AGENT_ID)], idx)).toHaveLength(0);
        expect(collectInvalidFormatFailures([row(FLOW_ID)], idx)).toHaveLength(0);
    });

    it('stepPreValidate 不剔除掩码 uuid 行，并入正常推送', async () => {
        const ctx = {
            telemetryPrefix: 'push',
            fileExt: '.yaml',
            traceId: 't5',
            opts: { filePath: 'x.yaml', resolveRowIndex: (i: number) => i + 1 },
        } as any;
        const res = await stepPreValidate(ctx, [
            row(AGENT_ID),
            row(FLOW_ID),
            row('123e4567-e89b-12d3-a456-426614174000'),
        ]);
        expect(res.failures).toHaveLength(0);
        expect(res.droppedIndex.size).toBe(0);
    });
});
