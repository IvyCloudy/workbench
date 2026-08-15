/**
 * ============================================================================
 *  linkerDiagnosticCommand.ts
 *  测试要点 ⇄ 测试案例 关联匹配 · 命令面板入口层
 * ----------------------------------------------------------------------------
 *  职责：
 *    ① 唯一命令入口 handleLinkerDiagnostic（testcaseViewer.diagnosticLinker）：
 *       基于「当前激活 tab 的 .md / .xmind」+「该要点已绑定的案例文件」→ 匹配
 *       → 打印规格（TC-Linker 前缀 + JSON 分块）：
 *         ┌ [TC-Linker] ===== 关联匹配诊断 =====
 *         ├ [TC-Linker] 📖 测试要点：<mdPath>
 *         ├ （可选）xmind 结构错误 / 告警清单
 *         ├ [TC-Linker] ===== 最终出参（约定格式） =====   ← envelope 完整 JSON
 *         └ [TC-Linker] ===== 统计 =====                    ← stats 完整 JSON
 *       ⚠️ xmind 由自定义编辑器打开时 activeTextEditor 为空，故取路径时会从
 *          activeTextEditor 兜底到 tabGroups.activeTab.input.uri，与状态栏一致。
 *    ② 埋点：linkerDiagnostic.done / linkerDiagnostic.linkerError
 *
 *  本文件不承载任何公共方法；业务级复用请调用 [linkerDiagnosticHandler.ts]：
 *    - getLinkedCasesByMdFile      业务级一站入口（1 要点文件进 → envelope 出）
 *    - linkAndAggregateCases       匹配聚合纯函数
 *    - parseMdToPointListSilent    md 静默解析
 *    - parseXmindToPointListSilent xmind 静默解析（re-export 自 utils/parseXmindToPointList）
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { showToast } from '../utils/message';
import { TelemetryService } from '../utils/telemetry';
import { telemetryErrProps } from '../utils/extensionHelpers';
import {
    getLinkedCasesByMdFile,
    type LinkedCasesEnvelope,
} from './linkerDiagnosticHandler';

/** 复用同一个 Output Channel，避免多次创建 */
let outputChannel: vscode.OutputChannel | undefined;
function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('TestCase Linker 诊断');
    }
    return outputChannel;
}

/**
 * 【工具函数】把 xmind 结构错误清单 / 告警清单追加到 Output Channel。
 *   - 结构错误：一次性列出所有无图标中间节点（E3 报错模式）
 *   - 告警：多 label、空文本等脏数据，不阻断解析
 *   - 清单长度接近/达到 parser 内部硬上限时（O9 抓断保护），提示用户可能已折叠
 */
function appendXmindDiagnosticsToChannel(
    ch: vscode.OutputChannel,
    envelope: LinkedCasesEnvelope,
): void {
    // 与 parser 内部 INVALID_NODES_HARD_LIMIT / WARNINGS_HARD_LIMIT 保持一致
    //   （仅为展示提示，取 200；如后续改变 parser 阈值，只需同步此处提示文案）
    const HARD_LIMIT = 200;
    if (envelope.xmindInvalidNodes && envelope.xmindInvalidNodes.length > 0) {
        ch.appendLine('');
        ch.appendLine(`⚠️ xmind 结构错误：以下 ${envelope.xmindInvalidNodes.length} 个中间节点缺少图标标记`);
        for (const n of envelope.xmindInvalidNodes) {
            ch.appendLine(`   · [${n.sheetTitle}] ${n.ancestryPath}`);
        }
        if (envelope.xmindInvalidNodes.length >= HARD_LIMIT) {
            ch.appendLine(`… 已达上限 ${HARD_LIMIT} 条，可能还有更多没有列出；请先修复已列出部分后重试。`);
        }
        ch.appendLine('请在 xmind 中为每个中间节点标记「小旗子」图标（功能条目），');
        ch.appendLine('或将其移动到测试点（五角星）之下作为说明节点，然后重试。');
    }
    if (envelope.xmindWarnings && envelope.xmindWarnings.length > 0) {
        ch.appendLine('');
        ch.appendLine(`ℹ️ xmind 脏数据告警（不影响解析）共 ${envelope.xmindWarnings.length} 条：`);
        for (const w of envelope.xmindWarnings) {
            ch.appendLine(`   · ${w.ancestryPath}  →  ${w.message}`);
        }
        if (envelope.xmindWarnings.length >= HARD_LIMIT) {
            ch.appendLine(`… 已达上限 ${HARD_LIMIT} 条，可能还有更多告警未列出。`);
        }
    }
}

