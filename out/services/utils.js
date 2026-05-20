"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_PATTERNS = void 0;
exports.getNonce = getNonce;
exports.escapeHtml = escapeHtml;
exports.isInQualifiedDir = isInQualifiedDir;
exports.buildErrorHtml = buildErrorHtml;
exports.debounce = debounce;
exports.deepClone = deepClone;
const path = __importStar(require("path"));
// ============================================
// CSP Nonce 生成
// ============================================
const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function getNonce() {
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
    }
    return result;
}
// ============================================
// HTML 转义
// ============================================
function escapeHtml(str) {
    if (!str)
        return '';
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
function isInQualifiedDir(uri, filePattern) {
    if (uri.scheme !== 'file' || !filePattern.test(uri.fsPath)) {
        return false;
    }
    const parts = uri.fsPath.split(path.sep);
    const len = parts.length;
    if (len < 4)
        return false;
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
function buildErrorHtml(message) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8}
.msg{text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.msg h3{color:#e34d59;margin:0 0 12px}.msg p{color:#666;font-size:14px;margin:0}
</style></head><body><div class="msg"><h3>不支持的文件位置</h3><p>${escapeHtml(message)}</p></div></body></html>`;
}
// ============================================
// 防抖函数
// ============================================
function debounce(fn, delay) {
    let timeoutId = null;
    return (...args) => {
        if (timeoutId)
            clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}
// ============================================
// 深拷贝
// ============================================
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object')
        return obj;
    if (Array.isArray(obj))
        return obj.map(item => deepClone(item));
    const cloned = {};
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
exports.FILE_PATTERNS = {
    CSV: /\.csv$/i,
    YAML: /\.ya?ml$/i,
    JSON: /\.json$/i,
};
//# sourceMappingURL=utils.js.map