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
 *   .../{测试任务|testtask}/<task>/{测试案例|testcase}/<file>
 */
export function isInQualifiedDir(filePath: string, filePattern: RegExp): boolean {
    if (!filePath || !filePattern.test(filePath)) {
        return false;
    }

    const parts = filePath.split(path.sep);
    const len = parts.length;
    if (len < 4) return false;

    const dirNames = parts.map(p => path.basename(p));
    const caseDir = dirNames[len - 2];
    const rootDir = dirNames[len - 4];

    return (rootDir === '测试任务' || rootDir === 'testtask') &&
           (caseDir === '测试案例' || caseDir === 'testcase') &&
           filePattern.test(dirNames[len - 1]);
}

// ============================================
// 通用辅助
// ============================================

/**
 * 防抖
 */
export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | null = null;
    return function (...args: Parameters<T>) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(null, args), wait);
    };
}

/**
 * 深克隆（支持普通对象、数组、Date）
 */
export function deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime()) as unknown as T;
    if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as unknown as T;

    const cloned = {} as T;
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }
    return cloned;
}