import * as vscode from 'vscode';

// ============================================
// 表格数据类型
// ============================================

export interface TableData {
    headers: string[];
    rows: string[][];
    detailTable?: DetailTableData;
    /**
     * 多明细字段：每一个顶层嵌套对象/对象数组字段对应一项。
     * 仅支持一层展开：子表单元格内若仍为嵌套结构，会被序列化为 JSON 字符串展示与编辑。
     * 兼容字段：detailTable 仍保留，等同于 detailTables[0]（若存在）。
     */
    detailTables?: DetailTableData[];
}

export interface DetailTableData {
    field: string;
    fieldDisplay: string;
    headers: string[];
    /**
     * 每个主行对应的明细二维数据：
     * - 对象数组：多子行
     * - 嵌套对象：一行子表（headers 为 key 的并集，rowGroups[ri] 长度为 1）
     * - 无明细：空数组
     */
    rowGroups: string[][][];
    rawRowGroups?: any[][][];
    /**
     * 每个主行的原始 detail 类型，长度与主行数一致。
     * - 'array'：原始为对象数组
     * - 'object'：原始为嵌套对象
     * - 'none'：无明细
     */
    rawRowTypes?: ('array' | 'object' | 'none')[];
}

export interface ColWidthInfo {
    width: number;
}

// ============================================
// CSV 数据类型
// ============================================

export interface SheetCell {
    text: string;
    style?: number;
}

export interface SheetRow {
    cells: { [key: number]: SheetCell };
}

export interface SheetData {
    name: string;
    rows: { [key: number]: SheetRow };
    cols?: { [key: string]: ColWidthInfo };
}

export interface ExcelData {
    sheets: SheetData[];
    maxCols: number;
    maxLength: number;
}

// ============================================
// 推送策略接口
// ============================================

export interface PushStrategy {
    push(data: any, filePath: string, webviewPanel: vscode.WebviewPanel, context?: vscode.ExtensionContext): Promise<void>;
}

// ============================================
// 查询参数类型
// ============================================

export interface QueryParams {
    testTaskNo: string;
    subTestTaskName: string;
    testPhaseName: string;
}

export interface QueryOptions extends QueryParams {
    currentPage: number;
    pageSize: number;
    testCaseNo?: string;
    testCaseName?: string;
    testCasePath?: string;
    testCasePriority?: string;
    testType?: string;
    type?: string;
}

// ============================================
// 存储配置类型
// ============================================

export interface AppConfig {
    apiUrl: string;
    authToken: string;
    userId: string;
    userName: string;
    sm2PublicKey: string;
}

// ============================================
// Webview 相关类型
// ============================================

export interface WebviewMessage {
    command?: string;
    type?: string;
    data?: any;
    [key: string]: any;
}

// ============================================
// 文件树类型
// ============================================

export interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
}

// ============================================
// API 返回类型
// ============================================

export interface ApiResponse<T = any> {
    returnCode: string;
    body?: T;
    errorMsg?: string;
    raw?: string;
}