/**
 * pushCore.enumTypeValidators.test.ts —— B2 枚举/类型校验器专项单测
 * ----------------------------------------------------------------------------
 * 需求：《案例推送前置校验-待补充拦截需求文档》2.3.3 / 2.3.4 / 2.4.2 / 验收要点 2、6、8
 *
 * 覆盖点：
 *   1) ENUM_VALIDATOR：4 类枚举字段（type / test_type / priority / key_flag）
 *      - YAML 键 & CSV 中文列双通道识别
 *      - 值合法 → 不命中；值非法 → severity=error + reason 含合法集合
 *      - 值为空串（`type: ""`）→ 判为不合法（需求 2.3.3）
 *      - 字段完全缺省（yaml 键 & csv 列都 undefined）→ 跳过（兼容旧文件）
 *      - 同行多字段命中 → 汇总为一条 failure（reason 列出全部命中字段）
 *   2) PLAN_EXEC_NUM_VALIDATOR：计划执行次数类型/非负整数
 *      - 数值 / 字符串数字 → 合法（含 "0"）
 *      - 空串 / 非数字字符 / 负数 / 小数 → 不合法
 *      - 字段完全缺省 → 跳过（兼容旧文件）
 *   3) 端到端：stepPreValidate 结束后 failures 中含 error 级新 kind，
 *      droppedIndex 剔除对应行；与 warn 级「待补充」跨行共存。
 */

import { describe, it, expect, vi } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import {
    ENUM_VALIDATOR,
    PLAN_EXEC_NUM_VALIDATOR,
    TYPE_VALUES,
    TEST_TYPE_VALUES,
    PRIORITY_VALUES,
    KEY_FLAG_VALUES,
} from '../handlers/pushCore.enumTypeValidators';import { runValidators, stepPreValidate, DEFAULT_VALIDATORS } from '../handlers/pushCore.stages';
import type { PushContext } from '../handlers/pushCore.types';

// Mock 掉 telemetry 与 pushFailureStore：
//   · telemetry：stepPreValidate 会同步发送埋点事件，真实实现依赖 vscode.env
//   · pushFailureStore：高亮持久化会走文件系统 IO，测试关注纯校验产物即可
vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));
vi.mock('../utils/pushFailureStore', () => ({
    persistPushFailures: vi.fn(async () => {}),
}));

const VALID_TSID_1 = '11111111-1111-1111-1111-111111111111';
const VALID_TSID_2 = '22222222-2222-2222-2222-222222222222';

const ctx = (): PushContext => ({
    opts: {
        extensionContext: {} as any,
        filePath: '/tmp/tt/b2.yaml',
        rows: [],
        resolveRowIndex: (i: number) => i + 1,
        hooks: {} as any,
        telemetryPrefix: 'push',
    },
    traceId: 't-b2',
    pushStart: Date.now(),
    fileExt: '.yaml',
    telemetryPrefix: 'push',
    hooks: {} as any,
});

