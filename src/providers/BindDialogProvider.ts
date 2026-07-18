/**
 * ============================================================================
 *  providers/BindDialogProvider.ts
 *  自定义"绑定测试案例 / 绑定测试要点"弹窗（Webview Panel）
 * ----------------------------------------------------------------------------
 *  与 BaseWebviewProvider 的关系：
 *    - 本类是**独立的 Panel**，但每次打开都根据源文件生成不同标题与初始数据，
 *      因此不直接继承 BaseWebviewProvider 的单例语义，改为一次性 Panel。
 *
 *  流程：
 *    1. 从源文件（.md/.xmind 或 .csv/.yaml/.json）判断"绑定方向"：
 *         - point → cases       右键测试要点，选择案例
 *         - case  → points      右键测试案例，选择要点
 *    2. 在同一测试任务子目录下扫描候选文件，标记已绑定 / 未绑定，
 *       连同当前已绑定状态传给 Webview。
 *    3. Webview 上勾选后 postMessage(save) → 落库到工作区文件。
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce, buildErrorHtml } from '../services/utils';
import { showToast } from '../utils/message';
import { TelemetryService } from '../utils/telemetry';
import {
    getBoundCasesOfPoint,
    getBoundPointsOfCase,
    setPointCases,
    setCasePoints,
    findWorkspaceRootFor,
    toRelPath,
    buildCaseOccupancyMap,
    buildPointOccupancyMap,
} from '../utils/pointCaseBindingStore';

// ============================================
// 类型
// ============================================

export type BindDirection = 'point-to-cases' | 'case-to-points';

/** 传给 webview 的候选项 */
interface CandidateItem {
    /** 绝对路径 */
    absPath: string;
    /** 相对工作区根路径（用于显示） */
    relPath: string;
    /** 文件名 */
    name: string;
    /** 文件扩展名（不含点） */
    ext: string;
    /** 是否已与当前源文件绑定 */
    boundToSource: boolean;
    /** 是否被其他项绑定（1:1 语义下：true 则不可选） */
    boundToOthers: boolean;
    /** 若被其他项占用，占用者相对路径（用于 UI 展示） */
    boundToOwnerRel?: string;
}

interface InitPayload {
    direction: BindDirection;
    /** 源文件绝对路径 */
    sourceAbsPath: string;
    /** 源文件相对路径 */
    sourceRelPath: string;
    /** 源文件展示名 */
    sourceName: string;
    /** 测试任务子目录名（例：TT2026040017_xxx） */
    scopeTaskName: string;
    candidates: CandidateItem[];
    /** 弹窗标题 */
    title: string;
    /** 目标类型标签 */
    targetLabel: string;
    /** store 中源文件当前已绑定的对端相对路径（1:1，最多 1 个） */
    currentBoundRel?: string;
    /** store 中源文件当前已绑定的对端绝对路径 */
    currentBoundAbs?: string;
}

// ============================================
// 目录扫描：确定 "测试任务/<子任务>/" 根目录
// ============================================

/**
 * 从任意文件路径向上寻找 "测试任务/<xxx>" 这一级目录。
 * 返回 { taskRoot: 该子任务根目录绝对路径, taskName: 子任务名 }
 */
function locateTaskRoot(sourceAbsPath: string): { taskRoot: string; taskName: string } | null {
    const norm = sourceAbsPath.replace(/\\/g, '/');
    // 匹配 "**/测试任务/<name>/" 段
    const m = norm.match(/^(.*\/测试任务\/[^\/]+)(\/|$)/);
    if (!m) return null;
    const taskRoot = m[1];
    const taskName = path.basename(taskRoot);
    return { taskRoot, taskName };
}

/**
 * 在 "测试任务/<xxx>/测试案例" 或 "测试任务/<xxx>/测试大纲" 目录下递归扫描目标文件。
 * dirName = '测试案例' 时返回 csv/yaml/yml/json；'测试大纲' 时返回 md/xmind。
 */
