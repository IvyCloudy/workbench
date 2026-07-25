/**
 * ============================================================================
 *  linkerDiagnosticHandler.ts
 *  测试要点 ⇄ 测试案例 关联匹配 · 公共 API 集合
 * ----------------------------------------------------------------------------
 *  定位：业务级公共方法汇（严格 1:1 语义：一个测试要点文件最多绑定一个测试案例文件）：
 *    ☆ getLinkedCasesByMdFile      业务级一站入口（1 要点文件进 → envelope 出）
 *    ☆ linkAndAggregateCases       匹配聚合纯函数（1 pointList + 1 case → envelope）
 *    ☆ parseMdToPointListSilent    md 静默解析
 *    ☆ parseXmindToPointListSilent xmind 静默解析（引自 utils/parseXmindToPointList）
 *    ☆ LinkedCasesEnvelope / LinkedCaseItem 类型定义
 *
 *  命令面板入口 handleLinkerDiagnostic 已于 2026-07-25 拆到 [linkerDiagnosticCommand.ts]；
 *  历史右键入口 handleViewLinkedCases（testcaseViewer.viewLinkedCases）已于
 *  同日合并到 diagnosticLinker，命令/埋点均已下线。
 *
 *  ⚠️ 缓存策略：底层引擎 LRU 用 filePath + mtimeMs + size 作为 key，
 *     文件保存后立即失效；如需查看编辑器内未保存的改动，请先保存要点/案例文件。
 * ============================================================================
 */
import * as path from 'path';
import * as fs from 'fs';
import {
    linkPointsToCases,
    normalizePointPath,
    type PointItem,
    type LinkOptions,
    type LinkResult,
} from '../utils/pointCaseLinker';
import { getCaseOfPoint } from '../utils/pointCaseBindingStore';
import {
    parseXmindToPointListSilent,
    type XmindInvalidNode,
    type XmindWarning,
} from '../utils/parseXmindToPointList';

// ============================================================================
// 中文 CSV 表头兼容
// ----------------------------------------------------------------------------
// 现状：底层引擎按英文字段名（parent_id / path / testcase_id / name）取值；
//       如果案例文件是「中文表头 CSV」（examples/case_example.csv 那类），
//       首行会是 `名称,路径,前置条件,...`，直接用英文字段取值全部为空 → 0 命中。
// 兼容策略：在调引擎前探测首行表头，命中中文关键字段时，把 LinkOptions 的
//       字段名指向对应中文键。中文 CSV 无 parent_id 字段，因此只能命中 type=3
//       （path 兜底），这是数据模型的天花板，非代码缺陷。
// ============================================================================
/** 中文 CSV 表头到引擎字段的映射：只覆盖 linker 需要的四个字段 */
const CN_HEADER_ALIAS: Record<keyof Pick<LinkOptions, 'pathField' | 'caseNameField' | 'caseIdField' | 'parentIdField' | 'preconditionFields' | 'expectedFields'>, string[]> = {
    // 名称 / 用例名 / 案例名
    caseNameField: ['名称', '用例名称', '案例名称', '测试案例名称'],
    // 路径 / 用例路径
    pathField: ['路径', '用例路径', '案例路径'],
    // 用例编号 / 案例编号（testcase_id 保持英文名兼容原模板）
    caseIdField: ['用例编号', '案例编号', 'testcase_id'],
    // 中文模板通常无 parent_id，仅列出可能的中文别名兜底
    parentIdField: ['父点编号', '所属要点', 'parent_id'],
    // 前置条件（中文 CSV 列名）
    preconditionFields: ['前置条件', '前置', 'preconditions', 'pre_condition'],
    // 预期结果（中文 CSV 列名，已是转换好的成品文本，含【UI检查】等标签）
    expectedFields: ['预期结果', '预期', 'expected', 'expectedResult'],
};

/** 探测案例文件是否为「中文表头 CSV」，返回可注入 LinkOptions 的字段名映射。
 *  - 仅处理 .csv；yaml/json 由用户按约定使用英文字段（现状已支持）
 *  - 只读首行（<= 8KB），性能开销可忽略
 *  - 探测失败或非中文表头 → 返回 undefined，保持默认字段名
 */
