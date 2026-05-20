import * as vscode from 'vscode';
import * as fs from 'fs';
import { getNonce, buildErrorHtml } from '../services/utils';
import type { WebviewMessage } from '../types';

// ============================================
// Webview 消息处理器类型
// ============================================

export type MessageHandler = (msg: WebviewMessage) => void | Promise<void>;

// ============================================
// 基础 Webview Provider
// ============================================

export abstract class BaseWebviewProvider {
    protected panel: vscode.WebviewPanel | undefined;
    protected disposables: vscode.Disposable[] = [];

    constructor(
        protected extensionUri: vscode.Uri,
        protected context: vscode.ExtensionContext
    ) {}

    /**
     * 获取面板 ID（子类覆盖）
     */
    protected abstract getPanelId(): string;

    /**
     * 获取面板标题（子类覆盖）
     */
    protected abstract getPanelTitle(): string;

    /**
     * 获取视图列（子类覆盖）
     */
    protected abstract getViewColumn(): vscode.ViewColumn;

    /**
     * 获取 HTML 文件路径（子类覆盖）
     */
    protected abstract getHtmlPath(): vscode.Uri;

    /**
     * 获取脚本路径（子类覆盖）
     */
    protected abstract getScriptPath(): vscode.Uri;

    /**
     * 处理消息（子类实现）
     */
    protected abstract handleMessage(msg: WebviewMessage): void | Promise<void>;

    /**
     * 显示面板
     */
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

    /**
     * 获取 HTML 内容
     */
    protected async getHtmlContent(): Promise<string> {
        try {
            const nonce = getNonce();
            const scriptUri = this.panel!.webview.asWebviewUri(this.getScriptPath()).toString();
            let html = await fs.promises.readFile(this.getHtmlPath().fsPath, 'utf-8');

            html = html.replace(/\$\{nonce\}/g, nonce);
            html = html.replace(/\$\{scriptUri\}/g, scriptUri);

            return html;
        } catch (e) {
            console.error(`[${this.getPanelId()}] getHtmlContent error:`, e);
            return this.getFallbackHtml();
        }
    }

    /**
     * 获取后备 HTML
     */
    protected getFallbackHtml(): string {
        return buildErrorHtml(`${this.getPanelTitle()} 页面加载失败`);
    }

    /**
     * 发送消息到 Webview
     */
    protected postMessage(message: WebviewMessage): void {
        this.panel?.webview.postMessage(message);
    }

    /**
     * 面板销毁时调用
     */
    protected onDispose(): void {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    /**
     * 释放资源
     */
    dispose(): void {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
