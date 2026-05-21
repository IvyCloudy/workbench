import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkbenchProvider } from './providers/WorkbenchProvider';
import { TableBrowserProvider } from './providers/TableBrowserProvider';
import { CsvEditorProvider, isQualifiedCsvFile } from './providers/CsvDocumentProvider';
import { YamlEditorProvider, isQualifiedYamlFile } from './providers/YamlDocumentProvider';
import { JsonEditorProvider, isQualifiedJsonFile } from './providers/JsonDocumentProvider';
import { isInQualifiedDir, FILE_PATTERNS } from './services/utils';
import { pushTestCase } from './services/http-client';

function getTabUri(input: any): vscode.Uri | undefined {
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.original;
    return;
}

function getActiveFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return;
    return getTabUri(tab.input);
}

function isTestCaseFile(uri: vscode.Uri): boolean {
    return isQualifiedCsvFile(uri) || isQualifiedYamlFile(uri) || isQualifiedJsonFile(uri);
}

function updateShowIcon(): void {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}

const processingFiles = new Set<string>();
// 记录用户主动用 TextEditor 打开的文件路径
// 一旦用户主动用 TextEditor 打开，当前会话中不再自动切换回插件
const userOpenedAsTextFiles = new Set<string>();

export function markUserOpenedAsText(fsPath: string): void {
    userOpenedAsTextFiles.add(fsPath);
}

export function isUserOpenedAsText(uri: vscode.Uri): boolean {
    return userOpenedAsTextFiles.has(uri.fsPath);
}

async function closeTabForUri(uri: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
        const tab = group.tabs.find(t => {
            const tabUri = getTabUri(t.input);
            return tabUri?.fsPath === uri.fsPath;
        });
        if (tab) {
            await vscode.window.tabGroups.close(tab);
            return;
        }
    }
}

async function openWithEditor(uri: vscode.Uri, viewType: string): Promise<void> {
    const fsPath = uri.fsPath;
    if (processingFiles.has(fsPath)) return;
    processingFiles.add(fsPath);

    try {
        // 等待文本标签关闭完成，再打开自定义编辑器，避免 VS Code 的标签替换机制
        await closeTabForUri(uri);
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        await vscode.commands.executeCommand('workbench.action.keepEditor');
    } catch (e) {
        console.error(`[${viewType}拦截] 切换编辑器失败:`, e);
        vscode.window.showErrorMessage(`切换编辑器失败: ${e}`);
    } finally {
        processingFiles.delete(fsPath);
    }
}

function parseCsvLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function detectDelimiter(line: string): string {
    const delimiters = [',', ';', '\t', '|'];
    const counts = delimiters.map(d => ({ delim: d, count: (line.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length }));
    const best = counts.filter(c => c.count >= 2).sort((a, b) => b.count - a.count)[0];
    return best ? best.delim : ',';
}

async function parseFileToPushData(filePath: string, ext: string): Promise<Record<string, string>[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8');

    if (ext === '.csv') {
        const lines = content.split('\n').filter((l: string) => l.trim());
        if (lines.length < 2) return [];
        const delimiter = detectDelimiter(lines[0]);
        const headers = parseCsvLine(lines[0], delimiter);
        return lines.slice(1).map(line => {
            const values = parseCsvLine(line, delimiter);
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => { obj[h] = values[i] || ''; });
            return obj;
        });
    }

    if (ext === '.yaml' || ext === '.yml') {
        const YAML = require('yaml');
        const parsed = YAML.parse(content);
        const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        return arr.map((item: any) => {
            const obj: Record<string, string> = {};
            for (const key of Object.keys(item || {})) {
                obj[key] = String(item[key] ?? '');
            }
            return obj;
        });
    }

    if (ext === '.json') {
        const parsed = JSON.parse(content);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr.map((item: any) => {
            const obj: Record<string, string> = {};
            for (const key of Object.keys(item || {})) {
                obj[key] = String(item[key] ?? '');
            }
            return obj;
        });
    }

    return [];
}

