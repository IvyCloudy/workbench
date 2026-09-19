/**
 * utils/pushFailure/categoryClassify.ts
 * -------------------------------------------------------------
 * 推送失败分类 · 枚举 + 归类器
 *   · FailNature / PushFailCategory 枚举
 *   · classifyBackendFailure（后端自由中文文本 → 稳定 category）
 *   · classifyFailure（统一入口：结构化信号优先，否则走文本归类）
 *   · fieldOfComposite / isFieldRelatedCategory（复合码解析辅助）
 *
 * 从原 utils/pushFailureCategory.ts 拆出。
 */

import { extractInterfaceField, type PushInterfaceField } from './fieldMapping';

// ============================================
// 分类枚举
// ============================================

/**
 * 错误性质（字段级分类的第二段）。与 PushInterfaceField 组合成 `字段.性质` 复合码。
 * 性质取自后端报错的可归类维度，固定、可枚举；具体字段由 extractInterfaceField 取。
 */
export type FailNature =
    | 'empty'      // 必填为空（xxx 不能为空 / 案例信息不能为空）
    | 'length'     // 长度超限（xxx 长度不能超过 N 个字符）
    | 'format'     // 格式非法（格式/不合法/必须以?结尾/关键案例格式）
    | 'enum'       // 行内枚举值非法（无效的案例类型/优先级/执行方式 等）
    | 'dup'        // 重复/已存在（sourceId 已存在 / 案例已存在 / 路径重复）
    | 'notFound';  // 资源不存在/未找到（用例库/标签/模块/环境/负责人 等冷门资源维度）

/**
 * 推送失败分类码。取值稳定、可枚举，供统计聚合与埋点维度使用（不建议改命名）。
 */
export type PushFailCategory =
    // —— 客户端预校验（已有结构化信号，直接复用）——
    | 'placeholder'
    | 'emptyTestcaseId'
    | 'sample'
    | 'emptyFile'
    | 'fileError'
    | 'mapError'
    // —— 后端失败（自由中文文本，需关键词归类）——
    | 'network'
    | 'auth'
    | 'yamlSyntax'
    | 'fieldDup'
    | 'fieldEmpty'
    | 'fieldLength'
    | 'fieldFormat'
    | 'enumInvalid'
    | 'checkpointZero'
    | 'stepMismatch'
    | 'taskStageMissing'
    | 'paramFormat'
    | 'fieldInvalid'
    | 'notFound'
    | 'taskNotFound'
    | 'testPointMissing'
    | 'pathNotMatchPoint'
    | 'serverError'
    | 'sourceNotSupported'
    | 'bizReject'
    | 'todo.placeholder'
    | 'unknown'
    // —— 字段级复合码：`${field}.${nature}` ——
    | `${string}.${FailNature}`;

// ============================================
// 结构化信号 → category 的映射表
// ============================================

/** RowValidator.kind → category（占位/空 tsId 用） */
const VALIDATOR_KIND_TO_CATEGORY: Record<string, PushFailCategory> = {
    placeholder: 'placeholder',
    empty: 'emptyTestcaseId',
    invalidFormat: 'sourceId.format',
    todoPlaceholder: 'todo.placeholder' as PushFailCategory,
    enumInvalid: 'enumInvalid',
    planExecNumInvalid: 'planExecNum.format' as PushFailCategory,
};

/** MapErrorFields.reason → category（字段映射错误用）。 */
const MAP_ERROR_REASON_TO_CATEGORY: Record<string, string> = {
    missingTestcaseId: 'sourceId.empty',
    missingOperation: 'description.empty',
    missingStepDesc: 'description.empty',
    missingExpected: 'expected.empty',
    invalidPath: 'testCasePath.format',
    invalidTestType: 'testType.enum',
    invalidCaseType: 'type.enum',
    invalidPriority: 'priority.enum',
    invalidKeyFlag:  'keyFlag.enum',
};

/**
 * 后端中文长文本 → 顶层 category 的归类规则（顺序即优先级，先命中先生效）。
 */
const BACKEND_TOP_RULES: Array<{ category: PushFailCategory; patterns: RegExp }> = [
    { category: 'sample', patterns: /样例数据|占位字段|案例唯一标识，不可修改|不可修改/ },
    { category: 'emptyFile', patterns: /文件无数据|文件无有效数据|无有效数据|空文件|文件中未检测到有效的测试案例数据/ },
    { category: 'fileError', patterns: /文件不在合规目录|文件解析失败|CSV\s*解析失败|JSON\s*解析失败|不支持的文件类型|读文件失败|文件读取失败/i },
    { category: 'yamlSyntax', patterns: /YAML\s*(语法|解析|格式|校验器)?\s*(错误|异常)|无法解析为有效的测试案例|YAML\s*解析失败/i },
    { category: 'network',      patterns: /超时|timeout|网络|连接失败|ECONN|connect|socket/i },
    { category: 'taskStageMissing', patterns: /阶段信息/ },
    { category: 'auth',         patterns: /鉴权|权限|未登录|token|无权限|登录|认证|unauthorized|forbidden|401|403/i },
    { category: 'sourceNotSupported', patterns: /不支持案例来源|无效的案例来源|案例来源不被支持|案例来源(?![\s]*[Ii][dD])(?:不被支持|无效)/ },
    { category: 'bizReject',    patterns: /不支持|不被支持|拒绝/ },
    { category: 'taskNotFound', patterns: /任务不存在|任务未绑定|未绑定|未找到对应测试任务|测试任务不存在|任务未找到/ },
    { category: 'pathNotMatchPoint', patterns: /案例路径错误未匹配到有效测试要点/ },
    { category: 'testPointMissing',   patterns: /未匹配到有效测试要点/ },
    { category: 'stepMismatch', patterns: /步骤描述与预期结果数量不一致|数量不一致/ },
    { category: 'checkpointZero', patterns: /检查点数为\s*0|检查点为\s*0|检查点数为0|检查点为0/ },
    { category: 'serverError',  patterns: /服务[器端]|系统异常|内部错误|5xx|server\s*error|5\d{2}(?:错误|异常|状态码|报错)/i },
    { category: 'paramFormat', patterns: /参数格式|参数错误|参数为空|参数不合法|参数校验|参数异常|请检查参数|入参|请求参数|参数不完整/ },
];

