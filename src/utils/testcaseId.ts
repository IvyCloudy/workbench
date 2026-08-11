/**
 * ============================================================================
 *  utils/testcaseId.ts
 *  testcase_id（案例唯一标识）格式校验工具
 * ----------------------------------------------------------------------------
 *  约定（与 pushCore.stages.ts 的 TESTCASE_ID_PATTERN 保持一致）：
 *    - 标准 UUID：8-4-4-4-12 十六进制带连字符
 *    - TC/MA 前缀 + 32 位 uuid.hex
 *
 *  新增两类 TC 前缀"掩码 uuid"场景：其本质为"32 位 uuid.hex + 掩码"，
 *  即在生成的 32 位 uuid hex 基础上，把特定位数替换为固定字母串，
 *  用于兼容 testagent / testflow 生成的特殊 testcase_id：
 *    - 场景一（testagent）：位数 3 7 10 14 17 21 24 28 31 替换为 testagent（body 共 32 位，第 32 位为 hex）
 *        e.g. TC00t000e00s000t00a000g00e000n00t0
 *    - 场景二（testflow）：位数 3 7 10 14 17 21 24 28    替换为 testflow（body 共 32 位，第 28 位 w 后另有 4 位 hex）
 *        e.g. TC00t000e00s000t00f000l00o000w0000
 *  掩码位的字母固定（大小写严格），非掩码位必须是十六进制 [0-9a-f]，
 *  即整串 = TC + 一段"32 位 uuid hex，其中特定位被固定字母覆盖"（testagent / testflow 总长均为 34）。
 *  上述两类校验方法独立导出，供推送预校验之外的场景（如绑定/关联）复用。
 * ============================================================================
 */

/** 标准 UUID / TC|MA + 32 位 hex */
const STANDARD_TESTCASE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(TC|MA)[0-9a-f]{32})$/i;

/**
 * 掩码 uuid 核心判定：TC 前缀 + 一段"uuid hex，其中特定 1-based 位被固定字母覆盖"。
 *
 * 注意：掩码字母 testagent / testflow 中，e/a/f 本身落在十六进制 a-f 区间内，
 * 因此绝不能把"非掩码位"用 [0-9a-f] 去兜底——否则 e/a/f 等掩码位即使没被 maskMap
 * 命中也会蒙混过关。正确做法是：依据 maskMap 逐位校验（掩码位=固定字母，其余位=hex），
 * 且总长度严格等于 len（TC 后的总位数，即 32 位 hex 串，testagent/testflow 均为 32）。
 *
 * 这样明确体现"uuid + 掩码"语义：长度不对、掩码位字母不对、非掩码位非 hex 都直接 false。
 *
 * @param len TC 后的总位数（掩码位 + hex 位之和），例如 32
 */
function isMaskedUuid(tsId: string, maskMap: Record<number, string>, len: number): boolean {
    if (typeof tsId !== 'string') return false;
    const v = tsId.trim();
    // 前缀必须是大写的 TC（掩码 uuid 约定前缀，严格匹配，不加 i 标志）
    if (v.slice(0, 2) !== 'TC') return false;
    const body = v.slice(2);
    // 总位数必须严格等于 len（不能只看 maskMap 最大位，否则末尾 hex 位被忽略）
    if (body.length !== len) return false;
    // 逐位校验：掩码位=固定字母（大小写严格），非掩码位=十六进制（大小写严格，不用 i）
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        const pos = i + 1; // 1-based
        const expected = maskMap[pos];
        if (expected) {
            if (ch !== expected) return false;
        } else {
            if (!/^[0-9a-f]$/.test(ch)) return false;
        }
    }
    return true;
}

// 场景一（testagent）掩码位映射（1-based，针对 TC 后的 32 位 hex 串）
//   testagent 共 9 个字母，嵌在 32 位 hex 中：掩码位 3/7/10/14/17/21/24/28/31，第 32 位仍为 hex：
//   3→t 7→e 10→s 14→t 17→a 21→g 24→e 28→n 31→t（32 位未覆盖，为 hex）
//   例：TC00t000e00s000t00a000g00e000n00t0
const TEST_AGENT_MASK: Record<number, string> = {
    3: 't', 7: 'e', 10: 's', 14: 't', 17: 'a', 21: 'g', 24: 'e', 28: 'n', 31: 't',
};

// 场景二（testflow）掩码位映射（1-based，针对 TC 后的 32 位 hex 串）
//   testflow 共 8 个字母，嵌在 32 位 hex 中（28→w 之后仍有 4 位 hex 29-32）：
//   3→t 7→e 10→s 14→t 17→f 21→l 24→o 28→w
//   例：TC00t000e00s000t00f000l00o000w0000
const TEST_FLOW_MASK: Record<number, string> = {
    3: 't', 7: 'e', 10: 's', 14: 't', 17: 'f', 21: 'l', 24: 'o', 28: 'w',
};

/** 判断是否为 testagent 掩码 uuid（TC 前缀 + 32 位串，特定位替换为 testagent）。 */
export function isTestAgentUuid(tsId: string | undefined | null): boolean {
    return isMaskedUuid(tsId as string, TEST_AGENT_MASK, 32);
}

/** 判断是否为 testflow 掩码 uuid（TC 前缀 + 32 位串，特定位替换为 testflow）。 */
export function isTestFlowUuid(tsId: string | undefined | null): boolean {
    return isMaskedUuid(tsId as string, TEST_FLOW_MASK, 32);
}

/** 标准 UUID 或 TC/MA + 32 位 hex（不含两类掩码 uuid）。 */
export function isStandardTestcaseId(tsId: string | undefined | null): boolean {
    return typeof tsId === 'string' && STANDARD_TESTCASE_ID.test(tsId.trim());
}

/**
 * 综合判定：testcase_id 是否合法。
 * 合法 = 标准 UUID / TC|MA+hex / testagent 掩码(uuid+掩码) / testflow 掩码(uuid+掩码)。
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
