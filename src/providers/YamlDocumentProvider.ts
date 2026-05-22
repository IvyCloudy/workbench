import * as vscode from 'vscode';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { loadYamlFromFile, type DetailTableInfo } from '../services/yaml-parser';
import { BaseEditorProvider, PushViaHttpClient, isInQualifiedDir } from './BaseEditorProvider';
import type { TableData, DetailTableData } from '../types';

// 检查YAML文件是否满足目录要求
export function isQualifiedYamlFile(uri: vscode.Uri): boolean {
    return isInQualifiedDir(uri, /\.ya?ml$/i);
}

// 异步解析YAML文件数据
async function parseYamlData(filePath: string): Promise<{ tableData: TableData; sourceData: any }> {
    const data = await loadYamlFromFile(filePath);
    const sheet = data.sheets[0];
    if (!sheet) return { tableData: { headers: [], rows: [] }, sourceData: null };

    const headers: string[] = [];
    const rows: string[][] = [];

    const row0 = sheet.rows[0];
    if (row0) {
        const cellKeys = Object.keys(row0.cells).map(k => parseInt(k)).sort((a, b) => a - b);
        cellKeys.forEach(ci => headers.push(row0.cells[ci]?.text || ''));
    }

    const rowKeys = Object.keys(sheet.rows).map(k => parseInt(k)).sort((a, b) => a - b);
    rowKeys.forEach(ri => {
        if (ri === 0 && headers.length > 0) return;
        const row = sheet.rows[ri];
        if (!row) return;
        const rowData: string[] = [];
        const cellKeys = Object.keys(row.cells).map(k => parseInt(k)).sort((a, b) => a - b);
        cellKeys.forEach(ci => rowData[ci] = row.cells[ci]?.text || '');
        while (rowData.length < headers.length) rowData.push('');
        rows.push(rowData);
    });

    // 构建子表数据
    let detailTable: DetailTableData | undefined;
    if (data.detailTable) {
        detailTable = {
            field: data.detailTable.field,
            fieldDisplay: data.detailTable.fieldDisplay,
            headers: data.detailTable.headers,
            rowGroups: data.detailTable.rowGroups,
            rawRowGroups: data.detailTable.rawRowGroups,
        };
    }

    // 使用解析器返回的原始数据，供 saveFile 重建嵌套结构
    // 非数组的顶层对象包装为数组，确保 rowIdx 正确索引到完整对象（而非丢失 detailField 字段）
    let sourceData: any = data.sourceData;
    if (!Array.isArray(sourceData) && typeof sourceData === 'object' && sourceData !== null) {
        sourceData = [sourceData];
    }

    return { tableData: { headers, rows, detailTable }, sourceData };
}

// JSON 字符串转真实类型（用于回写时还原数组和对象）
function parseCellValue(val: string): any {
    if (!val) return '';
    if (val.startsWith('[') || val.startsWith('{')) {
        try { return JSON.parse(val); } catch { return val; }
    }
    return val;
}

// YAML 自定义编辑器 Provider
export class YamlEditorProvider extends BaseEditorProvider {
    protected pushStrategy = new PushViaHttpClient();
    private originalSourceData: any = null;
    private detailFieldName: string | null = null;

    protected getTypeName(): string { return 'YAML'; }
    protected getDataType(): 'yaml' | 'json' | 'csv' { return 'yaml'; }
    protected getOpenCommand(): string { return 'yamlEditor.openWithFile'; }
    protected getErrorMessage(): string {
        return '该文件不在允许的目录下，仅支持：<br>测试任务/xxx/输入文档/测试案例/*.yaml 或 *.yml';
    }

    protected isQualifiedFile(uri: vscode.Uri): boolean {
        return isQualifiedYamlFile(uri);
    }

    protected async parseData(filePath: string): Promise<TableData> {
        const result = await parseYamlData(filePath);
        this.originalSourceData = result.sourceData;
        this.detailFieldName = result.tableData.detailTable?.field || null;
        return result.tableData;
    }

    protected async saveFile(filePath: string, data: TableData): Promise<void> {
        if (!data) throw new Error('没有数据可保存');
        const { headers, rows, detailTable } = data;

        // 有子表数据时：非子表字段用 cell 值，子表字段尝试还原原始结构
        const detailField = detailTable?.field || this.detailFieldName;

        const records: any[] = rows.map((row, rowIdx) => {
            const record: any = {};
            headers.forEach((h, i) => {
                if (h === detailField && this.originalSourceData && detailTable?.rowGroups) {
                    // 有子表数据时：基于原始数据或编辑数据重建
                    const editedRows: string[][] = detailTable.rowGroups[rowIdx] || [];
                    if (editedRows.length > 0) {
                        const origDetailData = rowIdx < this.originalSourceData.length
                            ? this.originalSourceData[rowIdx]?.[h] : null;
                        const rawRows: any[] = Array.isArray(origDetailData) ? origDetailData : [];
                        const reconstructed: any[] = [];

                        for (let di = 0; di < editedRows.length; di++) {
                            const src: any = (di < rawRows.length && typeof rawRows[di] === 'object')
                                ? { ...rawRows[di] } : {};
                            detailTable.headers.forEach((dh, ci) => {
                                const edited = editedRows[di]?.[ci];
                                if (edited !== undefined) {
                                    const origRaw = rawRows[di]?.[dh];
                                    if (Array.isArray(origRaw)) {
                                        src[dh] = edited ? edited.split('; ').map((s: string) => s.trim()).filter(Boolean) : [];
                                    } else if (origRaw !== undefined && typeof origRaw === 'boolean') {
                                        src[dh] = edited === 'true';
                                    } else if (origRaw !== undefined && typeof origRaw === 'number') {
                                        src[dh] = Number(edited) || 0;
                                    } else {
                                        src[dh] = parseCellValue(edited);
                                    }
                                }
                            });
                            reconstructed.push(src);
                        }
                        record[h] = reconstructed;
                    } else {
                        record[h] = this.originalSourceData[rowIdx]?.[h] ?? parseCellValue(row[i]);
                    }
                } else if (h === detailField && !detailTable?.rowGroups && this.originalSourceData && rowIdx < this.originalSourceData.length) {
                    record[h] = this.originalSourceData[rowIdx]?.[h] ?? parseCellValue(row[i]);
                } else {
                    record[h] = parseCellValue(row[i]);
                }
            });
            return record;
        });

        const yamlContent = YAML.stringify(records.length === 1 ? records[0] : records);
        await fs.promises.writeFile(filePath, yamlContent, 'utf-8');
    }
}
