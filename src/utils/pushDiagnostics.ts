/**
 * ============================================================================
 *  utils/pushDiagnostics.ts
 *  推送链路诊断日志（临时排查用）
 * ----------------------------------------------------------------------------
 *  设计要点：
 *    - 所有诊断日志统一前缀 `[推送诊断]`，并同时写入：
 *        1) console（Extension Host 开发者工具 Console 可见）
 *        2) VS Code OutputChannel「TestCase 推送诊断」（Output 面板可见，自动弹出）
 *    - 非扩展宿主环境（vitest 单测）require('vscode') 会失败，channel 退化为 null，
 *      仅走 console，不影响测试。
 *    - 本模块纯"观测"，不改变任何业务流程，排查完成后可整体删除。
 * ============================================================================
 */

let channel: any = null;
let channelReady = false;

function getChannel(): any {
    if (channelReady) return channel;
    channelReady = true;
    try {
        // 延迟 require，避免非扩展宿主（单测）环境加载失败
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode');
        if (vscode?.window?.createOutputChannel) {
            channel = vscode.window.createOutputChannel('TestCase 推送诊断');
        }
    } catch {
        channel = null;
    }
    return channel;
}

export function showPushDiag(): void {
    const ch = getChannel();
    if (ch) {
        try { ch.show(true); } catch { /* ignore */ }
    }
}

export function pushDiag(...args: any[]): void {
    const text = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
    // 双保险：Extension Host 控制台 + OutputChannel
    // eslint-disable-next-line no-console
    console.log('[推送诊断]', ...args);
    const ch = getChannel();
    if (ch) {
        try { ch.appendLine(`${stamp()} ${text}`); } catch { /* ignore */ }
    }
}

function stamp(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}

function safeStringify(v: any): string {
    try {
        if (v instanceof Error) return v.stack || v.message;
        return JSON.stringify(v, getCircularReplacer(), 2);
    } catch {
        return String(v);
    }
}

function getCircularReplacer() {
    const seen = new WeakSet<object>();
    return (_k: string, val: any) => {
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
        }
        if (typeof val === 'function') return '[Function]';
        return val;
    };
}
