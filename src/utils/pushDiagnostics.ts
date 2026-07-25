/**
 * ============================================================================
 *  utils/pushDiagnostics.ts
 *  推送链路诊断日志（可通过配置开关按需启用）
 * ----------------------------------------------------------------------------
 *  设计要点：
 *    - 默认关闭。通过配置 `testcaseViewer.debug.push=true` 开启后才输出：
 *        1) console（Extension Host 开发者工具 Console 可见）
 *        2) VS Code OutputChannel「TestCase 推送诊断」（Output 面板可见，自动弹出）
 *    - 关闭状态下 `pushDiag`/`showPushDiag` 直接提前 return，
 *      不进入 safeStringify（无 deep clone / JSON.stringify 开销），
 *      也不创建 OutputChannel。
 *    - 非扩展宿主环境（vitest 单测）require('vscode') 会失败，
 *      此时 isDiagEnabled 返回环境变量 `PUSH_DIAG=1` 是否设置，
 *      channel 退化为 null，仅走 console，不影响测试。
 *    - 本模块纯"观测"，不改变任何业务流程。
 * ============================================================================
 */

let channel: any = null;
let channelReady = false;

let cachedEnabled: boolean | null = null;
let configListenerBound = false;

function getVscode(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('vscode');
    } catch {
        return null;
    }
}

function isDiagEnabled(): boolean {
    if (cachedEnabled !== null) return cachedEnabled;
    const vscode = getVscode();
    if (!vscode?.workspace?.getConfiguration) {
        // 单测/非扩展宿主：支持通过环境变量启用
        cachedEnabled = process.env.PUSH_DIAG === '1';
        return cachedEnabled;
    }
    try {
        cachedEnabled = vscode.workspace
            .getConfiguration('testcaseViewer')
            .get('debug.push', false) === true;
    } catch {
        cachedEnabled = false;
    }
    // 首次读取时挂配置变更监听，避免每次调用都读 API
    if (!configListenerBound && vscode.workspace?.onDidChangeConfiguration) {
        try {
            vscode.workspace.onDidChangeConfiguration((e: any) => {
                if (e?.affectsConfiguration?.('testcaseViewer.debug.push')) {
                    cachedEnabled = null; // 失效缓存，下次调用重新读
                }
            });
            configListenerBound = true;
        } catch { /* ignore */ }
    }
    return cachedEnabled;
}

function getChannel(): any {
    if (channelReady) return channel;
    channelReady = true;
    const vscode = getVscode();
    try {
        if (vscode?.window?.createOutputChannel) {
            channel = vscode.window.createOutputChannel('TestCase 推送诊断');
        }
    } catch {
        channel = null;
    }
    return channel;
}

export function showPushDiag(): void {
    if (!isDiagEnabled()) return;
    const ch = getChannel();
    if (ch) {
        try { ch.show(true); } catch { /* ignore */ }
    }
}

export function pushDiag(...args: any[]): void {
    if (!isDiagEnabled()) return; // 关闭时零开销：不做序列化、不写 console
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
