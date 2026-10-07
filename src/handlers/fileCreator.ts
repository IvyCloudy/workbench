import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { markAsCreatedByCommand } from '../utils/fileIdentifier';
import { TelemetryService } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';
import { showToast } from '../utils/message';
import { FileTypeChecker } from '../providers/UnifiedEditorProvider';

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

    // 文件已创建，立刻触发完成回调（打开编辑器），不等重命名
    await onComplete(newFileUri);

    // 触发重命名（inline edit），让用户直接修改文件名
    await vscode.commands.executeCommand('revealInExplorer', newFileUri);
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('renameFile');

    // 重命名监听仅用于清理本地标记（extension.ts 全局 onDidRenameFiles 已处理 panelMap 同步）
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
            if (file.oldUri.fsPath === filePath) {
                renameDisposable.dispose();
                break;
            }
        }
    });

    // 超时兜底：30 秒后释放监听器
    setTimeout(() => {
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
        TelemetryService.sendTelemetryEvent('createNewTestCase.success', {
            fileName: fileName,
            fileType: path.extname(fileName)
        });
    } catch (err: any) {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document);
            TelemetryService.sendTelemetryErrorEvent('createNewTestCase.openEditor.failed', telemetryErrProps(err));
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

    // 严格的层级合规校验：复用 FileTypeChecker.isQualifiedFile（锚定工作区根的
    // 测试任务/<任务>/测试案例/ 三元组），避免历史 includes('测试案例') 的字符串匹配
    // 把嵌套错位路径（如 测试任务/测试任务/<任务>/测试案例/）误判为合格。
    // 构造探测 Uri：拼一个尚不存在的 .csv 假名喂给校验器，仅参与路径层级判断，不落盘。
    const probeUri = vscode.Uri.file(path.join(baseDir, '__probe__.csv'));
    const probe = FileTypeChecker.isQualifiedFile(probeUri);
    if (!probe.qualified) {
        showToast(undefined, 'warning', '只能在 测试任务/<任务文件夹>/测试案例/ 目录（或其子目录）下创建新测试案例');
        TelemetryService.sendTelemetryEvent('createNewTestCase.aborted', { reason: 'dirNotQualified' });
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
        TelemetryService.sendTelemetryErrorEvent('createNewTestCase.error', telemetryErrProps(err));
    }
}

/**
 * 新增测试要点 - 在测试大纲目录下创建 测试要点.md 或 测试要点.xmind
 */
export async function handleCreateNewTestPoint(
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

    if (!baseDir.includes('测试大纲')) {
        showToast(undefined, 'warning', '只能在测试大纲目录或其子文件夹中创建新测试要点');
        return;
    }

    // 格式选择（右键子菜单已指定格式时跳过弹窗）
    let chosenExt: string;
    if (forcedExt) {
        chosenExt = forcedExt;
    } else {
        const formatPick = await vscode.window.showQuickPick(
            [
                { label: '$(markdown) Markdown (.md)', description: '表格格式的测试要点文档', extension: '.md' },
                { label: '$(organization) XMind (.xmind)', description: '思维导图格式，适合脑图展示', extension: '.xmind' },
            ],
            { placeHolder: '请选择测试要点文件格式', ignoreFocusOut: true }
        );
        if (!formatPick) return;
        chosenExt = formatPick.extension;
    }

    let defaultFileName = `测试要点${chosenExt}`;
    let defaultFilePath = path.join(baseDir, defaultFileName);
    let counter = 1;
    while (fs.existsSync(defaultFilePath)) {
        defaultFileName = `测试要点${counter}${chosenExt}`;
        defaultFilePath = path.join(baseDir, defaultFileName);
        counter++;
    }

    try {
        if (chosenExt === '.xmind') {
            // XMind 格式：从模板文件复制
            const templatePath = path.join(context.extensionUri.fsPath, 'examples', 'point_example.xmind');
            let templateBuffer: Buffer;
            try {
                templateBuffer = await fs.promises.readFile(templatePath);
            } catch (err: any) {
                showToast(undefined, 'error', `读取 XMind 模板文件失败: ${err.message || err}`);
                TelemetryService.sendTelemetryErrorEvent('createNewTestPoint.templateReadFailed', { ...telemetryErrProps(err), fileType: '.xmind' });
                return;
            }
            await fs.promises.writeFile(defaultFilePath, templateBuffer);

            const newFileUri = vscode.Uri.file(defaultFilePath);
            await vscode.commands.executeCommand('vscode.open', newFileUri);
            await vscode.commands.executeCommand('revealInExplorer', newFileUri);
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('renameFile');
        } else {
            // Markdown 格式：使用模板创建
            const templatePath = path.join(context.extensionUri.fsPath, 'examples', 'point_example.md');
            let templateContent: string;
            try {
                templateContent = await fs.promises.readFile(templatePath, 'utf-8');
            } catch (err: any) {
                showToast(undefined, 'error', `读取模板文件失败: ${err.message || err}`);
                return;
            }

            await createFileAndTriggerRename(
                defaultFilePath,
                templateContent,
                async (finalUri) => {
                    await vscode.commands.executeCommand('vscode.open', finalUri);
                },
            );
        }

        TelemetryService.sendTelemetryEvent('createNewTestPoint.success', {
            fileName: defaultFileName,
            fileType: chosenExt,
        });
    } catch (err: any) {
        showToast(undefined, 'error', `创建测试要点失败: ${err.message || err}`);
        TelemetryService.sendTelemetryErrorEvent('createNewTestPoint.error', telemetryErrProps(err));
    }
}
