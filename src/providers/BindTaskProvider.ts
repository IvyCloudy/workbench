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
import { getAllBoundItems, getAllBoundFolderPaths, clearBindingsCache, type CurrentTask } from '../utils/taskInfoStore';
import {
    getAllBoundFilePaths as getAllPointCaseBoundFiles,
    getWorkspaceRoots as getPCBWorkspaceRoots,
    getStoreFilePath as getPCBStorePath,
    clearCache as clearPointCaseBindingCache,
    isPathBound as isPointCaseBound,
    getBoundCasesOfPoint,
    getBoundPointsOfCase,
    getGlobalBoundFileMap,
    invalidateGlobalBoundFileMap,
    loadBindings as loadPCBBindings,
    findWorkspaceRootFor as findPCBRoot,
    toRelPath as toPCBRelPath,
} from '../utils/pointCaseBindingStore';
import { TelemetryService } from '../utils/telemetry';

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

/** 获取当前工作区根目录列表 */
function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map(f => f.uri.fsPath.replace(/\\/g, '/'));
}

/**
 * 过滤绑定项，只保留 rootPath 位于当前工作区内的项。
 * 若无工作区或 rootPath 不在任何工作区内，则排除该项。
 */
function filterBoundItemsByWorkspace(items: CurrentTask[]): CurrentTask[] {
    const roots = getWorkspaceRoots();
    if (roots.length === 0) return items; // 无工作区时不过滤
    return items.filter(item => {
        if (!item.taskInfo || !item.taskInfo.rootPath) return false;
        const itemRoot = item.taskInfo.rootPath.replace(/\\/g, '/');
        return roots.some(r => itemRoot.startsWith(r + '/') || itemRoot === r);
    });
}

// ============================================
// 任务文件夹装饰器（资源管理器图标覆盖）
// ============================================

class TaskFolderDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onDidChange.event;

    /** 通知装饰器刷新（绑定文件变更时调用） */
    refresh() {
        // 变更时强制失效 O(1) 缓存，让下次 provideFileDecoration 拿到最新
        invalidateGlobalBoundFileMap();
        this._onDidChange.fire([]);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const fsPath = uri.fsPath;
        if (!fsPath) return undefined;

        const fsPathNorm = fsPath.replace(/\\/g, '/');

        // ---- (A) 优先：point ↔ case 文件级绑定标记（O(1) 查表，5s TTL 缓存） ----
        try {
            const map = getGlobalBoundFileMap();
            const meta = map.get(fsPathNorm);
            if (meta) {
                if (meta.role === 'point') {
                    return {
                        badge: '🔗',
                        color: new vscode.ThemeColor('charts.green'),
                        tooltip: `已绑定测试案例：${meta.boundToName}`,
                    };
                } else {
                    return {
                        badge: '🔗',
                        color: new vscode.ThemeColor('charts.green'),
                        tooltip: `已绑定测试要点：${meta.boundToName}`,
                    };
                }
            }
        } catch (_) { /* ignore */ }

        // ---- (B) 原逻辑：任务文件夹徽标 ----
        const boundPaths = getAllBoundFolderPaths(effectiveContext!);
        // 只保留当前工作区内的绑定路径
        const roots = getWorkspaceRoots();
        const workspaceBoundPaths = roots.length === 0
            ? boundPaths
            : boundPaths.filter(bp => roots.some(r => bp.startsWith(r + '/') || bp === r));

        // 找到 exact 匹配的绑定文件夹路径
        let matchedPath = '';
        for (const bp of workspaceBoundPaths) {
            if (fsPathNorm === bp) {
                matchedPath = bp;
                break;
            }
        }

        if (!matchedPath) return undefined;

        // 只有当前 URI 就是绑定子任务文件夹本身时才着色
        const isExactTaskFolder = fsPathNorm === matchedPath;

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
        const items = filterBoundItemsByWorkspace(getAllBoundItems(effectiveContext!));
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
// 「测试要点↔案例 绑定」总览 TreeView
// ============================================

class PointCaseBindingsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    refresh() { this._onDidChange.fire(); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        // 顶级：列出所有 point，二级：其绑定的 case
        const roots = getPCBWorkspaceRoots();
        if (roots.length === 0) return [];

        if (!element) {
            // 顶级：遍历所有 workspace root 里的 bindings
            const items: vscode.TreeItem[] = [];
            for (const root of roots) {
                const data = loadPCBBindings(root);
                for (const b of data.bindings) {
                    if (!b.point || b.cases.length === 0) continue;
                    const pointAbs = path.join(root, b.point);
                    const label = `📄 ${path.basename(b.point)}`;
                    const ti = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
                    ti.description = b.point;
                    ti.tooltip = `测试要点\n${pointAbs}`;
                    ti.contextValue = 'pcbPoint';
                    ti.resourceUri = vscode.Uri.file(pointAbs);
                    (ti as any)._pcbRoot = root;
                    (ti as any)._pcbBinding = b;
                    ti.command = {
                        command: 'testcaseViewer.pcb.revealFile',
                        title: '定位',
                        arguments: [pointAbs],
                    };
                    items.push(ti);
                }
            }
            if (items.length === 0) {
                const empty = new vscode.TreeItem('（暂无绑定关系）', vscode.TreeItemCollapsibleState.None);
                empty.tooltip = '在测试大纲的 md/xmind 或测试案例的 csv/yaml/json 上右键即可创建绑定';
                return [empty];
            }
            return items;
        }

        // 二级：point 的 case
        const b = (element as any)._pcbBinding;
        const root = (element as any)._pcbRoot;
        if (!b || !root) return [];
        return (b.cases || []).map((caseRel: string) => {
            const caseAbs = path.join(root, caseRel);
            const child = new vscode.TreeItem(`📎 ${path.basename(caseRel)}`, vscode.TreeItemCollapsibleState.None);
            child.description = caseRel;
            child.tooltip = `测试案例\n${caseAbs}`;
            child.contextValue = 'pcbCase';
            child.resourceUri = vscode.Uri.file(caseAbs);
            child.command = {
                command: 'testcaseViewer.pcb.revealFile',
                title: '定位',
                arguments: [caseAbs],
            };
            return child;
        });
    }
}

