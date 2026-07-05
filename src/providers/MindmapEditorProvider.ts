/**
 * ============================================================================
 *  providers/MindmapEditorProvider.ts
 *  测试大纲思维导图编辑器（CustomTextEditorProvider）
 * ----------------------------------------------------------------------------
 *  作用域：仅匹配 `**\/测试大纲\/**\/*.md`（在 package.json 中通过 selector 限定）。
 *
 *  核心设计：
 *    - 使用 vscode.CustomTextEditorProvider，托管基于 TextDocument 的编辑：
 *        * 撤销/重做、磁盘冲突、外部修改自动同步、脏状态徽标 全部由 VS Code 处理
 *        * 我们只在内存中操作 markdown 文本，写盘交给 WorkspaceEdit（保存=Ctrl/Cmd+S）
 *    - md ↔ 节点树双向同步：
 *        * 文档 → webview：解析为节点树 postMessage('init')
 *        * webview → 文档：变更后 postMessage('update')，扩展端把节点树序列化回 md
 *          通过 WorkspaceEdit 整体替换文本内容（保留撤销栈）
 *    - 提供"导出 .xmind"按钮：右上角点击 → showSaveDialog → 写入 .xmind zip
 *    - 提供"用文本打开"按钮：切换回默认 md 文本编辑器
 *
 *  避免循环更新：
 *    - webview 的本地编辑会先回调 update 给扩展端，扩展端做 WorkspaceEdit
 *    - WorkspaceEdit 触发 onDidChangeTextDocument → 我们再 push 一次新文本给 webview
 *    - 通过 lastSyncedText 比较跳过自身写入引起的回环
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getNonce, escapeHtml, buildErrorHtml } from '../services/utils';
import { parseMarkdown, toMarkdown, type MindmapNode } from '../utils/markdownMindmap';
import {
    buildXmindFile,
    buildXmindFileRich,
    type XMindRichNode,
    type XMindRichTheme,
    type XMindAttachmentResolver,
} from '../utils/xmindExporter';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { stackHead } from '../services/utils';
import { showModal } from '../utils/message';
import {
    parsePointsMarkdown,
    parseResultToMindmapNode,
    mindmapNodeToParseResult,
    isPointsDocument,
    resolvePointsRootTitle,
    patchMarkdownTablesWithEditedResult,
    buildPathRemap,
    featurePathKey,
} from '../points';

/**
 * 富元素（图片/附件）资源目录约定：
 *   <md 所在目录>/attachments/<md 文件 basename(无扩展)>/
 * 复制本地文件到此目录后，md 中以相对路径引用：
 *   ![](attachments/<basename>/xxx.png)   图片
 *   [📎 file.pdf](attachments/<basename>/file.pdf)  附件
 */
function getAttachmentsDir(docPath: string): string {
    const dir = path.dirname(docPath);
    const baseNoExt = path.basename(docPath, path.extname(docPath));
    return path.join(dir, 'attachments', baseNoExt);
}
async function ensureDir(dir: string): Promise<void> {
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch (_) { /* ignore */ }
}
/** 在目标目录中产生一个不冲突的文件名（同名追加 -1 / -2 ...） */
async function uniqueDestPath(targetDir: string, fileName: string): Promise<string> {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    let candidate = path.join(targetDir, fileName);
    let i = 1;
    while (true) {
        try {
            await fs.promises.access(candidate, fs.constants.F_OK);
            candidate = path.join(targetDir, `${stem}-${i}${ext}`);
            i++;
        } catch (_) {
            return candidate;
        }
    }
}

export const MINDMAP_EDITOR_VIEWTYPE = 'testcaseViewer.mindmapEditor';

/**
 * 判断给定路径是否落在「测试大纲」目录下（任意层级）。
 * package.json 中 selector 已做模式过滤；这里再次防御，避免外部命令调用越权。
 */
export function isOutlineMarkdownFile(filePath: string): boolean {
    if (!filePath) return false;
    if (!/\.md$/i.test(filePath)) return false;
    const parts = filePath.split(path.sep);
    return parts.includes('测试大纲');
}

