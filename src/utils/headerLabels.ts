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
const REVERSE_CONFIG_KEY = 'testcaseViewer.headerReverseLabels';

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
 * 从插件配置中读取反向映射（中文别名 → 英文 key），用于推送时将中文表头还原为英文字段名。
 *
 * 映射来源（合并优先级，从低到高）：
 *   1. 从 headerLabels 正向表自动反转生成（兜底，非精确）。
 *   2. 插件内置默认值（package.json 中 headerReverseLabels.default）。
 *   3. 用户/工作区通过 headerReverseLabels 显式配置（最高优先级）。
 *
 * 步骤 2 和 3 由 VSCode 自动合并，调用 getConfiguration().get() 拿到最终结果。
 * 显式配置的 headerReverseLabels 会覆盖自动反转的结果，用户可精确控制每个中文表头的英文字段。
 */
export function getReverseHeaderLabels(): HeaderLabels {
    // 先以 headerLabels 正向表自动反转作为兜底映射
    const forward = getHeaderLabels();
    const reverse: HeaderLabels = {};
    for (const [en, zh] of Object.entries(forward)) {
        if (typeof zh === 'string' && zh.trim() !== '') {
            const existing = reverse[zh];
            if (!existing || (!en.includes('-') && existing.includes('-'))) {
                reverse[zh] = en;
            }
        }
    }
    // 从 headerReverseLabels 配置读取显式反向映射，覆盖自动反转结果
    try {
        const cfg = vscode.workspace.getConfiguration().get<HeaderLabels>(REVERSE_CONFIG_KEY);
        if (cfg && typeof cfg === 'object') {
            for (const k in cfg) {
                if (Object.prototype.hasOwnProperty.call(cfg, k)) {
                    const v = (cfg as any)[k];
                    if (typeof v === 'string') reverse[k] = v;
                }
            }
        }
    } catch { /* ignore */ }
    return reverse;
}

/**
 * 将 push 数据对象的 key 从中文映射回英文。
 * 仅当对象中包含中文 key（即数据文件使用中文表头）时才执行转换。
 *
 * 例外：若行内出现典型「中文 CSV 模板」表头键
 * （案例步骤/案例名称/预期结果/路径/前置条件/案例类型/描述/优先级），
 * 说明这是 examples/case_example.csv 风格的中文 CSV，
 * 下游 mapChineseRowToCaseItem 会按中文键直接做语义化映射
 * （如「案例步骤」→ description 数组、「预期结果」→ expected 数组），
 * 该映射与 headerReverseLabels 的简单 key 改名语义并不一致
 * （如「案例步骤」反向映射成 description 字符串会与「描述」语义重叠，
 * 且让 mapper 误判中文分支后取不到值），
 * 因此这里直接保留原始中文键，跳过反向映射，交由 mapper 处理。
 */
const CSV_ZH_HEADER_KEYS = ['案例步骤', '案例名称', '预期结果', '路径', '前置条件', '案例类型', '描述', '优先级'];

export function normalizePushData(data: any[]): any[] {
    if (!Array.isArray(data) || data.length === 0) return data;
    // 快速判断：首行是否有中文 key
    const first = data[0];
    if (!first || typeof first !== 'object') return data;
    const keys = Object.keys(first);
    const hasChineseKey = keys.some(k => /[\u4e00-\u9fff]/.test(k));
    if (!hasChineseKey) return data;

    // 中文 CSV 模板行：原样返回，由 mapChineseRowToCaseItem 处理
    const isChineseCsvRow = keys.some(k => CSV_ZH_HEADER_KEYS.includes(k));
    if (isChineseCsvRow) return data;

    const reverse = getReverseHeaderLabels();
    return data.map((rec: any) => {
        if (!rec || typeof rec !== 'object') return rec;
        const mapped: any = {};
        for (const [k, v] of Object.entries(rec)) {
            const en = reverse[k] || k;
            mapped[en] = v;
        }
        return mapped;
    });
}

/**
 * 监听表头映射变更（仅设置项变更）。
 * 返回 Disposable 数组，调用方负责注册到 context.subscriptions 或 panel.onDidDispose。
 */
export function onHeaderLabelsChange(handler: () => void): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_KEY) || e.affectsConfiguration(REVERSE_CONFIG_KEY)) {
                try { handler(); } catch { /* ignore */ }
            }
        })
    );
    return disposables;
}
