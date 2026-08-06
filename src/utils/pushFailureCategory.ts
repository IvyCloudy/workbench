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
 *
 * 形如 `testCaseName.empty` / `testCasePath.empty` / `sourceId.dup` / `testCasePath.dup` 的
 * 复合码由"命中字段 + 错误性质"两段合成，单看即知哪个字段、什么问题。
 */
export type PushFailCategory =
    // —— 客户端预校验（已有结构化信号，直接复用）——
    | 'placeholder'          // testcase_id 为占位值 TESTCASE_ID
    | 'emptyTestcaseId'      // testcase_id 为空
    | 'sample'               // 样例占位数据（'案例唯一标识，不可修改' 等）
    | 'emptyFile'            // 文件无数据/无有效数据（前置拦截，未进 runPush）
    | 'fileError'            // 文件级前置拦截（不在合规目录/解析失败/读文件失败，早于 runPush）
    | 'mapError'             // 字段映射错误（缺 testcase_id / 步骤缺 operation / 缺步骤描述 / 路径非法）
    // —— 后端失败（自由中文文本，需关键词归类）——
    | 'network'              // 网络/超时
    | 'auth'                 // 鉴权/权限/未登录
    | 'yamlSyntax'           // YAML 语法/解析错误（文件级前置拦截，早于 runPush）
    | 'fieldDup'            // 字段重复/已存在（性质级兜底：能定位字段时合成 `字段.dup`）
    // —— 字段级复合 category：格式 = `字段.性质`（如 testCaseName.empty / testCasePath.empty /
    //    sourceId.dup），由"命中字段 + 错误性质"两段合成。单看 category 即能定位"哪个字段、出了什么问题"，
    //    不再混进统一的 fieldInvalid。性质固定枚举见 FAILURE_NATURE；字段取自 PushInterfaceField。 ——
    | 'fieldEmpty'           // 字段为空（性质级兜底：能定位字段时合成 `字段.empty`）
    | 'fieldLength'          // 字段长度超限（性质级兜底：能定位字段时合成 `字段.length`）
    | 'fieldFormat'          // 字段格式非法（性质级兜底：能定位字段时合成 `字段.format`）
    | 'enumInvalid'          // 行内枚举值非法（性质级兜底：能定位字段时合成 `字段.enum`）
    | 'fieldDup'             // 字段重复/已存在（性质级兜底：能定位字段时合成 `字段.dup`）
    | 'checkpointZero'       // 案例检查点数为 0（性质唯一，无需复合）
    | 'stepMismatch'         // 步骤描述与预期结果数量不一致（性质唯一，无需复合）
    | 'taskStageMissing'     // 测试任务编号未匹配到有效阶段信息（阶段信息强匹配，早于 auth）
    | 'paramFormat'          // 接口请求参数格式/校验错误（整批失败，区别于行级字段格式错）
    | 'fieldInvalid'         // 字段类兜底（无法定位到具体性质的字段错误）
    | 'notFound'             // 其他不存在/未找到（兜底，具体业务已拆到下方细分类）
    // —— notFound 细分类：按"未找到的是什么资源"拆，单看 category 即懂业务 ——
    | 'taskNotFound'         // 任务不存在/未绑定/未找到（资源=测试任务）
    | 'testPointMissing'     // 任务下未匹配到有效测试要点（资源=测试要点，field=testPoint）
    | 'pathNotMatchPoint'    // 案例路径错误未匹配到有效测试要点（field=testCasePath）
    | 'serverError'          // 服务端异常/5xx
    // —— bizReject 细分类 ——
    | 'sourceNotSupported'   // 案例来源不被支持/无效（资源=案例来源平台，已拆出避免与泛业务拒绝混淆）
    | 'bizReject'            // 其他明确业务拒绝（不含案例来源类）
    | 'unknown'              // 兜底（无法归类的后端文本）
    // —— 字段级复合码：`${field}.${nature}`，如 testCaseName.empty / testCasePath.empty /
    //    sourceId.dup / testCasePath.dup。仅当性质可定位字段时由 classifyFailure 合成，
    //    不在此枚举中一一列出（PushFailCategory 用模板字面量允许该形态）。 ——
    | `${string}.${FailNature}`;