describe('B2 枚举字段校验（ENUM_VALIDATOR · error）', () => {
    it('合法值（type / test_type / priority / key_flag 均落在允许集合内）→ 不命中', () => {
        const hit = ENUM_VALIDATOR.check(
            { type: '功能点类', test_type: '手工', priority: '高', key_flag: '是' } as any,
            VALID_TSID_1,
        );
        expect(hit).toBeNull();
    });

    it('非法值（type="错误取值"）→ severity=error，reason 含合法集合', () => {
        const hit = ENUM_VALIDATOR.check(
            { type: '错误取值', test_type: '手工', priority: '高', key_flag: '是' } as any,
            VALID_TSID_1,
        );
        expect(hit).not.toBeNull();
        expect(hit!.field).toBe('type');
        expect(hit!.reason).toContain('案例类型="错误取值"');
        // reason 中应体现合法取值集合，便于用户修正
        TYPE_VALUES.forEach(v => expect(hit!.reason).toContain(v));
    });

    it('空串值（`type: ""` 场景）→ 判为不合法（需求 2.3.3）', () => {
        const hit = ENUM_VALIDATOR.check(
            { type: '', test_type: '手工', priority: '高', key_flag: '是' } as any,
            VALID_TSID_1,
        );
        expect(hit).not.toBeNull();
        expect(hit!.field).toBe('type');
        expect(hit!.reason).toContain('案例类型=空');
    });

    it('字段完全缺省（key 都不存在）→ 跳过校验（兼容旧文件）', () => {
        // 空对象只有 tsId，一个枚举字段都没有 —— 应该跳过所有枚举检查
        const hit = ENUM_VALIDATOR.check({} as any, VALID_TSID_1);
        expect(hit).toBeNull();
    });

    it('部分缺省 + 部分非法 → 只报非法的字段', () => {
        // 仅 priority 存在但非法，其余字段完全缺省
        const hit = ENUM_VALIDATOR.check({ priority: 'urgent' } as any, VALID_TSID_1);
        expect(hit).not.toBeNull();
        expect(hit!.field).toBe('priority');
        expect(hit!.reason).toContain('优先级="urgent"');
        // 不应误报其他缺省字段
        expect(hit!.reason).not.toContain('案例类型');
        expect(hit!.reason).not.toContain('执行方式');
        expect(hit!.reason).not.toContain('关键标识');
    });

    it('CSV 中文列名（「案例类型」/「执行方式」/「优先级」/「关键标识」）也被识别', () => {
        const hit = ENUM_VALIDATOR.check(
            { '案例类型': '功能点类', '执行方式': '手工', '优先级': '中', '关键标识': '0' } as any,
            VALID_TSID_1,
        );
        expect(hit).toBeNull(); // 全合法 → 不命中
    });

    it('CSV 列存在但取值非法 → 命中并显式字段名', () => {
        const hit = ENUM_VALIDATOR.check(
            { '执行方式': '半自动' } as any,
            VALID_TSID_1,
        );
        expect(hit).not.toBeNull();
        expect(hit!.field).toBe('testType');
        expect(hit!.reason).toContain('执行方式="半自动"');
    });

    it('同行多字段非法 → 汇总为一条 failure，reason 列出全部命中字段', () => {
        const hit = ENUM_VALIDATOR.check(
            { type: '错', test_type: '半自动', priority: '紧急', key_flag: '也许' } as any,
            VALID_TSID_1,
        );
        expect(hit).not.toBeNull();
        expect(hit!.reason).toContain('案例类型');
        expect(hit!.reason).toContain('执行方式');
        expect(hit!.reason).toContain('优先级');
        expect(hit!.reason).toContain('关键标识');
        // primaryField 取第一个命中字段（type → 'type'）
        expect(hit!.field).toBe('type');
    });

    it('YAML 键与 CSV 键都存在时 —— YAML 键优先', () => {
        // yaml 键值合法、csv 键值非法 → 以 yaml 为准，不命中
        const hit = ENUM_VALIDATOR.check(
            { priority: '高', '优先级': '错' } as any,
            VALID_TSID_1,
        );
        expect(hit).toBeNull();
    });
});

describe('B2 关键标识（key_flag）—— 4 种合法写法都支持', () => {
    it.each(KEY_FLAG_VALUES.map(v => [v]))('key_flag="%s" → 合法', (val) => {
        const hit = ENUM_VALIDATOR.check({ key_flag: val } as any, VALID_TSID_1);
        expect(hit).toBeNull();
    });

    it('key_flag=2 → 不合法', () => {
        const hit = ENUM_VALIDATOR.check({ key_flag: '2' } as any, VALID_TSID_1);
        expect(hit).not.toBeNull();
        expect(hit!.field).toBe('keyFlag');
    });
});

describe('B2 执行方式 / 优先级 —— 参数化覆盖所有合法值', () => {
    it.each(TEST_TYPE_VALUES.map(v => [v]))('test_type="%s" → 合法', (val) => {
        expect(ENUM_VALIDATOR.check({ test_type: val } as any, VALID_TSID_1)).toBeNull();
    });
    it.each(PRIORITY_VALUES.map(v => [v]))('priority="%s" → 合法', (val) => {
        expect(ENUM_VALIDATOR.check({ priority: val } as any, VALID_TSID_1)).toBeNull();
    });
});

