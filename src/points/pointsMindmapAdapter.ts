import { createNode, type MindmapNode } from '../utils/markdownMindmap';
import { buildContentJson, XMIND_ROOT_TITLE, type XMindSheet, type XMindTopic } from './xmindGenerator';
import { parseResultFromContentJson } from './contentJsonToParseResult';
import type { FeatureEntry, ParseResult } from './types';

const FLAG_MARKER = { groupId: 'flagMakers', markerId: 'flag-purple' };
const STAR_MARKER = { groupId: 'starMakers', markerId: 'star-red' };

function getAttached(topic: XMindTopic | undefined): XMindTopic[] {
  return topic?.children?.attached ?? [];
}

function hasMarker(topic: XMindTopic, groupId: string, markerId: string): boolean {
  return (topic.markers ?? []).some((m) => m.groupId === groupId && m.markerId === markerId);
}

function topicKind(topic: XMindTopic): MindmapNode['kind'] {
  if (hasMarker(topic, STAR_MARKER.groupId, STAR_MARKER.markerId)) {
    return 'test-point';
  }
  if (hasMarker(topic, FLAG_MARKER.groupId, FLAG_MARKER.markerId)) {
    return 'path';
  }
  return 'heading';
}

function xmindTopicToMindmapNode(topic: XMindTopic, depth: number): MindmapNode {
  const kind: MindmapNode['kind'] = depth === 0 ? 'root' : topicKind(topic);
  const node = createNode(String(topic.title ?? ''), depth, kind);
  const children = getAttached(topic);

  if (kind === 'test-point') {
    node.children = children.map((child) => {
      const descNode = createNode(String(child.title ?? ''), depth + 1, 'test-desc');
      descNode.children = [];
      return descNode;
    });
  } else {
    node.children = children.map((child) => xmindTopicToMindmapNode(child, depth + 1));
  }
  return node;
}

/** ParseResult → 内置 simple-mind-map 可渲染的 MindmapNode 树 */
export function parseResultToMindmapNode(
  parseResult: ParseResult,
  rootTitle?: string
): MindmapNode {
  const sheets = buildContentJson(parseResult, rootTitle);
  const root = sheets[0]?.rootTopic;
  if (!root) {
    return createNode(rootTitle ?? XMIND_ROOT_TITLE, 0, 'root');
  }
  return xmindTopicToMindmapNode(root, 0);
}

function mindmapNodeKindToMarkers(kind: MindmapNode['kind']): XMindTopic['markers'] {
  if (kind === 'path') {
    return [FLAG_MARKER];
  }
  if (kind === 'test-point') {
    return [STAR_MARKER];
  }
  return undefined;
}

function mindmapNodeToXmindTopic(node: MindmapNode): XMindTopic {
  const markers = mindmapNodeKindToMarkers(node.kind);
  const childTopics = node.children.map(mindmapNodeToXmindTopic);
  const topic: XMindTopic = {
    id: node.id,
    title: node.title,
  };
  if (markers && markers.length > 0) {
    topic.markers = markers;
  }
  if (childTopics.length > 0) {
    topic.children = { attached: childTopics };
  }
  return topic;
}

function mindmapNodeToContentJson(tree: MindmapNode): XMindSheet[] {
  const rootTopic = mindmapNodeToXmindTopic(tree);
  return [
    {
      id: tree.id,
      title: 'sheet-1',
      rootTopic,
      topicPositioning: 'fixed',
    },
  ];
}

/** 编辑后的 MindmapNode 树 → ParseResult（供表格 patch 回写） */
export function mindmapNodeToParseResult(tree: MindmapNode): ParseResult {
  return parseResultFromContentJson(mindmapNodeToContentJson(tree));
}

/** 判断文档是否应按「功能条目 + 测试点表格」模式处理 */
export function isPointsDocument(document: { getText(): string } | import('vscode').TextDocument): boolean {
  const text = document.getText();
  return /^功能条目\s*[:：]\s*.+$/m.test(text);
}

export async function resolvePointsRootTitle(filePath: string): Promise<string> {
  const { getCurrentTaskInfo } = await import('../utils/commands');
  const currentTask = await getCurrentTaskInfo(filePath);
  if (!currentTask.bind) {
    return XMIND_ROOT_TITLE;
  }
  return `${currentTask.taskInfo.testTaskName}/${currentTask.taskInfo.subTestTaskName}`;
}