function scanCandidateFiles(taskRoot: string, dirName: '测试案例' | '测试大纲'): string[] {
    const targetDir = path.join(taskRoot, dirName);
    let exists = false;
    try { exists = fs.statSync(targetDir).isDirectory(); } catch { /* ignore */ }
    if (!exists) return [];

    const okExts = dirName === '测试案例'
        ? new Set(['.csv', '.yaml', '.yml', '.json'])
        : new Set(['.md', '.xmind']);
    const results: string[] = [];

    function walk(dir: string) {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (ent.name.startsWith('.')) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                walk(full);
            } else if (ent.isFile()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (okExts.has(ext)) results.push(full);
            }
        }
    }
    walk(targetDir);
    return results;
}

// ============================================
// Provider
// ============================================

export class BindDialogProvider {
    private static activePanel: vscode.WebviewPanel | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly refreshDecorations: () => void,
    ) {}

    /**
     * 打开绑定弹窗。
     * @param sourceUri 源文件（要点 md/xmind 或 案例 csv/yaml/json）
     * @param direction 绑定方向
     */
    async open(sourceUri: vscode.Uri, direction: BindDirection): Promise<void> {
        const sourceAbsPath = sourceUri.fsPath;

        // 1) 校验：必须在 测试任务/<子任务>/ 下
        const loc = locateTaskRoot(sourceAbsPath);
        if (!loc) {
            showToast(undefined, 'warning', '当前文件不在 "测试任务/<子任务>" 目录结构下');
            return;
        }

        const root = findWorkspaceRootFor(sourceAbsPath);
        if (!root) {
            showToast(undefined, 'warning', '当前文件不在已打开的工作区内');
            return;
        }

        // 2) 扫描候选
        const candidateAbsList = direction === 'point-to-cases'
            ? scanCandidateFiles(loc.taskRoot, '测试案例')
            : scanCandidateFiles(loc.taskRoot, '测试大纲');

        // 3) 计算已绑定集合：直接用相对路径匹配，避免绝对路径拼接过程中的分隔符/大小写差异
        const sourceRelForCompare = toRelPath(sourceAbsPath, root) || '';
        const boundRelSet = new Set<string>(
            (direction === 'point-to-cases'
                ? getBoundCasesOfPoint(sourceAbsPath)
                : getBoundPointsOfCase(sourceAbsPath)
            )
                .map(abs => toRelPath(abs, root))
                .filter((r): r is string => !!r),
        );

        // 3.5) 计算候选项占用映射（1:1）：
        //   - point-to-cases：候选是 case，若某 case 已被某 point 绑定则占用
        //   - case-to-points：候选是 point，若某 point 已绑定某 case 则占用
        const occupancyMap = direction === 'point-to-cases'
            ? buildCaseOccupancyMap(root)   // caseRel -> pointRel
            : buildPointOccupancyMap(root); // pointRel -> caseRel

        // 4) 组装 candidates
        const candidates: CandidateItem[] = candidateAbsList.map(abs => {
            const relPath = toRelPath(abs, root) || abs.replace(/\\/g, '/');
            const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
            const boundToSource = boundRelSet.has(relPath);

            // 1:1 占用判定：查候选项在占用映射中的绑定方；若绑定方 ≠ 当前源文件则视为被别人占用
            let boundToOthers = false;
            let boundToOwnerRel: string | undefined;
            const owner = occupancyMap.get(relPath);
            if (owner && owner !== sourceRelForCompare) {
                boundToOthers = true;
                boundToOwnerRel = owner;
            }

            return {
                absPath: abs,
                relPath,
                name: path.basename(abs),
                ext,
                boundToSource,
                boundToOthers,
                boundToOwnerRel,
            };
        }).sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-CN'));

        // 诊断日志（在 Output → 面板中查看）
        try {
            console.log('[BindDialog] open', {
                direction,
                sourceRel: sourceRelForCompare,
                boundRelSet: Array.from(boundRelSet),
                occupancyEntries: Array.from(occupancyMap.entries()).slice(0, 20),
                candidateRels: candidates.map(c => ({ rel: c.relPath, boundToSource: c.boundToSource, boundToOthers: c.boundToOthers })),
            });
        } catch { /* ignore */ }

        const sourceRelPath = toRelPath(sourceAbsPath, root) || sourceAbsPath;
        const targetLabel = direction === 'point-to-cases' ? '测试案例' : '测试要点';
        const title = direction === 'point-to-cases' ? '绑定测试案例' : '绑定测试要点';

        // 从 boundRelSet 中取当前 1:1 绑定的对端（若有）；不在候选扫描范围内也能显示
        const boundRelArr = Array.from(boundRelSet);
        const currentBoundRel = boundRelArr.length > 0 ? boundRelArr[0] : undefined;
        const currentBoundAbs = currentBoundRel ? path.join(root, currentBoundRel) : undefined;

        const payload: InitPayload = {
            direction,
            sourceAbsPath,
            sourceRelPath,
            sourceName: path.basename(sourceAbsPath),
            scopeTaskName: loc.taskName,
            candidates,
            title,
            targetLabel,
            currentBoundRel,
            currentBoundAbs,
        };

        // 5) 打开或复用 Panel
        if (BindDialogProvider.activePanel) {
            try { BindDialogProvider.activePanel.dispose(); } catch { /* ignore */ }
            BindDialogProvider.activePanel = undefined;
        }

        const panel = vscode.window.createWebviewPanel(
            'testcaseViewer.bindDialog',
            `${title} - ${path.basename(sourceAbsPath)}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
            },
        );
        BindDialogProvider.activePanel = panel;

        panel.onDidDispose(() => {
            if (BindDialogProvider.activePanel === panel) {
                BindDialogProvider.activePanel = undefined;
            }
        });

        panel.webview.html = await this.getHtml(panel.webview);

        // 消息处理
        panel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (!msg) return;
                if (msg.command === 'ready') {
                    panel.webview.postMessage({ command: 'init', payload });
                    return;
                }
                if (msg.command === 'save') {
                    const selectedAbsPaths: string[] = Array.isArray(msg.selected) ? msg.selected : [];
                    // 1:1 前置校验（后端 store 也会再校验一次）
                    if (selectedAbsPaths.length > 1) {
                        panel.webview.postMessage({
                            command: 'saveError',
                            message: `测试要点与测试案例为 1:1 关系，最多只能绑定 1 个${targetLabel}`,
                        });
                        return;
                    }
                    try {
                        if (direction === 'point-to-cases') {
                            await setPointCases(sourceAbsPath, selectedAbsPaths);
                        } else {
                            await setCasePoints(sourceAbsPath, selectedAbsPaths);
                        }
                        TelemetryService.sendTelemetryEvent('bindDialog.save.success', {
                            direction, count: String(selectedAbsPaths.length),
                        });
                        this.refreshDecorations();
                        const tip = selectedAbsPaths.length === 0
                            ? '已解除绑定'
                            : `已绑定 1 个${targetLabel}`;
                        showToast(undefined, 'info', tip);
                        panel.webview.postMessage({ command: 'saved' });
                        setTimeout(() => panel.dispose(), 300);
                    } catch (err: any) {
                        TelemetryService.sendTelemetryErrorEvent('bindDialog.save.error', {
                            errorMessage: String(err?.message || err).slice(0, 500),
                        });
                        panel.webview.postMessage({ command: 'saveError', message: err?.message || String(err) });
                    }
                    return;
                }
                if (msg.command === 'cancel') {
                    panel.dispose();
                    return;
                }
                if (msg.command === 'reveal' && typeof msg.absPath === 'string') {
                    try {
                        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.absPath));
                    } catch { /* ignore */ }
                    return;
                }
            } catch (err: any) {
                console.error('[BindDialog] 消息处理异常:', err?.message || err);
            }
        });

        TelemetryService.sendTelemetryEvent('bindDialog.opened', {
            direction, candidateCount: String(candidates.length),
        });
    }

    // ==================== HTML 组装 ====================

    private async getHtml(webview: vscode.Webview): Promise<string> {
        try {
            const nonce = getNonce();
            const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'bind-dialog', 'index.html');
            const scriptUri = webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'bind-dialog', 'main.js'),
            ).toString();
            const mediaBase = webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ).toString();
            const cspSource = webview.cspSource;
            let html = await fs.promises.readFile(htmlPath.fsPath, 'utf-8');
            html = html.replace(/\$\{nonce\}/g, nonce);
            html = html.replace(/\$\{scriptUri\}/g, scriptUri);
            html = html.replace(/\$\{mediaBase\}/g, mediaBase);
            html = html.replace(/\$\{cspSource\}/g, cspSource);
            return html;
        } catch (err: any) {
            console.error('[BindDialog] HTML 加载失败:', err?.message || err);
            return buildErrorHtml('绑定弹窗加载失败');
        }
    }
}