export async function activate(context: vscode.ExtensionContext) {
    const workbenchProvider = new WorkbenchProvider(context.extensionUri, context);
    const tableBrowserProvider = new TableBrowserProvider(context.extensionUri, context);
    const csvEditorProvider = new CsvEditorProvider(context.extensionUri, context);
    const yamlEditorProvider = new YamlEditorProvider(context.extensionUri, context);
    const jsonEditorProvider = new JsonEditorProvider(context.extensionUri, context);

    // 注册自定义编辑器
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('csvEditor.testCase', csvEditorProvider),
        vscode.window.registerCustomEditorProvider('yamlEditor.testCase', yamlEditorProvider),
        vscode.window.registerCustomEditorProvider('jsonEditor.testCase', jsonEditorProvider)
    );

    // 监听标签页变化
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (e) => {
            // 标签关闭时清除标记，再次打开时恢复自动切换
            for (const tab of e.closed) {
                const input = tab.input;
                let uri: vscode.Uri | undefined;
                if (input instanceof vscode.TabInputText) uri = input.uri;
                else if (input instanceof vscode.TabInputCustom) uri = input.uri;
                if (uri) {
                    if (/\.csv$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                    if (/\.ya?ml$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                    if (/\.json$/i.test(uri.fsPath)) {
                        userOpenedAsTextFiles.delete(uri.fsPath);
                    }
                    // 清理处理中标记，防止内存泄漏
                    processingFiles.delete(uri.fsPath);
                }
            }
            for (const tab of e.opened) {
                const input = tab.input;
                // 只拦截纯文本编辑器打开的标签，避免循环
                if (!(input instanceof vscode.TabInputText)) continue;
                const uri = input.uri;
                if (uri) {
                    if (isQualifiedCsvFile(uri)) {
                        if (isUserOpenedAsText(uri)) {
                            console.log('[CSV拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[CSV拦截] 标签页打开CSV:', uri.fsPath);
                        await openWithEditor(uri, 'csvEditor.testCase');
                    } else if (isQualifiedYamlFile(uri)) {
                        if (isUserOpenedAsText(uri)) {
                            console.log('[YAML拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[YAML拦截] 标签页打开YAML:', uri.fsPath);
                        await openWithEditor(uri, 'yamlEditor.testCase');
                    } else if (isQualifiedJsonFile(uri)) {
                        if (isUserOpenedAsText(uri)) {
                            console.log('[JSON拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                            continue;
                        }
                        console.log('[JSON拦截] 标签页打开JSON:', uri.fsPath);
                        await openWithEditor(uri, 'jsonEditor.testCase');
                    }
                }
            }
        })
    );

    // 监听活动编辑器变化
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (editor) {
                const uri = editor.document.uri;
                console.log('[编辑器拦截] 活动编辑器变化:', uri.fsPath);
                if (isUserOpenedAsText(uri)) {
                    console.log('[编辑器拦截] 用户主动用TextEditor打开，跳过:', uri.fsPath);
                    updateShowIcon();
                    return;
                }
                if (isQualifiedCsvFile(uri)) {
                    await openWithEditor(uri, 'csvEditor.testCase');
                } else if (isQualifiedYamlFile(uri)) {
                    await openWithEditor(uri, 'yamlEditor.testCase');
                } else if (isQualifiedJsonFile(uri)) {
                    await openWithEditor(uri, 'jsonEditor.testCase');
                }
            }
            updateShowIcon();
        })
    );

    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(updateShowIcon),
        vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
            const uri = getActiveFileUri();
            if (uri) {
                const { TestCaseWebviewProvider } = await import('./providers/TestCaseProvider');
                const testcaseProvider = new TestCaseWebviewProvider(context.extensionUri, context);
                await testcaseProvider.showWebview(uri);
            }
        }),
        vscode.commands.registerCommand('workbench.open', async () => await workbenchProvider.show()),
        vscode.commands.registerCommand('tableBrowser.open', async () => await tableBrowserProvider.show()),
        vscode.commands.registerCommand('csvEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.csv$/i.test(uri.fsPath)) {
                await openWithEditor(uri, 'csvEditor.testCase');
            }
        }),
        vscode.commands.registerCommand('csvEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.csv$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('csvEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('yamlEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.ya?ml$/i.test(uri.fsPath)) {
                await openWithEditor(uri, 'yamlEditor.testCase');
            }
        }),
        vscode.commands.registerCommand('yamlEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.ya?ml$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('yamlEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('jsonEditor.open', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.json$/i.test(uri.fsPath)) {
                await openWithEditor(uri, 'jsonEditor.testCase');
            }
        }),
        vscode.commands.registerCommand('jsonEditor.openWith', async () => {
            const uri = getActiveFileUri();
            if (uri && /\.json$/i.test(uri.fsPath)) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(uri.fsPath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('jsonEditor.openWithFile', async (filePath: string) => {
            if (filePath) {
                // 标记为用户主动用 TextEditor 打开
                markUserOpenedAsText(filePath);
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            }
        }),
        vscode.commands.registerCommand('testcaseViewer.pushTestCaseFromExplorer', async (uri: vscode.Uri, _selected: any, allUris?: vscode.Uri[]) => {
            try {
                const targets = allUris && allUris.length ? allUris : (uri ? [uri] : []);
                for (const target of targets) {
                    const filePath = target.fsPath;
                    const ext = path.extname(filePath).toLowerCase();

                    let isQualified = false;
                    if (ext === '.csv') isQualified = isInQualifiedDir(target, FILE_PATTERNS.CSV);
                    else if (ext === '.yaml' || ext === '.yml') isQualified = isInQualifiedDir(target, FILE_PATTERNS.YAML);
                    else if (ext === '.json') isQualified = isInQualifiedDir(target, FILE_PATTERNS.JSON);
                    if (!isQualified) {
                        vscode.window.showWarningMessage(`文件不在允许的目录下: ${path.basename(filePath)}`);
                        continue;
                    }

                    const rows = await parseFileToPushData(filePath, ext);
                    if (!rows || rows.length === 0) {
                        vscode.window.showWarningMessage(`文件无数据: ${path.basename(filePath)}`);
                        continue;
                    }

                    console.log(`[推送] 文件: ${filePath}, ${rows.length} 行:\n`, JSON.stringify(rows, null, 2));
                    const result = await pushTestCase(rows, context);
                    if (result.returnCode === 'SUC0000') {
                        vscode.window.showInformationMessage(`推送成功: ${path.basename(filePath)} (${rows.length} 行)`);
                    } else {
                        vscode.window.showErrorMessage(`推送失败: ${result.errorMsg || '未知错误'}`);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`推送失败: ${err.message || err}`);
            }
        })
    );

    updateShowIcon();

    // 插件激活时显示工作台
    try {
        await workbenchProvider.show();
    } catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }
}
