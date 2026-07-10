/**
 * ============================================================================
 *  handlers/yamlValidationHandler.ts
 *  YAML 格式校验 & Quick Fix 注册
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 在 YAML 文件打开/保存/内容变更时自动校验格式（Diagnostics 波浪线）。
 *    2. 注册 YamlFixProvider（CodeAction / Quick Fix）。
 *    3. 注册修复上报命令（workbench.reportYamlFix）。
 *    4. 处理窗口重载（Cmd+R）后已打开文件的兜底校验。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { validateYamlFile, validateYamlContent, publishYamlDiagnostics, getAllFixes, getYamlDiagnosticsCollection } from '../utils/yamlValidator';
import { YamlFixProvider } from '../providers/YamlFixProvider';
import { TelemetryService } from '../utils/telemetry';

// ============================================
// 防抖定时器（deactivate 时清理）
// ============================================

const yamlChangeTimers = new Map<string, NodeJS.Timeout>();

// ============================================
// 已校验 URI 集合（避免窗口重载/编辑器切换时重复校验）
// ============================================

const validatedUris = new Set<string>();

// ============================================
// 是否为 YAML 文件
// ============================================

function isYamlFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') { return false; }
    const ext = path.extname(uri.fsPath).toLowerCase();
    return ext === '.yaml' || ext === '.yml';
}

// ============================================
// 校验 & 发布（从磁盘读取，用于打开/保存）
// ============================================

async function validateAndPublish(uri: vscode.Uri): Promise<void> {
    if (!isYamlFile(uri)) { return; }
    try {
        const issues = await validateYamlFile(uri.fsPath);
        publishYamlDiagnostics(uri, issues);
    } catch (err: any) {
        console.warn('[YAML] 校验失败:', err?.message || err);
    }
}

/**
 * 供外部（editorCommands / editorMessageHandlers）调用的校验入口。
 * 用于自定义编辑器切换到文本编辑器后，显式触发一次校验。
 * 已在 registerYamlValidation 中通过 onDidChangeVisibleTextEditors 自动覆盖该场景，
 * 但保留此函数作为兜底 API。
 */
export async function validateYamlUri(uri: vscode.Uri): Promise<void> {
    await validateAndPublish(uri);
}

// ============================================
// 注册入口
// ============================================

