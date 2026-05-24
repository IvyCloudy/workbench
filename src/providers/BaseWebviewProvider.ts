/**
 * ============================================================================
 *  providers/BaseWebviewProvider.ts
 *  独立 Webview Panel 的抽象基类
 * ----------------------------------------------------------------------------
 *  适用对象：WorkbenchProvider / TableBrowserProvider / TestCaseProvider
 *  职责：
 *    1. 统一管理 panel 创建 / 重用 / 销毁 / disposables。
 *    2. 从结论同体模板加载 HTML，替换 nonce / scriptUri / mediaBase / cspSource。
 *    3. 定义统一消息入口（handleMessage）供子类实现。
 *  与 BaseEditorProvider 的区别：
 *    - 本类适用于「面板式」Webview（独立 Tab，文件无关）。
 *    - BaseEditorProvider 适用于绑定到某个文件的「定制编辑器」。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { getNonce, buildErrorHtml } from '../services/utils';
import type { WebviewMessage } from '../types';

// ============================================
// 消息处理器类型
// ============================================

export type MessageHandler = (msg: WebviewMessage) => void | Promise<void>;

// ============================================
// 基础 Webview Provider（用于 WorkbenchProvider/TableBrowserProvider/TestCaseProvider 这些独立 Panel）
// ============================================

export abstract class BaseWebviewProvider {
    protected panel: vscode.WebviewPanel | undefined;
    protected disposables: vscode.Disposable[] = [];

    constructor(
        protected extensionUri: vscode.Uri,
        protected context: vscode.ExtensionContext
    ) {}

    // ==================== 抽象方法 ====================

    protected abstract getPanelId(): string;
    protected abstract getPanelTitle(): string;
    protected abstract getViewColumn(): vscode.ViewColumn;
    protected abstract getHtmlPath(): vscode.Uri;
    protected abstract getScriptPath(): vscode.Uri;
    protected abstract handleMessage(msg: WebviewMessage): void | Promise<void>;

    // ==================== 公共方法 ====================

    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(this.getViewColumn());
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            this.getPanelId(),
            this.getPanelTitle(),
            this.getViewColumn(),
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );

        this.panel.onDidDispose(() => this.onDispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables
        );

        this.panel.webview.html = await this.getHtmlContent();
    }

    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // ==================== 内部方法 ====================

    protected async getHtmlContent(): Promise<string> {
        try {
            const nonce = getNonce();
            const scriptUri = this.panel!.webview.asWebviewUri(this.getScriptPath()).toString();
            // 媒体资源根（用于 CSP 限定可加载的样式/脚本来源）
            const mediaBase = this.panel!.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media')
            ).toString();
            const cspSource = this.panel!.webview.cspSource;
            let html = await fs.promises.readFile(this.getHtmlPath().fsPath, 'utf-8');

            html = html.replace(/\$\{nonce\}/g, nonce);
            html = html.replace(/\$\{scriptUri\}/g, scriptUri);
            html = html.replace(/\$\{mediaBase\}/g, mediaBase);
            html = html.replace(/\$\{cspSource\}/g, cspSource);

            return html;
        } catch (e) {
            console.error(`[${this.getPanelId()}] getHtmlContent error:`, e);
            return buildErrorHtml(`${this.getPanelTitle()} 页面加载失败`);
        }
    }

    protected postMessage(message: WebviewMessage): void {
        this.panel?.webview.postMessage(message);
    }

    protected onDispose(): void {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
