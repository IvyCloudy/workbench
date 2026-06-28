/**
 * ============================================================================
 *  utils/pushDataMapper.ts
 *  推送测试案例的字段映射工具
 * ----------------------------------------------------------------------------
 *  作用：
 *    将 YAML/CSV 解析后的数据行映射为后端「推送测试案例」接口
 *    所要求的 caseList[] 字段格式。
 *
 *  仅在「新增测试案例文件」场景（sourcePlatform === 'testAgentMa'）使用，
 *  其他平台请保持原始数据透传。
 *
 *  映射入口 mapRowToCaseItem 会自动识别行的表头风格：
 *    - 含任一中文键（案例名称/案例步骤/预期结果/路径/前置条件/案例类型）→ 中文 CSV 分支
 *    - 否则                                                          → YAML 结构化分支
 *
 *  ── YAML 结构化字段映射 ─────────────────────────────────
 *    接口字段           ← 数据源字段
 *    sourceId          ← testcase_id
 *    testCasePath      ← path
 *    testCaseName      ← name              （案例名称）
 *    testCaseDes       ← description       （案例描述）
 *    testType          ← test_type         （无该字段时默认 '手工'）
 *    type              ← 固定 '功能点类'
 *    priority          ← priority
 *    preCondition      ← preconditions     （数组按 \n 拼为字符串）
 *    description(接口) ← 每个 step 拼为 operation + <br> + data
 *                        （data 多行用 <br> 连接，data 为空时仅输出 operation）
 *                        注：operation 必填，为空将抛错由上层提示
 *    expected(接口)    ← 每个 step 拼为「【UI检查】/【接口检查】/【数据检查】」三段
 *                        任一段为空则跳过对应标题；三段都为空时输出 '' 占位
 *    description 与 expected 数组长度均等于 steps.length，按 step 顺序一一对应
 *
 *  ── 中文 CSV 字段映射 ─────────────────────────────────
 *    接口字段           ← 中文表头
 *    sourceId          ← testcase_id
 *    testCasePath      ← 路径
 *    testCaseName      ← 案例名称
 *    testCaseDes       ← 描述
 *    testType          ← 默认 '手工'
 *    type              ← 案例类型（空 → '功能点类'）
 *    priority          ← 优先级
 *    preCondition      ← 前置条件
 *    description(接口) ← 案例步骤（按 \n 拆为字符串数组；为空抛错）
 *    expected(接口)    ← 预期结果（整段作为单元素数组；为空 ['']）
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

/** 将任意值安全转为字符串（null / undefined → ''；对象 → JSON） */
function toStr(v: any): string {
    if (v == null) return '';
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch { return ''; }
    }
    return String(v);
}

/**
 * 将任意值规整为字符串数组（按行）。
 * - null / undefined / '' → []
 * - 数组：递归展开；元素为对象用 JSON.stringify；空值跳过
 * - 对象：JSON.stringify（单行）
 * - 其他：String(v) 后按 \r?\n 拆行
 * - 最终统一剔除空字符串
 */
function toLines(v: any): string[] {
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
function joinLines(v: any): string {
    return toLines(v).join('\n');
}

/** 中文表头识别：只要行里出现任一中文关键键即视为 CSV 中文风格 */
function isChineseHeaderRow(row: Record<string, any>): boolean {
    if (!row || typeof row !== 'object') return false;
    const ZH_KEYS = ['案例名称', '案例步骤', '预期结果', '路径', '前置条件', '案例类型', '描述', '优先级'];
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

/** 中文 CSV 行 → 接口 caseList[] 项 */
function mapChineseRowToCaseItem(row: Record<string, any>): Record<string, any> {
    const sourceId = toStr(row['testcase_id']).trim();
    const caseTag = sourceId || toStr(row['案例名称']) || '(未命名案例)';

    // sourceId（testcase_id）必填
    if (sourceId === '') {
        throw new Error(`案例 [${caseTag}] 缺少 testcase_id，请补全后再推送。`);
    }

    // description：案例步骤 按 \n 拆为字符串数组；为空抛错
    const stepsText = unescapeCsvCell(row['案例步骤']);
    const description: string[] = stepsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
    if (description.length === 0) {
        throw new Error(`案例 [${caseTag}] 缺少「案例步骤」内容，请补全后再推送。`);
    }

    // expected：预期结果 整段作为单元素数组；为空 ['']
    const expectedText = unescapeCsvCell(row['预期结果']);
    const expected: string[] = expectedText.trim() === '' ? [''] : [expectedText];

    // type：案例类型 → 空兜底为「功能点类」
    const typeStr = toStr(row['案例类型']).trim();

    return {
        sourceId,
        testCasePath: toStr(row['路径']),
        testCaseName: toStr(row['案例名称']),
        testCaseDes:  unescapeCsvCell(row['描述']),
        testType:     '手工',
        type:         typeStr || '功能点类',
        priority:     toStr(row['优先级']),
        preCondition: unescapeCsvCell(row['前置条件']),
        description,
        expected,
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

    // sourceId（testcase_id）必填
    if (sourceId === '') {
        throw new Error(`案例 [${caseTag}] 缺少 testcase_id，请补全后再推送。`);
    }

    // description：每个 step 拼为 operation + <br> + data；operation 必填，为空抛错；与 steps 一一对应
    const description: string[] = steps.map((s, idx) => {
        const op = toStr(s && s.operation).trim();
        if (op === '') {
            throw new Error(`案例 [${caseTag}] 的第 ${idx + 1} 个步骤缺少 operation（操作步骤），请补全后再推送。`);
        }
        const dataLines = toLines(s && s.data).filter((l) => l.trim() !== '');
        return dataLines.length ? `${op}<br>${dataLines.join('<br>')}` : op;
    });

    // expected：每个 step 拼成「【UI检查】/【接口检查】/【数据检查】」三段，空段不拼接；三段都为空时保留 '' 占位；与 steps 一一对应
    const expected: string[] = steps.map((s) => {
        const segs: string[] = [];
        const ui = toLines(s && s.ui_expected).filter((l) => l.trim() !== '');
        const api = toLines(s && s.api_expected).filter((l) => l.trim() !== '');
        const db = toLines(s && s.db_expected).filter((l) => l.trim() !== '');
        if (ui.length) segs.push('【UI检查】\n' + ui.join('\n'));
        if (api.length) segs.push('【接口检查】\n' + api.join('\n'));
        if (db.length) segs.push('【数据检查】\n' + db.join('\n'));
        return segs.join('\n');
    });

    // testType：缺省为「手工」
    const testType = row['test_type'] != null && String(row['test_type']).trim() !== ''
        ? String(row['test_type'])
        : '手工';

    return {
        sourceId,
        testCasePath: toStr(row['path']),
        testCaseName: toStr(row['name']),
        testCaseDes:  toStr(row['description']),
        testType,
        type:         '功能点类',
        priority:     toStr(row['priority']),
        preCondition: joinLines(row['preconditions']),
        description,
        expected,
    };
}
