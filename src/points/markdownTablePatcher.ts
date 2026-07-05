import { parsePointsMarkdown } from './markdownParser';
import { splitTableCells } from './tableCells';
import { pickTestPointFields, resolveTableColumnsFromLines, TableColumnMap } from './tableColumns';
import { FeatureEntry, ParseResult, TestPoint } from './types';
import { TextDocument } from 'vscode';
const TABLE_ROW_REGEX = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR_REGEX = /^\s*\|[\s\-:|]+\|\s*$/;
const FEATURE_LINE_REGEX = /^功能条目\s*[:：]\s*(.+)$/;

function escapeCell(value: string): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

interface TableRange {
  separatorLine: number;
  rowStart: number;
  rowEnd: number;
  columns: TableColumnMap;
}

interface RowPatchContext {
  featurePath: string;
  columns: TableColumnMap;
}

interface AppendOperation {
  at: number;
  newLines: string[];
}

function pathKey(path: string[]): string {
  return path.map((segment) => segment.trim()).join('/');
}

export function featurePathKey(path: string[]): string {
  return pathKey(path);
}

// 回写匹配键：同一路径下序号唯一，不同路径允许相同序号。
function pointKey(featurePathKey: string, index: string): string {
  return `${featurePathKey}::${index}`;
}

function pointOrdinalKey(featurePathKey: string, index: string, ordinal: number): string {
  return `${featurePathKey}::${index}::${ordinal}`;
}

function flattenPoints(feature: FeatureEntry): TestPoint[] {
  const points: TestPoint[] = [];
  for (const group of feature.tableGroups) {
    points.push(...group.testPoints);
  }
  return points;
}

function uniquePathKeys(features: FeatureEntry[]): string[] {
  const paths = new Set<string>();
  for (const feature of features) {
    paths.add(pathKey(feature.path));
  }
  return [...paths];
}

/** 同一路径下全部测试点的稳定签名，用于路径重命名后与原始功能条目匹配 */
function buildPathSignature(features: FeatureEntry[], featurePath: string): string {
  const parts: string[] = [];
  const indexCounters = new Map<string, number>();

  for (const feature of features) {
    if (pathKey(feature.path) !== featurePath) {
      continue;
    }
    for (const point of flattenPoints(feature)) {
      const index = (point.index || '').trim();
      if (!index) {
        continue;
      }
      const ordinal =
        point.groupOrdinal !== undefined
          ? point.groupOrdinal
          : (indexCounters.get(index) ?? 0);
      if (point.groupOrdinal === undefined) {
        indexCounters.set(index, ordinal + 1);
      }
      parts.push(`${index}::${ordinal}`);
    }
  }
  return parts.sort().join('|');
}

function findOriginalPathForEdited(
  editedPath: string,
  editedSig: string,
  originalSigByPath: Map<string, string>,
  originalPaths: Set<string>
): string | undefined {
  if (originalPaths.has(editedPath)) {
    return editedPath;
  }
  if (!editedSig) {
    return undefined;
  }

  let candidate: string | undefined;
  for (const [origPath, origSig] of originalSigByPath) {
    if (origSig !== editedSig) {
      continue;
    }
    if (candidate) {
      return undefined;
    }
    candidate = origPath;
  }
  return candidate;
}

/**
 * 根据测试点签名推断路径重命名映射（原始路径 -> 编辑后路径）。
 * 仅当某编辑路径的签名与唯一原始路径一致时建立映射。
 */
export function buildPathRemap(
  originalResult: ParseResult,
  editedResult: ParseResult
): Map<string, string> {
  const originalPaths = new Set(uniquePathKeys(originalResult.features));
  const editedPaths = uniquePathKeys(editedResult.features);
  const originalSigByPath = new Map<string, string>();
  const remap = new Map<string, string>();

  for (const path of originalPaths) {
    originalSigByPath.set(path, buildPathSignature(originalResult.features, path));
  }

  for (const editedPath of editedPaths) {
    if (originalPaths.has(editedPath)) {
      continue;
    }
    const editedSig = buildPathSignature(editedResult.features, editedPath);
    const originalPath = findOriginalPathForEdited(
      editedPath,
      editedSig,
      originalSigByPath,
      originalPaths
    );
    if (originalPath && originalPath !== editedPath) {
      remap.set(originalPath, editedPath);
    }
  }

  return remap;
}

function buildReversePathRemap(pathRemap: Map<string, string>): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [originalPath, editedPath] of pathRemap) {
    reverse.set(editedPath, originalPath);
  }
  return reverse;
}

function resolveOriginalPathForLookup(
  editedPath: string,
  reversePathRemap: Map<string, string>
): string {
  return reversePathRemap.get(editedPath) ?? editedPath;
}

