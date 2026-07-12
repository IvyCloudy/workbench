/**
 * ============================================================================
 *  yamlPreOpenInterceptor.ts
 *  YAML CustomEditor Tab 前置拦截器
 * ----------------------------------------------------------------------------
 *  背景：当用户从 Problems 面板 / 资源管理器双击等入口打开一个 YAML 文件，
 *  由于 package.json 中 `testcaseViewer.unifiedEditor` 是该扩展名的默认
 *  CustomEditor，VS Code 会立即为其派单我们的编辑器（进入 resolveCustomEditor）。
 *  若此时 YAML 语法错误无法解析成表结构，用户会看到"空表 / 数据丢失"甚至
 *  过渡占位页。
 *
 *  更优做法：在 tab 一出现时（`onDidChangeTabs.opened`）就同步预检 YAML 内容，
 *  一旦发现不可解析 → 立即关掉 CustomEditor tab + 打开文本编辑器，
 *  用户完全看不到中间过渡页面。
 *
 *  与 BaseEditorProvider 内的兜底逻辑构成"双保险"：
 *   - 此处：Tab 打开事件（最早时机，用户零感知切换）
 *   - Base：resolveCustomEditor 内（若上面因异步/缓存等原因未拦到时的兜底）
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { validateYamlContent } from '../utils/yamlValidator';
import { markInterceptorHandled } from '../utils/yamlInterceptorState';
import { YAML_CMD_FIX_ALL } from '../utils/yamlConstants';
import { TelemetryService } from '../utils/telemetry';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

export function registerYamlPreOpenInterceptor(): vscode.Disposable {
    // 记录已处理过的 uri，避免因 openWith 触发新 tab 事件时二次拦截导致循环
    const processed = new WeakSet<vscode.Tab>();
    return vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.opened) {
            if (processed.has(tab)) continue;
            processed.add(tab);

            const input = tab.input as any;
            // 仅拦截 CustomEditor 类型的 tab
            if (!input || typeof input.viewType !== 'string' || !(input.uri instanceof vscode.Uri)) continue;
            if (input.viewType !== TESTCASE_EDITOR_VIEWTYPE) continue;

            const uri: vscode.Uri = input.uri;
            const fsPath = uri.fsPath;
            if (!/\.ya?ml$/i.test(fsPath)) continue; // 仅 YAML

            // 同步读文件并预检
            let content = '';
            try {
                const openedDoc = vscode.workspace.textDocuments.find(
                    (d) => d.uri.fsPath === fsPath || d.uri.toString() === uri.toString(),
                );
                content = openedDoc ? openedDoc.getText() : fs.readFileSync(fsPath, 'utf-8');
            } catch {
                continue; // 读不到直接放行
            }
            if (!content) continue;

            // ─── 语义预检 + 计算首条 error（按行号升序）───
            // 【关键】Toast 展示的行号、光标定位的行号，必须来自同一个 validateYamlContent 结果，
            // 与 Problems 面板的数据源保持一致（Problems 面板也是 validateYamlContent 生成的）。
            let firstError: { line: number; message: string } | undefined;
            let errorCount = 0;
            try {
                const errIssues = validateYamlContent(content)
                    .filter((iss) => iss.severity === 'error')
                    .sort((a, b) => a.line - b.line);
                errorCount = errIssues.length;
                if (errIssues.length > 0) {
                    firstError = {
                        line: errIssues[0].line,
                        // 剥掉「YAML 解析错误 (第 X 行): 」前缀，只留原始错误摘要
                        message: errIssues[0].message.replace(/^YAML (解析|格式)错误 \(第 \d+ 行\): /, ''),
                    };
                }
            } catch {
                // 校验器自身崩溃视为致命错误，仍走文本编辑器更安全
                firstError = { line: 1, message: 'YAML 校验器异常，请手动检查文件语法' };
                errorCount = 1;
            }
            if (!firstError) continue; // 无 error → 放行给 CustomEditor

            // 标记：本次已由拦截器完整处理（Toast + 光标定位一体化完成），
            // BaseEditorProvider 兜底路径若也被 VS Code 触发，会通过 wasHandledByInterceptor 检测
            // 到该标志，从而"静默切换"，不重复弹 Toast、不重复拉光标。
            markInterceptorHandled(uri);

            const displayLine = firstError.line;
            const displayMessage = firstError.message;
            const errSummary = displayMessage.split('\n')[0].slice(0, 240);
            const locHint = `第 ${displayLine} 行`;

            // 🔑 关键：必须"先关后开"——直接 openWith('default') 只会新开 tab，
            //         而 CustomEditor 的 tab 仍占据位置，导致两个 tab 并存。
            //   步骤：
            //     ① tabGroups.close(tab) —— 关闭当前 CustomEditor tab
            //     ② openTextDocument + showTextDocument(doc, {selection}) —— 打开文本编辑器
            //        并一步到位把光标定位到首条 error 行（不依赖 activeTextEditor，避免时序问题）
            //     ③ Toast 提示（说明为什么切换 + 提供"查看问题面板"等快捷入口）
            setTimeout(async () => {
                try {
                    // 先关闭 CustomEditor tab
                    await vscode.window.tabGroups.close(tab, true);
                } catch (closeErr: any) {
                    console.warn('[YAML PreOpen] close tab failed:', closeErr?.message || closeErr);
                }
                try {
                    // 用文本编辑器打开 + 一步到位定位光标到首条 error 行
                    // 【绝对可靠】showTextDocument 的 selection 参数由 VS Code 内部保证生效，
                    // 不需要事后去拿 activeTextEditor 再设置 selection（那种方式在切换过程中
                    // activeTextEditor 可能仍指向旧编辑器，导致定位失效）。
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lineIdx = Math.max(0, Math.min(displayLine - 1, doc.lineCount - 1));
                    const pos = new vscode.Position(lineIdx, 0);
                    await vscode.window.showTextDocument(doc, {
                        preview: false,
                        selection: new vscode.Range(pos, pos),
                    });
                    TelemetryService.sendTelemetryEvent('yaml.preOpen.autoSwitch', {
                        file: path.basename(fsPath),
                        errorLine: String(displayLine),
                        errorCount: String(errorCount),
                    });
                } catch (err: any) {
                    console.warn('[YAML PreOpen] open text editor failed:', err?.message || err);
                }

                // Toast 提示（Warning 级别 + 快捷按钮）
                // 明确告知用户：光标已定位到"首条错误"，若关注其他错误请去 Problems 面板
                const countHint = errorCount > 1 ? `，共 ${errorCount} 处错误` : '';
                vscode.window.showWarningMessage(
                    `YAML 文件存在语法错误（首条：${locHint}${countHint}），已切换为文本编辑器打开。错误摘要：${errSummary}`,
                    'YAML 修复全部',
                    '查看问题面板',
                ).then((choice) => {
                    if (choice === 'YAML 修复全部') {
                        vscode.commands.executeCommand(YAML_CMD_FIX_ALL, uri);
                    } else if (choice === '查看问题面板') {
                        vscode.commands.executeCommand('workbench.actions.view.problems');
                    }
                });
            }, 0);
        }
    });
}
