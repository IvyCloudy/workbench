/**
 * ============================================================================
 *  utils/testcaseId.ts
 *  testcase_id（案例唯一标识）格式校验工具
 * ----------------------------------------------------------------------------
 *  约定（与 pushCore.stages.ts 的 TESTCASE_ID_PATTERN 保持一致）：
 *    - 标准 UUID：8-4-4-4-12 十六进制带连字符
 *    - TC/MA 前缀 + 32 位 uuid.hex
 *
 *  新增两类 TC 前缀"掩码 uuid"场景（对生成的 32 位 uuid.hex 的特定位数
 *  替换为固定字母串），用于兼容 testagent / testflow 生成的特殊 testcase_id：
 *    - 场景一（testagent）：位数 4 8 11 15 18 22 25 29 32 替换为 testagent
 *        e.g. TC000t000e00s000t00a000g00e000n00t
 *    - 场景二（testflow）：位数 4 8 11 15 18 22 25 29   替换为 testflow
 *        e.g. TC000t000e00s000t00f000l00o000w000
 *  上述两类校验方法独立导出，供推送预校验之外的场景（如绑定/关联）复用。
 * ============================================================================
 */

/** 标准 UUID / TC|MA + 32 位 hex */
const STANDARD_TESTCASE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(TC|MA)[0-9a-f]{32})$/i;

/**
 * 场景一：testagent 掩码 uuid。
 * 32 位 hex 中，以下位数（1-based，针对 TC 后的 32 位串）被 testagent 字母替换：
 *   3→t 7→e 10→s 14→t 17→a 21→g 24→e 28→n 31→t
 * 其余位数必须为十六进制 [0-9a-f]。
 * 标准样例：TC00t000e00s000t00a000g00e000n00t0
 */
const TEST_AGENT_UUID = /^TC[0-9a-f]{2}t[0-9a-f]{3}e[0-9a-f]{2}s[0-9a-f]{3}t[0-9a-f]{2}a[0-9a-f]{3}g[0-9a-f]{2}e[0-9a-f]{3}n[0-9a-f]{2}t[0-9a-f]$/i;

/**
 * 场景二：testflow 掩码 uuid。
 * 32 位 hex 中，以下位数（1-based，针对 TC 后的 32 位串）被 testflow 字母替换：
 *   3→t 7→e 10→s 14→t 17→f 21→l 24→o 28→w
 * 位数 31/32 仍为十六进制 [0-9a-f]（testflow 仅 8 个字母，不占用末两位）。
 * 标准样例：TC00t000e00s000t00f000l00o000w0000
 */
const TEST_FLOW_UUID = /^TC[0-9a-f]{2}t[0-9a-f]{3}e[0-9a-f]{2}s[0-9a-f]{3}t[0-9a-f]{2}f[0-9a-f]{3}l[0-9a-f]{2}o[0-9a-f]{3}w[0-9a-f]{4}$/i;

/** 判断是否为 testagent 掩码 uuid（TC 前缀，特定位数替换为 testagent）。 */
export function isTestAgentUuid(tsId: string | undefined | null): boolean {
    return typeof tsId === 'string' && TEST_AGENT_UUID.test(tsId.trim());
}

/** 判断是否为 testflow 掩码 uuid（TC 前缀，特定位数替换为 testflow）。 */
export function isTestFlowUuid(tsId: string | undefined | null): boolean {
    return typeof tsId === 'string' && TEST_FLOW_UUID.test(tsId.trim());
}

/** 标准 UUID 或 TC/MA + 32 位 hex（不含两类掩码 uuid）。 */
export function isStandardTestcaseId(tsId: string | undefined | null): boolean {
    return typeof tsId === 'string' && STANDARD_TESTCASE_ID.test(tsId.trim());
}

/**
 * 综合判定：testcase_id 是否合法。
 * 合法 = 标准 UUID / TC|MA+hex / testagent 掩码 / testflow 掩码。
 */
export function isValidTestcaseId(tsId: string | undefined | null): boolean {
    if (typeof tsId !== 'string') return false;
    const v = tsId.trim();
    return (
        STANDARD_TESTCASE_ID.test(v) ||
        isTestAgentUuid(v) ||
        isTestFlowUuid(v)
    );
}
