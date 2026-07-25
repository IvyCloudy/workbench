/**
 * ============================================================================
 *  utils/pushDataMapper.ts
 *  推送测试案例的字段映射工具
 * ----------------------------------------------------------------------------
 *  作用：
 *    将 YAML/CSV 解析后的数据行映射为后端「推送测试案例」接口
 *    所要求的 caseList[] 字段格式。
 *
 *  仅在「新增测试案例文件」场景（sourcePlatform === 'testAgentMA'）使用，
 *  其他平台请保持原始数据透传。
 *
 *  映射入口 mapRowToCaseItem 会自动识别行的表头风格：
 *    - 含任一中文键（名称/步骤描述/预期结果/路径/前置条件/案例类型）→ 中文 CSV 分支
 *    - 否则                                                          → YAML 结构化分支
 *
 *  ── YAML 结构化字段映射 ─────────────────────────────────
 *    接口字段           ← 数据源字段
 *    sourceId          ← testcase_id
 *    testCasePath      ← path
 *    testCaseName      ← name              （案例名称）
 *    testCaseDes       ← description       （案例描述）
 *    testType          ← test_type / 执行方式（空或'手工' → '手工'；其他 → '自动化'）
 *    type              ← 固定 '功能点类'
 *    priority          ← priority
 *    preCondition      ← preconditions     （数组按 \n 拼为字符串）
 *    description(接口) ← 每个 step 拼为 operation + <br> + data
 *                        （data 多行用 <br> 连接，data 为空时仅输出 operation）
 *                        注：operation 必填，为空将抛错由上层提示
 *    expected(接口)    ← 每个 step 拼为「【UI检查】/【接口调用】/【数据检查】」三段
 *                        任一段为空则跳过对应标题；三段都为空时输出 '' 占位
 *    description 与 expected 数组长度均等于 steps.length，按 step 顺序一一对应
 *
 *  ── 中文 CSV 字段映射 ─────────────────────────────────
 *    接口字段           ← 中文表头
 *    sourceId          ← testcase_id
 *    testCasePath      ← 路径
 *    testCaseName      ← 名称
 *    testCaseDes       ← 案例描述
 *    testType          ← 执行方式（空或'手工' → '手工'；其他 → '自动化'）
 *    type              ← 案例类型（空 → '功能点类'）
 *    priority          ← 优先级
 *    preCondition      ← 前置条件
 *    description(接口) ← 步骤描述（解析「步骤x[:：]\n内容」结构，按步骤号提取）
 *                        若文本不含「步骤N:」但非空，整段作为步骤1
 *    expected(接口)    ← 预期结果（同上解析，按 description 步骤号对齐，缺步骤填 ''）
 *                        若文本不含「步骤N:」但含【UI检查】/【接口调用】/【数据检查】
 *                        且非空，则整段视为步骤1的预期
 *    description 与 expected 数组长度始终相等，按步骤号一一对应
 *
 *  ── 通用规则 ─────────────────────────────────────────
 *    1. sourceId（即 testcase_id）必填，缺失时抛错。
 *    2. CSV 单元格中的字面量 `\n` / `\r\n` / `\t` 会被 unescapeCsvCell
 *       还原为真实换行/制表符，便于按行拆分。
 *       潜在风险：如果单元格内容**本身就是字面量反斜杠 + n**
 *       （如代码片段 `"\\n"`），会被误判为换行符；当前样例文件不会触发，
 *       使用方需注意。
 * ============================================================================
 */