/**
 * 把绝对路径压缩为「以 workspace 根目录为参照的相对路径」，仅用于
 * 面向用户的错误提示；envelope 里的 filePath 仍保持绝对路径不变。
 */
function short(fp: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws && fp.startsWith(ws)) return '.' + fp.slice(ws.length);
    return fp;
}

// ============================================================================
// 命令入口
// ============================================================================
export async function handleLinkerDiagnostic(): Promise<void> {
    const ch = getChannel();
    ch.clear();
    // ⚠️ 关键：ch.show(true) 不能在此时调用！Output 面板一旦被激活会立刻抢占 activeTab，
    //    导致下方 tabGroups 兜底逻辑取到「extension-output-...」这种非法路径。
    //    必须先解析出 mdPath，再在末尾统一 show。
    // 打印规格：TC-Linker 前缀 + JSON 分块输出，方便用户直接复制 envelope / stats 两块 JSON 粘贴排查。
    ch.appendLine('[TC-Linker] ===== 关联匹配诊断 =====');

    // 1) 取当前激活 tab 里的测试要点文件（必须位于「测试任务/<任务名>/测试大纲/」下）
    //    ⚠️ xmind 由自定义编辑器打开时 activeTextEditor 为空，因此需要从 tabGroups 兜底；
    //       同时必须过滤 scheme，只接受 file:// 协议，避免 output / terminal / diff 等虚拟 tab 混入。
    let mdPath: string | undefined;
    const activeTextUri = vscode.window.activeTextEditor?.document?.uri;
    if (activeTextUri && activeTextUri.scheme === 'file') {
        mdPath = activeTextUri.fsPath;
    }
    if (!mdPath) {
        // 从当前 tab 组的 activeTab 兜底（覆盖 xmind 自定义编辑器场景）
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const tabUri: vscode.Uri | undefined = (activeTab?.input as any)?.uri;
        if (tabUri && tabUri.scheme === 'file') {
            mdPath = tabUri.fsPath;
        }
    }
    if (!mdPath) {
        // 最后一层兜底：遍历所有 tab 组，找出最近的 .md / .xmind file tab
        //   —— 覆盖「用户先聚焦了 Output/终端等虚拟 tab 再执行命令」的场景
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const uri: vscode.Uri | undefined = (tab.input as any)?.uri;
                if (uri?.scheme === 'file') {
                    const ext = path.extname(uri.fsPath).toLowerCase();
                    if (ext === '.md' || ext === '.xmind') {
                        mdPath = uri.fsPath;
                        break;
                    }
                }
            }
            if (mdPath) break;
        }
    }
    if (!mdPath) {
        const msg = '请先在编辑器中打开一个测试要点 .md / .xmind 文件后再执行本命令。';
        ch.appendLine(`[TC-Linker] ⚠️ ${msg}`);
        ch.show(true);
        showToast(undefined, 'warning', msg);
        return;
    }
    const activeExt = path.extname(mdPath).toLowerCase();
    if (activeExt !== '.md' && activeExt !== '.xmind') {
        const msg = `当前激活文件不是测试要点（.md / .xmind）：${short(mdPath)}`;
        ch.appendLine(`[TC-Linker] ⚠️ ${msg}`);
        ch.show(true);
        showToast(undefined, 'warning', msg);
        return;
    }
    // 路径必须命中「测试任务/<任务名>/测试大纲/」（与右键菜单入口保持一致）
    const OUTLINE_RE = /测试任务[\\/][^\\/]+[\\/]测试大纲[\\/].+\.(md|xmind)$/i;
    if (!OUTLINE_RE.test(mdPath)) {
        const msg = `当前激活的测试要点文件不在「测试任务/<任务名>/测试大纲/」下：${short(mdPath)}`;
        ch.appendLine(`[TC-Linker] ⚠️ ${msg}`);
        ch.show(true);
        showToast(undefined, 'warning', msg);
        return;
    }
    ch.appendLine(`[TC-Linker] 📖 测试要点：${mdPath}`);
    // 到这里已确定路径合法，可以安全弹出 Output 面板（不会再影响前面的取路径逻辑）
    ch.show(true);

    // 2) 调用【业务级公共方法】完成"解析 pointList + 读绑定 + 校验 case 存在 + 匹配 + 聚合"。
    const t0 = Date.now();
    const envelope = await getLinkedCasesByMdFile(mdPath);
    const elapsed = Date.now() - t0;

    if (envelope.errorMsg) {
        ch.appendLine(`[TC-Linker] ⚠️ ${envelope.errorMsg}`);
        // 若是 xmind 结构错误，把问题节点清单一次性列全，方便用户批量修 xmind
        appendXmindDiagnosticsToChannel(ch, envelope);
        // 即使有错误也把 envelope 完整 JSON dump 出来，与历史规格一致（total=0, data={}）
        ch.appendLine('[TC-Linker] ===== 最终出参（约定格式） =====');
        ch.appendLine(JSON.stringify(envelope, null, 2));
        // 错误分支同样携带 mdFile / costMs，方便统计「哪些要点文件更易触发错误」
        TelemetryService.sendTelemetryErrorEvent('linkerDiagnostic.linkerError', {
            ...telemetryErrProps(new Error(envelope.errorMsg)),
            mdFile: path.basename(mdPath),
            costMs: String(elapsed),
        });
        showToast(undefined, 'warning', envelope.errorMsg);
        return;
    }
    // 无错误但有告警：一并输出（放在 envelope JSON 之前，便于用户第一时间看到）
    appendXmindDiagnosticsToChannel(ch, envelope);

    // 3) 打印约定格式的最终出参（envelope 完整 JSON）
    ch.appendLine('[TC-Linker] ===== 最终出参（约定格式） =====');
    ch.appendLine(JSON.stringify(envelope, null, 2));

    // 4) 简要统计（打点/参考用，结构化 JSON stats 块）
    //    matchedPointKeys = envelope.data 的 key 数，即「有命中的 point 数」；
    //    未命中的 point 不会出现在 data 里，因此本值 ≤ pointList 总数。
    const stats = {
        totalMatched: envelope.total,
        totalRecords: envelope.stats?.totalRecords,
        typeCount: envelope.stats?.typeCount,
        totalOrphan: envelope.stats?.totalOrphan,
        totalStripped: envelope.stats?.totalStripped,
        matchedPointKeys: Object.keys(envelope.data).length,
        costMs: elapsed,
    };
    ch.appendLine('[TC-Linker] ===== 统计 =====');
    ch.appendLine(JSON.stringify(stats, null, 2));

    // 5) 从 envelope 中回捞 casePath 供 telemetry 使用（1:1 语义下所有 item 的 filePath 相同）
    const firstItem = Object.values(envelope.data)[0]?.[0];
    const casePath = firstItem?.filePath ?? '(未知)';

    TelemetryService.sendTelemetryEvent('linkerDiagnostic.done', {
        mdFile: path.basename(mdPath),
        caseFile: path.basename(casePath),
        // matchedPointKeys：有命中的 point 数（== Object.keys(envelope.data).length）
        matchedPointKeys: String(Object.keys(envelope.data).length),
        totalRecords: String(envelope.stats?.totalRecords ?? 0),
        matched: String(envelope.total),
        costMs: String(elapsed),
    });
}