// ============================================
// 结构化信号 → category 的映射表
// ============================================

/** RowValidator.kind → category（占位/空 tsId 用） */
const VALIDATOR_KIND_TO_CATEGORY: Record<string, PushFailCategory> = {
    placeholder: 'placeholder',
    empty: 'emptyTestcaseId',
    invalidFormat: 'sourceId.format',
};

/** MapErrorFields.reason → category（字段映射错误用）。
 *  已知字段/性质的映射错误直接给出 `字段.性质` 复合码，不再统一落 mapError，
 *  使 failCategoryBreakdown 能下钻到"具体哪个字段空了/格式错了"。
 *  类型上实际为复合字符串，使用时 as PushFailCategory。
 */
const MAP_ERROR_REASON_TO_CATEGORY: Record<string, string> = {
    missingTestcaseId: 'sourceId.empty',
    missingOperation: 'description.empty',
    missingStepDesc: 'description.empty',
    missingExpected: 'expected.empty',
    invalidPath: 'testCasePath.format',
    invalidTestType: 'testType.enum',
};

/**
 * 后端中文长文本 → 顶层 category 的归类规则（顺序即优先级，先命中先生效）。
 * 仅放「无法或不必定位到具体接口字段」的稳定分类；字段级错误（empty/length/format/enum/dup）
 * 走下方 BACKEND_NATURE_RULES，由 classifyBackendFailure 合成 `字段.性质` 复合码。
 *
 * 设计原则：字段类错误**按"命中的接口字段 + 错误性质"拆细**为复合码
 * （testCaseName.empty / testCasePath.empty / sourceId.dup …），使 failCategoryBreakdown
 * 单看分类即可定位"哪个字段、出了什么问题"，不再被统一的 fieldInvalid 掩盖。
 */