// ============================================================================
// 结构化映射错误
// ----------------------------------------------------------------------------
// 目的：让调用侧（pushCore.ts）可以在 catch 时判定错误来源、直接拿到"主表 1-based 行号"，
//       再拼接出"第 N 行 案例 [xxx] 的第 K 个步骤缺少 operation ..."这样的
//       用户友好文案，而不需要用正则去匹配 message。
//
// 行号来源：
//   上层会在每行 row 对象上预贴 __rowIndex 字段（主表 1-based 行号），
//   该字段仅作为"本地元数据"横穿整条映射链路，不会被拼接到推送后端 body 中
//   （mapper 只读特定业务字段，未知字段天然被忽略）。
//
// 字段说明：
//   caseTag  —— 案例标识（testcase_id / 名称 / (未命名案例)），保持与 message 一致
//   reason   —— 错误原因短标签，便于埋点归类（如 'missingTestcaseId' / 'missingOperation'）
//   stepIdx  —— 步骤下标（0-based），仅在 reason='missingOperation' 时有值
//   rowIndex —— 主表行号（1-based），从 row.__rowIndex 读取；上层未预贴时为 undefined
// ============================================================================
export interface MapErrorFields {
    caseTag: string;
    reason: 'missingTestcaseId' | 'missingOperation' | 'missingStepDesc' | 'missingTestCaseDes' | 'missingExpected' | 'invalidPath';
    stepIdx?: number;
    rowIndex?: number;
}

/** 用于识别映射错误的品牌字段，避免 instanceof 跨 realm 不可靠 */
export const MAP_ERROR_BRAND = '__pushDataMapperError__';

/** row 上预贴主表行号的隐藏字段名（双下划线 + 英文：不会与任何业务字段冲突） */
export const ROW_INDEX_META = '__rowIndex';

/** 从 row 中安全提取主表行号（不存在 / 非正整数 → undefined） */
function pickRowIndex(row: any): number | undefined {
    if (!row || typeof row !== 'object') return undefined;
    const v = (row as any)[ROW_INDEX_META];
    return typeof v === 'number' && v > 0 && Number.isInteger(v) ? v : undefined;
}

/** 创建带结构化字段的映射错误（Error 子类，保留原 message 兼容旧日志） */
function makeMapError(message: string, fields: MapErrorFields): Error {
    const err = new Error(message) as Error & MapErrorFields & { [MAP_ERROR_BRAND]: true };
    err.caseTag = fields.caseTag;
    err.reason = fields.reason;
    if (fields.stepIdx !== undefined) err.stepIdx = fields.stepIdx;
    if (fields.rowIndex !== undefined) err.rowIndex = fields.rowIndex;
    (err as any)[MAP_ERROR_BRAND] = true;
    return err;
}

/** 判断是否是映射错误（可跨 realm，基于品牌字段） */
export function isMapError(err: any): err is Error & MapErrorFields {
    return !!(err && err[MAP_ERROR_BRAND] === true);
}

/** 将任意值安全转为字符串（null / undefined → ''；对象 → JSON） */
export function toStr(v: any): string {
    if (v == null) return '';
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch { return ''; }
    }
    return String(v);
}

/** 将字符串中的换行符 \n 替换为 <br>，用于推送时的步骤描述格式化 */
function nl2br(v: any): string {
    return toStr(v).replace(/\n/g, '<br>');
}

/**
 * 将任意值规整为字符串数组（按行）。
 * - null / undefined / '' → []
 * - 数组：递归展开；元素为对象用 JSON.stringify；空值跳过
 * - 对象：JSON.stringify（单行）
 * - 其他：String(v) 后按 \r?\n 拆行
 * - 最终统一剔除空字符串
 */
export function toLines(v: any): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) {
        const out: string[] = [];
        for (const item of v) {
            if (item == null) continue;
            if (Array.isArray(item) || typeof item === 'object') {
                const s = toStr(item);
                if (s !== '') out.push(s);
            } else {
                const s = String(item);
                if (s !== '') out.push(s);
            }
        }
        return out;
    }
    if (typeof v === 'object') {
        const s = toStr(v);
        return s === '' ? [] : [s];
    }
    return String(v).split(/\r?\n/).filter((s) => s !== '');
}

/** 把任意值按 \n 拼成单字符串（空值 → ''） */
export function joinLines(v: any): string {
    return toLines(v).join('\n');
}

/**
 * 校验并标准化路径：空值返回空字符串；非空非字符串/仅空白/标准化后无效 → 抛错；
 * 合法路径 → 去掉开头 /，确保结尾有 /。
 */