/**
 * 字段级错误性质规则（顺序即优先级，先命中先生效）。
 */
const BACKEND_NATURE_RULES: Array<{ nature: FailNature; patterns: RegExp }> = [
    { nature: 'enum',   patterns: /无效的案例类型|无效的案例优先级|无效的案例默认执行方式|无效的案例关键案例|无效的案例[\u4e00-\u9fa5]*格式|无效的案例[\u4e00-\u9fa5]*(类型|优先级|执行方式|关键案例)/ },
    { nature: 'dup',    patterns: /已存在|重复|duplicate|already|冲突|conflict/i },
    { nature: 'length', patterns: /长度不能超过|长度超过|超过.{0,6}个字符|字符长度|超出长度/ },
    { nature: 'empty',  patterns: /不能为空|不能为空白|为空|缺失|未填写|必填|缺少/ },
    { nature: 'format', patterns: /格式|不合法|非法|规范|不符合|必须以.*结尾|结尾|invalid|param|参数|路径格式|关键案例格式/ },
];

/** 性质级兜底 category（取不到具体字段时使用，保留可下钻语义） */
const NATURE_FALLBACK_CATEGORY: Record<FailNature, PushFailCategory> = {
    empty: 'fieldEmpty',
    length: 'fieldLength',
    format: 'fieldFormat',
    enum: 'enumInvalid',
    dup: 'fieldDup',
    notFound: 'notFound',
};

// ============================================
// 归类器
// ============================================

export function classifyBackendFailure(text: string): PushFailCategory {
    const s = text || '';
    for (const rule of BACKEND_TOP_RULES) {
        if (rule.patterns.test(s)) return rule.category;
    }
    for (const rule of BACKEND_NATURE_RULES) {
        if (rule.patterns.test(s)) {
            const field = extractInterfaceField(s);
            if (field) return `${field}.${rule.nature}` as PushFailCategory;
            return NATURE_FALLBACK_CATEGORY[rule.nature];
        }
    }
    if (/不存在|未找到|查无|not\s*found|404/i.test(s)) {
        const field = extractInterfaceField(s);
        if (field) return `${field}.notFound` as PushFailCategory;
        return 'notFound';
    }
    if (/无法解析|结构异常|字段校验未通过|参数结构错误/.test(s)) return 'fieldInvalid';
    return 'unknown';
}

export function classifyFailure(input: {
    reason: string;
    validatorKind?: string;
    mapErrorReason?: string;
}): PushFailCategory {
    if (input.validatorKind && VALIDATOR_KIND_TO_CATEGORY[input.validatorKind]) {
        return VALIDATOR_KIND_TO_CATEGORY[input.validatorKind];
    }
    if (input.mapErrorReason && MAP_ERROR_REASON_TO_CATEGORY[input.mapErrorReason]) {
        return MAP_ERROR_REASON_TO_CATEGORY[input.mapErrorReason] as PushFailCategory;
    }
    return classifyBackendFailure(input.reason);
}

// ============================================
// 复合码解析辅助
// ============================================

/** 字段相关 category 白名单（与复合码正则协同判定）。 */
const FIELD_RELATED_CATEGORIES: PushFailCategory[] = [
    'fieldInvalid', 'fieldEmpty', 'fieldLength', 'fieldFormat', 'enumInvalid', 'fieldDup',
    'checkpointZero', 'stepMismatch', 'taskStageMissing',
    'mapError', 'placeholder', 'emptyTestcaseId',
    'notFound', 'taskNotFound', 'testPointMissing', 'pathNotMatchPoint',
    'sourceNotSupported', 'bizReject',
    'todo.placeholder',
];

/** 判断某 category 是否字段相关（含复合码 `字段.性质` 与性质级兜底名）。 */
export function isFieldRelatedCategory(cat: PushFailCategory): boolean {
    if (FIELD_RELATED_CATEGORIES.includes(cat)) return true;
    const m = typeof cat === 'string' ? cat.match(/^(.+)\.(empty|length|format|enum|dup|notFound)$/) : null;
    return !!m;
}

/** 从复合码 `字段.性质` 解析出字段。 */
export function fieldOfComposite(cat: PushFailCategory): PushInterfaceField | undefined {
    if (typeof cat !== 'string') return undefined;
    const m = cat.match(/^(.+)\.(empty|length|format|enum|dup|notFound)$/);
    return m ? (m[1] as PushInterfaceField) : undefined;
}