export class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const filePath = document.uri.fsPath;

        // 配置 webview
        // localResourceRoots 必须同时包含扩展 media 目录与 md 文件相关目录，
        // 否则 attachments/ 下的本地图片会被 webview 拒绝加载。
        const docDirUri = vscode.Uri.file(path.dirname(filePath));
        const workspaceRoots: vscode.Uri[] = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
        const resourceRoots: vscode.Uri[] = [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            docDirUri,
            ...workspaceRoots,
        ];
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: resourceRoots,
        };

        // 防御：非测试大纲 md 不应该走到这里（package.json 已限定），但保险起见兜底
        if (!isOutlineMarkdownFile(filePath)) {
            webviewPanel.webview.html = buildErrorHtml(
                '此文件不在「测试大纲」目录下，无法用思维导图打开。',
                '不支持的文件',
            );
            return;
        }

        try {
            webviewPanel.webview.html = await this.getHtmlContent(webviewPanel.webview);
        } catch (err: any) {
            webviewPanel.webview.html = buildErrorHtml(
                `思维导图编辑器加载失败：${err?.message || err}`,
                '加载失败',
            );
            sendTelemetryErrorEvent('mindmap.htmlLoadFailed', {
                errorMessage: String(err?.message || String(err)).slice(0, 500),
                stackHead: stackHead(err),
            });
            return;
        }

        // 用于跳过"自身写入"引起的回环
        let lastPushedText = '';
        // webview 写入时间戳：用于在保存（onDidSave）后避免被外部 fsWatcher 误触发再 push
        let suppressUntil = 0;

        // 把本地绝对路径转换为 webview 可访问的 URI（图片显示需要）
        const docDir = path.dirname(filePath);
        const toWebUri = (relOrAbs: string): string => {
            try {
                if (!relOrAbs) return '';
                // 网络/data URI：直接放行
                if (/^(https?:|data:|file:)/i.test(relOrAbs)) return relOrAbs;
                const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(docDir, relOrAbs);
                return webviewPanel.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
            } catch (_) { return ''; }
        };

        // ============ 把当前文档同步到 webview ============
        const pushToWebview = async (reason: string) => {
            const text = document.getText();
            try {
                let tree: MindmapNode;
                let mode: 'points' | 'outline' = 'outline';

                if (isPointsDocument(document)) {
                    const result = parsePointsMarkdown(document);
                    if (result.features.length > 0) {
                        const rootTitle = await resolvePointsRootTitle(filePath);
                        tree = parseResultToMindmapNode(result, rootTitle);
                        mode = 'points';
                    } else {
                        tree = parseMarkdown(text);
                    }
                } else {
                    tree = parseMarkdown(text);
                }

                lastPushedText = text;
                webviewPanel.webview.postMessage({
                    type: 'init',
                    mode,
                    fileName: path.basename(filePath),
                    filePath,
                    tree,
                    reason,
                });
            } catch (err: any) {
                console.error('[Mindmap] 解析 md 失败:', err?.message || err);
                webviewPanel.webview.postMessage({
                    type: 'parseError',
                    message: err?.message || '解析失败',
                });
                sendTelemetryErrorEvent('mindmap.parseFailed', {
                    errorMessage: String(err?.message || String(err)).slice(0, 500),
                    stackHead: stackHead(err),
                });
            }
        };

        // ============ 监听文档外部变化（包括我们自己 applyEdit）============
        const docChangeSub = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString()) return;
            // 跳过自身写入
            const text = e.document.getText();
            if (Date.now() < suppressUntil && text === lastPushedText) return;
            if (text === lastPushedText) return;
            void pushToWebview('docChange');
        });

        // ============ 处理 webview 消息 ============
        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            if (!msg || typeof msg !== 'object') return;
            switch (msg.type) {
                case 'ready':
                    void pushToWebview('ready');
                    sendTelemetryEvent('mindmap.opened', { ext: '.md' });
                    return;

                case 'update': {
                    const tree = msg.tree as MindmapNode | undefined;
                    if (!tree) return;

                    const usePointsMode = msg.mode === 'points' || isPointsDocument(document);

                    if (usePointsMode) {
                        try {
                            const parseResult = mindmapNodeToParseResult(tree);
                            if (parseResult.features.length === 0) {
                                return;
                            }

                            const warnings: string[] = [];
                            for (const feature of parseResult.features) {
                                const featurePath = feature.path.join('/');
                                let invalidCount = 0;
                                for (const group of feature.tableGroups) {
                                    for (const point of group.testPoints) {
                                        if (!point.index || !point.index.trim()) {
                                            invalidCount++;
                                        }
                                    }
                                }
                                if (invalidCount > 0) {
                                    warnings.push(
                                        `功能条目「${featurePath}」中有 ${invalidCount} 个测试点缺少序号，无法回写`
                                    );
                                }
                            }

                            const originalResult = parsePointsMarkdown(document);
                            const originalPaths = new Set(
                                originalResult.features.map((f) => featurePathKey(f.path))
                            );
                            const pathRemap = buildPathRemap(originalResult, parseResult);
                            const remappedNewPaths = new Set(pathRemap.values());
                            for (const feature of parseResult.features) {
                                const featurePath = featurePathKey(feature.path);
                                if (originalPaths.has(featurePath)) continue;
                                if (remappedNewPaths.has(featurePath)) continue;
                                warnings.push(
                                    `功能条目「${featurePath}」在原始 Markdown 中未找到，无法回写`
                                );
                            }

                            if (warnings.length > 0) {
                                showModal(
                                    webviewPanel,
                                    'warning',
                                    `回写 Markdown 时发现 ${warnings.length} 个问题`,
                                    `以下内容无法回写：\n\n${warnings.join('\n')}`
                                );
                                return;
                            }

                            const patched = patchMarkdownTablesWithEditedResult(document, parseResult);
                            if (patched.updatedFeatures === 0) {
                                return;
                            }
                            const newText = patched.markdown;
                            if (newText === document.getText()) return;

                            const edit = new vscode.WorkspaceEdit();
                            const fullRange = new vscode.Range(
                                document.positionAt(0),
                                document.positionAt(document.getText().length),
                            );
                            edit.replace(document.uri, fullRange, newText);
                            suppressUntil = Date.now() + 200;
                            lastPushedText = newText;
                            await vscode.workspace.applyEdit(edit);
                        } catch (err: any) {
                            sendTelemetryErrorEvent('mindmap.pointsWritebackFailed', {
                                errorMessage: String(err?.message || String(err)).slice(0, 500),
                                stackHead: stackHead(err),
                            });
                        }
                        return;
                    }

                    let newText: string;
                    try {
                        newText = toMarkdown(tree);
                    } catch (err: any) {
                        sendTelemetryErrorEvent('mindmap.serializeFailed', {
                            errorMessage: String(err?.message || String(err)).slice(0, 500),
                            stackHead: stackHead(err),
                        });
                        return;
                    }
                    if (newText === document.getText()) return;
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length),
                    );
                    edit.replace(document.uri, fullRange, newText);
                    suppressUntil = Date.now() + 200;
                    lastPushedText = newText;
                    await vscode.workspace.applyEdit(edit);
                    return;
                }

                case 'exportXmind': {
                    await this.handleExportXmind(document, webviewPanel, msg);
                    return;
                }

                case 'openWithText': {
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    return;
                }

                // ---- 富元素：把相对路径解析为 webview 可访问 URI（用于 <img src>） ----
                case 'resolveAsset': {
                    const items = Array.isArray(msg.items) ? msg.items : [];
                    const out = items.map((rel: string) => ({ rel, uri: toWebUri(rel) }));
                    webviewPanel.webview.postMessage({
                        type: 'resolveAssetResult',
                        requestId: msg.requestId,
                        items: out,
                    });
                    return;
                }

                // ---- 富元素：打开链接（http/https）或本地文件（附件） ----
                case 'openExternal': {
                    const target = String(msg.target || '');
                    if (!target) return;
                    try {
                        // http(s) 外链：直接交给系统浏览器
                        if (/^https?:/i.test(target)) {
                            await vscode.env.openExternal(vscode.Uri.parse(target));
                            return;
                        }

                        // 本地附件：相对/绝对路径
                        // 注意：md 中的相对路径常被 URL 编码（如空格 → %20），
                        // 直接拼到磁盘路径会导致 fs 找不到文件。先尝试 decode，
                        // 失败（非法编码）回退原串。
                        let localTarget = target;
                        try { localTarget = decodeURIComponent(target); } catch (_) { localTarget = target; }
                        // 去除可能的 file:// 前缀（兼容某些情况下 mdimage parser 会保留协议）
                        if (/^file:\/\//i.test(localTarget)) {
                            try { localTarget = vscode.Uri.parse(localTarget).fsPath; } catch (_) {}
                        }
                        const abs = path.isAbsolute(localTarget) ? localTarget : path.join(docDir, localTarget);
                        const fileUri = vscode.Uri.file(abs);

                        // 1) 预检：文件不存在则给出明确提示，避免 macOS LaunchServices
                        //    弹出"No application found to open URL"误导用户以为是应用问题。
                        if (!fs.existsSync(abs)) {
                            const pick = await vscode.window.showWarningMessage(
                                `附件文件不存在：${abs}`,
                                '在 Finder 中显示父目录',
                            );
                            if (pick) {
                                const parent = path.dirname(abs);
                                if (fs.existsSync(parent)) {
                                    try {
                                        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(parent));
                                    } catch (_) {}
                                }
                            }
                            return;
                        }

                        // 2) 已知 VS Code 可直接渲染的文件类型 → 在右侧新列打开
                        const ext = path.extname(abs).toLowerCase();
                        const inEditorExts = new Set([
                            '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx',
                            '.log', '.csv', '.tsv', '.ini', '.conf', '.toml', '.sh', '.bat', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
                            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.pdf',
                        ]);
                        if (inEditorExts.has(ext)) {
                            await vscode.commands.executeCommand(
                                'vscode.open',
                                fileUri,
                                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                            );
                            return;
                        }

                        // 3) 非 VS Code 可识别类型 → 交给操作系统默认应用
                        //    vscode.env.openExternal 对 file:// 在不同平台支持不一，
                        //    macOS 上某些扩展名找不到 default app 时会触发 "No application found"，
                        //    所以这里先尝试 openExternal，失败立刻兜底 revealFileInOS。
                        let opened = false;
                        try {
                            opened = await vscode.env.openExternal(fileUri);
                        } catch (_) {
                            opened = false;
                        }
                        if (!opened) {
                            const pick = await vscode.window.showWarningMessage(
                                `未找到能打开 ${path.basename(abs)} 的应用程序。`,
                                '在 Finder 中显示',
                            );
                            if (pick) {
                                try {
                                    await vscode.commands.executeCommand('revealFileInOS', fileUri);
                                } catch (_) {}
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showWarningMessage(`无法打开：${target}（${err?.message || err}）`);
                    }
                    return;
                }

                // ---- 富元素：用户点选本地文件，复制到 attachments 目录，返回 md 中应使用的相对路径 ----
                case 'pickFile': {
                    const kind = msg.kind === 'image' ? 'image' : 'attachment'; // 'image' | 'attachment'
                    const filters: { [k: string]: string[] } = kind === 'image'
                        ? { '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }
                        : { '所有文件': ['*'] };
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectMany: false,
                        canSelectFolders: false,
                        openLabel: kind === 'image' ? '选择图片' : '选择附件',
                        filters,
                    });
                    if (!picked || picked.length === 0) {
                        webviewPanel.webview.postMessage({
                            type: 'pickFileResult',
                            requestId: msg.requestId,
                            canceled: true,
                        });
                        return;
                    }
                    const srcPath = picked[0].fsPath;
                    const attachDir = getAttachmentsDir(filePath);
                    await ensureDir(attachDir);
                    const destPath = await uniqueDestPath(attachDir, path.basename(srcPath));
                    try {
                        await fs.promises.copyFile(srcPath, destPath);
                    } catch (err: any) {
                        webviewPanel.webview.postMessage({
                            type: 'pickFileResult',
                            requestId: msg.requestId,
                            ok: false,
                            message: err?.message || String(err),
                        });
                        return;
                    }
                    // md 中应使用的相对路径（相对 md 所在目录），始终用 / 分隔，便于跨平台
                    const relPath = path.relative(docDir, destPath).split(path.sep).join('/');
                    const webUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    webviewPanel.webview.postMessage({
                        type: 'pickFileResult',
                        requestId: msg.requestId,
                        ok: true,
                        kind,
                        rel: relPath,
                        name: path.basename(destPath),
                        webUri,
                    });
                    sendTelemetryEvent('mindmap.pickFile', { kind });
                    return;
                }

                // ---- 富元素：webview 直接把字节流（如压缩后的图片）发过来，
                //      落盘到 attachments 目录，返回 md 中应使用的相对路径 ----
                case 'saveAssetBytes': {
                    try {
                        const kind = msg.kind === 'image' ? 'image' : 'attachment';
                        const base64: string = String(msg.base64 || '');
                        const suggestedName: string = String(msg.name || 'image.bin');
                        if (!base64) {
                            webviewPanel.webview.postMessage({
                                type: 'saveAssetBytesResult',
                                requestId: msg.requestId,
                                ok: false,
                                message: 'empty bytes',
                            });
                            return;
                        }
                        const buf = Buffer.from(base64, 'base64');
                        const attachDir = getAttachmentsDir(filePath);
                        await ensureDir(attachDir);
                        // 文件名安全化：仅保留 ASCII 字母/数字/._-，其余替换成 _
                        const safeName = suggestedName.replace(/[^\w.\-]+/g, '_') || 'image.bin';
                        const destPath = await uniqueDestPath(attachDir, safeName);
                        await fs.promises.writeFile(destPath, buf);
                        const relPath = path.relative(path.dirname(filePath), destPath).split(path.sep).join('/');
                        const webUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                        webviewPanel.webview.postMessage({
                            type: 'saveAssetBytesResult',
                            requestId: msg.requestId,
                            ok: true,
                            kind,
                            rel: relPath,
                            name: path.basename(destPath),
                            webUri,
                        });
                        sendTelemetryEvent('mindmap.saveAssetBytes', { kind });
                    } catch (err: any) {
                        webviewPanel.webview.postMessage({
                            type: 'saveAssetBytesResult',
                            requestId: msg.requestId,
                            ok: false,
                            message: err?.message || String(err),
                        });
                    }
                    return;
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            docChangeSub.dispose();
            messageSub.dispose();
        });
    }

    /**
     * 把当前文档另存为 .xmind 文件。
     *
     * 三级优先策略：
     *   1) richTree + theme（webview 自己组装的富节点树 + 当前主题）→ 完整保留配色 / 形状 / 图片 / 链接
     *   2) base64（旧路径：webview 用 simple-mind-map 自带导出器生成的字节）→ 兼容，但无主题
     *   3) 回退：用文档 markdown 解析重建，仅含结构和文字
     */
    private async handleExportXmind(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        msg?: {
            base64?: string;
            name?: string;
            richTree?: XMindRichNode;
            theme?: XMindRichTheme;
            layout?: string;
        },
    ): Promise<void> {
        try {
            const sheetTitle = path.basename(
                document.uri.fsPath,
                path.extname(document.uri.fsPath),
            );
            let buf: Uint8Array;
            if (msg && msg.richTree && typeof msg.richTree === 'object') {
                // 附件解析器：把 md 中附件路径（相对 / 绝对）读为字节，
                // 供 exporter 写入 .xmind 包内的 resources/，
                // 达到 XMind 中点击附件以“理解为附件”而非外链打开的效果。
                const docDir = path.dirname(document.uri.fsPath);
                const attachmentResolver: XMindAttachmentResolver = {
                    resolve: (ref: string) => {
                        if (!ref || /^https?:/i.test(ref) || /^data:/i.test(ref)) return null;
                        let r = ref;
                        try { r = decodeURIComponent(r); } catch (_) { /* ignore */ }
                        if (/^file:\/\//i.test(r)) {
                            try { r = vscode.Uri.parse(r).fsPath; } catch (_) { /* ignore */ }
                        }
                        const abs = path.isAbsolute(r) ? r : path.join(docDir, r);
                        try {
                            if (!fs.existsSync(abs)) return null;
                            const bytes = fs.readFileSync(abs);
                            return {
                                bytes: new Uint8Array(bytes),
                                filename: path.basename(abs),
                            };
                        } catch (_) {
                            return null;
                        }
                    },
                };
                buf = buildXmindFileRich(
                    msg.richTree,
                    msg.theme || {},
                    sheetTitle,
                    msg.layout,
                    attachmentResolver,
                );
            } else if (msg && typeof msg.base64 === 'string' && msg.base64) {
                buf = Buffer.from(msg.base64, 'base64');
            } else {
                const text = document.getText();
                const tree = parseMarkdown(text);
                buf = buildXmindFile(tree, sheetTitle);
            }

            // 默认保存到同目录、同名 .xmind
            const defaultUri = vscode.Uri.file(
                path.join(
                    path.dirname(document.uri.fsPath),
                    path.basename(document.uri.fsPath, path.extname(document.uri.fsPath)) + '.xmind',
                ),
            );
            const target = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'XMind 文件': ['xmind'] },
                saveLabel: '导出',
                title: '导出为 XMind',
            });
            if (!target) {
                webviewPanel.webview.postMessage({ type: 'exportXmindResult', ok: false, canceled: true });
                return;
            }
            await fs.promises.writeFile(target.fsPath, Buffer.from(buf));
            webviewPanel.webview.postMessage({
                type: 'exportXmindResult',
                ok: true,
                fsPath: target.fsPath,
            });
            sendTelemetryEvent('mindmap.exportXmind', { ok: 'true' });
            vscode.window.showInformationMessage(`已导出：${path.basename(target.fsPath)}`);
        } catch (err: any) {
            console.error('[Mindmap] 导出 xmind 失败:', err?.message || err);
            webviewPanel.webview.postMessage({
                type: 'exportXmindResult',
                ok: false,
                message: err?.message || String(err),
            });
            sendTelemetryErrorEvent('mindmap.exportXmindFailed', {
                errorMessage: String(err?.message || String(err)).slice(0, 500),
                stackHead: stackHead(err),
            });
            vscode.window.showErrorMessage(`导出 XMind 失败：${err?.message || err}`);
        }
    }

    private async getHtmlContent(webview: vscode.Webview): Promise<string> {
        const nonce = getNonce();
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'index.html');
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'main.js'),
        ).toString();
        const styleLayoutUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'styles', 'layout.css'),
        ).toString();
        const stylePanelsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'styles', 'panels.css'),
        ).toString();
        const stylePopupsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'styles', 'popups.css'),
        ).toString();
        const vendorScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'vendor', 'simple-mind-map.bundle.js'),
        ).toString();
        const vendorStyleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'vendor', 'simple-mind-map.bundle.css'),
        ).toString();
        const mediaBase = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ).toString();
        const cspSource = webview.cspSource;

        let html = await fs.promises.readFile(htmlPath.fsPath, 'utf-8');
        html = html
            .replace(/\$\{nonce\}/g, nonce)
            .replace(/\$\{scriptUri\}/g, scriptUri)
            .replace(/\$\{styleLayoutUri\}/g, styleLayoutUri)
            .replace(/\$\{stylePanelsUri\}/g, stylePanelsUri)
            .replace(/\$\{stylePopupsUri\}/g, stylePopupsUri)
            .replace(/\$\{vendorScriptUri\}/g, vendorScriptUri)
            .replace(/\$\{vendorStyleUri\}/g, vendorStyleUri)
            .replace(/\$\{mediaBase\}/g, mediaBase)
            .replace(/\$\{cspSource\}/g, cspSource);
        // 防御：忽略 escapeHtml 等未替换占位符
        html = html.replace(/\$\{escapeHtmlPlaceholder\}/g, escapeHtml(''));
        return html;
    }
}
