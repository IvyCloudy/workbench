import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parsePointsMarkdownText } from '../points/markdownParser';
import { buildContentJson } from '../points/xmindGenerator';
import { parseResultFromContentJson } from '../points/contentJsonToParseResult';
import { patchMarkdownTablesWithEditedResult } from '../points/markdownTablePatcher';
import { parseResultToMindmapNode, mindmapNodeToParseResult } from '../points/pointsMindmapAdapter';

function mockDocument(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    lineCount: lines.length,
    lineAt: (i: number) => ({ text: lines[i] ?? '' }),
  } as import('vscode').TextDocument;
}

describe('parsePointsMarkdown', () => {
  it('parses feature entries and table rows from point_example.md', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../examples/point_example.md'),
      'utf-8'
    );
    const result = parsePointsMarkdownText(text);
    expect(result.rootTitle).toBe('1. 测试大纲');
    expect(result.features.length).toBe(1);
    expect(result.features[0].path).toEqual(['功能条目路径']);
    expect(result.features[0].tableGroups[0].testPoints).toHaveLength(1);
    expect(result.features[0].tableGroups[0].testPoints[0]).toMatchObject({
      index: '1.1.1',
      testPoint: 'xxx',
      testPointDesc: '基于xxx的测试点',
    });
  });

  it('parses multiple tables under the same feature path', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../xmind/example-markdown/0624新版本point.md'),
      'utf-8'
    );
    const result = parsePointsMarkdownText(text);
    expect(result.features.length).toBeGreaterThan(1);
    const firstPath = result.features[0].path.join('/');
    expect(firstPath).toContain('入库申请');
    const totalPoints = result.features.reduce(
      (sum, f) => sum + f.tableGroups.reduce((s, g) => s + g.testPoints.length, 0),
      0
    );
    expect(totalPoints).toBeGreaterThan(10);
  });
});

describe('contentJson round-trip', () => {
  it('buildContentJson → parseResultFromContentJson preserves feature paths and test points', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../examples/point_example.md'),
      'utf-8'
    );
    const original = parsePointsMarkdownText(text);
    const sheets = buildContentJson(original);
    const restored = parseResultFromContentJson(sheets);

    expect(restored.features.length).toBe(original.features.length);
    expect(restored.features[0].path).toEqual(original.features[0].path);
    expect(restored.features[0].tableGroups[0].testPoints[0].index).toBe('1.1.1');
    expect(restored.features[0].tableGroups[0].testPoints[0].testPoint).toBe('xxx');
  });
});

describe('pointsMindmapAdapter round-trip', () => {
  it('parseResult → MindmapNode → ParseResult preserves test points', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../examples/point_example.md'),
      'utf-8'
    );
    const original = parsePointsMarkdownText(text);
    const tree = parseResultToMindmapNode(original, '测试任务/子任务');
    const restored = mindmapNodeToParseResult(tree);

    expect(restored.features[0].tableGroups[0].testPoints[0]).toMatchObject({
      index: '1.1.1',
      testPoint: 'xxx',
    });
  });
});

describe('points writeback after edit', () => {
  it('patches markdown when test point title is edited in mindmap tree', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../examples/point_example.md'),
      'utf-8'
    );
    const doc = mockDocument(text);
    const original = parsePointsMarkdownText(text);
    const tree = parseResultToMindmapNode(original, '测试任务/子任务');

    function findTestPoint(node: import('../utils/markdownMindmap').MindmapNode): import('../utils/markdownMindmap').MindmapNode | undefined {
      if (node.kind === 'test-point') return node;
      for (const child of node.children) {
        const found = findTestPoint(child);
        if (found) return found;
      }
      return undefined;
    }

    const testPointNode = findTestPoint(tree);
    expect(testPointNode).toBeDefined();
    testPointNode!.title = '1.1.1 updated test point';

    const edited = mindmapNodeToParseResult(tree);
    const patched = patchMarkdownTablesWithEditedResult(doc, edited);
    expect(patched.updatedFeatures).toBeGreaterThan(0);
    expect(patched.markdown).toContain('updated test point');
  });
});

describe('patchMarkdownTablesWithEditedResult', () => {
  it('patches edited test point text while preserving table structure', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '../../examples/point_example.md'),
      'utf-8'
    );
    const doc = mockDocument(text);
    const original = parsePointsMarkdownText(text);
    const sheets = buildContentJson(original);
    const edited = parseResultFromContentJson(sheets);
    edited.features[0].tableGroups[0].testPoints[0].testPoint = 'updated test point';

    const patched = patchMarkdownTablesWithEditedResult(doc, edited);
    expect(patched.updatedFeatures).toBeGreaterThan(0);
    expect(patched.markdown).toContain('updated test point');
    expect(patched.markdown).toContain('| 序号');
  });
});