function normalizePath(path: string): string {
    if (path == null || path === '') return '';
    if (typeof path !== 'string') {
        throw new Error('路径类型错误：期望字符串，实际为 ' + typeof path);
    }
    var p = path.trim();
    if (!p) {
        throw new Error('路径为空或仅含空白字符');
    }
    // 兼容 Windows 风格分隔符：反斜杠 \、全角 ／、间隔点 · 统一转为正斜杠 /，
    // 与关联匹配侧的 normalizePointPath 保持一致的分隔符规则，避免推送出去的路径
    // 仍以 \ 分割导致后端按 / 解析失败。
    p = p.replace(/[\\／·]+/g, '/');
    if (p.charAt(0) === '/') p = p.slice(1);
    if (p.charAt(p.length - 1) !== '/') p = p + '/';
    if (!p || p === '/') {
        throw new Error('路径标准化后无效，原始值: "' + path + '"');
    }
    return p;
}

/**
 * 取字段值：若字段存在且值不为空则使用原值（类型对齐默认值），否则返回默认值。
 * 默认判空规则：null / undefined / ''（空字符串），也可通过 emptyFn 自定义。
 *
 * 类型对齐规则（以 fallback 的 typeof 为准）：
 *   - fallback 是 string  → 原值非字符串时走 toStr()（number/boolean/object 统一转字符串）
 *   - fallback 是 number  → 原值尝试 Number()，非法数字（如 "abc"）回退到原值
 *   - fallback 是 boolean → 原值尝试 "true"/"false" → true/false
 *   - 类型已一致或无法匹配 → 原样返回
 *
 * @example
 *   fieldOrDefault(row, 'name', '未命名')            // string 兜底
 *   fieldOrDefault(row, 'type', '功能点类')           // string 兜底
 *   fieldOrDefault(row, 'count', 0, v => v == null)  // number 兜底，200 → 200
 */
export function fieldOrDefault(row: Record<string, any>, field: string, fallback: any, emptyFn?: (v: any) => boolean): any {
    if (!row || typeof row !== 'object') return fallback;
    if (!Object.prototype.hasOwnProperty.call(row, field)) return fallback;
    var v = row[field];
    var isEmpty = emptyFn || function (x: any) { return x == null || x === ''; };
    if (isEmpty(v)) return fallback;
    // 类型已一致，直接返回
    if (typeof v === typeof fallback) return v;
    // 按 fallback 类型对齐
    if (typeof fallback === 'string') return toStr(v);
    if (typeof fallback === 'number') {
        var n = Number(v);
        return isNaN(n) ? v : n;
    }
    if (typeof fallback === 'boolean') {
        var s = String(v).trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
        return v;
    }
    return v;
}

/** 中文表头识别：只要行里出现任一中文关键键即视为 CSV 中文风格 */
function isChineseHeaderRow(row: Record<string, any>): boolean {
    if (!row || typeof row !== 'object') return false;
    const ZH_KEYS = ['名称', '步骤描述', '预期结果', '路径', '前置条件', '案例类型', '优先级'];
    return ZH_KEYS.some((k) => Object.prototype.hasOwnProperty.call(row, k));
}

/**
 * CSV 反转义：CSV 单元格里通常用字面量 \n / \r\n 表示换行，
 * 这里把字面量 \n、\r\n、\t 还原为真实控制字符，便于按行拆分。
 */
function unescapeCsvCell(v: any): string {
    const s = toStr(v);
    return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * 从「步骤x[:：]\n内容」格式的文本中解析出 {步骤号, 内容} 数组。
 * 步骤号用于后续 description 与 expected 按序号对齐。
 */
function parseStepBlocks(text: string): Array<{ num: number; content: string }> {
    const blocks: Array<{ num: number; content: string }> = [];
    const regex = /步骤(\d+)[:：]\s*\r?\n?/g;

    // 先收集所有分隔符的位置和步骤号
    const delimiters: Array<{ num: number; start: number; end: number }> = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        delimiters.push({ num: parseInt(match[1]), start: match.index, end: match.index + match[0].length });
    }

    // 提取每段内容
    for (let i = 0; i < delimiters.length; i++) {
        const contentStart = delimiters[i].end;
        const contentEnd = i + 1 < delimiters.length ? delimiters[i + 1].start : text.length;
        const content = text.slice(contentStart, contentEnd).trim();
        if (content !== '') {
            blocks.push({ num: delimiters[i].num, content });
        }
    }

    return blocks;
}

