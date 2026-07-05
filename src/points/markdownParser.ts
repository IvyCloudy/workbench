import { FeatureEntry, ParseResult, TableGroup, TestPoint } from './types';
import { TextDocument } from 'vscode';
import { splitTableCells } from './tableCells';
import { pickTestPointFields, resolveTableColumnsFromLines } from './tableColumns';

const FEATURE_LINE_REGEX = /^功能条目\s*[:：]\s*(.+)$/;
const H4_REGEX = /^####\s+(.+)$/;
const TABLE_SEPARATOR_REGEX = /^\s*\|[\s\-:|]+\|\s*$/;
const TABLE_ROW_REGEX = /^\s*\|(.+)\|\s*$/;
const H1_REGEX = /^#\s+(.+)$/;
const GROUP_HEADING_REGEX = /^(测试点列表|关联测试点列表|公共测试点列表|覆盖测试点列表)$/;

export function parsePointsMarkdown(document: TextDocument): ParseResult {
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }
  return {
    rootTitle: findRootTitle(lines),
    features: extractFeatures(lines),
  };
}

export function parsePointsMarkdownText(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return {
    rootTitle: findRootTitle(lines),
    features: extractFeatures(lines),
  };
}

function findRootTitle(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(H1_REGEX);
    if (match) {
      return match[1].trim();
    }
  }
  return '无标题';
}

function extractFeatures(lines: string[]): FeatureEntry[] {
  const featureLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (FEATURE_LINE_REGEX.test(lines[i])) {
      featureLineIndices.push(i);
    }
  }

  if (featureLineIndices.length === 0) {
    return [];
  }

  const features: FeatureEntry[] = [];
  for (let i = 0; i < featureLineIndices.length; i++) {
    const lineStart = featureLineIndices[i];
    const nextFeatureLine =
      i + 1 < featureLineIndices.length ? featureLineIndices[i + 1] : lines.length;
    const lineEnd = findFeatureEndLine(lines, lineStart, nextFeatureLine);

    const pathStr = lines[lineStart].match(FEATURE_LINE_REGEX)![1].trim();
    const path = pathStr
      .split(/[/\\]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const initialHeading = findInitialHeading(lines, lineStart);
    const tableGroups = extractTableGroups(lines, lineStart + 1, lineEnd, initialHeading);

    features.push({ path, tableGroups, lineStart, lineEnd });
  }

  return features;
}

function findFeatureEndLine(
  lines: string[],
  lineStart: number,
  nextFeatureLine: number
): number {
  for (let i = lineStart + 1; i < nextFeatureLine; i++) {
    const line = lines[i].trim();
    if (/^#{2,3}\s/.test(line) || line === '---') {
      return i;
    }
  }
  return nextFeatureLine;
}

function findInitialHeading(lines: string[], featureLineIndex: number): string {
  for (let i = featureLineIndex - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (FEATURE_LINE_REGEX.test(line)) {
      break;
    }
    if (/^#{1,3}\s/.test(line)) {
      break;
    }

    const h4Match = line.match(H4_REGEX);
    if (h4Match) {
      return h4Match[1].trim();
    }

    if (GROUP_HEADING_REGEX.test(line)) {
      return line;
    }
  }
  return '未分类';
}

function extractTableGroups(
  lines: string[],
  startLine: number,
  endLine: number,
  initialHeading: string
): TableGroup[] {
  const groups: TableGroup[] = [];
  let currentHeading = initialHeading;
  let i = startLine;

  while (i < endLine) {
    const line = lines[i].trim();

    const h4Match = line.match(H4_REGEX);
    if (h4Match) {
      currentHeading = h4Match[1].trim();
      i++;
      continue;
    }

    if (GROUP_HEADING_REGEX.test(line)) {
      currentHeading = line;
      i++;
      continue;
    }

    if (TABLE_SEPARATOR_REGEX.test(line)) {
      const table = extractTable(lines, i, endLine);
      if (table.length > 0) {
        groups.push({ heading: currentHeading, testPoints: table });
      }
      i = skipTable(lines, i, endLine);
      continue;
    }

    i++;
  }

  return groups;
}

function extractTable(lines: string[], separatorLine: number, endLine: number): TestPoint[] {
  const points: TestPoint[] = [];
  const columns = resolveTableColumnsFromLines(lines, separatorLine);
  for (let i = separatorLine + 1; i < endLine; i++) {
    const line = lines[i].trim();

    if (line === '' || line.startsWith('#')) {
      break;
    }

    if (FEATURE_LINE_REGEX.test(line)) {
      break;
    }

    if (TABLE_SEPARATOR_REGEX.test(line)) {
      continue;
    }

    const rowMatch = line.match(TABLE_ROW_REGEX);
    if (!rowMatch) {
      break;
    }

    const cells = splitTableCells(rowMatch[1]);
    const { index, testPoint, testPointDesc } = pickTestPointFields(cells, columns);
    if (index && testPoint) {
      points.push({ index, testPoint, source: '', testPointDesc });
    }
  }

  return points;
}

function skipTable(lines: string[], separatorLine: number, endLine: number): number {
  let i = separatorLine + 1;
  while (i < endLine) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) {
      return i;
    }
    if (FEATURE_LINE_REGEX.test(line)) {
      return i;
    }
    if (TABLE_SEPARATOR_REGEX.test(line)) {
      i++;
      continue;
    }
    if (!TABLE_ROW_REGEX.test(line)) {
      return i;
    }
    i++;
  }
  return i;
}
