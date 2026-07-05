import { splitTableCells } from './tableCells';

const INDEX_HEADER_NAMES = ['序号'];
const TESTPOINT_HEADER_NAMES = ['测试点'];
const TESTPOINT_DESC_HEADER_NAMES = ['描述', '测试点描述'];
const SOURCE_HEADER_NAMES = ['引入来源', '来源'];

export interface TableColumnMap {
  indexCol: number;
  testPoint: number;
  testPointDesc: number;
}

function findColumnIndex(headers: string[], names: string[]): number {
  for (const name of names) {
    const idx = headers.findIndex((header) => header.trim() === name);
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

export function resolveTableColumns(headers: string[], headerLine: number): TableColumnMap {
  const indexCol = findColumnIndex(headers, INDEX_HEADER_NAMES);
  const testPointCol = findColumnIndex(headers, TESTPOINT_HEADER_NAMES);
  const testPointDescCol = findColumnIndex(headers, TESTPOINT_DESC_HEADER_NAMES);
  findColumnIndex(headers, SOURCE_HEADER_NAMES);
  if (indexCol < 0 || testPointCol < 0) {
    throw new Error(`行号${headerLine} 表头行不包含序号/测试点,请检查文本内表头设置`);
  }
  return {
    indexCol,
    testPoint: testPointCol,
    testPointDesc: testPointDescCol,
  };
}

const TABLE_ROW_REGEX = /^\s*\|(.+)\|\s*$/;

export function resolveTableColumnsFromLines(lines: string[], separatorLine: number): TableColumnMap {
  const headerLine = separatorLine - 1;
  if (headerLine < 0) {
    throw new Error('未能解析到表头行，请检查文件设置');
  }
  const rowMatch = String(lines[headerLine] ?? '').trim().match(TABLE_ROW_REGEX);
  if (!rowMatch) {
    throw new Error(`行号${headerLine}内容格式校验失败，请检查文件是否为标准markdown表格`);
  }
  return resolveTableColumns(splitTableCells(rowMatch[1]), headerLine);
}

export function pickTestPointFields(
  cells: string[],
  columns: TableColumnMap
): { index: string; testPoint: string; testPointDesc: string } {
  const index = (cells[columns.indexCol] ?? '').trim();
  const testPoint = (cells[columns.testPoint] ?? '').trim();
  const testPointDesc = (cells[columns.testPointDesc] ?? '').trim();
  return { index, testPoint, testPointDesc };
}
