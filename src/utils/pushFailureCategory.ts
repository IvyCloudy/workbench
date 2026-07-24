/**
 * ============================================================================
 *  utils/pushFailureCategory.ts
 *  推送失败分类（展示用原文 reason，统计/埋点用稳定 category code）
 * ----------------------------------------------------------------------------
 *  为什么需要本文件：
 *    后端返回的失败 reason 是自由中文长文本（措辞多变、长度大、无稳定分类），
 *    既无法聚合统计，也容易撑爆埋点 8KB payload 上限。
 *    本文件统一提供「分类枚举 + 归类器 + 聚合器」三层能力：
 *      - 客户端预校验（占位/空 tsId/样例）与字段映射错误（MapError）已是结构化信号，
 *        直接映射为 category，零改造；
 *      - 后端中文长文本用关键词/正则归类为稳定 category；
 *      - 聚合器把多条失败按 category 分桶，统计 count 并保留少量原文样本，
 *        供 onComplete 弹窗「按错误类型分组」展示 + 埋点维度。
 *
 *  设计要点：
 *    - reason（中文原文）只作「展示」，category（英文短码）只作「统计/埋点」。
 *      二者解耦：用户仍看到完整中文，统计/埋点只看稳定 code，既准又省 payload。
 *    - 新增后端错误类型：只需在 BACKEND_CATEGORY_RULES 加一条规则 + 枚举加一个值，
 *      不改持久化结构、不改埋点字段。
 * ============================================================================
 */

// ============================================
// 分类枚举
// ============================================

/**
 * 推送失败分类码。取值稳定、可枚举，供统计聚合与埋点维度使用（不建议改命名）。
 */
export type PushFailCategory =
    // —— 客户端预校验（已有结构化信号，直接复用）——
    | 'placeholder'          // testcase_id 为占位值 TESTCASE_ID
    | 'emptyTestcaseId'      // testcase_id 为空
    | 'sample'               // 样例占位数据（'案例唯一标识，不可修改' 等）
    | 'mapError'             // 字段映射错误（缺 testcase_id / 步骤缺 operation / 缺步骤描述 / 路径非法）
    // —— 后端失败（自由中文文本，需关键词归类）——
    | 'network'              // 网络/超时
    | 'auth'                 // 鉴权/权限/未登录
    | 'duplicate'            // 重复/已存在
    | 'fieldInvalid'         // 字段不合法/格式错误/参数错误
    | 'notFound'             // 不存在/未找到/未绑定
    | 'serverError'          // 服务端异常/5xx
    | 'bizReject'            // 其他明确业务拒绝
    | 'unknown';             // 兜底（无法归类的后端文本）

// ============================================
// 结构化信号 → category 的映射表
// ============================================

/** RowValidator.kind → category（占位/空 tsId 用） */
const VALIDATOR_KIND_TO_CATEGORY: Record<string, PushFailCategory> = {
    placeholder: 'placeholder',
    empty: 'emptyTestcaseId',
    invalidFormat: 'fieldInvalid',
};

/** MapErrorFields.reason → category（字段映射错误用） */
const MAP_ERROR_REASON_TO_CATEGORY: Record<string, PushFailCategory> = {
    missingTestcaseId: 'mapError',
    missingOperation: 'mapError',
    missingStepDesc: 'mapError',
    invalidPath: 'mapError',
};

/**
 * 后端中文长文本 → category 的归类规则（顺序即优先级，先命中先生效）。
 * 关键词聚焦「错误类型」而非具体业务措辞，保证措辞变体也能稳定归类。
 */
const BACKEND_CATEGORY_RULES: Array<{ category: PushFailCategory; patterns: RegExp }> = [
    { category: 'network',      patterns: /超时|timeout|网络|连接失败|ECONN|connect|socket/i },
    { category: 'auth',         patterns: /鉴权|权限|未登录|token|无权限|登录|认证|unauthorized|forbidden|401|403/i },
    { category: 'duplicate',    patterns: /已存在|重复|duplicate|already|冲突|conflict/i },
    { category: 'fieldInvalid', patterns: /格式|不合法|非法|必填|长度|字段|参数|param|invalid|格式错误|为空|不能为空|缺失|缺少|未填写/i },
    { category: 'notFound',     patterns: /不存在|未找到|查无|未绑定|not\s*found|404/i },
    { category: 'serverError',  patterns: /服务[器端]?|5\d\d|系统异常|内部错误|5xx|server\s*error/i },
];

