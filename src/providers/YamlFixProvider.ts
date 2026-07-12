/**
 * ============================================================================
 *  providers/YamlFixProvider.ts
 *  YAML 格式快速修复（Quick Fix / CodeAction）
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 注册为 yaml/yml 文件的 CodeActionProvider。
 *    2. 为每一条 YAML Diagnostic 生成对应的 Quick Fix（支持同行多个）。
 *    3. 在灯泡菜单里直接暴露批量修复入口（无任何顶部下拉 / 二级弹窗，一次点击即执行）：
 *         · YAML · 修复选中范围（仅在跨行选区、选区内可修复 ≥ 2 且 < 全量时）
 *         · YAML · 修复所有 error（仅在存在 error 级可修复时出现）
 *         · YAML · 修复全部（只要有 fix 就出现）
 *       为了让「修复所有 error」在视觉上从属于「修复全部」的"二级选项"，
 *       标题前缀用一层缩进符号 └ 表现层级关系（灯泡菜单本身不支持真正嵌套子菜单）。
 *    4. QuickPick 智能选择器（fixPick）作为兜底保留：仅当选区过大导致
 *       逐行项被隐藏时，才追加一个"更多修复操作..."入口；同时它仍通过
 *       状态栏、右键菜单、命令面板暴露，供用户按习惯触发。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { getFixesForLine, getAllFixes, getYamlDiagnosticsCollection, isCascadeFallbackFix } from '../utils/yamlValidator';
import {
    YAML_DIAGNOSTIC_SOURCE,
    YAML_CMD_REPORT_FIX,
    YAML_CMD_FIX_ALL,
    YAML_CMD_FIX_ALL_ERRORS,
    YAML_CMD_FIX_RANGE,
    YAML_CMD_FIX_PICK,
} from '../utils/yamlConstants';
import { createLogger } from '../utils/logger';

const log = createLogger('YAML');

export class YamlFixProvider implements vscode.CodeActionProvider {

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
    ): vscode.CodeAction[] {
        // 选区行范围（1-based），用于"更多修复操作"上下文
        const startLine = range.start.line + 1;
        const endLine = range.end.line + 1;
        const selectionSpansMultipleLines = endLine > startLine;

        // ── 快速短路：无 diagnostics 且选区未跨行 → 无事可做 ──
        if (context.diagnostics.length === 0 && !selectionSpansMultipleLines) return [];

        const yamlDiagnostics = context.diagnostics.filter(
            (d) => d.source === YAML_DIAGNOSTIC_SOURCE,
        );
        if (yamlDiagnostics.length === 0 && !selectionSpansMultipleLines) return [];

        const actions: vscode.CodeAction[] = [];
        // "更多修复操作"入口先收集到 headActions，最后合并到 actions 最前
        const headActions: vscode.CodeAction[] = [];

        // ── 1. 逐行修复：一条 Diagnostic 对应一条 CodeAction ──
        //
        // 【级联兜底 fix 的降级】
        //   级联兜底 fix 指 `# [indent mismatch] / [unparseable]` 两类——它们的根因
        //   通常在**其他行**，若用户在单行菜单点了这类 fix，会直接把当前行注释掉。
        //   → 标题上标注告警且非首选。
        //
        //   注：`# [duplicate key removed]` **不属于级联兜底**——本行注释化即为正确修复。
        //
        // 【大选区压缩】
        //   若选区跨多行、且选区内可修复行数 >= PER_LINE_ACTION_THRESHOLD（20），逐行 QuickFix
        //   会淹没菜单。此时跳过逐行展开，只保留"更多修复操作"入口。
        const PER_LINE_ACTION_THRESHOLD = 20;
        const linesWithFixInSelection = selectionSpansMultipleLines
            ? new Set(
                yamlDiagnostics
                    .map(d => d.range.start.line + 1)
                    .filter(ln => ln >= startLine && ln <= endLine),
            ).size
            : 0;
        const suppressPerLine =
            selectionSpansMultipleLines && linesWithFixInSelection >= PER_LINE_ACTION_THRESHOLD;

        const perLineFixIndex = new Map<number, number>(); // line -> 已消费到的 fix 索引
        if (!suppressPerLine) {
            for (const diagnostic of yamlDiagnostics) {
                const line = diagnostic.range.start.line + 1;
                const fixes = getFixesForLine(document.uri, line);
                const consumed = perLineFixIndex.get(line) ?? 0;
                if (consumed >= fixes.length) continue;
                const fixLine = fixes[consumed];
                perLineFixIndex.set(line, consumed + 1);

                const cascadeFallback = isCascadeFallbackFix(fixLine);
                const shortTitle = extractShortTitle(diagnostic.message);
                // 统一视觉：所有条目都以「YAML · 第 N 行 · 短标题」格式呈现，与 QuickPick 对齐
                const sevTag = severityTag(diagnostic.severity);
                const title = cascadeFallback
                    ? `YAML · 第 ${line} 行 · ${shortTitle}（${sevTag}·⚠ 会注释化整行，建议改用『更多修复操作...』）`
                    : `YAML · 第 ${line} 行 · ${shortTitle}（${sevTag}）`;
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.edit = new vscode.WorkspaceEdit();
                const fullLineRange = new vscode.Range(
                    line - 1, 0,
                    line - 1, document.lineAt(line - 1).text.length,
                );
                action.edit.replace(document.uri, fullLineRange, fixLine);
                action.command = { command: YAML_CMD_REPORT_FIX, title: '', arguments: [1] };
                action.isPreferred = !cascadeFallback;
                actions.push(action);
            }
        }

        // ── 2. 批量修复入口：直接在灯泡菜单里平铺 CodeAction，一次点击即执行 ──
        //   用户明确不要顶部下拉 QuickPick。因此批量入口全部打平为可直接点击的
        //   CodeAction，各自绑定 fixAll / fixAllErrors / fixRange 命令。
        //
        //   显示规则：
        //     · 修复选中范围：**仅**在跨行选区、且选区内可修复 >=2 且 < 全量时出现
        //     · 修复所有 error：**仅**在有 error 级可修复时出现
        //         → 标题以「└ 仅修复 error」缩进显示，视觉上作为「修复全部」的二级选项
        //     · 修复全部：**永久**出现（只要 allFixes >=1）
        //
        //   注：fixPick QuickPick 入口仅在「大选区隐藏逐行项」场景兜底暴露
        //   （见下方 suppressPerLine 分支），并继续通过状态栏 / 右键菜单 / 命令面板暴露。
        const allDiagnostics = getYamlDiagnosticsCollection().get(document.uri) || [];
        const diagnosticLines = new Set(allDiagnostics.map(d => d.range.start.line + 1));
        const allFixes = getAllFixes(document.uri).filter(f => diagnosticLines.has(f.line));

        log.debug('provideCodeActions', {
            documentUri: document.uri.toString(),
            yamlDiagCount: yamlDiagnostics.length,
            allDiagCount: allDiagnostics.length,
            allFixesCount: allFixes.length,
            selection: `${startLine}~${endLine}`,
            suppressPerLine,
        });

        if (allFixes.length >= 1) {
            // 同行多条 diagnostic 取最严重级
            const lineSev = new Map<number, vscode.DiagnosticSeverity>();
            for (const d of allDiagnostics) {
                const ln = d.range.start.line + 1;
                const prev = lineSev.get(ln);
                if (prev === undefined || d.severity < prev) lineSev.set(ln, d.severity);
            }
            const errFix = allFixes.filter(f => lineSev.get(f.line) === vscode.DiagnosticSeverity.Error).length;
            const warnFix = allFixes.filter(f => lineSev.get(f.line) === vscode.DiagnosticSeverity.Warning).length;

            // 2a. 修复选中范围（仅在跨行选区、且选区内可修复 >=2 且 < 全量时）
            if (selectionSpansMultipleLines) {
                const rangeFixCount = allFixes.filter(f => f.line >= startLine && f.line <= endLine).length;
                if (rangeFixCount >= 2 && rangeFixCount < allFixes.length) {
                    const rangeAction = new vscode.CodeAction(
                        `YAML · 修复选中范围（第 ${startLine}~${endLine} 行 · ${rangeFixCount} 处）`,
                        vscode.CodeActionKind.QuickFix,
                    );
                    rangeAction.diagnostics = yamlDiagnostics;
                    rangeAction.command = {
                        command: YAML_CMD_FIX_RANGE,
                        title: '修复选中范围',
                        arguments: [document.uri, startLine, endLine],
                    };
                    rangeAction.isPreferred = false;
                    headActions.push(rangeAction);
                }
            }

            // 2b. 修复全部（永久提供；作为父项排在前）
            const allSubParts: string[] = [`${allFixes.length} 处`];
            if (errFix > 0) allSubParts.push(`error ${errFix}`);
            if (warnFix > 0) allSubParts.push(`warning ${warnFix}`);
            const allAction = new vscode.CodeAction(
                `YAML · 修复全部（${allSubParts.join(' · ')}）`,
                vscode.CodeActionKind.QuickFix,
            );
            allAction.diagnostics = yamlDiagnostics;
            allAction.command = {
                command: YAML_CMD_FIX_ALL,
                title: '修复全部',
                arguments: [document.uri],
            };
            allAction.isPreferred = false;
            headActions.push(allAction);

            // 2c. 修复所有 error（仅在有 error 级可修复时；标题缩进以呈现"二级"视觉）
            //   灯泡菜单本身不支持真正的嵌套子菜单，用「└ 」前缀让其视觉上贴附在
            //   上一条「修复全部」下方，作为其"仅 error"版本的快捷入口。
            if (errFix > 0) {
                const errAction = new vscode.CodeAction(
                    `YAML ·   └ 仅修复 error（${errFix} 处${warnFix > 0 ? `，保留 warning ${warnFix} 处不变` : ''}）`,
                    vscode.CodeActionKind.QuickFix,
                );
                errAction.diagnostics = yamlDiagnostics;
                errAction.command = {
                    command: YAML_CMD_FIX_ALL_ERRORS,
                    title: '仅修复 error',
                    arguments: [document.uri],
                };
                errAction.isPreferred = false;
                headActions.push(errAction);
            }

            // 2d. 大选区兜底：若隐藏了逐行项，再挂一个 QuickPick 入口方便用户拿到更细粒度的选择
            if (suppressPerLine) {
                const pickAction = new vscode.CodeAction(
                    `YAML · 更多修复操作...（大选区已隐藏逐行项）`,
                    vscode.CodeActionKind.QuickFix,
                );
                pickAction.diagnostics = yamlDiagnostics;
                pickAction.command = {
                    command: YAML_CMD_FIX_PICK,
                    title: '更多修复操作',
                    arguments: [document.uri],
                };
                pickAction.isPreferred = false;
                headActions.push(pickAction);
            }
        }

        // ── 3. 批量入口置顶：headActions 拼在 actions 最前面 ──
        return [...headActions, ...actions];
    }
}

/**
 * 从完整的 diagnostic.message 里剥离 "第 N 行：" 前缀 + 尾部"如需..."提示，
 * 得到适合 Quick Fix 菜单的简短标题。
 */
function extractShortTitle(msg: string): string {
    return msg
        .replace(/^第\s*\d+\s*行\s*[：:]\s*/, '')
        .replace(/[，。]\s*如需.*$/, '')
        .replace(/^YAML\s*(解析错误|解析警告|格式错误)\s*\(第\s*\d+\s*行\)\s*[：:]\s*/, '$1: ')
        .trim();
}

/**
 * 严重级中文标签：与 QuickPick description 中的字样保持一致。
 *   Error   → error   Warning → warning   Information → info   Hint → hint
 */
function severityTag(sev: vscode.DiagnosticSeverity | undefined): string {
    switch (sev) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'info';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return '';
    }
}