describe('B2 计划执行次数校验（PLAN_EXEC_NUM_VALIDATOR · error）', () => {
    it('数值型：整数 0 / 1 / 100 均合法', () => {
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 0 } as any, VALID_TSID_1)).toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 1 } as any, VALID_TSID_1)).toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 100 } as any, VALID_TSID_1)).toBeNull();
    });

    it('字符串数字："0" / "3" 合法（CSV / 部分 YAML parser 场景）', () => {
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '0' } as any, VALID_TSID_1)).toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ '计划执行次数': '3' } as any, VALID_TSID_1)).toBeNull();
    });

    it('空串 / 空白字符 → 不合法', () => {
        const h1 = PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '' } as any, VALID_TSID_1);
        const h2 = PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '   ' } as any, VALID_TSID_1);
        expect(h1).not.toBeNull();
        expect(h2).not.toBeNull();
        expect(h1!.field).toBe('planExecNum');
        expect(h1!.reason).toContain('应为非负整数');
    });

    it('文本 / 负数 / 小数 → 不合法', () => {
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 'abc' } as any, VALID_TSID_1)).not.toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '-1' } as any, VALID_TSID_1)).not.toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: -1 } as any, VALID_TSID_1)).not.toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '1.5' } as any, VALID_TSID_1)).not.toBeNull();
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 1.5 } as any, VALID_TSID_1)).not.toBeNull();
        // 科学计数法虽然是合法 number，但按"非负整数"约束仍应通过（100 是整数）
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: 1e2 } as any, VALID_TSID_1)).toBeNull();
        // 但字符串 "1e2" 走字符串纯数字正则不通过 → 不合法
        expect(PLAN_EXEC_NUM_VALIDATOR.check({ plan_exec_num: '1e2' } as any, VALID_TSID_1)).not.toBeNull();
    });

    it('字段完全缺省（yaml 键 & csv 列都 undefined）→ 跳过（兼容旧文件）', () => {
        const hit = PLAN_EXEC_NUM_VALIDATOR.check({} as any, VALID_TSID_1);
        expect(hit).toBeNull();
    });
});