const BACKEND_TOP_RULES: Array<{ category: PushFailCategory; patterns: RegExp }> = [
    // sample：样例占位数据拦截（"为样例数据，不允许推送"），需早于 bizReject（"不允许"会被抢走）。
    // 文本形如 "为样例数据，不允许推送。请修改\"案例唯一标识，不可修改\"等占位字段为真实数据后再试"。
    { category: 'sample', patterns: /样例数据|占位字段|案例唯一标识，不可修改|不可修改/ },
    // emptyFile：文件存在但无有效数据行（前置拦截，未进 runPush）。需早于 fileError：
    // "文件无数据/无有效数据"是内容为空，区别于 fileError 的解析异常。
    { category: 'emptyFile', patterns: /文件无数据|文件无有效数据|无有效数据|空文件|文件中未检测到有效的测试案例数据/ },
    // fileError：文件级前置拦截（不在合规目录/读文件失败/解析异常），早于 yamlSyntax/network/auth。
    // 注意必须排在 yamlSyntax 之前：CSV/JSON 解析失败的"文件解析失败"归 fileError，而非 yamlSyntax。
    // 文本形如 "文件不在合规目录下..." / "文件解析失败: ..." / "CSV 解析失败: ..." / "JSON 解析失败: ..."。
    { category: 'fileError', patterns: /文件不在合规目录|文件解析失败|CSV\s*解析失败|JSON\s*解析失败|不支持的文件类型|读文件失败|文件读取失败/i },
    // yamlSyntax：文件级前置拦截（YAML 语法/解析错误），仅在明确含 YAML 语境时命中。
    // 文本形如 "YAML 语法错误（首条：第 N 行...）" / "YAML 校验器异常：..." / "无法解析为有效的测试案例"。
    { category: 'yamlSyntax', patterns: /YAML\s*(语法|解析|格式|校验器)?\s*(错误|异常)|无法解析为有效的测试案例|YAML\s*解析失败/i },
    { category: 'network',      patterns: /超时|timeout|网络|连接失败|ECONN|connect|socket/i },
    // taskStageMissing（阶段信息强匹配，需早于 auth）："测试任务编号未匹配到有效阶段信息"
    // 虽整句可能含"无权限"，但"阶段信息"是字段校验失败，应归此类型并下钻到 testTaskNo 字段。
    // 仅精准匹配"阶段信息"，不影响"设计人无权限"等纯 auth 场景（不含"阶段信息"）。
    { category: 'taskStageMissing', patterns: /阶段信息/ },
    { category: 'auth',         patterns: /鉴权|权限|未登录|token|无权限|登录|认证|unauthorized|forbidden|401|403/i },
    // sourceNotSupported 需早于 bizReject：精准匹配来源相关措辞，避免抢走行内枚举值非法的字段类错误。
    { category: 'sourceNotSupported', patterns: /不支持案例来源|无效的案例来源|案例来源不被支持|案例来源(?![\s]*[Ii][dD])(?:不被支持|无效)/ },
    // bizReject 仅兜底其他明确业务拒绝（不再含案例来源类，已由 sourceNotSupported 承接；"不允许"已由 sample 前置承接）。
    // 需同时覆盖"不支持"（不+支持连续，如"不支持此操作"）与"不被支持"（不+被+支持，如"当前操作不被支持"），
    // 否则后者会漏匹配归 unknown。
    { category: 'bizReject',    patterns: /不支持|不被支持|拒绝/ },
    // taskNotFound 需早于 notFound 兜底：任务级"不存在/未绑定/未找到"归此，不含测试要点未匹配。
    { category: 'taskNotFound', patterns: /任务不存在|任务未绑定|未绑定|未找到对应测试任务|测试任务不存在|任务未找到/ },
    // testPointMissing（任务下未匹配）与 pathNotMatchPoint（案例路径错误未匹配）拆开，
    // 避免两类触发来源不同的失败混在同一 category；二者均含"未匹配到有效测试要点"。
    { category: 'pathNotMatchPoint', patterns: /案例路径错误未匹配到有效测试要点/ },
    { category: 'testPointMissing',   patterns: /未匹配到有效测试要点/ },
    // notFound 兜底（其他未找到/404）已从 BACKEND_TOP_RULES 移出，改在 classifyBackendFailure
    // 的字段级处理中（NATURE 规则之后、fieldInvalid 之前）判定，以便合成 `字段.notFound` 复合码。
    // 此处不再保留顶层 notFound 规则，避免吞掉能更精确归类的字段级错误。
    // stepMismatch：步骤描述与预期结果数量不一致（性质唯一，无需复合字段）。
    { category: 'stepMismatch', patterns: /步骤描述与预期结果数量不一致|数量不一致/ },
    // checkpointZero：案例检查点数为 0（性质唯一，无需复合字段）。
    { category: 'checkpointZero', patterns: /检查点数为\s*0|检查点为\s*0|检查点数为0|检查点为0/ },
    // serverError：要求 5xx 紧跟错误语境，避免误伤"长度不能超过500个字符"中的裸数字 500。
    { category: 'serverError',  patterns: /服务[器端]|系统异常|内部错误|5xx|server\s*error|5\d{2}(?:错误|异常|状态码|报错)/i },
    // paramFormat：接口请求参数级格式/校验错误（整批失败），区别于行级字段格式错 fieldFormat。
    // 文本形如 "参数格式不对，请检查参数" / "请求参数格式不正确" / "参数校验失败" / "入参不合法"。
    // 须排在 fieldInvalid 之前：避免被 "参数结构错误" 之类措辞误伤为字段级兜底；
    // 但因文案不点名具体字段，仅作为分类维度（field 不强制），便于在运营看板区分"参数级整批失败"与"行级字段格式错"。
    { category: 'paramFormat', patterns: /参数格式|参数错误|参数为空|参数不合法|参数校验|参数异常|请检查参数|入参|请求参数|参数不完整/ },
];

