import * as vscode from 'vscode';
import { getActiveFileUri, isTestCaseFile, telemetryErrProps } from '../utils/extensionHelpers';
import { TelemetryService } from '../utils/telemetry';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

export function registerEditorCommands(
    _context: vscode.ExtensionContext,
    extPattern: RegExp
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('testcaseViewer.openWithEditor', async () => {
            const uri = getActiveFileUri();
            if (!uri || !extPattern.test(uri.fsPath)) {
                TelemetryService.sendTelemetryEvent('command.aborted', { command: 'testcaseViewer.openWithEditor', reason: 'noActiveFileOrExt' });
                return;
            }
            if (!isTestCaseFile(uri)) {
                TelemetryService.sendTelemetryEvent('command.aborted', { command: 'testcaseViewer.openWithEditor', reason: 'notTestCaseFile' });
                return;
            }
            TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.openWithEditor' });
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, TESTCASE_EDITOR_VIEWTYPE);
            } catch (err: any) {
                TelemetryService.sendTelemetryErrorEvent('command.openWithEditor.error', telemetryErrProps(err));
                throw err;
            }
        }),
        vscode.commands.registerCommand('testcaseViewer.openWithText', async () => {
            const uri = getActiveFileUri();
            if (!uri || !extPattern.test(uri.fsPath)) {
                TelemetryService.sendTelemetryEvent('command.aborted', { command: 'testcaseViewer.openWithText', reason: 'noActiveFileOrExt' });
                return;
            }
            TelemetryService.sendTelemetryEvent('command.executed', { command: 'testcaseViewer.openWithText' });
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            } catch (err: any) {
                TelemetryService.sendTelemetryErrorEvent('command.openWithText.error', telemetryErrProps(err));
                throw err;
            }
        })
    ];
}
