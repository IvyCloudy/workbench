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
function activate(context) {
    const provider = new TestCaseProvider_1.TestCaseWebviewProvider(context.extensionUri, context);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        const isMatch = editor && editor.document.uri.scheme === 'file' &&
            /testcases?\.csv$/i.test(editor.document.uri.fsPath);
        vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!isMatch);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testcaseViewer.viewOnline', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        await provider.showWebview(editor.document.uri);
    }));
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const isMatch = editor.document.uri.scheme === 'file' &&
            /testcases?\.csv$/i.test(editor.document.uri.fsPath);
        vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!isMatch);
    }
}
//# sourceMappingURL=extension.js.map