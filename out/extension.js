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
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const WorkbenchProvider_1 = require("./providers/WorkbenchProvider");
const CsvBrowserProvider_1 = require("./providers/CsvBrowserProvider");
const CsvEditorProvider_1 = require("./providers/CsvEditorProvider");
const CsvDocumentProvider_1 = require("./providers/CsvDocumentProvider");
function getActiveFileUri() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab)
        return;
    const input = tab.input;
    if (input instanceof vscode.TabInputText)
        return input.uri;
    if (input instanceof vscode.TabInputCustom)
        return input.uri;
    return;
}
function isTestCaseFile(uri) {
    return uri.scheme === 'file' && /testcases?\.csv$/i.test(uri.fsPath);
}
function updateShowIcon() {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}
const processingFiles = new Set();
async function openWithCsvEditor(uri) {
    const fsPath = uri.fsPath;
    if (processingFiles.has(fsPath))
        return;
    processingFiles.add(fsPath);
    try {
        // 关闭当前编辑器
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise(resolve => setTimeout(resolve, 100));
        // 用自定义编辑器打开
        await vscode.commands.executeCommand('vscode.openWith', uri, 'csvEditor.testCase');
    }
    catch (e) {
        console.error('[CSV拦截] 切换编辑器失败:', e);
    }
    finally {
        processingFiles.delete(fsPath);
    }
}
function activate(context) {
    const workbenchProvider = new WorkbenchProvider_1.WorkbenchProvider(context.extensionUri, context);
    const csvBrowserProvider = new CsvBrowserProvider_1.CsvBrowserProvider(context.extensionUri, context);
    const csvEditorProvider = new CsvEditorProvider_1.CsvEditorProvider(context.extensionUri);
    // 注册自定义CSV编辑器
    context.subscriptions.push(vscode.window.registerCustomEditorProvider('csvEditor.testCase', csvEditorProvider));
    // 监听标签页打开
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(async (e) => {
        for (const tab of e.opened) {
            const input = tab.input;
            let uri;
            if (input instanceof vscode.TabInputText) {
                uri = input.uri;
            }
            else if (input instanceof vscode.TabInputCustom) {
                uri = input.uri;
            }
            if (uri && (0, CsvDocumentProvider_1.isQualifiedCsvFile)(uri)) {
                console.log('[CSV拦截] 标签页打开CSV:', uri.fsPath);
                await openWithCsvEditor(uri);
            }
        }
    }));
    // 监听活动编辑器变化
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor) {
            const uri = editor.document.uri;
            console.log('[CSV拦截] 活动编辑器变化:', uri.fsPath);
            if ((0, CsvDocumentProvider_1.isQualifiedCsvFile)(uri)) {
                await openWithCsvEditor(uri);
            }
        }
        updateShowIcon();
    }));
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(updateShowIcon), vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
        const uri = getActiveFileUri();
        if (uri) {
            const { TestCaseWebviewProvider } = await Promise.resolve().then(() => __importStar(require('./providers/TestCaseProvider')));
            const testcaseProvider = new TestCaseWebviewProvider(context.extensionUri, context);
            await testcaseProvider.showWebview(uri);
        }
    }), vscode.commands.registerCommand('workbench.open', () => workbenchProvider.show()), vscode.commands.registerCommand('csvBrowser.open', () => csvBrowserProvider.show()), vscode.commands.registerCommand('csvEditor.open', async () => {
        const uri = getActiveFileUri();
        if (uri && /\.csv$/i.test(uri.fsPath)) {
            await openWithCsvEditor(uri);
        }
    }));
    updateShowIcon();
    // 插件激活时显示工作台
    try {
        workbenchProvider.show();
    }
    catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }
}
//# sourceMappingURL=extension.js.map