describe('B2 端到端：runValidators / stepPreValidate 集成', () => {
    it('DEFAULT_VALIDATORS 包含 B2 error 校验器且顺序正确（error → warn）', () => {
        const kinds = DEFAULT_VALIDATORS.map(v => v.kind);
        // 顺序：placeholder → empty → invalidFormat → enumInvalid → planExecNumInvalid → todoPlaceholder
        expect(kinds.indexOf('enumInvalid')).toBeGreaterThan(kinds.indexOf('invalidFormat'));
        expect(kinds.indexOf('planExecNumInvalid')).toBeGreaterThan(kinds.indexOf('enumInvalid'));
        expect(kinds.indexOf('todoPlaceholder')).toBeGreaterThan(kinds.indexOf('planExecNumInvalid'));
    });

    it('runValidators：非法枚举 → severity=error 且加入 droppedIndex（行被剔除）', () => {
        const rows = [
            { [TS_ID_COLUMN]: VALID_TSID_1, type: '错误取值' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['enumInvalid']).toHaveLength(1);
        expect(failuresByKind['enumInvalid']![0].severity).toBe('error');
        expect(failuresByKind['enumInvalid']![0].field).toBe('type');
        expect(droppedIndex.has(0)).toBe(true);
    });

    it('runValidators：非法计划执行次数 → severity=error，category=planExecNum.format', () => {
        const rows = [
            { [TS_ID_COLUMN]: VALID_TSID_1, plan_exec_num: 'abc' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['planExecNumInvalid']).toHaveLength(1);
        expect(failuresByKind['planExecNumInvalid']![0].severity).toBe('error');
        expect(failuresByKind['planExecNumInvalid']![0].category).toBe('planExecNum.format');
        expect(failuresByKind['planExecNumInvalid']![0].field).toBe('planExecNum');
        expect(droppedIndex.has(0)).toBe(true);
    });

    it('跨行：error 行（枚举非法）与 warn 行（「待补充」）共存', () => {
        const rows = [
            // 行 1：枚举非法（error 级，剔除）
            { [TS_ID_COLUMN]: VALID_TSID_1, type: '错' },
            // 行 2：仅「待补充」（warn 级，保留）
            { [TS_ID_COLUMN]: VALID_TSID_2, description: '这里「待补充」' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['enumInvalid']).toHaveLength(1);
        expect(failuresByKind['todoPlaceholder']).toHaveLength(1);
        // 只剔除 error 行；warn 行仍进入 payload
        expect(droppedIndex.has(0)).toBe(true);
        expect(droppedIndex.has(1)).toBe(false);
    });

    it('同一行叠加：error（枚举）+ warn（「待补充」）都被完整收集', () => {
        // v2 语义（多问题暴露）：非 tsId 硬失败的 validator 不再 break，
        // 因此同一行的 enumInvalid + todoPlaceholder 都会进入 failuresByKind。
        // 该行仍属被剔除（因为有 error），但两条问题都会展示给用户，方便一次性修复。
        const rows = [
            { [TS_ID_COLUMN]: VALID_TSID_1, type: '错', description: '「待补充」' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['enumInvalid']).toHaveLength(1);
        expect(failuresByKind['todoPlaceholder']).toHaveLength(1);
        // Set 去重保证同一行只入 droppedIndex 一次
        expect(droppedIndex.size).toBe(1);
        expect(droppedIndex.has(0)).toBe(true);
    });

    it('同一行叠加多类 error：enumInvalid + planExecNumInvalid 都被完整收集', () => {
        // 该行同时命中枚举字段非法 + 计划执行次数非法，二者都是 error 级；
        // 期望：两个 kind 各出一条 failure；该行被剔除但 droppedIndex 只加一次。
        const rows = [
            { [TS_ID_COLUMN]: VALID_TSID_1, type: '错', plan_exec_num: 'abc' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['enumInvalid']).toHaveLength(1);
        expect(failuresByKind['planExecNumInvalid']).toHaveLength(1);
        expect(droppedIndex.size).toBe(1);
    });

    it('tsId 层硬失败（invalidFormat）→ 不再扫后续 validator（避免噪音）', () => {
        // tsId 本身格式非法 → 后续基于 tsId 的字段级问题无意义，跳过扫描。
        // 期望：只有 invalidFormat 一条；enumInvalid / todoPlaceholder 都不产出。
        const rows = [
            { [TS_ID_COLUMN]: 'not-a-uuid', type: '错', description: '「待补充」' },
        ];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['invalidFormat']).toHaveLength(1);
        expect(failuresByKind['enumInvalid'] ?? []).toHaveLength(0);
        expect(failuresByKind['todoPlaceholder'] ?? []).toHaveLength(0);
    });

    it('stepPreValidate：新 kind 会进入最终 failures 列表且 severity=error', async () => {
        // 不直接 spy persistPushFailures（ES module 只读属性），仅验证 stepPreValidate 的返回结构：
        //   · failures 汇总里应包含 enumInvalid + planExecNumInvalid 两条 error 级项；
        //   · byKind 里两类 kind 分别独立汇总，供 stepPreValidate 内的高亮持久化消费。
        // 持久化实际是否落盘由 pushCore.stages.ts 内的
        // `highlightFailures = [...formatFailures, ...enumInvalidFailures, ...planExecNumFailures, ...]`
        // 静态代码保证，无需在测试中再重复验证 IO 副作用。
        const rows = [
            { [TS_ID_COLUMN]: VALID_TSID_1, type: '错' },
            { [TS_ID_COLUMN]: VALID_TSID_2, plan_exec_num: 'abc' },
        ];
        const res = await stepPreValidate(ctx(), rows as any);
        expect(res.failures).toHaveLength(2);
        expect(res.failures.every(f => f.severity === 'error')).toBe(true);
        expect(res.byKind['enumInvalid']).toHaveLength(1);
        expect(res.byKind['planExecNumInvalid']).toHaveLength(1);
    });
});