export function registerYamlValidation(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // ── 1. 文件打开 / 保存时校验（从磁盘读取）──
    disposables.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            validatedUris.add(doc.uri.toString());
            validateAndPublish(doc.uri);
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            validatedUris.add(doc.uri.toString());
            validateAndPublish(doc.uri);
        }),
        // 文档关闭时清理 validatedUris，避免 Set 无限增长
        vscode.workspace.onDidCloseTextDocument((doc) => {
            validatedUris.delete(doc.uri.toString());
        }),
    );

    // ── 1b. 可见文本编辑器变化时校验 ──
    // 覆盖如下场景：
    //   a) 从自定义编辑器（webview）切换为默认文本编辑器
    //      → onDidOpenTextDocument 可能因 TextDocument 提前存在而不触发
    //   b) 窗口重载（Cmd+R）后已有编辑器重新可见
    //   c) 编辑器拆分/合并后 YAML 文件新增可见
    // 通过 validatedUris Set 避免重复校验，仅首次可见时执行。
    disposables.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) {
                const uri = editor.document.uri;
                if (!isYamlFile(uri)) { continue; }
                const key = uri.toString();
                if (!validatedUris.has(key)) {
                    validatedUris.add(key);
                    validateAndPublish(uri);
                }
            }
        }),
    );

    // ── 2. 内容变更时校验（从编辑器内存读取，500ms 防抖）──
    disposables.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!isYamlFile(e.document.uri)) { return; }
            const key = e.document.uri.toString();
            if (yamlChangeTimers.has(key)) {
                clearTimeout(yamlChangeTimers.get(key)!);
            }
            yamlChangeTimers.set(key, setTimeout(() => {
                yamlChangeTimers.delete(key);
                try {
                    const issues = validateYamlContent(e.document.getText());
                    publishYamlDiagnostics(e.document.uri, issues);
                } catch (err: any) {
                    console.warn('[YAML] 变更校验失败:', err?.message || err);
                }
            }, 500));
        }),
    );

    // ── 3. Quick Fix 修复上报命令 ──
    disposables.push(
        vscode.commands.registerCommand(
            'workbench.reportYamlFix',
            (fixCount: number) => {
                try {
                    TelemetryService.sendTelemetryEvent('yaml.fix.applied', {
                        fixCount: String(fixCount),
                    });
                } catch (_) { /* ignore */ }
            },
        ),
    );

    // ── 3b. 全部修复命令（分批，避免大文件单次 edit 体积超限）──
    disposables.push(
        vscode.commands.registerCommand(
            'workbench.yamlFixAll',
            async (uri: vscode.Uri) => {
                console.log('[YAML-FixAll] ====== 命令触发 ======');
                const uriKey = uri?.toString();
                console.log('[YAML-FixAll] 收到 uri:', uriKey);
                console.log('[YAML-FixAll] uri.fsPath:', uri?.fsPath);
                console.log('[YAML-FixAll] uri.scheme:', uri?.scheme);

                // 打印 visibleTextEditors 做对照
                const visEds = vscode.window.visibleTextEditors;
                console.log('[YAML-FixAll] visibleTextEditors 数量:', visEds.length);
                for (const ed of visEds) {
                    console.log('[YAML-FixAll]   editorUri:', ed.document.uri.toString(),
                        '| fsPath:', ed.document.uri.fsPath,
                        '| scheme:', ed.document.uri.scheme,
                        '| langId:', ed.document.languageId);
                }

                const editor = vscode.window.visibleTextEditors.find(
                    (e) => e.document.uri.toString() === uriKey,
                );
                if (!editor) {
                    console.error('[YAML-FixAll] ❌ 找不到对应编辑器！uriKey=', uriKey);
                    vscode.window.showWarningMessage(`YAML 修复：找不到对应的编辑器 (uri: ${uriKey})`);
                    return;
                }
                console.log('[YAML-FixAll] ✅ 找到编辑器:', editor.document.uri.toString());

                // 以当前文件 Diagnostics 覆盖的行号为准，过滤 fixDataStore 中的过时数据
                const rawFixes = getAllFixes(uri);
                const allDiagnostics = getYamlDiagnosticsCollection().get(uri) || [];
                const diagnosticLines = new Set(allDiagnostics.map(d => d.range.start.line + 1));
                const allFixes = rawFixes.filter(f => diagnosticLines.has(f.line));
                console.log('[YAML-FixAll] rawFixes 数量:', rawFixes.length, '| 过滤后数量:', allFixes.length);
                console.log('[YAML-FixAll] diagLines:', Array.from(diagnosticLines).sort((a, b) => a - b));
                console.log('[YAML-FixAll] allFixes 过滤后详情:', allFixes);
                if (allFixes.length === 0) {
                    console.warn('[YAML-FixAll] ⚠️ 过滤后无修复操作（原始修复数可能 >0）');
                    vscode.window.showWarningMessage('YAML 修复：没有找到可修复的问题');
                    return;
                }

                const batchSize = 100;
                // 从低到高升序排列
                const sorted = [...allFixes].sort((a, b) => a.line - b.line);
                const firstLine = sorted.length > 0 ? sorted[0].line : 0;
                const lastLine = sorted.length > 0 ? sorted[sorted.length - 1].line : 0;

                console.log(`[YAML-FixAll] 📋 共需处理 ${sorted.length} 行，起止行 ${firstLine}-${lastLine}，清单:`, sorted.map(f => f.line).join(', '));

                let doneCount = 0; // 已处理（含替换+跳过）的累计

                try {
                    for (let i = 0; i < sorted.length; i += batchSize) {
                        const batch = sorted.slice(i, i + batchSize);
                        let batchSkipped = 0;
                        let batchReplaced = 0;
                        const batchNum = Math.floor(i / batchSize) + 1;
                        const totalBatches = Math.ceil(sorted.length / batchSize);
                        const remaining = sorted.length - doneCount;
                        const batchFirstLine = batch[0].line;
                        const batchLastLine = batch[batch.length - 1].line;

                        console.log(`[YAML-FixAll] ── 第 ${batchNum}/${totalBatches} 批 (行 ${batchFirstLine}-${batchLastLine})，当前批 ${batch.length} 行，总剩余 ${remaining} 行 ──`);

                        const applied = await editor.edit(
                            (editBuilder) => {
                                for (const { line, fixedLine } of batch) {
                                    const lineIdx = line - 1;
                                    if (lineIdx < 0 || lineIdx >= editor.document.lineCount) {
                                        batchSkipped++;
                                        doneCount++;
                                        console.warn(`[YAML-FixAll]  进度 ${doneCount}/${sorted.length} | ⚠️ 跳过行 ${line}（越界，文件共 ${editor.document.lineCount} 行）`);
                                        continue;
                                    }
                                    const oldLine = editor.document.lineAt(lineIdx);
                                    if (oldLine.text === fixedLine) {
                                        doneCount++;
                                        console.log(`[YAML-FixAll]  进度 ${doneCount}/${sorted.length} | ➖ 跳过行 ${line}（已是修复后内容）`);
                                        continue;
                                    }
                                    doneCount++;
                                    console.log(`[YAML-FixAll]  进度 ${doneCount}/${sorted.length} | ✏️ 修复行 ${line}: "${oldLine.text.trim()}" → "${fixedLine.trim()}"`);
                                    editBuilder.replace(
                                        oldLine.range,
                                        fixedLine,
                                    );
                                    batchReplaced++;
                                }
                            },
                            { undoStopBefore: i === 0, undoStopAfter: false },
                        );
                        const stillRemaining = sorted.length - doneCount;
                        console.log(`[YAML-FixAll] 第 ${batchNum}/${totalBatches} 批完成: applied=${applied}, 本批替换=${batchReplaced}, 本批跳过=${batchSkipped}, 总进度=${doneCount}/${sorted.length}, 剩余=${stillRemaining}`);
                        if (!applied) {
                            console.warn(`[YAML] 分批修复中断于第 ${batchNum} 批`);
                            break;
                        }
                        // 给编辑器呼吸时间
                        if (i + batchSize < sorted.length) {
                            await new Promise((r) => setTimeout(r, 30));
                        }
                    }

                    // 上报修复个数
                    TelemetryService.sendTelemetryEvent('yaml.fix.applied', {
                        fixCount: String(allFixes.length),
                    });

                    // 修复完成后重新校验并发布 Diagnostics
                    const issues = validateYamlContent(editor.document.getText());
                    publishYamlDiagnostics(uri, issues);
                    console.log('[YAML-FixAll] 修复后重新校验: 剩余问题数=', issues.length);

                    vscode.window.showInformationMessage(
                        `YAML 格式修复完成：共修复 ${allFixes.length} 处，剩余 ${issues.length} 处问题`,
                    );
                } catch (err: any) {
                    console.error('[YAML-FixAll] ❌ 分批修复异常:', err?.message || err, err);
                    vscode.window.showErrorMessage(`YAML 分批修复失败: ${err?.message || err}`);
                }
            },
        ),
    );

    // ── 4. Quick Fix Provider ──
    disposables.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', language: 'yaml' },
            new YamlFixProvider(),
        ),
    );

    // ── 5. 窗口重载（Cmd+R）后兜底，已打开的 YAML 文件需主动校验 ──
    const yamlDocs = vscode.workspace.textDocuments.filter(
        (d) => d.uri.scheme === 'file' && (d.fileName.endsWith('.yaml') || d.fileName.endsWith('.yml')),
    );
    for (const doc of yamlDocs) {
        validateAndPublish(doc.uri);
    }

    return disposables;
}

// ============================================
// 清理（deactivate 时调用）
// ============================================

export function disposeYamlValidation(): void {
    for (const timer of yamlChangeTimers.values()) {
        clearTimeout(timer);
    }
    yamlChangeTimers.clear();
}
