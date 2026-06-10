/**
 * ============================================================================
 *  services/telemetry.ts
 *  轻量埋点封装
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 统一对外暴露 trackEvent / trackError / trackTiming / trackException 四个方法
 *    2. 自动注入通用上下文（插件版本、VSCode 版本、平台、机器ID、会话ID）
 *    3. 严格遵循 vscode.env.isTelemetryEnabled —— 用户关闭遥测时全部静默丢弃
 *    4. 失败容错：埋点不影响主流程，永远不向上抛错
 *    5. 队列 + 节流批量上报，避免高频事件压垮网关
 *    6. 关闭/激活生命周期事件自动埋点
 *  设计要点：
 *    - 上报通道：优先使用 telemetryUrl，未配置则回退 apiUrl；最终请求 `${base}/api/v1/track`
 *    - 鉴权：Header `X-Telemetry-Token`，对应网关侧 TELEMETRY_TOKENS 之一
 *    - Token 优先级：cfg.telemetryToken（登录后端下发，可灰度/吊销） >  内置 BUILTIN_TELEMETRY_TOKEN（兜底，零配置可用）
 *    - 开发环境（NODE_ENV=development 或 base 为 localhost）默认仅 console.log，不真实上报
 *    - 所有路径/文件名相关字段必须由调用方自行脱敏（hash 或仅传扩展名/大小）
 *    - 单事件 payload 不超过 8KB，超过将被截断
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { readConfig } from './storage';

// ============================================
// 内置兜底 Token
// ----------------------------------------------------------------------------
//  * 用户无需任何配置即可让埋点跑通，避免登录前/未配置时数据全部丢失。
//  * 该 Token 必须同步加入网关侧 TELEMETRY_TOKENS 白名单。
//  * 如需吊销老版本插件流量，把该 Token 从网关白名单移除即可（不需要发版）。
//  * 如果用户的 app-config.json 里配置了 telemetryToken（未来由登录接口下发），
//    将优先使用配置值，便于灰度切换。
// ============================================
const BUILTIN_TELEMETRY_TOKEN = 'wb-telemetry-2026-221ae433c3920433044f65e0ee0bde03';

// ============================================
// 类型
// ============================================

/** 字符串属性（维度，便于聚合） */
export type TelemetryProps = Record<string, string | number | boolean | undefined>;
/** 数值度量（用于求和/平均） */
export type TelemetryMeasures = Record<string, number>;

interface TelemetryEvent {
    /** 事件名，建议 namespace.action 形式，如 push.success */
    name: string;
    /** 维度属性 */
    props?: TelemetryProps;
    /** 数值度量 */
    measures?: TelemetryMeasures;
    /** 事件级别 */
    level?: 'info' | 'warn' | 'error';
    /** 事件发生的客户端时间戳（毫秒） */
    ts: number;
}

// ============================================
// 全局状态
// ============================================

let _context: vscode.ExtensionContext | undefined;
let _sessionId = '';
let _commonProps: TelemetryProps = {};
let _queue: TelemetryEvent[] = [];
let _flushTimer: NodeJS.Timeout | undefined;
/** 上一次连续失败次数，用于退避 */
let _failureCount = 0;

const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 20;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_QUEUE = 200;

// ============================================
// 内部工具
// ============================================

function isEnabled(): boolean {
    // VSCode 用户级遥测开关（最高优先级）
    if (typeof vscode.env.isTelemetryEnabled === 'boolean' && !vscode.env.isTelemetryEnabled) {
        return false;
    }
    return !!_context;
}

/** 仅本地打印、不真实上报的开发模式判断
 *
 *  规则（2026-05 调整）：
 *    - NODE_ENV=development              → dev 静默
 *    - 没拿到任何上报地址（空字符串）   → dev 静默
 *    - 其他情况（包括显式配置的 127.0.0.1 / localhost）→ 真实上报
 *
 *  这样既能在生产侧避免「用户没配 telemetryUrl 就把数据打到本机」的乌龙，
 *  也允许开发者通过 app-config.json 显式配 http://127.0.0.1:8080 联调本地网关。
 */
function isDevMode(apiUrl: string): boolean {
    if (process.env.NODE_ENV === 'development') return true;
    if (!apiUrl) return true;
    return false;
}

/** 仅打印一次的 target 日志标记 */
let _targetLogged = false;