/**
 * 字段级错误性质规则（顺序即优先级，先命中先生效）。
 * 命中后由 classifyBackendFailure 再取接口字段，合成 `字段.性质` 复合码；取不到字段则落性质级兜底 category。
 * 注意：enum/dup 的"无效/已存在"措辞需精准，避免抢走 sourceNotSupported（来源类已在上层 taskStageMissing 之后、此处之前判定）。
 */
const BACKEND_NATURE_RULES: Array<{ nature: FailNature; patterns: RegExp }> = [
    // stepMismatch 性质已在 BACKEND_TOP_RULES 处理（无需复合），此处不再列。
    // enum：行内枚举值非法（数据中包含无效的案例类型/优先级/执行方式 等）。
    // 注意 sourceNotSupported 已精准匹配"无效的案例来源"且排在 BACKEND_TOP_RULES 靠前，故不会抢走来源类。
    { nature: 'enum',   patterns: /无效的案例类型|无效的案例优先级|无效的案例默认执行方式|无效的案例关键案例|无效的案例[\u4e00-\u9fa5]*格式|无效的案例[\u4e00-\u9fa5]*(类型|优先级|执行方式|关键案例)/ },
    // dup：重复/已存在（sourceId 已存在 / 案例已存在 / 路径重复）。性质级兜底为 fieldDup。
    { nature: 'dup',    patterns: /已存在|重复|duplicate|already|冲突|conflict/i },
    // length：字段长度超限（xxx 长度不能超过 N 个字符）。
    { nature: 'length', patterns: /长度不能超过|长度超过|超过.{0,6}个字符|字符长度|超出长度/ },
    // empty：必填字段为空（xxx 不能为空 / 案例信息不能为空 / 缺失 / 未填写）。
    { nature: 'empty',  patterns: /不能为空|不能为空白|为空|缺失|未填写|必填|缺少/ },
    // format：字段格式非法（格式不正确/不合法/规范/必须符合/关键案例格式）。
    { nature: 'format', patterns: /格式|不合法|非法|规范|不符合|必须以.*结尾|结尾|invalid|param|参数|路径格式|关键案例格式/ },
];

/** 性质级兜底 category（取不到具体字段时使用，保留可下钻语义） */
const NATURE_FALLBACK_CATEGORY: Record<FailNature, PushFailCategory> = {
    empty: 'fieldEmpty',
    length: 'fieldLength',
    format: 'fieldFormat',
    enum: 'enumInvalid',
    dup: 'fieldDup',
};

// ============================================
// 归类器
// ============================================

/**
 * 归类一条后端失败（自由中文文本）。
 *
 * 三段式：
 *  1. 先按 BACKEND_TOP_RULES 判定顶层稳定分类（network / auth / taskNotFound /
 *     testPointMissing / pathNotMatchPoint / stepMismatch / checkpointZero /
 *     paramFormat / serverError / sourceNotSupported / bizReject / taskStageMissing），
 *     命中即返回，不再下钻字段。
 *  2. 否则按 BACKEND_NATURE_RULES 判定「错误性质」（empty / length / format / enum / dup），
 *     再取接口字段合成 `字段.性质` 复合码；取不到字段则落性质级兜底 category
 *     （fieldEmpty / fieldLength / fieldFormat / enumInvalid / fieldDup）。
 *  3. 否则 notFound 兜底（其他资源不存在/未找到）：先抽取资源字段，命中则合成
 *     `字段.notFound` 复合码（如 caseLib.notFound / tag.notFound）；抽不到则落 notFound。
 *     此层优先于 fieldInvalid，确保冷门资源维度也能精确下钻（以 `字段.notFound` 为主）。
 *  4. 都不命中返回 'unknown'。
 */
