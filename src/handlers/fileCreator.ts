import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { markAsCreatedByCommand } from '../utils/fileIdentifier';
import { sendTelemetryEvent, sendTelemetryErrorEvent } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';
import { showToast } from '../utils/message';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/**
 * 公共：创建文件并触发资源管理器重命名（inline edit）+ 超时兜底
 */
async function createFileAndTriggerRename(
    filePath: string,
    content: string,
    onComplete: (finalUri: vscode.Uri) => Promise<void>,
    extraAction?: (filePath: string) => void,
): Promise<void> {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    extraAction?.(filePath);

    const newFileUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('revealInExplorer', newFileUri);
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('renameFile');

    const renameDisposable = vscode.workspace.onDidRenameFiles(async (event) => {
        for (const file of event.files) {
            if (file.oldUri.fsPath === filePath) {
                renameDisposable.dispose();
                await onComplete(file.newUri);
                break;
            }
        }
    });

    setTimeout(async () => {
        if (fs.existsSync(filePath)) {
            await onComplete(newFileUri);
        }
        renameDisposable.dispose();
    }, 30000);
}

/**
 * 使用插件编辑器打开文件
 */
async function openWithPluginEditor(fileUri: vscode.Uri, _originalFileName: string): Promise<void> {
    try {
        await vscode.commands.executeCommand('vscode.openWith', fileUri, TESTCASE_EDITOR_VIEWTYPE);

        const fileName = path.basename(fileUri.fsPath);
        showToast(undefined, 'success', `测试案例 ${fileName} 创建成功`);
        sendTelemetryEvent('createNewTestCase.success', {
            fileName: fileName,
            fileType: path.extname(fileName)
        });
    } catch (err: any) {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            sendTelemetryErrorEvent('createNewTestCase.openEditor.failed', telemetryErrProps(err));
        } catch (fallbackErr: any) {
            showToast(undefined, 'error', `打开文件失败: ${fallbackErr.message || fallbackErr}`);
        }
    }
}

/**
 * 资源管理器右键「新增测试案例」入口
 */
export async function handleCreateNewTestCase(
    targets: vscode.Uri[],
    context: vscode.ExtensionContext,
    forcedExt?: string,
): Promise<void> {
    if (!targets || targets.length === 0) return;

    const target = targets[0];
    const targetPath = target.fsPath;

    const stats = await fs.promises.stat(targetPath);
    let baseDir = targetPath;
    if (stats.isFile()) {
        baseDir = path.dirname(targetPath);
    }

    if (!baseDir.includes('测试案例')) {
        showToast(undefined, 'warning', '只能在测试案例目录或其子文件夹中创建新测试案例');
        return;
    }

    let chosenExt: string;
    if (forcedExt) {
        chosenExt = forcedExt;
    } else {
        const fileTypePick = await vscode.window.showQuickPick(
            [
                { label: '$(file) CSV (.csv)', description: '表格格式，推荐用于结构化案例', extension: '.csv' },
                { label: '$(file) YAML (.yaml)', description: '层次化格式，适合复杂步骤描述', extension: '.yaml' },
            ],
            { placeHolder: '请选择测试案例文件格式', ignoreFocusOut: true }
        );
        if (!fileTypePick) return;
        chosenExt = fileTypePick.extension;
    }

    let defaultFileName = `未命名测试案例${chosenExt}`;
    let defaultFilePath = path.join(baseDir, defaultFileName);
    let counter = 1;
    while (fs.existsSync(defaultFilePath)) {
        defaultFileName = `未命名测试案例${counter}${chosenExt}`;
        defaultFilePath = path.join(baseDir, defaultFileName);
        counter++;
    }

    let templateContent: string;
    try {
        if (chosenExt === '.csv') {
            const csvTemplatePath = path.join(context.extensionUri.fsPath, 'examples', 'case_example.csv');
            templateContent = await fs.promises.readFile(csvTemplatePath, 'utf-8');
        } else {
            const yamlTemplatePath = path.join(context.extensionUri.fsPath, 'examples', 'case_example.yaml');
            templateContent = await fs.promises.readFile(yamlTemplatePath, 'utf-8');
        }
    } catch (err: any) {
        showToast(undefined, 'error', `读取模板文件失败: ${err.message || err}`);
        return;
    }

    try {
        await createFileAndTriggerRename(
            defaultFilePath,
            templateContent,
            async (finalUri) => {
                await openWithPluginEditor(finalUri, path.basename(finalUri.fsPath));
            },
            (fp) => markAsCreatedByCommand(fp),
        );
    } catch (err: any) {
        showToast(undefined, 'error', `创建测试案例失败: ${err.message || err}`);
        sendTelemetryErrorEvent('createNewTestCase.error', telemetryErrProps(err));
    }
}

/**
 * 新增测试要点 - 在测试大纲目录下创建 测试要点.md
 */
export async function handleCreateNewTestPoint(
    targets: vscode.Uri[],
    context: vscode.ExtensionContext,
): Promise<void> {
    if (!targets || targets.length === 0) return;

    const target = targets[0];
    const targetPath = target.fsPath;

    const stats = await fs.promises.stat(targetPath);
    let baseDir = targetPath;
    if (stats.isFile()) {
        baseDir = path.dirname(targetPath);
    }

    if (!baseDir.includes('测试大纲')) {
        showToast(undefined, 'warning', '只能在测试大纲目录或其子文件夹中创建新测试要点');
        return;
    }

    let defaultFileName = '测试要点.md';
    let defaultFilePath = path.join(baseDir, defaultFileName);
    let counter = 1;
    while (fs.existsSync(defaultFilePath)) {
        defaultFileName = `测试要点${counter}.md`;
        defaultFilePath = path.join(baseDir, defaultFileName);
        counter++;
    }

    const templatePath = path.join(context.extensionUri.fsPath, 'examples', 'point_example.md');
    let templateContent: string;
    try {
        templateContent = await fs.promises.readFile(templatePath, 'utf-8');
    } catch (err: any) {
        showToast(undefined, 'error', `读取模板文件失败: ${err.message || err}`);
        return;
    }

    try {
        await createFileAndTriggerRename(
            defaultFilePath,
            templateContent,
            async (finalUri) => {
                await vscode.commands.executeCommand('vscode.open', finalUri);
            },
        );
    } catch (err: any) {
        showToast(undefined, 'error', `创建测试要点失败: ${err.message || err}`);
    }
}
