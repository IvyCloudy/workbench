/**
 * ============================================================================
 *  providers/WorkbenchProvider.ts
 *  「工作台」Webview（插件首页）
 * ----------------------------------------------------------------------------
 *  职责：提供一个总入口页面，列出各业务模块入口（测试任务/案例/执行/缺陷/评审/报告）。
 *  当前状态：各子功能还是占位 Toast，待后续补齐具体跳转逻辑。
 * ============================================================================
 */
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
        }
    };
}