function detectCsvHeaderOptions(filePath: string): Partial<LinkOptions> | undefined {
    try {
        if (!/\.csv$/i.test(filePath)) return undefined;
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(8192);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const head = buf.slice(0, n).toString('utf-8');
            const firstLine = head.split(/\r?\n/)[0] || '';
            if (!firstLine) return undefined;
            // 简单按逗号切；单元格里带逗号+引号的极端情况这里不深究——不影响关键词匹配
            const headers = firstLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            const set = new Set(headers);
            // 若首行完全没有中文，直接短路
            if (!headers.some(h => /[\u4e00-\u9fff]/.test(h))) return undefined;

            const out: Partial<LinkOptions> = {};
            // LinkOptions 中 preconditionFields / expectedFields 是 string[]，
            // 其余（pathField 等）是 string；数组字段需包成数组返回，否则
            // buildCaseDetail 会按字符遍历字段名而读不到值。
            const ARRAY_KEYS = new Set<keyof typeof CN_HEADER_ALIAS>(['preconditionFields', 'expectedFields']);
            for (const key of Object.keys(CN_HEADER_ALIAS) as (keyof typeof CN_HEADER_ALIAS)[]) {
                const aliases = CN_HEADER_ALIAS[key];
                const hit = aliases.find(a => set.has(a));
                if (hit) (out as any)[key] = ARRAY_KEYS.has(key) ? [hit] : hit;
            }
            return Object.keys(out).length > 0 ? out : undefined;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return undefined;
    }
}

// ----------------------------------------------------------------------------
// 【墓碑】handleViewLinkedCases / testcaseViewer.viewLinkedCases（2026-07-25 已下线）
//   已合并至 handleLinkerDiagnostic（拆分后位于 linkerDiagnosticCommand.ts）；
//   如需业务级复用，请调用 getLinkedCasesByMdFile。
//   埋点 viewLinkedCases.done / viewLinkedCases.error 已停发。
// ----------------------------------------------------------------------------

// ============================================================================
// ★★★ 公共方法：查看关联案例（可被任意上层调用方复用） ★★★
// ----------------------------------------------------------------------------
// 职责边界（保持纯净）：
//   ✅ 只做「单文件匹配 + 聚合成约定格式」
//   ❌ 不读绑定配置、不解析 md、不打 log、不弹 toast、不依赖 VSCode API
//
// 1:1 语义：一个测试要点 md 最多绑定一个测试案例文件，因此本函数只处理**单个**
// 案例文件（filePath 为字符串）。若未来需要支持 N 个文件，请另加批量函数，
// 不要在此扩参数，避免语义漂移。
// ============================================================================
/**
 * 【公共方法】根据 pointList 与 单个案例文件路径，返回约定格式的关联结果。
 *
 * @param pointList  测试要点列表（{ pointId, pointName, pointPath }[]）
 * @param filePath   测试案例文件绝对路径（.yaml/.yml/.json/.csv）
 * @returns          约定格式的 envelope：{ total, errorMsg, data, stats? }
 */
export async function linkAndAggregateCases(
    pointList: PointItem[],
    filePath: string,
): Promise<LinkedCasesEnvelope> {
    // ---- 入参校验（错误消息统一中文提示、面向最终用户）----
    if (!Array.isArray(pointList) || pointList.length === 0) {
        return { total: 0, errorMsg: '未传入任何测试要点', data: {} };
    }
    if (!filePath || typeof filePath !== 'string') {
        return { total: 0, errorMsg: '未传入测试案例文件', data: {} };
    }

    // ---- 单文件匹配（针对中文表头 CSV 做字段名兼容） ----
    let r!: LinkResult;
    try {
        const csvOpts = detectCsvHeaderOptions(filePath);
        r = await linkPointsToCases(filePath, pointList, csvOpts ?? {});
    } catch (err: any) {
        return { total: 0, errorMsg: `匹配失败: ${err?.message || err}`, data: {} };
    }

    // ---- 聚合成约定格式（单文件场景下无需去重，直接透传）----
    const data: Record<string, LinkedCaseItem[]> = {};
    for (const [pointKey, cases] of Object.entries(r.byPoint)) {
        data[pointKey] = cases.map(c => ({
            testcase_id: c.testcase_id,
            caseName: c.caseName,
            casePath: c.casePath,
            caseDetail: c.caseDetail,
            type: c.type,
            filePath,
        }));
    }

    return {
        total: r.stats.matchedRecords,
        errorMsg: '',
        data,
        stats: {
            totalRecords: r.stats.totalRecords,
            typeCount: { ...r.stats.matchedByType },
            totalOrphan: r.stats.orphanRecords,
            totalStripped: r.stats.strippedParentIds,
            duplicatePointIds: r.stats.duplicatePointIds,
            multiHitCases: r.stats.multiHitCases,
        },
    };
}