// ============================================
// 归类器
// ============================================

/**
 * 归类一条后端失败（自由中文文本）。
 * 命中规则返回对应 category；都不命中返回 'unknown'。
 */
export function classifyBackendFailure(text: string): PushFailCategory {
    const s = text || '';
    for (const rule of BACKEND_CATEGORY_RULES) {
        if (rule.patterns.test(s)) return rule.category;
    }
    return 'unknown';
}

/**
 * 统一归类入口：优先用已有的结构化信号（validatorKind / mapErrorReason），
 * 否则走中文文本归类。这样预校验/映射错误与后端文本走同一条归类链路，
 * 统计口径完全一致。
 */
export function classifyFailure(input: {
    reason: string;
    validatorKind?: string;
    mapErrorReason?: string;
}): PushFailCategory {
    if (input.validatorKind && VALIDATOR_KIND_TO_CATEGORY[input.validatorKind]) {
        return VALIDATOR_KIND_TO_CATEGORY[input.validatorKind];
    }
    if (input.mapErrorReason && MAP_ERROR_REASON_TO_CATEGORY[input.mapErrorReason]) {
        return MAP_ERROR_REASON_TO_CATEGORY[input.mapErrorReason];
    }
    return classifyBackendFailure(input.reason);
}

// ============================================
// 接口字段聚焦（必填字段维度）
// ============================================
// 后端字段类错误往往点名具体接口字段（如 "sourceId 不能为空" / "案例名称为空"）。
// 仅靠 fieldInvalid 看不出是哪个字段，故额外抽取「接口字段码」维度（field），
// 与 category 正交：category 表示"错误大类"，field 表示"命中的接口字段"。
// 该维度用于埋点 failFieldBreakdown + 前端"按字段引导纠错"。

/** 接口 caseList 字段码（聚焦维度，覆盖推送接口主要入参字段） */
export type PushInterfaceField =
    | 'sourceId'        // 案例唯一标识 / testcase_id（必填）
    | 'testCasePath'    // 案例路径 / path（必填）
    | 'testCaseName'    // 案例名称 / name（必填）
    | 'testCaseDes'     // 案例描述
    | 'description'     // 步骤描述（必填）
    | 'expected'        // 预期结果（必填）
    | 'priority'        // 优先级
    | 'type'            // 案例类型
    | 'preCondition'    // 前置条件
    | 'testType';       // 执行方式

/**
 * 接口字段 → 别名（中英文，后端报错可能用任一种）。
 * 顺序即优先级：把含 "案例" 前缀、更具体的短语排在前面，避免被通用别名抢先。
 */
const INTERFACE_FIELD_ALIASES: Array<{ field: PushInterfaceField; aliases: RegExp }> = [
    { field: 'sourceId',     aliases: /sourceId|testcase_id|testCaseId|案例唯一标识|案例标识|案例\s*id|案例ID/ },
    { field: 'testCasePath', aliases: /testCasePath|案例路径|案例\s*path|路径/ },
    { field: 'testCaseName', aliases: /testCaseName|案例名称|案例\s*name|名称/ },
    { field: 'testCaseDes',  aliases: /testCaseDes|案例描述/ },
    { field: 'description',  aliases: /description|步骤描述|步骤/ },
    { field: 'expected',     aliases: /expected|预期结果|预期/ },
    { field: 'priority',     aliases: /priority|优先级/ },
    { field: 'type',         aliases: /\btype\b|案例类型/ },
    { field: 'preCondition', aliases: /preCondition|前置条件/ },
    { field: 'testType',     aliases: /testType|执行方式/ },
];

/** MapError.reason → 接口字段（客户端字段映射错误已知具体字段） */
const MAP_ERROR_REASON_TO_FIELD: Record<string, PushInterfaceField> = {
    missingTestcaseId: 'sourceId',
    missingOperation: 'description',
    missingStepDesc: 'description',
    invalidPath: 'testCasePath',
};

/** 字段相关 category（仅这些大类才有意义去聚焦到具体字段） */
const FIELD_RELATED_CATEGORIES: PushFailCategory[] = ['fieldInvalid', 'mapError', 'placeholder', 'emptyTestcaseId'];

/**
 * 从自由文本抽取接口字段码（仅基于 reason 关键词）。命中返回字段码；否则 undefined。
 * 用于后端中文错误文本定位到具体必填字段。
 */
export function extractInterfaceField(text: string): PushInterfaceField | undefined {
    const s = text || '';
    for (const f of INTERFACE_FIELD_ALIASES) {
        if (f.aliases.test(s)) return f.field;
    }
    return undefined;
}

