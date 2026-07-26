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
    // bizReject 需早于 fieldInvalid："当前不支持案例来源" 应归为业务拒绝，而不是字段错误
    { category: 'bizReject',    patterns: /不支持|不允许|拒绝/i },
    // notFound 需早于 fieldInvalid："任务下未匹配到有效测试要点"、"案例路径错误未匹配到有效测试要点"
    // 里含"未匹配"，若先命中 fieldInvalid（"未"→"未填写"其实不含，但"路径"会走 field 抽取）会误分类
    { category: 'notFound',     patterns: /不存在|未找到|查无|未绑定|未匹配|not\s*found|404/i },
    // fieldInvalid：新增"不一致"（步骤描述与预期结果数量不一致）、"检查点"（案例检查点数为0）、
    // "无效"（数据中包含无效的案例来源/案例类型/案例优先级/案例默认执行方式）
    { category: 'fieldInvalid', patterns: /格式|不合法|非法|无效|必填|长度|字段|参数|param|invalid|格式错误|为空|不能为空|缺失|缺少|未填写|不一致|检查点/i },
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

/** 接口字段码（聚焦维度，覆盖推送接口主要入参字段）。
 *
 *  两层级别（由 FIELD_LEVEL 区分）：
 *   - interface：接口级公共参数（请求体顶层 / header），一次错 = 整批失败
 *     testTaskNo / subTestTaskId / artifactId / sourcePlatform / designer
 *   - case：caseList[] 行级字段，每行独立
 *     sourceId / testCasePath / testCaseName / ... / testType
 *
 *  区分两层的目的：避免接口级一次错误在 count 维度淹没行级字段真实分布
 *  （例：designer 无权限会导致 100 行全部失败，如果不分层，会远比 description:42 看起来严重）。
 */
export type PushInterfaceField =
    // ── 接口级公共参数（level=interface）──
    | 'testTaskNo'      // 测试任务编号（请求体顶层，必填）
    | 'subTestTaskId'   // 子任务Id（请求体顶层，必填）
    | 'artifactId'      // 产出物Id（请求体顶层，必填，<=500）
    | 'sourcePlatform'  // 案例来源平台（请求体顶层，TMS/RFWeb/CMBT_APP 等，必填）
    | 'designer'        // 设计人（header X-User-Id/X-User-Name 携带，<=200，必填）
    // ── caseList[] 行级字段（level=case）──
    | 'sourceId'        // 案例唯一标识 / testcase_id（必填）
    | 'testCasePath'    // 案例路径 / path（必填）
    | 'testCaseName'    // 案例名称 / name（必填）
    | 'testCaseDes'     // 案例描述
    | 'description'     // 步骤描述（必填）
    | 'expected'        // 预期结果（必填）
    | 'priority'        // 优先级
    | 'type'            // 案例类型
    | 'preCondition'    // 前置条件
    | 'keyFlag'         // 关键案例（是/否，必填）
    | 'projectDes'      // 项目说明
    | 'planExecNum'     // 计划执行次数
    | 'testType';       // 执行方式

/** 字段级别：interface=接口级公共参数（一次错=整批失败）；case=caseList 行级字段 */
export type PushFieldLevel = 'interface' | 'case';

/** 字段→级别映射表。与 PushInterfaceField 一一对应（TS 会强制盖全）。 */
const FIELD_LEVEL: Record<PushInterfaceField, PushFieldLevel> = {
    // interface
    testTaskNo: 'interface',
    subTestTaskId: 'interface',
    artifactId: 'interface',
    sourcePlatform: 'interface',
    designer: 'interface',
    // case
    sourceId: 'case',
    testCasePath: 'case',
    testCaseName: 'case',
    testCaseDes: 'case',
    description: 'case',
    expected: 'case',
    priority: 'case',
    type: 'case',
    preCondition: 'case',
    keyFlag: 'case',
    projectDes: 'case',
    planExecNum: 'case',
    testType: 'case',
};

/** 查字段级别（迭代完 FIELD_LEVEL 后外部调用入口） */
export function fieldLevelOf(field: PushInterfaceField): PushFieldLevel {
    return FIELD_LEVEL[field];
}

/**
 * 接口字段 → 别名（中英文，后端报错可能用任一种）。
 * 顺序即优先级：把含 "案例" 前缀、更具体的短语排在前面，避免被通用别名抢先。
 */
