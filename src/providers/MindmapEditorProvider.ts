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
import { buildXmindFile } from '../utils/xmindExporter';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { stackHead } from '../services/utils';

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
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
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
        const pushToWebview = (reason: string) => {
            const text = document.getText();
            try {
                const tree = parseMarkdown(text);
                lastPushedText = text;
                webviewPanel.webview.postMessage({
                    type: 'init',
                    fileName: path.basename(filePath),
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
            pushToWebview('docChange');
        });

        // ============ 处理 webview 消息 ============
        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            if (!msg || typeof msg !== 'object') return;
            switch (msg.type) {
                case 'ready':
                    pushToWebview('ready');
                    sendTelemetryEvent('mindmap.opened', { ext: '.md' });
                    return;

                case 'update': {
                    // webview 把整棵树发回，我们序列化为 md 并通过 WorkspaceEdit 写入
                    const tree = msg.tree as MindmapNode | undefined;
                    if (!tree) return;
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
                    await this.handleExportXmind(document, webviewPanel);
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
                        if (/^https?:/i.test(target)) {
                            await vscode.env.openExternal(vscode.Uri.parse(target));
                        } else {
                            // 本地附件：相对/绝对路径
                            const abs = path.isAbsolute(target) ? target : path.join(docDir, target);
                            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
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
            }
        });

        webviewPanel.onDidDispose(() => {
            docChangeSub.dispose();
            messageSub.dispose();
        });
    }

    /**
     * 把当前文档另存为 .xmind 文件。
     */
    private async handleExportXmind(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        try {
            const text = document.getText();
            const tree = parseMarkdown(text);
            const buf = buildXmindFile(tree, path.basename(document.uri.fsPath, path.extname(document.uri.fsPath)));

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
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'style.css'),
        ).toString();
        const vendorScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pages', 'mindmap', 'vendor', 'markmap.bundle.js'),
        ).toString();
        const mediaBase = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ).toString();
        const cspSource = webview.cspSource;

        let html = await fs.promises.readFile(htmlPath.fsPath, 'utf-8');
        html = html
            .replace(/\$\{nonce\}/g, nonce)
            .replace(/\$\{scriptUri\}/g, scriptUri)
            .replace(/\$\{styleUri\}/g, styleUri)
            .replace(/\$\{vendorScriptUri\}/g, vendorScriptUri)
            .replace(/\$\{mediaBase\}/g, mediaBase)
            .replace(/\$\{cspSource\}/g, cspSource);
        // 防御：忽略 escapeHtml 等未替换占位符
        html = html.replace(/\$\{escapeHtmlPlaceholder\}/g, escapeHtml(''));
        return html;
    }
}