function safeStringify(obj: any): string {
    try {
        const str = JSON.stringify(obj);
        if (str.length > MAX_PAYLOAD_BYTES) {
            return str.slice(0, MAX_PAYLOAD_BYTES) + '...[truncated]';
        }
        return str;
    } catch {
        return '"[unserializable]"';
    }
}

function genSessionId(): string {
    return crypto.randomBytes(8).toString('hex');
}

/** 提取错误堆栈头几行用于上报，避免信息泄漏 */
function stackHead(err: any, lines = 5): string {
    const stack = err && err.stack ? String(err.stack) : '';
    return stack.split('\n').slice(0, lines).join(' | ').slice(0, 1000);
}

// ============================================
// 上报通道
// ============================================

async function postBatch(events: TelemetryEvent[]): Promise<void> {
    if (!_context || events.length === 0) return;
    const cfg = await readConfig(_context);
    // 埋点网关：优先 telemetryUrl，留空回退到 apiUrl（兼容旧部署）
    const telemetryBase = ((cfg.telemetryUrl || cfg.apiUrl) || '').trim().replace(/\/+$/, '');
    // Token 优先级：用户配置（含登录后端下发） > 内置兜底
    // 这样未来一旦后端在登录响应里下发 telemetryToken，会自动覆盖兜底值，无需发版。
    const telemetryToken = ((cfg.telemetryToken || '').trim() || BUILTIN_TELEMETRY_TOKEN).trim();

    const payload = {
        sessionId: _sessionId,
        common: _commonProps,
        events,
    };

    // 开发环境：仅 console（用 telemetryBase 判断，未配置网关时也按 dev 处理）
    if (isDevMode(telemetryBase)) {
        console.log('[telemetry][dev] batch=', events.length, safeStringify(payload));
        return;
    }

    // 理论上有兜底 Token 不会触发，但保留防御
    if (!telemetryToken) {
        console.warn('[telemetry] 未配置 telemetryToken 且无内置兜底，事件已丢弃');
        return;
    }

    // 首次真实上报时打印目的端，便于排查本地联调
    if (!_targetLogged) {
        _targetLogged = true;
        console.log('[telemetry] target =', telemetryBase + '/api/v1/track',
            'tokenSource =', (cfg.telemetryToken || '').trim() ? 'config' : 'builtin');
    }

    // 生产：POST 到 telemetry 网关；失败不影响业务，只记录日志
    try {
        const url = `${telemetryBase}/api/v1/track`;
        const body = JSON.stringify(payload);
        await new Promise<void>((resolve, reject) => {
            try {
                const httpMod = url.startsWith('https') ? require('https') : require('http');
                const u = new URL(url);
                const req = httpMod.request({
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname + u.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body, 'utf8'),
                        'X-Telemetry-Token': telemetryToken,
                    },
                }, (res: any) => {
                    res.on('data', () => { /* drain */ });
                    res.on('end', () => {
                        // 非 2xx 视为失败，纳入退避
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`telemetry http ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', (e: any) => reject(e));
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('telemetry timeout')); });
                req.write(body);
                req.end();
            } catch (e) {
                reject(e);
            }
        });
        _failureCount = 0;
    } catch (err: any) {
        _failureCount++;
        console.warn('[telemetry] 上报失败（已忽略）:', err?.message || err);
    }
}

function scheduleFlush(): void {
    if (_flushTimer) return;
    // 简单退避：连续失败超过 3 次后，把间隔拉长到 30s
    const delay = _failureCount >= 3 ? 30_000 : FLUSH_INTERVAL_MS;
    _flushTimer = setTimeout(() => {
        _flushTimer = undefined;
        const batch = _queue.splice(0, MAX_BATCH);
        if (batch.length === 0) return;
        // 不 await，避免阻塞后续 push
        postBatch(batch).catch(() => { /* 已在 postBatch 内处理 */ });
        if (_queue.length > 0) scheduleFlush();
    }, delay);
}

function enqueue(ev: TelemetryEvent): void {
    if (!isEnabled()) return;
    if (_queue.length >= MAX_QUEUE) {
        // 丢弃最早的事件，保护内存
        _queue.splice(0, _queue.length - MAX_QUEUE + 1);
    }
    _queue.push(ev);
    scheduleFlush();
}

// ============================================
// 公共 API
// ============================================

/**
 * 初始化埋点。应在 extension activate 中尽早调用一次。
 */
export async function initTelemetry(context: vscode.ExtensionContext): Promise<void> {
    _context = context;
    _sessionId = genSessionId();

    const pkg = (context.extension && context.extension.packageJSON) || {};
    _commonProps = {
        extName: pkg.name || 'unknown',
        extVersion: pkg.version || '0.0.0',
        vscodeVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        osRelease: os.release(),
        language: vscode.env.language,
        machineId: vscode.env.machineId, // VSCode 提供的稳定脱敏 ID
        sessionId: _sessionId,
    };

    // 监听用户遥测开关变化
    if (vscode.env.onDidChangeTelemetryEnabled) {
        context.subscriptions.push(
            vscode.env.onDidChangeTelemetryEnabled(enabled => {
                console.log('[telemetry] user toggle telemetry =', enabled);
                if (!enabled) _queue = [];
            })
        );
    }

    // 注册激活事件 + 注销 hook
    trackEvent('extension.activated');
    context.subscriptions.push({
        dispose: () => {
            trackEvent('extension.deactivated');
            // 尽力一次性 flush
            const remaining = _queue.splice(0, _queue.length);
            if (remaining.length) postBatch(remaining).catch(() => { /* ignore */ });
        }
    });
}

/** 上报一个普通事件 */
export function trackEvent(name: string, props?: TelemetryProps, measures?: TelemetryMeasures): void {
    if (!isEnabled()) return;
    enqueue({
        name,
        props: props,
        measures: measures,
        level: 'info',
        ts: Date.now(),
    });
}

/** 上报一个错误事件（业务可预期错误，例如接口返回失败） */
export function trackError(name: string, props?: TelemetryProps, measures?: TelemetryMeasures): void {
    if (!isEnabled()) return;
    enqueue({
        name,
        props: props,
        measures: measures,
        level: 'error',
        ts: Date.now(),
    });
}

/** 上报一个未捕获异常 */
export function trackException(name: string, err: any, props?: TelemetryProps): void {
    if (!isEnabled()) return;
    const message = (err && err.message) ? String(err.message).slice(0, 500) : String(err).slice(0, 500);
    enqueue({
        name,
        props: { ...props, errorMessage: message, stackHead: stackHead(err) },
        level: 'error',
        ts: Date.now(),
    });
}

/**
 * 包裹一段异步逻辑，自动上报耗时与成功/失败结果。
 * 用法：
 *   await trackTiming('push.flow', async () => { ... }, { rowCount: 100 });
 */
export async function trackTiming<T>(
    name: string,
    fn: () => Promise<T>,
    props?: TelemetryProps,
): Promise<T> {
    const start = Date.now();
    try {
        const ret = await fn();
        trackEvent(name, { ...props, result: 'success' }, { durationMs: Date.now() - start });
        return ret;
    } catch (err: any) {
        trackException(name, err, { ...props, result: 'error' });
        // 仍然抛出，由调用方决定如何处理
        throw err;
    }
}

/**
 * 接收来自 webview 的埋点消息，转发到上报队列。
 * 在 BaseEditorProvider / TestCaseProvider 的 onDidReceiveMessage 中调用即可。
 *
 * webview 端约定消息格式：
 *   { type: 'telemetry', name: 'xxx', level?: 'info'|'error', props?: {...}, measures?: {...} }
 */
export function handleWebviewTelemetry(msg: any): boolean {
    if (!msg || msg.type !== 'telemetry' || typeof msg.name !== 'string') return false;
    const level = msg.level === 'error' ? 'error' : 'info';
    const props: TelemetryProps = { ...(msg.props || {}), source: 'webview' };
    const measures: TelemetryMeasures = (msg.measures && typeof msg.measures === 'object') ? msg.measures : {};
    if (level === 'error') trackError(msg.name, props, measures);
    else trackEvent(msg.name, props, measures);
    return true;
}

/** 仅供测试/特殊场景：立即清空队列上报 */
export async function flushTelemetry(): Promise<void> {
    if (!isEnabled()) return;
    if (_flushTimer) {
        clearTimeout(_flushTimer);
        _flushTimer = undefined;
    }
    const batch = _queue.splice(0, _queue.length);
    if (batch.length) await postBatch(batch);
}
