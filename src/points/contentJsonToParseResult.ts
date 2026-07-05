import { FeatureEntry, ParseResult, TableGroup, TestPoint } from './types';
import { XMIND_ROOT_TITLE, XMindSheet, XMindTopic } from './xmindGenerator';

const DEFAULT_TABLE_HEADING = '测试点列表';
const LEGACY_FEATURE_ROOT = '功能条目';

interface FeatureDraft {
  path: string[];
  tableGroups: TableGroup[];
}

function getAttached(topic: XMindTopic | undefined): XMindTopic[] {
  return topic?.children?.attached ?? [];
}

// 支持纯数字序号（1.1.5）与字母数字序号（3AD88D.1.1）
const TEST_POINT_TITLE_REGEX = /^([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)(?:\s+(.+))?$/;

function hasMarker(topic: XMindTopic, groupId: string, markerId: string): boolean {
  return (topic.markers ?? []).some((m) => m.groupId === groupId && m.markerId === markerId);
}

function isTestPointTopic(topic: XMindTopic): boolean {
  if (hasMarker(topic, 'starMakers', 'star-red')) {
    return true;
  }
  if (hasMarker(topic, 'flagMakers', 'flag-purple')) {
    return false;
  }
  const title = String(topic.title ?? '').trim();
  return TEST_POINT_TITLE_REGEX.test(title);
}

function isPathTopic(topic: XMindTopic): boolean {
  return hasMarker(topic, 'flagMakers', 'flag-purple');
}

function parseTestPointTitle(text: string): TestPoint {
  const value = text.trim().replace(/^((?::[a-z][a-z0-9]*_[a-z0-9]+:\s*)+)/i, '').trim();
  if (!value) {
    return { index: '', testPoint: '', source: '', testPointDesc: '' };
  }
  const match = value.match(TEST_POINT_TITLE_REGEX);
  if (match) {
    return {
      index: (match[1] || '').trim(),
      testPoint: (match[2] || '').trim(),
      source: '',
      testPointDesc: '',
    };
  }
  return { index: '', testPoint: value, source: '', testPointDesc: '' };
}

/**
 * 子节点顺序 = Markdown 同行组内行顺序；按 ordinal 展开为多行测试点。
 */
function expandTestPointTopicToRows(topic: XMindTopic): TestPoint[] {
  const parsed = parseTestPointTitle(String(topic.title ?? ''));
  const descChildren = getAttached(topic);

  if (descChildren.length > 0) {
    return descChildren.map((child, ordinal) => ({
      index: parsed.index,
      testPoint: parsed.testPoint,
      source: '',
      groupOrdinal: ordinal,
      testPointDesc: String(child.title ?? ''),
      patchTestPointDesc: true,
    }));
  }

  return [
    {
      ...parsed,
      groupOrdinal: 0,
      patchTestPointDesc: false,
    },
  ];
}

function collectFeaturesFromTopic(
  topic: XMindTopic,
  path: string[],
  output: FeatureDraft[]
): void {
  const text = String(topic.title ?? '').trim();
  const children = getAttached(topic);

  if (children.length === 0) {
    return;
  }

  const isDirectPointList = children.length > 0 && children.every((child) => isTestPointTopic(child));
  if (isDirectPointList) {
    const testPoints = children.flatMap((child) => expandTestPointTopicToRows(child));
    if (testPoints.length > 0) {
      output.push({
        path: path.concat(text).filter(Boolean),
        tableGroups: [{ heading: DEFAULT_TABLE_HEADING, testPoints }],
      });
    }
    return;
  }

  const pathChildren = children.filter((child) => isPathTopic(child));
  const testPointChildren = children.filter((child) => isTestPointTopic(child));
  if (pathChildren.length > 0 && testPointChildren.length > 0) {
    const featurePath = path.concat(text).filter(Boolean);
    const testPoints = testPointChildren.flatMap((child) => expandTestPointTopicToRows(child));
    if (testPoints.length > 0) {
      output.push({
        path: featurePath,
        tableGroups: [{ heading: DEFAULT_TABLE_HEADING, testPoints }],
      });
    }
    for (const child of pathChildren) {
      collectFeaturesFromTopic(child, featurePath, output);
    }
    return;
  }

  const nextPath = path.concat(text).filter(Boolean);
  for (const child of children) {
    collectFeaturesFromTopic(child, nextPath, output);
  }
}

/** 从标准 XMind content.json 还原 ParseResult（与 buildContentJson 输出同构） */
export function parseResultFromContentJson(sheets: XMindSheet[]): ParseResult {
  const root = sheets[0]?.rootTopic;
  if (!root) {
    return { rootTitle: XMIND_ROOT_TITLE, features: [] };
  }

  let level1 = getAttached(root);
  if (level1.length === 1 && String(level1[0].title ?? '').trim() === LEGACY_FEATURE_ROOT) {
    level1 = getAttached(level1[0]);
  }

  const drafts: FeatureDraft[] = [];
  for (const node of level1) {
    collectFeaturesFromTopic(node, [], drafts);
  }

  const features: FeatureEntry[] = drafts.map((draft) => ({
    path: draft.path,
    tableGroups: draft.tableGroups,
    lineStart: 0,
    lineEnd: 0,
  }));

  return {
    rootTitle: String(root.title ?? XMIND_ROOT_TITLE).trim() || XMIND_ROOT_TITLE,
    features,
  };
}
