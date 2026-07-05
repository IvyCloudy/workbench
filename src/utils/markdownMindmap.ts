/**
 * ============================================================================
 *  utils/markdownMindmap.ts
 *  md ↔ 思维导图节点树双向解析器
 * ----------------------------------------------------------------------------
 *  语义规则（标题骨架 + 列表叶子）：
 *    - `# 标题`     → 根节点
 *    - `##/###/...` → 子节点（按 # 数派生层级）
 *    - `- xxx`      → 当前最近标题节点下的叶子节点（缩进 2 空格 = 一级）
 *  设计要点：
 *    - 解析尽量"宽容"：空 md → 自动得到一个"未命名思维导图"根节点；多 H1 → 全部挂到一个虚拟根下。
 *    - 序列化稳定：相同节点树多次 toMarkdown 输出完全一致，避免无意义 diff。
 *    - 节点 id 仅运行时使用，不会写入 md（保证 md 是唯一数据源）。
 * ============================================================================
 */

export interface MindmapNode {
    /** 运行时唯一 id（不写入 md） */
    id: string;
    /** 节点显示文本 */
    title: string;
    /** 节点深度：根=0 */
    depth: number;
    /**
     * 节点形态：
     *  - heading：来自 markdown 标题（# / ## / ###）
     *  - list   ：来自 markdown 列表项 - xxx
     *  - root   ：合成根节点（多个 H1 / 空文档时）
     */
    kind: 'heading' | 'list' | 'root' | 'path' | 'test-point' | 'test-desc';
    children: MindmapNode[];
}

let _idSeq = 0;
function nextId(): string {
    _idSeq = (_idSeq + 1) & 0x7fffffff;
    return 'n_' + Date.now().toString(36) + '_' + _idSeq.toString(36);
}

/** 工厂：构造一个新节点 */
export function createNode(title: string, depth: number, kind: MindmapNode['kind'] = 'heading'): MindmapNode {
    return { id: nextId(), title, depth, kind, children: [] };
}

/**
 * 解析 markdown 文本为思维导图节点树。
 *
 * 容错策略：
 *  - 空文本 → 返回单一占位根节点
 *  - 无 # 但有 - 列表项 → 用"未命名思维导图"作为根，列表全部挂为子节点
 *  - 多个 H1 → 用一个 kind='root' 的虚拟根包裹（深度 0），各 H1 作为深度 1 的子节点
 */
export function parseMarkdown(md: string): MindmapNode {
    const text = (md || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    // 第一遍：抽取出所有"语义行"
    interface SemLine {
        kind: 'heading' | 'list';
        depth: number; // heading: 1..6；list: 缩进级别（基于 2 空格），最少为 1
        title: string;
    }
    const sem: SemLine[] = [];
    for (const raw of lines) {
        const line = raw.replace(/\t/g, '  '); // tab → 2 空格，便于缩进统计
        // 跳过空行
        if (!line.trim()) continue;

        // 标题：#... 后跟空格 + 文本
        const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) {
            sem.push({ kind: 'heading', depth: h[1].length, title: h[2].trim() });
            continue;
        }

        // 列表项：可选缩进 + (- | * | +) + 空格 + 文本
        const li = /^(\s*)([-*+])\s+(.+?)\s*$/.exec(line);
        if (li) {
            const indent = li[1].length;
            const indentLevel = Math.floor(indent / 2) + 1; // 0空格=1级
            sem.push({ kind: 'list', depth: indentLevel, title: li[3].trim() });
            continue;
        }
        // 其他行（普通段落 / 代码 / 引用）暂忽略
    }

    // 空文档兜底
    if (sem.length === 0) {
        const root = createNode('未命名思维导图', 0, 'root');
        return root;
    }

    // 决定"根节点"：
    //  - 仅当 sem 中存在 heading 时，使用其中 depth 最小的 heading 作为根
    //  - 若该最小深度的 heading 出现 ≥ 2 次，仍合成一个虚拟根包裹它们（避免丢失数据）
    const headings = sem.filter(s => s.kind === 'heading');
    let root: MindmapNode;
    let firstSemIndex = 0;

    if (headings.length === 0) {
        // 没有任何标题：合成根，所有 list 作为子
        root = createNode('未命名思维导图', 0, 'root');
    } else {
        const minDepth = Math.min(...headings.map(h => h.depth));
        const topHeadings = headings.filter(h => h.depth === minDepth);
        if (topHeadings.length === 1 && sem[0].kind === 'heading' && sem[0].depth === minDepth) {
            // 单根：直接用首个标题做根
            root = createNode(sem[0].title, 0, 'heading');
            firstSemIndex = 1;
        } else {
            // 多根：合成虚拟根
            root = createNode('未命名思维导图', 0, 'root');
        }
    }

    // 第二遍：把 sem 依次挂到树上（基于堆栈的层级管理）
    interface StackItem { node: MindmapNode; depth: number; kind: MindmapNode['kind'] }
    const stack: StackItem[] = [{ node: root, depth: 0, kind: root.kind }];

    function pushChild(parentItem: StackItem, child: MindmapNode) {
        // 不覆盖 caller 已计算好的 child.depth（targetDepth）。
        // 仅当 caller 未指定（depth=0/未设置）时，才用 parent+1 兜底。
        if (!child.depth || child.depth <= parentItem.node.depth) {
            child.depth = parentItem.node.depth + 1;
        }
        parentItem.node.children.push(child);
        stack.push({ node: child, depth: child.depth, kind: child.kind });
    }

    for (let i = firstSemIndex; i < sem.length; i++) {
        const s = sem[i];
        if (s.kind === 'heading') {
            // heading 的目标深度：（最小标题级别为 1 → 在树中为 1；其他级别相对叠加）
            // 简化策略：只看 heading 自身相对树根的层级
            //   令 baseDepth = (root.kind === 'root' ? 0 : 1)
            //   heading 在树中深度 = s.depth - minDepth + baseDepth
            const headingDepths = headings.map(h => h.depth);
            const minDepth = Math.min(...headingDepths);
            const baseDepth = (root.kind === 'root' || (firstSemIndex === 0)) ? 1 : 1; // 永远 ≥ 1
            const targetDepth = s.depth - minDepth + baseDepth;

            // 弹栈直到栈顶 depth < targetDepth
            while (stack.length > 0 && stack[stack.length - 1].depth >= targetDepth) {
                stack.pop();
            }
            if (stack.length === 0) stack.push({ node: root, depth: 0, kind: root.kind });
            const parent = stack[stack.length - 1];
            pushChild(parent, createNode(s.title, targetDepth, 'heading'));
        } else {
            // list 节点：挂到"最近的、深度最浅但 < 自身缩进"的节点下
            // 简化：list 的目标深度 = 当前栈顶（任意类型）所在 heading 链的 depth + s.depth
            // 找到栈中最深的 heading 作为锚点
            let anchorIdx = -1;
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k].kind === 'heading' || stack[k].kind === 'root') { anchorIdx = k; break; }
            }
            if (anchorIdx < 0) anchorIdx = 0;
            const anchor = stack[anchorIdx];
            const targetDepth = anchor.depth + s.depth;

            // 弹掉栈中所有 list 类型且 depth >= targetDepth 的项
            while (stack.length > anchorIdx + 1 && stack[stack.length - 1].depth >= targetDepth) {
                stack.pop();
            }
            const parent = stack[stack.length - 1];
            pushChild(parent, createNode(s.title, targetDepth, 'list'));
        }
    }

    return root;
}

