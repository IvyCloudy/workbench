/**
 * ============================================================================
 *  handlers/yamlValidationHandler.ts
 *  YAML 格式校验 & Quick Fix 注册
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 在 YAML 文件打开/保存/内容变更时自动校验格式（Diagnostics 波浪线）。
 *    2. 注册 YamlFixProvider（CodeAction / Quick Fix）。
 *    3. 注册修复上报命令、全部修复命令（withProgress + 可取消）。
 *    4. 文档关闭 / 窗口重载后的清理与兜底校验。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import {
    validateYamlFile,
    validateYamlContent,
    publishYamlDiagnostics,
    getAllFixes,
    getYamlDiagnosticsCollection,
    clearYamlFix,
    clearYamlValidationCache,
} from '../utils/yamlValidator';
import { YamlFixProvider } from '../providers/YamlFixProvider';
import {
    YAML_CMD_REPORT_FIX,
    YAML_CMD_FIX_ALL,
    YAML_CMD_FIX_ALL_ERRORS,
    YAML_CMD_FIX_ALL_WARNINGS,
    YAML_CMD_FIX_RANGE,
    YAML_CMD_FIX_PICK,
    YAML_DEBOUNCE_MS,
    YAML_DEBOUNCE_MS_LARGE,
    YAML_LARGE_FILE_THRESHOLD,
    YAML_FIX_COOLDOWN_MS,
} from '../utils/yamlConstants';
import { TelemetryService } from '../utils/telemetry';
import { createLogger } from '../utils/logger';

const log = createLogger('YAML');

// ============================================
// 状态
// ============================================

/** 防抖定时器 */
const yamlChangeTimers = new Map<string, NodeJS.Timeout>();
/** 已校验 URI 集合（避免重复校验） */
const validatedUris = new Set<string>();
/**
 * 正在批量修复中的 URI 计数（counter 化，允许嵌套 / 并发命令场景安全叠加）
 * 计数 > 0 表示应跳过防抖校验
 */
const fixingRefCount = new Map<string, number>();
/** 幂等标志：registerYamlValidation 只允许注册一次 */
let registered = false;

// ============================================
// 工具函数
// ============================================

function isYamlFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    return ext === '.yaml' || ext === '.yml';
}

function isFixing(key: string): boolean {
    return (fixingRefCount.get(key) ?? 0) > 0;
}

function markFixing(key: string): void {
    fixingRefCount.set(key, (fixingRefCount.get(key) ?? 0) + 1);
}

function unmarkFixing(key: string): void {
    const cur = fixingRefCount.get(key) ?? 0;
    if (cur <= 1) fixingRefCount.delete(key);
    else fixingRefCount.set(key, cur - 1);
}

async function validateAndPublish(uri: vscode.Uri): Promise<void> {
    if (!isYamlFile(uri)) return;
    try {
        const issues = await validateYamlFile(uri.fsPath);
        publishYamlDiagnostics(uri, issues);
    } catch (err: any) {
        log.warn('校验失败:', err?.message || err);
    }
}

/**
 * 根据文档大小自适应选取防抖时长。
 */
function pickDebounceMs(doc: vscode.TextDocument): number {
    // TextDocument 没有直接的 byteLength，用 chars 近似
    const chars = doc.getText().length;
    return chars >= YAML_LARGE_FILE_THRESHOLD ? YAML_DEBOUNCE_MS_LARGE : YAML_DEBOUNCE_MS;
}

// ============================================
// 注册入口
// ============================================

