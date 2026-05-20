"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseWebviewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const utils_1 = require("../services/utils");
// ============================================
// 基础 Webview Provider
// ============================================
class BaseWebviewProvider {
    constructor(extensionUri, context) {
        this.extensionUri = extensionUri;
        this.context = context;
        this.disposables = [];
    }
    /**
     * 显示面板
     */
    show() {
        if (this.panel) {
            this.panel.reveal(this.getViewColumn());
            return;
        }
        this.panel = vscode.window.createWebviewPanel(this.getPanelId(), this.getPanelTitle(), this.getViewColumn(), {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        });
        this.panel.onDidDispose(() => this.onDispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
        this.panel.webview.html = this.getHtmlContent();
    }
    /**
     * 获取 HTML 内容
     */
    getHtmlContent() {
        try {
            const nonce = (0, utils_1.getNonce)();
            const scriptUri = this.panel.webview.asWebviewUri(this.getScriptPath()).toString();
            let html = fs.readFileSync(this.getHtmlPath().fsPath, 'utf-8');
            html = html.replace(/\$\{nonce\}/g, nonce);
            html = html.replace(/\$\{scriptUri\}/g, scriptUri);
            return html;
        }
        catch (e) {
            console.error(`[${this.getPanelId()}] getHtmlContent error:`, e);
            return this.getFallbackHtml();
        }
    }
    /**
     * 获取后备 HTML
     */
    getFallbackHtml() {
        return (0, utils_1.buildErrorHtml)(`${this.getPanelTitle()} 页面加载失败`);
    }
    /**
     * 发送消息到 Webview
     */
    postMessage(message) {
        this.panel?.webview.postMessage(message);
    }
    /**
     * 面板销毁时调用
     */
    onDispose() {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    /**
     * 释放资源
     */
    dispose() {
        this.panel?.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
exports.BaseWebviewProvider = BaseWebviewProvider;
//# sourceMappingURL=BaseWebviewProvider.js.map