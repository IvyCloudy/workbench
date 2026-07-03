import * as vscode from 'vscode';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';
import { stackHead } from '../services/utils';

/** 构造遥测错误上报所需的公共字段 */
export function telemetryErrProps(err: any, extras?: Record<string, string>): Record<string, string> {
    return {
        errorMessage: String(err?.message || String(err)).slice(0, 500),
        stackHead: stackHead(err),
        ...extras,
    };
}

export function getActiveFileUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) return undefined;

    const input = tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.original;
    return undefined;
}

export function isTestCaseFile(uri: vscode.Uri): boolean {
    return FileTypeChecker.isQualifiedFile(uri).qualified;
}

export function updateShowIcon(): void {
    const uri = getActiveFileUri();
    vscode.commands.executeCommand('setContext', 'testcaseViewer:showIcon', !!uri && isTestCaseFile(uri));
}
