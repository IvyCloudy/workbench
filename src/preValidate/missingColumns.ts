/**
 * preValidate/missingColumns.ts
 * -------------------------------------------------------------
 * 必备列/字段存在性校验（结构完整性 · 2.3.5 新增）
 * -------------------------------------------------------------
 * 需求：《案例推送前置校验-待补充拦截需求文档》§2.3.5
 *   · 校验目标：文件级结构性错误 —— 缺少任一必备列（CSV）/ 必备字段（YAML/JSON）
 *     会导致本文件所有案例都无法被正确解析或推送。
 *   · 严重级：error 硬拦截；不允许"忽略并继续"。
 *   · 判定规则：
 *       - CSV：以表头行为准，检查必备列是否全部存在（主列名 csvHeader 或别名
 *         csvAliases 任一命中即视为存在，兼容英文字段名 / 中文变体表头）；缺任一即命中。
 *       - YAML / JSON：以整个文件所有案例为整体判定 —— 若"全文件所有案例"
 *         均未出现某必备键，则该键命中缺失（只要文件里至少有一条案例包含该键，
 *         该键即视为存在，不命中）。
 *   · steps.*_expected 至少一个：三者中任一键在文件任一步骤出现过即通过；
 *     三者全部缺失才命中。CSV 只要有"预期结果"列即通过。
 *
 * 设计要点：
 *   · 纯函数、无副作用（可单测），不做埋点/不做 IO；
 *   · 上层（editValidationHandler / stepPreValidate）各自负责弹窗、埋点、
 *     持久化，本模块只输出结构化命中项；
 *   · 清单与需求文档 §2.3.5 表格一一对应，若清单变更需同步修改文档。
 */

import type { FileType } from '../parsers';

/**
 * 一条"必备列/字段"契约。
 *   · yamlKey：YAML/JSON 的对象键名（顶层字段）；
 *   · csvHeader：CSV 表头中文列名；
 *   · atLeastOneOfYamlKeys：仅 steps.*_expected 使用 —— 在 steps[] 中扫描
 *     多个候选键，只要任一在文件的任一 step 中出现过即视为存在；
 *   · location：仅用于展示与命中项归类（顶层字段 / steps 内子字段）。
 */
export interface RequiredFieldSpec {
    /** 展示用中文名（弹窗 / reason 使用） */
    label: string;
    /** YAML / JSON 顶层键名（当 location='top' 时使用）*/
    yamlKey?: string;
    /**
     * YAML / JSON steps[i] 内的候选键集合 —— 只要任一在文件的任一 step
     * 中出现过即视为存在（location='step' 时使用；用于 steps.operation
     * 单键、steps.*_expected 多键"至少一个"两种场景）。
     */
    atLeastOneOfStepKeys?: string[];
    /** CSV 中文列名（表头行判定） */
    csvHeader: string;
    /**
     * CSV 表头别名集合（可选）：表头命中 csvHeader 或任一别名即视为该必备列存在。
     *
     * 背景（2026-09-24）：现网 CSV 表头存在两类"语义等价但字面不同"的写法——
     *   · 英文字段名（name / path / description …）：编辑器经「表头中英文映射」
     *     显示为中文（如 name → 案例名称），推送映射也能正确还原为英文字段；
     *   · 中文变体（案例名称 / 测试名称 / 用例名称 …）：与界面显示名、
     *     linkerDiagnosticHandler / pushFailure/fieldMapping 等既有别名口径一致。
     * 若仅按 csvHeader 精确匹配，会把上述文件误判为"缺列"；且这些列多为受保护列
     * （PROTECTED_COLS 禁止重命名/删除），用户在编辑器内无法改成 csvHeader 字面值，
     * 只能新增中文列——新增时若按界面显示名填写（如"案例名称"）仍被判缺，
     * 形成"改了还是缺列"的死循环。故此处按"主名 + 别名"集合判定。
     */
    csvAliases?: string[];
    /** 命中位置 —— 决定 YAML / JSON 的扫描策略：'top' 扫顶层键，'step' 扫 steps[] */
    location: 'top' | 'step';
}

