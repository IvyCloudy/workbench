/**
 * ============================================================================
 *  BindStatusBarProvider.ts
 *  状态栏「跳转到已绑定文件」按钮
 * ----------------------------------------------------------------------------
 *  当活动编辑器打开的文件已参与 point ⇄ case 绑定时，
 *  在窗口底部状态栏显示一个可点击按钮：
 *    - 若当前文件为「测试要点」(md/xmind)  → 显示 "$(arrow-right) 跳转到已绑定的测试案例"
 *    - 若当前文件为「测试案例」(csv/yaml/json) → 显示 "$(arrow-right) 跳转到已绑定的测试要点"
 *    - 若当前文件未绑定或未打开合适类型的文件 → 隐藏
 *
 *  设计目标：
 *    - 侵入面尽可能小：不修改 package.json、不修改现有 BindTaskProvider
 *    - 复用已有命令：testcaseViewer.jumpToBoundCase / testcaseViewer.jumpToBoundPoint
 * ============================================================================
 */

import * as vscode from 'vscode';
import { getGlobalBoundFileMap } from '../utils/pointCaseBindingStore';

/** 模块内部保存当前注册后的刷新函数，供 `refreshBindStatusBar` 强制触发。 */
let currentUpdater: (() => void) | undefined;

/**
 * 注册状态栏「跳转」按钮，返回可释放资源列表。
 * 调用方（extension.ts）需将结果 push 到 context.subscriptions。
 */
export function registerBindStatusBar(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // 优先级设一个较大的值，让按钮尽量靠左；alignment 用 Left 更符合导航语义
    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    disposables.push(statusBar);

    /** 依据当前活动编辑器/tab，更新状态栏按钮 */
    const updateStatusBar = () => {
        try {
            // 1) 取当前活动文件路径（兼容自定义编辑器：走 tabGroups）
            let fsPath: string | undefined = vscode.window.activeTextEditor?.document?.uri?.fsPath;
            if (!fsPath) {
                const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
                const input: any = activeTab?.input;
                if (input?.uri?.fsPath) fsPath = input.uri.fsPath;
            }
            if (!fsPath) {
                statusBar.hide();
                return;
            }

            // 2) 查绑定表（O(1) 查表，内部 5s TTL 缓存）
            const norm = fsPath.replace(/\\/g, '/');
            const meta = getGlobalBoundFileMap().get(norm);
            if (!meta) {
                statusBar.hide();
                return;
            }

            // 3) 依据角色配置文案与命令
            if (meta.role === 'point') {
                statusBar.text = '$(arrow-right) 跳转到已绑定的测试案例';
                statusBar.tooltip = `已绑定测试案例：${meta.boundToName}\n点击跳转`;
                statusBar.command = 'testcaseViewer.jumpToBoundCase';
            } else {
                statusBar.text = '$(arrow-right) 跳转到已绑定的测试要点';
                statusBar.tooltip = `已绑定测试要点：${meta.boundToName}\n点击跳转`;
                statusBar.command = 'testcaseViewer.jumpToBoundPoint';
            }
            statusBar.show();
        } catch (_) {
            statusBar.hide();
        }
    };

    // 4) 监听：编辑器切换
    disposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar())
    );
    // 5) 监听：tab 切换（兼容自定义编辑器）
    try {
        disposables.push(
            vscode.window.tabGroups.onDidChangeTabs(() => updateStatusBar())
        );
    } catch (_) { /* 旧版本 API 无该事件时忽略 */ }

    // 6) 监听：绑定文件变更（point-case-bindings.json 保存 / 外部改动）
    disposables.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            const p = doc.uri.fsPath.replace(/\\/g, '/');
            if (p.endsWith('/.plugin/.tms/point-case-bindings.json')) {
                updateStatusBar();
            }
        })
    );
    try {
        const watcher = vscode.workspace.createFileSystemWatcher(
            '**/.plugin/.tms/point-case-bindings.json'
        );
        watcher.onDidChange(() => updateStatusBar());
        watcher.onDidCreate(() => updateStatusBar());
        watcher.onDidDelete(() => updateStatusBar());
        disposables.push(watcher);
    } catch (_) { /* ignore */ }

    // 7) 初始刷新一次
    updateStatusBar();

    // 对外暴露强制刷新入口，供 BindDialogProvider 保存后主动触发
    currentUpdater = updateStatusBar;
    disposables.push({ dispose: () => { if (currentUpdater === updateStatusBar) currentUpdater = undefined; } });

    return disposables;
}

/**
 * 供 BindDialogProvider 在保存绑定后主动刷新状态栏。
 * （用户完成绑定后无需切换编辑器，按钮自动出现。）
 */
export function refreshBindStatusBar(): void {
    try {
        if (typeof currentUpdater === 'function') currentUpdater();
    } catch (_) { /* ignore */ }
}
