/**
 * ============================================================================
 *  utils/fileIdentifier.ts
 *  文件标识工具：检测文件是否通过"新增测试案例"命令创建
 * ----------------------------------------------------------------------------
 *  新方案：使用 .vscode/testcase-viewer/created-files.json 记录
 *  
 *  优点：
 *    1. 完全不影响原文件内容和解析逻辑
 *    2. 兼容性好，不需要处理前置元数据
 *    3. 简单可靠，易于维护
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 记录文件的相对路径（相对于工作区根目录）
const RECORD_DIR = '.vscode/testcase-viewer';
const RECORD_FILE = 'created-files.json';

/**
 * 获取记录文件的完整路径
 */
function getRecordFilePath(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    return path.join(workspaceRoot, RECORD_DIR, RECORD_FILE);
}

/**
 * 读取记录文件
 */
function readRecordFile(): Record<string, { createdAt: string; version: string }> {
    const recordFilePath = getRecordFilePath();
    if (!recordFilePath || !fs.existsSync(recordFilePath)) {
        return {};
    }
    
    try {
        const content = fs.readFileSync(recordFilePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return {};
    }
}

/**
 * 写入记录文件
 */
function writeRecordFile(records: Record<string, { createdAt: string; version: string }>): void {
    const recordFilePath = getRecordFilePath();
    if (!recordFilePath) {
        return;
    }
    
    // 确保目录存在
    const recordDir = path.dirname(recordFilePath);
    if (!fs.existsSync(recordDir)) {
        fs.mkdirSync(recordDir, { recursive: true });
    }
    
    fs.writeFileSync(recordFilePath, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * 标记文件为通过命令创建
 * @param filePath 文件路径
 */
export function markAsCreatedByCommand(filePath: string): void {
    const records = readRecordFile();
    records[filePath] = {
        createdAt: new Date().toISOString(),
        version: '1.0'
    };
    writeRecordFile(records);
}

/**
 * 移除文件的命令创建标记
 * @param filePath 文件路径
 */
export function unmarkAsCreatedByCommand(filePath: string): void {
    const records = readRecordFile();
    if (records[filePath]) {
        delete records[filePath];
        writeRecordFile(records);
    }
}

/**
 * 检测文件是否通过"新增测试案例"命令创建
 * @param filePath 文件路径
 * @returns 是否通过命令创建
 */
export function isCreatedByCommand(filePath: string): boolean {
    const records = readRecordFile();
    return !!records[filePath];
}

/**
 * 获取文件的创建信息
 * @param filePath 文件路径
 * @returns 创建信息对象，如果文件不是通过命令创建则返回 null
 */
export function getFileCreationInfo(filePath: string): { createdAt: string; version: string } | null {
    const records = readRecordFile();
    return records[filePath] || null;
}

/**
 * 清理已不存在的文件的记录
 */
export function cleanupRecords(): void {
    const records = readRecordFile();
    const existingRecords: Record<string, { createdAt: string; version: string }> = {};
    
    for (const filePath of Object.keys(records)) {
        if (fs.existsSync(filePath)) {
            existingRecords[filePath] = records[filePath];
        }
    }
    
    writeRecordFile(existingRecords);
}

/**
 * 为通过命令创建的文件添加装饰器（在编辑器左侧显示图标）
 * @param editor 文本编辑器
 */
export function addCommandCreatedDecoration(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    
    if (!isCreatedByCommand(filePath)) {
        return;
    }
    
    // 创建装饰器类型
    const decorationType = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '📝 ',
            color: '#4CAF50',
            fontWeight: 'bold'
        }
    });
    
    // 在第一行添加装饰器
    const range = new vscode.Range(0, 0, 0, 0);
    const decorations = [{ range }];
    
    editor.setDecorations(decorationType, decorations);
}

/**
 * 在状态栏显示文件创建信息
 * @param filePath 文件路径
 * @returns 状态栏项
 */
export function showCreationInfoInStatusBar(filePath: string): vscode.StatusBarItem | undefined {
    const info = getFileCreationInfo(filePath);
    
    if (!info) {
        return undefined;
    }
    
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = `$(symbol-method) 通过命令创建`;
    statusBarItem.tooltip = `创建方式: 测试案例命令创建\n创建时间: ${info.createdAt || '未知'}\n版本: ${info.version || '1.0'}`;
    statusBarItem.show();
    
    return statusBarItem;
}
