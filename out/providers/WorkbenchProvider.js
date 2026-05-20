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
exports.WorkbenchProvider = void 0;
const vscode = __importStar(require("vscode"));
const BaseWebviewProvider_1 = require("./BaseWebviewProvider");
// ============================================
// 工作台 Provider
// ============================================
class WorkbenchProvider extends BaseWebviewProvider_1.BaseWebviewProvider {
    constructor() {
        super(...arguments);
        this.handleMessage = (msg) => {
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
                    vscode.commands.executeCommand(msg.commandId || '').then(() => { }, () => { });
                    break;
            }
        };
    }
    getPanelId() { return 'workbench'; }
    getPanelTitle() { return '工作台'; }
    getViewColumn() { return vscode.ViewColumn.One; }
    getHtmlPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'index.html');
    }
    getScriptPath() {
        return vscode.Uri.joinPath(this.extensionUri, 'media', 'pages', 'workbench', 'main.js');
    }
}
exports.WorkbenchProvider = WorkbenchProvider;
//# sourceMappingURL=WorkbenchProvider.js.map