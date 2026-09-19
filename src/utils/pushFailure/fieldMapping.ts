/**
 * utils/pushFailure/fieldMapping.ts
 * -------------------------------------------------------------
 * 推送失败字段聚焦 · 接口字段维度
 *   · PushInterfaceField / PushFieldLevel 定义
 *   · fieldLevelOf / extractInterfaceField / auxiliaryFieldOf
 *   · failureFieldOf / failureFieldDetail（统一字段聚焦入口）
 *
 * 从原 utils/pushFailureCategory.ts 拆出。
 */

import { classifyFailure, isFieldRelatedCategory, fieldOfComposite, type PushFailCategory } from './categoryClassify';

// ============================================
// 接口字段维度
// ============================================

/** 接口字段码（聚焦维度，覆盖推送接口主要入参字段）。 */
export type PushInterfaceField =
    // ── 接口级公共参数（level=interface）──
    | 'testTaskNo'
    | 'subTestTaskId'
    | 'artifactId'
    | 'sourcePlatform'
    | 'designer'
    // ── caseList[] 行级字段（level=case）──
    | 'sourceId'
    | 'testCasePath'
    | 'testCaseName'
    | 'testCaseDes'
    | 'description'
    | 'expected'
    | 'priority'
    | 'type'
    | 'preCondition'
    | 'keyFlag'
    | 'projectDes'
    | 'planExecNum'
    | 'testType'
    // ── 扩展字段码 ──
    | 'caseInfo'
    | 'testPoint'
    | 'stepSeq'
    // ── 冷门资源字段码 ──
    | 'caseLib'
    | 'tag'
    | 'module'
    | 'env'
    | 'owner';

/** 字段级别：interface=接口级公共参数；case=caseList 行级字段 */
export type PushFieldLevel = 'interface' | 'case';

/** 字段→级别映射表。与 PushInterfaceField 一一对应（TS 会强制盖全）。 */
const FIELD_LEVEL: Record<PushInterfaceField, PushFieldLevel> = {
    testTaskNo: 'interface',
    subTestTaskId: 'interface',
    artifactId: 'interface',
    sourcePlatform: 'interface',
    designer: 'interface',
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
    caseInfo: 'case',
    testPoint: 'case',
    stepSeq: 'case',
    caseLib: 'case',
    tag: 'case',
    module: 'case',
    env: 'case',
    owner: 'case',
};

/** 查字段级别 */
export function fieldLevelOf(field: PushInterfaceField): PushFieldLevel {
    return FIELD_LEVEL[field];
}

/**
 * 接口字段 → 别名（中英文，后端报错可能用任一种）。
 * 顺序即优先级：把含"案例"前缀、更具体的短语排在前面，避免被通用别名抢先。
 */
const INTERFACE_FIELD_ALIASES: Array<{ field: PushInterfaceField; aliases: RegExp }> = [
    // ──── 接口级公共参数（优先匹配） ────
    { field: 'testTaskNo',     aliases: /testTaskNo|test_task_no|测试任务编号|任务编号|阶段信息/ },
    { field: 'subTestTaskId',  aliases: /subTestTaskId|sub_test_task_id|subTaskId|子任务\s*[Ii][dD]|子任务/ },
    { field: 'artifactId',     aliases: /artifactId|artifact_id|产出物\s*[Ii][dD]|产出物/ },
    { field: 'designer',       aliases: /designer|设计人/ },
    // ──── caseList[] 行级字段 ────
    { field: 'sourceId',       aliases: /sourceId|testcase_id|testCaseId|案例来源\s*[Ii][dD]|案例唯一标识|案例标识|案例\s*id|案例ID|案例已存在/ },
    { field: 'sourcePlatform', aliases: /sourcePlatform|source_platform|案例来源平台|案例来源(?![\s]*[Ii][dD])|来源平台/ },
    { field: 'testCasePath',   aliases: /testCasePath|案例路径|案例\s*path|路径/ },
    { field: 'testCaseName',   aliases: /testCaseName|案例名称|案例\s*name|名称/ },
    { field: 'testCaseDes',    aliases: /testCaseDes|案例描述/ },
    { field: 'stepSeq',        aliases: /数量不一致|步骤描述与预期结果/ },
    { field: 'description',    aliases: /description|步骤描述|步骤/ },
    { field: 'expected',       aliases: /expected|预期结果|预期|检查点/ },
    { field: 'priority',       aliases: /priority|优先级/ },
    { field: 'type',           aliases: /\btype\b|案例类型/ },
    { field: 'preCondition',   aliases: /preCondition|前置条件/ },
    { field: 'keyFlag',        aliases: /keyFlag|key_flag|关键案例/ },
    { field: 'projectDes',     aliases: /projectDes|project_des|项目说明/ },
    { field: 'planExecNum',    aliases: /planExecNum|plan_exec_num|计划执行次数/ },
    { field: 'testType',       aliases: /testType|默认执行方式|执行方式/ },
    { field: 'caseInfo',       aliases: /案例信息/ },
    { field: 'testPoint',      aliases: /测试要点/ },
    // ──── 冷门资源字段 ────
    { field: 'caseLib',       aliases: /用例库|案例库|caseLib|case_lib/ },
    { field: 'tag',           aliases: /标签|tag\b|tags/ },
    { field: 'module',        aliases: /模块|module|moduleId|module_id/ },
    { field: 'env',           aliases: /环境|env\b|environment|运行环境|测试环境/ },
    { field: 'owner',         aliases: /负责人|归属人|owner|ownerId|owner_id/ },
];