export function classifyBackendFailure(text: string): PushFailCategory {
    const s = text || '';
    // 1) 顶层稳定分类（network/auth/taskNotFound/testPointMissing/pathNotMatchPoint/stepMismatch/
    //    paramFormat/serverError/sourceNotSupported/bizReject/taskStageMissing）
    for (const rule of BACKEND_TOP_RULES) {
        if (rule.patterns.test(s)) return rule.category;
    }
    // 2) 字段级性质 → 合成 `字段.性质` 复合码（如 sourceId.format / testCasePath.empty）。
    //    此层优先于 fieldInvalid：凡是能定位到字段+性质的错误（含 sourceId 格式错）都归精确复合码，
    //    不被笼统的 fieldInvalid 兜底吞掉（以 sourceId.format 为主）。
    for (const rule of BACKEND_NATURE_RULES) {
        if (rule.patterns.test(s)) {
            const field = extractInterfaceField(s);
            if (field) return `${field}.${rule.nature}` as PushFailCategory;
            return NATURE_FALLBACK_CATEGORY[rule.nature];
        }
    }
    // 3) notFound 兜底（其他未找到/404）。放在性质规则之后、fieldInvalid 之前：
    //    凡是文本含"不存在/未找到/查无/404"的资源类错误，先尝试抽取具体资源字段，
    //    命中则合成 `字段.notFound` 精确复合码（如 caseLib.notFound / tag.notFound），
    //    不再笼统落 notFound（以 `字段.notFound` 为主，与 sourceId.format 同一取向）。
    //    注意：taskNotFound / testPointMissing / pathNotMatchPoint 等已拆细分类已在 TOP_RULES
    //    优先命中，此处仅承接"其他冷门资源不存在"场景。
    if (/不存在|未找到|查无|not\s*found|404/i.test(s)) {
        const field = extractInterfaceField(s);
        if (field) return `${field}.notFound` as PushFailCategory;
        return 'notFound';
    }
    // 4) fieldInvalid 兜底（无法定位具体性质的字段级措辞）。放在性质规则之后，
    //    仅承接"性质也无法归类"的残差字段错误，不再抢走 sourceId.format 等复合码。
    if (/无法解析|结构异常|字段校验未通过|参数结构错误/.test(s)) return 'fieldInvalid';
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
        return MAP_ERROR_REASON_TO_CATEGORY[input.mapErrorReason] as PushFailCategory;
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
    | 'testType'        // 执行方式
    // ── 扩展字段码（覆盖更多后端报错场景，便于埋点下钻）──
    | 'caseInfo'        // 案例信息（整行必填校验，如 "案例信息不能为空"）
    | 'testPoint'       // 测试要点（"任务下未匹配到有效测试要点" / "案例路径错误未匹配到有效测试要点"）
    | 'stepSeq'         // 步骤/预期数量一致性（"步骤描述与预期结果数量不一致"）
    // ── 冷门资源字段码（notFound / fieldInvalid 类报错中常见、但非主流程字段的资源维度）──
    | 'caseLib'         // 用例库（"用例库不存在/未找到" 等 notFound 落点）
    | 'tag'             // 标签（"标签不存在/未找到"）
    | 'module'          // 模块（"模块不存在/未找到"）
    | 'env'             // 环境（"环境不存在/未找到/无效"）
    | 'owner';          // 负责人/归属人（"负责人不存在/未找到"，区别于 designer 设计人）

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
    // 扩展字段码
    caseInfo: 'case',
    testPoint: 'case',
    stepSeq: 'case',
    // 冷门资源字段码（均为 case 级，行级资源维度）
    caseLib: 'case',
    tag: 'case',
    module: 'case',
    env: 'case',
    owner: 'case',
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
    { field: 'testTaskNo',     aliases: /testTaskNo|test_task_no|测试任务编号|任务编号|阶段信息/ },
    // subTestTaskId：后端错误 "子任务Id...不能为空"
    { field: 'subTestTaskId',  aliases: /subTestTaskId|sub_test_task_id|subTaskId|子任务\s*[Ii][dD]|子任务/ },
    // artifactId：后端错误 "产出物Id不能为空/长度不能超过500个字符"
    { field: 'artifactId',     aliases: /artifactId|artifact_id|产出物\s*[Ii][dD]|产出物/ },
    // designer：后端错误 "设计人不能为空/长度不能超过200个字符/设计人无权限"
    { field: 'designer',       aliases: /designer|设计人/ },

    // ──── caseList[] 行级字段 ────
    // sourceId 补 "案例来源Id"：后端错误 "案例来源Id不能为空/长度不能超过36个字符" 均指向该字段
    // 需排在 sourcePlatform 之前："案例来源Id" 应优先归到 sourceId，避免被 sourcePlatform 的"案例来源"抢先命中
    // 另补 "案例已存在"：后端 "案例已存在请勿重复添加" 是 sourceId 唯一性冲突，归到 sourceId 便于下钻
    { field: 'sourceId',       aliases: /sourceId|testcase_id|testCaseId|案例来源\s*[Ii][dD]|案例唯一标识|案例标识|案例\s*id|案例ID|案例已存在/ },
    // sourcePlatform 案例来源平台：后端错误 "无效的案例来源(TMS/...)/当前不支持案例来源(...)" 均指向该字段
    { field: 'sourcePlatform', aliases: /sourcePlatform|source_platform|案例来源平台|案例来源(?![\s]*[Ii][dD])|来源平台/ },
    { field: 'testCasePath',   aliases: /testCasePath|案例路径|案例\s*path|路径/ },
    { field: 'testCaseName',   aliases: /testCaseName|案例名称|案例\s*name|名称/ },
    { field: 'testCaseDes',    aliases: /testCaseDes|案例描述/ },
    // 步骤/预期数量一致性（stepSeq）需排在 description 之前："步骤描述与预期结果数量不一致"
    // 含"步骤"会被 description 抢先，故先匹配 stepSeq 的"数量不一致/步骤描述与预期结果"
    { field: 'stepSeq',        aliases: /数量不一致|步骤描述与预期结果/ },
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
    // 案例信息（整行必填校验）："案例信息不能为空" 归到 caseInfo，避免 field=undefined 丢失维度
    { field: 'caseInfo',       aliases: /案例信息/ },
    // 测试要点（notFound 类）："任务下未匹配到有效测试要点" / "案例路径错误未匹配到有效测试要点"
    // 均指向 testPoint 字段，便于在 notFound 大类下下钻到具体是哪个要点维度
    { field: 'testPoint',      aliases: /测试要点/ },
    // ──── 冷门资源字段（notFound / fieldInvalid 落点，承载能力/标签/模块/环境等维度下钻） ────
    // 均为独占词，不与上面通用别名冲突，放末尾顺序安全。
    { field: 'caseLib',       aliases: /用例库|案例库|caseLib|case_lib/ },
    { field: 'tag',           aliases: /标签|tag\b|tags/ },
    { field: 'module',        aliases: /模块|module|moduleId|module_id/ },
    { field: 'env',           aliases: /环境|env\b|environment|运行环境|测试环境/ },
    // owner 用"负责人/归属人"区分 designer（设计人）：designer 别名仅含"设计人"，不抢"负责人"
    { field: 'owner',         aliases: /负责人|归属人|owner|ownerId|owner_id/ },
];