// ============================================================================
// ★★★ 高层公共方法：一个测试要点 md → 约定 envelope ★★★
// ----------------------------------------------------------------------------
// 定位：面向业务调用方的「一站式」入口
//   - 入参：单个测试要点 md 的绝对路径（字符串）
//   - 出参：约定格式的 envelope
// 内部流程：
//   1. 校验 mdPath
//   2. parseMdToPointListSilent(mdPath)  → pointList
//   3. getCaseOfPoint(mdPath)            → 唯一绑定的案例文件绝对路径（1:1）
//   4. 校验案例文件在磁盘上仍存在
//   5. linkAndAggregateCases(pointList, casePath) → envelope
// ============================================================================
/**
 * 【推荐入口】根据测试要点 md 路径，获取其关联的测试案例（约定 envelope 格式）。
 *
 * @param mdPath   测试要点 .md 的绝对路径
 * @returns        约定 envelope：{ total, errorMsg, data, stats? }
 *
 * 错误场景（envelope.errorMsg 非空、total=0、data={}）：
 *   - mdPath 为空 / 非字符串
 *   - md 中未解析出任何测试点
 *   - 该 md 未绑定测试案例文件（提示用户去做绑定）
 *   - 绑定的案例文件已在磁盘缺失
 *   - 匹配过程抛错
 */
export async function getLinkedCasesByMdFile(
    mdPath: string,
): Promise<LinkedCasesEnvelope> {
    // 1) 入参校验
    if (!mdPath || typeof mdPath !== 'string') {
        return { total: 0, errorMsg: '未拿到测试要点文件路径', data: {} };
    }
    // 1.1) 扩展名分派：目前支持 .md 与 .xmind
    //      不同扩展名走不同 parser，出参统一收敛到 PointItem[] + 可选的结构诊断信息
    const ext = path.extname(mdPath).toLowerCase();
    let pointList: PointItem[];
    let xmindInvalidNodes: XmindInvalidNode[] | undefined;
    let xmindWarnings: XmindWarning[] | undefined;
    if (ext === '.md') {
        pointList = await parseMdToPointListSilent(mdPath);
        if (pointList.length === 0) {
            return {
                total: 0,
                errorMsg: '未从 md 解析出测试点，请检查表头格式（需为 `| 序号 | 测试点 | ... |`）',
                data: {},
            };
        }
    } else if (ext === '.xmind') {
        const xr = await parseXmindToPointListSilent(mdPath);
        pointList = xr.pointList;
        xmindInvalidNodes = xr.invalidNodes.length > 0 ? xr.invalidNodes : undefined;
        xmindWarnings = xr.warnings.length > 0 ? xr.warnings : undefined;
        if (xr.errorMsg) {
            // 结构错误 / 读取错误 → 直接短路返回，携带清单供上层写 Output Channel
            return {
                total: 0,
                errorMsg: xr.errorMsg,
                data: {},
                xmindInvalidNodes,
                xmindWarnings,
            };
        }
        if (pointList.length === 0) {
            return {
                total: 0,
                errorMsg: '未从 xmind 解析出测试点，请确认存在带「五角星」图标的节点',
                data: {},
                xmindWarnings,
            };
        }
    } else {
        return {
            total: 0,
            errorMsg: `暂不支持的测试要点文件类型：${ext || '(无后缀)'}，当前支持 .md / .xmind`,
            data: {},
        };
    }

    // 3) 读绑定配置 → 唯一的案例文件绝对路径（1:1）
    const casePath = getCaseOfPoint(mdPath);
    if (!casePath) {
        return {
            total: 0,
            errorMsg: '当前测试要点尚未绑定测试案例，请选择文件右键绑定后再试',
            data: {},
        };
    }

    // 4) 校验案例文件在磁盘上仍存在
    try {
        if (!fs.existsSync(casePath) || !fs.statSync(casePath).isFile()) {
            return { total: 0, errorMsg: '绑定的测试案例文件已缺失', data: {} };
        }
    } catch {
        return { total: 0, errorMsg: '绑定的测试案例文件已缺失', data: {} };
    }

    // 5) 调用底层单文件匹配 + 聚合；xmind 侧的结构诊断信息随 envelope 一并回传
    const envelope = await linkAndAggregateCases(pointList, casePath);
    if (xmindInvalidNodes) envelope.xmindInvalidNodes = xmindInvalidNodes;
    if (xmindWarnings) envelope.xmindWarnings = xmindWarnings;
    return envelope;
}

