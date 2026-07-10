/**
 * ============================================================================
 *  providers/YamlFixProvider.ts
 *  YAML 格式快速修复（Quick Fix / CodeAction）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 注册为 yaml/yml 文件的 CodeActionProvider。
 *    2. 检测当前行的 Diagnostic 是否为 YAML 格式问题。
 *    3. 提供单行修复 + 全部修复两个 CodeAction。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { getFixForLine, getAllFixes, getYamlDiagnosticsCollection } from '../utils/yamlValidator';

/** YAML 格式校验的 Diagnostic source 名称 */
const YAML_SOURCE = 'YAML 格式';
/** 修复上报命令 ID */
const FIX_REPORT_COMMAND = 'workbench.reportYamlFix';
/** 分批修复全部命令 ID */
const FIX_ALL_COMMAND = 'workbench.yamlFixAll';

export class YamlFixProvider implements vscode.CodeActionProvider {

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // ── 筛选当前行的 YAML 格式 Diagnostic ──
        const yamlDiagnostics = context.diagnostics.filter(
            (d) => d.source === YAML_SOURCE,
        );

        if (yamlDiagnostics.length === 0) {
            return actions;
        }

        // ── 1. 逐行修复：一个 Diagnostic 对应一条修复 ──
        for (const diagnostic of yamlDiagnostics) {
            const line = diagnostic.range.start.line + 1; // 1-based
            const fixLine = getFixForLine(document.uri, line);
            if (!fixLine) { continue; }

            // 去掉 "第 N 行：" 前缀，用 \n 换行以便 Quick Fix 菜单完整显示
            const cleanMsg = diagnostic.message
                .replace(/^第\s*\d+\s*行\s*[：:]\s*/, '')
                .replace(/[，。]\s*如需.*$/, '');
            const action = new vscode.CodeAction(
                `🔧 第 ${line} 行\n${cleanMsg}`,
                vscode.CodeActionKind.QuickFix,
            );
            action.diagnostics = [diagnostic];
            action.edit = new vscode.WorkspaceEdit();
            const fullLineRange = new vscode.Range(line - 1, 0, line - 1, document.lineAt(line - 1).text.length);
            action.edit.replace(document.uri, fullLineRange, fixLine);
            action.command = { command: FIX_REPORT_COMMAND, title: '', arguments: [1] };
            action.isPreferred = true;

            actions.push(action);
        }

        // ── 2. "全部修复"：通过命令分批执行，避免超大 WorkspaceEdit 被 VS Code 丢弃 ──
        // 以当前文件 Diagnostics 覆盖的行号为准，过滤 fixDataStore 中的过时数据
        const allDiagnostics = getYamlDiagnosticsCollection().get(document.uri) || [];
        const diagnosticLines = new Set(allDiagnostics.map(d => d.range.start.line + 1));
        const allFixes = getAllFixes(document.uri).filter(f => diagnosticLines.has(f.line));
        console.log('[YAML-Fix] provideCodeActions', {
            documentUri: document.uri.toString(),
            documentFsPath: document.uri.fsPath,
            yamlDiagCount: yamlDiagnostics.length,
            allDiagCount: allDiagnostics.length,
            diagLines: Array.from(diagnosticLines).sort((a, b) => a - b),
            allFixesCount: allFixes.length,
        });
        if (allFixes.length > 1) {
            const fixAllAction = new vscode.CodeAction(
                `🔧 修复全部\n共 ${allFixes.length} 处格式问题（分批执行）`,
                vscode.CodeActionKind.QuickFix,
            );
            fixAllAction.diagnostics = yamlDiagnostics;
            // 不设 edit，纯 command 模式：由命令内部用 editor.edit() 分批应用修复
            fixAllAction.command = { command: FIX_ALL_COMMAND, title: '分批修复全部', arguments: [document.uri] };
            fixAllAction.isPreferred = false;

            actions.push(fixAllAction);
            console.log('[YAML-Fix] 已添加"修复全部" CodeAction, allFixesDetails:', allFixes);
        } else if (allFixes.length <= 1) {
            console.log('[YAML-Fix] 修复数量不足，未添加"修复全部"按钮 (allFixes.length=', allFixes.length, ')');
        }

        return actions;
    }
}