/** category → 辅助字段码（兜底维度）。 */
const AUX_FIELD_BY_CATEGORY: Partial<Record<PushFailCategory, PushInterfaceField>> = {
    taskStageMissing: 'testTaskNo',
    taskNotFound: 'testTaskNo',
    testPointMissing: 'testPoint',
    pathNotMatchPoint: 'testCasePath',
    checkpointZero: 'expected',
    stepMismatch: 'stepSeq',
    sourceNotSupported: 'sourcePlatform',
    bizReject: 'sourcePlatform',
};

export function auxiliaryFieldOf(category: PushFailCategory): PushInterfaceField | undefined {
    return AUX_FIELD_BY_CATEGORY[category];
}

/** MapError.reason → 接口字段（客户端字段映射错误已知具体字段） */
const MAP_ERROR_REASON_TO_FIELD: Record<string, PushInterfaceField> = {
    missingTestcaseId: 'sourceId',
    missingOperation: 'description',
    missingStepDesc: 'description',
    missingExpected: 'expected',
    invalidPath: 'testCasePath',
    invalidTestType: 'testType',
};

/**
 * 从自由文本抽取接口字段码（仅基于 reason 关键词）。命中返回字段码；否则 undefined。
 */
export function extractInterfaceField(text: string): PushInterfaceField | undefined {
    const s = text || '';
    for (const f of INTERFACE_FIELD_ALIASES) {
        if (f.aliases.test(s)) return f.field;
    }
    return undefined;
}

/** 字段来源（用于埋点区分"强信号命中"与"辅助兜底"）。 */
export type FieldSource = 'structured' | 'text' | 'aux';

/** 统一字段聚焦入口（带来源）。 */
export function failureFieldDetail(input: {
    reason?: string;
    validatorKind?: string;
    mapErrorReason?: string;
    category?: PushFailCategory;
}): { field: PushInterfaceField | undefined; source: FieldSource | undefined } {
    if (input.mapErrorReason && MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason]) {
        return { field: MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason], source: 'structured' };
    }
    if (input.validatorKind && (
        input.validatorKind === 'placeholder' ||
        input.validatorKind === 'empty' ||
        input.validatorKind === 'invalidFormat'
    )) {
        return { field: 'sourceId', source: 'structured' };
    }
    const cat = input.category
        ?? classifyFailure({
            reason: input.reason || '',
            validatorKind: input.validatorKind,
            mapErrorReason: input.mapErrorReason,
        });
    if (isFieldRelatedCategory(cat)) {
        const fromComposite = fieldOfComposite(cat);
        if (fromComposite) return { field: fromComposite, source: 'text' };
        const fromText = extractInterfaceField(input.reason || '');
        if (fromText) return { field: fromText, source: 'text' };
        const aux = auxiliaryFieldOf(cat);
        if (aux) return { field: aux, source: 'aux' };
    }
    return { field: undefined, source: undefined };
}

/**
 * 统一字段聚焦入口：优先用结构化信号，否则仅在"字段相关大类"错误中才从 reason 抽取字段码。
 */
export function failureFieldOf(input: {
    reason?: string;
    validatorKind?: string;
    mapErrorReason?: string;
    category?: PushFailCategory;
}): PushInterfaceField | undefined {
    return failureFieldDetail(input).field;
}