// ============================================================================
// 约定的出参类型
// ============================================================================
/** 每条命中案例（作为 data[pointKey] 中的元素） */
export interface LinkedCaseItem {
    testcase_id: string;
    caseName: string;
    /** 案例记录中的 path 字段（功能条目/测试要点路径） */
    casePath: string;
    caseDetail: string;
    type: 1 | 2 | 3;
    /** 该案例所在的源文件绝对路径 */
    filePath: string;
}

/** 「查看关联案例」命令的整体出参包裹 */
export interface LinkedCasesEnvelope {
    /** 命中的案例总条数（== matchedRecords） */
    total: number;
    /** 错误信息；无错时为空字符串 */
    errorMsg: string;
    /** 约定的主数据：{ "${pointId}_${pointName}": LinkedCaseItem[] } */
    data: Record<string, LinkedCaseItem[]>;
    /** 可选统计信息（仅公共方法内部聚合成功时提供，便于上层做诊断/打点） */
    stats?: {
        totalRecords: number;
        typeCount: { type1: number; type2: number; type3: number };
        totalOrphan: number;
        totalStripped: number;
        /** 输入 pointList 中重复的 pointId（脏数据信号） */
        duplicatePointIds?: string[];
        /** 同一 case 被多个 point 命中的 testcase_id（脏数据信号） */
        multiHitCases?: string[];
    };
    /** xmind 解析结构错误清单（仅 xmind 源、且中间存在无图标节点时非空） */
    xmindInvalidNodes?: XmindInvalidNode[];
    /** xmind 解析脏数据告警（如多 label 等，不阻断解析） */
    xmindWarnings?: XmindWarning[];
}

/**
 * 【公共方法】从测试要点 md 中解析出 pointList（静默：不写 Output Channel）
 *
 * 规则：
 *   1. 找到形如「功能条目：xxx / yyy」的行，作为 pointPath 的「功能条目前缀」
 *      （会归一化：\ → /、全角 ／· → /、折叠连续/首尾斜杠、去两侧空格）；
 *      若找不到，则退化为文件名（去后缀）作为功能条目前缀。
 *   2. 找表格首行为「| 序号 | 测试点 | ... |」的表，取每行的前两列作为 pointId / pointName。
 *   3. 每行最终的 pointPath = 功能条目前缀 用 '/' 拼接 测试点名称，
 *      再整体归一化（兼容「功能条目尾部缺/或多/、用\」等写法，确保与案例侧 path 一致）。
 */
