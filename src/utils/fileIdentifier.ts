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
import { sendTelemetryException, sendTelemetryErrorEvent } from '../services/telemetry';
import { stackHead } from '../services/utils';

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
    } catch (err: any) {
        // 读/反序列化失败：记录文件可能损坏或权限异常，会导致样例行识别失效，需上报便于排查
        sendTelemetryException('fileIdentifier.read.failed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
        return {};
    }
}

/**
 * 写入记录文件
 */
function writeRecordFile(records: Record<string, { createdAt: string; version: string }>): void {
    const recordFilePath = getRecordFilePath();
    if (!recordFilePath) {
        sendTelemetryErrorEvent('fileIdentifier.write.noWorkspace', {});
        return;
    }

    try {
        // 确保目录存在
        const recordDir = path.dirname(recordFilePath);
        if (!fs.existsSync(recordDir)) {
            fs.mkdirSync(recordDir, { recursive: true });
        }

        fs.writeFileSync(recordFilePath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err: any) {
        // 写入失败：磁盘只读 / 权限不足 / 工作区不可写。后续样例行将无法被正确识别。
        sendTelemetryException('fileIdentifier.write.failed', {
            errorMessage: String(err?.message || String(err)).slice(0, 500),
            stackHead: stackHead(err),
        });
    }
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

// ============================================================================
// 模板示例行识别（方案 A）
// ----------------------------------------------------------------------------
// 通过"新增测试案例"命令创建的文件，会内置一行模板示例数据，用于展示表格
// 字段结构。这条数据本身没有业务含义，不应作为最终推送数据上报后端。
//
// 判定规则（同时满足才视为示例行，避免误伤）：
//   1. 文件必须是通过命令创建（isCreatedByCommand === true）
//   2. 行的 testcase_id 等于占位文案 `案例唯一标识，不可修改`
//      —— 用户一旦修改 testcase_id（实际编辑后会自动生成 UUID），
//        即视为真实数据，恢复正常推送。
// ============================================================================

/** 测试案例 id 列名（与 services/utils.ts 中 TS_ID_COLUMN 保持一致） */
const TS_ID_COLUMN = 'testcase_id';

/** 模板示例行的 testcase_id 占位文案（与 case_example.yaml 模板保持一致） */
export const TEMPLATE_EXAMPLE_TS_ID = '案例唯一标识，不可修改';

/**
 * 判断给定行记录是否为模板示例行。
 * @param record 单条测试案例记录（对象形式）
 */
export function isTemplateExampleRow(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    const tsId = record[TS_ID_COLUMN];
    if (tsId == null) return false;
    return String(tsId).trim() === TEMPLATE_EXAMPLE_TS_ID;
}

/**
 * 过滤推送数据中的模板示例行。
 * 仅当文件由命令创建时才执行过滤；非命令创建的文件原样返回。
 * @param filePath 文件绝对路径
 * @param rows 待推送的记录数组
 * @returns 过滤后的记录数组
 */
export function filterTemplateExampleRows<T = any>(filePath: string, rows: T[]): T[] {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    if (!isCreatedByCommand(filePath)) return rows;
    return rows.filter(rec => !isTemplateExampleRow(rec));
}

/**
 * 收集模板示例行的 testcase_id 集合，便于把它们一并写入推送快照基线，
 * 避免 diffPushSnapshot 把"未参与推送"的样例行误判为新增行（高亮绿色）。
 * 仅当文件由命令创建时返回非空集合。
 *
 * @param filePath  文件绝对路径
 * @param tableData 当前文件解析得到的 tableData（提供 headers + rows）
 */
export function getTemplateExampleTsIds(
    filePath: string,
    tableData: { headers: string[]; rows: any[][] } | null | undefined,
): Set<string> {
    const result = new Set<string>();
    if (!tableData || !isCreatedByCommand(filePath)) return result;
    const headers = tableData.headers || [];
    const rows = tableData.rows || [];
    const tsIdx = headers.indexOf(TS_ID_COLUMN);
    if (tsIdx < 0) return result;
    for (const row of rows) {
        const id = row && row[tsIdx] != null ? String(row[tsIdx]) : '';
        if (id && id.trim() === TEMPLATE_EXAMPLE_TS_ID) {
            result.add(id);
        }
    }
    return result;
}