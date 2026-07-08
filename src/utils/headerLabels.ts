/**
 * ============================================================================
 *  utils/headerLabels.ts
 *  表头「英文 key → 中文别名」映射加载工具
 * ----------------------------------------------------------------------------
 *  来源（合并优先级，从低到高）：
 *    1. 插件内置默认值（package.json 的 default 字段）
 *    2. 用户设置 `testcaseViewer.headerLabels`
 *    3. 工作区设置 `testcaseViewer.headerLabels`
 *    4. 工作区文件 `.plugin/.tms/headerLabels.json`（最高优先级，{ key: value } 平铺对象）
 *  前三层由 VSCode 自动合并；第 4 层由本模块手动读取并覆盖。
 *  未配置且不在内置默认中的字段，表头只显示英文 key。
 *
 *  设计原则：
 *    - 中文别名仅用于 webview 表头展示，绝不会写回原始数据文件。
 *    - 配置非法格式时静默降级为空对象，不影响编辑器正常打开。
 *    - 监听 VSCode 配置变更 + 文件系统变更，前端可实时刷新表头。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const CONFIG_KEY = 'testcaseViewer.headerLabels';
const REVERSE_CONFIG_KEY = 'testcaseViewer.headerReverseLabels';
const HLABELS_REL_PATH = path.join('.plugin', '.tms', 'headerLabels.json');

export type HeaderLabels = { [key: string]: string };

// ── 辅助：定位/读取 .plugin/.tms/headerLabels.json ──────────────────────────

/** 获取当前工作区 .plugin/.tms/headerLabels.json 的绝对路径（无工作区返回 null） */
function getHeaderLabelsJsonPath(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return path.join(folders[0].uri.fsPath, HLABELS_REL_PATH);
}

/** 从 .plugin/.tms/headerLabels.json 读取 { key: value } 映射（失败返回 {}） */
function readHeaderLabelsJson(): HeaderLabels {
    const result: HeaderLabels = {};
    try {
        const jsonPath = getHeaderLabelsJsonPath();
        if (jsonPath && fs.existsSync(jsonPath)) {
            const raw = fs.readFileSync(jsonPath, 'utf-8');
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') {
                for (const k in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, k)) {
                        const v = (obj as any)[k];
                        if (typeof v === 'string') result[k] = v;
                    }
                }
            }
        }
    } catch { /* ignore */ }
    return result;
}

// ── 主要读取函数 ────────────────────────────────────────────────────────────

/** 读取表头中英映射（默认值 + 用户/工作区设置由 VSCode 自动合并，再以 .plugin/.tms/headerLabels.json 最高优先级覆盖） */
export function getHeaderLabels(): HeaderLabels {
    // 1. VSCode 配置系统（内置默认 + 用户设置 + 工作区 settings.json）
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

    // 2. .plugin/.tms/headerLabels.json 最高优先级覆盖
    const fileLabels = readHeaderLabelsJson();
    for (const k in fileLabels) {
        if (Object.prototype.hasOwnProperty.call(fileLabels, k)) {
            merged[k] = fileLabels[k];
        }
    }

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
 * （步骤描述/名称/预期结果/路径/前置条件/案例类型/优先级），
 * 说明这是 examples/case_example.csv 风格的中文 CSV，
 * 下游 mapChineseRowToCaseItem 会按中文键直接做语义化映射
 * （如「步骤描述」→ description 数组按 #\n 拆分、「预期结果」→ expected 数组按 #\n 拆分），
 * 该映射与 headerReverseLabels 的简单 key 改名语义并不一致
 * （如「步骤描述」反向映射成 description 字符串会与「案例描述」语义重叠，
 * 且让 mapper 误判中文分支后取不到值），
 * 因此这里直接保留原始中文键，跳过反向映射，交由 mapper 处理。
 */
const CSV_ZH_HEADER_KEYS = ['步骤描述', '名称', '预期结果', '路径', '前置条件', '案例类型', '优先级', '执行方式'];

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
 * 监听表头映射变更（VSCode 设置项变更 + .plugin/.tms/headerLabels.json 文件变更）。
 * 返回 Disposable 数组，调用方负责注册到 context.subscriptions 或 panel.onDidDispose。
 */
export function onHeaderLabelsChange(handler: () => void): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // 1. VSCode 配置系统变更（用户设置 / 工作区 settings.json）
    disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CONFIG_KEY) || e.affectsConfiguration(REVERSE_CONFIG_KEY)) {
                try { handler(); } catch { /* ignore */ }
            }
        })
    );

    // 2. .plugin/.tms/headerLabels.json 文件系统变更监听
    const jsonPath = getHeaderLabelsJsonPath();
    if (jsonPath) {
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(
                    path.dirname(jsonPath),
                    'headerLabels.json'
                )
            );
            const onFileChange = () => { try { handler(); } catch { /* ignore */ } };
            disposables.push(
                watcher,
                watcher.onDidChange(onFileChange),
                watcher.onDidCreate(onFileChange),
                watcher.onDidDelete(onFileChange),
            );
        } catch { /* ignore */ }
    }

    return disposables;
}

// ============================================================================
// 配置表头中英映射：若不存在则创建 .plugin/.tms/headerLabels.json，否则打开现有文件
// ----------------------------------------------------------------------------
// 流程：
//   1. 找到当前工作区第一个文件夹
//   2. 拼接 `.plugin/.tms/headerLabels.json` 路径
//   3. 文件不存在 → 读取当前合并后的 headerLabels 默认值，写入 headerLabels.json 模板
//   4. 文件存在   → 直接打开
//   5. 用 VS Code 文本编辑器打开文件，光标定位到 headerLabels 行
// ============================================================================

/**
 * 打开或创建工作区级 headerLabels.json，帮助用户配置表头中英映射。
 *
 * - 若 .plugin/.tms/headerLabels.json 已存在 → 直接打开，并定位到 headerLabels 行
 * - 若不存在 → 读取当前插件内置默认 headerLabels，生成模板文件后打开
 */
export async function openOrCreateHeaderLabelsSettings(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('请先打开一个工作区文件夹。');
        return;
    }

    const workspaceRoot = folders[0].uri.fsPath;
    const pluginDir = path.join(workspaceRoot, '.plugin', '.tms');
    const configPath = path.join(pluginDir, 'headerLabels.json');

    if (!fs.existsSync(configPath)) {
        // 读取当前合并后的 headerLabels 默认值（内置 + 用户设置）
        const defaults = getHeaderLabels();

        // 创建 .plugin/.tms 目录（如不存在）
        if (!fs.existsSync(pluginDir)) {
            fs.mkdirSync(pluginDir, { recursive: true });
        }

        // 写入模板文件
        fs.writeFileSync(
            configPath,
            JSON.stringify(defaults, null, 4) + '\n',
            'utf-8'
        );

        vscode.window.showInformationMessage('已在工作区创建 .plugin/.tms/headerLabels.json，表头映射模板已生成。');
    }

    // 打开文件
    const doc = await vscode.workspace.openTextDocument(configPath);
    const editor = await vscode.window.showTextDocument(doc);

    // 将光标定位到文件开头
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    editor.revealRange(new vscode.Range(0, 0, 0, 0));
}
