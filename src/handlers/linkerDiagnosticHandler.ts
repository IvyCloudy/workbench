/**
 * ============================================================================
 *  linkerDiagnosticHandler.ts
 *  测试要点 ⇄ 测试案例 关联匹配 · 应用层入口
 * ----------------------------------------------------------------------------
 *  职责（严格 1:1 语义：一个测试要点 md 最多绑定一个测试案例文件）：
 *    ① 右键入口 handleViewLinkedCases：
 *       md → 读绑定 → 匹配 → 按约定 envelope 打印到开发者 Console
 *    ② 命令面板入口 handleLinkerDiagnostic：
 *       手动选 1 个 md + 1 个 case 文件 → 匹配 → 详情打印到 Output Channel
 *       （面向开发/联调场景，绕过绑定配置做算法验证）
 *    ③ 三个公共方法：
 *       - getLinkedCasesByMdFile   业务级一站入口（1 md 进 → envelope 出）
 *       - linkAndAggregateCases    匹配聚合纯函数（1 md + 1 case → envelope）
 *       - parseMdToPointListSilent md 静默解析
 *
 *  ⚠️ 缓存策略：底层引擎 LRU 用 filePath + mtimeMs + size 作为 key，
 *     文件保存后立即失效；如需查看编辑器内未保存的改动，请先保存 md/case。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    linkPointsToCases,
    clearLinkerCache,
    type PointItem,
    type LinkOptions,
} from '../utils/pointCaseLinker';
import { getCaseOfPoint } from '../utils/pointCaseBindingStore';
import { showToast } from '../utils/message';
import { TelemetryService } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';

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
const CN_HEADER_ALIAS: Record<keyof Pick<LinkOptions, 'pathField' | 'caseNameField' | 'caseIdField' | 'parentIdField'>, string[]> = {
    // 名称 / 用例名 / 案例名
    caseNameField: ['名称', '用例名称', '案例名称', '测试案例名称'],
    // 路径 / 用例路径
    pathField: ['路径', '用例路径', '案例路径'],
    // 用例编号 / 案例编号（testcase_id 保持英文名兼容原模板）
    caseIdField: ['用例编号', '案例编号', 'testcase_id'],
    // 中文模板通常无 parent_id，仅列出可能的中文别名兜底
    parentIdField: ['父点编号', '所属要点', 'parent_id'],
};

/**
 * 探测案例文件是否为「中文表头 CSV」，返回可注入 LinkOptions 的字段名映射。
 * - 仅处理 .csv；yaml/json 由用户按约定使用英文字段（现状已支持）
 * - 只读首行（<= 8KB），性能开销可忽略
 * - 探测失败或非中文表头 → 返回 undefined，保持默认字段名
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
            for (const key of Object.keys(CN_HEADER_ALIAS) as (keyof typeof CN_HEADER_ALIAS)[]) {
                const aliases = CN_HEADER_ALIAS[key];
                const hit = aliases.find(a => set.has(a));
                if (hit) (out as any)[key] = hit;
            }
            return Object.keys(out).length > 0 ? out : undefined;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return undefined;
    }
}

/** 复用同一个 Output Channel，避免多次创建 */
let outputChannel: vscode.OutputChannel | undefined;
function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('TestCase Linker 诊断');
    }
    return outputChannel;
}

// ============================================================================
// 【推荐入口】右键 md 一键查看关联案例（1:1 语义）
// ============================================================================
/**
 * 从测试要点 .md 右键触发：
 *   1. 校验路径合法（必须是 .md）
 *   2. 解析当前 md → pointList（静默）
 *   3. 读绑定配置 → 唯一的案例文件绝对路径（1:1）
 *   4. 校验该案例文件仍在磁盘上
 *   5. 调用引擎完成匹配
 *   6. 把「按约定格式聚合的结果」用 console.log 打到 Extension Host 的
 *      开发者控制台（VSCode 菜单：帮助 → 切换开发人员工具 → Console）
 *
 * ⚠️ 全程静默：不弹 toast、不弹对话框、不弹 Output 面板。
 *    错误信息统一收敛到 envelope.errorMsg 里，仅打点 telemetry。
 *
 * 打印的核心对象格式（严格遵循最初约定）：
 *   {
 *     "${pointId}_${pointName}": [
 *       {
 *         "testcase_id": "作为 node_id",
 *         "caseName": "xxx",
 *         "caseDetail": "【前置条件】...【预期结果】...",
 *         "type": 1
 *       }
 *     ]
 *   }
 */