/**
 * 统一字段聚焦入口：优先用结构化信号（mapErrorReason / validatorKind），
 * 否则仅在"字段相关大类"错误中才从 reason 抽取字段码，避免 network/auth 等
 * 文本偶含别名（如鉴权文案里出现"名称"）被误打上错误字段。
 */
export function failureFieldOf(input: {
    reason?: string;
    validatorKind?: string;
    mapErrorReason?: string;
}): PushInterfaceField | undefined {
    if (input.mapErrorReason && MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason]) {
        return MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason];
    }
    // 占位 / 空 tsId 本质是 sourceId（testcase_id）字段问题
    if (input.validatorKind && VALIDATOR_KIND_TO_CATEGORY[input.validatorKind]) {
        return 'sourceId';
    }
    const cat = classifyFailure({
        reason: input.reason || '',
        validatorKind: input.validatorKind,
        mapErrorReason: input.mapErrorReason,
    });
    if (FIELD_RELATED_CATEGORIES.includes(cat)) {
        return extractInterfaceField(input.reason || '');
    }
    return undefined;
}

/** 单条失败的字段统计（含原文样本，供 UI / 埋点） */
export interface FailureFieldStat {
    field: PushInterfaceField;
    count: number;
    samples: string[];
}

/**
 * 按接口字段聚合（聚焦维度）。非字段类错误（field 为 undefined）不计入。
 * - 优先用 item.field；缺失时用 failureFieldOf 兜底（兼容历史/未贯通数据）；
 * - 同字段合并 count，保留最多 maxSamples 条不重复 reason 样本；
 * - 返回按 count 降序。
 */
export function aggregateByField(
    items: Array<{ reason: string; field?: PushInterfaceField; category?: PushFailCategory; validatorKind?: string; mapErrorReason?: string }>,
    maxSamples = 2,
): FailureFieldStat[] {
    const buckets = new Map<PushInterfaceField, FailureFieldStat>();
    for (const it of items || []) {
        const reason = it.reason || '';
        const field = it.field
            ?? failureFieldOf({ reason, validatorKind: it.validatorKind, mapErrorReason: it.mapErrorReason });
        if (!field) continue;
        let stat = buckets.get(field);
        if (!stat) {
            stat = { field, count: 0, samples: [] };
            buckets.set(field, stat);
        }
        stat.count++;
        if (stat.samples.length < maxSamples && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/** 把字段聚合压成埋点友好紧凑串（field:count 逗号分隔），空聚合返回 '' */
export function summarizeFieldBreakdown(stats: FailureFieldStat[]): string {
    return (stats || [])
        .map(s => `${s.field}:${s.count}`)
        .join(',');
}

// ============================================
// 聚合器
// ============================================

/** 单条失败的分类统计（已含若干原文样本，供 UI 展示与埋点 sample） */
export interface FailureCategoryStat {
    category: PushFailCategory;
    count: number;
    samples: string[];
}

/**
 * 把一组失败按 category 分桶聚合。
 * - 同 category 多条时合并 count，并保留最多 maxSamples 条不重复的 reason 原文样本；
 * - 未带 category 的项用 classifyFailure 兜底归类（兼容历史数据/未贯通场景）；
 * - 返回结果按 count 降序，便于「Top 失败类型」展示与埋点 topFailCategory。
 */
export function aggregateFailures(
    items: Array<{ reason: string; category?: PushFailCategory; validatorKind?: string; mapErrorReason?: string }>,
    maxSamples = 2,
): FailureCategoryStat[] {
    const buckets = new Map<PushFailCategory, FailureCategoryStat>();
    for (const it of items || []) {
        const reason = it.reason || '';
        const cat = it.category
            || classifyFailure({ reason, validatorKind: it.validatorKind, mapErrorReason: it.mapErrorReason });
        let stat = buckets.get(cat);
        if (!stat) {
            stat = { category: cat, count: 0, samples: [] };
            buckets.set(cat, stat);
        }
        stat.count++;
        if (stat.samples.length < maxSamples && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * 把聚合结果压成埋点友好的紧凑字符串（category:count 逗号分隔）。
 * 例："network:3,auth:1"。空聚合返回 ''。
 */
export function summarizeCategoryBreakdown(stats: FailureCategoryStat[]): string {
    return (stats || [])
        .map(s => `${s.category}:${s.count}`)
        .join(',');
}
