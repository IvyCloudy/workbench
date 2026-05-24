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

// ============================================
// 文件类型检查器
// ============================================

export class FileTypeChecker {
    /**
     * 检查文件是否合格，并识别其类型
     */
    static isQualifiedFile(uri: vscode.Uri): { qualified: boolean; type: FileType | null } {
        const filePath = uri.fsPath.toLowerCase();

        if (filePath.endsWith('.csv')) {
            return { qualified: isInQualifiedDir(uri.fsPath, FILE_PATTERNS.CSV), type: 'csv' };
        }
        if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            return { qualified: isInQualifiedDir(uri.fsPath, FILE_PATTERNS.YAML), type: 'yaml' };
        }
        if (filePath.endsWith('.json')) {
            return { qualified: isInQualifiedDir(uri.fsPath, FILE_PATTERNS.JSON), type: 'json' };
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

    static getErrorMessage(type: FileType | null): string {
        if (!type) return '该文件不在允许的目录下';
        const typeName = FileTypeChecker.getTypeName(type);
        const ext = type === 'yaml' ? '*.yaml 或 *.yml' : `*.${type.toLowerCase()}`;
        return `该 ${typeName} 文件不在允许的目录下，仅支持：测试任务/xxx/测试案例/${ext}`;
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

    protected getErrorMessage(type: FileType | null): string {
        return FileTypeChecker.getErrorMessage(type);
    }

    protected resolveFile(uri: vscode.Uri): { qualified: boolean; type: FileType | null } {
        return FileTypeChecker.isQualifiedFile(uri);
    }
}