const pointCaseBindingsTreeProvider = new PointCaseBindingsTreeProvider();

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
                TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.revealBoundTask', execResult: 'folderNotExist' });
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

            await vscode.commands.executeCommand('revealInExplorer', targetUri);

            console.log('[revealBoundTask] done');
            TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.revealBoundTask' });
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

    // 3b. 「测试要点↔案例 绑定」总览 TreeView
    const pcbTreeView = vscode.window.createTreeView('pointCaseBindings', {
        treeDataProvider: pointCaseBindingsTreeProvider,
    });
    disposables.push(pcbTreeView);
    disposables.push(
        pcbTreeView.onDidChangeVisibility(e => {
            if (e.visible) {
                clearPointCaseBindingCache();
                pointCaseBindingsTreeProvider.refresh();
            }
        })
    );
    // 定位命令（用于 TreeView 单击）
    disposables.push(
        vscode.commands.registerCommand('testcaseViewer.pcb.revealFile', async (absPath: string) => {
            if (!absPath) return;
            try {
                await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absPath));
                TelemetryService.sendTelemetryEvent('command.executed', {
                    command: 'testcaseViewer.pcb.revealFile',
                });
            } catch (err: any) {
                TelemetryService.sendTelemetryErrorEvent('pcb.revealFile.error', {
                    errorMessage: String(err?.message || err).slice(0, 500),
                });
            }
        })
    );

    // 4. 监听绑定文件变更，自动刷新装饰器 + TreeView
    disposables.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const p = doc.uri.fsPath.replace(/\\/g, '/');
            if (p.includes('task-bindings.json')) {
                TelemetryService.sendTelemetryEvent('bindings.fileChanged', {});
                clearBindingsCache(); // 强制清除缓存，确保读到最新数据
                taskFolderDecorationProvider.refresh();
                bindTasksTreeProvider.refresh();
            } else if (p.endsWith('/.plugin/.tms/point-case-bindings.json')) {
                TelemetryService.sendTelemetryEvent('pointCaseBindings.fileChanged', {});
                clearPointCaseBindingCache();
                taskFolderDecorationProvider.refresh();
                pointCaseBindingsTreeProvider.refresh();
            }
        })
    );

    // 5. 监听 point-case 绑定文件的外部改动（非文本编辑器保存路径，例如 fs 直接写）
    try {
        const pcbWatcher = vscode.workspace.createFileSystemWatcher('**/.plugin/.tms/point-case-bindings.json');
        const onChange = () => {
            clearPointCaseBindingCache();
            taskFolderDecorationProvider.refresh();
            pointCaseBindingsTreeProvider.refresh();
        };
        pcbWatcher.onDidChange(onChange);
        pcbWatcher.onDidCreate(onChange);
        pcbWatcher.onDidDelete(onChange);
        disposables.push(pcbWatcher);
    } catch (_) { /* ignore */ }

    // 初始刷新（绑定文件已就绪）
    taskFolderDecorationProvider.refresh();

    return disposables;
}

// ============================================
// 对外：供 BindDialogProvider 在保存后触发装饰器与 TreeView 刷新
// ============================================

export function refreshBindDecorations(): void {
    try {
        clearPointCaseBindingCache();
        taskFolderDecorationProvider.refresh();
        bindTasksTreeProvider.refresh();
        pointCaseBindingsTreeProvider.refresh();
    } catch (_) { /* ignore */ }
}
