/**
 * ============================================================================
 *  BindTaskProvider.ts
 *  绑定任务相关功能（从 extension.ts 拆分）
 * ----------------------------------------------------------------------------
 *  包含：
 *    1. TaskFolderDecorationProvider  —— 资源管理器文件图标装饰（🔗 + 蓝色）
 *    2. BindTasksTreeProvider          ——"已绑定任务"侧边栏面板
 *    3. revealBoundTask 命令           —— 点击面板跳转并展开目标文件夹
 *    4. 绑定文件监听 + 自动刷新
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getAllBoundItems, getAllBoundFolderPaths, clearBindingsCache } from '../utils/taskInfoStore';
import { sendTelemetryEvent, sendTelemetryException } from '../services/telemetry';
import { stackHead } from '../services/utils';

// ============================================
// 全局上下文引用
// ============================================

let effectiveContext: vscode.ExtensionContext | undefined;

// ============================================
// 工具方法
// ============================================

/** 递归查找目录内任意文件 */
function findAnyFileInDir(dirPath: string): string | undefined {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const childPath = path.join(dirPath, entry.name);
            if (entry.isFile()) return childPath;
            if (entry.isDirectory()) {
                const found = findAnyFileInDir(childPath);
                if (found) return found;
            }
        }
    } catch (_) { /* ignore */ }
    return undefined;
}

// ============================================
// 任务文件夹装饰器（资源管理器图标覆盖）
// ============================================

class TaskFolderDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onDidChange.event;

    /** 通知装饰器刷新（绑定文件变更时调用） */
    refresh() {
        this._onDidChange.fire([]);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const fsPath = uri.fsPath;
        if (!fsPath) return undefined;

        const boundPaths = getAllBoundFolderPaths(effectiveContext!);        const fsPathNorm = fsPath.replace(/\\/g, '/');

        // 找到 exaxt 匹配的绑定文件夹路径
        let matchedPath = '';
        for (const bp of boundPaths) {
            if (fsPathNorm === bp) {
                matchedPath = bp;
                break;
            }
        }

        if (!matchedPath) return undefined;

        // 只有当前 URI 就是绑定子任务文件夹本身时才着色
        const isExactTaskFolder = fsPathNorm === matchedPath;

        console.log('[Decorator] uri=', fsPath, 'isExact=', isExactTaskFolder);

        return {
            badge: '🔗',
            color: isExactTaskFolder ? new vscode.ThemeColor('charts.blue') : undefined,
            tooltip: '已绑定测试任务',
        };
    }
}

const taskFolderDecorationProvider = new TaskFolderDecorationProvider();

// ============================================
// 已绑定任务 TreeView（Explorer 侧边栏底部面板）
// ============================================

class BindTasksTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    refresh() {
        this._onDidChange.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const items = getAllBoundItems(effectiveContext!);
        return items.map(entry => {
            const info = entry.taskInfo!;
            const testTaskName = info.testTaskName || '';
            const subTestTaskName = info.subTestTaskName || '';
            // childPath 格式：测试任务/${任务文件名}，取第二段
            const parts = (info.childPath || '').split('/');
            const originalFileName = parts.length >= 2 ? parts[1] : (info.childPath ? path.basename(info.childPath) : '');
            const displayLabel = `🔗 ${originalFileName} ${testTaskName}_${subTestTaskName}`;
            const fullPath = path.join(info.rootPath || '', info.childPath || '');

            const item = new vscode.TreeItem(
                displayLabel,
                vscode.TreeItemCollapsibleState.None
            );
            item.tooltip = `已绑定测试任务: ${originalFileName}\n路径: ${fullPath}`;
            if (fullPath) {
                item.command = {
                    command: 'testcaseViewer.revealBoundTask',
                    title: '定位文件夹',
                    arguments: [fullPath],
                };
            }
            return item;
        });
    }
}

const bindTasksTreeProvider = new BindTasksTreeProvider();

// ============================================
// revealBoundTask 命令（点击面板跳转并展开）
// ============================================

function registerRevealBoundTaskCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(
        'testcaseViewer.revealBoundTask',
        async (fullPath: string) => {
            console.log('[revealBoundTask] start, fullPath=', fullPath);
            if (!fullPath) return;

            let folderExists = false;
            try { folderExists = fs.existsSync(fullPath); } catch (_) { /* ignore */ }
            if (!folderExists) {
                sendTelemetryEvent('command.executed', { command: 'testcaseViewer.revealBoundTask', execResult: 'folderNotExist' });
                vscode.window.showWarningMessage(
                    `文件夹不存在，请检查 task-bindings.json 中的路径配置:\n${fullPath}`
                );
                return;
            }

            // 找到文件夹内任意文件，用 revealInExplorer 展开（不打开编辑器，无闪烁）
            const fileToReveal = findAnyFileInDir(fullPath);
            const targetUri = fileToReveal
                ? vscode.Uri.file(fileToReveal)
                : vscode.Uri.file(fullPath);

            await vscode.commands.executeCommand('workbench.view.explorer');
            await new Promise(r => setTimeout(r, 300));
            await vscode.commands.executeCommand('revealInExplorer', targetUri);

            console.log('[revealBoundTask] done');
            sendTelemetryEvent('command.executed', { command: 'testcaseViewer.revealBoundTask' });
        }
    );
}

// ============================================
// 统一注册入口（供 extension.ts 调用）
// ============================================

/**
 * 注册绑定任务相关的所有功能：
 *   - 文件夹装饰器
 *   - "已绑定任务" TreeView
 *   - revealBoundTask 命令
 *   - 绑定文件监听（自动刷新）
 *
 * 返回的 Disposable 列表需 push 到 context.subscriptions。
 */
export function registerBindTaskFeatures(context: vscode.ExtensionContext): vscode.Disposable[] {
    effectiveContext = context;

    const disposables: vscode.Disposable[] = [];

    // 1. 文件夹装饰器
    disposables.push(
        vscode.window.registerFileDecorationProvider(taskFolderDecorationProvider)
    );

    // 2. "已绑定任务" TreeView —— 使用 createTreeView 以便监听显隐事件
    const bindTaskTreeView = vscode.window.createTreeView('boundTasks', {
        treeDataProvider: bindTasksTreeProvider,
    });
    disposables.push(bindTaskTreeView);
    // 视图变为可见时自动刷新（打开资源管理器/切换回 Explorer 时触发）
    disposables.push(
        bindTaskTreeView.onDidChangeVisibility(e => {
            if (e.visible) {
                bindTasksTreeProvider.refresh();
                taskFolderDecorationProvider.refresh();
            }
        })
    );

    // 3. revealBoundTask 命令
    disposables.push(registerRevealBoundTaskCommand());

    // 4. 监听绑定文件变更，自动刷新装饰器 + TreeView
    disposables.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.uri.fsPath.includes('task-bindings.json')) {
                sendTelemetryEvent('bindings.fileChanged', {});
                clearBindingsCache(); // 强制清除缓存，确保读到最新数据
                taskFolderDecorationProvider.refresh();
                bindTasksTreeProvider.refresh();
            }
        })
    );

    // 初始刷新（绑定文件已就绪）
    taskFolderDecorationProvider.refresh();

    return disposables;
}
