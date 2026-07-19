/**
 * ============================================================================
 *  handlers/bindHandler.ts
 *  资源管理器右键"绑定测试案例 / 绑定测试要点"命令入口
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { showToast } from '../utils/message';
import { BindDialogProvider, BindDirection } from '../providers/BindDialogProvider';
import {
    getCaseOfPoint,
    getPointOfCase,
} from '../utils/pointCaseBindingStore';
import { TelemetryService } from '../utils/telemetry';

/**
 * 校验源文件是否符合规则并推断绑定方向。
 * @param uri 源文件（用户右键的目标）
 * @param expected 期望的方向；点击"绑定测试案例"对应 point-to-cases，反之则 case-to-points
 */
function inferDirection(uri: vscode.Uri, expected: BindDirection): BindDirection | null {
    const p = uri.fsPath.replace(/\\/g, '/');
    const ext = path.extname(p).toLowerCase();

    // 必须位于 "测试任务/<xxx>/" 下
    if (!/\/测试任务\/[^\/]+\//.test(p + '/')) {
        showToast(undefined, 'warning', '当前文件不在 "测试任务/<子任务>" 目录结构下');
        return null;
    }

    if (expected === 'point-to-cases') {
        // 要求 .md / .xmind 且在"测试大纲"目录内
        if (!/\/测试任务\/[^\/]+\/测试大纲\//.test(p)) {
            showToast(undefined, 'warning', '"绑定测试案例"只能用于 测试大纲 目录下的文件');
            return null;
        }
        if (ext !== '.md' && ext !== '.xmind') {
            showToast(undefined, 'warning', '"绑定测试案例"仅支持 .md 或 .xmind 文件');
            return null;
        }
        return 'point-to-cases';
    } else {
        // case-to-points：要求 .csv/.yaml/.yml/.json 且在"测试案例"目录
        if (!/\/测试任务\/[^\/]+\/测试案例\//.test(p)) {
            showToast(undefined, 'warning', '"绑定测试要点"只能用于 测试案例 目录下的文件');
            return null;
        }
        if (!['.csv', '.yaml', '.yml', '.json'].includes(ext)) {
            showToast(undefined, 'warning', '"绑定测试要点"仅支持 .csv / .yaml / .json 文件');
            return null;
        }
        return 'case-to-points';
    }
}

/**
 * 处理"绑定测试案例"命令（源文件为 .md/.xmind）
 */
export async function handleBindCases(
    uri: vscode.Uri,
    provider: BindDialogProvider,
): Promise<void> {
    if (!uri) {
        showToast(undefined, 'warning', '请在资源管理器中右键测试要点文件（.md/.xmind）');
        return;
    }
    const direction = inferDirection(uri, 'point-to-cases');
    if (!direction) return;
    await provider.open(uri, direction);
}

/**
 * 处理"绑定测试要点"命令（源文件为 .csv/.yaml/.json）
 */
export async function handleBindPoints(
    uri: vscode.Uri,
    provider: BindDialogProvider,
): Promise<void> {
    if (!uri) {
        showToast(undefined, 'warning', '请在资源管理器中右键测试案例文件（.csv/.yaml/.json）');
        return;
    }
    const direction = inferDirection(uri, 'case-to-points');
    if (!direction) return;
    await provider.open(uri, direction);
}

// ============================================
// 一键跳转到对端（P1 ④）
// ============================================

function extOf(uri: vscode.Uri): string {
    return path.extname(uri.fsPath).toLowerCase();
}

async function jumpTo(absPath: string): Promise<void> {
    // 打开文件（若是 md/xmind 走默认编辑器，csv/yaml/json 走自定义编辑器）
    try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath));
    } catch {
        try {
            const doc = await vscode.workspace.openTextDocument(absPath);
            await vscode.window.showTextDocument(doc);
        } catch { /* ignore */ }
    }
    try {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absPath));
    } catch { /* ignore */ }
}

async function offerBindDialog(uri: vscode.Uri, direction: BindDirection, provider: BindDialogProvider) {
    const pick = await vscode.window.showInformationMessage(
        direction === 'point-to-cases'
            ? '当前测试要点尚未绑定测试案例，是否立即绑定？'
            : '当前测试案例尚未绑定测试要点，是否立即绑定？',
        { modal: false },
        '立即绑定',
    );
    if (pick === '立即绑定') {
        await provider.open(uri, direction);
    }
}

/**
 * 从当前活动编辑器 / tab 兑底取 uri（兼容自定义编辑器）。
 * 仅当命令未从右键传入 uri 时使用，例如从命令面板、状态栏按钮触发。
 */
function fallbackUriFromActive(): vscode.Uri | undefined {
    try {
        const fromEditor = vscode.window.activeTextEditor?.document?.uri;
        if (fromEditor) return fromEditor;
        const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const input: any = activeTab?.input;
        if (input?.uri) return input.uri as vscode.Uri;
    } catch (_) { /* ignore */ }
    return undefined;
}

/**
 * 右键 .md/.xmind → "跳转到已绑定的测试案例"
 */
export async function handleJumpToBoundCase(
    uri: vscode.Uri,
    provider: BindDialogProvider,
): Promise<void> {
    if (!uri) uri = fallbackUriFromActive() as vscode.Uri;
    if (!uri) {
        showToast(undefined, 'warning', '请先打开一个测试要点文件（.md / .xmind）');
        return;
    }
    const ext = extOf(uri);
    if (!['.md', '.xmind'].includes(ext)) {
        showToast(undefined, 'warning', '当前文件不是测试要点（.md / .xmind）');
        return;
    }
    const target = getCaseOfPoint(uri.fsPath);
    if (!target) {
        TelemetryService.sendTelemetryEvent('jumpToBound.miss', { direction: 'point-to-cases' });
        await offerBindDialog(uri, 'point-to-cases', provider);
        return;
    }
    if (!fs.existsSync(target)) {
        TelemetryService.sendTelemetryEvent('jumpToBound.notExist', { direction: 'point-to-cases' });
        vscode.window.showWarningMessage(`绑定的测试案例文件不存在：${target}`);
        return;
    }
    TelemetryService.sendTelemetryEvent('jumpToBound.hit', { direction: 'point-to-cases' });
    await jumpTo(target);
}

/**
 * 右键 .csv/.yaml/.json → "跳转到已绑定的测试要点"
 */
export async function handleJumpToBoundPoint(
    uri: vscode.Uri,
    provider: BindDialogProvider,
): Promise<void> {
    if (!uri) uri = fallbackUriFromActive() as vscode.Uri;
    if (!uri) {
        showToast(undefined, 'warning', '请先打开一个测试案例文件（.csv / .yaml / .json）');
        return;
    }
    const ext = extOf(uri);
    if (!['.csv', '.yaml', '.yml', '.json'].includes(ext)) {
        showToast(undefined, 'warning', '当前文件不是测试案例（.csv / .yaml / .json）');
        return;
    }
    const target = getPointOfCase(uri.fsPath);
    if (!target) {
        TelemetryService.sendTelemetryEvent('jumpToBound.miss', { direction: 'case-to-points' });
        await offerBindDialog(uri, 'case-to-points', provider);
        return;
    }
    if (!fs.existsSync(target)) {
        TelemetryService.sendTelemetryEvent('jumpToBound.notExist', { direction: 'case-to-points' });
        vscode.window.showWarningMessage(`绑定的测试要点文件不存在：${target}`);
        return;
    }
    TelemetryService.sendTelemetryEvent('jumpToBound.hit', { direction: 'case-to-points' });
    await jumpTo(target);
}