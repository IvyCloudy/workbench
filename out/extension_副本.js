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
const TestCaseProvider_1 = require("./providers/TestCaseProvider");
const WorkbenchProvider_1 = require("./providers/WorkbenchProvider");
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
function activate(context) {
    const testcaseProvider = new TestCaseProvider_1.TestCaseWebviewProvider(context.extensionUri, context);
    const workbenchProvider = new WorkbenchProvider_1.WorkbenchProvider(context.extensionUri, context);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateShowIcon), vscode.window.tabGroups.onDidChangeTabs(updateShowIcon));
    context.subscriptions.push(vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
        const uri = getActiveFileUri();
        if (!uri)
            return;
        await testcaseProvider.showWebview(uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('workbench.open', () => {
        workbenchProvider.show();
    }));
    updateShowIcon();
    try {
        workbenchProvider.show();
    }
    catch (err) {
        console.error('WorkbenchProvider.show() failed:', err);
    }
}
//# sourceMappingURL=extension_%E5%89%AF%E6%9C%AC.js.map