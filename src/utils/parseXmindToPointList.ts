/**
 * ============================================================================
 *  utils/parseXmindToPointList.ts
 *  XMind 测试要点解析器（独立模块，不侵入现有 md 解析链路）
 * ----------------------------------------------------------------------------
 *  职责：
 *    输入：一个 .xmind 文件绝对路径
 *    输出：PointItem[]（与 md 侧同构：{ pointId, pointName, pointPath }）
 *           + 中间节点缺图标的报错清单 invalidNodes（若非空则同时给出 errorMsg）
 *           + 多标签等脏数据告警 warnings（不阻断解析）
 *
 *  语义规则（与需求方最终确认版一致，详见 docs/architecture/xmind-parser-spec.md）：
 *
 *    ┌─ 节点角色判定（按图标）：
 *    │   · 测试点节点：marker id 前缀命中 `star`（五角星图标）
 *    │       - 注意：`priority-*`（数字圆圈优先级图标）不视为测试点，仅 `star-*` 才算
 *    │   · 功能条目节点：marker id 前缀命中 `flag`
 *    │   · 根节点（中心主题）：豁免图标校验，且【不】进 pointPath
 *    │   · 说明性节点：处于「五角星节点」祖先链下的一切子节点，全部忽略、不校验
 *    │   · 中间无图标节点：非根、非说明、无 flag/star 图标 → 结构错误
 *    │       - 严格模式（E3）：收集所有问题节点，一次性列出后中止解析
 *    │
 *    ├─ 测试点字段抽取：
 *    │   · pointName = 五角星节点文本
 *    │   · pointId = 五角星节点的**首个 label**；无 label → 空字符串
 *    │       （多 label 时取首个并输出脏数据告警）
 *    │
 *    ├─ pointPath 组装（P1 语义）：
 *    │   · 由祖先链上「所有 flag 节点」+「所有 star 节点」组成，
 *    │     根节点不进 path；测试点自身节点名作为 path 末段（与 md 同构）
 *    │   · 例：根 → 🚩A → 🚩B → ⭐ P[001] → ⭐ Q
 *    │       - P 的 pointPath = A/B/P
 *    │       - Q 的 pointPath = A/B/P/Q （P 作为 Q 的祖先五角星也进 path）
 *    │
 *    ├─ 嵌套测试点：不阻止下钻，每个五角星节点都作为独立测试点纳入
 *    │
 *    └─ 多 sheet / 游离主题：处理所有 sheet；跳过游离主题（不含在 rootTopic 的枝干）
 *
 *  格式兼容：
 *    · xmind ZEN / 2020+ / 2024+：zip 内含 `content.json`（数组形式，每个元素一张 sheet）
 *    · xmind 8 及以前：zip 内含 `content.xml`（XML 格式）
 *    · 二者共存时优先 JSON
 *
 *  依赖：jszip（解 zip；不使用 xml2js，XML 用极简正则解析器覆盖 xmind 8 常见结构）
 * ============================================================================
 */
import * as fs from 'fs';
import JSZip from 'jszip';
import { normalizePointPath, type PointItem } from './pointCaseLinker';

// ============================================================================
// 对外类型
// ============================================================================

/** 一条"无图标中间节点"的错误记录（用于 Output Channel 列全） */
export interface XmindInvalidNode {
    /** 从根到该节点的完整链路（用 `→` 分隔，含根节点，便于用户定位） */
    ancestryPath: string;
    /** 节点自身文本 */
    title: string;
    /** 所在 sheet 标题（多 sheet 情况方便定位） */
    sheetTitle: string;
}

/** 一条脏数据告警（不阻断解析，仅提示） */
export interface XmindWarning {
    /** 从根到该节点的完整链路 */
    ancestryPath: string;
    /** 告警文本 */
    message: string;
}

/** 解析结果包裹 */
export interface XmindParseResult {
    /** 解析成功的测试点列表；解析失败时为空数组 */
    pointList: PointItem[];
    /** 错误信息；无错时为空字符串（结构错误、格式错误、IO 错误均走此字段） */
    errorMsg: string;
    /** 无图标中间节点清单（E3 报错模式）；仅在结构错误时非空 */
    invalidNodes: XmindInvalidNode[];
    /** 脏数据告警（多 label、空文本等），不阻断解析 */
    warnings: XmindWarning[];
}