/**
 * 必备列/字段清单（需求 §2.3.5 表格；顺序决定弹窗中缺失项的展示顺序）。
 *
 * 命名说明：
 *   · path / name / description / preconditions / type / test_type / priority
 *     → 顶层字段；YAML/JSON 只要至少一条案例包含该键即视为存在。
 *   · steps.operation → step 内 operation 键；至少一条 step 含即视为存在。
 *   · steps.*_expected → ui/api/db_expected 三选一；任一在任一 step 中出现即通过。
 */
export const REQUIRED_FIELDS: RequiredFieldSpec[] = [
    {
        label: '名称', yamlKey: 'name', csvHeader: '名称', location: 'top',
        // 别名与 highlight-util / linkerDiagnosticHandler.caseNameField / pushFailure.fieldMapping 口径一致
        csvAliases: ['name', 'testCaseName', '案例名称', '测试名称', '用例名称', '测试案例名称'],
    },
    {
        label: '路径', yamlKey: 'path', csvHeader: '路径', location: 'top',
        csvAliases: ['path', 'testCasePath', '案例路径', '用例路径'],
    },
    {
        label: '案例描述', yamlKey: 'description', csvHeader: '案例描述', location: 'top',
        csvAliases: ['description', 'testCaseDesc', '用例描述', '测试描述'],
    },
    {
        label: '前置条件', yamlKey: 'preconditions', csvHeader: '前置条件', location: 'top',
        csvAliases: ['preconditions', '前置'],
    },
    {
        label: '案例类型', yamlKey: 'type', csvHeader: '案例类型', location: 'top',
        csvAliases: ['type', '用例类型'],
    },
    {
        label: '执行方式', yamlKey: 'test_type', csvHeader: '执行方式', location: 'top',
        csvAliases: ['test_type', 'testType', '执行类型'],
    },
    {
        label: '优先级', yamlKey: 'priority', csvHeader: '优先级', location: 'top',
        csvAliases: ['priority'],
    },
    {
        label: '步骤描述', atLeastOneOfStepKeys: ['operation'], csvHeader: '步骤描述', location: 'step',
        csvAliases: ['operation', 'steps', '操作步骤'],
    },
    {
        label: '预期结果', atLeastOneOfStepKeys: ['ui_expected', 'api_expected', 'db_expected'], csvHeader: '预期结果', location: 'step',
        csvAliases: ['expected', 'ui_expected', 'api_expected', 'db_expected'],
    },
];

/** 单条命中项：给上层弹窗与推送失败列表消费。 */
export interface MissingColumnHit {
    /** 展示用中文名（同 REQUIRED_FIELDS.label） */
    label: string;
    /** 承载具体缺失位置的描述 —— 弹窗展示 "缺少中文列名/字段（yamlKey 或候选键列表）" */
    csvHeader: string;
    /** YAML/JSON 侧的键名或候选键（弹窗尾部标注）；location='step' 时可能是多个 */
    yamlKeys: string[];
    /** 命中位置：'top' | 'step'，供上层区分展示或分类 */
    location: 'top' | 'step';
}

/** 检测结果：命中数组 + 便捷 ok 标记。 */
export interface MissingColumnResult {
    /** 缺失清单（按 REQUIRED_FIELDS 定义顺序） */
    missing: MissingColumnHit[];
    /** 便捷判据：无缺失时为 true */
    ok: boolean;
}

/** 空结果：便于上层短路，避免频繁 `[]` 字面量。 */
const EMPTY_RESULT: MissingColumnResult = { missing: [], ok: true };

/**
 * 将 spec 转成 hit —— 归一 yamlKeys 展示。
 */
function toHit(spec: RequiredFieldSpec): MissingColumnHit {
    const keys: string[] = [];
    if (spec.yamlKey) keys.push(spec.yamlKey);
    if (spec.atLeastOneOfStepKeys && spec.atLeastOneOfStepKeys.length > 0) {
        keys.push(...spec.atLeastOneOfStepKeys);
    }
    return {
        label: spec.label,
        csvHeader: spec.csvHeader,
        yamlKeys: keys,
        location: spec.location,
    };
}