function patchFeaturePathLines(
  lines: string[],
  pathRemap: Map<string, string>
): number {
  let changedPaths = 0;
  if (pathRemap.size === 0) {
    return changedPaths;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const match = trimmed.match(FEATURE_LINE_REGEX);
    if (!match) {
      continue;
    }
    const path = match[1]
      .split(/[/\\]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const key = pathKey(path);
    const newPathKey = pathRemap.get(key);
    if (!newPathKey) {
      continue;
    }
    const colonMatch = lines[i].match(/^功能条目\s*([:：])/);
    const colon = colonMatch?.[1] ?? '：';
    const newLine = `功能条目${colon} ${newPathKey}`;
    if (lines[i] !== newLine) {
      lines[i] = newLine;
      changedPaths++;
    }
  }

  return changedPaths;
}

function stringifyRow(cells: string[]): string {
  return `| ${cells.map((cell) => escapeCell(cell ?? '')).join(' | ')} |`;
}

function inferTableColumnCount(lines: string[], separatorLine: number): number {
  const headerLine = separatorLine - 1;
  if (headerLine < 0) {
    return 3;
  }
  const rowMatch = String(lines[headerLine] ?? '').trim().match(TABLE_ROW_REGEX);
  if (!rowMatch) {
    return 3;
  }
  return splitTableCells(rowMatch[1]).length;
}

function collectTableRanges(lines: string[], feature: FeatureEntry): TableRange[] {
  const ranges: TableRange[] = [];
  let i = feature.lineStart + 1;
  while (i < feature.lineEnd) {
    const line = lines[i].trim();
    if (!TABLE_SEPARATOR_REGEX.test(line)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < feature.lineEnd) {
      const rowLine = lines[j].trim();
      if (rowLine === '' || rowLine.startsWith('#') || FEATURE_LINE_REGEX.test(rowLine)) {
        break;
      }
      if (TABLE_SEPARATOR_REGEX.test(rowLine) || TABLE_ROW_REGEX.test(rowLine)) {
        j++;
        continue;
      }
      break;
    }
    ranges.push({
      separatorLine: i,
      rowStart: i + 1,
      rowEnd: j,
      columns: resolveTableColumnsFromLines(lines, i),
    });
    i = j;
  }
  return ranges;
}

function buildEditedPointByOrdinal(
  editedResult: ParseResult,
  reversePathRemap: Map<string, string>
): Map<string, TestPoint> {
  const byPathIndexOrdinal = new Map<string, TestPoint>();

  for (const feature of editedResult.features) {
    const editedPath = pathKey(feature.path);
    const featurePath = resolveOriginalPathForLookup(editedPath, reversePathRemap);
    for (const group of feature.tableGroups) {
      for (const point of group.testPoints) {
        const index = (point.index || '').trim();
        if (!index || point.groupOrdinal === undefined) {
          continue;
        }
        byPathIndexOrdinal.set(
          pointOrdinalKey(featurePath, index, point.groupOrdinal),
          point
        );
      }
    }
  }

  return byPathIndexOrdinal;
}

function applyEditedPointToRow(
  cells: string[],
  columns: TableColumnMap,
  editedPoint: TestPoint
): boolean {
  let changed = false;
  const index = (editedPoint.index || '').trim();
  if (index && cells[columns.indexCol] !== index) {
    cells[columns.indexCol] = index;
    changed = true;
  }
  if (editedPoint.testPoint !== undefined && cells[columns.testPoint] !== editedPoint.testPoint) {
    cells[columns.testPoint] = editedPoint.testPoint;
    changed = true;
  }
  if (
    columns.testPointDesc >= 0 &&
    editedPoint.patchTestPointDesc !== false &&
    cells[columns.testPointDesc] !== editedPoint.testPointDesc
  ) {
    cells[columns.testPointDesc] = editedPoint.testPointDesc ?? '';
    changed = true;
  }
  return changed;
}

export function patchMarkdownTablesWithEditedResult(
  originalDocument: TextDocument,
  editedResult: ParseResult
): { markdown: string; updatedFeatures: number } {
  const originalResult = parsePointsMarkdown(originalDocument);
  const lines: string[] = [];

  for (let i = 0; i < originalDocument.lineCount; i++) {
    lines.push(originalDocument.lineAt(i).text);
  }
  const pathRemap = buildPathRemap(originalResult, editedResult);
  const reversePathRemap = buildReversePathRemap(pathRemap);
  const editedByOrdinal = buildEditedPointByOrdinal(editedResult, reversePathRemap);
  const existingPointKeys = new Set<string>();
  const rowContextByLine = new Map<number, RowPatchContext>();
  const linesPerPointKey = new Map<string, number[]>();
  let changedRows = 0;

  // 建立「表格行号 -> 功能条目路径 + 列映射」，回写时按表头定位序号/测试点列。
  for (const feature of originalResult.features) {
    const featurePath = pathKey(feature.path);
    const tableRanges = collectTableRanges(lines, feature);
    for (const range of tableRanges) {
      for (let i = range.rowStart; i < range.rowEnd; i++) {
        rowContextByLine.set(i, { featurePath, columns: range.columns });
        const rowLine = lines[i].trim();
        const rowMatch = rowLine.match(TABLE_ROW_REGEX);
        if (!rowMatch) {
          continue;
        }
        const cells = splitTableCells(rowMatch[1]);
        const { index } = pickTestPointFields(cells, range.columns);
        if (!index) {
          continue;
        }
        const key = pointKey(featurePath, index);
        const bucket = linesPerPointKey.get(key) ?? [];
        bucket.push(i);
        linesPerPointKey.set(key, bucket);
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const rowMatch = line.match(TABLE_ROW_REGEX);
    if (!rowMatch) {
      continue;
    }
    const rowContext = rowContextByLine.get(i);
    if (!rowContext) {
      continue;
    }
    const cells = splitTableCells(rowMatch[1]);
    const { index } = pickTestPointFields(cells, rowContext.columns);
    if (!index) {
      continue;
    }
    const key = pointKey(rowContext.featurePath, index);
    existingPointKeys.add(key);

    const siblingLines = linesPerPointKey.get(key) ?? [];
    const ordinal = siblingLines.indexOf(i);
    if (ordinal < 0) {
      continue;
    }
    const editedPoint = editedByOrdinal.get(
      pointOrdinalKey(rowContext.featurePath, index, ordinal)
    );
    if (!editedPoint) {
      continue;
    }

    if (applyEditedPointToRow(cells, rowContext.columns, editedPoint)) {
      lines[i] = stringifyRow(cells);
      changedRows++;
    }
  }

  // 对于新增序号，按功能条目路径追加到对应 feature 的最后一个表格中。
  const originalByPath = new Map<string, FeatureEntry[]>();
  for (const feature of originalResult.features) {
    const key = pathKey(feature.path);
    const bucket = originalByPath.get(key) ?? [];
    bucket.push(feature);
    originalByPath.set(key, bucket);
  }

  const appendOps: AppendOperation[] = [];

  for (const editedFeature of editedResult.features) {
    const editedKey = pathKey(editedFeature.path);
    const lookupKey = resolveOriginalPathForLookup(editedKey, reversePathRemap);
    const originals = originalByPath.get(lookupKey) ?? [];
    if (originals.length === 0) {
      continue;
    }
    const targetFeature = originals[originals.length - 1];
    if (!targetFeature) {
      continue;
    }
    const tableRanges = collectTableRanges(lines, targetFeature);
    if (tableRanges.length === 0) {
      continue;
    }
    const targetTable = tableRanges[tableRanges.length - 1];
    const { columns } = targetTable;
    const columnCount = Math.max(inferTableColumnCount(lines, targetTable.separatorLine), 2);
    const newLines: string[] = [];
    for (const point of flattenPoints(editedFeature)) {
      const index = (point.index || '').trim();
      if (!index) {
        continue;
      }
      const pointId = pointKey(lookupKey, index);
      const siblingLines = linesPerPointKey.get(pointId) ?? [];
      if (
        point.groupOrdinal !== undefined &&
        point.groupOrdinal < siblingLines.length
      ) {
        continue;
      }
      if (point.groupOrdinal === undefined && existingPointKeys.has(pointId)) {
        continue;
      }
      const cells = new Array<string>(columnCount).fill('');
      cells[columns.indexCol] = index;
      cells[columns.testPoint] = point.testPoint;
      if (columns.testPointDesc >= 0) {
        cells[columns.testPointDesc] = point.testPointDesc;
      }
      newLines.push(stringifyRow(cells));
      existingPointKeys.add(pointId);
      changedRows++;
    }
    if (newLines.length === 0) {
      continue;
    }
    appendOps.push({ at: targetTable.rowEnd, newLines });
  }

  // 逆序插入，避免前面插入导致后续插入位置偏移。
  appendOps.sort((a, b) => b.at - a.at);
  for (const op of appendOps) {
    lines.splice(op.at, 0, ...op.newLines);
  }

  const changedPaths = patchFeaturePathLines(lines, pathRemap);

  return {
    markdown: lines.join('\n'),
    updatedFeatures: changedRows + changedPaths,
  };
}
