/**
 * ============================================================================
 *  handlers/bindHandler.ts
 *  资源管理器右键"绑定测试案例 / 绑定测试要点"命令入口
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { showToast } from '../utils/message';
import { BindDialogProvider, BindDirection } from '../providers/BindDialogProvider';

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