export function registerYamlValidation(): vscode.Disposable[] {
    if (registered) {
        log.warn('registerYamlValidation 已注册，跳过重复注册');
        return [];
    }
    registered = true;

    const disposables: vscode.Disposable[] = [];

    // 立即将编辑器右上角按钮所依赖的上下文键置为 false，
    // 避免首次评估 when 表达式时读到 undefined 导致按钮不显示。
    // 后续在 refreshYamlStatusBar 里会根据实际诊断动态更新。
    vscode.commands.executeCommand('setContext', 'yaml.hasProblems', false);
    vscode.commands.executeCommand('setContext', 'yaml.hasErrors', false);
    vscode.commands.executeCommand('setContext', 'yaml.hasWarnings', false);

    // ── 1. 打开 / 保存 / 关闭 ──
    disposables.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            validatedUris.add(doc.uri.toString());
            validateAndPublish(doc.uri);
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            validatedUris.add(doc.uri.toString());
            validateAndPublish(doc.uri);
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            const key = doc.uri.toString();
            validatedUris.delete(key);
            // ⚠ 关键：文档关闭窗口内可能存在未 fire 的防抖定时器，闭包持有 doc 引用，
            //   不清理会导致 doc 无法 GC、且定时器 fire 后仍会向已关闭文档发布 diagnostics（无用副作用）。
            const pending = yamlChangeTimers.get(key);
            if (pending) {
                clearTimeout(pending);
                yamlChangeTimers.delete(key);
            }
            if (isYamlFile(doc.uri)) {
                clearYamlFix(doc.uri);
            }
        }),
    );

    // ── 1b. 可见文本编辑器变化时校验 ──
    disposables.push(
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) {
                const uri = editor.document.uri;
                if (!isYamlFile(uri)) continue;
                const key = uri.toString();
                if (!validatedUris.has(key)) {
                    validatedUris.add(key);
                    validateAndPublish(uri);
                }
            }
        }),
    );

    // ── 2. 内容变更防抖校验（自适应时长） ──
    disposables.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!isYamlFile(e.document.uri)) return;
            const key = e.document.uri.toString();
            if (isFixing(key)) return;
            if (yamlChangeTimers.has(key)) {
                clearTimeout(yamlChangeTimers.get(key)!);
            }
            const debounceMs = pickDebounceMs(e.document);
            yamlChangeTimers.set(key, setTimeout(() => {
                yamlChangeTimers.delete(key);
                try {
                    const issues = validateYamlContent(e.document.getText());
                    publishYamlDiagnostics(e.document.uri, issues);
                } catch (err: any) {
                    log.warn('变更校验失败:', err?.message || err);
                }
            }, debounceMs));
        }),
    );

    // ── 3. Quick Fix 修复上报命令 ──
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_REPORT_FIX,
            (fixCount: number) => {
                try {
                    TelemetryService.sendTelemetryEvent('yaml.fix.applied', {
                        fixCount: String(fixCount),
                    });
                } catch (_) { /* ignore */ }
            },
        ),
    );

    // ── 3b. 全部修复命令（withProgress + 可取消） ──
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_FIX_ALL,
            async (uri: vscode.Uri) => {
                await runYamlFixLoop(uri, '全部');
            },
        ),
    );

    // ── 3b-1. 仅修复 error 级别 ──
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_FIX_ALL_ERRORS,
            async (uri: vscode.Uri) => {
                await runYamlFixLoop(uri, '仅 error', undefined, 'error');
            },
        ),
    );

    // ── 3b-2. 仅修复 warning 级别 ──
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_FIX_ALL_WARNINGS,
            async (uri: vscode.Uri) => {
                await runYamlFixLoop(uri, '仅 warning', undefined, 'warning');
            },
        ),
    );

    // ── 3c. 修复选中多行范围命令 ──
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_FIX_RANGE,
            async (uri: vscode.Uri, startLine: number, endLine: number) => {
                if (typeof startLine !== 'number' || typeof endLine !== 'number') {
                    log.warn('YAML_CMD_FIX_RANGE 参数非法', { startLine, endLine });
                    return;
                }
                const lo = Math.min(startLine, endLine);
                const hi = Math.max(startLine, endLine);
                await runYamlFixLoop(
                    uri,
                    `选中行（${lo}～${hi}）`,
                    (line: number) => line >= lo && line <= hi,
                );
            },
        ),
    );

    // ── 3d. 智能选择器：右键菜单 / 状态栏 / 命令面板的统一入口 ──
    //   背景：灯泡（lightbulb）仅在光标行可见，选区大时用户难以找到。
        //   本命令提供一个不依赖灯泡的入口，可从：
    //     - 右键菜单（editor/context）
    //     - 底部状态栏（testcaseViewer.yaml.fixPick command 链接）
    //     - 命令面板（Cmd+Shift+P → "YAML 格式修复"）
    //     - 自定义快捷键
    //   触发，并自动根据当前选区与诊断分布弹出 QuickPick。
    disposables.push(
        vscode.commands.registerCommand(
            YAML_CMD_FIX_PICK,
            async (uriArg?: vscode.Uri) => {
                await handleFixPick(uriArg);
            },
        ),
    );

    // ── 3d. 共用的多轮分批修复主循环
    //    label：提示文案（"全部" / "选中行(…)" / "仅 error" / "仅 warning"）
    //    lineFilter：只修复行号命中的 fix；为空表示全修
    //    severityFilter：只修复该严重级的 fix；为空表示不区分级别
    async function runYamlFixLoop(
        uri: vscode.Uri,
        label: string,
        lineFilter?: (line: number) => boolean,
        severityFilter?: 'error' | 'warning',
    ): Promise<void> {
        const uriKey = uri?.toString();
        log.debug('====== runYamlFixLoop ======', { uriKey, label, fsPath: uri?.fsPath, severityFilter });

        const editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uriKey,
        );
        if (!editor) {
            log.warn('找不到对应编辑器！uriKey=', uriKey);
            vscode.window.showWarningMessage(`YAML 修复：找不到对应的编辑器 (uri: ${uriKey})`);
            return;
        }

        // 内部工具：从当前 diagnostics 构建"行号 → severity"映射
        const buildLineSeverity = (): Map<number, vscode.DiagnosticSeverity> => {
            const diags = getYamlDiagnosticsCollection().get(uri) || [];
            const m = new Map<number, vscode.DiagnosticSeverity>();
            for (const d of diags) {
                const ln = d.range.start.line + 1;
                const prev = m.get(ln);
                // 同一行若有 error + warning，取更严重的（Error < Warning 数值上）
                if (prev === undefined || d.severity < prev) m.set(ln, d.severity);
            }
            return m;
        };

        // 按 severityFilter 过滤 fix：只保留严重级匹配的行
        const matchesSeverity = (line: number, sevMap: Map<number, vscode.DiagnosticSeverity>): boolean => {
            if (!severityFilter) return true;
            const s = sevMap.get(line);
            if (s === undefined) return false;
            if (severityFilter === 'error') return s === vscode.DiagnosticSeverity.Error;
            return s === vscode.DiagnosticSeverity.Warning;
        };

        // 初次拉取；后续每轮迭代都会重新校验后再拉一批新的 fix
        let rawFixes = getAllFixes(uri);
        let lineSev = buildLineSeverity();
        let diagnosticLines = new Set(lineSev.keys());
        let allFixes = rawFixes.filter(f => diagnosticLines.has(f.line) && matchesSeverity(f.line, lineSev));
        if (lineFilter) allFixes = allFixes.filter(f => lineFilter(f.line));
        log.debug('rawFixes:', rawFixes.length, '过滤后:', allFixes.length, 'label:', label);
        if (allFixes.length === 0) {
            vscode.window.showWarningMessage(`YAML 修复（${label}）：没有找到可修复的问题`);
            return;
        }

        // 埋点：起始快照（用于计算"修复了多少 error / warning"）
        const initialTotal = (getYamlDiagnosticsCollection().get(uri) || []).length;
        const initialError = Array.from(lineSev.values()).filter(s => s === vscode.DiagnosticSeverity.Error).length;
        const initialWarning = Array.from(lineSev.values()).filter(s => s === vscode.DiagnosticSeverity.Warning).length;

        const batchSize = 100;
        // 多轮迭代上限：修一轮 → 消除级联 error → 暴露新的 fix → 再修
        // 上限 5 轮，防止规则冲突导致的死循环。
        const MAX_ROUNDS = 5;

        markFixing(uriKey);
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `YAML 修复中（${label}）`,
                    cancellable: true,
                },
                async (progress, token) => {
                    let replacedTotal = 0;
                    const fixedLineSet = new Set<number>();       // 去重后的"实际被修改的行号"
                    let doneCount = 0;
                    let round = 0;
                    // 选中范围场景：本轮 fix 全是 indent-mismatch 兜底，无法安全修复的条数
                    let stoppedByCascade = 0;
                    let cancelledByUser = false;

                    while (round < MAX_ROUNDS) {
                        round++;
                        // ── 关键：把 indent-mismatch 兜底注释化推迟到"最后一轮" ──
                        // 场景：`name:hello`（R4 冗余）会让 YAML 解析器把下面所有行都
                        //   报为 "same column" parse error，兜底策略是"注释化"。
                        //   若与 R4 修复放在同一 editor.edit 一起提交，会导致下面几十行
                        //   全被注释掉。因此，先只应用"稳妥 fix"（非注释化的 fix），
                        //   让 R4 修好后重新校验，parse error 大概率自动消失；
                        //   只有稳妥 fix 全部完成、仍存在兜底 fix 时才注释化。
                        const sortedAll = [...allFixes].sort((a, b) => a.line - b.line);
                        const safeFixes = sortedAll.filter(f => !isIndentMismatchFallback(f.fixedLine));
                        const fallbackFixes = sortedAll.filter(f => isIndentMismatchFallback(f.fixedLine));

                        // 若本轮全是 indent-mismatch 兜底：
                        //   · "修复全部" 场景：允许兜底生效（用户已在全量视图，接受"最坏情况注释化"）
                        //   · "选中范围" / "仅修复 error" 场景：拒绝执行注释化，且中止后续轮次
                        //     —— 选中范围的根因大概率在选区外；"仅 error" 用户明确只想清 error，
                        //        若唯一手段是"整行注释化"，宁可让用户先跑一次"修复全部"（会先跑
                        //        非破坏性规则 fix 消除级联 error），也不能直接把一堆行注释掉。
                        //     此时应提示用户"级联错误，请使用『修复全部』或扩大选区"。
                        const restrictedMode = lineFilter !== undefined || severityFilter === 'error';
                        let sorted: typeof sortedAll;
                        if (safeFixes.length > 0) {
                            sorted = safeFixes;
                        } else if (fallbackFixes.length > 0 && !restrictedMode) {
                            sorted = fallbackFixes; // 修复全部：允许兜底
                        } else {
                            // 受限模式 + 全是兜底 → 拒绝执行，记录中止原因（弹窗合并到末尾统一显示）
                            log.warn('受限模式下全是 indent-mismatch 兜底 fix，拒绝执行以避免破坏原文', {
                                fallbackCount: fallbackFixes.length,
                                hasLineFilter: lineFilter !== undefined,
                                severityFilter,
                            });
                            stoppedByCascade = fallbackFixes.length;
                            break;
                        }
                        const totalThisRound = sorted.length;
                        if (totalThisRound === 0) break;
                        log.debug('本轮策略: 稳妥=', safeFixes.length, ' 兜底=', fallbackFixes.length, ' 本轮执行=', totalThisRound);

                        let doneThisRound = 0;
                        let replacedThisRound = 0;
                        for (let i = 0; i < sorted.length; i += batchSize) {
                            if (token.isCancellationRequested) {
                                log.warn('用户取消 YAML 修复');
                                cancelledByUser = true;
                                break;
                            }
                            const batch = sorted.slice(i, i + batchSize);
                            const batchNum = Math.floor(i / batchSize) + 1;
                            const totalBatches = Math.ceil(sorted.length / batchSize);
                            let batchReplaced = 0;

                            const applied = await editor.edit(
                                (editBuilder) => {
                                    for (const { line, fixedLine } of batch) {
                                        const lineIdx = line - 1;
                                        if (lineIdx < 0 || lineIdx >= editor.document.lineCount) {
                                            doneThisRound++;
                                            continue;
                                        }
                                        const oldLine = editor.document.lineAt(lineIdx);
                                        if (oldLine.text === fixedLine) {
                                            doneThisRound++;
                                            continue;
                                        }
                                        doneThisRound++;
                                        editBuilder.replace(oldLine.range, fixedLine);
                                        batchReplaced++;
                                        fixedLineSet.add(line);
                                    }
                                },
                                { undoStopBefore: round === 1 && i === 0, undoStopAfter: false },
                            );
                            if (!applied) {
                                log.warn('分批修复中断于第', round, '轮 第', batchNum, '批');
                                break;
                            }
                            replacedThisRound += batchReplaced;

                            // 更新进度
                            const percent = (batch.length / totalThisRound) * 100 / MAX_ROUNDS;
                            progress.report({
                                increment: percent,
                                message: `第 ${round} 轮 · 第 ${batchNum}/${totalBatches} 批（本轮 ${doneThisRound}/${totalThisRound}）`,
                            });

                            if (i + batchSize < sorted.length) {
                                await new Promise((r) => setTimeout(r, 30));
                            }
                        }

                        replacedTotal += replacedThisRound;
                        doneCount += doneThisRound;
                        if (cancelledByUser) break;

                        // ── 本轮修完 → 重新校验，看是否还有新的可修复 issue ──
                        const nextIssues = validateYamlContent(editor.document.getText());
                        publishYamlDiagnostics(uri, nextIssues);
                        rawFixes = getAllFixes(uri);
                        lineSev = buildLineSeverity();
                        diagnosticLines = new Set(lineSev.keys());
                        allFixes = rawFixes.filter(f => diagnosticLines.has(f.line) && matchesSeverity(f.line, lineSev));
                        if (lineFilter) allFixes = allFixes.filter(f => lineFilter(f.line));
                        log.debug('修复第', round, '轮结束: 本轮替换', replacedThisRound, ' 剩余可修', allFixes.length);
                        // 若本轮没实际替换任何一行（例如所有 fix 均等于原行），中止避免死循环
                        if (replacedThisRound === 0) break;
                        if (allFixes.length === 0) break;
                    }

                    // 修复后重新校验（供收尾弹窗 & 埋点使用）
                    const finalIssues = validateYamlContent(editor.document.getText());
                    publishYamlDiagnostics(uri, finalIssues);
                    const finalSevMap = buildLineSeverity();
                    const finalError = Array.from(finalSevMap.values()).filter(s => s === vscode.DiagnosticSeverity.Error).length;
                    const finalWarning = Array.from(finalSevMap.values()).filter(s => s === vscode.DiagnosticSeverity.Warning).length;

                    // ── 埋点：完整覆盖"修复次数、修复行数、严重级分布、剩余量、上下文规模" ──
                    // 字段说明见 README「埋点字段」章节
                    TelemetryService.sendTelemetryEvent('yaml.fix.applied', {
                        fixCount: String(replacedTotal),                                    // 累计替换次数（同 batch 内多次可叠加）
                        fixedLines: String(fixedLineSet.size),                              // 去重后实际被修改的行数
                        rounds: String(round),                                              // 迭代轮数
                        cancelled: cancelledByUser ? '1' : '0',                             // 是否被用户取消
                        scope: lineFilter ? 'range' : 'all',                                // 修复范围（选中 / 全部）
                        severityScope: severityFilter ?? 'both',                            // 严重级范围（error / warning / both）
                        errorFixed: String(Math.max(0, initialError - finalError)),        // 修复 error 数（增量）
                        warningFixed: String(Math.max(0, initialWarning - finalWarning)),  // 修复 warning 数（增量）
                        initialTotal: String(initialTotal),                                 // 修复前总问题数
                        remaining: String(finalIssues.length),                              // 修复后剩余问题数
                        remainingError: String(finalError),                                 // 修复后剩余 error 数
                        remainingWarning: String(finalWarning),                             // 修复后剩余 warning 数
                        docLines: String(editor.document.lineCount),                        // 文档总行数（衡量修复效率）
                        stoppedByCascade: stoppedByCascade > 0 ? '1' : '0',                 // 是否因级联错误中止
                    });

                    log.debug('修复后剩余问题数=', finalIssues.length, ' 累计已处理=', doneCount, ' 实修行数=', fixedLineSet.size);

                    // ── 统一收尾弹窗：把「取消 / 级联中止 / 正常完成」合并为一条 ──
                    const remain = finalIssues.length;
                    if (cancelledByUser) {
                        vscode.window.showWarningMessage(
                            `YAML 修复已取消（${label}）：已修复 ${fixedLineSet.size} 行 / ${replacedTotal} 处，剩余 ${remain} 处问题`,
                        );
                    } else if (stoppedByCascade > 0) {
                        // 级联错误中止 = Warning 级别弹窗，附带「修复全部」快捷按钮
                        const detail = replacedTotal > 0
                            ? `已修复 ${fixedLineSet.size} 行 / ${replacedTotal} 处（${round} 轮）`
                            : `未修复任何行`;
                        // 文案区分：选中范围 vs 仅按严重级过滤
                        const cascadeReason = lineFilter !== undefined
                            ? '根因可能不在选中范围内'
                            : '这些是级联解析错误，唯一手段是"注释化整行"，建议改用「修复全部」，让规则 fix 先修好根因';
                        vscode.window.showWarningMessage(
                            `YAML 修复完成（${label}）：${detail}，剩余 ${remain} 处问题。` +
                            `其中 ${stoppedByCascade} 处为级联解析错误，${cascadeReason}。`,
                            '修复全部',
                            '查看问题面板',
                        ).then((choice) => {
                            if (choice === '修复全部') {
                                vscode.commands.executeCommand(YAML_CMD_FIX_ALL, uri);
                            } else if (choice === '查看问题面板') {
                                vscode.commands.executeCommand('workbench.actions.view.problems');
                            }
                        });
                    } else {
                        vscode.window.showInformationMessage(
                            `YAML 格式修复完成（${label}）：共修复 ${fixedLineSet.size} 行 / ${replacedTotal} 处（${round} 轮），剩余 ${remain} 处问题`,
                        );
                    }
                },
            );
        } catch (err: any) {
            log.error('分批修复异常:', err?.message || err);
            vscode.window.showErrorMessage(`YAML 分批修复失败: ${err?.message || err}`);
        } finally {
            // 释放 fixingRefCount，覆盖 editor.edit 触发的 onDidChangeTextDocument 尾包
            setTimeout(() => unmarkFixing(uriKey), YAML_FIX_COOLDOWN_MS);
        }
    }

    // ── 4. Quick Fix Provider ──
    disposables.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', language: 'yaml' },
            new YamlFixProvider(),
        ),
    );

    // ── 4b. 状态栏：YAML 格式问题永久可见入口 ──
    //   只在当前活动编辑器为 yaml／并且当前文件存在可修复的诊断时才显示，
    //   确保不干扰非 YAML 使用场景。点击后直接路由到 fixPick 智能选择器。
    const yamlStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100,
    );
    yamlStatusBar.command = YAML_CMD_FIX_PICK;
    yamlStatusBar.tooltip = 'YAML 格式修复（支持选中范围 / 全部 / 仅 error / 仅 warning）';
    disposables.push(yamlStatusBar);

    // 用于驱动编辑器右上角标题栏按钮显隐 & 图标切换的上下文键
    //   yaml.hasProblems  ：当前 YAML 文件是否有可修复问题（控制按钮整体显隐）
    //   yaml.hasErrors    ：当前 YAML 文件是否含 error 级问题（切换 error 图标）
    //   yaml.hasWarnings  ：当前 YAML 文件是否只含 warning 级问题（切换 warning 图标）
    // 三个键互斥使用，package.json 的 when 表达式据此选择三选一的按钮。
    let lastCtxProblems = false, lastCtxErrors = false, lastCtxWarnings = false;
    const setYamlCtx = (hasProblems: boolean, hasErrors: boolean, hasWarnings: boolean) => {
        if (hasProblems !== lastCtxProblems) {
            vscode.commands.executeCommand('setContext', 'yaml.hasProblems', hasProblems);
            lastCtxProblems = hasProblems;
        }
        if (hasErrors !== lastCtxErrors) {
            vscode.commands.executeCommand('setContext', 'yaml.hasErrors', hasErrors);
            lastCtxErrors = hasErrors;
        }
        if (hasWarnings !== lastCtxWarnings) {
            vscode.commands.executeCommand('setContext', 'yaml.hasWarnings', hasWarnings);
            lastCtxWarnings = hasWarnings;
        }
    };

    const refreshYamlStatusBar = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isYamlFile(editor.document.uri)) {
            yamlStatusBar.hide();
            setYamlCtx(false, false, false);
            return;
        }
        const diags = getYamlDiagnosticsCollection().get(editor.document.uri) || [];
        if (diags.length === 0) {
            yamlStatusBar.hide();
            setYamlCtx(false, false, false);
            return;
        }
        // 同行多条 diagnostic 取最严重级
        const lineSev = new Map<number, vscode.DiagnosticSeverity>();
        for (const d of diags) {
            const ln = d.range.start.line + 1;
            const prev = lineSev.get(ln);
            if (prev === undefined || d.severity < prev) lineSev.set(ln, d.severity);
        }
        let err = 0, warn = 0;
        for (const s of lineSev.values()) {
            if (s === vscode.DiagnosticSeverity.Error) err++;
            else if (s === vscode.DiagnosticSeverity.Warning) warn++;
        }
        // 图标随严重级变化：有 error → $(error)；仅 warning → $(warning)；其他 → $(wrench)
        // 文案统一：“YAML 修复 N”（单一总数），不再混用 emoji，与 QuickPick 视觉对齐
        const total = err + warn;
        const icon = err > 0 ? '$(error)' : (warn > 0 ? '$(warning)' : '$(wrench)');
        yamlStatusBar.text = `${icon} YAML 修复 ${total || diags.length}`;
        // 仅当含 error 时高亮标色（warningBackground，避免与 VS Code error 背景日常乱色）
        yamlStatusBar.backgroundColor = err > 0
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
        yamlStatusBar.show();

        // 同步驱动编辑器右上角按钮（IDEA-style 徽章）
        //   yaml.hasErrors    ：含 error（含混合情况）
        //   yaml.hasWarnings  ：含 warning（含混合情况）
        //   yaml.hasProblems  ：有任意可修复问题
        // 三键组合非否定，package.json 的 when 用 err 优先短路：
        //   err       → 显示 error 图标
        //   !err && warn → 显示 warning 图标
        //   兜底         → 显示 wrench 图标
        setYamlCtx(true, err > 0, warn > 0);
    };
    // ── 状态栏刷新：切换编辑器 / 诊断变化时更新徽章 & 上下文键 ──
    refreshYamlStatusBar();
    disposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            refreshYamlStatusBar();
        }),
        vscode.languages.onDidChangeDiagnostics((e) => {
            const active = vscode.window.activeTextEditor;
            if (!active) return;
            if (e.uris.some(u => u.toString() === active.document.uri.toString())) {
                refreshYamlStatusBar();
            }
        }),
    );

    // ── 5. 窗口重载兜底 ──
    const yamlDocs = vscode.workspace.textDocuments.filter(
        (d) => d.uri.scheme === 'file' && (d.fileName.endsWith('.yaml') || d.fileName.endsWith('.yml')),
    );
    for (const doc of yamlDocs) {
        validateAndPublish(doc.uri);
    }

    return disposables;
}

