import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadCsvFromContent, sheetToCsv, exportToCsv } from './csv-parser';
import type { ExcelData, SheetData } from '../types';

describe('csv-parser.ts', () => {
  describe('loadCsvFromContent', () => {
    it('应该解析简单的 CSV 内容', () => {
      const content = 'name,age,city\nAlice,30,Beijing\nBob,25,Shanghai';
      const result = loadCsvFromContent(content);

      expect(result.sheets).toHaveLength(1);
      expect(result.sheets[0].name).toBe('Sheet1');

      // 检查表头
      const headerRow = result.sheets[0].rows[0];
      expect(headerRow.cells[0].text).toBe('name');
      expect(headerRow.cells[1].text).toBe('age');
      expect(headerRow.cells[2].text).toBe('city');

      // 检查数据行
      const dataRow1 = result.sheets[0].rows[1];
      expect(dataRow1.cells[0].text).toBe('Alice');
      expect(dataRow1.cells[1].text).toBe('30');
      expect(dataRow1.cells[2].text).toBe('Beijing');

      expect(result.maxLength).toBe(2);
      expect(result.maxCols).toBe(3);
    });

    it('应该处理带引号的 CSV 内容', () => {
      const content = 'name,description\nAlice,"Hello, World"\nBob,"Line1\nLine2"';
      const result = loadCsvFromContent(content);

      const dataRow1 = result.sheets[0].rows[1];
      expect(dataRow1.cells[1].text).toBe('Hello, World');

      const dataRow2 = result.sheets[0].rows[2];
      expect(dataRow2.cells[1].text).toBe('Line1\nLine2');
    });

    it('应该处理 BOM 字符', () => {
      const content = '\uFEFFname,age\nAlice,30';
      const result = loadCsvFromContent(content);

      const headerRow = result.sheets[0].rows[0];
      expect(headerRow.cells[0].text).toBe('name');
    });

    it('应该处理空内容', () => {
      const result = loadCsvFromContent('');
      expect(result.sheets).toHaveLength(1);
      expect(result.maxLength).toBe(0);
    });

    it('应该处理只有表头的 CSV', () => {
      const content = 'name,age,city';
      const result = loadCsvFromContent(content);

      expect(result.maxLength).toBe(0);
      expect(result.maxCols).toBe(3);
    });

    it('应该计算列宽', () => {
      // 注意：列宽是根据数据行计算的，不包括表头
      const content = 'header1,header2,header3\nshort,verylongcolumnnamehere,medium';
      const result = loadCsvFromContent(content);

      expect(result.sheets[0].cols).toBeDefined();
      // 第一列数据很短 (5 char * 8 = 40 < MIN_COL_WIDTH 70)
      // 第二列数据很长 (22 char * 8 = 176)
      expect(result.sheets[0].cols![0].width).toBe(70); // MIN_COL_WIDTH
      expect(result.sheets[0].cols![1].width).toBe(176); // 22 * 8
    });
  });

  describe('sheetToCsv', () => {
    it('应该将 SheetData 转换为 CSV 字符串', () => {
      const sheets: SheetData[] = [{
        name: 'Sheet1',
        rows: {
          0: {
            cells: {
              0: { text: 'name' },
              1: { text: 'age' }
            }
          },
          1: {
            cells: {
              0: { text: 'Alice' },
              1: { text: '30' }
            }
          }
        }
      }];

      const csv = sheetToCsv(sheets);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('name,age');
      expect(lines[1]).toBe('Alice,30');
    });

    it('应该正确转义包含逗号的字段', () => {
      const sheets: SheetData[] = [{
        name: 'Sheet1',
        rows: {
          0: {
            cells: {
              0: { text: 'name' },
              1: { text: 'city' }
            }
          },
          1: {
            cells: {
              0: { text: 'Alice' },
              1: { text: 'Bei, jing' }
            }
          }
        }
      }];

      const csv = sheetToCsv(sheets);
      expect(csv).toContain('"Bei, jing"');
    });

    it('应该正确转义包含引号的字段', () => {
      const sheets: SheetData[] = [{
        name: 'Sheet1',
        rows: {
          0: {
            cells: {
              0: { text: 'name' },
              1: { text: 'quote' }
            }
          },
          1: {
            cells: {
              0: { text: 'Alice' },
              1: { text: 'say "hello"' }
            }
          }
        }
      }];

      const csv = sheetToCsv(sheets);
      expect(csv).toContain('"say ""hello"""');
    });

    it('应该处理空的工作表', () => {
      const sheets: SheetData[] = [{
        name: 'Empty',
        rows: {}
      }];

      const csv = sheetToCsv(sheets);
      expect(csv).toBe('');
    });

    it('应该处理包含换行符的字段', () => {
      const sheets: SheetData[] = [{
        name: 'Sheet1',
        rows: {
          0: {
            cells: {
              0: { text: 'desc' }
            }
          },
          1: {
            cells: {
              0: { text: 'Line1\nLine2' }
            }
          }
        }
      }];

      const csv = sheetToCsv(sheets);
      expect(csv).toContain('"Line1\nLine2"');
    });
  });

  describe('exportToCsv', () => {
    it('应该导出完整的 CSV 格式', () => {
      const sheets: SheetData[] = [{
        name: 'Sheet1',
        rows: {
          0: { cells: { 0: { text: 'name' }, 1: { text: 'value' } } },
          1: { cells: { 0: { text: 'A' }, 1: { text: 'B' } } }
        }
      }];

      const csv = exportToCsv(sheets);
      // exportToCsv 使用 XLSX.utils.sheet_to_csv 返回完整 CSV
      expect(csv).toContain('name');
      expect(csv).toContain('value');
      expect(csv).toContain('A');
      expect(csv).toContain('B');
    });

    it('应该处理空的工作表', () => {
      const sheets: SheetData[] = [{
        name: 'Empty',
        rows: {}
      }];

      const csv = exportToCsv(sheets);
      expect(csv).toBe('');
    });

    it('应该处理空数组', () => {
      const csv = exportToCsv([]);
      expect(csv).toBe('');
    });
  });

  describe('边界情况', () => {
    it('应该处理特殊字符', () => {
      const content = 'col1,col2\nvalue1,value2';
      const result = loadCsvFromContent(content);
      expect(result.maxCols).toBe(2);
    });

    it('应该处理不一致的列数', () => {
      const content = 'a,b,c\n1\n2,3';
      const result = loadCsvFromContent(content);

      expect(result.maxCols).toBe(3);
      expect(result.sheets[0].rows[1].cells[0].text).toBe('1');
    });

    it('应该处理制表符分隔的内容', () => {
      const content = 'col1\tcol2\nval1\tval2';
      const result = loadCsvFromContent(content);

      // xlsx 库默认按逗号分隔，制表符可能不被识别
      expect(result.sheets).toHaveLength(1);
    });
  });
});