export async function handleViewLinkedCases(uri: vscode.Uri): Promise<void> {
    // eslint-disable-next-line no-console
    const log = console.log.bind(console);
    log('%c[TC-Linker] ===== 查看关联案例 =====', 'color:#22c55e;font-weight:bold');

    const mdPath = uri?.fsPath;
    if (!mdPath) {
        const envelope: LinkedCasesEnvelope = { total: 0, errorMsg: '未拿到测试要点文件路径', data: {} };
        log('%c[TC-Linker] ❌ 未拿到 md 文件路径', 'color:#ef4444');
        log('%c[TC-Linker] ===== 最终出参 =====', 'color:#3b82f6;font-weight:bold');
        log(envelope);
        log('[TC-Linker] JSON:', JSON.stringify(envelope, null, 2));
        return;
    }
    log('[TC-Linker] 📖 测试要点：', mdPath);

    // ==== 调用高层公共方法：一个 md 进 → 约定 envelope 出 ====
    const t0 = Date.now();
    const envelope = await getLinkedCasesByMdFile(mdPath);
    const elapsed = Date.now() - t0;

    // ---- 结果输出 ----
    if (envelope.errorMsg) {
        log('%c[TC-Linker] ⚠️  ', 'color:#f59e0b', envelope.errorMsg);
        TelemetryService.sendTelemetryErrorEvent('viewLinkedCases.error', { errorMsg: envelope.errorMsg });
    }
    log('%c[TC-Linker] ===== 最终出参（约定格式） =====', 'color:#3b82f6;font-weight:bold');
    log(envelope);                          // 折叠展开友好
    log('[TC-Linker] JSON:', JSON.stringify(envelope, null, 2));  // 纯文本便于复制

    // ---- 简要统计（打点/参考）----
    log(
        '%c[TC-Linker] ===== 统计 =====',
        'color:#3b82f6;font-weight:bold',
        {
            totalMatched: envelope.total,
            totalRecords: envelope.stats?.totalRecords,
            typeCount: envelope.stats?.typeCount,
            totalOrphan: envelope.stats?.totalOrphan,
            totalStripped: envelope.stats?.totalStripped,
            pointKeys: Object.keys(envelope.data).length,
            elapsedMs: elapsed,
        }
    );

    TelemetryService.sendTelemetryEvent('viewLinkedCases.done', {
        mdFile: path.basename(mdPath),
        totalRecords: String(envelope.stats?.totalRecords ?? 0),
        matched: String(envelope.total),
        pointCount: String(Object.keys(envelope.data).length),
        elapsedMs: String(elapsed),
        hasError: envelope.errorMsg ? '1' : '0',
    });

    // ⚠️ 按需求已去除 toast 弹窗，结果仅通过 Extension Host 开发者工具 Console 查看
}

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
    let r;
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
    // 1.1) 扩展名分派（当前仅支持 .md；预留 .xmind 等未来扩展）
    const ext = path.extname(mdPath).toLowerCase();
    if (ext !== '.md') {
        return {
            total: 0,
            errorMsg: `暂不支持的测试要点文件类型：${ext || '(无后缀)'}，当前仅支持 .md`,
            data: {},
        };
    }

    // 2) 解析 md → pointList
    const pointList = await parseMdToPointListSilent(mdPath);
    if (pointList.length === 0) {
        return {
            total: 0,
            errorMsg: '未从 md 解析出测试点，请检查表头格式（需为 `| 序号 | 测试点 | ... |`）',
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

    // 5) 调用底层单文件匹配 + 聚合
    return linkAndAggregateCases(pointList, casePath);
}

// ============================================================================
// 约定的出参类型
// ============================================================================
/** 每条命中案例（作为 data[pointKey] 中的元素） */
export interface LinkedCaseItem {
    testcase_id: string;
    caseName: string;
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
}

/**
 * 【公共方法】从测试要点 md 中解析出 pointList（静默：不写 Output Channel）
 *
 * 规则：
 *   1. 找到形如「功能条目：xxx / yyy」的行，作为 pointPath（会归一化空格）；
 *      若找不到，则退化为文件名（去后缀）作为 pointPath。
 *   2. 找表格首行为「| 序号 | 测试点 | ... |」的表，取每行的前两列作为 pointId / pointName。
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

    // pointPath
    let pointPath = '';
    for (const line of lines) {
        const m = line.match(/功能条目\s*[:：]\s*(.+?)\s*$/);
        if (m) {
            pointPath = m[1].replace(/\s*[/／]\s*/g, '/').trim();
            break;
        }
    }
    if (!pointPath) pointPath = path.basename(mdPath, path.extname(mdPath));

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
        if (!pid || !pname) continue;
        result.push({ pointId: pid, pointName: pname, pointPath });
    }
    return result;
}