/**
 * 把节点树序列化回 markdown 文本。
 *
 * 规则：
 *  - root 节点本身：若 kind='root' 且其子节点全部为 heading，则不输出 root.title 这一行；否则输出 `# root.title`。
 *  - heading 节点：按节点深度输出对应 # 数（封顶 6 级）
 *  - list   节点：按"距最近 heading 祖先的相对深度"输出 `- xxx`，缩进每级 2 空格
 *  - 兄弟节点之间用换行分隔；heading 与其后内容之间空一行（提升可读性）
 */
export function toMarkdown(root: MindmapNode): string {
    const lines: string[] = [];

    function renderHeading(node: MindmapNode, headingDepth: number) {
        const hashes = '#'.repeat(Math.min(Math.max(headingDepth, 1), 6));
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`${hashes} ${node.title}`);
    }

    function renderList(node: MindmapNode, listIndent: number) {
        const pad = '  '.repeat(Math.max(listIndent, 0));
        lines.push(`${pad}- ${node.title}`);
    }

    /**
     * @param node          当前节点
     * @param headingDepth  其作为 heading 应使用的级别（仅在 kind=heading 时使用）
     * @param listBaseDepth 作为 list 起步缩进级别（仅在 kind=list 时使用）
     */
    function walk(node: MindmapNode, headingDepth: number, listBaseDepth: number) {
        if (node.kind === 'root') {
            // root 仅当存在非 heading 子节点（即直挂 list）时，才需要输出标题占位
            const hasDirectList = node.children.some(c => c.kind === 'list');
            if (hasDirectList) {
                lines.push(`# ${node.title}`);
                lines.push('');
            }
            for (const child of node.children) {
                if (child.kind === 'heading') {
                    walk(child, 1, 0);
                } else if (child.kind === 'list') {
                    walk(child, 0, 0);
                }
            }
            return;
        }
        if (node.kind === 'heading') {
            renderHeading(node, headingDepth);
            for (const child of node.children) {
                if (child.kind === 'heading') {
                    walk(child, headingDepth + 1, 0);
                } else {
                    walk(child, 0, 0);
                }
            }
            return;
        }
        if (node.kind === 'list') {
            renderList(node, listBaseDepth);
            for (const child of node.children) {
                // 列表下不再挂 heading（即使存在也降级为 list）
                walk({ ...child, kind: 'list' }, 0, listBaseDepth + 1);
            }
            return;
        }
    }

    walk(root, 1, 0);
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n') + '\n';
}

/**
 * 节点树深拷贝（用于撤销/导出等需要快照的场景）
 */
export function cloneTree(node: MindmapNode): MindmapNode {
    return {
        id: node.id,
        title: node.title,
        depth: node.depth,
        kind: node.kind,
        children: node.children.map(cloneTree),
    };
}

/**
 * 在节点树中按 id 查找节点（含父引用）。
 */
export function findNodeById(
    root: MindmapNode,
    id: string,
): { node: MindmapNode; parent: MindmapNode | null; index: number } | null {
    if (root.id === id) return { node: root, parent: null, index: -1 };
    const stack: Array<{ node: MindmapNode; parent: MindmapNode | null; index: number }> = [
        { node: root, parent: null, index: -1 },
    ];
    while (stack.length) {
        const cur = stack.pop()!;
        cur.node.children.forEach((c, i) => {
            if (c.id === id) {
                stack.length = 0;
                stack.push({ node: c, parent: cur.node, index: i });
            } else {
                stack.push({ node: c, parent: cur.node, index: i });
            }
        });
        if (stack.length === 1 && stack[0].node.id === id) return stack[0];
    }
    return null;
}
