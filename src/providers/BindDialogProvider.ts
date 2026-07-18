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

/** 是否开启 point-case 绑定的调试日志（受 settings.testcaseViewer.debug.pointCaseBinding 控制） */
function isBindDebug(): boolean {
    try {
        return !!vscode.workspace.getConfiguration('testcaseViewer').get<boolean>('debug.pointCaseBinding', false);
    } catch { return false; }
}
function dbg(...args: any[]) { if (isBindDebug()) console.log('[BindDialog]', ...args); }

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
    /** 候选目录的绝对路径（用于空态提示 + 快捷打开） */
    targetDirAbs?: string;
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
 *
 * 【异步版】主线程零阻塞，大目录不再假死。
 */
async function scanCandidateFilesAsync(taskRoot: string, dirName: '测试案例' | '测试大纲'): Promise<string[]> {
    const targetDir = path.join(taskRoot, dirName);
    let exists = false;
    try {
        const st = await fs.promises.stat(targetDir);
        exists = st.isDirectory();
    } catch { /* ignore */ }
    if (!exists) return [];

    const okExts = dirName === '测试案例'
        ? new Set(['.csv', '.yaml', '.yml', '.json'])
        : new Set(['.md', '.xmind']);
    const results: string[] = [];

    async function walk(dir: string): Promise<void> {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        // 并发访问子项（同层并行）
        await Promise.all(entries.map(async ent => {
            if (ent.name.startsWith('.')) return;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                await walk(full);
            } else if (ent.isFile()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (okExts.has(ext)) results.push(full);
            }
        }));
    }
    await walk(targetDir);
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
        const _openStart = Date.now();
        const sourceAbsPath = sourceUri.fsPath;

        // 1) 校验：必须在 测试任务/<子任务>/ 下
        const loc = locateTaskRoot(sourceAbsPath);
        if (!loc) {
            showToast(undefined, 'warning', '当前文件不在 "测试任务/<子任务>" 目录结构下');
            TelemetryService.sendTelemetryEvent('bindDialog.abort', { reason: 'notInTaskDir' });
            return;
        }

        const root = findWorkspaceRootFor(sourceAbsPath);
        if (!root) {
            showToast(undefined, 'warning', '当前文件不在已打开的工作区内');
            TelemetryService.sendTelemetryEvent('bindDialog.abort', { reason: 'notInWorkspace' });
            return;
        }

        const targetLabel = direction === 'point-to-cases' ? '测试案例' : '测试要点';
        const title = direction === 'point-to-cases' ? '绑定测试案例' : '绑定测试要点';
        const targetDir = direction === 'point-to-cases' ? '测试案例' : '测试大纲';
        const targetDirAbs = path.join(loc.taskRoot, targetDir);

        // 2) 先打开 Panel + 展示 loading（避免大目录扫描时假死）
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

        // 3) 异步扫描候选（不阻塞主线程）
        let payload: InitPayload | undefined;
        let payloadReady = false;
        let readyReceived = false;

        const buildPayload = async () => {
            const candidateAbsList = await scanCandidateFilesAsync(loc.taskRoot, targetDir);

            const sourceRelForCompare = toRelPath(sourceAbsPath, root) || '';
            const boundRelSet = new Set<string>(
                (direction === 'point-to-cases'
                    ? getBoundCasesOfPoint(sourceAbsPath)
                    : getBoundPointsOfCase(sourceAbsPath)
                )
                    .map(abs => toRelPath(abs, root))
                    .filter((r): r is string => !!r),
            );

            const occupancyMap = direction === 'point-to-cases'
                ? buildCaseOccupancyMap(root)
                : buildPointOccupancyMap(root);

            const candidates: CandidateItem[] = candidateAbsList.map(abs => {
                const relPath = toRelPath(abs, root) || abs.replace(/\\/g, '/');
                const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
                const boundToSource = boundRelSet.has(relPath);
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

            dbg('open', {
                direction,
                sourceRel: sourceRelForCompare,
                boundRelSet: Array.from(boundRelSet),
                occupancyEntries: Array.from(occupancyMap.entries()).slice(0, 20),
                candidateRels: candidates.map(c => ({ rel: c.relPath, boundToSource: c.boundToSource, boundToOthers: c.boundToOthers })),
            });

            const sourceRelPath = toRelPath(sourceAbsPath, root) || sourceAbsPath;
            const boundRelArr = Array.from(boundRelSet);
            const currentBoundRel = boundRelArr.length > 0 ? boundRelArr[0] : undefined;
            const currentBoundAbs = currentBoundRel ? path.join(root, currentBoundRel) : undefined;

            payload = {
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
                targetDirAbs,
            };
            payloadReady = true;

            // 若 webview 已 ready，则立即发送；否则等待 ready 触发
            if (readyReceived) {
                panel.webview.postMessage({ command: 'init', payload });
            }

            TelemetryService.sendTelemetryEvent('bindDialog.opened', {
                direction,
                candidateCount: String(candidates.length),
                scanMs: String(Date.now() - _openStart),
            });
        };

        // 消息处理
        panel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                if (!msg) return;
                if (msg.command === 'ready') {
                    readyReceived = true;
                    if (payloadReady && payload) {
                        panel.webview.postMessage({ command: 'init', payload });
                    } else {
                        // 提示前端进入 loading 状态
                        panel.webview.postMessage({ command: 'loading', message: '正在扫描候选文件...' });
                    }
                    return;
                }
                if (msg.command === 'save') {
                    const selectedAbsPaths: string[] = Array.isArray(msg.selected) ? msg.selected : [];
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
                            direction,
                            count: String(selectedAbsPaths.length),
                            action: selectedAbsPaths.length === 0 ? 'unbind' : 'bind',
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
                            direction,
                        });
                        panel.webview.postMessage({ command: 'saveError', message: err?.message || String(err) });
                    }
                    return;
                }
                if (msg.command === 'cancel') {
                    TelemetryService.sendTelemetryEvent('bindDialog.cancel', { direction });
                    panel.dispose();
                    return;
                }
                if (msg.command === 'reveal' && typeof msg.absPath === 'string') {
                    try {
                        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.absPath));
                        TelemetryService.sendTelemetryEvent('bindDialog.reveal', { direction });
                    } catch { /* ignore */ }
                    return;
                }
                if (msg.command === 'openTargetDir' && typeof msg.absPath === 'string') {
                    // 空态时"打开目录"按钮：在资源管理器中定位目录本身
                    try {
                        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.absPath));
                        TelemetryService.sendTelemetryEvent('bindDialog.openTargetDir', { direction });
                    } catch { /* ignore */ }
                    return;
                }
            } catch (err: any) {
                console.error('[BindDialog] 消息处理异常:', err?.message || err);
                TelemetryService.sendTelemetryErrorEvent('bindDialog.messageError', {
                    errorMessage: String(err?.message || err).slice(0, 500),
                });
            }
        });

        // 触发异步扫描（不 await，避免阻塞返回；出错也上报）
        buildPayload().catch(err => {
            TelemetryService.sendTelemetryErrorEvent('bindDialog.scanError', {
                errorMessage: String(err?.message || err).slice(0, 500),
            });
            panel.webview.postMessage({
                command: 'saveError',
                message: `扫描失败：${err?.message || err}`,
            });
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