// ============================================================================
// 输出保护上限（O9）
// ----------------------------------------------------------------------------
// 用户漏标整棵大树的图标时，invalidNodes 可能瞬间上千条，Output Channel 会
// 被淹没。为避免体验灾难，DFS 阶段发现清单已达上限即停止继续追加，Output 侧
// 由 handler 层负责显示「已折叠 N 条」提示。warnings 同理，防止脏数据密集时
// 噪声爆炸。
// ============================================================================
const INVALID_NODES_HARD_LIMIT = 200;
const WARNINGS_HARD_LIMIT = 200;

// ============================================================================
// 内部标准化树
// ============================================================================

/** 归一化后的 xmind 节点（两种格式都收敛到该结构） */
interface XmindNode {
    /** 节点文本（title / topic 文本） */
    title: string;
    /** 节点上挂载的所有 markerId（如 `star-red`, `flag-red`, `task-start` 等） */
    markers: string[];
    /** 节点上挂载的所有 label 文本 */
    labels: string[];
    /** 子节点（attached 主枝干；游离主题不进入） */
    children: XmindNode[];
}

// ============================================================================
// 角色判定
// ============================================================================
const FLAG_PREFIX = /^flag(-|$)/i;
// 收紧规则：仅 star-* 系图标视为测试点；priority-*（数字圆圈优先级）不算测试点
const STAR_PREFIX = /^star(-|$)/i;

