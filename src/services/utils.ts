import * as path from 'path';
import * as vscode from 'vscode';

// ============================================
// CSP Nonce 生成
// ============================================

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function getNonce(): string {
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
    }
    return result;
}

// ============================================
// HTML 转义
// ============================================

export function escapeHtml(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================
// 路径工具
// ============================================

/**
 * 检查文件是否在允许的目录下
 * @param uri 文件 URI
 * @param filePattern 文件扩展名正则
 * @returns 是否合格
 */
export function isInQualifiedDir(uri: vscode.Uri, filePattern: RegExp): boolean {
    if (uri.scheme !== 'file' || !filePattern.test(uri.fsPath)) {
        return false;
    }
    const parts = uri.fsPath.split(path.sep);
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
// 错误 HTML 生成
// ============================================

export function buildErrorHtml(message: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${escapeHtml(message)}</p></div></body></html>`;
}

// ============================================
// 防抖函数
// ============================================

export function debounce<T extends (...args: any[]) => any>(
    fn: T,
    delay: number
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | null = null;
    return (...args: Parameters<T>) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

// ============================================
// 深拷贝
// ============================================

export function deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as any;
    const cloned: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }
    return cloned;
}

// ============================================
// 文件扩展名检查
// ============================================

export const FILE_PATTERNS = {
    CSV: /\.csv$/i,
    YAML: /\.ya?ml$/i,
    JSON: /\.json$/i,
} as const;
