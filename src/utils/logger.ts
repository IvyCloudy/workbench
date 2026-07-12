/**
 * ============================================================================
 *  utils/logger.ts
 *  轻量分层日志（按 tag 开关）
 * ----------------------------------------------------------------------------
 *  设计要点：
 *    - 默认所有 debug 日志静默；warn / error 始终输出。
 *    - 通过 VS Code 配置 `testcaseViewer.debug.<tag>` 打开 debug（如 yaml）。
 *    - 未安装或非 VS Code 环境时安全降级（走 process.env.DEBUG_<TAG>）。
 * ============================================================================
 */

let vscodeRef: any = null;
try {
    // 延迟 require，避免非扩展宿主环境（单测）加载失败
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vscodeRef = require('vscode');
} catch {
    vscodeRef = null;
}

export interface Logger {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
}

function isDebugEnabled(tag: string): boolean {
    // 1. 优先看 VS Code 配置
    if (vscodeRef?.workspace?.getConfiguration) {
        try {
            const cfg = vscodeRef.workspace.getConfiguration('testcaseViewer');
            const val = cfg.get(`debug.${tag}`);
            if (typeof val === 'boolean') return val;
        } catch { /* ignore */ }
    }
    // 2. 兜底环境变量
    const envKey = `DEBUG_${tag.toUpperCase()}`;
    return process.env[envKey] === '1' || process.env[envKey] === 'true';
}

export function createLogger(tag: string): Logger {
    const prefix = `[${tag}]`;
    return {
        debug: (...args: any[]) => {
            if (isDebugEnabled(tag)) console.log(prefix, ...args);
        },
        info: (...args: any[]) => {
            if (isDebugEnabled(tag)) console.info(prefix, ...args);
        },
        warn: (...args: any[]) => console.warn(prefix, ...args),
        error: (...args: any[]) => console.error(prefix, ...args),
    };
}
