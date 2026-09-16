import * as vscode from 'vscode';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';

// 埋点 props 构造器（telemetryErrProps / telemetryTsIdListProps /
// caseDeletionTelemetryProps / syncDeletedResultTelemetryProps）已收敛到
// telemetryProps 纯模块（无 vscode 依赖，便于 pointCaseDeleter / http 等底层
// 模块复用且不影响单测）。此处再导出以保持既有 import 路径兼容。
export * from './telemetryProps';

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
