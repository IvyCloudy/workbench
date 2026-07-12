/**
 * ============================================================================
 *  yamlResolveFallback.ts
 *  CustomEditor 内的 YAML 语法兜底拦截
 * ----------------------------------------------------------------------------
 *  背景：extension.ts 里的 registerYamlPreOpenInterceptor 已经在 Tab 打开事件
 *  阶段拦截了不可解析的 YAML；但在极端时序下（tab 事件早于扩展 activate、
 *  或前置拦截器抛异常）仍会走到 resolveCustomEditor。本模块作为"双保险"里的
 *  第二道兜底，负责在 CustomEditor 拿到 document 后再次校验、并把不可解析文件
 *  静默或显式地切换到文本编辑器。
 *
 *  与前置拦截器的核心差异：
 *   - 前置拦截器：Tab 打开即刻同步预检，用户看不到任何过渡页面。
 *   - 本模块：resolveCustomEditor 内异步预检，若前置已处理过（wasHandledByInterceptor）
 *            则静默关闭当前 tab；否则渲染一个"正在切换…"占位页 + 主动 close+openWith。
 *
 *  行号/Toast/Problems 面板三者行号完全一致：
 *   ① 先主动跑 validateYamlContent + publishYamlDiagnostics —— 让 Problems 面板
 *      即刻同步到最新内存内容，避免 onDidChangeTextDocument 防抖窗口内看到旧诊断。
 *   ② 从 vscode.languages.getDiagnostics(uri) 拉首条 Error —— 这就是 Problems
 *      面板的 backing data，天然与 Toast 同源。
 *   ③ DiagnosticCollection 尚未注册时兜底用步骤 ① 的 issues 计算首条 Error。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { TelemetryService } from '../utils/telemetry';
import { YAML_CMD_FIX_ALL, YAML_DIAGNOSTIC_SOURCE } from '../utils/yamlConstants';
import { validateYamlContent, publishYamlDiagnostics } from '../utils/yamlValidator';
import type { YamlIssue } from '../utils/yamlTypes';
import { wasHandledByInterceptor } from '../utils/yamlInterceptorState';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

/**
 * 在 resolveCustomEditor 内做一次 YAML 语法兜底拦截。
 *
 * @returns handled=true 时表示已完成拦截 & 切换文本编辑器动作，
 *          调用方（resolveCustomEditor）应立即 return，避免继续挂载 webview。
 *          handled=false 时表示无 error / 或读文件失败，走原有 CustomEditor 流程。
 */
