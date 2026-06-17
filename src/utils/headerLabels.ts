/**
 * ============================================================================
 *  utils/headerLabels.ts
 *  表头「英文 key → 中文别名」映射加载工具
 * ----------------------------------------------------------------------------
 *  来源（合并优先级，从低到高）：
 *    1. 插件内置默认值（package.json 的 default 字段，覆盖常见字段如 testcase_id/path/steps 等）
 *    2. 用户设置 `testcaseViewer.headerLabels`
 *    3. 工作区设置 `testcaseViewer.headerLabels`（最高优先级）
 *  以上三层由 VSCode 自动合并，调用 getConfiguration().get() 直接拿到合并后结果。
 *  未配置且不在内置默认中的字段，表头只显示英文 key。
 *
 *  设计原则：
 *    - 中文别名仅用于 webview 表头展示，绝不会写回原始数据文件。
 *    - 配置非法格式时静默降级为空对象，不影响编辑器正常打开。
 *    - 提供 onDidChange 监听，前端可在配置变更时实时刷新表头。
 * ============================================================================
 */
import * as vscode from 'vscode';

const CONFIG_KEY = 'testcaseViewer.headerLabels';

export type HeaderLabels = { [key: string]: string };

/** 读取表头中英映射（默认值 + 用户/工作区设置由 VSCode 自动合并） */
export function getHeaderLabels(): HeaderLabels {
    const merged: HeaderLabels = {};
    try {
        const cfg = vscode.workspace.getConfiguration().get<HeaderLabels>(CONFIG_KEY);
        if (cfg && typeof cfg === 'object') {
            for (const k in cfg) {
                if (Object.prototype.hasOwnProperty.call(cfg, k)) {
                    const v = (cfg as any)[k];
                    if (typeof v === 'string') merged[k] = v;
                }
            }
        }
    } catch { /* ignore */ }
    return merged;
}

/**
 * 监听表头映射变更（仅设置项变更）。
 * 返回 Disposable 数组，调用方负责注册到 context.subscriptions 或 panel.onDidDispose。
 */
export function onHeaderLabelsChange(handler: () => void): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_KEY)) {
                try { handler(); } catch { /* ignore */ }
            }
        })
    );
    return disposables;
}