/**
 * category → 辅助字段码（兜底维度）。
 * 当自由文本抽不到具体字段（extractInterfaceField 返回 undefined）时，
 * 基于「已命中 category 的业务语义」回退出一个辅助字段，使字段维度更丰富、
 * 减少 undefined 丢失。优先级低于 INTERFACE_FIELD_ALIASES 直接文本抽取。
 *
 * 仅对「字段相关大类」生效（见 FIELD_RELATED_CATEGORIES）；
 * network / auth / yamlSyntax / fileError / emptyFile / serverError / unknown 等
 * 非字段类不在此表（这些 category 本就不该打字段）。
 *
 * 说明：这是"辅助/弱信号"推断，目的是丰富字段维度而非精确判定；
 * 能直接文本命中的场景仍以 extractInterfaceField 为准，二者互斥（先文本后辅助）。
 */
const AUX_FIELD_BY_CATEGORY: Partial<Record<PushFailCategory, PushInterfaceField>> = {
    taskStageMissing: 'testTaskNo',     // 阶段信息强关联测试任务编号
    taskNotFound: 'testTaskNo',         // 任务不存在/未绑定/未找到
    testPointMissing: 'testPoint',      // 任务下未匹配到有效测试要点
    pathNotMatchPoint: 'testCasePath',  // 案例路径错误未匹配到有效测试要点（路径维度）
    checkpointZero: 'expected',         // 检查点数为 0（预期结果维度）
    stepMismatch: 'stepSeq',            // 步骤描述与预期结果数量不一致
    sourceNotSupported: 'sourcePlatform', // 案例来源不被支持（来源平台维度）
    bizReject: 'sourcePlatform',        // 其他业务拒绝（多为来源类，归来源平台便于下钻）
};