export async function tryYamlResolveFallback(params: {
    document: vscode.CustomDocument;
    webviewPanel: vscode.WebviewPanel;
    filePath: string;
    fileName: string;
    log: (...args: any[]) => void;
    /** 由 BaseEditorProvider 静态提供，用于在静默切换前把 panelMap 中的本 panel 移除 */
    removePanelMapEntry: () => void;
}): Promise<boolean> {
    const { document, webviewPanel, filePath, fileName, log, removePanelMapEntry } = params;

    // ═══════════════════════════════════════════════════════════════════════════
    // 【Toast / 光标 / Problems 面板 三者行号必须一致】
    // 详见文件头注释；此处按 3 步走：① publish 最新诊断 ② 从 getDiagnostics 拉 ③ 兜底
    // ═══════════════════════════════════════════════════════════════════════════
    const openedDoc =
        vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === filePath || d.uri.toString() === document.uri.toString(),
        );
    let rawTextForCheck: string;
    try {
        rawTextForCheck = openedDoc ? openedDoc.getText() : await fs.promises.readFile(filePath, 'utf-8');
    } catch (readErr: any) {
        log('⚠ yaml pre-open read failed:', readErr?.message || readErr);
        rawTextForCheck = '';
    }

    // ─── 步骤 1：主动跑一次校验并 publish，强制 Problems 面板同步到最新内存内容 ───
    let publishedIssues: YamlIssue[] = [];
    try {
        publishedIssues = validateYamlContent(rawTextForCheck);
        publishYamlDiagnostics(document.uri, publishedIssues);
    } catch (vErr: any) {
        log('⚠ validateYamlContent/publish failed:', vErr?.message || vErr);
    }

    // ─── 步骤 2：从 vscode.languages.getDiagnostics 读取 Problems 面板同源诊断 ───
    let firstError: { line: number; message: string } | undefined;
    try {
        const diags = vscode.languages.getDiagnostics(document.uri)
            .filter(
                (d) =>
                    d.source === YAML_DIAGNOSTIC_SOURCE &&
                    d.severity === vscode.DiagnosticSeverity.Error,
            )
            .sort((a, b) => a.range.start.line - b.range.start.line);
        if (diags.length > 0) {
            const d = diags[0];
            firstError = {
                line: d.range.start.line + 1, // VS Code Range 是 0-based
                message: d.message.replace(/^YAML (解析|格式)错误 \(第 \d+ 行\): /, ''),
            };
        }
    } catch (dErr: any) {
        log('⚠ getDiagnostics failed:', dErr?.message || dErr);
    }

    // ─── 步骤 3：兜底 —— 若 DiagnosticCollection 仍为空（例如 provider 尚未注册） ───
    if (!firstError && publishedIssues.length > 0) {
        const errIssues = publishedIssues
            .filter((iss) => iss.severity === 'error')
            .sort((a, b) => a.line - b.line);
        if (errIssues.length > 0) {
            firstError = {
                line: errIssues[0].line,
                message: errIssues[0].message.replace(/^YAML (解析|格式)错误 \(第 \d+ 行\): /, ''),
            };
        }
    }
    log('🔎 yaml pre-open check → firstError=', firstError, 'diagCount=', publishedIssues.length);

    if (!firstError) return false; // 无 error → 放行给 CustomEditor

    // ─── 分支 A：前置拦截器已完整处理过 → 静默关闭本 CustomEditor tab ───
    if (wasHandledByInterceptor(document.uri)) {
        log('🚦 already handled by preOpen interceptor, silent close CustomEditor tab.');
        removePanelMapEntry();
        try {
            webviewPanel.webview.html =
                '<html><body style="margin:0;padding:0;background:transparent;"></body></html>';
        } catch (_) { /* ignore */ }
        setTimeout(() => {
            void (async () => {
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const inp = tab.input as any;
                        if (inp && inp.viewType === TESTCASE_EDITOR_VIEWTYPE
                            && inp.uri instanceof vscode.Uri
                            && inp.uri.toString() === document.uri.toString()) {
                            try { await vscode.window.tabGroups.close(tab, true); } catch (_) { /* ignore */ }
                        }
                    }
                }
            })();
        }, 0);
        return true;
    }

    // ─── 分支 B：前置未处理 → 由本模块显式切换（占位页 + Toast + close+open）───
    const displayLine = firstError.line;
    const displayMessage = firstError.message;

    TelemetryService.sendTelemetryEvent('editor.opened.yamlUnparseable', {
        targetFile: fileName,
        errorLine: String(displayLine),
    });
    log('⚠ yaml unparseable, auto switch to text editor. line=', displayLine, 'msg=', displayMessage);
    removePanelMapEntry();

    const errSummary = displayMessage
        ? displayMessage.split('\n')[0].slice(0, 240)
        : 'YAML 语法错误';
    const locHint = displayLine ? `第 ${displayLine} 行` : '';

    // ⚠️ 关键教训：不能在 resolveCustomEditor 同步流程里直接 dispose(webviewPanel)。
    //     会抛 "OverlayWebview has been disposed"。因此：先塞占位 HTML → setTimeout(0) 排下宏任务
    //     再触发 close+openWith('default')。
    const safeSummary = errSummary
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    try {
        webviewPanel.webview.html = `<!doctype html><html><body style="margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#666;">
            <div style="padding:24px;">
                <p style="color:#888;font-size:13px;">正在切换到文本编辑器…</p>
                <details style="margin-top:12px;color:#999;font-size:12px;">
                    <summary style="cursor:pointer;">若长时间未切换，点此手动打开</summary>
                    <p style="margin:8px 0 12px 0;">${locHint ? `<b>${locHint}</b>：` : ''}${safeSummary}</p>
                    <button id="openTextBtn" style="padding:6px 14px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;">用文本编辑器打开</button>
                </details>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const btn = document.getElementById('openTextBtn');
                if (btn) btn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'manualOpenText' });
                });
            </script>
        </body></html>`;
        webviewPanel.webview.onDidReceiveMessage((m: any) => {
            if (m?.type === 'manualOpenText') {
                void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            }
        });
    } catch (_) { /* ignore */ }

    // 🔑 关键：必须"先关后开"——避免同一 tab 组内出现两个 tab
    setTimeout(() => {
        void (async () => {
            try {
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input as any;
                        if (input && input.viewType === TESTCASE_EDITOR_VIEWTYPE
                            && input.uri instanceof vscode.Uri
                            && input.uri.toString() === document.uri.toString()) {
                            try {
                                await vscode.window.tabGroups.close(tab, true);
                            } catch (closeErr: any) {
                                log('⚠ close CustomEditor tab failed:', closeErr?.message || closeErr);
                            }
                        }
                    }
                }
                // 用文本编辑器打开 + 一步到位定位光标到首条 error 行
                const doc = await vscode.workspace.openTextDocument(document.uri);
                const lineIdx = displayLine && displayLine > 0
                    ? Math.max(0, Math.min(displayLine - 1, doc.lineCount - 1))
                    : 0;
                const pos = new vscode.Position(lineIdx, 0);
                await vscode.window.showTextDocument(doc, {
                    preview: false,
                    selection: new vscode.Range(pos, pos),
                });
            } catch (openErr: any) {
                log('⚠ auto switch to text editor failed:', openErr?.message || openErr);
                try {
                    const doc = await vscode.workspace.openTextDocument(document.uri);
                    await vscode.window.showTextDocument(doc, { preview: false });
                } catch (_) { /* ignore */ }
            }
        })();
    }, 0);

    // Toast 提示（Warning 级别 + 「修复全部」快捷按钮）
    const totalErrCount = publishedIssues.filter((iss) => iss.severity === 'error').length;
    const countHint = totalErrCount > 1 ? `，共 ${totalErrCount} 处错误` : '';
    vscode.window.showWarningMessage(
        `YAML 文件存在语法错误（首条：${locHint}${countHint}），已切换为文本编辑器打开。错误摘要：${errSummary}`,
        'YAML 修复全部',
        '查看问题面板',
    ).then((choice) => {
        if (choice === 'YAML 修复全部') {
            vscode.commands.executeCommand(YAML_CMD_FIX_ALL, document.uri);
        } else if (choice === '查看问题面板') {
            vscode.commands.executeCommand('workbench.actions.view.problems');
        }
    });

    return true;
}
