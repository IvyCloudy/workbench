/**
 * ============================================================================
 *  services/utils.ts
 *  扩展端通用工具集
 * ----------------------------------------------------------------------------
 *  内容分组：
 *    1. FILE_PATTERNS：CSV/YAML/JSON 后缀正则
 *    2. CSP nonce / HTML escape / 错误页 HTML 模板（buildErrorHtml）
 *    3. 路径合规校验（isInQualifiedDir）
 *    4. 推送追踪相关常量与 UUID 生成
 *  设计要点：
 *    - 本文件不依赖 vscode.workspace 等运行时上下文，纯工具函数，便于单测。
 *    - 任务信息（testTaskNo / subTestTaskName）统一由 getCurrentTaskInfo /
 *      getTaskInfoByFilePath 基于 task-bindings.json 提供。
 * ============================================================================
 */
import * as path from 'path';

// ============================================
// 文件类型匹配模式
// ============================================

export const FILE_PATTERNS = {
    CSV: /\.csv$/i,
    YAML: /\.ya?ml$/i,
    JSON: /\.json$/i,
} as const;

// ============================================
// CSP nonce
// ============================================

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成 CSP nonce
 */
export function getNonce(length: number = 64): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
    }
    return result;
}

// ============================================
// HTML
// ============================================

/**
 * HTML 字符转义
 */
export function escapeHtml(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 构建错误页 HTML（统一样式）。
 * @param message 错误描述
 * @param title   标题
 * @param actions 可选操作按钮：点击后会通过 postMessage 向扩展端发送 { type: action }
 */
export function buildErrorHtml(
    message: string,
    title: string = '错误',
    actions: Array<{ label: string; action: string; primary?: boolean }> = []
): string {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const buttonsHtml = actions
        .map(a => `<button class="btn${a.primary ? ' btn-p' : ''}" data-act="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`)
        .join('');
    const scriptHtml = actions.length
        ? `<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => vscode.postMessage({ type: b.getAttribute('data-act') }));
});
</script>`
        : '';
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: #f5f6f8;
        }
        .msg {
            text-align: center;
            padding: 40px;
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,.1);
            max-width: 520px;
        }
        .msg h3 { color: #e34d59; margin: 0 0 12px; }
        .msg p { color: #666; font-size: 14px; margin: 0 0 20px; line-height: 1.6; }
        .actions { display: flex; gap: 8px; justify-content: center; }
        .btn {
            padding: 6px 16px; font-size: 13px; cursor: pointer;
            border: 1px solid #d9d9d9; background: #fff; color: #333; border-radius: 3px;
        }
        .btn:hover { border-color: #1677ff; color: #1677ff; }
        .btn-p { background: #1677ff; color: #fff; border-color: #1677ff; }
        .btn-p:hover { background: #4096ff; color: #fff; }
    </style>
</head>
<body>
    <div class="msg">
        <h3>${safeTitle}</h3>
        <p>${safeMessage}</p>
        ${buttonsHtml ? `<div class="actions">${buttonsHtml}</div>` : ''}
    </div>
    ${scriptHtml}
</body>
</html>`;
}

// ============================================
// 文件路径校验
// ============================================

/**
 * 检查文件是否在合格目录下：
 *   .../测试任务/<任务目录>/测试案例/[...]/<file>
 * 任务目录只要是文件夹即可，不强制要求 <编号>_<名称> 格式。
 * 文件可直接放在 测试案例/ 目录下，也可放在其子目录中。
 */
export function isInQualifiedDir(filePath: string, filePattern: RegExp): boolean {
    if (!filePath || !filePattern.test(filePath)) {
        return false;
    }

    const parts = filePath.split(path.sep);
    const len = parts.length;
    if (len < 4) return false;

    // 动态查找 "测试任务" 的位置（不在固定倒数层级）
    let rootIdx = -1;
    for (let i = 0; i < len - 3; i++) {
        if (parts[i] === '测试任务') {
            rootIdx = i;
            break;
        }
    }
    if (rootIdx === -1) return false;

    // rootIdx + 1 必须是任务目录（任意文件夹名）
    const taskDir = parts[rootIdx + 1];
    if (!taskDir) return false;

    // rootIdx + 2 必须是 "测试案例"
    const caseDir = parts[rootIdx + 2];
    if (caseDir !== '测试案例') return false;

    // 文件名匹配（文件可在 测试案例/ 目录或其子目录下）
    const lastPart = parts[len - 1];
    return filePattern.test(lastPart);
}

// ============================================
// 推送相关：固定列名 & UUID
// ============================================

/** 推送追踪列：行的唯一 id，请求时回传给后端，用于响应回写匹配 */
export const TS_ID_COLUMN = 'testcase_id';
/** 推送成功回写列：成功时存放后端返回的 testCaseNo */
export const TEST_CASE_NO_COLUMN = 'testCaseNo';

/**
 * 生成 RFC4122 v4 UUID（无外部依赖，浏览器/Node 通用）
 */
export function genUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// ============================================
// 错误工具
// ============================================

/**
 * 提取错误堆栈头几行用于上报，避免信息泄漏
 */
export function stackHead(err: any, lines = 5): string {
    const stack = err && err.stack ? String(err.stack) : '';
    return stack.split('\n').slice(0, lines).join(' | ').slice(0, 1000);
}