/**
 * 单测：md ↔ 思维导图节点树双向解析
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdown, toMarkdown, type MindmapNode } from '../utils/markdownMindmap';

function strip(node: MindmapNode): any {
    return {
        title: node.title,
        kind: node.kind,
        children: node.children.map(strip),
    };
}

describe('markdownMindmap.parseMarkdown', () => {
    it('空文档返回占位根节点', () => {
        const root = parseMarkdown('');
        expect(root.kind).toBe('root');
        expect(root.title).toBe('未命名思维导图');
        expect(root.children.length).toBe(0);
    });

    it('单一 H1 直接作为根', () => {
        const root = parseMarkdown('# 我的大纲\n## 模块A\n### 子模块');
        expect(root.kind).toBe('heading');
        expect(root.title).toBe('我的大纲');
        expect(root.children.length).toBe(1);
        expect(root.children[0].title).toBe('模块A');
        expect(root.children[0].children[0].title).toBe('子模块');
    });

    it('多个 H1 时合成虚拟根', () => {
        const root = parseMarkdown('# A\n# B\n# C');
        expect(root.kind).toBe('root');
        expect(root.children.length).toBe(3);
        expect(root.children.map(c => c.title)).toEqual(['A', 'B', 'C']);
    });

    it('list 项作为最近 heading 的叶子', () => {
        const root = parseMarkdown('# 大纲\n## 模块\n- 用例1\n- 用例2');
        const mod = root.children[0];
        expect(mod.title).toBe('模块');
        expect(mod.children.map(c => c.title)).toEqual(['用例1', '用例2']);
        expect(mod.children.every(c => c.kind === 'list')).toBe(true);
    });

    it('list 缩进派生层级', () => {
        const root = parseMarkdown('# 大纲\n- 一级\n  - 二级\n    - 三级');
        const lvl1 = root.children[0];
        expect(lvl1.title).toBe('一级');
        expect(lvl1.children[0].title).toBe('二级');
        expect(lvl1.children[0].children[0].title).toBe('三级');
    });

    it('无 # 但有 list：自动合成根', () => {
        const root = parseMarkdown('- 一级\n- 一级2');
        expect(root.kind).toBe('root');
        expect(root.children.map(c => c.title)).toEqual(['一级', '一级2']);
    });
});

describe('markdownMindmap.toMarkdown', () => {
    it('单根 heading 树序列化', () => {
        const root = parseMarkdown('# 大纲\n## 模块A\n### 子A');
        const md = toMarkdown(root);
        expect(md).toContain('# 大纲');
        expect(md).toContain('## 模块A');
        expect(md).toContain('### 子A');
    });

    it('list 节点用 - 输出且按层级缩进', () => {
        const root = parseMarkdown('# 大纲\n## 模块\n- 用例1\n  - 子用例');
        const md = toMarkdown(root);
        expect(md).toContain('- 用例1');
        expect(md).toContain('  - 子用例');
    });

    it('空文档可序列化为合法 md', () => {
        const root = parseMarkdown('');
        const md = toMarkdown(root);
        // 空文档（root + 无子）输出空字符串或仅末尾换行
        expect(md.trim()).toBe('');
    });
});

describe('markdownMindmap 双向往返一致性', () => {
    function roundTrip(md: string): string {
        return toMarkdown(parseMarkdown(md));
    }

    it('标题树往返 1 次后再次解析结构稳定', () => {
        const src = '# 大纲\n\n## 模块A\n\n### 子A1\n\n### 子A2\n\n## 模块B\n';
        const tree1 = parseMarkdown(src);
        const md1 = toMarkdown(tree1);
        const tree2 = parseMarkdown(md1);
        expect(strip(tree2)).toEqual(strip(tree1));
        // 二次序列化应当幂等
        expect(toMarkdown(tree2)).toBe(md1);
    });

    it('混合 heading + list 往返结构稳定', () => {
        const src = '# 大纲\n## 模块A\n- 用例1\n  - 步骤1\n- 用例2\n## 模块B\n';
        const tree1 = parseMarkdown(src);
        const md1 = toMarkdown(tree1);
        const tree2 = parseMarkdown(md1);
        expect(strip(tree2)).toEqual(strip(tree1));
    });
});
