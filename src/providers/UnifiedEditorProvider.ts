/**
 * ============================================================================
 *  providers/UnifiedEditorProvider.ts
 *  统一的测试案例编辑器实现（唯一子类）
 * ----------------------------------------------------------------------------
 *  职责：
 *    - FileTypeChecker：根据后缀识别文件类型，校验是否处于合规目录下。
 *    - UnifiedEditorProvider：继承 BaseEditorProvider，复用 PushViaHttpClient。
 *  与 BaseEditorProvider 的职责边界：
 *    - 本文件仅负责「说明为什么这个文件能被打开」，不介入 webview 生命周期。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { BaseEditorProvider, PushViaHttpClient, PushStrategy, isInQualifiedDir, FILE_PATTERNS } from './BaseEditorProvider';
import type { FileType } from '../parsers';
import { isInTempFolder, explainUnqualified } from '../services/utils';

// ============================================
// 文件类型检查器
// ============================================

/**
 * 将文件绝对路径转换为「相对打开的工作区文件夹」的路径。
 * 目录合规判定严格从工作区根起算（第 1 层=测试任务、第 2 层=任务名、第 3 层=测试案例），
 * 因此必须先剥掉工作区根以上的目录——例如工作区为 C001_测试 时，其上层父目录恰叫「测试任务」
 * （/Users/liujia/yyy/测试任务/C001_测试/...），该父目录不属于当前项目，必须整体排除，
 * 不能参与层级匹配，否则会把第 1 层错算到父目录的「测试任务」上。
 * vscode.workspace.asRelativePath 始终返回正斜杠路径；文件不在任何工作区时回退为原绝对路径。
 */
function toWorkspaceRelativePath(filePath: string): string {
    return vscode.workspace.asRelativePath(filePath, false);
}

export class FileTypeChecker {
    /**
     * 检查文件是否合格，并识别其类型。
     * 合规判定基于「相对打开的工作区文件夹」的路径（见 toWorkspaceRelativePath），
     * 层级严格锚定在工作区根：第 1 层=测试任务、第 2 层=任务名、第 3 层=测试案例。
     * 注意：此锚定规则比资源管理器右键菜单的 when 正则更严格，二者在嵌套同名「测试任务」目录下可能不一致。
     */
    static isQualifiedFile(uri: vscode.Uri): { qualified: boolean; type: FileType | null } {
        const filePath = uri.fsPath.toLowerCase();
        const relPath = toWorkspaceRelativePath(uri.fsPath);

        if (filePath.endsWith('.csv')) {
            return { qualified: isInQualifiedDir(relPath, FILE_PATTERNS.CSV), type: 'csv' };
        }
        if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            return { qualified: isInQualifiedDir(relPath, FILE_PATTERNS.YAML), type: 'yaml' };
        }
        if (filePath.endsWith('.json')) {
            return { qualified: isInQualifiedDir(relPath, FILE_PATTERNS.JSON), type: 'json' };
        }

        return { qualified: false, type: null };
    }

    static getTypeName(type: FileType): string {
        switch (type) {
            case 'csv': return 'CSV';
            case 'yaml': return 'YAML';
            case 'json': return 'JSON';
        }
    }

    static getErrorMessage(type: FileType | null, filePath?: string): string {
        // 临时文件夹内的文件：给出明确排除原因，避免与「目录不合规」混淆。
        if (type && filePath && isInTempFolder(filePath)) {
            return '该文件位于「临时文件夹」中，不识别为测试案例，不支持案例编辑器展示与推送。';
        }
        if (!type) return '该文件类型无法识别为测试案例';
        const typeName = FileTypeChecker.getTypeName(type);
        // filePath 为「相对打开的工作区根目录」的路径，据此给出清晰的层级排查说明。
        return explainUnqualified(filePath || '', typeName);
    }
}

// ============================================
// 统一编辑器 Provider（无状态，每个 panel 由 Base 维护独立 session）
// ============================================

export class UnifiedEditorProvider extends BaseEditorProvider {
    protected pushStrategy: PushStrategy = new PushViaHttpClient();

    protected formatTypeName(type: FileType): string {
        return FileTypeChecker.getTypeName(type);
    }

    protected getErrorMessage(type: FileType | null, filePath?: string): string {
        return FileTypeChecker.getErrorMessage(type, filePath);
    }

    protected resolveFile(uri: vscode.Uri): { qualified: boolean; type: FileType | null } {
        return FileTypeChecker.isQualifiedFile(uri);
    }
}