/**
 * 检测 CSV 表头是否含全部必备中文列名。
 *
 * @param headers CSV 表头数组（parser.parse 后的 tableData.headers；已 trim）
 * @returns 缺失列清单（按 REQUIRED_FIELDS 顺序）
 */
export function detectMissingColumnsForCsv(headers: string[] | undefined | null): MissingColumnResult {
    if (!Array.isArray(headers)) return { missing: REQUIRED_FIELDS.map(toHit), ok: false };
    const headerSet = new Set<string>();
    for (const h of headers) {
        if (typeof h === 'string') headerSet.add(h.trim());
    }
    // 命中判定：表头 == csvHeader 或 == 任一 csvAliases（trim 后精确比较）。
    // 见 RequiredFieldSpec.csvAliases 注释 —— 英文字段名 / 中文变体均视为该必备列存在。
    const hasHeader = (spec: RequiredFieldSpec): boolean => {
        if (headerSet.has(spec.csvHeader)) return true;
        if (spec.csvAliases && spec.csvAliases.some(a => headerSet.has(a))) return true;
        return false;
    };
    const missing: MissingColumnHit[] = [];
    for (const spec of REQUIRED_FIELDS) {
        if (!hasHeader(spec)) missing.push(toHit(spec));
    }
    return { missing, ok: missing.length === 0 };
}

/**
 * 检测 YAML / JSON 源数据是否含全部必备字段（"全文件所有案例"整体判定）。
 *
 * @param sourceData parser.parse 后的 sourceData（可能为数组 / 单对象 / null）
 * @returns 缺失字段清单
 */
export function detectMissingColumnsForYamlJson(sourceData: any): MissingColumnResult {
    // 归一为数组视图
    let recs: any[];
    if (Array.isArray(sourceData)) recs = sourceData;
    else if (sourceData && typeof sourceData === 'object') recs = [sourceData];
    else recs = [];

    // 空文件：所有必备键都算缺失（与需求"缺列会导致推送失败"一致，文件根本无法解析出案例）
    if (recs.length === 0) {
        return { missing: REQUIRED_FIELDS.map(toHit), ok: false };
    }

    // 预扫描：统计文件里各"顶层键"、"steps 子键"是否至少出现过一次
    const topKeysSeen = new Set<string>();
    const stepKeysSeen = new Set<string>();
    for (const rec of recs) {
        if (!rec || typeof rec !== 'object') continue;
        for (const k of Object.keys(rec)) topKeysSeen.add(k);
        const steps = (rec as any).steps;
        if (Array.isArray(steps)) {
            for (const s of steps) {
                if (s && typeof s === 'object') {
                    for (const sk of Object.keys(s)) stepKeysSeen.add(sk);
                }
            }
        }
    }

    const missing: MissingColumnHit[] = [];
    for (const spec of REQUIRED_FIELDS) {
        if (spec.location === 'top') {
            if (spec.yamlKey && !topKeysSeen.has(spec.yamlKey)) missing.push(toHit(spec));
        } else {
            // step 位：候选键有一个出现过就通过
            const cands = spec.atLeastOneOfStepKeys || [];
            if (cands.length === 0) continue;
            const hitAny = cands.some(k => stepKeysSeen.has(k));
            if (!hitAny) missing.push(toHit(spec));
        }
    }
    return { missing, ok: missing.length === 0 };
}

/**
 * 统一入口：按 fileType 自动分流。
 *   · csv → detectMissingColumnsForCsv(headers)
 *   · yaml / json → detectMissingColumnsForYamlJson(sourceData)
 * headers / sourceData 都传时，按 fileType 决定优先级；不适用者会被忽略。
 *
 * @returns 空结果表示无缺失；缺失时 missing 数组非空。
 */
export function detectMissingColumns(
    fileType: FileType | null | undefined,
    headers: string[] | undefined | null,
    sourceData: any,
): MissingColumnResult {
    if (!fileType) return EMPTY_RESULT;
    if (fileType === 'csv') return detectMissingColumnsForCsv(headers);
    return detectMissingColumnsForYamlJson(sourceData);
}

