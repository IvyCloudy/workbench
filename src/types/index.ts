import * as vscode from 'vscode';

// ============================================
// 表格数据类型
// ============================================

export interface TableData {
    headers: string[];
    rows: string[][];
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