const INTERFACE_FIELD_ALIASES: Array<{ field: PushInterfaceField; aliases: RegExp }> = [
    // ──── 接口级公共参数（优先匹配，避免被 "名称/路径" 等行级别名抢先） ────
    // testTaskNo：后端错误 "测试任务编号...不能为空/未匹配到有效阶段信息"
    { field: 'testTaskNo',     aliases: /testTaskNo|test_task_no|测试任务编号|任务编号/ },
    // subTestTaskId：后端错误 "子任务Id...不能为空"
    { field: 'subTestTaskId',  aliases: /subTestTaskId|sub_test_task_id|subTaskId|子任务\s*[Ii][dD]|子任务/ },
    // artifactId：后端错误 "产出物Id不能为空/长度不能超过500个字符"
    { field: 'artifactId',     aliases: /artifactId|artifact_id|产出物\s*[Ii][dD]|产出物/ },
    // designer：后端错误 "设计人不能为空/长度不能超过200个字符/设计人无权限"
    { field: 'designer',       aliases: /designer|设计人/ },

    // ──── caseList[] 行级字段 ────
    // sourceId 补 "案例来源Id"：后端错误 "案例来源Id不能为空/长度不能超过36个字符" 均指向该字段
    // 需排在 sourcePlatform 之前："案例来源Id" 应优先归到 sourceId，避免被 sourcePlatform 的"案例来源"抢先命中
    { field: 'sourceId',       aliases: /sourceId|testcase_id|testCaseId|案例来源\s*[Ii][dD]|案例唯一标识|案例标识|案例\s*id|案例ID/ },
    // sourcePlatform 案例来源平台：后端错误 "无效的案例来源(TMS/...)/当前不支持案例来源(...)" 均指向该字段
    { field: 'sourcePlatform', aliases: /sourcePlatform|source_platform|案例来源平台|案例来源(?![\s]*[Ii][dD])|来源平台/ },
    { field: 'testCasePath',   aliases: /testCasePath|案例路径|案例\s*path|路径/ },
    { field: 'testCaseName',   aliases: /testCaseName|案例名称|案例\s*name|名称/ },
    { field: 'testCaseDes',    aliases: /testCaseDes|案例描述/ },
    { field: 'description',    aliases: /description|步骤描述|步骤/ },
    // expected 补 "检查点"："案例检查点数为0请查看预期结果检查分类" 归到预期结果字段
    { field: 'expected',       aliases: /expected|预期结果|预期|检查点/ },
    { field: 'priority',       aliases: /priority|优先级/ },
    { field: 'type',           aliases: /\btype\b|案例类型/ },
    { field: 'preCondition',   aliases: /preCondition|前置条件/ },
    // 关键案例：接口字段名为 keyFlag，后端报错可能回“关键案例不能为空/格式不正确”
    { field: 'keyFlag',        aliases: /keyFlag|key_flag|关键案例/ },
    // 项目说明（projectDes）：caseList 实际字段，预留字段维度堆积
    { field: 'projectDes',     aliases: /projectDes|project_des|项目说明/ },
    // 计划执行次数（planExecNum）：caseList 实际字段，预留字段维度堆积
    { field: 'planExecNum',    aliases: /planExecNum|plan_exec_num|计划执行次数/ },
    // testType 补 "默认执行方式"：错误原文 "无效的案例默认执行方式"
    { field: 'testType',       aliases: /testType|默认执行方式|执行方式/ },
];

/** MapError.reason → 接口字段（客户端字段映射错误已知具体字段） */
const MAP_ERROR_REASON_TO_FIELD: Record<string, PushInterfaceField> = {
    missingTestcaseId: 'sourceId',
    missingOperation: 'description',
    missingStepDesc: 'description',
    invalidPath: 'testCasePath',
};

/** 字段相关 category（仅这些大类才有意义去聚焦到具体字段）
 *  包含 duplicate："sourceId 已存在/案例已存在" 也可能带具体字段（如 sourceId），
 *  应允许抽取，避免字段维度丢失重复类错误。 */
const FIELD_RELATED_CATEGORIES: PushFailCategory[] = ['fieldInvalid', 'mapError', 'placeholder', 'emptyTestcaseId', 'duplicate'];

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

/** 单条失败的字段统计（含原文样本，供 UI / 埋点）。level 区分接口级/行级，便于分层展示。 */
export interface FailureFieldStat {
    field: PushInterfaceField;
    level: PushFieldLevel;
    count: number;
    samples: string[];
}

/**
 * 按接口字段聚合（聚焦维度）。非字段类错误（field 为 undefined）不计入。
 * - 优先用 item.field；缺失时用 failureFieldOf 兜底（兼容历史/未贯通数据）；
 * - 同字段合并 count，保留最多 maxSamples 条不重复 reason 样本；
 * - 自动写入 level（接口级/行级），方便下游分层展示；
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
            stat = { field, level: FIELD_LEVEL[field], count: 0, samples: [] };
            buckets.set(field, stat);
        }
        stat.count++;
        if (stat.samples.length < maxSamples && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * 按字段级别（interface / case）拆分聚合结果，便于 UI 分两个 section 展示。
 * 两个子集内部保持原有 count 降序。
 */
export function splitFieldStatsByLevel(stats: FailureFieldStat[]): { interfaceStats: FailureFieldStat[]; caseStats: FailureFieldStat[] } {
    const interfaceStats: FailureFieldStat[] = [];
    const caseStats: FailureFieldStat[] = [];
    for (const s of stats || []) {
        (s.level === 'interface' ? interfaceStats : caseStats).push(s);
    }
    return { interfaceStats, caseStats };
}

/** 求某一层级中 count 最高的字段（用于埋点 topInterfaceFailField / topCaseFailField） */
export function topFieldOfLevel(stats: FailureFieldStat[], level: PushFieldLevel): FailureFieldStat | undefined {
    return (stats || []).find(s => s.level === level);
}

/**
 *  把字段聚合压成埋点友好紧凑串（field:count 逗号分隔），空聚合返回 ''。
 *  可选 level 参数：仅输出指定级别的字段（interface/case），便于埋点拆分为
 *  interfaceFieldBreakdown / caseFieldBreakdown 两个独立维度。不传时同归一串（兼容旧埋点）。
 */
export function summarizeFieldBreakdown(stats: FailureFieldStat[], level?: PushFieldLevel): string {
    return (stats || [])
        .filter(s => !level || s.level === level)
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