/**
 * 生成"打开文件"弹窗文案 —— 供 vscode.window.showErrorMessage 使用。
 *
 * ⚠️ 该函数保留用于兜底纯文本文案（如日志 / 单元测试）。UI 层已改为
 *    通过 openPreValidateGate 触发 webview 内自定义弹窗，不再直接调用本函数。
 *
 * fileType 语义（用于双语文案）：
 *   · 'csv'  → 仅展示 CSV 中文列名（用户操作对象就是中文列，无需英文）；
 *   · 'yaml' / 'json' → 中英文并列，方便用户对照 YAML 键补齐。
 * 兼容旧签名：未传 fileType 时按纯中文清单输出（保持向后兼容）。
 *
 * 例：
 *   CSV     → `当前文件缺少必备列/字段：路径、案例描述。缺列会导致推送失败，请补齐后再使用。`
 *   YAML    → `当前文件缺少必备列/字段：路径（path）、案例描述（description）、预期结果（steps[].ui_expected / api_expected / db_expected）。缺列会导致推送失败，请补齐后再使用。`
 */
export function buildMissingColumnMessage(
    missing: MissingColumnHit[],
    fileType?: FileType | null,
): string {
    if (missing.length === 0) return '';
    const labels = missing.map(m => formatHitBilingual(m, fileType)).join('、');
    return `当前文件缺少必备列/字段：${labels}。缺列会导致推送失败，请补齐后再使用。`;
}

/**
 * 生成一条给推送失败列表用的 reason 文本（每个缺失一条 failure）。
 *
 * ‼️ 文案必须明确表达"文件级问题"，避免用户误以为某一行有问题。参考需求 §2.3.5：
 *   > “当前文件缺少必备列/字段：路径、案例描述、前置条件……”
 *
 * fileType 语义：
 *   · 'csv'  → CSV 场景不带"（对应 YAML 字段：xxx）"后缀（用户面对的就是中文列名）；
 *   · 'yaml' / 'json' → 带 YAML 键后缀，便于用户对照文件结构补齐；
 *   · 未传（兼容旧签名）→ 保留 YAML 键后缀，与历史行为一致。
 *
 * 组装示例（YAML）：当前文件缺少必备列/字段“路径（对应 YAML 字段：path）”
 * 组装示例（CSV） ：当前文件缺少必备列/字段“路径”
 *
 * 文案精简（2026-09-19）：去掉"，将导致推送失败，请补齐后再推送"冗余尾巴，
 * 严重级与行为指引由弹窗组头/整段汇总文案承载，bullet 只保留"缺哪一项"的事实。
 */
export function buildMissingColumnReason(
    hit: MissingColumnHit,
    fileType?: FileType | null,
): string {
    const withYamlSuffix = fileType !== 'csv';
    let suffix = '';
    if (withYamlSuffix) {
        const keyDesc = hit.location === 'step'
            ? `steps[].${hit.yamlKeys.join(' / ')}`
            : (hit.yamlKeys[0] || '');
        suffix = keyDesc ? `（对应 YAML 字段：${keyDesc}）` : '';
    }
    return `当前文件缺少必备列/字段“${hit.label}”${suffix}`;
}

/**
 * 内部：把一个缺失项格式化为"中文（英文键）"或纯中文。
 * · YAML / JSON：`路径（path）`、`预期结果（steps[].ui_expected / api_expected / db_expected）`；
 * · CSV：仅 `路径`（CSV 用户操作对象就是中文列名，无需英文对照）；
 * · fileType 缺省时保留纯中文，兼容历史签名。
 */
function formatHitBilingual(hit: MissingColumnHit, fileType?: FileType | null): string {
    if (fileType !== 'yaml' && fileType !== 'json') return hit.label;
    const keyDesc = hit.location === 'step'
        ? `steps[].${hit.yamlKeys.join(' / ')}`
        : (hit.yamlKeys[0] || '');
    return keyDesc ? `${hit.label}（${keyDesc}）` : hit.label;
}