/** 基于已命中 category 的辅助字段推断（见 AUX_FIELD_BY_CATEGORY 说明）。 */
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

/** 字段相关 category（仅这些大类才有意义去聚焦到具体字段）。
 *  复合码 `字段.性质`（如 testCaseName.empty / sourceId.dup）天然字段相关，由 isFieldRelatedCategory 判定。
 *  性质级兜底层（fieldEmpty/fieldLength/fieldFormat/enumInvalid/fieldDup）与
 *  checkpointZero/stepMismatch/taskStageMissing/fieldInvalid 等也字段相关。
 *  另含：mapError/placeholder/emptyTestcaseId（客户端预校验，本质是 sourceId 问题）、
 *  notFound/taskNotFound/testPointMissing/pathNotMatchPoint（点名 testTaskNo/subTestTaskId/testPoint/testCasePath）、
 *  sourceNotSupported/bizReject（点名 sourcePlatform）。 */
const FIELD_RELATED_CATEGORIES: PushFailCategory[] = [
    'fieldInvalid', 'fieldEmpty', 'fieldLength', 'fieldFormat', 'enumInvalid', 'fieldDup',
    'checkpointZero', 'stepMismatch', 'taskStageMissing',
    'mapError', 'placeholder', 'emptyTestcaseId',
    'notFound', 'taskNotFound', 'testPointMissing', 'pathNotMatchPoint',
    'sourceNotSupported', 'bizReject',
];

/** 判断某 category 是否字段相关（含复合码 `字段.性质` 与性质级兜底名）。 */
export function isFieldRelatedCategory(cat: PushFailCategory): boolean {
    if (FIELD_RELATED_CATEGORIES.includes(cat)) return true;
    // 复合码：形如 `${field}.${nature}`（含 notFound 性质）
    const m = typeof cat === 'string' ? cat.match(/^(.+)\.(empty|length|format|enum|dup|notFound)$/) : null;
    return !!m;
}

/** 从复合码 `字段.性质` 解析出字段（无需再走文本抽取，更精准）。 */
export function fieldOfComposite(cat: PushFailCategory): PushInterfaceField | undefined {
    if (typeof cat !== 'string') return undefined;
    const m = cat.match(/^(.+)\.(empty|length|format|enum|dup|notFound)$/);
    return m ? (m[1] as PushInterfaceField) : undefined;
}

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
 * 字段来源（用于埋点区分"强信号命中"与"辅助兜底"，并保留兜底项的原样数据）。
 * - structured：客户端结构化信号（mapErrorReason / validatorKind）直接给出字段
 * - text：      后端文本关键词直接命中接口字段（强信号）
 * - aux：       文本抽不到字段，基于已命中 category 的业务语义回退（弱信号兜底）
 */
export type FieldSource = 'structured' | 'text' | 'aux';

/**
 * 统一字段聚焦入口（带来源）：返回 `{ field, source }`，source 区分字段是
 * 结构化信号 / 文本命中 / 辅助兜底推断。供埋点标记辅助兜底项、并透传其原样 reason。
 */