/** 中文 CSV 行 → 接口 caseList[] 项 */
function mapChineseRowToCaseItem(row: Record<string, any>): Record<string, any> {
    const sourceId = toStr(row['testcase_id']).trim();
    const caseTag = sourceId || toStr(row['名称']) || '(未命名案例)';
    const rowIndex = pickRowIndex(row);

    // sourceId（testcase_id）必填
    if (sourceId === '') {
        throw makeMapError(
            `案例 [${caseTag}] 缺少 testcase_id，请补全后再推送。`,
            { caseTag, reason: 'missingTestcaseId', rowIndex }
        );
    }

    // 案例描述（testCaseDes）必填：空/仅空白 → 抛错
    const testCaseDesRaw = unescapeCsvCell(row['案例描述']);
    if (testCaseDesRaw.trim() === '') {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「案例描述」，请补全后再推送。`,
            { caseTag, reason: 'missingTestCaseDes', rowIndex }
        );
    }

    // description：解析「步骤x[:：]\n内容」格式，按步骤号排序
    // 兼容：若文本中不含「步骤N:」结构但整段非空，则整段视为「步骤1」的内容
    //       （适配用户只写单步骤时直接写正文，不加"步骤1:"前缀的常见习惯）
    const stepsText = unescapeCsvCell(row['步骤描述']);
    let descBlocks = parseStepBlocks(stepsText);
    if (descBlocks.length === 0 && stepsText.trim() !== '') {
        descBlocks = [{ num: 1, content: stepsText.trim() }];
    }
    const description: string[] = descBlocks.map(b => nl2br(b.content));
    if (description.length === 0) {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「步骤描述」内容，请补全后再推送。`,
            { caseTag, reason: 'missingStepDesc', rowIndex }
        );
    }

    // expected：解析同格式文本，按 description 的步骤号顺序对齐，
    //           缺失的步骤填充空字符串，确保 expected 长度始终等于 description
    // 兼容：若文本中不含「步骤N:」结构但含【UI检查】/【接口调用】/【数据检查】标签
    //       且整段非空，则整段视为「步骤1」的预期结果（与步骤描述回退规则对称）
    const expectedText = unescapeCsvCell(row['预期结果']);
    let expBlocks = parseStepBlocks(expectedText);
    if (expBlocks.length === 0
        && /【\s*(UI检查|接口调用|数据检查)\s*】/.test(expectedText)
        && expectedText.trim() !== '') {
        expBlocks = [{ num: 1, content: expectedText.trim() }];
    }
    const expMap = new Map(expBlocks.map(b => [b.num, b.content]));
    const expected: string[] = descBlocks.map(b => expMap.get(b.num) ?? '');
    // 预期结果必填：至少要有一步存在非空预期，否则视为整体缺失预期
    if (expected.every(e => toStr(e).trim() === '')) {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「预期结果」，请补全后再推送。`,
            { caseTag, reason: 'missingExpected', rowIndex }
        );
    }

    // testType：执行方式 → 空或'手工' → '手工'；其他 → '自动化'
    const execMethod = toStr(row['执行方式']).trim();
    const testType = (!execMethod || execMethod === '手工') ? '手工' : '自动化';

    return {
        sourceId,
        testCasePath: normalizePath(row['路径']),
        testCaseName: fieldOrDefault(row, '名称', ''),
        testCaseDes:  unescapeCsvCell(row['案例描述']),
        testType,
        type:         fieldOrDefault(row, '案例类型', '功能点类'),
        priority:     fieldOrDefault(row, '优先级', '低'),
        preCondition: nl2br(unescapeCsvCell(row['前置条件'])),
        description,
        expected,
        keyFlag: fieldOrDefault(row, '关键案例', '否'),
        projectDes: fieldOrDefault(row, '项目说明', ''),
        planExecNum: fieldOrDefault(row, '计划执行次数', 1)
    };
}

/**
 * 将单条数据行映射为接口 caseList[] 项。
 *  - 识别中文表头 → 走 mapChineseRowToCaseItem
 *  - 否则按 YAML 结构化字段映射
 */
export function mapRowToCaseItem(row: Record<string, any>): Record<string, any> {
    if (isChineseHeaderRow(row)) {
        return mapChineseRowToCaseItem(row);
    }

    const steps: any[] = Array.isArray(row['steps']) ? row['steps'] : [];

    const sourceId = toStr(row['testcase_id']).trim();
    // 案例标识，用于报错定位
    const caseTag = sourceId || toStr(row['name']) || '(未命名案例)';
    const rowIndex = pickRowIndex(row);

    // sourceId（testcase_id）必填
    if (sourceId === '') {
        throw makeMapError(
            `案例 [${caseTag}] 缺少 testcase_id，请补全后再推送。`,
            { caseTag, reason: 'missingTestcaseId', rowIndex }
        );
    }

    // 案例描述（testCaseDes）必填：空/仅空白 → 抛错
    const testCaseDesRaw = toStr(row['description']);
    if (testCaseDesRaw.trim() === '') {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「案例描述」（description），请补全后再推送。`,
            { caseTag, reason: 'missingTestCaseDes', rowIndex }
        );
    }

    // steps 必填：steps 缺失或为空数组时，description / expected 都会是 []，
    // 后端不接受空列表，前置拦截并给出更明确的报错定位。
    if (steps.length === 0) {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「步骤」（steps），请补全后再推送。`,
            { caseTag, reason: 'missingStepDesc', rowIndex }
        );
    }

    // description：每个 step 拼为 operation + <br> + data；operation 必填，为空抛错；与 steps 一一对应
    const description: string[] = steps.map((s, idx) => {
        const op = toStr(s && s.operation).trim();
        if (op === '') {
            throw makeMapError(
                `案例 [${caseTag}] 的第 ${idx + 1} 个步骤缺少 operation（操作步骤），请补全后再推送。`,
                { caseTag, reason: 'missingOperation', stepIdx: idx, rowIndex }
            );
        }
        const dataLines = toLines(s && s.data).filter((l) => l.trim() !== '');
        return dataLines.length ? `${nl2br(op)}<br>${dataLines.join('<br>')}` : nl2br(op);
    });

    // expected：每个 step 拼成「【UI检查】/【接口调用】/【数据检查】」三段，空段不拼接；三段都为空时保留 '' 占位；与 steps 一一对应
    const expected: string[] = steps.map((s) => {
        const segs: string[] = [];
        const ui = toLines(s && s.ui_expected).filter((l) => l.trim() !== '');
        const api = toLines(s && s.api_expected).filter((l) => l.trim() !== '');
        const db = toLines(s && s.db_expected).filter((l) => l.trim() !== '');
        if (ui.length) segs.push('【UI检查】\n' + ui.join('\n'));
        if (api.length) segs.push('【接口调用】\n' + api.join('\n'));
        if (db.length) segs.push('【数据检查】\n' + db.join('\n'));
        return segs.join('\n');
    });
    // 预期结果必填：至少要有一步存在非空预期（ui/api/db 任一段填了即可），否则视为整体缺失预期
    if (expected.length === 0 || expected.every(e => toStr(e).trim() === '')) {
        throw makeMapError(
            `案例 [${caseTag}] 缺少「预期结果」（每个步骤的 ui_expected / api_expected / db_expected 至少填其一），请补全后再推送。`,
            { caseTag, reason: 'missingExpected', rowIndex }
        );
    }

    // testType：执行方式 → 空或'手工' → '手工'；其他 → '自动化'
    const testTypeRaw = row['test_type'] != null && String(row['test_type']).trim() !== ''
        ? String(row['test_type']).trim()
        : '';
    const testType = (!testTypeRaw || testTypeRaw === '手工') ? '手工' : '自动化';

    return {
        sourceId,
        testCasePath: normalizePath(row['path']),
        testCaseName: fieldOrDefault(row, 'name', ''),
        testCaseDes:  fieldOrDefault(row, 'description', ''),
        testType,
        type:         '功能点类',
        priority:     fieldOrDefault(row, 'priority', '低'),
        preCondition: nl2br(joinLines(row['preconditions'])),
        description,
        expected,
        keyFlag: fieldOrDefault(row, 'key_flag', '否'),
        projectDes: fieldOrDefault(row, 'project_des', ''),
        planExecNum: fieldOrDefault(row, 'plan_exec_num', 1)
    };
}
