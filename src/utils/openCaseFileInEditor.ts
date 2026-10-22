/**
 * ============================================================================
 *  utils/openCaseFileInEditor.ts
 *  以案例编辑器（testcaseViewer.unifiedEditor）打开文件的共享工具
 * ----------------------------------------------------------------------------
 *  收敛两类调用方的重复实现（删除结果页跳转 / 删除取消后重开 / 推送结果页跳转 /
 *  推送发起前打开）：
 *
 *   · suppressValidationPrompt=true —— "只为展示结果"的场景（删除 / 推送结果页
 *     跳转、删除取消后重开编辑器）。这些场景若先弹「案例格式校验」，用户必须关掉
 *     它才能看到删除 / 推送结果。抑制按文件路径登记，待面板 ready 后解除：
 *       - markReady 由 webview ready 消息触发，必晚于 resolveWebviewView 内的
 *         triggerEditValidationOnWebviewOpen（打开校验），因此 waitReady 兑现后
 *         才清除抑制，绝不会漏抑制；
 *       - 按路径抑制可同时覆盖同一次打开的两个触发点（onDidOpenTextDocument 与
 *         webview-open），且不影响用户之后从资源管理器正常打开同一文件。
 *
 *   · suppressValidationPrompt 缺省 —— 推送发起等需要正常打开校验的场景。
 *
 *  panel 注册轮询是必需的：BaseEditorProvider.waitReady 在 panelMap 未注册时会
 *  直接 reject，而 panelMap.set 发生在 resolveWebviewView 早期、早于打开校验，
 *  故先轮询等注册再 waitReady，保证抑制生命周期完整覆盖该校验。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import {
    suppressEditValidationPromptForFile,
    clearEditValidationPromptSuppressionForFile,
} from '../preValidate/editValidationHandler';

const TESTCASE_EDITOR_VIEWTYPE = 'testcaseViewer.unifiedEditor';

export interface OpenCaseFileInEditorOptions {
    /** 抑制「案例格式校验」弹窗（结果展示场景传 true） */
    suppressValidationPrompt?: boolean;
    /** 等待 webview ready 的超时（毫秒），默认 3000 */
    waitReadyMs?: number;
    /** 等待 panel 注册的轮询上限（毫秒），默认 3000 */
    panelWaitMs?: number;
}

/**
 * 以案例编辑器打开文件并等待 webview ready，返回其 panel（失败 / 超时返回 undefined）。
 *
 * @param filePath 文件绝对路径
 * @param opts     见 OpenCaseFileInEditorOptions
 */
export async function openCaseFileInEditor(
    filePath: string,
    opts: OpenCaseFileInEditorOptions = {},
): Promise<vscode.WebviewPanel | undefined> {
    const waitReadyMs = opts.waitReadyMs ?? 3000;
    const panelWaitMs = opts.panelWaitMs ?? 3000;
    if (opts.suppressValidationPrompt) suppressEditValidationPromptForFile(filePath);
    try {
        const existing = BaseEditorProvider.getPanel(filePath);
        if (existing) {
            // 已打开：切到该 tab 即可（openWith 对已打开的自定义编辑器等价于 reveal）
            try { existing.reveal(existing.viewColumn, false); } catch (_) { /* ignore */ }
        } else {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), TESTCASE_EDITOR_VIEWTYPE);
        }
        // 先轮询等 panelMap 注册（waitReady 对未注册 panel 会直接 reject）
        let panel = BaseEditorProvider.getPanel(filePath);
        for (let i = 0; !panel && i * 100 < panelWaitMs; i++) {
            await new Promise(res => setTimeout(res, 100));
            panel = BaseEditorProvider.getPanel(filePath);
        }
        if (panel) {
            try { await BaseEditorProvider.waitReady(filePath, waitReadyMs); } catch (_) { /* ignore */ }
        }
        return panel;
    } finally {
        // waitReady 兑现（或超时）后才解除抑制：此刻打开校验必然已执行完
        if (opts.suppressValidationPrompt) clearEditValidationPromptSuppressionForFile(filePath);
    }
}
