import * as vscode from 'vscode';
import * as fs from 'fs';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export class WorkbenchProvider {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private extensionUri: vscode.Uri,
        private context: vscode.ExtensionContext
    ) {}

    show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'workbench',
            '工作台',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'media')
                ]
            }
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables
        );

        this.panel.webview.html = this.getHtmlContent();
    }

    private handleMessage(msg: any): void {
        switch (msg.command) {
            case 'openTestTask':
                vscode.window.showInformationMessage(`打开测试任务: ${msg.taskName || msg.taskId}`);
                break;
            case 'openTestCase':
                vscode.window.showInformationMessage('打开测试案例管理');
                break;
            case 'openExecution':
                vscode.window.showInformationMessage('打开执行管理');
                break;
            case 'openDefect':
                vscode.window.showInformationMessage('打开缺陷管理');
                break;
            case 'openReview':
                vscode.window.showInformationMessage('打开评审管理');
                break;
            case 'openReport':
                vscode.window.showInformationMessage('打开测试报告');
                break;
            case 'openTaskList':
                vscode.window.showInformationMessage('打开测试任务列表');
                break;
            case 'navigate':
                vscode.commands.executeCommand(msg.commandId || '').then(() => {}, () => {});
                break;
        }
    }

    private getHtmlContent(): string {
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'index.html');
        try {
            const nonce = getNonce();
            let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
            html = html.replace(/\$\{nonce\}/g, nonce);
            html = html.replace(/\$\{scriptUri\}/g, this.panel!.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'main.js')
            ).toString());
            return html;
        } catch {
            return this.getFallbackHtml();
        }
    }

    private getFallbackHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>工作台</title></head>
<body style="padding:20px;font-family:sans-serif;color:#333;">
<h2>工作台</h2>
<p style="color:#999;">工作台页面正在开发中...</p>
</body></html>`;
    }

    private dispose(): void {
        this.panel = undefined;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}