export async function parseMdToPointListSilent(mdPath: string): Promise<PointItem[]> {
    let text: string;
    try {
        text = await fs.promises.readFile(mdPath, 'utf-8');
    } catch {
        // 真静默：既不弹 UI、也不向 console 泄露，日志交给上层自行决定
        return [];
    }
    const lines = text.split(/\r?\n/);

    // 功能条目前缀（pointPath 的父级部分）
    // 兼容 md 中功能条目路径的多种写法：
    //   - 反斜杠 \（Windows 风格）       账户中心\登录模块
    //   - 全角斜杠 ／、间隔点 ·
    //   - 尾部缺 / 或多余 /（账户中心/登录模块 与 账户中心/登录模块/ 等价）
    //   - 分隔符两侧多余空格
    // 统一交给 normalizePointPath 归一化为「/ 分隔、无首尾斜杠」的标准形式，
    // 与底层匹配引擎（buildIndex / matchCore）使用同一套规则，避免 md 侧与
    // 案例侧出现「\ 对 /」「有无尾斜杠」的匹配不一致。
    let funcPrefix = '';
    for (const line of lines) {
        const m = line.match(/功能条目\s*[:：]\s*(.+?)\s*$/);
        if (m) {
            funcPrefix = normalizePointPath(m[1]);
            break;
        }
    }
    if (!funcPrefix) funcPrefix = path.basename(mdPath, path.extname(mdPath));

    // 表格
    const result: PointItem[] = [];
    let inTable = false;
    let idIdx = -1;
    let nameIdx = -1;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('|')) { inTable = false; idIdx = -1; nameIdx = -1; continue; }
        const cells = splitMdRow(line);
        if (!inTable) {
            // 表头列名弹性识别，兼容不同团队叫法
            const idI = cells.findIndex(c => /^(序号|编号|点号|id|pointId)$/i.test(c.trim()));
            const nameI = cells.findIndex(c => /^(测试点|测试要点|要点|名称|name|pointName)$/i.test(c.trim()));
            if (idI >= 0 && nameI >= 0) { inTable = true; idIdx = idI; nameIdx = nameI; }
            continue;
        }
        if (cells.every(c => /^:?-+:?$/.test(c.trim()))) continue;
        const pid = (cells[idIdx] || '').trim();
        const pname = (cells[nameIdx] || '').trim();
        // 仅当「测试点名称」为空才跳过；
        // pointId（序号/编号）为空时，用测试点名称兜底，保证「未填编号的测试要点」
        // 也能进入 pointList，并凭借 pointPath 参与 path 匹配（type=3），
        // 从而支持「查看关联案例」。
        if (!pname) continue;
        const pointId = pid || pname;
        // pointPath = 功能条目前缀 用 '/' 拼接 测试点名称，整体归一化：
        //   - 兼容「功能条目尾部缺 /」→ 自动补 /；「尾部多 /」→ 折叠
        //   - 兼容「功能条目用 \」→ 统一转 /
        //   - 与案例侧 path（如 深层功能/嵌套场景/登录鉴权）保持同构，type=1 精确命中
        const pointPath = normalizePointPath(`${funcPrefix}/${pname}`);
        result.push({ pointId, pointName: pname, pointPath });
    }
    return result;
}

// ============================================================================
// 【抽屉】未绑定场景兜底扫描（当前未启用）
// ----------------------------------------------------------------------------
// ✅ 意图：当 md 未绑定测试案例时，能自动以目录约定发现案例文件，避免硬报错。
// 🔒 当前策略：md 未绑定测试案例时直接短路提示用户去做绑定（业务团队认为显式绑定更可控）。
// 🎛️ 启用方式：在 getLinkedCasesByMdFile 里「未拿到绑定」分支中，用 locateCaseDir + collectCaseFiles
//    置换直接返回错误 envelope 即可。下方两个函数已设计成纯函数，无副作用、无需预初始化，
//    兜底时不会与主链路衍生意外副作用。
// ⚠️ 若不再需要兜底能力，可安全删除以下两个函数；删除前请确认无调用方。
// ============================================================================
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function locateCaseDir(mdPath: string): string | null {
    // 优先规则：如果 md 所在目录名叫「测试大纲」，则同级找「测试案例」
    let dir = path.dirname(mdPath);
    for (let i = 0; i < 6; i++) {
        const parent = path.dirname(dir);
        // 情况1：dir 本身就是「测试大纲/xxx/...」向上走到「测试大纲」层
        if (path.basename(dir) === '测试大纲') {
            const candidate = path.join(parent, '测试案例');
            if (fs.existsSync(candidate)) return candidate;
        }
        // 情况2：当前层的兄弟目录里存在「测试案例」
        try {
            const siblingCase = path.join(parent, '测试案例');
            if (fs.existsSync(siblingCase) && fs.statSync(siblingCase).isDirectory()) {
                return siblingCase;
            }
        } catch (_) { /* ignore */ }
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** 递归收集 yaml/yml/json/csv 文件（兜底扫描配套） */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function collectCaseFiles(dir: string, out: string[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            await collectCaseFiles(full, out);
        } else if (e.isFile() && /\.(ya?ml|json|csv)$/i.test(e.name)) {
            out.push(full);
        }
    }
}

// ============================================================================
// 辅助
// ============================================================================
/**
 * 拆 markdown 表格行：
 *   - 去掉首尾的 `|`
 *   - 按 `|` 切列，但保留转义竖线 `\|`（还原为 `|` 且不做分列）
 */
function splitMdRow(line: string): string[] {
    const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
    // 用占位符暂存 `\|`，切完再还原
    const PLACEHOLDER = '\u0000';
    const escaped = trimmed.replace(/\\\|/g, PLACEHOLDER);
    return escaped.split('|').map(c => c.replace(new RegExp(PLACEHOLDER, 'g'), '|'));
}
