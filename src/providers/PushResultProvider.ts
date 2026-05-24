/**
 * ============================================================================
 *  providers/PushResultProvider.ts
 *  推送结果统一展示入口
 * ----------------------------------------------------------------------------
 *  职责：为「资源管理器右键推送」与「编辑器内推送」提供一致的反馈能力。
 *    - 全部成功：information toast
 *    - 部分成功：警告模态对话框 + 失败明细
 *    - 全部失败：错误模态对话框 + 失败明细
 *  额外能力：
 *    - 「复制失败明细」按钮一键拷贝全量明细。
 *    - 明细超 MAX_INLINE_FAILURES 条时，完整列表写入「测试案例推送」输出面板。
 *  设计要点：
 *    - 导出函数名与参数保持与历史 webview 实现一致，以实现「零改动调用方」。
 * ============================================================================
 */
import * as vscode from 'vscode';

export interface PushFailure {
    /** 行号，从 1 开始；缺失则用 tsId 标识 */
    rowIndex?: number;
    tsId: string;
    reason: string;
}

export interface PushResultOptions {
    /** 文件名，仅用于标题展示 */
    fileName: string;
    /** 成功条数 */
    successCount: number;
    /** 失败明细 */
    failures: PushFailure[];
    /** 总条数（用于全部成功时的 toast 文案） */
    total?: number;
}

/** 模态弹窗中详情区最多展示的失败条数，超出部分会写入输出面板 */
const MAX_INLINE_FAILURES = 50;

/** 复用同一个 OutputChannel，避免重复创建 */
let pushOutput: vscode.OutputChannel | undefined;
function getOutput(): vscode.OutputChannel {
    if (!pushOutput) {
        pushOutput = vscode.window.createOutputChannel('测试案例推送');
    }
    return pushOutput;
}

/**
 * 统一展示推送结果：
 *   - 全部成功：information toast 提示，不弹窗
 *   - 部分成功：warning 模态对话框 + 失败明细按行列举
 *   - 全部失败：error 模态对话框 + 失败明细按行列举
 *
 * 模态对话框为 VS Code 原生组件（居中遮罩、Esc 关闭），不再占用编辑区 Tab。
 * 失败明细超过 MAX_INLINE_FAILURES 条时，仅在弹窗内列出前 N 条，
 * 完整列表会写入「测试案例推送」输出面板。
 */
export function showPushResult(
    _context: vscode.ExtensionContext,
    options: PushResultOptions
): void {
    const { fileName, successCount, failures } = options;
    const total = options.total != null ? options.total : (successCount + failures.length);

    // 全部成功 → 仅 toast
    if (failures.length === 0) {
        vscode.window.showInformationMessage(
            `推送成功: ${fileName}（${successCount}/${total} 条）`
        );
        return;
    }

    const allDetailLines = failures.map((f, i) => formatFailureLine(i + 1, f));
    const allDetailText = allDetailLines.join('\n');

    // 弹窗内展示的明细（超过上限则截断并附提示）
    let inlineDetail: string;
    if (failures.length <= MAX_INLINE_FAILURES) {
        inlineDetail = allDetailText;
    } else {
        const head = allDetailLines.slice(0, MAX_INLINE_FAILURES).join('\n');
        inlineDetail =
            head +
            `\n…另有 ${failures.length - MAX_INLINE_FAILURES} 条失败，完整明细已写入「测试案例推送」输出面板。`;
        // 写入输出面板，便于事后查看
        const ch = getOutput();
        ch.appendLine(`[${new Date().toLocaleString()}] ${fileName} 推送结果`);
        ch.appendLine(`成功 ${successCount}/${total}，失败 ${failures.length} 条：`);
        allDetailLines.forEach(line => ch.appendLine(line));
        ch.appendLine('');
    }

    const allFailed = successCount === 0;
    const title = allFailed
        ? `推送失败: ${fileName}（0/${total}）`
        : `推送部分成功: ${fileName}（${successCount}/${total}，失败 ${failures.length} 条）`;

    const showFn = allFailed
        ? vscode.window.showErrorMessage
        : vscode.window.showWarningMessage;

    const buttons: string[] = ['复制失败明细'];
    if (failures.length > MAX_INLINE_FAILURES) {
        buttons.push('查看输出面板');
    }

    void showFn(title, { modal: true, detail: inlineDetail }, ...buttons).then((action) => {
        if (action === '复制失败明细') {
            void vscode.env.clipboard.writeText(allDetailText).then(() => {
                vscode.window.showInformationMessage('失败明细已复制到剪贴板');
            });
        } else if (action === '查看输出面板') {
            getOutput().show(true);
        }
    });
}

/** 单条失败的展示文案 */
function formatFailureLine(seq: number, f: PushFailure): string {
    const rowPart = f.rowIndex !== undefined ? `第 ${f.rowIndex} 行` : `tsId ${shortenTsId(f.tsId)}`;
    return `${seq}. ${rowPart}：${f.reason}`;
}

/** tsId 较长时只展示前 8 位，避免弹窗过宽 */
function shortenTsId(tsId: string): string {
    if (!tsId) return '(无)';
    return tsId.length > 12 ? `${tsId.slice(0, 8)}…` : tsId;
}