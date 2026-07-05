import * as vscode from 'vscode';
import {createId} from './xmindIds';
import JSZip from 'jszip';
import {FeatureEntry, ParseResult, TestPoint, TestPointGrouped} from './types';

interface XMindMarker {
  groupId: string;
  markerId: string;
}

export interface BuildContentJsonOptions {
  /** 叶子节点 title 是否带序号前缀，默认 true（`序号 描述`） */
  includeIndexInLeafTitle?: boolean;
}

export interface XMindTopic {
  id: string;
  title: string;
  structureClass?: string;
  markers?: XMindMarker[];
  children?: {
    attached: XMindTopic[];
  };
}

export interface XMindSheet {
  id: string;
  title: string;
  rootTopic: XMindTopic;
  topicPositioning: string;
}

const FLAG_MARKER: XMindMarker = {
  groupId: 'flagMakers',
  markerId: 'flag-purple',
};

const STAR_MARKER: XMindMarker = {
  groupId: 'starMakers',
  markerId: 'star-red',
};

/** XMind 导图根节点（Level 0）默认标题 */
export const XMIND_ROOT_TITLE = '测试任务/子任务';

export async function generateXMind(
  parseResult: ParseResult,
  outputPath: string,
  rootTitle?: string
): Promise<void> {
  const content = buildContentJson(parseResult, rootTitle);
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(content));
  zip.file('metadata.json', JSON.stringify({}));
  zip.file(
    'manifest.json',
    JSON.stringify({
      'file-entries': {
        'content.json': {},
        'metadata.json': {},
      },
    })
  );

  const uint8Array = await zip.generateAsync({type: 'uint8array'});
  await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPath), uint8Array);
}

export function buildContentJson(parseResult: ParseResult, rootTitle?: string, options: BuildContentJsonOptions = {}): XMindSheet[] {

  const rootTopic = buildRootTopic(parseResult, rootTitle, options);
  return [
    {
      id: createId(),
      title: 'sheet-1',
      rootTopic,
      topicPositioning: 'fixed',
    },
  ];
}

function buildRootTopic(parseResult: ParseResult, rootTitle?: string, options: BuildContentJsonOptions = {}): XMindTopic {
  const pathTree = buildPathTree(parseResult.features);
  const level1Children: XMindTopic[] = [];

  for (const child of pathTree.children.values()) {
    level1Children.push(buildPathSegmentTopic(child, options));
  }

  for (const feature of pathTree.features) {
    level1Children.push(buildLeafFeatureTopic(feature, options));
  }

  const root: XMindTopic = {
    id: createId(),
    title: rootTitle ?? XMIND_ROOT_TITLE,
    structureClass: 'org.xmind.ui.logic.right',
  };

  if (level1Children.length > 0) {
    root.children = {attached: level1Children};
  }

  return root;
}

interface PathTreeNode {
  title: string;
  features: FeatureEntry[];
  children: Map<string, PathTreeNode>;
}

function buildPathTree(features: FeatureEntry[]): PathTreeNode {
  const root: PathTreeNode = {
    title: '',
    features: [],
    children: new Map(),
  };

  for (const feature of features) {
    if (feature.path.length === 0) {
      root.features.push(feature);
      continue;
    }

    let current = root;
    for (let i = 0; i < feature.path.length; i++) {
      const segment = feature.path[i];
      let child = current.children.get(segment);
      if (!child) {
        child = {title: segment, features: [], children: new Map()};
        current.children.set(segment, child);
      }
      current = child;
      if (i === feature.path.length - 1) {
        current.features.push(feature);
      }
    }
  }

  return root;
}

function buildPathSegmentTopic(node: PathTreeNode, options: BuildContentJsonOptions = {}): XMindTopic {
  const topic = createXmindTopic(node.title, {withFlag: true, children: []});

  for (const child of node.children.values()) {
    topic.children!.attached.push(buildPathSegmentTopic(child, options));
  }

  for (const feature of node.features) {
    appendTestPointsToTopic(topic, feature, options);
  }

  if (topic.children!.attached.length === 0) {
    delete topic.children;
  }

  return topic;
}

function buildLeafFeatureTopic(feature: FeatureEntry, options: BuildContentJsonOptions = {}): XMindTopic {
  const topic = createXmindTopic('未命名功能条目', {withFlag: true, children: []});
  appendTestPointsToTopic(topic, feature, options);
  if (topic.children!.attached.length === 0) {
    delete topic.children;
  }
  return topic;
}

/**
 * 按照 index 和 testPoint 分组，合并 testPointDesc
 * @param data原始 TestPoint 数组
 * @returns 去重并带有描述列表的数组
 */
export function groupTestPoints(data: TestPoint[]): TestPointGrouped[] {
  const map = new Map<string, { base: TestPoint; descList: string[] }>();

  data.forEach((item) => {
    const key = `${item.index}|${item.testPoint}`;
    const descText = String(item.testPointDesc ?? '');

    if (map.has(key)) {
      map.get(key)!.descList.push(descText);
    } else {
      map.set(key, {
        base: {
          index: item.index,
          testPoint: item.testPoint,
          source: item.source,
          testPointDesc: item.testPointDesc,
        },
        descList: [descText],
      });
    }
  });

  return Array.from(map.values()).map((group) => ({
    ...group.base,
    testPointDescList: [...group.descList],
  }));
}

/** 将各表格组的测试点直接挂在功能路径最后一层节点下，不再插入「测试点列表」等分组节点 */
function appendTestPointsToTopic(parent: XMindTopic, feature: FeatureEntry, options: BuildContentJsonOptions = {}): void {
  for (const group of feature.tableGroups) {
    const result = groupTestPoints(group.testPoints);

    for (const testPoint of result) {

      parent.children!.attached.push(buildTestPointTopic(testPoint, options));
    }
  }
}

function buildTestPointTopic(testPoint: TestPointGrouped, options: BuildContentJsonOptions = {}): XMindTopic {
  const includeIndex = options.includeIndexInLeafTitle !== false;
  const title = includeIndex && testPoint.index ?
    `${testPoint.index} ${testPoint.testPoint}` :
    testPoint.testPoint;
  const entries = testPoint.testPointDescList || [];
  const needsDescChildren =
    entries.length > 1 || entries.some((entry) => String(entry).trim().length > 0);
  const descList: XMindTopic[] = needsDescChildren
    ? entries.map((text) => ({
        id: createId(),
        title: text,
      }))
    : [];

  return createXmindTopic(title, { withStar: true, children: descList });
}

export function createXmindTopic(
  title: string,
  options: { withFlag?: boolean; withStar?: boolean; children?: XMindTopic[] } = {}
): XMindTopic {
  const topic: XMindTopic = {
    id: createId(),
    title,
  };

  const markers: XMindMarker[] = [];
  if (options.withFlag) {
    markers.push(FLAG_MARKER);
  }
  if (options.withStar) {
    markers.push(STAR_MARKER);
  }
  if (markers.length > 0) {
    topic.markers = markers;
  }

  if (options.children) {
    topic.children = {attached: options.children};
  }

  return topic;
}

