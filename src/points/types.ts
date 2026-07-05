export interface TestPoint {
  index: string;
  testPoint: string;
  source: string;
  testPointDesc: string;
  /** 回写时是否更新「测试点描述」列；false 表示保留 Markdown 原值 */
  patchTestPointDesc?: boolean;
  /** 同 index|testPoint 分组内的顺序（0-based），与导图子节点顺序一致 */
  groupOrdinal?: number;
}

export interface TestPointGrouped extends TestPoint {
  testPointDescList: string[];
}

export interface TableGroup {
  heading: string;
  testPoints: TestPoint[];
}

export interface FeatureEntry {
  path: string[];
  tableGroups: TableGroup[];
  lineStart: number;
  lineEnd: number;
}

export interface ParseResult {
  rootTitle: string;
  features: FeatureEntry[];
}