// ============================================
// 清理（deactivate 调用）
// ============================================

export function disposeYamlValidation(): void {
    for (const timer of yamlChangeTimers.values()) {
        clearTimeout(timer);
    }
    yamlChangeTimers.clear();
    validatedUris.clear();
    fixingRefCount.clear();
    clearYamlValidationCache();
    registered = false;
}

// ============================================
// 工具函数
// ============================================

/**
 * 智能选择器：右键 / 状态栏 / 命令面板的统一入口
 * ------------------------------------------------------------
 * 处理链路：
 *   1. 定位目标 uri（优先参数，其次 activeTextEditor）；必须是 YAML 文件
 *   2. 采集当前选区行范围、诊断 error/warning 分布
 *   3. 组装 QuickPick 项：
 *      - 若选区跨行且选区内可修复 >= 2 → 提供「修复选中范围」
 *      - 总可修复 >= 1 → 提供「修复全部」
 *      - error/warning 均 >0 → 追加「仅 error」「仅 warning」
 *   4. 用户选择后，通过 executeCommand 路由到对应的命令实现，
 *      复用现有的 fixAll/fixRange/fixAllErrors/fixAllWarnings 逻辑
 *
 * 相比灯泡（lightbulb），本入口的关键优势：**不依赖光标行的诊断**——用户
 * 在选区任意位置右键或点状态栏都能触发，解决"灯泡只在第一行显示"的痛点。
 */