function isFlagNode(n: XmindNode): boolean {
    return n.markers.some(m => FLAG_PREFIX.test(m));
}
function isStarNode(n: XmindNode): boolean {
    return n.markers.some(m => STAR_PREFIX.test(m));
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 静默解析一个 xmind 文件为 PointItem[]。
 * - 与 parseMdToPointListSilent 语义对齐，但因 xmind 有结构错误的可能，
 *   故返回 XmindParseResult 包裹，供上层构造 envelope.errorMsg + Output 清单
 */
export async function parseXmindToPointListSilent(
    xmindPath: string,
): Promise<XmindParseResult> {
    // 1) 读取 zip
    let buf: Buffer;
    try {
        buf = await fs.promises.readFile(xmindPath);
    } catch (err: any) {
        return { pointList: [], errorMsg: `读取 xmind 文件失败：${err?.message || err}`, invalidNodes: [], warnings: [] };
    }

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch (err: any) {
        return { pointList: [], errorMsg: `xmind 文件不是合法的 zip 归档：${err?.message || err}`, invalidNodes: [], warnings: [] };
    }

    // 2) 定位内容：优先 content.json（ZEN），回退 content.xml（xmind 8）
    const jsonEntry = zip.file('content.json');
    const xmlEntry = zip.file('content.xml');

    let sheets: { title: string; root: XmindNode }[] = [];
    try {
        if (jsonEntry) {
            const jsonText = await jsonEntry.async('string');
            sheets = parseZenJson(jsonText);
        } else if (xmlEntry) {
            const xmlText = await xmlEntry.async('string');
            sheets = parseLegacyXml(xmlText);
        } else {
            return {
                pointList: [],
                errorMsg: 'xmind 文件内未找到 content.json 或 content.xml，可能是不受支持的 xmind 变体',
                invalidNodes: [],
                warnings: [],
            };
        }
    } catch (err: any) {
        return {
            pointList: [],
            errorMsg: `解析 xmind 内容失败：${err?.message || err}`,
            invalidNodes: [],
            warnings: [],
        };
    }

    if (sheets.length === 0) {
        return { pointList: [], errorMsg: 'xmind 文件无有效画布（sheet）', invalidNodes: [], warnings: [] };
    }

    // 3) DFS 抽取
    const points: PointItem[] = [];
    const invalidNodes: XmindInvalidNode[] = [];
    const warnings: XmindWarning[] = [];

    for (const sheet of sheets) {
        traverse(sheet.root, sheet.title, [sheet.root], /* pathSegments */ [], /* insideStarSubtree */ false, points, invalidNodes, warnings);
    }

    // 4) 结构错误优先：一次性列全所有问题节点后中止
    if (invalidNodes.length > 0) {
        return {
            pointList: [],
            errorMsg: `xmind 结构错误：检测到 ${invalidNodes.length} 个中间节点未标记「功能条目」（小旗子）图标，请在 xmind 中补全图标后重试`,
            invalidNodes,
            warnings,
        };
    }

    return { pointList: points, errorMsg: '', invalidNodes: [], warnings };
}

// ============================================================================
// DFS 遍历
// ============================================================================
/**
 * @param node                 当前节点
 * @param sheetTitle           当前 sheet 标题（错误清单用）
 * @param ancestryNodes        从根到当前节点的完整链（含根、含 self），用于错误报告的 ancestryPath
 * @param pathSegments         已收集的 pointPath 前缀段（不含根、按规则只放 flag/star 节点）
 * @param insideStarSubtree    当前节点是否处于某个五角星节点的子树内
 *                             - 若为 true：本节点自身若不是五角星，则视为"说明节点"忽略（不校验、不进 path）
 * @param out                  收集到的测试点
 * @param invalidNodes         收集到的结构错误节点
 * @param warnings             收集到的告警
 */
function traverse(
    node: XmindNode,
    sheetTitle: string,
    ancestryNodes: XmindNode[],
    pathSegments: string[],
    insideStarSubtree: boolean,
    out: PointItem[],
    invalidNodes: XmindInvalidNode[],
    warnings: XmindWarning[],
): void {
    const isRoot = ancestryNodes.length === 1; // ancestryNodes[0] == root == self
    const star = isStarNode(node);
    const flag = isFlagNode(node);

    // ---- 结构校验（先做校验，再决定是否下钻）----
    if (!isRoot && !insideStarSubtree && !star && !flag) {
        // 中间无图标节点：结构错误
        //   - "中间"定义：非根、且不在说明子树内（insideStarSubtree=false）
        //   - "无图标"定义：不带 flag/star 系图标（F2）
        //   - 说明：叶子节点也会在这里被判定为错误——但仅当它不在星形子树下时。
        //     实际上如果一个节点没有任何 flag/star 图标又不在星形子树下，
        //     那它无论是否叶子都不该出现在测试点结构中，此判定符合用户约定。
        //   - O9 截断：清单到达硬上限后不再追加，避免 Output 面板被淹没
        if (invalidNodes.length < INVALID_NODES_HARD_LIMIT) {
            invalidNodes.push({
                ancestryPath: buildAncestryPath(ancestryNodes),
                title: node.title,
                sheetTitle,
            });
        }
        // 继续下钻，收集完整错误清单（但只统计条数超限的部分，不再入清单）
    }

    // ---- 多 label 告警（仅在星形节点上，因为只有星形节点消费 label 作为 pointId）----
    if (star && node.labels.length > 1) {
        if (warnings.length < WARNINGS_HARD_LIMIT) {
            warnings.push({
                ancestryPath: buildAncestryPath(ancestryNodes),
                message: `测试点节点检测到 ${node.labels.length} 个标签，仅采用首个「${node.labels[0]}」作为 pointId`,
            });
        }
    }

    // ---- 空 title 星形节点告警（O11）：pointName 为空会严重影响用户可读性 ----
    //   - 不阻断解析：pointList 中依然记录该点，但用户能在 Output 侧看到告警提示
    //   - 仅在星形节点校验，flag 节点空 title 不影响测试点消费
    if (star && !node.title) {
        if (warnings.length < WARNINGS_HARD_LIMIT) {
            warnings.push({
                ancestryPath: buildAncestryPath(ancestryNodes),
                message: '测试点节点标题为空，pointName 将为空字符串，建议在 xmind 中补全节点文本',
            });
        }
    }

    // ---- 构造当前节点在 pointPath 里的段（如果它应该进 path）----
    // 规则：非根 + (flag 或 star) → 进 path；根不进 path；说明节点不进 path
    let currentPathSegments = pathSegments;
    if (!isRoot && (flag || star)) {
        currentPathSegments = [...pathSegments, node.title];
    }

    // ---- 若当前节点是星形节点：登记为一个测试点 ----
    if (star) {
        const pointId = node.labels[0] || '';
        const pointName = node.title;
        // pointPath = 归一化后的段串（currentPathSegments 已经含 self.title）
        const pointPath = normalizePointPath(currentPathSegments.join('/'));
        out.push({ pointId, pointName, pointPath });
    }

    // ---- 下钻 ----
    // insideStarSubtree 传递语义：
    //   - 若当前节点自身就是星形节点：子树视为"该测试点内部"，除非子树里还有星形节点（那会自成一个测试点）
    //   - 一旦进入 insideStarSubtree，除非遇到新的星形节点，否则中间节点不再校验、不再进 path
    const childInsideStarSubtree = insideStarSubtree || star;
    for (const child of node.children) {
        traverse(child, sheetTitle, [...ancestryNodes, child], currentPathSegments, childInsideStarSubtree, out, invalidNodes, warnings);
    }
}

/** 把 ancestryNodes 转成人类友好的链条字符串："根 → A → B → 当前" */
function buildAncestryPath(ancestryNodes: XmindNode[]): string {
    return ancestryNodes.map(n => (n.title || '(未命名)')).join(' → ');
}

// ============================================================================
// xmind ZEN / 2020+ 的 content.json 解析
// ----------------------------------------------------------------------------
// 结构（简化）：
//   [
//     {
//       "id": "sheet-1",
//       "title": "画布1",
//       "rootTopic": {
//         "id": "root",
//         "title": "中心主题",
//         "markers": [ { "markerId": "flag-red" } ] ,
//         "labels": [ "LGN-001", ... ] ,
//         "children": {
//           "attached": [ { ...topic... }, ... ],
//           "detached": [ { ...topic... }, ... ]     // 游离主题 → 跳过
//         }
//       }
//     },
//     ...
//   ]
// ============================================================================
function parseZenJson(jsonText: string): { title: string; root: XmindNode }[] {
    const data = JSON.parse(jsonText);
    if (!Array.isArray(data)) {
        throw new Error('content.json 顶层不是数组，可能是不支持的 xmind 变体');
    }
    const out: { title: string; root: XmindNode }[] = [];
    for (const sheet of data) {
        if (!sheet || !sheet.rootTopic) continue;
        const root = zenTopicToNode(sheet.rootTopic);
        out.push({ title: String(sheet.title ?? '(未命名画布)'), root });
    }
    return out;
}

function zenTopicToNode(topic: any): XmindNode {
    const title = typeof topic?.title === 'string' ? topic.title.trim() : '';
    const markers = Array.isArray(topic?.markers)
        ? topic.markers
              .map((m: any) => (m && typeof m.markerId === 'string' ? m.markerId : ''))
              .filter((s: string) => !!s)
        : [];
    // labels 允许两种写法：字符串数组 或 [{ content: 'xxx' }] 对象数组（个别版本）
    const labels: string[] = [];
    if (Array.isArray(topic?.labels)) {
        for (const l of topic.labels) {
            if (typeof l === 'string') {
                const s = l.trim();
                if (s) labels.push(s);
            } else if (l && typeof l.content === 'string') {
                const s = l.content.trim();
                if (s) labels.push(s);
            }
        }
    }
    // 只取 attached，跳过 detached（游离主题）
    const attached = topic?.children?.attached;
    const children: XmindNode[] = Array.isArray(attached) ? attached.map(zenTopicToNode) : [];
    return { title, markers, labels, children };
}

// ============================================================================
// xmind 8 的 content.xml 解析（极简正则驱动，不引入 xml2js）
// ----------------------------------------------------------------------------
// 覆盖的最小结构：
//   <xmap-content>
//     <sheet ...>
//       <title>画布1</title>
//       <topic id="..." >
//         <title>中心主题</title>
//         <marker-refs>
//           <marker-ref marker-id="star-red"/>
//         </marker-refs>
//         <labels>
//           <label>LGN-001</label>
//         </labels>
//         <children>
//           <topics type="attached">
//             <topic>...</topic>
//           </topics>
//         </children>
//       </topic>
//     </sheet>
//   </xmap-content>
//
// 注：xmind 8 的 xml 层级较深，我们只需要 "topic 元素树" 及其 title/marker/label。
// 用一个手写的极简 SAX 风格解析：识别标签开始/结束 + 文本节点，够用即可。
// ============================================================================
function parseLegacyXml(xmlText: string): { title: string; root: XmindNode }[] {
    // 简化：只关心 <topic>、<title>、<marker-ref>、<label>、<topics type="attached">、<sheet>
    // 用一个 token 流扫描来构建 XmindNode 树。
    interface Token {
        kind: 'open' | 'close' | 'self' | 'text';
        name?: string;
        attrs?: Record<string, string>;
        text?: string;
    }
    const tokens: Token[] = [];

    // 极简 tokenizer：不做 CDATA 校验、不解析 xmlns 命名空间前缀（保留）
    const re = /<([/!?]?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xmlText)) !== null) {
        if (m[5] !== undefined) {
            const text = decodeXmlEntities(m[5]);
            if (text && text.trim()) tokens.push({ kind: 'text', text });
            continue;
        }
        const prefix = m[1];
        const name = m[2];
        const attrStr = m[3] || '';
        const selfClose = m[4] === '/';
        if (prefix === '!') continue; // 注释、doctype
        if (prefix === '?') continue; // 处理指令
        if (prefix === '/') {
            tokens.push({ kind: 'close', name });
            continue;
        }
        const attrs = parseXmlAttrs(attrStr);
        tokens.push({ kind: selfClose ? 'self' : 'open', name, attrs });
    }

    // 树构建：栈式
    interface Ctx {
        name: string;
        attrs: Record<string, string>;
        node: XmindNode | null;         // 只在 <topic> 时创建
        parentTopic: XmindNode | null;  // 记录该栈项**外层最近**的 topic 节点，方便挂 child
        insideAttachedTopics: boolean;  // 当前 <topics> 是否是 attached
        textBuf: string[];              // 收集直接文本子内容（如 <title>...</title>）
    }
    const sheets: { title: string; root: XmindNode }[] = [];
    let currentSheetTitle = '';
    let currentSheetRoot: XmindNode | null = null;

    const stack: Ctx[] = [];
    function currentTopic(): XmindNode | null {
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].node) return stack[i].node;
        }
        return null;
    }
    function nearestParentTopic(): XmindNode | null {
        // 从栈顶向下找**第二个** topic（第一个是自身）；此函数在 open topic 时调用
        let found = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].node) {
                found++;
                if (found === 1) return stack[i].node;
            }
        }
        return null;
    }

    for (const t of tokens) {
        if (t.kind === 'open' || t.kind === 'self') {
            const name = stripNs(t.name!);
            const attrs = t.attrs || {};

            let node: XmindNode | null = null;
            let insideAttachedTopics = stack.length > 0 ? stack[stack.length - 1].insideAttachedTopics : false;

            if (name === 'topics') {
                // 只有 type="attached" 才继续下钻；否则打上 detached 标记，其子树全部忽略
                const type = attrs['type'] ?? 'attached';
                insideAttachedTopics = (type === 'attached');
            } else if (name === 'topic') {
                // 是否应当纳入：
                //   - sheet 内的第一个 topic（作为 rootTopic），无论其外层 topics 类型
                //   - 处于 attached topics 内的 topic
                const parentTopic = nearestParentTopic();
                const shouldInclude = parentTopic === null ? true : insideAttachedTopics;
                if (shouldInclude) {
                    node = { title: '', markers: [], labels: [], children: [] };
                    if (parentTopic) {
                        parentTopic.children.push(node);
                    } else {
                        // 作为 sheet 的 root
                        currentSheetRoot = node;
                    }
                }
            } else if (name === 'marker-ref') {
                const mid = attrs['marker-id'] || attrs['markerId'];
                const target = currentTopic();
                if (target && mid) target.markers.push(mid);
            }

            stack.push({
                name,
                attrs,
                node,
                parentTopic: nearestParentTopic(),
                insideAttachedTopics,
                textBuf: [],
            });

            if (t.kind === 'self') {
                stack.pop();
            }
        } else if (t.kind === 'close') {
            const name = stripNs(t.name!);
            // 找到匹配的开标签（同名最近栈项）
            let idx = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name === name) { idx = i; break; }
            }
            if (idx < 0) continue;
            const ctx = stack[idx];
            const textJoined = ctx.textBuf.join('').trim();

            if (name === 'title') {
                // 挂到最近的 topic 或 sheet
                // 优先：如果紧邻外层是 sheet，则挂到 sheetTitle；否则挂到 currentTopic
                const outerName = idx > 0 ? stack[idx - 1].name : '';
                if (outerName === 'sheet') {
                    currentSheetTitle = textJoined;
                } else {
                    const t2 = currentTopic();
                    if (t2 && !t2.title) t2.title = textJoined;
                }
            } else if (name === 'label') {
                const t2 = currentTopic();
                if (t2 && textJoined) t2.labels.push(textJoined);
            } else if (name === 'sheet') {
                if (currentSheetRoot) {
                    sheets.push({ title: currentSheetTitle || '(未命名画布)', root: currentSheetRoot });
                }
                currentSheetTitle = '';
                currentSheetRoot = null;
            }

            // 弹栈
            stack.splice(idx);
        } else if (t.kind === 'text') {
            if (stack.length > 0) {
                stack[stack.length - 1].textBuf.push(t.text!);
            }
        }
    }

    return sheets;
}

function parseXmlAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"|([a-zA-Z_][\w:-]*)\s*=\s*'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        const key = m[1] ?? m[3];
        const val = m[2] ?? m[4];
        if (key) out[key] = val ?? '';
    }
    return out;
}

/** 去掉 XML 元素/属性名的命名空间前缀（如 `xhtml:p` → `p`） */
function stripNs(name: string): string {
    const idx = name.indexOf(':');
    return idx >= 0 ? name.slice(idx + 1) : name;
}

function decodeXmlEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&'); // 最后处理 &amp;
}

// ============================================================================
// 供 handler / 测试直接消费的便捷函数（可选）
// ============================================================================
/** 仅返回 pointList；结构错误时返回空数组（详细错误请用 parseXmindToPointListSilent） */
export async function parseXmindPointListOnly(xmindPath: string): Promise<PointItem[]> {
    const r = await parseXmindToPointListSilent(xmindPath);
    return r.pointList;
}