// ============================================================================
// ★★★ 保留：未绑定场景兜底扫描（当前未启用，后续如需恢复扫描模式可复用） ★★★
// ----------------------------------------------------------------------------
// 当前策略：md 未绑定测试案例时直接短路提示用户去做绑定；
// 兜底扫描作为「按目录约定自动发现案例文件」的能力保留在此，随时可以启用。
// 启用方式：在 getLinkedCasesByMdFile 里 boundAbsList.length === 0 分支中，
// 用 locateCaseDir + collectCaseFiles 代替直接返回错误 envelope 即可。
// ============================================================================

/** 从 md 所在路径向上找到「测试案例」目录 */
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
// 命令入口
// ============================================================================
export async function handleLinkerDiagnostic(): Promise<void> {
    const ch = getChannel();
    ch.clear();
    ch.show(true);
    ch.appendLine(`[${nowIso()}] === 关联匹配诊断开始 ===`);

    // 1) 选 md 文件（1:1 语义：仅单选）
    const mdPicks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: '选择测试要点 .md',
        filters: { Markdown: ['md'] },
    });
    if (!mdPicks || mdPicks.length === 0) {
        ch.appendLine('用户取消：未选择测试要点文件。');
        return;
    }

    // 2) 选 case 文件（1:1 语义：仅单选）
    const casePicks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: '选择测试案例（yaml/json/csv）',
        filters: { '测试案例': ['yaml', 'yml', 'json', 'csv'] },
    });
    if (!casePicks || casePicks.length === 0) {
        ch.appendLine('用户取消：未选择测试案例文件。');
        return;
    }

    // 3) 是否清缓存（诊断场景默认清一次，观察真实解析耗时）
    const clearCacheChoice = await vscode.window.showQuickPick(
        [
            { label: '是（推荐，观察真实解析）', value: true },
            { label: '否（复用缓存）', value: false },
        ],
        { placeHolder: '是否清空 linker 缓存后再匹配？' }
    );
    const shouldClear = clearCacheChoice?.value ?? true;
    if (shouldClear) {
        clearLinkerCache();
        ch.appendLine('已清空 linker 缓存。');
    }

    // 4) 解析 md → pointList
    const mdPath = mdPicks[0].fsPath;
    const pointList = await parseMdToPointListSilent(mdPath);
    ch.appendLine(`解析 md：${short(mdPath)} → ${pointList.length} 个点`);
    ch.appendLine('');
    ch.appendLine(`📋 pointList 共 ${pointList.length} 个点：`);
    for (const p of pointList) {
        ch.appendLine(`   · ${p.pointId} | ${p.pointName} | ${p.pointPath}`);
    }
    ch.appendLine('');

    if (pointList.length === 0) {
        ch.appendLine('⚠️  未从 md 中解析出任何测试点，终止匹配。');
        return;
    }

    // 5) 调用【公共方法】完成匹配 + 聚合（与右键入口共用同一份逻辑）
    const casePath = casePicks[0].fsPath;
    const t0 = Date.now();
    const envelope = await linkAndAggregateCases(pointList, casePath);
    const elapsed = Date.now() - t0;

    if (envelope.errorMsg) {
        ch.appendLine(`❌ 匹配失败：${envelope.errorMsg}`);
        TelemetryService.sendTelemetryErrorEvent('linkerDiagnostic.linkerError', telemetryErrProps(new Error(envelope.errorMsg)));
        showToast(undefined, 'error', `linker 执行失败: ${envelope.errorMsg}`);
        return;
    }
    ch.appendLine(`⏱  linker 完成：耗时 ${elapsed}ms（案例文件：${short(casePath)}）。`);
    ch.appendLine('');

    // 6) 打印每个 point 的详情（诊断视角，超大结果做行数保护避免 Output 面板卡顿）
    const keys = Object.keys(envelope.data).sort();
    if (keys.length === 0) {
        ch.appendLine('   （无任何 point 命中案例）');
    }
    const MAX_CASES_PER_POINT = 100;
    for (const key of keys) {
        const cases = envelope.data[key];
        ch.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        ch.appendLine(`🔗 ${key}  → ${cases.length} 条`);
        const shown = cases.slice(0, MAX_CASES_PER_POINT);
        for (const c of shown) {
            const badge = typeBadge(c.type);
            const detail = c.caseDetail ? ` ｜ ${trunc(c.caseDetail, 60)}` : '';
            ch.appendLine(`   ${badge} ${c.testcase_id} · ${c.caseName}${detail}`);
        }
        if (cases.length > MAX_CASES_PER_POINT) {
            ch.appendLine(`   … 还有 ${cases.length - MAX_CASES_PER_POINT} 条（已折叠，完整结果见 telemetry / 复用公共方法）`);
        }
    }
    ch.appendLine('');

    // 7) 总览
    const st = envelope.stats;
    ch.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    ch.appendLine(`📊 总览`);
    ch.appendLine(`   案例文件: ${short(casePath)}`);
    ch.appendLine(`   总记录: ${st?.totalRecords ?? 0}`);
    ch.appendLine(`   命中: ${envelope.total}  (type1=${st?.typeCount.type1 ?? 0}, type2=${st?.typeCount.type2 ?? 0}, type3=${st?.typeCount.type3 ?? 0})`);
    ch.appendLine(`   孤儿: ${st?.totalOrphan ?? 0}`);
    ch.appendLine(`   剥离子序号次数: ${st?.totalStripped ?? 0}`);
    // 脏数据信号（仅在有值时输出，避免噪声）
    if (st?.duplicatePointIds && st.duplicatePointIds.length > 0) {
        ch.appendLine(`   ⚠️  重复 pointId (${st.duplicatePointIds.length}): ${st.duplicatePointIds.slice(0, 20).join(', ')}${st.duplicatePointIds.length > 20 ? ' …' : ''}`);
    }
    if (st?.multiHitCases && st.multiHitCases.length > 0) {
        ch.appendLine(`   ⚠️  跨点多命中 case (${st.multiHitCases.length}): ${st.multiHitCases.slice(0, 20).join(', ')}${st.multiHitCases.length > 20 ? ' …' : ''}`);
    }
    ch.appendLine(`   总耗时: ${elapsed}ms`);
    ch.appendLine('');
    ch.appendLine(`[${nowIso()}] === 关联匹配诊断结束 ===`);

    TelemetryService.sendTelemetryEvent('linkerDiagnostic.done', {
        mdFile: path.basename(mdPath),
        caseFile: path.basename(casePath),
        pointCount: String(pointList.length),
        totalRecords: String(st?.totalRecords ?? 0),
        matched: String(envelope.total),
        elapsedMs: String(elapsed),
    });

    showToast(
        undefined,
        'info',
        `关联匹配完成：${envelope.total}/${st?.totalRecords ?? 0} 记录命中，耗时 ${elapsed}ms（详见 Output）`
    );
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

function typeBadge(t: 1 | 2 | 3): string {
    if (t === 1) return '🟢[type=1 精确]';
    if (t === 2) return '🟡[type=2 仅ID]';
    return '🔵[type=3 仅path]';
}

function trunc(s: string, n: number): string {
    if (!s) return '';
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n) + '…' : one;
}

function short(fp: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws && fp.startsWith(ws)) return '.' + fp.slice(ws.length);
    return fp;
}

function nowIso(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