export function failureFieldDetail(input: {
    reason?: string;
    validatorKind?: string;
    mapErrorReason?: string;
    category?: PushFailCategory;
}): { field: PushInterfaceField | undefined; source: FieldSource | undefined } {
    if (input.mapErrorReason && MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason]) {
        return { field: MAP_ERROR_REASON_TO_FIELD[input.mapErrorReason], source: 'structured' };
    }
    // 占位 / 空 tsId 本质是 sourceId（testcase_id）字段问题
    if (input.validatorKind && VALIDATOR_KIND_TO_CATEGORY[input.validatorKind]) {
        return { field: 'sourceId', source: 'structured' };
    }
    const cat = input.category
        ?? classifyFailure({
            reason: input.reason || '',
            validatorKind: input.validatorKind,
            mapErrorReason: input.mapErrorReason,
        });
    if (isFieldRelatedCategory(cat)) {
        // 复合码直接取字段（最精准，避免文本二次抽取歧义）
        const fromComposite = fieldOfComposite(cat);
        if (fromComposite) return { field: fromComposite, source: 'text' };
        // 1) 文本直接抽取字段（强信号，优先）
        const fromText = extractInterfaceField(input.reason || '');
        if (fromText) return { field: fromText, source: 'text' };
        // 2) 辅助字段：文本抽不到时，基于已命中 category 的业务语义回退（弱信号兜底）
        const aux = auxiliaryFieldOf(cat);
        if (aux) return { field: aux, source: 'aux' };
    }
    return { field: undefined, source: undefined };
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
    category?: PushFailCategory;
}): PushInterfaceField | undefined {
    return failureFieldDetail(input).field;
}

/** 单条失败的字段统计（含原文样本，供 UI / 埋点）。level 区分接口级/行级，便于分层展示。
 *  auxSamples 仅收集「辅助兜底推断」出来的项的原样 reason，便于埋点单独透传、区分弱信号。 */
export interface FailureFieldStat {
    field: PushInterfaceField;
    level: PushFieldLevel;
    count: number;
    samples: string[];
    auxSamples: string[];
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
        const detail = failureFieldDetail({
            reason,
            validatorKind: it.validatorKind,
            mapErrorReason: it.mapErrorReason,
            category: it.category,
        });
        const field = it.field ?? detail.field;
        if (!field) continue;
        let stat = buckets.get(field);
        if (!stat) {
            stat = { field, level: FIELD_LEVEL[field], count: 0, samples: [], auxSamples: [] };
            buckets.set(field, stat);
        }
        stat.count++;
        if (stat.samples.length < maxSamples && reason && !stat.samples.includes(reason)) {
            stat.samples.push(reason);
        }
        // 辅助兜底项：原样 reason 全量收集（不受 maxSamples 上限约束），
        // 便于埋点 auxFieldRawSamples 单独透传弱信号推断的原始数据。
        if (detail.source === 'aux' && reason && !stat.auxSamples.includes(reason)) {
            stat.auxSamples.push(reason);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

/**
 * 把辅助兜底项的原样 reason 压成埋点友好的紧凑串（reason || reason 分隔，去重）。
 * 仅含「字段由辅助兜底推断」出来的失败项原文，便于后台区分弱信号并回流补充归类规则。
 * 空聚合返回 ''。
 */
export function summarizeAuxFieldSamples(stats: FailureFieldStat[]): string {
    const all = (stats || []).flatMap(s => s.auxSamples);
    return Array.from(new Set(all.filter(Boolean))).join(' || ');
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
 * - 特例：`unknown` 是未归类措辞，需把「全部」原文 reason 都计入样本（不受 maxSamples 上限约束），
 *   便于后台完整回流、补归类规则，故对 unknown 桶始终收集全部不重复 reason。
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
        // unknown 分类不受样本上限限制，保留全部不重复 reason
        const limit = cat === 'unknown' ? Infinity : maxSamples;
        let stat = buckets.get(cat);
        if (!stat) {
            stat = { category: cat, count: 0, samples: [] };
            buckets.set(cat, stat);
        }
        stat.count++;
        if (stat.samples.length < limit && reason && !stat.samples.includes(reason)) {
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
