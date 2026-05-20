import * as vscode from 'vscode';
import { BaseWebviewProvider, type MessageHandler } from './BaseWebviewProvider';
import type { WebviewMessage } from '../types';

// ============================================
// 工作台 Provider
// ============================================

export class WorkbenchProvider extends BaseWebviewProvider {
    protected getPanelId(): string { return 'workbench'; }
    protected getPanelTitle(): string { return '工作台'; }
    protected getViewColumn(): vscode.ViewColumn { return vscode.ViewColumn.One; }
    protected getHtmlPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'index.html');
    }
    protected getScriptPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'main.js');
    }

    protected handleMessage: MessageHandler = (msg: WebviewMessage) => {
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
    };
}