async function handleFixPick(uriArg?: vscode.Uri): Promise<void> {
    // 1. 定位目标 URI
    let uri = uriArg;
    let editor: vscode.TextEditor | undefined;
    if (uri) {
        editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri!.toString());
    } else {
        editor = vscode.window.activeTextEditor;
        uri = editor?.document.uri;
    }
    if (!uri || !isYamlFile(uri)) {
        vscode.window.showWarningMessage('YAML 格式修复：请先打开 .yaml / .yml 文件');
        return;
    }

    // 2. 采集诊断与 fix 分布
    const diags = getYamlDiagnosticsCollection().get(uri) || [];
    if (diags.length === 0) {
        vscode.window.showInformationMessage('YAML 格式修复：当前文件没有检测到问题 🎉');
        return;
    }
    const lineSev = new Map<number, vscode.DiagnosticSeverity>();
    for (const d of diags) {
        const ln = d.range.start.line + 1;
        const prev = lineSev.get(ln);
        if (prev === undefined || d.severity < prev) lineSev.set(ln, d.severity);
    }
    const diagnosticLines = new Set(lineSev.keys());
    const allFixes = getAllFixes(uri).filter(f => diagnosticLines.has(f.line));
    if (allFixes.length === 0) {
        vscode.window.showWarningMessage(
            `YAML 格式修复：当前文件有 ${diags.length} 处问题，但均为无法自动修复的错误。请查看问题面板手动处理。`,
            '查看问题面板',
        ).then(choice => {
            if (choice === '查看问题面板') {
                vscode.commands.executeCommand('workbench.actions.view.problems');
            }
        });
        return;
    }

    const errFixCount = allFixes.filter(f => lineSev.get(f.line) === vscode.DiagnosticSeverity.Error).length;
    const warnFixCount = allFixes.filter(f => lineSev.get(f.line) === vscode.DiagnosticSeverity.Warning).length;

    // 3. 选区分析（若能拿到 editor 就取选区，否则视为无选区）
    let selStart = 0, selEnd = 0, selectionSpansMultipleLines = false;
    let rangeFixCount = 0;
    if (editor) {
        const sel = editor.selection;
        selStart = sel.start.line + 1;
        selEnd = sel.end.line + 1;
        selectionSpansMultipleLines = selEnd > selStart;
        if (selectionSpansMultipleLines) {
            rangeFixCount = allFixes.filter(f => f.line >= selStart && f.line <= selEnd).length;
        }
    }

    // 4. 组装 QuickPick 项【统一视觉】
    //    – label：$(codicon) + 中文名称
    //    – description：“共 N 处 · error x · warning y”风格
    //    – detail：一句话说明作用域，不用 emoji
    //    – 与灯泡里的“YAML · 更多修复操作...”入口、状态栏的“YAML 修复 N”完全对齐
    type Action = 'range' | 'all' | 'error' | 'warning';
    type PickItem = vscode.QuickPickItem & { action: Action };
    const picks: PickItem[] = [];

    // 4a. 修复选中范围（仅在跨行选区、可修复 >=2 且 < 全量时提供）
    if (selectionSpansMultipleLines && rangeFixCount >= 2 && rangeFixCount < allFixes.length) {
        picks.push({
            label: `$(selection) 修复选中范围`,
            description: `第 ${selStart}~${selEnd} 行 · ${rangeFixCount} 处`,
            detail: '仅修复选区内的问题，不影响选区外内容',
            action: 'range',
        });
    }

    // 4b. 修复全部（永久提供）
    const allSubParts: string[] = [`共 ${allFixes.length} 处`];
    if (errFixCount > 0) allSubParts.push(`error ${errFixCount}`);
    if (warnFixCount > 0) allSubParts.push(`warning ${warnFixCount}`);
    picks.push({
        label: `$(wrench) 修复全部`,
        description: allSubParts.join(' · '),
        detail: '逐行修复当前文件所有可自动修复的问题，多轮迭代直至收敛',
        action: 'all',
    });

    // 4c/4d. 分级修复（仅在两类共存时提供，否则“全部”已覆盖）
    if (errFixCount > 0 && warnFixCount > 0) {
        picks.push({
            label: `$(error) 仅修复 error`,
            description: `共 ${errFixCount} 处`,
            detail: '仅处理严重级为 error 的行，保留 warning 不变',
            action: 'error',
        });
        picks.push({
            label: `$(warning) 仅修复 warning`,
            description: `共 ${warnFixCount} 处`,
            detail: '仅处理严重级为 warning 的行，保留 error 不变',
            action: 'warning',
        });
    }

    const picked = await vscode.window.showQuickPick(picks, {
        title: `YAML 格式修复 · ${path.basename(uri.fsPath)}`,
        placeHolder: '选择修复范围（↑↓ 选择，回车确认，Esc 取消）',
        ignoreFocusOut: false,
        matchOnDescription: false,
        matchOnDetail: false,
    });
    if (!picked) {
        log.debug('用户取消了 fixPick 选择器');
        return;
    }

    // 5. 路由到对应命令
    switch (picked.action) {
        case 'range':
            await vscode.commands.executeCommand(YAML_CMD_FIX_RANGE, uri, selStart, selEnd);
            break;
        case 'all':
            await vscode.commands.executeCommand(YAML_CMD_FIX_ALL, uri);
            break;
        case 'error':
            await vscode.commands.executeCommand(YAML_CMD_FIX_ALL_ERRORS, uri);
            break;
        case 'warning':
            await vscode.commands.executeCommand(YAML_CMD_FIX_ALL_WARNINGS, uri);
            break;
    }
}

/**
 * 判断一条 fixedLine 是否为 **级联兜底注释化** 产物（根因通常在别处的 parse error）。
 * 仅覆盖两类：
 *   - # [indent mismatch] xxx （All mapping items must start at the same column）
 *   - # [unparseable] xxx     （通用兜底：无法归类的 parse error）
 * 这两类 fix 若与"根因行的规则修复"同轮提交，会把级联的一大堆无辜行都注释掉，
 * 因此策略是"推迟到最后一轮"、并在"选中范围 / 仅修复 error"受限模式下拒绝执行。
 *
 * **`# [duplicate key removed]` 不算级联兜底**：它的根因就是"本行 key 与前面重复"，
 * 注释化本行即为正确修复，不会误伤任何无辜行，可与普通规则 fix 同轮提交。
 */
function isIndentMismatchFallback(fixedLine: string): boolean {
    const trimmed = fixedLine.trimStart();
    return trimmed.startsWith('# [indent mismatch]')
        || trimmed.startsWith('# [unparseable]');
}

